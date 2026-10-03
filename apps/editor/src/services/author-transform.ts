/** Author transform operations. Documents contain local TRS; both UI inputs use world space. */
import { SceneGraph, identityTransform, worldToLocalTransform } from '@aether/scene';
import type { SceneDocument, NodeId, TransformData } from '@aether/scene';
import { eulerToQuat, quatToEuler } from '@aether/core';
import { SpawnEditStore } from '@aether/runtime';
import type { EditResult, TransformValues } from '@aether/runtime';
import type { LabRenderer } from '../renderer';

export type InspectorTransformInput = { kind: 'position' | 'rotation'; axis: 0 | 1 | 2; value: number }
  | { kind: 'scale'; value: number };
export type TransformView = Pick<LabRenderer, 'getObjectNodeId' | 'getObjectState' | 'getObjectQuat'
  | 'findObjectIndexByNodeId' | 'setObjectPos' | 'setObjectQuat' | 'setObjectScale'>;
export type TransformMode = 'translate' | 'rotate' | 'scale';

export function graphOfDoc(doc: SceneDocument): SceneGraph {
  const graph = SceneGraph.fromDocument(doc);
  graph.updateWorldTransforms();
  return graph;
}

export function parentWorldOf(graph: SceneGraph, id: NodeId): TransformData | null {
  const node = graph.getNode(id);
  if (node === null) return null;
  if (node.parent === null) return identityTransform();
  return graph.getNode(node.parent)?.world ?? null;
}

export function pushWorldOfNode(view: TransformView, graph: SceneGraph, id: NodeId): void {
  const index = view.findObjectIndexByNodeId(id);
  const node = graph.getNode(id);
  if (index === null || node === null) return;
  node.world.position.forEach((v, axis) => view.setObjectPos(index, axis as 0 | 1 | 2, v));
  view.setObjectQuat(index, [...node.world.rotation]);
  // Renderer currently has one scale slot; the document retains all three axes.
  view.setObjectScale(index, node.world.scale[0]);
}

export function pushSubtreeToView(view: TransformView, graph: SceneGraph, id: NodeId): void {
  for (const child of [id, ...graph.descendantsOf(id)]) pushWorldOfNode(view, graph, child);
}

/** Convert only the operated quantity; renderer's scalar scale must never replace document TRS. */
export function worldEditValues(graph: SceneGraph, id: NodeId, world: TransformData, mode: TransformMode): TransformValues | string {
  const parent = parentWorldOf(graph, id);
  if (parent === null) return `场景文档里找不到父级链（节点 ${id}）`;
  if (mode === 'scale' && !parent.scale.every((v) => Math.abs(v - parent.scale[0]) < 1e-9)) {
    return '父级为非均匀缩放，当前统一缩放工具无法无损表示此操作';
  }
  const local = worldToLocalTransform(parent, world, identityTransform());
  if (local === null) return '父级缩放为 0，无法换算局部变换';
  if (mode === 'translate') return { posX: local.position[0], posY: local.position[1], posZ: local.position[2] };
  if (mode === 'rotate') return { rotation: [...local.rotation] };
  return { scale: local.scale[0] };
}

export class AuthorTransformController {
  constructor(private readonly store: () => SpawnEditStore | null, private readonly playing: () => boolean,
    private readonly view: TransformView) {}

  private reject(error: string): EditResult { return { ok: false, error, edit: null }; }

  private commit(index: number, world: TransformData, mode: TransformMode): EditResult {
    const store = this.store();
    const id = this.view.getObjectNodeId(index);
    if (this.playing()) return this.reject('Play 期间禁止作者变换编辑');
    if (store === null || id === null) return this.reject('该物体不属于场景文档，变换不会被保存');
    const graph = graphOfDoc(store.document);
    const values = worldEditValues(graph, id, world, mode);
    const result = typeof values === 'string' ? this.reject(values) : store.setTransform(id, values);
    // Includes failure: discard temporary gizmo preview and restore the author projection.
    pushSubtreeToView(this.view, graphOfDoc(store.document), id);
    return result;
  }

  inspector(index: number, input: InspectorTransformInput): EditResult {
    const store = this.store();
    const id = this.view.getObjectNodeId(index);
    if (this.playing()) return this.reject('Play 期间禁止作者变换编辑');
    if (store === null || id === null) return this.reject('该物体不属于场景文档，变换不会被保存');
    const node = graphOfDoc(store.document).getNode(id);
    if (node === null) return this.reject(`场景里找不到节点 ${id}`);
    const world: TransformData = { position: [...node.world.position], rotation: [...node.world.rotation], scale: [...node.world.scale] };
    if (input.kind === 'position') world.position[input.axis] = input.value;
    else if (input.kind === 'rotation') {
      const angles = [...quatToEuler(world.rotation)] as [number, number, number];
      angles[input.axis] = input.value * Math.PI / 180;
      world.rotation = [...eulerToQuat(...angles)];
    } else world.scale = [input.value, input.value, input.value];
    return this.commit(index, world, input.kind === 'position' ? 'translate' : input.kind === 'rotation' ? 'rotate' : 'scale');
  }

  gizmo(index: number, mode: TransformMode): EditResult {
    const state = this.view.getObjectState(index);
    const rotation = this.view.getObjectQuat(index);
    if (state === null || rotation === null) return this.reject('视图物体不存在');
    return this.commit(index, { position: [...state.pos], rotation: [...rotation], scale: [state.scale, state.scale, state.scale] }, mode);
  }

  /** A drag preview updates the derived graph only, never the author document/history. */
  preview(graph: SceneGraph, id: NodeId, index: number, mode: TransformMode): void {
    if (this.playing()) return;
    const state = this.view.getObjectState(index);
    const rotation = this.view.getObjectQuat(index);
    const current = graph.getNode(id);
    if (state === null || rotation === null || current === null) return;
    const values = worldEditValues(graph, id, {
      position: [...state.pos], rotation: [...rotation], scale: [state.scale, state.scale, state.scale],
    }, mode);
    if (typeof values === 'string') return;
    graph.setLocalTransform(id, {
      position: values.posX === undefined ? [...current.transform.position] : [values.posX, values.posY!, values.posZ!],
      rotation: values.rotation === undefined ? [...current.transform.rotation] : [...values.rotation],
      scale: values.scale === undefined ? [...current.transform.scale] : [values.scale, values.scale, values.scale],
    });
    graph.updateWorldTransforms();
    for (const child of graph.descendantsOf(id)) pushWorldOfNode(this.view, graph, child);
  }

  history(redo = false): EditResult {
    if (this.playing()) return this.reject('Play 期间禁止作者变换编辑');
    const store = this.store();
    if (store === null) return this.reject('没有作者文档');
    const edit = redo ? store.redo() : store.undo();
    if (edit?.kind === 'transform') pushSubtreeToView(this.view, graphOfDoc(store.document), edit.nodeId);
    return { ok: edit !== null, error: edit === null ? '没有可撤销/重做的编辑' : null, edit };
  }
}
