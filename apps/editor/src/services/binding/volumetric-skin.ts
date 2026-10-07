/** Adaptive finite-volume bone-weight diffusion, CPU reference solver shared by MCP
 * and the browser Worker. Independently implemented; no commercial addon dependency.
 * The SPD screened Laplacian is solved by preconditioned conjugate gradients, rather
 * than turning shortest-path distances into weights. Output is normalized top-4 LBS.
 */
import { boneSegments, type JointPositions, type SkinWeights } from './binding-math';
import { isTipBone, type Vec3 } from './humanik-template';
import { buildSolidVolume } from './volumetric-volume';

export interface VolumetricOptions {
  resolution: number;
  depth: number;
  /** Relative residual tolerance; maximum iterations remains bounded. */
  tolerance: number;
}
export const DEFAULT_VOLUMETRIC_OPTIONS: Readonly<VolumetricOptions> = {resolution:48,depth:1,tolerance:0.001};
export interface VolumetricStats {
  algorithm: 'adaptive-volume-diffusion-v1' | 'adaptive-volume-diffusion-v2';
  cells: number;
  refinedCells: number;
  cellSize: number;
  components: number;
  unseededComponents: number;
  outsideBones: string[];
  projectedBones?: {bone:string;distance:number}[];
  fallbackVertices: number;
  surfaceOnlyCells: number;
  maxResidual: number;
  maxIterations: number;
  converged: boolean;
  elapsedMs: number;
}
export interface VolumetricResult { skin: SkinWeights; volumetric: VolumetricStats }
export function validateVolumetricOptions(o: VolumetricOptions): void {
  if(!Number.isInteger(o.resolution)||o.resolution<16||o.resolution>96||
    !Number.isInteger(o.depth)||o.depth<0||o.depth>2||
    !Number.isFinite(o.tolerance)||o.tolerance<0.0001||o.tolerance>0.01)
    throw new Error('体积蒙皮参数：resolution 必须为 16..96，depth 为 0..2，tolerance 为 0.0001..0.01');
}
function distance(p: Vec3,a: Vec3,b: Vec3):number{
  const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2],den=dx*dx+dy*dy+dz*dz;
  const t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy+(p[2]-a[2])*dz)/den)):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy,p[2]-a[2]-t*dz);
}
export function computeVolumetricWeights(vertices:Float32Array,stride:number,indices:Uint32Array,
  placed:JointPositions,options:VolumetricOptions=DEFAULT_VOLUMETRIC_OPTIONS):VolumetricResult{
  validateVolumetricOptions(options);
  const start=performance.now(),segs=boneSegments(placed).map((s,index)=>({...s,index})).filter(s=>!isTipBone(s.bone));
  if(segs.some(s=>[...s.a,...s.b].some(x=>!Number.isFinite(x))))throw new Error('体积蒙皮：骨骼坐标无效');
  const volume=buildSolidVolume(vertices,stride,indices,options.resolution,options.depth);
  const {cells,neighbors}=volume,N=cells.length,B=segs.length;
  const stats:VolumetricStats={algorithm:'adaptive-volume-diffusion-v2',cells:N,refinedCells:volume.refinedCells,
    cellSize:volume.cellSize,components:0,unseededComponents:0,outsideBones:[],fallbackVertices:0,
    surfaceOnlyCells:volume.surfaceOnlyCells,maxResidual:0,maxIterations:0,converged:true,elapsedMs:0};
  // Bone-axis seeds. Restrict snapping so an exterior bone cannot pull an entire remote part.
  const seedSources=cells.map(()=>new Set<number>()),seedCounts=new Uint32Array(B);
  for(let b=0;b<B;b++){
    const s=segs[b]!,length=Math.hypot(s.b[0]-s.a[0],s.b[1]-s.a[1],s.b[2]-s.a[2]);
    const steps=Math.max(1,Math.ceil(length/(volume.cellSize*.5)));
    for(let j=0;j<=steps;j++){
      const p:Vec3=[s.a[0]+(s.b[0]-s.a[0])*j/steps,s.a[1]+(s.b[1]-s.a[1])*j/steps,s.a[2]+(s.b[2]-s.a[2])*j/steps];
      const i=volume.find(p);if(i<0)continue;
      const c=cells[i]!,limit=c.size*volume.cellSize*.9;
      if(distance(c.center,s.a,s.b)>limit)continue;
      if(!seedSources[i]!.has(b)){seedSources[i]!.add(b);seedCounts[b]=seedCounts[b]!+1;}
    }
    if(!seedCounts[b]){
      // Thin/open generated legs may surround an empty volume cell. Permit a
      // bounded projection to nearby surface volume, with an explicit diagnostic.
      // Distant bones stay invalid; no joint or volume connectivity is modified.
      let best=-1,nearest=Infinity;
      for(let i=0;i<N;i++){const d=distance(cells[i]!.center,s.a,s.b);if(d<nearest){nearest=d;best=i;}}
      const limit=Math.min(.12,length*.25,volume.coarseCellSize*2);
      if(best>=0&&nearest<=limit){seedSources[best]!.add(b);seedCounts[b]=1;(stats.projectedBones??=[]).push({bone:s.bone,distance:nearest});}
      else stats.outsideBones.push(s.bone);
    }
  }
  // A disconnected unseeded accessory has no harmonic boundary data. Anchor its
  // nearest cell/bone explicitly and report it, instead of silent distance fallback.
  const visited=new Uint8Array(N),queue=new Int32Array(N);
  for(let root=0;root<N;root++)if(!visited[root]){
    stats.components++;let head=0,tail=1,hasSeed=false,bestCell=root,bestBone=0,bestDist=Infinity;
    queue[0]=root;visited[root]=1;
    while(head<tail){const i=queue[head++]!;if(seedSources[i]!.size)hasSeed=true;
      for(let b=0;b<B;b++){const d=distance(cells[i]!.center,segs[b]!.a,segs[b]!.b);if(d<bestDist){bestDist=d;bestCell=i;bestBone=b;}}
      for(const j of neighbors[i]!.keys())if(!visited[j]){visited[j]=1;queue[tail++]=j;}
    }
    if(!hasSeed){stats.unseededComponents++;seedSources[bestCell]!.add(bestBone);}
  }
  // CSR graph, area/distance conductance. Source penalty acts only at bone seeds.
  const offsets=new Uint32Array(N+1);let edgeCount=0;
  for(let i=0;i<N;i++){offsets[i]=edgeCount;edgeCount+=neighbors[i]!.size;}offsets[N]=edgeCount;
  const ids=new Uint32Array(edgeCount),conductance=new Float32Array(edgeCount),diagonal=new Float64Array(N),penalty=new Float64Array(N);
  for(let i=0;i<N;i++){let k=offsets[i]!;for(const[j,w]of neighbors[i]!){ids[k]=j;conductance[k++]=w;diagonal[i]=diagonal[i]!+w;}
    if(seedSources[i]!.size){penalty[i]=Math.max(diagonal[i]!,cells[i]!.size*volume.cellSize)*8;diagonal[i]=diagonal[i]!+penalty[i]!;}
  }
  const fields:Float32Array[]=[],x=new Float64Array(N),r=new Float64Array(N),p=new Float64Array(N),ap=new Float64Array(N),rhs=new Float64Array(N);
  function multiply(v:Float64Array,out:Float64Array):void{
    for(let i=0;i<N;i++){let value=diagonal[i]!*v[i]!;for(let k=offsets[i]!;k<offsets[i+1]!;k++)value-=conductance[k]!*v[ids[k]!]!;out[i]=value;}
  }
  for(let b=0;b<B;b++){
    let norm=0,rz=0;x.fill(0);
    for(let i=0;i<N;i++){rhs[i]=seedSources[i]!.has(b)?penalty[i]!/seedSources[i]!.size:0;r[i]=rhs[i]!;
      p[i]=r[i]!/diagonal[i]!;norm+=rhs[i]!*rhs[i]!;rz+=r[i]!*p[i]!;}
    let iteration=0,residual=norm?1:0;
    for(;norm>0&&residual>options.tolerance&&iteration<240;iteration++){
      multiply(p,ap);let pap=0;for(let i=0;i<N;i++)pap+=p[i]!*ap[i]!;
      if(pap<=0||!Number.isFinite(pap))throw new Error('体积蒙皮：扩散求解器失去正定性');
      const alpha=rz/pap;let nextRz=0,rr=0;
      for(let i=0;i<N;i++){x[i]=x[i]!+alpha*p[i]!;r[i]=r[i]!-alpha*ap[i]!;rr+=r[i]!*r[i]!;nextRz+=r[i]!*r[i]!/diagonal[i]!;}
      residual=Math.sqrt(rr/norm);const beta=nextRz/rz;
      for(let i=0;i<N;i++)p[i]=r[i]!/diagonal[i]!+beta*p[i]!;rz=nextRz;
    }
    stats.maxResidual=Math.max(stats.maxResidual,residual);stats.maxIterations=Math.max(stats.maxIterations,iteration);
    if(residual>options.tolerance)stats.converged=false;
    fields.push(Float32Array.from(x,value=>Math.max(0,value)));
  }
  const count=vertices.length/stride,joints=new Uint16Array(count*4),weights=new Float32Array(count*4);
  for(let v=0;v<count;v++){
    const pos:Vec3=[vertices[v*stride]!,vertices[v*stride+1]!,vertices[v*stride+2]!],cell=volume.find(pos);
    const rank:Array<{bone:number;weight:number}>=[];
    for(let b=0;b<B;b++){
      let weight=0;
      if(cell>=0){
        // Cell-centered sampling plus neighboring cells softens quantization while
        // staying inside the connected solid; no surface-adjacency shortcuts.
        const c=cells[cell]!,d=distance(pos,c.center,c.center),own=1/(d+volume.cellSize*.25);
        let sum=own;weight=fields[b]![cell]!*own;
        for(const j of neighbors[cell]!.keys()){const q=cells[j]!,w=1/(distance(pos,q.center,q.center)+volume.cellSize*.25);
          weight+=fields[b]![j]!*w;sum+=w;}
        weight/=sum;
      }
      rank.push({bone:segs[b]!.index,weight});
    }
    rank.sort((a,b)=>b.weight-a.weight);let sum=rank.slice(0,4).reduce((s,q)=>s+q.weight,0);
    if(sum<1e-12){stats.fallbackVertices++;let best=0,d=Infinity;
      for(let b=0;b<B;b++){const next=distance(pos,segs[b]!.a,segs[b]!.b);if(next<d){d=next;best=b;}}
      joints[v*4]=segs[best]!.index;weights[v*4]=1;continue;
    }
    for(let k=0;k<4;k++){joints[v*4+k]=rank[k]!.bone;weights[v*4+k]=rank[k]!.weight/sum;}
  }
  stats.elapsedMs=performance.now()-start;return {skin:{joints,weights},volumetric:stats};
}
