/** 动态GPU蒙皮完整探针：按场景装配、真实实例flags/矩阵边界、同身份动作与Play循环。 */
import fs from 'node:fs';
import path from 'node:path';
import {waitFor,createRecorder,makeArgParser,readStartSceneExpectation} from './editor-smoke-lib.mjs';
import {runGameProbe,navigateProbeScene,playPaused,stopProbe} from './game-probe-lib.mjs';
import {GAME_PROBE_SCENE,readProbeScene,actorDemand,sameCounts,validSkinRow,shouldFailAssetRequest} from './game-probe-oracles.mjs';
const {arg,has}=makeArgParser(process.argv);
const OUT_DIR=path.resolve(arg('out','.workbuddy/tmp'));
const {results,check,summary}=createRecorder();
const manifest=JSON.parse(fs.readFileSync('assets/_data/asset-manifest.json','utf8'));

async function waitActors(cdp,expected){
  const ready=await waitFor(()=>cdp.eval(`JSON.stringify([...window.__editor.actorLib.assembledIds].sort())===${JSON.stringify(JSON.stringify(expected))}`),{timeout:30000,interval:100,label:'场景需求角色装配完成'});
  if(!ready)throw new Error('场景需求角色未装配完成：'+JSON.stringify(await cdp.eval('window.__editor.actorLib.diagnostics')));
  await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}

async function inspect(cdp,expected,label){
  await waitActors(cdp,expected.actors);
  const state=await cdp.eval(`(()=>{const e=window.__editor,b=e.bridge,lib=e.actorLib,s=e.playCtl.session.runtime;
    const actors=lib.assembledIds.map(id=>{const a=lib.get(id);return {id,base:a.paletteBase,rest:a.restPose,poses:a.palette.data.length/16/a.palette.jointCount,
      joints:a.palette.jointCount,matrices:a.palette.data.length/16,vertices:a.vertices.length/15,skinJoints:a.joints.length,weights:a.weights.length,clips:a.clips.map(c=>c.name)};});
    const active=(b.batches()??[]).map(batch=>{const rows=[];for(let i=0;i<batch.count;i++){const o=i*b.instanceStride;rows.push({x:batch.instances[o],z:batch.instances[o+2],base:batch.instances[o+7],pose:batch.instances[o+11],frames:batch.instances[o+12],phase:batch.instances[o+13],flags:batch.instances[o+14],stride:batch.instances[o+15]});}return {mesh:batch.meshId,count:batch.count,skin:!!batch.skin,rows};});
    const wantedActors={},visible=b.entities.filter(n=>!(n.kind==='player'&&n.sourceNodeId===b.presentedPlayerNodeId));let proxy=0;
    for(const n of visible){if(n.lodTier>=2||lib.get(n.characterId)===null)proxy++;else wantedActors[n.characterId]=(wantedActors[n.characterId]??0)+1;}
    return {actors,active,wantedActors,proxy,visible:visible.length,entities:b.entities,playerNode:b.presentedPlayerNodeId,playerStart:e.renderer.getDocument().playerStart,
      uploads:e.renderer.core.paletteUploadCount,gpuIds:e.renderer.debugDynamicMeshIds(),draws:e.renderer.stats.drawCalls,diagnostics:lib.diagnostics,tick:s.tick,outcome:s.outcome};})()`);
  check(label+'仅按场景需求装配有骨架角色',JSON.stringify(state.actors.map(a=>a.id).sort())===JSON.stringify(expected.actors),JSON.stringify({assembled:state.actors.map(a=>a.id),expected}));
  check(label+'作者玩家由真实模型呈现且不重复生成代理',state.playerNode!==null&&state.playerNode===state.playerStart&&state.entities.filter(n=>n.kind==='player'&&n.sourceNodeId===state.playerNode).length===1,JSON.stringify({playerNode:state.playerNode,playerStart:state.playerStart}));
  const actualActors=Object.fromEntries(state.active.filter(b=>b.mesh.startsWith('actor:')).map(b=>[b.mesh.slice(6),b.count]));
  const proxyCount=state.active.filter(b=>b.mesh.startsWith('capsule:')).reduce((sum,b)=>sum+b.count,0);
  check(label+'活跃批次数量匹配在场实体/LOD/玩家抑制规则',sameCounts(actualActors,state.wantedActors)&&proxyCount===state.proxy&&state.active.reduce((sum,b)=>sum+b.count,0)===state.visible,JSON.stringify({actualActors,wanted:state.wantedActors,proxyCount,expectedProxy:state.proxy}));
  const sorted=[...state.actors].sort((a,b)=>a.base-b.base);let matrices=0,chain=sorted.length>=2;
  for(const actor of sorted){chain&&=Number.isInteger(actor.poses)&&actor.poses>0&&actor.base===matrices&&actor.rest===actor.poses-1&&actor.base+(actor.rest+1)*actor.joints===actor.base+actor.matrices;matrices+=actor.matrices;}
  check(label+'多角色调色板按矩阵单位首尾相接、rest完整落在末pose',chain,JSON.stringify(sorted));
  check(label+'实际蒙皮顶点/关节权重完整',sorted.every(a=>a.vertices>0&&a.skinJoints===a.vertices*4&&a.weights===a.vertices*4&&a.clips.length>0),JSON.stringify(sorted.map(a=>({id:a.id,vertices:a.vertices,joints:a.skinJoints,weights:a.weights}))));
  const invalid=[];
  for(const batch of state.active){const actor=batch.mesh.startsWith('actor:')?sorted.find(a=>a.id===batch.mesh.slice(6)):null;
    if(batch.skin!==!!actor||batch.rows.length!==batch.count)invalid.push({mesh:batch.mesh,skin:batch.skin});
    for(const row of batch.rows)if(!validSkinRow(row,actor,matrices))invalid.push({mesh:batch.mesh,row});}
  check(label+'逐活跃实例核对flags/base/jointStride及精确pose边界',state.active.length>0&&invalid.length===0,JSON.stringify({instances:state.active.reduce((sum,b)=>sum+b.count,0),invalid}));
  check(label+'实际GPU已上传palette并提交对应动态绘制',state.uploads>0&&state.draws>0&&state.active.every(b=>state.gpuIds.includes(b.mesh)),JSON.stringify({uploads:state.uploads,draws:state.draws,gpu:state.gpuIds}));
  return state;
}

async function animationSample(cdp,identity){
  return cdp.eval(`(()=>{const e=window.__editor,b=e.bridge,s=e.playCtl.session.runtime,id=${JSON.stringify(identity)};
    const entity=b.entities.find(n=>n.runId===id.runId&&n.id===id.id&&n.generation===id.generation);if(!entity)throw new Error('动画观察身份已失效');
    b.watchDebug({kind:'entity',...id},()=>{});const debug=b.debugSnapshot();
    const batch=(b.batches()??[]).find(batch=>batch.meshId==='actor:'+entity.characterId),rows=[];
    for(let row=0;row<(batch?.count??0);row++){const o=row*b.instanceStride;if(Math.hypot(batch.instances[o]-entity.x,batch.instances[o+2]-entity.z)<.0001)rows.push({pose:batch.instances[o+11],phase:batch.instances[o+13],base:batch.instances[o+7],stride:batch.instances[o+15]});}
    if(rows.length!==1)throw new Error('动画身份到实例位置不唯一，不能以批次下标冒充身份');
    return {identity:id,entity,debug,row:rows[0],tick:s.tick,outcome:s.outcome};})()`);
}

async function main(){
  const scene=arg('scene',readStartSceneExpectation().path);
  return runGameProbe({name:'dynamic-skin',outDir:OUT_DIR,port:Number(arg('port',5100)),cdpPort:Number(arg('cdp',9341)),
    chromePath:arg('chrome','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),headed:has('headed'),windowSize:arg('window-size','1600,1000'),url:arg('url',null),scene,results,check,summary},async({cdp,details,url})=>{
    await playPaused(cdp);
    details.production=await inspect(cdp,actorDemand(readProbeScene(scene),manifest),'正式场景');
    details.productionStop=await stopProbe(cdp,check);
    await navigateProbeScene(cdp,url,GAME_PROBE_SCENE);
    // B-02已有rig-only，不能声称源资产缺档。仅在白盒精确注入503，验真降级与Stop后恢复。
    const demand=actorDemand(readProbeScene(GAME_PROBE_SCENE),manifest);
    const b02=manifest.characters.find(c=>c.id==='B-02'),rig=b02.lods.find(l=>l.label.includes('+骨骼'));
    if(!rig)throw new Error('故障注入夹具缺少B-02 rig-only资产');
    const failedPath='assets/'+rig.file;details.injectedFailures=[];
    const paused=event=>{
      const message=JSON.parse(event.data);
      if(message.sessionId!==cdp.sessionId||message.method!=='Fetch.requestPaused')return;
      const requested=new URL(message.params.request.url).searchParams.get('path');
      const matches=shouldFailAssetRequest(message.params.request,failedPath);
      if(matches)details.injectedFailures.push({path:requested,status:503});
      void cdp.send(matches?'Fetch.fulfillRequest':'Fetch.continueRequest',matches?{requestId:message.params.requestId,responseCode:503,body:Buffer.from('probe unavailable').toString('base64')}:{requestId:message.params.requestId}).catch(error=>check('故障注入响应完成',false,error.message));
    };
    cdp.ws.addEventListener('message',paused);
    let first,beforeUploads;
    try {
    await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*B02*animation_ready.glb*',requestStage:'Request'}]});
    first=await playPaused(cdp);const expected={actors:demand.actors.filter(id=>id!=='B-02'),missing:['B-02']};
    const diagnosed=await waitFor(()=>cdp.eval(`window.__editor.actorLib.diagnostics.some(d=>d.startsWith('B-02:')&&d.includes('503'))`),{timeout:10000,interval:100,label:'503故障必须成为显式装配诊断'});
    if(!diagnosed)throw new Error('503故障没有产生预期诊断');
    details.whitebox=await inspect(cdp,expected,'白盒');
    check('注入503产生明确诊断并走实际胶囊flags0路径',details.injectedFailures.length===1&&details.whitebox.proxy===1&&details.whitebox.active.some(b=>b.mesh.startsWith('capsule:')&&b.rows.every(r=>r.flags===0))&&details.whitebox.diagnostics.some(d=>d.startsWith('B-02:')&&d.includes('503')),JSON.stringify({faults:details.injectedFailures,diagnostics:details.whitebox.diagnostics}));

    // 只观察同一运行代次/槽代次中确实移动的循环片，静止/攻击末帧不被误判成停动画。
    await cdp.eval(`(()=>{const c=window.__editor.playCtl;for(let i=0;i<20;i++)document.querySelector('#btn-step').click();return c.tick;})()`);
    const identity=await cdp.eval(`(()=>{const e=window.__editor.bridge.entities.find(n=>n.kind==='npc'&&n.characterId==='E-01'&&n.behavior===1);if(!e)throw new Error('无追逐循环动画样本');return {id:e.id,generation:e.generation,runId:e.runId};})()`);
    const a=await animationSample(cdp,identity);
    await cdp.eval(`(()=>{const c=window.__editor.playCtl;for(let i=0;i<17;i++)document.querySelector('#btn-step').click();return c.tick;})()`);
    const b=await animationSample(cdp,identity);
    const moved=Math.hypot(b.entity.x-a.entity.x,b.entity.z-a.entity.z);
    check('同一身份在可控17tick中保持运行并产生实际位移',a.outcome==='running'&&b.outcome==='running'&&b.tick-a.tick===17&&moved>.01&&JSON.stringify(a.debug?.identity)===JSON.stringify(b.debug?.identity),JSON.stringify({a,b,moved}));
    check('同一循环片的实际实例pose及phase随移动推进',a.debug?.clip?.name===b.debug?.clip?.name&&['walk','run'].includes(a.debug?.clip?.name)&&a.row.pose!==b.row.pose&&a.row.phase!==b.row.phase&&a.debug?.pipeline==='gpu-palette'&&b.debug?.pipeline==='gpu-palette',JSON.stringify({a,b}));
    details.animation={a,b,moved};
    await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT_DIR,'dynamic-skin.png'),Buffer.from(shot.data,'base64'));

    beforeUploads=await cdp.eval('window.__editor.renderer.core.paletteUploadCount');
    details.stop=await stopProbe(cdp,check);
    // 有共享动作时beginPlay会重建目标骨架；不要求旧CPU缓存永远复用，只要求再装配与重传正确。
    } finally {
      try{await cdp.send('Fetch.disable');}catch(error){check('故障注入关闭完成',false,error.message);}
      finally{cdp.ws.removeEventListener('message',paused);}
    }
    const again=await playPaused(cdp);
    details.replay=await inspect(cdp,demand,'再次Play');
    check('撤销故障后下一轮Play清除失败并恢复B-02真模型',details.replay.active.some(batch=>batch.mesh==='actor:B-02')&&!details.replay.diagnostics.some(d=>d.startsWith('B-02:')),JSON.stringify({actors:details.replay.actors.map(a=>a.id),diagnostics:details.replay.diagnostics}));
    check('Stop→Play创建新runId且palette确实重传',again.runId!==first.runId&&details.replay.uploads>beforeUploads,JSON.stringify({first,again,beforeUploads,afterUploads:details.replay.uploads}));
    details.finalStop=await stopProbe(cdp,check);
    check('无console error',cdp.consoleErrors.length===0,JSON.stringify(cdp.consoleErrors));
    check('无未捕获异常',cdp.exceptions.length===0,JSON.stringify(cdp.exceptions));
  });
}
main().then(code=>process.exit(code)).catch(error=>{console.error('动态蒙皮探针异常终止：',error.message);process.exit(1);});
