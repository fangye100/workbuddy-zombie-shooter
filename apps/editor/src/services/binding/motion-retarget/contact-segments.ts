/**
 * contact-segments.ts —— 足部接触语义（MR-03）。
 *
 * docs/16 §3.4 的落地：无动画师时，用「标记离面高度 + 世界速度」的滞回状态机
 * 生成接触段。阈值按 h_s 归一、速度用**实际秒差**（不固定帧数）；最短持续
 * 时间以秒计。有意滑动/滚动**只能来自标注**（自动检测不猜意图）。
 *
 * 明确不做：
 *  - 不逐帧把最低骨/最低脚归零（保留跳跃与腾空，A11）；
 *  - 低高度 ≠ 静止支撑（速度必须同时低）；
 *  - in-place 源仍可检测（相位信息），但不承诺世界锁脚（诊断警告）。
 */

import type { ContactAnnotation, ContactDetectionSettings } from '@aether/scene';
import type { ContactSegment, RetargetDiagnostic } from './contracts';
import type { Plane } from './space-targets';
import { signedPlaneDistance } from './space-targets';

export interface MarkerTrajectory {
  markerId: string;
  /** 关联求解链 id（如 'LeftLeg'）；可为 null */
  chainId: string | null;
  /** 世界轨迹 (frames × 3)，米，规范世界系 */
  positions: Float64Array;
}

export interface DetectContactsInput {
  times: Float64Array;
  markers: MarkerTrajectory[];
  /** 源支撑平面 */
  plane: Plane;
  /** h_s（米）：阈值归一基准 */
  hSrcM: number;
  detection: ContactDetectionSettings;
  /** 手工标注（覆盖自动检测） */
  annotations: ContactAnnotation[];
  /** 源世界锁脚能力（in-place 素材为 false） */
  canWorldLock: boolean;
}

export interface DetectContactsResult {
  segments: ContactSegment[];
  diagnostics: RetargetDiagnostic[];
}

/** 退出高度 = 进入高度的 2 倍（高度滞回；速度滞回用 speedExit > speedEnter） */
function exitHeightM(det: ContactDetectionSettings, hSrcM: number): number {
  return det.heightEnter * 2 * hSrcM;
}

export function detectContactSegments(input: DetectContactsInput): DetectContactsResult {
  const diagnostics: RetargetDiagnostic[] = [];
  const segments: ContactSegment[] = [];
  const { times, markers, plane, hSrcM, detection, annotations, canWorldLock } = input;

  if (!canWorldLock) {
    diagnostics.push({
      severity: 'warning',
      code: 'MRC_NO_WORLD_LOCK',
      message: '源缺可信世界轨迹：接触段仍检测（相位参考），但世界锁脚不承诺，结果应为 partial',
    });
  }

  // 标注按 marker 分组；存在标注的 marker 不再自动检测（标注覆盖，不叠加）
  const annotated = new Map<string, ContactAnnotation[]>();
  for (const a of annotations) {
    if (!markers.some((m) => m.markerId === a.marker)) {
      diagnostics.push({
        severity: 'warning',
        code: 'MRC_ANNOT_UNKNOWN_MARKER',
        message: `标注引用了不存在的标记 ${a.marker}，忽略`,
        constraint: a.marker,
      });
      continue;
    }
    const list = annotated.get(a.marker) ?? [];
    list.push(a);
    annotated.set(a.marker, list);
  }

  for (const m of markers) {
    const notes = annotated.get(m.markerId);
    if (notes !== undefined) {
      for (const a of notes) {
        segments.push({
          id: `${a.marker}@${a.startS.toFixed(3)}s`,
          marker: a.marker,
          chainId: m.chainId,
          startS: a.startS,
          endS: a.endS,
          mode: a.mode,
          space: 'world',
          origin: 'annotated',
          confidence: 1,
          anchor: null,
          pivot: null,
        });
      }
      continue;
    }
    segments.push(...detectOneMarker(times, m, plane, hSrcM, detection, diagnostics));
  }

  segments.sort((a, b) => a.startS - b.startS);
  return { segments, diagnostics };
}

function detectOneMarker(
  times: Float64Array,
  m: MarkerTrajectory,
  plane: Plane,
  hSrcM: number,
  det: ContactDetectionSettings,
  diagnostics: RetargetDiagnostic[],
): ContactSegment[] {
  const frames = times.length;
  const pos = m.positions;
  const heightEnterM = det.heightEnter * hSrcM;
  const speedEnterM = det.speedEnter * hSrcM;
  const speedExitM = det.speedExit * hSrcM;
  const heightExitM = exitHeightM(det, hSrcM);

  // 逐帧高度与世界速度（秒差；首帧速度取第二帧的）
  const d = new Float64Array(frames);
  const v = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    d[f] = signedPlaneDistance([pos[f * 3]!, pos[f * 3 + 1]!, pos[f * 3 + 2]!], plane);
    if (f === 0) continue;
    const dt = Math.max(1e-9, times[f]! - times[f - 1]!);
    const dx = pos[f * 3]! - pos[(f - 1) * 3]!;
    const dy = pos[f * 3 + 1]! - pos[(f - 1) * 3 + 1]!;
    const dz = pos[f * 3 + 2]! - pos[(f - 1) * 3 + 2]!;
    v[f] = Math.hypot(dx, dy, dz) / dt;
  }
  v[0] = v[1] ?? 0;

  const out: ContactSegment[] = [];
  let start = -1;
  let worstSpeed = 0;
  let maxHeight = -Infinity;
  for (let f = 0; f < frames; f++) {
    const inContact = start >= 0;
    const shouldEnter = !inContact && d[f]! <= heightEnterM && v[f]! <= speedEnterM;
    const shouldExit = inContact && (v[f]! > speedExitM || d[f]! > heightExitM);
    if (shouldEnter) {
      start = f;
      worstSpeed = v[f]!;
      maxHeight = d[f]!;
    } else if (inContact && shouldExit) {
      // 退出过渡帧不计入段内统计（它的速度/高度正是“离开”本身）
      pushSegment(out, times, m, start, f - 1, det, hSrcM, worstSpeed, maxHeight, diagnostics);
      start = -1;
    } else if (inContact) {
      worstSpeed = Math.max(worstSpeed, v[f]!);
      maxHeight = Math.max(maxHeight, d[f]!);
      if (f === frames - 1) {
        pushSegment(out, times, m, start, f, det, hSrcM, worstSpeed, maxHeight, diagnostics);
        start = -1;
      }
    }
  }
  return out;
}

function pushSegment(
  out: ContactSegment[],
  times: Float64Array,
  m: MarkerTrajectory,
  startF: number,
  endF: number,
  det: ContactDetectionSettings,
  hSrcM: number,
  worstSpeed: number,
  maxHeight: number,
  diagnostics: RetargetDiagnostic[],
): void {
  const startS = times[startF]!;
  const endS = times[endF]!;
  if (endS - startS < det.minDurationS) {
    diagnostics.push({
      severity: 'info',
      code: 'MRC_SEGMENT_TOO_SHORT',
      message: `${m.markerId} 的候选接触段 [${startS.toFixed(3)}s, ${endS.toFixed(3)}s] 短于最短持续 ${det.minDurationS}s，丢弃`,
      constraint: m.markerId,
    });
    return;
  }
  // 置信度（0..1，clean > noisy）：速度余量主导，离面贴合加分。
  // 两个量都在归一化域（除以各自阈值）计算，与帧率/角色尺寸无关。
  const speedExitM = det.speedExit * hSrcM;
  const heightExitM = det.heightEnter * 2 * hSrcM;
  const speedTerm = clamp01(1 - worstSpeed / speedExitM);
  const heightTerm = maxHeight <= 0 ? 1 : clamp01(1 - maxHeight / heightExitM);
  const conf = clamp01(0.5 + 0.5 * speedTerm * (0.5 + 0.5 * heightTerm));
  out.push({
    id: `${m.markerId}@${startS.toFixed(3)}s`,
    marker: m.markerId,
    chainId: m.chainId,
    startS,
    endS,
    mode: 'support',
    space: 'world',
    origin: 'detected',
    confidence: conf,
    anchor: null,
    pivot: null,
  });
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

