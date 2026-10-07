/** Import animation-only FBX into shared, target-independent BVH sources.
 * Rest rotations are removed by a change of basis, not by zeroing animation keys.
 * Every sampled joint position is checked against FBX FK before publishing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AnimationMixer, Euler, Quaternion, Vector3, LoopOnce } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
const domainPath = resolve(root, '.workbuddy/tmp/shared-motion/domain.mjs');
await build({ entryPoints: [resolve(root, 'tools/motion/domain-entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: domainPath, tsconfig: resolve(root, 'tsconfig.check.json') });
const { parseBvh, buildSourceMotion } = await import(new URL(`file:///${domainPath.replaceAll('\\', '/')}`));
const template = JSON.parse(readFileSync(resolve(root, 'assets/characters/_tools/humanik_skeleton.json'), 'utf8'));
const names = template.boneOrder.filter(n => !n.endsWith('Tip'));
const files = ['player_walking', 'player_running', 'player_jump_up', 'player_shoot_rifle', 'player_punching',
  'zombie_idle', 'zombie_walk', 'zombie_attack', 'zombie_death', 'zombie_scream'];
const outDir = resolve(root, 'assets/animations/mixamo');
mkdirSync(outDir, { recursive: true });
const report = [];
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function writeMeta(path, defaults) {
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const merged = { ...defaults, ...previous, sourceHash: defaults.sourceHash,
    userData: { ...previous.userData, ...defaults.userData } };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
}

for (const id of files) {
  const bytes = readFileSync(resolve(root, `assets-src/mixamo/animations/${id}.fbx`));
  const scene = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
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
  if (['player_walking', 'player_running', 'zombie_walk'].includes(id)) {
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
  writeFileSync(resolve(root, path), text);
  const meta = { schemaVersion: 1, guid: `as_motion_${id}`, kind: 'bvh', importer: {
    normalizeHeightM: null, weldTolerance: .0001, upAxisFlip: false, aoBakeFloor: null, splitSubMeshes: true, maxSubMeshes: 8 },
    bindings: [], rig: null, animations: null, userData: { source: 'Mixamo', sourceFbxHash: hash(bytes), importer: 'fbx-world-rest-basis-v1' }, sourceHash: hash(text) };
  writeMeta(resolve(root, `${path}.meta.json`), meta);
  const start = rootSamples[0], end = rootSamples.at(-1);
  report.push({ id, path, frames, fps, duration: clip.duration, maxFkErrorM: errorM, maxSerializedFkErrorM: roundtripErrorM,
    ...(nominalSpeedMps ? { nominalSpeedMps } : {}),
    rootEndpointDisplacementM: Math.hypot(end[0] - start[0], end[2] - start[2]), sourceFbxHash: hash(bytes) });
}
mkdirSync(resolve(root, '.workbuddy/tmp/shared-motion'), { recursive: true });
writeFileSync(resolve(root, '.workbuddy/tmp/shared-motion/import-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const clips = Object.fromEntries(files.map(id => [id, {
  source: { path: `assets/animations/mixamo/${id}.bvh`, guid: `as_motion_${id}` },
  loop: ['player_walking', 'player_running', 'zombie_idle', 'zombie_walk'].includes(id), rootPolicy: 'in-place',
  ...(report.find(r => r.id === id).nominalSpeedMps ? { nominalSpeedMps: report.find(r => r.id === id).nominalSpeedMps } : {}),
}]));
clips.player_ready = { ...clips.player_shoot_rifle, loop: true, poseAtS: 0 };
const library = { schemaVersion: 1, id: 'as_mixamo_shared_motion', clips, profiles: {
  player: { idle: 'player_ready', walk: 'player_walking', run: 'player_running', jump: 'player_jump_up', shoot: 'player_shoot_rifle', attack: 'player_punching' },
  npc: { idle: 'zombie_idle', walk: 'zombie_walk', attack: 'zombie_attack', death: 'zombie_death', scream: 'zombie_scream' },
} };
const libPath = resolve(outDir, 'shared.motion.json'), libText = `${JSON.stringify(library, null, 2)}\n`;
writeFileSync(libPath, libText);
writeMeta(`${libPath}.meta.json`, { schemaVersion: 1, guid: library.id, kind: 'motion-library',
  importer: { normalizeHeightM: null, weldTolerance: .0001, upAxisFlip: false, aoBakeFloor: null, splitSubMeshes: true, maxSubMeshes: 8 },
  bindings: [], rig: null, animations: null, userData: { source: 'Mixamo', importer: 'fbx-world-rest-basis-v1' }, sourceHash: hash(libText) });
