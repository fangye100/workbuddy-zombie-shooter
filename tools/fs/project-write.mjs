/** Shared devfs/offline-MCP coordination. Direct filesystem writers must opt into this protocol. */
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** One project lock also covers rename transactions involving several files. */
export async function withProjectWriteLock(root, operation, timeoutMs = 10000) {
  const realRoot = realpathSync(root);
  const lock = path.join(realRoot, '.workbuddy', 'cache', 'fs-coordination.lock');
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const token = randomUUID();
  const started = Date.now();
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started >= timeoutMs) {
        const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').catch(() => 'unknown owner');
        const busy = new Error(`Project write lock busy: ${lock}; ${owner}. An abandoned lock needs explicit recovery after confirming its owner stopped.`);
        busy.code = 'lock_busy'; throw busy;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ token, pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }), { flag: 'wx' });
    return await operation();
  } finally {
    // Never remove another owner's replacement lock or unrelated recovery material.
    const names = await fs.readdir(lock).catch(() => []);
    const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (((owner?.token === token || owner === null) && names.length === 1 && names[0] === 'owner.json') || names.length === 0) {
      if (names.length === 1) await fs.unlink(path.join(lock, 'owner.json'));
      await fs.rmdir(lock);
    }
  }
}

export async function atomicWriteText(abs, text) {
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, text, { flag: 'wx', encoding: 'utf8' });
    await fs.rename(temp, abs);
  } finally {
    await fs.unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Lock acquisition precedes read/compare/merge/replace. No caller may refresh its old version here. */
export async function comparePatchJson(root, abs, patch, baseHash, fingerprint) {
  return withProjectWriteLock(root, async () => {
    const text = await fs.readFile(abs, 'utf8');
    let meta;
    try { meta = JSON.parse(text); }
    catch { return { ok: false, status: 409, conflict: true, error: 'Current JSON is invalid', currentHash: 'invalid' }; }
    const currentHash = fingerprint(meta);
    if (currentHash !== baseHash) return { ok: false, status: 409, conflict: true, currentHash, error: `Version conflict: baseline ${baseHash}, current ${currentHash}` };
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('JSON root must be an object');
    const updated = { ...meta, ...patch };
    const out = `${JSON.stringify(updated, null, 2)}\n`;
    await atomicWriteText(abs, out);
    return { ok: true, status: 200, error: null, bytes: Buffer.byteLength(out), hash: fingerprint(updated) };
  });
}
