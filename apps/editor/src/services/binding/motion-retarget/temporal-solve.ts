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
  if (!Number.isFinite(opts.transitionS) || opts.transitionS < 0) throw new RangeError('Invalid transition duration');
  if (frames < 2 || opts.transitionS === 0) {
    const copy = corrections.slice();
    return { corrections: copy, maxJumpMps: measureRootCorrectionSpeed(times, copy) };
  }
  // Integrate the piecewise-linear signal over an actual seconds window. Frame-count
  // averages overweight dense samples and change the result for irregular sampling.
  const prefix = new Float64Array(frames * 3);
  for (let f = 1; f < frames; f++) {
    const dt = times[f]! - times[f - 1]!;
    for (let c = 0; c < 3; c++) {
      prefix[f * 3 + c] = prefix[(f - 1) * 3 + c]! + dt * (corrections[(f - 1) * 3 + c]! + corrections[f * 3 + c]!) / 2;
    }
  }
  const integralAt = (t: number, c: number): number => {
    let lo = 0, hi = frames - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[mid]! <= t) lo = mid; else hi = mid;
    }
    const dt = t - times[lo]!;
    const span = times[hi]! - times[lo]!;
    const a = corrections[lo * 3 + c]!;
    const slope = (corrections[hi * 3 + c]! - a) / span;
    return prefix[lo * 3 + c]! + a * dt + slope * dt * dt / 2;
  };
  const out = new Float64Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    const lo = Math.max(times[0]!, times[f]! - opts.transitionS / 2);
    const hi = Math.min(times[frames - 1]!, times[f]! + opts.transitionS / 2);
    for (let c = 0; c < 3; c++) {
      out[f * 3 + c] = (integralAt(hi, c) - integralAt(lo, c)) / (hi - lo);
    }
  }
  return { corrections: out, maxJumpMps: measureRootCorrectionSpeed(times, out) };
}

/** Maximum added root speed, measured on the final correction signal, in m/s. */
export function measureRootCorrectionSpeed(times: Float64Array, corrections: Float64Array): number {
  // 修正信号的速度跳变（相邻帧差的模 / dt）
  let maxJump = 0;
  for (let f = 1; f < times.length; f++) {
    const dt = Math.max(1e-9, times[f]! - times[f - 1]!);
    const d = Math.hypot(
      corrections[f * 3]! - corrections[(f - 1) * 3]!,
      corrections[f * 3 + 1]! - corrections[(f - 1) * 3 + 1]!,
      corrections[f * 3 + 2]! - corrections[(f - 1) * 3 + 2]!,
    );
    maxJump = Math.max(maxJump, d / dt);
  }
  return maxJump;
}
