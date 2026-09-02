/**
 * Transform Gizmo 交互数学（Game Editor）。
 *
 * 几何（arrow / ring / box / torus 顶点生成）已上提进引擎层
 * `packages/render/src/gizmo.ts` 的 `buildGizmoHandles()`，由 `RendererCore` 持有；
 * 编辑器侧只保留「命中测试 / 拖拽」所需的纯函数——它们要读相机 ray / viewProj，
 * 所以放在这里（main.ts 调用）。
 *
 * 颜色用项目 token（红=血红 / 绿=尸绿 / 蓝=电光青），几何侧直接写 sRGB。
 */

import * as m4 from '@aether/core';

/** 与全项目共用的向量类型（main.ts / 相机 / 拖拽都用它） */
export type V3 = m4.Vec3;

/**
 * 轴约束拖拽平面的法线：平面必须包含该轴，且尽量朝向相机
 * （取视线在垂直于轴方向上的分量）。拖拽期间相机不动，法线恒定。
 */
export function axisPlaneNormal(viewDir: V3, axisDir: V3): V3 {
  const d = m4.v3dot(viewDir, axisDir);
  return m4.v3norm([
    viewDir[0] - axisDir[0] * d,
    viewDir[1] - axisDir[1] * d,
    viewDir[2] - axisDir[2] * d,
  ]);
}

/** 旋转拖拽的平面内正交基（u、w 都 ⊥ 轴；u 由视线决定，拖拽期间稳定） */
export function rotatePlaneBasis(axisDir: V3, viewDir: V3): { u: V3; w: V3 } {
  const u = m4.v3norm(m4.v3cross(axisDir, viewDir));
  const w = m4.v3cross(axisDir, u);
  return { u, w };
}

/** 点 q 在平面基 (u, w) 下相对 origin 的极角 */
export function angleInPlane(q: V3, origin: V3, u: V3, w: V3): number {
  const d: V3 = [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]];
  return Math.atan2(m4.v3dot(d, w), m4.v3dot(d, u));
}

/** 归一化到 (-π, π]：atan2 在 ±180° 处分支跳变，逐帧差值必须过这里，否则连续旋转会 ±2π 瞬转 */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
