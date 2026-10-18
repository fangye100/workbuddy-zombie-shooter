import type { VfxInstance } from '@aether/runtime';

const SHADER = /* wgsl */ `
struct Frame { vp:mat4x4f };
struct Instance { center:vec4f, right:vec4f, up:vec4f, color:vec4f, uv:vec4f };
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
@group(0) @binding(2) var image:texture_2d<f32>;
@group(0) @binding(3) var samp:sampler;
struct Out { @builtin(position) pos:vec4f, @location(0) uv:vec2f, @location(1) color:vec4f };
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out {
 let corners=array<vec2f,6>(vec2f(-.5,-.5),vec2f(.5,-.5),vec2f(.5,.5),vec2f(-.5,-.5),vec2f(.5,.5),vec2f(-.5,.5));
 let p=corners[vi];let i=instances[ii];var o:Out;
 o.pos=frame.vp*vec4f(i.center.xyz+i.right.xyz*p.x+i.up.xyz*p.y,1);
 o.uv=vec2f(mix(i.uv.x,i.uv.y,p.x+.5),mix(i.uv.w,i.uv.z,p.y+.5));o.color=i.color;return o;
}
@fragment fn fs(i:Out)->@location(0) vec4f {
 let t=textureSample(image,samp,i.uv);let a=t.a*i.color.a;
 if(a<.003){discard;}
 return vec4f(t.rgb*i.color.rgb*a,a);
}`;
type V3=readonly number[];
const sub=(a:V3,b:V3)=>[a[0]!-b[0]!,a[1]!-b[1]!,a[2]!-b[2]!];
const cross=(a:V3,b:V3)=>[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];
const unit=(v:V3)=>{const l=Math.hypot(...v);return l>1e-8?v.map(x=>x/l):[1,0,0];};
const scale=(v:V3,n:number)=>v.map(x=>x*n);
const linear=(n:number)=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4;

/** Fixed-capacity instancing; independent depth-tested pass leaves the outline MRT untouched. */
export class VfxPass {
  private readonly uniform:GPUBuffer;
  private readonly buffer:GPUBuffer;
  private readonly sampler:GPUSampler;
  private readonly alpha:GPURenderPipeline;
  private readonly additive:GPURenderPipeline;
  private readonly textures=new Map<string,{texture:GPUTexture;group:GPUBindGroup;width:number;height:number}>();
  private disposed=false;
  instances:readonly VfxInstance[]=[];
  readonly stats={active:0,draws:0,uploadedBytes:0,buffers:2,textures:0,destroyedBuffers:0,destroyedTextures:0};
  constructor(private readonly device:GPUDevice,readonly capacity=256) {
    this.uniform=device.createBuffer({label:'vfx-frame',size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.buffer=device.createBuffer({label:'vfx-instances',size:capacity*80,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    this.sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
    const module=device.createShaderModule({label:'vfx',code:SHADER});
    const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}},{binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{}},{binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{}}]});
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
    const pipeline=(additive:boolean)=>device.createRenderPipeline({label:`vfx-${additive?'additive':'alpha'}`,layout:pipelineLayout,vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float',blend:{color:{srcFactor:'one',dstFactor:additive?'one':'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'},depthStencil:{format:'depth24plus',depthCompare:'less-equal',depthWriteEnabled:false}});
    this.alpha=pipeline(false);this.additive=pipeline(true);
  }
  addTexture(key:string,bitmap:ImageBitmap):void {
    if(this.disposed)return;
    if(this.textures.has(key))return;
    if(bitmap.width>4096 || bitmap.height>4096 || this.textures.size>=16)throw new Error('VFX 纹理预算超限（16张/4096px）');
    const texture=this.device.createTexture({label:`vfx:${key}`,size:[bitmap.width,bitmap.height],format:'rgba8unorm-srgb',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    this.device.queue.copyExternalImageToTexture({source:bitmap},{texture,premultipliedAlpha:false},[bitmap.width,bitmap.height]);
    const group=this.device.createBindGroup({layout:this.alpha.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.buffer}},{binding:2,resource:texture.createView()},{binding:3,resource:this.sampler}]});
    this.textures.set(key,{texture,group,width:bitmap.width,height:bitmap.height});this.stats.textures=this.textures.size;
  }
  draw(encoder:GPUCommandEncoder,color:GPUTextureView,depth:GPUTextureView,vp:Float32Array,eye:V3,view:Float32Array):number {
    this.stats.active=0;this.stats.draws=0;this.stats.uploadedBytes=0;
    if(this.disposed)return 0;
    // Far-to-near alpha. Preserve that order; batch only consecutive compatible items.
    const depthOf=(p:V3)=>view[2]!*p[0]!+view[6]!*p[1]!+view[10]!*p[2]!+view[14]!;
    const items=this.instances.filter(p=>this.textures.has(p.effect.texture.guid)).slice(0,this.capacity).sort((a,b)=>depthOf(a.position)-depthOf(b.position));
    if(!items.length)return 0;
    const data=new Float32Array(items.length*20);
    for(let i=0;i<items.length;i++){
      const p=items[i]!,e=p.effect,o=i*20;let position:V3=p.position;
      const facing=unit(sub(eye,position));let right=unit(cross([0,1,0],facing)),up=unit(cross(facing,right));
      if(e.kind==='trail' && p.end){position=p.position.map((n,k)=>(n+p.end![k]!)/2);right=sub(p.end,p.position);up=scale(unit(cross(right,sub(eye,position))),e.size[1]);}
      else {
        if(p.normal){const n=unit(p.normal);right=unit(cross(Math.abs(n[1]!)>.95?[1,0,0]:[0,1,0],n));up=unit(cross(n,right));position=position.map((v,k)=>v+n[k]!*.008);}
        else {const angle=(p.seed%6283)/1000,c=Math.cos(angle),s=Math.sin(angle),r=right;right=r.map((v,k)=>v*c+up[k]!*s);up=up.map((v,k)=>v*c-r[k]!*s);}
        right=scale(right,e.size[0]);up=scale(up,e.size[1]);
      }
      const rgb=[1,3,5].map(k=>linear(parseInt(e.color.slice(k,k+2),16)/255));
      const tex=this.textures.get(e.texture.guid)!,frame=Math.min(e.frames-1,Math.floor(p.age/e.duration*e.frames));
      data.set([...position,0],o);data.set([...right,0],o+4);data.set([...up,0],o+8);data.set([...rgb,Math.max(0,1-p.age/e.duration)],o+12);
      data.set([frame/e.frames+.5/tex.width,(frame+1)/e.frames-.5/tex.width,.5/tex.height,1-.5/tex.height],o+16);
    }
    this.device.queue.writeBuffer(this.uniform,0,vp as Float32Array<ArrayBuffer>);this.device.queue.writeBuffer(this.buffer,0,data);
    const pass=encoder.beginRenderPass({label:'vfx',colorAttachments:[{view:color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:depth,depthLoadOp:'load',depthStoreOp:'store'}});
    let i=0;
    while(i<items.length){const first=items[i]!,key=first.effect.texture.guid,blend=first.effect.blend;let end=i+1;while(end<items.length && items[end]!.effect.texture.guid===key && items[end]!.effect.blend===blend)end++;
      pass.setPipeline(blend==='additive'?this.additive:this.alpha);pass.setBindGroup(0,this.textures.get(key)!.group);pass.draw(6,end-i,0,i);this.stats.draws++;i=end;
    }
    pass.end();this.stats.active=items.length;this.stats.uploadedBytes=data.byteLength+64;return this.stats.draws;
  }
  destroy():void {if(this.disposed)return;this.disposed=true;this.uniform.destroy();this.buffer.destroy();this.stats.destroyedBuffers+=2;for(const {texture} of this.textures.values()){texture.destroy();this.stats.destroyedTextures++;}this.textures.clear();this.instances=[];this.stats.active=this.stats.draws=this.stats.buffers=this.stats.textures=0;}
}
