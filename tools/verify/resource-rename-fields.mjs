/** Real devfs handlers and temporary project data: typed paths, rollback, shared write coordination. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsApiHandler } from '../../apps/editor/devfs.ts';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'resource-rename-fields-'));
assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'resource-rename-fields-'));
const put = async (p, value) => { const abs = path.join(root, p); await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, typeof value === 'string' ? value : JSON.stringify(value)); };
const get = async (p) => JSON.parse(await readFile(path.join(root, p), 'utf8'));
const present = async (p) => { await access(path.join(root, p)); };
const absent = async (p) => { await assert.rejects(access(path.join(root, p))); };
const handler = createFsApiHandler(root);
function request(route, body) {
  return new Promise((resolve, reject) => {
    const listeners = {}; const req = { method: 'POST', url: `/__fs/${route}`, on(e, cb) { (listeners[e] ??= []).push(cb); } };
    const res = { statusCode: 0, setHeader() {}, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    handler(req, res, () => reject(new Error('route unhandled')));
    for (const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(body)));
    for (const cb of listeners.end ?? []) cb();
  });
}
const rename = (p, name) => request('rename', { path: p, newName: name });
try {
  const project = JSON.parse(await readFile(path.join(repo, 'aether.project.json'), 'utf8'));
  const scene = JSON.parse(await readFile(path.join(repo, 'assets/scenes/act1/floor-1.scene.json'), 'utf8'));
  const original = 'assets/style/base.post.json', next = 'assets/style/renamed.post.json';
  scene.id = 'sc_typed_refs'; scene.environment.postOverride = original; scene.dependencies = [original, 'assets/style/base.post.json.backup'];
  scene.userData = { note: original };
  const prefab = { schemaVersion: scene.schemaVersion, id: 'pf_typed_refs', name: 'typed', root: scene.nodes[0].id,
    nodes: [structuredClone(scene.nodes[0])], dependencies: [original], meta: {} };
  project.scenes = [{ id: scene.id, path: 'assets/scenes/refs.scene.json', enabled: true }]; project.startIndex = 0; project.assetRoots = ['assets'];
  await put('aether.project.json', project); await put(project.scenes[0].path, scene); await put('assets/prefabs/refs.prefab.json', prefab); await put(original, {});
  const first = await rename(original, 'renamed.post.json'); assert.equal(first.status, 200, JSON.stringify(first));
  const diskScene = await get(project.scenes[0].path), diskPrefab = await get('assets/prefabs/refs.prefab.json');
  console.log(JSON.stringify({actual: {postOverride: diskScene.environment.postOverride, sceneDependencies: diskScene.dependencies, prefabDependencies: diskPrefab.dependencies}, expected: {postOverride:next, sceneDependencies:[next,'assets/style/base.post.json.backup'],prefabDependencies:[next]}}));
  assert.equal(diskScene.environment.postOverride, next); assert.deepEqual(diskScene.dependencies, [next, 'assets/style/base.post.json.backup']); assert.deepEqual(diskPrefab.dependencies, [next]); assert.deepEqual(diskScene.userData, scene.userData);
  await absent(original); await present(next); assert.ok(first.body.updatedFiles.includes('assets/prefabs/refs.prefab.json'));
  const moved = await rename('assets/style', 'moved-style'); assert.equal(moved.status, 200);
  const movedPath = 'assets/moved-style/renamed.post.json';
  assert.equal((await get(project.scenes[0].path)).environment.postOverride, movedPath); assert.deepEqual((await get('assets/prefabs/refs.prefab.json')).dependencies, [movedPath]);
  console.log('PASS scene postOverride and scene/prefab dependencies: file and directory rename, similar prefix and free annotation retained');
  // Force atomic prefab write failure after the scene write: the existing filename
  // is legal, but its transaction temp suffix exceeds the filesystem entry limit.
  const longPrefab = `assets/prefabs/${'p'.repeat(198)}.prefab.json`;
  await put(longPrefab, await get('assets/prefabs/refs.prefab.json'));
  const beforeIoScene = await readFile(path.join(root, project.scenes[0].path));
  const beforeIoPrefab = await readFile(path.join(root, longPrefab));
  const failed = await rename(movedPath, 'io-failed.post.json');
  assert.equal(failed.status, 500, JSON.stringify(failed));
  assert.deepEqual(failed.body.rollbackErrors, []);
  await present(movedPath); await absent('assets/moved-style/io-failed.post.json');
  assert.deepEqual(await readFile(path.join(root, project.scenes[0].path)), beforeIoScene);
  assert.deepEqual(await readFile(path.join(root, longPrefab)), beforeIoPrefab);
  assert.equal((await get('assets/prefabs/refs.prefab.json')).dependencies[0], movedPath);
  assert.equal((await get(path.relative(root, path.join(failed.body.recoveryPath, 'transaction.json')))).state, 'rolled-back');
  await rm(path.join(root, longPrefab));
  console.log('PASS real mid-transaction I/O failure restores typed scene/prefab reference bytes and source; journal rolled-back');
  const blocked = await get(project.scenes[0].path); blocked.nodes[0].components.push({kind:'Script',enabled:true,behavior:'untyped',params:{path:movedPath}});
  await put(project.scenes[0].path,blocked); const beforeScene=await readFile(path.join(root,project.scenes[0].path));const beforePrefab=await readFile(path.join(root,'assets/prefabs/refs.prefab.json'));
  const refused=await rename(movedPath,'refused.post.json');assert.equal(refused.status,400);await present(movedPath);await absent('assets/moved-style/refused.post.json');assert.deepEqual(await readFile(path.join(root,project.scenes[0].path)),beforeScene);assert.deepEqual(await readFile(path.join(root,'assets/prefabs/refs.prefab.json')),beforePrefab);
  console.log('PASS unsupported matching Script preflight leaves asset/postOverride/dependencies/annotation bytes unchanged');
} finally { await rm(root, {recursive:true,force:true}); }
