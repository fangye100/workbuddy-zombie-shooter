import { ObjectPool } from '@aether/core';
import type { WeaponDefinition, WeaponBehavior } from '@aether/scene';
import type { SolidContact } from './solid-ray';
export type WeaponPoint=[number,number,number];
export interface WeaponActor { id:number;generation:number;x:number;y?:number;height?:number;z:number;radius:number;hp:number }
export interface WeaponHit { actor:WeaponActor|null; point:WeaponPoint; distance:number; surface?:SolidContact; kind?:'entity'|'scene'|'miss'; nodeId?:string|undefined; normal?:WeaponPoint|undefined }
/** 场景物体伤害来源：沿同一武器事实链，DOT 明确标 burn，不借直接命中序号。 */
export type WeaponSceneDamageKind='direct'|'projectile'|'explosion'|'burn';
export interface WeaponSceneTarget { readonly nodeId:string; readonly position:WeaponPoint; readonly radius:number;
  readonly minX?:number;readonly maxX?:number;readonly minY?:number;readonly maxY?:number;readonly minZ?:number;readonly maxZ?:number }
/** 目标 AABB 上朝向攻击者的最近点；没有 bounds 时用中心向攻击者偏移半径。 */
function sceneContactPoint(s:WeaponSceneTarget,from:WeaponPoint):WeaponPoint {
  const clamp=(v:number,min:number|undefined,max:number|undefined)=>Math.max(min??v,Math.min(max??v,v));
  if(s.minX!==undefined||s.maxX!==undefined||s.minY!==undefined||s.maxY!==undefined||s.minZ!==undefined||s.maxZ!==undefined){
    return [clamp(from[0],s.minX,s.maxX),clamp(from[1],s.minY,s.maxY),clamp(from[2],s.minZ,s.maxZ)];
  }
  const dx=from[0]-s.position[0],dy=from[1]-s.position[1],dz=from[2]-s.position[2],l=Math.hypot(dx,dy,dz);
  if(l<1e-6)return [...s.position] as WeaponPoint;
  return [s.position[0]+dx/l*s.radius,s.position[1]+dy/l*s.radius,s.position[2]+dz/l*s.radius];
}
export interface WeaponVfxEvent { readonly sequence:number; readonly tick:number; readonly weaponId:string; readonly kind:'fire'|'trace'|'impact'|'projectile'|'projectile-end'; readonly effectId?:number; readonly from:readonly number[]; readonly to:readonly number[]; readonly contact:'entity'|'scene'|'miss'; readonly actor:Readonly<WeaponActor>|null; readonly nodeId:string|null; readonly normal:readonly number[]|null }
export interface WeaponDamageFacts {readonly weaponId:string;readonly vfxSequence?:number;readonly damageKind?:'burn';readonly origin?:readonly [number,number,number];readonly contact?:readonly [number,number,number]}
export interface WeaponWorld {
  actors():WeaponActor[]; actor(id:number):WeaponActor|null;
  trace(from:WeaponPoint,direction:WeaponPoint,range:number,ignore:ReadonlySet<number>,radius?:number):WeaponHit;
  blocked(from:WeaponPoint,to:WeaponPoint):boolean;
  damage(id:number,damage:number,facts?:WeaponDamageFacts):number;
  displace(id:number,from:WeaponPoint,distance:number):void;
  solidImpact?(hit:WeaponHit,from:WeaponPoint,direction:WeaponPoint,weapon:WeaponDefinition,tick:number):void;
  /** 场景可破坏目标的爆炸/范围查询；物体 HP 仍由游戏 runtime 持有。 */
  sceneTargets?():readonly WeaponSceneTarget[];
  /** 对稳定 NodeId 施加伤害；返回实际扣除量（0 = 非目标/来源不允许/已破坏）。 */
  damageScene?(nodeId:string,damage:number,facts:WeaponDamageFacts|undefined,kind:WeaponSceneDamageKind,
    point?:WeaponPoint,normal?:WeaponPoint):number;
  /** 爆炸遮挡查询：忽略目标自身 collider，避免把自身当墙。 */
  blockedExcept?(from:WeaponPoint,to:WeaponPoint,ignoreNodeId:string):boolean;
}
export interface WeaponEffect { id:number;tick:number;weaponId:string;kind:'shot'|'pellet'|'pierce'|'projectile'|'explosion'|'slash'|'flame'|'burn';from:WeaponPoint;to:WeaponPoint;position:WeaponPoint;duration:number;radius:number;spreadDeg:number;color:string;hit:boolean }
interface Projectile {effect:WeaponEffect|null;definition:WeaponDefinition|null;damage:number;direction:WeaponPoint;age:number;travel:number;velocityY:number}
interface Status {id:number;generation:number;weaponId:string;until:number;damage:number;slow:number;slowUntil:number;position:WeaponPoint}
interface FireContext {weapon:WeaponDefinition;from:WeaponPoint;direction:WeaponPoint;damage:number;tick:number;random():number;world:WeaponWorld;combat:WeaponCombat}
export interface WeaponImplementation { fire(context:FireContext):void }

class RayWeapon implements WeaponImplementation {
  constructor(private pellets=false,private pierce=false){}
  fire(c:FireContext):void {
    const w=c.weapon,count=this.pellets?w.pellets:1;
    for(let n=0;n<count;n++){
      // Stratified pellet angles retain a centre pellet and fill the authored cone reproducibly.
      const angle=this.pellets?(count===1?0:(n/(count-1)-.5)*w.spreadDeg*Math.PI/180):(c.random()-.5)*w.spreadDeg*Math.PI/180;
      const d:WeaponPoint=[c.direction[0]*Math.cos(angle)-c.direction[2]*Math.sin(angle),0,c.direction[0]*Math.sin(angle)+c.direction[2]*Math.cos(angle)];
      const ignore=new Set<number>();let end:WeaponPoint=[c.from[0]+d[0]*w.rangeM,c.from[1],c.from[2]+d[2]*w.rangeM],hit=false;
      for(let p=0;p<(this.pierce?w.penetration:1);p++){
        const result=c.world.trace(c.from,d,w.rangeM,ignore);end=result.point;const traceSeq=c.combat.recordTrace(w,c.from,result,c.tick);
        if(!result.actor){
          if(result.nodeId)c.world.damageScene?.(result.nodeId,c.damage,{weaponId:w.id,vfxSequence:traceSeq},'direct',result.surface?.point,result.normal);
          if(result.surface)c.world.solidImpact?.(result,c.from,d,w,c.tick);
          break;
        }
        hit=true;ignore.add(result.actor.id);c.combat.impact(c.weapon,result.actor,c.damage,c.tick,c.world,c.from,result.point);
      }
      c.combat.effect(w,this.pellets?'pellet':this.pierce?'pierce':'shot',c.from,end,c.tick,.12,0,hit);
    }
  }
}
class AreaWeapon implements WeaponImplementation {
  constructor(private flame=false){}
  fire(c:FireContext):void {
    const w=c.weapon,half=w.spreadDeg*Math.PI/360,end:WeaponPoint=[c.from[0]+c.direction[0]*w.rangeM,c.from[1],c.from[2]+c.direction[2]*w.rangeM];let hit=false;
    for(const actor of c.world.actors()){
      const dx=actor.x-c.from[0],dz=actor.z-c.from[2],distance=Math.hypot(dx,dz),point:WeaponPoint=[actor.x,c.from[1],actor.z];
      if(actor.y!==undefined&&(c.from[1]<actor.y||c.from[1]>actor.y+(actor.height??1.8)))continue;
      if(distance>w.rangeM+actor.radius || distance>0 && (dx*c.direction[0]+dz*c.direction[2])/distance<Math.cos(half) || c.world.blocked(c.from,point))continue;
      hit=true;c.combat.impact(w,actor,c.damage,c.tick,c.world,c.from);
    }
    // 火焰/近战同样沿原武器事实作用于场景目标；是否允许由目标 trigger 配置决定。
    for(const s of c.world.sceneTargets?.()??[]){
      const dx=s.position[0]-c.from[0],dz=s.position[2]-c.from[2],distance=Math.hypot(dx,dz);
      if(distance>w.rangeM+s.radius || distance>0 && (dx*c.direction[0]+dz*c.direction[2])/distance<Math.cos(half))continue;
      // 范围目标必须忽略自身 collider，否则目标自己就是“墙”，电锯/火焰永远打不中。
      const contact=sceneContactPoint(s,c.from);
      const blocked=c.world.blockedExcept?.(c.from,contact,s.nodeId) ?? c.world.blocked(c.from,contact);
      if(blocked)continue;
      const seq=c.combat.sceneImpact(w,c.from,s,c.tick,contact);
      const applied=c.world.damageScene?.(s.nodeId,c.damage,{weaponId:w.id,vfxSequence:seq},this.flame?'burn':'direct',contact,undefined)??0;
      if(this.flame&&applied>0)c.combat.applySceneBurn(s.nodeId,w);
      if(applied>0)hit=true;
    }
    c.combat.effect(w,this.flame?'flame':'slash',c.from,end,c.tick,this.flame?.18:.2,w.rangeM,hit);
  }
}
class ProjectileWeapon implements WeaponImplementation {fire(c:FireContext):void {c.combat.launch(c);}}

/** Shared strategy contract. Adding a behavior doesn't duplicate reload/equipment/upgrade state. */
export const WEAPON_IMPLEMENTATIONS:Readonly<Record<WeaponBehavior,WeaponImplementation>>={
  hitscan:new RayWeapon(),pellets:new RayWeapon(true),piercing:new RayWeapon(false,true),projectile:new ProjectileWeapon(),melee:new AreaWeapon(),flame:new AreaWeapon(true),
};

export class WeaponCombat {
  readonly effects:WeaponEffect[]=[];
  private presentationEvents:Readonly<WeaponEffect>[]=[];
  presentationDropped=0;
  drainPresentationEvents():readonly Readonly<WeaponEffect>[] {const events=this.presentationEvents;this.presentationEvents=[];return events;}
  private projectiles:Projectile[]=[];
  private readonly projectilePool=new ObjectPool<Projectile>({capacity:64,maxRetained:64,
    create:()=>({effect:null,definition:null,damage:0,direction:[0,0,0],age:0,travel:0,velocityY:0}),
    onRelease:p=>{p.effect=null;p.definition=null;p.direction.fill(0);p.damage=0;p.age=0;p.travel=0;p.velocityY=0;},
  });
  projectilePoolStats(){return this.projectilePool.getStats();}
  private statuses=new Map<number,Status>();
  /** 场景目标的 burn DOT（key=稳定 NodeId）；由游戏 runtime 的 damageScene 消费。 */
  private sceneStatuses=new Map<string,{until:number;damage:number;weaponId:string}>();
  private sequence=0;
  private now=0;
  private rng:number;
  private vfxSequence=0;
  private vfxEvents:WeaponVfxEvent[]=[];
  vfxDropped=0;
  constructor(seed:number){this.rng=(seed>>>0)||1;}
  private random():number {let x=this.rng;x^=x<<13;x^=x>>>17;x^=x<<5;this.rng=x>>>0;return this.rng/4294967296;}
  canFire(w:WeaponDefinition):boolean {return w.behavior!=='projectile' || this.projectiles.length<64;}
  fire(w:WeaponDefinition,from:WeaponPoint,direction:WeaponPoint,damage:number,tick:number,world:WeaponWorld):void {
    this.recordVfx(w,'fire',from,{actor:null,point:from,distance:0,kind:'miss'},tick);
    WEAPON_IMPLEMENTATIONS[w.behavior].fire({weapon:w,from,direction,damage,tick,world,combat:this,random:()=>this.random()});
  }
  private recordVfx(w:WeaponDefinition,kind:WeaponVfxEvent['kind'],from:WeaponPoint,hit:WeaponHit,tick:number,effectId?:number):number {
    if(this.vfxEvents.length>=2048){this.vfxEvents.shift();this.vfxDropped++;}
    this.vfxEvents.push(Object.freeze({sequence:++this.vfxSequence,tick,weaponId:w.id,kind,...(effectId===undefined?{}:{effectId}),from:Object.freeze([...from]),to:Object.freeze([...hit.point]),contact:hit.kind??(hit.actor?'entity':'miss'),actor:hit.actor?Object.freeze({...hit.actor}):null,nodeId:hit.nodeId??null,normal:hit.normal?Object.freeze([...hit.normal]):null}));
    return this.vfxSequence;
  }
  recordTrace(w:WeaponDefinition,from:WeaponPoint,hit:WeaponHit,tick:number):number {return this.recordVfx(w,'trace',from,hit,tick);}
  /** 场景目标的范围/爆炸命中事实：同一 VFX 序号供 FractureEvent.source 使用。 */
  sceneImpact(w:WeaponDefinition,from:WeaponPoint,target:WeaponSceneTarget,tick:number,point:WeaponPoint=target.position):number {
    return this.recordVfx(w,'impact',from,{actor:null,point,distance:0,kind:'scene',nodeId:target.nodeId},tick);
  }
  /** 记录场景 burn DOT；实际扣血仍由游戏 runtime 的 damageScene 逐 tick 执行。 */
  applySceneBurn(nodeId:string,w:WeaponDefinition):void {
    if(!(w.effects.burnSec>0 && w.effects.burnDps>0))return;
    this.sceneStatuses.set(nodeId,{until:this.now+w.effects.burnSec,damage:w.effects.burnDps,weaponId:w.id});
  }
  blockedFire(w:WeaponDefinition,from:WeaponPoint,hit:WeaponHit,tick:number):void {
    this.recordVfx(w,'fire',from,{actor:null,point:from,distance:0,kind:'miss'},tick);this.recordTrace(w,from,hit,tick);this.effect(w,'shot',from,hit.point,tick,.12,0,false);
  }
  drainVfxEvents():readonly WeaponVfxEvent[] {const events=this.vfxEvents;this.vfxEvents=[];return events;}
  effect(w:WeaponDefinition,kind:WeaponEffect['kind'],from:WeaponPoint,to:WeaponPoint,tick:number,duration:number,radius:number,hit:boolean):WeaponEffect {
    const e:WeaponEffect={id:++this.sequence,tick,weaponId:w.id,kind,from:[...from],to:[...to],position:[...from],duration,radius,spreadDeg:w.spreadDeg,color:w.presentation.color,hit};
    this.effects.push(e);const snapshot=structuredClone(e);Object.freeze(snapshot.from);Object.freeze(snapshot.to);Object.freeze(snapshot.position);if(this.presentationEvents.length>=2048){this.presentationEvents.shift();this.presentationDropped++;}this.presentationEvents.push(Object.freeze(snapshot));return e;
  }
  impact(w:WeaponDefinition,actor:WeaponActor,damage:number,tick:number,world:WeaponWorld,origin:WeaponPoint,contact:WeaponPoint=[actor.x,(actor.y??0)+(actor.height??1.8)*.55,actor.z]):void {
    const vfxSequence=this.recordVfx(w,'impact',origin,{actor,point:contact,distance:0,kind:'entity'},tick);
    world.damage(actor.id,damage,{weaponId:w.id,vfxSequence,origin:[...origin],contact:[...contact]});
    if(w.effects.blastRadiusM>0 && w.behavior!=='projectile')this.explode(w,[actor.x,origin[1],actor.z],damage/2,tick,world,new Set([actor.id]));
    const live=world.actor(actor.id);if(!live || live.generation!==actor.generation || live.hp<=0)return;
    const e=w.effects;
    if(e.knockbackM>0)world.displace(actor.id,origin,e.knockbackM);
    if(e.burnSec>0 || e.slowSec>0){
      const previous=this.statuses.get(actor.id);
      const s=previous?.generation===actor.generation?previous:{id:actor.id,generation:actor.generation,weaponId:w.id,until:0,damage:0,slow:0,slowUntil:0,position:[actor.x,(actor.y??0)+1,actor.z] as WeaponPoint};
      if(e.burnDps>=s.damage)s.weaponId=w.id;
      s.until=Math.max(s.until,this.now+e.burnSec);s.damage=Math.max(s.damage,e.burnDps);s.slow=Math.max(s.slow,e.slowFrac);s.slowUntil=Math.max(s.slowUntil,this.now+e.slowSec);this.statuses.set(actor.id,s);
    }
  }
  private explode(w:WeaponDefinition,point:WeaponPoint,damage:number,tick:number,world:WeaponWorld,ignore=new Set<number>()):void {
    this.effect(w,'explosion',point,point,tick,.4,w.effects.blastRadiusM,true);
    for(const a of world.actors())if(!ignore.has(a.id) && Math.hypot(a.x-point[0],a.y===undefined?0:Math.max(a.y-point[1],point[1]-a.y-(a.height??1.8),0),a.z-point[2])<=w.effects.blastRadiusM+a.radius && !world.blocked(point,[a.x,Math.max(a.y??point[1],Math.min(point[1],(a.y??point[1])+(a.height??1.8))),a.z])){
      const vfxSequence=this.recordVfx(w,'impact',point,{actor:a,point:[a.x,(a.y??0)+(a.height??1.8)*.55,a.z],distance:0,kind:'entity'},tick);
      world.damage(a.id,damage,{weaponId:w.id,vfxSequence,origin:[...point],contact:[a.x,a.y??point[1],a.z]});if(world.actor(a.id))world.displace(a.id,point,w.effects.knockbackM);
    }
    // 场景物体沿用同一爆心/距离/遮挡查询；被墙挡住的 target 不变，忽略目标自身 collider。
    for(const s of world.sceneTargets?.()??[]){
      const clamp=(v:number,min:number|undefined,max:number|undefined)=>Math.max(min??v,Math.min(max??v,v));
      const closest:WeaponPoint=[
        clamp(point[0],s.minX??s.position[0],s.maxX??s.position[0]),
        clamp(point[1],s.minY??s.position[1],s.maxY??s.position[1]),
        clamp(point[2],s.minZ??s.position[2],s.maxZ??s.position[2]),
      ];
      const distance=Math.hypot(closest[0]-point[0],closest[1]-point[1],closest[2]-point[2]);
      // 有 AABB 时 closest 已在目标表面，不能再加一次 radius；无 bounds 才用中心+半径。
      const hasBounds=s.minX!==undefined||s.maxX!==undefined||s.minY!==undefined||s.maxY!==undefined||s.minZ!==undefined||s.maxZ!==undefined;
      if(distance>w.effects.blastRadiusM+(hasBounds?0:s.radius))continue;
      const blocked=world.blockedExcept?.(point,closest,s.nodeId) ?? world.blocked(point,closest);
      if(blocked)continue;
      const seq=this.sceneImpact(w,point,s,tick,closest);
      world.damageScene?.(s.nodeId,damage,{weaponId:w.id,vfxSequence:seq},'explosion',point,undefined);
    }
  }
  launch(c:FireContext):void {
    if(this.projectiles.length>=64)throw new Error('Projectile pool capacity exceeded');
    // 先完成可能失败的外部数据复制，失败时不占用租约或发布半发射特效。
    const definition=structuredClone(c.weapon);
    const end:WeaponPoint=[c.from[0]+c.direction[0]*c.weapon.rangeM,c.from[1],c.from[2]+c.direction[2]*c.weapon.rangeM];
    const effect=this.effect(c.weapon,'projectile',c.from,end,c.tick,c.weapon.projectile.lifetimeSec,c.weapon.projectile.radiusM,false);
    const p=this.projectilePool.acquire();
    p.effect=effect;p.definition=definition;p.damage=c.damage;
    p.direction[0]=c.direction[0];p.direction[1]=c.direction[1];p.direction[2]=c.direction[2];
    p.age=0;p.travel=0;p.velocityY=c.weapon.projectile.launchSpeedY+c.direction[1]*c.weapon.projectile.speedMps;
    this.projectiles.push(p);
    this.recordVfx(c.weapon,'projectile',c.from,{actor:null,point:c.from,distance:0,kind:'miss'},c.tick,effect.id);
  }
  slow(id:number,generation:number):number {const s=this.statuses.get(id);return s?.generation===generation && s.slowUntil>this.now?1-s.slow:1;}
  step(tick:number,dt:number,world:WeaponWorld):void {
    this.now+=dt;
    for(let i=this.effects.length-1;i>=0;i--){const e=this.effects[i]!;if(e.kind!=='projectile' && (tick-e.tick)*dt>=e.duration)this.effects.splice(i,1);}
    for(let i=this.projectiles.length-1;i>=0;i--){
      const p=this.projectiles[i]!,w=p.definition!,from=p.effect!.position,step=Math.min(w.projectile.speedMps*dt,Math.max(0,w.rangeM-p.travel));p.age+=dt;p.travel+=step;p.velocityY-=w.projectile.gravity*dt;
      const next:WeaponPoint=[from[0]+p.direction[0]*step,from[1]+p.velocityY*dt,from[2]+p.direction[2]*step];
      const length=Math.hypot(next[0]-from[0],next[1]-from[1],next[2]-from[2]);const direction:WeaponPoint=length>0?[(next[0]-from[0])/length,(next[1]-from[1])/length,(next[2]-from[2])/length]:[1,0,0];
      const hit=world.trace(from,direction,length,new Set(),w.projectile.radiusM);p.effect!.position=hit.point;
      const impact=!!hit.actor || hit.distance<length-1e-6 || next[1]<=.05 || p.travel>=w.rangeM || p.age>=w.projectile.lifetimeSec;
      if(impact){
        const groundT=next[1]<=.05 && from[1]>.05?(from[1]-.05)/(from[1]-next[1])*length:Infinity;
        p.effect!.position=groundT<hit.distance?[from[0]+direction[0]*groundT,.05,from[2]+direction[2]*groundT]:hit.point;
        if(!hit.actor && hit.distance<length-1e-6)p.effect!.position=[p.effect!.position[0]-direction[0]*.01,p.effect!.position[1]-direction[1]*.01,p.effect!.position[2]-direction[2]*.01];
        this.recordVfx(w,'projectile',from,{...hit,point:[...p.effect!.position]},tick,p.effect!.id);
        const endSeq=this.recordVfx(w,'projectile-end',from,{...hit,point:[...p.effect!.position]},tick,p.effect!.id);
        if(w.effects.blastRadiusM>0)this.explode(w,p.effect!.position,p.damage,tick,world);
        else if(hit.actor)this.impact(w,hit.actor,p.damage,tick,world,from);
        else if(hit.nodeId){
          world.damageScene?.(hit.nodeId,p.damage,{weaponId:w.id,vfxSequence:endSeq},'projectile',[p.effect!.position[0],p.effect!.position[1],p.effect!.position[2]],hit.normal);
          if(hit.surface&&groundT>=hit.distance)world.solidImpact?.(hit,from,direction,w,tick);
        } else if(hit.surface&&groundT>=hit.distance)world.solidImpact?.(hit,from,direction,w,tick);
        this.projectiles.splice(i,1);this.effects.splice(this.effects.indexOf(p.effect!),1);this.projectilePool.release(p);
      }else this.recordVfx(w,'projectile',from,hit,tick,p.effect!.id);
    }
    for(const [id,s] of this.statuses){
      const a=world.actor(id);if(!a || a.generation!==s.generation || a.hp<=0){this.statuses.delete(id);continue;}
      const burnDt=Math.max(0,Math.min(dt,s.until-(this.now-dt)));
      if(burnDt>0 && s.damage>0)world.damage(id,s.damage*burnDt,{weaponId:s.weaponId,damageKind:'burn'});
      if(Math.max(s.until,s.slowUntil)<=this.now)this.statuses.delete(id);
    }
    for(const [nodeId,s] of this.sceneStatuses){
      const applied=world.damageScene?.(nodeId,s.damage*dt,{weaponId:s.weaponId,damageKind:'burn'},'burn')??0;
      if(applied<=0 || s.until<=this.now)this.sceneStatuses.delete(nodeId);
    }
  }
  get burning():ReadonlyArray<{id:number;generation:number;until:number}> {return [...this.statuses.values()].filter(s=>s.until>this.now && s.damage>0);}
  get pendingProjectiles():number{return this.projectiles.length;}
  clear():void {this.effects.length=0;for(const p of this.projectiles)this.projectilePool.release(p);this.projectiles.length=0;this.statuses.clear();this.sceneStatuses.clear();this.vfxEvents=[];this.vfxDropped=0;this.presentationEvents=[];this.presentationDropped=0;}
}
