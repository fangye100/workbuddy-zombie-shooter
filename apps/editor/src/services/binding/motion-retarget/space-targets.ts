/**
 * space-targets.ts —— 空间补偿规则（MR-02）。
 *
 * docs/16 §3 的落地：
 *  - `SpaceMapping`：S(p) = o_t + s_root·C(p − o_s)；标定自洽要求 S(H_src_ref)=H_tgt_ref；
 *  - 双模式（2026-09-15 钉板）：normalize-gait 全走 S；preserve-world 下
 *    世界锚点保持米制、根竖直缩放/水平软目标；
 *  - 根候选轨迹（吃**源原始采样**，不吃已缩放的 L0 输出——防二次缩放）；
 *  - 自由末端目标（§3.2 归一化链空间映射）；
 *  - 接触锚点 a_k = projectToPlane(S(median(P_src[I_k])))，整段共享，不逐帧重设；
 *  - A02 反例：根/末端不同比例的漂移估算（诊断用，不用于接触目标构造）。
 */

import type { Quat } from '../binding-math';
import type { ContactSegment, SourceMotion, V3 } from './contracts';

export type SpaceMode = 'normalize-gait' | 'preserve-world';

export interface Plane {
  origin: V3;
  normal: V3;
}

export interface SpaceMapping {
  mode: SpaceMode;
  /** h_t / h_s */
  sRoot: number;
  /** 固定世界朝向对齐（当前恒 identity；保留显式字段防隐式假设） */
  C: Quat;
  oSrc: V3;
  oTgt: V3;
  /** 身体相对点（根候选/默认足迹/自由末端参考）映射 */
  mapBodyRelative(p: V3): [number, number, number];
  /** 世界锚点/物体目标映射：normalize-gait 走 S；preserve-world 保米制 */
  mapWorldAnchor(p: V3): [number, number, number];
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

function rotateQuat(q: Quat, v: V3): [number, number, number] {
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

/**
 * 构造空间映射。标定自检：S(参考站姿骨盆) 必须落在目标参考骨盆高上，
 * 不满足时返回诊断（错误在平面/原点标定，不允许用整体下降掩盖）。
 */
export function buildSpaceMapping(
  hSrcM: number,
  hTgtM: number,
  opts: { mode?: SpaceMode; oSrc?: V3; oTgt?: V3; C?: Quat } = {},
): { mapping: SpaceMapping; calibrationErrorM: number } {
  const sRoot = hTgtM / hSrcM;
  const C: Quat = opts.C ?? [0, 0, 0, 1];
  const oSrc: V3 = opts.oSrc ?? [0, 0, 0];
  const oTgt: V3 = opts.oTgt ?? [0, 0, 0];
  const mode = opts.mode ?? 'normalize-gait';

  const similarity = (p: V3): [number, number, number] => {
    // S(p) = o_t + s·C·(p − o_s)：C 是固定世界朝向对齐（非 identity 时也参与）。
    // 注意：contactAnchor 是 median∘map；C 恒 identity 时与文档的 map∘median 等价，
    // 启用非 identity C 时须改为先取中值再映射（逐坐标中值不与旋转交换）。
    const d = sub3(p, oSrc);
    const r = rotateQuat(C, d);
    return add3(oTgt, scale3(r, sRoot));
  };
  const identityAnchor = (p: V3): [number, number, number] => [p[0], p[1], p[2]];

  const mapping: SpaceMapping = {
    mode,
    sRoot,
    C,
    oSrc,
    oTgt,
    mapBodyRelative: similarity,
    mapWorldAnchor: mode === 'normalize-gait' ? similarity : identityAnchor,
  };

  // 标定自检：骨盆参考点（源平面上方 h_s）映射后应在目标平面上方 h_t
  const srcRef: V3 = [oSrc[0], oSrc[1] + hSrcM, oSrc[2]];
  const mapped = similarity(srcRef);
  const calibrationErrorM = Math.abs(mapped[1] - (oTgt[1] + hTgtM));
  return { mapping, calibrationErrorM };
}

// ---------------------------------------------------------------- 根轨迹

export interface RootCandidate {
  /** (frames × 3) 米 */
  positions: Float64Array;
  /** 根朝向轨迹（源 yaw 保留，不随接触求解改变；A18） */
  quats: Float64Array;
}

/**
 * 根候选轨迹 H_bar(t)（§3.1）。
 * **输入必须是源原始世界采样**（SourceMotion.worldPositions）——把已缩放的
 * L0 根轨道再喂进来会二次缩放（docs/16 §1 明令禁止）。
 * preserve-world：竖直按 s_root 归一（骨盆高是身体属性），水平保持米制（世界距离）。
 */
export function rootCandidate(sm: SourceMotion, map: SpaceMapping): RootCandidate {
  const src = sm.worldPositions[sm.rootBone];
  const rot = sm.worldRotations[sm.rootBone];
  const frames = sm.times.length;
  const out = new Float64Array(frames * 3);
  const quats = new Float64Array(frames * 4);
  if (src === undefined) return { positions: out, quats };
  for (let f = 0; f < frames; f++) {
    const p: V3 = [src[f * 3]!, src[f * 3 + 1]!, src[f * 3 + 2]!];
    let mapped: [number, number, number];
    if (map.mode === 'normalize-gait') {
      mapped = map.mapBodyRelative(p);
    } else {
      const b = map.mapBodyRelative(p);
      mapped = [p[0], b[1], p[2]];
    }
    out[f * 3] = mapped[0];
    out[f * 3 + 1] = mapped[1];
    out[f * 3 + 2] = mapped[2];
    if (rot !== undefined) {
      for (let k = 0; k < 4; k++) quats[f * 4 + k] = rot[f * 4 + k]!;
    } else {
      quats[f * 4 + 3] = 1;
    }
  }
  return { positions: out, quats };
}

// ---------------------------------------------------------------- 自由末端

/**
 * 自由部位目标（§3.2）：u = (P_src − A_src)/L_src（链附着系 U 恒取规范世界轴的
 * 同轴简化，16A §4.4 允许），P_free = A_tgt + L_tgt·u。
 * `A_tgt` 必须来自目标当前 FK（调用方传入），不能用「骨盆+常量偏移」。
 */
export function freeLimbTarget(
  pSrc: V3,
  aSrc: V3,
  lSrc: number,
  aTgt: V3,
  lTgt: number,
): [number, number, number] {
  if (!(lSrc > 1e-9)) return [aTgt[0], aTgt[1], aTgt[2]];
  const u = scale3(sub3(pSrc, aSrc), 1 / lSrc);
  return add3(aTgt, scale3(u, lTgt));
}

/**
 * A02 反例诊断：根/末端比例不同时，源静止末端的映射目标漂移
 * dP̂/dt = (r_root − r_tip)·dH/dt。只作诊断，不得用于接触目标构造
 * （接触期必须换世界固定目标或零速度约束）。
 */
export function radialDriftM(rRoot: number, rTip: number, rootTravelM: number): number {
  return (rRoot - rTip) * rootTravelM;
}

// ---------------------------------------------------------------- 接触锚点

/** p 到平面的投影（沿法向） */
export function projectToPlane(p: V3, plane: Plane): [number, number, number] {
  const d = dot3(sub3(p, plane.origin), plane.normal);
  return sub3(p, scale3(plane.normal, d));
}

/** 点到平面的带符号距离（法向为正） */
export function signedPlaneDistance(p: V3, plane: Plane): number {
  return dot3(sub3(p, plane.origin), plane.normal);
}

/**
 * 接触锚点 a_k（§3.3）：时段内标记世界的**逐坐标中值**（稳健，个别噪声帧不拉动）
 * → 世界映射（按模式）→ 投影到目标支撑平面。
 * 锚点是整段共享变量——只在这里构造一次，时段内不许逐帧重设。
 */
export function contactAnchor(
  markerTraj: Float64Array,
  frameStart: number,
  frameEnd: number,
  map: SpaceMapping,
  plane: Plane,
): [number, number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let f = frameStart; f <= frameEnd; f++) {
    const p = map.mapWorldAnchor([markerTraj[f * 3]!, markerTraj[f * 3 + 1]!, markerTraj[f * 3 + 2]!]);
    xs.push(p[0]);
    ys.push(p[1]);
    zs.push(p[2]);
  }
  const median = (arr: number[]): number => {
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  return projectToPlane([median(xs), median(ys), median(zs)], plane);
}

/**
 * 踝目标（§3.3）：P_ankle = a_k − R_foot_world · b_target。
 * R_foot_world 用**源映射的脚世界朝向**（不依赖求解结果），b 是目标脚的局部标记。
 */
export function ankleTargetFromMarker(
  anchor: V3,
  footWorldQuat: Quat,
  markerLocal: V3,
): [number, number, number] {
  return sub3(anchor, rotateVec3(footWorldQuat, markerLocal));
}

function rotateVec3(q: Quat, v: V3): [number, number, number] {
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

// ---------------------------------------------------------------- 接触段锚点

/** 求解期把锚点写回接触段（ContactSegment.anchor 只经此路径赋值，保持共享语义） */
export function assignContactAnchors(
  segments: ContactSegment[],
  anchors: ReadonlyMap<string, V3>,
): ContactSegment[] {
  return segments.map((s) => {
    const a = anchors.get(s.id);
    return a === undefined ? s : { ...s, anchor: [a[0], a[1], a[2]] };
  });
}
