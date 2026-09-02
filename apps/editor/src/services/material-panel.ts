/**
 * MaterialPanelService —— 材质槽三层语义（Mesh 材质面板背后的一整套 API）。
 *
 * 覆盖：整物体换共享材质、挂参数引用、材质库下拉、单槽查询 / 换库条目 / 新建实例 /
 * 本地覆盖的 ensure-promote-discard / 改名 / 删除（引用槽位回退 baseId）/
 * 导出实例与全场景槽位绑定。状态在 host.state（objects / library / params）。
 */
import type { LabRenderer, MaterialSlotInfo } from '../renderer';
import type { LabParams } from '../params';
import {
  cloneMaterial,
  sharedId,
  type MaterialInstance,
  type MaterialSource,
  type MaterialState,
  type MaterialRef,
} from '../materials';

export class MaterialPanelService {
  constructor(private readonly host: LabRenderer) {}

  /** 给整个物体换共享材质（Unity：给所有 slot 换 sharedMaterial）。会清掉所有子网格的 override */
  setObjectMaterial(index: number, materialIndex: number): void {
    const o = this.host.state.objects[index];
    if (o === undefined) return;
    o.materialIndex = materialIndex;
    for (const sm of o.subMeshes) {
      sm.materialId = sharedId(materialIndex);
      sm.override = null;
    }
  }

  /** 挂上参数引用：材质 API 要按 id 回查共享材质。params 对象引用全程恒定（重置也是 Object.assign 就地改） */
  attachParams(p: LabParams): void {
    this.host.state.params = p;
  }

  /** 材质库下拉项：6 个共享材质 + 用户实例 */
  getMaterialLibrary(): MaterialRef[] {
    return this.host.state.library.refs(this.host.state.params);
  }

  /** 当前材质槽信息；越界或无该槽返回 null */
  getSlotMaterial(objIndex: number, subIndex: number): MaterialSlotInfo | null {
    const s = this.host.state;
    const o = s.objects[objIndex];
    const sm = o?.subMeshes[subIndex];
    if (o === undefined || sm === undefined) return null;
    return {
      objIndex,
      subIndex,
      objectName: o.name,
      meshName: sm.name,
      triangles: sm.indexCount / 3,
      materialId: sm.materialId,
      materialName: s.library.nameOf(s.params, sm.materialId),
      source: this.host.sourceOf(sm),
      hasOverride: sm.override !== null,
      state: this.host.resolveMaterial(sm),
    };
  }

  /** 把槽位换成材质库里已有的一条（共享或实例），并清掉本地覆盖 */
  assignSlotMaterial(objIndex: number, subIndex: number, id: string): void {
    const sm = this.host.state.objects[objIndex]?.subMeshes[subIndex];
    if (sm === undefined) return;
    sm.materialId = id;
    sm.override = null;
  }

  /**
   * 以当前生效材质为模板**新建材质实例**并赋给这个槽位（清掉本地覆盖）。
   * 实例进库：其他 mesh 也能从下拉里选到它；改它不影响它的来源材质。
   */
  createSlotInstance(objIndex: number, subIndex: number): void {
    const s = this.host.state;
    const sm = s.objects[objIndex]?.subMeshes[subIndex];
    if (sm === undefined) return;
    const baseId = sm.materialId;
    const template = this.host.resolveMaterial(sm);
    const name = s.library.nameOf(s.params, baseId);
    const newId = s.library.createInstance(template, baseId, name);
    sm.materialId = newId;
    sm.override = null;
  }

  /**
   * 确保槽位上有一份本地覆盖（没有就按当前生效材质拷一份）。
   * 用途：用户在共享材质上调参数时自动转覆盖 —— 这样「改这个 mesh」永远不会误伤全局。
   */
  ensureOverride(objIndex: number, subIndex: number): void {
    const sm = this.host.state.objects[objIndex]?.subMeshes[subIndex];
    if (sm === undefined || sm.override !== null) return;
    sm.override = cloneMaterial(this.host.resolveMaterial(sm));
  }

  /**
   * 把本地覆盖**保存为材质实例**：从此进库、可复用、能随 JSON 导出，
   * 而共享材质的全局设置一点没动。
   */
  promoteOverride(objIndex: number, subIndex: number): void {
    const s = this.host.state;
    const sm = s.objects[objIndex]?.subMeshes[subIndex];
    if (sm === undefined || sm.override === null) return;
    const template = sm.override;
    const name = s.library.nameOf(s.params, sm.materialId);
    const newId = s.library.createInstance(template, sm.materialId, name);
    sm.materialId = newId;
    sm.override = null;
  }

  /** 丢弃本地覆盖，回到库条目（共享或实例） */
  discardOverride(objIndex: number, subIndex: number): void {
    const sm = this.host.state.objects[objIndex]?.subMeshes[subIndex];
    if (sm === undefined) return;
    sm.override = null;
  }

  renameMaterial(id: string, name: string): void {
    this.host.state.library.rename(id, name);
  }

  /**
   * 删除材质实例。引用它的槽位回退到实例的 baseId（来源材质），
   * 免得一删实例就有一堆 mesh 掉回默认材质。
   */
  removeMaterial(id: string): void {
    const s = this.host.state;
    const inst = s.library.find(id);
    if (inst === null) return; // 共享材质不可删
    const fallback = inst.baseId ?? sharedId(0);
    if (!s.library.remove(id)) return;
    for (const o of s.objects) {
      for (const sm of o.subMeshes) {
        if (sm.materialId === id) {
          sm.materialId = fallback;
          sm.override = null;
        }
      }
    }
  }

  /** 实例清单（JSON 导出用） */
  exportInstances(): MaterialInstance[] {
    return this.host.state.library.serialize();
  }

  /** 全场景材质槽绑定（JSON 导出用）：谁用了哪条材质、有没有局部覆盖；身份信息供重导对齐 */
  exportSlots(): {
    object: string;
    mesh: string;
    materialId: string;
    materialName: string;
    source: MaterialSource;
    override: MaterialState | null;
    nodeId: string;
    nodePath: string[];
    primitiveKey: string;
  }[] {
    const s = this.host.state;
    const out: {
      object: string;
      mesh: string;
      materialId: string;
      materialName: string;
      source: MaterialSource;
      override: MaterialState | null;
      nodeId: string;
      nodePath: string[];
      primitiveKey: string;
    }[] = [];
    for (const o of s.objects) {
      if (o.removed) continue;
      for (const sm of o.subMeshes) {
        out.push({
          object: o.name,
          mesh: sm.name,
          materialId: sm.materialId,
          materialName: s.library.nameOf(s.params, sm.materialId),
          source: this.host.sourceOf(sm),
          override: sm.override === null ? null : cloneMaterial(sm.override),
          nodeId: sm.nodeId,
          nodePath: sm.nodePath,
          primitiveKey: sm.primitiveKey,
        });
      }
    }
    return out;
  }
}
