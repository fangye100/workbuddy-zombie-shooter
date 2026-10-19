import type {VfxEffectDefinition,VfxMotion} from '@aether/scene';
import type {VfxPoint} from './vfx';
export const RIBBON_HANDLES=32,RIBBON_POINTS=2048;
export interface RibbonSample {position:VfxPoint;tick:number;age:number;distance:number;breakBefore:boolean}
export interface RibbonTrail {key:string;epoch:number;effect:VfxEffectDefinition;points:RibbonSample[];playing:boolean;lastTick:number;distance:number;gap:boolean}
/** Simulation-time history only. No renderer, gameplay motion, GPU or wall clock. */
export class RibbonHistory {
 private readonly trails=new Map<string,RibbonTrail>();private epoch=0;private tick=-1;
 readonly stats={appended:0,degenerate:0,skipped:0,breaks:0,clipped:0,expired:0,pointOverflow:0,handleOverflow:0,started:0,stopped:0,restarted:0};
 constructor(readonly handleCapacity=RIBBON_HANDLES,readonly pointCapacity=RIBBON_POINTS){}
 get active():readonly RibbonTrail[]{return [...this.trails.values()].filter(t=>t.points.length>1);}
 get pointCount(){return [...this.trails.values()].reduce((n,t)=>n+t.points.length,0);}
 advance(tick:number,step:number){if(!Number.isInteger(tick) || tick<this.tick || !Number.isFinite(step) || step<=0)throw new Error('Ribbon clock');this.tick=tick;
  for(const t of this.trails.values()){for(const p of t.points)p.age=Math.max(0,tick-p.tick)*step;const before=t.points.length;t.points=t.points.filter(p=>p.age+1e-9<t.effect.duration);this.stats.expired+=before-t.points.length;if(t.points[0])t.points[0].breakBefore=true;}
 }
 push(key:string,effect:VfxEffectDefinition,position:VfxPoint,tick:number,step:number,nowTick=tick):boolean {
  if(effect.kind!=='ribbon' || !effect.ribbon)throw new Error('Ribbon definition');if(position.length!==3 || !position.every(Number.isFinite) || tick>nowTick || !Number.isInteger(tick))throw new Error('Ribbon sample');this.advance(nowTick,step);
  let t=this.trails.get(key);if(!t){if(this.trails.size>=this.handleCapacity){const idle=[...this.trails.values()].find(t=>!t.playing && !t.points.length);if(idle)this.trails.delete(idle.key);else{this.stats.handleOverflow++;return false;}}t={key,epoch:0,effect:structuredClone(effect),points:[],playing:false,lastTick:-1,distance:0,gap:true};this.trails.set(key,t);}
  if(tick<=t.lastTick)return true;
  if(!t.playing){if(t.epoch)this.stats.restarted++;this.stats.started++;t.epoch=++this.epoch;t.effect=structuredClone(effect);t.points=[];t.distance=0;t.gap=true;t.lastTick=-1;t.playing=true;}
  t.lastTick=tick;if((nowTick-tick)*step+1e-9>=effect.duration)return true;const config=effect.ribbon,last=t.points.at(-1),distance=last?Math.hypot(...position.map((v,i)=>v-last.position[i]!)):0;
  if(last && distance<config.minDistance){if(distance<1e-8)this.stats.degenerate++;else this.stats.skipped++;return true;}
  if(last && distance>config.breakDistance){t.gap=true;this.stats.breaks++;}
  if(t.points.length>=config.maxPoints){t.points.shift();this.stats.clipped++;}
  if(this.pointCount>=this.pointCapacity){t.gap=true;this.stats.pointOverflow++;return false;}
  if(t.gap)t.distance=0;else t.distance+=distance;
  t.points.push({position:[...position] as [number,number,number],tick,age:Math.max(0,nowTick-tick)*step,distance:t.distance,breakBefore:t.gap || !last});t.gap=false;this.stats.appended++;return true;
 }
 stop(key:string){const t=this.trails.get(key);if(t?.playing){t.playing=false;this.stats.stopped++;}}
 disconnect(key:string){const t=this.trails.get(key);if(t){t.gap=true;this.stats.breaks++;}}
 stopExcept(keys:ReadonlySet<string>){for(const key of this.trails.keys())if(!keys.has(key))this.stop(key);}
 clear(){this.trails.clear();this.tick=-1;for(const key of Object.keys(this.stats) as (keyof typeof this.stats)[])this.stats[key]=0;}
 snapshot(){return {points:this.pointCount,handles:this.trails.size,stats:{...this.stats},trails:this.active.map(t=>({key:t.key,epoch:t.epoch,playing:t.playing,points:t.points.map(p=>({...p,position:[...p.position]}))}))};}
}
/** Authored local polyline, parameterized by arc length and fixed simulation seconds. */
export function sampleVfxMotion(motion:VfxMotion,seconds:number):{position:[number,number,number];cycle:number;finished:boolean} {
 const cycle=motion.loop?Math.floor(seconds/motion.seconds):0,t=motion.loop?(seconds%motion.seconds)/motion.seconds:Math.min(1,seconds/motion.seconds),lengths=motion.points.slice(1).map((p,i)=>Math.hypot(...p.map((v,k)=>v-motion.points[i]![k]!))),total=lengths.reduce((a,b)=>a+b,0);let remaining=t*total;
 for(let i=0;i<lengths.length;i++){const length=lengths[i]!;if(remaining<=length && length>1e-8){const a=motion.points[i]!,b=motion.points[i+1]!;return {position:a.map((v,k)=>v+(b[k]!-v)*remaining/length) as [number,number,number],cycle,finished:!motion.loop && seconds>=motion.seconds};}remaining-=length;}
 return {position:[...motion.points.at(-1)!],cycle,finished:!motion.loop && seconds>=motion.seconds};
}
export function sampleVfxMotionWorld(motion:VfxMotion,seconds:number,m:ArrayLike<number>){const sample=sampleVfxMotion(motion,seconds),p=sample.position;return {...sample,position:[m[0]!*p[0]+m[4]!*p[1]+m[8]!*p[2]+m[12]!,m[1]!*p[0]+m[5]!*p[1]+m[9]!*p[2]+m[13]!,m[2]!*p[0]+m[6]!*p[1]+m[10]!*p[2]+m[14]!] as [number,number,number]};}
