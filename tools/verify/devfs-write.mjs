/**
 * devfs 写端点回归测（纯 node，无需 dev server / 浏览器）。
 *
 * 为什么独立成文件而不进 vitest：
 *   门禁 tsconfig.check.json 的 include 不含 node 类型，测试里用 node:fs 会触发
 *   TS 报错。devfs 本身是 server-only（放 apps/editor 根而非 src/），只能由 node
 *   直接跑。本文件用 `node --experimental-strip-types` 加载 devfs.ts，覆盖三项铁律：
 *     ① 路径锁根：../../ 穿越被拒；
 *     ② .json only：其它扩展名被拒；
 *     ③ patch 浅合并保留兄弟键（importer / userData / rig / guid 不被 bindingEditor 覆盖）。
 *
 * 用法：node tools/verify/devfs-write.mjs
 * 退出码：0 = 全过；1 = 有断言失败。
 */
import { createFsApiHandler } from '../../apps/editor/devfs.ts';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failures++;
  }
}

function makeReq(url, method, bodyObj) {
  const chunk = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj));
  const listeners = {};
  return {
    method,
    url,
    on(ev, cb) { (listeners[ev] ??= []).push(cb); },
    emit() {
      if (chunk !== null) (listeners.data ?? []).forEach((cb) => cb(chunk));
      (listeners.end ?? []).forEach((cb) => cb());
    },
  };
}

function makeRes() {
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let status = 0;
  let body = '';
  const res = {
    setHeader() {},
    get statusCode() { return status; },
    set statusCode(v) { status = v; },
    end(s) { body = s; resolveDone(); },
  };
  return { res, done: () => done.then(() => ({ status, body: body === '' ? null : JSON.parse(body) })) };
}

async function runWrite(handler, root, rel, bodyObj) {
  const req = makeReq(`/__fs/write`, 'POST', { path: rel, ...bodyObj });
  const { res, done } = makeRes();
  handler(req, res, () => {});
  req.emit();
  return done();
}

const root = mkdtempSync(path.join(tmpdir(), 'devfs-'));
try {
  const handler = createFsApiHandler(root);

  // 预置一份 gen-asset-meta 风格的 sidecar（带 guid/importer/userData/rig/bindings）
  const metaRel = 'assets/characters/models/B-01/rigged/B01.meta.json';
  const metaAbs = path.join(root, metaRel);
  mkdirSync(path.dirname(metaAbs), { recursive: true });
  writeFileSync(metaAbs, JSON.stringify({
    schemaVersion: 1,
    guid: 'guid-abc-123',
    kind: 'gltf',
    importer: { normalizeHeightM: 1.8, weldTolerance: 1e-4 },
    bindings: [],
    rig: null,
    userData: { characterId: 'B-01', variant: 'rigged' },
    updatedAt: '2026-01-01T00:00:00Z',
  }, null, 2), 'utf8');

  console.log('devfs 写端点回归：');

  // ③ patch 浅合并保留兄弟键 + 写入 bindingEditor
  const editorData = {
    positions: { Hip: [0, 0.9, 0], Spine: [0, 1.1, 0.02] },
    cylinders: { Hip: { bone: 'Hip', radii: { top: 0.2, medium: 0.18, bottom: 0.22 }, enabled: true } },
    savedAt: '2026-09-07T00:00:00Z',
  };
  const w = await runWrite(handler, root, metaRel, { patch: { bindingEditor: editorData } });
  check('写端点返回 200 ok', w.status === 200 && w.body?.ok === true);
  check('写出字节数 > 0', typeof w.body?.bytes === 'number' && w.body.bytes > 0);

  const after = JSON.parse(readFileSync(metaAbs, 'utf8'));
  check('bindingEditor 已写入', after.bindingEditor !== undefined);
  check('bindingEditor.cylinders 形状被保留', after.bindingEditor?.cylinders?.Hip?.radii?.top === 0.2);
  check('兄弟键 guid 未被覆盖', after.guid === 'guid-abc-123');
  check('兄弟键 importer 未被覆盖', after.importer?.normalizeHeightM === 1.8);
  check('兄弟键 userData 未被覆盖', after.userData?.characterId === 'B-01');
  check('兄弟键 rig 未被覆盖', after.rig === null);
  check('兄弟键 bindings 未被覆盖', Array.isArray(after.bindings));

  // 再次 patch 只更新 bindingEditor，不破坏其它键
  const w2 = await runWrite(handler, root, metaRel, { patch: { bindingEditor: { positions: { Hip: [0, 0.95, 0] }, cylinders: null } } });
  const after2 = JSON.parse(readFileSync(metaAbs, 'utf8'));
  check('二次 patch 仍成功', w2.status === 200 && w2.body?.ok === true);
  check('二次 patch 更新了 positions', after2.bindingEditor?.positions?.Hip?.[1] === 0.95);
  check('二次 patch 后 guid 仍在', after2.guid === 'guid-abc-123');

  // ① 路径锁根：拒绝 ../../ 穿越
  const traverse = await runWrite(handler, root, '../../etc/passwd', { content: '{}' });
  check('../../ 穿越被拒 (400)', traverse.status === 400);

  // ② 仅允许 .json
  const nonJson = await runWrite(handler, root, 'assets/x.png', { content: '{}' });
  check('非 .json 被拒 (403)', nonJson.status === 403);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
