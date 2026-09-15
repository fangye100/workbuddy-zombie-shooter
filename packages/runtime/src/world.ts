/**
 * World —— headless 游戏世界（SoA 存储 + 固定步长 tick）。
 *
 * ## 为什么用 SoA 而不是对象数组
 * GDD 的尸潮主题僵尸数 ×2，单波 20+、同屏上百。AoS（每个实体一个对象）在这种量级
 * 下缓存命中率与 GC 压力都不划算，且后面要做 instancing / 批处理时，SoA 的
 * Float32Array 可以直接喂给 GPU。ADR-011 已定此方向，这里从一开始就按 SoA 写，
 * 避免"先 AoS 再重写"。
 *
 * ## 设计约束
 * - **零 GPU、零 DOM**：可在 vitest / node 里直接跑。
 * - **确定性**：随机只来自注入的 RNG（种子固定 → 结果可复现 → 可写断言、可防回归）。
 * - **固定步长**：tick(dt) 由调用方驱动，不做真实时间采样（回放与测试都需要可控步长）。
 */
import { AgentKind, type AgentView, type CharacterStats, type SpawnRequest } from './types';

/** 线性同余伪随机。固定种子 → 完全可复现的散布，是写断言的前提 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface WorldOptions {
  /** 实体容量上限。超过 spawn 会抛（不静默丢弃） */
  capacity?: number;
  /** 分离强度：相邻实体互推的力度，0 = 关闭 */
  separation?: number;
}

export class World {
  readonly capacity: number;

  // ---- SoA 列 ----
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  /** 个体最大速度（米/秒） */
  readonly speed: Float32Array;
  readonly radius: Float32Array;
  readonly yaw: Float32Array;
  readonly kind: Uint8Array;
  readonly alive: Uint8Array;
  /** characterId 回查表（SoA 存不了字符串，用并列数组） */
  readonly characterId: string[];
  /** 身高，导出快照时决定胶囊尺寸 */
  readonly height: Float32Array;

  private n = 0;
  private readonly separation: number;

  constructor(opts: WorldOptions = {}) {
    this.capacity = opts.capacity ?? 512;
    this.separation = opts.separation ?? 1.0;
    const c = this.capacity;
    this.x = new Float32Array(c);
    this.z = new Float32Array(c);
    this.vx = new Float32Array(c);
    this.vz = new Float32Array(c);
    this.speed = new Float32Array(c);
    this.radius = new Float32Array(c);
    this.yaw = new Float32Array(c);
    this.kind = new Uint8Array(c);
    this.alive = new Uint8Array(c);
    this.height = new Float32Array(c);
    this.characterId = new Array<string>(c).fill('');
  }

  get size(): number {
    return this.n;
  }

  private alloc(): number {
    if (this.n >= this.capacity) {
      throw new Error(`World 容量已满（${this.capacity}）；spawn 前先确认投放量`);
    }
    return this.n++;
  }

  /** 放一个玩家（追击目标）。返回下标 */
  addPlayer(x: number, z: number, stats: CharacterStats): number {
    const i = this.alloc();
    this.x[i] = x;
    this.z[i] = z;
    this.vx[i] = 0;
    this.vz[i] = 0;
    this.speed[i] = stats.speed;
    this.radius[i] = stats.radius;
    this.height[i] = stats.height;
    this.yaw[i] = 0;
    this.kind[i] = AgentKind.Player;
    this.alive[i] = 1;
    this.characterId[i] = stats.id;
    return i;
  }

  /**
   * 按 SpawnRequest 生成一群实体，在 spread 半径内散布。
   * 散布用注入的 RNG —— 同种子必然得到同一批坐标。
   */
  spawn(req: SpawnRequest, rng: () => number): number {
    let spawned = 0;
    for (let k = 0; k < req.count; k++) {
      const i = this.alloc();
      // 圆内均匀取点：半径乘 sqrt(u) 否则会向圆心堆积
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * req.spread;
      this.x[i] = req.x + Math.cos(ang) * r;
      this.z[i] = req.z + Math.sin(ang) * r;
      this.vx[i] = 0;
      this.vz[i] = 0;
      this.speed[i] = req.stats.speed;
      this.radius[i] = req.stats.radius;
      this.height[i] = req.stats.height;
      this.yaw[i] = ang;
      this.kind[i] = AgentKind.Zombie;
      this.alive[i] = 1;
      this.characterId[i] = req.characterId;
      spawned++;
    }
    return spawned;
  }

  /** 推进一个固定步长。dt 单位秒 */
  tick(dt: number): void {
    const n = this.n;

    // ---- 1. 追击：每个僵尸朝最近的存活玩家移动 ----
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1 || this.kind[i] !== AgentKind.Zombie) continue;

      let tx = 0;
      let tz = 0;
      let best = Infinity;
      for (let p = 0; p < n; p++) {
        if (this.alive[p] !== 1 || this.kind[p] !== AgentKind.Player) continue;
        const dx = this.x[p]! - this.x[i]!;
        const dz = this.z[p]! - this.z[i]!;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) {
          best = d2;
          tx = dx;
          tz = dz;
        }
      }
      if (best === Infinity) {
        this.vx[i] = 0;
        this.vz[i] = 0;
        continue;
      }

      const dist = Math.sqrt(best);
      if (dist > 1e-4) {
        const sp = this.speed[i]!;
        this.vx[i] = (tx / dist) * sp;
        this.vz[i] = (tz / dist) * sp;
        this.yaw[i] = Math.atan2(tz, tx);
      } else {
        this.vx[i] = 0;
        this.vz[i] = 0;
      }
    }

    // ---- 2. 分离：重叠的僵尸互推，避免叠在一点 ----
    // O(n²)。切片规模（几十）够用；上到 500 僵尸前必须换成空间网格
    // （均匀网格 / 空间哈希），否则每帧 25 万次距离计算会拖垮 tick。
    if (this.separation > 0) {
      for (let i = 0; i < n; i++) {
        if (this.alive[i] !== 1 || this.kind[i] !== AgentKind.Zombie) continue;
        for (let j = i + 1; j < n; j++) {
          if (this.alive[j] !== 1 || this.kind[j] !== AgentKind.Zombie) continue;
          const dx = this.x[j]! - this.x[i]!;
          const dz = this.z[j]! - this.z[i]!;
          const minD = this.radius[i]! + this.radius[j]!;
          const d2 = dx * dx + dz * dz;
          if (d2 >= minD * minD || d2 < 1e-8) continue;
          const d = Math.sqrt(d2);
          const push = ((minD - d) / d) * 0.5 * this.separation;
          const px = dx * push;
          const pz = dz * push;
          this.x[i]! -= px;
          this.z[i]! -= pz;
          this.x[j]! += px;
          this.z[j]! += pz;
        }
      }
    }

    // ---- 3. 积分 ----
    for (let i = 0; i < n; i++) {
      if (this.alive[i] !== 1) continue;
      if (this.kind[i] === AgentKind.Player) continue; // 切片阶段玩家不动
      this.x[i]! += this.vx[i]! * dt;
      this.z[i]! += this.vz[i]! * dt;
    }
  }

  /** 导出某个实体的只读视图（给快照序列化用） */
  view(i: number): AgentView {
    return {
      index: i,
      kind: this.kind[i]! as AgentKind,
      characterId: this.characterId[i] ?? '',
      x: this.x[i]!,
      z: this.z[i]!,
      yaw: this.yaw[i]!,
      radius: this.radius[i]!,
      height: this.height[i]!,
      alive: this.alive[i] === 1,
    };
  }

  /** 全部存活实体的视图。导出快照与写断言都走这里 */
  snapshot(): AgentView[] {
    const out: AgentView[] = [];
    for (let i = 0; i < this.n; i++) {
      if (this.alive[i] === 1) out.push(this.view(i));
    }
    return out;
  }
}
