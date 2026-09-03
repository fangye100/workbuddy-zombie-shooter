/**
 * 帧 uniform 布局与装箱（引擎层，纯函数，不碰 GPU / DOM / 编辑器参数）。
 *
 * 2026-09-03 L-3：这四个 pack 函数原先是 `apps/editor/src/renderer.ts` 的私有方法，
 * 而它们要写的 buffer 尺寸常量（`LIGHTS_FLOATS` 等）却在 `renderer-core.ts` 里 ——
 * 「装箱逻辑」和「layout 常量」分居两地，改一个 WGSL 字段要跨两层改两处。
 * 现在二者合到同一个文件：布局定义与写入顺序一屏可见，改 WGSL 只动这里。
 *
 * **参数契约刻意收窄**：这里只声明装箱真正读到的字段（`LightPackParams` 等），
 * 不引入编辑器侧的 `LabParams`（ADR-007：LabParams 属编辑器 UI 层）。
 * 调用方直接把 `LabParams` 传进来即可 —— 它是这些接口的字段超集，结构化类型天然兼容。
 */

import { hexToLinear, hexToRgb, sphericalToDir } from '@aether/core';
import type { MaterialState } from './materials';

// ===================== uniform 布局（原在 renderer-core.ts） =====================

export const SLOT_BYTES = 256; // minUniformBufferOffsetAlignment
export const SLOT_FLOATS = SLOT_BYTES / 4;

export const MAX_MATERIAL_SLOTS = 256;
export const MAX_OBJECTS = 64;

export const FRAME_FLOATS = 24; // 96 B
export const LIGHTS_FLOATS = 40; // 160 B
export const TOON_FLOATS = 28; // 112 B
export const POST_FLOATS = 44; // 176 B

// ===================== 参数契约（LabParams 的字段子集） =====================

/** packLights 读到的字段 */
export interface LightPackParams {
  keyAzimuth: number;
  keyElevation: number;
  keyIntensity: number;
  keyColor: string;

  fillSkyColor: string;
  fillSkyIntensity: number;
  fillGroundColor: string;
  fillGroundIntensity: number;

  rimColor: string;
  rimIntensity: number;
  rimPower: number;
  rimTopBias: number;

  ambientColor: string;
  ambientIntensity: number;

  pointEnabled: boolean;
  pointColor: string;
  pointIntensity: number;
  pointRange: number;
  pointOrbit: boolean;

  fogColor: string;
  fogDensity: number;
}

/** packToon 读到的字段 */
export interface ToonPackParams {
  shadowEnd: number;
  specStart: number;
  edgeSoftness: number;
  shadowMult: number;
  shadowMix: number;
  shadowSat: number;
  litSat: number;
  specMix: number;
  shadowTint: string;
  specTint: string;

  outlineWidth: number;
  outlineDistanceComp: boolean;
  inkColor: string;

  debugMode: number;
}

/** packPost 读到的字段 */
export interface PostPackParams {
  gradeEnabled: boolean;
  gradeShadowRange: number;
  gradeMidRange: number;
  gradeEdge: number;
  gradeShadowMult: number;
  gradeShadowMix: number;
  gradeShadowSat: number;
  gradeMidSat: number;
  /** 中间调倍率。此前在 packPost 里写死 0.98（L-7），真源是 tokens.json 的 grading.stops[mid].multiply */
  gradeMidMult: number;
  gradeLightMult: number;
  gradeLightMix: number;
  gradeLightSat: number;

  /** 暗部混向色。此前写死 #0E0C16（= core.night-deep），真源是 tokens.json */
  gradeShadowColor: string;
  /** 亮部混向色。此前写死 #FFF6E2（= core.bone），真源是 tokens.json */
  gradeLightColor: string;

  halftoneEnabled: boolean;
  halftoneSize: number;
  halftoneStrength: number;
  halftoneThreshold: number;

  tonemapMode: number;
  exposure: number;
  bloomEnabled: boolean;
  bloomThreshold: number;
  bloomIntensity: number;
  vignette: number;
  outlinePostExempt: boolean;

  inkColor: string;
  debugMode: number;
}

/** 三个 block 一起装箱时的入参（编辑器每帧调一次就够） */
export interface FrameUniformInput {
  lights: Float32Array;
  toon: Float32Array;
  post: Float32Array;
  /** 传 LabParams 即可（字段超集，结构化兼容） */
  params: LightPackParams & ToonPackParams & PostPackParams;
  /** 秒；点光自动环绕用 */
  time: number;
  /** 画布物理像素宽（post 需要） */
  width: number;
  /** 画布物理像素高（toon 线宽换算 + post 需要） */
  height: number;
}

// ===================== 装箱 =====================

/** 灯光 block（40 floats）：唯一分阶主光 + 半球 fill + rim + 常数环境 + 局部点光 + 雾 */
export function packLights(dst: Float32Array, p: LightPackParams, time: number): void {
  const dir = sphericalToDir(p.keyAzimuth, p.keyElevation);
  dst[0] = dir[0];
  dst[1] = dir[1];
  dst[2] = dir[2];
  dst[3] = p.keyIntensity;

  const key = hexToLinear(p.keyColor);
  dst[4] = key[0];
  dst[5] = key[1];
  dst[6] = key[2];
  dst[7] = 1;

  const sky = hexToLinear(p.fillSkyColor);
  dst[8] = sky[0];
  dst[9] = sky[1];
  dst[10] = sky[2];
  dst[11] = p.fillSkyIntensity;

  const ground = hexToLinear(p.fillGroundColor);
  dst[12] = ground[0];
  dst[13] = ground[1];
  dst[14] = ground[2];
  dst[15] = p.fillGroundIntensity;

  const rim = hexToLinear(p.rimColor);
  dst[16] = rim[0];
  dst[17] = rim[1];
  dst[18] = rim[2];
  dst[19] = p.rimIntensity;

  const amb = hexToLinear(p.ambientColor);
  dst[20] = amb[0];
  dst[21] = amb[1];
  dst[22] = amb[2];
  dst[23] = p.ambientIntensity;

  dst[24] = p.rimPower;
  dst[25] = p.rimTopBias;
  dst[26] = 0;
  dst[27] = 0;

  const fog = hexToLinear(p.fogColor);
  dst[28] = fog[0];
  dst[29] = fog[1];
  dst[30] = fog[2];
  dst[31] = p.fogDensity;

  const t = p.pointOrbit ? time * 0.8 : 0;
  dst[32] = Math.cos(t) * 2.6;
  dst[33] = 1.4;
  dst[34] = Math.sin(t) * 2.6;
  dst[35] = p.pointRange;

  const pl = hexToLinear(p.pointColor);
  dst[36] = pl[0];
  dst[37] = pl[1];
  dst[38] = pl[2];
  dst[39] = p.pointEnabled ? p.pointIntensity : 0;
}

/** Toon 分阶 block（28 floats）：阈值 / 染色 / 描边 / 墨色 / debug */
export function packToon(dst: Float32Array, p: ToonPackParams, framebufferHeight: number): void {
  dst[0] = p.shadowEnd;
  dst[1] = p.specStart;
  dst[2] = p.edgeSoftness;
  dst[3] = p.shadowMult;

  dst[4] = p.shadowMix;
  dst[5] = p.shadowSat;
  dst[6] = p.litSat;
  dst[7] = p.specMix;

  const st = hexToRgb(p.shadowTint);
  dst[8] = st[0];
  dst[9] = st[1];
  dst[10] = st[2];
  dst[11] = 0;

  const sp = hexToRgb(p.specTint);
  dst[12] = sp[0];
  dst[13] = sp[1];
  dst[14] = sp[2];
  dst[15] = 0;

  // 线宽按 1080p 定义，framebufferHeight 已是物理像素，直接按比例换算
  dst[16] = (p.outlineWidth * framebufferHeight) / 1080;
  dst[17] = p.outlineDistanceComp ? 1 : 0;
  dst[18] = 0;
  dst[19] = 0;

  const ink = hexToRgb(p.inkColor);
  dst[20] = ink[0];
  dst[21] = ink[1];
  dst[22] = ink[2];
  dst[23] = 0;

  dst[24] = p.debugMode;
  dst[25] = 0;
  dst[26] = 0;
  dst[27] = 0;
}

/**
 * 后处理 block（44 floats）：grading 三段 / 半调 / tonemap / bloom / 暗角。
 *
 * 注：grading 工作在 sRGB display-referred 空间，所以这里的颜色送 raw sRGB，
 * **不转 linear**（与灯光 block 相反）。三个 grading 常量色（night-deep / bone / ink）
 * 目前硬编码在下面，按 ADR-002 应由内容库生成层提供 —— 见 docs/12 遗留项 L-7。
 */
export function packPost(
  dst: Float32Array,
  p: PostPackParams,
  width: number,
  height: number,
): void {
  dst[0] = p.gradeShadowRange;
  dst[1] = p.gradeMidRange;
  dst[2] = p.gradeEdge;
  dst[3] = p.gradeEnabled ? 1 : 0;

  dst[4] = p.gradeShadowMult;
  dst[5] = p.gradeShadowMix;
  dst[6] = p.gradeShadowSat;
  dst[7] = 0;

  dst[8] = p.gradeMidMult;
  dst[9] = 0;
  dst[10] = p.gradeMidSat;
  dst[11] = 0;

  dst[12] = p.gradeLightMult;
  dst[13] = p.gradeLightMix;
  dst[14] = p.gradeLightSat;
  dst[15] = 0;

  const nd = hexToRgb(p.gradeShadowColor);
  dst[16] = nd[0];
  dst[17] = nd[1];
  dst[18] = nd[2];
  dst[19] = 0;

  const bone = hexToRgb(p.gradeLightColor);
  dst[20] = bone[0];
  dst[21] = bone[1];
  dst[22] = bone[2];
  dst[23] = 0;

  const ink = hexToRgb(p.inkColor);
  dst[24] = ink[0];
  dst[25] = ink[1];
  dst[26] = ink[2];
  dst[27] = 0;

  dst[28] = p.halftoneEnabled ? 1 : 0;
  dst[29] = p.halftoneSize;
  dst[30] = p.halftoneStrength;
  dst[31] = p.halftoneThreshold;

  dst[32] = p.tonemapMode;
  dst[33] = p.exposure;
  dst[34] = p.bloomThreshold;
  dst[35] = p.bloomEnabled ? p.bloomIntensity : 0;

  dst[36] = p.vignette;
  dst[37] = p.outlinePostExempt ? 1 : 0;
  dst[38] = width;
  dst[39] = height;

  dst[40] = p.debugMode;
  dst[41] = 0;
  dst[42] = 0;
  dst[43] = 0;
}

/**
 * 材质槽（每槽 20 floats，base = slot * SLOT_FLOATS）。
 *
 * dst[base + 18] 是「有贴图」标志位，由调用方在装箱后单独置位 ——
 * 它取决于物体是否挂了纹理（编辑器语义），不属于材质本体。
 */
export function packMaterial(dst: Float32Array, base: number, m: MaterialState): void {
  const a = hexToRgb(m.albedo);
  dst[base] = a[0];
  dst[base + 1] = a[1];
  dst[base + 2] = a[2];
  dst[base + 3] = 1;

  dst[base + 4] = m.roughness;
  dst[base + 5] = m.metallic;
  dst[base + 6] = m.emissiveStrength;
  dst[base + 7] = 0;

  const e = hexToRgb(m.emissiveColor);
  dst[base + 8] = e[0];
  dst[base + 9] = e[1];
  dst[base + 10] = e[2];
  dst[base + 11] = 0;

  dst[base + 12] = m.shadowEnd;
  dst[base + 13] = m.specMix;
  dst[base + 14] = m.softnessScale;
  dst[base + 15] = m.halftoneScale;

  dst[base + 16] = m.unlit ? 1 : 0;
  dst[base + 17] = m.outlineScale;
  dst[base + 18] = 0;
  dst[base + 19] = 0;
}

/** 三个 block 一次装完（编辑器每帧的正规入口） */
export function packFrameUniforms(input: FrameUniformInput): void {
  const { lights, toon, post, params, time, width, height } = input;
  packLights(lights, params, time);
  packToon(toon, params, height);
  packPost(post, params, width, height);
}
