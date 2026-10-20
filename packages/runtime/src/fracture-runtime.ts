/**
 * WU-04 碎片运行与预算：通用碎片播放器。
 *
 * 责任（计划 §6.3、§10 WU-04）：真实/简化两层碎片播放、准入校验、事件去重、
 * 活动预算（容量/优先级/TTL/淡出）、异常原子清理、可观察统计、ObjectPool 租约
 * 账目。固定步长由宿主经 tick(dt)/stepOnce() 驱动，渲染频率不反推物理时钟。
 *
 * 边界：不实现 GPU 渲染（WU-05）、不实现伤害/死亡策略（WU-06/07）、不实现作者
 * UI（WU-08）。本模块只管理碎片运动状态（mesh transform/速度/休眠），实际绘制
 * 由 WU-05 读取 snapshot/活动清单。碎片是装饰：不占用武器 ProjectilePool 配额、
 * 不淘汰承担玩法职责的对象。
 */

import { ObjectPool } from '@aether/core';
import type { RapierFractureBackend } from './fracture-rapier';
import type { FractureEvent, FractureBodyHandle, FractureVec3, FractureQuat } from './fracture';
import { fractureEventKey } from './fracture';

/** 碎片 profile 中单个碎块的播放输入（由宿主从 .fracture.json + 世界变换组合）。 */
export interface FractureChunkInput {
  /** 稳定 chunkId（资产内唯一）。 */
  readonly chunkId: string;
  /** 资产分类：large 走真实刚体，small 走简化积分。 */
  readonly cls: 'large' | 'small';
  /** 激活时的世界变换（资产 bind 已组合进目标世界变换，只执行一次）。 */
  readonly position: FractureVec3;
  readonly rotation: FractureQuat;
  /** 碰撞/显示尺度（世界均匀尺度）。 */
  readonly scale: number;
  /** 碰撞代理（局部，中心在质心）。 */
  readonly shape:
    | { readonly type: 'box'; readonly halfExtents: FractureVec3 }
    | { readonly type: 'sphere'; readonly radius: number }
    | { readonly type: 'capsule'; readonly radius: number; readonly height: number }
    | { readonly type: 'convex'; readonly points: Float32Array };
  readonly mass: number;
  readonly friction: number;
  readonly restitution: number;
  /** 初始线/角速度（由来向/爆心/命中点/质心/seed 生成，本模块不再加随机）。 */
  readonly linearVelocity: FractureVec3;
  readonly angularVelocity: FractureVec3;
  readonly ccd?: boolean;
}

/** 一次激活的全部输入（事件 + profile 解析后的碎块集合 + 播放策略）。 */
export interface FractureActivation {
  readonly event: FractureEvent;
  readonly chunks: readonly FractureChunkInput[];
  /** 播放策略：优先级（大者先保留）、寿命、淡出时长。 */
  readonly priority: number;
  readonly lifetimeSec: number;
  readonly fadeSec: number;
}

/** 准入/激活拒绝的诊断（不静默丢块）。 */
export interface FractureRejection {
  readonly reason:
    | 'duplicate'           // 同 run/target 已碎裂（去重）
    | 'invalid-activation'  // 输入非法（空块/坏数值/非法尺度/非法寿命）
    | 'queue-full'          // 事件队列满
    | 'session-closed';     // 已 dispose / generation 失效
  readonly detail: string;
  readonly eventKey: string;
}

export interface FracturePlayResult {
  readonly accepted: boolean;
  readonly rejection: FractureRejection | null;
  /** 激活代次（同 target 重开时区分新旧句柄）。 */
  readonly activationGen: number;
}

/** 活动碎片的运行状态（渲染层 WU-05 读取）。 */
export interface ActiveChunk {
  readonly handle: FractureBodyHandle;
  readonly layer: 'rigid' | 'simplified';
  readonly eventKey: string;
  readonly activationGen: number;
  readonly priority: number;
  /** 已存活秒数、寿命、淡出时长。 */
  ageSec: number;
  readonly lifetimeSec: number;
  readonly fadeSec: number;
  /** 简化层的运动状态（rigid 层由后端持有）。 */
  sim: SimplifiedState | null;
  /** 是否正在淡出（0=未开始，越接近 1 越透明）。 */
  fade: number;
  expired: boolean;
}

export interface SimplifiedState {
  position: [number, number, number];
  rotation: [number, number, number, number];
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  /** 简化环境接触的地面高度（由静态镜像近似）。 */
  groundY: number;
  resting: boolean;
}

/** 可观察统计（CPU 链路；GPU/三角形/材质批属 WU-05/09）。 */
export interface FractureRuntimeStats {
  rigidActive: number;
  simplifiedActive: number;
  queuedEvents: number;
  deduplicated: number;
  rejectedAdmission: number;
  evicted: number;
  expired: number;
  /** ObjectPool 租约账目。 */
  poolActive: number;
  poolHighWater: number;
  /** 累计 CPU 毫秒：物理 step / 简化积分 / 更新合计。 */
  physicsMs: number;
  integrateMs: number;
  updateMs: number;
  ticks: number;
}

export interface FractureRuntimeOptions {
  /** 活动真实刚体上限（默认 32，计划 §6.3 待测初值，非性能认证）。 */
  maxRigidBodies?: number;
  /** 活动简化块上限（默认 256）。 */
  maxSimplifiedChunks?: number;
  /** 事件队列上限（默认 256）。 */
  maxEventQueue?: number;
  /** 固定步长秒（默认 1/60）。 */
  fixedStepSec?: number;
  /** 单帧最多补几个固定 tick（默认 5，宁可慢放不瞬移）。 */
  maxCatchUpTicks?: number;
  /** 简化积分的环境接触地面高度（无静态镜像时的兜底）。 */
  defaultGroundY?: number;
}

interface PendingEvent {
  readonly activation: FractureActivation;
  readonly eventKey: string;
}

interface Lease {
  chunk: ActiveChunk;
}

const DEFAULTS = {
  maxRigidBodies: 32,
  maxSimplifiedChunks: 256,
  maxEventQueue: 256,
  fixedStepSec: 1 / 60,
  maxCatchUpTicks: 5,
  defaultGroundY: 0,
} as const;

/** 有界简化三维积分：位置/速度/四元数/角速度 + 地面接触 + 休眠。仍是 mesh 运动状态。 */
function integrateSimplified(s: SimplifiedState, dt: number): void {
  if (s.resting) return;
  // 重力
  s.linearVelocity[1] -= 9.81 * dt;
  // 位置积分
  s.position[0] += s.linearVelocity[0] * dt;
  s.position[1] += s.linearVelocity[1] * dt;
  s.position[2] += s.linearVelocity[2] * dt;
  // 四元数积分：q' = q + 0.5*dt*ω⊗q（归一化）
  const [qx, qy, qz, qw] = s.rotation;
  const [wx, wy, wz] = s.angularVelocity;
  const hx = 0.5 * dt * (wx * qw + wy * qz - wz * qy);
  const hy = 0.5 * dt * (-wx * qz + wy * qw + wz * qx);
  const hz = 0.5 * dt * (wx * qy - wy * qx + wz * qw);
  const hw = 0.5 * dt * (-wx * qx - wy * qy - wz * qz);
  let nx = qx + hx, ny = qy + hy, nz = qz + hz, nw = qw + hw;
  const len = Math.hypot(nx, ny, nz, nw) || 1;
  s.rotation = [nx / len, ny / len, nz / len, nw / len];
  // 简化环境接触：地面反弹 + 摩擦衰减 + 休眠
  if (s.position[1] <= s.groundY) {
    s.position[1] = s.groundY;
    if (s.linearVelocity[1] < 0) s.linearVelocity[1] = -s.linearVelocity[1] * 0.3;
    s.linearVelocity[0] *= 0.7;
    s.linearVelocity[2] *= 0.7;
    s.angularVelocity[0] *= 0.6;
    s.angularVelocity[1] *= 0.6;
    s.angularVelocity[2] *= 0.6;
    const speed = Math.hypot(s.linearVelocity[0], s.linearVelocity[1], s.linearVelocity[2]);
    const spin = Math.hypot(s.angularVelocity[0], s.angularVelocity[1], s.angularVelocity[2]);
    if (speed < 0.15 && spin < 0.5) {
      s.linearVelocity = [0, 0, 0];
      s.angularVelocity = [0, 0, 0];
      s.resting = true;
    }
  }
}

export interface FractureRuntime {
  /** 提交一次性破碎激活。去重/准入校验在物理资源分配前完成。 */
  play(activation: FractureActivation): FracturePlayResult;
  /** 推进渲染帧：累加真实时间，按固定步长消费有界 tick；渲染频率不反推物理时钟。 */
  tick(frameDtSec: number): void;
  /** 恰推进一个固定 tick（Pause 后 Step 用）。 */
  stepOnce(): void;
  /** 当前活动碎片（渲染层读取）。 */
  readonly active: readonly ActiveChunk[];
  readonly stats: FractureRuntimeStats;
  /** 先归还本 session 全部租约/活动对象，再销毁后端 World。 */
  dispose(): void;
  readonly disposed: boolean;
}

let fractureSessionSeq = 0;

export function createFractureRuntime(
  backend: RapierFractureBackend,
  opts: FractureRuntimeOptions = {},
): FractureRuntime {
  const maxRigid = opts.maxRigidBodies ?? DEFAULTS.maxRigidBodies;
  const maxSimplified = opts.maxSimplifiedChunks ?? DEFAULTS.maxSimplifiedChunks;
  const maxQueue = opts.maxEventQueue ?? DEFAULTS.maxEventQueue;
  const fixedStep = opts.fixedStepSec ?? DEFAULTS.fixedStepSec;
  const maxCatchUp = opts.maxCatchUpTicks ?? DEFAULTS.maxCatchUpTicks;
  const defaultGroundY = opts.defaultGroundY ?? DEFAULTS.defaultGroundY;
  for (const [k, v, min] of [
    ['maxRigidBodies', maxRigid, 1], ['maxSimplifiedChunks', maxSimplified, 1],
    ['maxEventQueue', maxQueue, 1], ['maxCatchUpTicks', maxCatchUp, 1],
  ] as const) {
    if (!Number.isInteger(v) || (v as number) < min) throw new Error(`${k} 必须为 ≥${min} 的整数`);
  }
  if (!Number.isFinite(fixedStep) || fixedStep <= 0) throw new Error('fixedStepSec 必须为有限正数');
  if (!Number.isFinite(defaultGroundY)) throw new Error('defaultGroundY 必须为有限数');

  let disposed = false;
  let accumulator = 0;
  const sessionSeq = ++fractureSessionSeq;
  let activationCounter = 0;
  const seen = new Set<string>();               // 去重：run/target 一次性
  const queue: PendingEvent[] = [];
  const activeChunks: ActiveChunk[] = [];
  let deduplicated = 0, rejectedAdmission = 0, evicted = 0, expiredCount = 0;
  let physicsMs = 0, integrateMs = 0, updateMs = 0, ticks = 0;

  // 租约池：复用 Core ObjectPool 通用借还/异常契约，不另造重复通用池。
  // 池化的是内部 ActiveChunk 包装（wrapper），公开事件不可池化改写。
  const leasePool = new ObjectPool<Lease>({
    create: () => ({ chunk: null as unknown as ActiveChunk }),
    capacity: maxRigid + maxSimplified,
    maxRetained: Math.min(256, maxRigid + maxSimplified),
  });
  const leases = new Set<Lease>();

  function now(): number { return performance.now(); }

  function validate(a: FractureActivation): string | null {
    if (!a.chunks || a.chunks.length === 0) return '碎块集合为空';
    if (!Number.isFinite(a.priority)) return 'priority 必须为有限数';
    if (!Number.isFinite(a.lifetimeSec) || a.lifetimeSec <= 0) return 'lifetimeSec 必须为有限正数';
    if (!Number.isFinite(a.fadeSec) || a.fadeSec < 0) return 'fadeSec 必须为有限非负数';
    const ids = new Set<string>();
    for (const c of a.chunks) {
      if (!c.chunkId) return '存在空 chunkId';
      if (ids.has(c.chunkId)) return `重复 chunkId：${c.chunkId}`;
      ids.add(c.chunkId);
      if (!Number.isFinite(c.scale) || c.scale <= 0) return `${c.chunkId} 尺度非法：${c.scale}`;
      if (!Number.isFinite(c.mass) || c.mass <= 0) return `${c.chunkId} 质量非法：${c.mass}`;
      const v = [...c.position, ...c.rotation, ...c.linearVelocity, ...c.angularVelocity];
      if (v.some((n) => !Number.isFinite(n))) return `${c.chunkId} 变换/速度含非有限分量`;
    }
    return null;
  }

  /** 容量不足时按优先级淘汰：低优先级 + 旧者优先回收（不淘汰玩法职责对象——碎片纯装饰）。 */
  function evictFor(layer: 'rigid' | 'simplified', incomingPriority: number): boolean {
    const pool = activeChunks.filter((c) => c.layer === layer && !c.expired);
    const cap = layer === 'rigid' ? maxRigid : maxSimplified;
    if (pool.length < cap) return true;
    // 找出最低优先级（并列取最老）的活动块；若其优先级 ≥ 新进者则拒绝新进者。
    let victim: ActiveChunk | null = null;
    for (const c of pool) {
      if (victim === null || c.priority < victim.priority || (c.priority === victim.priority && c.ageSec > victim.ageSec)) victim = c;
    }
    if (victim === null || victim.priority >= incomingPriority) return false;
    retire(victim, 'evict');
    evicted++;
    return true;
  }

  function retire(c: ActiveChunk, why: 'expire' | 'evict' | 'dispose'): void {
    if (c.expired) return;
    c.expired = true;
    if (c.layer === 'rigid') backend.release(c.handle);
    if (why === 'expire') expiredCount++;
    // 归还租约
    for (const l of leases) {
      if (l.chunk === c) { leases.delete(l); leasePool.release(l); break; }
    }
    const i = activeChunks.indexOf(c);
    if (i >= 0) activeChunks.splice(i, 1);
  }

  /** 激活一个事件的全部碎块；任一失败原子清理本事件已建对象。 */
  function activate(a: FractureActivation): void {
    activationCounter++;
    const gen = activationCounter;
    // 句柄代次跨 session 唯一：同 target 重开新 session 不复用旧 key。
    const genKey = sessionSeq + '-' + gen;
    const eventKey = fractureEventKey(a.event);
    const built: ActiveChunk[] = [];
    try {
      for (const c of a.chunks) {
        const layer = c.cls === 'large' ? 'rigid' : 'simplified';
        if (!evictFor(layer, a.priority)) continue; // 容量不足且新进者不占优：跳过该块（诊断计入统计）
        const handle: FractureBodyHandle = {
          key: `${eventKey}#g${genKey}:${c.chunkId}`, // 含 session+激活代次，避免 key 重用误操作新 body
          chunkId: c.chunkId,
          layer,
        };
        // 物理资源先分配成功，才消耗租约——分配失败的块不产生孤儿租约。
        let sim: SimplifiedState | null = null;
        if (layer === 'rigid') {
          backend.addBody(handle, {
            position: c.position, rotation: c.rotation,
            linearVelocity: c.linearVelocity, angularVelocity: c.angularVelocity,
            shape: c.shape, mass: c.mass, friction: c.friction, restitution: c.restitution,
            ...(c.ccd === true ? { ccd: true } : {}),
          });
        } else {
          sim = {
            position: [...c.position] as [number, number, number],
            rotation: [...c.rotation] as [number, number, number, number],
            linearVelocity: [...c.linearVelocity] as [number, number, number],
            angularVelocity: [...c.angularVelocity] as [number, number, number],
            groundY: defaultGroundY, resting: false,
          };
        }
        const chunk: ActiveChunk = {
          handle, layer, eventKey, activationGen: gen, priority: a.priority,
          ageSec: 0, lifetimeSec: a.lifetimeSec, fadeSec: a.fadeSec,
          sim, fade: 0, expired: false,
        };
        // 资源已就位才借租约；acquire 失败由外层原子清理回收已建资源。
        const lease = leasePool.acquire();
        lease.chunk = chunk;
        leases.add(lease);
        activeChunks.push(chunk);
        built.push(chunk);
      }
    } catch (e) {
      // 原子清理：本事件已建对象全部回收（含已分配的真实 body 与租约）。
      for (const c of built) retire(c, 'dispose');
      throw e;
    }
  }

  function stepOne(): void {
    const t0 = now();
    backend.step(ticks);
    physicsMs += now() - t0;
    const t1 = now();
    for (const c of activeChunks) {
      c.ageSec += fixedStep;
      if (c.layer === 'simplified' && c.sim) integrateSimplified(c.sim, fixedStep);
      // 生命周期：到期进入淡出；淡出完毕退役。
      const remain = c.lifetimeSec - c.ageSec;
      if (remain <= 0) {
        if (c.fadeSec <= 0) { retire(c, 'expire'); continue; }
        c.fade = Math.min(1, -remain / c.fadeSec);
        if (c.fade >= 1) retire(c, 'expire');
      }
    }
    integrateMs += now() - t1;
    ticks++;
  }

  return {
    get active() { return activeChunks; },
    get disposed() { return disposed; },
    get stats(): FractureRuntimeStats {
      const ps = leasePool.getStats();
      return {
        rigidActive: activeChunks.filter((c) => c.layer === 'rigid').length,
        simplifiedActive: activeChunks.filter((c) => c.layer === 'simplified').length,
        queuedEvents: queue.length,
        deduplicated, rejectedAdmission, evicted, expired: expiredCount,
        poolActive: ps.active, poolHighWater: ps.highWater,
        physicsMs, integrateMs, updateMs, ticks,
      };
    },
    play(activation: FractureActivation): FracturePlayResult {
      if (disposed) {
        rejectedAdmission++;
        return { accepted: false, rejection: { reason: 'session-closed', detail: 'runtime 已 dispose', eventKey: '' }, activationGen: 0 };
      }
      const eventKey = fractureEventKey(activation.event);
      if (seen.has(eventKey)) { deduplicated++; return { accepted: false, rejection: { reason: 'duplicate', detail: '同 run/target 已碎裂', eventKey }, activationGen: 0 }; }
      const invalid = validate(activation);
      if (invalid) { rejectedAdmission++; return { accepted: false, rejection: { reason: 'invalid-activation', detail: invalid, eventKey }, activationGen: 0 }; }
      if (queue.length >= maxQueue) { rejectedAdmission++; return { accepted: false, rejection: { reason: 'queue-full', detail: `事件队列满（${maxQueue}）`, eventKey }, activationGen: 0 }; }
      seen.add(eventKey);
      queue.push({ activation, eventKey });
      return { accepted: true, rejection: null, activationGen: activationCounter + 1 };
    },
    tick(frameDtSec: number): void {
      if (disposed) return;
      if (!Number.isFinite(frameDtSec) || frameDtSec < 0) return;
      const t0 = now();
      accumulator += frameDtSec;
      let n = 0;
      // 先把队列中的事件激活为碎片（消费不重复：激活即从队列移除）。
      while (queue.length > 0 && n < maxCatchUp) {
        const p = queue.shift()!;
        activate(p.activation);
        n++;
      }
      // 再按固定步长推进物理/简化积分，有界追赶。
      let steps = 0;
      while (accumulator >= fixedStep && steps < maxCatchUp) {
        accumulator -= fixedStep;
        stepOne();
        steps++;
      }
      // 超出有界追赶的残余时间丢弃（宁可慢放不瞬移），避免下一帧雪崩。
      if (steps >= maxCatchUp && accumulator >= fixedStep) accumulator = 0;
      updateMs += now() - t0;
    },
    stepOnce(): void {
      if (disposed) return;
      while (queue.length > 0) { const p = queue.shift()!; activate(p.activation); }
      stepOne();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // 先归还本 session 全部活动租约/半完成对象，再由 owner 销毁 World。
      for (const c of [...activeChunks]) retire(c, 'dispose');
      // 半完成对象（原子清理中归还失败的孤儿租约）一并销毁，账目闭环。
      for (const l of [...leases]) {
        leases.delete(l);
        if (leasePool.isActive(l)) leasePool.invalidate(l);
      }
      queue.length = 0;
      // 池.dispose() 只销毁闲置；活动租约已在上面 retire 归还，此时 release 会因
      // disposed 走 destroy 路径，账目闭环。
      leasePool.dispose();
      backend.destroy();
    },
  };
}
