/** Fixed-tick deterministic bounded emitters; only decorative particles, no gameplay state. */
import type {VfxEffectDefinition} from '@aether/scene';
import {VfxPool,type VfxPoint,type VfxRequest} from './vfx';
interface State {key:string;epoch:number;serial:number;fraction:number;tick:number;playing:boolean;position:VfxPoint}
export interface VfxAnchor {position:VfxPoint;direction?:VfxPoint;normal?:VfxPoint}
export class VfxEmitters {
 private epoch=0;
 private readonly states=new Map<string,State>();
 readonly stats={emitted:0,dropped:0,handleOverflow:0,tickOverflow:0,started:0,stopped:0,restarted:0};
 constructor(readonly pool:VfxPool,readonly capacity=32){}
 update(key:string,effect:VfxEffectDefinition,anchor:VfxAnchor,tick:number,step:number,seed:number,priority=1,nowTick=tick):boolean {
  if(!Number.isInteger(tick) || !Number.isFinite(step) || step<=0)throw new Error('VFX emitter clock');
  let s=this.states.get(key);if(!s){if(this.states.size>=this.capacity){const idle=[...this.states.values()].find(x=>!x.playing);if(idle)this.states.delete(idle.key);else{this.stats.handleOverflow++;return false;}}s={key,epoch:0,serial:0,fraction:0,tick:tick-1,playing:false,position:anchor.position};this.states.set(key,s);}
  if(!s.playing){if(s.epoch)this.stats.restarted++;s.epoch=++this.epoch;s.serial=0;s.fraction=0;s.tick=tick-1;s.position=anchor.position;s.playing=true;this.stats.started++;}
  if(tick<s.tick)throw new Error('VFX emitter tick reversed');
  const emission=effect.emission??{rate:30,maxParticles:32,speed:0,spreadDeg:0},begin=s.tick+1,span=tick-s.tick;
  let success=true;
  for(let t=Math.max(begin,tick-239);t<=tick;t++){
   if(t===Math.max(begin,tick-239) && begin<t)this.stats.tickOverflow+=t-begin;
   s.fraction+=emission.rate*step;const count=Math.floor(s.fraction+1e-9);s.fraction-=count;
   for(let n=0;n<count;n++){
    const serial=++s.serial,age=Math.max(0,nowTick-t)*step;if(age+1e-9>=effect.duration)continue;
    let bits=(seed^Math.imul(serial,0x9e3779b1))>>>0;const random=()=>{bits^=bits<<13;bits^=bits>>>17;bits^=bits<<5;return (bits>>>0)/4294967296;};
    const d=anchor.direction??[0,1,0],length=Math.hypot(...d)||1,angle=(random()-.5)*emission.spreadDeg*Math.PI/180,c=Math.cos(angle),sn=Math.sin(angle),velocity:[number,number,number]=[(d[0]*c-d[2]*sn)/length*emission.speed,d[1]/length*emission.speed,(d[0]*sn+d[2]*c)/length*emission.speed];
    const fraction=span>0?(t-(begin-1))/span:1,position=anchor.position.map((v,i)=>s!.position[i]!+(v-s!.position[i]!)*fraction) as [number,number,number];
    const particleKey=`emit:${key}:${s.epoch}:${serial}`,owned=this.pool.active.filter(p=>p.key.startsWith(`emit:${key}:`)).length;
    const request:VfxRequest={key:particleKey,effect,position,velocity,...(anchor.direction?{direction:anchor.direction}:{}),...(anchor.normal?{normal:anchor.normal}:{}),seed:Math.floor(random()*6283),priority};
    if(owned>=emission.maxParticles || !this.pool.spawn(request)){this.stats.dropped++;success=false;continue;}
    this.pool.active.find(p=>p.key===particleKey)!.age=age;this.stats.emitted++;
   }
  }
  s.tick=tick;s.position=[...anchor.position] as [number,number,number];return success;
 }
 stop(key:string):void{const s=this.states.get(key);if(s?.playing){s.playing=false;this.stats.stopped++;}}
 stopExcept(keys:ReadonlySet<string>):void{for(const key of this.states.keys())if(!keys.has(key))this.stop(key);}
 get activeHandles(){return [...this.states.values()].filter(s=>s.playing).map(s=>({key:s.key,epoch:s.epoch,serial:s.serial,tick:s.tick}));}
 clear():void{this.states.clear();for(const key of Object.keys(this.stats) as (keyof typeof this.stats)[])this.stats[key]=0;}
}
export function sampleVfxCurve(curve:ReadonlyArray<{t:number;value:number}>|undefined,t:number,fallback=1):number {
 if(!curve)return fallback;t=Math.min(1,Math.max(0,t));for(let i=1;i<curve.length;i++){const a=curve[i-1]!,b=curve[i]!;if(t<=b.t)return a.value+(b.value-a.value)*(t-a.t)/(b.t-a.t);}return curve[curve.length-1]!.value;
}
