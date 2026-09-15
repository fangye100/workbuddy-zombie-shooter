/**
 * two-bone-solver.ts —— 两骨解析 IK 核（MR-04，docs/16 §4.1 / 16A §4.8）。
 *
 * 根 A、末端 T、骨长 l1/l2，可达域 |l1−l2| ≤ D ≤ l1+l2：
 *   e = (T−A)/D, a = (l1²−l2²+D²)/(2D), b = √(l1²−a²), K = A + a·e + b·v
 * v 是正交于 e 的弯曲方向（pole）。不可达时**显式**夹取并报残差，绝不静默拉骨。
 *
 * 旋转分配：世界方向 → 局部旋转用「父世界逆 × from-to 最小旋转」；
 * 最小 from-to 本身是纯 swing（无绕目标轴 twist），扭转保持交给上层基准，
 * 不在这里二次分解假装保住 twist（docs/16 §4.1）。
 */

import { quatMul, type Quat } from '../binding-math';
import type { V3 } from './contracts';

export interface TwoBoneInput {
  root: V3;
  tip: V3;
  l1: number;
  l2: number;
  /** 弯曲参考方向（世界系；源膝方向或指定 pole）。null = 用 prevKnee 或退化默认 */
  poleHint: V3 | null;
  /** 上一帧膝位置（跨帧连续；完全退化时也拿不到就用确定性默认） */
  prevKnee: V3 | null;
}

export type TwoBoneStatus = 'exact' | 'clamped-out' | 'clamped-in';

export interface TwoBoneSolution {
  knee: V3;
  status: TwoBoneStatus;
  /** 不可达残差（米，≥0；exact 时 0） */
  residualM: number;
  /** 实际到达的末端（clamped 时 = 沿方向的最近可达点） */
  reachedTip: V3;
}

function sub3(a: V3, b: V3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add3(a: V3, b: V3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale3(a: V3, s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function len3(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function conj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function rotateVec3(q: Quat, v: V3): [number, number, number] {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

export function solveTwoBone(input: TwoBoneInput): TwoBoneSolution {
  const { root, tip, l1, l2 } = input;
  if (!Number.isFinite(l1) || !Number.isFinite(l2) || l1 <= 0 || l2 <= 0) {
    throw new RangeError('Two-bone IK requires finite, positive segment lengths');
  }
  const delta = sub3(tip, root);
  const dReq = len3(delta);
  const dMax = l1 + l2;
  const dMin = Math.abs(l1 - l2);

  let status: TwoBoneStatus = 'exact';
  let residualM = 0;
  let d = dReq;
  if (dReq > dMax) {
    status = 'clamped-out';
    residualM = dReq - (l1 + l2);
    d = dMax;
  } else if (dReq < dMin && dReq >= 0) {
    status = 'clamped-in';
    residualM = Math.abs(l1 - l2) - dReq;
    d = dMin;
  }

  // e 用**原始**方向（夹取只改距离，不改方向）；D=0 时取确定性默认
  const e: [number, number, number] = dReq > 1e-12 ? scale3(delta, 1 / dReq) : [0, 0, 1];
  const reachedTip: [number, number, number] =
    status === 'exact' ? [tip[0], tip[1], tip[2]] : add3(root, scale3(e, d));

  // Use the closed reach interval. Artificially shortening a straight limb creates
  // a sqrt(epsilon)-sized bend and makes positions disagree with its rotations.
  // Coincident endpoints with equal lengths form a fully folded limb.
  const a = d === 0 ? 0 : d === dMax ? l1 :
    d === dMin ? (l1 >= l2 ? l1 : -l1) :
      (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const b = d === dMax || (d === dMin && d > 0) ? 0 : Math.sqrt(Math.max(0, l1 * l1 - a * a));

  // 弯曲方向 v：poleHint − (poleHint·e)e；退化用 prevKnee；再退化用确定性正交基
  let v = orthogonalize(input.poleHint, e);
  if (v === null && input.prevKnee !== null) {
    v = orthogonalize(sub3(input.prevKnee, root), e);
  }
  if (v === null) v = defaultPerp(e);

  const knee = add3(add3(root, scale3(e, a)), scale3(v, b));
  return { knee, status, residualM, reachedTip };
}

function orthogonalize(p: V3 | null, e: V3): [number, number, number] | null {
  if (p === null) return null;
  const t = sub3(p, scale3(e, dot3(p, e)));
  const l = len3(t);
  if (l < 1e-9) return null;
  return scale3(t, 1 / l);
}

function defaultPerp(e: V3): [number, number, number] {
  // 与 e 不平行的坐标轴做正交化；e 接近 +X 时用 +Y，否则用 +X
  const ref: V3 = Math.abs(e[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return orthogonalize(ref, e)!;
}

/**
 * 世界方向 → 骨局部旋转：local = inv(parentWorld) · fromTo(restWorldDir, currentWorldDir)。
 * 输入**可以是任意长度**的位移向量（如 knee−hip，模长 = 骨长）——内部先归一化，
 * 再计算保留微小角度的 swing（不归一化会让对齐角随骨长变化）。
 * 纯 swing（最小弧）；twist 保持是上层基准的事。零长度方向 = 不旋转。
 */
export function alignBoneRotation(
  parentWorldQuat: Quat,
  restWorldDir: V3,
  currentWorldDir: V3,
): Quat {
  return quatMul(conj(parentWorldQuat), swingBetweenDirections(restWorldDir, currentWorldDir));
}

/** Minimal swing for IK geometry, retaining small angles at either end of [0, pi]. */
export function swingBetweenDirections(from: V3, to: V3): Quat {
  const a = unitOrZero(from);
  const b = unitOrZero(to);
  if (a === null || b === null) return [0, 0, 0, 1];
  const cross: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sin = len3(cross);
  const cos = Math.max(-1, Math.min(1, dot3(a, b)));
  if (sin === 0) {
    if (cos >= 0) return [0, 0, 0, 1];
    const axis = defaultPerp(a);
    return [axis[0], axis[1], axis[2], 0];
  }
  const half = Math.atan2(sin, cos) / 2;
  const factor = Math.sin(half) / sin;
  return [cross[0] * factor, cross[1] * factor, cross[2] * factor, Math.cos(half)];
}

function unitOrZero(v: V3): [number, number, number] | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-12) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** 目标世界朝向 → 局部：local = inv(parentWorld) · desiredWorld（足/掌世界朝向任务） */
export function worldToLocalRotation(parentWorldQuat: Quat, desiredWorld: Quat): Quat {
  return quatMul(conj(parentWorldQuat), desiredWorld);
}
