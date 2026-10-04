import { describe, it, expect } from 'vitest';
import { SpawnEditStore, cloneDocument } from '@aether/runtime';
import type { SceneDocument, parseGlb } from '@aether/scene';
import { assetSceneNode, AuthorAssetController } from '../src/services/author-asset';
import { authorSaveViolations } from '../src/services/author-scene-save';
import { AuthorTransformController, type TransformView } from '../src/services/author-transform';

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });
function setup() {
  const store = new SpawnEditStore(cloneDocument((Object.values(MODULES)[0] as { default: SceneDocument }).default));
  const node = assetSceneNode('asset-test', 'LOD2', 'assets/environment/models/P-01/tex2/P-01_lod2.glb', 'guid-test', [2, 0, 3]);
  return { store, node };
}

describe('asset browser document insertion', () => {
  it('shares transform history, retains GUID/metres, and undoes/redoes exact nodes', () => {
    const { store, node } = setup();
    const original = cloneDocument(store.document);
    expect(store.insertAsset(node).ok).toBe(true);
    store.setTransform(node.id, { posX: 5 });
    expect(authorSaveViolations(original, store.document, store.insertedAssetNodes)).toEqual([]);
    expect(store.document.nodes.at(-1)!.transform.position).toEqual([5, 0, 3]);
    store.undo(); store.undo();
    expect(store.document).toEqual(original);
    store.redo(); store.redo();
    expect(store.document.nodes.at(-1)!.transform.position).toEqual([5, 0, 3]);
    expect(store.document.nodes.at(-1)!.components).toEqual(node.components);
  });

  it('rejects duplicate/missing GUID/invalid nodes without recording a command', () => {
    const { store, node } = setup();
    const invalid = structuredClone(node);
    invalid.transform.position[0] = NaN;
    expect(store.insertAsset(invalid).ok).toBe(false);
    const mesh = invalid.components[0]!;
    if (mesh.kind === 'MeshRenderer' && mesh.source.type === 'asset') delete mesh.source.ref.guid;
    expect(store.insertAsset(invalid).ok).toBe(false);
    expect(store.undoDepth).toBe(0);
    expect(store.insertAsset(node).ok).toBe(true);
    expect(store.insertAsset(node).ok).toBe(false);
    expect(store.undoDepth).toBe(1);
  });

  it('does not extend save authority to uncommanded nodes or changed asset paths', () => {
    const { store, node } = setup();
    store.document.nodes.push(structuredClone(node));
    expect(authorSaveViolations(store.committedDocument, store.document)).not.toEqual([]);
    store.document.nodes.pop(); store.insertAsset(node);
    const mesh = store.document.nodes.at(-1)!.components[0]!;
    if (mesh.kind === 'MeshRenderer' && mesh.source.type === 'asset') mesh.source.ref.path = 'assets/unrelated.glb';
    expect(authorSaveViolations(store.committedDocument, store.document, store.insertedAssetNodes)).not.toEqual([]);
  });

  it('preserves an undo during an in-flight insertion save as an authorized dirty removal', () => {
    const { store, node } = setup();
    store.insertAsset(node);
    const snapshot = store.beginSave(); store.undo();
    store.confirmSave(snapshot.doc, snapshot.lastEditId);
    expect(store.dirty).toBe(true);
    expect(authorSaveViolations(store.committedDocument, store.document, store.insertedAssetNodes)).toEqual([]);
  });

  it('destroys the view on undo and rolls back capacity failure on redo', () => {
    const { store, node } = setup();
    let full = false; let active = false; let removed = 0;
    const view = {
      addObject: () => { if (full) return null; active = true; return 10; },
      removeObject: () => { active = false; removed++; },
      findObjectIndexByNodeId: () => active ? 10 : null,
    };
    const assets = new AuthorAssetController(() => store, view);
    const history = new AuthorTransformController(() => store, () => false, view as unknown as TransformView,
      (edit, redo) => assets.project(edit, redo));
    assets.insert(store, node, {} as ReturnType<typeof parseGlb>, null);
    expect(history.history().ok).toBe(true);
    expect(removed).toBe(1); expect(active).toBe(false);
    full = true;
    expect(history.history(true).ok).toBe(false);
    expect(store.document.nodes.some((n) => n.id === node.id)).toBe(false);
    expect(store.redoDepth).toBe(1);
    full = false;
    expect(history.history(true).ok).toBe(true); expect(active).toBe(true);
  });

  it('keeps the CPU texture alive for redo and closes it when history is released', () => {
    const { store, node } = setup();
    let closed = false;
    const bitmap = { close: () => { closed = true; } } as ImageBitmap;
    const view = {
      addObject: (...args: unknown[]) => { expect(args[9]).toBe(true); expect(closed).toBe(false); return 1; },
      removeObject: () => {}, findObjectIndexByNodeId: () => 1,
    };
    const assets = new AuthorAssetController(() => store, view);
    assets.insert(store, node, {} as ReturnType<typeof parseGlb>, bitmap);
    const edit = store.undo()!;
    if (edit.kind !== 'asset-node') throw new Error('wrong command');
    assets.project(edit, false); store.redo(); assets.project(edit, true);
    expect(closed).toBe(false);
    assets.clear(); expect(closed).toBe(true);
  });
});
