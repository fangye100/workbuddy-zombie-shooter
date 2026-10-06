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
 * - Stop releases GPU resources. Shared-motion Play re-reads rig/sidecar data;
 *   target-local solved clips remain reusable in the content-keyed motion service.
 *
 * ## 降级（flags bit0 = 0 的胶囊路径）
 *
 * 任何一步失败——角色无绑定骨架、fetch/解析失败、共享动作配置损坏——
 * 都产出 diagnostics + 不注册，RuntimeBridge 继续
 * 画胶囊。一个缺资产不该让 Play 崩，也不该让其余角色陪葬（AGENTS.md §2.5 同精神）。
 */

import {
  parseGlb,
  findCharacterLodPath,
  findRiggedCharacterIds,
  type MeshData,
} from '@aether/scene';
import { fileUrl } from '../asset-util';
import type { SharedMotionRuntime, ResolvedMotion } from './shared-motion-runtime';
import {
  bakePosePalette,
  bindPoseIndex,
  DEFAULT_BAKE_PROFILE,
  limitClips,
  type BakedPalette,
  type BakeProfile,
} from '@aether/render';

/** 一个已装配好的真角色（RuntimeBridge 消费，字段全部是纯数据） */
export interface ActorMesh {
  /** Shared source results and diagnostics, generated for this target at load time. */
  motion?: ResolvedMotion;
  /** Decoded CPU texture cache; GPU copies belong to RendererCore and die at Stop. */
  albedo?: ImageBitmap | null;
  characterId: string;
  /** core 动态网格缓存键：`actor:<characterId>`（与胶囊 `capsule:r…:h…` 区分） */
  meshId: string;
  /** 15 float 交错顶点（VERTEX_LAYOUT），资产原尺寸（不规整身高） */
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  /** 4 关节下标 + 4 权重 / 顶点（SKIN_LAYOUT 消费；类型对齐 MeshData 的宽标注） */
  joints: Uint16Array;
  weights: Float32Array;
  /** Global matrix offset (instance [7]); pose stride is this actor's jointCount. */
  paletteBase: number;
  /** bind pose 相对 paletteBase 的下标（M2 静止姿态；M3 换 clip 帧时同样取相对量） */
  restPose: number;
  /** 网格原点 → 脚底的高度（实例 y = feetOffset 让模型踩在实体坐标上） */
  feetOffset: number;
  /** 本角色的烘焙调色板（纯数据；M3 相位查表 poseIndexAt 的输入） */
  palette: BakedPalette;
  /**
   * 动画片段元数据（M3）：从 palette.clips + clipBasePose 派生，全部是
   * **角色 palette 内的局部**量 —— Bridge 选片（idle/walk）与打包
   * inst[12]=frameCount / 相位推进（durationSec）用。
   */
  clips: ActorClipMeta[];
}

/** 单个动画片段的查表元数据（局部于本角色 palette；M3 动画相位用） */
export interface ActorClipMeta {
  name: string;
  /** 该 clip 第 0 帧在本角色 palette 里的局部 pose 下标（= BakedPalette.clipBasePose[i]） */
  basePose: number;
  frameCount: number;
  /** 片段时长（秒）——相位推进速度的分母 */
  durationSec: number;
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
  /** Global matrix offsets, allowing different joint counts in the same GPU buffer. */
  readonly bases: readonly number[];
  /** 按输入顺序拼接的总调色板；空输入 = null（无角色时没有可上传的数据） */
  readonly data: Float32Array<ArrayBuffer> | null;
}

/**
 * 装配数学（纯函数）：按**输入序**给每个角色分配全局起始矩阵，并把各角色的
 * 烘焙帧拼成一块总调色板。输入序由调用方保证 —— ActorLibrary 传 manifest
 * 规范序（rankOrderEntries，PR #19 FR-B），测试直接传数组。
 *
 * ActorLibrary 的 `preload`（base 分配）与 `buildPalette`（拼接）都走这里 ——
 * 单一实现，Node 单测（runtime-actors.test.ts）与浏览器探针
 *（dynamic-skin-probe.mjs）复算的是同一份不变量（第三道复审 C5 防线）。
 *
 * 不变量：
 * - `bases[i]` = preceding matrix count (not float count or pose count);
 * - `data` = 各角色 `palette.data` 顺序拼接；
 * - global bind matrix = bases[i] + bindPoseIndex(palette_i) * palette_i.jointCount,
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
    next += p.data.length / 16;
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

/**
 * 按 manifest rank 给已装配角色排出**规范序**（PR #19 review FR-B）。
 *
 * 背景：重试会让注册序偏离 manifest 序（E-02 瞬时失败 → E-03 先注册 → E-02
 * 下轮重试成功按 Map 插入序追加末尾），而 paletteBase 的分配序文档承诺是
 * manifest 序。这里把「排序」抽成纯函数，ActorLibrary 的 base 分配与拼接
 * 都以它的输出为准 —— 注册历史不再影响布局。
 *
 * 排序规则：rank 有的按 rank 升序；rank 缺失（manifest 后被改、角色不在
 * 「+动画」清单里）的排末尾按 id 字典序稳定兜底 —— 永远全量重排，与
 * 注册顺序无关。
 */
export function rankOrderEntries<T extends { characterId: string }>(
  entries: readonly T[],
  rank: ReadonlyMap<string, number>,
): T[] {
  return [...entries].sort((a, b) => {
    const ra = rank.get(a.characterId);
    const rb = rank.get(b.characterId);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.characterId < b.characterId ? -1 : a.characterId > b.characterId ? 1 : 0;
  });
}

export class ActorLibrary {
  private sharedMotions: SharedMotionRuntime | null = null;
  setSharedMotions(motions: SharedMotionRuntime): void { this.sharedMotions = motions; }
  /** asset-manifest.json 的原始 JSON（可后补，见 setManifest） */
  private manifestJson: unknown;
  /** characterId → manifest「+动画」清单序号（规范装配序；setManifest 时派生） */
  private rank: ReadonlyMap<string, number> = new Map();
  /** characterId → 已装配角色（注册序可能与规范序不同；装配布局一律走 rankOrderEntries） */
  private readonly entries = new Map<string, ActorMesh>();
  /** 本轮已失败的角色（不重试；clear() 后重新开始） */
  private readonly failed = new Set<string>();
  private readonly errors = new Map<string, string>();
  get diagnostics(): string[] { return [...this.errors].map(([id, message]) => `${id}: ${message}`); }
  private cacheGeneration = 0;
  private readonly fetcher: (path: string) => Promise<ArrayBuffer>;
  /** 烘焙档位（P4 M4）：采样率与片段数上限，来自项目 render.targetTier */
  private bake: BakeProfile;

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
    /**
     * 烘焙档位（P4 M4，docs/20 §M4）。
     *
     * 调色板显存 = 帧数 × 关节数 × 16 float，mobile 上全片段 24fps 的开销撑不住
     * 200 只。默认桌面档；mobile（t0/t1）降到 16fps 且只烘 1~2 个片段。
     * 档位真源在项目文件 `render.targetTier`，由调用方传入（本类不读项目文件）。
     */
    bake: BakeProfile = DEFAULT_BAKE_PROFILE,
  ) {
    this.manifestJson = manifest;
    this.fetcher = fetcher;
    this.bake = bake;
    this.recomputeRank();
  }

  /** 当前烘焙档位（HUD / 探针显示用） */
  get bakeProfile(): BakeProfile {
    return this.bake;
  }

  /**
   * 设定烘焙档位（P4 M4）。
   *
   * 🔴 **必须早于任何 preload**：已装配的角色不会因改档位而重烘 —— 重烘会换掉
   * palette 的帧数与布局，而 paletteBase 已经发给了 Bridge 与 GPU（重排就要整套
   * 重传，且已发出的 ActorMesh 是同一引用，改字段会静默错位）。
   * 正常启动路径档位在 manifest 之前就设好了（main.ts），这里只在真出问题时告警。
   */
  setBakeProfile(p: BakeProfile): void {
    if (this.entries.size > 0) {
      console.warn('[actors] 已有角色装配完成 —— 改烘焙档位不会重烘（档位必须在 preload 前设定）');
      return;
    }
    this.bake = p;
  }

  get(characterId: string): ActorMesh | null {
    return this.entries.get(characterId) ?? null;
  }

  /** 已装配角色数（探针 / HUD 用） */
  get assembledIds(): string[] { return this.orderedEntries.map(a => a.characterId); }

  get size(): number {
    return this.entries.size;
  }

  /**
   * 补设资产清单（构造时 manifest 可能尚未加载完——编辑器启动是异步的，
   * 而 Bridge/Play 的装配链要同步建好）。清单到位前 preload 一律返回 false。
   */
  setManifest(json: unknown): void {
    this.manifestJson = json;
    this.recomputeRank();
    // 清单变化可能改变规范序 → 已装配角色的 base 布局全部重排（幂等，安全）
    this.reassignBases();
  }

  /** 从当前清单派生 rank（manifest 缺省时为空表：全部走末尾字典序兜底） */
  private recomputeRank(): void {
    const ids =
      this.manifestJson === null || this.manifestJson === undefined
        ? []
        : findRiggedCharacterIds(this.manifestJson);
    const map = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) map.set(ids[i]!, i);
    this.rank = map;
  }

  /**
   * 按需装配一个角色。返回「是否有新角色注册」—— true 时调用方要重新
   * `buildPalette()` + `setDynamicPalette()`；幂等（已注册 / 已失败都返回 false）。
   *
   * 清单**未就绪**（null，编辑器启动竞态）也返回 false 但**不记失败**——
   * 这是可重试状态，调用方等 manifest 到位后再来（见 main.ts 的 manifestReady）。
   */
  async preload(characterId: string): Promise<boolean> {
    const generation = this.cacheGeneration;
    if (this.entries.has(characterId) || this.failed.has(characterId)) return false;
    if (this.manifestJson === null || this.manifestJson === undefined) return false;

    let path = findCharacterLodPath(this.manifestJson, characterId, ANIMATED_LOD_LABEL);
    const rigPath = this.sharedMotions ? findCharacterLodPath(this.manifestJson, characterId, '+骨骼') : null;
    if (path === null && rigPath === null) {
      // B-02 等从未绑骨的角色走这里——「没档」是数据事实，降级到 warn 即可
      console.warn(`[actors] ${characterId} 无「${ANIMATED_LOD_LABEL}」LOD 档，退回胶囊`);
      this.errors.set(characterId, '缺少带骨架的角色资产，显示胶囊代理');
      this.failed.add(characterId);
      return false;
    }

    try {
      // Rig-only assets with a configured library are authoritative. A broken binding
      // is reported rather than silently falling back to stale embedded animations.
      let meta = rigPath ? await this.sharedMotions!.assetMeta(rigPath) : null;
      if (meta?.sharedMotion) path = rigPath;
      else meta = path && this.sharedMotions ? await this.sharedMotions.assetMeta(path) : null;
      if (!path) throw new Error('Rig-only GLB requires a shared motion binding');
      if (generation !== this.cacheGeneration) return false;
      const buf = await this.fetcher(path);
      if (generation !== this.cacheGeneration) return false;
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
      let motion: ResolvedMotion | undefined;
      let animations = glb.animations;
      if (this.sharedMotions) {
        if (meta?.sharedMotion) {
          motion = await this.sharedMotions.resolve(sk, meta.sharedMotion, meta);
          animations = motion.clips;
        }
      }
      if (generation !== this.cacheGeneration) return false;
      if (animations.length === 0) throw new Error('GLB 无动画片段，且未配置共享动作库');

      // P4 M4：按档位裁剪片段 + 降采样（mobile 档省显存/CPU 的关键一步）
      const bakeClips = [...limitClips(animations, this.bake.maxClips)];
      const palette = bakePosePalette(sk, bakeClips, { fps: this.bake.fps });
      // 片段元数据（M3）：合并 BakedPalette.clips 与 clipBasePose，Bridge 选片用
      const clips: ActorClipMeta[] = palette.clips.map((c, i) => ({
        name: c.name,
        basePose: palette.clipBasePose[i]!,
        frameCount: c.frameCount,
        durationSec: c.durationSec,
      }));

      // paletteBase 先占位 0，注册后 reassignBases 按 manifest 规范序全量重算
      //（重试场景下注册序 ≠ manifest 序，内联累加会把重试历史焊进布局——
      // PR #19 review FR-B。每次成功注册全量重排，已发放 ActorMesh 是同一
      // 引用，改字段即对 Bridge 生效）
      let albedo: ImageBitmap | null = null;
      if (glb.image) {
        try { albedo = await createImageBitmap(glb.image, { colorSpaceConversion: 'none' }); }
        catch (error) { console.warn(`[actors] ${characterId} 贴图解码失败，使用代理色`, error); }
      }
      if (generation !== this.cacheGeneration) { albedo?.close(); return false; }
      this.entries.set(characterId, {
        ...(motion ? { motion } : {}),
        albedo,
        characterId,
        meshId: `actor:${characterId}`,
        vertices: mesh.vertices,
        indices: mesh.indices,
        joints: mesh.joints,
        weights: mesh.weights,
        paletteBase: 0,
        // 🔴 bindPoseIndex 返回的是**本角色 palette 内**的局部下标（角色自身
        // pose 总数-1），不是全局——shader 端 matrix = base + pose * jointCount，
        // 所以这里直接存局部值，绝不能再减 base（第二个角色起会算出负值 →
        // u32 巨数 → 越界读全零矩阵，PR #18 review 抓的正 bug）
        restPose: bindPoseIndex(palette),
        feetOffset: meshMinY(mesh),
        palette,
        clips,
      });
      this.reassignBases();
      return true;
    } catch (e) {
      if (generation !== this.cacheGeneration) return false;
      console.warn(`[actors] ${characterId} 装配失败（${path}），退回胶囊：`, e);
      this.errors.set(characterId, String(e));
      this.failed.add(characterId);
      return false;
    }
  }

  /**
   * 按 manifest 规范序重排全部已装配角色的 paletteBase（数学归 assemblePalettes）。
   * 调用时机：成功注册新角色 / setManifest。幂等。
   */
  private reassignBases(): void {
    const ordered = rankOrderEntries([...this.entries.values()], this.rank);
    const { bases } = assemblePalettes(ordered.map((e) => e.palette));
    for (let i = 0; i < ordered.length; i++) {
      ordered[i]!.paletteBase = bases[i]!;
    }
    this.orderedEntries = ordered;
  }

  /** 规范序快照（reassignBases 维护；buildPalette 与探针复算共用同一序） */
  private orderedEntries: ActorMesh[] = [];

  /** 把全部角色的烘焙帧按 **manifest 规范序**拼成一块（喂 core.setDynamicPalette；数学归 assemblePalettes） */
  buildPalette(): Float32Array<ArrayBuffer> | null {
    if (this.orderedEntries.length !== this.entries.size) this.reassignBases();
    return assemblePalettes(this.orderedEntries.map((e) => e.palette)).data;
  }

  /**
   * 清空「失败名单」（Stop 边界调用）：下一轮 Play 对瞬时故障（网络抖动等）
   * 允许重试。已成功的装配缓存不动（跨 Play 复用）。
   */
  resetFailures(): void {
    this.failed.clear();
    this.errors.clear();
  }

  /** New Play re-reads authored rig/binding data. Solved motion caches remain content-keyed. */
  beginPlay(): void { if (this.sharedMotions) this.clear(); else this.resetFailures(); }

  /**
   * 单角色清除失败名单（PR #19 review FR-A）：main 的预载循环跨 Stop 边界后，
   * 在飞的 fetch 才 reject 会把 id 迟到地写回 failed，下一轮 Play 因此跳过它
   * ——违背「Stop 边界允许重试」。调用方（kickActorPreload 的代次守卫）在确认
   * 循环已过期时对本轮 id 逐个清一次，封死跨边界污染窗口。幂等。
   */
  resetFailure(characterId: string): void {
    this.failed.delete(characterId);
    this.errors.delete(characterId);
  }

  /** 清空装配（编辑器卸载 / 换项目时；Play 间复用不要调） */
  clear(): void {
    this.cacheGeneration++;
    for (const actor of this.entries.values()) actor.albedo?.close();
    this.entries.clear();
    this.failed.clear();
    this.errors.clear();
    this.orderedEntries = [];
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
