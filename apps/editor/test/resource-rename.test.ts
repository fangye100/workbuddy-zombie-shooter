import { describe, it, expect } from 'vitest';
import { SpawnEditStore, cloneDocument, sceneFingerprint } from '@aether/runtime';
import type { SceneDocument } from '@aether/scene';
import { AuthorSceneSaver } from '../src/services/author-scene-save';
import { resolveStartScenePath } from '../src/scene-boot';
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

const projects = import.meta.glob('../../../aether.project.json', { eager: true });
async function normalBootPath() {
  const project = JSON.parse(JSON.stringify((Object.values(projects)[0] as { default: unknown }).default));
  project.scenes = [{ path: 'assets/scenes/start.scene.json', id: fixture().id, enabled: true }]; project.startIndex = 0;
  const boot = await resolveStartScenePath(async () => ({ ok: true, status: 200, json: async () => project }));
  expect(boot.fromProject).toBe(true); expect(boot.path).toBe('/assets/scenes/start.scene.json');
  return boot.path;
}
describe('normal boot URL survives rename and subsequent author save', () => {
  it.each([
    ['asset', 'assets/model.glb', 'assets/renamed.glb', false, 'assets/scenes/start.scene.json'],
    ['scene file', 'assets/scenes/start.scene.json', 'assets/scenes/renamed.scene.json', false, 'assets/scenes/renamed.scene.json'],
    ['scene directory', 'assets/scenes', 'assets/moved-scenes', true, 'assets/moved-scenes/start.scene.json'],
  ] as const)('%s accepts committed data and saves the next Inspector edit without reload', async (_name, oldPath, path, directory, expected) => {
    const source = await normalBootPath(); const store = new SpawnEditStore(fixture());
    let disk = fixture(); disk.name = 'accepted rename version';
    if (_name === 'asset') {
      const mesh = disk.nodes.find((n) => n.id === 'nd_f1r0_cv0')!.components.find((c) => c.kind === 'MeshRenderer')!;
      if (mesh.kind !== 'MeshRenderer') throw new Error('mesh'); mesh.source = { type: 'asset', ref: { path } };
    }
    const renamed = { ...result, oldPath, path, directory, updatedFiles: [expected] };
    const reads: string[] = []; const read = async (p: string) => { reads.push(p); expect(p).toBe(expected); return { ok: true, status: 200, json: cloneDocument(disk), error: null }; };
    const refreshed = await refreshAuthorResources(store, source, renamed, read);
    expect(refreshed.status).toBe('refreshed'); expect(refreshed.source).toBe(expected);
    expect(store.document).toEqual(disk); expect(store.committedDocument).toEqual(disk); expect(store.dirty).toBe(false);
    const saver = new AuthorSceneSaver({ read, write: async (p, body) => {
      expect(p).toBe(expected); expect(body.baseHash).toBe(sceneFingerprint(disk));
      disk = JSON.parse(body.content) as SceneDocument; return { ok: true, status: 200, error: null };
    } });
    store.setTransform('nd_f1r0_cv0', { posX: -4 });
    expect((await saver.save(store, refreshed.source)).status).toBe('saved');
    expect(disk.nodes.find((n) => n.id === 'nd_f1r0_cv0')!.transform.position[0]).toBe(-4);
    expect(store.dirty).toBe(false); expect(store.committedDocument).toEqual(disk); expect(reads).toEqual([expected, expected]);
  });
  it('matches updated file identities with a leading slash and avoids unrelated URL reads', async () => {
    const source = await normalBootPath(); const s = new SpawnEditStore(fixture()); let reads = 0;
    const read = async () => { reads++; return { ok: true, status: 200, json: fixture(), error: null }; };
    expect((await refreshAuthorResources(s, source, { ...result, updatedFiles: ['/assets/scenes/start.scene.json'] }, read)).status).toBe('refreshed');
    expect(reads).toBe(1);
    expect(await refreshAuthorResources(s, source, result, read)).toMatchObject({ status: 'unaffected', source: 'assets/scenes/start.scene.json' });
    expect(reads).toBe(1);
    expect(renamedResourcePath('/assets/older/a', result)).toBe('assets/older/a');
    expect(renamedResourcePath('/a.glb.meta.json', { ...result, oldPath: '/a.glb', path: '/b.glb', directory: false })).toBe('b.glb.meta.json');
  });
  it('retains dirty/Play/replaced-store protection for the boot URL before and during read', async () => {
    const source = await normalBootPath(); const renamed = { ...result, updatedFiles: ['assets/scenes/start.scene.json'] };
    const dirty = new SpawnEditStore(fixture()); dirty.setTransform('nd_f1r0_cv0', { posX: 9 });
    expect((await refreshAuthorResources(dirty, source, renamed, async () => { throw new Error('must not read dirty'); })).status).toBe('conflict'); expect(dirty.undoDepth).toBe(1);
    const playing = new SpawnEditStore(fixture());
    expect((await refreshAuthorResources(playing, source, renamed, async () => { throw new Error('must not read in Play'); }, () => false)).status).toBe('conflict');
    const editing = new SpawnEditStore(fixture());
    expect((await refreshAuthorResources(editing, source, renamed, async () => { editing.setTransform('nd_f1r0_cv0', { posX: 9 }); return { ok: true, status: 200, json: fixture(), error: null }; })).status).toBe('conflict'); expect(editing.undoDepth).toBe(1); expect(editing.dirty).toBe(true);
    const replaced = new SpawnEditStore(fixture()); let accepted = true;
    expect((await refreshAuthorResources(replaced, source, renamed, async () => { accepted = false; return { ok: true, status: 200, json: fixture(), error: null }; }, () => accepted)).status).toBe('conflict'); expect(replaced.dirty).toBe(false);
  });
});
