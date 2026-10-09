/** Extract animation from FBX into shared, target-independent BVH sources.
 * Rest rotations are removed by a change of basis, not by zeroing animation keys.
 * Every sampled joint position is checked against FBX FK before publishing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { AnimationMixer, Euler, Quaternion, Vector3, LoopOnce } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
const domainPath = resolve(root, '.workbuddy/tmp/shared-motion/domain.mjs');
await build({ entryPoints: [resolve(root, 'tools/motion/domain-entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: domainPath, tsconfig: resolve(root, 'tsconfig.check.json') });
const { parseBvh, buildSourceMotion } = await import(pathToFileURL(domainPath));
const template = JSON.parse(readFileSync(resolve(root, 'assets/characters/_tools/humanik_skeleton.json'), 'utf8'));
const names = template.boneOrder.filter(n => !n.endsWith('Tip'));
const baselineFiles = ['player_walking', 'player_running', 'player_jump_up', 'player_shoot_rifle', 'player_punching',
  'zombie_idle', 'zombie_walk', 'zombie_attack', 'zombie_death', 'zombie_scream'];
const args = process.argv.slice(2);
if (args[0] === '--') args.shift(); // pnpm run forwards the explicit argument separator.
if (args.length && (args.length !== 2 || args[0] !== '--batch')) throw new Error('Usage: import-mixamo.mjs [--batch <delivery batch.json>]');
const batch = args.length ? JSON.parse(readFileSync(resolve(root, args[1]), 'utf8')) : null;
if (args.length && (!batch || typeof batch !== 'object' || Array.isArray(batch))) throw new Error('Invalid animation batch document');
if (batch && (typeof batch.id !== 'string' || !/^ANI-\d{8}$/.test(batch.id))) throw new Error('Invalid animation batch id');
if (batch && (!Array.isArray(batch.items) || !batch.items.length)) throw new Error('Empty animation delivery batch');
const batchItems = batch?.items.filter(item => !item.dupeOfLocal) ?? [];
if (batch && !batchItems.length) throw new Error('Animation batch has no new sources');
const files = batch ? batchItems.map(item => {
  if (typeof item.file !== 'string' || !/^ani_[a-z0-9_]+\.fbx$/.test(item.file)) throw new Error('Invalid batch source filename');
  return item.file.slice(0, -4);
}) : baselineFiles;
if (new Set(files).size !== files.length) throw new Error('Duplicate source filenames in batch');
// FBX files can contain meshes despite a bone-only delivery claim. Texture loading
// is suppressed in this offline extractor; only the validated skeletal tracks are published.
const fakeElement = () => ({ style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {} });
globalThis.document ??= { createElementNS: fakeElement };
globalThis.window ??= { URL: { createObjectURL: () => '', revokeObjectURL() {} } };
globalThis.self ??= globalThis;
const outDir = resolve(root, 'assets/animations/mixamo');
mkdirSync(outDir, { recursive: true });
const report = [];
const pendingWrites = [];
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
if (batch) {
  // Validate every handoff identity before changing any derived asset.
  for (const item of batchItems) {
    if (!/^ANI-[A-Z0-9-]+$/.test(item.req)) throw new Error('Invalid requirement id');
    const delivery = JSON.parse(readFileSync(resolve(root, args[1], '..', item.req, 'delivery.json'), 'utf8'));
    if (delivery.id !== item.req) throw new Error(`${item.req}: handoff identity mismatch`);
    const bytes = readFileSync(resolve(root, 'assets-src/mixamo/animations', item.file));
    const variant = delivery.variants?.find(v => `sha256:${v.sha256}` === hash(bytes));
    if (!variant || variant.bytes !== bytes.length) throw new Error(`${item.file}: handoff hash/size mismatch`);
  }
}
function writeMeta(path, defaults) {
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const merged = { ...defaults, ...previous, sourceHash: defaults.sourceHash,
    userData: { ...previous.userData, ...defaults.userData } };
  pendingWrites.push({ path, text: `${JSON.stringify(merged, null, 2)}\n` });
  return merged;
}

for (const id of files) {
  const bytes = readFileSync(resolve(root, `assets-src/mixamo/animations/${id}.fbx`));
  const scene = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  let sourceMeshes = 0, sourceSkinnedMeshes = 0, sourceBoneCount = 0;
  scene.traverse(n => { if (n.isMesh) sourceMeshes++; if (n.isSkinnedMesh) sourceSkinnedMeshes++; if (n.isBone) sourceBoneCount++; });
  const bones = new Map();
  scene.traverse(n => { if (n.isBone) bones.set(n.name.replace(/^mixamorig:?/, ''), n); });
  for (const name of names) if (!bones.has(name)) throw new Error(`${id}: missing ${name}`);
  scene.updateMatrixWorld(true);
  const rest = new Map();
  for (const name of names) {
    const b = bones.get(name);
    rest.set(name, { p: b.getWorldPosition(new Vector3()).multiplyScalar(.01), q: b.getWorldQuaternion(new Quaternion()) });
  }
  const parents = new Map(names.map(n => [n, names.find(p => bones.get(n).parent === bones.get(p)) ?? null]));
  for (const n of names) if (n !== 'Hips' && parents.get(n) === null) throw new Error(`${id}: unsupported parent ${n}`);
  const children = n => names.filter(k => parents.get(k) === n);
  const order = [];
  const lines = ['HIERARCHY'];
  function hierarchy(n, depth) {
    const pad = '  '.repeat(depth), p = parents.get(n);
    order.push(n);
    const offset = rest.get(n).p.clone().sub(p ? rest.get(p).p : new Vector3());
    lines.push(`${pad}${p ? 'JOINT' : 'ROOT'} ${n}`, `${pad}{`, `${pad}  OFFSET ${offset.toArray().join(' ')}`,
      `${pad}  CHANNELS ${p ? '3 Xrotation Yrotation Zrotation' : '6 Xposition Yposition Zposition Xrotation Yrotation Zrotation'}`);
    const kids = children(n);
    for (const c of kids) hierarchy(c, depth + 1);
    if (!kids.length) {
      const b = bones.get(n), child = b.children.find(c => c.isBone);
      const end = child ? child.getWorldPosition(new Vector3()).multiplyScalar(.01).sub(rest.get(n).p)
        : new Vector3(0, .08, 0).applyQuaternion(rest.get(n).q);
      lines.push(`${pad}  End Site`, `${pad}  {`, `${pad}    OFFSET ${end.toArray().join(' ')}`, `${pad}  }`);
    }
    lines.push(`${pad}}`);
  }
  hierarchy('Hips', 0);
  if (scene.animations.length !== 1) throw new Error(`${id}: expected one clip`);
  const clip = scene.animations[0], fps = 30;
  const frames = Math.round(clip.duration * fps) + 1;
  const mixer = new AnimationMixer(scene);
  const action = mixer.clipAction(clip).setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
  lines.push('MOTION', `Frames: ${frames}`, `Frame Time: ${1 / fps}`);
  let errorM = 0;
  const rootSamples = [];
  const expectedWorld = [];
  for (let f = 0; f < frames; f++) {
    mixer.setTime(Math.min(f / fps, clip.duration)); scene.updateMatrixWorld(true);
    const deltas = new Map(), reconstructed = new Map(), values = [];
    const expected = {};
    for (const n of order) {
      const b = bones.get(n), parent = parents.get(n), r = rest.get(n);
      const world = b.getWorldQuaternion(new Quaternion()).multiply(r.q.clone().invert());
      deltas.set(n, world);
      const local = parent ? deltas.get(parent).clone().invert().multiply(world) : world;
      const actual = b.getWorldPosition(new Vector3()).multiplyScalar(.01);
      expected[n] = actual.toArray();
      const position = parent ? r.p.clone().sub(rest.get(parent).p).applyQuaternion(deltas.get(parent)).add(reconstructed.get(parent)) : actual;
      reconstructed.set(n, position);
      errorM = Math.max(errorM, position.distanceTo(actual));
      // The project's BVH reader follows absolute root position-channel semantics.
      if (!parent) { values.push(...actual.toArray()); rootSamples.push(actual.toArray()); }
      const e = new Euler().setFromQuaternion(local, 'XYZ');
      values.push(e.x * 180 / Math.PI, e.y * 180 / Math.PI, e.z * 180 / Math.PI);
    }
    lines.push(values.map(v => Number(v.toFixed(8))).join(' '));
    expectedWorld.push(expected);
  }
  mixer.uncacheRoot(scene);
  if (errorM > .002) throw new Error(`${id}: unrepresentable animated translations; FK error ${errorM} m`);
  const text = `${lines.join('\n')}\n`, path = `assets/animations/mixamo/${id}.bvh`;
  // Read the serialized Euler channels through the project's actual runtime parser.
  const source = buildSourceMotion(parseBvh(text), { unitScale: 1, forceUpAxis: 1 });
  let roundtripErrorM = 0;
  for (let f = 0; f < frames; f++) for (const n of names) {
    const p = source.worldPositions[n], e = expectedWorld[f][n];
    roundtripErrorM = Math.max(roundtripErrorM, Math.hypot(p[f * 3] - e[0], p[f * 3 + 1] - e[1], p[f * 3 + 2] - e[2]));
  }
  if (roundtripErrorM > .002) throw new Error(`${id}: serialized BVH FK error ${roundtripErrorM} m`);
  const stanceSpeeds = [];
  if (['player_walking', 'player_running', 'zombie_walk'].includes(id) || id.startsWith('ani_p_strafe_')) {
    for (const name of ['LeftFoot', 'RightFoot']) {
      const p = source.worldPositions[name];
      const minY = Math.min(...Array.from(p).filter((_, i) => i % 3 === 1));
      for (let f = 1; f < frames; f++) if (p[f * 3 + 1] < minY + .03 && p[(f - 1) * 3 + 1] < minY + .03) {
        const speed = Math.hypot(p[f * 3] - p[(f - 1) * 3], p[f * 3 + 2] - p[(f - 1) * 3 + 2]) * fps;
        if (speed > .05) stanceSpeeds.push(speed);
      }
    }
    stanceSpeeds.sort((a, b) => a - b);
  }
  const nominalSpeedMps = stanceSpeeds.length ? stanceSpeeds[Math.floor(stanceSpeeds.length / 2)] : undefined;
  pendingWrites.push({ path: resolve(root, path), text });
  const meta = { schemaVersion: 1, guid: `as_motion_${id}`, kind: 'bvh', importer: {
    normalizeHeightM: null, weldTolerance: .0001, upAxisFlip: false, aoBakeFloor: null, splitSubMeshes: true, maxSubMeshes: 8 },
    bindings: [], rig: null, animations: null, userData: { source: 'Mixamo', sourceFbxHash: hash(bytes), importer: 'fbx-world-rest-basis-v1',
      ...(batch ? { requirementId: batchItems.find(item => item.file === `${id}.fbx`).req, batchId: batch.id,
        acceptance: 'candidate-not-visual-accepted', sourceBoneCount, strippedSourceMeshes: sourceMeshes } : {}) }, sourceHash: hash(text) };
  const publishedMeta = writeMeta(resolve(root, `${path}.meta.json`), meta);
  const start = rootSamples[0], end = rootSamples.at(-1);
  report.push({ id, path, frames, fps, duration: clip.duration, maxFkErrorM: errorM, maxSerializedFkErrorM: roundtripErrorM,
    ...(nominalSpeedMps ? { nominalSpeedMps } : {}),
    rootEndpointDisplacementM: Math.hypot(end[0] - start[0], end[2] - start[2]), sourceFbxHash: hash(bytes), guid: publishedMeta.guid,
    ...(batch ? { sourceBoneCount, sourceMeshes, sourceSkinnedMeshes, publishedJoints: order.length } : {}) });
}
mkdirSync(resolve(root, '.workbuddy/tmp/shared-motion'), { recursive: true });
writeFileSync(resolve(root, `.workbuddy/tmp/shared-motion/${batch ? 'batch-import-report' : 'import-report'}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const clips = Object.fromEntries(files.map(id => [id, {
  source: { path: `assets/animations/mixamo/${id}.bvh`, guid: report.find(r => r.id === id).guid },
  // New deliveries are candidates. Loop seams and gameplay timing need acceptance
  // before any candidate replaces a production profile.
  loop: !batch && ['player_walking', 'player_running', 'zombie_idle', 'zombie_walk'].includes(id), rootPolicy: 'in-place',
  ...(report.find(r => r.id === id).nominalSpeedMps ? { nominalSpeedMps: report.find(r => r.id === id).nominalSpeedMps } : {}),
}]));
if (!batch) clips.player_ready = { ...clips.player_shoot_rifle, loop: true, poseAtS: 0 };
const defaults = { schemaVersion: 1, id: 'as_mixamo_shared_motion', clips, profiles: {
  player: { idle: 'player_ready', walk: 'player_walking', run: 'player_running', jump: 'player_jump_up', shoot: 'player_shoot_rifle', attack: 'player_punching' },
  npc: { idle: 'zombie_idle', walk: 'zombie_walk', attack: 'zombie_attack', death: 'zombie_death', scream: 'zombie_scream' },
} };
const libPath = resolve(outDir, 'shared.motion.json');
const previousLibrary = existsSync(libPath) ? JSON.parse(readFileSync(libPath, 'utf8')) : null;
if (batch && !previousLibrary) throw new Error('Batch intake requires an existing shared library');
const library = previousLibrary ? { ...previousLibrary, clips: { ...previousLibrary.clips, ...clips },
  profiles: batch ? previousLibrary.profiles : { ...defaults.profiles, ...previousLibrary.profiles } } : defaults;
if (batch) {
  // A dedicated preview profile exposes every candidate through the existing
  // manual animation panel without changing production player/NPC choices.
  library.profiles[`${batch.id.toLowerCase()}-preview`] = Object.fromEntries(files.map(id => [id, id]));
}
const libText = `${JSON.stringify(library, null, 2)}\n`;
pendingWrites.push({ path: libPath, text: libText });
writeMeta(`${libPath}.meta.json`, { schemaVersion: 1, guid: library.id, kind: 'motion-library',
  importer: { normalizeHeightM: null, weldTolerance: .0001, upAxisFlip: false, aoBakeFloor: null, splitSubMeshes: true, maxSubMeshes: 8 },
  bindings: [], rig: null, animations: null, userData: { source: 'Mixamo', importer: 'fbx-world-rest-basis-v1' }, sourceHash: hash(libText) });
// Parsing/FK/handoff failures publish no partial batch. A filesystem write failure
// is still explicit; rerunning the same batch repairs its deterministic outputs.
for (const output of pendingWrites) writeFileSync(output.path, output.text);
