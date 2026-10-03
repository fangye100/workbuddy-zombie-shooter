/** GUI persistence + real devfs versus independent offline MCP stdio processes, isolated assets. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, rmdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { createFsApiHandler } from '../../apps/editor/devfs.ts';
import { withProjectWriteLock } from '../fs/project-write.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'binding-write-'));
assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'binding-write-'));
const clients = [];
try {
  await mkdir(path.join(root, 'tools/mcp-binding/dist'), { recursive: true });
  await mkdir(path.join(root, 'tools/fs'), { recursive: true });
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await copyFile(path.join(repo, 'tools/mcp-binding/server.mjs'), path.join(root, 'tools/mcp-binding/server.mjs'));
  await copyFile(path.join(repo, 'tools/fs/project-write.mjs'), path.join(root, 'tools/fs/project-write.mjs'));
  await build({ entryPoints: [path.join(repo, 'tools/mcp-binding/src/domain-entry.ts')], bundle: true,
    platform: 'node', format: 'esm', outfile: path.join(root, 'tools/mcp-binding/dist/domain.mjs'), tsconfig: path.join(repo, 'tsconfig.check.json') });
  await build({ stdin: { contents: `
    export { BindingPersistence } from './apps/editor/src/services/binding/binding-persistence';
    export { BindingSession } from './apps/editor/src/services/binding/binding-session';
    export { writeProjectFile } from './apps/editor/src/asset-util';
    export { sceneFingerprint } from '@aether/runtime';
  `, resolveDir: repo, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm',
    outfile: path.join(root, 'gui.mjs'), tsconfig: path.join(repo, 'tsconfig.check.json') });
  const { BindingPersistence, BindingSession, writeProjectFile, sceneFingerprint } = await import(pathToFileURL(path.join(root, 'gui.mjs')).href);
  const source = path.join(repo, 'assets/characters/models/E-04/game_ready/E04_20260901_010134_1600tris.glb');
  await copyFile(source, path.join(root, 'assets/model.glb'));
  const metaPath = path.join(root, 'assets/model.glb.meta.json');
  const original = JSON.parse(await readFile(`${source}.meta.json`, 'utf8'));
  original.userData.concurrentUnknown = { keep: [1, 2, 3] };
  await writeFile(metaPath, JSON.stringify(original));
  const disk = async () => JSON.parse(await readFile(metaPath, 'utf8'));

  function client() {
    const child = spawn(process.execPath, [path.join(root, 'tools/mcp-binding/server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
    clients.push(child); let buffer = ''; let next = 0; const pending = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue; const msg = JSON.parse(line); const p = pending.get(msg.id);
        if (!p) continue; pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      }
    });
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++next; const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 15000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    return { child, call, async tool(name, args = {}) {
      const r = await call('tools/call', { name, arguments: args });
      if (r.isError) return { ok: false, error: r.content[0].text };
      return JSON.parse(r.content.find((c) => c.type === 'text').text);
    } };
  }
  const a = client(); const b = client();
  for (const c of [a, b]) {
    await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'write-probe', version: '1' } });
    await c.tool('load_model', { path: 'assets/model.glb' });
  }
  assert.notEqual(a.child.pid, b.child.pid); assert.notEqual(a.child.pid, process.pid);
  const gui = new BindingPersistence(); const session = new BindingSession();
  assert.equal(gui.accept('assets/model.glb.meta.json', original), null);
  session.poseJoint('Head', [0, 2.4, 0]);
  await a.tool('set_joint', { name: 'Head', position: [0, 2.6, 0] });
  await b.tool('set_joint', { name: 'Head', position: [0, 2.8, 0] });
  const handler = createFsApiHandler(root);
  function request(body) {
    return new Promise((resolve, reject) => {
      const listeners = {}; const req = { method: 'POST', url: '/__fs/write', on(e, cb) { (listeners[e] ??= []).push(cb); } };
      const res = { statusCode: 0, setHeader() {}, end(text) { const json = JSON.parse(text); resolve({ ok: this.statusCode === 200, status: this.statusCode, json: async () => json }); } };
      handler(req, res, () => reject(new Error('route not handled')));
      for (const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(body)));
      for (const cb of listeners.end ?? []) cb();
    });
  }
  const guiSave = () => gui.save(session.getEditorData(), (r) => writeProjectFile(r.path, { patch: r.patch, baseHash: r.baseHash }, async (_u, options) => request(JSON.parse(options.body))));
  let start; let unlock; const started = new Promise((r) => { start = r; }); const release = new Promise((r) => { unlock = r; });
  const held = withProjectWriteLock(root, async () => { start(); await release; }); await started;
  const guiPending = guiSave(); const mcpPending = a.tool('save');
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await disk(), original, 'both writers wait for the shared lock');
  unlock(); await held; const [g, m] = await Promise.all([guiPending, mcpPending]);
  assert.equal([g, m].filter((r) => r.ok).length, 1);
  const loser = g.ok ? m : g; assert.equal(loser.conflict, true); assert.equal(loser.currentHash, sceneFingerprint(await disk()));
  assert.equal(session.positions.Head[1], 2.4); assert.equal((await a.tool('get_joints')).positions.Head[1], 2.6);
  assert.deepEqual((await disk()).userData, original.userData);
  console.log(`PASS real GUI/devfs PID ${process.pid} vs stdio MCP PID ${a.child.pid}: one winner, 409 loser, local edits and unknown metadata retained`);

  const stale = await b.tool('save'); assert.equal(stale.conflict, true); assert.equal((await b.tool('get_joints')).positions.Head[1], 2.8);
  assert.equal((await b.tool('hydrate')).hydrated, true);
  await b.tool('set_joint', { name: 'Head', position: [0, 3.1, 0] }); assert.equal((await b.tool('save')).ok, true);
  assert.equal((await disk()).bindingEditor.positions.Head[1], 3.1);
  console.log('PASS second independent MCP stale save rejected; explicit hydrate + edit + save recovers');

  const latest = await disk(); gui.accept('assets/model.glb.meta.json', latest);
  await rm(metaPath); await mkdir(metaPath);
  assert.equal((await guiSave()).ok, false); assert.equal(session.positions.Head[1], 2.4);
  await assert.rejects(access(path.join(root, '.workbuddy/cache/fs-coordination.lock')));
  await rmdir(metaPath); await writeFile(metaPath, JSON.stringify(latest)); assert.equal((await guiSave()).ok, true);
  console.log('PASS real devfs I/O failure releases cross-process lock; accepted baseline and local edits retry successfully');
  await assert.rejects(withProjectWriteLock(root, async () => { throw new Error('operation failed'); }), /operation failed/);
  await withProjectWriteLock(root, async () => {});
  console.log('PASS failed coordinated operation releases lock for next writer');
} finally {
  await Promise.all(clients.map((c) => new Promise((resolve) => { if (c.exitCode !== null) return resolve(); c.once('exit', resolve); c.kill(); })));
  await rm(root, { recursive: true, force: true });
}
