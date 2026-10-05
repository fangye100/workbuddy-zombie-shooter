/** Cheap grounded silhouettes for a stylized crowd. No shadow-map or static object slots. */
const SHADER = /* wgsl */ `
struct Frame { vp:mat4x4f, color:vec4f };
struct Contact { center:vec4f, radii:vec4f };
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> contacts:array<Contact>;
struct V { @builtin(position) position:vec4f, @location(0) uv:vec2f };
struct F { @location(0) color:vec4f, @location(1) aux:vec4f };
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->V {
  let points=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let p=points[vi]; let c=contacts[ii]; let offset=p*c.radii.xy;
  let cs=cos(c.center.w); let sn=sin(c.center.w);
  var v:V; v.position=frame.vp*vec4f(c.center.xyz+vec3f(offset.x*cs+offset.y*sn,0,-offset.x*sn+offset.y*cs),1);v.uv=p;return v;
}
@fragment fn fs(v:V)->F {
  let distance=dot(v.uv,v.uv); let alpha=(1.0-smoothstep(0.15,1.0,distance))*frame.color.a;
  var o:F;o.color=vec4f(frame.color.rgb,alpha);o.aux=vec4f(0);return o;
}`;

export class ContactShadowPass {
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPURenderPipeline;
  private instances:GPUBuffer|null=null;
  private group:GPUBindGroup|null=null;
  private capacity=0;
  private readonly frame=new Float32Array(20);
  constructor(private readonly device:GPUDevice,hdr:GPUTextureFormat,depth:GPUTextureFormat) {
    this.uniform=device.createBuffer({label:'contact-shadow-frame',size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const module=device.createShaderModule({label:'contact-shadows',code:SHADER});
    this.pipeline=device.createRenderPipeline({label:'contact-shadows',layout:'auto',vertex:{module,entryPoint:'vs'},
      fragment:{module,entryPoint:'fs',targets:[{format:hdr,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}},{format:hdr,writeMask:0}]},
      primitive:{topology:'triangle-list'},depthStencil:{format:depth,depthWriteEnabled:false,depthCompare:'less-equal'},
    });
  }
  draw(pass:GPURenderPassEncoder,data:Float32Array<ArrayBuffer>,vp:Float32Array,color:readonly number[],opacity:number):number {
    if (!data.length || opacity<=0) return 0;
    if (this.capacity<data.byteLength) {
      this.clear();this.capacity=Math.max(4096,data.byteLength);
      this.instances=this.device.createBuffer({label:'contact-shadow-instances',size:this.capacity,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      this.group=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.instances}}]});
    }
    this.frame.set(vp);this.frame.set([color[0]!,color[1]!,color[2]!,opacity],16);
    this.device.queue.writeBuffer(this.uniform,0,this.frame);this.device.queue.writeBuffer(this.instances!,0,data);
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group!);pass.draw(6,data.length/8);return 1;
  }
  clear():void { this.instances?.destroy();this.instances=null;this.group=null;this.capacity=0; }
  destroy():void {this.clear();this.uniform.destroy();}
}
