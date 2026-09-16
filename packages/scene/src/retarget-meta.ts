/**
 * retarget-meta.ts —— 运动重定向的**持久化**数据契约（MR-01）。
 *
 * 开发合同真源：docs/16-MotionMatch动画匹配设计.md §5。这里只放会写进
 * `.meta.json` 的形状 + 校验 + 指纹 + 迁移；**运行期**内存契约
 * （RetargetRig / SourceMotion / RetargetOutcome）在编辑器侧
 * `motion-retarget/contracts.ts`，不要混进来。
 *
 * ## 归属（按 docs/16 §5 的表）
 *
 * | 数据 | 归属 |
 * |---|---|
 * | `RetargetCalibration`（SourceCalibration / TargetCalibration） | 源/目标**各自**资产的 `.meta.json`（`retarget.calibration`），各为唯一真源 |
 * | `RetargetRecipe` | **派生动画资产**的 `.meta.json`（`retarget.recipe`），只引用双方标定指纹，不复制可编辑标定 |
 * | 采样缓存 / 轨道 | 派生 GLB 与 `.workbuddy/cache/`，不是 sidecar |
 *
 * 为什么不集中一个 assetdb：见 asset-meta.ts 头注释（sidecar 抗合并冲突）。
 *
 * ## 指纹
 *
 * 任何标定被修改都必须使引用它的配方失效。指纹 = 规范化 JSON（键排序）过
 * 双轮 FNV-1a（两粒种子 → 96 bit 十六进制）。要求：同一进程 / 跨进程 /
 * 跨会话稳定；对键序不敏感；对任何语义值敏感。碰撞概率对本项目规模可忽略。
 */

import type { Vec3 } from './document';
import type { MetaDiagnostic } from './asset-meta';

export const RETARGET_META_SCHEMA_VERSION = 1;

/** 当前求解算法版本：算法行为变化时必须 +1，否则旧产物不会被判定失效 */
export const RETARGET_ALGORITHM_VERSION = 'mr-foot-2';

// ---------------------------------------------------------------- 标定

/** 支撑平面（世界系）。平面 = { p : normal · (p − origin) = 0 }，normal 单位化后使用 */
export interface SupportPlane {
  origin: Vec3;
  normal: Vec3;
  /** 平面从哪来：用户声明 / 长时稳定样本拟合 / 模板默认 */
  source: 'declared' | 'fitted' | 'template';
  /** 拟合来源的置信度 0..1；declared 恒 1 */
  confidence: number;
}

/**
 * 骨局部标记（脚跟 / 前掌 / 脚尖 / 掌面 / 身体表面代理）。
 * `offset` 在**该骨骼的局部坐标系**里（世界点 = 骨骼世界变换 · offset），
 * 单位米。id 约定 `<骨名>.<部位>`，如 `LeftFoot.heel`。
 */
export interface RigMarkerEntry {
  bone: string;
  offset: Vec3;
  /** derived = 从骨架几何推导的代理（有误差，须报告）；manual = 从网格/用户标定 */
  origin: 'derived' | 'manual';
}

/**
 * 一侧（源或目标）的重定向标定。存「不能从资产反推」的数据：
 * 足底标记、参考站姿骨盆高、支撑平面、单位/轴向覆盖。
 * 骨骼层级、rest TRS、骨长**不存**——它们在资产里，抄一份就是双真源。
 */
export interface RetargetCalibration {
  schemaVersion: number;
  side: 'source' | 'target';
  /** 参考站姿：骨盆原点到支撑平面的高度（米，含足底标定）。即 docs/16 §3.1 的 h_s / h_t */
  pelvisHeightM: number;
  supportPlane: SupportPlane;
  /** 资产原单位 → 米；null = 按资产推断（BVH 由骨架高度推断） */
  unitScale: number | null;
  /** up 轴覆盖；null = 按资产推断 */
  upAxis: 'x' | 'y' | 'z' | null;
  /** 足/掌/表面标记，按 marker id 索引 */
  markers: Record<string, RigMarkerEntry>;
  /** 姿态基准分层（docs/16 §1 钉板）：direction=骨向最小弧（BVH），world-rest=世界 rest 换基（glTF→glTF） */
  rotationBaseline: 'direction' | 'world-rest';
}

/** 源侧标定（语义别名：同一形状，side 固定为 source） */
export type SourceCalibration = RetargetCalibration;
/** 目标侧标定 */
export type TargetCalibration = RetargetCalibration;

// ---------------------------------------------------------------- 配方

/** 无标注时的接触检测配置。阈值按 h_s 归一（docs/16 §3.4） */
export interface ContactDetectionSettings {
  /** 进入：标记离面高度 ≤ heightEnter × h_s */
  heightEnter: number;
  /** 进入：标记世界速度 ≤ speedEnter × h_s / s */
  speedEnter: number;
  /** 退出：速度 > speedExit × h_s / s（必须大于 speedEnter 形成滞回） */
  speedExit: number;
  /** 最短稳定持续（秒），短于它的候选丢弃 */
  minDurationS: number;
}

/** 手工接触标注（覆盖自动检测；docs/16 失败矩阵「有意滑动被误锁」的解法） */
export interface ContactAnnotation {
  marker: string;
  startS: number;
  endS: number;
  mode: 'support' | 'roll' | 'slide';
  note?: string;
}

/** 容差（按 h_t 归一的比例，验收数字见 docs/16 §8） */
export interface RetargetRecipeTolerances {
  /** 锁定段最大锚点偏差 ≤ anchorH × h_t */
  anchorH: number;
  /** 累计切向滑动 ≤ slideH × h_t */
  slideH: number;
  /** 穿透 ≤ penetrationH × h_t */
  penetrationH: number;
  /** 根朝向保持容差（度） */
  yawDeg: number;
}

/** 软任务权重（全部 > 0；比例由 MR-05 实测再调） */
export interface RetargetRecipeWeights {
  pose: number;
  root: number;
  free: number;
  anchorAdjust: number;
  temporal: number;
}

export interface RetargetAssetRef {
  guid: string;
  path: string;
  /** 源文件内容指纹（sha256 或 retargetFingerprint 产物） */
  contentHash: string;
}

/**
 * 一次重定向的完整配方：换任何输入（源/目标/标定/参数/算法版本）
 * 都必须产生不同指纹并使旧结果失效（docs/16 §5 失效规则）。
 */
export interface RetargetRecipe {
  schemaVersion: number;
  name: string;
  source: RetargetAssetRef;
  target: RetargetAssetRef;
  /** 双方标定的指纹（calibrationFingerprint）；任一标定变化 → 配方失效 */
  sourceCalibrationFingerprint: string;
  targetCalibrationFingerprint: string;
  /** 空间模式（docs/16 §3.1 钉板） */
  spaceMode: 'normalize-gait' | 'preserve-world';
  rotationBaseline: 'direction' | 'world-rest';
  contactDetection: ContactDetectionSettings;
  annotations: ContactAnnotation[];
  weights: RetargetRecipeWeights;
  tolerances: RetargetRecipeTolerances;
  algorithmVersion: string;
}

export function defaultContactDetection(): ContactDetectionSettings {
  return {
    heightEnter: 0.02,
    speedEnter: 0.1,
    speedExit: 0.25,
    minDurationS: 0.08,
  };
}

export function defaultRetargetTolerances(): RetargetRecipeTolerances {
  // docs/16 §8 A08：0.002 / 0.005 / 0.001（按 h_t 归一）；A18：0.5°
  return { anchorH: 0.002, slideH: 0.005, penetrationH: 0.001, yawDeg: 0.5 };
}

export function defaultRetargetWeights(): RetargetRecipeWeights {
  return { pose: 1, root: 1, free: 0.5, anchorAdjust: 0.1, temporal: 0.3 };
}

export function createDefaultRecipe(
  source: RetargetAssetRef,
  target: RetargetAssetRef,
  opts: Partial<Pick<RetargetRecipe, 'name' | 'spaceMode' | 'rotationBaseline' | 'annotations'>> = {},
): RetargetRecipe {
  return {
    schemaVersion: RETARGET_META_SCHEMA_VERSION,
    name: opts.name ?? 'retarget',
    source,
    target,
    // 空串 = 尚未绑定标定（保存前必须由 session 填入真实指纹）
    sourceCalibrationFingerprint: '',
    targetCalibrationFingerprint: '',
    spaceMode: opts.spaceMode ?? 'normalize-gait',
    rotationBaseline: opts.rotationBaseline ?? 'direction',
    contactDetection: defaultContactDetection(),
    annotations: opts.annotations ?? [],
    weights: defaultRetargetWeights(),
    tolerances: defaultRetargetTolerances(),
    algorithmVersion: RETARGET_ALGORITHM_VERSION,
  };
}

// ---------------------------------------------------------------- 指纹

/**
 * 规范化 JSON：对象键按字典序递归排序，数组保序。
 * 键序不影响指纹——sidecar 手工编辑后重排键不应制造假失效。
 */
export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stringifyCanonical).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stringifyCanonical(obj[k])}`).join(',')}}`;
}

/** FNV-1a 32 位单轮 */
function fnv1a(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 稳定内容指纹：双轮 FNV-1a → `fp1_<12 hex>`（96 bit）。
 * 跨进程/跨会话确定（不掺 Math.random / 时间）。
 */
export function retargetFingerprint(value: unknown): string {
  const s = stringifyCanonical(value);
  const a = fnv1a(s, 0x811c9dc5);
  const b = fnv1a(s, 0x01000193);
  const c = fnv1a(s + a.toString(16), 0x9dc5811c);
  return `fp1_${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}${c
    .toString(16)
    .padStart(8, '0')}`;
}

/** 标定指纹（用于配方的 sourceCalibrationFingerprint / targetCalibrationFingerprint） */
export function calibrationFingerprint(cal: RetargetCalibration): string {
  // schemaVersion 属于容器元数据，不参与语义指纹（升版不改内容不应假失效）
  const { schemaVersion: _v, ...semantic } = cal;
  return retargetFingerprint(semantic);
}

// ---------------------------------------------------------------- 校验

const AXIS_VALUES = ['x', 'y', 'z'] as const;
const BASELINE_VALUES = ['direction', 'world-rest'] as const;

function isVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

/** 校验一侧标定。不抛异常，返回诊断（与 validateAssetMeta 同策略） */
export function validateRetargetCalibration(cal: unknown): MetaDiagnostic[] {
  const out: MetaDiagnostic[] = [];
  const err = (path: string, code: string, message: string): void => {
    out.push({ severity: 'error', path, code, message });
  };

  if (typeof cal !== 'object' || cal === null) {
    err('/retarget/calibration', 'E_RTCAL_NOT_OBJECT', '标定必须是对象');
    return out;
  }
  const c = cal as Partial<RetargetCalibration>;

  // R14：版本先于字段校验（缺失/非法/未来版本都拒绝，不静默当 v1 用）
  if (typeof c.schemaVersion !== 'number' || !Number.isInteger(c.schemaVersion) || c.schemaVersion < 1) {
    err('/retarget/calibration/schemaVersion', 'E_RTCAL_VERSION', 'schemaVersion 缺失或非法');
  } else if (c.schemaVersion > RETARGET_META_SCHEMA_VERSION) {
    err(
      '/retarget/calibration/schemaVersion',
      'E_RTCAL_VERSION_FUTURE',
      `标定版本 ${c.schemaVersion} 高于支持的 ${RETARGET_META_SCHEMA_VERSION}，拒绝加载`,
    );
  }

  if (c.side !== 'source' && c.side !== 'target') {
    err('/retarget/calibration/side', 'E_RTCAL_SIDE', "side 必须是 'source' | 'target'");
  }
  if (typeof c.pelvisHeightM !== 'number' || !(c.pelvisHeightM > 0)) {
    err('/retarget/calibration/pelvisHeightM', 'E_RTCAL_PELVIS', '骨盆高度必须是 > 0 的米数');
  }
  if (c.unitScale !== null && c.unitScale !== undefined && !(c.unitScale > 0)) {
    err('/retarget/calibration/unitScale', 'E_RTCAL_UNIT', 'unitScale 必须 > 0 或 null');
  }
  if (c.upAxis !== null && c.upAxis !== undefined && !AXIS_VALUES.includes(c.upAxis)) {
    err('/retarget/calibration/upAxis', 'E_RTCAL_UPAXIS', 'upAxis 必须是 x/y/z 或 null');
  }
  if (!BASELINE_VALUES.includes(c.rotationBaseline as (typeof BASELINE_VALUES)[number])) {
    err(
      '/retarget/calibration/rotationBaseline',
      'E_RTCAL_BASELINE',
      'rotationBaseline 必须是 direction | world-rest（docs/16 §1 分层规则）',
    );
  }

  const sp = c.supportPlane;
  if (typeof sp !== 'object' || sp === null || !isVec3(sp.normal) || !isVec3(sp.origin)) {
    err('/retarget/calibration/supportPlane', 'E_RTCAL_PLANE', 'supportPlane 需要 origin/normal');
  } else {
    const n = Math.hypot(sp.normal[0], sp.normal[1], sp.normal[2]);
    if (n < 1e-9) {
      err('/retarget/calibration/supportPlane/normal', 'E_RTCAL_PLANE_NORMAL', '平面法向为零向量');
    } else if (Math.abs(n - 1) > 1e-6) {
      out.push({
        severity: 'warning',
        path: '/retarget/calibration/supportPlane/normal',
        code: 'W_RTCAL_PLANE_UNNORMALIZED',
        message: `平面法向未单位化（|n|=${n.toFixed(6)}），加载时会归一化`,
      });
    }
    if (sp.source !== 'declared' && sp.source !== 'fitted' && sp.source !== 'template') {
      err('/retarget/calibration/supportPlane/source', 'E_RTCAL_PLANE_SOURCE', '平面来源非法');
    }
    // PR 复审：confidence 契约为有限 0..1；管线把非 0 一律当可信——NaN/负/超 1
    // 会静默放开接触锚定，必须在准入层拒绝。declared 恒 1（schema 注释）。
    if (typeof sp.confidence !== 'number' || !Number.isFinite(sp.confidence) ||
        sp.confidence < 0 || sp.confidence > 1) {
      err('/retarget/calibration/supportPlane/confidence', 'E_RTCAL_PLANE_CONFIDENCE', 'confidence 必须是 [0,1] 内的有限数');
    } else if (sp.source === 'declared' && sp.confidence !== 1) {
      err('/retarget/calibration/supportPlane/confidence', 'E_RTCAL_PLANE_CONFIDENCE', "declared 平面的 confidence 恒为 1");
    }
  }

  if (typeof c.markers !== 'object' || c.markers === null) {
    err('/retarget/calibration/markers', 'E_RTCAL_MARKERS', 'markers 必须是对象');
  } else {
    for (const [id, mk] of Object.entries(c.markers)) {
      if (typeof mk?.bone !== 'string' || mk.bone.length === 0) {
        err(`/retarget/calibration/markers/${id}`, 'E_RTCAL_MARKER_BONE', '标记缺少骨骼名');
      }
      if (!isVec3(mk?.offset)) {
        err(`/retarget/calibration/markers/${id}/offset`, 'E_RTCAL_MARKER_OFFSET', '标记偏移必须是有限数三元组');
      }
    }
  }
  return out;
}

/** 校验配方（含对既有标定指纹形式的检查；不含对资产存在性的检查——那是 session 层职责） */
export function validateRetargetRecipe(recipe: unknown): MetaDiagnostic[] {
  const out: MetaDiagnostic[] = [];
  const err = (path: string, code: string, message: string): void => {
    out.push({ severity: 'error', path, code, message });
  };

  if (typeof recipe !== 'object' || recipe === null) {
    err('/retarget/recipe', 'E_RTR_NOT_OBJECT', '配方必须是对象');
    return out;
  }
  const r = recipe as Partial<RetargetRecipe>;

  if (typeof r.schemaVersion !== 'number' || !Number.isInteger(r.schemaVersion) || r.schemaVersion < 1) {
    err('/retarget/recipe/schemaVersion', 'E_RTR_VERSION', 'schemaVersion 缺失、非整数或低于首个支持版本 1');
  } else if (r.schemaVersion > RETARGET_META_SCHEMA_VERSION) {
    err(
      '/retarget/recipe/schemaVersion',
      'E_RTR_VERSION_FUTURE',
      `配方版本 ${r.schemaVersion} 高于支持的 ${RETARGET_META_SCHEMA_VERSION}，拒绝加载`,
    );
  }

  for (const side of ['source', 'target'] as const) {
    const ref = r[side];
    if (typeof ref !== 'object' || ref === null || typeof ref.guid !== 'string' || ref.guid.length === 0) {
      err(`/retarget/recipe/${side}`, 'E_RTR_REF', `${side} 资产引用缺 guid`);
    } else if (typeof ref.contentHash !== 'string' || ref.contentHash.length === 0) {
      err(`/retarget/recipe/${side}/contentHash`, 'E_RTR_HASH', `${side} 内容指纹不能为空`);
    }
  }

  for (const f of ['sourceCalibrationFingerprint', 'targetCalibrationFingerprint'] as const) {
    const v = r[f];
    // 空串 = 未绑定标定：可保存草稿，但不允许作为可执行配方（session 层拒跑）
    if (typeof v !== 'string' || (v.length > 0 && !v.startsWith('fp1_'))) {
      err(`/retarget/recipe/${f}`, 'E_RTR_CAL_FP', `${f} 必须是空串或 fp1_ 指纹`);
    }
  }

  if (r.spaceMode !== 'normalize-gait' && r.spaceMode !== 'preserve-world') {
    err('/retarget/recipe/spaceMode', 'E_RTR_SPACEMODE', 'spaceMode 必须是 normalize-gait | preserve-world');
  }
  if (!BASELINE_VALUES.includes(r.rotationBaseline as (typeof BASELINE_VALUES)[number])) {
    err('/retarget/recipe/rotationBaseline', 'E_RTR_BASELINE', 'rotationBaseline 非法');
  }

  const det = r.contactDetection;
  if (typeof det !== 'object' || det === null) {
    err('/retarget/recipe/contactDetection', 'E_RTR_DETECT', 'contactDetection 缺失');
  } else {
    if (!(det.heightEnter > 0)) err('/retarget/recipe/contactDetection/heightEnter', 'E_RTR_DETECT_VALUE', 'heightEnter 必须 > 0');
    if (!(det.speedEnter > 0)) err('/retarget/recipe/contactDetection/speedEnter', 'E_RTR_DETECT_VALUE', 'speedEnter 必须 > 0');
    if (!(det.speedExit > det.speedEnter)) {
      err('/retarget/recipe/contactDetection/speedExit', 'E_RTR_DETECT_HYSTERESIS', 'speedExit 必须 > speedEnter（进出滞回，docs/16 §3.4）');
    }
    if (!(det.minDurationS > 0)) err('/retarget/recipe/contactDetection/minDurationS', 'E_RTR_DETECT_VALUE', 'minDurationS 必须 > 0（秒制）');
  }

  if (!Array.isArray(r.annotations)) {
    err('/retarget/recipe/annotations', 'E_RTR_ANNOTATIONS', 'annotations 必须是数组');
  } else {
    r.annotations.forEach((a, i) => {
      if (typeof a?.marker !== 'string' || a.marker.length === 0) {
        err(`/retarget/recipe/annotations/${i}/marker`, 'E_RTR_ANNOT_MARKER', '标注缺少 marker id');
      }
      if (a?.mode !== 'support' && a?.mode !== 'roll' && a?.mode !== 'slide') {
        err(`/retarget/recipe/annotations/${i}/mode`, 'E_RTR_ANNOT_MODE', '标注 mode 非法');
      }
      if (typeof a?.startS !== 'number' || typeof a?.endS !== 'number' || !(a.endS > a.startS)) {
        err(`/retarget/recipe/annotations/${i}`, 'E_RTR_ANNOT_SPAN', '标注必须满足 endS > startS（秒）');
      }
    });
  }

  const tol = r.tolerances;
  if (typeof tol !== 'object' || tol === null) {
    err('/retarget/recipe/tolerances', 'E_RTR_TOL', 'tolerances 缺失');
  } else {
    for (const k of ['anchorH', 'slideH', 'penetrationH'] as const) {
      if (!(tol[k] >= 0)) err(`/retarget/recipe/tolerances/${k}`, 'E_RTR_TOL_VALUE', `${k} 必须 ≥ 0`);
    }
    if (!(tol.yawDeg >= 0)) err('/retarget/recipe/tolerances/yawDeg', 'E_RTR_TOL_VALUE', 'yawDeg 必须 ≥ 0');
  }

  const w = r.weights;
  if (typeof w !== 'object' || w === null) {
    err('/retarget/recipe/weights', 'E_RTR_WEIGHTS', 'weights 缺失');
  } else {
    for (const k of ['pose', 'root', 'free', 'anchorAdjust', 'temporal'] as const) {
      if (!(w[k] > 0)) err(`/retarget/recipe/weights/${k}`, 'E_RTR_WEIGHT_VALUE', `${k} 必须 > 0`);
    }
  }

  if (r.algorithmVersion !== RETARGET_ALGORITHM_VERSION) {
    out.push({
      severity: 'warning',
      path: '/retarget/recipe/algorithmVersion',
      code: 'W_RTR_ALGO_STALE',
      message: `配方记录算法 ${String(r.algorithmVersion)}，当前 ${RETARGET_ALGORITHM_VERSION}，结果需重算`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 迁移

export interface RetargetMigrateResult<T> {
  value: T | null;
  diagnostics: MetaDiagnostic[];
}

/**
 * 配方迁移链。当前只有 v1；未来每 +1 版本必须在这里补一条迁移函数 + 一条测试
 * （与 SCHEMA_VERSION 纪律同构，docs/16 §5）。
 * 高于当前版本 → 拒绝（不静默降级）；低于 → 逐步升到当前版本。
 */
export function migrateRetargetRecipe(input: unknown): RetargetMigrateResult<RetargetRecipe> {
  const diagnostics: MetaDiagnostic[] = [];
  if (typeof input !== 'object' || input === null) {
    diagnostics.push({ severity: 'error', path: '', code: 'E_RTR_NOT_OBJECT', message: '配方必须是对象' });
    return { value: null, diagnostics };
  }
  const v = (input as Partial<RetargetRecipe>).schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    diagnostics.push({ severity: 'error', path: '/schemaVersion', code: 'E_RTR_VERSION', message: 'schemaVersion 缺失或非法' });
    return { value: null, diagnostics };
  }
  if (v > RETARGET_META_SCHEMA_VERSION) {
    diagnostics.push({
      severity: 'error',
      path: '/schemaVersion',
      code: 'E_RTR_VERSION_FUTURE',
      message: `配方版本 ${v} 高于支持的 ${RETARGET_META_SCHEMA_VERSION}，拒绝加载`,
    });
    return { value: null, diagnostics };
  }
  // v1 → v1：无变换。后续版本在此追加 if (v === 1) { ...migrate...; }
  diagnostics.push(...validateRetargetRecipe(input));
  return { value: input as RetargetRecipe, diagnostics };
}

// ---------------------------------------------------------------- AssetMeta 挂载块

/**
 * AssetMeta 上的重定向挂载块。可选字段（旧 sidecar 缺省 = null），
 * 因此 META_SCHEMA_VERSION 不因本块的出现而 +1；gen-asset-meta 的
 * merge 语义（只补列出的字段）不受影响。
 */
export interface RetargetAssetMeta {
  /** 本资产的标定。源资产存 SourceCalibration，目标资产存 TargetCalibration */
  calibration: RetargetCalibration | null;
  /** 派生动画资产上的配方；源/目标资产上为 null */
  recipe: RetargetRecipe | null;
}

/** 校验 AssetMeta.retarget 挂载块（路径前缀 /retarget） */
export function validateRetargetAssetBlock(block: unknown): MetaDiagnostic[] {
  const out: MetaDiagnostic[] = [];
  if (typeof block !== 'object' || block === null) {
    out.push({ severity: 'error', path: '/retarget', code: 'E_RT_BLOCK', message: 'retarget 块必须是对象' });
    return out;
  }
  const b = block as Partial<RetargetAssetMeta>;
  if (b.calibration !== null && b.calibration !== undefined) {
    out.push(...validateRetargetCalibration(b.calibration));
  }
  if (b.recipe !== null && b.recipe !== undefined) {
    out.push(...validateRetargetRecipe(b.recipe));
  }
  return out;
}
