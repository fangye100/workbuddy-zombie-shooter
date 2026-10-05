import type { CombatEvent } from '@aether/runtime';

const INK = '#14110f';
const PAPER = '#fff6e2';
const GOLD = '#ffc531';
export const IMPACT_SECONDS = 0.7;

/** Keep event positions after despawn; never resolve recycled entity slots to draw a hit. */
export function visibleImpacts(events: readonly CombatEvent[], runId: number, tick: number, step: number) {
  return events.slice(-24).filter(e => {
    const age = (tick - e.tick) * step;
    return e.runId === runId && age >= 0 && age < IMPACT_SECONDS
      && Number.isFinite(e.x) && Number.isFinite(e.z) && Number.isFinite(e.amount) && e.amount > 0;
  });
}

function burst(c: CanvasRenderingContext2D, x: number, y: number, radius: number, turn: number, fill: string): void {
  c.beginPath();
  for (let i = 0; i < 16; i++) {
    const angle = turn + i * Math.PI / 8;
    const r = radius * (i % 2 ? 0.38 : (i % 4 ? 0.72 : 1));
    const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath(); c.lineJoin = 'round'; c.lineWidth = 2.5;
  c.strokeStyle = INK; c.fillStyle = fill; c.fill(); c.stroke();
}

/** A transient illustration of an actual shot, not an authored emitter or a damage source. */
export function drawShotInk(c: CanvasRenderingContext2D, a: {x:number;y:number}, b: {x:number;y:number}, age: number): void {
  if (age < 0 || age >= 0.28) return;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  c.save(); c.lineCap = 'round';
  if (age < 0.1) {
    c.globalAlpha = 1 - age / 0.1;
    c.beginPath(); c.moveTo(a.x,a.y); c.lineTo(b.x,b.y);
    c.strokeStyle = INK; c.lineWidth = 6; c.stroke();
    c.strokeStyle = GOLD; c.lineWidth = 3.5; c.stroke();
    c.strokeStyle = PAPER; c.lineWidth = 1.2; c.stroke();
    c.globalAlpha = 1 - age / 0.15;
    burst(c,a.x,a.y,21 * (1 - age * 4),angle,GOLD);
    burst(c,a.x,a.y,10 * (1 - age * 4),angle + 0.2,PAPER);
  }
  // A short ink-edged powder puff; anchored to the recorded origin and simulation clock.
  const t = age / 0.28;
  for (let i = 0; i < 3; i++) {
    const x = a.x - Math.cos(angle) * (i * 5 + t * 8);
    const y = a.y - Math.sin(angle) * i * 4 - t * 17;
    c.globalAlpha = (1 - t) * 0.3;
    c.beginPath(); c.arc(x,y,3 + t * 7 + i,0,Math.PI * 2);
    c.fillStyle = '#d3c9b7'; c.strokeStyle = INK; c.lineWidth = 1;
    c.fill(); c.stroke();
  }
  c.restore();
}

export function drawImpactInk(c: CanvasRenderingContext2D, x: number, y: number, age: number, amount: number, killed: boolean, player: boolean, seed: number): void {
  if (age < 0 || age >= IMPACT_SECONDS) return;
  c.save();
  const t = age / IMPACT_SECONDS;
  c.globalAlpha = Math.min(1, (1 - t) * 3);
  const accent = player ? '#ef6745' : GOLD;
  if (age < 0.24) {
    const impact = age / 0.24;
    c.save(); c.globalAlpha *= 1 - impact;
    burst(c,x,y,(killed ? 32 : 23) * (0.7 + impact * 0.5),seed * 0.7,accent);
    // Deliberate, deterministic speed strokes, without a random frame-to-frame shimmer.
    c.strokeStyle = INK; c.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
      const a = seed + i * Math.PI * 0.4, r = 26 + impact * 22;
      c.beginPath(); c.moveTo(x + Math.cos(a)*r,y + Math.sin(a)*r);
      c.lineTo(x + Math.cos(a)*(r+9),y + Math.sin(a)*(r+9)); c.stroke();
    }
    c.restore();
  }
  // Damage and kill labels use separate baselines; neither fabricates a critical hit.
  c.translate(x,y - 22 - 36 * t); c.rotate((seed % 3 - 1) * 0.055);
  const pop = 1 + 0.18 * Math.max(0,1 - age / 0.12); c.scale(pop,pop);
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  c.font = '900 25px system-ui, sans-serif'; c.lineWidth = 5; c.strokeStyle = INK;
  const label = `−${Math.ceil(amount)}`;
  c.strokeText(label,0,0); c.fillStyle = player ? '#ff917b' : PAPER; c.fillText(label,0,0);
  if (killed) {
    c.font = '900 16px system-ui, sans-serif'; c.lineWidth = 4;
    const caption = player ? '倒下' : '击杀！';
    c.strokeText(caption,0,-27); c.fillStyle = accent; c.fillText(caption,0,-27);
  }
  c.restore();
}
