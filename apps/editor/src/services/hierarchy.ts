/**
 * HierarchyService —— 场景层级（Hierarchy）数据源与可见性 / 删除。
 *
 * 提供层级面板的数据源（对象列表 + GLB 树 + 子网格 + 材质名），以及子网格 / 物体
 * 显隐、删除（墓碑标记）。删除 / 隐藏会联动取消选中与悬停（通过 host 的 selection API），
 * 并立刻释放 GPU 缓冲避免泄漏。状态存于 host.state。
 */
import type { GltfNodeTree } from '@aether/scene';
import type {
  LabRenderer,
  SceneObject,
  SubMesh,
  HierarchyNode,
  HierarchySubNode,
  HierarchyTreeNode,
} from '../renderer';

export class HierarchyService {
  constructor(private readonly host: LabRenderer) {}

  /** 层级面板数据源；removed 的墓碑行不出现在列表里。每个对象带上可展开的子网格列表 */
  getObjectList(): HierarchyNode[] {
    const s = this.host.state;
    const subNode = (sm: SubMesh): HierarchySubNode => ({
      name: sm.name,
      triangles: sm.indexCount / 3,
      visible: sm.visible,
      materialName: s.library.nameOf(s.params, sm.materialId),
      source: this.host.sourceOf(sm),
    });
    // GLB 原始层级 → 面板树节点；组节点若没有 mesh 后代会被剪掉（parseGlb 已剪过空壳，双保险）
    const buildTree = (o: SceneObject, nodes: GltfNodeTree[]): HierarchyTreeNode[] => {
      const out: HierarchyTreeNode[] = [];
      for (const n of nodes) {
        const subs: HierarchyTreeNode['subs'] = [];
        if (n.subStart !== null) {
          for (let i = n.subStart; i < n.subStart + n.subCount; i++) {
            const sm = o.subMeshes[i];
            if (sm !== undefined) subs.push({ subIndex: i, node: subNode(sm) });
          }
        }
        const children = buildTree(o, n.children);
        if (subs.length === 0 && children.length === 0) continue;
        out.push({ name: n.name, subs, children });
      }
      return out;
    };

    const out: HierarchyNode[] = [];
    for (let i = 0; i < s.objects.length; i++) {
      const o = s.objects[i]!;
      if (o.removed) continue;
      out.push({
        index: i,
        name: o.name,
        category: o.category,
        visible: o.visible,
        pickable: o.pickable,
        triangles: o.indexCount / 3,
        subMeshes: o.subMeshes.map(subNode),
        tree: buildTree(o, o.nodeTree),
      });
    }
    return out;
  }

  /** 子网格显隐（层级树里 mesh 节点的眼睛）。只影响那一段索引区间 */
  setSubMeshVisible(index: number, sub: number, visible: boolean): void {
    const s = this.host.state;
    const o = s.objects[index];
    const sm = o?.subMeshes[sub];
    if (sm === undefined) return;
    sm.visible = visible;
    if (!visible && s.selectedIndex === index && s.selectedSub === sub) {
      this.host.selectObject(index, null);
    }
  }

  /** 显隐（层级面板的眼睛）。隐藏 = 不画 + 不拾取；已隐藏的物体被取消选中以免残留 gizmo */
  setObjectVisible(index: number, visible: boolean): void {
    const s = this.host.state;
    const o = s.objects[index];
    if (o === undefined) return;
    o.visible = visible;
    if (!visible) {
      if (s.selectedIndex === index) this.host.selectObject(null);
      if (s.hoveredIndex === index) this.host.setHovered(null);
    }
  }

  /**
   * 从场景删除（墓碑标记，索引保持不变，避免打乱其他物体的 uniform 槽位）。
   *
   * 墓碑物体永远不会被绘制或拾取，它的 GPU 缓冲必须立刻还回去 ——
   * 只打标记不释放，等于每次导入 80k 面高模再删掉就永久泄漏一份顶点数据。
   */
  removeObject(index: number): void {
    const s = this.host.state;
    const o = s.objects[index];
    if (o === undefined || o.removed) return;
    if (s.selectedIndex === index) this.host.selectObject(null);
    if (s.hoveredIndex === index) this.host.setHovered(null);
    o.removed = true;
    o.vertexBuffer.destroy();
    o.indexBuffer.destroy();
    // 拖入资产的独占贴图一并还回去（共享 whiteTex / 角色 charTexture 不动）
    if (o.ownsTexture) {
      o.texture.destroy();
      o.ownsTexture = false;
      o.texture = this.host.whiteTex;
    }
    // 丢弃指向已销毁缓冲的 bind group：留着只是占引用，用到就是非法访问
    s.bindGroups[index] = [];
    this.host.recountTriangles();
  }
}
