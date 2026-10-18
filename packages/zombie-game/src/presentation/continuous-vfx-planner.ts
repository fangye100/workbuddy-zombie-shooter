import {VfxEmitters,type VfxInstance,type WeaponEffect} from '@aether/runtime';
import type {VfxEffectDefinition} from '@aether/scene';
import {lookupCharacterStats} from '@aether/content';
import type {RuntimeSession} from '../session';
import type {EnemyAttackEvent} from '../enemy-attacks';
import {weaponMarkerWorld,type WeaponVfxPlanner} from './vfx-planner';
export const CONTINUOUS_VFX_SLOTS=[['weapon.flame','火焰喷射'],['actor.smoke','燃烧烟尘'],['combat.spark','接触火花'],['enemy.charge.trail','冲锋拖尾'],['combat.melee','近战弧线']] as const;
/** Game facts → generic emitters. No damage, collision, timing or trajectory simulation here. */
export class ContinuousVfxPlanner {
 readonly bindings=new Map<string,VfxEffectDefinition>();readonly emitters:VfxEmitters;
 readonly renderedWeapons=new Set<string>();readonly renderedEnemies=new Set<number>();readonly recent:Readonly<WeaponEffect>[]=[];
 readonly stats={fallback:0,eventDrops:0};private run=-1;private flameUntil=new Map<string,number>();
 constructor(private readonly weapons:WeaponVfxPlanner){this.emitters=new VfxEmitters(weapons.pool);}
 update(runtime:RuntimeSession,enemyEvents:readonly EnemyAttackEvent[],canDraw:(p:VfxInstance)=>boolean):void {
  if(this.run!==runtime.runId){this.emitters.clear();this.flameUntil.clear();this.recent.length=0;this.run=runtime.runId;}
  const tick=Math.max(0,runtime.tick-1),dt=runtime.fixedStep,keep=new Set<string>();this.renderedWeapons.clear();this.renderedEnemies.clear();this.stats.fallback=0;this.stats.eventDrops=runtime.weaponCombat.presentationDropped;
  const draw=(key:string)=>this.weapons.pool.active.some(p=>(p.key===key || p.key.startsWith('emit:'+key+':')) && canDraw(p));
  const emit=(key:string,tag:string,position:readonly [number,number,number],direction:readonly [number,number,number],at:number,seed:number,priority=1)=>{const effect=this.bindings.get(tag);keep.add(key);if(!effect)return false;this.emitters.update(key,effect,{position,direction},at,dt,seed,priority,tick);return draw(key);};
  const arc=(key:string,from:readonly [number,number,number],to:readonly [number,number,number],radius:number,at:number,seed:number)=>{
   const effect=this.bindings.get('combat.melee');if(!effect)return false;const age=Math.max(0,tick-at)*dt;if(age>=effect.duration)return false;
   if(!this.weapons.pool.active.some(p=>p.key===key)){const direction:[number,number,number]=[to[0]-from[0],0,to[2]-from[2]];this.weapons.pool.spawn({key,effect:{...effect,size:[radius*2,radius*2]},position:from,normal:[0,1,0],direction,seed,priority:3});const p=this.weapons.pool.active.find(p=>p.key===key);if(p)p.age=age;}
   return draw(key);
  };
  const facts=runtime.weaponCombat.drainPresentationEvents();for(const e of facts){this.recent.push(e);if(this.recent.length>32)this.recent.shift();
   if(e.kind==='flame'){
    const key=`${runtime.runId}:flame:${e.weaponId}`,muzzle=weaponMarkerWorld(runtime,'muzzle');this.flameUntil.set(e.weaponId,e.tick+Math.ceil(e.duration/dt));
    const direction:[number,number,number]=[e.to[0]-e.from[0],0,e.to[2]-e.from[2]];
    if(emit(key,'weapon.flame',muzzle,direction,e.tick,e.id,3))this.renderedWeapons.add(e.weaponId);else this.stats.fallback++;
   }else if(e.kind==='slash'){
    if(arc(`${runtime.runId}:slash:${e.id}`,e.from,e.to,e.radius,e.tick,e.id))this.renderedWeapons.add(e.weaponId);else this.stats.fallback++;
   }
  }
  for(const [id,until] of this.flameUntil){if(tick>=until || runtime.weapons.active.id!==id){this.flameUntil.delete(id);continue;}const key=`${runtime.runId}:flame:${id}`,p=runtime.player();if(!p?.alive)continue;
   if(emit(key,'weapon.flame',weaponMarkerWorld(runtime,'muzzle'),[Math.cos(p.yaw),0,Math.sin(p.yaw)],tick,1,3))this.renderedWeapons.add(id);else this.stats.fallback++;
  }
  for(const status of runtime.weaponCombat.burning){const actor=runtime.view().find(a=>a.id===status.id && a.generation===status.generation && a.alive);if(!actor)continue;const height=lookupCharacterStats(actor.characterId)?.capsuleHeight??0;
   emit(`${runtime.runId}:burn:${actor.id}:${actor.generation}`,'actor.smoke',[actor.x,height/2,actor.z],[0,1,0],tick,actor.id^actor.generation);
  }
  for(const event of this.weapons.frameEvents)if(event.kind==='trace' && event.contact!=='miss')emit(`${runtime.runId}:spark:${event.sequence}`,'combat.spark',event.to as [number,number,number],event.normal as [number,number,number]??[0,1,0],event.tick,event.sequence,2);
  for(const event of enemyEvents){const e=event.effect,key=`${runtime.runId}:charge:${e.id}`;
   if(e.kind==='charge' && event.type==='move'){if(emit(key,'enemy.charge.trail',e.position,[0,1,0],event.tick,e.id))this.renderedEnemies.add(e.id);else this.stats.fallback++;}
   if(e.kind==='charge' && event.type==='end')this.emitters.stop(key);
   if(e.kind==='melee' && event.type==='spawn' && arc(`${runtime.runId}:enemy-melee:${e.id}`,e.from,e.to,e.radius,event.tick,e.id))this.renderedEnemies.add(e.id);
  }
  // Existing slash remains drawable until its real presentation TTL; no repeated spawn on paused frames.
  for(const p of this.weapons.pool.active)if(p.key.startsWith(`${runtime.runId}:slash:`) && canDraw(p)){const e=this.recent.find(e=>p.key.endsWith(':'+e.id));if(e)this.renderedWeapons.add(e.weaponId);}
  for(const e of runtime.enemyAttacks.effects)if(e.kind==='melee' && draw(`${runtime.runId}:enemy-melee:${e.id}`))this.renderedEnemies.add(e.id);
  for(const e of runtime.enemyAttacks.effects)if(e.kind==='charge' && !e.finished){const key=`${runtime.runId}:charge:${e.id}`;keep.add(key);if(draw(key))this.renderedEnemies.add(e.id);}
  this.emitters.stopExcept(keep);
 }
 clear():void{this.emitters.clear();this.bindings.clear();this.renderedWeapons.clear();this.renderedEnemies.clear();this.recent.length=0;this.flameUntil.clear();this.run=-1;}
}
