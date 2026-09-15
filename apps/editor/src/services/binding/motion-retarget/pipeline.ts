/**
 * pipeline.ts —— 算法编排（MR-05，docs/16 §2 数据流）。
 *
 * 只连接 owner：contracts 校验 → 空间映射 → 接触检测 → 锚点 → 姿态基准 →
 * 共享根求解 → 时间平滑 → **重解** → 质量判定。本文件不含任何求解规则。
 * 输入不可变；支持取消（AbortSignal，阶段间检查）；失败不产出半份 clip。
 */

import {
  computeDependencyFingerprint,
  diagnoseSourceMotion,
  diagnoseRetargetRig,
  hasErrors,
  type Quat,
  type RetargetOutcome,
  type RetargetRig,
  type SourceMotion,
  type RetargetEnvironment,
  type ContactSegment,
  type RetargetDiagnostic,
} from './contracts';
import {
  calibrationFingerprint,
  validateRetargetRecipe,
  validateRetargetCalibration,
  type RetargetRecipe,
  type RetargetCalibration,
} from '@aether/scene';
import { quatMul } from '../binding-math';
import { buildSpaceMapping, rootCandidate, contactAnchor, assignContactAnchors } from './space-targets';
import { detectContactSegments } from './contact-segments';
import { markerWorldPositions } from './source-motion';
import type { RotationBaseline } from './rig-calibration';
import { solvePose } from './pose-solver';
import { smoothRootCorrections } from './temporal-solve';
import { buildQualityReport } from './quality-report';

export interface RetargetMotionInput {
  source: SourceMotion;
  targetRig: RetargetRig;
  /** 姿态基准（rig-calibration 计算；BVH 源用 direction 模式） */
  baseline: RotationBaseline;
  recipe: RetargetRecipe;
  environment: RetargetEnvironment;
  /** 源侧标定（h_s 缺省从源首帧 Hips 推断） */
  sourceCalibration: RetargetCalibration | null;
  signal?: AbortSignal;
}

export function retargetMotion(input: RetargetMotionInput): RetargetOutcome {
  const t0 = Date.now();
  const { source, targetRig, baseline, recipe, environment, signal } = input;
  const diagnostics: RetargetDiagnostic[] = [];
  const coverage: string[] = [];
  // R12：依赖身份必须覆盖**实际参与求解**的执行依赖（源标定与基准 pre/post），
  // 而不只是配方元数据——否则同源同配方、不同标定的解会共享缓存身份。
  const dep = computeDependencyFingerprint({
    sourceFingerprint: source.fingerprint,
    targetRig,
    recipeSemantic: {
      recipe,
      sourceCalibration: input.sourceCalibration,
      baseline: { mode: baseline.mode, pre: baseline.pre, post: baseline.post },
    },
    environment,
    algorithmVersion: recipe.algorithmVersion,
  });

  const cancelled = (): boolean =>
    signal?.aborted === true
      ? (diagnostics.push({ severity: 'error', code: 'MRC_CANCELLED', message: '求解被取消，不产出结果' }), true)
      : false;

  // ── 1. 输入守门 ──
  const d1 = diagnoseSourceMotion(source);
  const d2 = diagnoseRetargetRig(targetRig);
  diagnostics.push(...d1, ...d2);
  if (hasErrors([...d1, ...d2]) || cancelled()) return failed(diagnostics, dep);

  // 姿态基准守门（docs/16 §1 钉板：不可达组合拒绝，不允许带着 error 诊断继续）
  if (hasErrors(baseline.diagnostics)) {
    diagnostics.push(...baseline.diagnostics);
    diagnostics.push({
      severity: 'error',
      code: 'MRC_BASELINE_REJECTED',
      message: `姿态基准（${baseline.mode}）自带 error 级诊断，拒绝求解（如 BVH 源 × world-rest 的非法组合）`,
    });
    return failed(diagnostics, dep);
  }
  if (baseline.mode !== recipe.rotationBaseline || baseline.mode !== targetRig.rotationBaseline) {
    diagnostics.push({
      severity: 'error',
      code: 'MRC_BASELINE_MODE_MISMATCH',
      message: `基准模式不一致：baseline=${baseline.mode}，recipe=${recipe.rotationBaseline}，rig=${targetRig.rotationBaseline}`,
    });
    return failed(diagnostics, dep);
  }

  // R13/R14：配方与标定先过校验（含版本/未来版本拒绝），再谈指纹
  const recipeDiags = validateRetargetRecipe(recipe);
  diagnostics.push(...recipeDiags);
  if (recipeDiags.some((d) => d.severity === 'error') || cancelled()) return failed(diagnostics, dep);
  if (input.sourceCalibration !== null) {
    const calDiags = validateRetargetCalibration(input.sourceCalibration);
    diagnostics.push(...calDiags);
    if (hasErrors(calDiags)) return failed(diagnostics, dep);
  }
  // R13：配方显式绑定了标定指纹却没传标定 → 拒绝（不允许首帧估计静默顶替持久标定）
  if (recipe.sourceCalibrationFingerprint !== '' && input.sourceCalibration === null) {
    diagnostics.push({
      severity: 'error',
      code: 'MRC_CAL_MISSING',
      message: '配方绑定了源标定指纹但未提供源标定：拒绝用首帧估计顶替持久标定',
    });
    return failed(diagnostics, dep);
  }
  // 标定指纹核对：配方引用的指纹必须与传入标定一致（MR-01 失效规则）
  if (recipe.sourceCalibrationFingerprint !== '' && input.sourceCalibration !== null) {
    const fp = calibrationFingerprint(input.sourceCalibration);
    if (fp !== recipe.sourceCalibrationFingerprint) {
      diagnostics.push({
        severity: 'error',
        code: 'MRC_CAL_FINGERPRINT_MISMATCH',
        message: '源标定指纹与配方记录不一致：标定已修改，配方需重新绑定或重算',
      });
      return failed(diagnostics, dep);
    }
  }

  // ── 2. 空间映射 + 根候选 ──
  const srcHipsY = source.worldPositions[source.rootBone]?.[1];
  const hS = input.sourceCalibration?.pelvisHeightM ??
    (Number.isFinite(srcHipsY) ? Math.max(0.1, srcHipsY! - environment.sourcePlane.origin[1]) : NaN);
  if (!Number.isFinite(hS)) {
    diagnostics.push({
      severity: 'error',
      code: 'MRC_HS_UNAVAILABLE',
      message: '源骨盆高度不可得（无标定且源根世界位置缺失），拒绝求解',
    });
    return failed(diagnostics, dep);
  }
  if (input.sourceCalibration === null) {
    diagnostics.push({
      severity: 'warning',
      code: 'MRC_HS_DERIVED',
      message: '未提供源标定：h_s 用源首帧骨盆高度估计（首帧蹲姿/腾空会系统性偏移，建议补 SourceCalibration）',
    });
  }
  const { mapping, calibrationErrorM } = buildSpaceMapping(hS, targetRig.pelvisHeightM, {
    mode: recipe.spaceMode,
    oSrc: environment.sourcePlane.origin,
    oTgt: environment.targetPlane.origin,
  });
  if (calibrationErrorM > 1e-6) {
    diagnostics.push({
      severity: 'warning',
      code: 'MRC_SPACE_CAL_ERROR',
      message: `空间标定自洽误差 ${calibrationErrorM.toFixed(6)}m（平面/原点标定可疑）`,
    });
  }
  if (cancelled()) return failed(diagnostics, dep);
  const root = rootCandidate(source, mapping);
  coverage.push('space-mapping');

  // ── 3. 接触检测 + 锚点 ──
  // 足部标记按「挂在 3 骨腿链上的标记」语义筛选（不认骨名字符串）
  const legChainBones = new Set(
    targetRig.chains.filter((ch) => ch.joints.length === 3).flatMap((ch) => [...ch.joints]),
  );
  const footMarkers = Object.values(targetRig.markers).filter((mk) => legChainBones.has(mk.bone));
  if (footMarkers.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'MRC_NO_FOOT_MARKERS',
      message: '目标骨架上没有挂在腿链（3 骨链）上的标记：接触检测为空，只做自由运动适配',
    });
  }
  // R05：源接触检测必须用**源侧**标记——目标标记几何不能反过来定义源的接触状态。
  // 复审 P1：①标定查找按「骨名 + 部位身份（.heel/.ball）」对应，与插入顺序无关；
  // ②没有可靠源标定时**不做世界锁脚**——从动画自身推导足底偏移会把腾空片段伪造成
  // 支撑（首帧 30cm 腾空被消除还报 complete）。正确语义：能力不完整 + 自由运动。
  const srcMarkers = sourceFootMarkerOffsets(input.sourceCalibration, footMarkers);
  let markerTrajs: Array<{ markerId: string; chainId: string | null; positions: Float64Array }> = [];
  if (srcMarkers.size === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'MRC_CONTACT_UNCALIBRATED',
      message: '源标定缺足底标记：接触能力不完整，本次不做世界锁脚（自由运动适配）；SourceCalibration.markers 提供足底标记前不承诺接触',
    });
    coverage.push('contact-uncalibrated');
  } else {
    markerTrajs = footMarkers
      .filter((mk) => srcMarkers.has(markerKeyOf(mk)))
      .map((mk) => ({
        markerId: mk.id,
        chainId: chainIdOfBone(targetRig, mk.bone),
        positions: markerWorldPositions(source, mk.bone, srcMarkers.get(markerKeyOf(mk))!),
      }));
  }
  const detected = detectContactSegments({
    times: source.times,
    markers: markerTrajs,
    plane: environment.sourcePlane,
    hSrcM: hS,
    detection: recipe.contactDetection,
    annotations: recipe.annotations,
    canWorldLock: source.canWorldLock,
  });
  diagnostics.push(...detected.diagnostics);
  const anchors = new Map<string, [number, number, number]>();
  const segmentsWithTimes: ContactSegment[] = detected.segments;
  for (const s of segmentsWithTimes) {
    const traj = markerTrajs.find((m) => m.markerId === s.marker);
    if (traj === undefined) continue;
    const [fs, fe] = frameSpan(source.times, s.startS, s.endS);
    anchors.set(s.id, contactAnchor(traj.positions, fs, fe, mapping, environment.targetPlane));
  }
  const segments = assignContactAnchors(segmentsWithTimes, anchors);
  coverage.push(source.canWorldLock ? 'world-lock' : 'phase-only');
  if (cancelled()) return failed(diagnostics, dep);

  // ── 4. 基准局部旋转 ──
  const baselineLocals = buildBaselineLocals(source, baseline);
  coverage.push(`rotation-baseline:${baseline.mode}`);
  // R01：根骨的完整世界朝向由基准局部给出（BVH 根局部==根世界），
  // fkBaseline 语义是「rootQuat 已含根局部」——直接覆盖根候选的透传朝向，避免二次应用
  for (let f = 0; f < source.times.length; f++) {
    const mapped = baselineLocals[f]![source.rootBone];
    if (mapped !== undefined) {
      root.quats[f * 4] = mapped[0];
      root.quats[f * 4 + 1] = mapped[1];
      root.quats[f * 4 + 2] = mapped[2];
      root.quats[f * 4 + 3] = mapped[3];
    }
  }

  // ── 5. 求解 → 平滑 → 重解（平滑后复算约束）──
  const first = solvePose({
    targetRig,
    sourceMotion: source,
    baselineLocals,
    rootPositions: root.positions,
    rootQuats: root.quats,
    segments,
    tolerances: recipe.tolerances,
  });
  diagnostics.push(...first.diagnostics);
  const smoothed = smoothRootCorrections(source.times, first.rootCorrections, {
    transitionS: 0.25,
  });
  const reRoot = new Float64Array(root.positions.length);
  for (let k = 0; k < reRoot.length; k++) {
    reRoot[k] = root.positions[k]! + smoothed.corrections[k]!;
  }
  const second = solvePose({
    targetRig,
    sourceMotion: source,
    baselineLocals,
    rootPositions: reRoot,
    rootQuats: root.quats,
    segments,
    tolerances: recipe.tolerances,
  });
  if (cancelled()) return failed(diagnostics, dep);

  // ── 6. 质量与状态 ──
  const quality = buildQualityReport({
    rig: targetRig,
    frames: second.frames,
    segments,
    anchorDeviations: second.anchorDeviations,
    reachResidualsM: second.reachResidualsM,
    rootCorrections: smoothed.corrections,
    switchJumpMps: smoothed.maxJumpMps,
    iterations: first.iterations + second.iterations,
    converged: first.converged && second.converged,
    durationMs: Date.now() - t0,
    tolerances: recipe.tolerances,
  });
  diagnostics.push(...second.diagnostics);
  for (const v of quality.violations) {
    diagnostics.push({
      severity: 'warning',
      code: v.code,
      message: `${v.message}：${v.valueM.toFixed(5)}m > 限 ${v.limitM.toFixed(5)}m`,
    });
  }
  const status = quality.status === 'failed' ? 'failed' : quality.status;
  return {
    status,
    clip: {
      times: source.times.slice(),
      frames: second.frames,
      skeletonFingerprint: targetRig.fingerprint,
    },
    diagnostics,
    metrics: quality.metrics,
    coverage,
    dependencyFingerprint: dep,
  };
}

// ---------------------------------------------------------------- 内部

/** 目标足标记 → 源侧同名同部位标记的键（HumanIK 骨名跨侧一致） */
function markerKeyOf(mk: { id: string; bone: string }): string {
  const kind = mk.id.endsWith('.heel') ? 'heel' : 'ball';
  return `${mk.bone}:${kind}`;
}

/**
 * R05/复审 P1：源侧足底标记**只认显式标定**。
 * 按「骨名 + .heel/.ball 身份后缀」对应——同骨两个标记交换插入顺序不影响结果；
 * 没有匹配条目就不返回偏移（调用方据此判定接触能力不完整），
 * 绝不从动画自身推导足底偏移（那会把腾空片段伪造成支撑）。
 */
function sourceFootMarkerOffsets(
  cal: RetargetCalibration | null,
  footMarkers: ReadonlyArray<{ id: string; bone: string }>,
): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  if (cal === null) return out;
  for (const mk of footMarkers) {
    const key = markerKeyOf(mk);
    const kind = key.endsWith(':heel') ? 'heel' : 'ball';
    const entry = Object.entries(cal.markers).find(
      ([id, e]) => e.bone === mk.bone && id.endsWith(`.${kind}`),
    );
    if (entry !== undefined) {
      out.set(key, [entry[1].offset[0], entry[1].offset[1], entry[1].offset[2]]);
    }
  }
  return out;
}

function chainIdOfBone(rig: RetargetRig, bone: string): string | null {
  for (const ch of rig.chains) {
    if (ch.joints.includes(bone)) return ch.id;
  }
  return null;
}

function frameSpan(times: Float64Array, startS: number, endS: number): [number, number] {
  let s = 0;
  let e = times.length - 1;
  for (let f = 0; f < times.length; f++) {
    if (Math.abs(times[f]! - startS) < Math.abs(times[s]! - startS)) s = f;
    if (Math.abs(times[f]! - endS) < Math.abs(times[e]! - endS)) e = f;
  }
  return [Math.min(s, e), Math.max(s, e)];
}

/** baseline_local(b) = pre · R_src_local(b) · post（逐帧，按骨名索引） */
function buildBaselineLocals(source: SourceMotion, baseline: RotationBaseline): Record<string, Quat>[] {
  const frames = source.times.length;
  const out: Record<string, Quat>[] = [];
  for (let f = 0; f < frames; f++) {
    const per: Record<string, Quat> = {};
    for (const bone of source.boneNames) {
      const lr = source.localRotations[bone];
      const pre = baseline.pre[bone] ?? [0, 0, 0, 1];
      const post = baseline.post[bone] ?? [0, 0, 0, 1];
      if (lr === undefined) {
        per[bone] = quatMul(pre, post);
      } else {
        const r: Quat = [lr[f * 4]!, lr[f * 4 + 1]!, lr[f * 4 + 2]!, lr[f * 4 + 3]!];
        per[bone] = quatMul(quatMul(pre, r), post);
      }
    }
    out.push(per);
  }
  return out;
}

function failed(diagnostics: RetargetDiagnostic[], dep: string): RetargetOutcome {
  return {
    status: 'failed',
    clip: null,
    diagnostics,
    metrics: null,
    coverage: [],
    dependencyFingerprint: dep,
  };
}
