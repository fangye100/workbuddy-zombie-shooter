/** Bounded paused-frame comparison for the M1 probe. No product profiler or persistent resources. */
export async function measureVfxCost(cdp){
 return cdp.eval(`(async()=>{
 const core=window.__editor.renderer.core,device=core.device,pass=core.vfx,original=core.drawFrame,create=device.createCommandEncoder;
 const timestamp=device.features.has('timestamp-query'),measure=async(enabled)=>{
  const cpu=[],gpu=[],draws=[];
  for(let n=0;n<24;n++){
   let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b;});let taken=false;
   core.drawFrame=function(input){
    if(taken)return original.call(this,input);taken=true;
    const query=timestamp?device.createQuerySet({type:'timestamp',count:2}):null;
    const resolved=timestamp?device.createBuffer({size:256,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}):null;
    const read=timestamp?device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}):null;
    device.createCommandEncoder=function(...args){const encoder=create.apply(this,args),begin=encoder.beginRenderPass,finish=encoder.finish;
     encoder.beginRenderPass=function(desc){let timestampWrites;
      if(query && desc.label==='scene')timestampWrites={querySet:query,beginningOfPassWriteIndex:0};
      if(query && desc.label==='post')timestampWrites={querySet:query,endOfPassWriteIndex:1};
      return begin.call(this,timestampWrites?{...desc,timestampWrites}:desc);};
     encoder.finish=function(...a){if(query){this.resolveQuerySet(query,0,2,resolved,0);this.copyBufferToBuffer(resolved,0,read,0,16);}return finish.apply(this,a);};return encoder;};
    const previous=this.vfx;this.vfx=enabled?pass:null;const start=performance.now();
    try{original.call(this,input);if(n>=4){cpu.push(performance.now()-start);draws.push(input.stats.drawCalls);}}
    catch(error){reject(error);}
    finally{this.vfx=previous;device.createCommandEncoder=create;core.drawFrame=original;}
    void (async()=>{try{if(read){await read.mapAsync(GPUMapMode.READ);const values=new BigUint64Array(read.getMappedRange());if(n>=4)gpu.push(Number(values[1]-values[0])/1e6);read.unmap();}resolve();}catch(e){reject(e);}finally{query?.destroy();resolved?.destroy();read?.destroy();}})();
   };
   await done;
  }
  const summarize=a=>({mean:a.reduce((s,x)=>s+x,0)/a.length,p95:[...a].sort((a,b)=>a-b)[Math.floor(a.length*.95)]});
  return {samples:cpu.length,cpuSubmissionMs:summarize(cpu),gpuSceneThroughPostMs:timestamp?summarize(gpu):null,drawCalls:summarize(draws)};
 };
 try{return {timestampEnabled:timestamp,method:'paused scene, same 3 live effects; 4 warmup + 20 samples per mode; CPU core.drawFrame wall-time; GPU scene-begin to post-end timestamp',off:await measure(false),on:await measure(true),vfxUploadBytes:pass?.stats.uploadedBytes??0};}
 finally{core.drawFrame=original;device.createCommandEncoder=create;core.vfx=pass;}
 })()`);
}
