/** 本任务有界 headed Play 探针；真实 CDP Input，正常 TLS，不修改游戏状态。 */
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {Cdp,launchEditorSession,waitFor,sleep} from './editor-smoke-lib.mjs';
import {STATIC_SCENES,staticNodes,captureStatic} from './weapon-static.mjs';
const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const SCENE='assets/scenes/sandbox/weapon-assembly-trial.scene.json';
const WEAPONS=['pistol','shotgun','smg','sniper','chainsaw','flame','launcher'];
export function probeOptions(argv){
 const value=(name,fallback)=>{const i=argv.indexOf('--'+name);if(i<0)return fallback;if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('缺参数 '+name);return argv[i+1];};
 const root=path.resolve(value('root',REPO)),expectedHead=value('expected-head','');
 const staticScene=value('static-scene',null),nodeIds=value('nodes','').split(',').filter(Boolean);
 if(staticScene!==null&&(!STATIC_SCENES.includes(staticScene)||nodeIds.length<1||nodeIds.length>12||new Set(nodeIds).size!==nodeIds.length||nodeIds.some(id=>!/^nd_[a-zA-Z0-9_-]+$/.test(id))))throw new Error('static-scene 必须为登记候选场景及1–12个唯一稳定 --nodes');
 if(staticScene===null&&nodeIds.length)throw new Error('--nodes 只用于 static-scene');
 if(staticScene!==null&&['--all-weapons','--weapon','--aim-ratio','--side-aim-ratio','--aim-yaw','--side-aim-yaw'].some(a=>argv.includes(a)))throw new Error('静态模式不能混入Play输入选项');
 const weaponIds=value('weapon','').split(',').filter(Boolean);
 if(argv.includes('--weapon')&&(!weaponIds.length||new Set(weaponIds).size!==weaponIds.length||weaponIds.some(id=>!WEAPONS.includes(id))))throw new Error('--weapon 必须为七件武器中的唯一ID列表');
 if(weaponIds.length&&argv.includes('--all-weapons'))throw new Error('--weapon 与 --all-weapons 不能混用');
 const scene=staticScene??SCENE,url=new URL(value('url','https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene='+scene));
 if(!/^[a-f0-9]{40}$/.test(expectedHead))throw new Error('必须提供完整 --expected-head');
 if(url.protocol!=='https:'||url.hostname!=='fangye-win11-office.tail6b29a2.ts.net'||url.port!=='5198'||url.searchParams.get('scene')!==scene||url.searchParams.has('play')||url.searchParams.has('game'))throw new Error('入口必须为本次 MagicDNS:5198 的编辑态试验scene；不自动Play/隐藏编辑UI');
 const cdpPort=Number(value('cdp','9348')),holdMs=Number(value('hold-ms','1800'));
 if(!Number.isInteger(cdpPort)||cdpPort<1024||cdpPort>65535||!Number.isInteger(holdMs)||holdMs<800||holdMs>5000)throw new Error('cdp/hold-ms 超出有界范围');
 const out=path.resolve(root,value('out','.workbuddy/tmp/wpn-integration/weapon-assembly-headed'));
 if(!out.startsWith(path.join(root,'.workbuddy','tmp')+path.sep))throw new Error('证据只能写本检出 .workbuddy/tmp 子目录');
 const ratio=name=>{const raw=value(name,null);if(raw===null)return null;const a=raw.split(',').map(Number);if(a.length!==2||a.some(n=>!Number.isFinite(n)||n<.05||n>.95))throw new Error(name+' 必须是有界画布比例 x,y (.05–.95)');return a;};
 const yaw=name=>{const raw=value(name,null);if(raw===null)return null;const n=Number(raw);if(!Number.isFinite(n)||n<-180||n>180)throw new Error(name+' 必须为 -180..180 世界方位角(度)');return n;};
 const aimYaw=yaw('aim-yaw'),sideAimYaw=yaw('side-aim-yaw'),aimRatio=ratio('aim-ratio'),sideAimRatio=ratio('side-aim-ratio');
 if(aimYaw!==null&&aimRatio||sideAimYaw!==null&&sideAimRatio)throw new Error('同一瞄准点不能同时指定yaw和ratio');
 return {root,expectedHead,url:url.href,staticScene,nodeIds,cdpPort,holdMs,out,weaponIds,allWeapons:argv.includes('--all-weapons')||weaponIds.length>0,aimRatio,sideAimRatio,aimYaw,sideAimYaw,chromePath:value('chrome','C:/Program Files/Google/Chrome/Application/chrome.exe')};
}
/** Read-only reconstruction: uploaded skin matrix × normalized inverse-bind origin. */
export function posedJointPosition(skin,normalization,ib){
 const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0);
 const a=Array.from(ib.slice(0,3)),b=Array.from(ib.slice(4,7)),c=Array.from(ib.slice(8,11)),v=Array.from(ib.slice(12,15),n=>-n),det=dot(a,cross(b,c));
 if(!Number.isFinite(det)||Math.abs(det)<1e-12)return null;
 const rest=[dot(v,cross(b,c))/det,dot(a,cross(v,c))/det,dot(a,cross(b,v))/det];
 const point=(m,p)=>[0,1,2].map(i=>m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12]);
 return point(skin,point(normalization,rest));
}
export function groundRayPoint(ray,height){
 if(!ray||!ray.o?.every(Number.isFinite)||!ray.d?.every(Number.isFinite)||Math.abs(ray.d[1])<1e-6)return null;
 const t=(height-ray.o[1])/ray.d[1];return t>0&&Number.isFinite(t)?[ray.o[0]+ray.d[0]*t,height,ray.o[2]+ray.d[2]*t]:null;
}
/** 作者文档先到并不代表 GLB、Hierarchy 和启动按钮已同步。只读真实投影。 */
export function sceneReadinessExpression(doc,scene){
 const meshes=doc.nodes.flatMap(n=>{const c=n.components.find(c=>c.kind==='MeshRenderer'&&c.enabled!==false);return c&&n.visible!==false?[{id:n.id,name:n.name,asset:c.source.type==='asset'?c.source.ref.path:null,hierarchy:c.background!==true}]:[];});
 return `(()=>{const e=window.__editor;if(!e?.playCtl)return {ok:false,reason:'editor missing'};const r=e.renderer,d=r.getDocument(),source=r.getSceneSource()?.url,expected=${JSON.stringify(meshes)},meshes=expected.map(n=>{const i=r.state.objects.findIndex(o=>o.nodeId===n.id&&!o.removed),o=r.state.objects[i],name=document.querySelector('#hierarchy .hier-row[data-index="'+i+'"]:not(.hier-sub) .hier-name')?.textContent;return {...n,index:i,actualName:o?.name,loadedAssetPath:o?.loadedAssetPath??null,hierarchyName:name??null,ok:i>=0&&o.name===n.name&&(!n.asset||o.loadedAssetPath===n.asset)&&(!n.hierarchy||name===n.name)};}),b=document.querySelector('#btn-play'),rect=b?.getBoundingClientRect(),hit=rect?document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2):null,button=!!rect&&rect.width>5&&rect.height>5&&!b.disabled&&(hit===b||b.contains(hit));return {ok:d?.id===${JSON.stringify(doc.id)}&&source===${JSON.stringify(scene)}&&r.pendingAssetCount===0&&meshes.every(n=>n.ok)&&button,sceneId:d?.id,source,pending:r.pendingAssetCount,meshes,button,state:e.playCtl.state,error:e.playCtl.error,frame:r.state.frameCounter};})()`;
}
function actorPoint(p,o){
 const [x,y,z,w]=o.quat,v=p.map(n=>n*o.scale),t=[2*(y*v[2]-z*v[1]),2*(z*v[0]-x*v[2]),2*(x*v[1]-y*v[0])];
 return [v[0]+w*t[0]+y*t[2]-z*t[1]+o.pos[0],v[1]+w*t[1]+z*t[0]-x*t[2]+o.pos[1],v[2]+w*t[2]+x*t[1]-y*t[0]+o.pos[2]];
}
export function profileOwners(processes,profile){
 const normalized=path.resolve(profile).replaceAll('\\','/').toLowerCase();
 return processes.filter(p=>{const command=p.CommandLine??'';const m=/--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s]+))/i.exec(command);return m&&path.resolve(m[1]??m[2]).replaceAll('\\','/').toLowerCase()===normalized;});
}
async function freePort(port){
 await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(new Error('CDP端口被占用；不接管/终止已有浏览器')));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
}
export const KEY={w:{key:'w',code:'KeyW',windowsVirtualKeyCode:87},s:{key:'s',code:'KeyS',windowsVirtualKeyCode:83},r:{key:'r',code:'KeyR',windowsVirtualKeyCode:82},...Object.fromEntries(['one','two','three','four','five','six','seven'].map((name,i)=>[name,{key:String(i+1),code:'Digit'+(i+1),windowsVirtualKeyCode:49+i}]))};
export class ProbeInput {
 constructor(cdp,record=()=>{}){this.cdp=cdp;this.record=record;this.held=new Map();this.mouse=null;}
 async key(name,down){const spec=KEY[name];if(!spec)throw new Error('未知按键');if(down)this.held.set(name,spec);await this.cdp.send('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',...spec,nativeVirtualKeyCode:spec.windowsVirtualKeyCode});if(!down)this.held.delete(name);this.record({input:'key',name,down});}
 async tap(name){await this.key(name,true);await this.key(name,false);}
 async move(point){this.position=point;await this.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'none',buttons:this.mouse?1:0});if(this.mouse)this.mouse=point;this.record({input:'mouseMove',point});}
 async pointer(point,down){this.position=point;this.mouse=point;await this.cdp.send('Input.dispatchMouseEvent',{type:down?'mousePressed':'mouseReleased',x:point.x,y:point.y,button:'left',buttons:down?1:0,clickCount:1});if(!down)this.mouse=null;this.record({input:'mouse',point,down});}
 async release(){const errors=[];for(const name of [...this.held.keys()])try{await this.key(name,false);}catch(e){errors.push(String(e));}if(this.mouse)try{await this.pointer(this.mouse,false);}catch(e){errors.push(String(e));}return errors;}
}
KEY.f={key:'f',code:'KeyF',windowsVirtualKeyCode:70};
const SNAPSHOT=`(async()=>{const e=window.__editor,c=e?.playCtl,r=c?.session.runtime,p=r?.player(),d=e?.renderer.getDocument(),o=e?.renderer.state.objects.find(o=>o.nodeId===d?.playerStart&&!o.removed),s=o?.skinState;const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(d??null)));const authorDocumentSha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
 return {authorDocumentSha256,authorPlayer:o?{nodeId:o.nodeId,pos:[...o.pos],quat:[...o.quat],scale:o.scale,visible:o.visible}:null,url:location.href,secure:isSecureContext,focus:document.activeElement?.tagName,state:c?.state,tick:c?.tick,cycle:c?.session.cycleCount,ledger:c?.ledger?.pending,player:p??null,weapons:r?.weapons.snapshot()??null,weaponEvents:r?.weapons.events.map(e=>({...e}))??[],firing:r?.firing??null,lastShot:r?.lastShot??null,models:e?.weaponModels.snapshot()??null,motions:e?.motions.summary()??null,bodyIk:e?.bodyIk.summary()??null,
 actor:s?{clip:s.clips[s.clip]?.name??null,time:s.time,playing:s.playing,layer:s.poseLayer?{clip:s.clips[s.poseLayer.clip]?.name??null,time:s.poseLayer.time,weight:s.poseLayer.binding.weight}:null,attachmentRequest:s.bodyIk?.attachment??null,handChains:o.skeleton.jointNames.flatMap((name,i)=>/(Left|Right)(Arm|ForeArm|Hand)$/.test(name)?[{name,position:(${posedJointPosition.toString()})(o.skinScratch.slice(i*16,(i+1)*16),o.skeleton.normalization,o.skeleton.inverseBind.slice(i*16,(i+1)*16))}]:[]),legMatrices:o.skeleton.jointNames.flatMap((name,i)=>/Leg|Foot/.test(name)?[{name,matrix:Array.from(o.skinScratch.slice(i*16,(i+1)*16))}]:[]).slice(0,8)}:null,
 source:e?.renderer.getSceneSource()?.url??null,sceneId:e?.renderer.getDocument()?.id??null,frame:e?.renderer.state.frameCounter};})()`;
async function visiblePoint(cdp,selector){
 const value=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e),x=r.x+r.width/2,y=r.y+r.height/2,t=document.elementFromPoint(x,y);return r.width>5&&r.height>5&&x>0&&y>0&&x<innerWidth&&y<innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&!e.disabled&&(t===e||e.contains(t))?{x,y}:null;})()`);
 if(!value)throw new Error('可见/可点击控件缺失或遮挡 '+selector);return value;
}
/** 每项拒绝都保留原始 client/plane 数据，不把失败折叠成 null。 */
export function aimPointExpression(spec){
 return `(${inspectAimPoint.toString()})(${JSON.stringify(spec)},${groundRayPoint.toString()})`;
}
function inspectAimPoint(spec,intersect){
 const e=document.querySelector('#gpu'),editor=window.__editor;
 const result={ok:false,reasons:[],spec,frame:editor?.renderer.state.frameCounter,tick:editor?.playCtl.tick};
 if(!e){result.reasons.push('canvas-missing');return result;}
 const r=e.getBoundingClientRect(),player=editor.playCtl.session.runtime?.player();
 Object.assign(result,{canvasRect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},canvasPixels:[e.width,e.height],dpr:devicePixelRatio,viewport:[innerWidth,innerHeight],player,camera:structuredClone(editor.camera)});
 let requested=null,screen=null;
 if(typeof spec==='number'){
  if(!player){result.reasons.push('player-missing');return result;}
  const a=spec*Math.PI/180;requested=[player.x+.75*Math.cos(a),.9,player.z+.75*Math.sin(a)];
  screen=editor.renderer.worldToScreen(requested);if(screen.behind)result.reasons.push('projection-behind');
 }
 const x=screen?.x??r.left+r.width*spec[0],y=screen?.y??r.top+r.height*spec[1],hit=document.elementFromPoint(x,y);
 Object.assign(result,{x,y,ratio:[(x-r.left)/r.width,(y-r.top)/r.height],requested,requestedYawDeg:typeof spec==='number'?spec:null,screen,actualElement:hit?{tag:hit.tagName,id:hit.id,className:String(hit.className)}:null});
 if(hit!==e)result.reasons.push('pointer-ui-occluded');
 if(!(x>r.left&&y>r.top&&x<r.right&&y<r.bottom))result.reasons.push('pointer-outside-canvas');
 if(!(x>0&&y>0&&x<innerWidth&&y<innerHeight))result.reasons.push('pointer-outside-viewport');
 const node=editor.renderer.getDocument().nodes.find(n=>n.components.some(c=>c.kind==='MeshRenderer'&&c.source.type==='builtin'&&c.source.shape==='plane'));
 if(!node){result.reasons.push('ground-missing');return result;}
 result.groundNode=node.id;result.groundTransform=structuredClone(node.transform);
 if(node.parent!==null||node.transform.rotation.some((n,i)=>Math.abs(n-(i===3?1:0))>1e-6)){result.reasons.push('ground-transform-unsupported');return result;}
 const mesh=node.components.find(c=>c.kind==='MeshRenderer'),ray=editor.renderer.pointerRay(x,y),ground=intersect(ray,node.transform.position[1]),gameAim=intersect(ray,.9),halfX=mesh.source.params[0]*node.transform.scale[0]/2,halfZ=mesh.source.params[1]*node.transform.scale[2]/2;
 const groundBounds={minX:node.transform.position[0]-halfX,maxX:node.transform.position[0]+halfX,minZ:node.transform.position[2]-halfZ,maxZ:node.transform.position[2]+halfZ};
 const aimErrorM=requested&&gameAim?Math.hypot(...gameAim.map((n,i)=>n-requested[i])):null;
 Object.assign(result,{ray,ground,gameAim,groundBounds,aimErrorM});
 if(!ground)result.reasons.push('ground-ray-no-forward-hit');
 if(!gameAim)result.reasons.push('aim-plane-no-forward-hit');
 if(requested&&gameAim&&aimErrorM>1e-4)result.reasons.push('aim-projection-mismatch');
 if(ground&&(ground[0]<groundBounds.minX||ground[0]>groundBounds.maxX||ground[2]<groundBounds.minZ||ground[2]>groundBounds.maxZ))result.reasons.push('ground-outside-authored-bounds');
 result.ok=result.reasons.length===0;return result;
}
async function aimPoint(cdp,spec,record=()=>{}){
 const result=await cdp.eval(aimPointExpression(spec));record({input:'aimGuard',...result});
 if(!result?.ok)throw new Error('瞄准guard拒绝：'+(result?.reasons?.join(',')??'missing-result'));
 return result;
}
/** 仅决定下一次真实 W/S 输入；地面和命中条件不变。 */
export function groundMovementDirection(point,preferred,marginM=1.5){
 const {ground:g,groundBounds:b,camera}=point,sign=preferred==='w'?-1:1;
 const dx=Math.sin(camera.yaw)*sign*marginM,dz=Math.cos(camera.yaw)*sign*marginM;
 const fits=s=>g[0]+s*dx>=b.minX&&g[0]+s*dx<=b.maxX&&g[2]+s*dz>=b.minZ&&g[2]+s*dz<=b.maxZ;
 if(fits(1))return preferred;if(fits(-1))return preferred==='w'?'s':'w';
 throw new Error('地面余量不足，无法安全持续真实W/S移动');
}
export async function captureWithoutMovement(input,capture,resume){
 const held=['w','s'].filter(name=>input.held.has(name));
 for(const name of held)await input.key(name,false);
 const result=await capture();
 for(const name of held)await resume(name);
 return result;
}
/** 短fire可能落在两个快照之间；事件须为本轮同武器新shot并与lastShot同tick。 */
export function attackEvidence(before,samples,def){
 const sequence=Math.max(0,...(before.weaponEvents??[]).map(e=>e.sequence)),id=def.id;
 const paired=samples.flatMap(s=>(s.weaponEvents??[]).filter(e=>e.sequence>sequence&&e.weaponId===id&&e.action==='fire'&&e.tick===s.lastShot?.tick).map(e=>({sequence:e.sequence,tick:e.tick,frame:s.frame,clip:e.clip})));
 const state=s=>s.weapons?.states.find(w=>w.id===id),ammoBefore=state(before)?.magazine,ammoAfter=state(samples.at(-1)??{})?.magazine;
 const fireFrames=samples.filter(s=>s.models?.pose?.action==='fire').map(s=>s.frame),recoilFrames=samples.filter(s=>Math.abs(s.models?.pose?.recoil?.pitchDeg??0)>1e-6||s.models?.pose?.recoil?.translation?.some(n=>Math.abs(n)>1e-6)).map(s=>s.frame);
 const upperFrames=samples.filter(s=>paired.some(e=>e.clip&&s.actor?.layer?.clip===e.clip)).map(s=>s.frame);
 return {ok:paired.length>0&&(def.ammo.reloadMode==='none'||Number.isFinite(ammoBefore)&&ammoAfter<ammoBefore)&&(fireFrames.length>0||recoilFrames.length>0||upperFrames.length>0),paired,ammoBefore,ammoAfter,fireFrames,recoilFrames,upperFrames,firing:samples.map(s=>({frame:s.frame,held:s.firing}))};
}
export function childActorLocal(sample,id){
 const d=sample?.models?.attachmentDraws?.find(d=>d.id===id),o=sample?.authorPlayer;
 if(!d||!o||d.frameStamp!==sample.frame||d.worldMatrix?.length!==16||!d.worldMatrix.every(Number.isFinite))return null;
 return actorPoint(d.worldMatrix.slice(12,15).map((n,k)=>n-o.pos[k]),{pos:[0,0,0],scale:1/o.scale,quat:o.quat.map((n,k)=>k===3?n:-n)});
}
/** shell补满后直接idle属于有效归槽，仍验证同帧真实draw与离槽/回位位置。 */
export function reloadEvidence(before,samples,id){
 const child=s=>s.models?.attachmentDraws?.find(d=>d.id===id),valid=s=>s?.models?.visible&&childActorLocal(s,id)!==null;
 const out=samples.find(s=>valid(s)&&child(s).removed),inside=samples.findLast(s=>valid(s)&&out&&s.frame>out.frame&&!child(s).removed&&s.models?.pose?.action==='idle');
 const outLocal=childActorLocal(out,id),inLocal=childActorLocal(inside,id),slotLocal=childActorLocal(before,id);
 const distance=(a,b)=>a&&b?Math.hypot(...a.map((n,k)=>n-b[k])):null;
 const delta=distance(outLocal,inLocal),slotResidual=distance(inLocal,slotLocal);
 return {ok:delta!==null&&delta>.001&&slotResidual!==null&&slotResidual<.001,outFrame:out?.frame,inFrame:inside?.frame,outActorLocal:outLocal,inActorLocal:inLocal,slotActorLocal:slotLocal,translationDeltaM:delta,slotResidualM:slotResidual,inAction:inside?.models?.pose?.action};
}
export function reloadMoment(sample,id,p,stage,outSeen){
 const child=sample.models?.attachmentDraws?.find(d=>d.id===id),pose=sample.models?.pose;
 if(!child||child.frameStamp!==sample.frame||!sample.models?.visible)return false;
 if(stage==='in')return outSeen&&!child.removed&&(pose?.action==='idle'||pose?.action==='reload'&&pose.phase>=p.magazineInPhase);
 return child.removed&&pose?.action==='reload'&&pose.phase>=(stage==='mid'?(p.magazineOutPhase+p.magazineInPhase)/2:p.magazineOutPhase);
}
async function run(options){
 const head=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:options.root,encoding:'utf8'}).trim();
 if(fs.realpathSync(options.root)!==fs.realpathSync(REPO)||fs.realpathSync(process.cwd())!==fs.realpathSync(options.root))throw new Error('root/cwd 与脚本所属检出不一致');
 if(head()!==options.expectedHead)throw new Error('HEAD不匹配，拒绝移动target验证');
 if(options.staticScene)staticNodes(options.root,options.staticScene,options.nodeIds);
 if(process.platform!=='win32')throw new Error('此入口只适配当前Windows；不猜测其他主机归属');
 const profile=path.join(options.root,'.workbuddy/tmp/chrome-profile');
 const raw=execFileSync('powershell.exe',['-NoProfile','-Command',"Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],{encoding:'utf8'}).trim();
 const processes=raw?([JSON.parse(raw)].flat()):[];if(processes.some(p=>!p.CommandLine))throw new Error('部分Chrome进程CommandLine不可读，无法确认profile归属；停止');
 const owners=profileOwners(processes,profile);if(owners.length)throw new Error('保留profile正被Chrome持有，拒绝启动：PID '+owners.map(p=>p.ProcessId).join(','));
 await freePort(options.cdpPort);fs.mkdirSync(options.out,{recursive:true});
 const report={mode:options.staticScene?'static':'play',toolSha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),staticHelperSha256:createHash('sha256').update(fs.readFileSync(path.join(REPO,'tools/verify/weapon-static.mjs'))).digest('hex'),targetHead:options.expectedHead,root:options.root,url:options.url,scene:options.staticScene??SCENE,sceneSha256:createHash('sha256').update(fs.readFileSync(path.join(options.root,options.staticScene??SCENE))).digest('hex'),profile,cdpPort:options.cdpPort,normalTls:true,startedAt:new Date().toISOString(),samples:[],checks:[],actions:[],screenshots:[],limitations:['原始PNG须人工检查轮廓、遮挡和美术质量；检查通过不等于像素批准。','不强制人为制造迟到decode。'],consoleErrors:[],exceptions:[]};
 let session,input;const captureJobs=new Set();const check=(name,ok,detail)=>report.checks.push({name,ok:!!ok,detail});
 const save=()=>fs.writeFileSync(path.join(options.out,'observations.json'),JSON.stringify(report,null,2)+'\n');
 try{
  session=await launchEditorSession({chromePath:options.chromePath,cdpPort:options.cdpPort,headed:true,appUrl:options.url,ignoreCertificateErrors:false,setupTimeoutMs:30000,windowSize:'1440,1000'});
  const browser=new Cdp(session.ws,undefined);let pidTimer;let processInfo;try{processInfo=await Promise.race([browser.send('SystemInfo.getProcessInfo'),new Promise((_,reject)=>{pidTimer=setTimeout(()=>reject(new Error('browser PID核对超时')),10000);})]);}finally{clearTimeout(pidTimer);}const browserPid=processInfo.processInfo.find(p=>p.type==='browser')?.id;
  report.browser={pid:session.chrome.pid,browserPid,targetId:session.targetId,flags:session.flags};if(browserPid!==session.chrome.pid)throw new Error('Chrome复用了其他进程，拒绝业务导航');
  const rawSend=session.cdp.send.bind(session.cdp),deadline=Date.now()+120000;
  session.cdp.send=(method,params)=>{const timeout=Math.min(10000,deadline-Date.now());if(timeout<=0)return Promise.reject(new Error('探针120s预算用尽'));let timer;return Promise.race([rawSend(method,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CDP命令超时 '+method)),timeout);})]).finally(()=>clearTimeout(timer));};
  input=new ProbeInput(session.cdp,event=>report.actions.push({...event,atMs:Date.now()}));
  const cdp=session.cdp,nav=await cdp.send('Page.navigate',{url:options.url});if(nav.errorText)throw new Error('正常TLS导航失败 '+nav.errorText);
  const expectedDoc=JSON.parse(fs.readFileSync(path.join(options.root,report.scene),'utf8'));
  const readiness=sceneReadinessExpression(expectedDoc,report.scene);
  const ready=await waitFor(async()=>{report.authorReadiness=await cdp.eval(readiness);return report.authorReadiness?.ok===true;},{timeout:30000,interval:200});
  if(!ready)throw new Error('作者场景/真实资产/Hierarchy/Play按钮未同步；见 authorReadiness');
  await cdp.send('Page.bringToFront');
  const gpu=await cdp.eval('(async()=>{const a=await navigator.gpu?.requestAdapter();const i=a?.info??(a?.requestAdapterInfo?await a.requestAdapterInfo():null);return {secure:isSecureContext,vendor:i?.vendor,architecture:i?.architecture,description:i?.description};})()');report.gpu=gpu;
  check('HTTPS secure真实硬件',gpu?.secure&&gpu?.vendor==='nvidia'&&gpu?.architecture==='lovelace',gpu);if(!report.checks.at(-1).ok)throw new Error('未确认本机真实GPU，停止实操');
  if(options.staticScene){await captureStatic(cdp,input,options,report,check);}else{
  const snap=async label=>{const sample={label,atMs:Date.now(),pointer:input.position??null,...await cdp.eval(SNAPSHOT)};report.samples.push(sample);return sample;};
  let activeAimSpec=null;
  const guardedAim=spec=>aimPoint(cdp,spec,event=>report.actions.push({...event,atMs:Date.now()}));
  const movement=async(name,down,point=null)=>{
   for(const held of ['w','s'])if(input.held.has(held))await input.key(held,false);
   if(down){const preferred=name;if(typeof activeAimSpec==='number'){point??=await guardedAim(activeAimSpec);name=groundMovementDirection(point,name);report.actions.push({input:'movementPlan',preferred,chosen:name,marginM:1.5,guardFrame:point.frame,guardTick:point.tick,ground:point.ground,groundBounds:point.groundBounds,atMs:Date.now()});}await input.key(name,true);}
  };
  const capture=async(label,detail=false)=>captureWithoutMovement(input,async()=>{
   let clip,clipEvidence;
   const sample=await snap(label+'-capture'),sampleIndex=report.samples.length-1;
   if(detail){
    clipEvidence=await cdp.eval(`(()=>{const e=window.__editor,o=e.renderer.state.objects.find(o=>o.nodeId===e.renderer.getDocument()?.playerStart&&!o.removed),frame=e.renderer.state.frameCounter,models=e.weaponModels.snapshot();if(!o?.skeleton||models.frameStamp!==frame)return null;const hands=o.skeleton.jointNames.flatMap((name,i)=>/(Left|Right)(ForeArm|Hand)$/.test(name)?[(${posedJointPosition.toString()})(o.skinScratch.slice(i*16,(i+1)*16),o.skeleton.normalization,o.skeleton.inverseBind.slice(i*16,(i+1)*16))]:[]).filter(Boolean).map(p=>(${actorPoint.toString()})(p,o));const children=models.attachmentDraws.filter(d=>d.frameStamp===frame),world=[...hands,...children.flatMap(d=>d.worldCorners??[])],points=world.map(p=>e.renderer.worldToScreen(p)).filter(p=>!p.behind&&Number.isFinite(p.x)&&Number.isFinite(p.y));if(points.length<4)return null;const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x=Math.max(0,Math.min(...xs)-60),y=Math.max(0,Math.min(...ys)-60),right=Math.min(innerWidth,Math.max(...xs)+60),bottom=Math.min(innerHeight,Math.max(...ys)+60);return right-x>5&&bottom-y>5?{clip:{x,y,width:right-x,height:bottom-y,scale:1},frame,childFrames:children.map(d=>d.frameStamp),world,screen:points,pose:models.pose}:null;})()`);
    clip=clipEvidence?.clip;
    if(!clip)throw new Error('换弹近景缺少本帧可投影手臂，不能生成有效局部截图');
   }
   for(const [suffix,part] of clip?[['-context',null],['',clip]]:[['',null]]){
    const frameBefore=await cdp.eval('window.__editor.renderer.state.frameCounter');const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,...(part?{clip:part}:{})});const frameAfter=await cdp.eval('window.__editor.renderer.state.frameCounter');const file=label+suffix+'.png';fs.writeFileSync(path.join(options.out,file),Buffer.from(data,'base64'));report.screenshots.push({label:label+suffix,file,sample:sampleIndex,sampleFrame:sample.frame,sampleModelFrameStamp:sample.models?.frameStamp??null,samplePose:sample.models?.pose??null,atMs:Date.now(),frameRange:[frameBefore,frameAfter],clip:part,clipEvidence:part?clipEvidence:null});
   }
  },name=>movement(name,true));
  const click=async selector=>{const point=await visiblePoint(cdp,selector);await input.pointer(point,true);await input.pointer(point,false);report.actions.push({click:selector,atMs:Date.now()});};
  const sampleFor=async(label,ms,onSample,interval=120)=>{const until=Date.now()+ms;while(Date.now()<until){await sleep(interval);if(typeof activeAimSpec==='number'){canvas=await guardedAim(activeAimSpec);const held=['w','s'].find(name=>input.held.has(name));if(held&&groundMovementDirection(canvas,held)!==held)await movement(held,true,canvas);await input.move(canvas);}const sample=await snap(label);if(onSample)await onSample(sample);}};
  const editor=await snap('editor');const expectedSceneId=JSON.parse(fs.readFileSync(path.join(options.root,SCENE),'utf8')).id;check('真实场景身份',editor.sceneId===expectedSceneId,editor.sceneId);if(editor.sceneId!==expectedSceneId)throw new Error('加载场景ID不匹配');await capture('01-editor');await click('#btn-play');
  if(!await waitFor(()=>cdp.eval('window.__editor.playCtl.state==="playing"'),{timeout:5000})){
   report.playStartFailure={readiness:await cdp.eval(readiness),sample:await snap('play-start-failed'),ui:await cdp.eval('document.body.innerText.slice(0,3500)')};
   throw new Error('UI Play 未进入运行；见 playStartFailure');
  }
  if(!await waitFor(()=>cdp.eval('window.__editor.weaponModels.snapshot().visible'),{timeout:20000,interval:150}))throw new Error('真实模型未形成有效本帧draw');
  const baseline=await snap('play-ready');await capture('02-pistol');
  let canvas=await visiblePoint(cdp,'#gpu');
  const primary=options.aimRatio??options.aimYaw,secondary=options.sideAimRatio??options.sideAimYaw,aiming=primary!==null;
  const aimAt=async(spec,label)=>{activeAimSpec=spec;const point=await guardedAim(spec);await input.move(point);report.actions.push({aim:label,...point,atMs:Date.now()});await sampleFor(label,400);await capture(label);return input.position;};
  if(aiming)canvas=await aimAt(primary,'12-aim-primary');
  if(secondary!==null){canvas=await aimAt(secondary,'13-aim-secondary');if(aiming)canvas=await aimAt(primary,'14-aim-return');}
  const doc=JSON.parse(fs.readFileSync(path.join(options.root,SCENE),'utf8'));
  const legsChanged=samples=>samples.length>1&&samples.some(s=>JSON.stringify(s.actor?.legMatrices)!==JSON.stringify(samples[0].actor?.legMatrices))&&samples.some(s=>/walk|run|jog|sprint|strafe/i.test(s.actor?.clip??''));
  if(!options.weaponIds.length){
  await input.pointer(canvas,true);await input.pointer(canvas,false);
  await movement('w',true);await input.pointer(canvas,true);await sampleFor('held-move-fire',options.holdMs);await capture('03-moving-fire');
  const moving=report.samples.filter(s=>s.label==='held-move-fire');check('真实held移动',moving.some(s=>Math.hypot(s.player.x-baseline.player.x,s.player.z-baseline.player.z)>.1),{before:baseline.player,after:moving.at(-1)?.player});
  check('移动期间locomotion和腿矩阵继续',legsChanged(moving),moving.map(s=>({clip:s.actor?.clip,time:s.actor?.time})));
  check('移动期间实际射击',moving.some(s=>s.lastShot?.tick>=baseline.tick),moving.at(-1)?.lastShot);
  await movement('w',false);await movement('s',true);
  await input.tap('seven');await sampleFor('held-switch-launcher',1000);const launcher=await snap('launcher');check('按7切实际Launcher',launcher.models?.visible&&launcher.models.weaponId==='launcher',launcher.models);await capture('04-launcher');
  if(aiming){
   await input.pointer(canvas,false);await movement('s',false);
   canvas=await aimAt(primary,'15-launcher-aim-primary');
   if(secondary!==null){await aimAt(secondary,'16-launcher-aim-secondary');canvas=await aimAt(primary,'17-launcher-aim-return');}
   await movement('s',true);
  }
  await input.pointer(canvas,false);await input.tap('one');await sampleFor('held-switch-pistol',800);check('按1回Pistol',report.samples.at(-1)?.models?.weaponId==='pistol',report.samples.at(-1)?.models);
  await movement('s',false);await movement('w',true);
  const proc=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules').arsenal.definitions.find(w=>w.id==='pistol').presentation.procedural;
  const reloadShots=new Set(),reloadStart=Date.now();let directionChanged=false;
  await input.tap('r');await sampleFor('held-move-reload',2500,async sample=>{
   if(!directionChanged&&Date.now()-reloadStart>=1200){await movement('w',false);await movement('s',true);directionChanged=true;}
   const pose=sample.models?.pose,removed=pose?.action==='reload'&&pose.phase>=proc.magazineOutPhase&&pose.phase<proc.magazineInPhase;
   if(removed&&!reloadShots.has('out')){reloadShots.add('out');await capture('09-magazine-out',aiming);}
   else if(removed&&pose.phase>=(proc.magazineOutPhase+proc.magazineInPhase)/2&&!reloadShots.has('mid')){reloadShots.add('mid');await capture('10-magazine-mid',aiming);}
   if(reloadShots.has('out')&&(pose?.action==='ready'||pose?.action==='reload'&&pose.phase>=proc.magazineInPhase)&&!reloadShots.has('in')){reloadShots.add('in');await capture('11-magazine-in',aiming);}
  });check('换弹phase与截图采样（遮挡另验）',reloadShots.has('out')&&reloadShots.has('in')&&(!aiming||reloadShots.has('mid')),[...reloadShots]);const reload=report.samples.filter(s=>s.label==='held-move-reload');check('移动中换弹phase',reload.some(s=>s.models?.pose?.action==='reload')&&reload.some(s=>Math.hypot(s.player.x-reload[0].player.x,s.player.z-reload[0].player.z)>.1),{phases:reload.map(s=>s.models?.pose?.phase)});check('reload期间腿部locomotion继续',legsChanged(reload),reload.map(s=>({clip:s.actor?.clip,time:s.actor?.time})));await capture('05-after-reload');
  check('reload期间本帧模型/双手结果',reload.some(s=>s.models?.visible&&s.models.frameStamp===s.frame&&Number.isFinite(s.models.measurements?.leftTargetResidualM)),reload.at(-1)?.models);
  }
  if(options.allWeapons){
   await input.release();const definitions=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules').arsenal.definitions,keys=['one','two','three','four','five','six','seven'];
   if(definitions.length!==7)throw new Error('七件模式要求真实7武器场景');
   report.selectedWeapons=options.weaponIds.length?options.weaponIds:definitions.map(d=>d.id);report.executedWeapons=[];
   if(options.weaponIds.length)report.limitations.push('仅检查selectedWeapons；未选武器不构成本次通过证据。');
   for(let i=0;i<definitions.length;i++){
    if(!report.selectedWeapons.includes(definitions[i].id))continue;
    const def=definitions[i],label='seven-'+def.id;await input.tap(keys[i]);await sampleFor(label+'-equip',700);let ready=await snap(label+'-ready');
    check(label+'真实切换与draw',ready.models?.visible&&ready.models.weaponId===def.id&&ready.models.frameStamp===ready.frame,ready.models);
    if(aiming)canvas=await aimAt(i%2&&secondary!==null?secondary:primary,label+'-aim');
    const before=await snap(label+'-attack-before'),direction=i%2?'s':'w';await movement(direction,true);await input.pointer(canvas,true);await sampleFor(label+'-moving-attack',650,null,25);await input.pointer(canvas,false);await movement(direction,false);await capture(label+'-attack');
    const attacks=report.samples.filter(s=>s.label===label+'-moving-attack'),attack=attackEvidence(before,attacks,def);
    check(label+'同武器新攻击事件与表现',attack.ok,{behavior:def.behavior,...attack});
    check(label+'攻击移动与下身持续',legsChanged(attacks)&&attacks.some(s=>Math.hypot(s.player.x-before.player.x,s.player.z-before.player.z)>.1),attacks.map(s=>({frame:s.frame,tick:s.tick,clip:s.actor?.clip,time:s.actor?.time})));
    report.executedWeapons.push(def.id);
    if(def.ammo.reloadMode==='none'){check(label+'无换弹语义',def.presentation.assembly.reloadAttachmentId===null&&ready.models.attachmentDraws?.length===0,{reloadMode:def.ammo.reloadMode});continue;}
    const p=def.presentation.procedural,id=def.presentation.assembly.reloadAttachmentId,shots=new Set(),cycles=[];
    // .55s shell换弹不串行等待三张PNG。三次真实shoot→R，每周期仅一个阶段，
    // 该阶段raw先入report，PNG异步进行；不锁定模拟，保留实际截图frameRange。
    const stages=def.ammo.reloadSec<.9?['out','mid','in']:['all'];
    for(let cycle=0;cycle<stages.length;cycle++){
     if(cycle>0){await input.pointer(canvas,true);await sleep(50);await input.pointer(canvas,false);await sampleFor(label+'-reload-preparation',Math.max(300,def.cooldownSec*1000));}
     const mounted=await snap(label+'-reload-mounted-'+cycle),start=Date.now(),jobs=[];let outSeen=false,reversed=false;
     await movement(direction,true);await input.tap('r');
     await sampleFor(label+'-moving-reload-'+cycle,Math.min(5000,def.ammo.reloadSec*1000+650),async sample=>{
      if(!reversed&&Date.now()-start>700){await movement(direction==='w'?'s':'w',true);reversed=true;}
      if(sample.models?.attachmentDraws?.some(d=>d.id===id&&d.removed))outSeen=true;
      for(const stage of stages[cycle]==='all'?['out','mid','in']:[stages[cycle]])if(!shots.has(stage)&&reloadMoment(sample,id,p,stage,outSeen)){
       shots.add(stage);report.actions.push({captureStage:stage,weapon:def.id,cycle,sample:report.samples.length-1,frame:sample.frame,tick:sample.tick,pose:sample.models.pose});
       // 每周期只启动一个截图，长周期三个截图仍顺序完成，防止重叠输入恢复。
       const job=capture(label+'-'+stage,aiming).catch(error=>{report.exceptions.push('阶段截图 '+def.id+'/'+stage+': '+String(error));}).finally(()=>captureJobs.delete(job));jobs.push(job);captureJobs.add(job);
       if(stages[cycle]==='all')await job;
      }
     },25);
     await Promise.all(jobs);await input.release();await sampleFor(label+'-moving-reload-'+cycle,150,null,25);
     const samples=report.samples.filter(s=>s.label===label+'-moving-reload-'+cycle),evidence=reloadEvidence(mounted,samples,id);cycles.push({cycle,stage:stages[cycle],...evidence});
     check(label+'移动换弹下身持续周期'+cycle,legsChanged(samples)&&samples.some(s=>Math.hypot(s.player.x-mounted.player.x,s.player.z-mounted.player.z)>.1),samples.map(s=>({frame:s.frame,phase:s.models?.pose?.phase,clip:s.actor?.clip})));
    }
    check(label+'实际附件out/in与归槽采样（可见性另验）',shots.has('out')&&shots.has('mid')&&shots.has('in')&&cycles.every(c=>c.ok),{shots:[...shots],cycles});
   }
   check('选定武器执行覆盖',report.selectedWeapons.every(id=>report.executedWeapons.includes(id)),{selected:report.selectedWeapons,executed:report.executedWeapons});
  }
  const handFrames=report.samples.filter(s=>s.state==='playing'&&s.models?.visible&&s.models.frameStamp===s.frame),handFailures=handFrames.filter(s=>s.models.ikDiagnostics?.some(d=>['IK_UNREACHABLE','IK_SOCKET_RESIDUAL','IK_ATTACHMENT'].includes(d.code))||!Number.isFinite(s.models.measurements?.rightTargetResidualM)||!Number.isFinite(s.models.measurements?.leftTargetResidualM)||s.models.measurements.rightTargetResidualM>1e-4||s.models.measurements.leftTargetResidualM>1e-4);
  check('aim/切换/攻击/换弹采样双手实际可达',handFrames.length>0&&handFailures.length===0,{samples:handFrames.length,failures:handFailures.map(s=>({label:s.label,frame:s.frame,tick:s.tick,pose:s.models.pose,measurements:s.models.measurements,diagnostics:s.models.ikDiagnostics}))});
  await input.release();await click('#btn-pause');const paused=await snap('pause-start');await sleep(600);const frozen=await snap('pause-end');check('Pause模拟与动作时钟冻结',paused.state==='paused'&&frozen.tick===paused.tick&&frozen.actor?.time===paused.actor?.time&&frozen.actor?.layer?.time===paused.actor?.layer?.time,{paused,frozen});await capture('06-paused');
  await click('#btn-stop');const stopped=await snap('stop');check('作者回滚',JSON.stringify(stopped.authorPlayer)===JSON.stringify(editor.authorPlayer)&&stopped.authorDocumentSha256===editor.authorDocumentSha256,{before:editor.authorPlayer,after:stopped.authorPlayer,beforeHash:editor.authorDocumentSha256,afterHash:stopped.authorDocumentSha256});check('Stop账目归零',stopped.state==='stopped'&&stopped.ledger===0&&stopped.models?.visibleDrawCount===0,stopped);await capture('07-stop');
  await click('#btn-play');await waitFor(()=>cdp.eval('window.__editor.weaponModels.snapshot().visible'),{timeout:20000,interval:150});const restarted=await snap('restart');check('重启新身份与模型',restarted.cycle>baseline.cycle&&restarted.player?.runId!==baseline.player?.runId&&restarted.models?.visible,restarted);await capture('08-restart');
  await click('#btn-stop');await sleep(500);const final=await snap('final-stop');check('重启后作者再次回滚',JSON.stringify(final.authorPlayer)===JSON.stringify(editor.authorPlayer)&&final.authorDocumentSha256===editor.authorDocumentSha256,{before:editor.authorPlayer,after:final.authorPlayer,beforeHash:editor.authorDocumentSha256,afterHash:final.authorDocumentSha256});check('重启Stop无残留',final.ledger===0&&final.models?.pending===0&&final.models?.loaded.length===0,final);
  }
 }catch(error){report.exceptions.push(String(error));}
 finally{
  await Promise.all([...captureJobs]);
  if(input)report.cleanupInputErrors=await input.release();
  if(session){report.consoleErrors=session.cdp.consoleErrors;report.exceptions.push(...session.cdp.exceptions);try{const bcdp=new Cdp(session.ws,undefined);let cleanupTimer;try{await Promise.race([bcdp.send('Target.closeTarget',{targetId:session.targetId}),new Promise((_,reject)=>{cleanupTimer=setTimeout(()=>reject(new Error('owned target关闭超时')),3000);})]);}finally{clearTimeout(cleanupTimer);}}catch(e){report.cleanupTargetError=String(e);}session.ws.close();session.chrome.kill();}
  check('target HEAD保持',head()===options.expectedHead,head());report.finishedAt=new Date().toISOString();report.passed=report.checks.length>=(options.staticScene?options.nodeIds.length+4:options.weaponIds.length?12:18)&&report.checks.every(c=>c.ok)&&!report.exceptions.length&&!report.consoleErrors.length&&!report.cleanupInputErrors?.length&&!report.cleanupTargetError;save();
 }
 console.log(JSON.stringify({passed:report.passed,evidence:options.out,checks:report.checks.map(c=>({name:c.name,ok:c.ok})),exceptions:report.exceptions}));return report.passed?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))run(probeOptions(process.argv.slice(2))).then(code=>{process.exitCode=code;}).catch(error=>{console.error(String(error));process.exitCode=1;});
