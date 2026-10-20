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
import { fractureEventKey, frozenFractureEvent } from './fracture';

/** 碎片 profile 中单个碎块的播放输入（由宿主从 .fracture.json + 世界变换组合）。 */
export interface FractureChunkInput {
  /** 稳定 chunkId（资产内唯一）。 */
  readonly chunkId: string;
  /** 资产分类：large 走真实刚体，small 走简化积分。 */
  readonly cls: 'large' | 'small';
  /** 碎块 GLB 稳定引用（WU-05 动态渲染用，不再回读资产/事件）。 */
  readonly mesh: { readonly path: string; readonly guid: string };
  /** 激活时的世界变换（资产 bind 已组合进目标世界变换，只执行一次）。 */
  readonly position: FractureVec3;
  readonly rotation: FractureQuat;
  /** 显示/碰撞世界尺度（bind.scale 已按三轴组合进 shape 与本值；非均匀组合在准入拒绝）。 */
  readonly scale: number;
  /** 碰撞代理（未缩放的资产局部，中心在质心）；激活时按 scale 折进世界尺寸。 */
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
  /** 入队序号（queueSeq，随 play 单调递增；非激活代次，激活代次在激活时赋予）。 */
  readonly activationGen: number;
}

/** 活动碎片的运行状态（渲染层 WU-05 读取）。 */
export interface ActiveChunk {
  readonly handle: FractureBodyHandle;
  readonly layer: 'rigid' | 'simplified';
  /** 碎块 GLB 稳定引用（WU-05 动态渲染直接使用，不维护第二份初始化状态）。 */
  readonly mesh: { readonly path: string; readonly guid: string };
  /** 激活时世界 TRS（WU-05 首帧放置；显示尺度 = scale，非 supportRadius）。 */
  readonly worldPosition: FractureVec3;
  readonly worldRotation: FractureQuat;
  readonly worldScale: number;
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
  /** 块代理支撑半径（世界尺度；简化层接触 + WU-05 显示尺度共用）。 */
  readonly supportRadius: number;
  /** 内部租约（dispose/retire 归还）。 */
  lease: Lease | null;
}

export interface SimplifiedState {
  position: [number, number, number];
  rotation: [number, number, number, number];
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
  /** 块代理的支撑半径（世界尺度，从 shape*scale 推出；接触时质心停在支撑面+radius）。 */
  supportRadius: number;
  /** 简化摩擦/恢复（来自输入策略，非固定常数）。 */
  friction: number;
  restitution: number;
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
  /** 满额且新进者优先级不占优被跳过的碎块数（显式计数，不静默丢块）。 */
  skipped: number;
  /** 激活中途失败（已原子清理）的事件数。 */
  failedActivations: number;
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
}

interface PendingEvent {
  readonly activation: FractureActivation;
  readonly eventKey: string;
  readonly queueSeq: number;
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
} as const;

/** 支撑面（来自真实场景 collider 镜像；无镜像则小块继续下落，不生成无限地面）。 */
interface SupportSurface { x: number; z: number; topY: number; halfX: number; halfZ: number }

/**
 * 查询本次竖向运动能接触的支撑面顶 Y（R2）：
 * - 只考虑本步下落会穿越的面（prevY >= topY >= currY），不选头顶天花板；
 * - 无穿越面时，已贴伏的块（底部距面 ≤ 1cm）贴住该面；
 * - 多块中保守选顶面较低者（不向上跳到更高面）；
 * - 无支撑返回 null（继续下落，不生成无限地面）。
 */
function supportHeightAt(
  surfaces: readonly SupportSurface[],
  x: number, prevY: number, currY: number, z: number,
): number | null {
  let crossed: number | null = null;
  let resting: number | null = null;
  for (const su of surfaces) {
    if (Math.abs(x - su.x) > su.halfX || Math.abs(z - su.z) > su.halfZ) continue;
    // 本步竖向穿越或触底该面（含穿越与精确落停；容差覆盖高速步过冲）
    if (prevY >= su.topY - 0.001 && currY <= su.topY + 0.001) {
      if (crossed === null || su.topY < crossed) crossed = su.topY;
    // 已贴伏在面上（resting 保持）
    } else if (prevY >= su.topY && prevY - su.topY <= 0.01) {
      if (resting === null || su.topY < resting) resting = su.topY;
    }
  }
  return crossed ?? resting;
}

/** 有界简化三维积分：位置/速度/四元数/角速度 + 场景支撑面接触 + 休眠。仍是 mesh 运动状态。 */
function integrateSimplified(s: SimplifiedState, dt: number, surfaces: readonly SupportSurface[]): void {
  // 支撑被删除/移开时唤醒已休眠块（R2）：resting 仅在支撑仍存在时保持，
  // 支撑消失后重新进入积分并下落。
  if (s.resting) {
    // 用纯 XZ 范围查询（不走穿越窗口），判断块当前所在面是否仍存在。
    let top: number | null = null;
    for (const su of surfaces) {
      if (Math.abs(s.position[0] - su.x) <= su.halfX && Math.abs(s.position[2] - su.z) <= su.halfZ) {
        if (top === null || su.topY < top) top = su.topY;
      }
    }
    if (top === null || Math.abs(s.position[1] - (top + s.supportRadius)) > 0.01) s.resting = false;
    else return;
  }
  const prevY = s.position[1];
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
  // 有界环境接触（R2）：用竖向扫掠选择本步能接触的支撑面（不选头顶天花板）；
  // 质心停在 支撑面顶 + 块支撑半径，不把质心塞进地板。
  // 无支撑面（场景无 collider/已移出边界）则继续下落。
  const top = supportHeightAt(surfaces, s.position[0], prevY, s.position[1], s.position[2]);
  if (top === null) return;
  const floor = top + s.supportRadius;
  // 质心降至支撑面+半径以下（含本步穿越）且正在下落时接触。
  if (s.position[1] <= floor && s.linearVelocity[1] <= 0) {
    s.position[1] = floor;
    if (s.linearVelocity[1] < 0) s.linearVelocity[1] = -s.linearVelocity[1] * s.restitution;
    const fri = Math.max(0, 1 - s.friction);
    s.linearVelocity[0] *= fri;
    s.linearVelocity[2] *= fri;
    s.angularVelocity[0] *= fri;
    s.angularVelocity[1] *= fri;
    s.angularVelocity[2] *= fri;
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
  for (const [k, v, min] of [
    ['maxRigidBodies', maxRigid, 1], ['maxSimplifiedChunks', maxSimplified, 1],
    ['maxEventQueue', maxQueue, 1], ['maxCatchUpTicks', maxCatchUp, 1],
  ] as const) {
    if (!Number.isInteger(v) || (v as number) < min) throw new Error(`${k} 必须为 ≥${min} 的整数`);
  }
  if (!Number.isFinite(fixedStep) || fixedStep <= 0) throw new Error('fixedStepSec 必须为有限正数');
  // 唯一固定步长合同：runtime 年龄/简化层与真实后端共享同一物理时钟，
  // 拒绝与后端 timestep 不一致的步长（不再让年龄与真实物理时间脱离）。
  const backendStep = backend.worldTimestep();
  if (backendStep !== undefined && Math.abs(backendStep - fixedStep) > 1e-6) {
    throw new Error(`fixedStepSec(${fixedStep}) 与后端 timestep(${backendStep}) 不一致：碎片年龄与真实物理时间必须共享同一时钟`);
  }

  let disposed = false;
  let accumulator = 0;
  const sessionSeq = ++fractureSessionSeq;
  let activationCounter = 0;
  let queueCounter = 0;
  const seen = new Set<string>();               // 去重：run/target 一次性
  const queue: PendingEvent[] = [];
  const activeChunks: ActiveChunk[] = [];
  let deduplicated = 0, rejectedAdmission = 0, evicted = 0, expiredCount = 0, skipped = 0, failedActivations = 0;
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

  /** 深拷贝一个激活输入，使入队后不受外部改写（R5 队列所有权边界）。 */
  function snapshotActivation(a: FractureActivation): FractureActivation {
    const v3 = (v: FractureVec3): FractureVec3 => [v[0], v[1], v[2]];
    const q = (v: FractureQuat): FractureQuat => [v[0], v[1], v[2], v[3]];
    const shape = (sh: FractureChunkInput['shape']): FractureChunkInput['shape'] => {
      if (sh.type === 'box') return { type: 'box', halfExtents: v3(sh.halfExtents) };
      if (sh.type === 'sphere') return { type: 'sphere', radius: sh.radius };
      if (sh.type === 'capsule') return { type: 'capsule', radius: sh.radius, height: sh.height };
      return { type: 'convex', points: new Float32Array(sh.points) }; // 复制 TypedArray
    };
    return {
      event: frozenFractureEvent(a.event), // 冻结：提交后改写不影响激活身份/handle key
      chunks: a.chunks.map((c) => ({
        chunkId: c.chunkId, cls: c.cls, mesh: { path: c.mesh.path, guid: c.mesh.guid },
        position: v3(c.position), rotation: q(c.rotation), scale: c.scale,
        shape: shape(c.shape), mass: c.mass, friction: c.friction, restitution: c.restitution,
        linearVelocity: v3(c.linearVelocity), angularVelocity: v3(c.angularVelocity),
        ...(c.ccd === true ? { ccd: true } : {}),
      })),
      priority: a.priority, lifetimeSec: a.lifetimeSec, fadeSec: a.fadeSec,
    };
  }

  function validate(a: FractureActivation): string | null {
    if (!a.chunks || a.chunks.length === 0) return '碎块集合为空';
    if (!Number.isFinite(a.priority)) return 'priority 必须为有限数';
    if (!Number.isFinite(a.lifetimeSec) || a.lifetimeSec <= 0) return 'lifetimeSec 必须为有限正数';
    if (!Number.isFinite(a.fadeSec) || a.fadeSec < 0) return 'fadeSec 必须为有限非负数';
    const ids = new Set<string>();
    for (const c of a.chunks) {
      if (!c.chunkId) return '存在空 chunkId';
      if (!c.mesh || typeof c.mesh.path !== 'string' || !c.mesh.path || typeof c.mesh.guid !== 'string' || !c.mesh.guid) return c.chunkId + ' 缺少稳定 mesh 引用';
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
    // 归还租约（chunk 持有 lease 引用，避免线性查找/漏还）。
    if (c.lease !== null) {
      const l = c.lease;
      c.lease = null;
      if (leases.delete(l) && leasePool.isActive(l)) leasePool.release(l);
    }
    const i = activeChunks.indexOf(c);
    if (i >= 0) activeChunks.splice(i, 1);
  }

  /** 取 chunk 的世界缩放代理（scale 折进 shape，唯一一次，不重复乘）。 */
  function scaledShape(c: FractureChunkInput): FractureChunkInput['shape'] {
    const k = c.scale;
    const sh = c.shape;
    if (sh.type === 'box') return { type: 'box', halfExtents: [sh.halfExtents[0] * k, sh.halfExtents[1] * k, sh.halfExtents[2] * k] };
    if (sh.type === 'sphere') return { type: 'sphere', radius: sh.radius * k };
    if (sh.type === 'capsule') return { type: 'capsule', radius: sh.radius * k, height: sh.height * k };
    // convex：点集整体缩放（复制，不改外部 TypedArray）
    const pts = new Float32Array(sh.points.length);
    for (let n = 0; n < sh.points.length; n++) pts[n] = sh.points[n]! * k;
    return { type: 'convex', points: pts };
  }

  /** chunk 代理的支撑半径（世界尺度，用于简化层支撑面接触与显示尺度携带）。 */
  function supportRadiusOf(c: FractureChunkInput): number {
    const sh = c.shape;
    if (sh.type === 'sphere') return sh.radius * c.scale;
    if (sh.type === 'box') return sh.halfExtents[1] * c.scale; // 竖直半高
    if (sh.type === 'capsule') return (sh.height / 2) * c.scale;
    // convex：用点集到原点最大距离近似支撑半径
    let r = 0;
    for (let n = 0; n + 2 < sh.points.length; n += 3) {
      const d = Math.hypot(sh.points[n]!, sh.points[n + 1]!, sh.points[n + 2]!) * c.scale;
      if (d > r) r = d;
    }
    return r;
  }

  /** 激活一个事件的全部碎块；任一阶段失败原子回收当前块及本事件已建资源。 */
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
        if (!evictFor(layer, a.priority)) { skipped++; continue; } // 容量不足且不占优：显式计数跳过，不静默丢块
        const handle: FractureBodyHandle = {
          key: `${eventKey}#g${genKey}:${c.chunkId}`, // 含 session+激活代次，避免 key 重用误操作新 body
          chunkId: c.chunkId,
          layer,
        };
        // R6：scale 折进代理（唯一一次）；支撑半径供简化层与 WU-05 显示尺度。
        const worldShape = scaledShape(c);
        const supportRadius = supportRadiusOf(c);
        // R4：每个中间资源从分配开始即有清理 owner——先建资源并入 built，再借租约。
        // 任何阶段（addBody/acquire/注册）失败，catch 回收 built 内全部（含当前块）。
        const chunkMesh = { path: c.mesh.path, guid: c.mesh.guid };
        let sim: SimplifiedState | null = null;
        if (layer === 'rigid') {
          backend.addBody(handle, {
            position: c.position, rotation: c.rotation,
            mesh: chunkMesh,
            linearVelocity: c.linearVelocity, angularVelocity: c.angularVelocity,
            shape: worldShape, mass: c.mass, friction: c.friction, restitution: c.restitution,
            ...(c.ccd === true ? { ccd: true } : {}),
          });
        } else {
          sim = {
            position: [...c.position] as [number, number, number],
            rotation: [...c.rotation] as [number, number, number, number],
            linearVelocity: [...c.linearVelocity] as [number, number, number],
            angularVelocity: [...c.angularVelocity] as [number, number, number],
            supportRadius, friction: c.friction, restitution: c.restitution, resting: false,
          };
        }
        // 资源已就位；先入 built（携带清理所需的 handle/layer），再借租约。
        const chunk: ActiveChunk = {
          handle, layer, mesh: chunkMesh, eventKey, activationGen: gen, priority: a.priority,
          worldPosition: [c.position[0], c.position[1], c.position[2]],
          worldRotation: [c.rotation[0], c.rotation[1], c.rotation[2], c.rotation[3]],
          worldScale: c.scale,
          ageSec: 0, lifetimeSec: a.lifetimeSec, fadeSec: a.fadeSec,
          sim, fade: 0, expired: false, supportRadius, lease: null,
        };
        built.push(chunk); // 先登记清理 owner：acquire 失败也会回收当前块 body
        const lease = leasePool.acquire(); // 抛错 → catch retire 当前块（释放 body）
        lease.chunk = chunk;
        leases.add(lease);
        chunk.lease = lease;
        activeChunks.push(chunk);
      }
    } catch (e) {
      // 原子清理：built 内全部（含当前块）回收 body/租约；不外溢。
      for (const c of built) retire(c, 'dispose');
      failedActivations++; // 显式诊断/计数，不裸异常穿透宿主而无观察
      throw e;
    }
  }

  function stepOne(): void {
    const t0 = now();
    backend.step(ticks);
    physicsMs += now() - t0;
    // 简化层环境接触复用真实场景 collider 镜像的支撑面（场景变化经 sync 后反映）；
    // 无镜像时返回空，小块继续下落，不生成无限地面。
    const supportSurfaces = backend.staticSupportSurfaces();
    const t1 = now();
    // 遍历期间 retire 会 splice activeChunks：用拷贝遍历，避免同 tick 多块到期时跳块。
    for (const c of [...activeChunks]) {
      c.ageSec += fixedStep;
      if (c.layer === 'simplified' && c.sim) integrateSimplified(c.sim, fixedStep, supportSurfaces);
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
        deduplicated, rejectedAdmission, evicted, expired: expiredCount, skipped, failedActivations,
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
      const queueSeq = ++queueCounter;
      // R5：队列所有权边界——入队即取不可被外部改写的深拷贝快照（复制嵌套数组与
      // convex TypedArray）。activate 用快照身份/变换，不再读外部可变对象；
      // 提交后改写调用方 chunks/event/TRS/凸点缓存均不改变已提交请求与去重。
      queue.push({ activation: snapshotActivation(activation), eventKey, queueSeq });
      return { accepted: true, rejection: null, activationGen: queueSeq };
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
