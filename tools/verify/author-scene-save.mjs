/** Real author saver -> browser file adapter -> devfs -> temporary project round-trip. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createFsApiHandler } from '../../apps/editor/devfs.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const bundle = path.join(repo, '.workbuddy/tmp/author-scene-save-probe.mjs');
await mkdir(path.dirname(bundle), { recursive: true });
await build({ stdin: { contents: `
  export { AuthorSceneSaver } from './apps/editor/src/services/author-scene-save';
  export { readProjectFile, writeProjectFile } from './apps/editor/src/asset-util';
  export { SpawnEditStore, listSpawnPoints, sceneFingerprint, cloneDocument } from '@aether/runtime';
  export { validateSceneDocument } from '@aether/scene';
`, resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm',
  outfile: bundle, tsconfig: path.join(repo, 'tsconfig.check.json') });
const { AuthorSceneSaver, SpawnEditStore, listSpawnPoints, sceneFingerprint, cloneDocument,
  readProjectFile, writeProjectFile, validateSceneDocument } = await import(pathToFileURL(bundle).href);

function request(handler, body) {
  return new Promise((resolve, reject) => {
    const listeners = {};
    const req = { method: 'POST', url: '/__fs/write', on(event, cb) { (listeners[event] ??= []).push(cb); } };
    const res = { statusCode: 0, setHeader() {}, end(text) {
      const json = JSON.parse(text);
      resolve({ ok: this.statusCode >= 200 && this.statusCode < 300, status: this.statusCode, json: async () => json });
    } };
    try {
      handler(req, res, () => reject(new Error('write route not handled')));
      for (const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(body)));
      for (const cb of listeners.end ?? []) cb();
    } catch (error) { reject(error); }
  });
}

const root = await mkdtemp(path.join(tmpdir(), 'author-save-'));
const rel = 'assets/scenes/author-probe.scene.json';
const absolute = path.join(root, rel);
assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'author-save-'));
assert.ok(path.resolve(absolute).startsWith(path.resolve(root) + path.sep));
try {
  const fixture = JSON.parse(await readFile(path.join(repo, 'assets/scenes/act1/floor-1.scene.json'), 'utf8'));
  fixture.id = 'sc_author_save_probe';
  fixture.userData = { unknownAuthorData: { preserve: [1, 'two', { three: true }] } };
  const project = JSON.parse(await readFile(path.join(repo, 'aether.project.json'), 'utf8'));
  project.scenes = [{ path: rel, id: fixture.id, enabled: true }]; project.startIndex = 0;
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(fixture));
  await writeFile(path.join(root, 'aether.project.json'), JSON.stringify(project));
  const handler = createFsApiHandler(root);
  const read = (p) => readProjectFile(p, async (url) => {
    const requested = new URL(url, 'http://fixture').searchParams.get('path');
    try { const content = await readFile(path.join(root, requested), 'utf8'); return { ok: true, status: 200, json: async () => JSON.parse(content) }; }
    catch (error) { return { ok: false, status: 404, json: async () => null }; }
  });
  const write = (p, body) => writeProjectFile(p, body, async (_url, options) => request(handler, JSON.parse(options.body)));
  const saver = new AuthorSceneSaver({ read, write });
  const loaded = await read(rel);
  assert.equal(loaded.ok, true);
  const store = new SpawnEditStore(loaded.json);
  const cover = 'nd_f1r0_cv0'; const spawn = listSpawnPoints(store.document)[0].nodeId;
  assert.equal(store.setTransform(cover, { posX: -4 }).ok, true);
  assert.equal(store.setTransform(cover, { scale: 2, rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }).ok, true);
  assert.equal(store.set(spawn, 'count', 7).ok, true);
  assert.equal(store.set(spawn, 'radius', 4).ok, true);
  const expected = cloneDocument(store.document);
  assert.equal((await saver.save(store, rel)).status, 'saved');
  const reopened = (await read(rel)).json;
  assert.deepEqual(reopened, expected);
  assert.equal(validateSceneDocument(reopened).filter((d) => d.severity === 'error').length, 0);
  assert.deepEqual(reopened.userData, fixture.userData);
  assert.equal(store.dirty, false);
  console.log('PASS real devfs mixed transform/spawn save + validated reload + unknown data preservation');

  store.setTransform(cover, { posZ: 22 });
  let injected = false;
  const lateConflict = new AuthorSceneSaver({ read, write: async (p, body) => {
    if (!injected) {
      injected = true; const external = (await read(rel)).json; external.name = 'other writer';
      const res = await write(p, { content: JSON.stringify(external), baseHash: sceneFingerprint(reopened) });
      assert.equal(res.ok, true);
    }
    return write(p, body);
  } });
  assert.equal((await lateConflict.save(store, rel)).status, 'conflict');
  assert.equal(store.undoDepth, 1); assert.equal(store.dirty, true);
  assert.equal((await read(rel)).json.name, 'other writer');
  console.log('PASS real devfs rejects late baseHash conflict and preserves local edit/history');

  const latest = (await read(rel)).json;
  store.reload(latest); store.setTransform(cover, { posZ: 33 });
  // Force server filesystem I/O to fail: the JSON destination is now an unreadable directory.
  await rm(absolute); await mkdir(absolute);
  const failure = new AuthorSceneSaver({ read: async () => ({ ok: true, status: 200, json: latest, error: null }), write });
  assert.equal((await failure.save(store, rel)).status, 'failed');
  assert.equal(store.undoDepth, 1); assert.equal(store.dirty, true);
  await rm(absolute, { recursive: true }); await writeFile(absolute, JSON.stringify(latest));
  assert.equal((await saver.save(store, rel)).status, 'saved');
  assert.equal((await read(rel)).json.nodes.find((n) => n.id === cover).transform.position[2], 33);
  console.log('PASS real devfs I/O failure preserves edit, queue recovers, retry saves valid JSON');
} finally {
  await rm(root, { recursive: true, force: true });
}
