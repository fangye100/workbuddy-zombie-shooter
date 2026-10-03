import { describe, it, expect } from 'vitest';
import { SpawnEditStore, cloneDocument } from '@aether/runtime';
import { quatToEuler } from '@aether/core';
import type { SceneDocument, TransformData } from '@aether/scene';
import { AuthorTransformController, graphOfDoc, pushSubtreeToView, type TransformView } from '../src/services/author-transform';

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });
function fixture(): SceneDocument {
  const source = cloneDocument((Object.values(MODULES)[0] as { default: SceneDocument }).default);
  source.nodes = source.nodes.slice(0, 2);
  source.nodes[0]!.id = 'parent'; source.nodes[0]!.parent = null;
  source.nodes[0]!.transform = { position: [10, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 2, 2] };
  source.nodes[1]!.id = 'child'; source.nodes[1]!.parent = 'parent';
  source.nodes[1]!.transform = { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 2, 3] };
  return source;
}

function setup(doc = fixture()) {
  const store = new SpawnEditStore(doc);
  const ids = doc.nodes.map((n) => n.id);
  const objects: TransformData[] = ids.map((id) => graphOfDoc(doc).getNode(id)!.world);
  let playing = false;
  const view: TransformView = {
    getObjectNodeId: (i) => ids[i] ?? null,
    findObjectIndexByNodeId: (id) => ids.includes(id) ? ids.indexOf(id) : null,
    getObjectState: (i) => objects[i] === undefined ? null : {
      name: ids[i]!, pos: [...objects[i]!.position], rot: [...quatToEuler(objects[i]!.rotation)],
      scale: objects[i]!.scale[0], materialIndex: 0,
      stats: { vertices: 3, triangles: 1, boundaryEdges: 0, components: 1 },
    },
    getObjectQuat: (i) => objects[i]?.rotation ?? null,
    setObjectPos: (i, axis, value) => { objects[i]!.position[axis] = value; },
    setObjectQuat: (i, value) => { objects[i]!.rotation = [...value]; },
    setObjectScale: (i, value) => { objects[i]!.scale = [value, value, value]; },
  };
  const controller = new AuthorTransformController(() => store, () => playing, view);
  pushSubtreeToView(view, graphOfDoc(doc), 'parent');
  return { store, view, objects, controller, play: () => { playing = true; } };
}

describe('author transform shared UI adapter', () => {
  it('Inspector and Gizmo agree in world space under a translated, rotated, scaled parent', () => {
    const inspector = setup(); const gizmo = setup();
    expect(inspector.controller.inspector(1, { kind: 'position', axis: 1, value: 4 }).ok).toBe(true);
    gizmo.view.setObjectPos(1, 1, 4);
    expect(gizmo.controller.gizmo(1, 'translate').ok).toBe(true);
    expect(inspector.store.document).toEqual(gizmo.store.document);
    expect(inspector.store.document.nodes[1]!.transform.position[0]).toBeCloseTo(2);
    expect(inspector.store.document.nodes[1]!.transform.scale).toEqual([1, 2, 3]);
    expect(inspector.objects[1]!.position[1]).toBeCloseTo(4);
    expect(inspector.store.undoDepth).toBe(1);
    expect(inspector.store.dirty).toBe(true);
    inspector.controller.history();
    expect(inspector.objects[1]!.position[1]).toBeCloseTo(2);
    inspector.controller.history(true);
    expect(inspector.objects[1]!.position[1]).toBeCloseTo(4);
  });

  it('parent edit projects descendants without changing their local author transform', () => {
    const { controller, store, objects } = setup();
    const child = cloneDocument(store.document).nodes[1]!.transform;
    controller.inspector(0, { kind: 'position', axis: 0, value: 15 });
    expect(store.document.nodes[1]!.transform).toEqual(child);
    expect(objects[1]!.position[0]).toBeCloseTo(15);
    controller.history();
    expect(objects[1]!.position[0]).toBeCloseTo(10);
  });

  it('rotation does not overwrite nonuniform scale', () => {
    const { controller, store } = setup();
    expect(controller.inspector(1, { kind: 'rotation', axis: 0, value: 30 }).ok).toBe(true);
    expect(store.document.nodes[1]!.transform.scale).toEqual([1, 2, 3]);
    expect(store.changedPaths().every((d) => d.path.includes('rotation'))).toBe(true);
  });

  it('invalid input and rejected gizmo preview restore the author view and leave no history', () => {
    const { controller, store, objects, view } = setup();
    const original = cloneDocument(store.document);
    expect(controller.inspector(1, { kind: 'position', axis: 0, value: NaN }).ok).toBe(false);
    view.setObjectPos(1, 1, 1e8);
    expect(controller.gizmo(1, 'translate').ok).toBe(false);
    expect(objects[1]!.position[1]).toBeCloseTo(2);
    expect(store.document).toEqual(original);
    expect(store.undoDepth).toBe(0);
  });

  it('rejects unsupported uniform scale under nonuniform parent before changing the document', () => {
    const doc = fixture(); doc.nodes[0]!.transform.scale = [2, 3, 4];
    const { controller, store } = setup(doc);
    expect(controller.inspector(1, { kind: 'scale', value: 8 }).error).toContain('非均匀');
    expect(store.document).toEqual(doc);
    expect(store.dirty).toBe(false);
  });

  it('Play disables Inspector, Gizmo and history without author writes or runtime projection', () => {
    const { controller, store, play, view, objects } = setup();
    controller.inspector(0, { kind: 'position', axis: 0, value: 15 });
    const author = cloneDocument(store.document);
    play(); view.setObjectPos(0, 0, 17);
    expect(controller.inspector(0, { kind: 'position', axis: 0, value: 40 }).ok).toBe(false);
    expect(controller.gizmo(0, 'translate').ok).toBe(false);
    expect(controller.history().ok).toBe(false);
    expect(store.document).toEqual(author);
    expect(store.undoDepth).toBe(1);
    expect(objects[0]!.position[0]).toBe(17);
  });
});
