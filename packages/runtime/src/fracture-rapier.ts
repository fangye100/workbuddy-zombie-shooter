/**
 * WU-03 真实三维物理后端：Rapier 适配实现。
 *
 * 通过 runtime 的通用 FracturePhysicsBackend 边界接入 @dimforge/rapier3d-compat
 * （Apache-2.0，内嵌 WASM、无运行时 fetch）。真实刚体的三轴位置、四元数、
 * 线/角速度、质量、摩擦、恢复系数全部进入求解器；静态环境镜像从场景 collider
 * 真源生成，不另造地面/墙体。
 *
 * 生命周期：WASM 模块代码经 ensureRapier() 共享加载；World/body/collider/handle
 * 按 Preview/Play session 隔离，destroy() 真实释放。异步初始化在 generation 失效
 * （Stop/换场景）后返回时不新建/复活旧 World。
 */

import type {
  FractureBodyHandle,
  FractureBodySnapshot,
  FracturePhysicsBackend,
  FractureVec3,
  FractureQuat,
} from './fracture';

/** Rapier 模块命名空间的结构子集（避免把具体包类型泄露到公共契约）。 */
interface RapierVector { x: number; y: number; z: number }
interface RapierRotation { x: number; y: number; z: number; w: number }
interface RapierBody {
  translation(): RapierVector;
  rotation(): RapierRotation;
  linvel(): RapierVector;
  angvel(): RapierVector;
  isSleeping(): boolean;
  isCcdEnabled(): boolean;
  applyImpulse(v: RapierVector, wakeUp: boolean): void;
  applyImpulseAtPoint(i: RapierVector, p: RapierVector, wakeUp: boolean): void;
  setLinvel(v: RapierVector, wakeUp: boolean): void;
  setAngvel(v: RapierVector, wakeUp: boolean): void;
  readonly handle: number;
}
interface RapierCollider { readonly handle: number }
interface RapierRigidBodyDesc {
  setTranslation(x: number, y: number, z: number): this;
  setRotation(q: RapierRotation): this;
  setLinvel(x: number, y: number, z: number): this;
  setAngvel(v: RapierVector): this;
  setCcdEnabled(enabled: boolean): this;
}
interface RapierColliderDesc {
  setFriction(f: number): this;
  setRestitution(r: number): this;
  setMass(m: number): this;
  setCollisionGroups(groups: number): this;
  setSensor(sensor: boolean): this;
  setTranslation(x: number, y: number, z: number): this;
}
interface RapierWorld {
  gravity: RapierVector;
  timestep: number;
  createRigidBody(desc: RapierRigidBodyDesc): RapierBody;
  createCollider(desc: RapierColliderDesc, body?: RapierBody): RapierCollider;
  removeRigidBody(body: RapierBody): void;
  removeCollider(collider: RapierCollider, wakeUp: boolean): void;
  getRigidBody(handle: number): RapierBody | null;
  step(): void;
  free(): void;
}
export interface RapierModule {
  init(): Promise<void>;
  World: new (gravity: RapierVector) => RapierWorld;
  RigidBodyDesc: { dynamic(): RapierRigidBodyDesc; fixed(): RapierRigidBodyDesc };
  ColliderDesc: {
    cuboid(hx: number, hy: number, hz: number): RapierColliderDesc;
    ball(radius: number): RapierColliderDesc;
    capsule(halfHeight: number, radius: number): RapierColliderDesc;
    convexHull(points: Float32Array): RapierColliderDesc | null;
  };
}

/** 共享的 WASM 模块代码加载（只加载一次；World 仍按 session 各自 new）。 */
let rapierModulePromise: Promise<RapierModule> | null = null;
export function ensureRapier(): Promise<RapierModule> {
  if (!rapierModulePromise) {
    rapierModulePromise = (async () => {
      const mod = (await import('@dimforge/rapier3d-compat')) as unknown as RapierModule;
      await mod.init();
      return mod;
    })();
  }
  return rapierModulePromise;
}

/** 碰撞分组（16 位 membership << 16 | 16 位 filter）。碎片首期装饰：与环境/大块互动，不撞玩家/NPC。 */
export const FRACTURE_GROUP = {
  environment: 0x0001,
  chunk: 0x0002,
  player: 0x0004,
  npc: 0x0008,
} as const;
export function collisionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}
/** 碎片：属于 chunk，与环境 + 其它 chunk 碰撞，明确排除 player/npc。 */
export const CHUNK_GROUPS = collisionGroups(FRACTURE_GROUP.chunk, FRACTURE_GROUP.environment | FRACTURE_GROUP.chunk);

export interface RapierBodySpec {
  /** 动态刚体初始世界变换（资产局部变换已组合进该世界变换，只执行一次）。 */
  position: FractureVec3;
  rotation: FractureQuat;
  /** 初始线/角速度。 */
  linearVelocity?: FractureVec3;
  angularVelocity?: FractureVec3;
  /** 碰撞代理（局部，中心在质心）。box/sphere 受世界均匀缩放；凸代理点已含尺度。 */
  shape:
    | { type: 'box'; halfExtents: FractureVec3 }
    | { type: 'sphere'; radius: number }
    | { type: 'capsule'; radius: number; height: number }
    | { type: 'convex'; points: Float32Array };
  mass: number;
  friction: number;
  restitution: number;
  /** 碰撞分组；默认碎片装饰组（排除 player/npc）。 */
  groups?: number;
  /** 仅对确有穿透风险的快速小刚体开启 CCD。 */
  ccd?: boolean;
}

export interface RapierBackendOptions {
  gravity?: FractureVec3;
  /** 固定步长秒。 */
  fixedStepSec: number;
  /** 线/角速度上限（有界，防穿透与数值爆炸）。 */
  maxLinearSpeed?: number;
  maxAngularSpeed?: number;
}

interface TrackedBody {
  key: string;
  chunkId: string;
  layer: 'rigid' | 'simplified';
  body: RapierBody;
  collider: RapierCollider;
  maxLinearSpeed: number;
  maxAngularSpeed: number;
}

interface StaticMirror {
  nodeId: string;
  body: RapierBody;
  collider: RapierCollider;
}

const DEFAULT_MAX_LINEAR = 60;
const DEFAULT_MAX_ANGULAR = 40;

export class RapierFractureBackend implements FracturePhysicsBackend {
  readonly name = 'rapier3d-compat@0.21.0';
  private readonly rapier: RapierModule;
  private readonly world: RapierWorld;
  private readonly bodies = new Map<string, TrackedBody>();
  private readonly statics = new Map<string, StaticMirror>();
  private readonly maxLinearSpeed: number;
  private readonly maxAngularSpeed: number;
  private destroyed = false;
  private tickCount = 0;

  constructor(rapier: RapierModule, opts: RapierBackendOptions) {
    if (!Number.isFinite(opts.fixedStepSec) || opts.fixedStepSec <= 0) {
      throw new Error('固定步长必须为有限正数');
    }
    this.rapier = rapier;
    const g = opts.gravity ?? [0, -9.81, 0];
    this.world = new rapier.World({ x: g[0], y: g[1], z: g[2] });
    this.world.timestep = opts.fixedStepSec;
    this.maxLinearSpeed = this.validSpeedLimit(opts.maxLinearSpeed, DEFAULT_MAX_LINEAR, '线速度上限');
    this.maxAngularSpeed = this.validSpeedLimit(opts.maxAngularSpeed, DEFAULT_MAX_ANGULAR, '角速度上限');
  }

  private validSpeedLimit(v: number | undefined, fallback: number, label: string): number {
    if (v === undefined) return fallback;
    if (!Number.isFinite(v) || v <= 0) throw new Error(label + '必须为有限正数');
    return v;
  }

  /** 夹紧单个速度向量到上限；非有限分量归零（防 NaN/Infinity 关闭保护）。返回夹紧后向量。 */
  private clampSpeed(v: FractureVec3, max: number): FractureVec3 {
    const x = Number.isFinite(v[0]) ? v[0] : 0;
    const y = Number.isFinite(v[1]) ? v[1] : 0;
    const z = Number.isFinite(v[2]) ? v[2] : 0;
    const s = Math.hypot(x, y, z);
    if (s <= max) return [x, y, z];
    const k = max / s;
    return [x * k, y * k, z * k];
  }

  /** 在求解推进前把速度夹进边界，使首个 tick 也不超限位移。 */
  private clampBodySpeeds(body: RapierBody, maxLin: number, maxAng: number): void {
    const lv = body.linvel();
    const cl = this.clampSpeed([lv.x, lv.y, lv.z], maxLin);
    if (cl[0] !== lv.x || cl[1] !== lv.y || cl[2] !== lv.z) body.setLinvel({ x: cl[0], y: cl[1], z: cl[2] }, true);
    const av = body.angvel();
    const ca = this.clampSpeed([av.x, av.y, av.z], maxAng);
    if (ca[0] !== av.x || ca[1] !== av.y || ca[2] !== av.z) body.setAngvel({ x: ca[0], y: ca[1], z: ca[2] }, true);
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('物理后端已销毁，不能再操作');
  }

  /** 实际创建动态刚体；质量/摩擦/恢复/CCD/分组真实进入求解器。 */
  addBody(handle: FractureBodyHandle, spec: RapierBodySpec): void {
    this.assertAlive();
    if (this.bodies.has(handle.key)) throw new Error(`重复刚体句柄：${handle.key}`);
    if (!Number.isFinite(spec.mass) || spec.mass <= 0) throw new Error('刚体质量必须为有限正数');
    const rb = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(spec.position[0], spec.position[1], spec.position[2])
      .setRotation({ x: spec.rotation[0], y: spec.rotation[1], z: spec.rotation[2], w: spec.rotation[3] });
    // 初始速度在创建前即夹进边界（含非有限分量归零）。
    const lv = this.clampSpeed(spec.linearVelocity ?? [0, 0, 0], this.maxLinearSpeed);
    const av = this.clampSpeed(spec.angularVelocity ?? [0, 0, 0], this.maxAngularSpeed);
    rb.setLinvel(lv[0], lv[1], lv[2]).setAngvel({ x: av[0], y: av[1], z: av[2] });
    if (spec.ccd === true) rb.setCcdEnabled(true);
    const body = this.world.createRigidBody(rb);
    let collider: RapierCollider;
    try {
      collider = this.world.createCollider(this.colliderDescFor(spec), body);
    } catch (e) {
      // collider 创建失败时移除刚体，避免不入账的孤儿占用到 destroy。
      this.world.removeRigidBody(body);
      throw e;
    }
    // 初始速度在求解前夹进边界，防止首个 tick 已超限位移。
    this.clampBodySpeeds(body, this.maxLinearSpeed, this.maxAngularSpeed);
    this.bodies.set(handle.key, {
      key: handle.key, chunkId: handle.chunkId, layer: handle.layer,
      body, collider,
      maxLinearSpeed: this.maxLinearSpeed, maxAngularSpeed: this.maxAngularSpeed,
    });
  }

  private colliderDescFor(spec: RapierBodySpec): RapierColliderDesc {
    const s = spec.shape;
    let desc: RapierColliderDesc | null;
    if (s.type === 'box') desc = this.rapier.ColliderDesc.cuboid(s.halfExtents[0], s.halfExtents[1], s.halfExtents[2]);
    else if (s.type === 'sphere') desc = this.rapier.ColliderDesc.ball(s.radius);
    else if (s.type === 'capsule') {
      const halfSegment = Math.max(0, s.height / 2 - s.radius);
      desc = this.rapier.ColliderDesc.capsule(halfSegment, s.radius);
    } else {
      if (!(s.points instanceof Float32Array) || s.points.length < 9 || s.points.length % 3 !== 0) {
        throw new Error('凸代理点必须为 3 的倍数且至少 3 点的 Float32Array');
      }
      desc = this.rapier.ColliderDesc.convexHull(s.points);
      if (!desc) throw new Error('凸代理无法构成有效凸包（退化点集）');
    }
    desc.setFriction(spec.friction).setRestitution(spec.restitution).setMass(spec.mass);
    desc.setCollisionGroups(spec.groups ?? CHUNK_GROUPS);
    return desc;
  }

  snapshot(handle: FractureBodyHandle): FractureBodySnapshot | null {
    if (this.destroyed) return null;
    const t = this.bodies.get(handle.key);
    if (!t) return null;
    const p = t.body.translation();
    const r = t.body.rotation();
    const lv = t.body.linvel();
    const av = t.body.angvel();
    return {
      position: [p.x, p.y, p.z],
      rotation: [r.x, r.y, r.z, r.w],
      linearVelocity: [lv.x, lv.y, lv.z],
      angularVelocity: [av.x, av.y, av.z],
      sleeping: t.body.isSleeping(),
    };
  }

  /** 偏心冲量：命中点偏离质心产生真实三轴角运动。 */
  applyImpulse(handle: FractureBodyHandle, impulse: FractureVec3, point: FractureVec3 | null): void {
    this.assertAlive();
    const t = this.bodies.get(handle.key);
    if (!t) throw new Error(`未知刚体句柄：${handle.key}`);
    const i = { x: impulse[0], y: impulse[1], z: impulse[2] };
    if (point) t.body.applyImpulseAtPoint(i, { x: point[0], y: point[1], z: point[2] }, true);
    else t.body.applyImpulse(i, true);
    // 冲量结果在下一步求解前夹进边界。
    this.clampBodySpeeds(t.body, t.maxLinearSpeed, t.maxAngularSpeed);
  }

  /** 恰推进一个固定 step；不反向推进时钟。推进前先夹紧速度上限（首个 tick 也不超限位移），
   *  推进后再次夹紧以约束接触求解后的结果。 */
  step(_tick: number): void {
    if (this.destroyed) return;
    for (const t of this.bodies.values()) {
      this.clampBodySpeeds(t.body, t.maxLinearSpeed, t.maxAngularSpeed);
    }
    this.world.step();
    this.tickCount++;
    for (const t of this.bodies.values()) {
      this.clampBodySpeeds(t.body, t.maxLinearSpeed, t.maxAngularSpeed);
    }
  }

  get ticks(): number { return this.tickCount; }

  /** 该刚体是否开启了 CCD（验证标志真实进入求解器）。 */
  isCcdEnabled(handle: FractureBodyHandle): boolean {
    if (this.destroyed) return false;
    const t = this.bodies.get(handle.key);
    return t ? t.body.isCcdEnabled() : false;
  }

  /** 真实移除动态刚体；旧 handle 不误删新资源（按 key 精确匹配）。 */
  release(handle: FractureBodyHandle): void {
    if (this.destroyed) return;
    const t = this.bodies.get(handle.key);
    if (!t) return;
    this.bodies.delete(handle.key);
    this.world.removeRigidBody(t.body);
  }

  // ---- 静态环境镜像：从场景 collider 真源生成，可 update/remove ----

  /**
   * 登记/更新一个静态环境 collider 镜像。形状为世界空间下的 box/sphere/capsule/凸代理；
   * 非均匀缩放的球/胶囊与 shear 在调用方（适配层）已拒绝，这里拿到的已是安全形状。
   * 同一 nodeId 重复调用即更新（先移除旧的）。
   */
  upsertStatic(nodeId: string, spec: { position: FractureVec3; rotation: FractureQuat; shape: RapierBodySpec['shape']; groups?: number }): void {
    this.assertAlive();
    this.removeStatic(nodeId);
    const rb = this.rapier.RigidBodyDesc.fixed()
      .setTranslation(spec.position[0], spec.position[1], spec.position[2])
      .setRotation({ x: spec.rotation[0], y: spec.rotation[1], z: spec.rotation[2], w: spec.rotation[3] });
    const body = this.world.createRigidBody(rb);
    const shapeSpec: RapierBodySpec = {
      position: spec.position, rotation: spec.rotation, shape: spec.shape,
      mass: 0, friction: 0.6, restitution: 0.1, groups: spec.groups ?? collisionGroups(FRACTURE_GROUP.environment, 0xffff),
    };
    let collider: RapierCollider;
    try {
      collider = this.world.createCollider(this.colliderDescFor(shapeSpec), body);
    } catch (e) {
      this.world.removeRigidBody(body);
      throw e;
    }
    this.statics.set(nodeId, { nodeId, body, collider });
  }

  /** 移除静态镜像（删除/开门不能遗留幽灵 collider）。 */
  removeStatic(nodeId: string): void {
    if (this.destroyed) return;
    const m = this.statics.get(nodeId);
    if (!m) return;
    this.statics.delete(nodeId);
    this.world.removeRigidBody(m.body);
  }

  /** 当前登记的静态镜像 key（供组合层差分；只读视图）。 */
  staticKeys(): readonly string[] {
    return [...this.statics.keys()];
  }

  /** 活动资源账目（区分 world/body/collider，不以单一 JS 计数归零自证）。 */
  get ledger(): { dynamicBodies: number; staticColliders: number; ticks: number; destroyed: boolean } {
    return { dynamicBodies: this.bodies.size, staticColliders: this.statics.size, ticks: this.tickCount, destroyed: this.destroyed };
  }

  /** 真实释放 World 与全部 body/collider；重复销毁安全，旧 handle 不再有效。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.bodies.clear();
    this.statics.clear();
    this.world.free();
  }
}

/**
 * 异步创建后端，带 session generation 守卫：Stop/换场景后迟到的初始化结果
 * 不新建/复活旧 World。generation 校验由调用方提供（当前 generation 必须与
 * 发起时一致才返回后端，否则丢弃已加载模块引用并返回 null）。
 */
export async function createRapierBackend(
  opts: RapierBackendOptions,
  isCurrentGeneration: () => boolean,
): Promise<RapierFractureBackend | null> {
  const rapier = await ensureRapier();
  if (!isCurrentGeneration()) return null;
  return new RapierFractureBackend(rapier, opts);
}
