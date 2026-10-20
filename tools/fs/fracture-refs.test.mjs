import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rewriteResourcePaths, pathRewriter} from './resource-paths.mjs';

test('FR-WU01-05 typed rename rewrites Destructible, SpawnPoint deathFracture and fracture asset refs', () => {
  const rewrite = pathRewriter('assets/fracture/crate', 'assets/fracture/crate2', true);
  const scene = {
    schemaVersion: 25,
    nodes: [{
      id: 'nd_a', components: [
        { kind: 'Destructible', enabled: true, profile: { path: 'assets/fracture/crate/crate.fracture.json', guid: 'g1' } },
        { kind: 'SpawnPoint', enabled: true, characterId: 'E-01', count: 1, wave: 1, trigger: 'room-enter', delaySec: 0, radius: 1, prefab: null,
          deathFracture: { profile: { path: 'assets/fracture/crate/crate.fracture.json', guid: 'g1' } } },
        { kind: 'SpawnPoint', enabled: true, characterId: 'E-02', count: 1, wave: 1, trigger: 'room-enter', delaySec: 0, radius: 1, prefab: null },
      ],
    }],
  };
  assert.equal(rewriteResourcePaths(scene, 'scene', rewrite, 25), true);
  assert.equal(scene.nodes[0].components[0].profile.path, 'assets/fracture/crate2/crate.fracture.json');
  assert.equal(scene.nodes[0].components[1].deathFracture.profile.path, 'assets/fracture/crate2/crate.fracture.json');
  assert.equal(scene.nodes[0].components[1].deathFracture.profile.guid, 'g1');
  assert.equal('deathFracture' in scene.nodes[0].components[2], false);

  const asset = {
    version: 1, id: 'g9', name: 'crate', status: 'accepted', kind: 'object',
    source: { model: { path: 'assets/fracture/crate/crate.glb', guid: 'g2' }, origin: 'delivered' },
    assemblyScale: 1,
    chunks: [{ chunkId: 'chunk-0001', class: 'large', mesh: { path: 'assets/fracture/crate/chunks.glb', guid: 'g3' },
      bind: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, pivot: [0, 0, 0],
      proxy: { shape: { type: 'convex', mesh: { path: 'assets/fracture/crate/convex.glb', guid: 'g4' } }, mass: 1, friction: 0.5, restitution: 0.2, collisionGroup: 'debris' } }],
    npc: null,
    playback: { priority: 1, lifetimeSec: 3, fadeSec: 0.5, companionVfx: { resource: { path: 'assets/vfx/blast.vfx.json', guid: 'g5' }, effectKey: 'blast' } },
  };
  assert.equal(rewriteResourcePaths(asset, 'fracture', rewrite, 25), true);
  assert.equal(asset.source.model.path, 'assets/fracture/crate2/crate.glb');
  assert.equal(asset.chunks[0].mesh.path, 'assets/fracture/crate2/chunks.glb');
  assert.equal(asset.chunks[0].proxy.shape.mesh.path, 'assets/fracture/crate2/convex.glb');
  assert.equal(asset.playback.companionVfx.resource.path, 'assets/vfx/blast.vfx.json');

  const untouched = structuredClone(asset);
  untouched.npc = { actorId: 'E-04', mode: 'skinned', boneMap: { 'chunk-0001': 'assets/fracture/crate/hidden-bone' }, normalizeHeightM: null, footOffsetM: 0 };
  assert.throws(() => rewriteResourcePaths(untouched, 'fracture', rewrite, 25), /不支持安全更新的引用/);
});
