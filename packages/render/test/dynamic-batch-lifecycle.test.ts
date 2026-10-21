import {describe,it,expect,vi} from 'vitest';
import {RendererCore,type CoreDynamicBatch} from '../src/renderer-core';

// GPU API 替身只隔离硬件；调用原 drawDynamicBatches、状态发布和释放 owner。
function host() {
  const core=Object.create(RendererCore.prototype) as RendererCore;
  const gpu=core as unknown as Record<string,any>;
  const resources=new Map<string,any>();
  gpu.dynamicMeshes=resources;gpu.dynamicErrors=new Map();gpu.dynamicBatchResults=new Map();gpu.dynamicFailureCount=0;
  gpu.device={queue:{writeBuffer:vi.fn()}};
  const slot={buf:{label:'instances'},rigidBuf:{label:'rigid'},poseBuf:{},bg:{}};
  gpu.dynamicInstSlot=vi.fn(()=>slot);
  gpu.materialFor=vi.fn(()=>({}));
  gpu.dynamicMesh=vi.fn((b:CoreDynamicBatch)=>{
    if(!resources.has(b.meshId))resources.set(b.meshId,{vbuf:{destroy:vi.fn()},ibuf:{destroy:vi.fn()},skinVb:{destroy:vi.fn()},indexCount:3});
    return resources.get(b.meshId);
  });
  const pass={setBindGroup:vi.fn(),setVertexBuffer:vi.fn(),setIndexBuffer:vi.fn(),setPipeline:vi.fn(),drawIndexed:vi.fn()};
  return {core,gpu,slot,resources,pass,draw:(bs:CoreDynamicBatch[])=>gpu.drawDynamicBatches(pass,bs,false)};
}
const batch=(meshId:string):CoreDynamicBatch=>({meshId,vertices:new Float32Array(45),indices:new Uint32Array([0,1,2]),skin:null,instances:new Float32Array(20),rigid:new Float32Array(12),count:1,outline:true});

describe('动态GPU实际上传回执与姿态网格退役',()=>{
  it('分配前没有ready；真实原上传+draw编码成功后才发布ready',()=>{
    const {core,draw,gpu,pass}=host(),b=batch('fracture:pose:1');
    expect(core.dynamicBatchState([b])).toBe('pending');
    expect(draw([b])).toBe(1);expect(gpu.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
    expect(pass.drawIndexed).toHaveBeenCalledOnce();expect(core.dynamicBatchState([b])).toBe('ready');
  });
  it.each(['instances','rigid','draw'])('%s失败不能发布成功；下一真实帧成功可恢复',stage=>{
    const {core,draw,gpu,pass}=host(),b=batch('fracture:pose:failure');
    if(stage==='draw')pass.drawIndexed.mockImplementationOnce(()=>{throw new Error('upload oracle');});
    else gpu.device.queue.writeBuffer.mockImplementation((buf:{label:string})=>{if(buf.label===stage)throw new Error('upload oracle');});
    expect(draw([b])).toBe(0);expect(core.dynamicBatchState([b])).toBe('failed');expect(core.dynamicError).toContain('upload oracle');
    gpu.device.queue.writeBuffer.mockReset();expect(draw([b])).toBe(1);expect(core.dynamicBatchState([b])).toBe('ready');expect(core.dynamicError).toBeNull();
  });
  it('同几何多材质中任一上传失败，本帧整体不能就绪',()=>{
    const {core,draw,gpu}=host(),b=batch('fracture:pose:parts');let calls=0;
    gpu.device.queue.writeBuffer.mockImplementation(()=>{if(++calls===2)throw new Error('first part failed');});
    draw([b,{...b,indexStart:0,indexCount:3}]);expect(core.dynamicBatchState([b])).toBe('failed');
  });
  it('释放退役的3个真实资源引用，保留仍活跃/其他owner；重复激活不累积',()=>{
    const {core,draw,resources}=host(),old=batch('fracture:old'),live=batch('fracture:live'),actor=batch('actor:E-04');
    draw([old,live,actor]);const retained=resources.get(old.meshId),kept=resources.get(live.meshId),other=resources.get(actor.meshId);
    core.releaseDynamicMeshesWithPrefix('fracture:',new Set([live.meshId]));
    for(const b of Object.values(retained) as any[])if(b?.destroy)expect(b.destroy).toHaveBeenCalledOnce();
    expect(kept.vbuf.destroy).not.toHaveBeenCalled();expect(other.vbuf.destroy).not.toHaveBeenCalled();expect(core.dynamicBatchState([old])).toBe('pending');
    for(let i=0;i<5;i++){const b=batch('fracture:next:'+i);draw([b]);const r=resources.get(b.meshId);core.releaseDynamicMeshesWithPrefix('fracture:',new Set([live.meshId]));expect(r.vbuf.destroy).toHaveBeenCalledOnce();}
    expect(resources.size).toBe(2);core.releaseDynamicMeshesWithPrefix('fracture:');expect(kept.vbuf.destroy).toHaveBeenCalledOnce();expect(resources.has(actor.meshId)).toBe(true);
  });
});
