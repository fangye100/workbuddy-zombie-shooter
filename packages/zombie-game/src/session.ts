import { EnemyAttacks, type EnemyAttackWorld } from './enemy-attacks';
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
 * Zombie campaign composition belongs to this game package, not the framework.
 * Inputs, combat and death are implemented; room entry uses authored XZ bounds.
 */

import { CharacterTable, rayCapsuleY, updateLod, type LodThresholds } from '@aether/gameplay';
import { AttackTokenPool } from '@aether/ai';
import { ZombieCrowdNavigation, type ZombieNavigationPolicy } from './crowd-navigation';
import { NPC_STATS, PLAYER_STATS, PLAYER_WEAPON, lookupCharacterStats } from '@aether/content';
import type { CharacterStatsEntry } from '@aether/content';
import type { NodeId } from '@aether/scene';
import type { LevelRuntimeDesc, LoadDiagnostic } from './loader';
import type { BehaviorContext, BehaviorExecutor, BehaviorLogEntry } from "@aether/runtime";
import { NULL_BEHAVIOR_EXECUTOR } from "@aether/runtime";
import { nearestSolidHit } from "@aether/runtime";
import { RunProgress, type RunCarry } from './run-progress';
import { legacyWeaponArsenal } from '@aether/scene';
import { WeaponSystem } from "@aether/runtime";
import { WeaponCombat, type WeaponWorld } from "@aether/runtime";

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
  /** 0 idle, 1 chase, 2 windup, 3 instantaneous strike, 4 recovery. */
  behavior: number;
  /** Authoritative windup/recovery phase; rendering does not own attack clocks. */
  behaviorPhase?: number;
  /** 可叠加的 Boss 动作由游戏规则提供阶段；宿主只选择已发布片段。 */
  motionCue?: { state: 'slam' | 'slam_recover'; phase: number };
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
  /** 击杀前的 NPC 只读快照，供表现尾部消费；不代表仍存活的模拟实体。 */
  readonly defeated?: EntityView;
  readonly x?: number;
  readonly z?: number;
  readonly type: 'damage' | 'kill';
  readonly tick: number;
  /**
   * 受击槽位。
   *
   * 🔴 **槽位不是身份**（评审 4166691436）：NPC 死亡后槽位回 freelist，
   * 下一次 spawn 会把同一个下标分给另一个实体。事件缓冲是"延迟消费"的
   * （宿主每帧取一次），只带裸槽位的话，晚到的消费方会把 slot 解析成
   * 顶替上来的新实体 —— 击杀统计记到别人头上。所以必须同时带下面两项。
   */
  readonly slot: number;
  /** 受击槽位当时的代次（`slot + generation` 才构成实体身份） */
  readonly generation: number;
  /** 事件产生时的运行代次（reset() 会递增；跨局保留的事件据此失效） */
  readonly runId: number;
  readonly characterId: string;
  /** 本次伤害量（kill 事件也带，便于统计贡献） */
  readonly amount: number;
  /** 伤害后的血量（kill 时为 0） */
  readonly hpAfter: number;
  /** 造成伤害的槽位；-1 = 系统/环境伤害 */
  readonly sourceSlot: number;
  /** 伤害来源的代次（同上，防顶替）；系统伤害为 -1 */
  readonly sourceGeneration: number;
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
export const BEHAVIOR_RECOVER = 4;

/**
 * 运行代次计数器。**只用于实体引用的有效期判定**（复审 #6），
 * 不进任何模拟计算、不影响确定性 —— 同样的种子/输入下，世界的演化与它无关。
 */
let NEXT_RUN_ID = 1;

export class RuntimeSession {
  weapons: WeaponSystem;
  weaponCombat: WeaponCombat;
  get weaponMount():{position:[number,number,number];rotation:[number,number,number,number]} {
    const p=this.playerEntityId,t=this.table,y=this.defIdToStats.get(t.defId[p]!)!.capsuleHeight/2,yaw=t.yaw[p]!;
    return {position:[t.posX[p]!,y,t.posZ[p]!],rotation:[0,-Math.sin(yaw/2),0,Math.cos(yaw/2)]};
  }
  private createWeapons():WeaponSystem {
    return new WeaponSystem(this.desc.runRules?.arsenal ?? legacyWeaponArsenal({magazineSize:10000,reserveRounds:10000000,reloadSec:.1},{damage:PLAYER_WEAPON.damage,cooldownSec:PLAYER_WEAPON.cdSec,rangeM:PLAYER_WEAPON.rangeM}));
  }
  equipWeapon(id:string):boolean { return this.outcome==='running' && !this.progress?.choosing && this.weapons.equip(id); }
  upgradeWeapon():boolean {return this.outcome==='running' && !!this.progress && !this.progress.choosing && this.weapons.upgrade(cost=>{if(this.progress!.scrap<cost)return false;this.progress!.scrap-=cost;return true;});}
  readonly enemyAttacks = new EnemyAttacks();
  private attackTokens: AttackTokenPool | null = null;
  private readonly npcDecisionAt: Float64Array;
  private readonly npcRecoveryUntil: Float64Array;
  private readonly npcRecoveryStartedAt: Float64Array;
  private readonly npcRng: Uint32Array;
  private readonly npcWindupDuration: Float64Array;
  private randomNpc(slot:number):number { let x=this.npcRng[slot]!;x^=x<<13;x^=x>>>17;x^=x<<5;this.npcRng[slot]=x>>>0;return (x>>>0)/4294967296; }
  private npcDecisionDelay(slot:number):number {const timing=this.desc.runRules?.npcTiming;return timing ? timing.decisionMinSec+(timing.decisionMaxSec-timing.decisionMinSec)*this.randomNpc(slot):0;}
  private readonly attackHolders = new Map<number,number>();
  private aimPoint: [number, number] | null = null;
  setAim(x: number | null, z: number | null): void {
    this.aimPoint = x !== null && z !== null && Number.isFinite(x) && Number.isFinite(z) ? [x,z] : null;
  }
  private attackWorld(): EnemyAttackWorld {
    const t = this.table;
    return { player: this.playerEntityId,
      actor: slot => t.isAlive(slot) ? { x:t.posX[slot]!, z:t.posZ[slot]!, radius:t.radius[slot]!, generation:t.generation[slot]!, hp:t.health[slot]! } : null,
      damage: (slot,amount,source) => { this.applyDamage(slot,amount,source); },
      move: (slot,x,z) => { const ox=t.posX[slot]!,oz=t.posZ[slot]!; const [cx,cz] = this.navigation.moveActor(t,slot,x,z); t.posX[slot]=cx;t.posZ[slot]=cz;t.velX[slot]=(cx-ox)/this.fixedStep;t.velZ[slot]=(cz-oz)/this.fixedStep;return [cx,0,cz]; },
      obstruction: (from,to) => { const dx=to[0]-from[0],dy=to[1]-from[1],dz=to[2]-from[2], l=Math.hypot(dx,dy,dz); if(l<1e-6)return null; const h=nearestSolidHit(from,[dx/l,dy/l,dz/l],this.desc.shotColliders,l); return h===null?null:[from[0]+dx/l*h,from[1]+dy/l*h,from[2]+dz/l*h]; }
    };
  }
  lastShot: { tick: number; from: [number, number, number]; to: [number, number, number]; hit: boolean } | null = null;
  danger: { x: number; z: number; radius: number; remaining: number; duration: number } | null = null;
  private nextBossAttack = 0;
  private bossStep(): void {
    const attack = this.desc.runRules?.bossAttack;
    if (!attack) return;
    let boss = -1;
    for (let i = 0; i < this.table.capacity; i++) if (this.table.isAlive(i) && this.kindOf[i] === 1 && this.sourceOf[i] === attack.source) { boss = i; break; }
    if (boss < 0 || this.table.health[this.playerId]! <= 0) { this.danger = null; return; }
    const now = this.tick * this.fixedStep;
    if (this.danger) {
      this.danger.remaining -= this.fixedStep;
      if (this.danger.remaining <= 0) {
        this.enemyAttacks.impact('slam',boss,this.table.generation[boss]!,this.danger.x,this.danger.z,attack.radius,this.tick);
        if (Math.hypot(this.table.posX[this.playerId]! - this.danger.x, this.table.posZ[this.playerId]! - this.danger.z) <= attack.radius)
          this.applyDamage(this.playerId, attack.damage, boss);
        this.danger = null; this.nextBossAttack = now + attack.cooldownSec;
      }
    } else if (now >= this.nextBossAttack) {
      this.danger = { x: this.table.posX[this.playerId]!, z: this.table.posZ[this.playerId]!, radius: attack.radius, remaining: attack.windupSec, duration: attack.windupSec };
    }
  }
  progress: RunProgress | null = null;
  aimAssist = false;
  /** Carries only run state; never writes the author scene. Invalid carry is rejected atomically. */
  restoreRun(value: unknown): boolean {
    const p = this.playerId;
    if (this.tick !== 0 || !this.progress || !this.progress.restore(value, this.table.maxHp[p]!)) return false;
    this.table.health[p] = (value as RunCarry).hp;
    return true;
  }
  chooseTalent(id: string): boolean { return this.outcome !== 'game-over' && !!this.progress?.choose(id); }
  get atSupply(): boolean {
    if (!this.progress || this.progress.choosing || this.outcome === 'game-over') return false;
    if (this.outcome === 'floor-clear') return true;
    const p = this.player();
    return !!p && this.desc.rooms.some(r => r.enabled && ['event', 'shop', 'rest'].includes(r.roomType)
      && this.clearedRooms().includes(r.nodeId) && p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ);
  }
  buyHeal(): boolean {
    if (!this.atSupply) return false;
    const p = this.playerId; const amount = this.progress!.payHeal(this.table.health[p]!, this.table.maxHp[p]!);
    this.table.health[p] = this.table.health[p]! + amount; return amount > 0;
  }
  buyTalent(): boolean { return this.atSupply && this.progress!.shopTalent(); }
  buyAmmo(): boolean { return this.atSupply && this.progress!.buyAmmo(); }
  reload(): boolean { return this.outcome === 'running' && !this.progress?.choosing && this.weapons.reload(); }
  private tbl: CharacterTable;

  /** 实体状态表。唯一权威（docs/18 §1.5）—— 不要在别处再维护第二张 */
  get table(): CharacterTable {
    return this.tbl;
  }

  readonly desc: LevelRuntimeDesc;
  readonly seed: number;
  readonly fixedStep: number;

  private readonly navigation: ZombieCrowdNavigation;
  private readonly navigationPolicy: ZombieNavigationPolicy = {
    movable: i => this.kindOf[i] === 1 && this.table.behavior[i] === BEHAVIOR_CHASE && !this.enemyAttacks.moving(i,this.table.generation[i]!),
    speed: i => this.table.maxSpeed[i]! * this.table.speedScale[i]! * this.weaponCombat.slow(i,this.table.generation[i]!),
    arrivalRange: i => { const a=this.defIdToStats.get(this.table.defId[i]!)?.attack; return a?.triggerRangeM ?? a?.rangeM ?? 0; },
    height: i => this.defIdToStats.get(this.table.defId[i]!)?.capsuleHeight ?? 1.8,
  };
  navigationSnapshot() { return this.navigation.snapshot(); }
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
  private readonly interactedRooms = new Set<NodeId>();

  /** Read-only eligibility shared by the HUD and the interaction command. */
  interactionTarget(): NodeId | null {
    if (this.outcomeState !== 'running') return null;
    const player = this.player();
    if (!player || player.hp <= 0) return null;
    const room = this.desc.rooms.find(r => r.enabled && r.clearRule === 'interact'
      && player.x >= r.minX && player.x <= r.maxX && player.z >= r.minZ && player.z <= r.maxZ);
    if (!room || !this.triggered.has(room.nodeId) || this.interactedRooms.has(room.nodeId)
      || this.roomAliveEnemies(room.nodeId) > 0) return null;
    return room.nodeId;
  }

  /** Explicit player action, accepted only when the read-only query permits it. */
  interact(): boolean {
    const target = this.interactionTarget();
    if (target === null) return false;
    this.interactedRooms.add(target);
    this.progress?.rewardEvent();
    this.updateWaves();
    return true;
  }
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
  /** 最近实际玩家位置；请求/发布的网格目标与进度由 navigation 持有。 */
  private goalX = 0;
  private goalZ = 0;
  /** 导航区（构造时已保证非 null，这里留一份免得每次判空） */
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
    this.weapons=this.createWeapons();this.weaponCombat=new WeaponCombat(this.seed);
    this.progress = opts.desc.runRules ? new RunProgress(opts.desc.runRules, this.seed,this.weapons) : null;
    this.aimAssist = opts.desc.runRules?.aimAssist ?? false;
    this.attackTokens=opts.desc.runRules?new AttackTokenPool(opts.desc.runRules.attackTokenCount,0):null;
    this.initialSeed = this.seed;
    this.fixedStep = opts.fixedStep ?? 1 / 30;
    const capacity = opts.capacity ?? 512;
    this.capacity = capacity;
    this.npcDecisionAt=new Float64Array(capacity);this.npcRecoveryUntil=new Float64Array(capacity);this.npcRecoveryStartedAt=new Float64Array(capacity);this.npcRng=new Uint32Array(capacity);this.npcWindupDuration=new Float64Array(capacity);
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
    this.goalX = opts.desc.playerStart.x;
    this.goalZ = opts.desc.playerStart.z;
    this.navigation = new ZombieCrowdNavigation(nav,opts.desc.obstacles,capacity,this.goalX,this.goalZ);

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
    const bossSource = this.desc.runRules?.bossAttack?.source;
    const slam = bossSource && this.sourceOf[i] === bossSource ? this.enemyAttacks.effects.find(e => e.kind === 'slam' && e.source === i && e.generation === this.table.generation[i]) : null;
    const cue = bossSource && this.sourceOf[i] === bossSource && this.danger ? { state: 'slam' as const, phase: 1-this.danger.remaining/Math.max(.001,this.danger.duration) }
      : slam ? { state: 'slam_recover' as const, phase: (this.tickCount-slam.startTick)*this.fixedStep/Math.max(.001,slam.duration) } : null;
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
      ...(cue ? { motionCue: { ...cue, phase: Math.max(0,Math.min(1,cue.phase)) } } : {}),
      behaviorPhase: this.table.behavior[i]===BEHAVIOR_WINDUP ? Math.max(0,Math.min(1,1-this.table.windupRemain[i]!/Math.max(.001,this.npcWindupDuration[i]!)))
        : this.table.behavior[i]===BEHAVIOR_RECOVER ? Math.max(0,Math.min(1,(this.tickCount*this.fixedStep-this.npcRecoveryStartedAt[i]!)/Math.max(.001,this.npcRecoveryUntil[i]!-this.npcRecoveryStartedAt[i]!))) : 0,
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
    // 🔴 已归零的槽位一律 no-op（评审 4166674712 / 4171651617）。
    // 玩家死亡后槽位**故意**保留（要看得见死状），`isAlive` 仍为 true ——
    // 于是不加这道闸的话，同一 tick 里第二只僵尸的挥抓会再走一遍完整死亡路径：
    // 再发一条 kill 事件（击杀统计/奖励被重复计）、再跑一次 game-over 分支。
    // 死亡必须是一次性的：血量已经是 0 就是死过了。
    if (this.tbl.health[targetSlot]! <= 0) {
      return { died: false, hpAfter: 0 };
    }
    const hpAfter = Math.max(0, this.tbl.health[targetSlot]! - amount);
    this.tbl.health[targetSlot] = hpAfter;
    // 受击高亮 [PLACEHOLDER 0.15]（docs/23 §2.1；渲染层消费，先给默认时长）
    this.tbl.hitFlash[targetSlot] = 0.15;
    const characterId = this.characterIdOf(targetSlot);
    const died = hpAfter <= 0;
    this.combatEventBuf.push({
      ...(died && this.kindOf[targetSlot] === 1 ? { defeated: this.viewAt(targetSlot) } : {}),
      type: died ? 'kill' : 'damage',
      tick: this.tickCount,
      slot: targetSlot,
      generation: this.tbl.generation[targetSlot]!,
      runId: this.runId,
      characterId,
      x: this.tbl.posX[targetSlot]!, z: this.tbl.posZ[targetSlot]!,
      amount,
      hpAfter,
      sourceSlot,
      sourceGeneration: sourceSlot < 0 ? -1 : this.tbl.generation[sourceSlot]!,
    });
    if (died && this.kindOf[targetSlot] === 1 && sourceSlot === this.playerId) this.progress?.recordKill();
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

  /** 推进一个固定步。**不读墙钟**，浏览器宿主要自己用累加器调度 */
  step(): StepReport {
    // 终态冻结（P5 C5）：世界定格，tick 不再走。返回空报告 —— 宿主的累加器
    // 可以继续调度（不需要各自判终态），但世界零变化。
    if (this.outcomeState !== 'running' || this.progress?.choosing) {
      return { tick: this.tickCount, spawned: 0, rejectedRooms: 0, rejections: [] };
    }
    const r = this.triggerRooms();
    // 🔴 updateWaves 的投放量必须并入报告（评审 4166674724）：它在一个 step 里
    // 可能凭空生成**整波**实体，而旧实现只汇总 triggerRooms 的 spawned ——
    // 于是"这一帧刷了 4 只"报成 spawned: 0，靠报告做指标/断言的调用方全被误导。
    const w = this.updateWaves();
    if (this.outcome !== 'running') {
      return { tick: this.tickCount, spawned: r.spawned + w.spawned, rejectedRooms: r.rejections.length, rejections: r.rejections };
    }
    this.decayHitFlash();
    this.movePlayer();
    this.moveNpcs();
    // 战斗判定在移动之后：进入 windup / 前摇倒计时 / 打击 / 玩家射击
    // 都用**本步最终位置**（与脚本的「看到最终位置」同一纪律）
    this.combatStep();
    this.enemyAttacks.step(this.tickCount,this.fixedStep,this.attackWorld());
    if (this.aimPoint && this.playerId >= 0) this.table.yaw[this.playerId] = Math.atan2(this.aimPoint[1]-this.table.posZ[this.playerId]!,this.aimPoint[0]-this.table.posX[this.playerId]!);
    this.weapons.advance(this.fixedStep,this.tickCount);
    this.weaponCombat.step(this.tickCount,this.fixedStep,this.weaponWorld());
    this.fireStep();
    this.bossStep();
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
      spawned: r.spawned + w.spawned,
      // 🔴 rejections 仍只收 triggerRooms 的整批拒绝：updateWaves 的容量不足是
      // **推迟重试**（波不丢，下一 tick 再试，并已单独 push W_SPAWN_CAPACITY 诊断），
      // 把它算进 rejectedRooms 会让"这批怪永远不刷了"和"晚一点刷"混成同一个信号。
      rejectedRooms: r.rejections.length,
      rejections: r.rejections,
    };
  }

  /** 最近实际玩家位置；流场发布可能按预算滞后，见 navigationSnapshot().flow。 */
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
    this.interactedRooms.clear();
    this.tickCount = 0;
    this.enemyAttacks.clear(); this.aimPoint = null;
    this.attackHolders.clear();this.attackTokens=this.desc.runRules?new AttackTokenPool(this.desc.runRules.attackTokenCount,0):null;
    this.lastShot = null; this.danger = null; this.nextBossAttack = 0;
    this.diags.length = 0;
    this.diagSeen.clear();
    this.behaviorLogs.length = 0; // 跨代日志必须清：旧代日志混进来会让"重跑了没"说不清
    this.combatEventBuf.length = 0; // 战斗事件同理：跨代残留会让击杀统计重复计账
    this.sessionEventBuf.length = 0; // 波次/清房事件同理
    this.waveRooms.clear(); // 波次状态随世界重建
    this.roomAlive.clear(); // 房间存活计数同理（整表重建，计数从头累积）
    this.outcomeState = 'running'; // 终态随换代复位（重跑新的一局）
    this.weapons=this.createWeapons();this.weaponCombat=new WeaponCombat(this.seed);
    this.progress = this.desc.runRules ? new RunProgress(this.desc.runRules, this.seed,this.weapons) : null;
    this.aimAssist = this.desc.runRules?.aimAssist ?? false;
    // 换运行代次：重跑之后，旧的实体引用必须明确失效，不能被新世界里
    // 同槽位的实体冒名顶替（复审 #6）。runId 只用于引用有效期，不影响确定性。
    this.runId = NEXT_RUN_ID++;
    // 输入与导航目标也要回到初始态 —— 否则 reset 后玩家还按着上一轮的摇杆
    this.inputX = 0;
    this.inputZ = 0;
    this.fireHeld = false;
    this.goalX = this.desc.playerStart.x;
    this.goalZ = this.desc.playerStart.z;
    this.navigation.reset(this.goalX,this.goalZ);
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
      const waves = this.existingWaves(room.nodeId);
      const lastWave = waves.length === 0 ? 0 : waves[waves.length - 1]!;
      // 🔴 首波 = 实际存在的最小波号，不是硬编码 1（评审 4166691559）：
      // 房间只写了 wave 3 时，旧的 `=== 1` 过滤得到空数组 → 一只不刷，
      // 却照样发出 "wave 1 已投" 的 wave-start 事件（幽灵波）。
      const first = waves.length === 0 ? 0 : waves[0]!;
      const wave1 = pending.filter((s) => Math.max(1, Math.trunc(s.wave)) === first);
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
      // 真的投了才发事件：无刷怪点的房间（如 clearRule=interact 的过场房）
      // 不该发出"wave 1 已投"——那是把"没有波"说成"投了一波"。
      if (first !== 0) {
        this.sessionEventBuf.push({
          type: 'wave-start',
          tick: this.tickCount,
          roomNodeId: room.nodeId,
          wave: first,
        });
      }
      this.waveRooms.set(room.nodeId, {
        nextWave: waves.length > 1 ? waves[1]! : Number.POSITIVE_INFINITY,
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
   *
   * 🔴 房间清空按 `room.clearRule` 分派（评审 4166674700）：见 `isRoomSatisfied`。
   */
  private updateWaves(): { spawned: number } {
    let spawned = 0;
    if (this.waveRooms.size === 0) return { spawned };
    const interWaveTicks = Math.max(1, Math.round(INTER_WAVE_SEC / this.fixedStep));

    for (const room of this.desc.rooms) {
      if (!room.enabled) continue;
      const st = this.waveRooms.get(room.nodeId);
      if (st === undefined || st.cleared) continue;

      if (room.clearRule === 'elite-dead' && this.eliteSatisfied(room, st)) {
        st.cleared = true;
        this.sessionEventBuf.push({ type: 'room-cleared', tick: this.tickCount, roomNodeId: room.nodeId });
        this.checkFloorClear();
        continue;
      }

      if (st.nextWaveAtTick >= 0) {
        // 等投放：到点投下一波（整波原子，容量不足时这波被丢——诊断走
        // W_SPAWN_CAPACITY 同款路径，见 step 的 rejections 汇总）
        if (this.tickCount < st.nextWaveAtTick) continue;
        const waveSpawns = this.desc.spawns.filter(
          (s) =>
            s.roomNodeId === room.nodeId &&
            s.enabled &&
            s.trigger === 'room-enter' &&
            Math.max(1, Math.trunc(s.wave)) === st.nextWave,
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
        for (const s of waveSpawns) spawned += this.spawnBatch(s);
        this.sessionEventBuf.push({
          type: 'wave-start',
          tick: this.tickCount,
          roomNodeId: room.nodeId,
          wave: st.nextWave,
        });
        // 推进到**下一个实际存在**的波号（不是 ++）：投完 wave 1 而房间里只有
        // wave 1 和 wave 5 时，++ 得到 2 —— 下一轮 filter 出空数组，照样发
        // "wave 2 已投"（幽灵波），真正的 wave 5 却被跳到 Infinity 之后再也不投。
        const after = this.nextExistingWave(room.nodeId, st.nextWave + 1);
        st.nextWave = after ?? Number.POSITIVE_INFINITY;
        st.nextWaveAtTick = -1;
        continue;
      }

      // 等清空：房内活敌（本房刷怪点出生的存活 NPC）为 0？
      // 🔴 clearRule='none' 的房间**没有通关要求**（过场/纯通路），不等怪清空。
      if (room.clearRule !== 'none' && this.roomAliveEnemies(room.nodeId) > 0) continue;

      // 按**实际存在**的波号推进（评审 4166691559）：波号稀疏时（如只有 1 和 5）
      // 旧的 `nextWave++` 会造出 wave 2/3/4 三条空的 wave-start 事件 + 三次 2s 空等，
      // 作者看到的表现是"房间莫名卡住 6 秒还没怪"。
      const next = this.nextExistingWave(room.nodeId, st.nextWave);
      if (next !== null) {
        st.nextWave = next;
        st.nextWaveAtTick = this.tickCount + interWaveTicks;
        continue;
      }

      // 全部波已投完 → 按 clearRule 判"算不算清了"（评审 4166674700）
      if (!this.isRoomSatisfied(room)) continue;
      st.cleared = true;
      this.sessionEventBuf.push({ type: 'room-cleared', tick: this.tickCount, roomNodeId: room.nodeId });
      this.checkFloorClear();
    }
    return { spawned };
  }

  /**
   * 房间的通关条件是否已满足（评审 4166674700）。
   *
   * 调用点保证「本房所有波都已投完且（除 'none' 外）房内活敌归零」。
   * 剩下的差异就是 clearRule：**"怪清完" 不等于 "房间通关"** ——
   * floor-1 的 nd_f1r1 是 `interact`（要玩家交互某物件）、floor-2 有 `elite-dead`
   * （要击杀精英），它们没有战斗波，旧实现进入房间那一刻就把它判成已清，
   * 于是 `checkFloorClear()` 会发出**假的 floor-clear**（本层其实没通）。
   *
   * 未实现的规则一律**不冒充已清**并产出诊断（静默放行 = 假胜利；静默当 kill-all
   * 也是假胜利）。宁可让作者看见"这间房卡住了"，也不能让通关判定说谎。
   */
  private isRoomSatisfied(room: LevelRuntimeDesc['rooms'][number]): boolean {
    if (room.clearRule === 'kill-all' || room.clearRule === 'none') return true;
    if (room.clearRule === 'interact') return this.interactedRooms.has(room.nodeId);
    if (room.clearRule === 'elite-dead' && room.clearTarget) return this.eliteSatisfied(room, this.waveRooms.get(room.nodeId)!);
    this.pushDiag(
      'W_ROOM_CLEAR_RULE_UNSUPPORTED',
      `房间 ${room.nodeId} 的 clearRule="${room.clearRule}" 本轮未实现：不判清空（也不会冒充已清去触发假的 floor-clear）`,
      room.nodeId,
    );
    return false;
  }

  private eliteSatisfied(room: LevelRuntimeDesc['rooms'][number], state: RoomWaveState): boolean {
    const target = this.desc.spawns.find(s => s.nodeId === room.clearTarget && s.roomNodeId === room.nodeId
      && s.enabled && s.count > 0 && s.trigger === 'room-enter');
    if (!target || Math.max(1, Math.trunc(target.wave)) >= state.nextWave) return false;
    for (let i = 0; i < this.table.capacity; i++) {
      if (this.table.isAlive(i) && this.kindOf[i] === 1 && this.sourceOf[i] === target.nodeId) return false;
    }
    return true;
  }

  /** 本房（enabled + room-enter 刷怪点的）波号集合，升序、去重、≤0 归 1 */
  private existingWaves(roomNodeId: NodeId): number[] {
    const set = new Set<number>();
    for (const s of this.desc.spawns) {
      if (s.roomNodeId !== roomNodeId || !s.enabled || s.trigger !== 'room-enter') continue;
      set.add(Math.max(1, Math.trunc(s.wave)));
    }
    return [...set].sort((a, b) => a - b);
  }

  /** 大于等于 `from` 的最小**实际存在**波号；没有（= 全部投完）返回 null */
  private nextExistingWave(roomNodeId: NodeId, from: number): number | null {
    for (const w of this.existingWaves(roomNodeId)) {
      if (w >= from) return w;
    }
    return null;
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
    this.progress?.finishFloor();
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
    this.npcRng[i]=mixSeed(this.initialSeed,`npc:${i}:${this.table.generation[i]}`)||1;
    this.npcDecisionAt[i]=this.tickCount*this.fixedStep+this.npcDecisionDelay(i);
    this.npcRecoveryUntil[i]=0;
    this.npcRecoveryStartedAt[i]=0;
    this.table.behavior[i] = this.desc.runRules?.npcTiming ? BEHAVIOR_IDLE : BEHAVIOR_CHASE;
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
   * 输入 → 静态与动态连续碰撞 → 实际速度及导航目标更新。
   * 没有输入时清零实际速度；流场预算仍由后续导航步骤推进。
   */
  private movePlayer(): void {
    if (this.playerId < 0 || !this.table.isAlive(this.playerId)) return;
    const i=this.playerId,t=this.table,x=t.posX[i]!,z=t.posZ[i]!;
    t.velX[i]=0;t.velZ[i]=0;
    if (this.inputX===0 && this.inputZ===0) return;
    const speed=t.maxSpeed[i]!*(1+(this.progress?.strength('speed')??0));
    const [cx,cz]=this.navigation.moveActor(t,i,x+this.inputX*speed*this.fixedStep,z+this.inputZ*speed*this.fixedStep);
    t.posX[i]=cx;t.posZ[i]=cz;t.velX[i]=(cx-x)/this.fixedStep;t.velZ[i]=(cz-z)/this.fixedStep;
    t.yaw[i]=Math.atan2(this.inputZ,this.inputX);this.goalX=cx;this.goalZ=cz;
  }

  // ------------------------------------------------------------ 内部：NPC 移动

  /**
   * NPC 攻击状态机：idle/chase/windup/瞬时 strike/recover。
   *
   * 数值全部走 stats 真源链（C1 的 attack 嵌套结构），代码里零魔法数字；
   * attack = null 的角色（B-02/B-03 近战未定）永不进 windup，只能追。
   * 攻击距离只控制起手；锁定目标后按攻击类型运行轨迹与命中。
   * RunRules 持久化各阶段随机间隔，同一种子可复现。会话时钟 now = tick × fixedStep。
   */
  private combatStep(): void {
    const t = this.tbl;
    const p = this.playerEntityId;
    if (p < 0 || !t.isAlive(p)) return;
    const px = t.posX[p]!;
    const pz = t.posZ[p]!;
    const now = this.tickCount * this.fixedStep;

    for (const [slot,generation] of this.attackHolders) {
      if (!t.isAlive(slot) || t.generation[slot] !== generation || (t.behavior[slot] !== BEHAVIOR_WINDUP && !this.enemyAttacks.moving(slot,generation) && now >= t.cooldownUntil[slot]!)) {this.attackTokens?.release(slot);this.attackHolders.delete(slot);}
    }
    for (let i = 0; i < t.capacity; i++) {
      if (!t.isAlive(i) || this.kindOf[i] !== 1) continue;
      const stats = this.defIdToStats.get(t.defId[i]!);
      const atk = stats?.attack;
      if (!stats) continue;

      const dx = t.posX[i]! - px;
      const dz = t.posZ[i]! - pz;
      const dist = Math.hypot(dx, dz);
      const b = t.behavior[i]!;

      if (this.enemyAttacks.moving(i,t.generation[i]!)) continue;
      if (b === BEHAVIOR_IDLE || b === BEHAVIOR_RECOVER) {
        if(now < this.npcDecisionAt[i]! || b===BEHAVIOR_RECOVER && now<this.npcRecoveryUntil[i]!) continue;
        t.behavior[i]=dist<=stats!.sightRange?BEHAVIOR_CHASE:BEHAVIOR_IDLE;
        this.npcDecisionAt[i]=now+this.npcDecisionDelay(i);
      } else if (b === BEHAVIOR_CHASE) {
        if(now<this.npcDecisionAt[i]!)continue;
        this.npcDecisionAt[i]=now+this.npcDecisionDelay(i);
        if(this.desc.runRules?.npcTiming && dist>stats!.sightRange*1.1){t.behavior[i]=BEHAVIOR_IDLE;continue;}
        if (!atk) continue; // Undefined attacks can still acquire/lose a chase target.
        if (dist <= (atk.triggerRangeM ?? atk.rangeM) && now >= t.cooldownUntil[i]!) {
          const elite = stats!.id.startsWith('B-') || stats!.id === 'E-04';
          if (!elite && this.attackTokens && !this.attackTokens.request(i)) continue;
          if (!elite && this.attackTokens) this.attackHolders.set(i,t.generation[i]!);
          t.behavior[i] = BEHAVIOR_WINDUP;
          t.windupRemain[i] = atk.windupSec*(1+(this.desc.runRules?.npcTiming.windupJitterFrac??0)*this.randomNpc(i));
          this.npcWindupDuration[i]=t.windupRemain[i]!;
          t.yaw[i] = Math.atan2(-dz,-dx);
          this.enemyAttacks.lock(i,t.generation[i]!,px,pz);
        }
      } else if (b === BEHAVIOR_WINDUP) {
        if (!atk) { t.behavior[i]=BEHAVIOR_CHASE;continue; }
        t.windupRemain[i] = t.windupRemain[i]! - this.fixedStep;
        if (t.windupRemain[i]! <= 0) {
          // strike（瞬时）：扇形判定 —— 攻击朝向 = 指向玩家的向量，命中 =
          // 距离在 range 内且攻击朝向与「NPC→玩家」夹角 ≤ arcDeg/2。
          // 无输入控制的朝向模型下这个夹角恒 0（打的就是眼前那只），
          // 留判定结构给「挥空/侧身闪避」（GDD 走位玩法）接上。
          const world = this.attackWorld();
          const handled = this.enemyAttacks.strike(i,world.actor(i)!,atk,this.tickCount,world.actor(p)!,world);
          const arc = atk.arcDeg ?? 90;
          const hit = dist <= atk.rangeM + t.radius[p]!;
          if (hit && !handled) {
            const halfArc = (arc * Math.PI) / 360;
            // NPC 朝向 = 移动朝向（yaw）；无移动记录时视为面向玩家（不出桩判定）
            const yaw = t.yaw[i]!;
            const facingX = Math.cos(yaw);
            const facingZ = Math.sin(yaw);
            const len = dist > 1e-6 ? dist : 1;
            const cosA = (facingX * -dx + facingZ * -dz) / len;
            const height = (this.defIdToStats.get(t.defId[p]!)?.capsuleHeight ?? 1.8) / 2;
            const blocked = dist > 1e-6 && nearestSolidHit([t.posX[i]!, height, t.posZ[i]!], [-dx / dist, 0, -dz / dist], this.desc.shotColliders, dist) !== null;
            if (cosA >= Math.cos(halfArc) && !blocked) {
              this.applyDamage(p, atk.damage, i);
            }
          }
          // strike 后恢复与冷却分别计时；恢复期间不参与普通追击。
          const timing=this.desc.runRules?.npcTiming;
          t.behavior[i] = timing?BEHAVIOR_RECOVER:BEHAVIOR_CHASE;
          this.npcRecoveryStartedAt[i]=now;
          this.npcRecoveryUntil[i]=now+(timing?timing.recoveryMinSec+(timing.recoveryMaxSec-timing.recoveryMinSec)*this.randomNpc(i):0);
          this.npcDecisionAt[i]=this.npcRecoveryUntil[i]!+this.npcDecisionDelay(i);
          t.cooldownUntil[i] = now + atk.cdSec*(1+(timing?.cooldownJitterFrac??0)*this.randomNpc(i));
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

  /** Adapter over the authoritative entity table and finite scene solids. */
  private weaponWorld(): WeaponWorld {
    const t=this.table,p=this.playerEntityId;
    const actor=(id:number)=>t.isAlive(id) && this.kindOf[id]===1?{id,generation:t.generation[id]!,x:t.posX[id]!,z:t.posZ[id]!,radius:t.radius[id]!,hp:t.health[id]!}:null;
    const blocked:WeaponWorld['blocked']=(from,to)=>{const l=Math.hypot(to[0]-from[0],to[1]-from[1],to[2]-from[2]);return l>1e-6 && nearestSolidHit(from,[(to[0]-from[0])/l,(to[1]-from[1])/l,(to[2]-from[2])/l],this.desc.shotColliders,l)!==null;};
    return {actor,actors:()=>{const out=[];for(let i=0;i<t.capacity;i++){const a=actor(i);if(a)out.push(a);}return out;},blocked,
      trace:(from,direction,range,ignore,radius=0)=>{
        let distance=nearestSolidHit(from,direction,this.desc.shotColliders,range,radius)??range, target=null;
        for(let i=0;i<t.capacity;i++){const a=actor(i);if(!a || ignore.has(i))continue;
          const stats=this.defIdToStats.get(t.defId[i]!);if(!stats)continue;
          const h=rayCapsuleY([from[0],from[1]+radius,from[2]],direction,a.x,a.z,a.radius+radius,stats.capsuleHeight+radius*2);
          if(h!==null && h<distance){distance=h;target=a;}
        }
        return {actor:target,distance,point:[from[0]+direction[0]*distance,from[1]+direction[1]*distance,from[2]+direction[2]*distance]};
      },
      damage:(id,damage)=>{
        const a=actor(id);if(!a)return 0;const dealt=Math.min(a.hp,damage);this.applyDamage(id,damage,p);
        t.health[p]=Math.min(t.maxHp[p]!,t.health[p]!+dealt*(this.progress?.strength('leech')??0));
        const blast=this.progress?.strength('blast')??0;
        if(blast>0)for(let i=0;i<t.capacity;i++){const b=actor(i);if(!b || i===id || Math.hypot(b.x-a.x,b.z-a.z)>blast || blocked([a.x,1,a.z],[b.x,1,b.z]))continue;this.applyDamage(i,damage/2,p);}
        return dealt;
      },
      displace:(id,from,distance)=>{
        const a=actor(id);if(!a || distance<=0)return;const dx=a.x-from[0],dz=a.z-from[2],l=Math.hypot(dx,dz);if(l<1e-6)return;
        const [x,z]=this.navigation.moveActor(t,id,a.x+dx/l*distance,a.z+dz/l*distance);t.posX[id]=x;t.posZ[id]=z;
      }
    };
  }
  private fireStep(): void {
    const t=this.table,p=this.playerEntityId,w=this.weapons.active;
    if(!this.fireHeld || this.progress?.choosing || p<0 || !t.isAlive(p) || t.health[p]!<=0)return;
    if(!this.weaponCombat.canFire(w)){this.pushDiag('W_WEAPON_CAPACITY','Projectile pool is full; shot deferred',null);return;}
    if(!this.weapons.beginFire(1+(this.progress?.strength('haste')??0)))return;
    let dx=Math.cos(t.yaw[p]!),dz=Math.sin(t.yaw[p]!);
    const target=this.aimPoint ?? (Math.hypot(this.inputX,this.inputZ)>1e-6?[t.posX[p]!+this.inputX,t.posZ[p]!+this.inputZ]:null);
    if(target){const x=target[0]!-t.posX[p]!,z=target[1]!-t.posZ[p]!,l=Math.hypot(x,z);if(l>1e-6){dx=x/l;dz=z/l;}}
    const y=this.defIdToStats.get(t.defId[p]!)!.capsuleHeight/2,world=this.weaponWorld();
    if(this.aimAssist && !this.aimPoint){let nearest=w.rangeM;for(const a of world.actors()){const x=a.x-t.posX[p]!,z=a.z-t.posZ[p]!,l=Math.hypot(x,z);if(l>.001 && l<nearest && !world.blocked([t.posX[p]!,y,t.posZ[p]!],[a.x,y,a.z])){nearest=l;dx=x/l;dz=z/l;}}}
    t.yaw[p]=Math.atan2(dz,dx);
    const marker=w.presentation.markers.muzzle.position;
    const from:[number,number,number]=[t.posX[p]!+dx*marker[0]-dz*marker[2],y+marker[1],t.posZ[p]!+dz*marker[0]+dx*marker[2]];
    const origin:[number,number,number]=[t.posX[p]!,y,t.posZ[p]!];
    if(world.blocked(origin,from)) {const hit=world.trace(origin,[dx,0,dz],Math.hypot(from[0]-origin[0],from[2]-origin[2]),new Set());this.weaponCombat.effect(w,'shot',origin,hit.point,this.tick,.12,0,false);this.lastShot={tick:this.tick,from:origin,to:hit.point,hit:false};return;}
    this.weaponCombat.fire(w,from,[dx,0,dz],w.damage*this.weapons.damageMultiplier*(1+(this.progress?.strength('damage')??0)),this.tick,world);
    const effect=this.weaponCombat.effects[this.weaponCombat.effects.length-1];if(effect)this.lastShot={tick:this.tick,from:effect.from,to:effect.to,hit:effect.hit};
  }

  private moveNpcs(): void {
    const t=this.table;
    for(let i=0;i<t.capacity;i++) {
      if (!t.isAlive(i) || this.kindOf[i]!==1)continue;
      if(t.behavior[i]!==BEHAVIOR_CHASE && !this.enemyAttacks.moving(i,t.generation[i]!)){t.velX[i]=0;t.velZ[i]=0;}
    }
    this.navigation.step(t,this.playerId,this.fixedStep,this.tickCount*this.fixedStep,this.navigationPolicy);
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
