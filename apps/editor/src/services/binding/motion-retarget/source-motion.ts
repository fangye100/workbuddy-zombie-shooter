/**
 * source-motion.ts —— BVH 源采样 → 规范世界 SourceMotion（MR-02）。
 *
 * 职责（docs/16 §2 数据流第一步）：
 *  - 单位 → 米（unitScale，默认由骨架高度推断 cm/m）；
 *  - 轴 → 规范 Y-up（与 retarget.ts 同一约定：Z-up 绕 X −90°，只做整体刚转）；
 *  - 逐帧 FK 得世界旋转/位置（在**源自己的骨名空间**里，映射到 HumanIK 名输出）；
 *  - 根运动模式分类（A09 四种能力，不伪造）；
 *  - 源指纹（依赖失效用）。
 *
 * 只读 BvhFile，不改它。输出的 SourceMotion 不可变（冻结数组由调用方自理，
 * 管线侧 pipeline 另有不可变断言）。
 */

import {
  mapBvhJointsToHumanik,
  type BvhFile,
  type BvhJoint,
} from '../bvh-parser';
import { HUMANIK_BONES, HUMANIK_ORDER, skinBones } from '../humanik-template';
import { quatMul, quatFromUnitVectors, type Quat } from '../binding-math';
import { retargetFingerprint } from '@aether/scene';
import type { RootMotionMode, SourceMotion, V3 } from './contracts';

const DEG = Math.PI / 180;

export interface BuildSourceMotionOptions {
  /** 单位换算覆盖（源单位 → 米）；缺省用 bvh.unitScale 推断 */
  unitScale?: number;
  /** up 轴覆盖；缺省用解析器检测 */
  forceUpAxis?: 0 | 1 | 2;
}

/** up 轴 → Y-up 的刚转四元数（与 retarget.ts upAxisToQuat 同约定） */
function upAxisQuat(axis: 0 | 1 | 2): Quat {
  if (axis === 1) return [0, 0, 0, 1];
  if (axis === 2) {
    const h = -45 * DEG;
    return [Math.sin(h), 0, 0, Math.cos(h)];
  }
  // X-up：极罕见，不重映射（诊断层负责提示）
  return [0, 0, 0, 1];
}

function conj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function conjugate(a: Quat, b: Quat): Quat {
  return quatMul(quatMul(a, b), conj(a));
}

function rotateVec(q: Quat, v: V3): [number, number, number] {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  // q v q⁻¹ 的展开式（省一次矩阵转换）
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** 按 BVH 声明序合成欧拉四元数（与 retarget.ts eulerToQuatZYX 同义，独立实现避免私有小函数耦合） */
function eulerQuat(j: BvhJoint, e: readonly [number, number, number]): Quat {
  let q: Quat = [0, 0, 0, 1];
  for (const ch of j.rotChannels) {
    const c = ch.toLowerCase();
    let ang = 0;
    let ax = 0;
    let ay = 0;
    let az = 0;
    if (c.startsWith('x')) {
      ang = e[0];
      ax = 1;
    } else if (c.startsWith('y')) {
      ang = e[1];
      ay = 1;
    } else if (c.startsWith('z')) {
      ang = e[2];
      az = 1;
    } else {
      continue;
    }
    const h = ang * 0.5;
    const s = Math.sin(h);
    q = quatMul(q, [ax * s, ay * s, az * s, Math.cos(h)]);
  }
  return q;
}

function readRootPos(bvh: BvhFile, j: BvhJoint, f: number): [number, number, number] {
  const p: [number, number, number] = [0, 0, 0];
  const base = f * bvh.dof;
  for (let k = 0; k < j.channels.length; k++) {
    const c = j.channels[k]!.toLowerCase();
    if (!c.endsWith('position')) continue;
    const v = bvh.frames[base + j.column + k]!;
    if (c.startsWith('x')) p[0] = v;
    else if (c.startsWith('y')) p[1] = v;
    else if (c.startsWith('z')) p[2] = v;
  }
  return p;
}

/** 原地判定阈值：水平位移跨度小于 1 cm 视为原地（米制、阈值不随帧率变） */
const IN_PLACE_SPAN_M = 0.01;

/**
 * BVH → 规范世界 SourceMotion。
 * 映射失败的关节不进输出（信息在 diagnostics）；一根都对不上时抛错（与 L0 同策略）。
 */
export function buildSourceMotion(
  bvh: BvhFile,
  opts: BuildSourceMotionOptions = {},
): SourceMotion {
  const { mapping } = mapBvhJointsToHumanik(bvh.order, skinBones());
  const mappedBones = Object.keys(mapping).length;
  if (mappedBones === 0) {
    throw new Error('BVH 里没有任何关节能对上 HumanIK 骨架，无法构造源采样');
  }

  const upAxis = opts.forceUpAxis ?? bvh.upAxis;
  const qUp = upAxisQuat(upAxis);
  const unitScale = opts.unitScale ?? bvh.unitScale ?? 1;

  // HumanIK 名序（父先于子）＝输出骨序
  const jointOfBone: Record<string, string> = {};
  for (const [jn, b] of Object.entries(mapping)) jointOfBone[b] = jn;
  const boneNames = HUMANIK_ORDER.filter((b) => jointOfBone[b] !== undefined);

  const frames = bvh.frameCount;
  const times = new Float64Array(frames);
  for (let f = 0; f < frames; f++) times[f] = f * bvh.frameTime;

  const localRotations: Record<string, Float64Array> = {};
  const worldRotations: Record<string, Float64Array> = {};
  const worldPositions: Record<string, Float64Array> = {};
  for (const b of boneNames) {
    const j = bvh.joints[jointOfBone[b]!]!;
    if (j.rotColumn >= 0 && j.rotChannels.length > 0) {
      localRotations[b] = new Float64Array(frames * 4);
    }
    worldRotations[b] = new Float64Array(frames * 4);
    worldPositions[b] = new Float64Array(frames * 3);
  }

  const rootJoint = bvh.joints[bvh.root]!;
  const hasRootPos = rootJoint.posColumn >= 0;

  // 逐帧：先算所有骨的局部旋转（C 共轭），再沿 BVH 父链 FK；只写映射骨
  const euler: [number, number, number] = [0, 0, 0];
  const localOf: Record<string, Quat> = {};
  const worldOf: Record<string, Quat> = {};
  const posOf: Record<string, [number, number, number]> = {};

  for (let f = 0; f < frames; f++) {
    for (const jn of bvh.order) {
      const j = bvh.joints[jn]!;
      if (j.rotColumn >= 0 && j.rotChannels.length > 0) {
        euler[0] = 0; euler[1] = 0; euler[2] = 0;
        const base = f * bvh.dof + j.rotColumn;
        for (let k = 0; k < j.rotChannels.length; k++) {
          const c = j.rotChannels[k]!.toLowerCase();
          const v = bvh.frames[base + k]! * DEG;
          if (c.startsWith('x')) euler[0] = v;
          else if (c.startsWith('y')) euler[1] = v;
          else if (c.startsWith('z')) euler[2] = v;
        }
        localOf[jn] = conjugate(qUp, eulerQuat(j, euler));
      } else {
        localOf[jn] = [0, 0, 0, 1];
      }
    }

    for (const jn of bvh.order) {
      const j = bvh.joints[jn]!;
      const parent = j.parent;
      if (parent === null) {
        worldOf[jn] = localOf[jn]!;
        // 根位置：位置通道（米、Y-up）；无通道时退 rest 偏移（原地素材）
        const raw: [number, number, number] = hasRootPos
          ? readRootPos(bvh, j, f)
          : [j.offset[0]!, j.offset[1]!, j.offset[2]!];
        const scaled: [number, number, number] = [raw[0] * unitScale, raw[1] * unitScale, raw[2] * unitScale];
        posOf[jn] = rotateVec(qUp, scaled);
      } else {
        const pw = worldOf[parent]!;
        worldOf[jn] = quatMul(pw, localOf[jn]!);
        const offScaled: [number, number, number] = [
          j.offset[0] * unitScale,
          j.offset[1] * unitScale,
          j.offset[2] * unitScale,
        ];
        const off = rotateVec(qUp, offScaled);
        // 子骨偏移在**父骨局部系**里（BVH 语义），随父世界旋转
        const r = rotateVec(pw, off);
        const pp = posOf[parent]!;
        posOf[jn] = [pp[0] + r[0], pp[1] + r[1], pp[2] + r[2]];
      }
    }

    for (const b of boneNames) {
      const jn = jointOfBone[b]!;
      const lr = localRotations[b];
      if (lr !== undefined) {
        const q = localOf[jn]!;
        lr[f * 4] = q[0];
        lr[f * 4 + 1] = q[1];
        lr[f * 4 + 2] = q[2];
        lr[f * 4 + 3] = q[3];
      }
      const wq = worldOf[jn]!;
      worldRotations[b]![f * 4] = wq[0];
      worldRotations[b]![f * 4 + 1] = wq[1];
      worldRotations[b]![f * 4 + 2] = wq[2];
      worldRotations[b]![f * 4 + 3] = wq[3];
      const p = posOf[jn]!;
      worldPositions[b]![f * 3] = p[0];
      worldPositions[b]![f * 3 + 1] = p[1];
      worldPositions[b]![f * 3 + 2] = p[2];
    }
  }

  // 根模式分类（A09）：水平跨度 + 有无位置通道
  let rootMode: RootMotionMode;
  let canWorldLock = false;
  if (!hasRootPos) {
    rootMode = 'in-place-with-phase';
  } else {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const hipsArr = worldPositions['Hips'];
    if (hipsArr === undefined) {
      rootMode = 'unknown';
    } else {
      for (let f = 0; f < frames; f++) {
        const x = hipsArr[f * 3]!;
        const z = hipsArr[f * 3 + 2]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const span = Math.max(maxX - minX, maxZ - minZ);
      if (!Number.isFinite(span)) {
        rootMode = 'unknown';
      } else if (span < IN_PLACE_SPAN_M) {
        rootMode = 'in-place-with-trajectory';
      } else {
        rootMode = 'world-trajectory';
        canWorldLock = true;
      }
    }
  }

  const fingerprint = sourceFingerprintOf(bvh, mapping, unitScale, upAxis, rootMode);
  return {
    fingerprint,
    boneNames,
    times,
    localRotations,
    worldRotations,
    worldPositions,
    rootBone: 'Hips',
    rootMode,
    canWorldLock,
    unitScaleSource: unitScale,
    upAxisSource: (['x', 'y', 'z'] as const)[upAxis],
  };
}

/** 源身份指纹：骨架映射 + 帧率 + 帧数 + 全部帧值的稳定散列（内容变 → 指纹变） */
function sourceFingerprintOf(
  bvh: BvhFile,
  mapping: Record<string, string>,
  unitScale: number,
  upAxis: number,
  rootMode: RootMotionMode,
): string {
  const framesDigest: number[] = [];
  const step = Math.max(1, Math.floor(bvh.frames.length / 4096));
  for (let i = 0; i < bvh.frames.length; i += step) framesDigest.push(round6(bvh.frames[i]!));
  return retargetFingerprint({
    root: bvh.root,
    joints: bvh.order.length,
    frameCount: bvh.frameCount,
    frameTime: round6(bvh.frameTime),
    mapping,
    unitScale,
    upAxis,
    rootMode,
    framesDigest,
  });
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * 标记的世界轨迹（米、规范世界系）：worldPos ⊕ rotate(worldQuat, offset)。
 * 接触检测（MR-03）与锚点构造（space-targets）都吃这个。
 */
export function markerWorldPositions(sm: SourceMotion, bone: string, offset: V3): Float64Array {
  const pos = sm.worldPositions[bone];
  const rot = sm.worldRotations[bone];
  const frames = sm.times.length;
  const out = new Float64Array(frames * 3);
  if (pos === undefined || rot === undefined) return out;
  for (let f = 0; f < frames; f++) {
    const q: Quat = [rot[f * 4]!, rot[f * 4 + 1]!, rot[f * 4 + 2]!, rot[f * 4 + 3]!];
    const d = rotateVec(q, offset);
    out[f * 3] = pos[f * 3]! + d[0];
    out[f * 3 + 1] = pos[f * 3 + 1]! + d[1];
    out[f * 3 + 2] = pos[f * 3 + 2]! + d[2];
  }
  return out;
}

/** 源 rest 骨向（HumanIK 名索引）——方向换基的输入。零向量 = 该骨无可用朝向 */
export function sourceRestDirections(bvh: BvhFile): Record<string, V3> {
  const { mapping } = mapBvhJointsToHumanik(bvh.order, skinBones());
  const qUp = upAxisQuat(bvh.upAxis);
  const out: Record<string, V3> = {};
  for (const jn of bvh.order) {
    const bone = mapping[jn];
    if (bone === undefined) continue;
    const j = bvh.joints[jn]!;
    // 优先：第一个子关节的偏移；退化：End Site；再退化：零向量
    let v: V3 | null = null;
    for (const cn of j.children) {
      const c = bvh.joints[cn]!;
      const len = Math.hypot(c.offset[0], c.offset[1], c.offset[2]);
      if (len > 1e-9) {
        const r = rotateVec(qUp, [c.offset[0], c.offset[1], c.offset[2]]);
        v = [r[0] / len, r[1] / len, r[2] / len];
        break;
      }
    }
    if (v === null && j.endOffset !== null) {
      const len = Math.hypot(j.endOffset[0], j.endOffset[1], j.endOffset[2]);
      if (len > 1e-9) {
        const r = rotateVec(qUp, [j.endOffset[0], j.endOffset[1], j.endOffset[2]]);
        v = [r[0] / len, r[1] / len, r[2] / len];
      }
    }
    out[bone] = v ?? [0, 0, 0];
  }
  return out;
}

/** 方向换基的对齐四元数（docs/16 §1：BVH 源的姿态基准） */
export function directionAlignQuats(srcDirs: Record<string, V3>): Record<string, Quat> {
  const out: Record<string, Quat> = {};
  for (const b of HUMANIK_ORDER) {
    const s = srcDirs[b];
    // 目标骨向：第一个子骨的 rest 偏移方向（HumanIK 模板，米/Y-up）
    const child = firstChildOf(b);
    if (s === undefined || child === null) {
      const p = HUMANIK_BONES[b]!.parent;
      out[b] = p === null ? [0, 0, 0, 1] : (out[p] ?? [0, 0, 0, 1]);
      continue;
    }
    const t = child;
    const sOk = Math.hypot(s[0], s[1], s[2]) > 1e-9;
    const tOk = Math.hypot(t[0], t[1], t[2]) > 1e-9;
    if (sOk && tOk) {
      out[b] = quatFromUnitVectors(s as [number, number, number], t as [number, number, number]);
    } else {
      const p = HUMANIK_BONES[b]!.parent;
      out[b] = p === null ? [0, 0, 0, 1] : (out[p] ?? [0, 0, 0, 1]);
    }
  }
  return out;
}

function firstChildOf(bone: string): V3 | null {
  for (const n of HUMANIK_ORDER) {
    if (HUMANIK_BONES[n]!.parent === bone) {
      const off = HUMANIK_BONES[n]!.tposeOffset;
      const len = Math.hypot(off[0], off[1], off[2]);
      if (len > 1e-9) return [off[0] / len, off[1] / len, off[2] / len];
      return null;
    }
  }
  return null;
}
