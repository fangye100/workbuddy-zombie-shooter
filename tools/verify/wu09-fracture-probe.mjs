/** WU09 联合成本/压力验收。受控输入与原生武器主路径分开；全部调用原Play/prepare/runtime/core。 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runGameProbe,playPaused,stopProbe} from './game-probe-lib.mjs';
import {createRecorder,makeArgParser,waitFor,sleep} from './editor-smoke-lib.mjs';
import {installFractureMeasure,distribution} from './fracture-measure.mjs';
const {arg,has}=makeArgParser(process.argv);if(!has('headed'))throw Error('必须 --headed');
const out=path.resolve(arg('out','.workbuddy/tmp/wu09-review/cost-pressure'));
const {results,check,summary}=createRecorder(),root=process.cwd().replaceAll('\\','/');
const hash=v=>createHash('sha256').update(v).digest('hex');
async function shot(cdp,name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));}
async function ready(cdp){if(!await waitFor(()=>cdp.eval(`(()=>{const c=window.__editor.playCtl;c.step();const v=c.session.runtime?.view().find(x=>x.characterId==='E-04');return !!c.fracture?.backend()&&!!v&&!!c.bridge.deathPoseSnapshot(v);})()`),{timeout:20000,label:'真实actor/World就绪'}))throw Error('后端/姿态未就绪：'+JSON.stringify(await cdp.eval(`(()=>{const c=window.__editor.playCtl;return {state:c.state,outcome:c.session.outcome,tick:c.tick,stats:c.fracture?.runtime.stats,actors:c.session.runtime?.view().map(x=>({id:x.id,kind:x.kind,c:x.characterId}))};})()`)));}
async function reset(cdp){await cdp.eval('(()=>{const c=window.__editor.playCtl;c.reset();for(let i=0;i<40;i++)c.step();})()');await ready(cdp);}
async function renderReady(cdp){if(!await waitFor(()=>cdp.eval(`(()=>{const e=window.__editor,c=e.playCtl;c.syncFractureBatches();const bs=c.fractureBatches;return bs.length>0&&e.renderer.core.dynamicBatchState(bs)==='ready';})()`),{timeout:20000,label:'实际GPU上传/draw就绪'}))throw Error('碎块GPU未就绪：'+JSON.stringify(await cdp.eval(`(()=>{const e=window.__editor,c=e.playCtl;return {active:c.fracture.runtime.stats,batches:c.fractureBatches.length,error:c.destructibleError,renderError:c.fractureRenderError,gpuError:e.renderer.core.dynamicError};})()`)));}
await runGameProbe({name:'wu09-fracture',outDir:out,port:5100,cdpPort:Number(arg('cdp',9497)),chromePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headed:true,windowPosition:'1920,80',scene:'assets/scenes/sandbox/fracture-wu07.scene.json',results,check,summary},async({cdp,details})=>{
 const win=await cdp.send('Browser.getWindowForTarget'),bounds=await cdp.send('Browser.getWindowBounds',{windowId:win.windowId});check('DISPLAY1',bounds.bounds.left===1920,JSON.stringify(bounds.bounds));
 details.source={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),hashes:Object.fromEntries(['apps/editor/src/services/fracture-renderer.ts','packages/runtime/src/fracture-activation.ts','tools/verify/fracture-measure.mjs','tools/verify/wu09-fracture-probe.mjs'].map(p=>[p,hash(fs.readFileSync(p))]))};
 await cdp.eval(`(${installFractureMeasure.toString()})()`);
 try{
  await playPaused(cdp);await ready(cdp);
  // 从正式死亡消费者捕获真实可见姿态事件；此处受控applyDamage只用于测量输入，不替代独立原生武器验收。
  details.capture=await cdp.eval(`(()=>{const c=window.__editor.playCtl,r=c.session.runtime,v=r.view().find(v=>v.characterId==='E-04'),spawn=c.spawnFracture;window.__wu09Facts=[];
   const consume=c.consumeDeathFractures;c.consumeDeathFractures=function(){const cursor=this.deathFractureCursor,t=performance.now();try{return consume.call(this);}finally{const events=this.deathFractureCursor-cursor;if(events>0)window.__wu09Facts.push({events,cpuMs:performance.now()-t,scope:'原死亡事实消费/同步分派，后续异步准备另计'});}};
   c.spawnFracture=function(ev){window.__wu09NpcEvent=ev;return spawn.call(this,ev);};r.applyDamage(v.id,99999,r.playerEntityId,{weaponId:'wu09-controlled',vfxSequence:9001,origin:[0,1,3],contact:[v.x,1,v.z]});c.update(0);return {controlled:true,victim:{runId:v.runId,id:v.id,generation:v.generation}};})()`);
  if(!await waitFor(()=>cdp.eval('!!window.__wu09NpcEvent'),{timeout:20000,label:'原NPC事件'}))throw Error('未捕获死亡事件');
  details.factPlanning=await cdp.eval('window.__wu09Facts');
  await cdp.eval(`(async()=>{const mod=await import(${JSON.stringify('/@fs/'+root+'/packages/runtime/src/index.ts')}),c=window.__editor.playCtl;window.__wu09RuntimeModule=mod;
   const npc=window.__wu09NpcEvent,p01={sequence:9002,tick:0,seed:11,profile:{path:'assets/fracture/p01-barrel/p01-barrel.fracture.json',guid:'as_p01frct'},target:{kind:'scene-object',runId:'wu09-same-input',nodeId:'controlled-p01'},position:[0,1.5,1],rotation:[0,0,0,1],scale:[1,1,1],contact:[.2,1.5,1],normal:[0,0,1],impulse:[2,3,1],source:{weaponId:'wu09-controlled',hitSequence:9002}};
   window.__wu09Events=[p01,{...npc,seed:11,target:{...npc.target,runId:'wu09-same-input'}}];window.__wu09Prepared=[];window.__wu09PrepareSamples=[];
   for(let n=0;n<12;n++)for(const event of window.__wu09Events){const measurements={admissionWallMs:0,chunkDecodeCpuMs:0,poseBakeCpuMs:0,planningCpuMs:0},result=await mod.prepareFractureActivation(event,{io:c.fractureIO,resolveConvexPoints:mod.createGlbConvexResolver(),measurements});if(!result.ok)throw Error(JSON.stringify(result));if(n===0)window.__wu09Prepared.push(result.activation);window.__wu09PrepareSamples.push({n,kind:event.target.kind,...measurements});}
  })()`);
  details.events=await cdp.eval('window.__wu09Events');details.inputSha256=hash(JSON.stringify(details.events));details.preparation=await cdp.eval('window.__wu09PrepareSamples');
  details.preparationDistributions=Object.fromEntries(['scene-object','npc'].map(kind=>[kind,Object.fromEntries(['admissionWallMs','chunkDecodeCpuMs','poseBakeCpuMs','planningCpuMs'].map(k=>[k,distribution(details.preparation.filter(x=>x.kind===kind&&x.n>=2).map(x=>x[k]))]))]));
  check('两类正式输入成功准备且CPU分段有限',details.preparation.length===24&&details.preparation.every(x=>['admissionWallMs','chunkDecodeCpuMs','poseBakeCpuMs','planningCpuMs'].every(k=>Number.isFinite(x[k])&&x[k]>=0)));
  details.modes={};
  for(const mode of ['off','simplified','rigid']){
   await reset(cdp);
   details.modes[mode]={inputSha256:details.inputSha256,control:await cdp.eval(`(()=>{const c=window.__editor.playCtl,mode=${JSON.stringify(mode)},prepared=window.__wu09Prepared;if(mode!=='off')for(const a of prepared){const input={...a,chunks:a.chunks.map(x=>mode==='simplified'?{...x,cls:'small'}:x)};const r=c.fracture.runtime.play(input);if(!r.accepted)throw Error(JSON.stringify(r));}c.step();return {mode,stats:c.fracture.runtime.stats,prepared:prepared.map(a=>({chunks:a.chunks.length,large:a.chunks.filter(x=>x.cls==='large').length,small:a.chunks.filter(x=>x.cls==='small').length}))};})()`),raw:[]};
   if(mode!=='off')await renderReady(cdp);
   const initial=await cdp.eval('window.__fractureMeasure.snapshot()');details.modes[mode].before=initial;
   for(let n=0;n<40;n++){const sample=await cdp.eval('window.__fractureMeasure.sample()');details.modes[mode].raw.push({n,warmup:n<8,...sample});}
   const samples=details.modes[mode].raw.slice(8);details.modes[mode].distribution=Object.fromEntries(['gpuSceneThroughPostMs','coreSubmissionCpuMs','playStepCpuMs','physicsCpuMs','simplifiedIntegrationAndRetirementCpuMs','fractureDraws','fractureTriangles','fractureWriteBufferBytes','writeBufferBytes'].map(k=>[k,distribution(samples.map(x=>x[k]))]));
   details.modes[mode].after=await cdp.eval('window.__fractureMeasure.snapshot()');
   check(mode+'：40帧/8暖机/32样本及实际GPU timestamp',samples.length===32&&samples.every(x=>x.timestamp&&Number.isFinite(x.gpuSceneThroughPostMs)));
   check(mode+'：模式实际数量',samples.every(x=>mode==='off'?x.runtime.poolActive===0:mode==='simplified'?x.runtime.rigidActive===0&&x.runtime.simplifiedActive===22:x.runtime.rigidActive===15&&x.runtime.simplifiedActive===7));
   check(mode+'：实际draw和上传边界',samples.every(x=>mode==='off'?x.fractureDraws===0&&x.fractureWriteBufferBytes===0&&x.preparedInstanceBytes===0:x.fractureDraws>0&&x.fractureTriangles>0&&x.fractureWriteBufferBytes>0));
   await shot(cdp,mode+'-frame');
  }
  // 默认32/256预算压力；重复输入仅换事件稳定身份，生命周期延长供休眠采样；正式磁盘未改。
  await reset(cdp);
  details.pressure=await cdp.eval(`(()=>{const c=window.__editor.playCtl,rt=c.fracture.runtime,a=window.__wu09Prepared[0];let accepted=0,rejected=0;for(let i=0;i<32;i++){const simple=i>=4,input={...a,event:{...a.event,target:{...a.event.target,nodeId:'pressure-'+i}},lifetimeSec:60,fadeSec:0,priority:1,chunks:a.chunks.map(x=>simple?{...x,cls:'small'}:x)};rt.play(input).accepted?accepted++:rejected++;}for(let i=0;i<7;i++)c.step();return {accepted,rejected,stats:rt.stats,bodies:c.fracture.backend().world.bodies.len(),colliders:c.fracture.backend().world.colliders.len()};})()`);
  await renderReady(cdp);details.pressure.resources=await cdp.eval('window.__fractureMeasure.snapshot()');details.pressure.frames=[];
  for(let n=0;n<24;n++)details.pressure.frames.push(await cdp.eval('window.__fractureMeasure.sample()'));
  check('真实32+简化256活动预算及满额跳块',details.pressure.stats.rigidActive===32&&details.pressure.stats.simplifiedActive===256&&details.pressure.stats.poolActive===288&&details.pressure.stats.skipped>0,JSON.stringify(details.pressure.stats));
  details.overflow=await cdp.eval(`(()=>{const c=window.__editor.playCtl,rt=c.fracture.runtime,old=rt.active.map(x=>x.handle.key),a=window.__wu09Prepared[0];rt.play({...a,priority:0,event:{...a.event,target:{...a.event.target,nodeId:'lower-priority'}}});c.step();return {stats:rt.stats,preserved:old.every(k=>rt.active.some(x=>x.handle.key===k))};})()`);
  check('满额低优先级保底不删除已有活动资源',details.overflow.preserved&&details.overflow.stats.poolActive===288,JSON.stringify(details.overflow));
  details.queue=await cdp.eval(`(()=>{const c=window.__editor.playCtl,rt=c.fracture.runtime,a=window.__wu09Prepared[0],before=rt.stats;let rejected=0;for(let i=0;i<257;i++)if(!rt.play({...a,priority:0,event:{...a.event,target:{...a.event.target,nodeId:'queue-'+i}}}).accepted)rejected++;const full=rt.stats;for(let i=0;i<52;i++)c.step();return {before,full,rejected,after:rt.stats};})()`);
  check('事件队列256有界且第257个明确拒绝',details.queue.full.queuedEvents===256&&details.queue.rejected===1&&details.queue.after.queuedEvents===0,JSON.stringify(details.queue));
  await shot(cdp,'pressure-288');
  await cdp.eval(`(()=>{const c=window.__editor.playCtl;for(let i=0;i<900;i++)c.fracture.onFixedTick(c.session.fixedStep);c.syncFractureBatches();})()`);
  details.sleep=await cdp.eval(`(()=>{const c=window.__editor.playCtl,b=c.fracture.backend(),rt=c.fracture.runtime,snaps=rt.active.filter(x=>x.layer==='rigid').map(x=>b.snapshot(x.handle));return {stats:rt.stats,snapshots:snaps,bodies:b.world.bodies.len(),colliders:b.world.colliders.len(),resources:window.__fractureMeasure.snapshot()};})()`);
  check('休眠仍持有实际World/body/collider和有界资源',details.sleep.snapshots.length===32&&details.sleep.snapshots.some(x=>x.sleeping)&&details.sleep.stats.poolActive===288,JSON.stringify({stats:details.sleep.stats,sleeping:details.sleep.snapshots.filter(x=>x.sleeping).length}));
  // 保存被释放对象引用；TTL、Reset、Stop分别核对，不读空数组every。
  details.ttl=await cdp.eval(`(()=>{const c=window.__editor.playCtl,rt=c.fracture.runtime,b=c.fracture.backend(),world=b.world,free=world.free;window.__wu09Old={runtime:rt,backend:b,world,freeCalls:0,handles:rt.active.map(x=>x.handle)};world.free=function(){window.__wu09Old.freeCalls++;return free.call(this);};for(let i=0;i<3000;i++)c.fracture.onFixedTick(c.session.fixedStep);c.syncFractureBatches();return {stats:rt.stats,bodies:b.world.bodies.len(),colliders:b.world.colliders.len(),prepared:c.fractureRenderStats.instanceBytes,batches:c.fractureBatches.length};})()`);
  check('TTL释放全部288租约/真实body并清空本帧准备量',details.ttl.stats.poolActive===0&&details.ttl.stats.rigidActive===0&&details.ttl.stats.simplifiedActive===0&&details.ttl.prepared===0&&details.ttl.batches===0,JSON.stringify(details.ttl));
  await reset(cdp);
  details.reset=await cdp.eval(`(()=>{const x=window.__wu09Old;return {disposed:x.runtime.disposed,pool:x.runtime.stats.poolActive,active:x.runtime.active.length,queue:x.runtime.stats.queuedEvents,ledger:x.backend.ledger,freeCalls:x.freeCalls,handles:x.handles.length,staleNull:x.handles.every(h=>x.backend.snapshot(h)===null),newRuntime:window.__editor.playCtl.fracture.runtime!==x.runtime};})()`);
  check('Reset实际旧runtime/backend/288句柄失效并World.free一次',details.reset.disposed&&details.reset.pool===0&&details.reset.active===0&&details.reset.queue===0&&details.reset.ledger.destroyed&&details.reset.freeCalls===1&&details.reset.handles===288&&details.reset.staleNull&&details.reset.newRuntime,JSON.stringify(details.reset));
  details.stopRounds=[];
  for(let round=0;round<2;round++){
   if(round){await playPaused(cdp);await ready(cdp);}
   await cdp.eval(`(()=>{const c=window.__editor.playCtl,result=c.fracture.runtime.play(window.__wu09Prepared[0]);if(!result.accepted)throw Error(JSON.stringify(result));c.step();})()`);await renderReady(cdp);
   const before=await cdp.eval(`(()=>{const c=window.__editor.playCtl,rt=c.fracture.runtime,b=c.fracture.backend(),world=b.world,free=world.free,h={runtime:rt,backend:b,world,freeCalls:0,handles:rt.active.map(x=>x.handle)};world.free=function(){h.freeCalls++;return free.call(this);};window.__wu09StopHeld=h;return {active:rt.active.length,pool:rt.stats.poolActive,bodies:world.bodies.len(),colliders:world.colliders.len(),resources:window.__fractureMeasure.snapshot()};})()`);
   await stopProbe(cdp,check);
   const after=await cdp.eval(`(()=>{const h=window.__wu09StopHeld;return {disposed:h.runtime.disposed,active:h.runtime.active.length,pool:h.runtime.stats.poolActive,queue:h.runtime.stats.queuedEvents,ledger:h.backend.ledger,freeCalls:h.freeCalls,staleNull:h.handles.every(x=>h.backend.snapshot(x)===null),resources:window.__fractureMeasure.snapshot()};})()`);
   details.stopRounds.push({round,before,after});const ids=before.resources.resources.filter(x=>x.fracture).map(x=>x.id);
   check('Stop/重开轮'+round+'核实际活体12body/World.free/GPU且保留共享frame',before.active===12&&before.pool===12&&after.disposed&&after.active===0&&after.pool===0&&after.queue===0&&after.ledger.destroyed&&after.freeCalls===1&&after.staleNull&&ids.length>0&&ids.every(i=>after.resources.resources[i].destroyCalls===1)&&after.resources.sharedFrameDestroyCalls===0,JSON.stringify({active:before.active,free:after.freeCalls,relatedResources:ids.length,sharedFrameDestroyCalls:after.resources.sharedFrameDestroyCalls}));
  }
  details.stopResources=details.stopRounds.at(-1).after.resources;details.ownedResourceIds=details.stopResources.resources.filter(x=>x.fracture).map(x=>x.id);
  details.method={warmup:8,samples:32,preparationWarmup:2,preparationSamplesPerKind:10,seed:11,gpu:'scene begin → post end，包括scene/outline/VFX/post，不能解释为碎片单pass',cpu:'prepare同步规划、chunk解码与palette/bake各自CPU墙钟；admission异步IO墙钟另列；play Step包含原游戏；integration含TTL遍历；事实消费/同步分派单次无暖机，不能当统计分布',upload:'真实GPUQueue.writeBuffer成功调用范围字节与copyExternalImageToTexture基础RGBA字节；不是准备计数',resident:'实际未destroy的GPUBuffer.size；纹理desc的逻辑格式/mip信息，非物理显存测量',scope:'本机NVIDIA，固定scene/input/seed；off不激活，simplified将同22块全部交原small积分，rigid保留作者15large/7small；暂停装配用原syncFractureBatches，长时压力只推进原binding.onFixedTick以隔离玩家死亡，不证明宿主接线；宿主由独立原生23/43断言证明；压力延长TTL不写磁盘'};
 }finally{await cdp.eval('window.__fractureMeasure?.restore()').catch(()=>{});}
});
if(results.some(r=>!r.ok&&!r.skipped))process.exitCode=1;
