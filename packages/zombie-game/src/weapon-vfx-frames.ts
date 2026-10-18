import type {RuntimeSession} from './session';
import {lookupCharacterStats} from '@aether/content';
import {weaponMarkerWorld} from './weapon-marker';
export interface WeaponVfxFrame {readonly tick:number;readonly weaponId:string;readonly emitting:boolean;readonly muzzle:readonly [number,number,number];readonly direction:readonly [number,number,number];readonly burning:readonly {readonly id:number;readonly generation:number;readonly position:readonly [number,number,number]}[]}
/** Read-only presentation facts captured after each simulation tick with the same visible marker transform. */
export class WeaponVfxFrames {
 private frames:WeaponVfxFrame[]=[];private active=false;dropped=0;
 capture(r:RuntimeSession):void {
  const w=r.weapons.active,e=[...r.weaponCombat.effects].reverse().find(e=>e.kind==='flame' && e.weaponId===w.id),p=r.player();if(!p)return;
  const statuses=r.weaponCombat.burning,emitting=w.behavior==='flame' && !!e && p.alive;if(!emitting && !statuses.length && !this.active)return;this.active=emitting || statuses.length>0;
  const muzzle=weaponMarkerWorld(r,'muzzle'),direction:[number,number,number]=e?[e.to[0]-e.from[0],0,e.to[2]-e.from[2]]:[Math.cos(p.yaw),0,Math.sin(p.yaw)];
  const actors=statuses.length?r.view():[],burning=statuses.flatMap(s=>{const actor=actors.find(a=>a.id===s.id && a.generation===s.generation && a.alive);if(!actor)return [];return [Object.freeze({id:s.id,generation:s.generation,position:Object.freeze([actor.x,(lookupCharacterStats(actor.characterId)?.capsuleHeight??0)/2,actor.z] as [number,number,number])})];});
  if(this.frames.length>=2048){this.frames.shift();this.dropped++;}this.frames.push(Object.freeze({tick:r.tick,weaponId:w.id,emitting,muzzle:Object.freeze(muzzle),direction:Object.freeze(direction),burning:Object.freeze(burning)}));
 }
 drain():readonly WeaponVfxFrame[]{const frames=this.frames;this.frames=[];return frames;}
 clear(){this.frames=[];this.active=false;this.dropped=0;}
}
