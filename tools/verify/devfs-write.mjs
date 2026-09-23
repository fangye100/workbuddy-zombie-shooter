/**
 * devfs 端点回归测（纯 node，无需 dev server / 浏览器）。
 *
 * 为什么独立成文件而不进 vitest：
 *   门禁 tsconfig.check.json 的 include 不含 node 类型，测试里用 node:fs 会触发
 *   TS 报错。devfs 本身是 server-only（放 apps/editor 根而非 src/），只能由 node
 *   直接跑。本文件用 `node --experimental-strip-types` 加载 devfs.ts，覆盖：
 *     ① 路径锁根：../../ 穿越被拒；
 *     ② .json only：其它扩展名被拒；
 *     ③ patch 浅合并保留兄弟键（importer / userData / rig / guid 不被 bindingEditor 覆盖）；
 *     ④ 乐观并发（baseHash）与逐路径写入队列（复审 P1/P2）；
 *     ⑤ /__fs/info · /__fs/rename · /__fs/reveal（右键菜单底座）：
 *        绝对路径解析、改名护栏（非法名/占用/穿越/项目锚点）、
 *        sidecar 随迁、aether.project.json 场景登记同步。
 *
 * 用法：node tools/verify/devfs-write.mjs
 * 退出码：0 = 全过；1 = 有断言失败。
 */
import { createFsApiHandler } from '../../apps/editor/devfs.ts';
import { sceneFingerprint } from '../../packages/runtime/src/doc-diff.ts';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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

async function runReq(handler, url, method = 'GET', bodyObj = undefined) {
  const chunk = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj));
  const listeners = {};
  const req = {
    method,
    url,
    on(ev, cb) { (listeners[ev] ??= []).push(cb); },
    emit() {
      if (chunk !== null) (listeners.data ?? []).forEach((cb) => cb(chunk));
      (listeners.end ?? []).forEach((cb) => cb());
    },
  };
  const { res, done } = makeRes();
  handler(req, res, () => {});
  req.emit();
  return done();
}

async function runWrite(handler, root, rel, bodyObj) {
  return runReq(handler, `/__fs/write`, 'POST', { path: rel, ...bodyObj });
}

async function runRename(handler, root, rel, newName) {
  return runReq(handler, `/__fs/rename`, 'POST', { path: rel, newName });
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

  // ④b 大小写路径并发（复审 P1）：Windows/macOS 上 `case.json` 与 `CASE.JSON`
  //     是同一个文件，必须进同一队列 —— 一个 200、一个 409，且内容属于成功的那一笔。
  //     Linux 上大小写是两个文件，这个用例只在大小写不敏感的盘上断言（探测一次）。
  {
    const caseRel = 'casefold/case.json';
    const caseAbs = path.join(root, caseRel);
    mkdirSync(path.dirname(caseAbs), { recursive: true });
    writeFileSync(caseAbs, '{"n":1}\n', 'utf8');
    // 探测本机盘是否大小写不敏感：用大写路径读到同一份内容即不敏感
    let ciFs = false;
    try {
      ciFs = readFileSync(caseAbs.toUpperCase().replace(/CASE\.JSON$/, 'CASE.JSON'), 'utf8') === '{"n":1}\n';
    } catch { /* 区分大小写的盘会抛 */ }
    if (ciFs) {
      const fpN = sceneFingerprint({ n: 1 });
      const [r1, r2] = await Promise.all([
        runWrite(handler, root, 'casefold/case.json', { content: '{"n":2}\n', baseHash: fpN }),
        runWrite(handler, root, 'casefold/CASE.JSON', { content: '{"n":3}\n', baseHash: fpN }),
      ]);
      const st = [r1.status, r2.status].sort((a, b) => a - b);
      check('大小写并发：恰好一个 200、一个 409（同一文件进同一队列）', st[0] === 200 && st[1] === 409);
      const finalN = JSON.parse(readFileSync(caseAbs, 'utf8')).n;
      check('大小写并发后磁盘是成功那笔的内容', finalN === 2 || finalN === 3);
      // 且没有留下互相覆盖的临时文件残骸
      const leftovers = readdirSync(path.dirname(caseAbs)).filter((f) => f.endsWith('.tmp'));
      check('大小写并发后无临时文件残留', leftovers.length === 0);
    } else {
      console.log('  (跳过大小写并发用例：当前盘区分大小写)');
    }
  }

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

  // ────────────────────────────────────────────────────────────────────────
  // ⑤ /__fs/info · /__fs/rename · /__fs/reveal（右键菜单底座）
  //    reveal 只测校验失败分支（穿越 400 / 不存在 404）——成功分支会真的弹出
  //    资源管理器窗口，回归测试不能拿桌面开party。
  // ────────────────────────────────────────────────────────────────────────
  console.log('\ninfo / rename / reveal 端点：');

  // info：绝对路径解析 + 锁根
  mkdirSync(path.join(root, 'probe'), { recursive: true });
  writeFileSync(path.join(root, 'probe/a.json'), '{}', 'utf8');
  const infoOk = await runReq(handler, `/__fs/info?path=${encodeURIComponent('probe/a.json')}`);
  check('info 返回 200 + 绝对路径在根内', infoOk.status === 200 && infoOk.body?.kind === 'file'
    && infoOk.body?.abs === path.join(root, 'probe', 'a.json'));
  const infoMissing = await runReq(handler, `/__fs/info?path=${encodeURIComponent('probe/none.json')}`);
  check('info 对不存在条目报 kind=missing（200，查询不炸）', infoMissing.status === 200 && infoMissing.body?.kind === 'missing');
  const infoEscape = await runReq(handler, `/__fs/info?path=${encodeURIComponent('../../etc/passwd')}`);
  check('info 拒绝 ../../ 穿越 (400)', infoEscape.status === 400);

  // rename：护栏（先测拒绝路径，再测成功路径，避免顺序耦合）
  writeFileSync(path.join(root, 'probe/b.json'), '{}', 'utf8');
  writeFileSync(path.join(root, 'probe/b.json.meta.json'), '{"guid":"g1"}', 'utf8');
  const rnEscape = await runRename(handler, root, '../../evil', 'x');
  check('rename 拒绝 ../../ 穿越 (400)', rnEscape.status === 400);
  const rnMissing = await runRename(handler, root, 'probe/ghost.json', 'newname.json');
  check('rename 对不存在条目 404', rnMissing.status === 404);
  const rnSame = await runRename(handler, root, 'probe/b.json', 'b.json');
  check('rename 同名拒绝 (400)', rnSame.status === 400);
  const rnBadNames = await Promise.all([
    runRename(handler, root, 'probe/b.json', 'a/b'),
    runRename(handler, root, 'probe/b.json', '..'),
    runRename(handler, root, 'probe/b.json', 'bad*name'),
    runRename(handler, root, 'probe/b.json', 'bad:name'),
    runRename(handler, root, 'probe/b.json', 'trailing.'),
    runRename(handler, root, 'probe/b.json', 'trailing '),
    runRename(handler, root, 'probe/b.json', 'con'),
    runRename(handler, root, 'probe/b.json', ''),
  ]);
  check('rename 非法名全拒（分隔符/../保留字/结尾点空格/con/空）', rnBadNames.every((r) => r.status === 400),
    rnBadNames.map((r) => r.status).join(','));
  const rnTarget = await runRename(handler, root, 'probe/b.json', 'a.json');
  check('rename 目标已占用 → 409', rnTarget.status === 409);

  // rename 成功路径：文件 + sidecar 随迁
  const rnOk = await runRename(handler, root, 'probe/b.json', 'renamed.json');
  check('rename 文件成功 (200)', rnOk.status === 200 && rnOk.body?.ok === true && rnOk.body?.path === 'probe/renamed.json');
  check('rename 后旧文件消失', !existsSync(path.join(root, 'probe/b.json')));
  check('rename 后新文件存在', existsSync(path.join(root, 'probe/renamed.json')));
  check('sidecar <名>.meta.json 随迁', existsSync(path.join(root, 'probe/renamed.json.meta.json'))
    && !existsSync(path.join(root, 'probe/b.json.meta.json')));
  check('响应里 metaRenamed=true', rnOk.body?.metaRenamed === true);

  // rename 目录：内部条目整目录搬家
  mkdirSync(path.join(root, 'probe/olddir/inner'), { recursive: true });
  writeFileSync(path.join(root, 'probe/olddir/inner/deep.json'), '{"d":1}', 'utf8');
  const rnDir = await runRename(handler, root, 'probe/olddir', 'newdir');
  check('rename 目录成功 (200)', rnDir.status === 200 && rnDir.body?.path === 'probe/newdir');
  check('目录内部条目跟着搬家', existsSync(path.join(root, 'probe/newdir/inner/deep.json')));

  // 场景登记同步：scenes[].path 精确命中（文件改名）与前缀命中（目录改名）
  writeFileSync(path.join(root, 'aether.project.json'), JSON.stringify({
    schemaVersion: 1,
    scenes: [
      { path: 'probe/newdir/inner/deep.json', name: 'A' },
      { path: 'probe/renamed.json', name: 'B' },
      { path: 'probe/untouched.json', name: 'C' },
    ],
  }, null, 2), 'utf8');
  const rnSceneFile = await runRename(handler, root, 'probe/renamed.json', 'renamed2.json');
  check('rename .scene.json 命中登记 → projectUpdated', rnSceneFile.status === 200 && rnSceneFile.body?.projectUpdated === true);
  const rnSceneDir = await runRename(handler, root, 'probe/newdir', 'newdir2');
  check('rename 目录前缀命中登记 → projectUpdated', rnSceneDir.status === 200 && rnSceneDir.body?.projectUpdated === true);
  const projAfter = JSON.parse(readFileSync(path.join(root, 'aether.project.json'), 'utf8'));
  check('登记路径已改写（文件级）', projAfter.scenes.some((s) => s.path === 'probe/renamed2.json'));
  check('登记路径已改写（目录前缀级）', projAfter.scenes.some((s) => s.path === 'probe/newdir2/inner/deep.json'));
  check('未命中的登记保持原样', projAfter.scenes.some((s) => s.path === 'probe/untouched.json'));
  // 无命中：改名的文件不在登记里（probe/a.json 没进过 scenes[]）→ 不动项目文件
  const rnNoHit = await runRename(handler, root, 'probe/a.json', 'a2.json');
  check('无登记命中 → projectUpdated=false（不动项目文件）', rnNoHit.status === 200 && rnNoHit.body?.projectUpdated === false);

  // 项目锚点拒绝改名
  const rnAnchor = await runRename(handler, root, 'aether.project.json', 'nope.json');
  check('rename 项目锚点 aether.project.json 拒绝 (400)', rnAnchor.status === 400
    && existsSync(path.join(root, 'aether.project.json')));

  // reveal：只测校验失败分支（成功分支会弹资源管理器窗口）
  const rvEscape = await runReq(handler, `/__fs/reveal`, 'POST', { path: '../../windows' });
  check('reveal 拒绝 ../../ 穿越 (400)', rvEscape.status === 400);
  const rvMissing = await runReq(handler, `/__fs/reveal`, 'POST', { path: 'probe/ghost.json' });
  check('reveal 对不存在条目 404', rvMissing.status === 404);

  // ── bot 评审收口回归（PR #14）──────────────────────────────────────────

  // 根本身边份拒绝：`path: "."` resolve 成项目根，rename 会把 checkout 挪出锁外
  const rnRoot = await runRename(handler, root, '.', 'escaped-root');
  check('rename 项目根本身拒绝 (400)', rnRoot.status === 400);
  const rnRoot2 = await runRename(handler, root, './', 'escaped-root');
  check('rename 根（./ 写法）同样拒绝 (400)', rnRoot2.status === 400);

  // 锚点大小写：大小写不敏感盘上 AETHER.PROJECT.JSON = 锚点本身，必须拒绝；
  // 区分大小写的盘上该文件不存在 → 404（同样没被改名）
  const rnAnchorCase = await runRename(handler, root, 'AETHER.PROJECT.JSON', 'nope.json');
  if (rnAnchorCase.status === 400) {
    check('rename 锚点大写变体拒绝 (400，大小写不敏感盘)', rnAnchorCase.status === 400);
  } else {
    check('rename 锚点大写变体按不存在拒绝 (404，区分大小写盘)', rnAnchorCase.status === 404);
  }

  // sidecar 目标位被孤儿占用：a.json(+meta) → b.json 时残留 b.json.meta.json → 409，
  // 且源文件与源 sidecar 都不动（不被半执行）
  writeFileSync(path.join(root, 'probe/sc.json'), '{}', 'utf8');
  writeFileSync(path.join(root, 'probe/sc.json.meta.json'), '{"guid":"sc"}', 'utf8');
  writeFileSync(path.join(root, 'probe/orphan-target.json.meta.json'), '{"guid":"orphan"}', 'utf8');
  const rnSidecarClash = await runRename(handler, root, 'probe/sc.json', 'orphan-target.json');
  check('sidecar 目标位被孤儿占用 → 409', rnSidecarClash.status === 409, JSON.stringify(rnSidecarClash.body));
  check('409 后源文件未动', existsSync(path.join(root, 'probe/sc.json')));
  check('409 后孤儿 sidecar 未被覆盖（guid 原样）',
    readFileSync(path.join(root, 'probe/orphan-target.json.meta.json'), 'utf8').includes('orphan'));

  // 登记同步覆盖**全部**路径字段：assetRoots/behaviorRoots/defaultStyle/inputMap/
  // gameplayConfig/materialLibrary 都要跟着目录改名走
  writeFileSync(path.join(root, 'aether.project.json'), JSON.stringify({
    schemaVersion: 1,
    scenes: [{ path: 'probe/newdir2/inner/deep.json', name: 'A' }],
    assetRoots: ['probe/newdir2/assets', 'assets'],
    behaviorRoots: ['probe/newdir2/behaviors'],
    defaultStyle: 'probe/newdir2/styles/tokens.json',
    inputMap: 'probe/newdir2/input.json',
    gameplayConfig: 'probe/newdir2/gameplay.json',
    materialLibrary: 'assets/materials/library.mat.json',
  }, null, 2), 'utf8');
  const rnAllFields = await runRename(handler, root, 'probe/newdir2', 'newdir3');
  check('目录改名后 ok (200)', rnAllFields.status === 200);
  const projAll = JSON.parse(readFileSync(path.join(root, 'aether.project.json'), 'utf8'));
  check('scenes[].path 前缀改写', projAll.scenes[0].path === 'probe/newdir3/inner/deep.json');
  check('assetRoots 命中项改写、未命中保留',
    projAll.assetRoots[0] === 'probe/newdir3/assets' && projAll.assetRoots[1] === 'assets');
  check('behaviorRoots 改写', projAll.behaviorRoots[0] === 'probe/newdir3/behaviors');
  check('defaultStyle 改写', projAll.defaultStyle === 'probe/newdir3/styles/tokens.json');
  check('inputMap 改写', projAll.inputMap === 'probe/newdir3/input.json');
  check('gameplayConfig 改写', projAll.gameplayConfig === 'probe/newdir3/gameplay.json');
  check('materialLibrary 未命中保持原样', projAll.materialLibrary === 'assets/materials/library.mat.json');

  // 部分成功：改名落盘但项目文件不可读 → ok:true + projectError（浏览器仍会刷新）
  rmSync(path.join(root, 'aether.project.json'), { force: true });
  mkdirSync(path.join(root, 'aether.project.json'), { recursive: true }); // 目录 → readFile 抛 EISDIR
  const rnPartial = await runRename(handler, root, 'probe/a2.json', 'a3.json');
  check('部分成功：改名 ok=true', rnPartial.status === 200 && rnPartial.body?.ok === true);
  check('部分成功：projectError 如实上报（非空字符串）',
    typeof rnPartial.body?.projectError === 'string' && rnPartial.body.projectError.length > 0,
    rnPartial.body?.projectError ?? '');
  check('部分成功：文件确实已改名', existsSync(path.join(root, 'probe/a3.json'))
    && !existsSync(path.join(root, 'probe/a2.json')));
  rmSync(path.join(root, 'aether.project.json'), { recursive: true, force: true }); // 收尾拆掉假目录
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
