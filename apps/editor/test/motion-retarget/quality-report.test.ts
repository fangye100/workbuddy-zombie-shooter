/**
 * quality-report.test.ts —— 质量指标测试（MR-05）。
 *
 * 手工构造帧/接触段，验证指标口径与 complete/partial/failed 判定。
 */
import { describe, it, expect } from 'vitest';
import { buildQualityReport, markerWorldAt } from '../../src/services/binding/motion-retarget/quality-report';
import { buildTargetRig } from '../../src/services/binding/motion-retarget/rig-calibration';
import { defaultRetargetTolerances } from '@aether/scene';
import type { ContactSegment, WorldPoseFrame } from '../../src/services/binding/motion-retarget/contracts';

const { rig } = buildTargetRig({});

function standFrame(y = 1.0): WorldPoseFrame {
  // 单帧静态站姿：全部骨在 rest（手算几个关键位）
  const bonePos: Record<string, [number, number, number]> = {
    Hips: [0, y, 0],
    LeftUpLeg: [0.1, y - 0.1, 0],
    LeftLeg: [0.1, y - 0.52, 0],
    LeftFoot: [0.1, y - 0.97, 0],
    RightUpLeg: [-0.1, y - 0.1, 0],
    RightLeg: [-0.1, y - 0.52, 0],
    RightFoot: [-0.1, y - 0.97, 0],
  };
  const boneQuat: Record<string, [number, number, number, number]> = {};
  for (const b of rig.order) boneQuat[b] = [0, 0, 0, 1];
  return { t: 0, rootPos: [0, y, 0], rootQuat: [0, 0, 0, 1], bonePos, boneQuat };
}

function supportSeg(anchor: [number, number, number], startS: number, endS: number): ContactSegment {
  return {
    id: `LeftFoot.ball@${startS}s`,
    marker: 'LeftFoot.ball',
    chainId: 'LeftLeg',
    startS,
    endS,
    mode: 'support',
    space: 'world',
    origin: 'annotated',
    confidence: 1,
    anchor,
    pivot: null,
  };
}

describe('buildQualityReport', () => {
  it('完美锁定（标记恰在锚点上、无穿透、无滑动）→ complete，零违例', () => {
    // rest 站姿：左 ball 世界位 = 踝 + (0,−0.03,+0.09)
    const anchor: [number, number, number] = [0.1, 0, 0.09];
    const frames = [standFrame(), { ...standFrame(), t: 1 / 30 }, { ...standFrame(), t: 2 / 30 }];
    const res = buildQualityReport({
      rig,
      frames,
      segments: [supportSeg(anchor, 0, 0.1)],
      anchorDeviations: [{ segmentId: 'x', marker: 'LeftFoot.ball', maxM: 0 }],
      reachResidualsM: { inner: 0, outer: 0 },
      rootCorrections: new Float64Array(9),
      switchJumpMps: 0,
      iterations: 1,
      converged: true,
      durationMs: 1,
      tolerances: defaultRetargetTolerances(),
    });
    expect(res.status).toBe('complete');
    expect(res.violations).toEqual([]);
    expect(res.metrics.maxPenetrationM).toBeLessThanOrEqual(0.001 + 1e-9);
  });

  it('静态偏差零运动 → 滑动 = 0（口径：相邻样本路程，不重复计锚点偏差）；偏差由 MRQ_ANCHOR 捕获', () => {
    const anchor: [number, number, number] = [0.5, 0, 0.09]; // 恒定偏 0.4m，零运动
    const frames = [standFrame(), { ...standFrame(), t: 1 / 30 }];
    const res = buildQualityReport({
      rig,
      frames,
      segments: [supportSeg(anchor, 0, 0.1)],
      anchorDeviations: [{ segmentId: 'x', marker: 'LeftFoot.ball', maxM: 0.4 }],
      reachResidualsM: { inner: 0, outer: 0 },
      rootCorrections: new Float64Array(6),
      switchJumpMps: 0,
      iterations: 1,
      converged: true,
      durationMs: 1,
      tolerances: defaultRetargetTolerances(),
    });
    expect(res.metrics.cumulativeSlideM).toBeCloseTo(0, 9);
    expect(res.violations.some((v) => v.code === 'MRQ_ANCHOR')).toBe(true);
    expect(res.violations.some((v) => v.code === 'MRQ_SLIDE')).toBe(false);
  });

  it('锁定段内切向移动 0.3m → 累计滑动 ≈ 0.3（相邻样本差分）', () => {
    const anchor: [number, number, number] = [0.1, 0, 0.09];
    const a = standFrame();
    const b = standFrame();
    // 脚在段内平移 0.3m（模拟滑步）
    (b.bonePos as Record<string, [number, number, number]>).LeftFoot = [0.4, 0.03, 0];
    const res = buildQualityReport({
      rig,
      frames: [{ ...a, t: 0 }, { ...b, t: 1 / 30 }],
      segments: [supportSeg(anchor, 0, 0.1)],
      anchorDeviations: [{ segmentId: 'x', marker: 'LeftFoot.ball', maxM: 0.31 }],
      reachResidualsM: { inner: 0, outer: 0 },
      rootCorrections: new Float64Array(6),
      switchJumpMps: 0,
      iterations: 1,
      converged: true,
      durationMs: 1,
      tolerances: defaultRetargetTolerances(),
    });
    // ball 标记跟随脚移动 0.3m；heel 标记同骨同段也移动 → 两者相加
    expect(res.metrics.cumulativeSlideM).toBeGreaterThan(0.29);
    expect(res.metrics.cumulativeSlideM).toBeLessThan(0.7);
    expect(res.violations.some((v) => v.code === 'MRQ_SLIDE')).toBe(true);
  });

  it('速度跳变口径：0.1×h_t/s 阈值，超限出违例', () => {
    const frames = [standFrame()];
    const res = buildQualityReport({
      rig,
      frames,
      segments: [],
      anchorDeviations: [],
      reachResidualsM: { inner: 0, outer: 0 },
      rootCorrections: new Float64Array(3),
      switchJumpMps: 0.2, // > 0.1×1.0
      iterations: 1,
      converged: true,
      durationMs: 1,
      tolerances: defaultRetargetTolerances(),
    });
    expect(res.violations.some((v) => v.code === 'MRQ_SWITCH_JUMP')).toBe(true);
  });

  it('markerWorldAt：从帧 + rig 标记读回世界点（rest 帧 = 踝 + 偏移，y 落支撑面）', () => {
    const fr = standFrame();
    const got = markerWorldAt(rig, fr, 'LeftFoot.ball')!;
    expect(got[0]).toBeCloseTo(0.1, 9);
    expect(got[1]).toBeCloseTo(0, 9);
    expect(got[2]).toBeCloseTo(0.09, 9);
  });
});
