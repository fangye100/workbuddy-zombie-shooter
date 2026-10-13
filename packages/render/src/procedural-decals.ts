import {DECAL_INSTANCE_FLOATS,MAX_RUNTIME_DECALS} from './decal-instances';
import {MAX_AUTHORED_DECALS} from '@aether/scene';

export const PROCEDURAL_DECAL_WGSL=/* wgsl */`
struct Frame {vp:mat4x4f};
struct Mark {center:vec4f,axisU:vec4f,axisV:vec4f,color:vec4f,style:vec4f};
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> marks:array<Mark>;
struct V { @builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) @interpolate(flat) color:vec4f,@location(2) @interpolate(flat) info:vec2f,@location(3) @interpolate(flat) style:vec4f };
struct F {@location(0) color:vec4f,@location(1) aux:vec4f};
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->V {
  let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let p=corners[vi];let m=marks[ii];var v:V;
  v.position=frame.vp*vec4f(m.center.xyz+p.x*m.axisU.xyz+p.y*m.axisV.xyz,1);
  v.uv=p;v.color=m.color;v.info=vec2f(m.center.w,m.axisU.w);v.style=m.style;return v;
}
fn hash(n:f32)->f32 {return fract(sin(n*127.1+311.7)*43758.5453);}
fn segment(p:vec2f,a:vec2f,b:vec2f)->f32 {let d=b-a;return length(p-a-d*clamp(dot(p-a,d)/dot(d,d),0.,1.));}
fn turn(p:vec2f,a:f32)->vec2f {let c=cos(a);let s=sin(a);return vec2f(c*p.x-s*p.y,s*p.x+c*p.y);}
fn stroke(p:vec2f,a:vec2f,b:vec2f,wa:f32,wb:f32)->f32 {let d=b-a;let t=clamp(dot(p-a,d)/dot(d,d),0.,1.);return length(p-a-d*t)-mix(wa,wb,t);}
fn border(sdf:f32,e:f32,aa:f32)->f32 {return select(0.,1.-smoothstep(0.,max(e,aa),-sdf),e>0.);}
@fragment fn fs(v:V)->F {
  let p=v.uv/v.style.x;let seed=v.info.y;let r=length(p);let angle=atan2(p.y,p.x);
  let aa=max(max(fwidth(p).x,fwidth(p).y)*.6,.001);let edge=v.style.y;let irregular=v.style.z;let detail=v.style.w;
  var sdf=1.;var ink=0.;var shade=1.;var inkColor=vec3f(.008);
  let noise=(sin(angle*7.+seed)*.08+sin(angle*13.-seed)*.04)*irregular*2.;
  if(v.info.x<.5){
    sdf=r-(.54+noise);
    for(var i=0;i<10;i++){if(f32(i)>3.+detail*7.){break;}let f=f32(i)+seed;let a=hash(f)*6.28318;let center=vec2f(cos(a),sin(a))*(.65+hash(f+7.)*.12);sdf=min(sdf,length(p-center)-(.035+hash(f+3.)*.10));}
    ink=border(sdf,edge,aa);
    let dotUv=fract(p*15.)-.5;let dots=1.-smoothstep(.15,.20,length(dotUv));shade=1.-detail*.35*dots;
  }else if(v.info.x<1.5){
    sdf=r-(.73+noise);shade=.28+.65*smoothstep(.02,.74,r);
    // 可见透明缺口与断笔；不形成一整枚闭合圆章。
    for(var i=0;i<6;i++){let f=f32(i)+seed;let a=hash(f+13.)*6.28318;let c=vec2f(cos(a),sin(a))*(.57+hash(f+5.)*.15);sdf=max(sdf,(.055+detail*.085)*irregular-length(p-c));}
    let brush=.72+.28*sin(p.x*21.+p.y*9.+seed);ink=border(sdf,edge,aa)*step(.25,hash(floor(angle*5.)+seed));shade*=brush;
  }else if(v.info.x<2.5){
    let width=.6+edge*16.;
    let bend=(hash(seed)-.5)*irregular*.6;let joint=vec2f(-.14,bend);
    let elbow=vec2f(-.55,-.3+(hash(seed+1.)-.5)*irregular*.4);
    sdf=min(stroke(p,vec2f(-.85,-.75),elbow,.006*width,.018*width),stroke(p,elbow,joint,.018*width,.026*width));
    let end=vec2f(.48,.25+(hash(seed+2.)-.5)*irregular*.5);
    sdf=min(sdf,min(stroke(p,joint,end,.026*width,.017*width),stroke(p,end,vec2f(.9,.64),.017*width,.005*width)));
    for(var i=0;i<3;i++){if(f32(i)>detail*3.){break;}let f=f32(i)+seed;let a=vec2f(-.3+f32(i)*.3,bend+f32(i)*.1);let b=a+vec2f((hash(f+5.)-.5)*.55,select(-.48,.5,i%2==0));let mid=mix(a,b,.55)+vec2f(irregular*.09,0);sdf=min(sdf,min(stroke(p,a,mid,.014*width,.009*width),stroke(p,mid,b,.009*width,.002*width)));}
    ink=.72;shade=1.25;
  }else if(v.info.x<3.5){
    sdf=max(abs(p.x)-(.9+sin(p.y*24.+seed)*.06*irregular),abs(p.y)-(.72+sin(p.x*19.-seed)*.06*irregular));
    // 斜条警示漆没有矩形黑框；seed 控制破损位置，不是无效旋钮。
    for(var i=0;i<7;i++){if(f32(i)>detail*7.){break;}let f=f32(i)+seed;let c=vec2f((hash(f+21.)-.5)*1.75,select(-.7,.7,i%2==0));sdf=max(sdf,(.035+hash(f+8.)*.085)*irregular-length(p-c));}
    ink=smoothstep(-aa*3.,aa*3.,sin((p.x+p.y)*9.42478))*.95;
  }else if(v.info.x<4.5){
    sdf=r-(.28+noise*.2);
    let rays=4.+round(detail*2.);
    for(var i=0;i<6;i++){if(f32(i)>=rays){break;}let f=f32(i)+seed;let a=f32(i)*6.28318/rays+(hash(f)-.5)*irregular*.4;let direction=vec2f(cos(a),sin(a));let start=direction*.2;let mid=direction*(.37+hash(f+3.)*.07);let end=direction*(.45+hash(f+5.)*.15);sdf=min(sdf,min(stroke(p,start,mid,.018,.009),stroke(p,mid,end,.009,.002)));}
    ink=max(border(sdf,edge,aa)*.7,1.-smoothstep(.11,.17,r));shade=.85+step(.2,r)*.25;
  }else if(v.info.x<5.5){
    sdf=r-(.69+noise);inkColor=v.color.rgb*.2;ink=border(sdf,edge*1.6,aa);shade=.62+.33*smoothstep(.1,.6,r);
    // 2–3 个浅色气泡环；无中心白爆点、不代表伤害范围。
    for(var i=0;i<3;i++){if(f32(i)>=2.+round(detail)){break;}let f=f32(i)+seed;let a=f32(i)*2.399+hash(f)*.4;let c=vec2f(cos(a),sin(a))*(.22+hash(f+4.)*.15);let d=length(p-c);let ring=1.-smoothstep(.008,.008+aa,abs(d-(.07+hash(f+7.)*.035)));shade+=ring*.55;}
  }else if(v.info.x<6.5){
    let a=length((p-vec2f(-.2,-.1))/vec2f(.62,.4))-.88;
    let b=length((p-vec2f(.33,.16))/vec2f(.42,.32))-.86;
    sdf=min(a,b)-noise*.6;shade=.52+detail*.44*step(.18,sin(p.x*(3.+detail*6.)+p.y*2.));ink=border(sdf,edge,aa)*step(.35,hash(floor(angle*6.)+seed));
  }else if(v.info.x<7.5){
    // 5–7 张互相分离的平面纸片，墨线代替文字，不烘焙阴影。
    let count=5.+round(detail*2.);
    for(var i=0;i<7;i++){if(f32(i)>=count){break;}let f=f32(i)+seed;let a=f32(i)*6.28318/count;let c=vec2f(cos(a),sin(a))*(.58+hash(f+2.)*.04);let q=turn(p-c,hash(f)*3.14);
      var d=max(abs(q.x)-.11,abs(q.y)-.16);d=max(d,q.x+q.y-(.21-irregular*.025));
      if(d<sdf){sdf=d;shade=.75+hash(f+3.)*.25;ink=border(d,edge*.4,aa)*.6;
        let lines=step(abs(q.x),.075)*(1.-smoothstep(.004,.004+aa,abs(q.y-.02)));
        ink=max(ink,lines*.6*detail);}
    }
  }else{
    // 4–6 个有清晰角面的砖屑加少量小片；不承担3D瓦砾碰撞/高度。
    let count=4.+round(detail*2.);
    for(var i=0;i<8;i++){let f=f32(i)+seed;let small=f32(i)>=count;let a=f32(i)*2.399+hash(f)*.3;let jitter=(hash(f+9.)-.5)*irregular*.2;let c=vec2f(cos(a),sin(a))*select(.43+jitter,.76,small);let q=turn(p-c,hash(f+2.)*3.14);let radius=select(.145+(hash(f+3.)-.5)*irregular*.1,.045,small);
      let d=max(abs(q.y),abs(q.x)*.866+abs(q.y)*.5)-radius;
      if(d<sdf){sdf=d;shade=.55+hash(f+4.)*.5+step(q.y,0.)*.15;ink=border(d,edge*.6,aa);}
    }
  }
  let alpha=(1.-smoothstep(-aa,aa,sdf))*v.color.a;
  if(alpha<.002){discard;}
  let rgb=mix(v.color.rgb*shade,inkColor,ink);
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
