import type {VfxSoftParticleDefinition} from '@aether/scene';
/** clipZ=A*viewZ+B, clipW=C*viewZ+D; works for perspective and orthographic projections. */
export function projectionDepthCoefficients(projection:ArrayLike<number>):[number,number,number,number]{return [projection[10]!,projection[14]!,projection[11]!,projection[15]!];}
export function linearVfxDepth(depth:number,c:readonly number[]){return Math.abs((c[1]!-depth*c[3]!)/(depth*c[2]!-c[0]!));}
/** CPU oracle for shader verification. Clear depth=1 is background, not a surface at the far plane. */
export function softParticleFade(scene:number,particle:number,c:readonly number[],soft:VfxSoftParticleDefinition){if(scene>=1)return 1;return Math.max(0,Math.min(1,(linearVfxDepth(scene,c)-linearVfxDepth(particle,c)-soft.bias)/soft.fadeDistance));}
export const SOFT_DEPTH_WGSL=/* wgsl */`
@group(1) @binding(0) var sceneDepth:texture_depth_2d;
@group(1) @binding(1) var<uniform> depthProjection:vec4f;
fn eyeDepth(d:f32)->f32{return abs((depthProjection.y-d*depthProjection.w)/(d*depthProjection.z-depthProjection.x));}
fn intersectionFade(pixel:vec4f,soft:vec2f)->f32 {
 let size=vec2i(textureDimensions(sceneDepth));let xy=clamp(vec2i(pixel.xy),vec2i(0),size-vec2i(1));let scene=textureLoad(sceneDepth,xy,0);
 if(scene>=1.0){return 1.0;}return clamp((eyeDepth(scene)-eyeDepth(pixel.z)-soft.y)/soft.x,0.0,1.0);
}`;
/** Play-owned projection buffer; borrowed core depth views invalidate the cached group on resize. */
export class VfxSoftDepth {
 readonly layout:GPUBindGroupLayout;private readonly buffer:GPUBuffer;private view:GPUTextureView|null=null;private group:GPUBindGroup|null=null;private disposed=false;
 readonly stats={buffers:1,destroyedBuffers:0,viewChanges:0,uploadedBytes:0};
 constructor(private readonly device:GPUDevice){this.buffer=device.createBuffer({label:'vfx-soft-depth-projection',size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'depth'}},{binding:1,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}}]});}
 update(view:GPUTextureView,projection:Float32Array){if(this.disposed)throw new Error('softParticle 会话已销毁');if(this.view!==view){this.view=view;this.group=this.device.createBindGroup({layout:this.layout,entries:[{binding:0,resource:view},{binding:1,resource:{buffer:this.buffer}}]});this.stats.viewChanges++;}this.device.queue.writeBuffer(this.buffer,0,new Float32Array(projectionDepthCoefficients(projection)));this.stats.uploadedBytes=16;return this.group!;}
 destroy(){if(this.disposed)return;this.disposed=true;this.buffer.destroy();this.stats.buffers=0;this.stats.destroyedBuffers=1;this.view=this.group=null;}
}
