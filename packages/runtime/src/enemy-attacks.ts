import type { AttackStats } from '@aether/content';

export type AttackPoint = [number, number, number];
export interface EnemyAttackEffect {
  kind: 'acid' | 'pounce' | 'charge' | 'melee' | 'explode' | 'slam';
  phase: 'flight' | 'pool' | 'strike';
  source: number; generation: number;
  from: AttackPoint; to: AttackPoint; position: AttackPoint;
  startTick: number; duration: number; radius: number; damage: number;
  hit: boolean; blocked: boolean; finished: boolean; flightSeconds: number;
}
interface Actor { x: number; z: number; radius: number; generation: number; hp: number }
export interface EnemyAttackWorld {
  actor(slot: number): Actor | null;
  player: number;
  damage(slot: number, amount: number, source: number): void;
  move(slot: number, x: number, z: number): AttackPoint;
  /** Actual segment collision with scene solids, including the lob's height. */
  obstruction(from: AttackPoint, to: AttackPoint): AttackPoint | null;
}

/** Simulation-owned attack trajectories. Rendering reads these facts; it never deals damage. */
export class EnemyAttacks {
  readonly effects: EnemyAttackEffect[] = [];
  private readonly targets = new Map<number, { generation: number; point: AttackPoint }>();
  lock(slot: number, generation: number, x: number, z: number): void {
    this.targets.set(slot, { generation, point: [x, 0, z] });
  }
  target(slot: number, generation: number): AttackPoint | undefined {
    const t = this.targets.get(slot); return t?.generation === generation ? t.point : undefined;
  }
  moving(slot: number, generation?: number): boolean { return this.effects.some(e => e.source === slot && (generation === undefined || e.generation === generation) && !e.finished && (e.kind === 'pounce' || e.kind === 'charge')); }
  clear(): void { this.effects.length = 0; this.targets.clear(); }
  impact(kind: 'slam', source: number, generation: number, x: number, z: number, radius: number, tick: number): void {
    const point: AttackPoint=[x,0,z];
    this.effects.push({kind,phase:'strike',source,generation,from:point,to:point,position:point,startTick:tick,duration:.45,radius,damage:0,hit:true,blocked:false,finished:true,flightSeconds:0});
  }
  strike(slot: number, actor: Actor, stats: AttackStats, tick: number, player: Actor, world: EnemyAttackWorld): boolean {
    const kind = stats.kind ?? 'melee';
    const target = this.target(slot, actor.generation) ?? [player.x, 0, player.z];
    this.targets.delete(slot);
    const from: AttackPoint = [actor.x, kind === 'acid' ? 1.3 : 0, actor.z];
    let to: AttackPoint = [...target];
    const length = Math.hypot(to[0] - from[0], to[2] - from[2]);
    if (length > stats.rangeM) to = [from[0] + (to[0]-from[0]) / length * stats.rangeM, 0, from[2] + (to[2]-from[2]) / length * stats.rangeM];
    const radius = kind === 'acid' ? stats.poolRadiusM! : kind === 'explode' ? stats.rangeM : stats.impactRadiusM ?? stats.rangeM;
    const duration = kind === 'acid' ? stats.flightSec! : kind === 'pounce' || kind === 'charge' ? Math.max(.01, Math.min(length, stats.rangeM) / stats.speedMps!) : .35;
    const e: EnemyAttackEffect = { kind, phase: kind === 'acid' ? 'flight' : 'strike', source: slot, generation: actor.generation, from, to, position: [...from], startTick: tick, duration, radius, damage: stats.damage, hit: false, blocked: false, finished: false, flightSeconds: duration };
    // Capacity is bounded by live attacks and a short feedback tail, not an unbounded event log.
    this.effects.push(e);
    if (kind === 'acid') e.duration += stats.poolSeconds!;
    if (kind === 'pounce' || kind === 'charge') e.duration += .25;
    if (kind === 'explode') {
      if (Math.hypot(player.x-actor.x, player.z-actor.z) <= radius + player.radius) world.damage(world.player, stats.damage, slot);
      world.damage(slot, actor.hp, slot); e.hit = true;
    }
    return kind !== 'melee';
  }
  step(tick: number, dt: number, world: EnemyAttackWorld): void {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i]!; const age = (tick - e.startTick) * dt;
      if (age >= e.duration) { this.effects.splice(i, 1); continue; }
      const player = world.actor(world.player); if (!player || player.hp <= 0) continue;
      if (e.kind === 'acid') {
        // The launch snapshot survives shooter death or slot reuse.
        const flightSec = e.flightSeconds;
        if (age < flightSec && !e.blocked) {
          const t = Math.max(0, age / flightSec);
          const next: AttackPoint = [e.from[0]+(e.to[0]-e.from[0])*t, e.from[1]*(1-t)+4*t*(1-t)*2.2, e.from[2]+(e.to[2]-e.from[2])*t];
          const block = world.obstruction(e.position, next);
          e.position = block ?? next; if (block) { e.blocked = true;e.duration=age+.3; }
        } else if (!e.blocked) {
          const block = e.phase === 'flight' ? world.obstruction(e.position,e.to) : null;
          if (block) { e.blocked=true;e.position=block;e.duration=age+.3;continue; }
          e.phase = 'pool'; e.position = [...e.to];
          if (Math.hypot(player.x-e.to[0],player.z-e.to[2]) <= e.radius + player.radius) {
            const source=world.actor(e.source);
            world.damage(world.player,e.damage*dt,source?.generation===e.generation?e.source:-1);
          }
        }
      } else if (e.kind === 'pounce' || e.kind === 'charge') {
        if (e.finished) continue;
        const actor = world.actor(e.source);
        if (!actor || actor.generation !== e.generation) { this.effects.splice(i,1); continue; }
        const t = Math.min(1, Math.max(0, age / e.flightSeconds));
        const next: AttackPoint = [e.from[0]+(e.to[0]-e.from[0])*t,0,e.from[2]+(e.to[2]-e.from[2])*t];
        const obstruction = world.obstruction([e.position[0],.7,e.position[2]],[next[0],.7,next[2]]);
        const destination = obstruction ?? next;
        e.position = world.move(e.source,destination[0],destination[2]);
        if (obstruction) e.blocked = true;
        if (!e.hit && !e.blocked && (e.kind === 'charge' || t === 1) && Math.hypot(player.x-e.position[0],player.z-e.position[2]) <= e.radius+player.radius) {
          world.damage(world.player,e.damage,e.source); e.hit = true;
        }
        e.finished = t === 1 || e.blocked;
      }
    }
  }
}
