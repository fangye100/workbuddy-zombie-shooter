import { VfxPool, type VfxPoint,type WeaponVfxEvent,type VfxInstance } from '@aether/runtime';
import type { VfxAsset, WeaponDefinition } from '@aether/scene';
import type { RuntimeSession, CombatEvent } from '../session';

export {weaponMarkerWorld} from '../weapon-marker';
import {weaponMarkerWorld} from '../weapon-marker';
export class WeaponVfxPlanner {
  readonly pool=new VfxPool(256);
  private run=-1;
  private tick=0;
  frameEvents:readonly WeaponVfxEvent[]=[];
  readonly recentEvents:WeaponVfxEvent[]=[];
  /** Only fully resolved weapon resources enter this map; missing keys keep Canvas fallback. */
  readonly ready=new Map<string,VfxAsset>();
  readonly fallbackWeapons=new Set<string>();private fallbackUntil=new Map<string,number>();
  update(runtime:RuntimeSession,canDraw:(p:VfxInstance)=>boolean=()=>true):void {
    if(this.run!==runtime.runId){this.pool.clear();this.recentEvents.length=0;this.fallbackWeapons.clear();this.fallbackUntil.clear();this.run=runtime.runId;this.tick=runtime.tick;}
    this.pool.advance(Math.max(0,runtime.tick-this.tick)*runtime.fixedStep);this.tick=runtime.tick;
    for(const [id,until] of this.fallbackUntil)if(runtime.tick>=until){this.fallbackUntil.delete(id);this.fallbackWeapons.delete(id);}
    this.frameEvents=runtime.weaponCombat.drainVfxEvents();
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
      else if(event.kind==='trace'){play('trail');if(event.contact!=='miss')play('impact');}
      else if(event.kind==='impact' && !this.frameEvents.some(e=>e.kind==='trace' && e.weaponId===event.weaponId && e.tick===event.tick && e.actor?.id===event.actor?.id && e.actor?.generation===event.actor?.generation))play('impact');
    }
    // Flash is attached to the same currently drawn marker while its TTL is alive.
    for(const p of this.pool.active)if(p.effect.kind==='muzzle')p.position=weaponMarkerWorld(runtime,'muzzle');
  }
  usable(w:WeaponDefinition):boolean{return this.ready.has(w.id);}
  /** Suppress only a burst with a matching live GPU hit; damage labels remain HUD feedback. */
  impactReady(event:CombatEvent,canDraw:(p:VfxInstance)=>boolean):boolean {
    return event.runId===this.run && this.recentEvents.some(e=>(e.kind==='trace' || e.kind==='impact') && e.contact==='entity' && e.tick===event.tick && e.actor?.id===event.slot && e.actor.generation===event.generation && this.pool.active.some(p=>p.key===`${this.run}:${e.sequence}:impact` && canDraw(p)));
  }
  clear():void{this.pool.clear();this.ready.clear();this.recentEvents.length=0;this.frameEvents=[];this.fallbackWeapons.clear();this.fallbackUntil.clear();this.run=-1;}
}
