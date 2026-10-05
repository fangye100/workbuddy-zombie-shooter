import type { RuntimeSession } from '@aether/runtime';
import { NPC_STATS } from '@aether/content';
export type WorldProjection = (p: readonly [number, number, number]) => { x: number; y: number; behind: boolean };

/** Screen-space feedback projected from simulation facts; never creates gameplay objects. */
export class CombatOverlay {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  constructor(private readonly project: WorldProjection) {
    this.canvas.className = 'combat-feedback'; this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d')!;
    document.getElementById('center')!.append(this.canvas);
  }
  update(runtime: RuntimeSession | null): void {
    this.canvas.hidden = !runtime;
    if (!runtime) return;
    const rect = this.canvas.getBoundingClientRect();
    if (this.canvas.width !== Math.round(rect.width) || this.canvas.height !== Math.round(rect.height)) { this.canvas.width = Math.round(rect.width); this.canvas.height = Math.round(rect.height); }
    const c = this.ctx; c.clearRect(0, 0, rect.width, rect.height);
    if (runtime.outcome !== 'running') return;
    const point = (p: readonly [number, number, number]) => { const q = this.project(p); return { x: q.x - rect.left, y: q.y - rect.top, behind: q.behind }; };
    const shot = runtime.lastShot;
    // Windup geometry uses the same authoritative ranges, arcs and facing as combat.
    const table = runtime.table;
    let shown = 0;
    for (let slot = 0; slot < table.capacity && shown < 24; slot++) {
      if (!table.isAlive(slot) || slot === runtime.playerEntityId || table.behavior[slot] !== 2) continue;
      const attack = NPC_STATS.find(s => s.defId === table.defId[slot])?.attack;
      if (!attack) continue;
      const x = table.posX[slot]!, z = table.posZ[slot]!, yaw = table.yaw[slot]!;
      const center = point([x, 0.07, z]); if (center.behind) continue;
      const arc = (attack.arcDeg ?? 90) * Math.PI / 180;
      c.beginPath(); c.moveTo(center.x, center.y);
      for (let j = 0; j <= 16; j++) {
        const angle = yaw - arc / 2 + arc * j / 16;
        const p = point([x + Math.cos(angle) * attack.rangeM, 0.07, z + Math.sin(angle) * attack.rangeM]); c.lineTo(p.x, p.y);
      }
      c.closePath(); c.fillStyle = '#ef67452e'; c.strokeStyle = '#f49b56b0'; c.lineWidth = 1.5; c.fill(); c.stroke(); shown++;
    }
    if (shot && (runtime.tick - shot.tick) * runtime.fixedStep < 0.12) {
      const a = point(shot.from), b = point(shot.to);
      if (!a.behind && !b.behind) { c.strokeStyle = shot.hit ? '#ffe780' : '#f4b55c'; c.lineWidth = 3; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); c.fillStyle = '#fff6e2'; c.beginPath(); c.arc(b.x, b.y, shot.hit ? 6 : 2, 0, Math.PI * 2); c.fill(); }
    }
    const danger = runtime.danger;
    if (danger) {
      c.beginPath();
      for (let i = 0; i <= 40; i++) {
        const angle = i / 40 * Math.PI * 2; const p = point([danger.x + Math.cos(angle) * danger.radius, 0.08, danger.z + Math.sin(angle) * danger.radius]);
        if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      c.fillStyle = '#e74c3d55'; c.strokeStyle = '#ffce5b'; c.lineWidth = 3; c.fill(); c.stroke();
      const p = point([danger.x, 0.2, danger.z]); c.font = 'bold 16px sans-serif'; c.textAlign = 'center'; c.fillStyle = '#fff6e2'; c.fillText(`撤离！${Math.max(0, danger.remaining).toFixed(1)}s`, p.x, p.y);
    }
    const events = runtime.combatEvents;
    for (let i = Math.max(0, events.length - 24); i < events.length; i++) {
      const e = events[i]!; const age = (runtime.tick - e.tick) * runtime.fixedStep;
      if (age > 0.65 || e.x === undefined || e.z === undefined) continue;
      const p = point([e.x, 2, e.z]); if (p.behind) continue;
      c.font = 'bold 18px sans-serif'; c.textAlign = 'center'; c.lineWidth = 3;
      const label = e.type === 'kill' ? (e.slot === runtime.playerEntityId ? '倒下' : '击杀！') : `${Math.ceil(e.amount)}`;
      c.strokeStyle = '#171327'; c.strokeText(label, p.x, p.y - age * 36);
      c.fillStyle = e.slot === runtime.playerEntityId ? '#ff7764' : '#ffe875'; c.fillText(label, p.x, p.y - age * 36);
    }
  }
}
