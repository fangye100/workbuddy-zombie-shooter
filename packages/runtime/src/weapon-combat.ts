import type { WeaponDefinition, WeaponBehavior } from '@aether/scene';
export type WeaponPoint=[number,number,number];
export interface WeaponActor { id:number;generation:number;x:number;y?:number;height?:number;z:number;radius:number;hp:number }
export interface WeaponHit { actor:WeaponActor|null; point:WeaponPoint; distance:number }
export interface WeaponWorld {
  actors():WeaponActor[]; actor(id:number):WeaponActor|null;
  trace(from:WeaponPoint,direction:WeaponPoint,range:number,ignore:ReadonlySet<number>,radius?:number):WeaponHit;
  blocked(from:WeaponPoint,to:WeaponPoint):boolean;
  damage(id:number,damage:number):number;
  displace(id:number,from:WeaponPoint,distance:number):void;
}
export interface WeaponEffect { id:number;tick:number;weaponId:string;kind:'shot'|'pellet'|'pierce'|'projectile'|'explosion'|'slash'|'flame'|'burn';from:WeaponPoint;to:WeaponPoint;position:WeaponPoint;duration:number;radius:number;spreadDeg:number;color:string;hit:boolean }
interface Projectile {effect:WeaponEffect;definition:WeaponDefinition;damage:number;direction:WeaponPoint;age:number;travel:number;velocityY:number}
interface Status {id:number;generation:number;until:number;damage:number;slow:number;slowUntil:number;position:WeaponPoint}
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
        const result=c.world.trace(c.from,d,w.rangeM,ignore);end=result.point;if(!result.actor)break;
        hit=true;ignore.add(result.actor.id);c.combat.impact(c.weapon,result.actor,c.damage,c.tick,c.world,c.from);
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
  private projectiles:Projectile[]=[];
  private statuses=new Map<number,Status>();
  private sequence=0;
  private now=0;
  private rng:number;
  constructor(seed:number){this.rng=(seed>>>0)||1;}
  private random():number {let x=this.rng;x^=x<<13;x^=x>>>17;x^=x<<5;this.rng=x>>>0;return this.rng/4294967296;}
  canFire(w:WeaponDefinition):boolean {return w.behavior!=='projectile' || this.projectiles.length<64;}
  fire(w:WeaponDefinition,from:WeaponPoint,direction:WeaponPoint,damage:number,tick:number,world:WeaponWorld):void {
    WEAPON_IMPLEMENTATIONS[w.behavior].fire({weapon:w,from,direction,damage,tick,world,combat:this,random:()=>this.random()});
  }
  effect(w:WeaponDefinition,kind:WeaponEffect['kind'],from:WeaponPoint,to:WeaponPoint,tick:number,duration:number,radius:number,hit:boolean):WeaponEffect {
    const e:WeaponEffect={id:++this.sequence,tick,weaponId:w.id,kind,from:[...from],to:[...to],position:[...from],duration,radius,spreadDeg:w.spreadDeg,color:w.presentation.color,hit};
    this.effects.push(e);return e;
  }
  impact(w:WeaponDefinition,actor:WeaponActor,damage:number,tick:number,world:WeaponWorld,origin:WeaponPoint):void {
    world.damage(actor.id,damage);
    if(w.effects.blastRadiusM>0 && w.behavior!=='projectile')this.explode(w,[actor.x,origin[1],actor.z],damage/2,tick,world,new Set([actor.id]));
    const live=world.actor(actor.id);if(!live || live.generation!==actor.generation || live.hp<=0)return;
    const e=w.effects;
    if(e.knockbackM>0)world.displace(actor.id,origin,e.knockbackM);
    if(e.burnSec>0 || e.slowSec>0){
      const previous=this.statuses.get(actor.id);
      const s=previous?.generation===actor.generation?previous:{id:actor.id,generation:actor.generation,until:0,damage:0,slow:0,slowUntil:0,position:[actor.x,(actor.y??0)+1,actor.z] as WeaponPoint};
      s.until=Math.max(s.until,this.now+e.burnSec);s.damage=Math.max(s.damage,e.burnDps);s.slow=Math.max(s.slow,e.slowFrac);s.slowUntil=Math.max(s.slowUntil,this.now+e.slowSec);this.statuses.set(actor.id,s);
    }
  }
  private explode(w:WeaponDefinition,point:WeaponPoint,damage:number,tick:number,world:WeaponWorld,ignore=new Set<number>()):void {
    this.effect(w,'explosion',point,point,tick,.4,w.effects.blastRadiusM,true);
    for(const a of world.actors())if(!ignore.has(a.id) && Math.hypot(a.x-point[0],a.y===undefined?0:Math.max(a.y-point[1],point[1]-a.y-(a.height??1.8),0),a.z-point[2])<=w.effects.blastRadiusM+a.radius && !world.blocked(point,[a.x,Math.max(a.y??point[1],Math.min(point[1],(a.y??point[1])+(a.height??1.8))),a.z])){
      world.damage(a.id,damage);if(world.actor(a.id))world.displace(a.id,point,w.effects.knockbackM);
    }
  }
  launch(c:FireContext):void {
    if(this.projectiles.length>=64)throw new Error('Projectile pool capacity exceeded');
    const end:WeaponPoint=[c.from[0]+c.direction[0]*c.weapon.rangeM,c.from[1],c.from[2]+c.direction[2]*c.weapon.rangeM];
    const effect=this.effect(c.weapon,'projectile',c.from,end,c.tick,c.weapon.projectile.lifetimeSec,c.weapon.projectile.radiusM,false);
    this.projectiles.push({effect,definition:structuredClone(c.weapon),damage:c.damage,direction:[...c.direction],age:0,travel:0,velocityY:c.weapon.projectile.launchSpeedY+c.direction[1]*c.weapon.projectile.speedMps});
  }
  slow(id:number,generation:number):number {const s=this.statuses.get(id);return s?.generation===generation && s.slowUntil>this.now?1-s.slow:1;}
  step(tick:number,dt:number,world:WeaponWorld):void {
    this.now+=dt;
    for(let i=this.effects.length-1;i>=0;i--){const e=this.effects[i]!;if(e.kind!=='projectile' && (tick-e.tick)*dt>=e.duration)this.effects.splice(i,1);}
    for(let i=this.projectiles.length-1;i>=0;i--){
      const p=this.projectiles[i]!,w=p.definition,from=p.effect.position,step=Math.min(w.projectile.speedMps*dt,Math.max(0,w.rangeM-p.travel));p.age+=dt;p.travel+=step;p.velocityY-=w.projectile.gravity*dt;
      const next:WeaponPoint=[from[0]+p.direction[0]*step,from[1]+p.velocityY*dt,from[2]+p.direction[2]*step];
      const length=Math.hypot(next[0]-from[0],next[1]-from[1],next[2]-from[2]);const direction:WeaponPoint=length>0?[(next[0]-from[0])/length,(next[1]-from[1])/length,(next[2]-from[2])/length]:[1,0,0];
      const hit=world.trace(from,direction,length,new Set(),w.projectile.radiusM);p.effect.position=hit.point;
      const impact=!!hit.actor || hit.distance<length-1e-6 || next[1]<=.05 || p.travel>=w.rangeM || p.age>=w.projectile.lifetimeSec;
      if(impact){
        const groundT=next[1]<=.05 && from[1]>.05?(from[1]-.05)/(from[1]-next[1])*length:Infinity;
        p.effect.position=groundT<hit.distance?[from[0]+direction[0]*groundT,.05,from[2]+direction[2]*groundT]:hit.point;
        if(!hit.actor && hit.distance<length-1e-6)p.effect.position=[p.effect.position[0]-direction[0]*.01,p.effect.position[1]-direction[1]*.01,p.effect.position[2]-direction[2]*.01];
        if(w.effects.blastRadiusM>0)this.explode(w,p.effect.position,p.damage,tick,world);
        else if(hit.actor)this.impact(w,hit.actor,p.damage,tick,world,from);
        this.projectiles.splice(i,1);this.effects.splice(this.effects.indexOf(p.effect),1);
      }
    }
    for(const [id,s] of this.statuses){
      const a=world.actor(id);if(!a || a.generation!==s.generation || a.hp<=0){this.statuses.delete(id);continue;}
      const burnDt=Math.max(0,Math.min(dt,s.until-(this.now-dt)));
      if(burnDt>0 && s.damage>0)world.damage(id,s.damage*burnDt);
      if(Math.max(s.until,s.slowUntil)<=this.now)this.statuses.delete(id);
    }
  }
  get burning():ReadonlyArray<{id:number;generation:number;until:number}> {return [...this.statuses.values()].filter(s=>s.until>this.now && s.damage>0);}
  get pendingProjectiles():number{return this.projectiles.length;}
  clear():void {this.effects.length=0;this.projectiles.length=0;this.statuses.clear();}
}
