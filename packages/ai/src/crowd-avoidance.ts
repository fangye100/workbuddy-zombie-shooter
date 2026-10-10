import { SpatialHash } from './navigation';

export interface AvoidanceOptions {
  maxNeighbors: number;
  timeHorizonSec: number;
  skinM: number;
  acceleration: number;
  collisionIterations: number;
  stuckWindowSec: number;
  stuckProgressRatio: number;
}

/** 输入由模拟持有；ids 是稳定池槽位，必须连同 generation 使用。 */
export interface AvoidanceBuffers {
  count: number;
  ids: Int32Array; generation: Uint32Array;
  x: Float32Array; z: Float32Array; vx: Float32Array; vz: Float32Array;
  radius: Float32Array; maxSpeed: Float32Array;
  preferredX: Float32Array; preferredZ: Float32Array;
  /** 0 = 外部控制（玩家、站定、特殊移动），仍进入邻居观察，但不由求解器位移。 */
  movable: Uint8Array;
  /** 水平层和垂直区间共同过滤；本算法不规划空中三维路径。 */
  layer: Int32Array; minY: Float32Array; maxY: Float32Array;
  nextX: Float32Array; nextZ: Float32Array; outX: Float32Array; outZ: Float32Array;
  stuck: Uint8Array;
}

export function createAvoidanceBuffers(capacity: number): AvoidanceBuffers {
  if (!Number.isInteger(capacity) || capacity<1) throw new RangeError('Invalid crowd capacity');
  const floats=()=>new Float32Array(capacity);
  return {count:0,ids:new Int32Array(capacity),generation:new Uint32Array(capacity),
    x:floats(),z:floats(),vx:floats(),vz:floats(),radius:floats(),maxSpeed:floats(),preferredX:floats(),preferredZ:floats(),
    movable:new Uint8Array(capacity),layer:new Int32Array(capacity),minY:floats(),maxY:floats(),
    nextX:floats(),nextZ:floats(),outX:floats(),outZ:floats(),stuck:new Uint8Array(capacity)};
}

export interface CrowdMovementConstraint {
  move(x:number,z:number,toX:number,toZ:number,radius:number,out:{x:number;z:number},agentIndex?:number): boolean;
}

export interface AvoidanceStats {
  agents: number; moving: number; candidateChecks: number; velocityConstraints: number;
  infeasibleVelocities: number; contactPairs: number; blockedMoves: number;
  residualOverlapPairs: number; maxPenetrationM: number; stuckAgents: number;
}

const EPS=1e-6,MAX_NEIGHBORS=32;

/** 稳定、互反的完全重合分离轴。没有墙钟、Math.random 或每帧重新随机。 */
function pairAxis(id:number,generation:number,other:number,otherGeneration:number,out:{x:number;z:number}): void {
  const first=id<other;
  const a=first?id:other,b=first?other:id,ag=first?generation:otherGeneration,bg=first?otherGeneration:generation;
  const h=(Math.imul(a+1,73856093)^Math.imul(b+1,19349663)^Math.imul(ag,83492791)^Math.imul(bg,2654435761))>>>0;
  const angle=h/4294967296*Math.PI*2,sign=first?1:-1;
  out.x=Math.cos(angle)*sign;out.z=Math.sin(angle)*sign;
}

/**
 * ORCA 圆盘速度约束 + 最近邻 + 有界 Jacobi 去穿透。
 * 数学参考：https://gamma.cs.unc.edu/ORCA/ 。此实现使用法线形式的二维半平面求解，
 * 并未包含 RVO2 的多边形障碍求解器；静态连续碰撞由显式端口提供。
 * 邻居截断、外部控制、有限迭代/不可行速度都不提供全局无碰撞数学保证。
 */
export class PredictiveCrowdSolver {
  private readonly hash: SpatialHash;
  private readonly candidates: Int32Array;
  private readonly nearest=new Int32Array(MAX_NEIGHBORS);
  private readonly distances=new Float64Array(MAX_NEIGHBORS);
  private readonly nx=new Float64Array(MAX_NEIGHBORS);
  private readonly nz=new Float64Array(MAX_NEIGHBORS);
  private readonly limit=new Float64Array(MAX_NEIGHBORS);
  private readonly correctionX: Float64Array;
  private readonly correctionZ: Float64Array;
  private readonly contacts: Uint32Array;
  private readonly historyGeneration: Uint32Array;
  private readonly identitySeen: Uint32Array;
  private identityEpoch = 0;
  private readonly historyAge: Float64Array;
  private readonly historyX: Float32Array;
  private readonly historyZ: Float32Array;
  private readonly axis={x:0,z:0};
  private readonly constrained={x:0,z:0};
  private solutionX=0;
  private solutionZ=0;
  private currentBuffers: AvoidanceBuffers | null = null;
  private currentActor = 0;
  private readonly includeNeighbor = (index: number): boolean => this.compatible(this.currentBuffers!,this.currentActor,index);
  private readonly metrics: AvoidanceStats={agents:0,moving:0,candidateChecks:0,velocityConstraints:0,infeasibleVelocities:0,contactPairs:0,blockedMoves:0,residualOverlapPairs:0,maxPenetrationM:0,stuckAgents:0};

  constructor(minX:number,minZ:number,maxX:number,maxZ:number,cellSize:number,private readonly capacity:number) {
    this.hash=new SpatialHash(minX,minZ,maxX,maxZ,cellSize,capacity);
    this.candidates=new Int32Array(capacity);this.correctionX=new Float64Array(capacity);this.correctionZ=new Float64Array(capacity);this.contacts=new Uint32Array(capacity);
    this.historyGeneration=new Uint32Array(capacity);this.historyAge=new Float64Array(capacity);this.historyX=new Float32Array(capacity);this.historyZ=new Float32Array(capacity);
    this.identitySeen=new Uint32Array(capacity);
  }

  /** 只读副本；可由 MCP/诊断读取，不推进模拟。 */
  snapshot(): AvoidanceStats {return {...this.metrics};}
  reset(): void {this.historyGeneration.fill(0);this.historyAge.fill(0);for(const key of Object.keys(this.metrics) as (keyof AvoidanceStats)[])this.metrics[key]=0;}

  solve(b:AvoidanceBuffers,p:Readonly<AvoidanceOptions>,dt:number,world?:CrowdMovementConstraint): void {
    if (!Number.isFinite(dt) || dt<=0 || !Number.isInteger(b.count) || b.count<0 || b.count>this.capacity) throw new RangeError('Invalid crowd step');
    if (!Number.isInteger(p.maxNeighbors) || p.maxNeighbors<1 || p.maxNeighbors>MAX_NEIGHBORS || !Number.isInteger(p.collisionIterations) || p.collisionIterations<1 || p.collisionIterations>12
      || ![p.timeHorizonSec,p.skinM,p.acceleration,p.stuckWindowSec,p.stuckProgressRatio].every(Number.isFinite)
      || p.timeHorizonSec<=0 || p.skinM<0 || p.acceleration<0 || p.stuckWindowSec<=0 || p.stuckProgressRatio<0) throw new RangeError('Invalid crowd options');
    this.clearMetrics();
    this.identityEpoch=(this.identityEpoch+1)>>>0;
    if(!this.identityEpoch){this.identitySeen.fill(0);this.identityEpoch=1;}
    this.metrics.agents=b.count;
    let maxRadius=0,maxSpeed=0;
    for(let i=0;i<b.count;i++) {
      if(b.ids[i]!<0 || b.ids[i]!>=this.capacity || !b.generation[i]
        || !Number.isFinite(b.x[i]) || !Number.isFinite(b.z[i]) || !Number.isFinite(b.vx[i]) || !Number.isFinite(b.vz[i])
        || !Number.isFinite(b.preferredX[i]) || !Number.isFinite(b.preferredZ[i]) || !Number.isFinite(b.radius[i])
        || !Number.isFinite(b.maxSpeed[i]) || !Number.isFinite(b.minY[i]) || !Number.isFinite(b.maxY[i])
        || b.radius[i]!<0 || b.maxSpeed[i]!<0 || b.maxY[i]!<b.minY[i]!) throw new RangeError('Invalid crowd actor');
      const id=b.ids[i]!;
      if(this.identitySeen[id]===this.identityEpoch)throw new RangeError('Duplicate crowd identity');
      this.identitySeen[id]=this.identityEpoch;
      maxRadius=Math.max(maxRadius,b.radius[i]!);maxSpeed=Math.max(maxSpeed,b.maxSpeed[i]!,Math.hypot(b.vx[i]!,b.vz[i]!));
      b.nextX[i]=b.x[i]!;b.nextZ[i]=b.z[i]!;b.outX[i]=0;b.outZ[i]=0;b.stuck[i]=0;
    }
    this.hash.build(b.x,b.z,b.count);
    for(let i=0;i<b.count;i++) {
      if(!b.movable[i]) {this.historyAge[b.ids[i]!]=0;this.historyGeneration[b.ids[i]!]=0;continue;}
      this.metrics.moving++;
      const speed=b.maxSpeed[i]!,x=b.x[i]!,z=b.z[i]!;
      // 加速度只平滑期望速度；紧急避碰不再在求解后裁剪到一个不满足约束的速度。
      let px=b.preferredX[i]!,pz=b.preferredZ[i]!;
      const change=Math.hypot(px-b.vx[i]!,pz-b.vz[i]!),step=p.acceleration*dt;
      if(change>step && change>EPS) {px=b.vx[i]!+(px-b.vx[i]!)*step/change;pz=b.vz[i]!+(pz-b.vz[i]!)*step/change;}
      const range=b.radius[i]!+maxRadius+p.skinM+(speed+maxSpeed)*p.timeHorizonSec;
      const count=this.neighbors(b,i,range,p.maxNeighbors);
      for(let k=0;k<count;k++)this.constraint(b,i,this.nearest[k]!,k,p,dt);
      this.metrics.velocityConstraints+=count;
      if(!this.projectVelocity(count,speed,px,pz,0)) {
        this.metrics.infeasibleVelocities++;
        // 无可行解时最小化最大半平面违约；有限迭代，不假装已经无碰撞。
        let low=0,high=0;
        for(let k=0;k<count;k++)high=Math.max(high,this.limit[k]!+speed);
        for(let iteration=0;iteration<8;iteration++) {
          const slack=(low+high)*.5;
          if(this.projectVelocity(count,speed,px,pz,slack))high=slack;else low=slack;
        }
        this.projectVelocity(count,speed,px,pz,high+EPS);
      }
      let nextX=x+this.solutionX*dt,nextZ=z+this.solutionZ*dt;
      if(world) {
        if(world.move(x,z,nextX,nextZ,b.radius[i]!,this.constrained,i)) {nextX=this.constrained.x;nextZ=this.constrained.z;}
        else {nextX=x;nextZ=z;this.metrics.blockedMoves++;}
      }
      b.nextX[i]=nextX;b.nextZ[i]=nextZ;
    }
    this.resolveContacts(b,p,maxRadius,world);
    for(let i=0;i<b.count;i++) {
      if(!b.movable[i]) continue;
      let vx=(b.nextX[i]!-b.x[i]!)/dt,vz=(b.nextZ[i]!-b.z[i]!)/dt;
      // 去穿透不是主动加速；避免初始拥挤纠偏产生异常大的下一帧预测速度。
      const length=Math.hypot(vx,vz),speed=b.maxSpeed[i]!;
      if(length>speed && length>EPS) {vx*=speed/length;vz*=speed/length;}
      b.outX[i]=vx;b.outZ[i]=vz;
      this.updateHistory(b,i,p,dt);
    }
  }

  private compatible(b:AvoidanceBuffers,i:number,j:number): boolean {
    return i!==j && b.layer[i]===b.layer[j] && b.maxY[i]!>=b.minY[j]! && b.maxY[j]!>=b.minY[i]!;
  }
  private clearMetrics(): void {
    const m=this.metrics;
    m.agents=0;m.moving=0;m.candidateChecks=0;m.velocityConstraints=0;m.infeasibleVelocities=0;
    m.contactPairs=0;m.blockedMoves=0;m.residualOverlapPairs=0;m.maxPenetrationM=0;m.stuckAgents=0;
  }

  private neighbors(b:AvoidanceBuffers,i:number,range:number,max:number): number {
    this.currentBuffers=b;this.currentActor=i;
    const n=this.hash.queryNearest(b.x[i]!,b.z[i]!,range,max,this.nearest,this.distances,b.x,b.z,b.ids,this.includeNeighbor);
    this.metrics.candidateChecks+=this.hash.nearestCandidateChecks;
    return n;
  }

  private constraint(b:AvoidanceBuffers,i:number,j:number,k:number,p:Readonly<AvoidanceOptions>,dt:number): void {
    const dx=b.x[j]!-b.x[i]!,dz=b.z[j]!-b.z[i]!,vx=b.vx[i]!-b.vx[j]!,vz=b.vz[i]!-b.vz[j]!;
    const distance=dx*dx+dz*dz,r=b.radius[i]!+b.radius[j]!+p.skinM;
    let nx:number,nz:number,ux:number,uz:number;
    if(distance>r*r) {
      const wx=vx-dx/p.timeHorizonSec,wz=vz-dz/p.timeHorizonSec,wSq=wx*wx+wz*wz,dot=wx*dx+wz*dz;
      if(dot<0 && dot*dot>r*r*wSq) {
        const length=Math.sqrt(wSq);nx=wx/length;nz=wz/length;
        const amount=r/p.timeHorizonSec-length;ux=amount*nx;uz=amount*nz;
      } else {
        const leg=Math.sqrt(distance-r*r);
        const left=dx*wz-dz*wx>0;
        const tx=left?(dx*leg-dz*r)/distance:-(dx*leg+dz*r)/distance;
        const tz=left?(dx*r+dz*leg)/distance:(dx*r-dz*leg)/distance;
        const along=vx*tx+vz*tz;ux=along*tx-vx;uz=along*tz-vz;nx=-tz;nz=tx;
      }
    } else {
      const wx=vx-dx/dt,wz=vz-dz/dt,length=Math.hypot(wx,wz);
      if(length>EPS){nx=wx/length;nz=wz/length;}
      else {pairAxis(b.ids[i]!,b.generation[i]!,b.ids[j]!,b.generation[j]!,this.axis);nx=this.axis.x;nz=this.axis.z;}
      const amount=r/dt-length;ux=amount*nx;uz=amount*nz;
    }
    const responsibility=b.movable[j]?0.5:1;
    this.nx[k]=nx;this.nz[k]=nz;this.limit[k]=nx*(b.vx[i]!+responsibility*ux)+nz*(b.vz[i]!+responsibility*uz);
  }

  /** 二维圆盘与半平面交集的增量投影；所有暂存数组复用。 */
  private projectVelocity(count:number,speed:number,desiredX:number,desiredZ:number,slack:number): boolean {
    const length=Math.hypot(desiredX,desiredZ),scale=length>speed?speed/Math.max(EPS,length):1;
    this.solutionX=desiredX*scale;this.solutionZ=desiredZ*scale;
    for(let i=0;i<count;i++) {
      const nx=this.nx[i]!,nz=this.nz[i]!,limit=this.limit[i]!-slack;
      if(nx*this.solutionX+nz*this.solutionZ>=limit-EPS)continue;
      if(Math.abs(limit)>speed+EPS)return false;
      const tx=-nz,tz=nx,half=Math.sqrt(Math.max(0,speed*speed-limit*limit));
      let low=-half,high=half;
      for(let j=0;j<i;j++) {
        const denominator=this.nx[j]!*tx+this.nz[j]!*tz;
        const value=this.limit[j]!-slack-limit*(this.nx[j]!*nx+this.nz[j]!*nz);
        if(Math.abs(denominator)<EPS){if(value>EPS)return false;continue;}
        const t=value/denominator;
        if(denominator>0)low=Math.max(low,t);else high=Math.min(high,t);
        if(low>high+EPS)return false;
      }
      const t=Math.max(low,Math.min(high,tx*desiredX+tz*desiredZ));
      this.solutionX=nx*limit+tx*t;this.solutionZ=nz*limit+tz*t;
    }
    return true;
  }

  private resolveContacts(b:AvoidanceBuffers,p:Readonly<AvoidanceOptions>,maxRadius:number,world?:CrowdMovementConstraint): void {
    for(let pass=0;pass<=p.collisionIterations;pass++) {
      this.hash.build(b.nextX,b.nextZ,b.count);this.correctionX.fill(0,0,b.count);this.correctionZ.fill(0,0,b.count);this.contacts.fill(0,0,b.count);
      let pairs=0,maxPenetration=0;
      for(let i=0;i<b.count;i++) {
        const count=this.hash.queryRange(b.nextX[i]!,b.nextZ[i]!,b.radius[i]!+maxRadius+p.skinM,this.candidates);
        for(let k=0;k<count;k++) {
          const j=this.candidates[k]!;
          if(j<=i || !this.compatible(b,i,j))continue;
          const dx=b.nextX[i]!-b.nextX[j]!,dz=b.nextZ[i]!-b.nextZ[j]!,distance=Math.hypot(dx,dz);
          const penetration=b.radius[i]!+b.radius[j]!+p.skinM-distance;
          if(penetration<=EPS)continue;
          pairs++;maxPenetration=Math.max(maxPenetration,penetration);
          const a=b.movable[i]?1:0,c=b.movable[j]?1:0,total=a+c;
          if(!total || pass===p.collisionIterations)continue;
          let nx=dx/Math.max(EPS,distance),nz=dz/Math.max(EPS,distance);
          if(distance<EPS){pairAxis(b.ids[i]!,b.generation[i]!,b.ids[j]!,b.generation[j]!,this.axis);nx=this.axis.x;nz=this.axis.z;}
          const amount=(penetration+EPS)/total;
          if(a){this.correctionX[i]=this.correctionX[i]!+nx*amount;this.correctionZ[i]=this.correctionZ[i]!+nz*amount;this.contacts[i]=this.contacts[i]!+1;}
          if(c){this.correctionX[j]=this.correctionX[j]!-nx*amount;this.correctionZ[j]=this.correctionZ[j]!-nz*amount;this.contacts[j]=this.contacts[j]!+1;}
        }
      }
      if(pass===p.collisionIterations || !pairs) {this.metrics.residualOverlapPairs=pairs;this.metrics.maxPenetrationM=maxPenetration;break;}
      this.metrics.contactPairs+=pairs;
      for(let i=0;i<b.count;i++) {
        if(!this.contacts[i])continue;
        let dx=this.correctionX[i]!/this.contacts[i]!,dz=this.correctionZ[i]!/this.contacts[i]!;
        const length=Math.hypot(dx,dz),cap=Math.max(.02,b.radius[i]!*.5);
        if(length>cap){dx*=cap/length;dz*=cap/length;}
        let x=b.nextX[i]!+dx,z=b.nextZ[i]!+dz;
        if(world) {
          if(world.move(b.nextX[i]!,b.nextZ[i]!,x,z,b.radius[i]!,this.constrained,i)){x=this.constrained.x;z=this.constrained.z;}
          else {x=b.nextX[i]!;z=b.nextZ[i]!;this.metrics.blockedMoves++;}
        }
        b.nextX[i]=x;b.nextZ[i]=z;
      }
    }
  }

  private updateHistory(b:AvoidanceBuffers,i:number,p:Readonly<AvoidanceOptions>,dt:number): void {
    const id=b.ids[i]!,generation=b.generation[i]!,desired=Math.hypot(b.preferredX[i]!,b.preferredZ[i]!);
    if(this.historyGeneration[id]!==generation || desired<EPS) {
      this.historyGeneration[id]=generation;this.historyAge[id]=0;this.historyX[id]=b.nextX[i]!;this.historyZ[id]=b.nextZ[i]!;return;
    }
    this.historyAge[id]=this.historyAge[id]!+dt;
    if(this.historyAge[id]!+EPS<p.stuckWindowSec)return;
    const progress=Math.hypot(b.nextX[i]!-this.historyX[id]!,b.nextZ[i]!-this.historyZ[id]!);
    if(progress<desired*this.historyAge[id]!*p.stuckProgressRatio){b.stuck[i]=1;this.metrics.stuckAgents++;}
    this.historyAge[id]=0;this.historyX[id]=b.nextX[i]!;this.historyZ[id]=b.nextZ[i]!;
  }
}
