import {mat4,invert} from '@aether/core';
import type {VfxDecalInstance} from '@aether/runtime';
import {sampleVfxVisual} from './vfx-visual';
export interface VfxDecalReceiver {nodeId:string;layer:number;matrix:Float32Array;vertices:Float32Array;indices:Uint32Array;stride:number;ranges?:readonly {start:number;count:number}[];unsupported?:string}
export interface DecalTriangle {firstIndex:number;indexCount:number;depth:number;texture:string;blend:'alpha'|'additive';key:string;receiver:string;sourceTriangle:number;normal:number[]}
export const DECAL_BUDGET={trianglesPerDecal:2048,verticesPerDecal:8192,totalVertices:32768,totalIndices:98304};
type P=number[];
const sub=(a:P,b:P)=>a.map((v,i)=>v-b[i]!);
const cross=(a:P,b:P)=>[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];
const dot=(a:P,b:P)=>a.reduce((s,v,i)=>s+v*b[i]!,0);
const determinant=(m:Float32Array)=>m[0]!*(m[5]!*m[10]!-m[9]!*m[6]!)-m[4]!*(m[1]!*m[10]!-m[9]!*m[2]!)+m[8]!*(m[1]!*m[6]!-m[5]!*m[2]!);
const point=(m:Float32Array,p:P)=>[0,1,2].map(i=>m[i]!*p[0]!+m[4+i]!*p[1]!+m[8+i]!*p[2]!+m[12+i]!);
const validMatrix=(m:Float32Array)=>m.length===16 && [...m].every(Number.isFinite) && Math.abs(determinant(m))>=1e-10 && m[3]===0 && m[7]===0 && m[11]===0 && m[15]===1;
/** Sutherland–Hodgman clipping in projector-local space; the input is a real receiver triangle. */
function clip(poly:P[],axis:number,sign:number,bound:number){const out:P[]=[];for(let i=0;i<poly.length;i++){const a=poly[i]!,b=poly[(i+1)%poly.length]!,da=bound-sign*a[axis]!,db=bound-sign*b[axis]!;if(da>=-1e-9)out.push(a);if((da>=0)!==(db>=0)){const t=da/(da-db);out.push(a.map((v,k)=>v+(b[k]!-v)*t));}}return out;}
/** Atomic per-projector budgets: never publish a partially clipped old/current decal. */
export function buildDecalMesh(instances:readonly VfxDecalInstance[],receivers:readonly VfxDecalReceiver[],view:Float32Array,budget=DECAL_BUDGET){
 const vertices:number[]=[],indices:number[]=[],triangles:DecalTriangle[]=[],diagnostics:string[]=[];let rejected=0,filtered=0,degenerate=0,candidates=0;
 for(const p of [...instances].sort((a,b)=>b.priority-a.priority || a.epoch-b.epoch)){
  const e=p.effect,d=e.decal;if(e.kind!=='decal' || !d){diagnostics.push(p.key+': 非投影贴花请求');rejected++;continue;}if(!validMatrix(p.matrix)){diagnostics.push(p.key+': 投影矩阵不可逆/非法');rejected++;continue;}
  const inverse=invert(mat4(),new Float32Array(p.matrix)),v:number[]=[],ix:number[]=[],ts:DecalTriangle[]=[];let failure='',count=0;
  const selected:VfxDecalReceiver[]=[];for(const id of p.receivers){const r=receivers.find(r=>r.nodeId===id);if(!r){failure='接收节点未就绪/不可见：'+id;break;}if(r.unsupported){failure=id+': '+r.unsupported;break;}if(!validMatrix(r.matrix)){failure=id+': 接收矩阵不可逆/非法';break;}if(!Number.isInteger(r.layer) || r.layer<0 || r.layer>31){failure=id+': 接收层非法';break;}if(!((p.layerMask>>>r.layer)&1)){filtered++;continue;}if(!Number.isInteger(r.stride) || r.stride<3 || r.vertices.length%r.stride || r.indices.length%3){failure=id+': 接收网格布局非法';break;}const ranges=r.ranges??[{start:0,count:r.indices.length}];if(ranges.some(s=>s.start<0 || s.count<0 || s.start%3 || s.count%3 || s.start+s.count>r.indices.length)){failure=id+': 接收子网格范围非法';break;}count+=ranges.reduce((n,s)=>n+s.count/3,0);if(count>budget.trianglesPerDecal){failure='接收三角形预算超限';break;}selected.push(r);}
  if(failure){diagnostics.push(p.key+': '+failure);rejected++;continue;}candidates+=count;
  const sample=sampleVfxVisual({key:p.key,effect:e,position:[0,0,0],seed:0,priority:p.priority,age:e.loop?p.age%e.duration:p.age}),half=[e.size[0]*sample.size/2,e.size[1]*sample.size/2,d.depth/2],axisNormal=[inverse[2]!,inverse[6]!,inverse[10]!],nl=Math.hypot(...axisNormal);const outward=axisNormal.map(n=>n/nl),minDot=Math.cos(d.maxAngle*Math.PI/180),alpha=sample.alpha*(e.loop?1:Math.max(0,1-p.age/e.duration));
  if(sample.size<1e-8 || alpha<=0)continue;
  outer:for(const r of selected)for(const range of r.ranges??[{start:0,count:r.indices.length}])for(let at=range.start;at<range.start+range.count;at+=3){
   const raw=[0,1,2].map(k=>{const index=r.indices[at+k]!;return Array.from(r.vertices.slice(index*r.stride,index*r.stride+3));});if(raw.some(q=>q.length!==3 || !q.every(Number.isFinite))){failure=r.nodeId+': 接收顶点/索引非法';break outer;}
   const world=raw.map(q=>point(r.matrix,q)),normal=cross(sub(world[1]!,world[0]!),sub(world[2]!,world[0]!)),length=Math.hypot(...normal);if(length<1e-10){degenerate++;continue;}const n=normal.map(x=>x/length*Math.sign(determinant(r.matrix)));if(dot(n,outward)<minDot){filtered++;continue;}
   let poly=world.map(q=>point(inverse,q));for(let axis=0;axis<3;axis++)for(const sign of [-1,1])poly=clip(poly,axis,sign,half[axis]!);if(poly.length<3){filtered++;continue;}
   const base=v.length/9;for(const q of poly){const w=point(p.matrix,q).map((x,i)=>x+n[i]!*d.normalOffset);v.push(...w,q[0]!/(2*half[0]!)+.5,.5-q[1]!/(2*half[1]!),...sample.color,alpha);}
   for(let k=1;k<poly.length-1;k++){if(Math.hypot(...cross(sub(poly[k]!,poly[0]!),sub(poly[k+1]!,poly[0]!)))<1e-10){degenerate++;continue;}const center=[0,1,2].map(i=>(v[base*9+i]!+v[(base+k)*9+i]!+v[(base+k+1)*9+i]!)/3),firstIndex=ix.length;ix.push(base,base+k,base+k+1);ts.push({firstIndex,indexCount:3,depth:view[2]!*center[0]!+view[6]!*center[1]!+view[10]!*center[2]!+view[14]!,texture:e.texture.guid,blend:e.blend,key:p.key,receiver:r.nodeId,sourceTriangle:at/3,normal:n});}
   if(v.length/9>budget.verticesPerDecal || vertices.length/9+v.length/9>budget.totalVertices || indices.length+ix.length>budget.totalIndices){failure='裁切输出顶点/索引预算超限';break outer;}
  }
  if(failure){diagnostics.push(p.key+': '+failure);rejected++;continue;}const base=vertices.length/9,first=indices.length;vertices.push(...v);indices.push(...ix.map(i=>i+base));triangles.push(...ts.map(t=>({...t,firstIndex:t.firstIndex+first})));
 }
 return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices),triangles,diagnostics,rejected,filtered,degenerate,candidates};
}
