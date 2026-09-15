/**
 * RuntimeSession —— 可控运行会话（WU-1c + WU-2）。
 *
 * ## 它取代了什么
 *
 * 早期的 `World` 是自己写的 SoA + 直线追击 + O(n²) 分离。那份实现有三个硬伤：
 *   1. 身份只有数组下标，槽位复用后旧引用会命中新实体；
 *   2. 分离是 O(n²)，上到几百只就废；
 *   3. **完全无视障碍** —— 僵尸会直接穿过掩体，而"朝玩家距离变小"看起来仍然正确。
 * 三者分别由 `CharacterTable`（generation 身份 + 池化）、`SpatialHash`、`FlowField`
 * 解决，全都是仓库里已有的纯 CPU 实现（取舍见 docs/18 §1）。
 *
 * ## 确定性
 *
 * 随机只来自构造时注入的种子。同一个（运行描述 + 种子 + 固定步长 + tick 数）
 * 必然得到同样的结果 —— 这是能写断言、能 A/B 对比的前提。
 * 不做真实时间采样：tick 由调用方驱动。
 *
 * ## 本轮的显式缺口（不是完成项）
 *
 * - 玩家不移动（无输入驱动）。输入序列属 WU-2 后半，本轮先固定。
 * - 无战斗、无死亡，敌人生成后不会消失。
 * - "进入房间"用矩形 bounds 包含玩家中心点判定，不用 Collider 触发器事件。
 */

import { CharacterTable } from '@aether/gameplay';
import { CrowdSolver, FlowField, FlowFieldIntegrator } from '@aether/ai';
import type { CrowdBuffers, CrowdParams } from '@aether/ai';
import { NPC_STATS, PLAYER_STATS, lookupCharacterStats } from '@aether/content';
import type { CharacterStatsEntry } from '@aether/content';
import type { NodeId } from '@aether/scene';
import type { LevelRuntimeDesc, LoadDiagnostic } from './loader';

/** 线性同余伪随机。固定种子 → 完全可复现的散布 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 把「会话种子 + 一个字符串身份」混成一颗派生种子（FNV-1a）。
 *
 * 用途见 `spawnBatch`：每个刷怪点用自己的派生流取点，而不是全场景共用一条。
 * 混入 session 种子而不是只用字符串哈希，是为了让"换种子重跑"仍然整体改变散布 ——
 * 否则无论 session 种子是多少，同一份场景的刷怪位置永远一模一样。
 */
export function mixSeed(seed: number, key: string): number {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0 || 1;
}

export interface SessionOptions {
  desc: LevelRuntimeDesc;
  seed?: number;
  /** 固定步长（秒）。渲染帧率不决定游戏步数 */
  fixedStep?: number;
  /** 实体容量上限。超过则整批拒绝（原子性） */
  capacity?: number;
}

export type EntityKind = 'player' | 'npc';

/** 单个实体的查询视图。id + generation 共同构成跨会话安全的身份 */
export interface EntityView {
  /** CharacterTable 槽位。数组下标**不是**身份，必须配 generation 用 */
  id: number;
  generation: number;
  characterId: string;
  kind: EntityKind;
  x: number;
  z: number;
  yaw: number;
  alive: boolean;
  /** 来源作者节点（刷怪点 / 玩家起点）。一处刷怪点可生成多个实体，两者不是同一个 ID */
  sourceNodeId: NodeId | null;
  /** 当前目标实体槽位；-1 = 无目标 */
  targetId: number;
  /** 行为状态。0 = idle，1 = chase */
  behavior: number;
}

/** 一次推进的结果摘要。拒绝是显式的，不藏在返回值里 */
export interface StepReport {
  tick: number;
  /** 本步新生成的实体数 */
  spawned: number;
  /** 本步因容量不足被整批拒绝的房间数 */
  rejectedRooms: number;
}

const BEHAVIOR_IDLE = 0;
const BEHAVIOR_CHASE = 1;

export class RuntimeSession {
  private tbl: CharacterTable;

  /** 实体状态表。唯一权威（docs/18 §1.5）—— 不要在别处再维护第二张 */
  get table(): CharacterTable {
    return this.tbl;
  }

  readonly desc: LevelRuntimeDesc;
  readonly seed: number;
  readonly fixedStep: number;

  private readonly field: FlowField;
  private readonly integrator: FlowFieldIntegrator;
  private readonly solver: CrowdSolver;
  private readonly buffers: CrowdBuffers;
  private readonly params: CrowdParams;
  /** 刷怪随机流的根种子。reset() 之后仍然用它派生，保证"同种子重跑" */
  private readonly initialSeed: number;

  /** 已触发过的房间。防"再次跨越边界重复投放同一波" */
  private readonly triggered = new Set<NodeId>();
  /** 按槽位记录来源作者节点 */
  private readonly sourceOf: (NodeId | null)[];
  private readonly kindOf: Uint8Array;
  private readonly defIdToStats = new Map<number, CharacterStatsEntry>();

  private playerId = -1;
  private tickCount = 0;
  private readonly capacity: number;

  constructor(opts: SessionOptions) {
    this.desc = opts.desc;
    this.seed = opts.seed ?? 1;
    this.initialSeed = this.seed;
    this.fixedStep = opts.fixedStep ?? 1 / 30;
    const capacity = opts.capacity ?? 512;
    this.capacity = capacity;

    this.tbl = new CharacterTable(this.capacity);
    this.sourceOf = new Array<NodeId | null>(capacity).fill(null);
    this.kindOf = new Uint8Array(capacity);

    for (const s of [...NPC_STATS, PLAYER_STATS]) {
      this.defIdToStats.set(s.defId, s);
    }

    // ---- 导航场 ----
    const nav = opts.desc.nav;
    if (nav === null) {
      // loader 已经拦过一次；这里再挡一次是因为 Session 也可以被直接构造
      throw new Error('运行描述缺少 NavZone，无法建立导航场');
    }
    const cs = nav.cellSize;
    this.field = new FlowField({
      width: Math.max(1, Math.ceil((nav.maxX - nav.minX) / cs)),
      height: Math.max(1, Math.ceil((nav.maxZ - nav.minZ) / cs)),
      cellSize: cs,
      originX: nav.minX,
      originZ: nav.minZ,
    });
    this.bakeObstacles();
    this.field.bakeClearance(8);
    this.field.applyClearanceToCost(2, 3);

    this.integrator = new FlowFieldIntegrator(this.field);
    // 玩家本轮固定不动 → 目标恒定 → 流场只需算一次
    this.integrator.setGoal(opts.desc.playerStart.x, opts.desc.playerStart.z);
    this.integrator.step(this.field.cellCount);

    this.solver = new CrowdSolver(nav.minX, nav.minZ, nav.maxX, nav.maxZ, cs * 2, capacity);
    this.buffers = {
      count: 0,
      posX: new Float32Array(capacity),
      posZ: new Float32Array(capacity),
      velX: new Float32Array(capacity),
      velZ: new Float32Array(capacity),
      radius: new Float32Array(capacity),
      maxSpeed: new Float32Array(capacity),
      speedScale: new Float32Array(capacity),
      dodgeBias: new Int8Array(capacity),
      outX: new Float32Array(capacity),
      outZ: new Float32Array(capacity),
      stuckTicks: new Uint16Array(capacity),
      stuckRefX: new Float32Array(capacity),
      stuckRefZ: new Float32Array(capacity),
      stuck: new Uint8Array(capacity),
    };
    this.params = {
      separationWeight: 1.2,
      maxNeighbors: 8,
      wallPush: 0.02,
      jitter: 0.05,
      acceleration: 8,
      dt: this.fixedStep,
      stuckWindowSeconds: 0.5,
      stuckProgressRatio: 0.15,
    };

    this.spawnPlayer();
    // 玩家出生所在房间应当立即触发（他就站在里面）
    this.triggerRooms();
  }

  // ------------------------------------------------------------ 查询

  get tick(): number {
    return this.tickCount;
  }

  get playerEntityId(): number {
    return this.playerId;
  }

  /** 存活实体的视图。CLI 指标、渲染 Bridge、断言都从这里取 */
  view(): EntityView[] {
    const out: EntityView[] = [];
    for (let i = 0; i < this.table.capacity; i++) {
      if (!this.table.isAlive(i)) continue;
      const stats = this.defIdToStats.get(this.table.defId[i]!);
      out.push({
        id: i,
        generation: this.table.generation[i]!,
        characterId: stats?.id ?? '?',
        kind: this.kindOf[i] === 0 ? 'player' : 'npc',
        x: this.table.posX[i]!,
        z: this.table.posZ[i]!,
        yaw: this.table.yaw[i]!,
        alive: true,
        sourceNodeId: this.sourceOf[i] ?? null,
        targetId: this.table.targetEntity[i]!,
        behavior: this.table.behavior[i]!,
      });
    }
    return out;
  }

  countNpc(): number {
    let n = 0;
    for (let i = 0; i < this.table.capacity; i++) {
      if (this.table.isAlive(i) && this.kindOf[i] === 1) n++;
    }
    return n;
  }

  /** 已触发的房间（供断言"没重复投放"） */
  triggeredRooms(): NodeId[] {
    return [...this.triggered];
  }

  // ------------------------------------------------------------ 推进

  /** 推进一个固定步。**不读墙钟**，浏览器宿主要自己用累加器调度 */
  step(): StepReport {
    this.triggerRooms();
    this.moveNpcs();
    this.tickCount += 1;
    return { tick: this.tickCount, spawned: 0, rejectedRooms: 0 };
  }

  run(ticks: number): StepReport[] {
    const out: StepReport[] = [];
    for (let i = 0; i < ticks; i++) out.push(this.step());
    return out;
  }

  /**
   * 回到初始状态（同种子重跑）。
   *
   * 完整存档恢复与任意时刻倒放暂缓（docs/17 §5.1）；本轮 Reset = 用同一个种子
   * 重建初始世界，比较实验靠"从初始状态重放"。
   */
  reset(): void {
    // **整表重建而不是逐个 destroy**。destroy 是把槽位推回 freelist（LIFO），
    // 回收顺序反过来会让下一轮分配到完全不同的槽位 —— 于是"同种子重跑"
    // 实体集合一致、槽位却不一样，调试和断言都对不上。重建才真正回到初始态。
    this.tbl = new CharacterTable(this.capacity);
    this.sourceOf.fill(null);
    this.kindOf.fill(0);
    this.triggered.clear();
    this.tickCount = 0;
    // 刷怪随机流由 initialSeed ⊗ nodeId 派生（见 spawnBatch），天然回到初始态 ——
    // 不需要也不应该"重新播种一条共享流"，那正是改动会互相污染的根因。
    this.spawnPlayer();
    this.triggerRooms();
  }

  // ------------------------------------------------------------ 内部：生成

  private spawnPlayer(): void {
    const stats = PLAYER_STATS;
    const i = this.table.spawn(stats.defId);
    if (i < 0) throw new Error('玩家生成失败：实体表已满');
    this.playerId = i;
    this.kindOf[i] = 0;
    this.sourceOf[i] = this.desc.playerStart.nodeId;
    this.table.posX[i] = this.desc.playerStart.x;
    this.table.posZ[i] = this.desc.playerStart.z;
    this.table.radius[i] = stats.capsuleRadius;
    // 本轮玩家不移动 —— 没有输入驱动，硬给速度会让"玩家在漂移"
    this.table.maxSpeed[i] = 0;
    this.table.behavior[i] = BEHAVIOR_IDLE;
  }

  /**
   * 房间进入触发。
   *
   * 三条纪律：
   *  - 只触发一次（triggered 去重），再次跨越边界不重复投放同一波；
   *  - 禁用组件（enabled=false）的房间与刷怪点不触发；
   *  - **整批原子**：容量不够就一个都不生成，不留半批实体。
   */
  private triggerRooms(): void {
    if (this.playerId < 0 || !this.table.isAlive(this.playerId)) return;
    const px = this.table.posX[this.playerId]!;
    const pz = this.table.posZ[this.playerId]!;

    for (const room of this.desc.rooms) {
      if (!room.enabled) continue;
      if (this.triggered.has(room.nodeId)) continue;
      if (px < room.minX || px > room.maxX || pz < room.minZ || pz > room.maxZ) continue;

      const pending = this.desc.spawns.filter(
        (s) => s.roomNodeId === room.nodeId && s.enabled && s.trigger === 'room-enter',
      );
      const total = pending.reduce((a, s) => a + s.count, 0);
      if (total > this.table.capacity - this.table.aliveCount) {
        // 原子拒绝：宁可这一波不刷，也不能刷一半让调用方以为成功了
        continue;
      }

      for (const s of pending) this.spawnBatch(s);
      this.triggered.add(room.nodeId);
    }
  }

  private spawnBatch(s: { nodeId: NodeId; characterId: string; count: number; radius: number; x: number; z: number }): void {
    const stats = lookupCharacterStats(s.characterId);
    if (stats === undefined) return; // loader 已报 error，这里不重复生成
    // 🔴 每个刷怪点一条**独立**随机流（种子 = 会话种子 ⊗ 节点 id）。
    // 全场景共用一条流时，改 A 刷怪点的 count 会多消耗几个随机数，于是 B、C 的
    // 取点被整体平移 —— 作者以为自己在做"局部编辑"，实际上整关重排了一遍。
    // WU-5 的 A/B 探针正是靠"没改的地方必须逐位不变"来证明改动是局部的，
    // 共享流会让这条断言对 count 永远不成立。
    const rng = makeRng(mixSeed(this.initialSeed, s.nodeId));
    for (let k = 0; k < s.count; k++) {
      const i = this.table.spawn(stats.defId);
      if (i < 0) return; // 容量保护（正常走不到：triggerRooms 已预检）
      // 圆内均匀取点：半径乘 sqrt(u)，否则会向圆心堆积
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * s.radius;
      this.table.posX[i] = s.x + Math.cos(ang) * r;
      this.table.posZ[i] = s.z + Math.sin(ang) * r;
      this.table.radius[i] = stats.capsuleRadius;
      this.table.maxSpeed[i] = stats.moveSpeed;
      this.table.speedScale[i] = 1;
      this.table.dodgeBias[i] = (i & 1) === 0 ? 1 : -1;
      this.table.targetEntity[i] = this.playerId;
      this.table.behavior[i] = BEHAVIOR_CHASE;
      this.kindOf[i] = 1;
      this.sourceOf[i] = s.nodeId;
    }
  }

  // ------------------------------------------------------------ 内部：移动

  private moveNpcs(): void {
    const b = this.buffers;
    const t = this.table;
    let n = 0;
    for (let i = 0; i < t.capacity; i++) {
      if (!t.isAlive(i) || this.kindOf[i] !== 1) continue;
      b.posX[n] = t.posX[i]!;
      b.posZ[n] = t.posZ[i]!;
      b.velX[n] = t.velX[i]!;
      b.velZ[n] = t.velZ[i]!;
      b.radius[n] = t.radius[i]!;
      b.maxSpeed[n] = t.maxSpeed[i]!;
      b.speedScale[n] = t.speedScale[i]!;
      b.dodgeBias[n] = t.dodgeBias[i]!;
      n++;
    }
    b.count = n;
    if (n === 0) return;

    this.solver.solve(b, this.field, this.params);

    let k = 0;
    for (let i = 0; i < t.capacity; i++) {
      if (!t.isAlive(i) || this.kindOf[i] !== 1) continue;
      const vx = b.outX[k]!;
      const vz = b.outZ[k]!;
      t.velX[i] = vx;
      t.velZ[i] = vz;
      t.posX[i] = t.posX[i]! + vx * this.fixedStep;
      t.posZ[i] = t.posZ[i]! + vz * this.fixedStep;
      if (Math.hypot(vx, vz) > 1e-4) t.yaw[i] = Math.atan2(vz, vx);
      k++;
    }
  }

  // ------------------------------------------------------------ 内部：障碍烘焙

  /**
   * 把静态障碍画进导航场的阻挡位。
   *
   * 只画 `Collider && !isTrigger`（loader 已过滤）。没有这一步，
   * "僵尸朝玩家靠近"看起来仍然正确 —— 因为它们会直接穿过掩体。
   */
  private bakeObstacles(): void {
    const cs = this.field.cellSize;
    for (const o of this.desc.obstacles) {
      if (!o.enabled) continue;
      const x0 = Math.floor((o.x - o.halfX - this.field.originX) / cs);
      const x1 = Math.floor((o.x + o.halfX - this.field.originX) / cs);
      const z0 = Math.floor((o.z - o.halfZ - this.field.originZ) / cs);
      const z1 = Math.floor((o.z + o.halfZ - this.field.originZ) / cs);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          if (this.field.inBounds(cx, cz)) this.field.setBlocked(cx, cz, true);
        }
      }
    }
  }
}

/** 便捷入口：装载 + 建会话。CLI 与浏览器都走这里，保证语义一致 */
export function createSession(
  desc: LevelRuntimeDesc,
  opts: { seed?: number; fixedStep?: number; capacity?: number } = {},
): RuntimeSession {
  return new RuntimeSession({ desc, ...opts });
}

export type { LoadDiagnostic };
