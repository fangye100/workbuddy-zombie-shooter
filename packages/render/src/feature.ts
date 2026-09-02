/**
 * L3 — 渲染特性插件接口。
 * 每个 Pass（阴影 / AO / SSR / TAA / 后处理…）都实现为独立 RenderFeature，
 * 按设备能力门控装配，2D 项目可以只装配两三个。
 */

import type { GfxDevice, CapabilityTier } from '../../gfx/src/device';
import type { FrameGraph } from '../../framegraph/src/graph';

/** 一帧的渲染快照：渲染层只读，逻辑层永不回写 */
export interface RenderView {
  readonly cameraIndex: number;
  readonly width: number;
  readonly height: number;
  readonly jitterX: number;      // TAA 亚像素抖动
  readonly jitterY: number;
  readonly frameIndex: number;
  readonly isShadowView: boolean;
}

export interface RenderWorldSnapshot {
  /** SoA：所有待渲染对象的属性，列式存储，可直接 writeBuffer */
  readonly objects: {
    readonly meshId: Uint32Array;
    readonly materialId: Uint32Array;
    readonly model: Float32Array;        // 每对象 12 个 f32 (mat3x4)
    readonly prevModel: Float32Array;    // 上一帧，用于 TAA 运动向量
    readonly flags: Uint32Array;
    count: number;
  };
  readonly lights: {
    readonly position: Float32Array;
    readonly color: Float32Array;
    readonly params: Float32Array;       // range, intensity, type, spotAngle
    count: number;
  };
  readonly cameras: {
    readonly view: Float32Array;
    readonly proj: Float32Array;         // 反向 Z 投影矩阵
    readonly prevViewProj: Float32Array;
    count: number;
  };
}

export interface FeatureDeps {
  readonly gfx: GfxDevice;
  readonly graph: FrameGraph;
  readonly world: RenderWorldSnapshot;
}

export interface RenderFeature {
  readonly name: string;
  /** 能力不足时整块跳过，由管线自动选择降级链路 */
  readonly minTier: CapabilityTier;
  /** 声明本特性需要的持久资源（如 TAA history、HiZ 金字塔） */
  setup(deps: FeatureDeps): void;
  /** 每帧往 graph 里 addPass */
  render(deps: FeatureDeps, view: RenderView): void;
  shutdown(): void;
}

// ---------------------------------------------------------------- 装配

export interface PipelineConfig {
  readonly shadows: 'off' | 'csm-2' | 'csm-4';
  readonly ao: 'off' | 'ssao' | 'gtao';
  readonly reflections: 'off' | 'probe' | 'ssr' | 'ssr+ddgi';
  readonly aa: 'off' | 'fxaa' | 'taa' | 'taau';
  readonly tonemap: 'aces' | 'agx' | 'reinhard';
  readonly volumetricFog: boolean;
  readonly transparent: 'sorted' | 'oit';
  readonly resolutionScale: number;
}

export const DEFAULT_PIPELINE: PipelineConfig = {
  shadows: 'csm-4',
  ao: 'gtao',
  reflections: 'ssr',
  aa: 'taau',
  tonemap: 'agx',
  volumetricFog: true,
  transparent: 'sorted',
  resolutionScale: 1.0,
};

/** 按配置 + 设备能力裁剪特性列表，返回本帧实际执行的 Pass 链 */
export function assembleFeatures(
  config: PipelineConfig,
  tierOf: (name: string) => CapabilityTier,
  all: readonly RenderFeature[],
): RenderFeature[] {
  const tierRank: Record<CapabilityTier, number> = { t0: 0, t1: 1, t2: 2, t3: 3 };
  const deviceRank = tierOf('device');
  return all.filter(f => {
    if (tierRank[f.minTier] > tierRank[deviceRank]) return false;
    switch (f.name) {
      case 'shadows':      return config.shadows !== 'off';
      case 'ao':           return config.ao !== 'off';
      case 'ssr':          return config.reflections === 'ssr' || config.reflections === 'ssr+ddgi';
      case 'ddgi':         return config.reflections === 'ssr+ddgi';
      case 'volumetric':   return config.volumetricFog;
      case 'taa':          return config.aa === 'taa' || config.aa === 'taau';
      default:             return true;
    }
  });
}

/** 一帧中 Pass 的标准顺序，新增特性在此登记 */
export const PASS_ORDER = [
  'hiz',
  'culling',
  'skinning',
  'particles',
  'shadows',
  'depth-prepass',
  'cluster-cull',
  'opaque',
  'decal',
  'sky',
  'ao',
  'ssr',
  'ddgi',
  'volumetric',
  'transparent',
  'taa',
  'bloom',
  'tonemap',
  'ui',
  'debug',
] as const;
