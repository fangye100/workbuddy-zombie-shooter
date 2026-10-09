import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
// Malformed handoffs must fail before changing the shared library or any source.
// These cases run without Adobe FBXs, so they also work in a clean CI checkout.
const snapshot = () => Object.fromEntries(readdirSync(resolve(root, 'assets/animations/mixamo'))
  .filter(name => name.endsWith('.bvh') || name.endsWith('.json')).map(name => [name,
    createHash('sha256').update(readFileSync(resolve(root, 'assets/animations/mixamo', name))).digest('hex')]));
const cases = [
  ['null document', null, /Invalid animation batch document/],
  ['invalid identity', { id: '../ANI-20261008', items: [{}] }, /Invalid animation batch id/],
  ['no new sources', { id: 'ANI-20261008', items: [{ dupeOfLocal: 'existing' }] }, /no new sources/],
  ['path traversal', { id: 'ANI-20261008', items: [{ file: '../ani_bad.fbx' }] }, /Invalid batch source filename/],
  ['duplicate file', { id: 'ANI-20261008', items: [{ file: 'ani_a.fbx' }, { file: 'ani_a.fbx' }] }, /Duplicate source filenames/],
  ['handoff identity mismatch', { id: 'ANI-20261008', items: [{ req: 'ANI-P-RELOAD', file: 'ani_p_reload.fbx' }] }, /handoff identity mismatch/],
];
for (const [name, batch, error] of cases) test(`batch rejection: ${name} preserves published assets`, () => {
  mkdirSync(resolve(root, '.workbuddy/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve(root, '.workbuddy/tmp/ani-rejection-'));
  try {
    writeFileSync(resolve(dir, 'batch.json'), JSON.stringify(batch));
    mkdirSync(resolve(dir, 'ANI-P-RELOAD'));
    writeFileSync(resolve(dir, 'ANI-P-RELOAD/delivery.json'), JSON.stringify({ id: 'ANI-WRONG' }));
    const before = snapshot();
    const run = spawnSync(process.execPath, [resolve(root, 'tools/motion/import-mixamo.mjs'), '--', '--batch', resolve(dir, 'batch.json')],
      { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.ifError(run.error);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, error);
    assert.deepEqual(snapshot(), before);
  } finally {
    // Only this test's mkdtemp directory, never caller assets or another session.
    rmSync(dir, { recursive: true, force: true });
  }
});
