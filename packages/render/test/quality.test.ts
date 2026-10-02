import { describe, it, expect } from 'vitest';
import {
  BAKE_PROFILES,
  DEFAULT_BAKE_PROFILE,
  bakeProfileForTier,
  limitClips,
  type QualityTier,
} from '../src/quality';
import { PALETTE_SAMPLE_FPS } from '../src/pose-palette';

/**
 * 烘焙档位（P4 M4，docs/20 §M4）。
 *
 * 这些断言锁的是**降级契约**：mobile 档必须真的比桌面档省（采样率更低、片段更少），
 * 否则档位就成了摆设 —— 200 只压测时该炸还是炸。
 */
describe('BAKE_PROFILES · 档位契约', () => {
  it('mobile 档（t0/t1）采样率低于桌面档（t2/t3）', () => {
    expect(BAKE_PROFILES.t0.fps).toBeLessThan(BAKE_PROFILES.t2.fps);
    expect(BAKE_PROFILES.t1.fps).toBeLessThan(BAKE_PROFILES.t3.fps);
  });

  it('mobile 档限制片段数，桌面档不限制', () => {
    expect(BAKE_PROFILES.t0.maxClips).toBe(1);
    expect(BAKE_PROFILES.t1.maxClips).toBe(2);
    expect(BAKE_PROFILES.t2.maxClips).toBeNull();
    expect(BAKE_PROFILES.t3.maxClips).toBeNull();
  });

  it('桌面档采样率 = 调色板默认采样率（不引入第二真源）', () => {
    expect(BAKE_PROFILES.t2.fps).toBe(PALETTE_SAMPLE_FPS);
    expect(BAKE_PROFILES.t3.fps).toBe(PALETTE_SAMPLE_FPS);
  });

  it('每个档位都是正整数采样率（0 会让帧数退化成 1）', () => {
    for (const t of ['t0', 't1', 't2', 't3'] as QualityTier[]) {
      expect(BAKE_PROFILES[t].fps).toBeGreaterThan(0);
      expect(Number.isInteger(BAKE_PROFILES[t].fps)).toBe(true);
    }
  });
});

describe('bakeProfileForTier · 数据兜底', () => {
  it('已知档位逐个命中', () => {
    expect(bakeProfileForTier('t0')).toEqual({ fps: 16, maxClips: 1 });
    expect(bakeProfileForTier('t3')).toEqual({ fps: 24, maxClips: null });
  });

  it('null / undefined / 未知字符串 → 回落默认档（数据拼错不该让编辑器起不来）', () => {
    expect(bakeProfileForTier(null)).toBe(DEFAULT_BAKE_PROFILE);
    expect(bakeProfileForTier(undefined)).toBe(DEFAULT_BAKE_PROFILE);
    expect(bakeProfileForTier('t9')).toBe(DEFAULT_BAKE_PROFILE);
    expect(bakeProfileForTier('')).toBe(DEFAULT_BAKE_PROFILE);
  });
});

describe('limitClips · 片段裁剪', () => {
  const clips = ['idle', 'walk', 'attack', 'die'];

  it('null = 不裁剪', () => {
    expect(limitClips(clips, null)).toEqual(clips);
  });

  it('上限小于长度 → 取前 N 个（顺序稳定，不能随机挑）', () => {
    expect(limitClips(clips, 2)).toEqual(['idle', 'walk']);
    expect(limitClips(clips, 1)).toEqual(['idle']);
  });

  it('上限 ≥ 长度 → 原样返回（不补空位）', () => {
    expect(limitClips(clips, 4)).toEqual(clips);
    expect(limitClips(clips, 99)).toEqual(clips);
  });

  it('上限 ≤ 0 → 空数组（不越界、不抛）', () => {
    expect(limitClips(clips, 0)).toEqual([]);
    expect(limitClips(clips, -3)).toEqual([]);
  });
});
