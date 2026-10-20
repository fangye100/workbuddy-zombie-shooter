import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyChunkGeometry, chunkPrims, skeletonPalette, verifyActorSkin } from './verify-fracture-assets.mjs';
import { readGlb, readAccessor } from './glb-io.mjs';

test('negative: flipped cap triangle must fail directed closure', () => {
  const doc = readGlb('assets/fracture/e04-bulwark/head.glb');
  const prims = chunkPrims(doc, 'head');
  const failures = [];
  verifyChunkGeometry(prims, 'neg-flip', failures);
  assert.equal(failures.length, 0);
  const mutated = prims.map(p => ({ ...p, indices: p.indices }));
  const caps = mutated[1];
  const tmp = caps.indices[1];
  caps.indices[1] = caps.indices[2];
  caps.indices[2] = tmp;
  const failures2 = [];
  verifyChunkGeometry(mutated, 'neg-flip', failures2);
  assert.ok(failures2.length > 0, 'flipped cap must fail');
});

test('negative: zeroed inverse bind matrices must break bind-pose skinning', async () => {
  const source = readGlb('assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb');
  const doc = readGlb('assets/fracture/e04-bulwark/head.glb');
  const corrupted = { json: JSON.parse(JSON.stringify(doc.json)), bin: Buffer.from(doc.bin) };
  const skin = corrupted.json.skins[0];
  if (skin.inverseBindMatrices !== undefined) {
    const acc = corrupted.json.accessors[skin.inverseBindMatrices];
    const view = corrupted.json.bufferViews[acc.bufferView];
    corrupted.bin.fill(0, view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  }
  const failures = [], notes = [];
  verifyActorSkin(source, { head: corrupted }, failures, notes);
  assert.ok(failures.length > 0, 'zeroed IBM must fail');
});

test('negative: perturbed residual cap joint binding must break boundary continuity', () => {
  const source = readGlb('assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb');
  const doc = readGlb('assets/fracture/e04-bulwark/torso.glb');

  // Locate a cap boundary vertex (cap-only index, position shared with outer).
  const prims = chunkPrims(doc, 'torso');
  const capPrim = prims[1], outerPrim = prims[0];
  const posKey = idx => [capPrim.positions[idx*3], capPrim.positions[idx*3+1], capPrim.positions[idx*3+2]]
    .map(x => Math.round(x * 1e6)).join(',');
  const outerUsed = new Set(Array.from(outerPrim.indices));
  const outerKeys = new Set(Array.from(outerPrim.indices, posKey));
  let target = -1;
  for (const v of new Set(Array.from(capPrim.indices))) {
    if (!outerUsed.has(v) && outerKeys.has(posKey(v))) { target = v; break; }
  }
  assert.ok(target >= 0, 'found cap boundary copy');

  // Build a corrupted doc with one cap vertex's joint changed: swap joint[0]↔joint[1].
  const corrupted = { json: JSON.parse(JSON.stringify(doc.json)), bin: Buffer.from(doc.bin) };
  // Override the JOINTS_0 accessor read via a wrapper: we'll write modified bytes into a COPY of the bin.
  const capP = corrupted.json.meshes[0].primitives[1];
  const jAccIdx = capP.attributes.JOINTS_0;
  const jAcc = corrupted.json.accessors[jAccIdx];
  const jView = corrupted.json.bufferViews[jAcc.bufferView];
  const jBase = (jView.byteOffset ?? 0) + (jAcc.byteOffset ?? 0);
  const jStride = jView.byteStride || 8;
  const j0 = corrupted.bin.readUInt16LE(jBase + target * jStride);
  const j1 = corrupted.bin.readUInt16LE(jBase + target * jStride + 2);
  corrupted.bin.writeUInt16LE(j1, jBase + target * jStride);
  corrupted.bin.writeUInt16LE(j0, jBase + target * jStride + 2);
  // Also zero ALL weights for this vertex (WEIGHTS_0 = VEC4 float = 16 bytes).
  const wAccIdx = capP.attributes.WEIGHTS_0;
  const wAcc = corrupted.json.accessors[wAccIdx];
  const wView = corrupted.json.bufferViews[wAcc.bufferView];
  const wBase = (wView.byteOffset ?? 0) + (wAcc.byteOffset ?? 0);
  const wStride = wView.byteStride || 16;
  for (let c = 0; c < 4; c++) corrupted.bin.writeFloatLE(0, wBase + target * wStride + c * 4);

  // Use ALL chunks so the coverage ratio matches the production verifier context.
  const allChunks = {};
  for (const name of ['head','torso','arm-l-upper','arm-l-forearm','arm-r-upper','arm-r-forearm','leg-l-thigh','leg-l-shin','leg-r-thigh','leg-r-shin']) {
    allChunks[name] = name === 'torso' ? corrupted : readGlb('assets/fracture/e04-bulwark/' + name + '.glb');
  }
  const failures = [], notes = [];
  verifyActorSkin(source, allChunks, failures, notes);
  const failStrings = failures.filter(f => typeof f === 'string');
  assert.ok(
    failStrings.includes('cap boundary continuity (bind+anim gap)'),
    'must trigger cap boundary continuity specifically, got: ' + JSON.stringify(failStrings),
  );
});
