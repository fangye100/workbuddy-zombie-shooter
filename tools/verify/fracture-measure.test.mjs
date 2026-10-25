import test from 'node:test';
import assert from 'node:assert/strict';
import {installFractureMeasure,distribution} from './fracture-measure.mjs';
function fixture({map='ready',drawError=false,createError=false}={}){
 let resolveMap;const allocated=[];
 const resource=(desc={})=>{const r={size:desc.size??16,label:desc.label,destroyCalls:0,destroy(){this.destroyCalls++;},unmap(){},mapAsync(){return map==='pending'?new Promise(resolve=>resolveMap=resolve):map==='reject'?Promise.reject(Error('readback rejected')):Promise.resolve();},getMappedRange(){return new BigUint64Array([1000n,6000n]).buffer;}};allocated.push(r);return r;};
 const index=resource({label:'fracture-index'}),instance=resource({label:'instance'}),rigid=resource({label:'rigid'});
 const device={features:new Set(['timestamp-query']),createBuffer(desc){if(createError&&desc.label==='wu09-query-read')throw Error('read allocation failed');return resource(desc);},createTexture:resource,createQuerySet:resource,
  queue:{writeBuffer(){},copyExternalImageToTexture(){}},createCommandEncoder(){return {beginRenderPass(){return {drawIndexed(){},setIndexBuffer(){}};},resolveQuerySet(){},copyBufferToBuffer(){},finish(){}};}};
 let ticks=0;const runtime={get stats(){return {ticks,physicsMs:ticks*.25,integrateMs:ticks*.125,poolActive:1};}};
 const batch={meshId:'fracture:test'},core={device,dynamicMeshes:new Map([['fracture:test',{ibuf:index}]]),dynamicMaterials:new Map(),dynamicInstSlots:[{buf:instance,rigidBuf:rigid}],drawFrame(input){if(drawError)throw Error('draw failed');const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({label:'scene'});device.queue.writeBuffer(instance,0,new Float32Array(20),2,3);device.queue.writeBuffer(rigid,0,new DataView(new ArrayBuffer(12)));pass.setIndexBuffer(index);pass.drawIndexed(6,2);encoder.beginRenderPass({label:'post'});encoder.finish();}};
 const originals={draw:core.drawFrame,encoder:device.createCommandEncoder,buffer:device.createBuffer,write:device.queue.writeBuffer};
 Object.assign(globalThis,{window:{__editor:{renderer:{core},playCtl:{fracture:{runtime},step(){ticks++;},fractureBatches:[batch],fractureRenderStats:{instanceBytes:128}}}},GPUBufferUsage:{QUERY_RESOLVE:1,COPY_SRC:2,COPY_DST:4,MAP_READ:8},GPUMapMode:{READ:1}});
 installFractureMeasure();return {core,device,allocated,originals,get sampler(){return window.__fractureMeasure;},input:{dynamicBatches:[{...batch}]},resolveMap:()=>resolveMap?.()};
}
test('实际API参数范围字节、draw及timestamp，观测资源逐个销毁',async()=>{
 const f=fixture(),promise=f.sampler.sample();f.core.drawFrame(f.input);const r=await promise;
 assert.equal(r.fractureWriteBufferBytes,24);assert.equal(r.fractureDraws,1);assert.equal(r.fractureTriangles,4);assert.equal(r.physicsCpuMs,.25);assert.equal(r.simplifiedIntegrationAndRetirementCpuMs,.125);assert.equal(r.gpuSceneThroughPostMs,.005);
 assert.equal(f.allocated.length,6);assert.equal(f.allocated.filter(r=>r.destroyCalls===1).length,3);f.sampler.restore();assert.equal(f.device.queue.writeBuffer,f.originals.write);assert.equal(f.device.createBuffer,f.originals.buffer);
});
test('异步map未完成取消，迟到完成不重复destroy或改写下一代钩子',async()=>{
 const f=fixture({map:'pending'}),promise=f.sampler.sample();f.core.drawFrame(f.input);const rejected=assert.rejects(promise,/取消/);f.sampler.restore();await rejected;f.resolveMap();await new Promise(r=>setTimeout(r,0));assert.equal(f.core.drawFrame,f.originals.draw);assert.equal(f.device.createCommandEncoder,f.originals.encoder);assert.ok(f.allocated.every(r=>r.destroyCalls<=1));
});
for(const opts of [{map:'reject'},{drawError:true},{createError:true}])test('异常readback/绘制/部分分配仍恢复原路径 '+JSON.stringify(opts),async()=>{
 const f=fixture(opts),promise=f.sampler.sample();f.core.drawFrame(f.input);await assert.rejects(promise,/rejected|failed/);assert.equal(f.core.drawFrame,f.originals.draw);assert.equal(f.device.createCommandEncoder,f.originals.encoder);f.sampler.restore();assert.ok(f.allocated.every(r=>r.destroyCalls<=1));
});
test('分布保留样本、p95和峰值，不把不可用GPU当零',()=>{assert.equal(distribution([]),null);assert.deepEqual(distribution([1,2,3,100]),{samples:4,min:1,median:3,p95:100,max:100,mean:26.5});});
