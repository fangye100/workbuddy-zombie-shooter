/** 本任务有界 headed Play 探针；真实 CDP Input，正常 TLS，不修改游戏状态。 */
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {Cdp,launchEditorSession,waitFor,sleep} from './editor-smoke-lib.mjs';
const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const SCENE='assets/scenes/sandbox/weapon-assembly-trial.scene.json';
export function probeOptions(argv){
 const value=(name,fallback)=>{const i=argv.indexOf('--'+name);if(i<0)return fallback;if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('缺参数 '+name);return argv[i+1];};
 const root=path.resolve(value('root',REPO)),expectedHead=value('expected-head','');
 const url=new URL(value('url','https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene='+SCENE));
 if(!/^[a-f0-9]{40}$/.test(expectedHead))throw new Error('必须提供完整 --expected-head');
 if(url.protocol!=='https:'||url.hostname!=='fangye-win11-office.tail6b29a2.ts.net'||url.port!=='5198'||url.searchParams.get('scene')!==SCENE||url.searchParams.has('play')||url.searchParams.has('game'))throw new Error('入口必须为本次 MagicDNS:5198 的编辑态试验scene；不自动Play/隐藏编辑UI');
 const cdpPort=Number(value('cdp','9348')),holdMs=Number(value('hold-ms','1800'));
 if(!Number.isInteger(cdpPort)||cdpPort<1024||cdpPort>65535||!Number.isInteger(holdMs)||holdMs<800||holdMs>5000)throw new Error('cdp/hold-ms 超出有界范围');
 const out=path.resolve(root,value('out','.workbuddy/tmp/wpn-integration/weapon-assembly-headed'));
 if(!out.startsWith(path.join(root,'.workbuddy','tmp')+path.sep))throw new Error('证据只能写本检出 .workbuddy/tmp 子目录');
 return {root,expectedHead,url:url.href,cdpPort,holdMs,out,chromePath:value('chrome','C:/Program Files/Google/Chrome/Application/chrome.exe')};
}
export function profileOwners(processes,profile){
 const normalized=path.resolve(profile).replaceAll('\\','/').toLowerCase();
 return processes.filter(p=>{const command=p.CommandLine??'';const m=/--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s]+))/i.exec(command);return m&&path.resolve(m[1]??m[2]).replaceAll('\\','/').toLowerCase()===normalized;});
}
async function freePort(port){
 await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(new Error('CDP端口被占用；不接管/终止已有浏览器')));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
}
export const KEY={w:{key:'w',code:'KeyW',windowsVirtualKeyCode:87},r:{key:'r',code:'KeyR',windowsVirtualKeyCode:82},one:{key:'1',code:'Digit1',windowsVirtualKeyCode:49},seven:{key:'7',code:'Digit7',windowsVirtualKeyCode:55}};
export class ProbeInput {
 constructor(cdp,record=()=>{}){this.cdp=cdp;this.record=record;this.held=new Map();this.mouse=null;}
 async key(name,down){const spec=KEY[name];if(!spec)throw new Error('未知按键');if(down)this.held.set(name,spec);await this.cdp.send('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',...spec,nativeVirtualKeyCode:spec.windowsVirtualKeyCode});if(!down)this.held.delete(name);this.record({input:'key',name,down});}
 async tap(name){await this.key(name,true);await this.key(name,false);}
 async pointer(point,down){this.mouse=point;await this.cdp.send('Input.dispatchMouseEvent',{type:down?'mousePressed':'mouseReleased',x:point.x,y:point.y,button:'left',buttons:down?1:0,clickCount:1});if(!down)this.mouse=null;this.record({input:'mouse',point,down});}
 async release(){const errors=[];for(const name of [...this.held.keys()])try{await this.key(name,false);}catch(e){errors.push(String(e));}if(this.mouse)try{await this.pointer(this.mouse,false);}catch(e){errors.push(String(e));}return errors;}
}
const SNAPSHOT=`(async()=>{const e=window.__editor,c=e?.playCtl,r=c?.session.runtime,p=r?.player(),d=e?.renderer.getDocument(),o=e?.renderer.state.objects.find(o=>o.nodeId===d?.playerStart&&!o.removed),s=o?.skinState;const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(d??null)));const authorDocumentSha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
 return {authorDocumentSha256,authorPlayer:o?{nodeId:o.nodeId,pos:[...o.pos],quat:[...o.quat],scale:o.scale,visible:o.visible}:null,url:location.href,secure:isSecureContext,focus:document.activeElement?.tagName,state:c?.state,tick:c?.tick,cycle:c?.session.cycleCount,ledger:c?.ledger?.pending,player:p??null,weapons:r?.weapons.snapshot()??null,lastShot:r?.lastShot??null,models:e?.weaponModels.snapshot()??null,motions:e?.motions.summary()??null,bodyIk:e?.bodyIk.summary()??null,
 actor:s?{clip:s.clips[s.clip]?.name??null,time:s.time,playing:s.playing,layer:s.poseLayer?{clip:s.clips[s.poseLayer.clip]?.name??null,time:s.poseLayer.time,weight:s.poseLayer.binding.weight}:null,legMatrices:o.skeleton.jointNames.flatMap((name,i)=>/Leg|Foot/.test(name)?[{name,matrix:Array.from(o.skinScratch.slice(i*16,(i+1)*16))}]:[]).slice(0,8)}:null,
 source:e?.renderer.getSceneSource()?.url??null,sceneId:e?.renderer.getDocument()?.id??null,frame:e?.renderer.state.frameCounter};})()`;
async function visiblePoint(cdp,selector){
 const value=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e),x=r.x+r.width/2,y=r.y+r.height/2,t=document.elementFromPoint(x,y);return r.width>5&&r.height>5&&x>0&&y>0&&x<innerWidth&&y<innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&!e.disabled&&(t===e||e.contains(t))?{x,y}:null;})()`);
 if(!value)throw new Error('可见/可点击控件缺失或遮挡 '+selector);return value;
}
async function run(options){
 const head=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:options.root,encoding:'utf8'}).trim();
 if(fs.realpathSync(options.root)!==fs.realpathSync(REPO)||fs.realpathSync(process.cwd())!==fs.realpathSync(options.root))throw new Error('root/cwd 与脚本所属检出不一致');
 if(head()!==options.expectedHead)throw new Error('HEAD不匹配，拒绝移动target验证');
 if(process.platform!=='win32')throw new Error('此入口只适配当前Windows；不猜测其他主机归属');
 const profile=path.join(options.root,'.workbuddy/tmp/chrome-profile');
 const raw=execFileSync('powershell.exe',['-NoProfile','-Command',"Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],{encoding:'utf8'}).trim();
 const processes=raw?([JSON.parse(raw)].flat()):[];if(processes.some(p=>!p.CommandLine))throw new Error('部分Chrome进程CommandLine不可读，无法确认profile归属；停止');
 const owners=profileOwners(processes,profile);if(owners.length)throw new Error('保留profile正被Chrome持有，拒绝启动：PID '+owners.map(p=>p.ProcessId).join(','));
 await freePort(options.cdpPort);fs.mkdirSync(options.out,{recursive:true});
 const report={targetHead:options.expectedHead,root:options.root,url:options.url,scene:SCENE,sceneSha256:createHash('sha256').update(fs.readFileSync(path.join(options.root,SCENE))).digest('hex'),profile,cdpPort:options.cdpPort,normalTls:true,startedAt:new Date().toISOString(),samples:[],checks:[],actions:[],screenshots:[],limitations:['CPU skinScratch 是本帧上传数据，不是GPU readback；可见握姿/腿步态仍须人工看截图。','此脚本不覆盖静态LOD视图；不强制人为制造迟到decode。'],consoleErrors:[],exceptions:[]};
 let session,input;const check=(name,ok,detail)=>report.checks.push({name,ok:!!ok,detail});
 const save=()=>fs.writeFileSync(path.join(options.out,'observations.json'),JSON.stringify(report,null,2)+'\n');
 try{
  session=await launchEditorSession({chromePath:options.chromePath,cdpPort:options.cdpPort,headed:true,appUrl:options.url,ignoreCertificateErrors:false,setupTimeoutMs:30000,windowSize:'1440,1000'});
  const browser=new Cdp(session.ws,undefined);let pidTimer;let processInfo;try{processInfo=await Promise.race([browser.send('SystemInfo.getProcessInfo'),new Promise((_,reject)=>{pidTimer=setTimeout(()=>reject(new Error('browser PID核对超时')),10000);})]);}finally{clearTimeout(pidTimer);}const browserPid=processInfo.processInfo.find(p=>p.type==='browser')?.id;
  report.browser={pid:session.chrome.pid,browserPid,targetId:session.targetId,flags:session.flags};if(browserPid!==session.chrome.pid)throw new Error('Chrome复用了其他进程，拒绝业务导航');
  const rawSend=session.cdp.send.bind(session.cdp),deadline=Date.now()+120000;
  session.cdp.send=(method,params)=>{const timeout=Math.min(10000,deadline-Date.now());if(timeout<=0)return Promise.reject(new Error('探针120s预算用尽'));let timer;return Promise.race([rawSend(method,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CDP命令超时 '+method)),timeout);})]).finally(()=>clearTimeout(timer));};
  input=new ProbeInput(session.cdp,event=>report.actions.push({...event,atMs:Date.now()}));
  const cdp=session.cdp,nav=await cdp.send('Page.navigate',{url:options.url});if(nav.errorText)throw new Error('正常TLS导航失败 '+nav.errorText);
  const ready=await waitFor(()=>cdp.eval('!!window.__editor?.playCtl && window.__editor.renderer.pendingAssetCount===0'),{timeout:30000,interval:200});if(!ready)throw new Error('编辑器/真实资产未就绪（可能TLS/加载/页面错误）');
  await cdp.send('Page.bringToFront');
  const gpu=await cdp.eval('(async()=>{const a=await navigator.gpu?.requestAdapter();const i=a?.info??(a?.requestAdapterInfo?await a.requestAdapterInfo():null);return {secure:isSecureContext,vendor:i?.vendor,architecture:i?.architecture,description:i?.description};})()');report.gpu=gpu;
  check('HTTPS secure真实硬件',gpu?.secure&&gpu?.vendor==='nvidia'&&gpu?.architecture==='lovelace',gpu);if(!report.checks.at(-1).ok)throw new Error('未确认本机真实GPU，停止实操');
  const snap=async label=>{const sample={label,atMs:Date.now(),...await cdp.eval(SNAPSHOT)};report.samples.push(sample);return sample;};
  const capture=async label=>{const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const file=label+'.png';fs.writeFileSync(path.join(options.out,file),Buffer.from(data,'base64'));report.screenshots.push({label,file,sample:report.samples.length-1});};
  const click=async selector=>{const point=await visiblePoint(cdp,selector);await input.pointer(point,true);await input.pointer(point,false);report.actions.push({click:selector,atMs:Date.now()});};
  const sampleFor=async(label,ms)=>{const until=Date.now()+ms;while(Date.now()<until){await sleep(120);await snap(label);}};
  const editor=await snap('editor');const expectedSceneId=JSON.parse(fs.readFileSync(path.join(options.root,SCENE),'utf8')).id;check('真实场景身份',editor.sceneId===expectedSceneId,editor.sceneId);if(editor.sceneId!==expectedSceneId)throw new Error('加载场景ID不匹配');await capture('01-editor');await click('#btn-play');
  if(!await waitFor(()=>cdp.eval('window.__editor.playCtl.state==="playing"'),{timeout:5000}))throw new Error('UI Play 未进入运行');
  if(!await waitFor(()=>cdp.eval('window.__editor.weaponModels.snapshot().visible'),{timeout:20000,interval:150}))throw new Error('真实模型未形成有效本帧draw');
  const baseline=await snap('play-ready');await capture('02-pistol');
  const canvas=await visiblePoint(cdp,'#gpu');await input.pointer(canvas,true);await input.pointer(canvas,false);
  await input.key('w',true);await input.pointer(canvas,true);await sampleFor('held-move-fire',options.holdMs);await capture('03-moving-fire');
  const moving=report.samples.filter(s=>s.label==='held-move-fire');check('真实held移动',moving.some(s=>Math.hypot(s.player.x-baseline.player.x,s.player.z-baseline.player.z)>.1),{before:baseline.player,after:moving.at(-1)?.player});
  const legsChanged=samples=>samples.length>1&&samples.some(s=>JSON.stringify(s.actor?.legMatrices)!==JSON.stringify(samples[0].actor?.legMatrices))&&samples.some(s=>/walk|run|jog|sprint|strafe/i.test(s.actor?.clip??''));
  check('移动期间locomotion和腿矩阵继续',legsChanged(moving),moving.map(s=>({clip:s.actor?.clip,time:s.actor?.time})));
  check('移动期间实际射击',moving.some(s=>s.lastShot?.tick>=baseline.tick),moving.at(-1)?.lastShot);
  await input.tap('seven');await sampleFor('held-switch-launcher',1000);const launcher=await snap('launcher');check('按7切实际Launcher',launcher.models?.visible&&launcher.models.weaponId==='launcher',launcher.models);await capture('04-launcher');
  await input.pointer(canvas,false);await input.tap('one');await sampleFor('held-switch-pistol',800);check('按1回Pistol',report.samples.at(-1)?.models?.weaponId==='pistol',report.samples.at(-1)?.models);
  await input.tap('r');await sampleFor('held-move-reload',2500);const reload=report.samples.filter(s=>s.label==='held-move-reload');check('移动中换弹phase',reload.some(s=>s.models?.pose?.action==='reload')&&Math.hypot(reload.at(-1).player.x-reload[0].player.x,reload.at(-1).player.z-reload[0].player.z)>.1,{phases:reload.map(s=>s.models?.pose?.phase)});check('reload期间腿部locomotion继续',legsChanged(reload),reload.map(s=>({clip:s.actor?.clip,time:s.actor?.time})));await capture('05-after-reload');
  check('reload期间本帧模型/双手结果',reload.some(s=>s.models?.visible&&s.models.frameStamp===s.frame&&Number.isFinite(s.models.measurements?.leftTargetResidualM)),reload.at(-1)?.models);
  await input.release();await click('#btn-pause');const paused=await snap('pause-start');await sleep(600);const frozen=await snap('pause-end');check('Pause模拟与动作时钟冻结',paused.state==='paused'&&frozen.tick===paused.tick&&frozen.actor?.time===paused.actor?.time&&frozen.actor?.layer?.time===paused.actor?.layer?.time,{paused,frozen});await capture('06-paused');
  await click('#btn-stop');const stopped=await snap('stop');check('作者回滚',JSON.stringify(stopped.authorPlayer)===JSON.stringify(editor.authorPlayer)&&stopped.authorDocumentSha256===editor.authorDocumentSha256,{before:editor.authorPlayer,after:stopped.authorPlayer,beforeHash:editor.authorDocumentSha256,afterHash:stopped.authorDocumentSha256});check('Stop账目归零',stopped.state==='stopped'&&stopped.ledger===0&&stopped.models?.visibleDrawCount===0,stopped);await capture('07-stop');
  await click('#btn-play');await waitFor(()=>cdp.eval('window.__editor.weaponModels.snapshot().visible'),{timeout:20000,interval:150});const restarted=await snap('restart');check('重启新身份与模型',restarted.cycle>baseline.cycle&&restarted.player?.runId!==baseline.player?.runId&&restarted.models?.visible,restarted);await capture('08-restart');
  await click('#btn-stop');await sleep(500);const final=await snap('final-stop');check('重启后作者再次回滚',JSON.stringify(final.authorPlayer)===JSON.stringify(editor.authorPlayer)&&final.authorDocumentSha256===editor.authorDocumentSha256,{before:editor.authorPlayer,after:final.authorPlayer,beforeHash:editor.authorDocumentSha256,afterHash:final.authorDocumentSha256});check('重启Stop无残留',final.ledger===0&&final.models?.pending===0&&final.models?.loaded.length===0,final);
 }catch(error){report.exceptions.push(String(error));}
 finally{
  if(input)report.cleanupInputErrors=await input.release();
  if(session){report.consoleErrors=session.cdp.consoleErrors;report.exceptions.push(...session.cdp.exceptions);try{const bcdp=new Cdp(session.ws,undefined);let cleanupTimer;try{await Promise.race([bcdp.send('Target.closeTarget',{targetId:session.targetId}),new Promise((_,reject)=>{cleanupTimer=setTimeout(()=>reject(new Error('owned target关闭超时')),3000);})]);}finally{clearTimeout(cleanupTimer);}}catch(e){report.cleanupTargetError=String(e);}session.ws.close();session.chrome.kill();}
  check('target HEAD保持',head()===options.expectedHead,head());report.finishedAt=new Date().toISOString();report.passed=report.checks.length>=17&&report.checks.every(c=>c.ok)&&!report.exceptions.length&&!report.consoleErrors.length&&!report.cleanupInputErrors?.length&&!report.cleanupTargetError;save();
 }
 console.log(JSON.stringify({passed:report.passed,evidence:options.out,checks:report.checks.map(c=>({name:c.name,ok:c.ok})),exceptions:report.exceptions}));return report.passed?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))run(probeOptions(process.argv.slice(2))).then(code=>{process.exitCode=code;}).catch(error=>{console.error(String(error));process.exitCode=1;});
