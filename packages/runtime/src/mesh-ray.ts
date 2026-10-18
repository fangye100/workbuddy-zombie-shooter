import {invert,rayAabb,rayTri,type Mat4} from '@aether/core';
type Point=[number,number,number];
export interface MeshRayInput {vertices:Float32Array;indices:Uint32Array|Uint16Array;matrix:Mat4;min:[number,number,number];max:[number,number,number];ranges:readonly {visible:boolean;indexStart:number;indexCount:number}[]}
/** 与渲染使用同一可见三角形；距离以世界单位返回，支持非均匀缩放与层级矩阵。 */
export function rayVisibleMesh(mesh:MeshRayInput,from:Point,direction:Point,range:number):{point:Point;normal:Point;distance:number}|null {
  const m=invert(new Float32Array(16),mesh.matrix);
  const apply=(p:Point,w:number):Point=>[m[0]!*p[0]+m[4]!*p[1]+m[8]!*p[2]+w*m[12]!,m[1]!*p[0]+m[5]!*p[1]+m[9]!*p[2]+w*m[13]!,m[2]!*p[0]+m[6]!*p[1]+m[10]!*p[2]+w*m[14]!];
  const o=apply(from,1),d=apply(direction,0);if(![...o,...d].every(Number.isFinite)||Math.hypot(...d)<1e-8)return null;
  const inside=o.every((v,i)=>v>=mesh.min[i]!&&v<=mesh.max[i]!);
  const bound=rayAabb(...o,...d,mesh.min,mesh.max);if(!inside&&(bound<0||bound>range))return null;
  let distance=range+1e-6,normal:Point|null=null;
  const vertex=(i:number):Point=>[mesh.vertices[i*15]!,mesh.vertices[i*15+1]!,mesh.vertices[i*15+2]!];
  for(const sm of mesh.ranges){if(!sm.visible)continue;const end=Math.min(mesh.indices.length,sm.indexStart+sm.indexCount);
    for(let i=sm.indexStart;i+2<end;i+=3){const a=vertex(mesh.indices[i]!),b=vertex(mesh.indices[i+1]!),c=vertex(mesh.indices[i+2]!);
      const t=rayTri(...o,...d,...a,...b,...c);if(t<0||t>=distance)continue;
      const u=b.map((v,i)=>v-a[i]!),v=c.map((v,i)=>v-a[i]!);const n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];
      const world:Point=[m[0]!*n[0]!+m[1]!*n[1]!+m[2]!*n[2]!,m[4]!*n[0]!+m[5]!*n[1]!+m[6]!*n[2]!,m[8]!*n[0]!+m[9]!*n[1]!+m[10]!*n[2]!],length=Math.hypot(...world);if(length<1e-8)continue;
      const sign=world.reduce((sum,v,i)=>sum+v*direction[i]!,0)>0?-1:1;
      normal=world.map(v=>v/length*sign) as Point;distance=t;
    }
  }
  return normal?{distance,point:from.map((v,i)=>v+direction[i]!*distance) as Point,normal}:null;
}
