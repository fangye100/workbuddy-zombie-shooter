/** 本任务定向 headed A/D 探针。真实输入/正常 TLS；所有运行时读取均无写入。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Cdp, launchEditorSession, waitFor, sleep } from './editor-smoke-lib.mjs';
import { probeOptions, profileOwners, freePort, ProbeInput, visiblePoint, collapseIkPanel, sceneReadinessExpression,
  aimPoint, posedJointPosition, actorPoint } from './weapon-assembly.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SCENE = 'assets/scenes/sandbox/weapon-assembly-trial.scene.json';
export function strafeOptions(argv) {
  const allowed = ['--root','--expected-head','--url','--cdp','--hold-ms','--out','--chrome'];
  for (let i=0;i<argv.length;i+=2) if (!allowed.includes(argv[i]) || !argv[i+1] || argv[i+1].startsWith('--')) throw Error('未知或缺少探针参数 '+argv[i]);
  return probeOptions(argv.includes('--out') ? argv : [...argv,'--out','.workbuddy/tmp/strafe-motion/r7-headed']);
}

/** 两组验收只通过真实 UI Stop→Play 分隔，避免累计横移消耗同一房间余量。 */
export async function restartTrial(click,stopSnapshot,playSnapshot,waitReady) {
  await click('#btn-stop');const stopped=await stopSnapshot();
  await click('#btn-play');if(!await waitReady())throw Error('重启 Play/动作/持握模型未就绪');
  return {stopped,restarted:await playSnapshot()};
}

/** 只把真实游戏视图的移动样本计入步态，Observation/Pause 不能冒充横移。 */
export function gaitEvidence(samples, expectedClip) {
  const active = samples.filter(s => s.state==='playing' && !s.observing && s.actor?.clip===expectedClip && s.player && s.actor.feet?.length===2 && s.actor.feet.every(p=>p?.local?.every(Number.isFinite)&&p?.world?.every(Number.isFinite)));
  let wraps=0, distanceM=0, simulatedS=0;
  for(let i=1;i<active.length;i++) {
    const a=active[i-1],b=active[i],dt=(b.tick-a.tick)*b.fixedStep;
    if(dt<=0)continue;
    distanceM+=Math.hypot(b.player.x-a.player.x,b.player.z-a.player.z);simulatedS+=dt;
    if(a.actor.phase>.5&&b.actor.phase<a.actor.phase-.5)wraps++;
  }
  return {ok:active.length>=6&&distanceM>.2&&wraps>=1, samples:active.length,wraps,distanceM,simulatedS,
    meanSpeedMps:simulatedS>0?distanceM/simulatedS:null,cyclesPerS:simulatedS>0?wraps/simulatedS:null,
    maxFootSpanX:active.length?Math.max(...active.map(s=>Math.abs(s.actor.feet[0].local[0]-s.actor.feet[1].local[0]))):null,
    minAnkleWorldY:active.length?Math.min(...active.flatMap(s=>s.actor.feet.map(p=>p.world[1]))):null};
}

/** 读取真实 runtime yaw/角色世界旋转与位移，不用强制 fixedAim 冒充无鼠标路径。 */
export function desktopStrafeEvidence(samples,expectedClip,expectedYaw) {
  const gait=gaitEvidence(samples,expectedClip),active=samples.filter(s=>s.state==='playing'&&!s.observing&&s.actor?.clip===expectedClip&&s.player);
  const angle=v=>Math.abs(Math.atan2(Math.sin(v),Math.cos(v)));
  let maxYawDeltaRad=0,maxActorYawDeltaRad=0,maxForwardFraction=0;
  for(let i=0;i<active.length;i++){
    const s=active[i],forward=actorPoint([0,0,1],{quat:s.authorPlayer.quat,scale:1,pos:[0,0,0]});
    maxYawDeltaRad=Math.max(maxYawDeltaRad,angle(s.player.yaw-expectedYaw));
    maxActorYawDeltaRad=Math.max(maxActorYawDeltaRad,angle(Math.atan2(forward[2],forward[0])-expectedYaw));
    if(i){const a=active[i-1].player,dx=s.player.x-a.x,dz=s.player.z-a.z,length=Math.hypot(dx,dz);if(length>1e-6)maxForwardFraction=Math.max(maxForwardFraction,Math.abs((dx*Math.cos(s.player.yaw)+dz*Math.sin(s.player.yaw))/length));}
  }
  return {...gait,maxYawDeltaRad,maxActorYawDeltaRad,maxForwardFraction,ok:gait.ok&&maxYawDeltaRad<.03&&maxActorYawDeltaRad<.03&&maxForwardFraction<.03};
}

/** 保留确定的现有 clip 回退；持握仍必须由真实本帧双手/装配数据证明。 */
export function holdingEvidence(sample, contract) {
  const layer=sample.actor?.layer,models=sample.models,ik=sample.actor?.ik,binding=ik?.binding;
  const expected=`WEAPON_CLIP_MISSING: ${contract.requested}; base ${sample.actor?.clip} retained; procedural pose available only with configured IK`;
  const retained=(layer?.diagnostics??[]).filter(d=>d===expected&&contract.requested==='pistol-idle'&&contract.upper==='ready'&&!contract.dedicatedAvailable&&models?.pose?.action==='idle');
  const unexpected=(layer?.diagnostics??[]).filter(d=>!retained.includes(d));
  const controls=['leftHand','rightHand'].map(part=>binding?.controls.find(c=>c.part===part));
  const socket=v=>v?.position?.length===3&&v.position.every(Number.isFinite)&&v.rotation?.length===4&&v.rotation.every(Number.isFinite);
  const request=ik?.attachment,finiteHands=sample.actor?.hands?.length===2&&sample.actor.hands.every(h=>h.local?.every(Number.isFinite)&&h.world?.every(Number.isFinite));
  const residuals=models?.measurements,within=(key,max)=>Number.isFinite(residuals?.[key])&&residuals[key]>=0&&residuals[key]<=max;
  const reasons=[];
  if(!layer||layer.clip!==contract.upper||!(layer.weight>0)||!layer.nodes.length||unexpected.length)reasons.push('upper-layer');
  if(!binding?.enabled||!(binding.weight>0)||controls.some(c=>!c?.enabled||!(c.weight>0))||ik?.diagnostics?.length)reasons.push('body-ik');
  if(!request?.dependent||![request.resolvedTarget,request.result,request.primary?.contact,request.primary?.modelSocket,request.dependent.contact,request.dependent.modelSocket].every(socket))reasons.push('socket-request');
  if(!finiteHands)reasons.push('actual-hands');
  if(!models?.visible||models.weaponId!=='pistol'||models.frameStamp!==sample.frame||!(models.visibleDrawCount>0)||models.diagnostics?.length||models.warnings?.length||models.ikDiagnostics?.length||models.attachmentDraws?.some(d=>d.frameStamp!==sample.frame))reasons.push('current-model-frame');
  if(!within('rightTargetResidualM',.02)||!within('leftTargetResidualM',.02)||!within('rightOrientationResidualRad',.05)||!within('leftOrientationResidualRad',.05))reasons.push('grip-residual');
  return {ok:!reasons.length,reasons,retainedDiagnostics:retained,unexpectedDiagnostics:unexpected,frame:sample.frame,modelFrame:models?.frameStamp,residuals,hands:sample.actor?.hands,attachment:request};
}

/** 从当前真实姿态计算一次侧前方全身观察输入，不直接写相机。 */
export function observationPlan(sample) {
  const view=sample.camera,forward=actorPoint([0,0,1],{quat:sample.authorPlayer.quat,scale:1,pos:[0,0,0]});
  const desiredYaw=Math.atan2(forward[0],forward[2])+Math.PI/4;
  const delta=Math.atan2(Math.sin(desiredYaw-view.yaw),Math.cos(desiredYaw-view.yaw));
  const plan={desiredYaw,desiredElevationDeg:20,desiredDistance:6.2,dx:-delta/.006,dy:(20-view.elevationDeg)/.25,wheelDelta:Math.log(6.2/view.distance)/.0012};
  if(!Object.values(plan).every(Number.isFinite)||Math.abs(plan.dx)>530||Math.abs(plan.dy)>200||Math.abs(plan.wheelDelta)>1400)throw Error('当前观察机位超出有界输入计划');
  return plan;
}

export function framingEvidence(projection) {
  const reasons=[],{bounds:b,canvas:c,points,uiRects}=projection;
  if(!b||!c||!points?.length)return {ok:false,reasons:['projection-missing']};
  if(points.some(p=>p.behind||!Number.isFinite(p.x)||!Number.isFinite(p.y)))reasons.push('invalid-projection');
  if(!['Head','LeftLeg','RightLeg','LeftFoot','RightFoot'].every(name=>points.some(p=>p.name===name)))reasons.push('full-body-landmarks');
  if(b.left<c.left+5||b.top<c.top+5||b.right>c.right-5||b.bottom>c.bottom-5)reasons.push('viewport-clipped');
  if(b.bottom-b.top<180||b.bottom-b.top>500)reasons.push('body-size');
  const occluders=uiRects.filter(r=>b.left<r.right&&b.right>r.left&&b.top<r.bottom&&b.bottom>r.top);
  if(occluders.length)reasons.push('ui-occluded');
  if(!(projection.frontDot>.4&&projection.frontDot<.95))reasons.push('side-front-view');
  return {ok:!reasons.length,reasons,bounds:b,occluders,frontDot:projection.frontDot};
}

export const STRAFE_SNAPSHOT = `(async()=>{const e=window.__editor,c=e?.playCtl,r=c?.session.runtime,p=r?.player(),d=e?.renderer.getDocument(),o=e?.renderer.state.objects.find(o=>o.nodeId===d?.playerStart&&!o.removed),s=o?.skinState,clip=s?.clips[s.clip],motions=e?.motions.summary()??null;const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(d??null)));
 const bones=o?.skeleton?o.skeleton.jointNames.map((name,i)=>({name,local:(${posedJointPosition.toString()})(o.skinScratch.slice(i*16,(i+1)*16),o.skeleton.normalization,o.skeleton.inverseBind.slice(i*16,(i+1)*16))})):[];
 const points=bones.map(b=>({...b,world:b.local?(${actorPoint.toString()})(b.local,o):null}));
 const navigation=typeof document==='undefined'?null:Object.fromEntries(['btn-freecam','btn-observation-camera'].map(id=>{const b=document.getElementById(id);return [id,b?{text:b.textContent,title:b.title,active:b.classList.contains('active'),pressed:b.getAttribute('aria-pressed')}:null];}));
 return {navigation,freeCam:e?.freeCam?.()??null,state:c?.state,tick:c?.tick,fixedStep:r?.fixedStep,frame:e?.renderer.state.frameCounter,observing:c?.observing,camera:{...structuredClone(e?.camera),elevationDeg:e?.params.cameraElevation},authorDocumentSha256:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join(''),dirty:e?.renderer.state.sceneDirty??null,player:p??null,ledger:c?.ledger?.pending,models:e?.weaponModels.snapshot()??null,motions,bodyIk:e?.bodyIk.summary()??null,authorPlayer:o?{nodeId:o.nodeId,pos:[...o.pos],quat:[...o.quat],scale:o.scale,visible:o.visible}:null,
 actor:s?{clip:clip?.name??null,time:s.time,duration:clip?.duration??null,phase:clip?.duration>0?s.time/clip.duration:null,normalization:Array.from(o.skeleton.normalization),feet:['LeftFoot','RightFoot'].map(name=>points.find(p=>p.name===name)),hips:points.find(p=>p.name==='Hips'),hands:points.filter(p=>/Hand$/.test(p.name)),joints:points,ik:s.bodyIk?{binding:structuredClone(s.bodyIk.binding),diagnostics:structuredClone(s.bodyIk.diagnostics),attachment:structuredClone(s.bodyIk.attachment??null)}:null,layer:motions?.nodes.find(n=>n.nodeId===d.playerStart)?.layer??null}:null};})()`;

export const FRAMING_EXPRESSION=`(async()=>{const s=await ${STRAFE_SNAPSHOT},e=window.__editor,canvas=document.querySelector('#gpu'),r=canvas.getBoundingClientRect(),points=(s.actor?.joints??[]).filter(p=>p.world).map(p=>({name:p.name,...e.renderer.worldToScreen(p.world)})),pad=26,bounds=points.length?{left:Math.min(...points.map(p=>p.x))-pad,right:Math.max(...points.map(p=>p.x))+pad,top:Math.min(...points.map(p=>p.y))-pad,bottom:Math.max(...points.map(p=>p.y))+pad}:null;
 const selectors='.hud-life,.hud-wave,.hud-objective,.hud-radar,.hud-help,.run-hud,.game-toolbar,#hud,#runtime-body-ik-panel,#runtime-motion-panel,#observation-camera-hint',uiRects=[...document.querySelectorAll(selectors)].filter(el=>!el.hidden&&getComputedStyle(el).display!=='none').map(el=>{const v=el.getBoundingClientRect();return {className:el.className,id:el.id,left:v.left,right:v.right,top:v.top,bottom:v.bottom};}).filter(v=>v.right>v.left&&v.bottom>v.top);
 const forward=(${actorPoint.toString()})([0,0,1],{quat:s.authorPlayer.quat,scale:1,pos:[0,0,0]}),frontDot=forward[0]*Math.sin(s.camera.yaw)+forward[2]*Math.cos(s.camera.yaw);
 return {sample:s,canvas:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height},viewport:[innerWidth,innerHeight],points,bounds,uiRects,frontDot};})()`;

export async function runStrafeProbe(options) {
  const head=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:options.root,encoding:'utf8'}).trim();
  if(fs.realpathSync(options.root)!==fs.realpathSync(REPO)||fs.realpathSync(process.cwd())!==fs.realpathSync(options.root)||head()!==options.expectedHead)throw Error('探针 root/cwd/HEAD 不匹配');
  if(process.platform!=='win32')throw Error('当前探针仅适配已确认 Windows 主机');
  const profile=path.join(options.root,'.workbuddy/tmp/chrome-profile');
  const raw=execFileSync('powershell.exe',['-NoProfile','-Command',"Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],{encoding:'utf8'}).trim();
  const processes=raw?[JSON.parse(raw)].flat():[];
  if(processes.some(p=>!p.CommandLine)||profileOwners(processes,profile).length)throw Error('保留 profile 归属不可证明或已被持有；不接管现有 Chrome');
  await freePort(options.cdpPort);fs.mkdirSync(options.out,{recursive:true});
  const report={targetHead:options.expectedHead,root:options.root,url:options.url,scene:SCENE,normalTls:true,profile,toolSha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),sceneSha256:createHash('sha256').update(fs.readFileSync(path.join(options.root,SCENE))).digest('hex'),startedAt:new Date().toISOString(),checks:[],actions:[],samples:[],screenshots:[],exceptions:[],limitations:['足点是踝关节，不是足底接触标记。最低踝高保持不等于接地 IK 或世界锁脚。','PNG 需检查全身轮廓、脚部遮挡与持握；自动检查不替代视觉批准。']};
  const check=(name,ok,detail)=>{report.checks.push({name,ok:!!ok,detail});};
  let session,input;
  try {
    session=await launchEditorSession({chromePath:options.chromePath,cdpPort:options.cdpPort,headed:true,appUrl:options.url,ignoreCertificateErrors:false,setupTimeoutMs:30000,windowSize:'1440,1000'});
    const browser=new Cdp(session.ws,undefined);let timer;
    let info;try{info=await Promise.race([browser.send('SystemInfo.getProcessInfo'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('browser PID 核对超时')),10000);})]);}finally{clearTimeout(timer);}
    const browserPid=info.processInfo.find(p=>p.type==='browser')?.id;report.browser={pid:session.chrome.pid,browserPid,targetId:session.targetId,flags:session.flags};
    if(browserPid!==session.chrome.pid)throw Error('Chrome 复用了其它进程，停止');
    const cdp=session.cdp,send=cdp.send.bind(cdp),deadline=Date.now()+120000;
    cdp.send=(method,params)=>{const ms=Math.min(10000,deadline-Date.now());if(ms<=0)return Promise.reject(Error('探针120秒预算用尽'));let timeout;return Promise.race([send(method,params),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('CDP 超时 '+method)),ms);})]).finally(()=>clearTimeout(timeout));};
    input=new ProbeInput(cdp,action=>report.actions.push({...action,atMs:Date.now()}));
    const nav=await cdp.send('Page.navigate',{url:options.url});if(nav.errorText)throw Error('正常 TLS 导航失败 '+nav.errorText);
    const doc=JSON.parse(fs.readFileSync(path.join(options.root,SCENE),'utf8')),readiness=sceneReadinessExpression(doc,SCENE);
    const mesh=doc.nodes.find(n=>n.id===doc.playerStart).components.find(c=>c.kind==='MeshRenderer'),lib=JSON.parse(fs.readFileSync(path.join(options.root,mesh.sharedMotion.library.path),'utf8')),profile=lib.profiles[mesh.sharedMotion.profile],pistol=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules').arsenal.definitions.find(w=>w.id==='pistol');
    report.fallbackContract={requested:pistol.presentation.animations.idle.clip,upper:'ready',dedicatedAvailable:!!profile[pistol.presentation.animations.idle.clip],readyAvailable:!!profile.ready,policy:'packages/zombie-game/src/presentation/player-motion.ts',note:'缺专用 idle 时保留 base，ready 上身层结合已配置的双手装配 IK；诊断仍原样报告。'};
    if(report.fallbackContract.requested!=='pistol-idle'||!report.fallbackContract.readyAvailable)throw Error('当前手枪回退契约与定向验收不匹配');
    if(!await waitFor(async()=>{report.readiness=await cdp.eval(readiness);return report.readiness?.ok;},{timeout:30000,interval:200}))throw Error('作者场景、GLB 或 Play 控件未就绪');
    await cdp.send('Page.bringToFront');
    report.gpu=await cdp.eval('(async()=>{const a=await navigator.gpu?.requestAdapter(),i=a?.info??(a?.requestAdapterInfo?await a.requestAdapterInfo():null);return {secure:isSecureContext,vendor:i?.vendor,architecture:i?.architecture,description:i?.description};})()');
    check('HTTPS/真实 NVIDIA',report.gpu.secure&&report.gpu.vendor==='nvidia'&&report.gpu.architecture==='lovelace',report.gpu);if(!report.checks.at(-1).ok)throw Error('未确认真实 GPU');
    const snap=async label=>{const sample={label,atMs:Date.now(),...await cdp.eval(STRAFE_SNAPSHOT)};report.samples.push(sample);return sample;};
    const click=async selector=>{const point=await visiblePoint(cdp,selector);await input.pointer(point,true);await input.pointer(point,false);report.actions.push({click:selector,atMs:Date.now()});};
    const drag=async(dx,dy,button='left')=>{if(Math.abs(dx)>530||Math.abs(dy)>250)throw Error('观察拖动超出有界范围');const p=await visiblePoint(cdp,'#gpu');await input.pointer(p,true,button);for(let k=1;k<=8;k++){await input.move({x:p.x+dx*k/8,y:p.y+dy*k/8});await sleep(20);}await input.pointer({x:p.x+dx,y:p.y+dy},false,button);await sleep(120);};
    const capture=async label=>{const sample=await snap(label),before=await cdp.eval('window.__editor.renderer.state.frameCounter'),{data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),after=await cdp.eval('window.__editor.renderer.state.frameCounter'),file=label+'.png';fs.writeFileSync(path.join(options.out,file),Buffer.from(data,'base64'));report.screenshots.push({file,sample:report.samples.length-1,frameRange:[before,after],clip:sample.actor?.clip,phase:sample.actor?.phase,state:sample.state,observing:sample.observing});return sample;};
    const author=await snap('author');await capture('01-author');await input.tap('v');const editFree=await snap('edit-free-v');await input.tap('v');const editOrbit=await snap('edit-orbit-v');check('Edit V保留自由飞行开关',editFree.freeCam?.on&&!editOrbit.freeCam?.on&&!editOrbit.observing,{editFree,editOrbit});await click('#btn-play');
    if(!await waitFor(()=>cdp.eval('window.__editor.playCtl.state==="playing"&&window.__editor.weaponModels.snapshot().visible&&window.__editor.motions.summary().pending===0'),{timeout:20000,interval:150}))throw Error('Play/动作/持握模型未就绪');
    const baseline=await snap('play-ready');check('正常游戏视图与持枪',!baseline.observing&&baseline.models.visible&&baseline.models.weaponId==='pistol',baseline.models);
    const cameraYaw=baseline.camera.yaw,aimYaw=Math.atan2(-Math.cos(cameraYaw),-Math.sin(cameraYaw))*180/Math.PI;
    const aim=async()=>{const point=await aimPoint(cdp,aimYaw,action=>report.actions.push({...action,atMs:Date.now()}));await input.move(point);};
    check('作者GodView俯视跟随机位',Math.abs(baseline.camera.distance-8)<.001&&Math.abs(baseline.camera.elevationDeg-55)<.001,baseline.camera);
    // 此阶段没有 mouseMove/画布 pointer 输入；只点工具栏 Play 后直接按 A/D。
    const defaultYaw=aimYaw*Math.PI/180;
    for(const [key,clip] of [['a','walk_l'],['d','walk_r']]){
      const start=report.samples.length;await input.key(key,true);const until=Date.now()+Math.min(options.holdMs,1000);
      while(Date.now()<until){await sleep(45);await snap('no-pointer-'+key);}
      const moving=report.samples.slice(start),evidence=desktopStrafeEvidence(moving,clip,defaultYaw);
      check(key+'初始无pointer侧移/面向',evidence.ok&&!report.actions.slice(0).some(a=>a.input==='mouseMove'),evidence);
      await capture('no-pointer-'+key+'-game');await input.key(key,false);await sleep(150);
    }
    report.ikPanel=await collapseIkPanel(cdp,click,action=>report.actions.push({...action,atMs:Date.now()}));
    // 实际 pointer 改成反向面向，再清输入/Pause/观察/返回，不能回跳相机默认 heading。
    const otherYaw=aimYaw+180,otherPoint=await aimPoint(cdp,otherYaw,action=>report.actions.push({...action,atMs:Date.now()}));await input.move(otherPoint);await sleep(200);
    const pointed=await snap('pointer-changed-facing');check('真实pointer更新非默认面向',Math.abs(Math.atan2(Math.sin(pointed.player.yaw-otherYaw*Math.PI/180),Math.cos(pointed.player.yaw-otherYaw*Math.PI/180)))<.03,pointed.player);
    await click('#btn-pause');const viewBefore=await snap('view-before-free');await click('#btn-freecam');const viewOn=await snap('actual-free-button');
    check('用户自由按钮在Pause进入同一观察导航',viewOn.observing&&viewOn.navigation['btn-freecam'].pressed==='true'&&viewOn.navigation['btn-observation-camera'].pressed==='true'&&!viewOn.freeCam.on,viewOn.navigation);
    await drag(35,-20);const center=await visiblePoint(cdp,'#gpu');await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:center.x,y:center.y,deltaX:0,deltaY:100});await drag(20,10,'right');const navigated=await snap('actual-free-navigated');
    check('用户观察orbit/pan/wheel实际改变机位且Pause冻结',navigated.observing&&navigated.tick===viewBefore.tick&&navigated.actor.time===viewBefore.actor.time&&navigated.camera.yaw!==viewBefore.camera.yaw&&navigated.camera.distance!==viewBefore.camera.distance&&JSON.stringify(navigated.camera.target)!==JSON.stringify(viewBefore.camera.target),{viewBefore,navigated});
    await capture('actual-free-paused-navigation');
    await input.tap('v');const viewReturned=await snap('actual-free-v-return');check('观察态V退出且两个按钮一致',!viewReturned.observing&&viewReturned.navigation['btn-freecam'].pressed==='false'&&viewReturned.navigation['btn-observation-camera'].pressed==='false',viewReturned.navigation);
    await click('#btn-pause');await sleep(150);await input.key('a',true);const keptStart=report.samples.length,keptUntil=Date.now()+700;
    while(Date.now()<keptUntil){await sleep(45);await snap('preserved-heading-a');}await input.key('a',false);
    check('Pause观察返回后无pointer保留非默认面向',desktopStrafeEvidence(report.samples.slice(keptStart),'walk_r',otherYaw*Math.PI/180).ok,desktopStrafeEvidence(report.samples.slice(keptStart),'walk_r',otherYaw*Math.PI/180));
    await input.tap('v');const playObserve=await snap('playing-v-observe');await input.key('a',true);await sleep(180);await input.key('a',false);const observeInput=await snap('observing-key-suppressed');await input.tap('escape');const playReturned=await snap('playing-escape-return');
    check('Play V观察拦截游戏移动并Esc返回',playObserve.observing&&observeInput.observing&&Math.hypot(observeInput.player.x-playObserve.player.x,observeInput.player.z-playObserve.player.z)<1e-5&&!playReturned.observing&&!playReturned.freeCam.on,{playObserve,observeInput,playReturned});
    // 用户新路径与旧步态回归各自从作者出生点开始，不改玩家位置或房间边界。
    const {stopped:r8Stopped,restarted}=await restartTrial(click,async()=>{await sleep(250);return capture('r8-path-stop');},()=>snap('regression-restarted'),()=>waitFor(()=>cdp.eval('window.__editor.playCtl.state==="playing"&&window.__editor.weaponModels.snapshot().visible&&window.__editor.motions.summary().pending===0'),{timeout:20000,interval:150}));
    check('R8路径Stop回滚/资源释放',r8Stopped.state==='stopped'&&!r8Stopped.observing&&r8Stopped.authorDocumentSha256===author.authorDocumentSha256&&JSON.stringify(r8Stopped.authorPlayer)===JSON.stringify(author.authorPlayer)&&JSON.stringify(r8Stopped.camera)===JSON.stringify(author.camera)&&r8Stopped.ledger===0&&r8Stopped.models?.pending===0&&r8Stopped.models?.visibleDrawCount===0&&r8Stopped.models?.loaded.length===0&&r8Stopped.motions?.nodes.length===0,r8Stopped);
    check('真实Play重启原场景出生点',restarted.state==='playing'&&!restarted.observing&&restarted.player.runId!==playReturned.player.runId&&Math.hypot(restarted.player.x-author.authorPlayer.pos[0],restarted.player.z-author.authorPlayer.pos[2])<1e-5&&restarted.authorDocumentSha256===author.authorDocumentSha256,restarted);
    await aim();
    for(const [key,clip,peakRange] of [['a','walk_l',[.35,.46]],['d','walk_r',[.55,.66]]]) {
      await input.key(key,true);const start=report.samples.length,until=Date.now()+options.holdMs;
      while(Date.now()<until){await aim();await sleep(25);await snap(key+'-held');}
      const moving=report.samples.slice(start),evidence=gaitEvidence(moving,clip);check(key+'真实游戏横移/连续步态',evidence.ok&&evidence.wraps>=2,evidence);
      const grips=moving.map(s=>holdingEvidence(s,report.fallbackContract));check(key+'本帧双手持握与保留回退',grips.length>0&&grips.every(g=>g.ok),grips);
      await capture(key+'-normal-game');
      if(!await waitFor(async()=>{await aim();const s=await snap(key+'-pre-pause');return s.actor?.clip===clip&&s.actor.phase>=peakRange[0]&&s.actor.phase<=peakRange[1];},{timeout:1500,interval:25}))throw Error('未采到自然宽步相位');
      await click('#btn-pause');await input.key(key,false);const paused=await snap(key+'-pause');await sleep(250);const frozen=await snap(key+'-frozen');
      check(key+'Pause冻结原步态',paused.state==='paused'&&paused.actor?.clip===clip&&frozen.tick===paused.tick&&frozen.actor?.time===paused.actor?.time,{paused,frozen});
      await capture(key+'-paused-game');await click('#btn-freecam');
      const plan=observationPlan(paused);report.actions.push({observationPlan:key,...plan});await drag(plan.dx,plan.dy);
      const point=await visiblePoint(cdp,'#gpu');await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX:0,deltaY:plan.wheelDelta});await sleep(200);
      const beforePan=await cdp.eval(FRAMING_EXPRESSION),bounds=beforePan.bounds,rect=beforePan.canvas;
      if(!bounds)throw Error('全身投影不可得');
      const pan={dx:rect.left+rect.width*.28-(bounds.left+bounds.right)/2,dy:rect.top+rect.height*.52-(bounds.top+bounds.bottom)/2};
      report.actions.push({observationPan:key,...pan,before:beforePan});await drag(pan.dx,pan.dy,'right');
      const projection=await cdp.eval(FRAMING_EXPRESSION),framing=framingEvidence(projection);report.actions.push({observationFraming:key,projection,evidence:framing});check(key+'侧前全身/双膝双足无遮挡',framing.ok,framing);
      if(!framing.ok)throw Error('观察截图不满足全身可见：'+framing.reasons.join(','));
      const viewed=await capture(key+'-paused-observation');
      check(key+'冻结全身观察保留动作',viewed.observing&&viewed.tick===paused.tick&&viewed.actor?.time===paused.actor?.time&&viewed.actor?.clip===clip,viewed);
      await input.tap('v');await click('#btn-pause');await aim();await sleep(200);const idle=await snap(key+'-released');check(key+'停步回idle',idle.state==='playing'&&!idle.observing&&idle.actor?.clip==='idle',idle.actor);
    }
    for(const [key,clip] of [['w','walk_f'],['s','walk_b']]) {
      await aim();await input.key(key,true);const start=report.samples.length,until=Date.now()+600;
      while(Date.now()<until){await aim();await sleep(25);await snap(key+'-regression');}
      await input.key(key,false);const moving=report.samples.slice(start);check(key+'前后步态基本回归',moving.some(s=>s.state==='playing'&&!s.observing&&s.actor?.clip===clip)&&moving.some(s=>Math.hypot(s.player.x-moving[0].player.x,s.player.z-moving[0].player.z)>.2),moving.map(s=>({tick:s.tick,clip:s.actor?.clip,phase:s.actor?.phase,player:s.player})));
      await sleep(150);
    }
    await input.release();await sleep(200);const stoppedInput=await snap('stopped-input');check('释放输入回idle',stoppedInput.actor?.clip==='idle',stoppedInput.actor);
    await click('#btn-stop');await sleep(250);const stopped=await capture('final-stop');
    check('Stop作者文档/相机回滚',stopped.authorDocumentSha256===author.authorDocumentSha256&&JSON.stringify(stopped.authorPlayer)===JSON.stringify(author.authorPlayer)&&JSON.stringify(stopped.camera)===JSON.stringify(author.camera)&&!stopped.observing,{author,stopped});
    check('Stop资源账目归零',stopped.state==='stopped'&&stopped.ledger===0&&stopped.models?.pending===0&&stopped.models?.visibleDrawCount===0&&stopped.models?.loaded.length===0&&stopped.motions?.nodes.length===0,stopped);
  } catch(error) { report.exceptions.push(String(error)); }
  finally {
    if(input)report.cleanupInputErrors=await input.release();
    if(session){report.consoleErrors=session.cdp.consoleErrors;report.exceptions.push(...session.cdp.exceptions);try{let timer;try{await Promise.race([new Cdp(session.ws,undefined).send('Target.closeTarget',{targetId:session.targetId}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned target close timeout')),3000);})]);}finally{clearTimeout(timer);}}catch(error){report.cleanupTargetError=String(error);}session.ws.close();session.chrome.kill();}
    check('目标HEAD保持',head()===options.expectedHead,head());report.finishedAt=new Date().toISOString();report.passed=report.checks.length>=17&&report.checks.every(c=>c.ok)&&!report.exceptions.length&&!report.consoleErrors?.length&&!report.cleanupInputErrors?.length&&!report.cleanupTargetError;
    fs.writeFileSync(path.join(options.out,'observations.json'),JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify({passed:report.passed,evidence:options.out,checks:report.checks.map(c=>({name:c.name,ok:c.ok})),exceptions:report.exceptions}));return report.passed?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runStrafeProbe(strafeOptions(process.argv.slice(2))).then(code=>{process.exitCode=code;}).catch(error=>{console.error(String(error));process.exitCode=1;});
