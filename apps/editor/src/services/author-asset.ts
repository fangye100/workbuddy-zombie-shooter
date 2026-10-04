/** Projects a document insertion and its undo/redo, retaining CPU assets but never GPU resources. */
import type { SceneNode, parseGlb } from '@aether/scene';
import type { AssetNodeEdit, SpawnEditStore } from '@aether/runtime';
import type { LabRenderer } from '../renderer';

type Model = ReturnType<typeof parseGlb>;
type AssetView = Pick<LabRenderer, 'addObject' | 'removeObject' | 'findObjectIndexByNodeId'>;
export function assetSceneNode(id: string, name: string, path: string, guid: string, position: [number, number, number]): SceneNode {
  return {
    id, name, parent: null, prefab: null, visible: true, pickable: true, category: '资产',
    transform: { position: [...position], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: [{ kind: 'MeshRenderer', enabled: true, visible: true, layer: 0, importScale: 1,
      source: { type: 'asset', ref: { path, guid } }, materials: [] }],
  };
}

export class AuthorAssetController {
  private owner: SpawnEditStore | null = null;
  private readonly assets = new Map<string, { model: Model; bitmap: ImageBitmap | null }>();
  constructor(private readonly store: () => SpawnEditStore | null, private readonly view: AssetView) {}

  clear(): void {
    for (const asset of this.assets.values()) asset.bitmap?.close();
    this.assets.clear();
    this.owner = null;
  }

  insert(store: SpawnEditStore, node: SceneNode, model: Model, bitmap: ImageBitmap | null): number {
    if (this.owner !== store) { this.clear(); this.owner = store; }
    const index = this.add(node, model, bitmap);
    if (index === null) { bitmap?.close(); throw new Error('场景物体已达上限（64）'); }
    const result = store.insertAsset(node);
    if (!result.ok) { this.view.removeObject(index); bitmap?.close(); throw new Error(result.error!); }
    this.assets.set(node.id, { model, bitmap });
    return index;
  }

  project(edit: AssetNodeEdit, redo: boolean): string | null {
    const store = this.store();
    if (!store) return '没有作者文档';
    if (!redo) {
      const index = this.view.findObjectIndexByNodeId(edit.nodeId);
      if (index !== null) this.view.removeObject(index);
      return null;
    }
    const asset = this.owner === store ? this.assets.get(edit.nodeId) : undefined;
    const node = store.document.nodes.find((candidate) => candidate.id === edit.nodeId);
    if (!asset || !node) return '资产重做数据已失效，请重新导入';
    try {
      return this.add(node, asset.model, asset.bitmap) === null ? '场景物体已达上限（64），不能重做' : null;
    } catch (error) { return `资产重做失败：${String(error)}`; }
  }

  private add(node: SceneNode, model: Model, bitmap: ImageBitmap | null): number | null {
    return this.view.addObject(model.mesh, bitmap, model.subMeshes, node.name, [...node.transform.position],
      model.nodeTree, model.skeleton, model.animations, node.id, true);
  }
}
