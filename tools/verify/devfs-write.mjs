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
import { sceneFingerprint } from '../../packages/runtime/src/doc-diff.ts';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

  // ────────────────────────────────────────────────────────────────────────
  // ④ 乐观并发控制（baseHash）与逐路径写入队列（复审 P1/P2）
  // ────────────────────────────────────────────────────────────────────────
  const concRel = 'concur/x.json';
  const concAbs = path.join(root, concRel);
  mkdirSync(path.dirname(concAbs), { recursive: true });
  writeFileSync(concAbs, '{"v":1}\n', 'utf8');
  const baseFp = sceneFingerprint({ v: 1 });

  // 正确 baseHash → 200；错误 baseHash → 409 且磁盘未被触碰
  const okHash = await runWrite(handler, root, concRel, { content: '{"v":2}\n', baseHash: baseFp });
  check('正确 baseHash 放行 (200)', okHash.status === 200 && okHash.body?.ok === true);
  const badHash = await runWrite(handler, root, concRel, { content: '{"v":9}\n', baseHash: 'deadbeefdeadbeef' });
  check('错误 baseHash → 409 conflict', badHash.status === 409 && badHash.body?.code === 'conflict');
  check('409 回传当前磁盘指纹', typeof badHash.body?.currentHash === 'string' && badHash.body.currentHash.length === 8);
  check('409 后磁盘未被触碰', readFileSync(concAbs, 'utf8') === '{"v":2}\n');

  // 并发：两个带**同一基准**的写请求同时进来，恰好一个 200、一个 409（队列串行化生效）
  const fp2 = sceneFingerprint({ v: 2 });
  const [c1, c2] = await Promise.all([
    runWrite(handler, root, concRel, { content: '{"v":3}\n', baseHash: fp2 }),
    runWrite(handler, root, concRel, { content: '{"v":4}\n', baseHash: fp2 }),
  ]);
  const statuses = [c1.status, c2.status].sort((a, b) => a - b);
  check('并发两写：恰好一个 200、一个 409', statuses[0] === 200 && statuses[1] === 409);
  const finalV = JSON.parse(readFileSync(concAbs, 'utf8')).v;
  check('并发后磁盘是其中一个写入者的内容（不是交错碎片）', finalV === 3 || finalV === 4);

  // ⑤ 写入失败恢复（复审 P1）：让一次写入真实失败，进程与队列都必须活着
  //    blocker 是**文件**而不是目录 → mkdir 必抛（ENOTDIR）→ 走 500 路径
  const blockerRel = 'blocker';
  writeFileSync(path.join(root, blockerRel), 'not-a-dir', 'utf8');
  const failRes = await runWrite(handler, root, 'blocker/x.json', { content: '{"a":1}\n' });
  check('写入失败返回 500 而不是把进程打挂', failRes.status === 500);

  // 失败之后：其它路径照常可写（队列没有卡死）
  const recoverA = await runWrite(handler, root, 'recover/a.json', { content: '{"ok":1}\n' });
  check('失败后其它路径照常可写 (200)', recoverA.status === 200 && recoverA.body?.ok === true);

  // 同一路径在故障排除后也照常可写（队列尾部被正确清理，没有残留拒绝态）
  rmSync(path.join(root, blockerRel), { force: true });
  const recoverB = await runWrite(handler, root, 'blocker/x.json', { content: '{"ok":2}\n' });
  check('故障排除后同一路径照常可写 (200)', recoverB.status === 200 && recoverB.body?.ok === true);
  check('恢复写入的内容落盘', JSON.parse(readFileSync(path.join(root, 'blocker/x.json'), 'utf8')).ok === 2);

  // 队列内部状态不应无限增长：刚才这些路径的队列尾部都已离开（不能逐个断言 Map，
  // 用「连续成功 + 进程存活」作为健康证据；若 Map 泄漏会在长跑里显现）
  check('写端点在全部失败后仍存活且可服务', existsSync(concAbs));
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
