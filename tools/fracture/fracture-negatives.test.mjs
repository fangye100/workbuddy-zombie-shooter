import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyChunkGeometry, chunkPrims, skeletonPalette } from './verify-fracture-assets.mjs';
import { readGlb } from './glb-io.mjs';

test('negative: flipped cap triangle must fail directed closure', () => {
  const doc = readGlb('assets/fracture/e04-bulwark/head.glb');
  const prims = chunkPrims(doc, 'head');
  const failures = [];
  verifyChunkGeometry(prims, 'neg-flip', failures);
  assert.equal(failures.length, 0);
  // Flip one cap triangle's winding in prim 1.
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
  const { verifyActorSkin } = await import('./verify-fracture-assets.mjs');
  const source = readGlb('assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb');
  const doc = readGlb('assets/fracture/e04-bulwark/head.glb');
  const corrupted = { json: JSON.parse(JSON.stringify(doc.json)), bin: doc.bin };
  const skin = corrupted.json.skins[0];
  if (skin.inverseBindMatrices !== undefined) {
    // Zero the IBM accessor bytes.
    const acc = corrupted.json.accessors[skin.inverseBindMatrices];
    const view = corrupted.json.bufferViews[acc.bufferView];
    corrupted.bin = Buffer.from(corrupted.bin);
    corrupted.bin.fill(0, view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  }
  const failures = [], notes = [];
  verifyActorSkin(source, { head: corrupted }, failures, notes);
  assert.ok(failures.length > 0, 'zeroed IBM must fail skin verification');
});

test('negative: perturbed residual cap endpoint weight must break boundary continuity', async () => {
  const { verifyActorSkin } = await import('./verify-fracture-assets.mjs');
  const { readAccessor } = await import('./glb-io.mjs');
  const source = readGlb('assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb');
  // Find a chunk with residual cap vertices (torso has them).
  const doc = readGlb('assets/fracture/e04-bulwark/torso.glb');
  const corrupted = { json: JSON.parse(JSON.stringify(doc.json)), bin: Buffer.from(doc.bin) };
  // Perturb one cap prim vertex's weight in the chunk's binary buffer.
  const mesh = corrupted.json.meshes[0];
  const capPrim = mesh.primitives[1];
  if (!capPrim || capPrim.attributes.WEIGHTS_0 === undefined) { assert.fail('torso cap prim missing'); return; }
  const wAcc = corrupted.json.accessors[capPrim.attributes.WEIGHTS_0];
  const wView = corrupted.json.bufferViews[wAcc.bufferView];
  const offset = (wView.byteOffset ?? 0) + (wAcc.byteOffset ?? 0);
  // Flip the first weight from dominant to zero (swap w[0] and w[1]).
  corrupted.bin.writeFloatLE(corrupted.bin.readFloatLE(offset + 4), offset);
  corrupted.bin.writeFloatLE(0, offset + 4);
  const failures = [], notes = [];
  verifyActorSkin(source, { torso: corrupted }, failures, notes);
  assert.ok(failures.length > 0, 'perturbed cap weight must fail boundary continuity');
});
