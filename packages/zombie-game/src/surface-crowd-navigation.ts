import { SurfaceNavigation, PredictiveCrowdSolver, createAvoidanceBuffers } from '@aether/ai';
import { discContactFraction } from '@aether/runtime';
import { defaultNavigationSettings,validNavigationSettings } from '@aether/scene';
import type { CharacterTable } from '@aether/gameplay';
import type { NavDesc, ObstacleDesc } from './loader';
import type { ZombieNavigationPolicy } from './crowd-navigation';

/** 三维场景适配器：权威位置仍是 CharacterTable，求解器只持有工作缓存。 */
export class ZombieSurfaceCrowdNavigation {
  readonly settings;
  readonly surface:SurfaceNavigation;
  private readonly solver:PredictiveCrowdSolver;
  private readonly buffers;
  private readonly y:Float32Array;
  private readonly heights:Float32Array;
  private readonly point={x:0,y:0,z:0,surface:-1};
  private readonly direction={x:0,z:0};
  private unreachable=0;
  private externalBlocked=0;
  private requestedX=0;
  private requestedZ=0;
  private readonly constraint={move:(x:number,z:number,toX:number,toZ:number,radius:number,out:{x:number;z:number},i?:number)=>{
    if(i===undefined||!this.surface.move(x,this.y[i]!,z,toX,toZ,radius,this.point))return false;
    out.x=this.point.x;out.z=this.point.z;this.y[i]=this.point.y;return true;
  }};
  constructor(nav:NavDesc,obstacles:readonly ObstacleDesc[],capacity:number,startX:number,startZ:number,startY:number){
    if(!nav.surface||!nav.surfaces?.length)throw new Error('三维导航缺少 NavSurface');
    this.settings=Object.freeze({...nav.crowd??defaultNavigationSettings()});
    if(!validNavigationSettings(this.settings))throw new RangeError('导航避让配置非法');
    this.surface=new SurfaceNavigation(nav.surfaces,{...nav.surface,cellSize:nav.cellSize},obstacles.filter(o=>o.enabled).map(o=>({
      id:o.nodeId,minX:o.x-o.halfX,maxX:o.x+o.halfX,minZ:o.z-o.halfZ,maxZ:o.z+o.halfZ,minY:o.minY??-Infinity,maxY:o.maxY??Infinity,
    })));
    this.solver=new PredictiveCrowdSolver(nav.minX,nav.minZ,nav.maxX,nav.maxZ,Math.max(.5,nav.cellSize*2),capacity);
    this.buffers=createAvoidanceBuffers(capacity);this.y=new Float32Array(capacity);this.heights=new Float32Array(capacity);
    this.reset(startX,startZ,startY);
  }
  reset(x:number,z:number,y=0):void{
    this.solver.reset();this.unreachable=0;this.externalBlocked=0;
    if(!this.surface.requestGoal(x,y,z))throw new Error('玩家起点不在三维可行走面上');
    while(this.surface.isPending)this.surface.step(this.settings.flowCellBudget);
    this.requestedX=x;this.requestedZ=z;
  }
  step(t:CharacterTable,player:number,dt:number,_now:number,policy:ZombieNavigationPolicy):void{
    if(!t.isAlive(player))return;
    const px=t.posX[player]!,py=t.posY[player]!,pz=t.posZ[player]!;
    this.surface.requestGoal(px,py,pz);this.surface.step(this.settings.flowCellBudget);this.requestedX=px;this.requestedZ=pz;
    const b=this.buffers;let n=0;this.unreachable=0;
    for(let i=0;i<t.capacity;i++){
      if(!t.isAlive(i))continue;
      b.ids[n]=i;b.generation[n]=t.generation[i]!;b.x[n]=t.posX[i]!;b.z[n]=t.posZ[i]!;
      b.vx[n]=t.velX[i]!;b.vz[n]=t.velZ[i]!;b.radius[n]=t.radius[i]!;b.maxSpeed[n]=policy.speed(i);
      this.heights[i]=policy.height(i);this.y[n]=t.posY[i]!;b.layer[n]=0;b.minY[n]=this.y[n]!;b.maxY[n]=this.y[n]!+policy.height(i);
      b.movable[n]=i!==player&&policy.movable(i)?1:0;b.preferredX[n]=0;b.preferredZ[n]=0;
      if(b.movable[n]){
        const distance=Math.hypot(px-b.x[n]!,py-this.y[n]!,pz-b.z[n]!);
        const arrival=Math.max(t.radius[player]!+b.radius[n]!+this.settings.skinM,policy.arrivalRange(i)*.88);
        if(!this.surface.direction(b.x[n]!,this.y[n]!,b.z[n]!,this.direction))this.unreachable++;
        else if(distance>arrival+.025){
          let dx=this.direction.x,dz=this.direction.z;
          if(distance<Math.max(2,arrival*2)&&this.surface.move(b.x[n]!,this.y[n]!,b.z[n]!,px,pz,b.radius[n]!,this.point)
            &&Math.hypot(this.point.x-px,this.point.y-py,this.point.z-pz)<.01){const l=Math.hypot(px-b.x[n]!,pz-b.z[n]!);dx=l>1e-6?(px-b.x[n]!)/l:0;dz=l>1e-6?(pz-b.z[n]!)/l:0;}
          // 期望速度按地表弧长折算；紧急接触修正不受这一期望速度限制。
          const probe={x:0,y:0,z:0,surface:-1};let factor=1;
          if(this.surface.move(b.x[n]!,this.y[n]!,b.z[n]!,b.x[n]!+dx*.1,b.z[n]!+dz*.1,b.radius[n]!,probe))
            factor=.1/Math.max(.1,Math.hypot(probe.x-b.x[n]!,probe.y-this.y[n]!,probe.z-b.z[n]!));
          const speed=Math.min(b.maxSpeed[n]!*factor,Math.max(0,(distance-arrival)/dt));b.preferredX[n]=dx*speed;b.preferredZ[n]=dz*speed;
        }
      }n++;
    }
    b.count=n;this.solver.solve(b,this.settings,dt,this.constraint);
    for(let k=0;k<n;k++)if(b.movable[k]){
      const i=b.ids[k]!;t.posX[i]=b.nextX[k]!;t.posY[i]=this.y[k]!;t.posZ[i]=b.nextZ[k]!;t.velX[i]=b.outX[k]!;t.velZ[i]=b.outZ[k]!;
      if(Math.hypot(b.outX[k]!,b.outZ[k]!)>.02)t.yaw[i]=Math.atan2(b.outZ[k]!,b.outX[k]!);
    }
  }
  moveActor(t:CharacterTable,slot:number,toX:number,toZ:number):[number,number]{
    const x=t.posX[slot]!,y=t.posY[slot]!,z=t.posZ[slot]!,r=t.radius[slot]!;
    if(!this.surface.move(x,y,z,toX,toZ,r,this.point))return [x,z];
    let fraction=1;const height=this.heights[slot]||this.surface.options.agentHeight;
    for(let j=0;j<t.capacity;j++)if(j!==slot&&t.isAlive(j)){
      const minY=Math.min(y,this.point.y),maxY=Math.max(y,this.point.y)+height;
      if(t.posY[j]!>=maxY||t.posY[j]!+(this.heights[j]||height)<=minY)continue;
      fraction=Math.min(fraction,discContactFraction(x,z,this.point.x,this.point.z,r,t.posX[j]!,t.posZ[j]!,t.radius[j]!+this.settings.skinM));
    }
    if(fraction<1){this.externalBlocked++;this.surface.move(x,y,z,x+(this.point.x-x)*fraction,z+(this.point.z-z)*fraction,r,this.point);}
    t.posY[slot]=this.point.y;return [this.point.x,this.point.z];
  }
  spawnPosition(x:number,y:number,z:number,radius:number,toX=x,toZ=z):[number,number,number]{
    if(!this.surface.move(x,y,z,toX,toZ,radius,this.point))throw new Error('出生点不受三维地表支撑或净空不足');
    return [this.point.x,this.point.y,this.point.z];
  }
  snapshot(){
    const surface=this.surface.snapshot();
    return {settings:{...this.settings},surface,flow:{version:surface.version,pending:surface.pending,publishedGoal:surface.goal,
      requestedX:this.requestedX,requestedZ:this.requestedZ,workLastStep:surface.workLastStep,cellCount:surface.cellCount,rejectedGoals:0},
      crowd:{...this.solver.snapshot(),unreachableAgents:this.unreachable,yieldingAgents:0,externalBlockedMoves:this.externalBlocked}};
  }
}
