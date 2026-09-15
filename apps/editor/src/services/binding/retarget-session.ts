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
} from './humanik-template';
import type { JointPositions } from './binding-math';
import { parseBvh, type BvhFile } from './bvh-parser';
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

function identity16(): Float32Array<ArrayBuffer> {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// ---------------------------------------------------------------- 目标骨架适配

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

export class RetargetSession {
  private readonly store: RetargetSidecarStore;
  private source: SessionSource | null = null;
  private target: SessionTarget | null = null;
  private sourceCal: RetargetCalibration | null = null;
  private targetCal: RetargetCalibration | null = null;
  private recipe: RetargetRecipe | null = null;
  private lastGood: RetargetOutcome | null = null;
  private lastFailure: RetargetOutcome | null = null;
  private sessionDiagnostics: RetargetDiagnostic[] = [];
  private revision = 0;
  private solvedRevision: number | null = null;

  constructor(store: RetargetSidecarStore) {
    this.store = store;
  }

  // ── 输入 ──────────────────────────────────────────────────────────

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
    this.bump();
    return { ok: true, diagnostics };
  }

  /**
   * 设定目标（两入口的差别只在这里收敛）。有目标标定时随 rig 一起生效；
   * 旧结果立即失效。骨架构建失败（非统一缩放 / 环 / 缺 Hips）不改当前目标。
   */
  setTarget(input: RetargetTargetInput): LoadResult {
    const built = this.buildTargetParts(input, this.targetCal);
    if (!built.ok) return { ok: false, diagnostics: built.diagnostics };
    this.target = {
      rig: built.rig,
      name: input.name,
      output: built.output,
      origin: { skeleton: input.skeleton ?? null, fitPositions: input.fitPositions ?? null, name: input.name },
    };
    this.bump();
    return { ok: true, diagnostics: built.diagnostics };
  }

  /**
   * 用**当前**目标输入核对会话目标：几何有变 → 重设目标并失效（'changed'），
   * 无变 → 不动（'unchanged'），构造失败 → 'invalid'（目标保持原状）。
   *
   * 入口 A 的 fit 在绑定面板里随时可被拖改——求解前 sync 保证解的是当前 fit；
   * 导出前 sync 必须为 unchanged，否则拒绝导出（防「解是旧 fit、导出铺新 fit」）。
   */
  syncTarget(input: RetargetTargetInput): { state: 'unchanged' | 'changed' | 'invalid'; diagnostics: RetargetDiagnostic[] } {
    if (this.target === null) {
      const r = this.setTarget(input);
      return { state: r.ok ? 'changed' : 'invalid', diagnostics: r.diagnostics };
    }
    const built = this.buildTargetParts(input, this.targetCal);
    if (!built.ok) return { state: 'invalid', diagnostics: built.diagnostics };
    if (built.rig.fingerprint === this.target.rig.fingerprint) {
      return { state: 'unchanged', diagnostics: built.diagnostics };
    }
    this.target = {
      rig: built.rig,
      name: input.name,
      output: built.output,
      origin: { skeleton: input.skeleton ?? null, fitPositions: input.fitPositions ?? null, name: input.name },
    };
    this.bump();
    return { state: 'changed', diagnostics: built.diagnostics };
  }

  /** 源侧标定（null = 清除 → 接触能力回到未标定态）。side 必须为 source。 */
  setSourceCalibration(cal: RetargetCalibration | null): LoadResult {
    if (cal === null) {
      this.sourceCal = null;
      this.bump();
      return { ok: true, diagnostics: [] };
    }
    const diags = validateRetargetCalibration(cal).map(metaDiagToRetarget);
    if (cal.side !== 'source') {
      diags.push(err('CAL_SIDE_MISMATCH', `源侧标定的 side 必须是 'source'，收到 '${cal.side}'`));
    }
    if (diags.some((d) => d.severity === 'error')) return { ok: false, diagnostics: diags };
    this.sourceCal = cal;
    this.bump();
    return { ok: true, diagnostics: diags };
  }

  /** 目标侧标定；改变即按原目标来源重建 rig（h_t / 标记 / 平面全走新值）。 */
  setTargetCalibration(cal: RetargetCalibration | null): LoadResult {
    if (cal === null) {
      this.targetCal = null;
      if (this.target !== null) {
        const r = this.setTarget(this.target.origin);
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
    this.targetCal = cal;
    if (this.target !== null) {
      const r = this.setTarget(this.target.origin);
      return { ok: r.ok, diagnostics: [...diags, ...r.diagnostics] };
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
      { srcDirections: sourceRestDirections(this.source.bvh) },
      this.target.rig,
    );
    const sp = this.sourceCal?.supportPlane;
    const environment: RetargetEnvironment = {
      sourcePlane: {
        origin: [sp?.origin[0] ?? 0, sp?.origin[1] ?? 0, sp?.origin[2] ?? 0],
        normal: [sp?.normal[0] ?? 0, sp?.normal[1] ?? 1, sp?.normal[2] ?? 0],
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
  } | null {
    if (this.target === null) return null;
    const bones = this.target.rig.bones;
    return {
      order: this.target.rig.order,
      parentOf: (b: string) => bones[b]?.parent ?? null,
      markers: this.target.rig.markers,
      planeY: this.target.rig.supportPlane.origin[1],
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
    const diagnostics = [...this.sessionDiagnostics, ...(diagSource?.diagnostics ?? [])];
    const times = outcome?.clip?.times;
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
      spaceMode: this.recipe?.spaceMode ?? null,
      targetPlaneY: this.target?.rig.supportPlane.origin[1] ?? null,
      frames: times?.length ?? this.source?.motion.times.length ?? null,
      durationS: times !== undefined && times.length > 0 ? times[times.length - 1]! : null,
      fps: this.source !== null ? 1 / this.source.bvh.frameTime : null,
      coverage: outcome?.coverage ?? [],
      metrics: outcome?.metrics ?? null,
      segments: outcome?.segments ?? [],
      constraintResiduals: outcome?.constraintResiduals ?? [],
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
    if (cur !== null && cur.sourceCalibrationFingerprint !== '' && srcCalFp === '') {
      sessionDiags.push(err(
        'RECIPE_CAL_UNBOUND',
        `配方绑定了源标定指纹（${cur.sourceCalibrationFingerprint.slice(0, 10)}…）但会话未设置源标定：` +
          '拒绝静默降级为未标定求解；请先载入标定（loadCalibrationFromMeta）或重置配方',
      ));
      return null;
    }
    if (cur !== null && cur.targetCalibrationFingerprint !== '' && tgtCalFp === '') {
      sessionDiags.push(err(
        'RECIPE_CAL_UNBOUND',
        `配方绑定了目标标定指纹（${cur.targetCalibrationFingerprint.slice(0, 10)}…）但会话未设置目标标定：` +
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
