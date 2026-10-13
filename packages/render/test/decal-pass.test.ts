import {describe,it,expect,vi,beforeAll} from 'vitest';
import {ProceduralDecalPass} from '../src/procedural-decals';
import {DECAL_INSTANCE_FLOATS} from '../src/decal-instances';
beforeAll(()=>{Object.assign(globalThis,{GPUBufferUsage:{STORAGE:1,COPY_DST:2,INDIRECT:4,COPY_SRC:8,UNIFORM:16,MAP_READ:32},GPUMapMode:{READ:1}});});
class Buffer {
 data:ArrayBuffer;destroyed=false;pending=false;reject:((reason:Error)=>void)|null=null;resolve:(()=>void)|null=null;
 constructor(readonly desc:GPUBufferDescriptor){this.data=new ArrayBuffer(Number(desc.size));}
 mapAsync(){if(!this.pending)return Promise.resolve();return new Promise<void>((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});}
 getMappedRange(){return this.data;}
 destroy(){this.destroyed=true;this.reject?.(new Error('Destroyed while mapping'));}
}
function setup(){
 const buffers:Buffer[]=[],trace:string[]=[];let defer=false;
 const queue={writeBuffer:vi.fn((buffer:Buffer,offset:number,data:ArrayBufferView)=>{new Uint8Array(buffer.data).set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),offset);}),submit:vi.fn()};
 const device={queue,createShaderModule:vi.fn(()=>({})),createComputePipeline:vi.fn(()=>({getBindGroupLayout:()=>({})})),createRenderPipeline:vi.fn(()=>({getBindGroupLayout:()=>({})})),createBindGroup:vi.fn(()=>({})),
 createBuffer:(desc:GPUBufferDescriptor)=>{const b=new Buffer(desc);b.pending=defer&&desc.label==='decal-count-readback';buffers.push(b);return b;},
 createCommandEncoder:()=>({beginComputePass:()=>{trace.push('compute');return {setPipeline:vi.fn(),setBindGroup:vi.fn(),dispatchWorkgroups:vi.fn(),end:()=>trace.push('compute-end')};},copyBufferToBuffer:(src:Buffer,_a:number,dst:Buffer)=>new Uint8Array(dst.data).set(new Uint8Array(src.data)),finish:()=>({})})};
 const frame=device.createBuffer({size:64,usage:16}),pass=new ProceduralDecalPass(device as unknown as GPUDevice,frame as unknown as GPUBuffer,'rgba16float','depth32float');
 const encoder=()=>device.createCommandEncoder() as unknown as GPUCommandEncoder;
 const render={setPipeline:vi.fn(),setBindGroup:vi.fn(),draw:vi.fn(),drawIndirect:vi.fn()};
 const data=(n:number)=>new Float32Array(n*DECAL_INSTANCE_FLOATS);
 return {pass,device,buffers,trace,encoder,render:render as unknown as GPURenderPassEncoder,draw:render.draw,indirect:render.drawIndirect,data,defer:()=>{defer=true;},args:()=>buffers.slice().reverse().find(b=>b.desc.label==='decal-indirect-args')!};
}
describe('贴花GPU编码与资源生命周期（mock只认证宿主API，不认证WGSL）',()=>{
 it('A直接批复用缓冲；非法输入原子拒绝，零帧无绘制，容量1024边界',async()=>{
  const s=setup();s.pass.prepare(s.encoder(),s.data(1));s.pass.drawPrepared(s.render);const snapshot=s.pass.snapshot();expect(snapshot).toMatchObject({backend:'direct',inputInstances:1,visibleInstances:null,bufferBytes:4096});
  expect(s.draw).toHaveBeenCalledWith(6,1);expect((await s.pass.readVisibleCount())?.countSource).toBe('submitted');
  const buffer=s.buffers[1];s.pass.prepare(s.encoder(),s.data(2));expect(s.buffers[1]).toBe(buffer);
  const before=s.pass.snapshot();expect(()=>s.pass.prepare(s.encoder(),new Float32Array(21))).toThrow();expect(s.pass.snapshot()).toEqual(before);
  expect(()=>s.pass.prepare(s.encoder(),s.data(1025))).toThrow();s.pass.prepare(s.encoder(),s.data(1024));expect(s.pass.snapshot().inputInstances).toBe(1024);expect(buffer?.destroyed).toBe(true);
  s.pass.prepare(s.encoder(),s.data(0));expect(s.pass.drawPrepared(s.render)).toBe(0);s.pass.clear();expect(s.pass.snapshot()).toMatchObject({instances:0,bufferBytes:0,uploadedBytes:0,computeDispatches:0});
 });
 it('B先compute后间接draw，args只由GPU写；总资源与上传统计，模式切换销毁全部旧缓冲',()=>{
  const s=setup();s.pass.setBackend('indirect');s.pass.prepare(s.encoder(),s.data(512));s.pass.drawPrepared(s.render);
  expect(s.trace).toEqual(['compute','compute-end']);expect(s.indirect).toHaveBeenCalledWith(s.args(),0);expect(s.draw).not.toHaveBeenCalled();
  expect(s.device.queue.writeBuffer.mock.calls.some(([b])=>b===s.args())).toBe(false);
  expect(s.pass.snapshot()).toMatchObject({bufferBytes:131104,uploadedBytes:40976,computeDispatches:1,drawCalls:1,visibleInstances:null});
  const active=s.buffers.slice(1);s.pass.setBackend('direct');expect(active.every(b=>b.destroyed)).toBe(true);expect(s.pass.snapshot().bufferBytes).toBe(0);
  expect(()=>s.pass.setBackend('unknown' as never)).toThrow();expect(s.pass.snapshot().backend).toBe('direct');
 });
 it('读回返回采样帧；后续普通帧不废弃结果或污染当前快照',async()=>{
  const s=setup();s.pass.setBackend('indirect');s.pass.prepare(s.encoder(),s.data(4));new Uint32Array(s.args().data).set([6,2,0,0]);s.defer();const sequence=s.pass.snapshot().sequence,pending=s.pass.readVisibleCount();
  s.pass.prepare(s.encoder(),s.data(3));s.buffers.at(-1)!.resolve!();expect(await pending).toMatchObject({sequence,inputInstances:4,visibleInstances:2,countSource:'gpu-frustum'});expect(s.pass.snapshot().visibleInstances).toBeNull();
 });
 it('映射中clear安全取消；非生命周期导致的真实GPU错误保留',async()=>{
  const s=setup();s.pass.setBackend('indirect');s.pass.prepare(s.encoder(),s.data(1));s.defer();const pending=s.pass.readVisibleCount();s.pass.clear();expect(await pending).toBeNull();
  s.pass.prepare(s.encoder(),s.data(1));const failed=s.pass.readVisibleCount();s.buffers.at(-1)!.reject!(new Error('Device lost'));await expect(failed).rejects.toThrow('Device lost');expect(s.buffers.at(-1)!.destroyed).toBe(true);
 });
});
