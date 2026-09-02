/**
 * 决策层：Blackboard（SoA 共享状态） + Perception（感知） + Utility 选意图。
 *
 * 选型结论：**Utility 选意图 + HFSM 执行**。
 * 不上 GOAP —— 尸潮不需要"规划"，只需要"冲上去"；而 Utility 的每个 consideration
 * 天然就是一个可以被肉鸽词条乘的权重。
 */

import { SpatialHash } from './navigation';

export const UNSET_TARGET = -1;

export const enum Behavior {
  Idle = 0,
  Investigate = 1,
  Chase = 2,
  Circle = 3,
  Attack = 4,
  Flee = 5,
  Stagger = 6,
  Dead = 7,
}

export const enum Alert {
  Calm = 0,
  Suspicious = 1,
  Aggro = 2,
}

/** 每 NPC 的个体黑板，列式存储 */
export class Blackboard {
  count = 0;

  target: Int32Array;
  alert: Uint8Array;
  /** 0..1 连续警觉度，衰减而非布尔切换 —— 玩家躲起来后应该徘徊一会儿再散开 */
  alertLevel: Float32Array;
  lastKnownX: Float32Array;
  lastKnownZ: Float32Array;
  lastSeenTick: Uint32Array;
  nextThinkTick: Uint32Array;
  behavior: Uint8Array;
  behaviorEnterTick: Uint32Array;
  utility: Float32Array;

  constructor(readonly capacity: number) {
    this.target = new Int32Array(capacity).fill(UNSET_TARGET);
    this.alert = new Uint8Array(capacity);
    this.alertLevel = new Float32Array(capacity);
    this.lastKnownX = new Float32Array(capacity);
    this.lastKnownZ = new Float32Array(capacity);
    this.lastSeenTick = new Uint32Array(capacity);
    this.nextThinkTick = new Uint32Array(capacity);
    this.behavior = new Uint8Array(capacity).fill(Behavior.Idle);
    this.behaviorEnterTick = new Uint32Array(capacity);
    this.utility = new Float32Array(capacity);
  }
}

/** 可被感知的目标（玩家 / 队友 / 噪声源），数量很少，暴力遍历即可 */
export interface TargetView {
  count: number;
  posX: Float32Array;
  posZ: Float32Array;
  alive: Uint8Array;
  /** 本 tick 发出的噪声半径（枪声 25m、玻璃 12m、脚步 6m），0 = 无声 */
  noiseRadius: Float32Array;
}

export interface PerceptionParams {
  sightRange: number;
  /** cos(fov/2)。僵尸用 200° 广角，靠余光察觉 */
  fovCos: number;
  hearingRange: number;
  /** 遮挡射线的采样间隔（tick）。射线是最贵的一步，降频做 */
  losInterval: number;
  /** 警觉度衰减（每秒） */
  alertDecay: number;
  /** 群体传染半径与间隔 */
  aggroRadius: number;
  aggroInterval: number;
}

/** 视线检测交给物理层（Raycast 批处理），此处只做回调 */
export type LineOfSightFn = (ax: number, az: number, bx: number, bz: number) => boolean;

export interface AgentView {
  count: number;
  posX: Float32Array;
  posZ: Float32Array;
  /** 朝向的余弦/正弦，预先算好避免决策里反复三角函数 */
  dirX: Float32Array;
  dirZ: Float32Array;
  alive: Uint8Array;
}

export class PerceptionSystem {
  private readonly near = new Int32Array(64);
  private los: LineOfSightFn | null = null;

  constructor(
    private readonly bb: Blackboard,
    private readonly hash: SpatialHash,
  ) {}

  /**
   * 10Hz 分帧调用。early-out 顺序固定为：距离 → 角度 → 射线，
   * 把最贵的射线留到最后。
   */
  update(agents: AgentView, targets: TargetView, p: PerceptionParams, tick: number, dt: number): void {
    this.hash.build(agents.posX, agents.posZ, agents.count);

    const sightSq = p.sightRange * p.sightRange;
    const doLos = tick % p.losInterval === 0;
    const los = this.los;

    for (let i = 0; i < agents.count; i++) {
      if (agents.alive[i] === 0) continue;

      const x = agents.posX[i]!;
      const z = agents.posZ[i]!;
      let best = UNSET_TARGET;
      let bestSq = Infinity;

      for (let t = 0; t < targets.count; t++) {
        if (targets.alive[t] === 0) continue;
        const dx = targets.posX[t]! - x;
        const dz = targets.posZ[t]! - z;
        const dSq = dx * dx + dz * dz;

        // ① 距离 / 听觉 early-out
        const noise = targets.noiseRadius[t]!;
        if (dSq > sightSq && (noise <= 0 || dSq > noise * noise)) continue;

        if (dSq > sightSq) {
          // 听觉命中：只知道"可疑位置"，不给精确目标
          if (dSq < bestSq) {
            bestSq = dSq;
            best = t;
          }
          continue;
        }

        // ② 视锥
        const dist = Math.sqrt(dSq);
        if (dist > 1e-3) {
          const dot = (dx / dist) * agents.dirX[i]! + (dz / dist) * agents.dirZ[i]!;
          if (dot < p.fovCos) continue;
        }

        // ③ 遮挡射线（降频）
        if (doLos && los !== null) {
          if (!los(x, z, targets.posX[t]!, targets.posZ[t]!)) continue;
        }

        if (dSq < bestSq) {
          bestSq = dSq;
          best = t;
        }
      }

      if (best !== UNSET_TARGET) {
        this.bb.target[i] = best;
        this.bb.lastKnownX[i] = targets.posX[best]!;
        this.bb.lastKnownZ[i] = targets.posZ[best]!;
        this.bb.lastSeenTick[i] = tick;
        this.bb.alertLevel[i] = 1;
        this.bb.alert[i] = Alert.Aggro;
      } else {
        const decayed = this.bb.alertLevel[i]! - p.alertDecay * dt;
        this.bb.alertLevel[i] = decayed > 0 ? decayed : 0;
        if (this.bb.alertLevel[i]! <= 0) {
          this.bb.alert[i] = Alert.Calm;
          this.bb.target[i] = UNSET_TARGET;
        } else if (this.bb.alertLevel[i]! < 0.5) {
          this.bb.alert[i] = Alert.Suspicious;
        }
      }
    }

    if (tick % p.aggroInterval === 0) this.propagateAggro(agents, p);
  }

  /**
   * 群体传染：处于 Aggro 的 NPC 向邻近同伴广播。
   * 尸潮"连锁反应"的观感全靠它，成本极低。
   */
  private propagateAggro(agents: AgentView, p: PerceptionParams): void {
    const rSq = p.aggroRadius * p.aggroRadius;
    for (let i = 0; i < agents.count; i++) {
      if (agents.alive[i] === 0 || this.bb.alert[i] !== Alert.Aggro) continue;
      const x = agents.posX[i]!;
      const z = agents.posZ[i]!;
      const n = this.hash.query(x, z, this.near);
      for (let k = 0; k < n; k++) {
        const j = this.near[k]!;
        if (j === i || agents.alive[j] === 0) continue;
        if (this.bb.alert[j] === Alert.Aggro) continue;
        const dx = agents.posX[j]! - x;
        const dz = agents.posZ[j]! - z;
        if (dx * dx + dz * dz > rSq) continue;
        this.bb.alert[j] = Alert.Suspicious;
        this.bb.alertLevel[j] = Math.max(this.bb.alertLevel[j]!, 0.6);
        this.bb.lastKnownX[j] = this.bb.lastKnownX[i]!;
        this.bb.lastKnownZ[j] = this.bb.lastKnownZ[i]!;
      }
    }
  }

  setLineOfSight(fn: LineOfSightFn | null): void {
    this.los = fn;
  }
}

export interface UtilityContext {
  /** 到目标距离 / 攻击距离，<1 表示已进入攻击范围 */
  distance01: number;
  health01: number;
  /** 攻击冷却剩余比例，0 = 随时可打 */
  cooldown01: number;
  /** 周围同伴密度 0..1 */
  crowd01: number;
  /** 目标是否可见 */
  visible: number;
  alert01: number;
}

export interface UtilityProfile {
  chase: number;
  attack: number;
  circle: number;
  flee: number;
  investigate: number;
  /** 迟滞：新行为需超过当前行为 score × hysteresis 才切换 */
  hysteresis: number;
  /** 最小驻留 tick，防止每帧反复横跳 */
  minDwellTicks: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function scoreFor(b: Behavior, c: UtilityContext, w: UtilityProfile): number {
  switch (b) {
    case Behavior.Chase:
      return w.chase * clamp01(1.4 - c.distance01) * (0.25 + 0.75 * c.visible);
    case Behavior.Attack:
      return (
        w.attack *
        clamp01(1.6 - c.distance01) *
        (1 - c.cooldown01) *
        (1 - 0.5 * c.crowd01)
      );
    case Behavior.Circle:
      // 挤不进去就绕圈游走伺机 —— 攻击名额的"溢出池"
      return w.circle * clamp01(2.2 - c.distance01) * c.crowd01;
    case Behavior.Flee:
      return w.flee * (1 - c.health01);
    case Behavior.Investigate:
      return w.investigate * c.alert01 * (1 - c.visible);
    default:
      return 0;
  }
}

const SCORED: readonly Behavior[] = [
  Behavior.Chase,
  Behavior.Attack,
  Behavior.Circle,
  Behavior.Flee,
  Behavior.Investigate,
];

export class UtilitySelector {
  constructor(private readonly profile: UtilityProfile) {}

  /**
   * 返回本 tick 应进入的行为。带迟滞 + 最小驻留，避免决策抖动。
   */
  select(bb: Blackboard, i: number, c: UtilityContext, tick: number): Behavior {
    const current = bb.behavior[i] as Behavior;
    if (current === Behavior.Dead || current === Behavior.Stagger) return current;
    if (tick - bb.behaviorEnterTick[i]! < this.profile.minDwellTicks) return current;

    let bestBehavior: Behavior = current;
    let bestScore = scoreFor(current, c, this.profile) * this.profile.hysteresis;

    for (let k = 0; k < SCORED.length; k++) {
      const b = SCORED[k]!;
      if (b === current) continue;
      const s = scoreFor(b, c, this.profile);
      if (s > bestScore) {
        bestScore = s;
        bestBehavior = b;
      }
    }

    // 全部分数都很低 → 回落到 Idle
    if (bestScore < 0.05 && current !== Behavior.Idle) return Behavior.Idle;

    if (bestBehavior !== current) {
      bb.behavior[i] = bestBehavior;
      bb.behaviorEnterTick[i] = tick;
      bb.utility[i] = bestScore;
    }
    return bestBehavior;
  }
}

/**
 * 分帧摊平：按 entity index 分桶，每帧只 tick 一桶。
 * 决策实际频率 = 60 / bucketCount，但 CPU 曲线是平的，不会有"某一帧全算"的尖峰。
 */
export class DecisionScheduler {
  constructor(readonly bucketCount: number) {}

  shouldTick(index: number, tick: number): boolean {
    return index % this.bucketCount === tick % this.bucketCount;
  }
}

/** 距离越近 tick 越频繁（近处 15Hz，远处 2.5Hz）—— 近处的表现才重要 */
export function thinkIntervalFor(distance: number, nearDist: number, farDist: number): number {
  const t = clamp01((distance - nearDist) / Math.max(1e-3, farDist - nearDist));
  return Math.max(1, Math.round(4 + t * 20));
}
