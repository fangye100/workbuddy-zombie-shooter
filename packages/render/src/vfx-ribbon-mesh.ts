import type {RibbonTrail} from '@aether/runtime';
import {sampleVfxVisual} from './vfx-visual';
export interface RibbonSegment {firstIndex:number;indexCount:number;depth:number;texture:string;blend:'alpha'|'additive';key:string}
const unit=(a:readonly number[])=>{const l=Math.hypot(...a);return l>1e-8?a.map(v=>v/l):[1,0,0];};
const cross=(a:readonly number[],b:readonly number[])=>[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];
/** Two vertices per sample. Adjacent indexed triangles truly share the joint edge. */
export function buildRibbonMesh(trails:readonly RibbonTrail[],eye:readonly number[],view:Float32Array,capacity=2048){
 const vertices:number[]=[],indices:number[]=[],segments:RibbonSegment[]=[];let dropped=0,degenerate=0;
 for(const trail of trails){const e=trail.effect,config=e.ribbon;if(!config)continue;const points=trail.points.slice(0,Math.max(0,capacity-vertices.length/18));dropped+=trail.points.length-points.length;const start=vertices.length/9;let phaseBase=0;
  for(let i=0;i<points.length;i++){const p=points[i]!,previous=i>0 && !p.breakBefore?points[i-1]:undefined,next=points[i+1] && !points[i+1]!.breakBefore?points[i+1]:undefined;
   let tangent=(next?.position??p.position).map((v,k)=>v-(previous?.position??p.position)[k]!);if(Math.hypot(...tangent)<1e-8)tangent=next?next.position.map((v,k)=>v-p.position[k]!):p.position.map((v,k)=>v-(previous?.position??p.position)[k]!);tangent=unit(tangent);
   let side=cross(tangent,eye.map((v,k)=>v-p.position[k]!));if(Math.hypot(...side)<1e-8)side=cross(tangent,Math.abs(tangent[1]!)<.9?[0,1,0]:[1,0,0]);side=unit(side);
   let miter=1;if(previous && next){const edgeSide=cross(unit(next.position.map((v,k)=>v-p.position[k]!)),eye.map((v,k)=>v-p.position[k]!));if(Math.hypot(...edgeSide)>1e-8){const n=unit(edgeSide);miter=Math.min(2,1/Math.max(.5,Math.abs(side.reduce((s,v,k)=>s+v*n[k]!,0))));}}
   const visual=sampleVfxVisual({key:trail.key,effect:e,position:p.position,age:p.age,seed:0,priority:0}),width=e.size[0]*visual.size*.5*miter,alpha=Math.max(0,1-p.age/e.duration)*visual.alpha;
   if(i===0 || p.breakBefore)phaseBase=Math.floor(p.distance/config.uvMetersPerTile)*config.uvMetersPerTile;const u=(p.distance-phaseBase)/config.uvMetersPerTile;
   for(const sign of [-1,1])vertices.push(...p.position.map((v,k)=>v+side[k]!*width*sign),u,sign===-1?0:1,...visual.color,alpha);
   if(previous){if(Math.hypot(...p.position.map((v,k)=>v-previous.position[k]!))<1e-8){degenerate++;continue;}const b=start+i*2,a=b-2,firstIndex=indices.length;indices.push(a,a+1,b,a+1,b+1,b);const center=p.position.map((v,k)=>(v+previous.position[k]!)/2),depth=view[2]!*center[0]!+view[6]!*center[1]!+view[10]!*center[2]!+view[14]!;segments.push({firstIndex,indexCount:6,depth,texture:e.texture.guid,blend:e.blend,key:trail.key});}
  }
 }
 return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices),segments,dropped,degenerate};
}
