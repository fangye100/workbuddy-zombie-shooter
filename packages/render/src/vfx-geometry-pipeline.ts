const SHADER=/* wgsl */`
struct Frame {vp:mat4x4f};
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var samp:sampler;
struct Out {@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f};
@vertex fn vs(@location(0) position:vec3f,@location(1) uv:vec2f,@location(2) color:vec4f)->Out {var o:Out;o.position=frame.vp*vec4f(position,1);o.uv=uv;o.color=color;return o;}
struct Fragment {@location(0) color:vec4f,@location(1) aux:vec4f};
@fragment fn fs(i:Out)->Fragment {let t=textureSample(image,samp,i.uv);let a=t.a*i.color.a;if(a<.003){discard;}var o:Fragment;o.color=vec4f(t.rgb*i.color.rgb*a,a);o.aux=vec4f(0,0,0,a);return o;}
`;
/** Common indexed world-position/UV/premultiplied-color pipelines for real VFX geometry. */
export function createVfxGeometryPipelines(device:GPUDevice,label:string){const module=device.createShaderModule({label:label,code:SHADER});
  const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}},{binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{}},{binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{}}]}),pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
  const pipeline=(additive:boolean)=>device.createRenderPipeline({label:label+'-'+(additive?'additive':'alpha'),layout:pipelineLayout,vertex:{module,entryPoint:'vs',buffers:[{arrayStride:36,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x2'},{shaderLocation:2,offset:20,format:'float32x4'}]}]},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float',blend:{color:{srcFactor:'one',dstFactor:additive?'one':'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}},{format:'rgba16float',writeMask:GPUColorWrite.ALPHA,blend:{color:{srcFactor:'zero',dstFactor:'one'},alpha:{srcFactor:'zero',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'},depthStencil:{format:'depth24plus',depthCompare:'less-equal',depthWriteEnabled:false}});return {alpha:pipeline(false),additive:pipeline(true)};
}
