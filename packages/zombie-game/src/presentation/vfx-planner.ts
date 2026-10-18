import { VfxPool, type VfxPoint,type WeaponVfxEvent } from '@aether/runtime';
import type { VfxAsset, WeaponDefinition } from '@aether/scene';
import type { RuntimeSession } from '../session';

/** Shared with the existing visible weapon: same mount, marker and procedural recoil. */
export function weaponMarkerWorld(runtime:RuntimeSession,marker:'primaryGrip'|'muzzle'|'supportGrip'|'magazine'|'chamber',recoil=true):[number,number,number] {
  const player=runtime.player(),pose=runtime.weapons.poseIntent,p=pose.markers[marker].position;
  const x=p[0]+(recoil?pose.recoil.translation[0]:0),y=p[1]+(recoil?Math.sin(pose.recoil.pitchDeg*Math.PI/180)*p[0]:0),z=p[2];
  const yaw=player?.yaw??0,dx=Math.cos(yaw),dz=Math.sin(yaw);
  return [(player?.x??0)+dx*x-dz*z,runtime.weaponMount.position[1]+y,(player?.z??0)+dz*x+dx*z];
}
export class WeaponVfxPlanner {
  readonly pool=new VfxPool(256);
  private run=-1;
  private tick=0;
  readonly recentEvents:WeaponVfxEvent[]=[];
  /** Only fully resolved weapon resources enter this map; missing keys keep Canvas fallback. */
  readonly ready=new Map<string,VfxAsset>();
  update(runtime:RuntimeSession):void {
    if(this.run!==runtime.runId){this.pool.clear();this.recentEvents.length=0;this.run=runtime.runId;this.tick=runtime.tick;}
    this.pool.advance(Math.max(0,runtime.tick-this.tick)*runtime.fixedStep);this.tick=runtime.tick;
    for(const event of runtime.weaponCombat.drainVfxEvents()){
      this.recentEvents.push(event);if(this.recentEvents.length>32)this.recentEvents.shift();
      const weapon=runtime.weapons.definitions.find(w=>w.id===event.weaponId),asset=this.ready.get(event.weaponId);if(!weapon || !asset)continue;
      const play=(kind:'muzzle'|'trail'|'impact')=>{
        const effect=asset.effects[weapon.presentation.vfx[kind]];if(!effect || effect.kind!==kind)return;
        const age=Math.max(0,runtime.tick-event.tick)*runtime.fixedStep;if(age>=effect.duration)return;
        const p=kind==='muzzle'?weaponMarkerWorld(runtime,'muzzle'):event.from as unknown as VfxPoint;
        const position=kind==='impact'?event.to as unknown as VfxPoint:p;
        const key=`${runtime.runId}:${event.sequence}:${kind}`;
        if(this.pool.spawn({key,effect,position,...(kind==='trail'?{end:event.to as unknown as VfxPoint}:{}),...(kind==='impact' && event.normal?{normal:event.normal as unknown as VfxPoint}:{}),seed:event.sequence,priority:kind==='muzzle'?3:kind==='impact'?2:1})){
          const instance=this.pool.active.find(p=>p.key===key);if(instance)instance.age=age;
        }
      };
      if(event.kind==='fire')play('muzzle');else {play('trail');if(event.contact!=='miss')play('impact');}
    }
    // Flash is attached to the same currently drawn marker while its TTL is alive.
    for(const p of this.pool.active)if(p.effect.kind==='muzzle')p.position=weaponMarkerWorld(runtime,'muzzle');
  }
  usable(w:WeaponDefinition):boolean{return this.ready.has(w.id);}
  clear():void{this.pool.clear();this.ready.clear();this.recentEvents.length=0;this.run=-1;}
}
