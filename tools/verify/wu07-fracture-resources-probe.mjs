/** WU-07 资源/故障边界探针：受控伤害及真实GPU上传故障，与原生击杀主验收分开。 */
import fs from 'node:fs';
import path from 'node:path';
import {sleep,waitFor,createRecorder,makeArgParser} from './editor-smoke-lib.mjs';
import {runGameProbe,playPaused,stopProbe} from './game-probe-lib.mjs';
const {arg,has}=makeArgParser(process.argv);
if(!has('headed'))throw new Error('资源边界验收必须显式 --headed');
const out=path.resolve(arg('out','.workbuddy/tmp/wu07-resources-gpu'));
const {results,check,summary}=createRecorder();
async function capture(cdp,name){const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));}
async function started(cdp){
  await playPaused(cdp);
  const ready=await waitFor(()=>cdp.eval(`(()=>{const e=window.__editor,c=e.playCtl,v=c.session.runtime.view().find(v=>v.characterId==='E-04');return v&&c.fracture?.backend()&&c.bridge.deathPoseSnapshot(v)?true:null})()`),{timeout:15000,interval:80,label:'真实actor/后端/可见姿态'});
  if(!ready)throw new Error('真实actor/后端/可见姿态未就绪');
}
async function controlledKill(cdp){
  return cdp.eval(`(()=>{const c=window.__editor.playCtl,r=c.session.runtime,v=r.view().find(v=>v.kind==='npc'&&v.characterId==='E-04');if(!v)throw new Error('missing victim');window.__reviewVictim={runId:v.runId,id:v.id,generation:v.generation};r.applyDamage(v.id,99999,r.playerEntityId,{weaponId:'review-controlled-pistol',vfxSequence:411,origin:[0,1,3],contact:[v.x,1,v.z]});c.update(0);return {identity:window.__reviewVictim,kill:r.combatEvents.filter(e=>e.type==='kill').length};})()`);
}
async function pumpTakeover(cdp){
  for(let i=0;i<150;i++){
    const s=await cdp.eval(`(()=>{const c=window.__editor.playCtl;c.step();return {active:c.fracture.runtime.active.length,queued:c.fracture.runtime.stats.queuedEvents,corpses:c.bridge.batches().filter(b=>b.meshId==='actor:E-04').reduce((n,b)=>n+b.count,0),batches:c.fractureBatches.length,error:c.destructibleError};})()`);
    if(s.active===10&&s.batches===20&&s.corpses===0)return s;
    if(s.error)return s;
    await sleep(25);
  }
  throw new Error('接管超时');
}
await runGameProbe({name:'wu07-resources-gpu',outDir:out,port:5100,cdpPort:Number(arg('cdp',9493)),chromePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headed:true,windowPosition:'1920,80',scene:'assets/scenes/sandbox/fracture-wu07.scene.json',results,check,summary},async({cdp,details})=>{
  const w=await cdp.send('Browser.getWindowForTarget');const bounds=await cdp.send('Browser.getWindowBounds',{windowId:w.windowId});
  check('DISPLAY1',bounds.bounds.left===1920,JSON.stringify(bounds.bounds));
  await started(cdp);
  await cdp.eval(`(()=>{const r=window.__editor.playCtl.fracture.runtime,original=r.play.bind(r);r.play=function(a){window.__reviewActivation=a;return original(a);};})()`);
  await cdp.eval(`(()=>{const d=window.__editor.renderer.core.device,original=d.createBuffer.bind(d);window.__reviewBuffers=[];d.createBuffer=function(desc){const b=original(desc);if(String(desc.label).startsWith('dyn-fracture:')){const row={buffer:b,label:desc.label,size:b.size,destroyed:false},destroy=b.destroy.bind(b);window.__reviewBuffers.push(row);b.destroy=function(){row.destroyed=true;return destroy();};}return b;};})()`);
  details.input=await controlledKill(cdp);
  details.takeover=await pumpTakeover(cdp);
  check('受控真实kill经正式消费者接管',details.takeover.active===10&&details.takeover.corpses===0,JSON.stringify(details.takeover));
  const resourceSnapshot=()=>cdp.eval(`(()=>{const c=window.__editor.playCtl,core=window.__editor.renderer.core,bs=window.__reviewBuffers;return {active:c.fracture?.runtime.active.length??null,pool:c.fracture?.runtime.stats.poolActive??null,backend:c.fracture?.backend()?.ledger??null,tick:c.tick,outcome:c.session.outcome,batches:c.fractureBatches.length,meshIds:[...core.dynamicMeshes.keys()].filter(k=>k.startsWith('fracture:')),buffers:bs.map(b=>({label:b.label,size:b.buffer.size,destroyed:b.destroyed})),aliveBytes:bs.filter(b=>!b.destroyed).reduce((n,b)=>n+b.buffer.size,0)};})()`);
  details.activeResources=await resourceSnapshot();
  await capture(cdp,'active-fragments');
  await cdp.eval(`(()=>{const c=window.__editor.playCtl;for(let i=0;i<400;i++)c.step();})()`);
  await sleep(150);
  details.expiredResources=await resourceSnapshot();
  check('到期后物理块/租约/批次归零',details.expiredResources.active===0&&details.expiredResources.pool===0&&details.expiredResources.batches===0,JSON.stringify({active:details.expiredResources.active,pool:details.expiredResources.pool,batches:details.expiredResources.batches,outcome:details.expiredResources.outcome}));
  check('到期后本次唯一姿态GPUBuffer已destroy或有界复用',details.expiredResources.aliveBytes===0,JSON.stringify({aliveBytes:details.expiredResources.aliveBytes,meshIds:details.expiredResources.meshIds,buffers:details.expiredResources.buffers}));
  await capture(cdp,'expired-fragments');
  // 重放同一正式准备输入，只变事件身份；资源边界用例，不冒称第二次原生击杀。
  details.repeatInput=await cdp.eval(`(async()=>{const c=window.__editor.playCtl,e=window.__reviewActivation.event;return await c.spawnFracture({...e,sequence:e.sequence+1,tick:e.tick+1,target:{...e.target,generation:e.target.generation+1}});})()`);
  check('同run第二个合法姿态请求已接受',details.repeatInput.accepted===true,JSON.stringify(details.repeatInput));
  for(let i=0;i<80;i++){await cdp.eval('window.__editor.playCtl.step()');if(await cdp.eval('window.__editor.playCtl.fractureBatches.length===20'))break;await sleep(25);}
  await sleep(100);
  details.repeatActiveResources=await resourceSnapshot();
  await cdp.eval('(()=>{const c=window.__editor.playCtl;for(let i=0;i<400;i++)c.step();})()');
  await sleep(100);
  details.repeatExpiredResources=await resourceSnapshot();
  check('重复激活/到期后唯一姿态GPU驻留不累积',details.repeatExpiredResources.aliveBytes<=details.expiredResources.aliveBytes,JSON.stringify({first:details.expiredResources.aliveBytes,second:details.repeatExpiredResources.aliveBytes,active:details.repeatExpiredResources.active,pool:details.repeatExpiredResources.pool,batches:details.repeatExpiredResources.batches}));
  await stopProbe(cdp,check);
  details.stoppedResources=await resourceSnapshot();
  check('Stop实际destroy全部已保留GPUBuffer',details.stoppedResources.aliveBytes===0,JSON.stringify(details.stoppedResources));

  // 新Play，受控真实Rapier分配失败：只替换addBody边界，其余会话/消费者不改。
  await started(cdp);
  await cdp.eval(`(()=>{const c=window.__editor.playCtl,b=c.fracture.backend(),old=b.addBody.bind(b);window.__reviewAllocation={called:0};b.addBody=function(...args){window.__reviewAllocation.called++;b.addBody=old;throw new Error('REVIEW_RAPIER_ALLOCATION_FAILURE');};})()`);
  details.bodyFailureInput=await controlledKill(cdp);
  const queued=await waitFor(()=>cdp.eval('window.__editor.playCtl.fracture.runtime.stats.queuedEvents===1'),{timeout:10000,interval:50,label:'真实kill入队'});
  check('后端故障前正式消费者确实入队',queued===true);
  details.bodyAllocationFailure=await cdp.eval(`(()=>{const c=window.__editor.playCtl;let thrown=null;try{c.step();}catch(e){thrown=String(e);}return {thrown,called:window.__reviewAllocation.called,error:c.destructibleError,active:c.fracture.runtime.active.length,pool:c.fracture.runtime.stats.poolActive,backend:c.fracture.backend().ledger,corpse:c.bridge.batches().filter(b=>b.meshId==='actor:E-04').reduce((n,b)=>n+b.count,0)};})()`);
  check('真后端分配失败由宿主诊断且不外抛',details.bodyAllocationFailure.called===1&&details.bodyAllocationFailure.thrown===null&&details.bodyAllocationFailure.error!==null,JSON.stringify(details.bodyAllocationFailure));
  await capture(cdp,'allocation-failure');
  await stopProbe(cdp,check);

  // 接管后的首个实例上传边界失败，保留真实GPUDevice/RendererCore/主循环。
  await started(cdp);
  await cdp.eval(`(()=>{const q=window.__editor.renderer.core.device.queue,old=q.writeBuffer.bind(q);window.__reviewGpuUpload={fail:true,triggered:0};q.writeBuffer=function(buffer,...args){if(window.__reviewGpuUpload.fail&&String(buffer.label).startsWith('dynamic-rigid-')){window.__reviewGpuUpload.triggered++;throw new Error('REVIEW_GPU_INSTANCE_UPLOAD_FAILURE');}return old(buffer,...args);};})()`);
  details.gpuFailureInput=await controlledKill(cdp);
  for(let i=0;i<160;i++){await cdp.eval('window.__editor.playCtl.step()');if(await cdp.eval('window.__reviewGpuUpload.triggered>0'))break;await sleep(25);}
  await sleep(150);
  details.gpuUploadFailure=await cdp.eval(`(()=>{const c=window.__editor.playCtl;return {triggered:window.__reviewGpuUpload.triggered,corpses:c.bridge.batches().filter(b=>b.meshId==='actor:E-04').reduce((n,b)=>n+b.count,0),active:c.fracture.runtime.active.length,error:c.destructibleError,gpuError:window.__editor.renderer.core.dynamicError};})()`);
  check('首个实例GPU上传失败时保留完整death',details.gpuUploadFailure.triggered>0&&details.gpuUploadFailure.corpses===1,JSON.stringify(details.gpuUploadFailure));
  await capture(cdp,'gpu-upload-failure');
  await cdp.eval('window.__reviewGpuUpload.fail=false');
  await cdp.eval('window.__editor.playCtl.reset()');
  await waitFor(()=>cdp.eval("(()=>{const c=window.__editor.playCtl;c.step();const v=c.session.runtime.view().find(v=>v.characterId==='E-04');return !!c.fracture?.backend()&&!!v&&!!c.bridge.deathPoseSnapshot(v);})()"),{timeout:10000,interval:50,label:'故障恢复新代后端及实际呈现姿态'});
  await controlledKill(cdp);
  details.gpuRecovered=await pumpTakeover(cdp);
  check('上传边界恢复后后续合法NPC正常接管',details.gpuRecovered.active===10&&details.gpuRecovered.corpses===0&&details.gpuRecovered.error===null,JSON.stringify(details.gpuRecovered));
  await sleep(150);
  await stopProbe(cdp,check);
});
if(results.some(r=>!r.ok&&!r.skipped))process.exitCode=1;
