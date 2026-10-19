/** Bounded next-frame timestamp sampling. Browser state stays observable through short CDP polls. */
export function installVfxCostSampler({sampleTimeoutMs=3000}={}) {
 const root=window;
 root.__vfxCostSampler?.cancel('superseded');
 const core=root.__editor.renderer.core,device=core.device,pass=core.vfx;
 const original=core.drawFrame,create=device.createCommandEncoder,started=performance.now();
 const state={phase:'idle',mode:null,sample:-1,elapsedMs:0,raf:0,draws:0,mapPending:false,deviceLost:null,trace:[],resources:{created:0,destroyed:0},restored:true};
 let closed=false,rafId,timer,cleanupSample=()=>{},drawHook=null,encoderHook=null;
 const timestamp=device.features.has('timestamp-query'),values={off:{cpu:[],gpu:[],draws:[]},on:{cpu:[],gpu:[],draws:[]}};
 const snapshot=()=>({...state,elapsedMs:performance.now()-started,visibility:document.visibilityState,focus:document.hasFocus(),trace:state.trace.slice(),resources:{...state.resources}});
 const mark=phase=>{state.phase=phase;state.trace.push({phase,mode:state.mode,sample:state.sample,elapsedMs:performance.now()-started,raf:state.raf,draws:state.draws,visibility:document.visibilityState,focus:document.hasFocus()});if(state.trace.length>256)state.trace.shift();};
 const restore=()=>{if(core.drawFrame===drawHook)core.drawFrame=original;if(device.createCommandEncoder===encoderHook)device.createCommandEncoder=create;state.restored=core.drawFrame===original && device.createCommandEncoder===create && core.vfx===pass;};
 const cancel=reason=>{if(closed)return snapshot();closed=true;clearTimeout(timer);cancelAnimationFrame(rafId);restore();cleanupSample();state.mapPending=false;state.error=reason;mark('cancelled');return snapshot();};
 const fail=error=>{cancel(String(error));state.phase='failed';};
 const tick=()=>{if(closed)return;state.raf++;rafId=requestAnimationFrame(tick);};rafId=requestAnimationFrame(tick);
 void device.lost.then(info=>{if(!closed){state.deviceLost={reason:info.reason,message:info.message};fail('GPU device lost');}});
 const next=(enabled,n)=>{
  if(closed || !['idle','sample-complete'].includes(state.phase))throw new Error('cost sampler not ready: '+state.phase);
  state.mode=enabled?'on':'off';state.sample=n;mark('waiting-draw');
  let live=true;const allocated=[];
  cleanupSample=()=>{if(!live)return;live=false;for(const r of allocated){r.destroy();state.resources.destroyed++;}};
  const allocate=resource=>{allocated.push(resource);state.resources.created++;return resource;};
  timer=setTimeout(()=>fail('cost sample deadline: '+state.phase),sampleTimeoutMs);
  drawHook=function(input){
   // Only the next real editor frame is sampled; never invoke a synthetic product frame.
   if(!live || closed)return original.call(this,input);
   core.drawFrame=original;state.draws++;mark('drawing');
   let read,query,resolved,error,ms=0,sceneWrites=0,postWrites=0;
   const previous=this.vfx;
   try{
    query=timestamp?allocate(device.createQuerySet({type:'timestamp',count:2})):null;
    resolved=timestamp?allocate(device.createBuffer({size:256,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC})):null;
    read=timestamp?allocate(device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})):null;
    encoderHook=function(...args){const encoder=create.apply(this,args),begin=encoder.beginRenderPass,finish=encoder.finish;
     encoder.beginRenderPass=function(desc){let timestampWrites;
      if(query && desc.label==='scene'){timestampWrites={querySet:query,beginningOfPassWriteIndex:0};sceneWrites++;}
      if(query && desc.label==='post'){timestampWrites={querySet:query,endOfPassWriteIndex:1};postWrites++;}
      return begin.call(this,timestampWrites?{...desc,timestampWrites}:desc);};
     encoder.finish=function(...a){if(query){this.resolveQuerySet(query,0,2,resolved,0);this.copyBufferToBuffer(resolved,0,read,0,16);}return finish.apply(this,a);};return encoder;};
    device.createCommandEncoder=encoderHook;this.vfx=enabled?pass:null;
    const start=performance.now();original.call(this,input);ms=performance.now()-start;
    if(timestamp && (sceneWrites!==1 || postWrites!==1))throw new Error('Expected one scene/post timestamp interval');
   }catch(e){error=e;}
   finally{this.vfx=previous;restore();}
   if(error){fail(error);return;}
   state.mapPending=!!read;mark(read?'map-pending':'reading-complete');
   void (async()=>{
    try{
     let gpu;
     if(read){await read.mapAsync(GPUMapMode.READ);if(!live || closed)return;const v=new BigUint64Array(read.getMappedRange());gpu=Number(v[1]-v[0])/1e6;read.unmap();}
     if(!live || closed)return;
     if(n>=4){const v=values[state.mode];v.cpu.push(ms);v.draws.push(input.stats.drawCalls);if(timestamp)v.gpu.push(gpu);}
     state.mapPending=false;clearTimeout(timer);cleanupSample();mark('sample-complete');
    }catch(e){if(live && !closed)fail(e);}
    finally{cleanupSample();}
   })();
  };
  core.drawFrame=drawHook;state.restored=false;return snapshot();
 };
 const summarize=a=>({mean:a.reduce((s,x)=>s+x,0)/a.length,p95:[...a].sort((a,b)=>a-b)[Math.floor(a.length*.95)]});
 const result=()=>{if(closed)throw new Error(state.error);const summarizeMode=v=>({samples:v.cpu.length,cpuSubmissionMs:summarize(v.cpu),gpuSceneThroughPostMs:timestamp?summarize(v.gpu):null,drawCalls:summarize(v.draws)});
  const output={timestampEnabled:timestamp,method:'paused scene, next real editor frame; 4 warmup + 20 samples per mode; CPU core.drawFrame wall-time; GPU scene-begin to post-end timestamp',off:summarizeMode(values.off),on:summarizeMode(values.on),vfxUploadBytes:pass?.stats.uploadedBytes??0};
  closed=true;clearTimeout(timer);cancelAnimationFrame(rafId);restore();cleanupSample();mark('complete');return {...output,diagnostic:snapshot()};};
 root.__vfxCostSampler={next,snapshot,cancel,result};return snapshot();
}

export async function measureVfxCost(cdp,{onProgress=()=>{},sampleTimeoutMs=3000,totalTimeoutMs=45000}={}) {
 let last,output;const started=Date.now();
 try{
  await cdp.send('Page.bringToFront');
  last=await cdp.eval(`(${installVfxCostSampler.toString()})(${JSON.stringify({sampleTimeoutMs})})`);onProgress(last);
  if(last.visibility!=='visible')throw new Error('成本采样页面不可见');
  for(const enabled of [false,true])for(let n=0;n<24;n++){
   last=await cdp.eval(`window.__vfxCostSampler.next(${enabled},${n})`);onProgress(last);
   while(last.phase!=='sample-complete'){
    if(['failed','cancelled'].includes(last.phase))throw new Error(last.error);
    if(Date.now()-started>totalTimeoutMs)throw new Error('成本采样总期限');
    await new Promise(r=>setTimeout(r,30));
    last=await cdp.eval('window.__vfxCostSampler.snapshot()');onProgress(last);
   }
  }
  output=await cdp.eval('window.__vfxCostSampler.result()');onProgress(output.diagnostic);return output;
 }catch(error){error.costDiagnostic=last;throw error;}
 finally{
  const cleaned=await cdp.eval(`window.__vfxCostSampler?.cancel('host finally')`).catch(error=>({cleanupUnavailable:String(error)}));
  onProgress(cleaned);
 }
}
