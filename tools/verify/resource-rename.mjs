/** Real devfs handlers and temporary project data: typed paths, rollback, shared write coordination. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsApiHandler } from '../../apps/editor/devfs.ts';
import { sceneFingerprint } from '../../packages/runtime/src/doc-diff.ts';
import { withProjectWriteLock } from '../fs/project-write.mjs';
import { validateSceneDocument } from '../../packages/scene/src/document.ts';
import { createDefaultRecipe, retargetFingerprint, validateRetargetAssetBlock } from '../../packages/scene/src/retarget-meta.ts';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'resource-rename-'));
assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'resource-rename-'));
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
  scene.id = 'sc_resource_rename';
  const asset = 'assets/models/model.glb';
  const mesh = scene.nodes.find((n) => n.id === 'nd_f1r0_cv0').components.find((c) => c.kind === 'MeshRenderer');
  mesh.source = { type: 'asset', ref: { path: asset, guid: 'as_probe', sub: 'index:0' } };
  const noGuid = structuredClone(scene.nodes.find((n) => n.id === 'nd_f1r0_cv0')); noGuid.id = 'nd_rename_noguid';
  noGuid.components.find((c) => c.kind === 'MeshRenderer').source.ref = { path: asset };
  scene.nodes.push(noGuid);
  scene.userData = { note: asset }; // annotation must not be rewritten
  project.scenes = [{ id: scene.id, path: 'assets/scenes/rename.scene.json', enabled: true }]; project.startIndex = 0;
  await put('aether.project.json', project); await put(project.scenes[0].path, scene);
  await mkdir(path.join(root, 'assets/models'), { recursive: true });
  const source = path.join(repo, 'assets/characters/models/E-04/game_ready/E04_20260901_010134_1600tris.glb');
  await copyFile(source, path.join(root, asset));
  const meta = JSON.parse(await readFile(`${source}.meta.json`, 'utf8')); meta.guid = 'as_probe';
  meta.retarget = { calibration: null, recipe: createDefaultRecipe(
    { guid: meta.guid, path: asset, contentHash: meta.sourceHash }, { guid: meta.guid, path: asset, contentHash: meta.sourceHash }) };
  await put(`${asset}.meta.json`, meta);
  await put('assets/_data/asset-manifest.json', { characters: [{ id: 'E-PROBE', lods: [{ label: '+动画', file: 'models/model.glb' }, { label: 'same rooted', file: asset }], views: {} }], environments: [] });
  const result = await rename(asset, 'renamed.glb'); assert.equal(result.status, 200, JSON.stringify(result));
  const renamed = 'assets/models/renamed.glb'; await present(renamed); await absent(asset);
  const saved = await get(project.scenes[0].path);
  assert.deepEqual(validateSceneDocument(saved).filter((d) => d.severity === 'error'), []);
  for (const id of ['nd_f1r0_cv0', 'nd_rename_noguid']) assert.equal(saved.nodes.find((n) => n.id === id).components.find((c) => c.kind === 'MeshRenderer').source.ref.path, renamed);
  assert.equal(saved.nodes.find((n) => n.id === 'nd_f1r0_cv0').components[0].source.ref.guid, 'as_probe');
  assert.deepEqual(saved.userData, scene.userData); assert.equal((await get(`${renamed}.meta.json`)).guid, 'as_probe');
  const afterMeta = await get(`${renamed}.meta.json`);
  assert.deepEqual(validateRetargetAssetBlock(afterMeta.retarget).filter((d) => d.severity === 'error'), []);
  assert.equal(afterMeta.retarget.recipe.source.path, renamed); assert.equal(afterMeta.retarget.recipe.target.path, renamed);
  assert.equal(afterMeta.retarget.recipe.source.guid, meta.guid); assert.equal(afterMeta.retarget.recipe.source.contentHash, meta.sourceHash);
  assert.equal(afterMeta.retarget.calibration, meta.retarget.calibration);
  assert.notEqual(retargetFingerprint(afterMeta.retarget.recipe), retargetFingerprint(meta.retarget.recipe));
  assert.match(result.body.diagnostics.join('\n'), /原结果已过期/);
  console.log('PASS typed retarget source/target resolve after rename; guid/content hash/calibration retained, schema valid, changed recipe fingerprint and explicit stale diagnostic');
  const manifest = await get('assets/_data/asset-manifest.json'); assert.equal(manifest.characters[0].lods[0].file, 'models/renamed.glb'); assert.equal(manifest.characters[0].lods[1].file, renamed);
  assert.deepEqual(await readFile(path.join(root, renamed)), await readFile(source));
  console.log('PASS real GLB rename: source+sidecar, stable guid/absent guid, scene consumer paths, manifest relative/rooted LOD, unknown annotation retained');

  assert.equal((await rename('assets/models', 'moved')).status, 200);
  const moved = 'assets/moved/renamed.glb'; await present(moved);
  assert.equal((await get(project.scenes[0].path)).nodes.find((n) => n.id === 'nd_f1r0_cv0').components[0].source.ref.path, moved);
  const beforeConflict = await readFile(path.join(root, project.scenes[0].path));
  await put('assets/moved/existing.glb', 'occupied');
  assert.equal((await rename(moved, 'existing.glb')).status, 409); await present(moved);
  assert.deepEqual(await readFile(path.join(root, project.scenes[0].path)), beforeConflict);
  console.log('PASS directory prefix rewrite and occupied target rejection leave valid source and references');

  const unsupported = await get(project.scenes[0].path);
  unsupported.nodes[0].components.push({ kind: 'Script', enabled: true, behavior: 'untyped', params: { asset: moved } });
  await put(project.scenes[0].path, unsupported);
  const refused = await rename(moved, 'refused.glb'); assert.equal(refused.status, 400); assert.match(refused.body.error, /Script.params.asset/);
  await present(moved); await absent('assets/moved/refused.glb');
  unsupported.nodes[0].components.pop(); await put(project.scenes[0].path, unsupported);
  assert.equal((await rename('assets/_data/asset-manifest.json', 'other.json')).status, 400);
  console.log('PASS untyped Script asset parameter and fixed manifest location reject before moving');

  // Force a real mid-transaction I/O error: atomic sidecar temp exceeds the filesystem's
  // per-entry name limit although the requested source name is legal (<=200 characters).
  const texture = 'assets/moved/self.png'; await put(texture, 'pixels');
  const textureMeta = structuredClone(meta); textureMeta.kind = 'texture'; textureMeta.guid = 'as_texture';
  textureMeta.bindings = [{ nodeId: 'probe', nodePath: [], prims: [{ primitiveKey: 'p', primitiveIndex: 0, visible: true,
    material: { type: 'override', base: { type: 'shared', id: 's' }, patch: { texture: { path: texture } } } }] }];
  await put(`${texture}.meta.json`, textureMeta);
  const withTexture = await get(project.scenes[0].path); withTexture.nodes.find((n) => n.id === 'nd_f1r0_cv0').components[0].materials = [{ match: { by: 'index', value: 0 }, material: { type: 'override', base: { type: 'shared', id: 's' }, patch: { texture: { path: texture } } } }];
  await put(project.scenes[0].path, withTexture); const before = await readFile(path.join(root, project.scenes[0].path));
  const longName = 't'.repeat(196) + '.png';
  const failed = await rename(texture, longName); assert.equal(failed.status, 500, JSON.stringify(failed));
  assert.deepEqual(failed.body.rollbackErrors, []); await present(texture); await present(`${texture}.meta.json`); await absent(`assets/moved/${longName}`);
  assert.deepEqual(await readFile(path.join(root, project.scenes[0].path)), before); assert.deepEqual(await get(`${texture}.meta.json`), textureMeta);
  assert.equal((await get(path.relative(root, path.join(failed.body.recoveryPath, 'transaction.json')))).state, 'rolled-back');
  console.log('PASS real mid-transaction filename I/O failure restores already-written scene bytes, moved asset and sidecar; journal says rolled-back');

  const baseline = await get(project.scenes[0].path); const edited = structuredClone(baseline);
  const spawn = edited.nodes.flatMap((n) => n.components).find((c) => c.kind === 'SpawnPoint'); spawn.count = 9;
  let enter; let release; const entered = new Promise((r) => { enter = r; }); const gate = new Promise((r) => { release = r; });
  const held = withProjectWriteLock(root, async () => { enter(); await gate; }); await entered;
  const pendingRename = rename(moved, 'concurrent.glb');
  const pendingWrite = request('write', { path: project.scenes[0].path, content: JSON.stringify(edited), baseHash: sceneFingerprint(baseline) });
  await new Promise((r) => setTimeout(r, 100)); release(); await held;
  const [rr, wr] = await Promise.all([pendingRename, pendingWrite]); assert.equal(rr.status, 200);
  assert.ok([200, 409].includes(wr.status));
  const final = await get(project.scenes[0].path); assert.equal(final.nodes.find((n) => n.id === 'nd_f1r0_cv0').components[0].source.ref.path, 'assets/moved/concurrent.glb');
  assert.deepEqual(validateSceneDocument(final).filter((d) => d.severity === 'error'), []);
  assert.equal(final.nodes.flatMap((n) => n.components).find((c) => c.kind === 'SpawnPoint').count, wr.status === 200 ? 9 : baseline.nodes.flatMap((n) => n.components).find((c) => c.kind === 'SpawnPoint').count);
  const stale = await request('write', { path: project.scenes[0].path, content: JSON.stringify(edited), baseHash: sceneFingerprint(baseline) }); assert.equal(stale.status, 409);
  console.log(`PASS rename/write share project lock: rename 200, concurrent write ${wr.status}; no lost field or stale path; old baseline always 409`);
} finally { await rm(root, { recursive: true, force: true }); }
