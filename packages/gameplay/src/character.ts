/**
 * 角色层：CharacterDef（数据驱动原型） + CharacterTable（SoA） + 池化与分帧装配 + 表现 LOD。
 *
 * 尸潮场景的两个关键判断：
 *  - 500 只僵尸 = 1 份骨骼 + 1 份动画集 + N 个共享材质变体，不是 500 份资源。
 *  - 装配必须有每帧预算。远处先给"空壳"，近了才装真身 —— 玩家永远看不到装配过程。
 */

export const enum LodTier {
  /** 骨骼动画 + compute skinning + IK */
  Full = 0,
  /** 顶点动画纹理（VAT）：instanced 渲染，一次 draw call 画几百只 */
  Vat = 1,
  /** 公告板或直接不上屏，只保留逻辑 */
  Proxy = 2,
}

export const enum BodySlot {
  Head = 0,
  Torso = 1,
  ArmL = 2,
  ArmR = 3,
  Legs = 4,
  Weapon = 5,
}

export interface BodyPartDef {
  readonly slot: BodySlot;
  readonly mesh: number;
  readonly material: number;
}

export interface CharacterPhysicsDef {
  readonly capsuleRadius: number;
  readonly capsuleHeight: number;
  readonly mass: number;
  readonly navAgentRadius: number;
}

export interface CharacterAiDef {
  readonly archetype: number;
  readonly aggression: number;
  readonly attackRange: number;
  readonly moveSpeed: number;
  readonly turnRate: number;
  readonly sightRange: number;
  readonly fovDeg: number;
  readonly hearingRange: number;
}

export interface HurtboxDef {
  readonly bone: number;
  readonly radius: number;
  /** 部位倍率：头部 ×2.5 */
  readonly multiplier: number;
}

export interface CharacterCombatDef {
  readonly attacks: readonly number[];
  readonly hurtboxes: readonly HurtboxDef[];
}

export interface CharacterDef {
  readonly id: number;
  /** 所有同骨架角色共享一份；引用计数管理，不会重复加载 */
  readonly skeleton: number;
  readonly bodyParts: readonly BodyPartDef[];
  readonly animSet: number;
  readonly animGraph: number;
  readonly physics: CharacterPhysicsDef;
  readonly ai: CharacterAiDef;
  readonly combat: CharacterCombatDef;
  readonly prewarm: number;
  readonly max: number;
}

// ---------------------------------------------------------------------------
// SoA 表：所有 per-NPC 状态列式存储
// ---------------------------------------------------------------------------

export class CharacterTable {
  readonly generation: Uint32Array;
  readonly alive: Uint8Array;
  readonly defId: Uint16Array;

  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  readonly velX: Float32Array;
  readonly velZ: Float32Array;
  readonly desiredVelX: Float32Array;
  readonly desiredVelZ: Float32Array;
  readonly yaw: Float32Array;
  readonly dirX: Float32Array;
  readonly dirZ: Float32Array;

  readonly radius: Float32Array;
  readonly maxSpeed: Float32Array;
  readonly speedScale: Float32Array;
  /** 破对称：±1，由 entity index 决定，让两只 NPC 总是往同一侧错身 */
  readonly dodgeBias: Int8Array;

  readonly targetEntity: Int32Array;
  readonly alertLevel: Float32Array;
  readonly nextThinkTick: Uint32Array;
  readonly behavior: Uint8Array;
  readonly attackToken: Uint8Array;

  readonly animState: Uint16Array;
  readonly montageId: Uint16Array;
  readonly animTime: Float32Array;
  readonly montageTime: Float32Array;
  /** 相位随机化：同批僵尸绝不能同步 —— 这一条比任何复杂 AI 都更能提升"活着"的观感 */
  readonly animPhaseOffset: Float32Array;
  readonly lodTier: Uint8Array;

  readonly health: Float32Array;
  readonly poise: Float32Array;
  readonly cooldownUntil: Float32Array;

  private readonly freeList: Int32Array;
  private freeTop: number;
  private live = 0;

  constructor(readonly capacity: number) {
    this.generation = new Uint32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.defId = new Uint16Array(capacity);
    this.posX = new Float32Array(capacity);
    this.posY = new Float32Array(capacity);
    this.posZ = new Float32Array(capacity);
    this.velX = new Float32Array(capacity);
    this.velZ = new Float32Array(capacity);
    this.desiredVelX = new Float32Array(capacity);
    this.desiredVelZ = new Float32Array(capacity);
    this.yaw = new Float32Array(capacity);
    this.dirX = new Float32Array(capacity);
    this.dirZ = new Float32Array(capacity);
    this.radius = new Float32Array(capacity);
    this.maxSpeed = new Float32Array(capacity);
    this.speedScale = new Float32Array(capacity).fill(1);
    this.dodgeBias = new Int8Array(capacity);
    this.targetEntity = new Int32Array(capacity).fill(-1);
    this.alertLevel = new Float32Array(capacity);
    this.nextThinkTick = new Uint32Array(capacity);
    this.behavior = new Uint8Array(capacity);
    this.attackToken = new Uint8Array(capacity);
    this.animState = new Uint16Array(capacity);
    this.montageId = new Uint16Array(capacity);
    this.animTime = new Float32Array(capacity);
    this.montageTime = new Float32Array(capacity);
    this.animPhaseOffset = new Float32Array(capacity);
    this.lodTier = new Uint8Array(capacity);
    this.health = new Float32Array(capacity);
    this.poise = new Float32Array(capacity);
    this.cooldownUntil = new Float32Array(capacity);

    this.freeList = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.freeList[i] = capacity - 1 - i;
    this.freeTop = capacity;
  }

  get aliveCount(): number {
    return this.live;
  }

  isAlive(i: number): boolean {
    return this.alive[i] === 1;
  }

  /**
   * 槽位从 freelist 分配，**不做 swap-remove** —— 索引必须稳定，
   * 因为黑板、攻击名额、仇恨目标都在按索引引用实体。
   */
  spawn(defId: number): number {
    const i = this.alloc(defId);
    if (i < 0) return -1;
    this.alive[i] = 1;
    this.live++;
    return i;
  }

  /** 分配槽位但保持休眠（预热用）：不占用活跃计数，也不参与任何遍历 */
  spawnDormant(defId: number): number {
    return this.alloc(defId);
  }

  private alloc(defId: number): number {
    if (this.freeTop === 0) return -1;
    const i = this.freeList[--this.freeTop]!;
    this.defId[i] = defId;
    this.generation[i] = this.generation[i]! + 1;
    this.health[i] = 1;
    this.speedScale[i] = 1;
    this.animPhaseOffset[i] = hash01(i);
    this.dodgeBias[i] = (i & 1) === 0 ? 1 : -1;
    this.lodTier[i] = LodTier.Proxy;
    this.targetEntity[i] = -1;
    this.behavior[i] = 0;
    this.attackToken[i] = 0;
    this.animTime[i] = 0;
    this.montageTime[i] = 0;
    this.alertLevel[i] = 0;
    return i;
  }

  /** 池化复用：休眠 → 活跃 */
  activate(i: number): boolean {
    if (this.alive[i] === 1) return false;
    this.alive[i] = 1;
    this.live++;
    return true;
  }

  /** 休眠但**保留槽位所有权**（由 CharacterPool 持有，不回到 freelist） */
  deactivate(i: number): void {
    if (this.alive[i] === 0) return;
    this.reset(i);
    this.live--;
  }

  /** 彻底销毁，槽位回到 freelist */
  destroy(i: number): void {
    if (this.alive[i] === 0) return;
    this.reset(i);
    this.freeList[this.freeTop++] = i;
    this.live--;
  }

  private reset(i: number): void {
    this.alive[i] = 0;
    this.targetEntity[i] = -1;
    this.behavior[i] = 0;
    this.attackToken[i] = 0;
    this.animTime[i] = 0;
    this.montageTime[i] = 0;
    this.alertLevel[i] = 0;
    this.velX[i] = 0;
    this.velZ[i] = 0;
    this.desiredVelX[i] = 0;
    this.desiredVelZ[i] = 0;
  }

  stats(): CharacterStats {
    let full = 0;
    let vat = 0;
    let proxy = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const t = this.lodTier[i]!;
      if (t === LodTier.Full) full++;
      else if (t === LodTier.Vat) vat++;
      else proxy++;
    }
    return { capacity: this.capacity, alive: this.live, full, vat, proxy };
  }
}

export interface CharacterStats {
  readonly capacity: number;
  readonly alive: number;
  readonly full: number;
  readonly vat: number;
  readonly proxy: number;
}

/** 确定性 hash → [0,1)，保证同一 index 的相位偏移每次运行一致（可回放） */
function hash01(i: number): number {
  let h = (i + 0x9e37_79b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85eb_ca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2_ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0x1_0000_0000;
}

// ---------------------------------------------------------------------------
// 池化
// ---------------------------------------------------------------------------

export class CharacterPool {
  private readonly free = new Map<number, number[]>();

  constructor(private readonly table: CharacterTable) {}

  prewarm(defId: number, count: number): number {
    let made = 0;
    for (let n = 0; n < count; n++) {
      const i = this.table.spawnDormant(defId);
      if (i < 0) break;
      this.push(defId, i);
      made++;
    }
    return made;
  }

  acquire(defId: number): number {
    const bucket = this.free.get(defId);
    if (bucket !== undefined && bucket.length > 0) {
      const i = bucket.pop()!;
      this.table.activate(i);
      return i;
    }
    return this.table.spawn(defId);
  }

  /** 归还到池：槽位休眠但保留，下次 acquire 零成本复用 */
  release(index: number): void {
    const defId = this.table.defId[index]!;
    this.table.deactivate(index);
    this.push(defId, index);
  }

  private push(defId: number, index: number): void {
    let bucket = this.free.get(defId);
    if (bucket === undefined) {
      bucket = [];
      this.free.set(defId, bucket);
    }
    bucket.push(index);
  }

  stats(): { readonly defs: number; readonly pooled: number } {
    let pooled = 0;
    for (const bucket of this.free.values()) pooled += bucket.length;
    return { defs: this.free.size, pooled };
  }
}

// ---------------------------------------------------------------------------
// 分帧装配
// ---------------------------------------------------------------------------

interface AssemblyRequest {
  defId: number;
  x: number;
  z: number;
  priority: number;
  seq: number;
}

/**
 * 所有异步加载（角色 / VFX / 音效）共用一个每帧预算池。
 * 优先级 = 距相机距离倒数 × 类型权重 —— 远处的僵尸先拿"空壳"，近了才装真身。
 */
export class AssemblyQueue {
  private readonly pending: AssemblyRequest[] = [];
  private seq = 0;

  constructor(
    private readonly pool: CharacterPool,
    private readonly onAssembled: (index: number, defId: number) => void,
  ) {}

  request(defId: number, x: number, z: number, cameraX: number, cameraZ: number, typeWeight: number): void {
    const d = Math.hypot(x - cameraX, z - cameraZ);
    this.pending.push({
      defId,
      x,
      z,
      priority: (typeWeight * 100) / (1 + d),
      seq: this.seq++,
    });
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** 每帧调用，最多装配 budget 个。返回本帧实际装配数 */
  pump(budget: number): number {
    if (this.pending.length === 0 || budget <= 0) return 0;
    this.pending.sort(byPriority);

    let done = 0;
    while (done < budget && this.pending.length > 0) {
      const req = this.pending.pop()!;
      const index = this.pool.acquire(req.defId);
      if (index < 0) {
        // 池与表都满了：退回队列，等有实体回收再装
        this.pending.push(req);
        break;
      }
      this.onAssembled(index, req.defId);
      done++;
    }
    return done;
  }
}

function byPriority(a: AssemblyRequest, b: AssemblyRequest): number {
  const d = a.priority - b.priority;
  return d !== 0 ? d : a.seq - b.seq;
}

// ---------------------------------------------------------------------------
// LOD
// ---------------------------------------------------------------------------

export interface LodThresholds {
  readonly fullDistance: number;
  readonly vatDistance: number;
  /** 迟滞：升级阈值比降级阈值大 10%，防止在边界反复横跳 */
  readonly hysteresis: number;
}

export function selectLodTier(distance: number, t: LodThresholds, current: LodTier): LodTier {
  const h = t.hysteresis;
  if (current === LodTier.Full) {
    return distance > t.fullDistance * (1 + h) ? LodTier.Vat : LodTier.Full;
  }
  if (current === LodTier.Vat) {
    if (distance < t.fullDistance * (1 - h)) return LodTier.Full;
    return distance > t.vatDistance * (1 + h) ? LodTier.Proxy : LodTier.Vat;
  }
  return distance < t.vatDistance * (1 - h) ? LodTier.Vat : LodTier.Proxy;
}

/** 每帧更新 LOD 分布。返回本帧发生切换的数量，供 profiler 观察抖动 */
export function updateLod(
  table: CharacterTable,
  t: LodThresholds,
  cameraX: number,
  cameraZ: number,
): number {
  let switches = 0;
  for (let i = 0; i < table.capacity; i++) {
    if (table.alive[i] === 0) continue;
    const d = Math.hypot(table.posX[i]! - cameraX, table.posZ[i]! - cameraZ);
    const next = selectLodTier(d, t, table.lodTier[i] as LodTier);
    if (next !== table.lodTier[i]!) {
      table.lodTier[i] = next;
      switches++;
    }
  }
  return switches;
}
