import type {VfxEffectDefinition} from '@aether/scene';
/** A fixed-tick projector request. Geometry and GPU state belong to render. */
export interface VfxDecalRequest {key:string;effect:Readonly<VfxEffectDefinition>;matrix:Readonly<Float32Array>;receivers:readonly string[];layerMask:number;priority:number}
export interface VfxDecalInstance extends VfxDecalRequest {age:number;bornTick:number;epoch:number}
export class VfxDecalPool {
 private items=new Map<string,VfxDecalInstance>();private epoch=0;private tick=0;private step=1/30;
 readonly stats={started:0,dropped:0,evicted:0,expired:0,stopped:0};
 constructor(readonly capacity=16){if(!Number.isInteger(capacity) || capacity<1 || capacity>64)throw new Error('Decal capacity');}
 advance(tick:number,step:number){if(!Number.isInteger(tick) || tick<this.tick || !Number.isFinite(step) || step<=0)throw new Error('Decal fixed clock');this.tick=tick;this.step=step;for(const [key,p] of this.items){p.age=(tick-p.bornTick)*step;if(!p.effect.loop && p.age+1e-9>=p.effect.duration){this.items.delete(key);this.stats.expired++;}}}
 spawn(r:VfxDecalRequest):boolean {
  if(r.effect.kind!=='decal' || !r.effect.decal || r.matrix.length!==16 || ![...r.matrix].every(Number.isFinite))throw new Error('Decal request requires a valid projector');
  if(this.items.has(r.key))return false;
  if(this.items.size>=this.capacity){const lowest=[...this.items.values()].reduce((a,b)=>a.priority<=b.priority?a:b);this.stats.dropped++;if(lowest.priority>=r.priority)return false;this.items.delete(lowest.key);this.stats.evicted++;}
  this.items.set(r.key,{...structuredClone(r),age:0,bornTick:this.tick,epoch:++this.epoch});this.stats.started++;return true;
 }
 stop(key:string){if(this.items.delete(key))this.stats.stopped++;}
 get active():readonly VfxDecalInstance[]{return [...this.items.values()];}
 snapshot(){return {capacity:this.capacity,tick:this.tick,step:this.step,stats:{...this.stats},instances:this.active.map(p=>({...p,matrix:[...p.matrix]}))};}
 clear(){this.items.clear();this.tick=0;this.epoch=0;Object.assign(this.stats,{started:0,dropped:0,evicted:0,expired:0,stopped:0});}
}
