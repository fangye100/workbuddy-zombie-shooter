import type { VfxEffectDefinition } from '@aether/scene';
export type VfxPoint = readonly [number, number, number];
export interface VfxRequest {
  key: string;
  effect: Readonly<VfxEffectDefinition>;
  position: VfxPoint;
  end?: VfxPoint;
  normal?: VfxPoint;
  seed: number;
  priority: number;
  /** Optional simulation lifetime, independent of the asset animation cycle. */
  lifetime?: number;
}
export interface VfxInstance extends VfxRequest { age: number }
/** Simulation-time pool: paused frames never age it; no render clock or gameplay state. */
export class VfxPool {
  private instances: VfxInstance[] = [];
  private seen = new Set<string>();
  readonly stats = { spawned: 0, dropped: 0, expired: 0 };
  constructor(readonly capacity = 256) { if (!Number.isInteger(capacity) || capacity < 1) throw new Error('VFX capacity'); }
  spawn(request: VfxRequest): boolean {
    if (this.seen.has(request.key)) return false;
    this.seen.add(request.key);
    // Dedup history is bounded independently from live instances.
    if (this.seen.size > this.capacity * 16) this.seen.delete(this.seen.values().next().value!);
    if (this.instances.length >= this.capacity) {
      const lowest = this.instances.reduce((a, b) => a.priority <= b.priority ? a : b);
      this.stats.dropped++;
      if (lowest.priority >= request.priority) return false;
      this.instances.splice(this.instances.indexOf(lowest), 1);
    }
    this.instances.push({ ...structuredClone(request), age: 0 }); this.stats.spawned++; return true;
  }
  advance(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) throw new Error('VFX dt');
    for (const p of this.instances) p.age += dt;
    this.instances = this.instances.filter(p => { if (p.age < (p.lifetime??p.effect.duration)) return true; this.stats.expired++; return false; });
  }
  upsert(request:VfxRequest,age:number):boolean {
    const instance=this.instances.find(p=>p.key===request.key);
    if(instance){Object.assign(instance,structuredClone(request),{age});return true;}
    this.seen.delete(request.key);
    if(!this.spawn(request))return false;this.instances.find(p=>p.key===request.key)!.age=age;return true;
  }
  stop(key:string):void {this.instances=this.instances.filter(p=>p.key!==key);}
  get active(): readonly VfxInstance[] { return this.instances; }
  clear(): void { this.instances = []; this.seen.clear(); this.stats.spawned = this.stats.dropped = this.stats.expired = 0; }
}
