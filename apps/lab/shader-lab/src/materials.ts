/**
 * 编辑器侧材质管理（依赖 LabParams 共享材质库）。
 *
 * 纯材质数据 / 原语已上提进包体（见 @aether/render 的 MaterialState / MaterialSlot /
 * sharedId / slotSource 等）。本文件只保留"把槽位解析到 LabParams.materials 共享库"
 * 的编辑器逻辑——这是 ADR-007 的边界：包体定义材质数据契约，编辑器消费并管理之。
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
 */

import { MATERIAL_OPTIONS, type LabParams } from './params';
import { uniqueName } from './naming';
import {
  cloneMaterial,
  isInstanceId,
  planSubMeshCount,
  sharedId,
  sharedIndex,
  slotSource,
  type MaterialInstance,
  type MaterialKind,
  type MaterialRef,
  type MaterialSlot,
  type MaterialState,
} from '@aether/render';

// 既有 `from './materials'` 引用兼容（renderer / materials.test）——纯原语改从包体来
export {
  cloneMaterial,
  isInstanceId,
  planSubMeshCount,
  sharedId,
  sharedIndex,
  slotSource,
};
export type {
  MaterialInstance,
  MaterialKind,
  MaterialRef,
  MaterialSlot,
  MaterialState,
  MaterialSource,
} from '@aether/render';

// 实例 id 前缀（共享材质 id 的 sharedId 已随包体走，这里只保留实例铸 id 用）
const INSTANCE_PREFIX = 'i';

/** 去掉「0 · 」这类序号前缀，用于给实例起名 */
function bareName(label: string): string {
  const i = label.indexOf('·');
  return (i >= 0 ? label.slice(i + 1) : label).trim();
}

/**
 * 槽位的生效材质（可写本体）。
 * 注意返回的是**引用**：改它就是在改 override / 实例 / 共享材质本身 —— 这正是三层的语义。
 */
export function slotState(slot: MaterialSlot, lib: MaterialLibrary, p: LabParams): MaterialState {
  return slot.override ?? lib.resolve(p, slot.materialId);
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
