/**
 * WU-03 静态环境镜像适配：把场景 collider 真源（稳定 NodeId + 真实世界矩阵）
 * 转成 Rapier 静态 collider。禁止另造隐藏地面/墙体——只镜像既有 collider。
 *
 * 变换核对：复用 scene 的 decomposeMatrixToTrs（与 three.js 约定一致，含镜像符号）。
 * - box：世界均匀/非均匀缩放折进 halfExtents，旋转取世界旋转。
 * - sphere：仅允许均匀缩放（|sx|=|sy|=|sz|）；非均匀明确拒绝，不静默当均匀。
 * - capsule：仅允许均匀缩放；非均匀/shear 拒绝。
 * - shear（旋转列不正交）：所有形状拒绝，产出 diagnostic，不静默近似。
 * 离线凸代理（WU-02 资产提供）按世界缩放预乘后走 convex，绕过均匀缩放限制。
 */

import { decomposeMatrixToTrs } from '@aether/scene';
import type { ColliderComponent, NodeId } from '@aether/scene';
import type { FractureVec3, FractureQuat } from './fracture';

export type StaticMirrorShape =
  | { type: 'box'; halfExtents: FractureVec3 }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; height: number }
  | { type: 'convex'; points: Float32Array };

export interface StaticMirrorSpec {
  nodeId: NodeId;
  position: FractureVec3;
  rotation: FractureQuat;
  shape: StaticMirrorShape;
  isTrigger: boolean;
}

export interface StaticMirrorResult {
  ok: boolean;
  spec?: StaticMirrorSpec;
  diagnostic?: string;
}

const SCALE_EPS = 1e-4;
const ORTHO_EPS = 1e-3;

/** 检测 shear：世界矩阵旋转部分（去缩放后）的列是否正交。 */
function hasShear(m: Float32Array | number[], sx: number, sy: number, sz: number): boolean {
  const c0 = [m[0]! / sx, m[1]! / sx, m[2]! / sx];
  const c1 = [m[4]! / sy, m[5]! / sy, m[6]! / sy];
  const c2 = [m[8]! / sz, m[9]! / sz, m[10]! / sz];
  const d01 = c0[0]! * c1[0]! + c0[1]! * c1[1]! + c0[2]! * c1[2]!;
  const d02 = c0[0]! * c2[0]! + c0[1]! * c2[1]! + c0[2]! * c2[2]!;
  const d12 = c1[0]! * c2[0]! + c1[1]! * c2[1]! + c1[2]! * c2[2]!;
  return Math.abs(d01) > ORTHO_EPS || Math.abs(d02) > ORTHO_EPS || Math.abs(d12) > ORTHO_EPS;
}

function uniformScale(sx: number, sy: number, sz: number): number | null {
  const a = Math.abs(sx), b = Math.abs(sy), c = Math.abs(sz);
  if (Math.abs(a - b) > SCALE_EPS || Math.abs(b - c) > SCALE_EPS) return null;
  return (a + b + c) / 3;
}

/**
 * 把一个场景 collider 的世界矩阵分解为静态镜像规格。
 * world 为 SceneGraph.worldMatrix(nodeId) 的真实世界矩阵（含全部父级嵌套 TRS）。
 * 不支持的组合返回 diagnostic，绝不静默近似。
 */
export function sceneColliderToStaticMirror(
  nodeId: NodeId,
  shape: ColliderComponent['shape'],
  isTrigger: boolean,
  world: Float32Array | number[],
): StaticMirrorResult {
  if (!world.every(Number.isFinite)) {
    return { ok: false, diagnostic: `collider ${nodeId} 世界矩阵含非有限值` };
  }
  const { t, r, s } = decomposeMatrixToTrs(world);
  const [sx, sy, sz] = s;
  if (Math.abs(sx) < 1e-9 || Math.abs(sy) < 1e-9 || Math.abs(sz) < 1e-9) {
    return { ok: false, diagnostic: `collider ${nodeId} 世界缩放退化（近零轴）` };
  }
  if (hasShear(world, sx, sy, sz)) {
    return { ok: false, diagnostic: `collider ${nodeId} 世界变换含 shear，不支持安全镜像` };
  }
  const position: FractureVec3 = [t[0], t[1], t[2]];
  const rotation: FractureQuat = [r[0], r[1], r[2], r[3]];

  if (shape.type === 'box') {
    const he: FractureVec3 = [
      shape.halfExtents[0] * Math.abs(sx),
      shape.halfExtents[1] * Math.abs(sy),
      shape.halfExtents[2] * Math.abs(sz),
    ];
    if (!he.every((v) => Number.isFinite(v) && v > 0)) {
      return { ok: false, diagnostic: `collider ${nodeId} box 缩放后半尺寸非正` };
    }
    return { ok: true, spec: { nodeId, position, rotation, shape: { type: 'box', halfExtents: he }, isTrigger } };
  }
  if (shape.type === 'sphere') {
    const u = uniformScale(sx, sy, sz);
    if (u === null) {
      return { ok: false, diagnostic: `collider ${nodeId} sphere 非均匀缩放（${sx},${sy},${sz}），拒绝近似为均匀` };
    }
    const radius = shape.radius * u;
    if (!Number.isFinite(radius) || radius <= 0) {
      return { ok: false, diagnostic: `collider ${nodeId} sphere 缩放后半径非正` };
    }
    return { ok: true, spec: { nodeId, position, rotation, shape: { type: 'sphere', radius }, isTrigger } };
  }
  if (shape.type === 'capsule') {
    const u = uniformScale(sx, sy, sz);
    if (u === null) {
      return { ok: false, diagnostic: `collider ${nodeId} capsule 非均匀缩放（${sx},${sy},${sz}），拒绝近似为均匀` };
    }
    // 简化层按「竖直胶囊」求支撑（圆截面 + 圆柱段半高）。倾斜胶囊的竖向轮廓
    // 与之不同：镜像进来会让碎块悬空/穿透，所以明确拒绝并给诊断，不静默近似。
    const [cqx, cqy, cqz, cqw] = rotation;
    const ax = 2 * (cqx * cqy - cqw * cqz);
    const ay = 1 - 2 * (cqx * cqx + cqz * cqz);
    const az = 2 * (cqy * cqz + cqw * cqx);
    const axis = Math.hypot(ax, ay, az) || 1;
    if (Math.abs(ay) / axis < 0.996) {
      return { ok: false, diagnostic: 'collider ' + nodeId + ' capsule 非竖直（轴向 ' + ax.toFixed(3) + ',' + ay.toFixed(3) + ',' + az.toFixed(3) + '），简化层只支持竖直胶囊' };
    }
    return {
      ok: true,
      spec: { nodeId, position, rotation, shape: { type: 'capsule', radius: shape.radius * u, height: shape.height * u }, isTrigger },
    };
  }
  return { ok: false, diagnostic: `collider ${nodeId} 不支持的形状类型 ${(shape as { type: string }).type}` };
}
