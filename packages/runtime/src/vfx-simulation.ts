import type {VfxEffectDefinition} from '@aether/scene';
import type {VfxAnchor} from './vfx-emitter';

export const GPU_VFX_PARTICLES=4096, GPU_VFX_HANDLES=16, GPU_VFX_PER_EMITTER=1024;
/** 3 vec4 (48 bytes): position/age, velocity/life, serial/rotation/live/reserved. */
export const VFX_STATE_FLOATS=12;
export interface VfxSimulationInput {effect:VfxEffectDefinition;anchor:VfxAnchor;seed:number;step:number}
export function vfxRandom(bits:number):number {bits^=bits<<13;bits^=bits>>>17;bits^=bits<<5;return bits>>>0;}
export function vfxBirthCount(tick:number,step:number,rate:number):number {return Math.floor(Math.fround(Math.fround(Math.fround(tick+1)*Math.fround(step))*Math.fround(rate))+.0001);}

/** CPU oracle only. Production GPU playback never reads this array back each frame. */
export class VfxSimulationReference {
 readonly state:Float32Array;readonly ids:Uint32Array;
 readonly stats={spawned:0,dropped:0,expired:0,alive:0};tick=-1;
 constructor(readonly input:VfxSimulationInput){this.state=new Float32Array(input.effect.emission!.maxParticles*VFX_STATE_FLOATS);this.ids=new Uint32Array(this.state.buffer);}
 advance(target:number,emitting=true):void {
  if(!Number.isInteger(target) || target<this.tick || target>10000000 || target-this.tick>240)throw new Error('VFX simulation clock: reversed/overflow');
  const {effect:e,anchor,seed,step}=this.input,em=e.emission!,dt=Math.fround(step),acc=em.acceleration??[0,0,0],d=anchor.direction??[0,1,0],length=Math.hypot(...d)||1;
  for(let t=this.tick+1;t<=target;t++)for(let slot=0;slot<em.maxParticles;slot++){
   const o=slot*12,s=this.state,u=this.ids;
   if(u[o+10]){s[o+3]=Math.fround(s[o+3]!+dt);if(s[o+3]!+1e-6>=e.duration){u[o+10]=0;this.stats.alive--;this.stats.expired++;}else for(let k=0;k<3;k++){s[o+4+k]=Math.fround(s[o+4+k]!+Math.fround(acc[k]!*dt));s[o+k]=Math.fround(s[o+k]!+Math.fround(s[o+4+k]!*dt));}}
   if(!emitting)continue;const before=t===0?0:vfxBirthCount(t-1,step,em.rate),last=vfxBirthCount(t,step,em.rate),first=before+1+((slot-(before%em.maxParticles)+em.maxParticles)%em.maxParticles);
   if(first>last)continue;const births=Math.floor((last-first)/em.maxParticles)+1,serial=first+(births-1)*em.maxParticles;
   this.stats.spawned+=births;this.stats.dropped+=births-(u[o+10]?0:1);if(!u[o+10])this.stats.alive++;
   const bits=vfxRandom((seed^Math.imul(serial,0x9e3779b1))>>>0),angle=(bits/4294967296-.5)*em.spreadDeg*Math.PI/180,c=Math.cos(angle),sn=Math.sin(angle);
   s.set([...anchor.position,0,(d[0]*c-d[2]*sn)/length*em.speed,d[1]/length*em.speed,(d[0]*sn+d[2]*c)/length*em.speed,e.duration],o);
   u[o+8]=serial;u[o+9]=vfxRandom(bits)%6283;u[o+10]=1;
  }
  this.tick=target;
 }
}
