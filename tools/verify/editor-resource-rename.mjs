/** Normal scene-boot URL -> real rename handler -> clean author reload -> real compare/save. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createFsApiHandler } from '../../apps/editor/devfs.ts';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'editor-resource-rename-'));
assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'editor-resource-rename-'));
try {
  const bundle = path.join(root, 'editor.mjs');
  await build({ stdin: { contents: `
    export { SpawnEditStore } from '@aether/runtime';
    export { AuthorSceneSaver } from './apps/editor/src/services/author-scene-save';
    export { refreshAuthorResources } from './apps/editor/src/services/resource-rename';
    export { resolveStartScenePath } from './apps/editor/src/scene-boot';
    export { readProjectFile, writeProjectFile } from './apps/editor/src/asset-util';
  `, resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, tsconfig: path.join(repo, 'tsconfig.check.json') });
  const { SpawnEditStore, AuthorSceneSaver, refreshAuthorResources, resolveStartScenePath, readProjectFile, writeProjectFile } = await import(pathToFileURL(bundle).href);
  const scenePath = 'assets/scenes/start.scene.json'; const assetPath = 'assets/models/model.glb';
  const project = JSON.parse(await readFile(path.join(repo, 'aether.project.json'), 'utf8'));
  const scene = JSON.parse(await readFile(path.join(repo, 'assets/scenes/act1/floor-1.scene.json'), 'utf8'));
  scene.id = 'sc_editor_rename'; project.scenes = [{ path: scenePath, id: scene.id, enabled: true }]; project.startIndex = 0;
  const cover = scene.nodes.find(n => n.id === 'nd_f1r0_cv0'); cover.components.find(c => c.kind === 'MeshRenderer').source = { type: 'asset', ref: { path: assetPath } };
  await mkdir(path.join(root, 'assets/scenes'), { recursive: true }); await mkdir(path.join(root, 'assets/models'), { recursive: true });
  await writeFile(path.join(root, scenePath), JSON.stringify(scene)); await writeFile(path.join(root, 'aether.project.json'), JSON.stringify(project));
  const source = path.join(repo, 'assets/characters/models/E-04/game_ready/E04_20260901_010134_1600tris.glb');
  await copyFile(source, path.join(root, assetPath)); await copyFile(`${source}.meta.json`, path.join(root, `${assetPath}.meta.json`));
  const handler = createFsApiHandler(root);
  function request(route, body) { return new Promise((resolve, reject) => {
    const listeners = {}; const req = { method: 'POST', url: `/__fs/${route}`, on(e, cb) { (listeners[e] ??= []).push(cb); } };
    const res = { statusCode: 0, setHeader() {}, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    handler(req, res, () => reject(new Error('unhandled')));
    for(const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(body))); for(const cb of listeners.end ?? []) cb();
  }); }
  const fetchRead = async (url) => {
    const rel = new URL(url, 'http://fixture').searchParams.get('path');
    assert.ok(!rel.startsWith('/'), 'adapter must use project identity for read');
    try { const text = await readFile(path.join(root, rel), 'utf8'); return { ok: true, status: 200, json: async () => JSON.parse(text) }; }
    catch { return { ok: false, status: 404, json: async () => null }; }
  };
  const read = (p) => readProjectFile(p, fetchRead);
  const write = (p, body) => writeProjectFile(p, body, async (_url, options) => {
    const response = await request('write', JSON.parse(options.body)); return { ok: response.status === 200, status: response.status, json: async () => response.body };
  });
  const boot = await resolveStartScenePath(fetchRead); assert.equal(boot.path, '/'+scenePath); assert.equal(boot.fromProject, true);
  const store = new SpawnEditStore(scene); const saver = new AuthorSceneSaver({ read, write }); let currentSource = boot.path;
  for(const [oldPath, name, expectedSource] of [[assetPath,'renamed.glb',scenePath],[scenePath,'renamed.scene.json','assets/scenes/renamed.scene.json'],['assets/scenes','moved-scenes','assets/moved-scenes/renamed.scene.json']]) {
    const renamed = await request('rename', { path: oldPath, newName: name }); assert.equal(renamed.status, 200, JSON.stringify(renamed));
    // Renderer receives the boot-style URL; model its URL identity again for every rename.
    const refreshed = await refreshAuthorResources(store, '/'+currentSource.replace(/^\/+/, ''), renamed.body, read);
    assert.equal(refreshed.status, 'refreshed'); assert.equal(refreshed.source, expectedSource); currentSource = refreshed.source;
    const disk = (await read(currentSource)).json; assert.deepEqual(store.committedDocument, disk); assert.deepEqual(store.document, disk);
    assert.equal(disk.nodes.find(n => n.id === cover.id).components.find(c => c.kind === 'MeshRenderer').source.ref.path, 'assets/models/renamed.glb');
    const nextX = store.document.nodes.find(n => n.id === cover.id).transform.position[0]+1; store.setTransform(cover.id,{posX:nextX});
    const saved = await saver.save(store,currentSource); assert.equal(saved.status,'saved',JSON.stringify(saved)); assert.equal(store.dirty,false);
    assert.equal((await read(currentSource)).json.nodes.find(n => n.id === cover.id).transform.position[0],nextX);
    console.log(`PASS boot /assets identity ${oldPath} rename -> committed author refresh -> immediate edit/save, source=${currentSource}`);
  }
} finally { await rm(root, { recursive: true, force: true }); }
