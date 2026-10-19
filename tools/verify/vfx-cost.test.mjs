import test from 'node:test';
import assert from 'node:assert/strict';
import {installVfxCostSampler,measureVfxCost} from './vfx-cost.mjs';

function fixture({map='ready',drawError=false}={}){
 let raf=0,resolveMap;const destroyed=[];
 const device={features:new Set(['timestamp-query']),lost:new Promise(()=>{}),
  createQuerySet:()=>resource('query'),createBuffer:()=>resource('buffer'),
  createCommandEncoder(){return {beginRenderPass(){return {};},resolveQuerySet(){},copyBufferToBuffer(){},finish(){return {};}};}};
 function resource(kind){return {destroy(){destroyed.push(kind);},unmap(){},getMappedRange:()=>new BigUint64Array([1000n,3000n]).buffer,mapAsync:()=>map==='pending'?new Promise(r=>{resolveMap=r;}):map==='reject'?Promise.reject(new Error('map rejected')):Promise.resolve()};}
 const pass={stats:{uploadedBytes:64}},core={device,vfx:pass,drawFrame(input){if(drawError)throw new Error('draw rejected');const e=device.createCommandEncoder();e.beginRenderPass({label:'scene'});e.beginRenderPass({label:'post'});e.finish();input.stats.drawCalls=this.vfx?3:2;}};
 const originals={draw:core.drawFrame,encoder:device.createCommandEncoder};
 Object.assign(globalThis,{window:{__editor:{renderer:{core}}},document:{visibilityState:'visible',hasFocus:()=>true},requestAnimationFrame:()=>++raf,cancelAnimationFrame:()=>{},GPUBufferUsage:{QUERY_RESOLVE:1,COPY_SRC:2,COPY_DST:4,MAP_READ:8},GPUMapMode:{READ:1}});
 const sampler=()=>window.__vfxCostSampler;
 return {core,device,pass,destroyed,originals,sampler,resolveMap:()=>resolveMap?.(),assertClean(){assert.equal(core.drawFrame,originals.draw);assert.equal(device.createCommandEncoder,originals.encoder);assert.equal(core.vfx,pass);const s=sampler().snapshot();assert.equal(s.resources.created,s.resources.destroyed);assert.equal(s.restored,true);}};
}
const turn=()=>new Promise(r=>setTimeout(r,5));
test('48 real frames retain timestamp interval, sample counts and destroy every temporary allocation',async()=>{
 const f=fixture();installVfxCostSampler();
 for(const enabled of [false,true])for(let n=0;n<24;n++){f.sampler().next(enabled,n);f.core.drawFrame({stats:{}});await turn();assert.equal(f.sampler().snapshot().phase,'sample-complete');}
 const result=f.sampler().result();assert.equal(result.off.samples,20);assert.equal(result.on.samples,20);assert.equal(result.off.drawCalls.mean,2);assert.equal(result.on.drawCalls.mean,3);assert.ok(Math.abs(result.on.gpuSceneThroughPostMs.mean-.002)<1e-12);assert.equal(f.destroyed.length,144);f.assertClean();
});
test('no next draw reaches bounded deadline and restores the pending draw hook',async()=>{
 const f=fixture();installVfxCostSampler({sampleTimeoutMs:10});f.sampler().next(false,0);await new Promise(r=>setTimeout(r,20));assert.equal(f.sampler().snapshot().phase,'failed');assert.match(f.sampler().snapshot().error,/waiting-draw/);f.assertClean();
});
test('pending map cancellation destroys resources; late resolution cannot mutate or affect restarted sampler',async()=>{
 const f=fixture({map:'pending'});installVfxCostSampler();f.sampler().next(true,0);f.core.drawFrame({stats:{}});assert.equal(f.sampler().snapshot().mapPending,true);f.sampler().cancel('test cancel');const old=f.sampler(),before=JSON.stringify(old.snapshot().trace);f.assertClean();installVfxCostSampler();f.resolveMap();await turn();assert.equal(JSON.stringify(old.snapshot().trace),before);assert.equal(f.sampler().snapshot().phase,'idle');f.sampler().cancel('finish');f.assertClean();
});
for(const opts of [{map:'reject'},{drawError:true}])test('failure restores draw/encoder/vfx and destroys allocated resources '+JSON.stringify(opts),async()=>{
 const f=fixture(opts);installVfxCostSampler();f.sampler().next(false,0);f.core.drawFrame({stats:{}});await turn();assert.equal(f.sampler().snapshot().phase,'failed');f.assertClean();
});
test('host poll failure cancels outstanding browser hooks in finally',async()=>{
 const f=fixture();let calls=0;const cdp={send:async()=>{},eval:async expression=>{if(expression.includes('.snapshot()') && calls++===0)throw new Error('CDP test disconnect');return (0,eval)(expression);}};
 await assert.rejects(measureVfxCost(cdp),/CDP test disconnect/);f.assertClean();
});

test('GPU map deadline records pending phase and releases all resources',async()=>{
 const f=fixture({map:'pending'});installVfxCostSampler({sampleTimeoutMs:10});f.sampler().next(true,0);f.core.drawFrame({stats:{}});await new Promise(r=>setTimeout(r,20));assert.equal(f.sampler().snapshot().phase,'failed');assert.match(f.sampler().snapshot().error,/map-pending/);f.assertClean();f.resolveMap();await turn();f.assertClean();
});
