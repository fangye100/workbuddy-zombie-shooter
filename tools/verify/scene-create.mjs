import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createProjectScene } from '../fs/create-scene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tempBase = path.join(repo, '.workbuddy/tmp');
await fs.mkdir(tempBase, { recursive: true });
const root = await fs.mkdtemp(path.join(tempBase, 'scene-create-'));
const bundle = path.join(root, 'scene.mjs');
try {
  await build({ entryPoints: [path.join(repo, 'packages/scene/src/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, tsconfig: path.join(repo, 'tsconfig.check.json'), logLevel: 'silent' });
  const { createEmptySceneDocument, validateProject, validateSceneDocument } = await import(pathToFileURL(bundle).href);
  const project = JSON.parse(await fs.readFile(path.join(repo, 'aether.project.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'aether.project.json'), JSON.stringify(project));
  const scene = createEmptySceneDocument('Test scene');
  assert.deepEqual(validateSceneDocument(scene).filter(d => d.severity === 'error'), []);
  const rel = 'assets/scenes/custom/new-scene.scene.json';
  await createProjectScene(root, rel, scene, validateProject);
  const written = JSON.parse(await fs.readFile(path.join(root, rel), 'utf8'));
  assert.equal(written.id, scene.id);
  const registered = JSON.parse(await fs.readFile(path.join(root, 'aether.project.json'), 'utf8'));
  assert.equal(registered.scenes.at(-1).id, scene.id);
  assert.equal(registered.startIndex, project.startIndex);
  await assert.rejects(createProjectScene(root, rel, createEmptySceneDocument('Overwrite'), validateProject));
  await assert.rejects(createProjectScene(root, 'assets/scenes/../../escape.scene.json', scene, validateProject));
  const raced = createEmptySceneDocument('Concurrent');
  const results = await Promise.allSettled(['a', 'b'].map(n => createProjectScene(root, `assets/scenes/${n}.scene.json`, raced, validateProject)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const latest = JSON.parse(await fs.readFile(path.join(root, 'aether.project.json'), 'utf8'));
  assert.equal(latest.scenes.filter(s => s.id === raced.id).length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, rel), 'utf8')).name, 'Test scene');
  console.log('PASS: scene create, registration, no overwrite, traversal rejection, concurrent identity conflict');
} finally {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith('scene-create-')) throw new Error('Unsafe cleanup target');
  await fs.rm(resolved, { recursive: true, force: true });
}
