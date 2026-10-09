import type { CombatEvent, EntityView } from '../session';
export interface NpcMotionCue { state: string; phase: number }
const identity = (e: { runId: number; id: number; generation: number }) => `${e.runId}:${e.id}:${e.generation}`;
/** 游戏表现策略；死亡立即从模拟移除，仅保留有界渲染快照，不参与碰撞、伤害或选取。 */
export class NpcMotionPresentation {
  private run = -1;
  private cursor = 0;
  private previous = new Map<string, EntityView>();
  private hits = new Map<string, { tick: number; variant: string }>();
  private deaths = new Map<string, { tick: number; entity: EntityView }>();
  clear(): void { this.run = -1; this.cursor = 0; this.previous.clear(); this.hits.clear(); this.deaths.clear(); }
  frames(live: readonly EntityView[], events: readonly CombatEvent[], tick: number, step: number, run: number): EntityView[] {
    if (run !== this.run || events.length < this.cursor) { this.clear(); this.run = run; }
    const current = new Map(live.filter(e => e.kind === 'npc').map(e => [identity(e), e]));
    for (; this.cursor < events.length; this.cursor++) {
      const ev = events[this.cursor]!;
      if (ev.runId !== run) continue;
      const key = `${ev.runId}:${ev.slot}:${ev.generation}`;
      const entity = ev.defeated ?? current.get(key) ?? this.previous.get(key);
      // A player damage event or an unobserved target cannot create a corpse.
      if (!entity || entity.kind !== 'npc' || entity.runId !== ev.runId || entity.id !== ev.slot || entity.generation !== ev.generation) continue;
      if (ev.type === 'damage') this.hits.set(key, { tick: ev.tick, variant: (ev.slot + ev.tick) % 2 ? 'hit_b' : 'hit' });
      else {
        this.hits.delete(key);
        this.deaths.set(key, { tick: ev.tick, entity: { ...entity, x: ev.x ?? entity.x, z: ev.z ?? entity.z, alive: false, hp: 0, hitFlash: 0 } });
        if (this.deaths.size > 32) this.deaths.delete(this.deaths.keys().next().value!);
      }
    }
    for (const [key, hit] of this.hits) if (!current.has(key) || (tick - hit.tick) * step >= .3) this.hits.delete(key);
    for (const [key, dead] of this.deaths) if ((tick - dead.tick) * step >= 3.3) this.deaths.delete(key);
    this.previous = current;
    return [...live, ...[...this.deaths.values()].map(d => d.entity)];
  }
  cue(entity: EntityView, tick: number, step: number): NpcMotionCue | null {
    if (entity.kind !== 'npc') return null;
    const key = identity(entity), dead = this.deaths.get(key);
    if (dead) return { state: 'death', phase: Math.min(.999, Math.max(0, (tick - dead.tick) * step / 3.3)) };
    if (entity.motionCue) return { ...entity.motionCue, phase: Math.min(.999,Math.max(0,entity.motionCue.phase)) };
    // 攻击计时始终优先，受击姿态不把前摇/收势重置，不额外施加硬直。
    if (entity.behavior === 2 || entity.behavior === 4) return null;
    const hit = this.hits.get(key);
    return hit ? { state: hit.variant, phase: Math.min(.999, Math.max(0, (tick - hit.tick) * step / .3)) } : null;
  }
}
