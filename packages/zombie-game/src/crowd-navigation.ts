import { FlowField, FlowFieldIntegrator, PredictiveCrowdSolver, createAvoidanceBuffers, UNREACHABLE } from '@aether/ai';
import { DiscCollisionWorld, discContactFraction } from '@aether/runtime';
import { defaultNavigationSettings, validNavigationSettings, type NavigationSettings } from '@aether/scene';
import type { CharacterTable } from '@aether/gameplay';
import type { NavDesc, ObstacleDesc } from './loader';

/** 游戏提供移动资格/攻击距离；Framework 不认识 chase、玩家或僵尸类型。 */
export interface ZombieNavigationPolicy {
  movable(slot: number): boolean;
  speed(slot: number): number;
  arrivalRange(slot: number): number;
  height(slot: number): number;
}

/** 持有导航工作缓存，不复制实体状态；唯一权威位置仍为 CharacterTable。 */
export class ZombieCrowdNavigation {
  readonly field: FlowField;
  readonly world: DiscCollisionWorld;
  readonly settings: Readonly<NavigationSettings>;
  private readonly integrator: FlowFieldIntegrator;
  private readonly solver: PredictiveCrowdSolver;
  private readonly buffers;
  private readonly yieldUntil: Float64Array;
  private readonly generation: Uint32Array;
  private readonly sample = { x: 0, z: 0, confidence: 0 };
  private readonly point = { x: 0, z: 0 };
  private rejectedGoals = 0;
  private unreachableAgents = 0;
  private yieldingAgents = 0;
  private externalBlockedMoves = 0;
  private goalCell = -1;
  private requestedX = 0;
  private requestedZ = 0;

  constructor(nav: NavDesc, obstacles: readonly ObstacleDesc[], capacity: number, startX: number, startZ: number) {
    // 显式支持旧版直接构造 API；场景 loader 已拒绝缺失 v16 配置。
    const settings = nav.crowd ?? defaultNavigationSettings();
    if (!validNavigationSettings(settings)) throw new RangeError('导航配置非法');
    this.settings = Object.freeze({ ...settings });
    const width = Math.ceil((nav.maxX - nav.minX) / nav.cellSize), height = Math.ceil((nav.maxZ - nav.minZ) / nav.cellSize);
    if (![nav.minX,nav.minZ,nav.maxX,nav.maxZ,nav.cellSize].every(Number.isFinite) || nav.cellSize <= 0
      || width < 1 || height < 1 || width * height > 262144) throw new RangeError('导航范围或网格容量非法');
    this.field = new FlowField({ width, height, cellSize: nav.cellSize, originX: nav.minX, originZ: nav.minZ });
    this.world = new DiscCollisionWorld(nav, obstacles);
    const f = this.field, cs = f.cellSize;
    for (const o of obstacles) {
      if (!o.enabled) continue;
      for (let z = Math.max(0,Math.floor((o.z-o.halfZ-nav.minZ)/cs)); z <= Math.min(height-1,Math.floor((o.z+o.halfZ-nav.minZ)/cs)); z++)
        for (let x = Math.max(0,Math.floor((o.x-o.halfX-nav.minX)/cs)); x <= Math.min(width-1,Math.floor((o.x+o.halfX-nav.minX)/cs)); x++) {
          const cx = nav.minX+(x+.5)*cs, cz = nav.minZ+(z+.5)*cs;
          if (o.shape === 'box' || Math.hypot(cx-o.x,cz-o.z) <= o.radius+cs*Math.SQRT1_2) f.setBlocked(x,z,true);
        }
    }
    f.bakeClearance(); f.applyClearanceToCost();
    this.integrator = new FlowFieldIntegrator(f);
    this.solver = new PredictiveCrowdSolver(nav.minX,nav.minZ,nav.maxX,nav.maxZ,Math.max(.5,cs*2),capacity);
    this.buffers = createAvoidanceBuffers(capacity);
    this.yieldUntil = new Float64Array(capacity); this.generation = new Uint32Array(capacity);
    this.reset(startX,startZ);
  }

  /** 初始烘焙属于 Play 建立期；运行期全部按场景预算推进。 */
  reset(x: number,z: number): void {
    this.solver.reset();this.yieldUntil.fill(0);this.generation.fill(0);
    this.rejectedGoals=0;this.unreachableAgents=0;this.yieldingAgents=0;this.externalBlockedMoves=0;this.goalCell=-1;
    this.integrator.invalidate();
    this.requestGoal(x,z);
    if (this.goalCell < 0) throw new Error('玩家起点附近没有可用导航格');
    while(this.integrator.isPending)this.integrator.step(this.settings.flowCellBudget);
  }

  private requestGoal(x: number,z: number): void {
    const f=this.field;
    const raw=f.cellIndexAtWorld(x,z);
    if (raw===this.goalCell) {this.requestedX=x;this.requestedZ=z;return;}
    let idx=raw;
    if (idx<0 || f.isBlocked(idx)) {
      // 玩家可站在保守烘焙的边缘格；显式计数并选近邻开放格，不改玩家位置。
      let best=Infinity;idx=-1;
      const cx=Math.floor((x-f.originX)/f.cellSize),cz=Math.floor((z-f.originZ)/f.cellSize);
      for(let dz=-4;dz<=4;dz++)for(let dx=-4;dx<=4;dx++) {
        if (!f.inBounds(cx+dx,cz+dz))continue;
        const j=f.index(cx+dx,cz+dz);if(f.isBlocked(j))continue;
        f.cellCenter(j,this.point);const distance=(this.point.x-x)**2+(this.point.z-z)**2;
        if(distance<best){best=distance;idx=j;}
      }
      this.rejectedGoals++;
    }
    this.requestedX=x;this.requestedZ=z;
    if(idx>=0){f.cellCenter(idx,this.point);this.integrator.setGoal(this.point.x,this.point.z);this.goalCell=idx;}
  }

  step(t: CharacterTable, player: number, dt: number, now: number, policy: ZombieNavigationPolicy): void {
    if(player<0 || !t.isAlive(player))return;
    const px=t.posX[player]!,pz=t.posZ[player]!;
    this.requestGoal(px,pz);this.integrator.step(this.settings.flowCellBudget);
    const b=this.buffers;
    let n=0;this.unreachableAgents=0;this.yieldingAgents=0;
    for(let i=0;i<t.capacity;i++) {
      if(!t.isAlive(i))continue;
      b.ids[n]=i;b.generation[n]=t.generation[i]!;
      b.x[n]=t.posX[i]!;b.z[n]=t.posZ[i]!;b.vx[n]=t.velX[i]!;b.vz[n]=t.velZ[i]!;
      b.radius[n]=t.radius[i]!;b.maxSpeed[n]=policy.speed(i);
      b.layer[n]=0;b.minY[n]=0;b.maxY[n]=policy.height(i);
      b.movable[n]=i!==player && policy.movable(i)?1:0;
      b.preferredX[n]=0;b.preferredZ[n]=0;
      if(this.generation[i]!==t.generation[i]){this.generation[i]=t.generation[i]!;this.yieldUntil[i]=0;}
      if(b.movable[n]) {
        const dx=px-b.x[n]!,dz=pz-b.z[n]!,distance=Math.hypot(dx,dz);
        const range=policy.arrivalRange(i);
        const arrival=Math.max(t.radius[player]!+b.radius[n]!+this.settings.skinM,range*.88);
        const cell=this.field.cellIndexAtWorld(b.x[n]!,b.z[n]!);
        const reachable=cell>=0 && this.field.integration[cell]!==UNREACHABLE;
        // 无路可达时等待并暴露事实；不退化成穿墙直线追击。
        if(!reachable){this.unreachableAgents++;}
        else if(distance>arrival+.025) {
          let fx=0,fz=0;
          if(distance<Math.max(2,arrival*2) && this.world.move(b.x[n]!,b.z[n]!,px,pz,b.radius[n]!,this.point)
            && Math.hypot(this.point.x-px,this.point.z-pz)<.01) {fx=dx/distance;fz=dz/distance;}
          else if(this.field.sampleFlow(b.x[n]!,b.z[n]!,this.sample)){fx=this.sample.x;fz=this.sample.z;}
          if(this.yieldUntil[i]!>now) {
            const side=i%2===0?1:-1,old=fx;fx=-fz*side;fz=old*side;this.yieldingAgents++;
          }
          const speed=Math.min(b.maxSpeed[n]!,Math.max(0,(distance-arrival)/dt));
          b.preferredX[n]=fx*speed;b.preferredZ[n]=fz*speed;
        }
      } else { this.yieldUntil[i]=0; }
      n++;
    }
    b.count=n;
    this.solver.solve(b,this.settings,dt,this.world);
    for(let k=0;k<n;k++) {
      if(!b.movable[k])continue;
      const i=b.ids[k]!;
      t.posX[i]=b.nextX[k]!;t.posZ[i]=b.nextZ[k]!;t.velX[i]=b.outX[k]!;t.velZ[i]=b.outZ[k]!;
      if(Math.hypot(b.outX[k]!,b.outZ[k]!)>.02)t.yaw[i]=Math.atan2(b.outZ[k]!,b.outX[k]!);
      // 解堵仅改变追击意图，不触碰攻击/动画时钟，不瞬移。
      if(b.stuck[k] && now>=this.yieldUntil[i]!)this.yieldUntil[i]=now+this.settings.stuckWindowSec*.6;
    }
  }

  move(x:number,z:number,toX:number,toZ:number,radius:number): [number,number] {
    if(!this.world.move(x,z,toX,toZ,radius,this.point))return [x,z];
    return [this.point.x,this.point.z];
  }

  /** 玩家、突扑/冲锋与击退不可绕过动态圆盘；邻居位置直接读权威表。 */
  moveActor(t:CharacterTable,slot:number,toX:number,toZ:number): [number,number] {
    const x=t.posX[slot]!,z=t.posZ[slot]!,radius=t.radius[slot]!;
    let targetX=toX,targetZ=toZ;
    for(let pass=0;pass<3;pass++) {
      if(!this.world.move(x,z,targetX,targetZ,radius,this.point))return [x,z];
      targetX=this.point.x;targetZ=this.point.z;
      let fraction=1;
      for(let j=0;j<t.capacity;j++)if(j!==slot && t.isAlive(j))
        fraction=Math.min(fraction,discContactFraction(x,z,targetX,targetZ,radius,t.posX[j]!,t.posZ[j]!,t.radius[j]!+this.settings.skinM));
      if(fraction===1)return [targetX,targetZ];
      this.externalBlockedMoves++;
      targetX=x+(targetX-x)*fraction;targetZ=z+(targetZ-z)*fraction;
    }
    // 静态滑动反复碰到动态阻挡时保守等待，不穿过人群或墙体。
    return [x,z];
  }

  snapshot() {
    return { settings:{...this.settings},flow:{version:this.field.version,pending:this.integrator.isPending,
      publishedGoal:this.integrator.publishedGoal,requestedX:this.requestedX,requestedZ:this.requestedZ,
      workLastStep:this.integrator.workLastStep,cellCount:this.field.cellCount,rejectedGoals:this.rejectedGoals},
      crowd:{...this.solver.snapshot(),unreachableAgents:this.unreachableAgents,yieldingAgents:this.yieldingAgents,externalBlockedMoves:this.externalBlockedMoves} };
  }
}
