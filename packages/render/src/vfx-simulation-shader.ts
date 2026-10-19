export const VFX_COMPUTE_SHADER=/* wgsl */`
struct Particle { p:vec4f, v:vec4f, id:vec4u };
struct Parameters { clock:vec4u, timing:vec4f, origin:vec4f, direction:vec4f, acceleration:vec4f, control:vec4u };
struct Counters { spawned:atomic<u32>, dropped:atomic<u32>, expired:atomic<u32>, alive:atomic<u32> };
@group(0) @binding(0) var<storage,read_write> particles:array<Particle>;
@group(0) @binding(1) var<uniform> params:Parameters;
@group(0) @binding(2) var<storage,read_write> counters:Counters;
fn random(v:u32)->u32 {var b=v;b=b^(b<<13u);b=b^(b>>17u);b=b^(b<<5u);return b;}
fn births(t:u32)->u32 {return u32(floor(f32(t+1u)*params.timing.x*params.timing.y+.0001));}
@compute @workgroup_size(64) fn simulate(@builtin(global_invocation_id) invocation:vec3u){
 let slot=invocation.x;let cap=params.clock.z;if(slot>=cap){return;}var particle=particles[slot];
 for(var t=params.clock.x;t<=params.clock.y;t++){
  if(particle.id.z!=0u){particle.p.w+=params.timing.x;
   if(particle.p.w+.000001>=particle.v.w){particle.id.z=0u;atomicSub(&counters.alive,1u);atomicAdd(&counters.expired,1u);}
   else {particle.v=vec4f(particle.v.xyz+params.acceleration.xyz*params.timing.x,particle.v.w);particle.p=vec4f(particle.p.xyz+particle.v.xyz*params.timing.x,particle.p.w);}
  }
  if(params.control.x==0u){continue;}
  var before=0u;if(t>0u){before=births(t-1u);}let last=births(t);
  let first=before+1u+(slot+cap-(before%cap))%cap;
  if(first>last){continue;}let count=(last-first)/cap+1u;let serial=first+(count-1u)*cap;
  atomicAdd(&counters.spawned,count);var dropped=count;
  if(particle.id.z==0u){atomicAdd(&counters.alive,1u);dropped-=1u;}atomicAdd(&counters.dropped,dropped);
  let bits=random(params.clock.w^(serial*0x9e3779b1u));let angle=(f32(bits)/4294967296.-.5)*params.origin.w;let c=cos(angle);let sn=sin(angle);let d=params.direction.xyz;
  particle.p=vec4f(params.origin.xyz,0);particle.v=vec4f(vec3f(d.x*c-d.z*sn,d.y,d.x*sn+d.z*c)*params.timing.w,params.timing.z);particle.id=vec4u(serial,random(bits)%6283u,1u,0u);
 }
 particles[slot]=particle;
}`;

export const VFX_COMPUTE_DRAW_SHADER=/* wgsl */`
struct Particle { p:vec4f, v:vec4f, id:vec4u };
struct Frame { vp:mat4x4f, eye:vec4f };
struct Effect { shape:vec4f, tint:vec4f, textureInfo:vec4f, counts:vec4u, sizes:array<vec4f,8>, alphas:array<vec4f,8>, colors:array<vec4f,8> };
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> particles:array<Particle>;
@group(0) @binding(2) var<uniform> effect:Effect;
@group(0) @binding(3) var image:texture_2d<f32>;
@group(0) @binding(4) var samp:sampler;
struct Out { @builtin(position) pos:vec4f, @location(0) uv:vec2f, @location(1) color:vec4f };
fn scalar(t:f32,alpha:bool)->f32 {
 var count=effect.counts.x;if(alpha){count=effect.counts.y;}
 for(var i=1u;i<count;i++){var a=effect.sizes[i-1u];var b=effect.sizes[i];if(alpha){a=effect.alphas[i-1u];b=effect.alphas[i];}if(t<=b.x){return mix(a.y,b.y,(t-a.x)/(b.x-a.x));}}return 1.;
}
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out {
 let p=particles[ii];var o:Out;o.pos=vec4f(2,2,2,1);o.uv=vec2f(0);o.color=vec4f(0);if(p.id.z==0u){return o;}
 let corners=array<vec2f,6>(vec2f(-.5,-.5),vec2f(.5,-.5),vec2f(.5,.5),vec2f(-.5,-.5),vec2f(.5,.5),vec2f(-.5,.5));let corner=corners[vi];
 let facing=normalize(frame.eye.xyz-p.p.xyz);var axis=vec3f(0,1,0);if(abs(facing.y)>.99){axis=vec3f(1,0,0);}let right=normalize(cross(axis,facing));let up=normalize(cross(facing,right));let angle=f32(p.id.y)/1000.;let r=right*cos(angle)+up*sin(angle);let u=up*cos(angle)-right*sin(angle);
 let t=clamp(p.p.w/p.v.w,0.,1.);let size=scalar(t,false);o.pos=frame.vp*vec4f(p.p.xyz+(r*corner.x*effect.shape.x+u*corner.y*effect.shape.y)*size,1);
 var progress=t;if(effect.textureInfo.z>.5){progress=fract(t);}let index=min(effect.shape.w-1.,floor(progress*effect.shape.w));let x0=index/effect.shape.w+.5/effect.textureInfo.x;let x1=(index+1.)/effect.shape.w-.5/effect.textureInfo.x;
 o.uv=vec2f(mix(x0,x1,corner.x+.5),mix(1.-.5/effect.textureInfo.y,.5/effect.textureInfo.y,corner.y+.5));var color=vec3f(1);
 for(var i=1u;i<effect.counts.z;i++){let a=effect.colors[i-1u];let b=effect.colors[i];if(t<=b.w){color=mix(a.xyz,b.xyz,(t-a.w)/(b.w-a.w));break;}}
 o.color=vec4f(color*effect.tint.xyz,(1.-t)*scalar(t,true));return o;
}
struct Fragment { @location(0) color:vec4f, @location(1) aux:vec4f };
@fragment fn fs(i:Out)->Fragment {let t=textureSample(image,samp,i.uv);let a=t.a*i.color.a;if(a<.003){discard;}var o:Fragment;o.color=vec4f(t.rgb*i.color.rgb*a,a);o.aux=vec4f(0,0,0,a);return o;}
`;
