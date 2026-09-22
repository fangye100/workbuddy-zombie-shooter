/**
 * mcp-binding 探针的自检客户端：esbuild 打包领域层 → spawn server.mjs →
 * 走 initialize → tools/list → load 真实 GLB → 摆关节 → 渲染 PNG 解码验证 →
 * undo/redo → save/hydrate 闭环，每步断言。退出码 0 = 链路全通。
 *
 * 用法：node tools/mcp-binding/probe.mjs   （或 pnpm run mcp-binding:check）
 *
 * 纪律：probe 绝不碰真实资产的 sidecar —— 测试模型是复制到
 * .workbuddy/tmp/mcp-binding-probe/ 的副本（已 gitignore），save 只落在那里。
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SERVER = path.resolve(HERE, 'server.mjs');
const TMP = path.resolve(REPO_ROOT, '.workbuddy', 'tmp', 'mcp-binding-probe');

/** 测试模型：最小的真实角色 GLB（30KB，E-04 游戏档）。勿用 _broken_backup_ 目录的副本 */
const FIXTURE_GLB = 'assets/characters/models/E-04/game_ready/E04_20260901_010134_1600tris.glb';

// ── ① 构建领域层 bundle（esbuild JS API；root devDep 链已带 esbuild） ──
const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [path.resolve(HERE, 'src', 'domain-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.resolve(HERE, 'dist', 'domain.mjs'),
  tsconfig: path.resolve(REPO_ROOT, 'tsconfig.check.json'),
  logLevel: 'silent',
});
console.log('build: dist/domain.mjs OK');

// ── ② 准备隔离的测试模型副本（+ 真实 sidecar，save 要求 sidecar 已存在） ──
mkdirSync(TMP, { recursive: true });
copyFileSync(path.resolve(REPO_ROOT, FIXTURE_GLB), path.resolve(TMP, 'probe.glb'));
const fixtureMeta = `${FIXTURE_GLB}.meta.json`;
const hasMeta = existsSync(path.resolve(REPO_ROOT, fixtureMeta));
if (hasMeta) {
  copyFileSync(path.resolve(REPO_ROOT, fixtureMeta), path.resolve(TMP, 'probe.glb.meta.json'));
}
// hydrated 的期望真值 = sidecar 存在且确有 bindingEditor 槽位（有文件没槽位也不算回填）
const origMeta = (() => {
  if (!hasMeta) return null;
  try {
    return JSON.parse(readFileSync(path.resolve(REPO_ROOT, fixtureMeta), 'utf8'));
  } catch {
    return null;
  }
})();
const expectHydrated =
  origMeta?.bindingEditor !== undefined && origMeta?.bindingEditor !== null;
const PROBE_GLB = '.workbuddy/tmp/mcp-binding-probe/probe.glb';

// ── ③ spawn server + NDJSON 客户端骨架（同 mcp-hello probe 的模式） ──
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg !== null && typeof msg === 'object' && 'id' in msg && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if ('error' in msg) p.reject(new Error(`RPC ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }
});

function call(method, params = undefined) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve,
      reject,
      timer: setTimeout(() => reject(new Error(`超时: ${method}`)), 15000),
    });
  });
}

function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
}

/** 单独验证版本协商（initialize 一会话一次，另起短命子进程） */
function negotiate(version) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
    let b = '';
    const finish = (v) => { clearTimeout(timer); c.kill(); resolve(v); };
    const timer = setTimeout(() => finish(null), 5000);
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      b += chunk;
      const nl = b.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try { msg = JSON.parse(b.slice(0, nl).trim()); } catch { return; }
      finish(msg?.result?.protocolVersion ?? null);
    });
    c.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'probe', version: '0.2.0' } },
    }) + '\n');
  });
}

/** 解 PNG：返回 {width, height, nonWhite}；非白像素数证明模型真的画上了 */
function decodePngStats(b64) {
  const png = Buffer.from(b64, 'base64');
  const sig = '89504e470d0a1a0a';
  if (png.subarray(0, 8).toString('hex') !== sig) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (1 + width * 4)) return null;
  let nonWhite = 0;
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4) + 1; // 跳 filter 字节
    for (let x = 0; x < width; x++) {
      const o = row + x * 4;
      if (raw[o] < 250 || raw[o + 1] < 250 || raw[o + 2] < 250) nonWhite++;
    }
  }
  return { width, height, nonWhite, bytes: png.length };
}

const tool = async (name, args = {}) => {
  const r = await call('tools/call', { name, arguments: args });
  return r;
};
/** 取工具的 JSON 文本块 */
const toolJson = async (name, args = {}) => {
  const r = await tool(name, args);
  const t = r?.content?.find((c) => c.type === 'text');
  return t !== undefined ? JSON.parse(t.text) : null;
};

const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
};

try {
  // ── 握手与版本协商（PR #9 同款纪律） ──
  const init = await call('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0.2.0' },
  });
  check('initialize 返回 serverInfo', init?.serverInfo?.name === 'aether-binding');
  check('协议版本回显支持集内的客户端版本', init?.protocolVersion === '2025-03-26');
  check('不支持版本回己方支持版本', (await negotiate('1999-01-01')) === '2025-06-18');
  notify('notifications/initialized');

  // ── 工具表 ──
  const list = await call('tools/list');
  const names = (list?.tools ?? []).map((t) => t.name);
  const EXPECT = [
    'load_model', 'get_state', 'get_joints', 'set_joint', 'mirror', 'reset_pose',
    'undo', 'redo', 'cylinders', 'set_options', 'compute_skin', 'render',
    'get_editor_data', 'save', 'hydrate',
  ];
  check('tools/list 含全部 15 个工具', EXPECT.every((n) => names.includes(n)) && names.length === EXPECT.length);

  // ── 前置条件：未载入模型时的错误路径（独立审核 P2 覆盖盲区） ──
  const preRender = await tool('render', {}).then(() => null, (e) => String(e));
  check('未载入模型 render 报 -32602', typeof preRender === 'string' && preRender.includes('-32602'));
  const preSkin = await tool('compute_skin').then(() => null, (e) => String(e));
  check('未载入模型 compute_skin 报 -32602', typeof preSkin === 'string' && preSkin.includes('-32602'));
  const preSave = await tool('save').then(() => null, (e) => String(e));
  check('未载入模型 save 报 -32602', typeof preSave === 'string' && preSave.includes('-32602'));

  // ── 路径防护：目录穿越与绝对路径都必须拒（独立审核 P2 覆盖盲区） ──
  const trav = await tool('load_model', { path: '../../outside.glb' }).then(() => null, (e) => String(e));
  check('目录穿越被拒（..）', typeof trav === 'string' && trav.includes('路径越出仓库'));
  const absPath = await tool('load_model', { path: 'C:/Windows/x.glb' }).then(() => null, (e) => String(e));
  check('绝对路径被拒（盘符路径跨平台拒绝）', typeof absPath === 'string' && absPath.includes('-32602') && absPath.includes('路径'));
  const notGlb = await tool('load_model', { path: 'package.json' }).then(() => null, (e) => String(e));
  check('非 .glb 被拒', typeof notGlb === 'string' && notGlb.includes('.glb'));

  // ── 载入真实 GLB ──
  const loaded = await toolJson('load_model', { path: PROBE_GLB });
  check('load_model 返回网格规模', loaded?.vertices > 0 && loaded?.triangles > 0);
  check('load_model 按 sidecar 有无回填 hydrated', loaded?.hydrated === expectHydrated);

  const state = await toolJson('get_state');
  check('get_state 默认选项（wrapper / 4 次平滑）',
    state?.options?.weightMode === 'wrapper' && state?.options?.smoothIters === 4);

  const joints = await toolJson('get_joints');
  const headBefore = joints?.positions?.Head;
  check('get_joints 返回 27 关节', joints?.order?.length === 27 && Array.isArray(headBefore));

  // ── 撤销粒度：两次连续 set_joint 必须各是一步（P1-2 回归：800ms 合并窗已封口） ──
  const neckBefore = joints?.positions?.Neck;
  await toolJson('set_joint', { name: 'Head', position: [0, headBefore[1] + 0.05, 0] });
  await toolJson('set_joint', { name: 'Neck', position: [0, neckBefore[1] + 0.05, 0] });
  await toolJson('undo');
  const afterOneUndo = await toolJson('get_joints');
  check('undo 只回退最近一步（合并窗已封口）',
    afterOneUndo?.positions?.Neck?.[1] === neckBefore[1] &&
    Math.abs(afterOneUndo?.positions?.Head?.[1] - (headBefore[1] + 0.05)) < 1e-9);
  await toolJson('undo');
  const afterTwoUndo = await toolJson('get_joints');
  check('再 undo 回退上一步', afterTwoUndo?.positions?.Head?.[1] === headBefore[1]);
  const redo = await toolJson('redo');
  check('redo 重做', redo?.done === true);
  await toolJson('undo'); // 还原到模板态，后续断言从干净状态开始

  // ── 参数校验错误路径（含 P1-1 回归：原型链键必须被白名单拒掉） ──
  const badBone = await tool('set_joint', { name: 'Nope', position: [0, 0, 0] }).then(
    () => null, (e) => String(e),
  );
  check('未知关节报 -32602', typeof badBone === 'string' && badBone.includes('-32602') && badBone.includes('未知'));
  const protoBone = await tool('set_joint', { name: 'constructor', position: [0, 1, 0] }).then(
    () => null, (e) => String(e),
  );
  check('原型链键 constructor 被白名单拒（P1-1）', typeof protoBone === 'string' && protoBone.includes('-32602'));
  const protoCyl = await tool('cylinders', { action: 'setRadius', bone: 'constructor', seg: 'top', value: 0.1 }).then(
    () => null, (e) => String(e),
  );
  check('cylinders 原型链键同样被拒且非 -32603（P1-1）',
    typeof protoCyl === 'string' && protoCyl.includes('-32602') && !protoCyl.includes('-32603'));
  const badVec = await tool('set_joint', { name: 'Head', position: [0, null, 0] }).then(
    () => null, (e) => String(e),
  );
  check('非法坐标报 -32602', typeof badVec === 'string' && badVec.includes('-32602'));

  // ── 导出选项钳制（面板同款规则） ──
  const opts = await toolJson('set_options', { smoothIters: 99, smoothLambda: 5 });
  check('set_options 钳制（99→12，5→1）', opts?.applied?.smoothIters === 12 && opts?.applied?.smoothLambda === 1);
  await toolJson('set_options', { smoothIters: 4, smoothLambda: 0.5 }); // 还原默认值

  // ── set_options 多字段 = 一步历史（PR #10 评审回归） ──
  {
    const before = (await toolJson('get_state'))?.options;
    await toolJson('set_options', { weightMode: 'distance', smoothWeights: false, smoothIters: 7 });
    await toolJson('undo');
    const after = (await toolJson('get_state'))?.options;
    check('set_options 多字段一步 undo 全回退',
      after?.weightMode === before?.weightMode &&
      after?.smoothWeights === before?.smoothWeights &&
      after?.smoothIters === before?.smoothIters);
  }

  // ── 半径必须为正（0/负数会被蒙皮静默替换成 1e-6 并持久化非法值） ──
  const zeroR = await tool('cylinders', { action: 'setRadius', bone: 'LeftArm', seg: 'top', value: 0 }).then(
    () => null, (e) => String(e),
  );
  check('半径 0 被拒（-32602 必须为正）', typeof zeroR === 'string' && zeroR.includes('-32602') && zeroR.includes('正'));

  // ── wrapper 圆柱体 ──
  const cyls = await toolJson('cylinders', { action: 'get' });
  check('cylinders get 有 LeftArm', cyls?.cylinders?.LeftArm?.radii !== undefined);
  const setR = await toolJson('cylinders', { action: 'setRadius', bone: 'LeftArm', seg: 'medium', value: 0.2 });
  check('cylinders setRadius 生效', setR?.ok === true && Math.abs(setR?.cylinder?.radii?.medium - 0.2) < 1e-9);
  const setOff = await toolJson('cylinders', { action: 'setOffset', bone: 'LeftArm', offset: [0.01, 0, 0] });
  check('cylinders setOffset 生效', setOff?.ok === true && Math.abs(setOff?.offset?.[0] - 0.01) < 1e-9);
  const clrOff = await toolJson('cylinders', { action: 'clearOffset', bone: 'LeftArm' });
  check('cylinders clearOffset 归零', clrOff?.ok === true && clrOff?.offset?.every((v) => v === 0));
  const autoF = await toolJson('cylinders', { action: 'autoFit' });
  check('cylinders autoFit 返回 changed 列表', Array.isArray(autoF?.changed));
  const unpin = await toolJson('cylinders', { action: 'unpin', bone: 'LeftUpLeg' });
  check('cylinders unpin 生效', unpin?.ok === true && unpin?.cylinder?.manual === false);
  const mirC = await toolJson('cylinders', { action: 'mirror', bone: 'LeftArm' });
  check('cylinders mirror 单骨生效', mirC?.ok === true);
  const mirAll = await toolJson('cylinders', { action: 'mirrorAll' });
  check('cylinders mirrorAll 生效', mirAll?.ok === true);
  const badAction = await tool('cylinders', { action: 'explode' }).then(() => null, (e) => String(e));
  check('cylinders 未知 action 报 -32602', typeof badAction === 'string' && badAction.includes('-32602'));

  // ── 骨架镜像与重置 ──
  const mir = await toolJson('mirror', { dir: 'L2R' });
  check('mirror L2R 生效', mir?.ok === true);
  const badDir = await tool('mirror', { dir: 'X2Y' }).then(() => null, (e) => String(e));
  check('mirror 非法 dir 报 -32602', typeof badDir === 'string' && badDir.includes('-32602'));
  const rst = await toolJson('reset_pose');
  check('reset_pose 生效', rst?.ok === true);

  // ── 权重计算统计 ──
  const skin = await toolJson('compute_skin');
  check('compute_skin 返回统计', typeof skin?.unwrappedVerts === 'number' && skin?.vertices > 0);

  // ── 渲染：PNG 解码验证 ──
  const r1 = await tool('render', { view: 'front' });
  const img1 = r1?.content?.find((c) => c.type === 'image');
  const png1 = img1 !== undefined ? decodePngStats(img1.data) : null;
  check('render front 产出 480×640 PNG', png1 !== null && png1.width === 480 && png1.height === 640);
  check('render front 画上了内容（非白像素 > 500）', png1 !== null && png1.nonWhite > 500);

  const r2 = await tool('render', { view: 'front', heatBone: 'Head' });
  const img2 = r2?.content?.find((c) => c.type === 'image');
  check('render heatBone 产出图像且与无热力不同', img2 !== undefined && img2.data !== img1?.data);

  const r3 = await tool('render', { view: 'side', width: 200, height: 400 });
  const img3 = r3?.content?.find((c) => c.type === 'image');
  const png3 = img3 !== undefined ? decodePngStats(img3.data) : null;
  check('render side 自定义尺寸 200×400', png3 !== null && png3.width === 200 && png3.height === 400);

  const heatTip = await tool('render', { heatBone: 'HeadTip' }).then(
    () => null, (e) => String(e),
  );
  check('tip 骨画热力被拒（不参与蒙皮）', typeof heatTip === 'string' && heatTip.includes('tip'));
  const heatBad = await tool('render', { heatBone: 'Nope' }).then(
    () => null, (e) => String(e),
  );
  check('未知 heatBone 被拒', typeof heatBad === 'string' && heatBad.includes('-32602'));

  // ── 持久化闭环：save → 读盘验证（逐键深比较，防「不碰其他键」断言空转） → hydrate ──
  const saved = await toolJson('save');
  const metaOnDisk = existsSync(path.resolve(TMP, 'probe.glb.meta.json'))
    ? JSON.parse(readFileSync(path.resolve(TMP, 'probe.glb.meta.json'), 'utf8'))
    : null;
  check('save 落盘且含 bindingEditor.positions',
    saved?.path?.endsWith('probe.glb.meta.json') === true &&
    metaOnDisk?.bindingEditor?.positions?.Head !== undefined);
  check('save 不碰 sidecar 其他键（逐键深比较）',
    origMeta !== null && metaOnDisk !== null &&
    Object.keys(origMeta).every((k) => JSON.stringify(origMeta[k]) === JSON.stringify(metaOnDisk[k])));
  const hyd = await toolJson('hydrate');
  check('hydrate 从 sidecar 回灌', hyd?.hydrated === true);

  const unknown = await tool('nope').then(() => null, (e) => String(e));
  check('未知工具返回 -32602', typeof unknown === 'string' && unknown.includes('-32602'));
} catch (err) {
  check(`链路异常：${String(err)}`, false);
} finally {
  child.kill();
}

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
