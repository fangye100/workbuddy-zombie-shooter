/**
 * RuntimeBridge —— 编辑器里「看得见的运行时」（docs/17 WU-3）。
 *
 * 职责边界（严格）：
 *   - 本模块**不产玩法**，只把 headless `RuntimeSession` 的纯数据视图翻译成渲染批次。
 *     同一个 session 在 CLI / vitest / 编辑器里跑出完全一样的结果，靠的就是这层
 *     不做任何"编辑器特供"的语义解释。
 *   - 不碰 SceneGraph、不碰 `transformBuf`：动态实体的变换走 storage 实例数组，
 *     **一个静态槽位都不占**（MAX_OBJECTS = 64 是静态关卡的硬上限，500 只僵尸挤进去
 *     会把关卡本身挤掉）。
 *
 * 真模型（ActorLibrary，docs/20 §5）：装配好的 characterId 用真网格 + GPU 蒙皮
 * （实例 flags bit0=1），未装配的退胶囊代理。胶囊仍是「临时可视化」——但降级
 * 本身是**设计行为**（B-02 无 rigged 档 / 加载失败 / 远处 LOD 退档），不是待修 bug。
 */

import { createCapsule, DEFAULT_MOTION_TRANSITION_SEC } from '@aether/scene';
import { rayCapsuleY } from '@aether/gameplay';
import { lookupCharacterStats } from '@aether/content';
import type { RuntimeSession, EntityView } from '@aether/runtime';
import { DYNAMIC_INSTANCE_FLOATS, PalettePoseTransitions, poseIndexAt, type CoreDynamicBatch } from '@aether/render';
import type { ActorMesh, ActorClipMeta } from './runtime-actors';
import { characterYaw } from './character-facing';
import { behaviorClipIndex, paletteChoice } from './animation-debug/selection';
import { deliver, noIk, type AnimationIdentity, type AnimationSink, type AnimationSnapshot } from './animation-debug/contracts';

/**
 * Bridge 对装配库的全部依赖（窄接口）：只问「这个角色有没有真模型」。
 * ActorLibrary 是正式实现；测试用手搓桩，不需要真 GLB / fetch。
 */
export interface ActorSource {
  get(characterId: string): ActorMesh | null;
  request?(characterId: string): void;
}

/** 实例的 CPU 端打包宽度（float），与 CoreDynamicBatch 契约一致 */
const F = DYNAMIC_INSTANCE_FLOATS;

/** 实例 flags：bit0 = 蒙皮（docs/20 §3.1；0 = 胶囊代理走老路径） */
const FLAG_SKINNED = 1;

/** 行为状态 → 片段名（EntityView.behavior：0 = idle、1 = chase；docs/20 M3） */

/** 黄金比共轭 φ⁻¹：实体相位偏移乘子（id × φ⁻¹ mod 1 分布均匀，避免全员机械同步） */
const PHASE_OFFSET_GOLDEN = 0.6180339887498949;

/**
 * 动画相位（docs/20 M3，确定性红线）：
 *
 *     phase = (世界时间 / 片段时长 + id × φ⁻¹ mod 1) mod 1
 *
 * - 世界时间 = `tick × fixedStep`（RuntimeSession 固定步长 1/30s —— 渲染帧率
 *   不影响动画相位，Node 与浏览器同 tick 同实体必然同值）；
 * - 偏移在**周期单位**上：无论片段时长多少，实体间均匀错开；
 * - 纯函数：无随机、无 Date —— 这是「同种子世界逐位可重放」的一部分。
 */
export function animPhase(tick: number, fixedStepSec: number, entityId: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0; // 时长 0 的退化片：相位恒 0（最近帧语义下静止）
  const offset = (entityId * PHASE_OFFSET_GOLDEN) % 1;
  const phase = (tick * fixedStepSec) / durationSec + offset;
  return phase - Math.floor(phase);
}

/**
 * 按行为状态选片（docs/20 M3）：chase → 'walk'（移动）、idle → 'idle'（站立）。
 * 名字匹配不到回退 clip 0（真 GLB 六片 idle/run/attack/walk/hit/death 全有，
 * 兜底防资产改名）；一个片都没有返回 -1，调用方回 bind pose（restPose）。
 */
export function clipIndexForBehavior(clips: readonly ActorClipMeta[], behavior: number): number {
  return behaviorClipIndex(clips, behavior);
}

/**
 * 代理体配色。**不是真源**——等真模型接进来后由材质决定，这里只为了让不同 NPC
 * 在灰盒阶段能被区分开。key 是 characterId，未登记者退回尸绿。
 */
const PROXY_COLORS: Record<string, [number, number, number]> = {
  'P-01': [0.35, 0.72, 1.0], // 玩家：冷蓝，一眼跟敌人分开
  'E-01': [0.52, 0.66, 0.36], // 游荡者：尸绿
  'E-02': [0.78, 0.62, 0.30], // 扑跃者：土黄
  'E-03': [0.62, 0.48, 0.70], // 呕吐者：酸紫
  'E-04': [0.42, 0.52, 0.66], // 盾卫：钢蓝（对应 E-04 shield-guard）
  'E-05': [0.86, 0.36, 0.28], // 爆尸：警戒红
  'B-01': [0.72, 0.24, 0.20], // 屠夫：暗血
  'B-02': [0.55, 0.30, 0.62], // 母体：深紫
  'B-03': [0.90, 0.85, 0.80], // 零号：惨白
};

/** 未登记角色的兜底色（尸绿，与编辑器高亮色系一致） */
const FALLBACK_COLOR: [number, number, number] = [0.56, 0.72, 0.38];

/**
 * LodTier.Proxy 的数值（= 2）。
 *
 * 🔴 不直接 `import { LodTier }`：那是 `const enum`，跨模块引用在 esbuild/vite 的
 * isolatedModules 下不可靠（编译期内联，运行时取不到）。这里用普通常量并对齐注释。
 */
const LOD_TIER_PROXY = 2;


/** 一批实例 + 它对应的实体身份（供选中反查） */
interface BatchSlot {
  poseTransitions?: { data: Float32Array<ArrayBuffer>; revision: number };
  poseSources?: (Float32Array<ArrayBuffer> | null)[];
  meshId: string;
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  /** 蒙皮顶点数据；胶囊代理为 null（core 上传全零 skin slot 占位） */
  skin: { joints: Uint16Array; weights: Float32Array } | null;
  instances: Float32Array<ArrayBuffer>;
  count: number;
  /** 该槽已装配的真模型（null = 胶囊槽）；实例打包要用 paletteBase / flags */
  actor: ActorMesh | null;
  /** 与 instances 行号一一对应的实体视图，选中反查用 */
  entities: EntityView[];
}

export class RuntimeBridge {
  readonly instanceStride = DYNAMIC_INSTANCE_FLOATS;
  private readonly poseTransitions = new PalettePoseTransitions();
  private gait = new Map<string, { x: number; z: number; clip: string; cycles: number }>();
  private presentedPlayerSource: string | null = null;
  get presentedPlayerNodeId(): string | null { return this.presentedPlayerSource; }
  private debugIdentity: Extract<AnimationIdentity, { kind: 'entity' }> | null = null;
  private debugSink: AnimationSink | null = null;
  private debugLast: AnimationSnapshot | null = null;
  /** Independent of viewport selection/highlighting. No batch rebuild or animation control. */
  watchDebug(identity: Extract<AnimationIdentity, { kind: 'entity' }> | null, sink: AnimationSink | null): void {
    this.debugIdentity = identity ? { ...identity } : null; this.debugSink = sink; this.debugLast = null;
  }
  debugSnapshot(): AnimationSnapshot | null {
    return this.debugLast ? structuredClone(this.debugLast) : null;
  }

  /** Suppress only the player proxy whose authored mesh is bound by the host. */
  setPlayerPresentation(nodeId: string | null): void {
    this.presentedPlayerSource = nodeId;
    this.notifyActorsChanged();
  }
  private session: RuntimeSession | null = null;
  /** 真角色装配库（null = 纯胶囊模式，Node 测试 / 资产缺失时） */
  private readonly actors: ActorSource | null;
  /** 按 characterId 分组的批次（网格不同 → 不同 meshId） */
  private readonly slots = new Map<string, BatchSlot>();
  /** LOD 降级是否启用（宿主调过 refreshLod 才算启用，见 refreshLod 注释） */
  private lodEnabled = false;

  /** 当前选中的实体（runId + id + generation 才是操作引用，跨代次必然失效） */
  private selected: { id: number; generation: number; runId: number } | null = null;

  constructor(actors: ActorSource | null = null) {
    this.actors = actors;
  }

  /**
   * 按相机位置刷新 LOD（P4 M4 降级）。转发给会话；会话未建（编辑态）时 no-op。
   *
   * 🔴 必须在 `batches()` **之前**调用 —— 批次是按 lodTier 分流的，顺序反了
   * LOD 会晚一帧生效（200 只压测时这一帧的抖动会污染帧率采样）。
   */
  refreshLod(cameraX: number, cameraZ: number): number {
    // 🔴 调用即视为宿主启用 LOD。未启用的宿主（Node 测试、无相机回路）必须保持
    // 「按 characterId 分组」的旧行为：CharacterTable.alloc 把 lodTier 初始化成
    // Proxy(2)（语义 = 尚未定档），若不看这个开关就分流，所有实体会一上来就退胶囊，
    // 真模型批次的断言全废（2026-10-02 M4 接线时实测踩到）。
    this.lodEnabled = true;
    return this.session?.refreshLod(cameraX, cameraZ) ?? 0;
  }

  get active(): boolean {
    return this.session !== null;
  }

  get currentTick(): number {
    return this.session?.tick ?? 0;
  }

  get entities(): EntityView[] {
    return this.session?.view() ?? [];
  }

  /**
   * 挂接（或摘下）一个会话。
   *
   * **本模块不拥有运行状态** —— 播放/暂停/单步/停止都由 `PlaySession` 管，
   * 这里只认「给我一个世界，我把它翻译成批次」（docs/18 §1.5：每类状态只能有一个 owner）。
   * 传 null 即摘下：批次立刻变空，渲染侧自动跳过 pass 1b。
   */
  attach(session: RuntimeSession | null): void {
    this.debugLast = null; deliver(this.debugSink, null);
    this.session = session;
    this.gait.clear();
    this.poseTransitions.clear();
    for (const s of this.slots.values()) s.entities.length = 0;
    if (session === null) {
      this.presentedPlayerSource = null;
      this.slots.clear();
      this.selected = null;
      return;
    }
    this.selected = null;
    // 会话一挂上就已经刷了第一间房（进入即触发），立刻打包一次：
    // 否则首帧到第一次推进之间画面上是「运行时启动了但一个实体都没有」
    this.rebuildSlots();
  }

  /**
   * 世界推进后必须调一次：实体位置变了，实例数组要重打包。
   *
   * 由 `PlayController` 在 `PlaySession.advance()` / `stepOnce()` 之后调用 ——
   * 不放在 `batches()` 里隐式做，是因为「读批次」不该有推进世界的副作用。
   */
  refresh(): void {
    this.rebuildSlots();
  }

  /** 生成渲染批次。没有会话时返回 null（渲染器据此跳过整段 pass 1b） */
  batches(): CoreDynamicBatch[] | null {
    if (this.session === null || this.slots.size === 0) return null;
    const out: CoreDynamicBatch[] = [];
    for (const s of this.slots.values()) {
      if (s.count <= 0) continue;
      out.push({
        meshId: s.meshId,
        vertices: s.vertices,
        indices: s.indices,
        skin: s.skin,
        albedo: s.actor?.albedo ?? null,
        instances: s.instances,
        count: s.count,
        outline: true,
        ...(s.poseTransitions ? { poseTransitions: s.poseTransitions } : {}),
      });
    }
    return out.length > 0 ? out : null;
  }

  /**
   * ActorLibrary 注册了新角色后调用：作废全部网格槽缓存，让下一次 rebuild
   * 用真模型网格重建（Play 期异步加载完成 → 胶囊原地换真模型）。
   * 只清 CPU 槽位；旧胶囊的 GPU buffer 仍留在 core 的 dynamicMeshes 缓存里
   * （Play 期与真模型并存，几十 KB 一次性开销，Stop 时统一释放）。
   */
  notifyActorsChanged(): void {
    this.slots.clear();
    if (this.session !== null) this.rebuildSlots();
  }

  /**
   * 选中一个实体。身份必须带**运行代次**（`runId + id + generation`）。
   *
   * 只比 `id + generation` 是逻辑身份 —— 它在跨会话里会重复，重跑之后旧引用
   * 会被新世界里同槽位的实体冒名顶替（复审 #6）。所以选中必须三代同检：
   * runId 不一致（来自旧会话 / 旧 reset 的引用）一律拒绝。
   */
  select(id: number, generation: number, runId: number): boolean {
    const v = this.session?.view().find((e) => e.id === id);
    if (v === undefined || v.generation !== generation || v.runId !== runId) return false;
    this.selected = { id, generation, runId };
    this.rebuildSlots();
    return true;
  }

  clearSelection(): void {
    if (this.selected === null) return;
    this.selected = null;
    this.rebuildSlots();
  }

  /**
   * 射线 vs 实体胶囊求交，返回最近命中的实体（null = 没打中）。
   *
   * 用竖直胶囊的解析解（无限圆柱 + 两端球），**不走 GPU 拾取**：动态实体根本不在
   * 静态场景的拾取表里，GPU 拾取也拿不到它们。这是 WU-3 的「最小选择入口」。
   */
  pickRay(
    origin: readonly [number, number, number],
    dir: readonly [number, number, number],
  ): EntityView | null {
    if (this.session === null) return null;
    let best: EntityView | null = null;
    let bestT = Infinity;
    for (const e of this.session.view()) {
      const stats = lookupCharacterStats(e.characterId);
      const r = stats?.capsuleRadius ?? 0.35;
      const h = stats?.capsuleHeight ?? 1.8;
      const t = rayCapsuleY(origin, dir, e.x, e.z, r, h);
      if (t !== null && t < bestT) {
        bestT = t;
        best = e;
      }
    }
    return best;
  }

  get selectedEntity(): EntityView | null {
    if (this.selected === null) return null;
    // 三代同检：runId 变了（重跑 / 换会话），这条引用已经指向旧世界，不能返回
    if (this.session === null || this.session.runId !== this.selected.runId) return null;
    const v = this.session.view().find((e) => e.id === this.selected!.id);
    if (v === undefined || v.generation !== this.selected.generation) return null;
    return v;
  }

  /**
   * 把实体视图按 characterId 分组成实例批次。
   *
   * 装配了真模型的角色用 `actor:<id>` 网格 + 蒙皮实例（flags bit0=1，paletteBase /
   * poseIndex 指向烘焙调色板）；未装配的走胶囊（`capsule:r…:h…`，按体型缓存，
   * 改体型即换 key，core 侧按需上传一次，之后每帧只重传实例数组）。
   */
  private rebuildSlots(): void {
    // 只清实体列表，**不 clear() slots**：网格（vertices/indices）缓存要留着，
    // 否则每帧都要重新 createCapsule —— 那 500 只僵尸的 CPU 开销就全在造网格上了
    for (const s of this.slots.values()) s.entities.length = 0;
    if (this.session === null) return;
    const view = this.session.view();
    // 动画相位的两个输入（M3）：tick 与固定步长都来自会话 —— 纯数据，
    // 不读墙钟，Node 与浏览器逐位一致（docs/20 §5「动画相位 = f(tick)」）
    const tick = this.session.tick;
    const fixedStep = this.session.fixedStep;
    const gaitKeys = new Set<string>();
    const poseKeys = new Set<string>();
    let debugSeen = false;

    for (const e of view) {
      if (e.kind === 'player' && this.presentedPlayerSource !== null && e.sourceNodeId === this.presentedPlayerSource) continue;
      const stats = lookupCharacterStats(e.characterId);
      const radius = stats?.capsuleRadius ?? 0.35;
      const height = stats?.capsuleHeight ?? 1.8;
      // P4 M4 降级：远处（Proxy）实体一律退胶囊 —— 真模型批次的实例数与顶点量
      // 是 200 只压测能不能跑的决定项，而 60m 外的僵尸玩家根本分辨不出模型。
      // 胶囊 key 按**体型**（不是 characterId）：同体型的落同一批，draw call 不涨。
      const capsuleKey = `capsule:r${radius.toFixed(3)}:h${height.toFixed(3)}`;
      const proxy = this.lodEnabled && e.lodTier >= LOD_TIER_PROXY;
      const key = proxy ? capsuleKey : e.characterId;
      let slot = this.slots.get(key);
      if (slot === undefined) {
        const actor = proxy ? null : (this.actors?.get(e.characterId) ?? null);
        if (!proxy && actor === null) this.actors?.request?.(e.characterId);
        if (actor !== null) {
          // 真模型：meshId 换 actor 档，蒙皮数据来自装配库（数组共享，不拷贝）
          slot = {
            meshId: actor.meshId,
            vertices: actor.vertices,
            indices: actor.indices,
            skin: { joints: actor.joints, weights: actor.weights },
            instances: new Float32Array(0),
            count: 0,
            actor,
            entities: [],
          };
        } else {
          // 胶囊代理：中心在原点，总高 = cylinderHeight + 2*radius
          const meshId = `capsule:r${radius.toFixed(3)}:h${height.toFixed(3)}`;
          const mesh = createCapsule(radius, Math.max(0.01, height - 2 * radius), 16, 6);
          slot = {
            meshId,
            vertices: mesh.vertices,
            indices: mesh.indices,
            skin: null,
            instances: new Float32Array(0),
            count: 0,
            actor: null,
            entities: [],
          };
        }
        this.slots.set(key, slot);
      }
      slot.entities.push(e);
    }

    for (const slot of this.slots.values()) {
      const n = slot.entities.length;
      if (slot.instances.length < n * F) slot.instances = new Float32Array(n * F);
      const inst = slot.instances;
      const sel = this.selected;
      for (let i = 0; i < n; i++) {
        const e = slot.entities[i]!;
        const stats = lookupCharacterStats(e.characterId);
        const height = stats?.capsuleHeight ?? 1.8;
        const actor = slot.actor;
        const observing = !!this.debugSink && this.debugIdentity?.id === e.id && this.debugIdentity.generation === e.generation && this.debugIdentity.runId === e.runId;
        if (observing) debugSeen = true;
        let decision: ReturnType<typeof paletteChoice>['decision'] | null = null;
        let clipIndex = -1;
        const o = i * F;
        // 真模型网格贴脚底（feetOffset 把 mesh 最低点抬到 y=0）；胶囊中心在
        // 原点 → 抬到脚底之上半高。实体 (x, z) 才是它站的位置
        inst[o] = e.x;
        inst[o + 1] = actor !== null ? actor.feetOffset : height / 2;
        inst[o + 2] = e.z;
        inst[o + 3] = characterYaw(e.yaw);
        // 网格已按真尺寸生成（胶囊按体型、真模型按资产），缩放恒为 1
        inst[o + 4] = 1;
        inst[o + 5] = 1;
        inst[o + 6] = 1;
        // [7] paletteBase: global matrix offset; [11] is a local pose, [15] its joint stride.
        inst[o + 7] = actor !== null ? actor.paletteBase : 0;
        const base: readonly [number, number, number] = slot.actor?.albedo ? [1, 1, 1] : (PROXY_COLORS[e.characterId] ?? FALLBACK_COLOR);
        // 选中 = 提亮。没有第二套高亮管线，成本最低且不会误伤静态关卡的高亮层。
        // 🔴 必须三代同检：reset() 后 runId 变了，但槽位 id 与 generation 会被复用，
        // 只比后两者的话「旧引用已失效」的实体仍会被画成选中态（视口与 Inspector 打架）。
        // 与 selectedEntity 的判定保持一致，见 PR #3 review。
        const k = sel !== null && sel.runId === e.runId
          && sel.id === e.id && sel.generation === e.generation ? 1.9 : 1;
        const flash = Math.min(1, Math.max(0, e.hitFlash / 0.15));
        inst[o + 8] = base[0] * k * (1 - flash) + flash;
        inst[o + 9] = base[1] * k * (1 - flash) + flash * 0.82;
        inst[o + 10] = base[2] * k * (1 - flash) + flash * 0.55;
        // [11] poseIndex（相对 paletteBase，局部量）：M3 按行为选片 + tick 推相位查表
        //（poseIndexAt 返回本角色 palette 内的下标；shader 端 matrix = base + pose * stride，
        //  与 restPose 同语义）。选不到片（资产改名 / 退化空片）回 bind pose。
        let poseIdx = 0;
        let frameCount = 0;
        let phase01 = 0;
        inst[o + 16] = 1; inst[o + 17] = 0; inst[o + 18] = 0; inst[o + 19] = 0;
        if (actor !== null) {
          // Anchored actors can acquire a chase target while their authored speed
          // remains zero. Their idle motion uses time, not a frozen walking gait.
          const behavior = e.behavior === 1 && stats?.moveSpeed === 0 ? 0 : e.behavior;
          const weapon=e.kind==='player'?this.session.weapons.animation:null;
          const choice = paletteChoice(actor.clips, behavior, weapon, observing);
          const clipIdx = choice.index; clipIndex = clipIdx;
          if (observing) {
            decision = choice.decision!;
            decision.rules.unshift({ id: 'anchor', label: '静止角色行为归一化', matched: e.behavior === 1 && stats?.moveSpeed === 0,
              selected: e.behavior === 1 && stats?.moveSpeed === 0, reason: `原始 behavior=${e.behavior}; 实际 behavior=${behavior}; moveSpeed=${stats?.moveSpeed ?? '未知'}` });
          }
          const clip = clipIdx >= 0 ? actor.clips[clipIdx]! : null;
          phase01 = clip !== null ? animPhase(tick, fixedStep, e.id, clip.durationSec) : 0;
          if (behavior===2) phase01=Math.min(.999,Math.max(0,e.behaviorPhase??0));
          if(weapon && weapon.action!=='idle')phase01=Math.min(.999,weapon.phase);
          const nominal = clip ? actor.motion?.states[clip.name]?.nominalSpeedMps : undefined;
          if (clip && nominal && clip.durationSec > 0 && (!weapon || weapon.action==='idle')) {
            const key = `${e.runId}:${e.id}:${e.generation}`; gaitKeys.add(key);
            const previous = this.gait.get(key);
            const cycles = previous?.clip === clip.name ? previous.cycles + Math.hypot(e.x - previous.x, e.z - previous.z) / (nominal * clip.durationSec) : phase01;
            this.gait.set(key, { x: e.x, z: e.z, clip: clip.name, cycles });
            phase01 = cycles % 1;
          }
          poseIdx = clip !== null ? poseIndexAt(actor.palette, clipIdx, phase01) : actor.restPose;
          frameCount = clip !== null ? clip.frameCount : 0;
          const poseKey = `${e.runId}:${e.id}:${e.generation}`; poseKeys.add(poseKey);
          const transition = this.poseTransitions.sample(poseKey, actor.palette, clipIdx, poseIdx,
            tick * fixedStep, actor.motion?.transitionSec ?? DEFAULT_MOTION_TRANSITION_SEC);
          inst[o + 16] = transition.weight;
          if (transition.from) {
            const stride = actor.palette.jointCount * 16;
            if (!slot.poseTransitions || slot.poseTransitions.data.length < n * stride) {
              slot.poseTransitions = { data: new Float32Array(n * stride), revision: 0 };
              slot.poseSources = [];
            }
            if (slot.poseSources?.[i] !== transition.from) {
              slot.poseTransitions.data.set(transition.from, i * stride);
              slot.poseTransitions.revision++;
            }
            (slot.poseSources ??= [])[i] = transition.from;
            inst[o + 17] = i * actor.palette.jointCount;
          } else if (slot.poseSources) slot.poseSources[i] = null;
        }
        inst[o + 11] = poseIdx;
        // [12..15] clipFrameCount / phase01 / flags / jointStride.
        inst[o + 12] = frameCount;
        inst[o + 13] = phase01;
        inst[o + 14] = actor !== null ? FLAG_SKINNED : 0;
        // Each actor has its own palette stride; 22- and 27-joint rigs coexist.
        inst[o + 15] = actor?.palette.jointCount ?? 0;
        if (observing) {
          const clip = actor?.clips[clipIndex], tr = this.poseTransitions.describe(`${e.runId}:${e.id}:${e.generation}`);
          this.debugLast = { identity: { kind: 'entity', id: e.id, runId: e.runId, generation: e.generation }, label: `${e.characterId} #${e.id}`,
            tick, revision: tr?.revision ?? 0, pipeline: actor ? 'gpu-palette' : 'proxy', status: actor ? 'ready' : 'unavailable',
            decision: decision ?? { requested: '—', actual: '胶囊代理', source: 'proxy', fallback: '未执行骨架动画', actionStamp: '', rules: [] },
            clip: clip ? { name: clip.name, index: clipIndex, time: phase01 * clip.durationSec, duration: clip.durationSec, phase: phase01, loop: null } : null,
            transition: tr?.active ? { from: actor?.clips[tr.fromClip]?.name ?? 'bind pose', to: clip?.name ?? 'bind pose', elapsed: tr.elapsed,
              duration: tr.duration, weight: tr.weight, source: 'palette-matrix-snapshot' } : null,
            ik: noIk('unsupported'), diagnostics: actor ? ['GPU 实例管线不执行身体 IK；调色板为加载时烘焙，未读取 GPU'] : [
              this.lodEnabled && e.lodTier >= LOD_TIER_PROXY ? 'LOD Proxy：未执行骨架动画' : '模型未装配：可能加载中、无 rig 或加载失败；显示胶囊代理',
            ] };
          deliver(this.debugSink, structuredClone(this.debugLast));
        }
      }
      slot.count = n;
    }
    for (const key of this.gait.keys()) if (!gaitKeys.has(key)) this.gait.delete(key);
    this.poseTransitions.prune(poseKeys);
    if (this.debugSink && !debugSeen) { this.debugLast = null; deliver(this.debugSink, null); }
  }
}
