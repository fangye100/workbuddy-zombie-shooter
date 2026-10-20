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
