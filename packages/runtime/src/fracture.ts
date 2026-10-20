/**
 * 碎裂系统的通用公共契约（WU-01 冻结接口边界）。
 *
 * 本文件只定义事件事实、身份、句柄、预算与物理后端边界；不实现物理求解、
 * 渲染或游戏破坏策略（WU-03–WU-07 的责任）。游戏状态不等待 GPU 读回，
 * 碎块位置/粒子计数不得反向计算伤害、掉落或通关。
 */

export type FractureVec3 = readonly [number, number, number];
export type FractureQuat = readonly [number, number, number, number];

/** 破碎 profile 的稳定引用（path + sidecar GUID）。 */
export interface FractureProfileRef {
  readonly path: string;
  readonly guid: string;
}

/**
 * 破碎目标身份。场景对象用稳定 NodeId + 运行会话身份；NPC 用
 * runId + 槽位/id + generation，不在槽位回收后读新代次实体的数据。
 */
export type FractureTarget =
  | { readonly kind: 'scene-object'; readonly runId: string; readonly nodeId: string }
  | { readonly kind: 'npc'; readonly runId: string; readonly slot: number; readonly id: number; readonly generation: number };

/** 触发来源沿既有 WeaponDamageFacts 语义；burn 不借用同帧直接命中序号。 */
export interface FractureSource {
  readonly weaponId: string;
  readonly damageKind?: 'burn';
  readonly hitSequence: number;
}

/** 一次性破碎事实快照：激活所需的不可变位置、变换接触与资产身份。 */
export interface FractureEvent {
  readonly sequence: number;
  readonly tick: number;
  readonly seed: number;
  readonly profile: FractureProfileRef;
  readonly target: FractureTarget;
  /**
   * 激活 tick 的目标世界变换快照（位置/旋转/尺度）。资产 assemblyScale 与身高归一化
   * 已在发布前组合进该世界变换（资产局部 → assemblyScale → 目标局部 → 世界，唯一
   * 转换链只执行一次）；消费者不得在槽位回收后重读目标，也不得二次缩放。
   */
  readonly position: FractureVec3;
  readonly rotation: FractureQuat;
  readonly scale: FractureVec3;
  readonly contact: FractureVec3 | null;
  readonly normal: FractureVec3 | null;
  readonly impulse: FractureVec3 | null;
  readonly source: FractureSource;
}

export function fractureTargetKey(target: FractureTarget): string {
  return target.kind === 'scene-object'
    ? `scene-object:${target.runId}:${target.nodeId}`
    : `npc:${target.runId}:${target.slot}:${target.id}:${target.generation}`;
}

/**
 * 播放去重键：一个身份在一次运行内只碎裂一次。物体状态先完成一次性转换
 * 再发布表现事实；散弹/贯穿/爆炸及同 tick 多次伤害不得重复破碎同一对象。
 */
export function fractureEventKey(event: FractureEvent): string {
  return fractureTargetKey(event.target);
}

/** 公开事件快照不可池化后改写；发布前冻结嵌套数组。 */
export function frozenFractureEvent(event: FractureEvent): FractureEvent {
  const frozen = <T extends readonly unknown[]>(v: T): T => Object.freeze([...v]) as T;
  return Object.freeze({
    ...event,
    target: Object.freeze({ ...event.target }),
    position: frozen(event.position),
    rotation: frozen(event.rotation),
    scale: frozen(event.scale),
    contact: event.contact === null ? null : frozen(event.contact),
    normal: event.normal === null ? null : frozen(event.normal),
    impulse: event.impulse === null ? null : frozen(event.impulse),
    profile: Object.freeze({ ...event.profile }),
    source: Object.freeze({ ...event.source }),
  });
}

/**
 * 运行时活动预算（待测初值由 WU-04 公布，此处只冻结取值域）。
 * 预算限制运行时活动工作量，不限制资产库离线制作规模。
 */
export interface FractureBudget {
  maxRigidBodies: number;
  maxSimplifiedChunks: number;
  maxEventQueue: number;
  fixedStepSec: number;
  maxCatchUpTicks: number;
}

export function validFractureBudget(value: unknown): value is FractureBudget {
  if (!value || typeof value !== 'object') return false;
  const b = value as FractureBudget;
  const int = (n: unknown, min: number, max: number): n is number =>
    Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
  return int(b.maxRigidBodies, 1, 128) && int(b.maxSimplifiedChunks, 1, 4096) && int(b.maxEventQueue, 16, 8192)
    && typeof b.fixedStepSec === 'number' && Number.isFinite(b.fixedStepSec) && b.fixedStepSec >= 1 / 240 && b.fixedStepSec <= 1 / 20
    && int(b.maxCatchUpTicks, 1, 32);
}

/** 运动层：真实刚体或有界简化积分；与资产的 large/small 分类正交。 */
export type FractureMotionLayer = 'rigid' | 'simplified';

export interface FractureBodyHandle {
  readonly key: string;
  readonly chunkId: string;
  readonly layer: FractureMotionLayer;
}

/** 物理后端只读快照；三轴位置 + 四元数姿态 + 线/角速度 + 休眠。 */
export interface FractureBodySnapshot {
  readonly position: FractureVec3;
  readonly rotation: FractureQuat;
  readonly linearVelocity: FractureVec3;
  readonly angularVelocity: FractureVec3;
  readonly sleeping: boolean;
}

/**
 * 物理后端边界（WU-03 提供 Rapier 适配实现）。固定步长推进，支持暂停/单步/
 * 有界追赶；World/body/collider 生命周期按 Preview/Play session 隔离，Stop 释放。
 */
export interface FracturePhysicsBackend {
  readonly name: string;
  snapshot(handle: FractureBodyHandle): FractureBodySnapshot | null;
  /** 恰推进一个固定 step；渲染插值可选，不能反向推进物理时钟。 */
  step(tick: number): void;
  release(handle: FractureBodyHandle): void;
  destroy(): void;
}
