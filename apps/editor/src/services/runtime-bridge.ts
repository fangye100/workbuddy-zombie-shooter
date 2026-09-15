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
 * 代理体（capsule）是**临时可视化**：真模型接进来后这里只换 `meshId` 对应的网格，
 * 批次与身份映射逻辑不动。
 */

import { createCapsule } from '@aether/scene';
import { lookupCharacterStats } from '@aether/content';
import type { RuntimeSession, EntityView } from '@aether/runtime';
import { DYNAMIC_INSTANCE_FLOATS, type CoreDynamicBatch } from '@aether/render';

/** 实例的 CPU 端打包宽度（float），与 CoreDynamicBatch 契约一致 */
const F = DYNAMIC_INSTANCE_FLOATS;

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
 * 射线与「竖直胶囊」求交：脚底在 y=0，轴为 (x, *, z)，总高 h、半径 r。
 * 解析解 = 无限圆柱（xz 平面二次方程）+ 两端半球；返回最近的正向 t，未命中 null。
 */
function rayCapsuleY(
  o: readonly [number, number, number],
  d: readonly [number, number, number],
  cx: number,
  cz: number,
  r: number,
  h: number,
): number | null {
  const y0 = r; // 下半球心
  const y1 = Math.max(r, h - r); // 上半球心
  let best: number | null = null;

  // ---- 圆柱段：xz 平面上的圆求交 ----
  const ox = o[0] - cx;
  const oz = o[2] - cz;
  const a = d[0] * d[0] + d[2] * d[2];
  if (a > 1e-9) {
    const b = 2 * (ox * d[0] + oz * d[2]);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t <= 0) continue;
        const y = o[1] + d[1] * t;
        if (y >= y0 && y <= y1) {
          if (best === null || t < best) best = t;
        }
      }
    }
  }

  // ---- 两端半球 ----
  for (const cy of [y0, y1]) {
    const t = raySphere(o, d, cx, cy, cz, r);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/** 射线与球求交，返回最近的正向 t，未命中 null */
function raySphere(
  o: readonly [number, number, number],
  d: readonly [number, number, number],
  cx: number,
  cy: number,
  cz: number,
  r: number,
): number | null {
  const ex = o[0] - cx;
  const ey = o[1] - cy;
  const ez = o[2] - cz;
  const b = 2 * (ex * d[0] + ey * d[1] + ez * d[2]);
  const c = ex * ex + ey * ey + ez * ez - r * r;
  const disc = b * b - 4 * c; // |d| = 1 → a = 1
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-b - sq) / 2;
  const t1 = (-b + sq) / 2;
  if (t0 > 0) return t0;
  if (t1 > 0) return t1;
  return null;
}

/** 一批实例 + 它对应的实体身份（供选中反查） */
interface BatchSlot {
  meshId: string;
  vertices: Float32Array;
  indices: Uint32Array;
  instances: Float32Array;
  count: number;
  /** 与 instances 行号一一对应的实体视图，选中反查用 */
  entities: EntityView[];
}

export class RuntimeBridge {
  private session: RuntimeSession | null = null;
  /** 按 characterId 分组的批次（网格尺寸不同 → 不同 meshId） */
  private readonly slots = new Map<string, BatchSlot>();

  /** 当前选中的实体（id + generation 才是身份，槽位会复用） */
  private selected: { id: number; generation: number } | null = null;

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
    this.session = session;
    for (const s of this.slots.values()) s.entities.length = 0;
    if (session === null) {
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
        instances: s.instances,
        count: s.count,
        outline: true,
      });
    }
    return out.length > 0 ? out : null;
  }

  /** 用槽位 + generation 选中一个实体；返回是否命中（槽位复用后旧身份必然失效） */
  select(id: number, generation: number): boolean {
    const v = this.session?.view().find((e) => e.id === id);
    if (v === undefined || v.generation !== generation) return false;
    this.selected = { id, generation };
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
    const v = this.session?.view().find((e) => e.id === this.selected!.id);
    if (v === undefined || v.generation !== this.selected.generation) return null;
    return v;
  }

  /**
   * 把实体视图按 characterId 分组成实例批次。
   *
   * 网格按 (radius, height) 生成并缓存：`meshId` 带参数，改体型即换 key，
   * core 侧按需上传一次，之后每帧只重传实例数组。
   */
  private rebuildSlots(): void {
    // 只清实体列表，**不 clear() slots**：网格（vertices/indices）缓存要留着，
    // 否则每帧都要重新 createCapsule —— 那 500 只僵尸的 CPU 开销就全在造网格上了
    for (const s of this.slots.values()) s.entities.length = 0;
    if (this.session === null) return;
    const view = this.session.view();

    for (const e of view) {
      const stats = lookupCharacterStats(e.characterId);
      const radius = stats?.capsuleRadius ?? 0.35;
      const height = stats?.capsuleHeight ?? 1.8;
      const key = e.characterId;
      let slot = this.slots.get(key);
      if (slot === undefined) {
        const meshId = `capsule:r${radius.toFixed(3)}:h${height.toFixed(3)}`;
        // 胶囊中心在原点，总高 = cylinderHeight + 2*radius
        const mesh = createCapsule(radius, Math.max(0.01, height - 2 * radius), 16, 6);
        slot = {
          meshId,
          vertices: mesh.vertices,
          indices: mesh.indices,
          instances: new Float32Array(0),
          count: 0,
          entities: [],
        };
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
        const o = i * F;
        // 胶囊中心在原点 → 抬到脚底之上半高，实体 (x, z) 才是它站的位置
        inst[o] = e.x;
        inst[o + 1] = height / 2;
        inst[o + 2] = e.z;
        inst[o + 3] = e.yaw;
        // 网格已按真尺寸生成，缩放恒为 1（改体型走换 meshId，不走缩放）
        inst[o + 4] = 1;
        inst[o + 5] = 1;
        inst[o + 6] = 1;
        inst[o + 7] = 0;
        const base = PROXY_COLORS[e.characterId] ?? FALLBACK_COLOR;
        // 选中 = 提亮。没有第二套高亮管线，成本最低且不会误伤静态关卡的高亮层
        const k = sel !== null && sel.id === e.id && sel.generation === e.generation ? 1.9 : 1;
        inst[o + 8] = base[0] * k;
        inst[o + 9] = base[1] * k;
        inst[o + 10] = base[2] * k;
        inst[o + 11] = 0;
      }
      slot.count = n;
    }
  }
}
