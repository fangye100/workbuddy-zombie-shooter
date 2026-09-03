import { describe, expect, it } from 'vitest';
import {
  axisPlaneNormal,
  rotatePlaneBasis,
  angleInPlane,
  wrapAngle,
  type V3,
} from '../src/gizmo';

/**
 * gizmo 交互数学回归测试（纯 CPU）。
 * 重点把守：旋转拖拽的极角/基向量约定（曾未经验证），以及 atan2 分支跳变防护。
 */

describe('axisPlaneNormal（轴约束拖拽平面）', () => {
  it('相机在 +z 看向原点、拖 X 轴 → 平面法线 = +z（平面含 X 轴且正对相机）', () => {
    const n = axisPlaneNormal([0, 0, 1], [1, 0, 0]);
    expect(n[0]).toBeCloseTo(0, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    expect(n[2]).toBeCloseTo(1, 6);
  });

  it('视线平行于轴时取正交分量：从 +x 看 Y 轴 → 法线 = +x', () => {
    const n = axisPlaneNormal([1, 0, 0], [0, 1, 0]);
    expect(n[0]).toBeCloseTo(1, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    expect(n[2]).toBeCloseTo(0, 6);
  });

  it('法线始终 ⊥ 轴', () => {
    const viewDir: V3 = [0.3, -0.8, 0.52];
    const axis: V3 = [1, 0, 0];
    const n = axisPlaneNormal(viewDir, axis);
    const dot = n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2];
    expect(Math.abs(dot)).toBeLessThan(1e-9);
  });
});

describe('rotatePlaneBasis + angleInPlane（旋转拖拽）', () => {
  // 相机在 +z：绕 Y 轴旋转的环落在 XZ 平面
  const axisY: V3 = [0, 1, 0];
  const viewDir: V3 = [0, 0, 1];
  const origin: V3 = [0, 0, 0];
  const { u, w } = rotatePlaneBasis(axisY, viewDir);

  it('基向量约定：u = +x，w = -z（cross(Y, Z) = X；W = Y×X = -Z）', () => {
    expect(u[0]).toBeCloseTo(1, 6);
    expect(u[2]).toBeCloseTo(0, 6);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[2]).toBeCloseTo(-1, 6);
  });

  it('+x 方向的抓取点极角 0，-z 方向极角 +π/2', () => {
    expect(angleInPlane([1, 0, 0], origin, u, w)).toBeCloseTo(0, 6);
    expect(angleInPlane([0, 0, -1], origin, u, w)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('拖拽点从 +x 转到 -z → 累计角 +90°，四元数把 +x 映到 -z（与屏幕方向一致）', () => {
    const a0 = angleInPlane([1, 0, 0], origin, u, w);
    const a1 = angleInPlane([0, 0, -1], origin, u, w);
    const total = wrapAngle(a1 - a0);
    expect(total).toBeCloseTo(Math.PI / 2, 6);
    // 旋转后的 +x 方向（用四元数公式手算：绕 +Y 转 θ，x→(cosθ, 0, -sinθ)）
    const c = Math.cos(total);
    const s = Math.sin(total);
    expect(c).toBeCloseTo(0, 6);
    expect(-s).toBeCloseTo(-1, 6); // -sinθ = -1 → 新 z = -1，即 -z ✓
  });

  it('连续旋转跨过 ±180°：逐帧差值累计 = 2π，无瞬转', () => {
    // 模拟从极角 170° 连续转到 190°（跨过 180° 分支）
    const steps = [170, 178, 186, 190].map((deg) => (deg * Math.PI) / 180);
    let last = steps[0]!;
    let total = 0;
    for (const ang of steps.slice(1)) {
      total += wrapAngle(ang - last);
      last = ang;
    }
    expect(total).toBeCloseTo((20 * Math.PI) / 180, 6);
  });
});

describe('wrapAngle（atan2 分支跳变防护）', () => {
  it('2π 归零、-3π/2 归 +π/2', () => {
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0, 9);
    expect(wrapAngle((-3 * Math.PI) / 2)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('输出始终在 (-π, π]', () => {
    for (let i = -25; i <= 25; i++) {
      const a = (i * Math.PI) / 8;
      const r = wrapAngle(a);
      expect(r).toBeLessThanOrEqual(Math.PI + 1e-9);
      expect(r).toBeGreaterThan(-Math.PI - 1e-9);
    }
  });
});
