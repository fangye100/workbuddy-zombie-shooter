/**
 * 渲染质量档位（P4 M4「规模与降级」，docs/20 §M4）。
 *
 * 为什么要有这个模块：
 *  烘焙调色板是全角色 × 全片段 × 全帧的**显存与 CPU 大户**（一个 24fps 的 3 秒
 *  片段 = 72 帧 × 23 关节 × 16 float）。mobile 档必须能整体降一档，而不是等
 *  200 只压测炸了再临时调参。档位的唯一输入是项目文件里的 `render.targetTier`
 *  （真源 `packages/scene/src/project.ts`），这里只做"档位 → 烘焙参数"的映射。
 *
 * 纯数据 + 纯函数：不 import 任何运行时状态，便于单测与 Node/浏览器同结果。
 */

/** 目标档位。与 `packages/scene/src/project.ts` 的 `TargetTier` 字面量保持一致 */
export type QualityTier = 't0' | 't1' | 't2' | 't3';

/** 烘焙参数：采样率 + 片段数上限（null = 不限制，烘全部片段） */
export interface BakeProfile {
  readonly fps: number;
  readonly maxClips: number | null;
}

/**
 * 档位表。
 *
 * - t0/t1 = mobile 横屏（GDD §已定）：16fps 采样 + 1~2 个片段。
 *   16fps 的依据：mobile 上动画本身就在远处/小尺寸出现，帧率再高也看不出来，
 *   而调色板显存是按 帧数×关节数 线性涨的（docs/20 §3）。
 * - t2/t3 = 桌面/高配：24fps（PALETTE_SAMPLE_FPS）+ 全片段。
 */
export const BAKE_PROFILES: Readonly<Record<QualityTier, BakeProfile>> = {
  t0: { fps: 16, maxClips: 1 },
  t1: { fps: 16, maxClips: 2 },
  t2: { fps: 24, maxClips: null },
  t3: { fps: 24, maxClips: null },
};

/** 拿不到项目档位时的兜底（桌面档——编辑器的默认运行环境） */
export const DEFAULT_BAKE_PROFILE: BakeProfile = BAKE_PROFILES.t2;

/**
 * 档位 → 烘焙参数。未知档位回落到默认档**而不是抛错**：
 * 档位来自数据文件，一个拼错的字符串不该让编辑器起不来（与"行为缺失降级为空
 * 操作"同一条纪律）。
 */
export function bakeProfileForTier(tier: string | null | undefined): BakeProfile {
  if (tier === null || tier === undefined) return DEFAULT_BAKE_PROFILE;
  const p = BAKE_PROFILES[tier as QualityTier];
  return p ?? DEFAULT_BAKE_PROFILE;
}

/** 按上限裁剪片段列表（maxClips 为 null 时原样返回） */
export function limitClips<T>(clips: readonly T[], maxClips: number | null): readonly T[] {
  if (maxClips === null || maxClips >= clips.length) return clips;
  return clips.slice(0, Math.max(0, maxClips));
}
