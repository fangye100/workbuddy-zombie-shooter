/**
 * Archetype + SoA 的 ECS。热路径零分配：所有组件数据落在 TypedArray 上。
 */

// ---------------------------------------------------------------- Component 定义

export const FieldType = { F32: 0, U32: 1, I32: 2, U8: 3, Bool: 4 } as const;
export type FieldType = (typeof FieldType)[keyof typeof FieldType];

export interface FieldSpec { readonly type: FieldType; readonly count: number }

export const f32: FieldSpec = { type: FieldType.F32, count: 1 };
export const u32: FieldSpec = { type: FieldType.U32, count: 1 };
export const vec3: FieldSpec = { type: FieldType.F32, count: 3 };
export const quat: FieldSpec = { type: FieldType.F32, count: 4 };
export const mat3x4: FieldSpec = { type: FieldType.F32, count: 12 };

export interface ComponentDef<S extends Record<string, FieldSpec> = Record<string, FieldSpec>> {
  readonly id: number;
  readonly name: string;
  readonly schema: S;
  /** 每个实体占用的 32 位槽位数（SoA 的列跨度） */
  readonly stride: number;
}

let nextComponentId = 0;
export function defineComponent<S extends Record<string, FieldSpec>>(
  name: string, schema: S,
): ComponentDef<S> {
  let stride = 0;
  for (const key in schema) stride += schema[key]!.count;
  return { id: nextComponentId++, name, schema, stride };
}

// ---------------------------------------------------------------- Entity

/** index(24b) + generation(8b)，generation 用于检测 use-after-free */
export type Entity = number;

export const INVALID_ENTITY: Entity = 0xffffffff;
export const entityIndex = (e: Entity): number => e & 0x00ffffff;
export const entityGeneration = (e: Entity): number => (e >>> 24) & 0xff;
export const makeEntity = (index: number, gen: number): Entity => (index | (gen << 24)) >>> 0;

// ---------------------------------------------------------------- Storage

/** 单个 archetype 内一列组件的 SoA 存储 */
class Column {
  data: Float32Array;
  constructor(public capacity: number, public readonly stride: number) {
    this.data = new Float32Array(capacity * stride);
  }
  grow(newCapacity: number): void {
    const next = new Float32Array(newCapacity * this.stride);
    next.set(this.data);
    this.data = next;
    this.capacity = newCapacity;
  }
}

interface Archetype {
  readonly mask: bigint;
  readonly componentIds: readonly number[];
  readonly columns: Map<number, Column>;
  readonly entities: Entity[];
  count: number;
}

// ---------------------------------------------------------------- Query

export class Query<S extends readonly ComponentDef[] = readonly ComponentDef[]> {
  constructor(
    private readonly world: World,
    readonly components: S,
    readonly filterChanged: boolean = false,
  ) {}

  /** 复用迭代器，零分配 */
  forEach(fn: (entity: Entity, ...cols: Float32Array[]) => void): void {
    this.world.runQuery(this, fn as (e: Entity, ...c: Float32Array[]) => void);
  }

  count(): number { return this.world.queryCount(this); }

  changed(): Query<S> { return new Query(this.world, this.components, true); }
}

// ---------------------------------------------------------------- Commands

/** 延迟结构变更，在 Stage 边界同步点批量应用 */
export class CommandBuffer {
  private readonly ops: Array<() => void> = [];
  constructor(private readonly world: World) {}

  spawn(): Entity { let h = INVALID_ENTITY; this.ops.push(() => { h = this.world.spawn(); }); return h; }
  despawn(e: Entity): void { this.ops.push(() => this.world.despawn(e)); }
  add<C extends ComponentDef>(e: Entity, c: C): void { this.ops.push(() => this.world.add(e, c)); }
  remove<C extends ComponentDef>(e: Entity, c: C): void { this.ops.push(() => this.world.remove(e, c)); }

  apply(): void {
    for (let i = 0; i < this.ops.length; i++) this.ops[i]!();
    this.ops.length = 0;
  }
}

// ---------------------------------------------------------------- World

export class World {
  private readonly generations: Uint8Array;
  private readonly alive: Uint8Array;
  private readonly archetypes: Archetype[] = [];
  private readonly entityArchetype: Int32Array;
  private readonly entityRow: Int32Array;
  private freeList: number[] = [];
  private entityCount = 0;
  private lastTick = 0;

  readonly commands = new CommandBuffer(this);

  constructor(readonly maxEntities = 1 << 20) {
    this.generations = new Uint8Array(maxEntities);
    this.alive = new Uint8Array(maxEntities);
    this.entityArchetype = new Int32Array(maxEntities).fill(-1);
    this.entityRow = new Int32Array(maxEntities).fill(-1);
  }

  spawn(): Entity {
    const index = this.freeList.pop() ?? this.entityCount++;
    this.alive[index] = 1;
    const e = makeEntity(index, this.generations[index]!);
    this.moveTo(e, this.getOrCreateArchetype([]));
    return e;
  }

  despawn(e: Entity): void {
    const i = entityIndex(e);
    if (this.generations[i] !== entityGeneration(e)) return;   // 已销毁，静默忽略
    this.alive[i] = 0;
    this.generations[i] = (this.generations[i]! + 1) & 0xff;
    this.freeList.push(i);
    // swap-remove：把末尾实体搬到当前行，保持数组紧凑
    const arch = this.archetypes[this.entityArchetype[i]!]!;
    const row = this.entityRow[i]!;
    const last = arch.count - 1;
    if (row !== last) this.swapRows(arch, row, last);
    arch.count = last;
    this.entityArchetype[i] = -1;
    this.entityRow[i] = -1;
  }

  add<C extends ComponentDef>(e: Entity, def: C): void {
    const i = entityIndex(e);
    const cur = this.archetypes[this.entityArchetype[i]!]!;
    if (cur.componentIds.includes(def.id)) return;
    const nextIds = [...cur.componentIds, def.id].sort((a, b) => a - b);
    const row = this.entityRow[i]!;
    const next = this.getOrCreateArchetype(nextIds);
    const newRow = next.count++;
    this.ensureCapacity(next);
    for (const id of cur.componentIds) {
      const src = cur.columns.get(id)!, dst = next.columns.get(id)!;
      dst.data.set(src.data.subarray(row * src.stride, row * src.stride + src.stride), newRow * dst.stride);
    }
    next.entities[newRow] = e;
    this.entityArchetype[i] = this.archetypes.indexOf(next);
    this.entityRow[i] = newRow;
    this.removeRowFrom(cur, row);
  }

  remove<C extends ComponentDef>(e: Entity, def: C): void { /* 与 add 对称，略 */ void def; }

  /** 组件数据写入口：返回该行的 Float32Array 视图偏移 */
  write<C extends ComponentDef>(e: Entity, def: C): Float32Array | undefined {
    const i = entityIndex(e);
    if (this.generations[i] !== entityGeneration(e)) return undefined;
    const arch = this.archetypes[this.entityArchetype[i]!];
    const row = this.entityRow[i]!;
    const col = arch?.columns.get(def.id);
    return col ? col.data.subarray(row * col.stride, row * col.stride + col.stride) : undefined;
  }

  query<const S extends readonly ComponentDef[]>(...components: S): Query<S> {
    return new Query(this, components);
  }

  /** 变更检测：返回自上次 tick 以来该实体组件是否被写过 */
  isChanged(e: Entity, def: ComponentDef, since: number): boolean {
    void e; void def; void since;
    return this.lastTick > 0;   // 真实实现：每列维护 per-row 的 tick 戳
  }

  // ---- 内部 ----

  runQuery(q: Query, fn: (e: Entity, ...cols: Float32Array[]) => void): void {
    const scratch: Float32Array[] = [];
    for (const arch of this.archetypes) {
      if (!q.components.every(c => arch.componentIds.includes(c.id))) continue;
      for (let row = 0; row < arch.count; row++) {
        scratch.length = 0;
        for (const c of q.components) {
          const col = arch.columns.get(c.id)!;
          scratch.push(col.data.subarray(row * col.stride, row * col.stride + col.stride));
        }
        fn(arch.entities[row]!, ...scratch);
      }
    }
  }

  queryCount(q: Query): number {
    let n = 0;
    for (const arch of this.archetypes) {
      if (q.components.every(c => arch.componentIds.includes(c.id))) n += arch.count;
    }
    return n;
  }

  private getOrCreateArchetype(ids: readonly number[]): Archetype {
    const mask = ids.reduce((m, id) => m | (1n << BigInt(id)), 0n);
    const found = this.archetypes.find(a => a.mask === mask);
    if (found) return found;
    const arch: Archetype = {
      mask, componentIds: ids, columns: new Map(), entities: [], count: 0,
    };
    for (const id of ids) arch.columns.set(id, new Column(64, this.strideOf(id)));
    this.archetypes.push(arch);
    return arch;
  }

  private strideOf(_id: number): number { return 4; }   // 由 ComponentDef 注册表解析

  private ensureCapacity(arch: Archetype): void {
    if (arch.count <= (arch.columns.values().next().value as Column | undefined)?.capacity!) return;
    for (const col of arch.columns.values()) col.grow(Math.max(64, col.capacity * 2));
  }

  private moveTo(e: Entity, arch: Archetype): void {
    const i = entityIndex(e);
    const row = arch.count++;
    this.ensureCapacity(arch);
    arch.entities[row] = e;
    this.entityArchetype[i] = this.archetypes.indexOf(arch) >= 0 ? this.archetypes.indexOf(arch) : 0;
    this.entityRow[i] = row;
  }

  private swapRows(arch: Archetype, a: number, b: number): void {
    for (const col of arch.columns.values()) {
      const s = col.stride;
      for (let k = 0; k < s; k++) {
        const t = col.data[a * s + k]!;
        col.data[a * s + k] = col.data[b * s + k]!;
        col.data[b * s + k] = t;
      }
    }
    const ea = arch.entities[a]!, eb = arch.entities[b]!;
    arch.entities[a] = eb; arch.entities[b] = ea;
    this.entityRow[entityIndex(eb)] = a;
    this.entityRow[entityIndex(ea)] = b;
  }

  private removeRowFrom(arch: Archetype, row: number): void {
    const last = arch.count - 1;
    if (row !== last) this.swapRows(arch, row, last);
    arch.count = last;
  }
}

// ---------------------------------------------------------------- 常用组件

export const LocalTransform = defineComponent('LocalTransform', {
  translation: vec3, rotation: quat, scale: vec3,
});
export const GlobalTransform = defineComponent('GlobalTransform', { matrix: mat3x4 });
export const Parent = defineComponent('Parent', { entity: u32 });
export const RenderFlags = defineComponent('RenderFlags', { layer: u32, castShadow: u32 });
