/**
 * two-bone-solver.test.ts —— 解析核测试（MR-04；A05 解析部分 / A06 归此）。
 *
 * 全部断言手算（16A §4.8 的几何就是 oracle）。
 */
import { describe, it, expect } from 'vitest';
import {
  solveTwoBone,
  alignBoneRotation,
  worldToLocalRotation,
  swingBetweenDirections,
  rotateVec3,
} from '../../src/services/binding/motion-retarget/two-bone-solver';
import { quatMul, quatToMat, type Quat } from '../../src/services/binding/binding-math';

describe('solveTwoBone · 解析几何', () => {
  it.each([0, -1, NaN, Infinity])('rejects invalid segment length %s before solving', (length) => {
    for (const [l1, l2] of [[length, 0.4], [0.4, length]]) {
      expect(() => solveTwoBone({ root: [0, 0, 0], tip: [0, 0, 0], l1: l1!, l2: l2!, poleHint: null, prevKnee: null })).toThrow(RangeError);
    }
  });
  it.each([0.25, 1, 2])('closed reach boundaries retain exact geometry at scale %s', (scale) => {
    const l1 = 0.42 * scale, l2 = 0.45 * scale;
    for (const distance of [l1 + l2, Math.abs(l1 - l2)]) {
      const sol = solveTwoBone({ root: [0, 0, 0], tip: [0, -distance, 0], l1, l2, poleHint: [1, 0, 0], prevKnee: null });
      expect(sol.status).toBe('exact');
      expect(sol.residualM).toBe(0);
      expect(sol.knee[0]).toBe(0);
      expect(Math.hypot(...sol.knee)).toBeCloseTo(l1, 12);
      expect(Math.hypot(sol.knee[0], sol.knee[1] + distance, sol.knee[2])).toBeCloseTo(l2, 12);
    }
    const folded = solveTwoBone({ root: [0, 0, 0], tip: [0, 0, 0], l1, l2: l1, poleHint: [1, 0, 0], prevKnee: null });
    expect(folded.status).toBe('exact');
    expect(folded.reachedTip).toEqual([0, 0, 0]);
    expect(Math.hypot(...folded.knee)).toBeCloseTo(l1, 12);
  });
  it('可达目标：|K−A| = l1、|T−K| = l2（骨长严格保持，A05 的 ≤1e-6 在这里是 ≤1e-9）', () => {
    const sol = solveTwoBone({
      root: [0, 0.9, 0],
      tip: [0.05, 0.05, 0.02],
      l1: 0.45,
      l2: 0.45,
      poleHint: [0, 0, 1],
      prevKnee: null,
    });
    expect(sol.status).toBe('exact');
    expect(sol.residualM).toBe(0);
    expect(Math.hypot(sol.knee[0] - 0, sol.knee[1] - 0.9, sol.knee[2] - 0)).toBeCloseTo(0.45, 12);
    expect(Math.hypot(0.05 - sol.knee[0], 0.05 - sol.knee[1], 0.02 - sol.knee[2])).toBeCloseTo(0.45, 12);
  });

  it('pole 决定弯曲平面：poleHint +Z ⟹ 膝在 +Z 侧', () => {
    const sol = solveTwoBone({
      root: [0, 0.9, 0],
      tip: [0, 0.1, 0],
      l1: 0.45,
      l2: 0.45,
      poleHint: [0, 0, 1],
      prevKnee: null,
    });
    expect(sol.knee[2]).toBeGreaterThan(0.01);
    const back = solveTwoBone({
      root: [0, 0.9, 0],
      tip: [0, 0.1, 0],
      l1: 0.45,
      l2: 0.45,
      poleHint: [0, 0, -1],
      prevKnee: null,
    });
    expect(back.knee[2]).toBeLessThan(-0.01);
  });

  it('外侧不可达：夹到 l1+l2 并显式报残差（16A 附录 0.8/0.2 案例）', () => {
    const sol = solveTwoBone({
      root: [0, 0.2, 0],
      tip: [0, 0, 0],
      l1: 0.8,
      l2: 0.2,
      poleHint: [1, 0, 0],
      prevKnee: null,
    });
    expect(sol.status).toBe('clamped-in');
    expect(sol.residualM).toBeCloseTo(0.4, 9); // |0.8−0.2| − 0.2 = 0.4（16A 附录案例）
    // 外侧：tip 在 1.5m 外
    const out = solveTwoBone({
      root: [0, 0, 0],
      tip: [0, 1.5, 0],
      l1: 0.45,
      l2: 0.45,
      poleHint: [1, 0, 0],
      prevKnee: null,
    });
    expect(out.status).toBe('clamped-out');
    expect(out.residualM).toBeCloseTo(0.6, 9);
    // Clamping reaches the actual boundary, without introducing an artificial bend.
    expect(Math.hypot(out.reachedTip[0], out.reachedTip[1], out.reachedTip[2])).toBeCloseTo(0.9, 8);
  });

  it('退化：D=0 与 pole 平行于链轴都不产生 NaN', () => {
    const a = solveTwoBone({ root: [0, 0.5, 0], tip: [0, 0.5, 0], l1: 0.4, l2: 0.4, poleHint: null, prevKnee: null });
    expect(Number.isFinite(a.knee[0] + a.knee[1] + a.knee[2])).toBe(true);
    const b = solveTwoBone({ root: [0, 0.9, 0], tip: [0, 0.1, 0], l1: 0.45, l2: 0.45, poleHint: [0, 1, 0], prevKnee: null });
    expect(Number.isFinite(b.knee[0] + b.knee[1] + b.knee[2])).toBe(true);
  });

  it('prevKnee 保持跨帧弯曲平面连续（pole 平行退化时兜底）', () => {
    const prev = solveTwoBone({ root: [0, 0.9, 0], tip: [0.1, 0.1, 0], l1: 0.45, l2: 0.45, poleHint: [0, 0, 1], prevKnee: null });
    // 目标几乎沿链轴（poleHint 平行），prevKnee 提供平面
    const cur = solveTwoBone({ root: [0, 0.9, 0], tip: [0.001, 0.05, 0], l1: 0.45, l2: 0.45, poleHint: null, prevKnee: prev.knee });
    expect(cur.knee[2]).toBeGreaterThan(0);
  });
});

describe('旋转分配（A06）', () => {
  const h = Math.SQRT1_2;

  it.each([0, 1e-8, 5e-5, Math.PI - 5e-5, Math.PI])('IK swing preserves direction for angle %s', (angle) => {
    const from: [number, number, number] = [0, -1, 0];
    const target: [number, number, number] = [Math.sin(angle), -Math.cos(angle), 0];
    for (const length of [0.1, 0.42, 2]) {
      const q = swingBetweenDirections(from, target.map(v => v * length) as [number, number, number]);
      const result = rotateVec3(q, from);
      expect(Math.hypot(...result.map((v, i) => v - target[i]!))).toBeLessThan(1e-12);
    }
  });

  it('worldToLocalRotation：父旋转改变后，parent·local 仍等于期望世界朝向（≤ 数值精度）', () => {
    const desired: Quat = [0, h, 0, h]; // 世界 yaw 90°
    for (const parent of [[0, 0, 0, 1] as Quat, [0, 0, h, h] as Quat, [h, 0, 0, h] as Quat]) {
      const local = worldToLocalRotation(parent, desired);
      const composed = quatMul(parent, local);
      for (let k = 0; k < 4; k++) expect(composed[k]).toBeCloseTo(desired[k]!, 9);
    }
  });

  it('alignBoneRotation：组合出的世界方向 = 当前方向（父任意）', () => {
    const rest = [0, -1, 0] as [number, number, number];
    const cur = [Math.SQRT1_2, -Math.SQRT1_2, 0] as [number, number, number];
    const parent: Quat = [0, 0, h, h];
    const local = alignBoneRotation(parent, rest, cur);
    const world = quatMul(parent, local);
    const m = quatToMat(world);
    const got = [m[0]! * rest[0] + m[4]! * rest[1] + m[8]! * rest[2], m[1]! * rest[0] + m[5]! * rest[1] + m[9]! * rest[2], m[2]! * rest[0] + m[6]! * rest[1] + m[10]! * rest[2]];
    expect(got[0]).toBeCloseTo(cur[0], 9);
    expect(got[1]).toBeCloseTo(cur[1], 9);
    expect(got[2]).toBeCloseTo(cur[2], 9);
  });
});
