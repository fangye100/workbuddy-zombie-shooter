/** 一组最多1024项；并行前缀和保持 CPU 透明排序，不用原子 append 重排。 */
export const DECAL_INDIRECT_WGSL=/* wgsl */`
struct Frame {vp:mat4x4f};
struct Mark {center:vec4f,axisU:vec4f,axisV:vec4f,color:vec4f,style:vec4f};
struct Settings {count:u32,padded:u32,_a:u32,_b:u32};
struct Args {vertices:u32,instances:u32,firstVertex:u32,firstInstance:u32};
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> source:array<Mark>;
@group(0) @binding(2) var<storage,read_write> compacted:array<Mark>;
@group(0) @binding(3) var<storage,read_write> args:Args;
@group(0) @binding(4) var<uniform> settings:Settings;
var<workgroup> flags:array<u32,1024>;
var<workgroup> prefix:array<u32,1024>;
fn visible(m:Mark)->bool {
  if(m.color.a<.002){return false;}
  var left=true;var right=true;var bottom=true;var top=true;var near=true;var far=true;
  for(var j=0u;j<4u;j++){
    let u=select(-1.,1.,(j&1u)!=0u);let v=select(-1.,1.,(j&2u)!=0u);
    let p=frame.vp*vec4f(m.center.xyz+u*m.axisU.xyz+v*m.axisV.xyz,1.);
    left=left&&(p.x < -p.w);right=right&&(p.x > p.w);bottom=bottom&&(p.y < -p.w);top=top&&(p.y > p.w);near=near&&(p.z<0.);far=far&&(p.z>p.w);
  }
  return !(left||right||bottom||top||near||far);
}
@compute @workgroup_size(256) fn compact(@builtin(local_invocation_index) lane:u32){
  for(var part=0u;part<4u;part++){
    let i=lane+part*256u;var flag=0u;
    if(i<settings.count){flag=select(0u,1u,visible(source[i]));}
    flags[i]=flag;prefix[i]=flag;
  }
  workgroupBarrier();
  for(var offset=1u;offset<settings.padded;offset*=2u){
    var next:array<u32,4>;
    for(var part=0u;part<4u;part++){
      let i=lane+part*256u;next[part]=prefix[i];if(i>=offset&&i<settings.padded){next[part]+=prefix[i-offset];}
    }
    workgroupBarrier();
    for(var part=0u;part<4u;part++){let i=lane+part*256u;prefix[i]=next[part];}
    workgroupBarrier();
  }
  for(var part=0u;part<4u;part++){let i=lane+part*256u;if(i<settings.count&&flags[i]!=0u){compacted[prefix[i]-1u]=source[i];}}
  if(lane==0u){args.vertices=6u;args.instances=prefix[settings.padded-1u];args.firstVertex=0u;args.firstInstance=0u;}
}`;
