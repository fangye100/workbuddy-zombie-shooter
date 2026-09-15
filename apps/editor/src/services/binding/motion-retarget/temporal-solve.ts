/**
 * temporal-solve.ts —— 时间连续（MR-05，docs/16 §4.3）。
 *
 * 保留源节奏：只对**相对基准的根修正**做时间正则，不抹源动作。
 * 接触切换用秒制过渡窗（窗内修正被箱式平滑摊开），锚点不随平滑移动
 * （跨窗口携带同一段落点）；平滑后由 pipeline 重解约束复算残差。
 */

export interface TemporalOptions {
  /** 切换过渡窗（秒，默认 0.25） */
  transitionS: number;
}

export interface TemporalResult {
  /** 平滑后的根修正（frames × 3） */
  corrections: Float64Array;
  /** 修正信号引入的最大速度跳变（m/s；A07 阈值 0.1×h_t） */
  maxJumpMps: number;
}

/** 箱式平滑根修正；plateau（段内平稳区）保留，只在边界摊开跳变 */
export function smoothRootCorrections(
  times: Float64Array,
  corrections: Float64Array,
  opts: TemporalOptions = { transitionS: 0.25 },
): TemporalResult {
  const frames = times.length;
  const radius = Math.max(1, Math.round((opts.transitionS / 2) / medianDt(times)));
  const out = new Float64Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const lo = Math.max(0, f - radius);
    const hi = Math.min(frames - 1, f + radius);
    const n = hi - lo + 1;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = lo; k <= hi; k++) sum += corrections[k * 3 + c]!;
      out[f * 3 + c] = sum / n;
    }
  }
  // 修正信号的速度跳变（相邻帧差的模 / dt）
  let maxJump = 0;
  for (let f = 1; f < frames; f++) {
    const dt = Math.max(1e-9, times[f]! - times[f - 1]!);
    const d = Math.hypot(
      out[f * 3]! - out[(f - 1) * 3]!,
      out[f * 3 + 1]! - out[(f - 1) * 3 + 1]!,
      out[f * 3 + 2]! - out[(f - 1) * 3 + 2]!,
    );
    maxJump = Math.max(maxJump, d / dt);
  }
  return { corrections: out, maxJumpMps: maxJump };
}

function medianDt(times: Float64Array): number {
  if (times.length < 2) return 1 / 30;
  return times[1]! - times[0]!;
}
