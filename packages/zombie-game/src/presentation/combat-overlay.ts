import type { RuntimeSession } from '@aether/zombie-game';
import { NPC_STATS } from '@aether/content';
import { drawImpactInk, visibleImpacts } from './combat-ink';
import { gameText as g } from './game-language';
import { drawEnemyAttack, drawAttackCue } from './enemy-attack-ink';
import { drawHeldWeapon, drawWeaponEffect } from './weapon-ink';
export type WorldProjection = (p: readonly [number, number, number]) => { x: number; y: number; behind: boolean };

/** Screen-space feedback projected from simulation facts; never creates gameplay objects. */
export class CombatOverlay {
  debugRanges = false;
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
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    const c = this.ctx; c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0, 0, rect.width, rect.height);
    if (runtime.outcome !== 'running') return;
    const point = (p: readonly [number, number, number]) => { const q = this.project(p); return { x: q.x - rect.left, y: q.y - rect.top, behind: q.behind }; };
    drawHeldWeapon(c,point,runtime,this.debugRanges);
    for(const effect of runtime.weaponCombat.effects)drawWeaponEffect(c,point,effect,(runtime.tick-effect.tick)*runtime.fixedStep);
    for(const burn of runtime.weaponCombat.burning){const t=runtime.table;if(!t.isAlive(burn.id) || t.generation[burn.id]!==burn.generation)continue;const p=point([t.posX[burn.id]!,runtime.weaponMount.position[1],t.posZ[burn.id]!]);if(p.behind)continue;c.fillStyle='#ff7045';c.font='bold 14px system-ui';c.fillText('♨',p.x,p.y);}
    // Windup geometry uses the same authoritative ranges, arcs and facing as combat.
    const table = runtime.table;
    let shown = 0;
    for (let slot = 0; slot < table.capacity && shown < 24; slot++) {
      if (!table.isAlive(slot) || slot === runtime.playerEntityId || table.behavior[slot] !== 2) continue;
      const attack = NPC_STATS.find(s => s.defId === table.defId[slot])?.attack;
      if (!attack) continue;
      const x = table.posX[slot]!, z = table.posZ[slot]!, yaw = table.yaw[slot]!;
      const y=table.posY[slot]!,center=point([x,y+.07,z]);if(center.behind)continue;
      const target = runtime.enemyAttacks.target(slot,table.generation[slot]!);
      drawAttackCue(c,point,attack,x,z,yaw,table.windupRemain[slot]!,target,y);
      if (!this.debugRanges) continue;
      const arc = (attack.arcDeg ?? 90) * Math.PI / 180;
      c.beginPath(); c.moveTo(center.x, center.y);
      for (let j = 0; j <= 16; j++) {
        const angle = yaw - arc / 2 + arc * j / 16;
        const p = point([x + Math.cos(angle) * attack.rangeM,y+.07,z+Math.sin(angle)*attack.rangeM]);c.lineTo(p.x,p.y);
      }
      c.closePath(); c.fillStyle = '#ef67452e'; c.strokeStyle = '#f49b56b0'; c.lineWidth = 1.5; c.fill(); c.stroke(); shown++;
    }
    const danger = runtime.danger;
    if (danger) {
      c.beginPath();
      for (let i = 0; i <= 40; i++) {
        const angle = i / 40 * Math.PI * 2; const p = point([danger.x + Math.cos(angle) * danger.radius, danger.y + 0.08, danger.z + Math.sin(angle) * danger.radius]);
        if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      c.fillStyle = '#e74c3d55'; c.strokeStyle = '#ffce5b'; c.lineWidth = 3; c.fill(); c.stroke();
      const p = point([danger.x, danger.y + 0.2, danger.z]); c.font = 'bold 16px sans-serif'; c.textAlign = 'center'; c.fillStyle = '#fff6e2'; c.fillText(g(`撤离！${Math.max(0, danger.remaining).toFixed(1)}s`), p.x, p.y);
    }
    for (const effect of runtime.enemyAttacks.effects) drawEnemyAttack(c,point,effect,(runtime.tick-effect.startTick)*runtime.fixedStep);
    for (const e of visibleImpacts(runtime.combatEvents,runtime.runId,runtime.tick,runtime.fixedStep)) {
      const age = (runtime.tick - e.tick) * runtime.fixedStep;
      const p = point([e.x!,(e.y??0)+1.2,e.z!]);if(p.behind)continue;
      drawImpactInk(c,p.x,p.y,age,e.amount,e.type === 'kill',e.slot === runtime.playerEntityId,e.slot + e.generation + e.tick);
    }
  }
}
