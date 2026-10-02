/**
 * 射线 × 竖直胶囊求交（P5 C3 从 apps/editor/services/runtime-bridge.ts 上提，
 * docs/23 §2.7：射线×胶囊是玩法域通用几何，不是编辑器专属）。
 *
 * 消费方：
 *  - 编辑器 pickRay（实体点选，原实现所在地）
 *  - 玩家手枪射击命中判定（RuntimeSession.fireStep）
 *
 * 纯函数、零依赖：给定原点/单位方向与胶囊参数，返回最近正向命中距离 t。
 */

/** 射线与「竖直胶囊」求交：脚底在 y=0，轴为 (x, *, z)，总高 h、半径 r。 */
export function rayCapsuleY(
  o: readonly [number, number, number],
  d: readonly [number, number, number],
  cx: number,
  cz: number,
  r: number,
  h: number,
): number | null {
  const y0 = r; // 下半球心
  const y1 = Math.max(r, h - r); // 上半球心
  let best: number | null = null;

  // ---- 圆柱段：xz 平面上的圆求交 ----
  const ox = o[0] - cx;
  const oz = o[2] - cz;
  const a = d[0] * d[0] + d[2] * d[2];
  if (a > 1e-9) {
    const b = 2 * (ox * d[0] + oz * d[2]);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t <= 0) continue;
        const y = o[1] + d[1] * t;
        if (y >= y0 && y <= y1) {
          if (best === null || t < best) best = t;
        }
      }
    }
  }

  // ---- 两端半球 ----
  for (const cy of [y0, y1]) {
    const t = raySphere(o, d, cx, cy, cz, r);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/** 射线与球求交，返回最近的正向 t，未命中 null（|d| = 1 → a = 1 的简化式） */
export function raySphere(
  o: readonly [number, number, number],
  d: readonly [number, number, number],
  cx: number,
  cy: number,
  cz: number,
  r: number,
): number | null {
  const ex = o[0] - cx;
  const ey = o[1] - cy;
  const ez = o[2] - cz;
  const b = 2 * (ex * d[0] + ey * d[1] + ez * d[2]);
  const c = ex * ex + ey * ey + ez * ez - r * r;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / 2;
  const t1 = (-b + sq) / 2;
  if (t0 > 0) return t0;
  if (t1 > 0) return t1;
  return null;
}
