/** Real assets, runtime solver, render sampling and heterogeneous NPC palette gate.
 * Does not require ignored original FBXs or a browser/GPU; headed acceptance is separate.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, '.workbuddy/tmp/shared-motion'); mkdirSync(out, { recursive: true });
await build({ entryPoints: [resolve(root, 'tools/motion/domain-entry.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: resolve(out, 'domain.mjs'), tsconfig: resolve(root, 'tsconfig.check.json') });
const { SharedMotionRuntime, parseGlb, createSkinState, evalJointMatrices, ActorLibrary } = await import(pathToFileURL(resolve(out, 'domain.mjs')));
const json = p => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const bytes = p => { const b = readFileSync(resolve(root, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const motions = new SharedMotionRuntime(async p => readFileSync(resolve(root, p), 'utf8'));
const library = json('assets/animations/mixamo/shared.motion.json');
const sources = [...new Set(Object.values(library.clips).map(c => c.source.path))];
for (const p of ['assets/animations/mixamo/shared.motion.json', ...sources]) {
  const actual = `sha256:${createHash('sha256').update(readFileSync(resolve(root, p))).digest('hex')}`;
  if (json(`${p}.meta.json`).sourceHash !== actual) throw new Error(`Stale source metadata: ${p}`);
}
const validationPaths = ['assets/scenes/sandbox/shared-motion-runtime.scene.json',
  'assets/scenes/sandbox/ani-20261008-intake.scene.json'].filter(p => existsSync(resolve(root, p)));
const checks = [];
for (const scenePath of validationPaths) for (const n of json(scenePath).nodes) {
  const mesh = n.components.find(c => c.kind === 'MeshRenderer' && c.sharedMotion);
  if (!mesh) continue;
  const sk = parseGlb(bytes(mesh.source.ref.path)).skeleton;
  if (!sk) throw new Error(`${n.id}: missing skeleton`);
  const locals = JSON.stringify(sk.locals);
  const result = await motions.resolve(sk, mesh.sharedMotion, json(`${mesh.source.ref.path}.meta.json`));
  const state = createSkinState(sk, result.clips);
  const data = new Float32Array((sk.joints.length + 1) * 16);
  for (let i = 0; i < result.clips.length; i++) {
    state.clip = i;
    const clip = result.clips[i];
    for (let f = 0; f <= Math.ceil(clip.duration * 30); f++) {
      state.time = Math.min(clip.duration, f / 30); evalJointMatrices(state, data);
      if (!data.every(Number.isFinite)) throw new Error(`${n.id}/${clip.name}: non-finite skin matrix`);
    }
    for (const t of clip.tracks) if (t.path === 'translation' && sk.jointNames[sk.joints.indexOf(t.node)] !== 'Hips') {
      throw new Error(`${n.id}/${clip.name}: limb rest offsets were replaced`);
    }
  }
  if (JSON.stringify(sk.locals) !== locals) throw new Error(`${n.id}: mutated target rest pose`);
  checks.push({ scene: scenePath, node: n.id, joints: sk.joints.length, key: result.key, states: result.clips.map(c => c.name),
    warnings: [...new Set(result.reports.flatMap(r => r.diagnostics.filter(d => d.severity !== 'info').map(d => d.code)))] });
}
if (checks.find(c => c.node === 'nd_motion_h01').key !== checks.find(c => c.node === 'nd_motion_player').key) throw new Error('Identical target did not share cache');
const actorLib = new ActorLibrary(json('assets/_data/asset-manifest.json'), async p => bytes(p)); actorLib.setSharedMotions(motions);
// This CPU gate does not decode textures. Headed acceptance verifies actual albedo/GPU upload.
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
const ids = json('assets/_data/asset-manifest.json').characters.map(c => c.id);
for (const id of ids) if (!await actorLib.preload(id)) throw new Error(`NPC assembly failed: ${id}: ${actorLib.diagnostics.join('; ')}`);
const actors = ids.map(id => actorLib.get(id));
const palette = actorLib.buildPalette();
if (!palette.every(Number.isFinite)) throw new Error('Non-finite NPC palette');
for (const a of actors) {
  const begin = a.paletteBase * 16;
  if (!a.motion || !palette.slice(begin, begin + a.palette.data.length).every((v, i) => v === a.palette.data[i])) throw new Error(`${a.characterId}: palette offset mismatch`);
}
const report = { sources: sources.length, nodes: checks, actors: actors.map(a => ({ id: a.characterId, stride: a.palette.jointCount,
  matrixBase: a.paletteBase, states: a.clips.map(c => c.name) })), stats: motions.stats };
writeFileSync(resolve(out, 'check-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Shared motion PASS: ${sources.length} sources; ${checks.length} scene targets; NPC strides ${actors.map(a => a.palette.jointCount).join('/')}; ${motions.stats.solves} solves, ${motions.stats.cacheHits} cache hits.`);
