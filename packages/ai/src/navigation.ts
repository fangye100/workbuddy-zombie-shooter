/**
 * 导航层：Flow Field（群体目标收敛） + SpatialHash（邻居查询） + CrowdSolver（群体避让）。
 *
 * 尸潮场景的核心判断：500 个敌人目标同一个点，逐个跑 A* 是 500 次搜索；
 * 流场一次计算、全体共享，摊薄后单 NPC 的寻路成本 ≈ 一次双线性采样。
 */

export const UNREACHABLE = 0xffff_ffff;

/** 单格代价以 10 为基准单位，对角 14（≈ 10×√2），地表附加代价上限 15 */
const STRAIGHT = 10;
const DIAGONAL = 14;
const MAX_WALK_COST = 15;
/** 桶环大小必须 > 最大单边代价（14 + 15 = 29），取 32 */
const RING = 32;

export const enum CellFlag {
  Open = 0,
  Blocked = 1,
}

/**
 * 设计更正：早期版本曾试图标记"势场局部极小"的死区格子，这是**错的** ——
 * Dijkstra 生成的是真实距离场，除目标外不存在局部极小，该分支永远不会命中。
 *
 * 群体在 U 形凹槽里卡住的真实原因有两个，都不是死区：
 *  ① 路径贴墙 → 用 `bakeClearance()` 把"离墙近"折进代价，路径自然走走廊中线；
 *  ② 拥堵僵持 → 用 CrowdSolver 的 stuck 检测触发 Stagger 分支（见文档 §5.4）。
 */
export const UNREACHABLE_COST = 0xffff;

/**
 * Dial's algorithm（桶环优先队列）。
 * 距离单调递增、边权有界时，出队是 O(1) 摊还，比二叉堆快 3–5 倍。
 */
class DialQueue {
  private readonly buckets: number[][] = [];
  private cursor = 0;
  private base = 0;
  private size = 0;

  constructor() {
    for (let i = 0; i < RING; i++) this.buckets.push([]);
  }

  get length(): number {
    return this.size;
  }

  /** 当前出队元素所对应的距离 */
  get distance(): number {
    return this.base;
  }

  clear(): void {
    for (let i = 0; i < RING; i++) this.buckets[i]!.length = 0;
    this.cursor = 0;
    this.base = 0;
    this.size = 0;
  }

  push(dist: number, node: number): void {
    this.buckets[dist % RING]!.push(node);
    this.size++;
  }

  /** 返回 -1 表示空 */
  pop(): number {
    if (this.size === 0) return -1;
    let guard = 0;
    while (this.buckets[this.cursor]!.length === 0) {
      this.cursor = (this.cursor + 1) % RING;
      this.base++;
      if (++guard > RING) {
        this.size = 0;
        return -1;
      }
    }
    const node = this.buckets[this.cursor]!.pop()!;
    this.size--;
    return node;
  }
}

export interface FlowFieldDesc {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;
}

export interface FlowSample {
  x: number;
  z: number;
  /** 0 = 无效（目标不可达 / 全被墙包围），1 = 方向可信 */
  confidence: number;
}

export class FlowField {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;

  /** 静态代价：1 平地，2–15 泥水/碎石 / 贴墙惩罚，255 墙 */
  readonly cost: Uint8Array;
  readonly flag: Uint8Array;
  /** 到最近障碍的格距（chamfer 距离变换），由 bakeClearance() 填充 */
  readonly clearance: Uint8Array;
  /** 到目标的累积代价（UNREACHABLE = 不可达） */
  readonly integration: Uint32Array;
  readonly flowX: Float32Array;
  readonly flowZ: Float32Array;

  /** 每次重算完成递增，供下游判断缓存失效 */
  version = 0;

  constructor(desc: FlowFieldDesc) {
    this.width = desc.width;
    this.height = desc.height;
    this.cellSize = desc.cellSize;
    this.originX = desc.originX;
    this.originZ = desc.originZ;
    const n = desc.width * desc.height;
    this.cost = new Uint8Array(n).fill(1);
    this.flag = new Uint8Array(n);
    this.clearance = new Uint8Array(n);
    this.integration = new Uint32Array(n).fill(UNREACHABLE);
    this.flowX = new Float32Array(n);
    this.flowZ = new Float32Array(n);
  }

  get cellCount(): number {
    return this.width * this.height;
  }

  index(cx: number, cz: number): number {
    return cz * this.width + cx;
  }

  inBounds(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < this.width && cz < this.height;
  }

  isBlocked(i: number): boolean {
    return this.flag[i] === CellFlag.Blocked;
  }

  /** 障碍或越界都视为高代价，供 steering 的贴墙推力使用 */
  costAtWorld(x: number, z: number): number {
    const i = this.cellIndexAtWorld(x, z);
    if (i < 0 || this.isBlocked(i)) return 255;
    return this.cost[i]!;
  }

  /**
   * Chamfer 距离变换：算出每格到最近障碍的格距。
   * 烘焙期或障碍变动后调用一次，是"路径不贴墙"的基础。
   */
  bakeClearance(maxDist = 8): void {
    const n = this.cellCount;
    const c = this.clearance;
    for (let i = 0; i < n; i++) c[i] = this.isBlocked(i) ? 0 : maxDist;

    for (let cz = 0; cz < this.height; cz++) {
      for (let cx = 0; cx < this.width; cx++) {
        const i = this.index(cx, cz);
        if (c[i] === 0) continue;
        let v = c[i]!;
        if (cx > 0) v = Math.min(v, c[i - 1]! + 1);
        if (cz > 0) v = Math.min(v, c[i - this.width]! + 1);
        if (cx > 0 && cz > 0) v = Math.min(v, c[i - this.width - 1]! + 1);
        if (cx + 1 < this.width && cz > 0) v = Math.min(v, c[i - this.width + 1]! + 1);
        c[i] = v;
      }
    }
    for (let cz = this.height - 1; cz >= 0; cz--) {
      for (let cx = this.width - 1; cx >= 0; cx--) {
        const i = this.index(cx, cz);
        if (c[i] === 0) continue;
        let v = c[i]!;
        if (cx + 1 < this.width) v = Math.min(v, c[i + 1]! + 1);
        if (cz + 1 < this.height) v = Math.min(v, c[i + this.width]! + 1);
        if (cx + 1 < this.width && cz + 1 < this.height) v = Math.min(v, c[i + this.width + 1]! + 1);
        if (cx > 0 && cz + 1 < this.height) v = Math.min(v, c[i + this.width - 1]! + 1);
        c[i] = v;
      }
    }
  }

  /**
   * 把 clearance 折进静态代价：离墙 margin 格以内的格子代价升高，
   * 于是最短路自然走走廊中线而不是贴着墙角 —— 这才是解决"U 形凹槽里挤成一团"的正解。
   */
  applyClearanceToCost(margin = 2, penalty = 3): void {
    for (let i = 0; i < this.cellCount; i++) {
      if (this.isBlocked(i)) continue;
      const gap = margin - this.clearance[i]!;
      const extra = gap > 0 ? gap * penalty : 0;
      this.cost[i] = Math.max(1, Math.min(MAX_WALK_COST, 1 + this.cost[i]! + extra));
    }
  }

  /** 世界坐标 → 格索引；越界返回 -1 */
  cellIndexAtWorld(x: number, z: number): number {
    const cx = Math.floor((x - this.originX) / this.cellSize);
    const cz = Math.floor((z - this.originZ) / this.cellSize);
    if (!this.inBounds(cx, cz)) return -1;
    return this.index(cx, cz);
  }

  /** 格索引 → 格心的世界坐标（写入 out） */
  cellCenter(i: number, out: { x: number; z: number }): void {
    const cx = i % this.width;
    const cz = (i - cx) / this.width;
    out.x = this.originX + (cx + 0.5) * this.cellSize;
    out.z = this.originZ + (cz + 0.5) * this.cellSize;
  }

  setBlocked(cx: number, cz: number, blocked: boolean): void {
    if (!this.inBounds(cx, cz)) return;
    const i = this.index(cx, cz);
    this.flag[i] = blocked ? CellFlag.Blocked : CellFlag.Open;
  }

  setCost(cx: number, cz: number, cost: number): void {
    if (!this.inBounds(cx, cz)) return;
    this.cost[this.index(cx, cz)] = Math.max(1, Math.min(MAX_WALK_COST, cost | 0));
  }

  /**
   * 双线性采样流向。被墙完全包围或不可达时 confidence = 0，
   * 调用方应退化为"朝目标直连 + 墙避射线"。
   */
  sampleFlow(x: number, z: number, out: FlowSample): boolean {
    const fx = (x - this.originX) / this.cellSize - 0.5;
    const fz = (z - this.originZ) / this.cellSize - 0.5;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;

    let sx = 0;
    let sz = 0;
    let w = 0;
    for (let dz = 0; dz <= 1; dz++) {
      for (let dx = 0; dx <= 1; dx++) {
        const cx = x0 + dx;
        const cz = z0 + dz;
        if (!this.inBounds(cx, cz)) continue;
        const i = this.index(cx, cz);
        if (this.isBlocked(i) || this.integration[i] === UNREACHABLE) continue;
        const weight = (dx === 0 ? 1 - tx : tx) * (dz === 0 ? 1 - tz : tz);
        if (weight <= 0) continue;
        sx += this.flowX[i]! * weight;
        sz += this.flowZ[i]! * weight;
        w += weight;
      }
    }

    out.x = 0;
    out.z = 0;
    out.confidence = 0;
    if (w <= 0) return false;

    sx /= w;
    sz /= w;
    const len = Math.hypot(sx, sz);
    if (len < 1e-5) return false;

    out.x = sx / len;
    out.z = sz / len;
    out.confidence = w;
    return true;
  }
}

/**
 * 流场积分器。**可跨帧恢复**：`step()` 每次只处理有限个格子，
 * 主线程不会被 16k 格的 Dijkstra 卡住；整套场跑完后一次性构建流向。
 */
export class FlowFieldIntegrator {
  private readonly dist: Uint32Array;
  private readonly queue = new DialQueue();
  private running = false;
  private stale = true;
  private goal = -1;

  constructor(private readonly field: FlowField) {
    this.dist = new Uint32Array(field.cellCount);
  }

  setGoal(x: number, z: number): boolean {
    const idx = this.field.cellIndexAtWorld(x, z);
    if (idx < 0 || this.field.isBlocked(idx)) return false;
    if (idx !== this.goal) {
      this.goal = idx;
      this.stale = true;
      this.running = false;
    }
    return true;
  }

  /** 地形或障碍变动后调用 */
  invalidate(): void {
    this.stale = true;
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 推进积分。返回 true 表示本帧完成了整场重算（此时 field.version 已递增）。
   * cellBudget 建议 2048 —— 约 0.4ms/帧，4 帧内收敛 128×128 全图。
   */
  step(cellBudget: number): boolean {
    if (this.stale && !this.running) {
      this.reset();
    }
    if (!this.running) return false;

    let processed = 0;
    while (this.queue.length > 0 && processed < cellBudget) {
      const cell = this.queue.pop();
      if (cell < 0) break;
      const d = this.queue.distance;
      // 惰性删除：该格已有更优距离，本次出队作废
      if (this.dist[cell]! !== d) continue;
      this.relax(cell, d);
      processed++;
    }

    if (this.queue.length === 0) {
      this.finish();
      return true;
    }
    return false;
  }

  private reset(): void {
    this.dist.fill(UNREACHABLE);
    this.queue.clear();
    this.dist[this.goal] = 0;
    this.queue.push(0, this.goal);
    this.stale = false;
    this.running = true;
  }

  private relax(cell: number, d: number): void {
    const cx = cell % this.field.width;
    const cz = (cell - cx) / this.field.width;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (!this.field.inBounds(nx, nz)) continue;
        const n = this.field.index(nx, nz);
        if (this.field.isBlocked(n)) continue;

        const diagonal = dx !== 0 && dz !== 0;
        // 禁止贴角穿越：对角线两侧任意一格是墙就不允许
        if (diagonal) {
          const a = this.field.index(cx + dx, cz);
          const b = this.field.index(cx, cz + dz);
          if (this.field.isBlocked(a) || this.field.isBlocked(b)) continue;
        }

        const weight =
          (diagonal ? DIAGONAL : STRAIGHT) +
          Math.min(MAX_WALK_COST, Math.max(1, this.field.cost[n]!)) -
          1;

        const nd = d + weight;
        if (nd < this.dist[n]!) {
          this.dist[n] = nd;
          this.queue.push(nd, n);
        }
      }
    }
  }

  private finish(): void {
    const f = this.field;
    f.integration.set(this.dist);

    for (let cz = 0; cz < f.height; cz++) {
      for (let cx = 0; cx < f.width; cx++) {
        const i = f.index(cx, cz);
        if (f.isBlocked(i) || f.integration[i] === UNREACHABLE) {
          f.flowX[i] = 0;
          f.flowZ[i] = 0;
          continue;
        }

        let best = f.integration[i]!;
        let bx = 0;
        let bz = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = cx + dx;
            const nz = cz + dz;
            if (!f.inBounds(nx, nz)) continue;
            const n = f.index(nx, nz);
            if (f.isBlocked(n)) continue;
            if (diagonalBlocked(f, cx, cz, dx, dz)) continue;
            const v = f.integration[n]!;
            if (v < best) {
              best = v;
              bx = dx;
              bz = dz;
            }
          }
        }

        if (bx === 0 && bz === 0) {
          // 只有目标格本身允许没有更低的邻居；其余情况要么是孤立格，
          // 要么四周全是墙 —— 一律给零向量，由 steering 退化为墙避射线
          f.flowX[i] = 0;
          f.flowZ[i] = 0;
        } else {
          const len = Math.hypot(bx, bz);
          f.flowX[i] = bx / len;
          f.flowZ[i] = bz / len;
        }
      }
    }

    f.version++;
    this.running = false;
  }
}

function diagonalBlocked(f: FlowField, cx: number, cz: number, dx: number, dz: number): boolean {
  if (dx === 0 || dz === 0) return false;
  return f.isBlocked(f.index(cx + dx, cz)) || f.isBlocked(f.index(cx, cz + dz));
}

/**
 * 计数排序空间哈希。邻居查询是群体避让里唯一的热点，
 * 用 counting sort 一次建成，查询期零分配。
 */
export class SpatialHash {
  private readonly cols: number;
  private readonly rows: number;
  private readonly cellSize: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly start: Int32Array;
  private readonly cursor: Int32Array;
  private readonly items: Int32Array;

  constructor(minX: number, minZ: number, maxX: number, maxZ: number, cellSize: number, capacity: number) {
    this.minX = minX;
    this.minZ = minZ;
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    this.rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
    this.start = new Int32Array(this.cols * this.rows + 1);
    this.cursor = new Int32Array(this.cols * this.rows);
    this.items = new Int32Array(capacity);
  }

  private cellOf(x: number, z: number): number {
    let cx = ((x - this.minX) / this.cellSize) | 0;
    let cz = ((z - this.minZ) / this.cellSize) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.rows) cz = this.rows - 1;
    return cz * this.cols + cx;
  }

  build(posX: Float32Array, posZ: Float32Array, count: number): void {
    const cells = this.cols * this.rows;
    this.start.fill(0);
    this.cursor.fill(0);

    for (let i = 0; i < count; i++) {
      const slot = this.cellOf(posX[i]!, posZ[i]!) + 1;
      this.start[slot] = this.start[slot]! + 1;
    }
    for (let c = 0; c < cells; c++) {
      this.start[c + 1] = this.start[c + 1]! + this.start[c]!;
    }
    for (let i = 0; i < count; i++) {
      const c = this.cellOf(posX[i]!, posZ[i]!);
      this.items[this.start[c]! + this.cursor[c]!] = i;
      this.cursor[c] = this.cursor[c]! + 1;
    }
  }

  /** 查询 3×3 邻域内的候选索引，写入 out，返回数量 */
  query(x: number, z: number, out: Int32Array): number {
    const cx = ((x - this.minX) / this.cellSize) | 0;
    const cz = ((z - this.minZ) / this.cellSize) | 0;
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) {
      const gz = cz + dz;
      if (gz < 0 || gz >= this.rows) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx;
        if (gx < 0 || gx >= this.cols) continue;
        const c = gz * this.cols + gx;
        const s = this.start[c]!;
        const e = this.start[c + 1]!;
        for (let k = s; k < e; k++) {
          if (n >= out.length) return n;
          out[n++] = this.items[k]!;
        }
      }
    }
    return n;
  }
}

export interface CrowdBuffers {
  count: number;
  posX: Float32Array;
  posZ: Float32Array;
  velX: Float32Array;
  velZ: Float32Array;
  radius: Float32Array;
  maxSpeed: Float32Array;
  /** 词条 / 状态对速度的缩放（0 = 定身） */
  speedScale: Float32Array;
  /** 破对称：±1，由 entity index 决定，让两只 NPC 总是往同一侧错身 */
  dodgeBias: Int8Array;
  outX: Float32Array;
  outZ: Float32Array;
  /** 输出：僵持判定窗口内的 tick 计数、参考位置与僵持标记 */
  stuckTicks: Uint16Array;
  stuckRefX: Float32Array;
  stuckRefZ: Float32Array;
  stuck: Uint8Array;
}

export interface CrowdParams {
  separationWeight: number;
  maxNeighbors: number;
  /** 贴墙推力：沿 cost 场梯度推离高代价格，避免糊在墙上 */
  wallPush: number;
  /** 侧向破对称扰动 */
  jitter: number;
  acceleration: number;
  dt: number;
  /** 僵持判定窗口（秒） */
  stuckWindowSeconds: number;
  /**
   * 窗口内**净位移 / 期望位移**低于这个比例 → stuck[i] = 1，上层应转 Stagger 分支。
   *
   * 注意：不能用"当前速度大小"来判僵持。被墙推力推得来回震荡的 agent 瞬时速度可以很高，
   * 但位移几乎为零 —— 只有净位移才抓得住这种"原地抖动"。
   */
  stuckProgressRatio: number;
}

/**
 * 群体避让。**刻意不做完整 ORCA** —— 500 实体下求解太贵，
 * 而且尸潮里"像流体一样挤过来"比"完美互不重叠"更有压迫感。
 */
export class CrowdSolver {
  private readonly hash: SpatialHash;
  private readonly near = new Int32Array(64);
  private readonly sample: FlowSample = { x: 0, z: 0, confidence: 0 };

  constructor(minX: number, minZ: number, maxX: number, maxZ: number, cellSize: number, capacity: number) {
    this.hash = new SpatialHash(minX, minZ, maxX, maxZ, cellSize, capacity);
  }

  solve(b: CrowdBuffers, field: FlowField, p: CrowdParams): void {
    this.hash.build(b.posX, b.posZ, b.count);
    const maxStep = p.acceleration * p.dt;
    const windowTicks = Math.max(1, Math.round(p.stuckWindowSeconds / p.dt));

    for (let i = 0; i < b.count; i++) {
      const x = b.posX[i]!;
      const z = b.posZ[i]!;
      const r = b.radius[i]!;
      const speed = b.maxSpeed[i]! * b.speedScale[i]!;

      const ok = field.sampleFlow(x, z, this.sample);
      let fx = ok ? this.sample.x : 0;
      let fz = ok ? this.sample.z : 0;

      // 贴墙推力：对 cost 场做 4 抽样梯度，往代价更低的方向推
      const cs = field.cellSize;
      const cRight = field.costAtWorld(x + cs, z);
      const cLeft = field.costAtWorld(x - cs, z);
      const cFwd = field.costAtWorld(x, z + cs);
      const cBack = field.costAtWorld(x, z - cs);
      fx += (cLeft - cRight) * p.wallPush;
      fz += (cBack - cFwd) * p.wallPush;

      // 邻居分离力（只取最近若干，避免 O(n²)）
      let sx = 0;
      let sz = 0;
      const n = this.hash.query(x, z, this.near);
      let used = 0;
      for (let k = 0; k < n && used < p.maxNeighbors; k++) {
        const j = this.near[k]!;
        if (j === i) continue;
        const dx = x - b.posX[j]!;
        const dz = z - b.posZ[j]!;
        const distSq = dx * dx + dz * dz;
        const rr = r + b.radius[j]!;
        if (distSq >= rr * rr || distSq < 1e-6) continue;
        const dist = Math.sqrt(distSq);
        const push = (rr - dist) / rr;
        sx += (dx / dist) * push;
        sz += (dz / dist) * push;
        used++;
      }

      // 破对称：始终给一个固定的微小侧向偏置，防止正面僵持
      const bias = b.dodgeBias[i]! * p.jitter;
      const px = -fz * bias;
      const pz = fx * bias;

      let dx = fx * speed + sx * p.separationWeight + px;
      let dz = fz * speed + sz * p.separationWeight + pz;

      const len = Math.hypot(dx, dz);
      if (len > speed && len > 1e-5) {
        dx = (dx / len) * speed;
        dz = (dz / len) * speed;
      }

      // 加速度限速，避免瞬时变向导致的抖动
      const curX = b.velX[i]!;
      const curZ = b.velZ[i]!;
      let stepX = dx - curX;
      let stepZ = dz - curZ;
      const stepLen = Math.hypot(stepX, stepZ);
      if (stepLen > maxStep && stepLen > 1e-5) {
        stepX = (stepX / stepLen) * maxStep;
        stepZ = (stepZ / stepLen) * maxStep;
      }

      b.outX[i] = curX + stepX;
      b.outZ[i] = curZ + stepZ;

      // 僵持检测：被挤住 / 卡在几何缝里 → 交给上层转 Stagger（播推挤动画 + 临时缩小碰撞半径）
      const ticks = b.stuckTicks[i]! + 1;
      if (ticks >= windowTicks) {
        const dxp = x - b.stuckRefX[i]!;
        const dzp = z - b.stuckRefZ[i]!;
        const moved = Math.hypot(dxp, dzp);
        const expected = Math.abs(speed) * p.stuckWindowSeconds;
        b.stuck[i] = expected > 1e-3 && moved < expected * p.stuckProgressRatio ? 1 : 0;
        b.stuckTicks[i] = 0;
        b.stuckRefX[i] = x;
        b.stuckRefZ[i] = z;
      } else {
        b.stuckTicks[i] = ticks;
      }
    }
  }
}
