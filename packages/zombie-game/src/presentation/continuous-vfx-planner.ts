import {VfxEmitters,type VfxInstance,type WeaponEffect} from '@aether/runtime';
import type {VfxEffectDefinition} from '@aether/scene';
import type {WeaponVfxFrame} from '../weapon-vfx-frames';
import type {RuntimeSession} from '../session';
import type {EnemyAttackEvent} from '../enemy-attacks';
import {type WeaponVfxPlanner} from './vfx-planner';
export const CONTINUOUS_VFX_SLOTS=[['weapon.flame','火焰喷射'],['actor.smoke','燃烧烟尘'],['combat.spark','接触火花'],['enemy.charge.trail','冲锋拖尾'],['combat.melee','近战弧线']] as const;
/** Game facts → generic emitters. No damage, collision, timing or trajectory simulation here. */
export class ContinuousVfxPlanner {
 readonly bindings=new Map<string,VfxEffectDefinition>();readonly emitters:VfxEmitters;
 readonly renderedWeapons=new Set<string>();readonly renderedEnemies=new Set<number>();readonly recent:Readonly<WeaponEffect>[]=[];readonly recentFrames:WeaponVfxFrame[]=[];
 readonly stats={fallback:0,eventDrops:0};private run=-1;private burnHandles=new Set<string>();
 constructor(private readonly weapons:WeaponVfxPlanner){this.emitters=new VfxEmitters(weapons.pool);}
 update(runtime:RuntimeSession,enemyEvents:readonly EnemyAttackEvent[],canDraw:(p:VfxInstance)=>boolean):void {
  if(this.run!==runtime.runId){this.emitters.clear();this.burnHandles.clear();this.recent.length=0;this.recentFrames.length=0;this.run=runtime.runId;}
  const tick=Math.max(0,runtime.tick-1),dt=runtime.fixedStep,keep=new Set<string>();this.renderedWeapons.clear();this.renderedEnemies.clear();this.stats.fallback=0;this.stats.eventDrops=runtime.weaponCombat.presentationDropped+runtime.weaponVfxFrames.dropped;
  const draw=(key:string)=>this.weapons.pool.active.some(p=>(p.key===key || p.key.startsWith('emit:'+key+':')) && canDraw(p));
  const emit=(key:string,tag:string,position:readonly [number,number,number],direction:readonly [number,number,number],at:number,seed:number,priority=1)=>{const effect=this.bindings.get(tag);keep.add(key);if(!effect)return false;this.emitters.update(key,effect,{position,direction},at,dt,seed,priority,tick);return draw(key);};
  const arc=(key:string,from:readonly [number,number,number],to:readonly [number,number,number],radius:number,at:number,seed:number)=>{
   const effect=this.bindings.get('combat.melee');if(!effect)return false;const age=Math.max(0,tick-at)*dt;if(age>=effect.duration)return false;
   if(!this.weapons.pool.active.some(p=>p.key===key)){const direction:[number,number,number]=[to[0]-from[0],0,to[2]-from[2]];this.weapons.pool.spawn({key,effect:{...effect,size:[radius*2,radius*2]},position:from,normal:[0,1,0],direction,seed,priority:3});const p=this.weapons.pool.active.find(p=>p.key===key);if(p)p.age=age;}
   return draw(key);
  };
  const facts=runtime.weaponCombat.drainPresentationEvents();for(const e of facts){this.recent.push(e);if(this.recent.length>32)this.recent.shift();
   if(e.kind==='slash'){
    if(arc(`${runtime.runId}:slash:${e.id}`,e.from,e.to,e.radius,e.tick,e.id))this.renderedWeapons.add(e.weaponId);else this.stats.fallback++;
   }
  }
  for(const frame of runtime.weaponVfxFrames.drain()){
   this.recentFrames.push(frame);if(this.recentFrames.length>64)this.recentFrames.shift();
   for(const h of this.emitters.activeHandles)if(h.key.includes(':flame:') && (!frame.emitting || !h.key.endsWith(':'+frame.weaponId))){this.emitters.stop(h.key);keep.delete(h.key);}
   const key=`${runtime.runId}:flame:${frame.weaponId}`,seed=[...frame.weaponId].reduce((n,c)=>Math.imul(n,31)+c.charCodeAt(0),7)>>>0;
   if(frame.emitting){if(emit(key,'weapon.flame',frame.muzzle,frame.direction,frame.tick,seed,3))this.renderedWeapons.add(frame.weaponId);else this.stats.fallback++;}
   else {this.emitters.stop(key);keep.delete(key);this.renderedWeapons.delete(frame.weaponId);}
   const nextBurn=new Set<string>();for(const s of frame.burning){const key=`${runtime.runId}:burn:${s.id}:${s.generation}`;nextBurn.add(key);emit(key,'actor.smoke',s.position,[0,1,0],frame.tick,s.id^s.generation);}
   for(const key of this.burnHandles)if(!nextBurn.has(key)){this.emitters.stop(key);keep.delete(key);}this.burnHandles=nextBurn;
  }
  for(const key of this.burnHandles)keep.add(key);
  // Paused render frames consume no new facts but retain the live emitter handles.
  for(const h of this.emitters.activeHandles)if(h.key.includes(':flame:') && runtime.weaponCombat.effects.some(e=>e.kind==='flame' && h.key.endsWith(':'+e.weaponId))){keep.add(h.key);if(draw(h.key))this.renderedWeapons.add(runtime.weapons.active.id);}
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
 clear():void{this.emitters.clear();this.bindings.clear();this.renderedWeapons.clear();this.renderedEnemies.clear();this.recent.length=0;this.recentFrames.length=0;this.burnHandles.clear();this.run=-1;}
}
