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

const SNAPSHOT = `(async()=>{const e=window.__editor,c=e?.playCtl,r=c?.session.runtime,p=r?.player(),d=e?.renderer.getDocument(),o=e?.renderer.state.objects.find(o=>o.nodeId===d?.playerStart&&!o.removed),s=o?.skinState,clip=s?.clips[s.clip];const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(d??null)));
 const bones=o?.skeleton?o.skeleton.jointNames.flatMap((name,i)=>/^(Hips|LeftFoot|RightFoot|LeftHand|RightHand)$/.test(name)?[{name,local:(${posedJointPosition.toString()})(o.skinScratch.slice(i*16,(i+1)*16),o.skeleton.normalization,o.skeleton.inverseBind.slice(i*16,(i+1)*16))}]:[]):[];
 const points=bones.map(b=>({...b,world:b.local?(${actorPoint.toString()})(b.local,o):null}));
 return {state:c?.state,tick:c?.tick,fixedStep:r?.fixedStep,frame:e?.renderer.state.frameCounter,observing:c?.observing,camera:structuredClone(e?.camera),authorDocumentSha256:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join(''),dirty:e?.renderer.state.sceneDirty??null,player:p??null,ledger:c?.ledger?.pending,models:e?.weaponModels.snapshot()??null,motions:e?.motions.summary()??null,bodyIk:e?.bodyIk.summary()??null,authorPlayer:o?{nodeId:o.nodeId,pos:[...o.pos],quat:[...o.quat],scale:o.scale,visible:o.visible}:null,
 actor:s?{clip:clip?.name??null,time:s.time,duration:clip?.duration??null,phase:clip?.duration>0?s.time/clip.duration:null,normalization:Array.from(o.skeleton.normalization),feet:['LeftFoot','RightFoot'].map(name=>points.find(p=>p.name===name)),hips:points.find(p=>p.name==='Hips'),hands:points.filter(p=>/Hand$/.test(p.name)),debug:e.motions.debugSnapshot(d.playerStart)}:null};})()`;

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
    if(!await waitFor(async()=>{report.readiness=await cdp.eval(readiness);return report.readiness?.ok;},{timeout:30000,interval:200}))throw Error('作者场景、GLB 或 Play 控件未就绪');
    await cdp.send('Page.bringToFront');
    report.gpu=await cdp.eval('(async()=>{const a=await navigator.gpu?.requestAdapter(),i=a?.info??(a?.requestAdapterInfo?await a.requestAdapterInfo():null);return {secure:isSecureContext,vendor:i?.vendor,architecture:i?.architecture,description:i?.description};})()');
    check('HTTPS/真实 NVIDIA',report.gpu.secure&&report.gpu.vendor==='nvidia'&&report.gpu.architecture==='lovelace',report.gpu);if(!report.checks.at(-1).ok)throw Error('未确认真实 GPU');
    const snap=async label=>{const sample={label,atMs:Date.now(),...await cdp.eval(SNAPSHOT)};report.samples.push(sample);return sample;};
    const click=async selector=>{const point=await visiblePoint(cdp,selector);await input.pointer(point,true);await input.pointer(point,false);report.actions.push({click:selector,atMs:Date.now()});};
    const capture=async label=>{const sample=await snap(label),before=await cdp.eval('window.__editor.renderer.state.frameCounter'),{data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),after=await cdp.eval('window.__editor.renderer.state.frameCounter'),file=label+'.png';fs.writeFileSync(path.join(options.out,file),Buffer.from(data,'base64'));report.screenshots.push({file,sample:report.samples.length-1,frameRange:[before,after],clip:sample.actor?.clip,phase:sample.actor?.phase,state:sample.state,observing:sample.observing});return sample;};
    const author=await snap('author');await capture('01-author');await click('#btn-play');
    if(!await waitFor(()=>cdp.eval('window.__editor.playCtl.state==="playing"&&window.__editor.weaponModels.snapshot().visible&&window.__editor.motions.summary().pending===0'),{timeout:20000,interval:150}))throw Error('Play/动作/持握模型未就绪');
    report.ikPanel=await collapseIkPanel(cdp,click,action=>report.actions.push({...action,atMs:Date.now()}));
    const baseline=await snap('play-ready');check('正常游戏视图与持枪',!baseline.observing&&baseline.models.visible&&baseline.models.weaponId==='pistol',baseline.models);
    const cameraYaw=baseline.camera.yaw,aimYaw=Math.atan2(-Math.cos(cameraYaw),-Math.sin(cameraYaw))*180/Math.PI;
    const aim=async()=>{const point=await aimPoint(cdp,aimYaw,action=>report.actions.push({...action,atMs:Date.now()}));await input.move(point);};
    await aim();
    for(const [key,clip,peakRange] of [['a','walk_l',[.35,.46]],['d','walk_r',[.55,.66]]]) {
      await input.key(key,true);const start=report.samples.length,until=Date.now()+options.holdMs;
      while(Date.now()<until){await aim();await sleep(25);await snap(key+'-held');}
      const moving=report.samples.slice(start),evidence=gaitEvidence(moving,clip);check(key+'真实游戏横移/连续步态',evidence.ok&&evidence.wraps>=2,evidence);
      check(key+'上身持枪保持',moving.some(s=>s.actor?.debug?.layer?.status==='ready')&&moving.every(s=>s.models?.visible&&s.models.weaponId==='pistol'),moving.map(s=>({frame:s.frame,clip:s.actor?.clip,layer:s.actor?.debug?.layer,weapon:s.models?.weaponId,draw:s.models?.frameStamp})));
      await capture(key+'-normal-game');
      if(!await waitFor(async()=>{await aim();const s=await snap(key+'-pre-pause');return s.actor?.clip===clip&&s.actor.phase>=peakRange[0]&&s.actor.phase<=peakRange[1];},{timeout:1500,interval:25}))throw Error('未采到自然宽步相位');
      await click('#btn-pause');await input.key(key,false);const paused=await snap(key+'-pause');await sleep(250);const frozen=await snap(key+'-frozen');
      check(key+'Pause冻结原步态',paused.state==='paused'&&paused.actor?.clip===clip&&frozen.tick===paused.tick&&frozen.actor?.time===paused.actor?.time,{paused,frozen});
      await capture(key+'-paused-game');await click('#btn-observation-camera');
      const point=await visiblePoint(cdp,'#gpu');await input.pointer(point,true);for(let k=1;k<=4;k++){await input.move({x:point.x+80*k/4,y:point.y+15*k/4});await sleep(25);}await input.pointer({x:point.x+80,y:point.y+15},false);
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX:0,deltaY:240});await sleep(150);
      const viewed=await capture(key+'-paused-observation');
      check(key+'冻结全身观察保留动作',viewed.observing&&viewed.tick===paused.tick&&viewed.actor?.time===paused.actor?.time&&viewed.actor?.clip===clip,viewed);
      await click('#btn-observation-camera');await click('#btn-pause');await aim();await sleep(200);const idle=await snap(key+'-released');check(key+'停步回idle',idle.state==='playing'&&!idle.observing&&idle.actor?.clip==='idle',idle.actor);
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
