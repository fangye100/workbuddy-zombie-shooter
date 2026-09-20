/**
 * retarget-session.ts —— 载入 / 预览 / 导出的统一重定向会话（MR-06）。
 *
 * docs/16 §6 的 owner 行：本文件在 `binding/` 下而非 `motion-retarget/` 内是**有意的**
 * —— session 编排预览/导出/失效检查，范围超出算法层。算法层（pipeline/bake-adapter）
 * 不感知编辑器；`main.ts` 只调用本文件，不再自持动画缓存。
 *
 * 两条编辑器入口在这里汇成同一会话（docs/16 §6 / 对话定稿的 UX 骨架）：
 *  - 入口 A（绑定面板「载入动作」）：目标 = 面板当前拟合的 T-pose（fitPositions）；
 *  - 入口 B（层级「应用动画」）：目标 = 场景物体自己的骨架（SkeletonData）。
 *  两入口的目标差异只收敛在 setTarget 一次调用里，求解 / 烘焙 / 导出走同一条路。
 *
 * 会话契约（对话验收口径）：
 *  - 源 / 目标 / 双方标定 / 配方 / 结果统一由 session 管理，任何输入变化 → `stale`
 *    （结果待更新），预览 / 应用 / 导出一律经 `requireResult()` 守门，指向**同一版本**；
 *  - 求解失败 / 取消**不覆盖**上一份可用结果（lastGood 保留，lastFailure 单独记录）；
 *  - 标定 / 配方经注入的 sidecar 存取（`RetargetSidecarStore`），读写 `.meta.json`
 *    的 `retarget` 块；存前校验、读后走 scene 包的校验/迁移，不静默修数据；
 *  - 诊断汇总（状态 + 逐约束残差 + 接触段）由 `summary()` 输出，呈现层（工作台）只渲染。
 *
 * 本文件不做 UI、不含求解规则；数值约定继承 contracts.ts（米 / 秒 / xyzw / 规范世界系）。
 */

import {
  HUMANIK_BONES,
  HUMANIK_ORDER,
  skinBones,
} from './humanik-template';
import type { JointPositions } from './binding-math';
import { parseBvh, mapBvhJointsToHumanik, type BvhFile } from './bvh-parser';
import {
  buildSourceMotion,
  sourceRestDirections,
  type BuildSourceMotionOptions,
} from './motion-retarget/source-motion';
import {
  buildTargetRig,
  computeDirectionBaseline,
} from './motion-retarget/rig-calibration';
import { retargetMotion } from './motion-retarget/pipeline';
import {
  bakeWorldSolveToLocal,
  type BakeBone,
  type BakeOutputRig,
  type LocalTrack,
} from './motion-retarget/bake-adapter';
import type {
  ConstraintResidual,
  ContactSegment,
  Quat,
  RetargetDiagnostic,
  RetargetEnvironment,
  RetargetMetrics,
  RetargetOutcome,
  RetargetRig,
  RootMotionMode,
  SourceMotion,
  V3,
} from './motion-retarget/contracts';
import {
  RETARGET_ALGORITHM_VERSION,
  RETARGET_META_SCHEMA_VERSION,
  calibrationFingerprint,
  createDefaultRecipe,
  migrateRetargetRecipe,
  validateRetargetCalibration,
  validateRetargetRecipe,
  type RetargetCalibration,
  type RetargetRecipe,
} from '@aether/scene';
import type { NodeLocal, SkeletonData } from '@aether/scene';

// ---------------------------------------------------------------- 基础类型

export interface RetargetSidecarStore {
  /** 读一份 `.meta.json`；ok=false 时 json 为 null、error 给出原因 */
  read(metaPath: string): Promise<{ ok: boolean; json: Record<string, unknown> | null; error?: string }>;
  /** 顶层键浅合并写回（与 devfs patch 同语义：只替换列出的顶层键） */
  patch(metaPath: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}

export interface LoadResult {
  ok: boolean;
  diagnostics: RetargetDiagnostic[];
}

/** 两入口共用的动画产物（骨名为键，与具体骨架解耦；喂 binding-export / clipToAnimClip） */
export interface RetargetAnimPayload {
  name: string;
  /** 秒，升序 */
  times: Float32Array;
  /** 骨名 → (frames × 4) xyzw */
  rotations: Record<string, Float32Array>;
  /** Hips 根位移 (frames × 3)；根骨无平移自由度时为 null */
  translation: Float32Array | null;
}

export type RetargetSessionStatus =
  | 'idle'    // 还没有源
  | 'ready'   // 源 + 目标就绪，尚未求解
  | 'pass'    // complete：已请求的能力完成且质量达标
  | 'partial' // 部分完成：可看结果，但有能力缺口或质量超限
  | 'failed'  // 生成失败：本次没有有效结果
  | 'stale';  // 结果待更新：输入已变，预览/应用/导出被守门拦下

export interface RetargetSessionSummary {
  status: RetargetSessionStatus;
  hasSource: boolean;
  hasTarget: boolean;
  clipName: string | null;
  targetName: string | null;
  sourceCalibrated: boolean;
  targetCalibrated: boolean;
  rootMode: RootMotionMode | null;
  /** 源是否有可信世界轨迹（世界锁脚前提） */
  canWorldLock: boolean;
  /** 用户对源动作位移的声明（auto = 按位移检测）；呈现层据此回显下拉 */
  rootMotionSetting: 'auto' | 'world-trajectory' | 'in-place-with-trajectory' | null;
  /** 当前配方的空间模式（未建配方时为 null）；呈现层据此回显，勿自持 DOM 状态 */
  spaceMode: 'normalize-gait' | 'preserve-world' | null;
  /** 目标支撑平面高度（世界 Y，米）；预览地线画这里 */
  targetPlaneY: number | null;
  frames: number | null;
  durationS: number | null;
  fps: number | null;
  coverage: readonly string[];
  metrics: RetargetMetrics | null;
  segments: readonly ContactSegment[];
  constraintResiduals: readonly ConstraintResidual[];
  /** 当前配方的验收容差（绝对米 = 比例 × h_t）；呈现层据此判定残差是否超限 */
  tolerances: { anchorM: number; slideM: number; penetrationM: number } | null;
  diagnostics: readonly RetargetDiagnostic[];
  /** 最近一次失败尝试的错误码（成功后清除；不影响保留的上一份结果） */
  lastFailureCode: string | null;
}

export interface RetargetSourceInfo {
  clipName: string;
  frames: number;
  fps: number;
  rootMode: RootMotionMode;
  canWorldLock: boolean;
  hasRootChannel: boolean;
}

/** 目标输入：skeleton / fitPositions / 模板三选一（都给时 skeleton 优先） */
export interface RetargetTargetInput {
  skeleton?: SkeletonData | null;
  /** 绑定面板拟合的 T-pose 世界坐标（入口 A）；会被合成为等价骨架 */
  fitPositions?: JointPositions | null;
  name: string;
  /**
   * 资产身份键（单位上下文的归属）：同一资产的体型编辑应传同一键（入口 B 传
   * 物体引用、入口 A 传绑定会话/模型）；缺省回退 name。**同键编辑保留单位，
   * 换键重新解析**——单位制是资产属性，跨资产沿用会把 1.97m 的骨架缩成 0.224m
   * 且落在人形区间内、合理性校验抓不住（复审 P1）。
   */
  assetKey?: unknown;
}

// ---------------------------------------------------------------- 数学小件（会话适配层的轻量几何，不进算法层）

function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotateVec(q: Quat, v: V3): [number, number, number] {
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

function err(code: string, message: string, extra?: Partial<RetargetDiagnostic>): RetargetDiagnostic {
  return { severity: 'error', code: `MRS_${code}`, message, ...extra };
}

function warn(code: string, message: string, extra?: Partial<RetargetDiagnostic>): RetargetDiagnostic {
  return { severity: 'warning', code: `MRS_${code}`, message, ...extra };
}

/** 骨盆高相对带宽：标定 h 与骨架实测 h 差 35% 以上 = 不同体型 */
const CAL_PELVIS_BAND = 0.35;

/** 腿链末端骨（与 rig-calibration chainSpecs 的 LeftLeg/RightLeg 3 骨链末端、
 *  pipeline footMarkers 的「3 骨链末端」同一类定义）：其上的标记是足类 */
const FOOT_CHAIN_END_BONES: ReadonlySet<string> = new Set(['LeftFoot', 'RightFoot']);

/** 残留单位声明的人形合理性区间（米）：脱离这个区间的骨架不适用该单位制 */
const TARGET_UNIT_SANITY = { min: 0.1, max: 5 } as const;

/**
 * 源标定 × 当前源的兼容性（UX 复审 P1「不同骨架沿用旧标定」的守门）。
 *
 * 判据刻意只用**骨盆相对的骨架几何**，不看任何世界量；对照值是
 * `cal.pelvisHeightM`——数据契约（retarget-meta）明确它**已经是骨盆到支撑面的
 * 距离**，不得再减支撑面高度（角色与地面同时抬高时比例不变，标定必须保留）。
 *  - 标记骨必须存在；单位/轴向声明与采样一致（身份，不是几何）；
 *  - **最深标记**（= 足底）的「骨盆 → 标记下垂量」必须落在 pelvisHeightM 的
 *    带宽内：够不着（缩短/悬空）或垂得更深（单侧拉长）都是另一具骨架。
 *    只看最深标记，手部等高位标记（下垂更小）不进判据、不会劫持。
 */
function diagnoseSourceCalibration(cal: RetargetCalibration, source: SessionSource): RetargetDiagnostic[] {
  const out: RetargetDiagnostic[] = [];
  const boneSet = new Set(source.motion.boneNames);
  for (const [id, mk] of Object.entries(cal.markers)) {
    if (!boneSet.has(mk.bone)) {
      out.push(err('CAL_BONE_MISSING', `源标定标记 ${id} 引用的骨 ${mk.bone} 不在当前源骨架里`, { constraint: id }));
    }
  }
  if (cal.unitScale !== null &&
      Math.abs(cal.unitScale - source.motion.unitScaleSource) >
        1e-9 * Math.max(cal.unitScale, source.motion.unitScaleSource)) {
    out.push(err('CAL_UNIT_MISMATCH', `源标定 unitScale=${cal.unitScale} 与源采样 ${source.motion.unitScaleSource} 不一致`));
  }
  if (cal.upAxis !== null && cal.upAxis !== source.motion.upAxisSource) {
    out.push(err('CAL_UPAXIS_MISMATCH', `源标定 upAxis=${cal.upAxis} 与源 ${source.motion.upAxisSource} 不一致`));
  }
  // rest 偏移链（源单位）→ 换算到米、经 up 轴换基后的世界 Y
  const chainY = restChainYOf(source.bvh, source.motion.unitScaleSource, source.motion.upAxisSource);
  const { mapping } = mapBvhJointsToHumanik(source.bvh.order, skinBones());
  const jointOfBone = new Map(Object.entries(mapping).map(([jn, b]) => [b, jn] as const));
  const hipsY = chainY.get(source.bvh.root) ?? NaN;
  if (!Number.isFinite(hipsY)) return out;
  const h = cal.pelvisHeightM; // 已是「骨盆到支撑面」的相对量（契约），不再减 planeY
  // 足类标记 = 挂在腿链末端骨（LeftFoot/RightFoot，与 pipeline footMarkers
  // 的「3 骨链末端」同一定义）。足类逐个必须落在 h 带宽内——缩短够不着、
  // 拉长垂更深都暴露，**单侧变化不得被另一侧掩盖**（复审 P1）；
  // 非足类（手/掌等高位标记）只需不垂到支撑面之下（下垂 ≤ h×(1+带宽)）。
  for (const [id, mk] of Object.entries(cal.markers)) {
    const jn = jointOfBone.get(mk.bone);
    const y = jn === undefined ? undefined : chainY.get(jn);
    if (y === undefined) continue;
    // 骨盆 → 标记的几何下垂量（标记偏移在骨局部，BVH rest 全 identity ⇒ 世界）
    const droop = hipsY - (y + mk.offset[1]);
    const isFoot = FOOT_CHAIN_END_BONES.has(mk.bone);
    if (droop > h * (1 + CAL_PELVIS_BAND)) {
      out.push(err('CAL_PELVIS_MISMATCH',
        `源标记 ${id} 的骨盆→标记下垂 ${droop.toFixed(3)}m 超过标定骨盆到支撑面 ${h.toFixed(3)}m 的 ${Math.round(CAL_PELVIS_BAND * 100)}% 带宽（贴支撑面的标记不可能垂得更深；常见于腿被拉长）——标定属于另一具骨架`, { constraint: id }));
    } else if (isFoot && droop < h * (1 - CAL_PELVIS_BAND)) {
      out.push(err('CAL_PELVIS_MISMATCH',
        `源足标记 ${id} 的骨盆→标记下垂 ${droop.toFixed(3)}m 够不到标定支撑面 ${h.toFixed(3)}m 的带宽（常见于腿被缩短）——标定属于另一具骨架`, { constraint: id }));
    }
  }
  return out;
}

/** BVH rest 链各关节的世界 Y（米）：rest 全 identity，偏移和经 up 轴换基后取 y 分量 */
function restChainYOf(bvh: BvhFile, unitScale: number, upAxis: 'x' | 'y' | 'z'): Map<string, number> {
  // 链和（源单位）：joint = Σ 偏移（root 起累计）
  const chain = new Map<string, [number, number, number]>();
  const acc = (name: string): [number, number, number] => {
    const hit = chain.get(name);
    if (hit !== undefined) return hit;
    const j = bvh.joints[name]!;
    const base: readonly [number, number, number] = j.parent === null ? [0, 0, 0] : acc(j.parent);
    const v: [number, number, number] = [base[0]! + j.offset[0], base[1]! + j.offset[1], base[2]! + j.offset[2]];
    chain.set(name, v);
    return v;
  };
  const out = new Map<string, number>();
  for (const name of bvh.order) {
    const [, y, z] = acc(name);
    const my = y! * unitScale;
    const mz = z! * unitScale;
    // qUp = I（y-up）→ y；rotX(-90)（z-up）→ y' = z；x-up 不换基 → y
    out.set(name, upAxis === 'z' ? mz : my);
  }
  return out;
}

/**
 * 目标标定 × 骨架的兼容性。基线 rig 用**标定自己的单位/轴向声明**构建
 *（unitScale/upAxis 是身份声明、不是几何，剥掉 markers/pelvis/plane 让骨架自算），
 * 判据同源侧：标记骨存在 + 骨盆高带宽 + 逐标记下垂量（min ≈ pelvisHeightM、
 * max ≤ pelvisHeightM×(1+带宽)）。`pelvisHeightM` 是骨盆到支撑面的相对量
 *（数据契约），不再减支撑面高度。
 */
function diagnoseTargetCalibration(cal: RetargetCalibration, baselineRig: RetargetRig): RetargetDiagnostic[] {
  const out: RetargetDiagnostic[] = [];
  const orderSet = new Set(baselineRig.order);
  for (const [id, mk] of Object.entries(cal.markers)) {
    if (!orderSet.has(mk.bone)) {
      out.push(err('CAL_BONE_MISSING', `目标标定标记 ${id} 引用的骨 ${mk.bone} 不在骨架里`, { constraint: id }));
    }
  }
  if (cal.pelvisHeightM > 0 && baselineRig.pelvisHeightM > 0 &&
      Math.abs(baselineRig.pelvisHeightM - cal.pelvisHeightM) / cal.pelvisHeightM > CAL_PELVIS_BAND) {
    out.push(err('CAL_PELVIS_MISMATCH', `目标标定骨盆高 ${cal.pelvisHeightM.toFixed(3)}m 与骨架实测 ${baselineRig.pelvisHeightM.toFixed(3)}m 相差超过 ${Math.round(CAL_PELVIS_BAND * 100)}%`));
  }
  // rest 世界 FK（骨盆 → 标记的下垂量；根/容器平移在差值中抵消）
  const posY: Record<string, number> = {};
  const rot: Record<string, Quat> = {};
  for (const n of baselineRig.order) {
    const b = baselineRig.bones[n]!;
    if (b.parent === null) {
      posY[n] = b.restLocalT[1];
      rot[n] = b.restLocalR as Quat;
    } else {
      rot[n] = quatMul(rot[b.parent]!, b.restLocalR as Quat);
      const off = rotateVec(rot[b.parent]!, b.restLocalT);
      posY[n] = posY[b.parent]! + off[1];
    }
  }
  const hipsY = posY['Hips'];
  if (hipsY === undefined) return out;
  const h = cal.pelvisHeightM; // 已是「骨盆到支撑面」的相对量（契约），不再减 planeY
  // 足类标记 = 3 骨腿链末端骨上的标记（取基线 rig 的链定义，与 pipeline
  // footMarkers 同一逻辑）。足类逐个 ∈ h 带宽（缩短/拉长都暴露，单侧不被
  // 另一侧掩盖）；非足类只需不垂到支撑面之下。
  const footBones = new Set(
    baselineRig.chains.filter((c) => c.joints.length === 3).map((c) => c.joints[2]!),
  );
  for (const [id, mk] of Object.entries(cal.markers)) {
    if (!orderSet.has(mk.bone) || posY[mk.bone] === undefined) continue;
    const off = rotateVec(rot[mk.bone]!, [mk.offset[0], mk.offset[1], mk.offset[2]]);
    const droop = hipsY - (posY[mk.bone]! + off[1]);
    const isFoot = footBones.has(mk.bone);
    if (droop > h * (1 + CAL_PELVIS_BAND)) {
      out.push(err('CAL_PELVIS_MISMATCH',
        `目标标记 ${id} 的骨盆→标记下垂 ${droop.toFixed(3)}m 超过标定骨盆到支撑面 ${h.toFixed(3)}m 的带宽（常见于腿被拉长）——标定属于另一具骨架`, { constraint: id }));
    } else if (isFoot && droop < h * (1 - CAL_PELVIS_BAND)) {
      out.push(err('CAL_PELVIS_MISMATCH',
        `目标足标记 ${id} 的骨盆→标记下垂 ${droop.toFixed(3)}m 够不到标定支撑面 ${h.toFixed(3)}m 的带宽（常见于腿被缩短）——标定属于另一具骨架`, { constraint: id }));
    }
  }
  return out;
}

/** 只保留标定的单位/轴向身份声明（markers/pelvis/plane 剥掉，骨架自算）——兼容基线的构建输入 */
function calibrationUnitsOnly(cal: RetargetCalibration): RetargetCalibration {
  const { markers: _m, supportPlane: _sp, ...rest } = cal;
  // pelvisHeightM=0 → buildTargetRig 落回骨架实测；supportPlane 缺省 → 派生平面
  return { ...rest, markers: {}, pelvisHeightM: 0 } as RetargetCalibration;
}

/** 按给定单位/轴向构造单位上下文（单位推断用；骨架几何仍自算） */
function unitContext(unitScale: number, upAxis: 'x' | 'y' | 'z' | null): RetargetCalibration {
  return calibrationUnitsOnly({
    schemaVersion: RETARGET_META_SCHEMA_VERSION,
    side: 'target',
    pelvisHeightM: 0,
    // 占位平面——calibrationUnitsOnly 会剥掉，骨架自算派生平面
    supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'template', confidence: 1 },
    unitScale,
    upAxis,
    markers: {},
    rotationBaseline: 'direction',
  } as RetargetCalibration);
}

function identity16(): Float32Array<ArrayBuffer> {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// ---------------------------------------------------------------- 目标骨架适配

/** 节点局部变换是否为身份（零平移 + 单位旋转 + 单位缩放）——身份的中间节点折叠无害 */
function isIdentityLocal(l: NodeLocal): boolean {
  const r = l.r;
  const s = l.s ?? [1, 1, 1];
  return (
    Math.abs(l.t[0]) + Math.abs(l.t[1]) + Math.abs(l.t[2]) < 1e-9 &&
    Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]) < 1e-9 && Math.abs(r[3] - 1) < 1e-9 &&
    Math.abs(s[0]! - 1) < 1e-9 && Math.abs(s[1]! - 1) < 1e-9 && Math.abs(s[2]! - 1) < 1e-9
  );
}

/**
 * 绑定面板 fit（骨名 → T-pose 世界坐标）→ 等价 SkeletonData。
 * T-pose 世界是纯平移（rest 旋转恒 identity，绑定面板契约），因此局部平移 =
 * 父子世界坐标差，与 binding-export 写出的 GLB 节点布局逐值一致——
 * 入口 A 的求解目标与导出骨架是同一具骨架，不会出现「解是对 A 做的、导出是 B」。
 */
export function skeletonFromFitPositions(fit: JointPositions): SkeletonData {
  const count = HUMANIK_ORDER.length;
  const indexOf = new Map(HUMANIK_ORDER.map((n, i) => [n, i] as const));
  const parent: number[] = [];
  const locals: NodeLocal[] = [];
  let rootIdx = 0;
  HUMANIK_ORDER.forEach((n, i) => {
    const p = HUMANIK_BONES[n]!.parent;
    const pi = p === null ? -1 : (indexOf.get(p) ?? -1);
    parent[i] = pi;
    if (pi < 0) rootIdx = i;
    const self = fit[n];
    const pt = pi < 0 ? undefined : fit[HUMANIK_ORDER[pi]!];
    locals[i] = {
      // 根骨局部平移 = 自身世界坐标（无父）；子骨 = 父子坐标差
      t: self === undefined
        ? [0, 0, 0]
        : pi < 0
          ? [self[0], self[1], self[2]]
          : pt === undefined
            ? [0, 0, 0]
            : [self[0] - pt[0], self[1] - pt[1], self[2] - pt[2]],
      r: [0, 0, 0, 1],
      s: [1, 1, 1],
    };
  });
  return {
    joints: HUMANIK_ORDER.map((_, i) => i),
    jointNames: [...HUMANIK_ORDER],
    inverseBind: new Float32Array(count * 16),
    parent,
    locals,
    roots: [rootIdx],
    normalization: identity16(),
  };
}

/**
 * 场景骨架 → 烘焙输出骨架。
 *
 * 与 rig-calibration 同源的规则：跨过非关节祖先、统一缩放沿链累计、非统一缩放拒绝、
 * 单位/轴向按目标标定归一（t·unitScale、刚体换基）。差异点是 **bake 契约要求
 * restLocalT 为未缩放局部偏移**（世界偏移 = 父世界旋转 · restLocalT × 累计缩放），
 * 因此按世界 FK 反解后除以累计缩放。根骨的容器（Armature 等）世界变换进 rootParentWorld。
 *
 * @param fingerprint 直接采用求解侧 RetargetRig.fingerprint：同一具骨架的**身份令牌**
 *                   （bake 的守门只做身份比对），不在本层重算内容哈希——避免两套
 *                   指纹构造漂移造成假失配。
 */
export function bakeOutputRigFromSkeleton(
  sk: SkeletonData,
  cal: RetargetCalibration | null,
  fingerprint: string,
): { output: BakeOutputRig; diagnostics: RetargetDiagnostic[] } {
  const diagnostics: RetargetDiagnostic[] = [];
  const unitScale = cal?.unitScale ?? 1;
  const upAxis = cal?.upAxis ?? 'y';
  if (!(unitScale > 0)) {
    diagnostics.push(err('UNIT_SCALE_BAD', `unitScale ${unitScale} 必须 > 0`));
  }
  const qAxis = axisToYQuat(upAxis);

  const nodeOfJoint = new Map<number, string>();
  for (let k = 0; k < sk.joints.length; k++) {
    const nm = sk.jointNames[k];
    if (nm !== null && nm !== undefined) nodeOfJoint.set(sk.joints[k]!, nm);
  }

  // 全节点图 FK（规范化后的世界位置 / 旋转 / 累计缩放）
  const worldPos = new Map<number, [number, number, number]>();
  const worldRot = new Map<number, Quat>();
  const worldScale = new Map<number, number>(); // 该节点自身及全部祖先的统一缩放累计
  const depth = new Map<number, number>();
  const visiting = new Set<number>();
  const resolve = (node: number): void => {
    if (worldRot.has(node)) return;
    if (visiting.has(node)) {
      diagnostics.push(err('NODE_CYCLE', `glTF 节点 ${node} 的父链成环，拒绝构造输出骨架`));
      worldRot.set(node, [0, 0, 0, 1]);
      worldPos.set(node, [0, 0, 0]);
      worldScale.set(node, 1);
      depth.set(node, 0);
      return;
    }
    visiting.add(node);
    const loc = sk.locals[node];
    if (loc === undefined) {
      diagnostics.push(err('NODE_LOCAL_MISSING', `glTF 节点 ${node} 缺局部变换`));
      worldRot.set(node, [0, 0, 0, 1]);
      worldPos.set(node, [0, 0, 0]);
      worldScale.set(node, 1);
      depth.set(node, 0);
      visiting.delete(node);
      return;
    }
    const s = loc.s ?? [1, 1, 1];
    const uniform = Math.abs(s[0]! - s[1]!) < 1e-9 && Math.abs(s[1]! - s[2]!) < 1e-9;
    if (!uniform) {
      diagnostics.push(err(
        'NONUNIFORM_SCALE',
        `glTF 节点 ${node} 的局部缩放 [${s.join(', ')}] 非统一，局部轨道无法表达，拒绝`,
      ));
    } else if ((s[0] ?? 1) < 0) {
      // 反射：统一负缩放同样无法经刚性骨架的局部轨道表达——在会话层早拒，
      // 不让求解白跑后由 bake 的可表达性门禁兜底
      diagnostics.push(err(
        'NEGATIVE_SCALE',
        `glTF 节点 ${node} 的统一缩放为负（反射），局部轨道无法表达，拒绝`,
      ));
    }
    // 与 rig-calibration 相同的规范化：t·unitScale、r 刚体换基
    const tScaled: [number, number, number] = [loc.t[0] * unitScale, loc.t[1] * unitScale, loc.t[2] * unitScale];
    const t = rotateVec(qAxis, tScaled);
    const r = quatMul(qAxis, quatMul([loc.r[0], loc.r[1], loc.r[2], loc.r[3]], quatConj(qAxis)));
    const p = sk.parent[node];
    if (p === undefined || p < 0) {
      worldRot.set(node, r);
      worldPos.set(node, t);
      worldScale.set(node, s[0] ?? 1);
      depth.set(node, 0);
    } else {
      resolve(p);
      const pq = worldRot.get(p)!;
      const ps = worldScale.get(p) ?? 1;
      worldRot.set(node, quatMul(pq, r));
      const off = rotateVec(pq, [t[0] * ps, t[1] * ps, t[2] * ps]);
      const pp = worldPos.get(p)!;
      worldPos.set(node, [pp[0] + off[0], pp[1] + off[1], pp[2] + off[2]]);
      worldScale.set(node, ps * (s[0] ?? 1));
      depth.set(node, (depth.get(p) ?? 0) + 1);
    }
    visiting.delete(node);
  };
  for (const node of nodeOfJoint.keys()) resolve(node);

  const sorted = [...nodeOfJoint.entries()].sort(
    (a, b) => (depth.get(a[0]) ?? 0) - (depth.get(b[0]) ?? 0),
  );

  const order: string[] = [];
  const bones: Record<string, BakeBone> = {};
  let rootParentWorld: BakeOutputRig['rootParentWorld'] = null;
  for (const [node, nm] of sorted) {
    order.push(nm);
    const wp = worldPos.get(node)!;
    const wr = worldRot.get(node)!;
    const selfScale = worldScale.get(node) ?? 1;
    // 最近的**关节**祖先（跨过非关节中间节点；与 rig-calibration 同规则）
    let anc = sk.parent[node];
    let parentNode: number | null = null;
    while (anc !== undefined && anc >= 0) {
      if (nodeOfJoint.has(anc)) {
        parentNode = anc;
        break;
      }
      anc = sk.parent[anc];
    }
    if (parentNode === null) {
      // 根关节：父 = 容器链（非关节祖先）的规范化世界变换，或场景原点
      const p = sk.parent[node];
      if (rootParentWorld === null && p !== undefined && p >= 0) {
        resolve(p);
        rootParentWorld = {
          pos: worldPos.get(p) ?? [0, 0, 0],
          quat: worldRot.get(p) ?? [0, 0, 0, 1],
          uniformScale: worldScale.get(p) ?? 1,
        };
      }
      const pq = rootParentWorld?.quat ?? [0, 0, 0, 1] as Quat;
      const pp = rootParentWorld?.pos ?? [0, 0, 0] as V3;
      const cum = rootParentWorld?.uniformScale ?? 1;
      const d = rotateVec(quatConj(pq), [wp[0] - pp[0], wp[1] - pp[1], wp[2] - pp[2]]);
      bones[nm] = {
        name: nm,
        parent: null,
        restLocalT: [d[0] / cum, d[1] / cum, d[2] / cum],
        restLocalR: quatMul(quatConj(pq), wr),
        nodeIndex: node,
        restUniformScale: rootParentWorld !== null ? selfScale / cum : selfScale,
      };
    } else {
      // 中间非关节节点守门（PR#5 评审）：本层把节点 → 最近关节祖先之间跨过的
      // 非关节中间节点折叠进 rest（restLocal 相对**关节父**表达），但播放期 FK
      // 走节点层级（skin.ts evalJointMatrices 按 sk.parent 逐节点累乘）会把该
      // 中间节点再乘一次 → 求解姿态与播放姿态必不一致，且适配器按骨层级读回
      // 自检抓不住。身份变换折叠 = 无操作，不拦；非身份 → 显式拒绝（与
      // NONUNIFORM_SCALE 同为不可表达层级）。根骨容器链走 rootParentWorld，
      // restLocal 保持容器相对，与节点 FK 自洽，不受此检查影响。
      const intermediates: string[] = [];
      for (let m = sk.parent[node]; m !== undefined && m >= 0 && m !== parentNode; m = sk.parent[m]) {
        const lm = sk.locals[m];
        if (lm !== undefined && !isIdentityLocal(lm)) intermediates.push(`节点#${m}`);
      }
      if (intermediates.length > 0) {
        diagnostics.push(err(
          'NONJOINT_INTERMEDIATE',
          `关节 ${nm} 与关节父 ${nodeOfJoint.get(parentNode)} 之间存在非关节中间节点（${intermediates.join('、')}）且变换非身份：烘焙 rest 会折叠它而播放端按节点层级再应用一次，播放姿态必错——请先清理骨架层级`,
        ));
      }
      const pq = worldRot.get(parentNode)!;
      const pp = worldPos.get(parentNode)!;
      const cum = worldScale.get(parentNode) ?? 1; // 作用于本骨偏移的累计缩放
      const d = rotateVec(quatConj(pq), [wp[0] - pp[0], wp[1] - pp[1], wp[2] - pp[2]]);
      bones[nm] = {
        name: nm,
        parent: nodeOfJoint.get(parentNode)!,
        restLocalT: [d[0] / cum, d[1] / cum, d[2] / cum],
        restLocalR: quatMul(quatConj(pq), wr),
        nodeIndex: node,
        // cum ≠ 0（含负）：自身比例 = selfScale / cum，符号语义与 bake 累计缩放一致
        restUniformScale: cum !== 0 ? selfScale / cum : 1,
      };
    }
  }

  return {
    output: { order, bones, fingerprint, rootParentWorld },
    diagnostics,
  };
}

/** 模板目标（测试 / 无骨架兜底）的烘焙输出骨架：节点 0..N-1 按 HUMANIK_ORDER */
export function bakeOutputRigFromTemplate(fingerprint: string): BakeOutputRig {
  const order = [...HUMANIK_ORDER];
  const bones: Record<string, BakeBone> = {};
  HUMANIK_ORDER.forEach((n, i) => {
    bones[n] = {
      name: n,
      parent: HUMANIK_BONES[n]!.parent,
      restLocalT: [
        HUMANIK_BONES[n]!.tposeOffset[0],
        HUMANIK_BONES[n]!.tposeOffset[1],
        HUMANIK_BONES[n]!.tposeOffset[2],
      ],
      restLocalR: [0, 0, 0, 1],
      nodeIndex: i,
    };
  });
  return { order, bones, fingerprint, rootParentWorld: null };
}

function axisToYQuat(axis: 'x' | 'y' | 'z'): Quat {
  if (axis === 'y') return [0, 0, 0, 1];
  if (axis === 'z') {
    const h = (-90 * Math.PI / 180) / 2;
    return [Math.sin(h), 0, 0, Math.cos(h)];
  }
  return [0, 0, 0, 1];
}

// ---------------------------------------------------------------- 会话

interface SessionSource {
  bvh: BvhFile;
  motion: SourceMotion;
  clipName: string;
}

/** 目标的来源快照：标定变化时按原骨架重建 rig，绝不做 rig→骨架往返（会二次归一） */
interface SessionTarget {
  rig: RetargetRig;
  name: string;
  output: BakeOutputRig;
  origin: RetargetTargetInput;
}

/** 资产身份键：显式 assetKey 优先，缺省回退 name（两入口的 name 都按资产稳定） */
function assetKeyOf(input: RetargetTargetInput): unknown {
  return input.assetKey !== undefined ? input.assetKey : input.name;
}

export class RetargetSession {
  private readonly store: RetargetSidecarStore;
  private source: SessionSource | null = null;
  private sourceOpts: BuildSourceMotionOptions = {};
  private target: SessionTarget | null = null;
  private sourceCal: RetargetCalibration | null = null;
  private targetCal: RetargetCalibration | null = null;
  /**
   * 目标骨架的单位/轴向上下文（从标定剥离的 identity 部分）+ 它的**资产身份键**。
   * 单位制是**资产文件的属性**（cm/m 授权），不是体型属性——同资产（同键）的
   * 体型编辑保留；换资产（换键）不沿用（跨资产污染会把 1.97m 缩成 0.224m 且
   * 落在人形区间内，合理性校验抓不住）。人形区间只兜底同资产内的病态声明。
   */
  private targetUnitCtx: RetargetCalibration | null = null;
  private targetUnitOwner: unknown = null;
  /** 完整目标标定的资产归属键：标定载入成功时记录。换资产（换键）时标定
   *  与单位上下文一样不得沿用——等比缩放的跨资产骨架可让几何检查恰好通过
   * （复审 37bd3ad P1：先载已标定 A 再切 B，B 被按 A 的 0.5 单位建出 0.5m） */
  private targetCalOwner: unknown = null;
  private recipe: RetargetRecipe | null = null;
  private lastGood: RetargetOutcome | null = null;
  private lastFailure: RetargetOutcome | null = null;
  private sessionDiagnostics: RetargetDiagnostic[] = [];
  /** 标定兼容性 / 停用的粘性诊断——**按侧分通道**：一侧通过不得抹掉另一侧仍有效的停用警告 */
  private srcCalDiagnostics: RetargetDiagnostic[] = [];
  private tgtCalDiagnostics: RetargetDiagnostic[] = [];
  /** 源侧停用警告所属的源指纹：源再换（指纹不同）即过期清除 */
  private srcCalDetachAtFp: string | null = null;
  private revision = 0;
  private solvedRevision: number | null = null;

  constructor(store: RetargetSidecarStore) {
    this.store = store;
  }

  // ── 输入 ──────────────────────────────────────────────────────────

  /**
  * 源状态快照（PR 复审 P2：main 两入口的「源+目标成对载入」失败时整体回退，
  * 保证旧结果仍新鲜可消费——只回滚目标会让 catch 宣称的“保留上一份结果”落空）。
  * 含 revision/solvedRevision：单线程会话内成对恢复是安全的。
  */
 public snapshotSourceState(): {
   source: SessionSource | null;
   sourceOpts: BuildSourceMotionOptions;
   sourceCal: RetargetCalibration | null;
   srcDiags: RetargetDiagnostic[];
   srcDetachAtFp: string | null;
   revision: number;
   solvedRevision: number | null;
 } {
   return {
     source: this.source,
     sourceOpts: { ...this.sourceOpts },
     sourceCal: this.sourceCal,
     srcDiags: this.srcCalDiagnostics,
     srcDetachAtFp: this.srcCalDetachAtFp,
     revision: this.revision,
     solvedRevision: this.solvedRevision,
   };
 }

 /** 回滚到快照（成对载入失败路径；不触碰目标侧——目标有自己的事务） */
 public rollbackSourceTo(snap: ReturnType<RetargetSession['snapshotSourceState']>): void {
   this.source = snap.source;
   this.sourceOpts = { ...snap.sourceOpts };
   this.sourceCal = snap.sourceCal;
   this.srcCalDiagnostics = snap.srcDiags;
   this.srcCalDetachAtFp = snap.srcDetachAtFp;
   this.revision = snap.revision;
   this.solvedRevision = snap.solvedRevision;
 }

  /** 载入 BVH 源（两入口共用）。解析 / 采样失败不抛，全部走诊断。 */
  loadSourceBvh(text: string, clipName: string, opts: BuildSourceMotionOptions = {}): LoadResult {
    const diagnostics: RetargetDiagnostic[] = [];
    let bvh: BvhFile;
    try {
      bvh = parseBvh(text);
    } catch (e) {
      diagnostics.push(err('BVH_PARSE_FAILED', `BVH 解析失败：${String(e)}`));
      return { ok: false, diagnostics };
    }
    let motion: SourceMotion;
    try {
      motion = buildSourceMotion(bvh, opts);
    } catch (e) {
      diagnostics.push(err('SOURCE_BUILD_FAILED', `源采样失败：${String(e)}`));
      return { ok: false, diagnostics };
    }
    this.source = { bvh, motion, clipName };
    this.sourceOpts = { ...opts };
    this.bump();
    // 标定归属（UX 复审 P1）：换了源（不同骨架/比例）时旧标定必须重新验明——
    // 骨名不存在或隐含足底远离支撑面 = 标定属于另一具骨架 → 自动停用并警告，
    // 不带着错误标高/标记继续"已标定"地求解
    if (this.sourceCal !== null) {
      const mismatch = diagnoseSourceCalibration(this.sourceCal, this.source);
      if (mismatch.length > 0) {
        this.sourceCal = null;
        this.srcCalDetachAtFp = motion.fingerprint;
        this.srcCalDiagnostics = [
          warn('SOURCE_CAL_DETACHED', `源标定与当前源不匹配，已停用（${mismatch.map((d) => d.code).join('、')}）：请载入这具骨架的 sidecar 或重新标定`),
        ];
        this.bump();
      } else {
        this.srcCalDiagnostics = [];
      }
    } else if (
      this.srcCalDiagnostics.length > 0 &&
      this.srcCalDetachAtFp !== null &&
      this.srcCalDetachAtFp !== motion.fingerprint
    ) {
      // 停用警告描述的是上一次换源：源再换即过期（徽章「需标定」已持续提示状态本身）
      this.srcCalDiagnostics = [];
      this.srcCalDetachAtFp = null;
    }
    return { ok: true, diagnostics };
  }

  /**
   * 纠正源的动作位移声明（ importer 语义，不是从数据猜）：auto = 按位移检测；
   * world-trajectory / in-place-with-trajectory = 显式覆盖根模式（A09 能力声明）。
   * 用缓存的 BvhFile 重采样——**不**接受「声明了轨迹却无位置通道」的非法组合
   *（buildSourceMotion 会抛，转为诊断，源保持原状）。
   */
  setSourceRootMotion(
    mode: 'auto' | 'world-trajectory' | 'in-place-with-trajectory',
  ): LoadResult {
    if (mode !== 'auto' && mode !== 'world-trajectory' && mode !== 'in-place-with-trajectory') {
      // DOM 注入的非法值不得进采样（会污染 rootMode 与源指纹）
      return { ok: false, diagnostics: [err('ROOT_MOTION_INVALID', `动作位移声明非法：${String(mode)}`)] };
    }
    if (this.source === null) {
      return { ok: false, diagnostics: [err('NO_SOURCE', '尚未载入源动作')] };
    }
    const opts = { ...this.sourceOpts, rootMotion: mode };
    try {
      const motion = buildSourceMotion(this.source.bvh, opts);
      this.source = { bvh: this.source.bvh, motion, clipName: this.source.clipName };
      this.sourceOpts = opts;
      this.bump();
      return { ok: true, diagnostics: [] };
    } catch (e) {
      return {
        ok: false,
        diagnostics: [err('ROOT_MOTION_INVALID', `动作位移声明不可用：${String(e)}`)],
      };
    }
  }

  /**
   * 设定目标（两入口的差别只在这里收敛）。有目标标定时随 rig 一起生效；
   * 旧结果立即失效。骨架构建失败（非统一缩放 / 环 / 缺 Hips）不改当前目标。
   */
  /** 目标标定相关状态快照（setTarget/syncTarget 事务化用） */
  private snapshotTargetCalState(): {
    targetCal: RetargetCalibration | null;
    calOwner: unknown;
    unitCtx: RetargetCalibration | null;
    unitOwner: unknown;
    tgtDiags: RetargetDiagnostic[];
  } {
    return {
      targetCal: this.targetCal,
      calOwner: this.targetCalOwner,
      unitCtx: this.targetUnitCtx,
      unitOwner: this.targetUnitOwner,
      tgtDiags: this.tgtCalDiagnostics,
    };
  }

  private restoreTargetCalState(snap: ReturnType<RetargetSession['snapshotTargetCalState']>): void {
    this.targetCal = snap.targetCal;
    this.targetCalOwner = snap.calOwner;
    this.targetUnitCtx = snap.unitCtx;
    this.targetUnitOwner = snap.unitOwner;
    this.tgtCalDiagnostics = snap.tgtDiags;
  }

  setTarget(input: RetargetTargetInput): LoadResult {
    // 事务性（复审 099a5d1 P1）：归属/几何停用与单位解析都发生在构建之前，
    // 构建失败（如非统一缩放骨架）必须完整保留旧目标及其标定
    const snap = this.snapshotTargetCalState();
    const built = this.buildTargetChecked(input);
    if (!built.ok) {
      this.restoreTargetCalState(snap);
      return { ok: false, diagnostics: built.diagnostics };
    }
    this.target = {
      rig: built.rig,
      name: input.name,
      output: built.output,
      origin: { skeleton: input.skeleton ?? null, fitPositions: input.fitPositions ?? null, name: input.name, assetKey: input.assetKey },
    };
    this.bump();
    return { ok: true, diagnostics: built.diagnostics };
  }

  /**
   * setTarget / syncTarget / setTargetCalibration 共用的「标定兼容检查 + 构建」入口。
   * 三判 P1：体型编辑路径（syncTarget）此前绕过检查——现在**只有这一个入口**构建目标，
   * 检查不可能被绕过。检查用的是「标定自己的单位声明 + 骨架自算几何」的基线。
   */
  private buildTargetChecked(input: RetargetTargetInput):
    | { ok: true; rig: RetargetRig; output: BakeOutputRig; diagnostics: RetargetDiagnostic[]; calDetached: boolean }
    | { ok: false; diagnostics: RetargetDiagnostic[] } {
    let calDetached = false;
    const key = assetKeyOf(input);
    if (this.targetCal !== null && this.targetCalOwner !== key) {
      // 资产归属（先于几何检查）：完整标定属于另一资产 → 停用。几何检查挡不住
      // 等比缩放的跨资产骨架（B 的原始数字 ×A 的单位恰好落进 A 标定的带宽）
      this.tgtCalDiagnostics = [
        warn('TARGET_CAL_DETACHED', '目标标定属于另一资产（资产键不同），已停用：请为当前资产载入对应 sidecar 或重新标定'),
      ];
      this.targetCal = null;
      this.targetCalOwner = null;
      calDetached = true;
    }
    if (this.targetCal !== null) {
      const baseline = this.buildTargetParts(input, calibrationUnitsOnly(this.targetCal));
      if (baseline.ok) {
        const mismatch = diagnoseTargetCalibration(this.targetCal, baseline.rig);
        if (mismatch.length > 0) {
          this.tgtCalDiagnostics = [
            warn('TARGET_CAL_DETACHED', `目标标定与新骨架不匹配，已停用（${mismatch.map((d) => d.code).join('、')}）：请载入这具骨架的 sidecar 或重新标定`),
          ];
          this.targetCal = null;
          calDetached = true;
          // 单位制是资产属性不是体型属性：停用几何标定时保留单位换算（cm 骨架
          // 不得因此变 145m）；targetUnitCtx 已在标定载入成功时捕获
        } else {
          this.tgtCalDiagnostics = [];
        }
      }
    }
    // 单位上下文按**资产身份键**门控：同资产（同键）沿用；换资产不沿用
    //（跨资产污染：.1 声明套到米制骨架 → 1.97m 变 0.224m，且两者都在人形
    // 区间内，合理性校验抓不住——复审 P1）
    const staleCtx = this.targetCal === null && this.targetUnitOwner === key ? this.targetUnitCtx : null;
    let built = this.buildTargetParts(input, this.targetCal ?? staleCtx);
    if (this.targetCal === null && built.ok) {
      const inBand = (v: number): boolean => v >= TARGET_UNIT_SANITY.min && v <= TARGET_UNIT_SANITY.max;
      if (!inBand(built.rig.pelvisHeightM)) {
        // 当前单位解释（本资产的残留声明或默认米制）超人形区间：按候选解析——
        // ① 残留声明不可信 → 丢弃按默认重建；② 默认米制把 cm 骨架当米（资产内
        // 的已知坑）→ 按 cm（×0.01）推断；两者都不行 → 保留并警告
        const prevUpAxis = staleCtx?.upAxis ?? null;
        if (staleCtx !== null) {
          this.tgtCalDiagnostics = [
            ...this.tgtCalDiagnostics,
            warn('TARGET_UNITS_DROPPED',
              `残留的单位声明（unitScale=${staleCtx.unitScale ?? 1}）使骨架骨盆高为 ${built.rig.pelvisHeightM.toFixed(3)}m，超出人形合理区间 [${TARGET_UNIT_SANITY.min}, ${TARGET_UNIT_SANITY.max}]m，已丢弃`),
          ];
          this.targetUnitCtx = null;
          this.targetUnitOwner = null;
          const retry = this.buildTargetParts(input, null);
          if (retry.ok && inBand(retry.rig.pelvisHeightM)) {
            built = retry;
          }
        }
        if (built.ok && !inBand(built.rig.pelvisHeightM)) {
          // 默认（或丢弃后重建）仍超界：最后尝试 cm 解释（米制骨架按 0.01 会过小，不会误采）
          const cmCtx = unitContext(0.01, prevUpAxis);
          const cmTry = this.buildTargetParts(input, cmCtx);
          if (cmTry.ok && inBand(cmTry.rig.pelvisHeightM)) {
            this.targetUnitCtx = cmCtx; // 推断结果入上下文（绑定当前资产键），后续同资产构建沿用
            this.targetUnitOwner = key;
            this.tgtCalDiagnostics = [
              ...this.tgtCalDiagnostics,
              warn('TARGET_UNITS_INFERRED',
                `骨架按米制解释骨盆高 ${built.rig.pelvisHeightM.toFixed(3)}m 超出人形区间，已按厘米制（×0.01）解释为 ${cmTry.rig.pelvisHeightM.toFixed(3)}m；请以 sidecar 标定确认单位`),
            ];
            built = cmTry;
          } else if (!this.tgtCalDiagnostics.some((d) => d.code === 'MRS_TARGET_UNITS_SUSPECT')) {
            // 追加式会随反复 sync 无界累积（复审 P3）——同一可疑状态只留一条
            this.tgtCalDiagnostics = [
              ...this.tgtCalDiagnostics,
              warn('TARGET_UNITS_SUSPECT',
                `骨架骨盆高 ${built.rig.pelvisHeightM.toFixed(3)}m 超出人形区间且无法按厘米制解释——单位可疑，请载入该资产的标定`),
            ];
          }
        }
      }
    }
    if (!built.ok) return { ok: false, diagnostics: built.diagnostics };
    return { ok: true, rig: built.rig, output: built.output, diagnostics: built.diagnostics, calDetached };
  }

  /**
   * 用**当前**目标输入核对会话目标：几何有变 → 重设目标并失效（'changed'），
   * 无变 → 不动（'unchanged'），构造失败 → 'invalid'（目标保持原状）。
   *
   * 入口 A 的 fit 在绑定面板里随时可被拖改——求解前 sync 保证解的是当前 fit；
   * 导出前 sync 必须为 unchanged，否则拒绝导出（防「解是旧 fit、导出铺新 fit」）。
   * 与 setTarget 走**同一个** buildTargetChecked（含标定兼容检查）：体型编辑路径
   * 不得绕过标定归属验明（三判 P1 之二）。
   */
  syncTarget(input: RetargetTargetInput): { state: 'unchanged' | 'changed' | 'invalid'; diagnostics: RetargetDiagnostic[] } {
    if (this.target === null) {
      const r = this.setTarget(input);
      return { state: r.ok ? 'changed' : 'invalid', diagnostics: r.diagnostics };
    }
    const snap = this.snapshotTargetCalState();
    const built = this.buildTargetChecked(input);
    if (!built.ok) {
      this.restoreTargetCalState(snap);
      return { state: 'invalid', diagnostics: built.diagnostics };
    }
    if (!built.calDetached && built.rig.fingerprint === this.target.rig.fingerprint) {
      return { state: 'unchanged', diagnostics: built.diagnostics };
    }
    this.target = {
      rig: built.rig,
      name: input.name,
      output: built.output,
      origin: { skeleton: input.skeleton ?? null, fitPositions: input.fitPositions ?? null, name: input.name, assetKey: input.assetKey },
    };
    this.bump();
    return { state: 'changed', diagnostics: built.diagnostics };
  }

  /** 源侧标定（null = 清除 → 接触能力回到未标定态）。side 必须为 source；与当前源几何不符则拒绝。 */
  setSourceCalibration(cal: RetargetCalibration | null): LoadResult {
    if (cal === null) {
      this.sourceCal = null;
      this.bump();
      return { ok: true, diagnostics: [] };
    }
    const diags = validateRetargetCalibration(cal).map(metaDiagToRetarget);
    if (diags.some((d) => d.severity === 'error')) return { ok: false, diagnostics: diags };
    // PR 复审 P1：标定的 unitScale/upAxis 是声明，用于纠正被误推断的源——先用缓存
    // BvhFile 按声明事务性重采样，再做几何兼容检查（否则纠错声明永远被当成资产
    // 不匹配拒绝，没有可用路径）。重采样后仍不匹配 → 连同重采样一起回滚拒绝。
    const snap = this.snapshotSourceState();
    if (this.source !== null) {
      const wantUnit = cal.unitScale;
      const wantAxis = cal.upAxis;
      const unitDiffers = wantUnit !== null && Math.abs(wantUnit - this.source.motion.unitScaleSource) >
        1e-9 * Math.max(wantUnit, this.source.motion.unitScaleSource);
      const axisDiffers = wantAxis !== null && wantAxis !== this.source.motion.upAxisSource;
      if (unitDiffers || axisDiffers) {
        try {
          const opts: BuildSourceMotionOptions = { ...this.sourceOpts };
          if (wantUnit !== null) opts.unitScale = wantUnit;
          if (wantAxis !== null) opts.forceUpAxis = ({ x: 0, y: 1, z: 2 } as const)[wantAxis];
          const motion = buildSourceMotion(this.source.bvh, opts);
          this.source = { bvh: this.source.bvh, motion, clipName: this.source.clipName };
          this.sourceOpts = opts;
          this.bump();
        } catch (e) {
          this.rollbackSourceTo(snap);
          return {
            ok: false,
            diagnostics: [...diags, err('SOURCE_RESAMPLE_FAILED', `标定声明的单位/轴向无法用于该源：${String(e)}`)],
          };
        }
      }
    }
    if (cal.side !== 'source') {
      diags.push(err('CAL_SIDE_MISMATCH', `源侧标定的 side 必须是 'source'，收到 '${cal.side}'`));
    }
    if (diags.some((d) => d.severity === 'error')) return { ok: false, diagnostics: diags };
    // 显式载入错骨架的 sidecar：报错拒绝，不静默接受（用户看得到该换哪份）
    if (this.source !== null) {
      const mismatch = diagnoseSourceCalibration(cal, this.source);
      if (mismatch.length > 0) {
        this.rollbackSourceTo(snap); // 声明引发的重采样随拒绝一起回滚（事务性）
        return { ok: false, diagnostics: [...diags, ...mismatch] };
      }
    }
    // 入库时归一支撑面法向（PR 复审）：校验层只警告；未归一值（[0,2,0]）会被
    // pipeline 对原始标定平面的复核再次拒绝——会话侧持有效值，与目标侧同规则
    const nLen = Math.hypot(cal.supportPlane.normal[0], cal.supportPlane.normal[1], cal.supportPlane.normal[2]);
    const calEff: RetargetCalibration = nLen > 1e-9
      ? { ...cal, supportPlane: { ...cal.supportPlane, normal: [cal.supportPlane.normal[0] / nLen, cal.supportPlane.normal[1] / nLen, cal.supportPlane.normal[2] / nLen] } }
      : cal;
    this.sourceCal = calEff;
    this.srcCalDiagnostics = [];
    this.srcCalDetachAtFp = null;
    this.bump();
    return { ok: true, diagnostics: diags };
  }

  /** 目标侧标定；改变即按原目标来源重建 rig（h_t / 标记 / 平面全走新值）。与骨架不符则拒绝。 */
  /**
   * 目标侧标定载入 / 清除——**事务性**：先在临时状态上完成候选构建，全部成功才
   * 统一提交；任一步失败回滚到调用前状态（复审 P2：模板目标 + 不支持的 X-up
   * 标定构建失败时，不得已覆盖原标定与单位上下文，且清除操作不得因此卡死）。
   */
  setTargetCalibration(cal: RetargetCalibration | null): LoadResult {
    // 快照（回滚用）
    const prev = {
      targetCal: this.targetCal,
      calOwner: this.targetCalOwner,
      unitCtx: this.targetUnitCtx,
      unitOwner: this.targetUnitOwner,
      tgtDiags: this.tgtCalDiagnostics,
    };
    const rollback = (): void => {
      this.targetCal = prev.targetCal;
      this.targetCalOwner = prev.calOwner;
      this.targetUnitCtx = prev.unitCtx;
      this.targetUnitOwner = prev.unitOwner;
      this.tgtCalDiagnostics = prev.tgtDiags;
    };
    if (cal === null) {
      this.targetCal = null;
      if (this.target !== null) {
        const r = this.setTarget(this.target.origin);
        if (!r.ok) {
          rollback();
          return { ok: false, diagnostics: r.diagnostics };
        }
        return r;
      }
      this.bump();
      return { ok: true, diagnostics: [] };
    }
    const diags = validateRetargetCalibration(cal).map(metaDiagToRetarget);
    if (cal.side !== 'target') {
      diags.push(err('CAL_SIDE_MISMATCH', `目标侧标定的 side 必须是 'target'，收到 '${cal.side}'`));
    }
    if (diags.some((d) => d.severity === 'error')) return { ok: false, diagnostics: diags };
    // 无目标时拒绝：标定的资产归属无从记录（owner=null → 之后任何 setTarget 都会
    // 以「资产键不同」停用，成为永不可激活的死标定）——先 setTarget 再载标定
    if (this.target === null) {
      diags.push(err('NO_TARGET', '尚未设定目标骨架：先载入/设定目标，再载入目标侧标定'));
      return { ok: false, diagnostics: diags };
    }
    // 显式载入错骨架的 sidecar：按当前目标构建「该标定单位声明 + 骨架自算几何」基线，
    // 不符则拒绝（基线带单位换算——厘米骨架 + unitScale=.01 不再被 97 vs 1 误拒）
    {
      const baseline = this.buildTargetParts(this.target.origin, calibrationUnitsOnly(cal));
      if (baseline.ok) {
        const mismatch = diagnoseTargetCalibration(cal, baseline.rig);
        if (mismatch.length > 0) {
          return { ok: false, diagnostics: [...diags, ...mismatch] };
        }
      }
    }
    // 候选状态提交后统一走重建；重建失败整体回滚
    this.targetCal = cal;
    this.targetCalOwner = this.target !== null ? assetKeyOf(this.target.origin) : null;
    this.targetUnitCtx = calibrationUnitsOnly(cal); // 单位制独立保留：几何停用不清单位
    this.targetUnitOwner = this.targetCalOwner;
    this.tgtCalDiagnostics = [];
    if (this.target !== null) {
      const r = this.setTarget(this.target.origin);
      if (!r.ok) {
        rollback();
        return { ok: false, diagnostics: [...diags, ...r.diagnostics] };
      }
      return { ok: true, diagnostics: [...diags, ...r.diagnostics] };
    }
    this.bump();
    return { ok: true, diagnostics: diags };
  }

  /** 更新配方参数（spaceMode / 标注 / 检测 / 容差 / 权重）；校验失败不改状态。 */
  updateRecipeSettings(
    settings: Partial<Pick<RetargetRecipe, 'spaceMode' | 'annotations' | 'contactDetection' | 'tolerances' | 'weights'>>,
  ): LoadResult {
    const base = this.recipe ?? this.draftRecipe();
    const next: RetargetRecipe = { ...base };
    const sink = next as unknown as Record<string, unknown>;
    for (const key of ['spaceMode', 'annotations', 'contactDetection', 'tolerances', 'weights'] as const) {
      const v = settings[key];
      if (v !== undefined) sink[key] = v;
    }
    const diags = validateRetargetRecipe(next).map(metaDiagToRetarget);
    if (diags.some((d) => d.severity === 'error')) return { ok: false, diagnostics: diags };
    this.recipe = next;
    this.bump();
    return { ok: true, diagnostics: diags };
  }

  // ── 求解 ──────────────────────────────────────────────────────────

  /**
   * 求解当前输入。失败 / 取消**不覆盖** lastGood（上一份可用结果继续可消费——
   * 输入没变时 revision 仍等于 solvedRevision，不触发 stale 拦截）。
   */
  solve(signal?: AbortSignal): RetargetOutcome {
    const sessionDiags: RetargetDiagnostic[] = [];
    if (this.source === null || this.target === null) {
      this.sessionDiagnostics = [];
      const outcome = syntheticFailed(
        this.source === null ? 'NO_SOURCE' : 'NO_TARGET',
        this.source === null ? '尚未载入源动作' : '尚未设定目标骨架',
      );
      this.lastFailure = outcome;
      return outcome;
    }
    const recipe = this.ensureRecipe(sessionDiags);
    if (recipe === null) {
      // 配方无法与当前输入对齐（如绑定了标定却未设置）：失败，不静默降级
      this.sessionDiagnostics = sessionDiags;
      const outcome = syntheticFailed(
        'RECIPE_NOT_USABLE',
        '配方无法与当前输入对齐（详见诊断：缺标定 / 指纹不符且不可自动重绑）',
      );
      outcome.diagnostics = [...sessionDiags, ...outcome.diagnostics];
      this.lastFailure = outcome;
      return outcome;
    }
    const baseline = computeDirectionBaseline(
      { srcDirections: sourceRestDirections(
          this.source.bvh,
          ({ x: 0, y: 1, z: 2 } as const)[this.source.motion.upAxisSource], // 有效采样轴向（PR 复审 P2）
        ) },
      this.target.rig,
    );
    const sp = this.sourceCal?.supportPlane;
    // 源平面法向在使用点归一（PR 复审）：校验层只警告不改值，未归一法向（如
    // [0,2,0]）原样进 diagnoseRetargetEnvironment 会被拒——目标侧早已同规则
    const spn = sp === undefined ? 0 : Math.hypot(sp.normal[0], sp.normal[1], sp.normal[2]);
    const spNormal: [number, number, number] = spn > 1e-9
      ? [sp!.normal[0] / spn, sp!.normal[1] / spn, sp!.normal[2] / spn]
      : [0, 1, 0];
    const environment: RetargetEnvironment = {
      sourcePlane: {
        origin: [sp?.origin[0] ?? 0, sp?.origin[1] ?? 0, sp?.origin[2] ?? 0],
        normal: spNormal,
      },
      targetPlane: {
        origin: [this.target.rig.supportPlane.origin[0], this.target.rig.supportPlane.origin[1], this.target.rig.supportPlane.origin[2]],
        normal: [this.target.rig.supportPlane.normal[0], this.target.rig.supportPlane.normal[1], this.target.rig.supportPlane.normal[2]],
      },
      origin: 'recipe-default',
      sceneNodeId: null,
    };
    const motionInput = {
      source: this.source.motion,
      targetRig: this.target.rig,
      baseline,
      recipe,
      environment,
      sourceCalibration: this.sourceCal,
      ...(signal !== undefined ? { signal } : {}),
    };
    const outcome = retargetMotion(motionInput);
    this.sessionDiagnostics = sessionDiags;
    if (outcome.status === 'failed') {
      this.lastFailure = outcome;
      return outcome;
    }
    this.lastGood = outcome;
    this.lastFailure = null;
    this.solvedRevision = this.revision;
    return outcome;
  }

  // ── 状态与消费守门 ────────────────────────────────────────────────

  /** 输入自上次成功求解后是否变化（结果待更新） */
  isStale(): boolean {
    return this.solvedRevision === null || this.solvedRevision !== this.revision;
  }

  /** 上一份可用结果（失败 / 取消后保留） */
  result(): RetargetOutcome | null {
    return this.lastGood;
  }

  lastFailedAttempt(): RetargetOutcome | null {
    return this.lastFailure;
  }

  /** 预览 / 应用 / 导出的同一版本守门：stale 或无结果时拒绝消费。 */
  requireResult(): { ok: true; outcome: RetargetOutcome } | { ok: false; code: string; message: string } {
    if (this.lastGood === null) {
      return { ok: false, code: 'MRS_NO_RESULT', message: '还没有可用结果：请先「生成预览」' };
    }
    if (this.isStale()) {
      return { ok: false, code: 'MRS_STALE', message: '结果待更新：输入已变化，请重新生成后再预览 / 应用 / 导出' };
    }
    return { ok: true, outcome: this.lastGood };
  }

  /** 当前目标的烘焙输出骨架（应用 / 导出共用同一份，与解同版本） */
  outputRig(): BakeOutputRig | null {
    return this.target?.output ?? null;
  }

  /** 世界解 → 当前输出骨架的局部轨道（同一版本守门 + bake 自身指纹守门） */
  bake(): { ok: true; tracks: LocalTrack[] } | { ok: false; code: string; message: string; diagnostics: RetargetDiagnostic[] } {
    const guard = this.requireResult();
    if (!guard.ok) {
      return { ok: false, code: guard.code, message: guard.message, diagnostics: [] };
    }
    if (this.target === null || guard.outcome.clip === null) {
      return { ok: false, code: 'MRS_NO_TARGET', message: '缺少输出骨架或世界解', diagnostics: [] };
    }
    const baked = bakeWorldSolveToLocal(guard.outcome.clip, this.target.output);
    if (baked.tracks === null) {
      return {
        ok: false,
        code: 'MRS_BAKE_FAILED',
        message: '烘焙失败（可表达性 / 骨架指纹不符），详见诊断',
        diagnostics: baked.diagnostics,
      };
    }
    return { ok: true, tracks: baked.tracks };
  }

  /**
   * 局部轨道 → 骨名键动画产物（binding-export 与场景挂载共用）。
   *
   * 只输出**源映射骨**的轨道：tip 骨（无源通道）在解里恒为 rest 局部，
   * 写不写轨道在 glTF 里逐位等价（无轨道 = 保持局部变换）；省掉恒等轨道
   * 同时保持与 L0「22 旋转 + 1 根位移」的导出契约一致。
   */
  toAnimPayload(tracks: readonly LocalTrack[], name: string): RetargetAnimPayload {
    const solvedBones = new Set(this.source?.motion.boneNames ?? []);
    const useTracks = tracks.filter((t) => solvedBones.size === 0 || solvedBones.has(t.bone));
    const frames = useTracks.length > 0 ? useTracks[0]!.times.length : 0;
    const times = new Float32Array(frames);
    for (let f = 0; f < frames; f++) times[f] = useTracks[0]!.times[f]!;
    const rotations: Record<string, Float32Array> = {};
    let translation: Float32Array | null = null;
    for (const t of useTracks) {
      const q = new Float32Array(t.rotations.length);
      for (let k = 0; k < t.rotations.length; k++) q[k] = t.rotations[k]!;
      rotations[t.bone] = q;
      if (t.translations !== null) {
        const p = new Float32Array(t.translations.length);
        for (let k = 0; k < t.translations.length; k++) p[k] = t.translations[k]!;
        translation = p;
      }
    }
    return { name, times, rotations, translation };
  }

  sourceInfo(): RetargetSourceInfo | null {
    if (this.source === null) return null;
    const root = this.source.bvh.joints[this.source.bvh.root]!;
    return {
      clipName: this.source.clipName,
      frames: this.source.motion.times.length,
      fps: 1 / this.source.bvh.frameTime,
      rootMode: this.source.motion.rootMode,
      canWorldLock: this.source.motion.canWorldLock,
      hasRootChannel: root.posColumn >= 0,
    };
  }

  // ── 呈现层只读视图（工作台预览画线用；面板不接触采样数据结构） ────

  /** 源采样第 frame 帧的骨名 → 世界位置；无源 / 越界为 null */
  sourceFramePositions(frame: number): Readonly<Record<string, V3>> | null {
    if (this.source === null) return null;
    const m = this.source.motion;
    if (frame < 0 || frame >= m.times.length) return null;
    const out: Record<string, V3> = {};
    for (const b of m.boneNames) {
      const p = m.worldPositions[b];
      if (p === undefined) continue;
      out[b] = [p[frame * 3]!, p[frame * 3 + 1]!, p[frame * 3 + 2]!];
    }
    return out;
  }

  /** 源骨（HumanIK 名）的父骨名 */
  sourceParentOf(bone: string): string | null {
    return this.source?.motion.boneNames.includes(bone) === true
      ? (HUMANIK_BONES[bone]?.parent ?? null)
      : null;
  }

  /** 目标骨架视图：骨序 / 父链 / 标记表 / 支撑平面高度（预览地线） */
  targetSkeletonView(): {
    order: readonly string[];
    parentOf: (bone: string) => string | null;
    markers: Readonly<Record<string, { id: string; bone: string; offset: V3 }>>;
    planeY: number;
    /** 骨盆到支撑面的高度（米）——对单位解释敏感的观测量（差分 oracle 用） */
    pelvisHeightM: number;
  } | null {
    if (this.target === null) return null;
    const bones = this.target.rig.bones;
    return {
      order: this.target.rig.order,
      parentOf: (b: string) => bones[b]?.parent ?? null,
      markers: this.target.rig.markers,
      planeY: this.target.rig.supportPlane.origin[1],
      pelvisHeightM: this.target.rig.pelvisHeightM,
    };
  }

  /** 当前结果第 frame 帧的世界姿态与标记世界点（无结果 / 越界为 null） */
  resultFrameView(frame: number): {
    bonePos: Readonly<Record<string, V3>>;
    markerWorld: (id: string) => V3 | null;
  } | null {
    if (this.lastGood === null || this.lastGood.clip === null) return null;
    const frames = this.lastGood.clip.frames;
    if (frame < 0 || frame >= frames.length) return null;
    const fr = frames[frame]!;
    const rig = this.target?.rig ?? null;
    return {
      bonePos: fr.bonePos,
      markerWorld: (id: string): V3 | null => {
        if (rig === null) return null;
        const mk = rig.markers[id];
        if (mk === undefined) return null;
        const bone = fr.bonePos[mk.bone];
        const q = fr.boneQuat[mk.bone];
        if (bone === undefined || q === undefined) return null;
        const off = rotateVec(q, mk.offset);
        return [bone[0] + off[0], bone[1] + off[1], bone[2] + off[2]];
      },
    };
  }

  /** 诊断汇总（状态 + 覆盖 + 指标 + 接触段 + 逐约束残差）；呈现层只渲染不重算 */
  summary(): RetargetSessionSummary {
    const outcome = this.lastGood;
    const failure = this.lastFailure;
    let status: RetargetSessionStatus;
    if (this.source === null) status = 'idle';
    else if (this.isStale()) {
      status = outcome !== null ? 'stale' : failure !== null ? 'failed' : 'ready';
    } else if (outcome !== null) status = outcome.status === 'complete' ? 'pass' : 'partial';
    else if (failure !== null) status = 'failed';
    else status = 'ready';
    const diagSource = this.isStale() && failure !== null ? failure : outcome ?? failure;
    const diagnostics = [
      ...this.sessionDiagnostics,
      ...this.srcCalDiagnostics,
      ...this.tgtCalDiagnostics,
      ...(diagSource?.diagnostics ?? []),
    ];
    const times = outcome?.clip?.times;
    const hT = this.target?.rig.pelvisHeightM ?? null;
    const tol = this.recipe !== null && hT !== null
      ? {
          anchorM: this.recipe.tolerances.anchorH * hT,
          slideM: this.recipe.tolerances.slideH * hT,
          penetrationM: this.recipe.tolerances.penetrationH * hT,
        }
      : null;
    return {
      status,
      hasSource: this.source !== null,
      hasTarget: this.target !== null,
      clipName: this.source?.clipName ?? null,
      targetName: this.target?.name ?? null,
      sourceCalibrated: this.sourceCal !== null,
      targetCalibrated: this.targetCal !== null,
      rootMode: this.source?.motion.rootMode ?? null,
      canWorldLock: this.source?.motion.canWorldLock ?? false,
      rootMotionSetting: this.source !== null
        ? (this.sourceOpts.rootMotion ?? 'auto')
        : null,
      spaceMode: this.recipe?.spaceMode ?? null,
      targetPlaneY: this.target?.rig.supportPlane.origin[1] ?? null,
      frames: times?.length ?? this.source?.motion.times.length ?? null,
      durationS: times !== undefined && times.length > 0 ? times[times.length - 1]! : null,
      fps: this.source !== null ? 1 / this.source.bvh.frameTime : null,
      coverage: outcome?.coverage ?? [],
      metrics: outcome?.metrics ?? null,
      segments: outcome?.segments ?? [],
      constraintResiduals: outcome?.constraintResiduals ?? [],
      tolerances: tol,
      diagnostics,
      lastFailureCode: failure?.diagnostics.find((d) => d.severity === 'error')?.code ?? null,
    };
  }

  // ── 配方持久化（重载复现 / 失效重绑） ─────────────────────────────

  recipeJson(): string | null {
    return this.recipe === null ? null : JSON.stringify(this.recipe);
  }

  /** 载入配方 JSON：走迁移 + 校验；与当前输入不符的绑定在下次 solve 时重绑并留诊断。 */
  loadRecipeJson(json: string): LoadResult {
    const migrated = migrateRetargetRecipe(safeParse(json));
    const diagnostics = migrated.diagnostics.map(metaDiagToRetarget);
    if (migrated.value === null || diagnostics.some((d) => d.severity === 'error')) {
      return { ok: false, diagnostics };
    }
    this.recipe = migrated.value;
    this.bump();
    return { ok: true, diagnostics };
  }

  // ── 标定 sidecar（.meta.json 的 retarget 块） ──────────────────────

  /** 保存一侧标定到 sidecar（merge：保留同文件里已有的 retarget.recipe 等字段）。 */
  async saveCalibrationToMeta(
    side: 'source' | 'target',
    metaPath: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const cal = side === 'source' ? this.sourceCal : this.targetCal;
    if (cal === null) return { ok: false, error: `没有${side === 'source' ? '源' : '目标'}侧标定可保存` };
    const cur = await this.store.read(metaPath);
    if (!cur.ok || cur.json === null) {
      return { ok: false, error: `读不到 sidecar（${cur.error ?? '不存在'}）：先跑 pnpm run scene:gen 生成合法 meta` };
    }
    const prevRetarget = (cur.json.retarget ?? {}) as Record<string, unknown>;
    const merged = {
      ...prevRetarget,
      calibration: { ...cal, schemaVersion: RETARGET_META_SCHEMA_VERSION },
    };
    const res = await this.store.patch(metaPath, { retarget: merged });
    return res.ok ? { ok: true } : { ok: false, error: `写入失败：${res.error ?? '未知错误'}` };
  }

  /** 从 sidecar 读一侧标定并设入会话（校验 / side 核对，坏数据不静默顶替）。 */
  async loadCalibrationFromMeta(side: 'source' | 'target', metaPath: string): Promise<LoadResult> {
    const cur = await this.store.read(metaPath);
    if (!cur.ok || cur.json === null) {
      return {
        ok: false,
        diagnostics: [err('META_READ_FAILED', `读不到 sidecar（${cur.error ?? '不存在'}）`)],
      };
    }
    const block = cur.json.retarget as { calibration?: unknown } | undefined;
    const cal = block?.calibration;
    if (cal === undefined || cal === null) {
      return { ok: false, diagnostics: [err('CAL_ABSENT', `${metaPath} 没有 retarget.calibration`)] };
    }
    const diags = validateRetargetCalibration(cal).map(metaDiagToRetarget);
    const calSide = (cal as Partial<RetargetCalibration>).side;
    if (calSide !== side) {
      diags.push(err('CAL_SIDE_MISMATCH', `sidecar 标定 side='${String(calSide)}' 与请求的 '${side}' 不一致`));
    }
    if (diags.some((d) => d.severity === 'error')) return { ok: false, diagnostics: diags };
    return side === 'source'
      ? this.setSourceCalibration(cal as RetargetCalibration)
      : this.setTargetCalibration(cal as RetargetCalibration);
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private bump(): void {
    this.revision += 1;
  }

  /** 求解侧 rig + 烘焙侧输出骨架一体构建（同一指纹身份，避免两处几何漂移） */
  private buildTargetParts(
    input: RetargetTargetInput,
    cal: RetargetCalibration | null,
  ): { ok: true; rig: RetargetRig; output: BakeOutputRig; diagnostics: RetargetDiagnostic[] } | { ok: false; diagnostics: RetargetDiagnostic[] } {
    let skeleton: SkeletonData | null = input.skeleton ?? null;
    if (skeleton === null && input.fitPositions != null) {
      skeleton = skeletonFromFitPositions(input.fitPositions);
    }
    const built = buildTargetRig({ skeleton, calibration: cal, name: input.name });
    const diagnostics = [...built.diagnostics];
    if (diagnostics.some((d) => d.severity === 'error')) {
      return { ok: false, diagnostics };
    }
    const baked = skeleton !== null
      ? bakeOutputRigFromSkeleton(skeleton, cal, built.rig.fingerprint)
      : { output: bakeOutputRigFromTemplate(built.rig.fingerprint), diagnostics: [] as RetargetDiagnostic[] };
    diagnostics.push(...baked.diagnostics);
    if (diagnostics.some((d) => d.severity === 'error')) {
      return { ok: false, diagnostics };
    }
    return { ok: true, rig: built.rig, output: baked.output, diagnostics };
  }

  /** 无输入时的可编辑草稿（solve 前会被 ensureRecipe 重绑或拒绝） */
  private draftRecipe(): RetargetRecipe {
    if (this.source === null || this.target === null) {
      return createDefaultRecipe(
        { guid: 'pending:source', path: 'pending', contentHash: 'pending' },
        { guid: 'pending:target', path: 'pending', contentHash: 'pending' },
        { name: 'retarget' },
      );
    }
    return createDefaultRecipe(
      this.sourceRef(),
      this.targetRef(),
      { name: this.source.clipName },
    );
  }

  /**
   * 源 / 目标的资产引用：guid 与 path 都用**内容 id**（指纹）。
   * 显示名（片段名 / 物体名）不进引用——改名 / 两入口目标名不同不得造成假失效
   * （A14：两入口等价目标 → 同一配方身份）。真实文件路径接入（资产库源）时替换 path。
   */
  private sourceRef(): { guid: string; path: string; contentHash: string } {
    const fp = this.source!.motion.fingerprint;
    return { guid: `bvhfp:${fp}`, path: `bvhfp:${fp}`, contentHash: fp };
  }

  private targetRef(): { guid: string; path: string; contentHash: string } {
    const fp = this.target!.rig.fingerprint;
    return { guid: `rigfp:${fp}`, path: `rigfp:${fp}`, contentHash: fp };
  }

  /**
   * 配方与当前输入对齐：源 / 目标 / 标定指纹任一变化 → 重绑（保留用户参数）。
   * A16：改任一侧标定只重绑该侧指纹；重算即用新指纹（不悄悄沿用旧绑定）。
   *
   * R13 防降级（复审 P1）：**配方绑定了标定指纹、会话却没设该侧标定**时不允许静默
   * 重绑成"未标定"求解——那会把持久配方的标定身份就地抹掉。此时 solve 直接失败，
   * 指引补标定（loadCalibrationFromMeta）或显式重置配方。标定存在但指纹不同
   * （用户改了标定）才是 A16 允许的重绑路径。
   */
  private ensureRecipe(sessionDiags: RetargetDiagnostic[]): RetargetRecipe | null {
    if (this.source === null || this.target === null) {
      throw new Error('MRS_INTERNAL: ensureRecipe 需要源与目标先就绪');
    }
    const srcCalFp = this.sourceCal !== null ? calibrationFingerprint(this.sourceCal) : '';
    const tgtCalFp = this.targetCal !== null ? calibrationFingerprint(this.targetCal) : '';
    const cur = this.recipe;
    if (
      cur !== null &&
      cur.source.contentHash === this.source.motion.fingerprint &&
      cur.target.contentHash === this.target.rig.fingerprint &&
      cur.sourceCalibrationFingerprint === srcCalFp &&
      cur.targetCalibrationFingerprint === tgtCalFp &&
      cur.algorithmVersion === RETARGET_ALGORITHM_VERSION
    ) {
      return cur;
    }
    // R13 拒绝只适用于「配方与当前**同一**源/目标匹配、却缺它绑定的标定」（防持久配方
    // 被静默降级）。输入本身已换（指纹不符）时旧配方整体作废——包括它的标定绑定——
    // 直接重绑（换源后标定被兼容性停用的场景就属于这一类，不得被拒绝卡死）
    const sameSource = cur !== null && cur.source.contentHash === this.source.motion.fingerprint;
    const sameTarget = cur !== null && cur.target.contentHash === this.target.rig.fingerprint;
    if (sameSource && cur!.sourceCalibrationFingerprint !== '' && srcCalFp === '') {
      sessionDiags.push(err(
        'RECIPE_CAL_UNBOUND',
        `配方绑定了源标定指纹（${cur!.sourceCalibrationFingerprint.slice(0, 10)}…）但会话未设置源标定：` +
          '拒绝静默降级为未标定求解；请先载入标定（loadCalibrationFromMeta）或重置配方',
      ));
      return null;
    }
    if (sameTarget && cur!.targetCalibrationFingerprint !== '' && tgtCalFp === '') {
      sessionDiags.push(err(
        'RECIPE_CAL_UNBOUND',
        `配方绑定了目标标定指纹（${cur!.targetCalibrationFingerprint.slice(0, 10)}…）但会话未设置目标标定：` +
          '拒绝静默降级；请先载入标定或重置配方',
      ));
      return null;
    }
    const fresh = createDefaultRecipe(
      this.sourceRef(),
      this.targetRef(),
      {
        name: cur?.name ?? this.source.clipName,
        ...(cur?.spaceMode !== undefined ? { spaceMode: cur.spaceMode } : {}),
        ...(cur?.annotations !== undefined ? { annotations: cur.annotations } : {}),
      },
    );
    if (cur !== null) {
      fresh.contactDetection = cur.contactDetection;
      fresh.tolerances = cur.tolerances;
      fresh.weights = cur.weights;
    }
    fresh.sourceCalibrationFingerprint = srcCalFp;
    fresh.targetCalibrationFingerprint = tgtCalFp;
    this.recipe = fresh;
    sessionDiags.push(warn(
      'RECIPE_REBOUND',
      `配方已按当前输入重绑（源 ${this.source.motion.fingerprint.slice(0, 10)}… / 目标 ${this.target.rig.fingerprint.slice(0, 10)}…）；旧结果已失效`,
    ));
    return fresh;
  }
}

// ---------------------------------------------------------------- 工具

function syntheticFailed(code: string, message: string): RetargetOutcome {
  return {
    status: 'failed',
    clip: null,
    diagnostics: [err(code, message)],
    metrics: null,
    coverage: [],
    dependencyFingerprint: '',
    segments: [],
    constraintResiduals: [],
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/** scene 包 MetaDiagnostic（path 型）→ 会话诊断（constraint 定位型） */
function metaDiagToRetarget(d: { severity: 'error' | 'warning' | 'info'; code: string; message: string; path: string }): RetargetDiagnostic {
  return { severity: d.severity, code: d.code, message: `${d.message}（${d.path}）` };
}
