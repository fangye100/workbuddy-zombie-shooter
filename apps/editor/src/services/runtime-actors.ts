/**
 * ActorLibrary —— 运行时真角色的加载 / 烘焙 / 全局调色板装配（docs/20 §5，P4 M2）。
 *
 * ## 为什么在编辑器侧而不是 packages/runtime
 *
 * runtime 必须保持纯 CPU、不认 GPU 资源（docs/17 §3.5 单一 owner）。本模块
 * fetch GLB、解析骨架、烘焙调色板 —— 产出全是**纯数据**（Float32Array），
 * GPU buffer 的创建归 RendererCore（ADR-001）。Node 侧测试可以只用烘焙数据
 * 断言 poseIndex，不需要本模块（运行时只认 tick，不认姿态）。
 *
 * ## 生命周期
 *
 * - Play 开始时按需 `preload(characterId)`（幂等；**一次 Play 会话内**失败不重试
 *   ——反复 fetch 只会把错误刷满控制台。Stop 边界调 `resetFailures()`，下一轮
 *   Play 允许重试一次瞬时故障（网络抖动不该让角色整个页面会话都变胶囊，
 *   PR #18 review 抓的语义错位））。
 * - 每次成功注册新角色后调用方应 `buildPalette()` → `core.setDynamicPalette()`。
 * - Stop 时 core 侧 `releaseDynamicResources()` 释放 GPU buffer；本库的 CPU 数据
 *   （网格 + 烘焙帧）跨 Play 缓存复用，重新上传即可。
 *
 * ## 降级（flags bit0 = 0 的胶囊路径）
 *
 * 任何一步失败——角色没有「+动画」档（B-02 从未绑骨）、fetch/解析失败、
 * 关节数与 shader 常量不符——都只 console.warn + 不注册，RuntimeBridge 继续
 * 画胶囊。一个缺资产不该让 Play 崩，也不该让其余角色陪葬（AGENTS.md §2.5 同精神）。
 */

import {
  parseGlb,
  findCharacterLodPath,
  type MeshData,
} from '@aether/scene';
import { fileUrl } from '../asset-util';
import { bakePosePalette, bindPoseIndex, type BakedPalette } from '@aether/render';

/** 调色板每个 pose 的关节数（与 dynamic.wgsl 的 PALETTE_JOINT_COUNT 同源，见其注释） */
export const PALETTE_JOINT_COUNT = 23;

/** 一个已装配好的真角色（RuntimeBridge 消费，字段全部是纯数据） */
export interface ActorMesh {
  characterId: string;
  /** core 动态网格缓存键：`actor:<characterId>`（与胶囊 `capsule:r…:h…` 区分） */
  meshId: string;
  /** 15 float 交错顶点（VERTEX_LAYOUT），资产原尺寸（不规整身高） */
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  /** 4 关节下标 + 4 权重 / 顶点（SKIN_LAYOUT 消费；类型对齐 MeshData 的宽标注） */
  joints: Uint16Array;
  weights: Float32Array;
  /** 该角色在全局调色板里的起始 pose（实例 [7]） */
  paletteBase: number;
  /** bind pose 相对 paletteBase 的下标（M2 静止姿态；M3 换 clip 帧时同样取相对量） */
  restPose: number;
  /** 网格原点 → 脚底的高度（实例 y = feetOffset 让模型踩在实体坐标上） */
  feetOffset: number;
}

/** LOD 标签关键字：manifest 里「+动画」档 = rigged_animated GLB（docs/20 §5） */
const ANIMATED_LOD_LABEL = '+动画';

// ------------------------------------------------ 装配数学（纯函数，M3 WU-1 抽出）

/**
 * 单个角色 palette 的 pose 总数（含末尾追加的 bind 帧）。
 * `data.length` 是 float 数：每 pose 恒为 jointCount × 16（列主 mat4）。
 */
export function palettePoseCount(palette: BakedPalette): number {
  return palette.data.length / 16 / palette.jointCount;
}

/** `assemblePalettes` 的输出：每角色的全局起始 pose + 拼接后的总调色板 */
export interface PaletteAssembly {
  /** 与输入等长：角色 i 的全局起始 pose = 前面角色的 pose 数之和（按输入顺序累加） */
  readonly bases: readonly number[];
  /** 按输入顺序拼接的总调色板；空输入 = null（无角色时没有可上传的数据） */
  readonly data: Float32Array<ArrayBuffer> | null;
}

/**
 * 装配数学（纯函数）：按**注册序**给每个角色分配全局起始 pose，并把各角色的
 * 烘焙帧拼成一块总调色板。
 *
 * ActorLibrary 的 `preload`（base 分配）与 `buildPalette`（拼接）都走这里 ——
 * 单一实现，Node 单测（runtime-actors.test.ts）与浏览器探针
 *（dynamic-skin-probe.mjs）复算的是同一份不变量（第三道复审 C5 防线）。
 *
 * 不变量：
 * - `bases[i]` = 前面角色 pose 数之和（**pose 单位**，不是 float 单位）；
 * - `data` = 各角色 `palette.data` 顺序拼接；
 * - 角色 i 的全局 bind pose 下标 = `bases[i] + bindPoseIndex(palette_i)`，
 *   即该角色块的**最后一 pose**。`bindPoseIndex` 返回的是角色 palette 内的
 *   **局部**下标，绝不能再减 base —— 第二个角色起会算出负数 → u32 巨数 →
 *   shader 越界读全零矩阵（PR #18 review 抓的 P1）。
 */
export function assemblePalettes(palettes: readonly BakedPalette[]): PaletteAssembly {
  const bases: number[] = [];
  let next = 0;
  let totalFloats = 0;
  for (const p of palettes) {
    bases.push(next);
    next += palettePoseCount(p);
    totalFloats += p.data.length;
  }
  if (palettes.length === 0) return { bases, data: null };
  const data = new Float32Array(new ArrayBuffer(totalFloats * 4));
  let off = 0;
  for (const p of palettes) {
    data.set(p.data, off);
    off += p.data.length;
  }
  return { bases, data };
}

export class ActorLibrary {
  /** asset-manifest.json 的原始 JSON（可后补，见 setManifest） */
  private manifestJson: unknown;
  /** characterId → 已装配角色（注册序即 palette 拼接序） */
  private readonly entries = new Map<string, ActorMesh & { palette: BakedPalette }>();
  /** 本轮已失败的角色（不重试；clear() 后重新开始） */
  private readonly failed = new Set<string>();
  private readonly fetcher: (path: string) => Promise<ArrayBuffer>;

  /**
   * @param manifest asset-manifest.json 的原始 JSON（解析归 findCharacterLodPath）
   * @param fetcher  可注入的资源加载器（浏览器 = /__fs/file 端点；测试可换桩）。
   *                 🔴 必须走 fileUrl()：vite root 是 apps/editor，直接 fetch
   *                 assets/** 会吃到 SPA fallback 的 index.html（parseGlb 报
   *                 「缺 glTF magic」），2026-10-02 M2 探针实锤过。
   */
  constructor(
    manifest: unknown,
    fetcher: (path: string) => Promise<ArrayBuffer> = (p) =>
      fetch(fileUrl(p)).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
  ) {
    this.manifestJson = manifest;
    this.fetcher = fetcher;
  }

  get(characterId: string): ActorMesh | null {
    return this.entries.get(characterId) ?? null;
  }

  /** 已装配角色数（探针 / HUD 用） */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 补设资产清单（构造时 manifest 可能尚未加载完——编辑器启动是异步的，
   * 而 Bridge/Play 的装配链要同步建好）。清单到位前 preload 一律返回 false。
   */
  setManifest(json: unknown): void {
    this.manifestJson = json;
  }

  /**
   * 按需装配一个角色。返回「是否有新角色注册」—— true 时调用方要重新
   * `buildPalette()` + `setDynamicPalette()`；幂等（已注册 / 已失败都返回 false）。
   *
   * 清单**未就绪**（null，编辑器启动竞态）也返回 false 但**不记失败**——
   * 这是可重试状态，调用方等 manifest 到位后再来（见 main.ts 的 manifestReady）。
   */
  async preload(characterId: string): Promise<boolean> {
    if (this.entries.has(characterId) || this.failed.has(characterId)) return false;
    if (this.manifestJson === null || this.manifestJson === undefined) return false;

    const path = findCharacterLodPath(this.manifestJson, characterId, ANIMATED_LOD_LABEL);
    if (path === null) {
      // B-02 等从未绑骨的角色走这里——「没档」是数据事实，降级到 warn 即可
      console.warn(`[actors] ${characterId} 无「${ANIMATED_LOD_LABEL}」LOD 档，退回胶囊`);
      this.failed.add(characterId);
      return false;
    }

    try {
      const buf = await this.fetcher(path);
      // targetHeight = null：不做身高规整。碰撞/选中的真源是 stats 的胶囊尺寸，
      // 网格保持资产原尺寸（1.895m 家族）；强行归一化会把两者基差焊死在渲染里
      const glb = parseGlb(buf, null);
      const sk = glb.skeleton;
      const mesh: MeshData = glb.mesh;
      if (sk === null) throw new Error('GLB 无骨架（不是 rigged 档）');
      // == null 同时捕 null 与 undefined（MeshData 的蒙皮字段是可选宽类型）
      if (mesh.joints == null || mesh.weights == null) throw new Error('网格无 JOINTS_0/WEIGHTS_0');
      // 长度校验：packSkin 对长度不足的输入会静默退化成恒等关节（geometry.ts），
      // bind pose 下不可见、M3 动画期才显形为「整模型不动」——装配期就拦下
      const vcount = mesh.vertices.length / 15;
      if (mesh.joints.length < vcount * 4 || mesh.weights.length < vcount * 4) {
        throw new Error(`蒙皮数据不足（joints ${mesh.joints.length} / weights ${mesh.weights.length} < ${vcount * 4}）`);
      }
      if (sk.joints.length + 1 !== PALETTE_JOINT_COUNT) {
        throw new Error(`关节数 ${sk.joints.length + 1} ≠ shader 常量 ${PALETTE_JOINT_COUNT}（换骨架要改三处）`);
      }
      if (glb.animations.length === 0) throw new Error('GLB 无动画片段');

      const palette = bakePosePalette(sk, glb.animations);
      // 全局 paletteBase = 已注册角色 pose 总数（注册序拼接；数学归 assemblePalettes）
      let base = 0;
      for (const e of this.entries.values()) base += palettePoseCount(e.palette);

      this.entries.set(characterId, {
        characterId,
        meshId: `actor:${characterId}`,
        vertices: mesh.vertices,
        indices: mesh.indices,
        joints: mesh.joints,
        weights: mesh.weights,
        paletteBase: base,
        // 🔴 bindPoseIndex 返回的是**本角色 palette 内**的局部下标（角色自身
        // pose 总数-1），不是全局——shader 端「全局 = paletteBase + 相对量」，
        // 所以这里直接存局部值，绝不能再减 base（第二个角色起会算出负值 →
        // u32 巨数 → 越界读全零矩阵，PR #18 review 抓的正 bug）
        restPose: bindPoseIndex(palette),
        feetOffset: meshMinY(mesh),
        palette,
      });
      return true;
    } catch (e) {
      console.warn(`[actors] ${characterId} 装配失败（${path}），退回胶囊：`, e);
      this.failed.add(characterId);
      return false;
    }
  }

  /** 把全部角色的烘焙帧按注册序拼成一块（喂 core.setDynamicPalette；数学归 assemblePalettes） */
  buildPalette(): Float32Array<ArrayBuffer> | null {
    return assemblePalettes([...this.entries.values()].map((e) => e.palette)).data;
  }

  /**
   * 清空「失败名单」（Stop 边界调用）：下一轮 Play 对瞬时故障（网络抖动等）
   * 允许重试。已成功的装配缓存不动（跨 Play 复用）。
   */
  resetFailures(): void {
    this.failed.clear();
  }

  /** 清空装配（编辑器卸载 / 换项目时；Play 间复用不要调） */
  clear(): void {
    this.entries.clear();
    this.failed.clear();
  }
}

/** 网格最低点（VERTEX_LAYOUT 的 y 在每顶点第 1 float）：脚底贴地偏移 = -minY */
function meshMinY(mesh: MeshData): number {
  const v = mesh.vertices;
  let minY = Infinity;
  for (let i = 1; i < v.length; i += 15) {
    if (v[i]! < minY) minY = v[i]!;
  }
  return minY === Infinity ? 0 : -minY;
}
