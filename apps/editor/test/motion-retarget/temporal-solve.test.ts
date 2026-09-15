/**
 * temporal-solve.test.ts —— 时间连续测试（MR-05，验收 A07 归此）。
 */
import { describe, it, expect } from 'vitest';
import { measureRootCorrectionSpeed, smoothRootCorrections } from '../../src/services/binding/motion-retarget/temporal-solve';

function timesAt(fps: number, n: number): Float64Array {
  const t = new Float64Array(n);
  for (let f = 0; f < n; f++) t[f] = f / fps;
  return t;
}

describe('smoothRootCorrections · A07', () => {
  it('seconds windows do not overweight dense samples; zero duration preserves the input signal', () => {
    const t = new Float64Array([0, 0.01, 0.5, 1]);
    const corr = new Float64Array(t.length * 3);
    t.forEach((v, i) => { corr[i * 3] = v; });
    const out = smoothRootCorrections(t, corr, { transitionS: 0.2 });
    expect(out.corrections[6]).toBeCloseTo(0.5, 12);
    expect(out.corrections[0]).toBeCloseTo(0.05, 12);
    expect(smoothRootCorrections(t, corr, { transitionS: 0 }).corrections).toEqual(corr);
  });

  it('measures the final correction instead of reusing a smoothed intermediate bound', () => {
    const t = new Float64Array([0, 0.1, 0.15]);
    const correction = new Float64Array([0, 0, 0, 0, 0.02, 0, 0, 0.04, 0]);
    expect(measureRootCorrectionSpeed(t, correction)).toBeCloseTo(0.4, 12);
  });
  it('阶跃修正在过渡窗内摊开：速度跳变 ≤ 阈值，不误罚源动态', () => {
    const fps = 30;
    const t = timesAt(fps, 30);
    const corr = new Float64Array(30 * 3);
    for (let f = 15; f < 30; f++) corr[f * 3 + 1] = -0.02; // 第 0.5s 起下沉 2cm
    const { corrections, maxJumpMps } = smoothRootCorrections(t, corr, { transitionS: 0.25 });
    // 阈值 0.1×h_t（h_t=1）
    expect(maxJumpMps).toBeLessThanOrEqual(0.1 + 1e-9);
    // 平滑后仍是"后半段低、前半段高"的形状（不抹方向）
    expect(corrections[0 * 3 + 1]!).toBeGreaterThan(corrections[29 * 3 + 1]!);
  });

  it('恒定修正（plateau）平滑后保持不变', () => {
    const t = timesAt(30, 10);
    const corr = new Float64Array(10 * 3);
    for (let f = 0; f < 10; f++) corr[f * 3] = 0.05;
    const { corrections, maxJumpMps } = smoothRootCorrections(t, corr, { transitionS: 0.2 });
    expect(maxJumpMps).toBeLessThan(1e-12); // 常数信号无跳变（浮点残差级）
    for (let f = 0; f < 10; f++) expect(corrections[f * 3]!).toBeCloseTo(0.05, 12);
  });

  it('平滑只动修正信号，锚点数据不经此函数（共享锚点语义由调用方保证）', () => {
    const t = timesAt(30, 6);
    const corr = new Float64Array(6 * 3);
    corr[3 * 3 + 1] = 0.1;
    const { corrections } = smoothRootCorrections(t, corr, { transitionS: 0.1 });
    // 输入未被修改（不可变纪律）
    expect(corr[3 * 3 + 1]!).toBe(0.1);
    // 输出是新数组
    expect(corrections).not.toBe(corr);
  });
});
