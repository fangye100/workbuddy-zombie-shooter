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
import { calibrationFingerprint, type RetargetRecipe, type RetargetCalibration } from '@aether/scene';
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
  const dep = computeDependencyFingerprint({
    sourceFingerprint: source.fingerprint,
    targetRig,
    recipeSemantic: recipe,
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
  const hS =
    input.sourceCalibration?.pelvisHeightM ??
    Math.max(0.1, source.worldPositions[source.rootBone]?.[1]! - environment.sourcePlane.origin[1]);
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
  const footMarkers = Object.values(targetRig.markers).filter((mk) => mk.bone.includes('Foot'));
  const markerTrajs = footMarkers.map((mk) => ({
    markerId: mk.id,
    chainId: chainIdOfBone(targetRig, mk.bone),
    positions: markerWorldPositions(source, mk.bone, mk.offset),
  }));
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
    converged: true,
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
