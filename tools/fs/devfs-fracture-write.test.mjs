import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

const HERE = path.dirname((await import('node:url')).fileURLToPath(new URL(import.meta.url)));
const ROOT2 = path.resolve(HERE, '../..');
const NL = String.fromCharCode(10);

const validAsset = {
  version: 1, id: 'as_fract1', name: 'crate', status: 'accepted', kind: 'object',
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

async function bundle() {
  const esbuild = await import('esbuild');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devfs-fracture-'));
  const handlerOut = path.join(dir, 'devfs-bundle.mjs');
  const entry = path.join(dir, 'entry.mjs');
  const entryText = 'export { createFsApiHandler } from ' + JSON.stringify(path.join(ROOT2, 'apps/editor/devfs.ts')) + ';' + NL
    + 'export { sceneFingerprint } from ' + JSON.stringify(path.join(ROOT2, 'packages/runtime/src/doc-diff.ts')) + ';';
  await fs.writeFile(entry, entryText);
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: handlerOut, tsconfig: path.join(ROOT2, 'tsconfig.check.json'), logLevel: 'error' });
  return import(pathToFileURL(handlerOut).href);
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devfs-root-'));
  const rel = 'assets/fracture/crate/crate.fracture.json';
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const text = JSON.stringify(validAsset, null, 2) + NL;
  await fs.writeFile(abs, text);
  await fs.writeFile(abs + '.meta.json', JSON.stringify({ kind: 'fracture', guid: 'as_fract1', userData: { keep: 42 }, sourceHash: 'old' }, null, 2) + NL);
  return { root, rel, abs, text };
}

test('FR-WU01-01 devfs fracture save: bad input 400 leaves source and sidecar unchanged; legal null companionVfx saves and updates digest', async () => {
  const { createFsApiHandler, sceneFingerprint } = await bundle();
  const { root, rel, abs } = await setup();
  const server = createServer((req, res) => createFsApiHandler(root)(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async body => {
    const response = await fetch(base + '/__fs/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  try {
    const before = await fs.readFile(abs, 'utf8');
    const metaBefore = await fs.readFile(abs + '.meta.json', 'utf8');
    const baseHash = sceneFingerprint(JSON.parse(before));

    const broken = structuredClone(validAsset);
    delete broken.chunks[0].chunkId;
    delete broken.playback.companionVfx;
    const bad = await post({ path: rel, content: JSON.stringify(broken, null, 2), baseHash });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /chunkId/);
    assert.match(bad.json.error, /playback|companionVfx|\u64ad\u653e/);
    assert.equal(await fs.readFile(abs, 'utf8'), before);
    assert.equal(await fs.readFile(abs + '.meta.json', 'utf8'), metaBefore);

    const conflict = await post({ path: rel, content: JSON.stringify({ ...validAsset, name: 'stale' }, null, 2), baseHash: 'stale' });
    assert.equal(conflict.status, 409);
    assert.equal(await fs.readFile(abs, 'utf8'), before);

    const nextText = JSON.stringify({ ...validAsset, name: 'crate v2' }, null, 2) + NL;
    const ok = await post({ path: rel, content: nextText, baseHash });
    assert.equal(ok.status, 200);
    assert.equal(await fs.readFile(abs, 'utf8'), nextText);
    const meta = JSON.parse(await fs.readFile(abs + '.meta.json', 'utf8'));
    assert.equal(meta.userData.keep, 42);
    assert.equal(meta.kind, 'fracture');
    assert.equal(meta.sourceHash, 'sha256:' + createHash('sha256').update(nextText).digest('hex'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
