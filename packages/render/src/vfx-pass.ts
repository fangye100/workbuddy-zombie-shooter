import {createVfxSpritePipelines} from './vfx-sprite-shader';
import {VfxSoftDepth} from './vfx-soft-depth';
import {sampleVfxVisual} from './vfx-visual';
import type { VfxInstance } from '@aether/runtime';
import type {VfxAnchor} from '@aether/runtime';
import type {VfxEffectDefinition} from '@aether/scene';
import {gpuVfxReason} from '@aether/scene';
import {VfxGpuSimulation} from './vfx-simulation';
import {VfxRibbonRenderer} from './vfx-ribbon';
import type {RibbonTrail} from '@aether/runtime';

type V3=readonly number[];
const sub=(a:V3,b:V3)=>[a[0]!-b[0]!,a[1]!-b[1]!,a[2]!-b[2]!];
const cross=(a:V3,b:V3)=>[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];
const unit=(v:V3)=>{const l=Math.hypot(...v);return l>1e-8?v.map(x=>x/l):[1,0,0];};
const scale=(v:V3,n:number)=>v.map(x=>x*n);

/** Fixed-capacity instancing. Covered pixels attenuate existing outline mask by (1-alpha). */
export class VfxPass {
  private readonly uniform:GPUBuffer;
  private readonly buffer:GPUBuffer;
  private readonly sampler:GPUSampler;
  private readonly alpha:GPURenderPipeline;
  private readonly additive:GPURenderPipeline;
  private soft:VfxSoftDepth|null=null;private softAlpha:GPURenderPipeline|null=null;private softAdditive:GPURenderPipeline|null=null;private readonly layout:GPUBindGroupLayout;
  private readonly textures=new Map<string,{texture:GPUTexture;group:GPUBindGroup;width:number;height:number}>();
  private disposed=false;
  gpu:VfxGpuSimulation|null=null;
  ribbon:VfxRibbonRenderer|null=null;
  ribbons:readonly RibbonTrail[]=[];
  gpuCompatibilityReason:string|null=null;
  /** Capability seam also permits explicitly labelled validation restrictions. */
  gpuSupport=()=>VfxGpuSimulation.capability(this.device);
  instances:readonly VfxInstance[]=[];
  readonly stats={active:0,draws:0,uploadedBytes:0,ribbonPoints:0,ribbonSegments:0,ribbonDraws:0,buffers:2,textures:0,destroyedBuffers:0,destroyedTextures:0,softInstances:0,softDepthRebinds:0};
  constructor(private readonly device:GPUDevice,readonly capacity=256) {
    this.uniform=device.createBuffer({label:'vfx-frame',size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.buffer=device.createBuffer({label:'vfx-instances',size:capacity*96,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    this.sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
    const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}},{binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{}},{binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{}}]});
    this.layout=layout;const pipelines=createVfxSpritePipelines(device,[layout]);this.alpha=pipelines.alpha;this.additive=pipelines.additive;
  }
  private ensureSoft(){if(this.soft)return;this.soft=new VfxSoftDepth(this.device);const pipelines=createVfxSpritePipelines(this.device,[this.layout,this.soft.layout],true);this.softAlpha=pipelines.alpha;this.softAdditive=pipelines.additive;}

  addTexture(key:string,bitmap:ImageBitmap):void {
    if(this.disposed)return;
    if(this.textures.has(key))return;
    if(bitmap.width>4096 || bitmap.height>4096 || this.textures.size>=16)throw new Error('VFX 纹理预算超限（16张/4096px）');
    const texture=this.device.createTexture({label:`vfx:${key}`,size:[bitmap.width,bitmap.height],format:'rgba8unorm-srgb',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    this.device.queue.copyExternalImageToTexture({source:bitmap},{texture,premultipliedAlpha:false},[bitmap.width,bitmap.height]);
    const group=this.device.createBindGroup({layout:this.alpha.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.buffer}},{binding:2,resource:texture.createView()},{binding:3,resource:this.sampler}]});
    this.textures.set(key,{texture,group,width:bitmap.width,height:bitmap.height});this.stats.textures=this.textures.size;
  }
  drawable(p:VfxInstance):boolean{const texture=this.textures.get(p.effect.texture.guid);return !this.disposed && p.effect.kind!=='ribbon' && !!texture && texture.width%p.effect.frames===0 && (p.effect.orientation!=='surface' || !!p.normal);}
  ribbonDrawable(t:RibbonTrail):boolean{return !this.disposed && this.textures.has(t.effect.texture.guid) && t.points.some((p,i)=>i>0 && !p.breakBefore);}
  private alphaPresent(){return this.instances.some(p=>p.effect.blend==='alpha' && this.drawable(p)) || this.ribbons.some(t=>t.effect.blend==='alpha' && this.textures.has(t.effect.texture.guid) && t.points.some((p,i)=>i>0 && !p.breakBefore));}
  private bufferCount(){return 2+(this.gpu?.stats.buffers??0)+(this.ribbon?.stats.buffers??0)+(this.soft?.stats.buffers??0);}
  updateGpuEmitter(key:string,effect:VfxEffectDefinition,anchor:VfxAnchor,tick:number,step:number,seed:number,playing=true):string|null {
    if(this.disposed)return 'VFX会话已停止';const reason=this.gpuSupport()??gpuVfxReason(effect)??(this.alphaPresent()?'同屏 CPU alpha（含Ribbon）需要统一排序，GPU发射器使用有界 CPU 兼容':null);this.gpuCompatibilityReason=reason;if(reason){this.gpu?.release(key);this.stats.buffers=this.bufferCount();return reason;}
    if(!this.textures.has(effect.texture.guid))return 'GPU模拟纹理未就绪';this.gpu??=new VfxGpuSimulation(this.device,key=>this.textures.get(key),this.sampler);
    const result=this.gpu.update(key,effect,anchor,tick,step,seed,playing);if(result)this.gpu.release(key);this.stats.buffers=this.bufferCount();return result;
  }
  private drawGpu(encoder:GPUCommandEncoder,color:GPUTextureView,aux:GPUTextureView,depth:GPUTextureView,vp:Float32Array,eye:V3){if(this.alphaPresent()){this.gpuCompatibilityReason='同屏 CPU alpha（含Ribbon）需要统一排序，GPU发射器使用有界 CPU 兼容';if(this.gpu)for(const key of this.gpu.snapshot().keys)this.gpu.release(key);this.stats.buffers=this.bufferCount();this.gpu?.encode(encoder,color,aux,depth,vp,eye);return;}this.gpu?.encode(encoder,color,aux,depth,vp,eye);if(this.gpu){this.stats.draws+=this.gpu.stats.draws;this.stats.uploadedBytes+=this.gpu.stats.uploadedBytes;}}
  draw(encoder:GPUCommandEncoder,color:GPUTextureView,aux:GPUTextureView,depth:GPUTextureView,vp:Float32Array,eye:V3,view:Float32Array,projection:Float32Array):number {
    this.stats.active=0;this.stats.draws=0;this.stats.uploadedBytes=0;this.stats.softInstances=0;
    if(this.disposed)return 0;
    // Far-to-near alpha. Preserve that order; batch only consecutive compatible items.
    const depthOf=(p:V3)=>view[2]!*p[0]!+view[6]!*p[1]!+view[10]!*p[2]!+view[14]!;
    const items=this.instances.filter(p=>this.drawable(p)).slice(0,this.capacity).sort((a,b)=>depthOf(sampleVfxVisual(a).position)-depthOf(sampleVfxVisual(b).position));
    if(this.ribbons.length)this.ribbon??=new VfxRibbonRenderer(this.device,this.uniform,key=>this.textures.get(key));
    const segments=this.ribbon?.prepare(this.ribbons,eye,view)??[];this.stats.ribbonPoints=this.ribbon?.stats.points??0;this.stats.ribbonSegments=segments.length;this.stats.ribbonDraws=0;this.stats.buffers=this.bufferCount();
    if(!items.length && !segments.length){this.drawGpu(encoder,color,aux,depth,vp,eye);return this.stats.draws;}
    const hasSoft=items.some(p=>!!p.effect.softParticle);let softGroup:GPUBindGroup|null=null;if(hasSoft){this.ensureSoft();softGroup=this.soft!.update(depth,projection);}this.stats.softInstances=items.filter(p=>!!p.effect.softParticle).length;this.stats.softDepthRebinds=this.soft?.stats.viewChanges??0;this.stats.buffers=this.bufferCount();
    const data=new Float32Array(items.length*24);
    for(let i=0;i<items.length;i++){
      const p=items[i]!,e=p.effect,o=i*24,visual=sampleVfxVisual(p);let position:V3=visual.position;
      const facing=unit(sub(eye,position));let right=unit(cross([0,1,0],facing)),up=unit(cross(facing,right));
      if(e.kind==='trail' && p.end){position=p.position.map((n,k)=>(n+p.end![k]!)/2);right=sub(p.end,p.position);up=scale(unit(cross(right,sub(eye,position))),e.size[1]);}
      else {
        if(p.normal && e.orientation!=='camera'){const n=unit(p.normal);right=p.direction?unit(p.direction.map((v,k)=>v-n[k]!*p.direction!.reduce((s,x,j)=>s+x*n[j]!,0))):unit(cross(Math.abs(n[1]!)>.95?[1,0,0]:[0,1,0],n));up=unit(cross(n,right));position=position.map((v,k)=>v+n[k]!*.008);}
        else {const angle=(p.seed%6283)/1000,c=Math.cos(angle),s=Math.sin(angle),r=right;right=r.map((v,k)=>v*c+up[k]!*s);up=up.map((v,k)=>v*c-r[k]!*s);}
        right=scale(right,e.size[0]*visual.size);up=scale(up,e.size[1]*visual.size);
      }
      const rgb=visual.color;
      const progress=e.loop?(p.age%e.duration)/e.duration:p.age/e.duration;
      const tex=this.textures.get(e.texture.guid)!,frame=Math.min(e.frames-1,Math.floor(progress*e.frames));
      const alpha=p.lifetime===undefined?Math.max(0,1-p.age/e.duration):Math.min(1,Math.max(0,(p.lifetime-p.age)/.15));
      data.set([...position,0],o);data.set([...right,0],o+4);data.set([...up,0],o+8);data.set([...rgb,alpha*visual.alpha],o+12);
      data.set([frame/e.frames+.5/tex.width,(frame+1)/e.frames-.5/tex.width,.5/tex.height,1-.5/tex.height],o+16);data.set([e.softParticle?.fadeDistance??0,e.softParticle?.bias??0,0,0],o+20);
    }
    this.device.queue.writeBuffer(this.uniform,0,vp as Float32Array<ArrayBuffer>);this.device.queue.writeBuffer(this.buffer,0,data);
    const pass=encoder.beginRenderPass({label:'vfx',colorAttachments:[{view:color,loadOp:'load',storeOp:'store'},{view:aux,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:depth,depthReadOnly:true}});
    const order=[...items.map((p,i)=>({kind:'sprite' as const,depth:depthOf(sampleVfxVisual(p).position),i,key:p.effect.texture.guid,blend:p.effect.blend,soft:!!p.effect.softParticle})),...segments.map(s=>({kind:'ribbon' as const,depth:s.depth,segment:s,key:s.texture,blend:s.blend}))].sort((a,b)=>a.depth-b.depth);
    for(let i=0;i<order.length;){const first=order[i]!;let end=i+1;
      if(first.kind==='sprite'){while(end<order.length){const n=order[end]!,prev=order[end-1]!;if(n.kind!=='sprite' || prev.kind!=='sprite' || n.key!==first.key || n.blend!==first.blend || n.i!==prev.i+1 || n.soft!==first.soft)break;end++;}pass.setPipeline(first.soft?(first.blend==='additive'?this.softAdditive!:this.softAlpha!):(first.blend==='additive'?this.additive:this.alpha));if(first.soft)pass.setBindGroup(1,softGroup!);pass.setBindGroup(0,this.textures.get(first.key)!.group);pass.draw(6,end-i,0,first.i);}
      else{let count=first.segment.indexCount;while(end<order.length){const n=order[end]!;if(n.kind!=='ribbon' || n.key!==first.key || n.blend!==first.blend || n.segment.firstIndex!==first.segment.firstIndex+count)break;count+=n.segment.indexCount;end++;}this.ribbon!.draw(pass,first.segment,count);}
      this.stats.draws++;i=end;
    }
    pass.end();this.stats.ribbonDraws=this.ribbon?.stats.draws??0;this.stats.active=items.length;this.stats.uploadedBytes=data.byteLength+64+(this.ribbon?.stats.uploadedBytes??0)+(hasSoft?16:0);this.drawGpu(encoder,color,aux,depth,vp,eye);return this.stats.draws;
  }
  destroy():void {if(this.disposed)return;this.disposed=true;this.uniform.destroy();this.buffer.destroy();this.stats.destroyedBuffers+=2;this.gpu?.destroy();this.ribbon?.destroy();this.soft?.destroy();this.stats.destroyedBuffers+=(this.gpu?.stats.destroyedBuffers??0)+(this.ribbon?.stats.destroyedBuffers??0)+(this.soft?.stats.destroyedBuffers??0);for(const {texture} of this.textures.values()){texture.destroy();this.stats.destroyedTextures++;}this.textures.clear();this.instances=[];this.ribbons=[];this.stats.active=this.stats.draws=this.stats.buffers=this.stats.textures=this.stats.ribbonPoints=this.stats.ribbonSegments=this.stats.ribbonDraws=this.stats.softInstances=0;}
}
