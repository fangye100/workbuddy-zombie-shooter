import { describe, it, expect } from 'vitest';
import { SpawnEditStore, cloneDocument, sceneFingerprint } from '@aether/runtime';
import type { SceneDocument } from '@aether/scene';
import { refreshAuthorResources, renamedResourcePath } from '../src/services/resource-rename';
const modules = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });
const fixture = () => cloneDocument((Object.values(modules)[0] as { default: SceneDocument }).default);
const result = { ok: true, path: 'assets/new', oldPath: 'assets/old', directory: true, updatedFiles: ['assets/sc.scene.json'], metaRenamed: false, projectUpdated: true, projectError: null, error: null };
describe('author resource rename refresh', () => {
  it('maps only moved file/directory paths and sidecar, not similar prefixes', () => {
    expect(renamedResourcePath('assets/older/a', result)).toBe('assets/older/a');
    expect(renamedResourcePath('assets/old/a', result)).toBe('assets/new/a');
    expect(renamedResourcePath('a.glb.meta.json', { ...result, oldPath: 'a.glb', path: 'b.glb', directory: false })).toBe('b.glb.meta.json');
  });
  it('accepts the new disk version into a clean author document', async () => {
    const s = new SpawnEditStore(fixture()); const next = fixture(); next.name = 'accepted disk';
    expect((await refreshAuthorResources(s, 'assets/sc.scene.json', result, async () => ({ ok: true, status: 200, json: next, error: null }))).status).toBe('refreshed');
    expect(s.document).toEqual(next); expect(sceneFingerprint(s.committedDocument)).toBe(sceneFingerprint(next)); expect(s.dirty).toBe(false);
  });
  it('keeps dirty document and history untouched, including an edit during reload', async () => {
    const s = new SpawnEditStore(fixture()); s.setTransform('nd_f1r0_cv0', { posX: 8 }); const before = cloneDocument(s.document);
    const read = async () => { throw new Error('should not read'); };
    expect((await refreshAuthorResources(s, 'assets/sc.scene.json', result, read)).status).toBe('conflict');
    expect(s.document).toEqual(before); expect(s.undoDepth).toBe(1);
    const fresh = new SpawnEditStore(fixture());
    expect((await refreshAuthorResources(fresh, 'assets/sc.scene.json', result, async () => {
      fresh.setTransform('nd_f1r0_cv0', { posX: 9 }); return { ok: true, status: 200, json: fixture(), error: null };
    })).status).toBe('conflict');
    expect(fresh.undoDepth).toBe(1); expect(fresh.dirty).toBe(true);
  });
  it('does not accept into Play or a replaced active store and rejects invalid disk data', async () => {
    const s = new SpawnEditStore(fixture());
    expect((await refreshAuthorResources(s, 'assets/sc.scene.json', result, async () => ({ ok: true, status: 200, json: fixture(), error: null }), () => false)).status).toBe('conflict');
    expect((await refreshAuthorResources(s, 'assets/sc.scene.json', result, async () => ({ ok: true, status: 200, json: {}, error: null }))).status).toBe('failed');
    expect(s.dirty).toBe(false);
  });
});
