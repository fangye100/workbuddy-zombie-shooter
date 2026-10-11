/** 三维地表导航：分层采样图共享目标场，连续投影保留真实高度。无游戏/编辑器依赖。 */
import {intervalsPenetrate} from '@aether/core';
export interface NavigationSurface {
  id: string;
  supportCollider?:string;
  /** 世界空间的三个矩形角：原点、宽边终点、深边终点。由场景变换派生。 */
  origin: readonly number[]; u: readonly number[]; v: readonly number[];
}
export interface SurfaceNavigationOptions {
  cellSize: number; maxSlopeDeg: number; maxStepM: number; agentRadius: number; agentHeight: number;
}
export interface SurfacePoint { x: number; y: number; z: number; surface: number }
export interface SurfaceObstacle { id?:string;minX:number;maxX:number;minY:number;maxY:number;minZ:number;maxZ:number }
interface Patch { source:NavigationSurface; ux:number;uy:number;uz:number;vx:number;vy:number;vz:number;det:number; slope:number }
interface Cell extends SurfacePoint { edges:number[];incoming:number[] }

export class SurfaceNavigation {
  private readonly patches:Patch[]=[];
  private readonly cells:Cell[]=[];
  private readonly buckets=new Map<string,number[]>();
  private published:Float64Array;
  private staging:Float64Array;
  private next:Int32Array;
  private stagingNext:Int32Array;
  private heap:{id:number;cost:number}[]=[];
  private active=-1;
  private requested=-1;
  private current=-1;
  private pendingEdge=0;
  private pendingCell=-1;
  private version=0;
  private dynamic:readonly SurfaceObstacle[]=[];
  private blocked=new Uint8Array(0);
  private blockedEdges=new Set<string>();
  private obstacleVersion=0;
  private overlayWork=0;
  workLastStep=0;
  readonly rejectedSurfaces:string[]=[];
  constructor(surfaces:readonly NavigationSurface[],readonly options:SurfaceNavigationOptions,private readonly obstacles:readonly SurfaceObstacle[]=[]) {
    this.options=Object.freeze({...options});
    this.obstacles=obstacles.map(o=>Object.freeze({...o}));
    if(![options.cellSize,options.maxSlopeDeg,options.maxStepM,options.agentRadius,options.agentHeight].every(Number.isFinite)
      ||options.cellSize<=0||options.maxSlopeDeg<=0||options.maxSlopeDeg>=89||options.maxStepM<0||options.agentRadius<=0||options.agentHeight<=0)
      throw new RangeError('三维导航配置非法');
    const cs=options.cellSize;
    const ids=new Set<string>();
    for(const input of surfaces){
      const source={...input,origin:[...input.origin],u:[...input.u],v:[...input.v]};
      if(!source.id||ids.has(source.id))throw new Error('导航面 ID 必须唯一');ids.add(source.id);
      if([...source.origin,...source.u,...source.v].length!==9||![...source.origin,...source.u,...source.v].every(Number.isFinite))throw new RangeError('导航面坐标非法');
      const [ox,oy,oz]=source.origin as [number,number,number];
      const ux=source.u[0]!-ox,uy=source.u[1]!-oy,uz=source.u[2]!-oz;
      const vx=source.v[0]!-ox,vy=source.v[1]!-oy,vz=source.v[2]!-oz,det=ux*vz-uz*vx;
      const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
      const slope=Math.atan2(Math.hypot(nx,nz),Math.abs(ny))*180/Math.PI;
      if(Math.abs(det)<1e-8||slope>options.maxSlopeDeg){this.rejectedSurfaces.push(source.id);continue;}
      const p:Patch={source,ux,uy,uz,vx,vy,vz,det,slope},surface=this.patches.length;this.patches.push(p);
      const width=Math.max(1,Math.ceil(Math.hypot(ux,uz)/cs)),depth=Math.max(1,Math.ceil(Math.hypot(vx,vz)/cs));
      if(this.cells.length+width*depth>262144)throw new RangeError('三维导航采样超过 262144 格');
      for(let b=0;b<depth;b++)for(let a=0;a<width;a++){
        const t=(a+.5)/width,s=(b+.5)/depth;
        const point={x:ox+ux*t+vx*s,y:oy+uy*t+vy*s,z:oz+uz*t+vz*s,surface};
        if(!this.clear(point.x,point.y,point.z,options.agentRadius))continue;
        const id=this.cells.length;this.cells.push({...point,edges:[],incoming:[]});
        const key=this.key(point.x,point.z),bucket=this.buckets.get(key)??[];bucket.push(id);this.buckets.set(key,bucket);
      }
    }
    const supported=this.cells.filter(c=>this.supported(c.x,c.y,c.z,options.agentRadius));
    this.cells.length=0;this.buckets.clear();
    for(const point of supported){const id=this.cells.length;this.cells.push(point);const key=this.key(point.x,point.z),bucket=this.buckets.get(key)??[];bucket.push(id);this.buckets.set(key,bucket);}
    // 只连接可连续步行的邻格；叠层同 XZ 并不构成边。楼梯接缝逐点按台阶高度验算。
    for(let i=0;i<this.cells.length;i++){
      const a=this.cells[i]!;
      for(const j of this.near(a.x,a.z,cs*1.5)){
        if(j===i)continue;const b=this.cells[j]!,distance=Math.hypot(b.x-a.x,b.z-a.z);
        if(distance<1e-6||distance>cs*1.5+1e-6)continue;
        const out={...a};
        if(this.move(a.x,a.y,a.z,b.x,b.z,options.agentRadius,out)
          &&Math.hypot(out.x-b.x,out.y-b.y,out.z-b.z)<1e-4){a.edges.push(j);b.incoming.push(i);}
      }
    }
    const n=this.cells.length;
    this.published=new Float64Array(n).fill(Infinity);this.staging=new Float64Array(n).fill(Infinity);
    this.next=new Int32Array(n).fill(-1);this.stagingNext=new Int32Array(n).fill(-1);
    this.blocked=new Uint8Array(n);
  }
  /** 替换运行障碍快照。仅重测新旧 AABB 周围的格/边；底图和支撑面不会重建。 */
  setDynamicObstacles(obstacles:readonly SurfaceObstacle[]):void {
    const ids=new Set<string>();
    for(const o of obstacles){
      if(!o.id||ids.has(o.id)||![o.minX,o.maxX,o.minY,o.maxY,o.minZ,o.maxZ].every(Number.isFinite)
        ||o.minX>=o.maxX||o.minY>=o.maxY||o.minZ>=o.maxZ)throw new RangeError('动态障碍必须具有唯一 ID 与有限正 AABB');
      ids.add(o.id);
    }
    const old=new Map(this.dynamic.map(o=>[o.id!,o])),next=new Map(obstacles.map(o=>[o.id!,o]));
    const dirty:SurfaceObstacle[]=[];
    for(const id of new Set([...old.keys(),...next.keys()])){
      const a=old.get(id),b=next.get(id);
      if(a&&b&&a.minX===b.minX&&a.maxX===b.maxX&&a.minY===b.minY&&a.maxY===b.maxY&&a.minZ===b.minZ&&a.maxZ===b.maxZ)continue;
      if(a)dirty.push(a);if(b)dirty.push(b);
    }
    this.overlayWork=0;if(!dirty.length)return;
    this.dynamic=obstacles.map(o=>Object.freeze({...o}));this.obstacleVersion++;
    const candidates=new Set<number>(),pad=this.options.agentRadius+this.options.cellSize*1.6;
    for(const o of dirty)for(const i of this.near((o.minX+o.maxX)/2,(o.minZ+o.maxZ)/2,Math.max(o.maxX-o.minX,o.maxZ-o.minZ)/2+pad))candidates.add(i);
    let changed=false;
    for(const i of candidates){
      const a=this.cells[i]!,blocked=this.clearDynamic(a.x,a.y,a.z,this.options.agentRadius)?0:1;this.overlayWork++;
      if(this.blocked[i]!==blocked){this.blocked[i]=blocked;changed=true;}
      for(const j of a.edges){
        const b=this.cells[j]!,key=`${i}:${j}`,out={...a};
        const closed=!this.move(a.x,a.y,a.z,b.x,b.z,this.options.agentRadius,out)||Math.hypot(out.x-b.x,out.y-b.y,out.z-b.z)>1e-4;this.overlayWork++;
        if(closed!==this.blockedEdges.has(key)){changed=true;if(closed)this.blockedEdges.add(key);else this.blockedEdges.delete(key);}
      }
    }
    if(changed){
      // 旧场立即失效；不能在预算重算期间继续沿旧路线撞门。
      this.published.fill(Infinity);this.next.fill(-1);this.current=-1;
      this.active=-1;this.heap.length=0;this.pendingCell=-1;
      if(this.requested>=0)this.begin();
    }
  }
  private clearDynamic(x:number,y:number,z:number,radius:number):boolean {
    return !this.dynamic.some(o=>intervalsPenetrate(o.minY,o.maxY,y+.04,y+this.options.agentHeight-.01)
      &&intervalsPenetrate(o.minX,o.maxX,x-radius,x+radius)&&intervalsPenetrate(o.minZ,o.maxZ,z-radius,z+radius));
  }
  private key(x:number,z:number):string{return `${Math.floor(x/this.options.cellSize)},${Math.floor(z/this.options.cellSize)}`;}
  private *near(x:number,z:number,r:number):Generator<number>{
    const cs=this.options.cellSize;
    const minX=Math.floor((x-r)/cs),maxX=Math.floor((x+r)/cs),minZ=Math.floor((z-r)/cs),maxZ=Math.floor((z+r)/cs);
    // 大障碍/远距离查询不遍历空白世界，也不让超出安全整数的 ++ 形成死循环。
    if(![minX,maxX,minZ,maxZ].every(Number.isSafeInteger)||(maxX-minX+1)*(maxZ-minZ+1)>Math.max(64,this.buckets.size*4)){
      for(const [key,ids] of this.buckets){const [bx,bz]=key.split(',').map(Number);if(bx!>=minX&&bx!<=maxX&&bz!>=minZ&&bz!<=maxZ)yield*ids;}
      return;
    }
    for(let bz=minZ;bz<=maxZ;bz++)for(let bx=minX;bx<=maxX;bx++)
      for(const id of this.buckets.get(`${bx},${bz}`)??[])yield id;
  }
  private height(p:Patch,x:number,z:number):number|null {
    const dx=x-p.source.origin[0]!,dz=z-p.source.origin[2]!;
    const a=(dx*p.vz-dz*p.vx)/p.det,b=(p.ux*dz-p.uz*dx)/p.det;
    if(a < -1e-6||a>1+1e-6||b < -1e-6||b>1+1e-6)return null;
    return p.source.origin[1]!+a*p.uy+b*p.vy;
  }
  private clear(x:number,y:number,z:number,radius:number):boolean{
    return this.clearDynamic(x,y,z,radius)&&!this.obstacles.some(o=>{
      if(!(o.maxY>y+.04 && o.minY<y+this.options.agentHeight-.01
        && x+radius>o.minX && x-radius<o.maxX && z+radius>o.minZ && z-radius<o.maxZ))return false;
      for(const p of this.patches)if(o.id&&p.source.supportCollider===o.id){
        for(let k=0;k<9;k++){
          const angle=k*Math.PI/4,r=k===8?0:radius,h=this.height(p,x+Math.cos(angle)*r,z+Math.sin(angle)*r);
          if(h!==null&&Math.abs(h-y)<=this.options.maxStepM+radius*Math.tan(this.options.maxSlopeDeg*Math.PI/180)+1e-5)return false;
        }
      }
      return true;
    });
  }
  locate(x:number,y:number,z:number,out:SurfacePoint,tolerance=.08):boolean{
    let best=Infinity,found=-1,height=0;
    for(let i=0;i<this.patches.length;i++){
      const h=this.height(this.patches[i]!,x,z);if(h===null)continue;
      const d=Math.abs(h-y);if(d<=tolerance+1e-6&&d<best){best=d;found=i;height=h;}
    }
    if(found<0)return false;out.x=x;out.y=height;out.z=z;out.surface=found;return true;
  }
  private supported(x:number,y:number,z:number,radius:number):boolean{
    if(!this.clear(x,y,z,radius))return false;
    // 保持完整圆盘在可行走面的并集内；相邻面可以共同支撑跨接缝的角色。
    for(let k=0;k<8;k++){
      const angle=k*Math.PI/4,px=x+Math.cos(angle)*radius,pz=z+Math.sin(angle)*radius;
      let found=false;
      for(const p of this.patches){const h=this.height(p,px,pz);if(h!==null&&Math.abs(h-y)<=this.options.maxStepM+radius*Math.tan(this.options.maxSlopeDeg*Math.PI/180)+1e-5){found=true;break;}}
      if(!found)return false;
    }
    return true;
  }
  /** 连续采样，每次最多 0.1m；遇悬崖/台阶/顶棚停止，不投影到其它楼层。 */
  move(x:number,y:number,z:number,toX:number,toZ:number,radius:number,out:SurfacePoint):boolean{
    const p={x,y,z,surface:-1};if(!this.locate(x,y,z,p)||!this.supported(x,p.y,z,radius))return false;
    const distance=Math.hypot(toX-x,toZ-z),steps=Math.ceil(distance/Math.min(.1,this.options.cellSize*.2));
    if(steps>10000)throw new RangeError('三维移动距离超过单步安全上限');
    const q={...p};
    for(let k=1;k<=steps;k++){
      const nx=x+(toX-x)*k/steps,nz=z+(toZ-z)*k/steps;
      const h=this.height(this.patches[p.surface]!,nx,nz);
      const expected=h??p.y,tolerance=this.options.maxStepM+(distance/steps)*Math.tan(this.options.maxSlopeDeg*Math.PI/180);
      if(!this.locate(nx,expected,nz,q,tolerance)||!this.supported(nx,q.y,nz,radius))break;
      p.x=q.x;p.y=q.y;p.z=q.z;p.surface=q.surface;
    }
    Object.assign(out,p);return true;
  }
  private cellAt(x:number,y:number,z:number,radius=this.options.agentRadius):number{
    const point={x,y,z,surface:-1};if(!this.locate(x,y,z,point))return -1;
    let best=Infinity,id=-1;
    for(const i of this.near(x,z,this.options.cellSize*1.5)){
      const c=this.cells[i]!,dy=Math.abs(c.y-y);if(c.surface!==point.surface)continue;
      if(dy>this.options.maxStepM+this.options.cellSize*Math.tan(this.options.maxSlopeDeg*Math.PI/180))continue;
      const d=(x-c.x)**2+(z-c.z)**2+dy*dy;if(d<best){best=d;id=i;}
    }
    // 门边缘的实际站位可能合法，但最近格的中心被保守膨胀阻挡。
    // 在同一面内选择连续可达的开放邻格，不能跨门吸附到对侧。
    if(id>=0&&this.blocked[id]){
      const choices:number[]=[];
      for(const i of this.near(x,z,this.options.cellSize*1.5))if(this.cells[i]!.surface===point.surface&&!this.blocked[i])choices.push(i);
      choices.sort((a,b)=>{const p=this.cells[a]!,q=this.cells[b]!;return (p.x-x)**2+(p.y-y)**2+(p.z-z)**2-((q.x-x)**2+(q.y-y)**2+(q.z-z)**2);});
      id=-1;
      for(const i of choices){const c=this.cells[i]!,out={...point};if(this.move(x,y,z,c.x,c.z,radius,out)&&Math.hypot(out.x-c.x,out.y-c.y,out.z-c.z)<1e-4){id=i;break;}}
    }
    return id;
  }
  private push(id:number,cost:number):void{
    const item={id,cost};let k=this.heap.length;this.heap.push(item);
    while(k>0){const parent=(k-1)>>1;if(this.heap[parent]!.cost<=cost)break;this.heap[k]=this.heap[parent]!;k=parent;}this.heap[k]=item;
  }
  private pop():{id:number;cost:number}{
    const head=this.heap[0]!,tail=this.heap.pop()!;if(!this.heap.length)return head;
    let k=0;while(k*2+1<this.heap.length){let c=k*2+1;if(c+1<this.heap.length&&this.heap[c+1]!.cost<this.heap[c]!.cost)c++;if(this.heap[c]!.cost>=tail.cost)break;this.heap[k]=this.heap[c]!;k=c;}this.heap[k]=tail;return head;
  }
  requestGoal(x:number,y:number,z:number):boolean{
    const point={x,y,z,surface:-1};
    if(!this.locate(x,y,z,point))return false;
    this.requested=this.cellAt(x,point.y,z);if(this.requested<0)return false;
    if(this.active<0&&this.current!==this.requested)this.begin();return true;
  }
  private begin():void{
    this.active=this.requested;this.staging.fill(Infinity);this.stagingNext.fill(-1);this.heap.length=0;this.pendingCell=-1;
    if(!this.blocked[this.active]){this.staging[this.active]=0;this.push(this.active,0);}
  }
  get isPending():boolean{return this.active>=0;}
  step(budget:number):void{
    if(!Number.isInteger(budget)||budget<1)throw new RangeError('导航预算非法');this.workLastStep=0;
    while(this.active>=0&&this.workLastStep<budget){
      if(this.pendingCell<0){
        if(!this.heap.length){
          [this.published,this.staging]=[this.staging,this.published];[this.next,this.stagingNext]=[this.stagingNext,this.next];
          this.current=this.active;this.active=-1;this.version++;if(this.current!==this.requested)this.begin();continue;
        }
        const entry=this.pop();this.workLastStep++;if(entry.cost!==this.staging[entry.id])continue;
        this.pendingCell=entry.id;this.pendingEdge=0;
        if(this.workLastStep>=budget)break;
      }
      const i=this.pendingCell,a=this.cells[i]!;
      if(this.pendingEdge===a.incoming.length){this.pendingCell=-1;continue;}
      const j=a.incoming[this.pendingEdge++]!,b=this.cells[j]!;this.workLastStep++;
      if(this.blocked[i]||this.blocked[j]||this.blockedEdges.has(`${j}:${i}`))continue;
      const cost=this.staging[i]!+Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
      if(cost<this.staging[j]!){this.staging[j]=cost;this.stagingNext[j]=i;this.push(j,cost);}
    }
  }
  direction(x:number,y:number,z:number,out:{x:number;z:number},radius=this.options.agentRadius):boolean{
    const i=this.cellAt(x,y,z,radius);if(i<0||!Number.isFinite(this.published[i]))return false;
    const j=this.next[i]!;let c=this.cells[j<0?i:j]!;
    // 角色不一定在格中心。靠近活动门时先回到当前开放格，再沿可走边转角。
    if(this.dynamic.length&&j>=0){const point={x,y,z,surface:-1};if(!this.move(x,y,z,c.x,c.z,radius,point)||Math.hypot(point.x-c.x,point.y-c.y,point.z-c.z)>1e-4)c=this.cells[i]!;}
    const dx=c.x-x,dz=c.z-z,l=Math.hypot(dx,dz);
    out.x=l>1e-6?dx/l:0;out.z=l>1e-6?dz/l:0;return true;
  }
  snapshot(){return {mode:'surface-3d' as const,cellCount:this.cells.length,surfaceCount:this.patches.length,rejectedSurfaces:[...this.rejectedSurfaces],
    obstacleVersion:this.obstacleVersion,dynamicObstacleCount:this.dynamic.length,overlayWork:this.overlayWork,blockedDynamicCells:this.blocked.reduce((a,b)=>a+b,0),blockedDynamicEdges:this.blockedEdges.size,
    version:this.version,pending:this.isPending,workLastStep:this.workLastStep,goal:this.current<0?null:{x:this.cells[this.current]!.x,y:this.cells[this.current]!.y,z:this.cells[this.current]!.z,surface:this.cells[this.current]!.surface}};}
}
