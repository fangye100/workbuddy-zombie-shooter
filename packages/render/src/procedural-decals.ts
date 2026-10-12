import {DECAL_INSTANCE_FLOATS,MAX_RUNTIME_DECALS} from './decal-instances';
import {MAX_AUTHORED_DECALS} from '@aether/scene';

export const PROCEDURAL_DECAL_WGSL=/* wgsl */`
struct Frame {vp:mat4x4f};
struct Mark {center:vec4f,axisU:vec4f,axisV:vec4f,color:vec4f};
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> marks:array<Mark>;
struct V { @builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) @interpolate(flat) color:vec4f,@location(2) @interpolate(flat) info:vec2f };
struct F {@location(0) color:vec4f,@location(1) aux:vec4f};
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->V {
  let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let p=corners[vi];let m=marks[ii];var v:V;
  v.position=frame.vp*vec4f(m.center.xyz+p.x*m.axisU.xyz+p.y*m.axisV.xyz,1);
  v.uv=p;v.color=m.color;v.info=vec2f(m.center.w,m.axisU.w);return v;
}
fn hash(n:f32)->f32 {return fract(sin(n*127.1+311.7)*43758.5453);}
fn segment(p:vec2f,a:vec2f,b:vec2f)->f32 {let d=b-a;return length(p-a-d*clamp(dot(p-a,d)/dot(d,d),0.,1.));}
@fragment fn fs(v:V)->F {
  let p=v.uv;let seed=v.info.y;let r=length(p);let angle=atan2(p.y,p.x);
  let aa=max(length(fwidth(p)),.001);var sdf=1.;var ink=0.;var shade=1.;
  let noise=sin(angle*7.+seed)*.08+sin(angle*13.-seed)*.04;
  if(v.info.x<.5){
    sdf=r-(.54+noise);
    for(var i=0;i<8;i++){let f=f32(i)+seed;let a=hash(f)*6.28318;let center=vec2f(cos(a),sin(a))*(.65+hash(f+7.)*.12);sdf=min(sdf,length(p-center)-(.035+hash(f+3.)*.10));}
    ink=1.-smoothstep(.025,.07,-sdf);
    // 美漫网点是透明镂空，避免产生一整块矩形底。
    let dotUv=fract(p*15.)-.5;let dots=1.-smoothstep(.19,.22,length(dotUv));shade=1.-.3*dots;
  }else if(v.info.x<1.5){
    sdf=r-(.8+noise);shade=.35+.65*smoothstep(.05,.7,r);ink=1.-smoothstep(.015,.06,-sdf);
  }else if(v.info.x<2.5){
    let bend=(hash(seed)-.5)*.5;
    let d=min(segment(p,vec2f(-.9,-.7),vec2f(-.2,bend)),segment(p,vec2f(-.2,bend),vec2f(.9,.55)));
    let fork=min(segment(p,vec2f(-.2,bend),vec2f(-.6,.8)),segment(p,vec2f(.32,.27),vec2f(.8,-.5)));
    sdf=min(d-.022,fork-.012);ink=.8;
  }else if(v.info.x<3.5){
    sdf=max(abs(p.x)-.95,abs(p.y)-.8);
    ink=max(1.-smoothstep(.035,.09,-sdf),step(.5,fract((p.x+p.y)*3.))*.9);
  }else{
    sdf=r-(.37+noise*.7);ink=max(1.-smoothstep(.015,.055,-sdf),1.-smoothstep(.09,.17,r));
  }
  let alpha=(1.-smoothstep(-aa,aa,sdf))*v.color.a;
  if(alpha<.002){discard;}
  let rgb=mix(v.color.rgb*shade,vec3f(.008),ink);
  var o:F;o.color=vec4f(rgb*alpha,alpha);o.aux=vec4f(0);return o;
}`;

/** 同管线实例批：无纹理分配、无静态槽、透明不写深度、不向 aux 写矩形描边。 */
export class ProceduralDecalPass {
  readonly module:GPUShaderModule;
  private readonly pipeline:GPURenderPipeline;
  private buffer:GPUBuffer|null=null;private group:GPUBindGroup|null=null;private capacity=0;
  private count=0;private draws=0;
  constructor(private readonly device:GPUDevice,private readonly frame:GPUBuffer,hdr:GPUTextureFormat,depth:GPUTextureFormat){
    this.module=device.createShaderModule({label:'procedural-decals',code:PROCEDURAL_DECAL_WGSL});
    this.pipeline=device.createRenderPipeline({label:'procedural-decals',layout:'auto',vertex:{module:this.module,entryPoint:'vs'},
      fragment:{module:this.module,entryPoint:'fs',targets:[{format:hdr,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}},{format:hdr,writeMask:0}]},
      primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:depth,depthWriteEnabled:false,depthCompare:'less-equal'}});
  }
  draw(pass:GPURenderPassEncoder,data:Float32Array<ArrayBuffer>):number {
    const count=data.length/DECAL_INSTANCE_FLOATS;this.draws=0;this.count=count;
    if(!Number.isInteger(count)||count>MAX_AUTHORED_DECALS+MAX_RUNTIME_DECALS)throw new RangeError('GPU 贴花实例长度或容量非法');
    if(!count)return 0;
    if(data.byteLength>this.capacity){this.clear();this.capacity=2**Math.ceil(Math.log2(Math.max(4096,data.byteLength)));
      this.buffer=this.device.createBuffer({label:'procedural-decal-instances',size:this.capacity,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      this.group=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.frame}},{binding:1,resource:{buffer:this.buffer}}]});
    }
    this.device.queue.writeBuffer(this.buffer!,0,data);pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group!);pass.draw(6,count);this.draws=1;this.count=count;return 1;
  }
  snapshot(){return {instances:this.count,drawCalls:this.draws,bufferBytes:this.capacity};}
  clear():void {this.buffer?.destroy();this.buffer=null;this.group=null;this.capacity=0;this.count=0;this.draws=0;}
}
