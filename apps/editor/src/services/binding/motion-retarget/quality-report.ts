/**
 * quality-report.ts —— 质量指标与 complete/partial/failed 判定（MR-05）。
 *
 * 口径（docs/16 §5 报告字段 / §8）：位置残差按 h_t 归一比较；滑步报
 * 「整段最大锚点偏差 + 累计切向路程」，不只报最大单帧位移。
 */

import type {
  ContactSegment,
  RetargetMetrics,
  RetargetRig,
  WorldPoseFrame,
} from './contracts';
import { rotateVec3 } from './two-bone-solver';
import { signedPlaneDistance } from './space-targets';
import type { RetargetRecipeTolerances } from '@aether/scene';

export interface QualityInput {
  rig: RetargetRig;
  frames: readonly WorldPoseFrame[];
  segments: readonly ContactSegment[];
  anchorDeviations: ReadonlyArray<{ segmentId: string; marker: string; maxM: number }>;
  reachResidualsM: { inner: number; outer: number };
  rootCorrections: Float64Array;
  switchJumpMps: number;
  iterations: number;
  converged: boolean;
  durationMs: number;
  tolerances: RetargetRecipeTolerances;
}

export interface QualityOutcome {
  metrics: RetargetMetrics;
  status: 'complete' | 'partial' | 'failed';
  violations: Array<{ code: string; message: string; valueM: number; limitM: number }>;
}

function len3(a: readonly number[]): number {
  return Math.hypot(a[0]!, a[1]!, a[2]!);
}
function sub3(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function tangential(v: readonly number[], normal: readonly number[]): [number, number, number] {
  const d = v[0]! * normal[0]! + v[1]! * normal[1]! + v[2]! * normal[2]!;
  return [v[0]! - d * normal[0]!, v[1]! - d * normal[1]!, v[2]! - d * normal[2]!];
}

/** 标记在某帧的世界位置（从解算帧 + rig 标记读回） */
export function markerWorldAt(
  rig: RetargetRig,
  frame: WorldPoseFrame,
  markerId: string,
): [number, number, number] | null {
  const mk = rig.markers[markerId];
  if (mk === undefined) return null;
  const bone = frame.bonePos[mk.bone];
  const q = frame.boneQuat[mk.bone];
  if (bone === undefined || q === undefined) return null;
  const off = rotateVec3(q, mk.offset);
  return [bone[0] + off[0], bone[1] + off[1], bone[2] + off[2]];
}

export function buildQualityReport(input: QualityInput): QualityOutcome {
  const { rig, frames, segments, tolerances } = input;
  const hT = rig.pelvisHeightM;
  const plane = rig.supportPlane;

  // 锚点偏差（沿用求解器逐段值）
  let maxAnchor = 0;
  for (const d of input.anchorDeviations) maxAnchor = Math.max(maxAnchor, d.maxM);

  // 累计切向滑动 + 穿透 + 摆动净空
  let cumulativeSlide = 0;
  let maxPenetration = 0;
  let minSwingClearance = Infinity;
  let maxRootCorrection = 0;
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f]!;
    maxRootCorrection = Math.max(
      maxRootCorrection,
      Math.hypot(input.rootCorrections[f * 3]!, input.rootCorrections[f * 3 + 1]!, input.rootCorrections[f * 3 + 2]!),
    );
    for (const [id, mk] of Object.entries(rig.markers)) {
      const world = markerWorldAt(rig, fr, id);
      if (world === null) continue;
      void mk;
      const seg = segments.find((s) => s.marker === id && fr.t >= s.startS - 1e-9 && fr.t <= s.endS + 1e-9 && s.anchor !== null);
      if (seg !== undefined) {
        const dev = tangential(sub3(world, seg.anchor!), plane.normal);
        cumulativeSlide += len3(dev);
        const pen = -signedPlaneDistance(world, plane);
        maxPenetration = Math.max(maxPenetration, pen);
      } else {
        const clearance = signedPlaneDistance(world, plane);
        minSwingClearance = Math.min(minSwingClearance, clearance);
      }
    }
  }
  if (!Number.isFinite(minSwingClearance)) minSwingClearance = Infinity;

  const metrics: RetargetMetrics = {
    maxAnchorDeviationM: maxAnchor,
    cumulativeSlideM: cumulativeSlide,
    maxPenetrationM: maxPenetration,
    minSwingClearanceM: Number.isFinite(minSwingClearance) ? minSwingClearance : 0,
    maxReachResidualInnerM: input.reachResidualsM.inner,
    maxReachResidualOuterM: input.reachResidualsM.outer,
    maxRootCorrectionM: maxRootCorrection,
    maxSwitchJumpMps: input.switchJumpMps,
    jointLimitViolations: 0,
    iterations: input.iterations,
    converged: input.converged,
    durationMs: input.durationMs,
    peakMemoryEstMb: estimateMemoryMb(frames, rig),
  };

  // 判定：硬接触超标 → failed 的候选（pipeline 可因能力缺口降为 partial）
  const violations: QualityOutcome['violations'] = [];
  const check = (code: string, message: string, valueM: number, limitM: number): void => {
    if (valueM > limitM) violations.push({ code, message, valueM, limitM });
  };
  check('MRQ_ANCHOR', '锁定段锚点偏差超限', maxAnchor, tolerances.anchorH * hT);
  check('MRQ_SLIDE', '累计切向滑动超限', cumulativeSlide, tolerances.slideH * hT);
  check('MRQ_PENETRATION', '穿透超限', maxPenetration, tolerances.penetrationH * hT);
  check('MRQ_REACH_OUT', '外侧不可达残差', metrics.maxReachResidualOuterM, tolerances.anchorH * hT);
  check('MRQ_SWITCH_JUMP', '修正速度跳变超限', input.switchJumpMps, 0.1 * hT);

  const status: 'complete' | 'partial' | 'failed' = violations.length === 0 ? 'complete' : 'partial';
  return { metrics, status, violations };
}

function estimateMemoryMb(frames: readonly WorldPoseFrame[], rig: RetargetRig): number {
  const perFrameBytes = rig.order.length * (3 + 4) * 8 + 7 * 8;
  return (frames.length * perFrameBytes) / (1024 * 1024);
}
