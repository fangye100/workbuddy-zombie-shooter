/** 单模型独立矩阵绘制；复用 CoreObjectDraw，不使用作者槽位或群体实例 ABI。 */
import { mat4 } from '@aether/core';
import { packSkin, type GltfResult } from '@aether/scene';
import { createAlbedoTexture } from './albedo-texture';
import { packMaterial } from './frame-uniforms';
import type { MaterialState } from './materials';
import type { CoreObjectDraw, RendererCore } from './renderer-core';
export type RegisterDrawResource=(label:string,dispose:()=>void)=>void;
export interface ModelDraw {
  draw:CoreObjectDraw; setMatrix(matrix:Float32Array):void; dispose():void;
}
export function createModelDraw(device:GPUDevice,core:Pick<RendererCore,'sceneLayout'|'frameBuf'|'lightsBuf'|'toonBuf'|'sampler'>,
  model:Pick<GltfResult,'mesh'|'subMeshes'>,bitmap:ImageBitmap|null,material:MaterialState,register:RegisterDrawResource,label:string):ModelDraw {
  const releases:(()=>void)[]=[];
  const own=<T extends {destroy():void}>(value:T,name:string):T=>{
    let live=true;const dispose=()=>{if(live){live=false;value.destroy();}};
    releases.push(dispose);
    try{register(`${label}:${name}`,dispose);}catch(error){dispose();throw error;}
    return value;
  };
  const dispose=()=>{for(const release of releases)release();};
  const buffer=(data:ArrayBufferView<ArrayBuffer>,usage:number,name:string):GPUBuffer=>{
    const b=own(device.createBuffer({label:`${label}:${name}`,size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST}),name);
    device.queue.writeBuffer(b,0,data);return b;
  };
  try{
    const vertexBuffer=buffer(new Float32Array(model.mesh.vertices),GPUBufferUsage.VERTEX,'vertices');
    const indexBuffer=buffer(new Uint32Array(model.mesh.indices),GPUBufferUsage.INDEX,'indices');
    const count=model.mesh.vertices.length/15;
    const skinVb=buffer(new Uint8Array(packSkin(null,null,count)),GPUBufferUsage.VERTEX,'identity-skin-vertices');
    const joints=buffer(mat4(),GPUBufferUsage.STORAGE,'identity-joint');
    const matrixBuffer=buffer(mat4(),GPUBufferUsage.UNIFORM,'model-matrix');
    const mat=new Float32Array(20);packMaterial(mat,0,material);mat[18]=bitmap?1:0;
    const materialBuffer=buffer(mat,GPUBufferUsage.UNIFORM,'material');
    let texture:GPUTexture;
    if(bitmap)texture=createAlbedoTexture(device,bitmap,t=>own(t,'albedo'));
    else{
      texture=own(device.createTexture({label:`${label}:white`,size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),'white');
      device.queue.writeTexture({texture},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]);
    }
    const bindGroup=device.createBindGroup({label,layout:core.sceneLayout,entries:[
      {binding:0,resource:{buffer:core.frameBuf}},{binding:1,resource:{buffer:core.lightsBuf}},{binding:2,resource:{buffer:core.toonBuf}},
      {binding:3,resource:{buffer:materialBuffer,size:80}},{binding:4,resource:{buffer:matrixBuffer,size:64}},
      {binding:5,resource:texture.createView()},{binding:6,resource:core.sampler},{binding:7,resource:{buffer:joints,size:64}},
    ]});
    const ranges=model.subMeshes.length?model.subMeshes:[{indexStart:0,indexCount:model.mesh.indices.length}];
    const draw:CoreObjectDraw={vertexBuffer,indexBuffer,skinVb,visible:false,subMeshes:ranges.map(r=>({indexStart:r.indexStart,indexCount:r.indexCount,visible:true,bindGroup,outline:material.outlineScale>.001}))};
    let destroyed=false;
    return {draw,setMatrix(matrix){if(destroyed)return;if(matrix.length!==16||!Array.from(matrix).every(Number.isFinite))throw new Error('Model draw matrix must be finite mat4');device.queue.writeBuffer(matrixBuffer,0,new Float32Array(matrix));},
      dispose(){if(destroyed)return;destroyed=true;draw.visible=false;dispose();}};
  }catch(error){dispose();throw error;}
}
