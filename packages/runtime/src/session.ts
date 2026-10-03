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

import { CharacterTable, rayCapsuleY, updateLod, type LodThresholds } from '@aether/gameplay';
import { CrowdSolver, FlowField, FlowFieldIntegrator } from '@aether/ai';
import type { CrowdBuffers, CrowdParams } from '@aether/ai';
import { NPC_STATS, PLAYER_STATS, PLAYER_WEAPON, lookupCharacterStats } from '@aether/content';
import type { CharacterStatsEntry } from '@aether/content';
import type { NodeId } from '@aether/scene';
import type { LevelRuntimeDesc, LoadDiagnostic } from './loader';
import type { BehaviorContext, BehaviorExecutor, BehaviorLogEntry } from './behavior-executor';
import { NULL_BEHAVIOR_EXECUTOR } from './behavior-executor';

/**
 * 行为日志条数上限。行为可能每 tick 都打日志，必须封顶——
 * 长时间跑不封顶会吃光内存，且冲掉的都是最早（往往最有用）的记录。
 */
const BEHAVIOR_LOG_LIMIT = 200;

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
  /**
   * 行为执行器（ADR-018 P3）。**由宿主注入**，runtime 不 import 行为代码。
   *
   * 不传 = `NULL_BEHAVIOR_EXECUTOR`（全部返回 false → 每个脚本产出一条未注册诊断），
   * 让"没接执行器"显式可见，而不是静默什么都不做。
   */
  executor?: BehaviorExecutor;
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
  /** 当前血量（P5；HUD 血条与死亡判定的读点） */
  hp: number;
  /** 血量上限（stats.hp 真源；血条比例的分母） */
  maxHp: number;
  /**
   * 受击高亮剩余秒（P5 §2.1；渲染层/HUD 消费点）。
   * 🔴 会随 tick 衰减到 0 —— 不衰减的话它永远是 0.15，等于一个只写不读的死列
   * （2026-10-02 审查发现）。
   */
  hitFlash: number;
  /**
   * LOD 档位（P4 M4）：0 = Full（真模型蒙皮）、1 = Vat、2 = Proxy（退胶囊）。
   * 由宿主每帧调 `refreshLod()` 按相机距离更新 —— runtime 本身不知道相机在哪。
   */
  lodTier: number;
}

/** 一个房间因容量不足被整批拒绝的明细 */
export interface SpawnRejection {
  roomNodeId: NodeId;
  /** 这一波要生成的实体数 */
  needed: number;
  /** 当时剩余的容量 */
  free: number;
}

/**
 * 战斗事件（P5，docs/23 §2.1a/§2.7）。由 applyDamage 产生、宿主与（后续的）
 * 行为脚本消费。事件不是轮询：伤害发生的那一刻就进缓冲，HUD / 音效 / 击杀
 * 统计据此派生，不需要每步扫表。
 */
export interface CombatEvent {
  readonly type: 'damage' | 'kill';
  readonly tick: number;
  /** 受击槽位 */
  readonly slot: number;
  readonly characterId: string;
  /** 本次伤害量（kill 事件也带，便于统计贡献） */
  readonly amount: number;
  /** 伤害后的血量（kill 时为 0） */
  readonly hpAfter: number;
  /** 造成伤害的槽位；-1 = 系统/环境伤害 */
  readonly sourceSlot: number;
}

/**
 * 默认 LOD 阈值（P4 M4「远处退胶囊」，docs/20 §M4）。
 *
 * - 25m 内：Full（真模型 + 蒙皮）
 * - 25~60m：Vat（动态通道下与 Full 同批次，仅预留）
 * - 60m 外：Proxy（退胶囊——200 只压测时这一档决定了 draw call 与顶点量）
 * - hysteresis 10%：升级阈值比降级阈值宽，防止在边界反复横跳（每帧切档的开销
 *   比"多画几只真模型"更大）
 */
export const DEFAULT_LOD_THRESHOLDS: LodThresholds = {
  fullDistance: 25,
  vatDistance: 60,
  hysteresis: 0.1,
};

/** applyDamage 的结果（HUD/音效/测试消费，docs/23 §2.1a） */
export interface DamageResult {
  readonly died: boolean;
  readonly hpAfter: number;
}

/**
 * 会话级事件（P5，docs/23 §2.4/§2.5）：波次投放 / 房间清空 /（C5 的）胜负。
 * 与 CombatEvent（实体级伤害）分开 —— 消费方不同（HUD 波次提示 / 关卡流程）。
 */
export interface SessionEvent {
  readonly type: 'wave-start' | 'room-cleared' | 'game-over' | 'floor-clear';
  readonly tick: number;
  readonly roomNodeId: NodeId | null;
  /** wave-start 专属：刚投放的波号（1 起） */
  readonly wave?: number;
}

/** 会话终态（P5 C5，docs/23 §2.5）。终态即冻结：step 不再推进世界 */
export type SessionOutcome = 'running' | 'game-over' | 'floor-clear';

/** 一个房间的波次推进状态（WaveScheduler，docs/23 §2.4） */
interface RoomWaveState {
  /** 下一个待投放的波号；> lastWave = 全部投完（等清空 → cleared） */
  nextWave: number;
  /** 本房最大波号（max of spawn wave，≤0 归 1 后） */
  lastWave: number;
  /** 投放下一波的 tick；-1 = 正在等当前波清空 */
  nextWaveAtTick: number;
  cleared: boolean;
}

/** 两波之间的间隔。[PLACEHOLDER 2.0s] docs/23 §2.4（playtest 后调） */
const INTER_WAVE_SEC = 2.0;

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
/** P5 四态扩展（docs/23 §2.2）：前摇蓄力中（站定；打断语义 [PLACEHOLDER 不实现]） */
export const BEHAVIOR_WINDUP = 2;
/**
 * 打击瞬时态：windup 结束的那一 tick 执行扇形判定后立即写回 CHASE + CD。
 * 🔴 数据上从不过夜（当 tick 即返回 CHASE）——宿主经 view() 永远观察不到 3，
 * 打击的事实记录在 combatEvents（damage 事件）；动画选片应消费事件而非行为码。
 * 常量保留导出是为了四态语义的完整对照表（docs/23 §2.2）。
 */
export const BEHAVIOR_STRIKE = 3;

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

  /**
   * 会话终态（P5 C5）。'running' 之外即冻结：step 直接短路返回，世界定格 ——
   * game-over（玩家死亡）与 floor-clear（全房清空）都不自动清场，宿主决定何时退。
   */
  get outcome(): SessionOutcome {
    return this.outcomeState;
  }
  private outcomeState: SessionOutcome = 'running';

  /** 已触发过的房间。防"再次跨越边界重复投放同一波" */
  private readonly triggered = new Set<NodeId>();
  /** 波次推进状态（P5 C4）：triggered 房间的 wave 调度器 */
  private readonly waveRooms = new Map<NodeId, RoomWaveState>();
  /**
   * 房间存活敌数（**增量维护**）。
   *
   * 旧实现是 `roomAliveEnemies()` 每次遍历整张实体表（O(房间数 × 容量)/tick），
   * 500 只规模下纯属浪费。生成时 +n、死亡回收时 −1 —— 计数与实体表的一致性
   * 由「NPC 销毁只走 `kill()` 这一条路」保证（`destroy` 全仓库只此一处调用）。
   */
  private readonly roomAlive = new Map<NodeId, number>();
  /** 会话事件缓冲（wave-start / room-cleared / C5 胜负） */
  private readonly sessionEventBuf: SessionEvent[] = [];

  /** 会话事件只读视图（波次提示 / 关卡流程消费） */
  get sessionEvents(): readonly SessionEvent[] {
    return this.sessionEventBuf;
  }

  /** 已清空的房间（C5 的 floor-clear 判定输入：全部 enabled 房间 cleared） */
  clearedRooms(): NodeId[] {
    const out: NodeId[] = [];
    for (const [id, st] of this.waveRooms) {
      if (st.cleared) out.push(id);
    }
    return out;
  }

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

  /**
   * 行为执行器（宿主注入，ADR-018 R3：runtime 不 import 行为代码）。
   *
   * **装载期冻结**：本代 Play 内行为代码不可变，改代码必须 Stop 后重跑
   * （与 `runId` 代次对齐）。这不是限制，是为了不让新旧闭包混在同一帧里。
   */
  private readonly executor: BehaviorExecutor;

  /** 行为日志（ctx.log 的落地处）。不落盘，供 UI / 测试查询 */
  private readonly behaviorLogs: BehaviorLogEntry[] = [];

  /** 行为日志只读视图（按时间顺序） */
  get behaviorLog(): readonly BehaviorLogEntry[] {
    return this.behaviorLogs;
  }

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
    this.executor = opts.executor ?? NULL_BEHAVIOR_EXECUTOR;

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
      out.push(this.viewAt(i));
    }
    return out;
  }

  /**
   * 玩家实体视图（O(1)）。
   *
   * 相机跟随每帧都要它 —— 用 `view().find()` 是每帧全表扫 + 建整个数组
   * （500 只时是每帧几百次无谓遍历与一次大分配，HANDOFF 里的 P2-3）。
   */
  player(): EntityView | null {
    const i = this.playerEntityId;
    if (i < 0 || !this.table.isAlive(i)) return null;
    return this.viewAt(i);
  }

  /** 单槽位视图（view() 与 player() 共用，避免两处构造逻辑漂移） */
  private viewAt(i: number): EntityView {
    const stats = this.defIdToStats.get(this.table.defId[i]!);
    return {
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
      hp: this.table.health[i]!,
      maxHp: this.table.maxHp[i]!,
      hitFlash: this.table.hitFlash[i]!,
      lodTier: this.table.lodTier[i]!,
    };
  }

  /**
   * 按相机位置刷新 LOD 档位（P4 M4「远处退胶囊」，docs/20 §M4）。
   *
   * 🔴 **相机是宿主的事**（编辑器相机 / 游戏相机是两个东西），所以 runtime 不自己
   * 持有相机，改由宿主每帧调用 —— 与 `setInput` 同一个"输入注入"模式。
   * 不刷新的话 `lodTier` 永远停在初始值，远处真模型照画，200 只压测必掉帧。
   *
   * 返回本帧发生档位切换的实体数（压测诊断用：抖动大 = 阈值/迟滞没调好）。
   */
  refreshLod(cameraX: number, cameraZ: number, t: LodThresholds = DEFAULT_LOD_THRESHOLDS): number {
    return updateLod(this.table, t, cameraX, cameraZ);
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
  /**
   * 🔴 伤害的唯一事实出口（P5，docs/23 §2.1a）。
   *
   * 所有掉血必须走这里 —— 玩家射击、NPC 挥抓、未来的 Build 系统（届时
   * DamagePipeline 在本方法**内部**做修饰，单入口不破）。任何路径直写
   * `table.health` 都会漏掉：击杀事件、受击高亮、胜负判定、死亡回收 ——
   * 这些派生反应全靠这个入口，绕过 = 不可审计。
   *
   * 减血 → ≤0 时 kill：NPC 槽位销毁回 freelist（generation+1 防旧引用冒名，
   * view() 自动消失）；玩家不销毁（保留"死状"槽位，胜负判定是 C5 的消费方）。
   */
  applyDamage(targetSlot: number, amount: number, sourceSlot = -1): DamageResult {
    if (!this.tbl.isAlive(targetSlot)) {
      return { died: false, hpAfter: 0 };
    }
    const hpAfter = Math.max(0, this.tbl.health[targetSlot]! - amount);
    this.tbl.health[targetSlot] = hpAfter;
    // 受击高亮 [PLACEHOLDER 0.15]（docs/23 §2.1；渲染层消费，先给默认时长）
    this.tbl.hitFlash[targetSlot] = 0.15;
    const characterId = this.characterIdOf(targetSlot);
    const died = hpAfter <= 0;
    this.combatEventBuf.push({
      type: died ? 'kill' : 'damage',
      tick: this.tickCount,
      slot: targetSlot,
      characterId,
      amount,
      hpAfter,
      sourceSlot,
    });
    if (died) this.kill(targetSlot);
    // 玩家死亡 = 本局失败终态（docs/23 §2.5）：事件当场发、世界本 step 后冻结。
    // 🔴 不自动清场 —— 让玩家看清死状，UI 决定何时退（编辑器不自动 Stop）。
    // 🔴 **判定条件来自场景真源** `desc.loseCondition`（loader 从 SceneDocument 读）：
    // 硬编码"玩家死 = 失败"会让作者对场景规则的修改失效（2026-10-02 审查：v4 的
    // loseCondition 曾是有定义无消费的假载体）。场景没声明 → 不判负（装载期已 warn）。
    if (
      died &&
      this.kindOf[targetSlot] === 0 &&
      this.desc.loseCondition === 'player-death' &&
      this.outcomeState === 'running'
    ) {
      this.outcomeState = 'game-over';
      this.sessionEventBuf.push({ type: 'game-over', tick: this.tickCount, roomNodeId: null });
    }
    return { died, hpAfter };
  }

  /**
   * 死亡回收（只由 applyDamage 调用）。NPC：槽位销毁回 freelist —— aliveCount
   * 有减有增，不再单调撞 512（docs/23 §1.1 的「死亡回收」缺口）。玩家：槽位
   * 保留（死了要看得见死状，C5 的失败冻结接管语义，destroy 会让 view 丢实体）。
   */
  private kill(slot: number): void {
    if (this.kindOf[slot] === 0) return; // 玩家：见上，槽位与 alive 标记都保留
    this.decRoomAlive(slot, -1);
    this.tbl.destroy(slot);
  }

  /** 房间存活计数 ±delta（槽位 → 出生刷怪点 → 所属房间） */
  private decRoomAlive(slot: number, delta: number): void {
    const src = this.sourceOf[slot] ?? null;
    if (src === null) return;
    const spawn = this.desc.spawns.find((s) => s.nodeId === src);
    const roomId = spawn?.roomNodeId ?? null;
    if (roomId === null) return;
    const next = (this.roomAlive.get(roomId) ?? 0) + delta;
    this.roomAlive.set(roomId, next < 0 ? 0 : next);
  }

  /** 战斗事件缓冲（只读视图；测试与宿主订阅用，缓冲归 session 拥有） */
  get combatEvents(): readonly CombatEvent[] {
    return this.combatEventBuf;
  }

  private readonly combatEventBuf: CombatEvent[] = [];

  /** 槽位 → characterId（事件/诊断用；defId 查表） */
  private characterIdOf(slot: number): string {
    const stats = this.defIdToStats.get(this.tbl.defId[slot]!);
    return stats?.id ?? `slot#${slot}`;
  }

  /**
   * 设定玩家移动输入。
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

  /**
   * 开火输入（P5 C3，docs/23 §2.3）。与 setInput 同模式：宿主每帧写，
   * runtime 在固定步里消费 —— 按住 = 持续射击（受武器 CD 节流）。
   */
  setFire(down: boolean): void {
    this.fireHeld = down;
  }

  /** 开火键状态（宿主 UI 显示用） */
  get firing(): boolean {
    return this.fireHeld;
  }

  private fireHeld = false;
  /** 玩家武器 CD 到点时刻（会话时钟秒；不占表列——玩家只有一个） */
  private playerCooldownUntil = 0;

  /** 推进一个固定步。**不读墙钟**，浏览器宿主要自己用累加器调度 */
  step(): StepReport {
    // 终态冻结（P5 C5）：世界定格，tick 不再走。返回空报告 —— 宿主的累加器
    // 可以继续调度（不需要各自判终态），但世界零变化。
    if (this.outcomeState !== 'running') {
      return { tick: this.tickCount, spawned: 0, rejectedRooms: 0, rejections: [] };
    }
    const r = this.triggerRooms();
    this.updateWaves();
    this.decayHitFlash();
    this.movePlayer();
    this.moveNpcs();
    // 战斗判定在移动之后：进入 windup / 前摇倒计时 / 打击 / 玩家射击
    // 都用**本步最终位置**（与脚本的「看到最终位置」同一纪律）
    this.combatStep();
    this.fireStep();
    this.tickCount += 1;
    // 脚本在移动之后执行：行为看到的是**本步最终位置**，
    // 否则"判断僵尸是否进入某区域"这类逻辑会差一步。
    this.runScripts();
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

  /**
   * 执行场景节点上的脚本（ADR-018 P3）。
   *
   * 三条规定：
   * - 顺序按 `desc.scripts` 的装载顺序（文档顺序 → 确定性可复现，不依赖 Map 迭代序）；
   * - 单个行为不可用只记诊断，**不中断整批**（ADR-017：一个挂掉的行为
   *   不该让整个场景打不开，更不能让其余脚本陪葬）；
   * - 诊断按 (code, nodeId) 去重 —— 未注册的行为每个 tick 都会命中，
   *   逐步 push 会把真正重要的那一条冲掉。
   */
  private runScripts(): void {
    if (this.desc.scripts.length === 0) return;
    for (const s of this.desc.scripts) {
      const ctx: BehaviorContext = {
        tick: this.tickCount,
        runId: this.runId,
        log: (message) => {
          // 行为可能每 tick 都打日志，必须封顶——否则长时间跑会吃光内存，
          // 而且冲掉的都是最早（往往最有用）的记录。封顶后丢最旧的。
          if (this.behaviorLogs.length >= BEHAVIOR_LOG_LIMIT) this.behaviorLogs.shift();
          this.behaviorLogs.push({
            tick: this.tickCount,
            nodeId: s.nodeId,
            behavior: s.behavior,
            message,
          });
        },
      };
      // 🔴 runtime 不信任执行器：行为代码是内容层（Agent 自由创作），
      // 抛异常是常态而不是意外。执行器自己该兜住，但 runtime 不能把"运行时崩掉"
      // 寄托在注入方的自觉上 —— 这里再兜一层，异常一律降级为跳过。
      let ok = false;
      try {
        ok = this.executor.run(s, ctx);
      } catch (e) {
        // 记完 THREW 就 continue：不再叠加 UNAVAILABLE ——
        // 一次失败出两条语义矛盾的诊断（PR#16 review）
        this.pushDiag(
          'W_BEHAVIOR_THREW',
          `脚本「${s.behavior}」（节点 ${s.nodeId}）执行时抛出异常，本轮跳过：${
            e instanceof Error ? e.message : String(e)
          }`,
          s.nodeId,
        );
        continue;
      }
      if (!ok) {
        this.pushDiag(
          'W_BEHAVIOR_UNAVAILABLE',
          `脚本「${s.behavior}」（节点 ${s.nodeId}）未注册或不可用，本轮降级为空操作`,
          s.nodeId,
        );
      }
    }
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
    this.behaviorLogs.length = 0; // 跨代日志必须清：旧代日志混进来会让"重跑了没"说不清
    this.combatEventBuf.length = 0; // 战斗事件同理：跨代残留会让击杀统计重复计账
    this.sessionEventBuf.length = 0; // 波次/清房事件同理
    this.waveRooms.clear(); // 波次状态随世界重建
    this.roomAlive.clear(); // 房间存活计数同理（整表重建，计数从头累积）
    this.outcomeState = 'running'; // 终态随换代复位（重跑新的一局）
    // 换运行代次：重跑之后，旧的实体引用必须明确失效，不能被新世界里
    // 同槽位的实体冒名顶替（复审 #6）。runId 只用于引用有效期，不影响确定性。
    this.runId = NEXT_RUN_ID++;
    // 输入与导航目标也要回到初始态 —— 否则 reset 后玩家还按着上一轮的摇杆
    this.inputX = 0;
    this.inputZ = 0;
    this.fireHeld = false;
    this.playerCooldownUntil = 0;
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
    // P5：血量真源（stats.player.hp，C1 落的真源链）
    this.table.maxHp[i] = stats.hp;
    this.table.health[i] = stats.hp;
  }

  /**
   * 房间进入触发（P5 C4 改造：wave 分组投放，docs/23 §2.4）。
   *
   * 三条纪律（沿用）：
   *  - 只触发一次（triggered 去重），再次跨越边界不重复投放同一波；
   *  - 禁用组件（enabled=false）的房间与刷怪点不触发；
   *  - **整波原子**：容量不够就一波都不生成，不留半批实体。
   *
   * 触发时只投 wave 1（wave ≤ 0 的旧数据归 1，与旧行为「触发即全量」兼容——
   * 全是 wave≤0 的房间等价于单波全量）；后续波由 updateWaves 按清空节奏投放。
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
      // wave 分组：≤0 归 1（旧数据兼容）；波号升序 = 投放顺序
      const waves = new Set<number>();
      for (const s of pending) waves.add(Math.max(1, s.wave));
      const lastWave = waves.size === 0 ? 0 : Math.max(...waves);

      const wave1 = pending.filter((s) => Math.max(1, s.wave) === 1);
      const total = wave1.reduce((a, s) => a + s.count, 0);
      const free = this.table.capacity - this.table.aliveCount;
      if (total > free) {
        // 原子拒绝：宁可这一波不刷，也不能刷一半让调用方以为成功了。
        // 🔴 但"不刷"不等于"不报" —— 拒绝必须显式回传，否则调用方无从区分
        // "房间没触发" 与 "容量不够被拒"（docs/17 §7：明确失败，符合约定的原子性）。
        rejections.push({ roomNodeId: room.nodeId, needed: total, free });
        continue;
      }

      for (const s of wave1) spawned += this.spawnBatch(s);
      if (lastWave >= 1) {
        this.sessionEventBuf.push({ type: 'wave-start', tick: this.tickCount, roomNodeId: room.nodeId, wave: 1 });
      }
      this.waveRooms.set(room.nodeId, {
        nextWave: 2,
        lastWave,
        nextWaveAtTick: -1,
        // 🔴 cleared 不许在投放时预置（单波房触发时怪还活着）；清空的唯一
        // 判定路径在 updateWaves（投完全部波且房内活敌归零）——两处判定会漂移
        cleared: false,
      });
      this.triggered.add(room.nodeId);
    }
    return { spawned, rejections };
  }

  /**
   * 波次推进（P5 C4，docs/23 §2.4）：当前波清空 → 间隔 interWaveSec → 投下一波；
   * 最后一波清空 → 房间 cleared（事件）。每个固定步在 triggerRooms 之后跑。
   *
   * 「房内敌数」按 sourceOf（出生刷怪点）归属房间统计，玩家不参与；
   * 同种子重跑的波次时序确定性由：①文档序遍历 ②spawnBatch 的 nodeId 派生流
   * ③tick 驱动（无墙钟）共同保证。
   */
  private updateWaves(): void {
    if (this.waveRooms.size === 0) return;
    const interWaveTicks = Math.max(1, Math.round(INTER_WAVE_SEC / this.fixedStep));

    for (const room of this.desc.rooms) {
      if (!room.enabled) continue;
      const st = this.waveRooms.get(room.nodeId);
      if (st === undefined || st.cleared) continue;

      if (st.nextWaveAtTick >= 0) {
        // 等投放：到点投下一波（整波原子，容量不足时这波被丢——诊断走
        // W_SPAWN_CAPACITY 同款路径，见 step 的 rejections 汇总）
        if (this.tickCount < st.nextWaveAtTick) continue;
        const waveSpawns = this.desc.spawns.filter(
          (s) =>
            s.roomNodeId === room.nodeId &&
            s.enabled &&
            s.trigger === 'room-enter' &&
            Math.max(1, s.wave) === st.nextWave,
        );
        const total = waveSpawns.reduce((a, s) => a + s.count, 0);
        const free = this.table.capacity - this.table.aliveCount;
        if (total > free) {
          // 容量不足：保持等待，下一 tick 再试（波不丢，直到容量腾出）
          st.nextWaveAtTick = this.tickCount + interWaveTicks;
          this.pushDiag(
            'W_SPAWN_CAPACITY',
            `房间 ${room.nodeId} 第 ${st.nextWave} 波要 ${total} 只，剩余容量 ${free} —— 推迟投放`,
            room.nodeId,
          );
          continue;
        }
        for (const s of waveSpawns) this.spawnBatch(s);
        this.sessionEventBuf.push({
          type: 'wave-start',
          tick: this.tickCount,
          roomNodeId: room.nodeId,
          wave: st.nextWave,
        });
        st.nextWave += 1;
        st.nextWaveAtTick = -1;
        continue;
      }

      // 等清空：房内活敌（本房刷怪点出生的存活 NPC）为 0 ？
      if (this.roomAliveEnemies(room.nodeId) > 0) continue;
      if (st.nextWave <= st.lastWave) {
        st.nextWaveAtTick = this.tickCount + interWaveTicks;
      } else {
        st.cleared = true;
        this.sessionEventBuf.push({ type: 'room-cleared', tick: this.tickCount, roomNodeId: room.nodeId });
        this.checkFloorClear();
      }
    }
  }

  /**
   * 本层通关判定（docs/23 §2.5）：全部 enabled 房间 cleared 且玩家存活。
   * 只在 room-cleared 之后检查（清房是唯一让「全清」从假变真的转移点）。
   */
  private checkFloorClear(): void {
    if (this.outcomeState !== 'running') return;
    for (const room of this.desc.rooms) {
      if (!room.enabled) continue;
      const st = this.waveRooms.get(room.nodeId);
      if (st === undefined || !st.cleared) return; // 有房间没触发或没清完
    }
    this.outcomeState = 'floor-clear';
    this.sessionEventBuf.push({ type: 'floor-clear', tick: this.tickCount, roomNodeId: null });
  }

  /**
   * 房内存活敌数（该房刷怪点出生的 alive NPC；玩家不计）。
   *
   * 🔴 **增量计数，不再每 tick 全表扫**：spawnBatch 加、kill 减。500 只规模下
   * 旧实现是 O(房间数 × 容量)/tick 的纯浪费（2026-10-02 审查提出）。
   */
  private roomAliveEnemies(roomNodeId: NodeId): number {
    return this.roomAlive.get(roomNodeId) ?? 0;
  }

  /** 把一个刚 alloc 出来的槽位初始化成"追玩家的 NPC"（spawnBatch 与 debugSpawn 共用） */
  private initNpcSlot(i: number, stats: CharacterStatsEntry, x: number, z: number): void {
    this.table.posX[i] = x;
    this.table.posZ[i] = z;
    this.table.radius[i] = stats.capsuleRadius;
    this.table.maxSpeed[i] = stats.moveSpeed;
    this.table.speedScale[i] = 1;
    this.table.dodgeBias[i] = (i & 1) === 0 ? 1 : -1;
    this.table.targetEntity[i] = this.playerId;
    this.table.behavior[i] = BEHAVIOR_CHASE;
    // P5：血量真源（stats.npc[].hp，roster 交叉校验过）
    this.table.maxHp[i] = stats.hp;
    this.table.health[i] = stats.hp;
    this.kindOf[i] = 1;
  }

  /**
   * 压测 / 调试注入：在指定位置生成 count 个 NPC（P4 M4 的 200 只压测入口）。
   *
   * 🔴 这是**调试通道，不是玩法路径**：实体不挂任何出生刷怪点（sourceOf = null），
   * 因此不计入房间存活数、不影响 WaveScheduler 的清空与推进判定 —— 压测要的是
   * "屏幕上真有 200 只"，不能顺手把关卡流程搅乱。玩法生成一律走场景刷怪点。
   *
   * 返回实际生成数（容量不足时少于 count）。
   */
  debugSpawn(characterId: string, x: number, z: number, count: number, spreadM = 0): number {
    const stats = lookupCharacterStats(characterId);
    if (stats === undefined) return 0;
    let made = 0;
    for (let k = 0; k < count; k++) {
      const i = this.table.spawn(stats.defId);
      if (i < 0) break; // 容量用尽
      // spreadM > 0 时按环形铺开（压测要的是分散的 200 只，不是叠在一个点上）
      const ang = spreadM > 0 ? (k / count) * Math.PI * 2 : 0;
      const r = spreadM > 0 ? Math.sqrt((k % 17) / 17) * spreadM : 0;
      this.initNpcSlot(i, stats, x + Math.cos(ang) * r, z + Math.sin(ang) * r);
      this.sourceOf[i] = null;
      made++;
    }
    return made;
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
      this.initNpcSlot(i, stats, s.x + Math.cos(ang) * r, s.z + Math.sin(ang) * r);
      this.sourceOf[i] = s.nodeId;
      made++;
    }
    // 房间存活计数（增量）：刷怪点归属房间从 desc 反查（低频，每波一次）
    if (made > 0) {
      const roomId = this.desc.spawns.find((sp) => sp.nodeId === s.nodeId)?.roomNodeId ?? null;
      if (roomId !== null) this.roomAlive.set(roomId, (this.roomAlive.get(roomId) ?? 0) + made);
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

  /**
   * NPC 攻击状态机（P5 C3，docs/23 §2.2 四态：idle/chase/windup/strike）。
   *
   * 数值全部走 stats 真源链（C1 的 attack 嵌套结构），代码里零魔法数字；
   * attack = null 的角色（B-02/B-03 近战未定）永不进 windup，只能追。
   * strike 是瞬时态：windup 归零的那一 tick 判定扇形命中并 applyDamage，
   * 然后回 CHASE + cooldownUntil。会话时钟 now = tick × fixedStep。
   */
  private combatStep(): void {
    const t = this.tbl;
    const p = this.playerEntityId;
    if (p < 0 || !t.isAlive(p)) return;
    const px = t.posX[p]!;
    const pz = t.posZ[p]!;
    const now = this.tickCount * this.fixedStep;

    for (let i = 0; i < t.capacity; i++) {
      if (!t.isAlive(i) || this.kindOf[i] !== 1) continue;
      const stats = this.defIdToStats.get(t.defId[i]!);
      const atk = stats?.attack;
      if (atk === null || atk === undefined) continue; // 近战未定：只追不打

      const dx = t.posX[i]! - px;
      const dz = t.posZ[i]! - pz;
      const dist = Math.hypot(dx, dz);
      const b = t.behavior[i]!;

      if (b === BEHAVIOR_CHASE) {
        if (dist <= atk.rangeM && now >= t.cooldownUntil[i]!) {
          t.behavior[i] = BEHAVIOR_WINDUP;
          t.windupRemain[i] = atk.windupSec;
        }
      } else if (b === BEHAVIOR_WINDUP) {
        t.windupRemain[i] = t.windupRemain[i]! - this.fixedStep;
        if (t.windupRemain[i]! <= 0) {
          // strike（瞬时）：扇形判定 —— 攻击朝向 = 指向玩家的向量，命中 =
          // 距离在 range 内且攻击朝向与「NPC→玩家」夹角 ≤ arcDeg/2。
          // 无输入控制的朝向模型下这个夹角恒 0（打的就是眼前那只），
          // 留判定结构给「挥空/侧身闪避」（GDD 走位玩法）接上。
          const arc = atk.arcDeg ?? 90;
          const hit = dist <= atk.rangeM + t.radius[p]!;
          if (hit) {
            const halfArc = (arc * Math.PI) / 360;
            // NPC 朝向 = 移动朝向（yaw）；无移动记录时视为面向玩家（不出桩判定）
            const yaw = t.yaw[i]!;
            const facingX = Math.cos(yaw);
            const facingZ = Math.sin(yaw);
            const len = dist > 1e-6 ? dist : 1;
            const cosA = (facingX * -dx + facingZ * -dz) / len;
            if (cosA >= Math.cos(halfArc)) {
              this.applyDamage(p, atk.damage, i);
            }
          }
          // strike：瞬时态（见 BEHAVIOR_STRIKE 注释）——判定完直接回 CHASE 进 CD
          t.behavior[i] = BEHAVIOR_CHASE;
          t.cooldownUntil[i] = now + atk.cdSec;
        }
      }
    }
  }

  /**
   * 受击高亮衰减（P5 §2.1）。
   *
   * 🔴 缺了这一步，`hitFlash` 被 applyDamage 写成 0.15 之后**永远停在 0.15** ——
   * 一个只写不读又不随时间变化的列就是死列（2026-10-02 审查发现）。消费方是
   * `view().hitFlash`（HUD 血条闪红 / 渲染层 tint），语义 = "刚被打中，还剩多久"。
   *
   * 衰减在 `combatStep` **之前**：本 tick 刚受的伤先完整亮一 tick，下一 tick 才开始减。
   */
  private decayHitFlash(): void {
    const t = this.tbl;
    const dt = this.fixedStep;
    for (let i = 0; i < t.capacity; i++) {
      if (!t.isAlive(i)) continue;
      const v = t.hitFlash[i]!;
      if (v > 0) t.hitFlash[i] = Math.max(0, v - dt);
    }
  }

  /**
   * 玩家手枪射击（P5 C3，docs/23 §2.3 最小闭环）。
   *
   * 按住开火 + 武器 CD 到点 → 朝玩家朝向射一条瞬时射线（无扫掠需求，
   * docs/23 §2.1a 裁决），最近的存活 NPC 吃 applyDamage。未命中也进 CD
   *（真实射空）。朝向 = 当前输入方向；无输入时保持最近一次移动朝向（yaw）。
   */
  private fireStep(): void {
    const t = this.tbl;
    const p = this.playerEntityId;
    // 血量归零不再开火（C5 失败冻结的前哨：死了不能继续输出）
    if (!this.fireHeld || p < 0 || !t.isAlive(p) || t.health[p]! <= 0) return;
    const now = this.tickCount * this.fixedStep;
    if (now < this.playerCooldownUntil) return;

    const ix = this.inputX;
    const iz = this.inputZ;
    const len = Math.hypot(ix, iz);
    let dx: number;
    let dz: number;
    if (len > 1e-6) {
      dx = ix / len;
      dz = iz / len;
    } else {
      dx = Math.cos(t.yaw[p]!);
      dz = Math.sin(t.yaw[p]!);
    }

    let bestSlot = -1;
    let bestT = Infinity;
    const w = PLAYER_WEAPON;
    // 射线打「胶囊中轴高度」：y=0 的贴地射线对站立胶囊恰好切线（下半球心
    // y=r），目标稍一横向漂移就脱靶——中轴高度稳定穿过圆柱段
    const playerStats = this.defIdToStats.get(t.defId[p]!)!;
    const rayY = playerStats.capsuleHeight / 2;
    for (let i = 0; i < t.capacity; i++) {
      if (!t.isAlive(i) || this.kindOf[i] !== 1) continue;
      const stats = this.defIdToStats.get(t.defId[i]!);
      if (stats === undefined) continue;
      const hit = rayCapsuleY(
        [t.posX[p]!, rayY, t.posZ[p]!],
        [dx, 0, dz],
        t.posX[i]!,
        t.posZ[i]!,
        t.radius[i]!,
        stats.capsuleHeight,
      );
      if (hit !== null && hit <= w.rangeM && hit < bestT) {
        bestT = hit;
        bestSlot = i;
      }
    }
    if (bestSlot >= 0) this.applyDamage(bestSlot, w.damage, p);
    this.playerCooldownUntil = now + w.cdSec;
  }

  private moveNpcs(): void {
    const b = this.buffers;
    const t = this.table;
    let n = 0;
    for (let i = 0; i < t.capacity; i++) {
      if (!t.isAlive(i) || this.kindOf[i] !== 1) continue;
      // 前摇蓄力站定（docs/23 §2.2 windup 语义）：不进求解器 = 位置冻结
      if (t.behavior[i] === BEHAVIOR_WINDUP) continue;
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
      // 🔴 过滤条件必须与上方装填循环完全一致（含 WINDUP 跳过）——
      // 两边不一致时 k 与装填序错位，速度/位置会写进错误的实体
      if (!t.isAlive(i) || this.kindOf[i] !== 1) continue;
      if (t.behavior[i] === BEHAVIOR_WINDUP) continue;
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
  opts: { seed?: number; fixedStep?: number; capacity?: number; executor?: BehaviorExecutor } = {},
): RuntimeSession {
  return new RuntimeSession({ desc, ...opts });
}

export type { LoadDiagnostic };
