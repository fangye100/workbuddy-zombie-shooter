/** 两来向真实Rapier/同tick真实GPU画面对照；受控输入，独立于原生击杀主路径。 */
import fs from 'node:fs';
import path from 'node:path';
import {runGameProbe,playPaused,stopProbe} from './game-probe-lib.mjs';
import {createRecorder,makeArgParser,waitFor} from './editor-smoke-lib.mjs';
const {arg,has}=makeArgParser(process.argv);if(!has('headed'))throw Error('必须 --headed');
const out=path.resolve(arg('out','.workbuddy/tmp/wu09-review/physics-visual')),{results,check,summary}=createRecorder();
async function click(cdp,selector){const p=await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});}
await runGameProbe({name:'wu09-physics-visual',outDir:out,port:5100,cdpPort:Number(arg('cdp',9496)),chromePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headed:true,windowPosition:'1920,80',scene:'assets/scenes/sandbox/fracture-wu07.scene.json',results,check,summary},async({cdp,details})=>{
 await playPaused(cdp);if(!await waitFor(()=>cdp.eval('!!window.__editor.playCtl.fracture?.backend()'),{timeout:20000}))throw Error('World未就绪');
 await click(cdp,'#btn-observation-camera');
 await cdp.eval(`(()=>{const e=window.__editor;e.camera.target=[-2.5,.3,.6];e.camera.distance=3.5;e.camera.yaw=.35;e.params.cameraElevation=35;})()`);
 details.directions={};
 for(const direction of [1,-1]){
  if(direction<0){await click(cdp,'#btn-reset');if(!await waitFor(()=>cdp.eval('!!window.__editor.playCtl.fracture?.backend()'),{timeout:20000}))throw Error('Reset World未就绪');}
  const name=direction>0?'positive':'negative';
  const admitted=await cdp.eval(`(async()=>{const c=window.__editor.playCtl,ev={sequence:1,tick:0,seed:11,profile:{path:'assets/fracture/p01-barrel/p01-barrel.fracture.json',guid:'as_p01frct'},target:{kind:'scene-object',runId:'wu09-visual',nodeId:'controlled-p01'},position:[-2.5,.8,1],rotation:[0,0,0,1],scale:[1,1,1],contact:[-2.3,1.2,1.2],normal:[${direction},0,-1],impulse:[${direction*2},.5,-3],source:{weaponId:'wu09-controlled',hitSequence:1}};
   const play=c.fracture.runtime.play.bind(c.fracture.runtime);c.fracture.runtime.play=function(a){return play({...a,lifetimeSec:30,fadeSec:0});};const result=await c.spawnFracture(ev);c.step();window.__wu09Contacts=[];window.__wu09ContactLabels=new Set();return {event:ev,result};})()`);
  check(name+'正式profile/prepare接原Play激活',admitted.result.accepted);
  if(!await waitFor(()=>cdp.eval(`(()=>{const c=window.__editor.playCtl;c.syncFractureBatches();return c.fractureBatches.length===24&&window.__editor.renderer.core.dynamicBatchState(c.fractureBatches)==='ready';})()`),{timeout:20000,label:'真实GLB材质及GPU就绪'}))throw Error('GLB/GPU未就绪');
  const frames=[];
  for(const ticks of [20,60,180,600]){
   const state=await cdp.eval(`(()=>{const e=window.__editor,c=e.playCtl,b=c.fracture.backend(),rt=c.fracture.runtime;while(rt.stats.ticks<${ticks}){c.fracture.onFixedTick(c.session.fixedStep);
    for(const [key,value]of b.bodies)b.world.contactPairsWith(value.collider,other=>{b.world.contactPair(value.collider,other,manifold=>{if(manifold.numSolverContacts()<1)return;const staticRow=[...b.statics.values()].find(x=>x.collider.handle===other.handle),chunk=[...b.bodies.values()].find(x=>x.collider.handle===other.handle);const label=staticRow?.nodeId??(chunk?'chunk:'+chunk.chunkId:'unknown');if(!window.__wu09ContactLabels.has(label)){window.__wu09ContactLabels.add(label);window.__wu09Contacts.push({tick:rt.stats.ticks,chunk:value.chunkId,other:label,contacts:manifold.numSolverContacts()});}});});}
    c.syncFractureBatches();return {tick:rt.stats.ticks,backend:b.ledger,bodies:b.world.bodies.len(),colliders:b.world.colliders.len(),chunks:rt.active.map(a=>({id:a.handle.chunkId,handle:a.handle,snapshot:b.snapshot(a.handle)})),contacts:window.__wu09Contacts.slice(),batches:c.fractureBatches.map(x=>({meshId:x.meshId,count:x.count,indexStart:x.indexStart,indexCount:x.indexCount,textureKey:x.textureKey,outline:x.outline,rigid:Array.from(x.rigid.slice(0,12)),instance:Array.from(x.instances.slice(0,20))})),camera:structuredClone(e.camera)};})()`);
   await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   const shot=await cdp.send('Page.captureScreenshot',{format:'png'}),file=name+'-'+ticks+'.png';fs.writeFileSync(path.join(out,file),Buffer.from(shot.data,'base64'));
   const after=await cdp.eval('window.__editor.playCtl.fracture.runtime.stats.ticks');state.screenshot=file;state.afterScreenshotTick=after;frames.push(state);
   check(name+' tick'+ticks+'物理状态/画面同tick且12真body/24材质批',state.tick===after&&state.backend.dynamicBodies===12&&state.chunks.length===12&&state.batches.length===24);
  }
  details.directions[name]={admitted,frames};
  check(name+'实际三轴旋转',frames.slice(0,2).some(f=>f.chunks.some(x=>x.snapshot.rotation.slice(0,3).every(v=>Math.abs(v)>1e-4))));
  check(name+'实际地面/墙/块间求解接触',frames.at(-1).contacts.some(x=>x.other.includes('ground'))&&frames.at(-1).contacts.some(x=>x.other.includes('wall'))&&frames.at(-1).contacts.some(x=>x.other.startsWith('chunk:')),JSON.stringify(frames.at(-1).contacts));
  check(name+'实际休眠仍保有body/collider',frames.at(-1).chunks.some(x=>x.snapshot.sleeping));
 }
 const p=details.directions.positive.frames[0].chunks[0].snapshot.position,n=details.directions.negative.frames[0].chunks[0].snapshot.position;
 check('相同seed/profile仅来向不同产生不同轨迹',Math.hypot(...p.map((v,i)=>v-n[i]))>.05,JSON.stringify({positive:p,negative:n}));
 details.method='真实场景镜像，原正式prepare/Play/Rapier/renderer；TTL仅受控延长，不修改资产；长时暂停状态由原binding固定tick推进，宿主Pause/Step另由原生主路径验证。截图前后tick一致；contactPair读取实际求解manifold，不是估计碰撞。';
 await stopProbe(cdp,check);
});
if(results.some(r=>!r.ok&&!r.skipped))process.exitCode=1;
