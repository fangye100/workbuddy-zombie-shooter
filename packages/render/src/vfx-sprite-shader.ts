import {SOFT_DEPTH_WGSL} from './vfx-soft-depth';
export function vfxSpriteShader(soft:boolean){return /* wgsl */ `
struct Frame { vp:mat4x4f };
struct Instance { center:vec4f, right:vec4f, up:vec4f, color:vec4f, uv:vec4f, soft:vec4f };
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
@group(0) @binding(2) var image:texture_2d<f32>;
@group(0) @binding(3) var samp:sampler;
struct Out { @builtin(position) pos:vec4f, @location(0) uv:vec2f, @location(1) color:vec4f, @location(2) soft:vec2f };
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out {
 let corners=array<vec2f,6>(vec2f(-.5,-.5),vec2f(.5,-.5),vec2f(.5,.5),vec2f(-.5,-.5),vec2f(.5,.5),vec2f(-.5,.5));
 let p=corners[vi];let i=instances[ii];var o:Out;
 o.pos=frame.vp*vec4f(i.center.xyz+i.right.xyz*p.x+i.up.xyz*p.y,1);
 o.uv=vec2f(mix(i.uv.x,i.uv.y,p.x+.5),mix(i.uv.w,i.uv.z,p.y+.5));o.color=i.color;o.soft=i.soft.xy;return o;
}
${soft?SOFT_DEPTH_WGSL:''}
struct Fragment { @location(0) color:vec4f, @location(1) aux:vec4f };
@fragment fn fs(i:Out)->Fragment {
 let t=textureSample(image,samp,i.uv);let a=t.a*i.color.a${soft?'*intersectionFade(i.pos,i.soft)':''};
 if(a<.003){discard;}
 var o:Fragment;o.color=vec4f(t.rgb*i.color.rgb*a,a);o.aux=vec4f(0,0,0,a);return o;
}`;}

/** Both variants share the same instance layout; only the soft variant borrows a sampled depth group. */
export function createVfxSpritePipelines(device:GPUDevice,layouts:GPUBindGroupLayout[],soft=false){
 const module=device.createShaderModule({label:soft?'vfx-soft-sprite':'vfx-sprite',code:vfxSpriteShader(soft)}),layout=device.createPipelineLayout({bindGroupLayouts:layouts});
 const pipeline=(additive:boolean)=>device.createRenderPipeline({label:`vfx-${soft?'soft-':''}${additive?'additive':'alpha'}`,layout,vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float',blend:{color:{srcFactor:'one',dstFactor:additive?'one':'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}},{format:'rgba16float',writeMask:GPUColorWrite.ALPHA,blend:{color:{srcFactor:'zero',dstFactor:'one'},alpha:{srcFactor:'zero',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'},depthStencil:{format:'depth24plus',depthCompare:'less-equal',depthWriteEnabled:false}});
 return {alpha:pipeline(false),additive:pipeline(true)};
}
