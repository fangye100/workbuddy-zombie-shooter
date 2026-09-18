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

/**
 * 单个实体的查询视图。
 *
 * 两类身份，**用途不同，别混用**（复审 #6）：
 *   - **逻辑身份** `id + generation`：用于确定性比较（Node 与浏览器同种子逐实体比对）。
 *     它是会话内的，跨会话会重复 —— 这不是 bug，是它的设计定义。
 *   - **操作引用** `runId + id + generation`：用于"这个操作/选中还有效吗"的有效期判定。
 *     重跑（新会话或 reset）之后，旧引用必须**明确失效**，不能被新世界里同槽位的
 *     实体冒名顶替。
 */
export interface EntityView {
  /** CharacterTable 槽位。数组下标**不是**身份，必须配 generation 用 */
  id: number;
  generation: number;
  /** 运行代次：本次会话（或最近一次 reset）的唯一标识。跨代次的引用一律视为过期 */
  runId: number;
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

/** 一个房间因容量不足被整批拒绝的明细 */
export interface SpawnRejection {
  roomNodeId: NodeId;
  /** 这一波要生成的实体数 */
  needed: number;
  /** 当时剩余的容量 */
  free: number;
}

/** 运行期诊断（与 loader 的装载期诊断分开：装载是一次性的，运行是每步的） */
export interface RuntimeDiagnostic {
  code: string;
  message: string;
  nodeId: NodeId | null;
}

/**
 * 一次推进的结果摘要。
 *
 * 🔴 拒绝必须是**显式的**：`spawned` / `rejectedRooms` / `rejections` 都要是真值。
 * 这里曾经返回常量 `{ spawned: 0, rejectedRooms: 0 }` —— 容量不足的房间被静默跳过，
 * 调用方看到"什么都没刷"却分不清是"房间没触发"还是"容量不够被拒"。
 * 那直接违反 AGENTS.md §2.2「超容量一律产出 diagnostic 显式告知」与
 * docs/17 §7「生成量超过容量 → 明确失败」。
 */
export interface StepReport {
  tick: number;
  /** 本步新生成的实体数 */
  spawned: number;
  /** 本步因容量不足被整批拒绝的房间数 */
  rejectedRooms: number;
  /** 被拒房间的明细（与 rejectedRooms 同源，供 UI 指出是哪一个房间） */
  rejections: SpawnRejection[];
}

const BEHAVIOR_IDLE = 0;
const BEHAVIOR_CHASE = 1;

/**
 * 运行代次计数器。**只用于实体引用的有效期判定**（复审 #6），
 * 不进任何模拟计算、不影响确定性 —— 同样的种子/输入下，世界的演化与它无关。
 */
let NEXT_RUN_ID = 1;

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

  /**
   * 运行代次。每次构造与每次 `reset()` 递增。
   *
   * 它**只用于操作引用的有效期判定**（"这条选中/编辑还有没有效"），
   * 不参与任何模拟计算 —— 不影响确定性，也别拿它当随机源。
   */
  runId: number;

  /** 已触发过的房间。防"再次跨越边界重复投放同一波" */
  private readonly triggered = new Set<NodeId>();

  // ---- 玩家输入与导航目标（复审 #7） ----
  /** 玩家移动输入（已归一化，长度 ≤ 1）。宿主每帧写，runtime 每个固定步消费 */
  private inputX = 0;
  private inputZ = 0;
  /** 上次重烘时的流场目标。挪动不到一个格子不重烘 */
  private goalX = 0;
  private goalZ = 0;
  /** 导航区（构造时已保证非 null，这里留一份免得每次判空） */
  private navBounds = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  /** 按槽位记录来源作者节点 */
  private readonly sourceOf: (NodeId | null)[];
  private readonly kindOf: Uint8Array;
  private readonly defIdToStats = new Map<number, CharacterStatsEntry>();

  private playerId = -1;
  private tickCount = 0;
  private readonly capacity: number;

  /** 运行期诊断累计（容量拒绝等）。与装载期诊断分开：装载一次性，运行每步都可能产生 */
  private readonly diags: RuntimeDiagnostic[] = [];
  private readonly diagSeen = new Set<string>();

  constructor(opts: SessionOptions) {
    this.desc = opts.desc;
    this.seed = opts.seed ?? 1;
    this.initialSeed = this.seed;
    this.fixedStep = opts.fixedStep ?? 1 / 30;
    const capacity = opts.capacity ?? 512;
    this.capacity = capacity;
    this.runId = NEXT_RUN_ID++;

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
    this.navBounds = { minX: nav.minX, minZ: nav.minZ, maxX: nav.maxX, maxZ: nav.maxZ };
    this.goalX = opts.desc.playerStart.x;
    this.goalZ = opts.desc.playerStart.z;
    this.integrator.setGoal(this.goalX, this.goalZ);
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
        runId: this.runId,
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

  /**
   * 设置玩家的移动输入（XZ）。
   *
   * 这是**固定 tick 输入消费**的唯一入口（复审 #7）：宿主把虚拟摇杆的真实输入
   * 转成约定的运行输入（一个向量），runtime 每个固定步消费一次 —— 跟 NPC 一样
   * 走同一条确定性路径。直接改玩家坐标不算输入链路：那绕过了"输入 → 每步消费 →
   * 碰撞与导航目标更新"整条链。
   *
   * 语义是模拟摇杆：长度是强度，超过 1 截断到 1（斜向摇满不超 1）。
   */
  setInput(x: number, z: number): void {
    const l = Math.hypot(x, z);
    const s = l > 1 ? 1 / l : 1;
    this.inputX = x * s;
    this.inputZ = z * s;
  }

  /** 推进一个固定步。**不读墙钟**，浏览器宿主要自己用累加器调度 */
  step(): StepReport {
    const r = this.triggerRooms();
    this.movePlayer();
    this.moveNpcs();
    this.tickCount += 1;
    for (const j of r.rejections) {
      this.pushDiag(
        'W_SPAWN_CAPACITY',
        `房间 ${j.roomNodeId} 这一波要 ${j.needed} 只，剩余容量只有 ${j.free} 只 —— 整批不生成`,
        j.roomNodeId,
      );
    }
    return {
      tick: this.tickCount,
      spawned: r.spawned,
      rejectedRooms: r.rejections.length,
      rejections: r.rejections,
    };
  }

  /** 当前导航流场的目标（玩家位置）。玩家移动超过一个格子就会重烘 —— 测试据此核 */
  get navGoal(): { x: number; z: number } {
    return { x: this.goalX, z: this.goalZ };
  }

  /** 运行期诊断（累计）。与装载期诊断分开，装载是一次性的 */
  diagnostics(): readonly RuntimeDiagnostic[] {
    return this.diags;
  }

  /** 取走运行期诊断并清空（宿主每帧取一次去显示，不会越攒越多） */
  drainDiagnostics(): RuntimeDiagnostic[] {
    const out = this.diags.slice();
    this.diags.length = 0;
    this.diagSeen.clear();
    return out;
  }

  private pushDiag(code: string, message: string, nodeId: NodeId | null): void {
    // 同一个 (code, node) 只记一次：容量不足的房间每步都会命中，
    // 逐步 push 会把真正重要的那条冲掉（WebGPU 错误那条踩过同样的坑）
    const key = `${code}|${nodeId ?? ''}`;
    if (this.diagSeen.has(key)) return;
    this.diagSeen.add(key);
    this.diags.push({ code, message, nodeId });
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
    this.diags.length = 0;
    this.diagSeen.clear();
    // 换运行代次：重跑之后，旧的实体引用必须明确失效，不能被新世界里
    // 同槽位的实体冒名顶替（复审 #6）。runId 只用于引用有效期，不影响确定性。
    this.runId = NEXT_RUN_ID++;
    // 输入与导航目标也要回到初始态 —— 否则 reset 后玩家还按着上一轮的摇杆
    this.inputX = 0;
    this.inputZ = 0;
    this.goalX = this.desc.playerStart.x;
    this.goalZ = this.desc.playerStart.z;
    this.integrator.setGoal(this.goalX, this.goalZ);
    this.integrator.step(this.field.cellCount);
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
    // 玩家速度来自真源；是否移动只由**输入**决定，没有输入就是 0 位移
    this.table.maxSpeed[i] = stats.moveSpeed;
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
  private triggerRooms(): { spawned: number; rejections: SpawnRejection[] } {
    const rejections: SpawnRejection[] = [];
    let spawned = 0;
    if (this.playerId < 0 || !this.table.isAlive(this.playerId)) {
      return { spawned, rejections };
    }
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
      const free = this.table.capacity - this.table.aliveCount;
      if (total > free) {
        // 原子拒绝：宁可这一波不刷，也不能刷一半让调用方以为成功了。
        // 🔴 但"不刷"不等于"不报" —— 拒绝必须显式回传，否则调用方无从区分
        // "房间没触发" 与 "容量不够被拒"（docs/17 §7：明确失败，符合约定的原子性）。
        rejections.push({ roomNodeId: room.nodeId, needed: total, free });
        continue;
      }

      for (const s of pending) spawned += this.spawnBatch(s);
      this.triggered.add(room.nodeId);
    }
    return { spawned, rejections };
  }

  /** 返回实际生成的数量（供 StepReport.spawned 汇总） */
  private spawnBatch(s: { nodeId: NodeId; characterId: string; count: number; radius: number; x: number; z: number }): number {
    const stats = lookupCharacterStats(s.characterId);
    if (stats === undefined) return 0; // loader 已报 error，这里不重复生成
    // 🔴 每个刷怪点一条**独立**随机流（种子 = 会话种子 ⊗ 节点 id）。
    // 全场景共用一条流时，改 A 刷怪点的 count 会多消耗几个随机数，于是 B、C 的
    // 取点被整体平移 —— 作者以为自己在做"局部编辑"，实际上整关重排了一遍。
    // WU-5 的 A/B 探针正是靠"没改的地方必须逐位不变"来证明改动是局部的，
    // 共享流会让这条断言对 count 永远不成立。
    const rng = makeRng(mixSeed(this.initialSeed, s.nodeId));
    let made = 0;
    for (let k = 0; k < s.count; k++) {
      const i = this.table.spawn(stats.defId);
      if (i < 0) return made; // 容量保护（正常走不到：triggerRooms 已预检）
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
      made++;
    }
    return made;
  }

  // ------------------------------------------------------------ 内部：玩家移动

  /**
   * 按输入推进玩家一个固定步。
   *
   * 三件事按序做：输入 → 位移 → 约束（障碍推出 + 导航区钳制）→ 导航目标更新。
   * 没有输入时连流场都不用碰（不动玩家的历史行为保持不变）。
   */
  private movePlayer(): void {
    if (this.playerId < 0 || !this.table.isAlive(this.playerId)) return;
    if (this.inputX === 0 && this.inputZ === 0) return;
    const i = this.playerId;
    const speed = this.table.maxSpeed[i]!;
    if (speed <= 0) return;

    const nx = this.table.posX[i]! + this.inputX * speed * this.fixedStep;
    const nz = this.table.posZ[i]! + this.inputZ * speed * this.fixedStep;
    const [cx, cz] = this.resolvePlayerCollision(nx, nz, this.table.radius[i]!);
    this.table.posX[i] = cx;
    this.table.posZ[i] = cz;
    this.table.yaw[i] = Math.atan2(this.inputZ, this.inputX);

    // 导航目标更新：玩家挪动超过一个格子，流场必须跟着重烘 ——
    // 不重烘的话 NPC 会朝"玩家原来站的地方"跑，画面与逻辑分家。
    const cs = this.field.cellSize;
    if (Math.abs(cx - this.goalX) >= cs || Math.abs(cz - this.goalZ) >= cs) {
      this.goalX = cx;
      this.goalZ = cz;
      this.integrator.setGoal(cx, cz);
      this.integrator.step(this.field.cellCount);
    }
  }

  /** 障碍推出（AABB 最浅穿透轴）+ 导航区边界钳制 */
  private resolvePlayerCollision(x: number, z: number, r: number): [number, number] {
    let px = x;
    let pz = z;
    for (const o of this.desc.obstacles) {
      if (!o.enabled) continue;
      const dx = px - o.x;
      const dz = pz - o.z;
      const ex = o.halfX + r;
      const ez = o.halfZ + r;
      if (Math.abs(dx) >= ex || Math.abs(dz) >= ez) continue;
      const pxn = ex - Math.abs(dx);
      const pzn = ez - Math.abs(dz);
      if (pxn < pzn) px = o.x + Math.sign(dx || 1) * ex;
      else pz = o.z + Math.sign(dz || 1) * ez;
    }
    px = Math.min(this.navBounds.maxX - r, Math.max(this.navBounds.minX + r, px));
    pz = Math.min(this.navBounds.maxZ - r, Math.max(this.navBounds.minZ + r, pz));
    return [px, pz];
  }

  // ------------------------------------------------------------ 内部：NPC 移动

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
