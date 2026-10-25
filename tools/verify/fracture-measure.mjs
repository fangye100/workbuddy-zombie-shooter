/** WU09 验证用观测：只包裹实际设备及下一次原编辑器帧，不实现模拟/渲染。 */
export function installFractureMeasure() {
 const e=window.__editor,core=e.renderer.core,d=core.device;
 const original={createBuffer:d.createBuffer,createTexture:d.createTexture,write:d.queue.writeBuffer,copy:d.queue.copyExternalImageToTexture,draw:core.drawFrame,encoder:d.createCommandEncoder};
 const resources=[],writes=[],copies=[];let frame=0;
 const sharedFrame=core.frameBuf,sharedDestroy=sharedFrame?.destroy;let sharedFrameDestroyCalls=0;
 if(sharedFrame)sharedFrame.destroy=function(){sharedFrameDestroyCalls++;return sharedDestroy.call(this);};
 function track(r,kind,desc){const row={r,kind,label:desc.label??'',size:kind==='buffer'?r.size:null,width:r.width,height:r.height,mips:r.mipLevelCount,format:r.format,destroyCalls:0};const destroy=r.destroy;r.destroy=function(){row.destroyCalls++;return destroy.call(this);};resources.push(row);return r;}
 d.createBuffer=function(desc){return track(original.createBuffer.call(this,desc),'buffer',desc);};
 d.createTexture=function(desc){return track(original.createTexture.call(this,desc),'texture',desc);};
 d.queue.writeBuffer=function(buffer,offset,data,dataOffset=0,size){const unit=data.BYTES_PER_ELEMENT??1,n=(size??data.byteLength/unit-dataOffset)*unit;const result=original.write.apply(this,arguments);writes.push({buffer,bytes:n,frame});return result;};
 d.queue.copyExternalImageToTexture=function(source,dest,size){const result=original.copy.apply(this,arguments);copies.push({texture:dest.texture,bytes:(size.width??size[0])*(size.height??size[1])*4,frame});return result;};
 function own(){const refs=new Set();for(const [k,m]of core.dynamicMeshes)if(k.startsWith('fracture:'))for(const n of ['vbuf','ibuf','skinVb'])refs.add(m[n]);const batches=e.playCtl.fractureBatches;for(const b of batches){
  // sync 每次生成新批次对象；以原mesh/子网格身份核同一实际提交槽，不能用对象地址对账。
  const i=(window.__fractureMeasure.lastInput?.dynamicBatches??[]).findIndex(x=>x.meshId===b.meshId&&x.indexStart===b.indexStart&&x.indexCount===b.indexCount),s=core.dynamicInstSlots[i];if(s)for(const n of ['buf','poseBuf','rigidBuf'])refs.add(s[n]);
  const material=b.textureKey?core.dynamicMaterials.get(b.textureKey):null;if(material)refs.add(material.texture);
 }return refs;}
 function snapshot(){const refs=own();return {sharedFrameDestroyCalls,resources:resources.map((x,i)=>{if(refs.has(x.r))x.fracture=true;return {id:i,kind:x.kind,label:x.label,size:x.size,width:x.width,height:x.height,mips:x.mips,format:x.format,destroyCalls:x.destroyCalls,fracture:x.fracture===true};}),writeBytes:writes.reduce((n,x)=>n+x.bytes,0),externalImageBytes:copies.reduce((n,x)=>n+x.bytes,0)};}
 let pending=null;
 async function sample(){
  if(pending)throw Error('已有未完成帧');
  const before=e.playCtl.fracture.runtime.stats,stepStart=performance.now();e.playCtl.step();const stepCpuMs=performance.now()-stepStart,after=e.playCtl.fracture.runtime.stats;
  return new Promise((resolve,reject)=>{
   const allocated=[];let finished=false,timer=setTimeout(()=>finish(Error('下一真实帧采样超时')),4000);
   function finish(error,result){if(finished)return;finished=true;clearTimeout(timer);core.drawFrame=original.draw;d.createCommandEncoder=original.encoder;pending=null;for(const r of allocated)r.destroy();error?reject(error):resolve(result);}
   pending={cancel:()=>finish(Error('采样取消'))};
   core.drawFrame=function(input){
    core.drawFrame=original.draw;frame++;window.__fractureMeasure.lastInput=input;
    const first=writes.length,firstCopies=copies.length,timestamp=d.features.has('timestamp-query');
    let scene=0,post=0,draws=0,triangles=0,fractureDraws=0,fractureTriangles=0;
    const batches=input.dynamicBatches??[];
    // 正式动态 pass 的调用顺序与原 drawDynamicBatches 一致；逐 draw 的几何索引/实例数仍取实际 API 参数。
    let currentIndex=null;
    let q=null,resolved=null,read=null;
    try{if(timestamp){q=d.createQuerySet({type:'timestamp',count:2});allocated.push(q);resolved=d.createBuffer({label:'wu09-query-resolve',size:256,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});allocated.push(resolved);read=d.createBuffer({label:'wu09-query-read',size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});allocated.push(read);}}catch(error){finish(error);return;}
    d.createCommandEncoder=function(...args){const enc=original.encoder.apply(this,args),begin=enc.beginRenderPass,finishEncoder=enc.finish;
     enc.beginRenderPass=function(desc){let timestampWrites;if(q&&desc.label==='scene'){timestampWrites={querySet:q,beginningOfPassWriteIndex:0};scene++;}if(q&&desc.label==='post'){timestampWrites={querySet:q,endOfPassWriteIndex:1};post++;}
      const pass=begin.call(this,timestampWrites?{...desc,timestampWrites}:desc),indexed=pass.drawIndexed,index=pass.setIndexBuffer;
      pass.setIndexBuffer=function(buf,...rest){currentIndex=buf;return index.call(this,buf,...rest);};
      pass.drawIndexed=function(count,n=1,...rest){const value=indexed.call(this,count,n,...rest);draws++;triangles+=count*n/3;
       // 实际 indexBuffer 引用从原 core 缓存核对，不按待绘制批次数猜 draw。
       if([...core.dynamicMeshes].some(([k,m])=>k.startsWith('fracture:')&&m.ibuf===currentIndex)){fractureDraws++;fractureTriangles+=count*n/3;}return value;};return pass;};
     enc.finish=function(...args){if(q){this.resolveQuerySet(q,0,2,resolved,0);this.copyBufferToBuffer(resolved,0,read,0,16);}return finishEncoder.apply(this,args);};return enc;};
    let cpu;try{const t=performance.now();original.draw.call(this,input);cpu=performance.now()-t;}catch(error){finish(error);return;}finally{d.createCommandEncoder=original.encoder;}
    const refs=own(),uploaded=writes.slice(first),imageCopies=copies.slice(firstCopies);
    void(async()=>{try{let gpu=null;if(read){await read.mapAsync(GPUMapMode.READ);const v=new BigUint64Array(read.getMappedRange());gpu=Number(v[1]-v[0])/1e6;read.unmap();if(scene!==1||post!==1)throw Error('缺少实际scene/post timestamp区间');}
     finish(null,{frame,timestamp,gpuSceneThroughPostMs:gpu,coreSubmissionCpuMs:cpu,playStepCpuMs:stepCpuMs,physicsCpuMs:after.physicsMs-before.physicsMs,simplifiedIntegrationAndRetirementCpuMs:after.integrateMs-before.integrateMs,
      runtime:after,actualIndexedDraws:draws,actualIndexedTriangles:triangles,fractureDraws,fractureTriangles,materialBatches:batches.filter(b=>b.meshId.startsWith('fracture:')).length,
      writeBufferBytes:uploaded.reduce((n,x)=>n+x.bytes,0),fractureWriteBufferBytes:uploaded.filter(x=>refs.has(x.buffer)).reduce((n,x)=>n+x.bytes,0),externalImageBytes:imageCopies.reduce((n,x)=>n+x.bytes,0),
      preparedInstanceBytes:e.playCtl.fractureRenderStats.instanceBytes});
    }catch(error){finish(error);}})();
   };
  });
 }
 window.__fractureMeasure={resources,writes,copies,lastInput:null,sample,snapshot,restore(){pending?.cancel();core.drawFrame=original.draw;d.createCommandEncoder=original.encoder;d.createBuffer=original.createBuffer;d.createTexture=original.createTexture;d.queue.writeBuffer=original.write;d.queue.copyExternalImageToTexture=original.copy;if(sharedFrame)sharedFrame.destroy=sharedDestroy;}};
 return {timestamp:d.features.has('timestamp-query')};
}

export function distribution(values){const v=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!v.length)return null;return {samples:v.length,min:v[0],median:v[Math.floor(v.length*.5)],p95:v[Math.min(v.length-1,Math.floor(v.length*.95))],max:v.at(-1),mean:v.reduce((a,b)=>a+b,0)/v.length};}
