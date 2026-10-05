/** Asset insertion is document data; GPU/cache ownership stays in the editor. */
import { validateSceneDocument } from '@aether/scene';
import type { SceneDocument, SceneNode } from '@aether/scene';
import type { EditResult } from './spawn-edit';

export interface AssetNodeEdit {
  kind: 'asset-node';
  id: number;
  nodeId: string;
  node: SceneNode;
  remove: boolean;
}

export function applyAssetNodeEdit(doc: SceneDocument, edit: AssetNodeEdit): EditResult {
  const reject = (error: string): EditResult => ({ ok: false, error, edit: null });
  const index = doc.nodes.findIndex((node) => node.id === edit.nodeId);
  if (edit.remove) {
    if (index < 0 || doc.nodes.some((node) => node.parent === edit.nodeId)) return reject('资产节点不存在或仍有子节点');
    doc.nodes.splice(index, 1);
  } else {
    const node = edit.node;
    const mesh = node.components[0];
    if (index >= 0 || node.id !== edit.nodeId || node.parent !== null || node.prefab !== null
      || node.components.length !== 1 || mesh?.kind !== 'MeshRenderer' || mesh.source.type !== 'asset'
      || !mesh.source.ref.guid?.trim() || !/^assets\/.+\.glb$/i.test(mesh.source.ref.path)) return reject('资产插入需要唯一节点、项目 GLB 路径和 GUID');
    const candidate = { ...doc, nodes: [...doc.nodes, node] };
    const invalid = validateSceneDocument(candidate).find((diagnostic) => diagnostic.severity === 'error');
    if (invalid) return reject(`资产节点校验失败：${invalid.message}`);
    doc.nodes.push(structuredClone(node));
  }
  return { ok: true, error: null, edit };
}
