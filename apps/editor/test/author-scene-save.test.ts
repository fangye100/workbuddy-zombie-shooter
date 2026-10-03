import { describe, it, expect } from 'vitest';
import { SpawnEditStore, cloneDocument, findSpawnComponent, listSpawnPoints, sceneFingerprint } from '@aether/runtime';
import type { SceneDocument } from '@aether/scene';
import { AuthorSceneSaver, authorSaveViolations, type AuthorSceneSavePort } from '../src/services/author-scene-save';

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });
const COVER = 'nd_f1r0_cv0';
function fixture(): SceneDocument {
  return cloneDocument((Object.values(MODULES)[0] as { default: SceneDocument }).default);
}
function setup() {
  const store = new SpawnEditStore(fixture());
  let disk = cloneDocument(store.document);
  let writes = 0;
  const port: AuthorSceneSavePort = {
    read: async () => ({ ok: true, status: 200, json: cloneDocument(disk), error: null }),
    write: async (_path, body) => {
      writes++;
      if (sceneFingerprint(disk) !== body.baseHash) return { ok: false, status: 409, error: 'conflict', conflict: true };
      disk = JSON.parse(body.content) as SceneDocument;
      return { ok: true, status: 200, bytes: body.content.length, error: null };
    },
  };
  return { store, port, saver: new AuthorSceneSaver(port), disk: () => disk, writes: () => writes, external: () => { disk.name = 'external'; } };
}

describe('author scene save authority and snapshot contract', () => {
  it('saves mixed position/rotation/scale/spawn edits, reopens identically, and preserves unknown fields', async () => {
    const s = setup();
    const sp = listSpawnPoints(s.store.document)[0]!.nodeId;
    s.store.setTransform(COVER, { posX: -4, scale: 2, rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] });
    s.store.set(sp, 'radius', 4); s.store.set(sp, 'count', 7);
    const wanted = cloneDocument(s.store.document);
    const result = await s.saver.save(s.store, 'fixture.scene.json');
    expect(result.status).toBe('saved');
    expect(s.writes()).toBe(1);
    const reopened = new SpawnEditStore(s.disk());
    expect(reopened.document).toEqual(wanted);
    expect(s.store.dirty).toBe(false);
    expect(findSpawnComponent(reopened.document, sp)!.count).toBe(7);
  });

  it('rejects unrelated field and misleading component changes with a path diagnostic before I/O', async () => {
    const s = setup();
    s.store.setTransform(COVER, { posX: -4 });
    s.store.document.name = 'unexpected';
    expect((await s.saver.save(s.store, 'fixture.scene.json')).message).toContain('name');
    expect(s.writes()).toBe(0);
    expect(s.store.undoDepth).toBe(1);
    expect(s.store.dirty).toBe(true);
    const base = fixture(); const saved = cloneDocument(base);
    const spawn = listSpawnPoints(base)[0]!.nodeId;
    const component = findSpawnComponent(saved, spawn)!;
    (component as { kind: string }).kind = 'Collider'; component.radius = 9;
    expect(authorSaveViolations(base, saved).some((d) => d.path.endsWith('.radius'))).toBe(true);
  });

  it('does not authorize deleting transform axes or corrupting quaternion/number values', () => {
    const base = fixture();
    for (const mutate of [
      (doc: SceneDocument) => { delete (doc.nodes[0] as unknown as Record<string, unknown>).transform; },
      (doc: SceneDocument) => { doc.nodes[0]!.transform.scale.pop(); },
      (doc: SceneDocument) => { doc.nodes[0]!.transform.rotation = [0, 0, 0, 2]; },
      (doc: SceneDocument) => { doc.nodes[0]!.transform.position[0] = NaN; },
    ]) {
      const saved = cloneDocument(base); mutate(saved);
      expect(authorSaveViolations(base, saved).length).toBeGreaterThan(0);
    }
  });

  it('early and service-side conflicts preserve edits and undo', async () => {
    const early = setup(); early.store.setTransform(COVER, { posX: -4 }); early.external();
    expect((await early.saver.save(early.store, 'fixture.scene.json')).status).toBe('conflict');
    expect(early.writes()).toBe(0);
    expect(early.store.dirty).toBe(true); expect(early.store.undoDepth).toBe(1);
    const late = setup(); late.store.setTransform(COVER, { posX: -4 });
    const write = late.port.write;
    late.port.write = async (...args) => { late.external(); return write(...args); };
    expect((await late.saver.save(late.store, 'fixture.scene.json')).status).toBe('conflict');
    expect(late.store.dirty).toBe(true); expect(late.store.undoDepth).toBe(1);
  });

  it('read/write I/O failure or thrown port leaves local state and releases the save gate', async () => {
    const s = setup(); s.store.setTransform(COVER, { posX: -4 });
    const read = s.port.read;
    s.port.read = async () => ({ ok: false, status: 500, json: null, error: 'read denied' });
    expect((await s.saver.save(s.store, 'fixture.scene.json')).status).toBe('failed');
    s.port.read = read;
    const write = s.port.write;
    s.port.write = async () => ({ ok: false, status: 500, error: 'disk full' });
    expect((await s.saver.save(s.store, 'fixture.scene.json')).status).toBe('failed');
    s.port.write = async () => { throw new Error('unexpected I/O'); };
    expect((await s.saver.save(s.store, 'fixture.scene.json')).status).toBe('failed');
    expect(s.store.undoDepth).toBe(1); expect(s.store.dirty).toBe(true);
    s.port.write = write;
    expect((await s.saver.save(s.store, 'fixture.scene.json')).status).toBe('saved');
  });

  it('edits during asynchronous save remain dirty and undoable while only the sent version is confirmed', async () => {
    const s = setup(); s.store.setTransform(COVER, { posX: -4 });
    const read = s.port.read;
    let release!: () => void;
    s.port.read = async (...args) => { await new Promise<void>((resolve) => { release = resolve; }); return read(...args); };
    const save = s.saver.save(s.store, 'fixture.scene.json');
    s.store.setTransform(COVER, { posZ: 22 });
    expect((await s.saver.save(s.store, 'fixture.scene.json')).status).toBe('busy');
    release();
    expect((await save).status).toBe('saved');
    expect(s.disk().nodes.find((n) => n.id === COVER)!.transform.position[2]).not.toBe(22);
    expect(s.store.dirty).toBe(true); expect(s.store.undoDepth).toBe(1);
    s.store.undo();
    expect(s.store.document).toEqual(s.disk()); expect(s.store.dirty).toBe(false);
  });
});


it('environment edits undo, redo and save while preserving unexposed fields', async () => {
  const s = setup();
  const before = structuredClone(s.store.document.environment);
  const target = { ...structuredClone(before), exposure: 1.35, fog: { ...before.fog, color: '#243536' } };
  expect(s.store.setEnvironment(target).ok).toBe(true);
  expect(s.store.dirty).toBe(true);
  s.store.undo(); expect(s.store.document.environment).toEqual(before);
  s.store.redo(); expect(s.store.document.environment).toEqual(target);
  expect((await s.saver.save(s.store, 'fixture.scene.json')).status).toBe('saved');
  expect(s.disk().environment).toEqual(target);
  expect(s.disk().environment.postOverride).toEqual(before.postOverride);
  expect(s.store.setEnvironment({ ...target, exposure: NaN }).ok).toBe(false);
  const invalid = cloneDocument(s.store.document); invalid.environment.postOverride = 'changed' as never;
  expect(authorSaveViolations(s.store.document, invalid).length).toBeGreaterThan(0);
});
