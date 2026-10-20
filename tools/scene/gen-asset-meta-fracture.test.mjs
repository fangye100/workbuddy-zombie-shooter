import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {generateAssetMetas} from './gen-asset-meta.mjs';

const HERE = path.dirname((await import('node:url')).fileURLToPath(new URL(import.meta.url)));
const REPO = path.resolve(HERE, '../..');
const NL = String.fromCharCode(10);

const asset = {
  version: 1, id: 'as_test001', name: 'crate', status: 'accepted', kind: 'object',
  source: { model: { path: 'assets/fracture/crate/crate.glb', guid: 'as_crate1' }, origin: 'delivered asset' },
  assemblyScale: 1,
  chunks: [{
    chunkId: 'chunk-0001', class: 'large', mesh: { path: 'assets/fracture/crate/chunks.glb', guid: 'as_chunks1' },
    bind: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, pivot: [0, 0, 0],
    proxy: { shape: { type: 'box', halfExtents: [0.2, 0.2, 0.2] }, mass: 4, friction: 0.6, restitution: 0.25, collisionGroup: 'debris' },
  }],
  npc: null,
  playback: { priority: 1, lifetimeSec: 3, fadeSec: 0.5, companionVfx: null },
};

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-fracture-'));
  await fs.mkdir(path.join(root, 'packages', 'content', 'src', 'generated'), { recursive: true });
  await fs.copyFile(
    path.join(REPO, 'packages', 'content', 'src', 'generated', 'roster.generated.ts'),
    path.join(root, 'packages', 'content', 'src', 'generated', 'roster.generated.ts'),
  );
  const rel = 'assets/fracture/crate/crate.fracture.json';
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(asset, null, 2) + NL);
  return { root, rel, abs };
}

const sha = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex');

test('FR-WU01-04 fracture sidecar guid 来自校验过的资产 id：首建过门禁、幂等、保留用户字段、坏身份拒绝', async () => {
  const { root, rel, abs } = await tempRoot();
  try {
    const first = await generateAssetMetas(root, {});
    assert.equal(first.failures.length, 0, JSON.stringify(first.failures));
    assert.equal(first.created, 1);
    const metaPath = abs + '.meta.json';
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    assert.equal(meta.kind, 'fracture');
    assert.equal(meta.guid, 'as_test001');
    const text = await fs.readFile(abs, 'utf8');
    assert.equal(meta.sourceHash, sha(text));

    const again = await generateAssetMetas(root, {});
    assert.equal(again.failures.length, 0);
    assert.equal(again.created, 0);
    assert.equal(again.updated, 0);
    assert.equal(again.unchanged, again.targets);

    const edited = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    edited.userData.keep = 7;
    await fs.writeFile(metaPath, JSON.stringify(edited, null, 2) + NL);
    const nextText = JSON.stringify({ ...asset, name: 'crate v2' }, null, 2) + NL;
    await fs.writeFile(abs, nextText);
    const third = await generateAssetMetas(root, {});
    assert.equal(third.failures.length, 0);
    const after = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    assert.equal(after.guid, 'as_test001');
    assert.equal(after.userData.keep, 7);
    assert.equal(after.sourceHash, sha(nextText));

    const wrong = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    wrong.guid = 'as_other99';
    const wrongText = JSON.stringify(wrong, null, 2) + NL;
    await fs.writeFile(metaPath, wrongText);
    const mismatch = await generateAssetMetas(root, {});
    assert.match(mismatch.failures.join(';'), /身份不匹配/);
    assert.equal(await fs.readFile(metaPath, 'utf8'), wrongText);

    const check = await generateAssetMetas(root, { checkOnly: true });
    assert.match(check.failures.join(';'), /身份不匹配/);

    const badRel = 'assets/fracture/crate/broken.fracture.json';
    const badAbs = path.join(root, badRel);
    const broken = structuredClone(asset);
    delete broken.chunks[0].chunkId;
    await fs.writeFile(badAbs, JSON.stringify(broken, null, 2) + NL);
    const invalid = await generateAssetMetas(root, {});
    assert.match(invalid.failures.join(';'), /校验失败/);
    assert.equal(await fs.access(badAbs + '.meta.json').then(() => true, () => false), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
