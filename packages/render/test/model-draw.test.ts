import {describe,it,expect,vi,afterEach} from 'vitest';
import {createModelDraw,type MaterialState} from '@aether/render';
import {createBox} from '@aether/scene';
const box=()=>createBox(1,1,1);
const material:MaterialState={albedo:'#ffffff',roughness:.8,metallic:0,emissiveColor:'#000000',emissiveStrength:0,shadowEnd:-1,specMix:0,softnessScale:1,halftoneScale:0,outlineScale:.1,unlit:false};
function fixture(fail=false){
 vi.stubGlobal('GPUBufferUsage',{COPY_DST:1,UNIFORM:2,VERTEX:4,INDEX:8,STORAGE:16});vi.stubGlobal('GPUTextureUsage',{TEXTURE_BINDING:1,COPY_DST:2,RENDER_ATTACHMENT:4});
 const allocated:{destroy:ReturnType<typeof vi.fn>}[]=[],ledger:(()=>void)[]=[];
 const resource=()=>{const r={destroy:vi.fn(),createView:()=>({})};allocated.push(r);return r;};
 const device={createBuffer:vi.fn(resource),createTexture:vi.fn(resource),createBindGroup:vi.fn(()=>{if(fail)throw new Error('allocation failure');return {}; }),
  queue:{writeBuffer:vi.fn(),writeTexture:vi.fn(),copyExternalImageToTexture:vi.fn()}} as unknown as GPUDevice;
 const core={frameBuf:{},lightsBuf:{},toonBuf:{},sampler:{},sceneLayout:{}} as Parameters<typeof createModelDraw>[1];
 const register=(_label:string,dispose:()=>void)=>{expect(allocated.at(-1)!.destroy).toHaveBeenCalledTimes(0);ledger.push(dispose);};
 return {allocated,ledger,device,core,register};
}
afterEach(()=>vi.unstubAllGlobals());
describe('独立mat4模型绘制资源',()=>{
 it('每个GPU buffer/texture立即登记，dispose与Stop账目重复释放幂等',()=>{
  const f=fixture(),draw=createModelDraw(f.device,f.core,{mesh:box(),subMeshes:[]},null,material,f.register,'model');
  expect(f.allocated).toHaveLength(7);expect(f.ledger).toHaveLength(7);expect(draw.draw.visible).toBe(false);
  draw.draw.visible=true;draw.dispose();for(const dispose of f.ledger)dispose();draw.dispose();
  expect(draw.draw.visible).toBe(false);for(const r of f.allocated)expect(r.destroy).toHaveBeenCalledTimes(1);
 });
 it('后半分配失败释放已创建全部资源，ledger仍可安全Stop',()=>{
  const f=fixture(true);expect(()=>createModelDraw(f.device,f.core,{mesh:box(),subMeshes:[]},null,material,f.register,'failed')).toThrow('allocation failure');
  expect(f.ledger).toHaveLength(7);for(const dispose of f.ledger)dispose();for(const r of f.allocated)expect(r.destroy).toHaveBeenCalledTimes(1);
 });
 it('bitmap texture在上传前进ledger，registrar取消时立刻销毁新资源',()=>{
  const f=fixture();let count=0;
  expect(()=>createModelDraw(f.device,f.core,{mesh:box(),subMeshes:[]},{width:1,height:1} as ImageBitmap,material,(_l,dispose)=>{
   count++;if(count===7)throw new Error('session stopped');f.ledger.push(dispose);
  },'cancel')).toThrow('session stopped');
  for(const r of f.allocated)expect(r.destroy).toHaveBeenCalledTimes(1);expect(f.device.queue.copyExternalImageToTexture).not.toHaveBeenCalled();
 });
});
