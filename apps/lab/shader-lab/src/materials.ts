import { MATERIAL_OPTIONS, type LabParams, type MaterialState } from './params';
import { uniqueName } from './naming';

/**
 * 材质库与材质槽的数据模型（纯逻辑，不碰 GPU / DOM，可单独测试）。
 *
 * 三层材质语义，与 Unity 对齐：
 *   1. shared（共享材质）—— params.materials 里的 6 个条目。改它就是全局改，
 *      所有引用它的 mesh 同步变化。左侧「材质」分组编辑的就是这一层。
 *   2. instance（材质实例）—— 从某个材质克隆出来的独立条目，存进材质库、可跨 mesh
 *      复用、可随 JSON 导出。改它不影响它的来源材质。
 *   3. override（覆盖）—— 挂在**单条子网格**上的局部副本，优先级最高，只影响那一条 mesh。
 *      「保存覆盖」= 把 override 提升为 instance，从此进库、可复用。
 *
 * 优先级：override > instance > shared。
 *
 * 为什么共享材质不存进本库：params.materials 是 JSON 导出的真源，也是既有「材质」
 * 分组与 ramp 预览的读写对象。本库只持有实例，共享条目一律按 id 回查 params，
 * 避免出现两份互相打架的副本。
 */

export type MaterialKind = 'shared' | 'instance';
/** 子网格材质槽当前的来源层级（override 不是库条目，是槽位上的局部副本） */
export type MaterialSource = 'shared' | 'instance' | 'override';

/** 材质库下拉项 */
export interface MaterialRef {
  id: string;
  name: string;
  kind: MaterialKind;
}

/** 用户创建的材质实例 */
export interface MaterialInstance {
  id: string;
  name: string;
  /** 派生来源 id（仅用于溯源展示，创建后不再联动） */
  baseId: string | null;
  state: MaterialState;
}

const SHARED_PREFIX = 's';
const INSTANCE_PREFIX = 'i';

/** 共享材质 id：与 params.materials 的下标一一对应 */
export function sharedId(index: number): string {
  return `${SHARED_PREFIX}${index}`;
}

/** 从 id 反解共享材质下标；非共享 id 返回 null */
export function sharedIndex(id: string): number | null {
  if (id.length < 2 || id[0] !== SHARED_PREFIX) return null;
  const n = Number(id.slice(1));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function isInstanceId(id: string): boolean {
  return id.length >= 2 && id[0] === INSTANCE_PREFIX;
}

export function cloneMaterial(m: MaterialState): MaterialState {
  return { ...m };
}

/**
 * 材质槽：一条子网格挂一份。这是「数据隔离」的核心结构 ——
 * materialId 指向材质库，override 是本槽的局部副本，两者互不干扰。
 */
export interface MaterialSlot {
  /** 库条目 id（共享或实例） */
  materialId: string;
  /** 局部覆盖：非 null 时优先于库条目，只作用于这一条子网格 */
  override: MaterialState | null;
}

/** 槽位的来源层级：override（本 mesh）> instance（库实例）> shared（共享材质） */
export function slotSource(slot: MaterialSlot): MaterialSource {
  if (slot.override !== null) return 'override';
  return isInstanceId(slot.materialId) ? 'instance' : 'shared';
}

/**
 * 槽位的生效材质（可写本体）。
 * 注意返回的是**引用**：改它就是在改 override / 实例 / 共享材质本身 —— 这正是三层的语义。
 */
export function slotState(slot: MaterialSlot, lib: MaterialLibrary, p: LabParams): MaterialState {
  return slot.override ?? lib.resolve(p, slot.materialId);
}

/** 去掉「0 · 」这类序号前缀，用于给实例起名 */
function bareName(label: string): string {
  const i = label.indexOf('·');
  return (i >= 0 ? label.slice(i + 1) : label).trim();
}

/**
 * 子网格条数的预算裁剪（纯函数，便于单测）。
 *
 * uniform 材质槽是固定容量，写越界 = WebGPU 校验错误 = 整页黑屏。
 * 所以「拆出来的条数装不下」时整体退化为 1 条（用整物体当一条子网格），
 * 而不是截断——截断会静默丢掉模型后半部分的几何，比少拆危险得多。
 *
 * @param requested   想拆成几条（0 或负 = 调用方没给 primitive 信息）
 * @param usedByOthers 场景里其他物体已经占掉的槽位数
 * @param capacity    全局槽位容量
 */
export function planSubMeshCount(requested: number, usedByOthers: number, capacity: number): number {
  if (requested <= 0) return 1;
  const budget = Math.max(1, capacity - usedByOthers);
  return requested <= budget ? requested : 1;
}


export class MaterialLibrary {
  /**
   * 实例表。用 Map 而不是数组：resolve / nameOf / find 是**每帧每子网格**都要跑的
   * （渲染装箱、层级树取材质名、导出），线性 find 在实例一多就退化成 O(subMeshes × instances)。
   * 数组顺序对下拉框有意义，所以保留 instances 数组做顺序，Map 只做索引。
   */
  private readonly byId = new Map<string, MaterialInstance>();
  private instances: MaterialInstance[] = [];
  private seq = 0;

  /** 材质库下拉列表：6 个共享材质 + 用户实例 */
  refs(p: LabParams): MaterialRef[] {
    const out: MaterialRef[] = [];
    for (let i = 0; i < p.materials.length; i++) {
      out.push({
        id: sharedId(i),
        name: MATERIAL_OPTIONS[i]?.label ?? `共享材质 ${i}`,
        kind: 'shared',
      });
    }
    for (const inst of this.instances) {
      out.push({ id: inst.id, name: inst.name, kind: 'instance' });
    }
    return out;
  }

  /** 取库条目的可编辑本体（共享 = params.materials[i] 本身，改它就是全局改） */
  resolve(p: LabParams, id: string): MaterialState {
    const si = sharedIndex(id);
    if (si !== null) return p.materials[si] ?? p.materials[0]!;
    return this.byId.get(id)?.state ?? p.materials[0]!;
  }

  nameOf(p: LabParams, id: string): string {
    const si = sharedIndex(id);
    if (si !== null) return MATERIAL_OPTIONS[si]?.label ?? `共享材质 ${si}`;
    return this.byId.get(id)?.name ?? id;
  }

  kindOf(id: string): MaterialKind {
    return isInstanceId(id) ? 'instance' : 'shared';
  }

  /** 按 id 取实例（共享材质返回 null） */
  find(id: string): MaterialInstance | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * 以某条材质为模板创建实例。名字按「<来源名> 实例 N」自动命名，不弹窗打断流程。
   * 返回新条目 id。
   */
  createInstance(template: MaterialState, baseId: string | null, baseLabel: string): string {
    this.seq++;
    const id = `${INSTANCE_PREFIX}${this.seq}`;
    const used = new Set(this.instances.map((i) => i.name));
    const base = bareName(baseLabel);
    const name = uniqueName(`${base} 实例 ${this.seq}`, used);
    const inst: MaterialInstance = { id, name, baseId, state: cloneMaterial(template) };
    this.instances.push(inst);
    this.byId.set(id, inst);
    return id;
  }

  /**
   * 重命名实例。空名字视为「不改」；与他人重名时自动加数字后缀 ——
   * 下拉框里出现两个同名实例，用户根本分不清自己在选哪一个。
   */
  rename(id: string, name: string): void {
    const inst = this.byId.get(id);
    if (inst === undefined) return;
    const next = name.trim();
    if (next === '') return;
    const used = new Set(this.instances.filter((i) => i.id !== id).map((i) => i.name));
    inst.name = uniqueName(next, used);
  }

  /**
   * 删除实例。引用它的槽位由调用方负责回退（renderer.removeInstance 里处理），
   * 库本身不认识场景对象。
   */
  remove(id: string): boolean {
    const i = this.instances.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.instances.splice(i, 1);
    this.byId.delete(id);
    return true;
  }

  /** 导出的实例清单（JSON 导出用） */
  serialize(): MaterialInstance[] {
    return this.instances.map((i) => ({ ...i, state: cloneMaterial(i.state) }));
  }
}
