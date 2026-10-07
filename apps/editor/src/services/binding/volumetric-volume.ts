/** Geometry-only adaptive solid volume. No DOM/GPU and no mutation of author geometry.
 * Generalized winding numbers classify interiors; a conservative surface band retains
 * thin/open parts. Boundary cells refine locally, while the interior stays coarse.
 */
type P = [number, number, number];
interface Triangle { a: P; b: P; c: P; center: P; area: P }
interface Node { lo: P; hi: P; center: P; area: P; radius: number; children: Node[]; triangles: Triangle[] }
export interface VolumeCell { x: number; y: number; z: number; size: number; center: P }
export interface SolidVolume {
  cells: VolumeCell[];
  neighbors: Array<Map<number, number>>;
  cellSize: number;
  coarseCellSize: number;
  refinedCells: number;
  surfaceOnlyCells: number;
  find: (p: readonly [number, number, number]) => number;
}
const dot = (a: P, b: P): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub = (a: P, b: P): P => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a: P, b: P): P => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
function buildTree(triangles: Triangle[]): Node {
  const lo: P = [Infinity,Infinity,Infinity], hi: P = [-Infinity,-Infinity,-Infinity];
  const area: P = [0,0,0];
  for (const t of triangles) for (let k=0;k<3;k++) {
    lo[k] = Math.min(lo[k]!,t.a[k]!,t.b[k]!,t.c[k]!);
    hi[k] = Math.max(hi[k]!,t.a[k]!,t.b[k]!,t.c[k]!);
    area[k] = area[k]!+t.area[k]!;
  }
  const center: P = [(lo[0]+hi[0])/2,(lo[1]+hi[1])/2,(lo[2]+hi[2])/2];
  const n: Node = {lo,hi,center,area,radius: Math.hypot(...sub(hi,lo))/2,children:[],triangles:[]};
  if (triangles.length<=12) n.triangles=triangles;
  else {
    const ext=sub(hi,lo), axis=ext[0]>=ext[1] && ext[0]>=ext[2]?0:ext[1]>=ext[2]?1:2;
    triangles.sort((a,b)=>a.center[axis]!-b.center[axis]!);
    const m=triangles.length>>1;
    n.children=[buildTree(triangles.slice(0,m)),buildTree(triangles.slice(m))];
  }
  return n;
}
function solidAngle(p: P, t: Triangle): number {
  const a=sub(t.a,p),b=sub(t.b,p),c=sub(t.c,p);
  const la=Math.hypot(...a),lb=Math.hypot(...b),lc=Math.hypot(...c);
  return 2*Math.atan2(dot(a,cross(b,c)),la*lb*lc+dot(a,b)*lc+dot(b,c)*la+dot(c,a)*lb);
}
function winding(p: P, node: Node, precision=3): number {
  const r=sub(node.center,p),d=Math.hypot(...r);
  // Far-field dipole approximation; descend near the surface where classification matters.
  if (node.children.length && d>node.radius*precision) return dot(node.area,r)/(d*d*d);
  if (!node.children.length) return node.triangles.reduce((s,t)=>s+solidAngle(p,t),0);
  return winding(p,node.children[0]!,precision)+winding(p,node.children[1]!,precision);
}
function boxDistance2(p: P, n: Node): number {
  let d=0;
  for(let k=0;k<3;k++){const v=Math.max(n.lo[k]!-p[k]!,0,p[k]!-n.hi[k]!);d+=v*v;}
  return d;
}
// Closest point on triangle (Voronoi regions), including edge/vertex regions.
function triangleDistance2(p: P, t: Triangle): number {
  const ab=sub(t.b,t.a),ac=sub(t.c,t.a),ap=sub(p,t.a),d1=dot(ab,ap),d2=dot(ac,ap);
  if(d1<=0&&d2<=0)return dot(ap,ap);
  const bp=sub(p,t.b),d3=dot(ab,bp),d4=dot(ac,bp);
  if(d3>=0&&d4<=d3)return dot(bp,bp);
  const vc=d1*d4-d3*d2;
  if(vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);const q=sub(ap,[ab[0]*v,ab[1]*v,ab[2]*v]);return dot(q,q);}
  const cp=sub(p,t.c),d5=dot(ab,cp),d6=dot(ac,cp);
  if(d6>=0&&d5<=d6)return dot(cp,cp);
  const vb=d5*d2-d1*d6;
  if(vb<=0&&d2>=0&&d6<=0){const v=d2/(d2-d6);const q=sub(ap,[ac[0]*v,ac[1]*v,ac[2]*v]);return dot(q,q);}
  const va=d3*d6-d5*d4;
  if(va<=0&&d4-d3>=0&&d5-d6>=0){const bc=sub(t.c,t.b),v=(d4-d3)/(d4-d3+d5-d6);const q=sub(bp,[bc[0]*v,bc[1]*v,bc[2]*v]);return dot(q,q);}
  const normal=cross(ab,ac),dist=dot(ap,normal);
  return dist*dist/dot(normal,normal);
}
function nearest2(p: P, node: Node, best=Infinity): number {
  if(boxDistance2(p,node)>best)return best;
  if(!node.children.length){for(const t of node.triangles)best=Math.min(best,triangleDistance2(p,t));return best;}
  const [a,b]=node.children as [Node,Node];
  const first=boxDistance2(p,a)<boxDistance2(p,b)?a:b,second=first===a?b:a;
  return nearest2(p,second,nearest2(p,first,best));
}

export function buildSolidVolume(vertices: Float32Array, stride: number, indices: Uint32Array,
  resolution: number, depth: number, maxCells=180000): SolidVolume {
  if(stride<3||vertices.length%stride||!vertices.length||indices.length%3)throw new Error('体积蒙皮：无效网格布局');
  const lo: P=[Infinity,Infinity,Infinity],hi: P=[-Infinity,-Infinity,-Infinity];
  const point=(i:number):P=>[vertices[i*stride]!,vertices[i*stride+1]!,vertices[i*stride+2]!];
  for(let i=0;i<vertices.length/stride;i++)for(let k=0;k<3;k++){
    const v=vertices[i*stride+k]!;if(!Number.isFinite(v))throw new Error('体积蒙皮：顶点包含非有限数');
    lo[k]=Math.min(lo[k]!,v);hi[k]=Math.max(hi[k]!,v);
  }
  const triangles:Triangle[]=[];
  for(let i=0;i<indices.length;i+=3){
    const ids=[indices[i]!,indices[i+1]!,indices[i+2]!];
    if(ids.some(x=>x>=vertices.length/stride))throw new Error('体积蒙皮：三角形索引越界');
    const [a,b,c]=ids.map(point) as [P,P,P],normal=cross(sub(b,a),sub(c,a));
    if(dot(normal,normal)<1e-20)continue;
    triangles.push({a,b,c,center:[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3,(a[2]+b[2]+c[2])/3],area:[normal[0]/2,normal[1]/2,normal[2]/2]});
  }
  const extent=Math.max(...sub(hi,lo));
  if(!triangles.length||extent<1e-8)throw new Error('体积蒙皮：网格没有有效表面');
  const tree=buildTree(triangles),coarse=extent/resolution,unit=coarse/(1<<depth),factor=1<<depth;
  const origin: P=[lo[0]-coarse,lo[1]-coarse,lo[2]-coarse];
  const dims=sub(hi,lo).map(x=>Math.ceil(x/coarse)+2);
  const cells:VolumeCell[]=[],maps=Array.from({length:depth+1},()=>new Map<string,number>());
  let refinedCells=0,surfaceOnlyCells=0;
  const key=(x:number,y:number,z:number):string=>`${x},${y},${z}`;
  function visit(x:number,y:number,z:number,size:number,level:number):void{
    const p:P=[origin[0]+(x+size/2)*unit,origin[1]+(y+size/2)*unit,origin[2]+(z+size/2)*unit];
    const h=size*unit,d2=nearest2(p,tree),near=d2<=h*h*.76;
    let angle=Math.abs(winding(p,tree));
    // Tighten the approximation around the inside/outside decision threshold.
    if(angle>1.5*Math.PI&&angle<2.5*Math.PI)angle=Math.abs(winding(p,tree,8));
    const inside=angle>2*Math.PI;
    if(!inside&&!near)return;
    // Refine the boundary, where coarse cells can join unrelated nearby surfaces.
    if(near&&level<depth){refinedCells++;const half=size/2;
      for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++)visit(x+dx*half,y+dy*half,z+dz*half,half,level+1);
      return;
    }
    if(!inside&&d2>h*h*.26)return; // conservative ~half-cell shell; no whole-grid dilation
    if(cells.length>=maxCells)throw new Error(`体积蒙皮：体素超过 ${maxCells} 上限，请降低分辨率或细分深度`);
    if(!inside)surfaceOnlyCells++;
    maps[level]!.set(key(x,y,z),cells.length);cells.push({x,y,z,size,center:p});
  }
  for(let z=0;z<dims[2]!;z++)for(let y=0;y<dims[1]!;y++)for(let x=0;x<dims[0]!;x++)visit(x*factor,y*factor,z*factor,factor,0);
  if(!cells.length)throw new Error('体积蒙皮：没有生成有效体素');
  function lookup(x:number,y:number,z:number):number{
    if(x<0||y<0||z<0||x>=dims[0]!*factor||y>=dims[1]!*factor||z>=dims[2]!*factor)return -1;
    for(let level=0;level<=depth;level++){
      const s=factor>>level,id=maps[level]!.get(key(Math.floor(x/s)*s,Math.floor(y/s)*s,Math.floor(z/s)*s));
      if(id!==undefined)return id;
    }return -1;
  }
  const neighbors=cells.map(()=>new Map<number,number>());
  // Face-area / center-distance conductance gives symmetric finite-volume diffusion
  // across coarse/fine interfaces. Sampling finest face tiles also handles 4:1 neighbors.
  for(let i=0;i<cells.length;i++){
    const c=cells[i]!,xyz=[c.x,c.y,c.z];
    for(let axis=0;axis<3;axis++){
      const a=(axis+1)%3,b=(axis+2)%3,faces=new Map<number,number>();
      for(let u=0;u<c.size;u++)for(let v=0;v<c.size;v++){
        const q=[...xyz];q[axis]=xyz[axis]!+c.size;q[a]=xyz[a]!+u+.5;q[b]=xyz[b]!+v+.5;
        const j=lookup(q[0]!,q[1]!,q[2]!);if(j>=0&&j!==i)faces.set(j,(faces.get(j)??0)+1);
      }
      for(const [j,tiles]of faces){const w=tiles*unit*2/(c.size+cells[j]!.size);
        neighbors[i]!.set(j,w);neighbors[j]!.set(i,w);
      }
    }
  }
  const find=(pos:readonly [number,number,number]):number=>{
    const p:P=[...pos];
    const q:P=[(p[0]-origin[0])/unit,(p[1]-origin[1])/unit,(p[2]-origin[2])/unit];
    const direct=lookup(...q);if(direct>=0)return direct;
    let best=-1,dist=Infinity;
    // Bound snapping to one coarse cell; disconnected parts are never bridged in the graph.
    for(let z=-factor;z<=factor;z++)for(let y=-factor;y<=factor;y++)for(let x=-factor;x<=factor;x++){
      const i=lookup(q[0]+x,q[1]+y,q[2]+z);if(i<0)continue;
      const d=dot(sub(cells[i]!.center,p),sub(cells[i]!.center,p));if(d<dist){dist=d;best=i;}
    }return best;
  };
  return {cells,neighbors,cellSize:unit,coarseCellSize:coarse,refinedCells,surfaceOnlyCells,find};
}
