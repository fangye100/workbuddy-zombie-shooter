#!/usr/bin/env node
/**
 * editor-parity —— **跨宿主一致性 + 画面对应 + 保存重开**的实机 harness（docs/17 §8）。
 *
 * ## 为什么它必须入库
 *
 * docs/12 已把「冒烟脚本未入库、结论不可复现」列为 P0 并修过一次。本阶段又退化过：
 * WU-3~WU-6 的四份 `wu*-probe.mjs` 都躺在被 gitignore 的 `.workbuddy/tmp/`，
 * 于是报告里最硬的三条结论（maxΔ=0、像素级命中、保存重开保持）**没有任何人能复跑**。
 * 结论与证据必须一起入库 —— 本文件就是把它们搬回来的地方。
 *
 * ## 三条证明
 *
 *   §8-1  Node 与浏览器同一初始化 / seed / 固定 tick → 逐实体身份、位置、目标、状态一致
 *         比对逻辑**不在本文件里**，而是调用 `runtime-parity.mjs --compare` ——
 *         那份比对才是"两侧一致"这个结论的唯一出处，本文件只负责把浏览器侧快照取出来。
 *   §8-5  选中敌人 → 它在画面上的像素位置 → 用**真实点击入口**回环命中它
 *   §8-6  改 radius → 保存 → **重新打开页面** → 值仍是新值（保存重开保持）
 *
 * ## 🔴 被测对象身份是一条隐含断言
 *
 * 调试端口必须每轮唯一，且接管页面前要用 `performance.now()` 验页面年龄。
 * 用固定端口 + 不等 Chrome 退出，会连上**上一轮的 Chrome 实例**、接管那个旧页面；
 * 旧页面带着上一轮的内存状态（实测 radius 4.75 vs 磁盘 1.5），
 * 症状与真实缺陷无法区分，却能让全部断言一起说谎。
 *
 * ## 用法
 *
 *   npm run runtime:build
 *   npm run verify:parity-host                     # 全跑（含 §8-6，会真写一次场景文件再还原）
 *   node tools/verify/editor-parity.mjs --no-save  # 跳过 §8-6（不想动磁盘时）
 *
 * 退出码：0 全通过；1 有断言失败；2 连不上编辑器 / 启动失败。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_APP = process.env.EDITOR_URL ?? 'https://localhost:5100/';
// 端口每轮唯一 —— 见文件头「被测对象身份是一条隐含断言」
const PORT = 9300 + (process.pid % 600);
const USER_DIR = path.resolve('.workbuddy/tmp/chrome-profile-parity');
const OUT = path.resolve('.workbuddy/tmp');
const SEED = Number(process.env.PARITY_SEED ?? 7);
const TICKS = Number(process.env.PARITY_TICKS ?? 60);
const SKIP_SAVE = process.argv.includes('--no-save');

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`无法连接 ${url}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.messages = [];
    this.wire(ws);
  }
  wire(ws) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p !== undefined) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const txt = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        this.messages.push(`[${msg.params.type}] ${txt}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.messages.push(`[exception] ${msg.params.exceptionDetails?.text ?? ''}`);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails !== undefined) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}

console.log(`启动 headed Chrome（真实 GPU）· 调试端口 ${PORT} …`);
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-webgpu',
    '--ignore-certificate-errors',
    '--window-size=1600,900',
    URL_APP,
  ],
  { stdio: 'ignore' },
);

let exitCode = 1;
try {
  await httpJson(`http://127.0.0.1:${PORT}/json/version`);
  let targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`, 60);
  let page = targets.find((t) => t.type === 'page' && t.url.includes('5100')) ?? targets.find((t) => t.type === 'page');
  if (page === undefined) throw new Error('没有可接管的页面');

  const ws0 = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws0.addEventListener('open', res);
    ws0.addEventListener('error', rej);
  });
  const cdp = new Cdp(ws0);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // ---- 验明正身：只接受本轮刚打开的页面
  const bootAge = async () => {
    try {
      return Number(await cdp.eval(`Math.round(performance.now())`));
    } catch {
      return null;
    }
  };
  const ADOPT_MAX_MS = 30_000;
  let age = await bootAge();
  if (!String(page.url).includes('5100') || age === null || age > ADOPT_MAX_MS) {
    console.log(`  接管页面不新鲜（age=${age}ms）→ 新开一个 tab`);
    const created = await cdp.send('Target.createTarget', { url: URL_APP });
    const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    const fresh = list.find((t) => t.id === created.targetId);
    ws0.close();
    const ws2 = new WebSocket(fresh.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws2.addEventListener('open', res);
      ws2.addEventListener('error', rej);
    });
    cdp.ws = ws2;
    cdp.pending.clear();
    cdp.wire(ws2);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await sleep(3000);
    age = await bootAge();
  }
  console.log(`  页面新鲜度 age=${age}ms（接管阈值 ${ADOPT_MAX_MS}ms）`);
  check('接管的页面是本轮新开的', age !== null && age <= ADOPT_MAX_MS, `age=${age}ms`);

  // 关掉 HTTP 缓存：要验的是"同一份场景 → 同一结果"，不是缓存行为
  try {
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.clearBrowserCache');
  } catch {
    /* 网络域不可用不影响其余断言 */
  }

  async function waitReady(label) {
    for (let i = 0; i < 90; i++) {
      const s = await cdp.eval(`(() => {
        const f = document.getElementById('fatal');
        if (f && getComputedStyle(f).display !== 'none') return 'FATAL';
        return (window.__editor && window.__editor.spawn && window.__editor.spawn.state().spawnCount > 0) ? 'READY' : 'BOOTING';
      })()`);
      if (s === 'READY') return;
      if (s === 'FATAL') throw new Error(`${label} 致命错误：` + (await cdp.eval(`document.getElementById('fatal-body')?.innerText ?? ''`)));
      await sleep(1000);
    }
    throw new Error(`${label} 启动超时`);
  }
  await waitReady('首次加载');

  const st = () => cdp.eval(`window.__editor.spawn.state()`);
  const call = (expr) => cdp.eval(`window.__editor.spawn.${expr}`);

  // ================================================================ §8-1
  console.log('\n──── §8-1：Node 与浏览器同源同输入一致性 ────');
  const scenePath = String((await st()).scenePath ?? '').replace(/^\/+/, '');
  check('拿到浏览器实际加载的场景路径', scenePath.length > 0, scenePath);

  const webSnap = await cdp.eval(`window.__editor.runtime.runTo(${SEED}, ${TICKS})`);
  check('浏览器侧取样成功', webSnap.ok === true, webSnap.ok ? `tick ${webSnap.tick}` : String(webSnap.error));

  // 比对逻辑**不在本 harness 里**：交给入库的 runtime-parity.mjs --compare。
  // 这样"两侧一致"这条结论只有一个出处，任何人都能单独复跑它。
  const webFile = path.join(OUT, `parity-web-seed${SEED}.json`);
  fs.writeFileSync(webFile, JSON.stringify(webSnap, null, 2), 'utf8');
  const cmp = spawnSync(
    process.execPath,
    ['tools/verify/runtime-parity.mjs', '--compare', webFile, '--scene', scenePath, '--seed', String(SEED), '--ticks', String(TICKS)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const cmpLines = String(cmp.stdout ?? '').trim().split('\n').filter(Boolean);
  for (const l of cmpLines) console.log('  ' + l);
  check(
    '🔴 逐实体身份 / 位置 / 目标 / 状态一致（由 runtime-parity --compare 判定）',
    cmp.status === 0,
    cmpLines.find((l) => l.includes('maxΔ'))?.trim() ?? `exit=${cmp.status} ${String(cmp.stderr ?? '').slice(0, 200)}`,
  );

  // 换种子再比一次：证明不是"碰巧都走同一条默认路径"
  const seed2 = SEED + 41;
  const webSnap2 = await cdp.eval(`window.__editor.runtime.runTo(${seed2}, ${TICKS})`);
  const webFile2 = path.join(OUT, `parity-web-seed${seed2}.json`);
  fs.writeFileSync(webFile2, JSON.stringify(webSnap2, null, 2), 'utf8');
  const cmp2 = spawnSync(
    process.execPath,
    ['tools/verify/runtime-parity.mjs', '--compare', webFile2, '--scene', scenePath, '--seed', String(seed2), '--ticks', String(TICKS)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  check('换种子后仍一致', cmp2.status === 0, `exit=${cmp2.status}`);
  check(
    '不同种子确实产生不同结果（一致性不是恒等）',
    JSON.stringify(webSnap2.entities.map((e) => e.x)) !== JSON.stringify(webSnap.entities.map((e) => e.x)),
    '',
  );

  // ================================================================ §8-5
  console.log('\n──── §8-5：选中的敌人在画面中对应得到 ────');
  await cdp.eval(`document.querySelector('#btn-play').click(); 'ok'`);
  // 🔴 不能只 sleep 固定时长就断言：机器有并发负载 / 冷启动时，1.5s 后世界可能还没跑起来，
  // §8-5 三条会一起挂（实测 10 次里挂 4 次）。改成**轮询到条件成立**为止。
  const waitEntity = async (timeoutMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const n = await cdp.eval(`(window.__editor.bridge.active ? window.__editor.bridge.entities.length : 0)`);
      if (Number(n) > 0) return Number(n);
      await sleep(400);
    }
    return 0;
  };
  const spawned = await waitEntity(30_000);
  check('Play 后世界里真的有运行时实体', spawned > 0, `${spawned} 个（轮询等待，最多 30s）`);

  const picked = await call('pickFirstNpc()');
  check('Play 中选中一个运行敌人', picked !== null && picked !== undefined, JSON.stringify(picked));

  // 冻结运行：不暂停的话投影取的是这一帧、点到的是下一帧的位置
  await cdp.eval(`document.querySelector('#btn-pause').click(); 'ok'`);
  // 暂停后还要等画面真的画过一帧 —— 否则 viewProj 可能还是上一帧（甚至未初始化）的
  const f0 = Number(await cdp.eval(`window.__editor.renderer.state.frameCounter`));
  for (let i = 0; i < 60; i++) {
    const f = Number(await cdp.eval(`window.__editor.renderer.state.frameCounter`));
    if (f > f0 + 1) break;
    await sleep(200);
  }

  // ⚠️ 不去动相机。Play 期间渲染用的不是 `__editor.camera`（那是编辑相机的 UI 状态），
  // 试图"把相机对准它"会让投影落到近平面上爆成 x=12683 —— 那是探针在自欺欺人。
  // 正确做法：在当前画面里挑一只真的看得见的僵尸。
  const locateEval = `(() => {
    const r = window.__editor.renderer;
    const rect = document.getElementById('gpu').getBoundingClientRect();
    const M = 24;
    const inside = (p) => p.x > rect.left + M && p.x < rect.right - M && p.y > rect.top + M && p.y < rect.bottom - M;
    const eye = r.picking.getEye();
    const cands = [];
    for (const e of window.__editor.bridge.entities) {
      const p = r.worldToScreen([e.x, 0.9, e.z]);
      if (p.behind || !inside(p)) continue;
      cands.push({ e, p, d: Math.hypot(e.x - eye[0], 0.9 - eye[1], e.z - eye[2]) });
    }
    if (cands.length === 0) return { ok: false, why: '画面里没有可见实体', eye: eye.map((v) => +v.toFixed(2)) };
    cands.sort((a, b) => a.d - b.d);
    const { e, p } = cands[0];
    const target = { id: e.id, generation: e.generation, sourceNodeId: e.sourceNodeId, targetId: e.targetId, behavior: e.behavior };
    // 走**真实点击**那一条路（mousedown → pickAtClient）
    window.__editor.bridge.clearSelection();
    window.__editor.pickAtClient(p.x, p.y);
    const sel = window.__editor.bridge.selectedEntity;
    let back = null;
    if (sel !== null) {
      const q = r.worldToScreen([sel.x, 0.9, sel.z]);
      back = { id: sel.id, generation: sel.generation, dx: Math.abs(q.x - p.x), dy: Math.abs(q.y - p.y) };
    }
    return {
      ok: true,
      visible: cands.length,
      picked: target,
      screen: { x: p.x, y: p.y },
      hit: sel === null ? null : { id: sel.id, generation: sel.generation },
      back,
    };
  })()`;
  // 同样要重试：相机取景 / canvas 尺寸在冷启动时可能还没稳定，
  // 一次性判定会把"还没画好"误报成"画面对应失败"。
  let locate = await cdp.eval(locateEval);
  let attempts = 1;
  while (locate.ok !== true && attempts < 20) {
    await sleep(500);
    locate = await cdp.eval(locateEval);
    attempts++;
  }
  check(
    '画面里能找到可见的运行时实体',
    locate.ok === true,
    locate.ok
      ? `${locate.visible} 只可见 · 目标 #${locate.picked.id}·代${locate.picked.generation} @ (${locate.screen.x.toFixed(1)}, ${locate.screen.y.toFixed(1)})px`
      : `${String(locate.why)} · eye=${JSON.stringify(locate.eye)} · 已重试 ${attempts} 次`,
  );
  check('🔴 点在它的像素位置上能选中运行时实体（真实点击入口）', locate.ok === true && locate.hit != null,
    locate.hit == null ? '点下去什么都没选中' : `选中 #${locate.hit.id}·代${locate.hit.generation}`);
  check(
    '🔴 选中的就是画面上那一只（投影回屏幕与点击点 ≤ 2px）',
    locate.ok === true && locate.back != null && locate.back.id === locate.picked?.id && locate.back.dx <= 2 && locate.back.dy <= 2,
    locate.back == null ? '无' : `#${locate.back.id}·代${locate.back.generation} Δ=(${locate.back.dx.toFixed(2)}, ${locate.back.dy.toFixed(2)})px`,
  );

  // 收尾 Stop（§8-6 要写盘，别让 Play 会话挂在上面）
  await cdp.eval(`document.querySelector('#btn-stop').click(); 'ok'`);
  await sleep(800);

  // ================================================================ §8-6
  if (SKIP_SAVE) {
    console.log('\n──── §8-6：已按 --no-save 跳过 ────');
  } else {
    console.log('\n──── §8-6：保存重开保持 ────');
    const origText = await cdp.eval(
      `(async () => { const r = await fetch('/__fs/file?path=' + encodeURIComponent(${JSON.stringify(scenePath)})); return await r.text(); })()`,
    );
    check('磁盘原文可读', typeof origText === 'string' && origText.length > 100, `${origText.length} 字符`);

    const radiusOf = (doc, id) => {
      if (doc === null || !Array.isArray(doc.nodes)) return null;
      for (const n of doc.nodes) for (const c of n.components) if (n.id === id && c.kind === 'SpawnPoint') return c.radius;
      return null;
    };
    const origJson = JSON.parse(origText);
    let s = await st();
    const nodeId = s.selectedNodeId;
    const target = (radiusOf(origJson, nodeId) ?? 1.5) + 3.25;

    // 🔴 刻意改**两个**刷怪点再保存。
    // 保存自检曾经写成"改动必须恰好一条"，结果把"连续改两个点"这个合法操作给拒了
    // （复审抓出来的回归）。这条用例就是它的守卫：多节点编辑必须能正常存盘。
    const docJson = JSON.parse(await cdp.eval(`window.__editor.runtime.docJson()`));
    const spawnIds = (docJson.nodes ?? [])
      .filter((n) => (n.components ?? []).some((c) => c.kind === 'SpawnPoint'))
      .map((n) => n.id);
    const secondId = spawnIds.find((id) => id !== nodeId) ?? null;
    const target2 = secondId === null ? null : (radiusOf(origJson, secondId) ?? 1.5) + 2.25;

    try {
      await call(`select(${JSON.stringify(nodeId)})`);
      await call(`edit('radius', ${target})`);
      if (secondId !== null) {
        await call(`select(${JSON.stringify(secondId)})`);
        await call(`edit('radius', ${target2})`);
      }
      await sleep(300);
      await call('save()');
      await sleep(900);
      s = await st();
      check(
        '保存成功且 dirty 归零',
        String(s.message).includes('已保存') && s.dirty === false,
        String(s.message),
      );
      check(
        '🔴 多节点编辑不会被保存自检误拒（回归守卫）',
        secondId === null || (String(s.message).includes('已保存') && !String(s.message).includes('拒绝保存')),
        secondId === null ? '场景只有一个刷怪点，跳过' : `第二个点 ${secondId} → ${target2}`,
      );

      const afterText = await cdp.eval(
        `(async () => { const r = await fetch('/__fs/file?path=' + encodeURIComponent(${JSON.stringify(scenePath)})); return await r.text(); })()`,
      );
      const afterJson = JSON.parse(afterText);
      check(
        '磁盘 radius 已是新值',
        Math.abs(radiusOf(afterJson, nodeId) - target) < 1e-6,
        `${radiusOf(origJson, nodeId)} → ${radiusOf(afterJson, nodeId)}`,
      );
      if (secondId !== null) {
        check(
          '第二个刷怪点的改动也落盘了',
          Math.abs(radiusOf(afterJson, secondId) - target2) < 1e-6,
          `${radiusOf(origJson, secondId)} → ${radiusOf(afterJson, secondId)}`,
        );
      }

      // **重开**：整页重载，场景从磁盘重新读一遍 —— 这是"保存重开保持"的唯一硬证据
      await cdp.send('Page.reload', { ignoreCache: true });
      await sleep(2500);
      await waitReady('重载后');
      const s2 = await st();
      check('🔴 重新打开页面后 radius 仍是新值', Math.abs((s2.radius ?? -1) - target) < 1e-6, `重载后 radius=${s2.radius}（期望 ${target}）`);
      check('重开后没有残留未保存改动', s2.dirty === false && s2.undoDepth === 0, `dirty=${s2.dirty} undo=${s2.undoDepth}`);

      // ── 保存竞态（复审 #1 的验收场景）──
      // 「发送 radius 2 → 等待写盘期间改成 3 → 保存返回后，3 仍为未保存修改」
      const race = await cdp.eval(`(async () => {
        window.__editor.spawn.select(${JSON.stringify(nodeId)});
        window.__editor.spawn.edit('radius', ${target + 1});
        const p = window.__editor.spawn.save(); // 序列化的是 target+1，之后才开始写盘
        window.__editor.spawn.edit('radius', ${target + 2}); // 等待期间作者继续改
        await p;
        return window.__editor.spawn.state();
      })()`);
      check(
        '🔴 保存竞态：快照之后的编辑不被吞（仍是未保存、可撤销）',
        race.dirty === true && race.undoDepth === 1 && Math.abs(race.radius - (target + 2)) < 1e-6,
        JSON.stringify({ dirty: race.dirty, undo: race.undoDepth, radius: race.radius }),
      );
      // 清理竞态状态：撤回后工作副本回到已提交版本（target+1），与磁盘一致
      await call('revertAll()');
      s = await st();
      check('竞态后撤回，工作副本与磁盘一致（dirty 归零）', s.dirty === false && Math.abs(s.radius - (target + 1)) < 1e-6, `radius=${s.radius}`);

      // ── 外部修改冲突（复审 #2）──
      // 外部把磁盘改掉，此时再保存：绝不能静默覆盖对方，本地编辑要保留
      const extJson = JSON.parse(await cdp.eval(
        `(async () => { const r = await fetch('/__fs/file?path=' + encodeURIComponent(${JSON.stringify(scenePath)})); return await r.text(); })()`,
      ));
      for (const n of extJson.nodes) for (const c of n.components) if (n.id === nodeId && c.kind === 'SpawnPoint') c.radius = 99;
      const extText = JSON.stringify(extJson, null, 2);
      await cdp.eval(
        `(async () => {
          const r = await fetch('/__fs/write', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: ${JSON.stringify(scenePath)}, content: ${JSON.stringify(extText)} }) });
          return await r.json();
        })()`,
      );
      await call(`select(${JSON.stringify(nodeId)})`);
      await call(`edit('radius', ${target + 3})`);
      await call('save()');
      await sleep(900);
      s = await st();
      check(
        '🔴 外部修改冲突：拒绝覆盖对方内容（不写盘、本地编辑保留）',
        String(s.message).includes('外部修改') && s.dirty === true && Math.abs(s.radius - (target + 3)) < 1e-6,
        String(s.message).slice(0, 120),
      );
      const stillExt = radiusOf(
        JSON.parse(await cdp.eval(
          `(async () => { const r = await fetch('/__fs/file?path=' + encodeURIComponent(${JSON.stringify(scenePath)})); return await r.text(); })()`,
        )),
        nodeId,
      );
      check('磁盘仍是外部写入的值（没被这次保存覆盖）', stillExt === 99, `磁盘 radius=${stillExt}`);
      await call('revertAll()');
    } finally {
      // 🔴 还原必须放 finally：任何断言抛错都不能把改动留在用户资产上
      const restore = await cdp.eval(
        `(async () => {
          const r = await fetch('/__fs/write', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: ${JSON.stringify(scenePath)}, content: ${JSON.stringify(origText)} }) });
          return await r.json();
        })()`,
      );
      const backText = await cdp.eval(
        `(async () => { const r = await fetch('/__fs/file?path=' + encodeURIComponent(${JSON.stringify(scenePath)})); return await r.text(); })()`,
      );
      check('场景文件已还原（与原文逐字节一致）', backText === origText, JSON.stringify(restore));
    }
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'editor-parity.png'), Buffer.from(shot.data, 'base64'));
  console.log(`截图 ${path.join(OUT, 'editor-parity.png')}`);

  const bad = cdp.messages.filter((m) => /error|exception|invalid|WGSL|Tint/i.test(m));
  console.log('---- console 可疑项 ----');
  console.log(bad.length === 0 ? '(无)' : bad.slice(0, 20).join('\n'));
  check('无 console 错误 / 异常', bad.length === 0, `${bad.length} 条`);
} finally {
  // 必须等进程真的退出：上一轮残留会让下一轮接管它的旧页面
  chrome.kill();
  await new Promise((r) => {
    const t = setTimeout(r, 8000);
    chrome.once('exit', () => {
      clearTimeout(t);
      r();
    });
  });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n===== ${results.length - failed} PASS / ${failed} FAIL =====`);
process.exit(failed === 0 ? 0 : 1);
