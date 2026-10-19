import type {RuntimeSession} from './session';
import {lookupCharacterStats} from '@aether/content';
export interface MotionVfxFrame {readonly runId:number;readonly tick:number;readonly id:number;readonly generation:number;readonly alive:boolean;readonly position:readonly [number,number,number]}
/** Player presentation motion captured at each real fixed tick, independent of weapon effects. */
export class MotionVfxFrames {
 private frames:MotionVfxFrame[]=[];private last:MotionVfxFrame|null=null;dropped=0;
 capture(r:RuntimeSession){const p=r.player();if(!p && !this.last)return;const position=p?[p.x,(lookupCharacterStats(p.characterId)?.capsuleHeight??0)/2,p.z] as [number,number,number]:[...this.last!.position] as [number,number,number],frame=Object.freeze({runId:r.runId,tick:r.tick,id:p?.id??this.last!.id,generation:p?.generation??this.last!.generation,alive:!!p,position:Object.freeze(position)});if(this.frames.length>=2048){this.frames.shift();this.dropped++;}this.frames.push(frame);this.last=p?frame:null;}
 drain():readonly MotionVfxFrame[]{const frames=this.frames;this.frames=[];return frames;}
 clear(){this.frames=[];this.last=null;this.dropped=0;}
}
