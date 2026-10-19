import { VfxPool, type VfxPoint,type WeaponVfxEvent,type VfxInstance } from '@aether/runtime';
import type { VfxAsset, WeaponDefinition,VfxEffectDefinition } from '@aether/scene';
import {lookupCharacterStats} from '@aether/content';
import type { RuntimeSession, CombatEvent } from '../session';

export {weaponMarkerWorld} from '../weapon-marker';
import {weaponMarkerWorld} from '../weapon-marker';
export class WeaponVfxPlanner {
  readonly pool=new VfxPool(256);
  private run=-1;
  private tick=0;
  private combatCursor=0;
  private impactAliases=new Map<number,{sequence:number;event:WeaponVfxEvent}>();
  private combatKeys=new WeakMap<CombatEvent,string>();
  private damageHandles=new Map<string,{tick:number;key:string}>();
  damageEffect:VfxEffectDefinition|null=null;
  readonly damageStats={spawned:0,coalesced:0,fallback:0};
  frameEvents:readonly WeaponVfxEvent[]=[];
  readonly recentEvents:WeaponVfxEvent[]=[];
  /** Only fully resolved weapon resources enter this map; missing keys keep Canvas fallback. */
  readonly ready=new Map<string,VfxAsset>();
  readonly fallbackWeapons=new Set<string>();private fallbackUntil=new Map<string,number>();
  update(runtime:RuntimeSession,canDraw:(p:VfxInstance)=>boolean=()=>true):void {
    if(this.run!==runtime.runId){this.pool.clear();this.recentEvents.length=0;this.fallbackWeapons.clear();this.fallbackUntil.clear();this.combatCursor=0;this.combatKeys=new WeakMap();this.damageHandles.clear();this.impactAliases.clear();this.run=runtime.runId;this.tick=runtime.tick;}
    this.pool.advance(Math.max(0,runtime.tick-this.tick)*runtime.fixedStep);this.tick=runtime.tick;
    for(const [id,until] of this.fallbackUntil)if(runtime.tick>=until){this.fallbackUntil.delete(id);this.fallbackWeapons.delete(id);}
    this.frameEvents=runtime.weaponCombat.drainVfxEvents();
    const traceContacts=new Map<string,WeaponVfxEvent>();
    const contactKey=(e:WeaponVfxEvent)=>`${e.tick}:${e.weaponId}:${e.actor?.id}:${e.actor?.generation}`;
    for(const event of this.frameEvents){
      this.recentEvents.push(event);if(this.recentEvents.length>32)this.recentEvents.shift();
      const weapon=runtime.weapons.definitions.find(w=>w.id===event.weaponId),asset=this.ready.get(event.weaponId);if(!weapon || !asset)continue;
      const play=(kind:'muzzle'|'trail'|'impact')=>{
        const effect=asset.effects[weapon.presentation.vfx[kind]];if(!effect || effect.kind!==kind)return;
        const age=Math.max(0,runtime.tick-event.tick)*runtime.fixedStep;if(age>=effect.duration)return;
        const p=kind==='muzzle'?weaponMarkerWorld(runtime,'muzzle'):event.from as unknown as VfxPoint;
        const position=kind==='impact'?event.to as unknown as VfxPoint:p;
        const key=`${runtime.runId}:${event.sequence}:${kind}`;
        const request={key,effect,position,...(kind==='trail'?{end:event.to as unknown as VfxPoint}:{}),...(kind==='impact' && event.normal?{normal:event.normal as unknown as VfxPoint}:{}),seed:event.sequence,priority:kind==='muzzle'?3:kind==='impact'?2:1};
        if(!canDraw({...request,age}) || !this.pool.spawn(request)){this.fallbackWeapons.add(weapon.id);this.fallbackUntil.set(weapon.id,runtime.tick+Math.ceil(effect.duration/runtime.fixedStep));return;}
        {
          const instance=this.pool.active.find(p=>p.key===key);if(instance)instance.age=age;
        }
      };
      if(event.kind==='fire'){if(weapon.behavior!=='melee')play('muzzle');}
      else if(event.kind==='trace'){play('trail');if(event.contact!=='miss')play('impact');if(event.actor)traceContacts.set(contactKey(event),event);}
      else if(event.kind==='impact'){
        const trace=traceContacts.get(contactKey(event));
        this.impactAliases.set(event.sequence,{sequence:trace?.sequence??event.sequence,event});if(this.impactAliases.size>4096)this.impactAliases.delete(this.impactAliases.keys().next().value!);if(!trace)play('impact');
      }
    }
    // Flash is attached to the same currently drawn marker while its TTL is alive.
    for(const p of this.pool.active)if(p.effect.kind==='muzzle')p.position=weaponMarkerWorld(runtime,'muzzle');
    // All damage sources use the existing authoritative buffer. Per-weapon contacts above
    // retain their authored impact; burn/environment/secondary damage get the shared burst.
    if(runtime.combatEvents.length<this.combatCursor)this.combatCursor=0;
    for(const [id,h] of this.damageHandles)if(!this.pool.active.some(p=>p.key===h.key))this.damageHandles.delete(id);
    for(;this.combatCursor<runtime.combatEvents.length;this.combatCursor++){
      const event=runtime.combatEvents[this.combatCursor]!;
      if(event.runId!==this.run || event.slot===runtime.playerEntityId || this.impactReady(event,canDraw))continue;
      const effect=this.damageEffect,age=Math.max(0,runtime.tick-event.tick)*runtime.fixedStep;
      if(!effect || age>=effect.duration || event.x===undefined || event.z===undefined)continue;
      const identity=`${event.runId}:${event.slot}:${event.generation}`,previous=this.damageHandles.get(identity);
      if(previous && event.tick-previous.tick<3 && this.pool.active.some(p=>p.key===previous.key && canDraw(p))){this.combatKeys.set(event,previous.key);this.damageStats.coalesced++;continue;}
      const key=`${identity}:damage:${this.combatCursor}`,position:VfxPoint=[event.x,(event.y??0)+(lookupCharacterStats(event.characterId)?.capsuleHeight??1.8)*.55,event.z];
      const request={key,effect,position,seed:event.slot^event.tick,priority:4};
      if(canDraw({...request,age}) && this.pool.spawn(request)){this.pool.active.find(p=>p.key===key)!.age=age;this.combatKeys.set(event,key);this.damageHandles.set(identity,{tick:event.tick,key});this.damageStats.spawned++;}else this.damageStats.fallback++;
    }
  }
  usable(w:WeaponDefinition):boolean{return this.ready.has(w.id);}
  /** Suppress only a burst with a matching live GPU hit; damage labels remain HUD feedback. */
  impactReady(event:CombatEvent,canDraw:(p:VfxInstance)=>boolean):boolean {
    const key=this.combatKeys.get(event);if(event.runId===this.run && key && this.pool.active.some(p=>p.key===key && canDraw(p)))return true;
    if(event.weaponEvent!==undefined){const a=this.impactAliases.get(event.weaponEvent);return event.runId===this.run && !!a && a.event.tick===event.tick && a.event.weaponId===event.weaponId && a.event.actor?.id===event.slot && a.event.actor?.generation===event.generation && this.pool.active.some(p=>p.key===`${this.run}:${a.sequence}:impact` && canDraw(p));}
    return event.runId===this.run && this.recentEvents.some(e=>(e.kind==='trace' || e.kind==='impact') && e.contact==='entity' && e.tick===event.tick && e.actor?.id===event.slot && e.actor.generation===event.generation && this.pool.active.some(p=>p.key===`${this.run}:${e.sequence}:impact` && canDraw(p)));
  }
  clear():void{this.pool.clear();this.ready.clear();this.recentEvents.length=0;this.frameEvents=[];this.fallbackWeapons.clear();this.fallbackUntil.clear();this.combatCursor=0;this.combatKeys=new WeakMap();this.damageHandles.clear();this.impactAliases.clear();this.damageEffect=null;this.damageStats.spawned=this.damageStats.coalesced=this.damageStats.fallback=0;this.run=-1;}
}
