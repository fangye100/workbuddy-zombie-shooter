/**
 * contact-segments.test.ts —— 接触检测测试（MR-03，验收 A04/A11 归此）。
 *
 * 合成轨迹全部由连续时间函数采样生成（不依赖被测实现的帧率假设），
 * 边界/模式/置信度断言手写。
 */
import { describe, it, expect } from 'vitest';
import { detectContactSegments, type MarkerTrajectory } from '../../src/services/binding/motion-retarget/contact-segments';
import { defaultContactDetection } from '@aether/scene';
import type { ContactAnnotation } from '@aether/scene';

const PLANE = { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number] };
const H = 1.0; // h_s（米）——阈值即绝对值
const DET = defaultContactDetection(); // heightEnter .02, speedEnter .1, speedExit .25, minDur .08s

describe('annotation execution intervals', () => {
  const times = new Float64Array([0, 0.1, 0.2, 0.3]);
  const marker: MarkerTrajectory = {
    markerId: 'LeftFoot.ball', chainId: 'LeftLeg', positions: new Float64Array(12),
  };
  const detect = (annotations: ContactAnnotation[]) => detectContactSegments({
    times, markers: [marker], plane: PLANE, hSrcM: H, detection: DET, annotations, canWorldLock: true,
  });

  it.each([[10, 11], [-0.1, 0.2], [0.2, 0.4], [0.01, 0.02]])(
    'rejects unsupported interval [%s,%s] without inventing an automatic segment', (startS, endS) => {
      const out = detect([{ marker: marker.markerId, startS, endS, mode: 'support' }]);
      expect(out.segments).toEqual([]);
      expect(out.diagnostics.map((d) => d.code)).toContain('MRC_ANNOT_TIME_UNSUPPORTED');
    },
  );

  it('keeps valid requested seconds and independent identities without millisecond rounding', () => {
    const out = detect([
      { marker: marker.markerId, startS: 0.0001, endS: 0.1, mode: 'support' },
      { marker: marker.markerId, startS: 0.0002, endS: 0.2, mode: 'support' },
    ]);
    expect(out.diagnostics).toEqual([]);
    expect(out.segments.map((sg) => sg.startS)).toEqual([0.0001, 0.0002]);
    expect(new Set(out.segments.map((sg) => sg.id)).size).toBe(2);
  });
});

function timesAt(fps: number, seconds: number): Float64Array {
  const n = Math.round(seconds * fps) + 1;
  const t = new Float64Array(n);
  for (let f = 0; f < n; f++) t[f] = f / fps;
  return t;
}

/** 走路脚标记：0..0.3s 摆动落下，0.3..1.3s 支撑（世界固定），1.3..1.6s 抬起 */
function walkFootMarker(fps: number, opts: { noise?: number; jump?: boolean } = {}): MarkerTrajectory {
  const t = timesAt(fps, 1.6);
  const p = new Float64Array(t.length * 3);
  for (let f = 0; f < t.length; f++) {
    const time = t[f]!;
    let x: number;
    let y: number;
    if (time < 0.3) {
      // 摆动：从 x=0.2 高 0.15 落到 x=0, y=0
      const k = time / 0.3;
      x = 0.2 * (1 - k);
      y = 0.15 * Math.sin(Math.PI * Math.min(1, k * 1.2));
    } else if (time < 1.3) {
      // 支撑：世界固定 + 微噪声
      x = 0;
      y = 0;
    } else {
      const k = (time - 1.3) / 0.3;
      x = 0.25 * k;
      y = 0.12 * Math.sin(Math.PI * k);
    }
    if (opts.jump && time >= 0.6 && time < 0.9) {
      y += 0.5 * Math.sin(Math.PI * ((time - 0.6) / 0.3)); // 中途跳起 0.5 m
      x += 0.3 * ((time - 0.6) / 0.3);
    }
    if (opts.noise) y += opts.noise * Math.sin(2 * Math.PI * 3 * time); // 平滑低频抖动
    p[f * 3] = x;
    p[f * 3 + 1] = y;
    p[f * 3 + 2] = 0;
  }
  return { markerId: 'LeftFoot.ball', chainId: 'LeftLeg', positions: p };
}

// ───────────────────────── 基本检测 ─────────────────────────

describe('detectContactSegments · 支撑段', () => {
  it('世界固定段被识别为一段 support，边界在 [0.3, 1.3]s 附近', () => {
    const fps = 60;
    const { segments, diagnostics } = detectContactSegments({
      times: timesAt(fps, 1.6),
      markers: [walkFootMarker(fps)],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: [],
      canWorldLock: true,
    });
    expect(diagnostics).toEqual([]);
    expect(segments.length).toBe(1);
    const s = segments[0]!;
    expect(s.mode).toBe('support');
    expect(s.origin).toBe('detected');
    expect(s.marker).toBe('LeftFoot.ball');
    expect(s.chainId).toBe('LeftLeg');
    // 进入时刻：首次 y ≤ 0.02 且速度低（≈0.3s，卡一个采样间隔）
    expect(Math.abs(s.startS - 0.3)).toBeLessThanOrEqual(1 / fps + 1e-9);
    expect(Math.abs(s.endS - 1.3)).toBeLessThanOrEqual(1 / fps + 1e-9);
  });

  it('噪声不产生碎段（2mm 抖动在阈值内）', () => {
    const fps = 60;
    const { segments } = detectContactSegments({
      times: timesAt(fps, 1.6),
      markers: [walkFootMarker(fps, { noise: 0.002 })],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: [],
      canWorldLock: true,
    });
    expect(segments.length).toBe(1);
  });
});

// ───────────────────────── A04：帧率无关 ─────────────────────────

describe('A04：30/60/120Hz 秒制边界一致', () => {
  for (const fps of [30, 60, 120]) {
    it(`fps=${fps}：边界偏差 ≤ 一个采样间隔`, () => {
      const { segments } = detectContactSegments({
        times: timesAt(fps, 1.6),
        markers: [walkFootMarker(fps)],
        plane: PLANE,
        hSrcM: H,
        detection: DET,
        annotations: [],
        canWorldLock: true,
      });
      expect(segments.length).toBe(1);
      expect(Math.abs(segments[0]!.startS - 0.3)).toBeLessThanOrEqual(1 / fps + 1e-9);
      expect(Math.abs(segments[0]!.endS - 1.3)).toBeLessThanOrEqual(1 / fps + 1e-9);
    });
  }

  it('三种帧率检测出的段数一致（都是 1）', () => {
    for (const fps of [30, 60, 120]) {
      const { segments } = detectContactSegments({
        times: timesAt(fps, 1.6),
        markers: [walkFootMarker(fps)],
        plane: PLANE,
        hSrcM: H,
        detection: DET,
        annotations: [],
        canWorldLock: true,
      });
      expect(segments.length).toBe(1);
    }
  });
});

// ───────────────────────── A11：跳跃不贴地 ─────────────────────────

describe('A11：跳跃不被逐帧贴地', () => {
  it('支撑段中途跳起 0.5m → 接触被切开/终止，腾空帧不判接触', () => {
    const fps = 60;
    const { segments } = detectContactSegments({
      times: timesAt(fps, 1.6),
      markers: [walkFootMarker(fps, { jump: true })],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: [],
      canWorldLock: true,
    });
    // 0.3..0.6 支撑、0.6..0.9 腾空（高度 0.5m ≫ 阈值）、0.9..1.3 落回支撑
    expect(segments.length).toBe(2);
    const first = segments[0]!;
    const second = segments[1]!;
    expect(first.endS).toBeLessThan(0.62);
    expect(second.startS).toBeGreaterThan(0.85);
    expect(second.endS).toBeCloseTo(1.3, 1);
    // 腾空窗口内没有任何段覆盖 0.75s（跳跃不被贴地）
    for (const s of segments) {
      const covers = s.startS <= 0.75 && s.endS >= 0.75;
      expect(covers).toBe(false);
    }
  });
});

// ───────────────────────── 滞回与最短持续 ─────────────────────────

describe('滞回与最短持续', () => {
  it('速度在 enter 与 exit 阈值之间不抖动（滞回）', () => {
    // 60fps、2 秒：全程贴地，速度 0.15 h/s（> enter 0.1，< exit 0.25）
    const fps = 60;
    const t = timesAt(fps, 2);
    const p = new Float64Array(t.length * 3);
    for (let f = 0; f < t.length; f++) {
      p[f * 3] = 0.15 * t[f]!;
      p[f * 3 + 1] = 0;
      p[f * 3 + 2] = 0;
    }
    const { segments } = detectContactSegments({
      times: t,
      markers: [{ markerId: 'm', chainId: null, positions: p }],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: [],
      canWorldLock: true,
    });
    // 首帧速度即 0.15 > speedEnter → 不进入；全程无接触（有意滑动语义，不误锁）
    expect(segments.length).toBe(0);
  });

  it('短于 minDurationS 的候选被丢弃并出 info 诊断', () => {
    // 贴地静止 0.2..0.25s（含端点，入口帧速度为 0）@60fps ≈ 0.033s < 0.08s
    const fps = 60;
    const t = timesAt(fps, 0.5);
    const p = new Float64Array(t.length * 3);
    for (let f = 0; f < t.length; f++) {
      const time = t[f]!;
      const planted = time >= 0.2 && time <= 0.25;
      p[f * 3 + 1] = planted ? 0 : 0.3;
    }
    const { segments, diagnostics } = detectContactSegments({
      times: t,
      markers: [{ markerId: 'm', chainId: null, positions: p }],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: [],
      canWorldLock: true,
    });
    expect(segments.length).toBe(0);
    expect(diagnostics.some((d) => d.code === 'MRC_SEGMENT_TOO_SHORT')).toBe(true);
  });
});

// ───────────────────────── 标注覆盖 ─────────────────────────

describe('标注覆盖', () => {
  it('slide 标注生成 slide 段（自动不猜滑动意图）；同 marker 的自动检测被取代', () => {
    const fps = 60;
    const ann: ContactAnnotation[] = [
      { marker: 'LeftFoot.ball', startS: 0.35, endS: 1.25, mode: 'slide' },
    ];
    const { segments } = detectContactSegments({
      times: timesAt(fps, 1.6),
      markers: [walkFootMarker(fps)],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: ann,
      canWorldLock: true,
    });
    expect(segments.length).toBe(1);
    expect(segments[0]!.mode).toBe('slide');
    expect(segments[0]!.origin).toBe('annotated');
    expect(segments[0]!.confidence).toBe(1);
    expect(segments[0]!.startS).toBe(0.35);
  });

  it('引用不存在标记的标注 → 警告并忽略', () => {
    const fps = 60;
    const { segments, diagnostics } = detectContactSegments({
      times: timesAt(fps, 1.6),
      markers: [walkFootMarker(fps)],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: [{ marker: 'Ghost.heel', startS: 0, endS: 1, mode: 'support' }],
      canWorldLock: true,
    });
    expect(diagnostics.some((d) => d.code === 'MRC_ANNOT_UNKNOWN_MARKER')).toBe(true);
    // 自动检测照常（标注没吃掉任何东西）
    expect(segments.length).toBe(1);
    expect(segments[0]!.origin).toBe('detected');
  });
});

// ───────────────────────── 能力边界 ─────────────────────────

describe('能力边界', () => {
  it('in-place 源（canWorldLock=false）：仍检测，但产警告、结果应 partial', () => {
    const fps = 60;
    const { segments, diagnostics } = detectContactSegments({
      times: timesAt(fps, 1.6),
      markers: [walkFootMarker(fps)],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: [],
      canWorldLock: false,
    });
    expect(segments.length).toBe(1);
    expect(diagnostics.some((d) => d.code === 'MRC_NO_WORLD_LOCK')).toBe(true);
  });

  it('干净接触的置信度高于噪声接触（单调性）', () => {
    const fps = 60;
    const clean = detectContactSegments({
      times: timesAt(fps, 1.6),
      markers: [walkFootMarker(fps)],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: [],
      canWorldLock: true,
    });
    const noisy = detectContactSegments({
      times: timesAt(fps, 1.6),
      markers: [walkFootMarker(fps, { noise: 0.004 })],
      plane: PLANE,
      hSrcM: H,
      detection: DET,
      annotations: [],
      canWorldLock: true,
    });
    expect(clean.segments[0]!.confidence).toBeGreaterThan(noisy.segments[0]!.confidence);
  });
});
