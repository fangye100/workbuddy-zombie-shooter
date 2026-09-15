/**
 * contracts.ts —— 运动重定向管线的**运行期内存契约**（MR-01）。
 *
 * 与持久化契约的分工（docs/16 §5 / §6）：
 *  - 持久化（`@aether/scene` 的 retarget-meta）：RetargetCalibration / RetargetRecipe，
 *    写进 `.meta.json`；
 *  - 本文件：RetargetRig / SourceMotion / ContactSegment / RetargetEnvironment /
 *    **RetargetOutcome**（运行期求解结果，刻意不与 retarget.ts 的 L0
 *    `RetargetResult` 同名——两者不同形）+ 形状校验 + 依赖指纹。
 *  - 本文件没有任何求解逻辑；求解器（MR-02 起）只消费这里的形状。
 *
 * 数值约定：位置一律**米**、时间一律**秒**、朝向一律四元数 xyzw、
 * 采样后的世界量一律在**规范世界系**（Y-up、与目标支撑平面同朝向的右手系）里。
 */

import { retargetFingerprint } from '@aether/scene';

export type Quat = [number, number, number, number];
export type V3 = [number, number, number];

// ---------------------------------------------------------------- RetargetRig

/** 运行期目标骨架的一根骨（rest TRS；不复制蒙皮/权重——那些在资产里） */
export interface RigBone {
  name: string;
  parent: string | null;
  /** rest 局部平移（米） */
  restLocalT: V3;
  /** rest 局部旋转（xyzw） */
  restLocalR: Quat;
}

/** 一条求解链（腿/臂）。joints 从链根到末端，父子相连 */
export interface RigChain {
  id: string;
  /** 链根骨（如 LeftUpLeg 的父——Hips 上的附着点由 FK 决定，不在这里） */
  joints: readonly string[];
  /** 链总长（米，rest 下逐段累加） */
  lengthM: number;
}

export interface RigMarker {
  id: string;
  bone: string;
  /** 骨局部偏移（米）。世界点 = 骨骼世界变换 · offset */
  offset: V3;
  origin: 'derived' | 'manual';
}

/** 目标（或源）骨架的运行期描述。由 rig-calibration.ts 从资产 + 标定构造 */
export interface RetargetRig {
  name: string;
  /** 父先于子的骨名序 */
  order: readonly string[];
  bones: Readonly<Record<string, RigBone>>;
  chains: readonly RigChain[];
  markers: Readonly<Record<string, RigMarker>>;
  /** h_t：参考站姿骨盆原点到支撑平面的高度（米，含足底标定） */
  pelvisHeightM: number;
  supportPlane: { origin: V3; normal: V3 };
  /** 该侧资产原单位 → 米 */
  unitScale: number;
  upAxis: 'x' | 'y' | 'z';
  rotationBaseline: 'direction' | 'world-rest';
  fingerprint: string;
}

// ---------------------------------------------------------------- SourceMotion

/**
 * 源采样的根运动模式（docs/16 §3.4，A09 的四种能力）：
 *  - world-trajectory         根有位置通道且世界位移非零 → 可世界锁脚
 *  - in-place-with-trajectory 有位置通道但位移 ≈ 0（原地表演）；除非标注补出
 *                             可重建轨迹，否则不能承诺世界锁脚
 *  - in-place-with-phase      无根位置通道，仅相位可指导局部摆动
 *  - unknown                  轨迹不可信（NaN / 时间轴异常），拒绝世界语义
 */
export type RootMotionMode =
  | 'world-trajectory'
  | 'in-place-with-trajectory'
  | 'in-place-with-phase'
  | 'unknown';

/** 源动作的规范世界采样（秒/米/Y-up）。全部数组按帧平铺，长度由 times.length 决定 */
export interface SourceMotion {
  fingerprint: string;
  boneNames: readonly string[];
  /** 秒，严格升序，从 0 起 */
  times: Float64Array;
  /** 骨名 → (frames × 4) 局部旋转 xyzw */
  localRotations: Readonly<Record<string, Float64Array>>;
  /** 骨名 → (frames × 4) 世界旋转（规范世界系） */
  worldRotations: Readonly<Record<string, Float64Array>>;
  /** 骨名 → (frames × 3) 世界位置（米，规范世界系） */
  worldPositions: Readonly<Record<string, Float64Array>>;
  rootBone: string;
  rootMode: RootMotionMode;
  /** 世界锁脚能力：有可信轨迹（world-trajectory，或标注重建）才为 true */
  canWorldLock: boolean;
  /** 原始源单位 → 米的换算（记录来源，便于诊断） */
  unitScaleSource: number;
  upAxisSource: 'x' | 'y' | 'z';
}

// ---------------------------------------------------------------- 接触与环境

export type ContactMode = 'support' | 'roll' | 'slide';

/** 一段接触（docs/16 §5 ContactSegment） */
export interface ContactSegment {
  /** 稳定 id：`<marker>@<startS>s` */
  id: string;
  marker: string;
  /** 参与求解的链 id；null = 未指定（仅诊断用） */
  chainId: string | null;
  startS: number;
  endS: number;
  mode: ContactMode;
  space: 'world' | 'object' | 'body';
  origin: 'annotated' | 'detected';
  /** 置信度 0..1（annotated 恒 1） */
  confidence: number;
  /** 世界落点（support/slide 的初始锚；roll 为当前枢轴）——由 space-targets 构造 */
  anchor: V3 | null;
  pivot: V3 | null;
}

/** 环境契约（docs/16 §5 RetargetEnvironment）。平地 MVP 用 recipe-default */
export interface RetargetEnvironment {
  sourcePlane: { origin: V3; normal: V3 };
  targetPlane: { origin: V3; normal: V3 };
  origin: 'recipe-default' | 'scene';
  /** origin === 'scene' 时必填（NodeRef，不用数组下标） */
  sceneNodeId: string | null;
}

// ---------------------------------------------------------------- 求解结果

/** 单帧规范世界解 */
export interface WorldPoseFrame {
  t: number;
  rootPos: V3;
  rootQuat: Quat;
  bonePos: Readonly<Record<string, V3>>;
  boneQuat: Readonly<Record<string, Quat>>;
}

/** 统一世界解（烘焙前）。bake-adapter 负责转到指定输出骨架的节点局部轨道 */
export interface WorldSolveClip {
  times: Float64Array;
  frames: readonly WorldPoseFrame[];
  /** 输出目标骨架指纹（防止解算后骨架被换掉还继续用旧解） */
  skeletonFingerprint: string;
}

export interface RetargetDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  /** 定位：帧下标（可选） */
  frame?: number;
  /** 定位：约束/标记 id（可选） */
  constraint?: string;
}

/** 质量指标（docs/16 §5 报告字段；MR-05 的 quality-report 填充） */
export interface RetargetMetrics {
  /** 锁定段最大锚点偏差（米） */
  maxAnchorDeviationM: number;
  /** 累计切向滑动路程（米） */
  cumulativeSlideM: number;
  /** 最大穿透（米，向下为正） */
  maxPenetrationM: number;
  /** 摆动相最小净空（米；负值 = 刮地） */
  minSwingClearanceM: number;
  /** 内/外可达残差（米） */
  maxReachResidualInnerM: number;
  maxReachResidualOuterM: number;
  /** 根修正幅度（米，相对基准根轨迹） */
  maxRootCorrectionM: number;
  /** 修正引入的最大速度跳变（m/s） */
  maxSwitchJumpMps: number;
  /** 关节超限计数（足部 MVP 恒 0，占位给 MR-07） */
  jointLimitViolations: number;
  /** 求解迭代次数与收敛状态 */
  iterations: number;
  converged: boolean;
  /** 求解耗时与峰值内存估计 */
  durationMs: number;
  peakMemoryEstMb: number;
}

/** 求解结果（docs/16 §5，2026-09-15 起得名 RetargetOutcome） */
export interface RetargetOutcome {
  status: 'complete' | 'partial' | 'failed';
  /** 规范世界解；failed 时为 null（不覆盖已有产物） */
  clip: WorldSolveClip | null;
  diagnostics: readonly RetargetDiagnostic[];
  metrics: RetargetMetrics | null;
  /** 本次实际启用的能力（如 'foot-contact' / 'world-lock'） */
  coverage: readonly string[];
  /** 全部输入的依赖指纹；任一输入变化即失效 */
  dependencyFingerprint: string;
}

// ---------------------------------------------------------------- 校验与指纹

const CODE_PREFIX = 'MRC';

function err(diags: RetargetDiagnostic[], code: string, message: string, extra?: Partial<RetargetDiagnostic>): void {
  diags.push({ severity: 'error', code: `${CODE_PREFIX}_${code}`, message, ...extra });
}

function quatNormOk(q: Quat): boolean {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return Number.isFinite(n) && n > 1 - 1e-3 && n < 1 + 1e-3;
}

/**
 * SourceMotion 形状校验（A09 的守门）：秒制严格升序、数组长度一致、
 * 四元数有限且归一、无 NaN。返回诊断；有 error 即拒绝进管线。
 */
export function diagnoseSourceMotion(m: SourceMotion): RetargetDiagnostic[] {
  const diags: RetargetDiagnostic[] = [];
  const frames = m.times.length;
  if (frames < 2) {
    err(diags, 'MOTION_TOO_SHORT', '源动作至少需要 2 帧');
    return diags;
  }
  for (let f = 0; f < frames; f++) {
    const t = m.times[f]!;
    if (!Number.isFinite(t) || t < 0 || (f > 0 && !(t > m.times[f - 1]!))) {
      err(diags, 'TIMES_NOT_ASCENDING', `时间轴在第 ${f} 帧不是严格升序的秒值`, { frame: f });
      break;
    }
  }
  for (const bone of m.boneNames) {
    const rot = m.localRotations[bone];
    const wr = m.worldRotations[bone];
    const wp = m.worldPositions[bone];
    if (rot !== undefined && rot.length !== frames * 4) {
      err(diags, 'LOCAL_ROT_LEN', `${bone} 局部旋转数组长度 ${rot.length} ≠ frames×4`);
    }
    if (wr !== undefined && wr.length !== frames * 4) {
      err(diags, 'WORLD_ROT_LEN', `${bone} 世界旋转数组长度 ${wr.length} ≠ frames×4`);
    }
    if (wp !== undefined && wp.length !== frames * 3) {
      err(diags, 'WORLD_POS_LEN', `${bone} 世界位置数组长度 ${wp.length} ≠ frames×3`);
    }
    for (const arr of [rot, wr]) {
      if (arr === undefined) continue;
      for (let f = 0; f < frames; f++) {
        const q: Quat = [arr[f * 4]!, arr[f * 4 + 1]!, arr[f * 4 + 2]!, arr[f * 4 + 3]!];
        if (!quatNormOk(q)) {
          err(diags, 'QUAT_NOT_NORMALIZED', `${bone} 第 ${f} 帧四元数非有限/未归一`, { frame: f });
          break;
        }
      }
    }
    if (wp !== undefined) {
      for (let k = 0; k < wp.length; k++) {
        if (!Number.isFinite(wp[k])) {
          err(diags, 'WORLD_POS_NAN', `${bone} 世界位置含非有限值`);
          break;
        }
      }
    }
  }
  if (!m.boneNames.includes(m.rootBone)) {
    err(diags, 'ROOT_MISSING', `根骨 ${m.rootBone} 不在骨名表里`);
  }
  if (m.upAxisSource === 'x') {
    diags.push({ severity: 'warning', code: `${CODE_PREFIX}_XUP_NOT_NORMALIZED`, message: 'X-up 源未做轴向归一（极罕见），结果可能不可用' });
  }
  if (m.rootMode === 'unknown') {
    diags.push({ severity: 'warning', code: `${CODE_PREFIX}_ROOT_UNKNOWN`, message: '根轨迹不可信，世界锁脚能力关闭' });
  }
  if (m.canWorldLock && m.rootMode !== 'world-trajectory') {
    err(diags, 'LOCK_WITHOUT_TRAJECTORY', 'canWorldLock 需要 world-trajectory 根模式（无轨迹不伪造 world 模式）');
  }
  return diags;
}

/**
 * RetargetRig 形状校验：父先于子、无环、链连续、标记骨存在、h_t > 0、单位 > 0。
 */
export function diagnoseRetargetRig(rig: RetargetRig): RetargetDiagnostic[] {
  const diags: RetargetDiagnostic[] = [];
  const seen = new Set<string>();
  for (const name of rig.order) {
    const b = rig.bones[name];
    if (b === undefined) {
      err(diags, 'BONE_MISSING', `骨 ${name} 在 bones 表里不存在`);
      continue;
    }
    if (b.parent !== null && !seen.has(b.parent)) {
      err(diags, 'ORDER_NOT_PARENT_FIRST', `骨 ${name} 的父 ${b.parent} 未先于它出现（或有环）`);
    }
    if (!quatNormOk(b.restLocalR)) {
      err(diags, 'REST_QUAT_BAD', `${name} 的 rest 旋转非有限/未归一`);
    }
    if (b.restLocalT.some((v) => !Number.isFinite(v))) {
      err(diags, 'REST_T_BAD', `${name} 的 rest 平移含非有限值`);
    }
    seen.add(name);
  }
  const inOrder = new Set(rig.order);
  for (const b of Object.keys(rig.bones)) {
    if (!inOrder.has(b)) err(diags, 'BONE_NOT_IN_ORDER', `骨 ${b} 不在 order 表里`);
  }
  for (const ch of rig.chains) {
    if (ch.joints.length < 2) {
      err(diags, 'CHAIN_TOO_SHORT', `链 ${ch.id} 至少要有 2 根骨`);
      continue;
    }
    for (let i = 0; i < ch.joints.length; i++) {
      const j = ch.joints[i]!;
      if (!inOrder.has(j)) {
        err(diags, 'CHAIN_BONE_MISSING', `链 ${ch.id} 引用不存在的骨 ${j}`);
        break;
      }
      if (i > 0 && rig.bones[j]!.parent !== ch.joints[i - 1]) {
        err(diags, 'CHAIN_NOT_CONTIGUOUS', `链 ${ch.id} 在 ${j} 处不满足父子相连`);
        break;
      }
    }
    if (!(ch.lengthM > 0)) err(diags, 'CHAIN_LENGTH_BAD', `链 ${ch.id} 总长必须 > 0`);
  }
  for (const [id, mk] of Object.entries(rig.markers)) {
    if (!inOrder.has(mk.bone)) {
      err(diags, 'MARKER_BONE_MISSING', `标记 ${id} 引用不存在的骨 ${mk.bone}`);
    }
    if (mk.offset.some((v) => !Number.isFinite(v))) {
      err(diags, 'MARKER_OFFSET_BAD', `标记 ${id} 偏移含非有限值`);
    }
  }
  if (!(rig.pelvisHeightM > 0)) err(diags, 'PELVIS_HEIGHT_BAD', 'h_t（骨盆高）必须 > 0');
  if (!(rig.unitScale > 0)) err(diags, 'UNIT_SCALE_BAD', 'unitScale 必须 > 0');
  return diags;
}

/** 全部输入的依赖指纹：源、目标、配方、环境、算法版本任一变化 → 结果失效 */
export function computeDependencyFingerprint(input: {
  sourceFingerprint: string;
  targetRig: RetargetRig;
  recipeSemantic: unknown;
  environment: RetargetEnvironment;
  algorithmVersion: string;
}): string {
  return retargetFingerprint({
    source: input.sourceFingerprint,
    targetRig: input.targetRig.fingerprint,
    recipe: input.recipeSemantic,
    environment: {
      sourcePlane: input.environment.sourcePlane,
      targetPlane: input.environment.targetPlane,
      origin: input.environment.origin,
      sceneNodeId: input.environment.sceneNodeId,
    },
    algorithmVersion: input.algorithmVersion,
  });
}

export function hasErrors(diags: readonly RetargetDiagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}
