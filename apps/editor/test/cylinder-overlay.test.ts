/**
 * 蒙皮包裹器圆柱体几何（binding/cylinder-overlay）单测。
 *
 * 覆盖的是「在视图里看不见圆柱体」这一类 bug 的几何侧根因：
 *   - 骨段退化（父子重合）→ 长度为 0 的圆柱 = 完全不可见
 *   - NaN 坐标（正交基退化 / 除零）→ 整块几何被 GPU 丢掉
 *   - 顶点数不是 9 的倍数 → 引擎按 stride 36B 读会错位/截断
 *   - disabled 的包裹器不该被画出来
 */

import { describe, it, expect } from 'vitest';
import {
  buildCylinderOverlay,
  buildCylinderOverlayFromSegments,
  CYL_VERT_FLOATS,
} from '../src/services/binding/cylinder-overlay';
import type { SkeletonData } from '@aether/scene';
import type { SkinCylinderMap } from '../src/services/binding/skin-proxy';

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/** 关节矩阵：只填平移列（12/13/14），其余为单位 —— 足够本函数取用 */
function jointMatrices(points: Array<[number, number, number]>): Float32Array {
  const m = new Float32Array(points.length * 16);
  for (let i = 0; i < points.length; i++) {
    const o = i * 16;
    m[o] = 1; m[o + 5] = 1; m[o + 10] = 1; m[o + 15] = 1;
    m[o + 12] = points[i]![0];
    m[o + 13] = points[i]![1];
    m[o + 14] = points[i]![2];
  }
  return m;
}

function fakeSkeleton(
  parent: number[],
  jointNames: Array<string | null>,
): SkeletonData {
  return {
    joints: parent.map((_, i) => i),
    jointNames,
    inverseBind: new Float32Array(parent.length * 16),
    parent,
    locals: [],
    roots: [0],
    normalization: identity(),
  } as unknown as SkeletonData;
}

/** 拆出所有顶点坐标分量，便于做范围/有限性断言 */
function positionsOf(v: Float32Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < v.length; i += CYL_VERT_FLOATS) {
    out.push([v[i]!, v[i + 1]!, v[i + 2]!]);
  }
  return out;
}

describe('buildCylinderOverlay', () => {
  it('单根骨产出完整侧壁 + 两端盖，顶点数是 stride 的整数倍', () => {
    const sk = fakeSkeleton([-1, 0], ['Hips', 'Spine']);
    const jm = jointMatrices([[0, 0, 0], [0, 0.4, 0]]);
    const ov = buildCylinderOverlay(jm, sk, identity(), null, { sides: 10 });
    expect(ov).not.toBeNull();
    // 每根骨 = 3 段侧壁(3×10×6) + 2 端盖(2×10×3) = 240 顶点
    expect(ov!.vertices.length).toBe(240 * CYL_VERT_FLOATS);
    expect(ov!.vertices.length % CYL_VERT_FLOATS).toBe(0);
  });

  it('圆柱体确实落在两个关节之间（含半径外扩），且没有 NaN', () => {
    const sk = fakeSkeleton([-1, 0], ['Hips', 'Spine']);
    const jm = jointMatrices([[0, 0, 0], [0, 0.4, 0]]);
    const ov = buildCylinderOverlay(jm, sk, identity(), null, { sides: 10 })!;
    const pts = positionsOf(ov.vertices);
    expect(pts.length).toBeGreaterThan(0);
    // 默认半径 = 0.4 × 0.35 = 0.14
    for (const [x, y, z] of pts) {
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.14 + 1e-6);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.14 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-0.14 - 1e-6);
      expect(y).toBeLessThanOrEqual(0.4 + 0.14 + 1e-6);
    }
  });

  it('退化骨段（父子重合）不会产出零长度圆柱——这是"看不见"的典型根因', () => {
    const sk = fakeSkeleton([-1, 0], ['Hips', 'Spine']);
    // 子关节与父关节完全重合 → 若不特判，圆柱长度为 0，屏幕上什么都没有
    const jm = jointMatrices([[0, 0, 0], [0, 0, 0]]);
    const ov = buildCylinderOverlay(jm, sk, identity(), null, { sides: 10 });
    expect(ov).not.toBeNull();
    const pts = positionsOf(ov!.vertices);
    const ys = pts.map((p) => p[1]);
    const span = Math.max(...ys) - Math.min(...ys);
    // 必须撑开成一个可见的小圆柱，而不是退化成一个点
    expect(span).toBeGreaterThan(0.01);
  });

  it('半径取自 SkinCylinderMap，且 enabled=false 的包裹器不画', () => {
    const sk = fakeSkeleton([-1, 0], ['Hips', 'Spine']);
    const jm = jointMatrices([[0, 0, 0], [0, 0.4, 0]]);

    const big: SkinCylinderMap = {
      Hips: { bone: 'Hips', radii: { top: 0.3, medium: 0.3, bottom: 0.3 }, enabled: true },
    };
    const wide = buildCylinderOverlay(jm, sk, identity(), big, { sides: 10 })!;
    const maxAbsX = Math.max(...positionsOf(wide.vertices).map((p) => Math.abs(p[0])));
    expect(maxAbsX).toBeGreaterThan(0.29); // 用了 0.3 而不是默认 0.14

    const off: SkinCylinderMap = {
      Hips: { bone: 'Hips', radii: { top: 0.3, medium: 0.3, bottom: 0.3 }, enabled: false },
    };
    expect(buildCylinderOverlay(jm, sk, identity(), off, { sides: 10 })).toBeNull();
  });

  it('无骨骼 / 只有根关节时不产出叠加层', () => {
    const sk = fakeSkeleton([-1], ['Hips']);
    const jm = jointMatrices([[0, 0, 0]]);
    expect(buildCylinderOverlay(jm, sk, identity(), null)).toBeNull();
  });

  it('modelMatrix 生效：圆柱跟着物体世界变换走', () => {
    const sk = fakeSkeleton([-1, 0], ['Hips', 'Spine']);
    const jm = jointMatrices([[0, 0, 0], [0, 0.4, 0]]);
    const m = identity();
    m[12] = 5; m[13] = 2; m[14] = -3; // 平移
    const ov = buildCylinderOverlay(jm, sk, m, null, { sides: 10 })!;
    for (const [x, y, z] of positionsOf(ov.vertices)) {
      expect(Math.abs(x - 5)).toBeLessThanOrEqual(0.14 + 1e-6);
      expect(Math.abs(z + 3)).toBeLessThanOrEqual(0.14 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(2 - 0.14 - 1e-6);
    }
  });
});

describe('buildCylinderOverlayFromSegments', () => {
  it('面板路径：骨段直接驱动几何，每骨仍是 240 顶点（与主视口一致）', () => {
    const segs = [
      { bone: 'Hips', a: [0, 0, 0] as const, b: [0, 0.4, 0] as const },
      { bone: 'Spine', a: [0, 0.4, 0] as const, b: [0, 0.8, 0] as const },
    ];
    const ov = buildCylinderOverlayFromSegments(segs, null, { sides: 10 });
    expect(ov).not.toBeNull();
    expect(ov!.vertices.length).toBe(240 * 2 * CYL_VERT_FLOATS);
  });

  it('null / 空数组 → 不画（面板在关节模式下不传 segs）', () => {
    expect(buildCylinderOverlayFromSegments(null, null)).toBeNull();
    expect(buildCylinderOverlayFromSegments([], null)).toBeNull();
  });

  it('退化骨段（a==b）撑成最小长度的竖直圆柱，不会塌成不可见', () => {
    const segs = [{ bone: 'Leaf', a: [0.5, 1.0, 0] as const, b: [0.5, 1.0, 0] as const }];
    const ov = buildCylinderOverlayFromSegments(segs, null)!;
    const pts = positionsOf(ov.vertices);
    // 撑成至少 0.02 长（max(0.02, 2*rb)）；rb 由 len<1e-5 路径用 default 公式 r=min(0.22, 0.04)
    // → length = max(0.02, 2*0.04) = 0.08，所以 y 跨度 ≈ 0.08
    let yMin = Infinity, yMax = -Infinity;
    for (const [, y] of pts) {
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    expect(yMax - yMin).toBeGreaterThan(0.01);
  });

  it('disabled 包裹器跳过；其它骨照画', () => {
    const segs = [
      { bone: 'A', a: [0, 0, 0] as const, b: [0, 0.4, 0] as const },
      { bone: 'B', a: [0, 0.4, 0] as const, b: [0, 0.8, 0] as const },
    ];
    const cyls: SkinCylinderMap = {
      A: { bone: 'A', enabled: false, radii: { bottom: 0.04, medium: 0.04, top: 0.04 } },
      B: { bone: 'B', enabled: true, radii: { bottom: 0.1, medium: 0.1, top: 0.1 } },
    };
    const ov = buildCylinderOverlayFromSegments(segs, cyls)!;
    expect(ov.vertices.length).toBe(240 * CYL_VERT_FLOATS);
  });
});
