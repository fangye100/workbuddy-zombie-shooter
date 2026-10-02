/**
 * 编辑器冒烟共享库（2026-09-23 拆分，docs/21 报告落地）。
 *
 * editor-smoke.mjs（核心套件：A~J2 + N）与 editor-binding-smoke.mjs（绑定套件：
 * K~L3 + MCP 探针）共用：断言记账、条件轮询 waitFor、dev server 探活/自起、
 * Chrome 启动 + CDP 会话接线、起始场景真源推导。原来全部内联在单文件里，
 * 拆分后两侧各自 import，改帮助器只改一处。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 条件轮询（docs/21 §2.4）：条件成立立即返回，超时返回最后一次取值。
 * 取代按最慢机器取值的固定 sleep——快机器省 30~60% 等待，慢机器不会因
 * 固定值不够长而假失败。fn 抛异常按「未就绪」处理（页面上文还没到）。
 * @returns 条件成立时的真值，或超时的最后一次假值
 */
export async function waitFor(fn, { timeout = 15000, interval = 200, label = '' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
    } catch {
      last = false;
    }
    if (last) return last;
    if (Date.now() - t0 > timeout) {
      if (label !== '') console.log(`  （waitFor 超时 ${timeout}ms：${label}）`);
      return last;
    }
    await sleep(interval);
  }
}

// ---------------------------------------------------------------- 断言记账

export function createRecorder() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const skip = (name, why) => {
    results.push({ name, skipped: true, detail: why });
    console.log(`  [SKIP] ${name} — ${why}`);
  };
  const summary = (consoleErrors, exceptions) => {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`断言：${passed} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`);
    console.log(`CONSOLE ERRORS: ${consoleErrors.length}`);
    for (const e of consoleErrors.slice(0, 10)) console.log(`   ! ${e.slice(0, 200)}`);
    console.log(`EXCEPTIONS: ${exceptions.length}`);
    for (const e of exceptions.slice(0, 10)) console.log(`   ! ${e.slice(0, 200)}`);
    console.log('='.repeat(60));
    const ok = failed === 0 && consoleErrors.length === 0 && exceptions.length === 0;
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    return ok ? 0 : 1;
  };
  return { results, check, skip, summary };
}

// ---------------------------------------------------------------- 参数

export function makeArgParser(argv) {
  const args = argv.slice(2);
  const arg = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
  };
  const has = (name) => args.includes(`--${name}`);
  return { arg, has };
}

// ---------------------------------------------------------------- dev server

// HTTPS 是常态不是例外：本机 vite.config 检测到 Tailscale 证书会自动开 https，
// 此时 curl/http 探测返回 000，得忽略自签证书。用原生 http/https 而非 fetch(undici)：
// undici 在自签证书下 TLS 握手会挂。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function aliveRaw(url, timeoutMs = 8000) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function alive(url, timeoutMs = 8000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return aliveRaw(url, timeoutMs);
  }
}

async function probe(port) {
  for (const proto of ['https', 'http']) {
    const url = `${proto}://localhost:${port}/`;
    if (await alive(url)) return url;
  }
  return null;
}

/**
 * 探活 + 按需自起 dev server。@returns {server|null, url}——server 为 null
 * 表示复用已运行的实例（不负责关它）。
 */
export async function ensureServer(port, viteConfig) {
  const existing = await probe(port);
  if (existing !== null) {
    console.log(`dev server 已在 ${existing}（复用，不新建）`);
    return { server: null, url: existing };
  }
  console.log(`dev server 未起，启动 vite --config ${viteConfig}`);
  const server = spawn(
    process.execPath,
    [path.resolve('node_modules/vite/bin/vite.js'), '--config', viteConfig, '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // vite 往 pipe 写带 ANSI 颜色码，会把 localhost:5188 拆成 localhost:\x1b[1m5188\x1b[22m
  let out = '';
  server.stdout.on('data', (b) => { out += String(b); });
  server.stderr.on('data', (b) => { out += String(b); });
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if (/Local:\s+https?:\/\/\S+/.test(stripAnsi(out)) || (await probe(port)) !== null) {
      const url = await probe(port);
      if (url !== null) return { server, url };
    }
  }
  throw new Error('dev server 45s 未就绪');
}

// ---------------------------------------------------------------- CDP

export async function cdpTargets(cdpPort) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('Chrome 调试端口 20s 内未就绪');
}

export class Cdp {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p !== undefined) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        // GPU 错误每帧重复上报，按文本去重，否则真正的源头被冲掉
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ');
        if (!this.consoleErrors.includes(text)) this.consoleErrors.push(text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails ?? {};
        const text = d.exception?.description ?? d.text ?? 'unknown';
        if (!this.exceptions.includes(text)) this.exceptions.push(text);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails !== undefined) {
      throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
}

/**
 * 启动 Chrome 并接好 CDP 会话（原 editor-smoke main() 里的接线原样上提）。
 * @returns {chrome, cdp, ws}；调用方负责 chrome.kill()
 */
export async function launchEditorSession({ chromePath, cdpPort, headed, appUrl, windowSize = '1280,800', grantClipboard = false }) {
  console.log(`启动 ${headed ? 'headed' : 'headless'} Chrome（WebGPU）→ ${appUrl}`);
  // 这四条 WebGPU flag 是一个整体，缺一条 requestAdapter() 就返回 null
  const flags = [
    '--enable-unsafe-webgpu',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${path.resolve('.workbuddy/tmp/chrome-profile')}`,
    `--window-size=${windowSize}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (headed) {
    // 反遮挡三件套（Windows）：窗口被盖住时 Chrome 的原生遮挡追踪会冻结 RAF/渲染
    flags.push(
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    );
  } else {
    flags.unshift('--headless=new');
    flags.push('--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan');
  }
  if (appUrl.startsWith('https://')) flags.push('--ignore-certificate-errors');
  const chrome = spawn(chromePath, [...flags, 'about:blank'], { stdio: 'ignore' });

  const ver = await cdpTargets(cdpPort);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  // 浏览器级 WS 只认 Target.*：先建 target 再 attach
  const { targetId } = await new Promise((resolve, reject) => {
    const id = 1;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }, { once: false });
    ws.send(JSON.stringify({ id, method: 'Target.createTarget', params: { url: 'about:blank' } }));
  });
  const { sessionId } = await new Promise((resolve, reject) => {
    const id = 2;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    });
    ws.send(JSON.stringify({ id, method: 'Target.attachToTarget', params: { targetId, flatten: true } }));
  });
  const cdp = new Cdp(ws, sessionId);
  if (grantClipboard) {
    // 剪贴板预授权（浏览器级命令，不带页面 sessionId）：无授权时页面一拿到焦点，
    // navigator.clipboard.writeText 会挂起等权限弹窗
    try {
      const bcdp = new Cdp(ws, undefined);
      await bcdp.send('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
        origin: new URL(appUrl).origin,
      });
    } catch (e) {
      console.log(`（剪贴板预授权跳过：${String(e)}）`);
    }
  }
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { chrome, cdp, ws };
}

/**
 * 编辑器状态归一（两套件共用）：清掉 chrome-profile 持久化 UI 残留（dock 挤压
 * 画布、收起态）、锁定 zh（标签断言按中文源文案写），reload 后等到 __editor 就绪。
 */
export async function normalizeEditorState(cdp) {
  await cdp.eval(`(() => {
    localStorage.removeItem('zh.ui.dockH');
    localStorage.removeItem('zh.ui.assets.collapsed');
    localStorage.setItem('zh.ui.lang', 'zh');
    location.reload();
    return true;
  })()`);
  return waitFor(
    () => cdp.eval('(() => (window.__editor && document.getElementById("gpu")) ? document.getElementById("gpu").clientHeight : 0)()').then((h) => typeof h === 'number' && h > 100),
    { timeout: 20000, interval: 300, label: '编辑器就绪（__editor + 画布立起）' },
  );
}

// ---------------------------------------------------------------- 真源推导（B2 / H / J2 共用）

/**
 * 从**项目文件 + 起始场景**推导「应该看到什么」（防门禁长期红灯的关键设计，
 * docs/21 §六：不得硬编码期望值）。口径与 instantiateScene 对齐。
 */
export function readStartSceneExpectation() {
  const proj = JSON.parse(fs.readFileSync(path.resolve('aether.project.json'), 'utf8'));
  const rawIndex = proj.startIndex;
  const index = typeof rawIndex === 'number' ? rawIndex : 0;
  const start = proj.scenes[index];
  if (start === undefined || typeof start.path !== 'string') {
    throw new Error(`aether.project.json 的 scenes[${index}] 不可用（startIndex=${String(rawIndex)}）`);
  }
  const doc = JSON.parse(fs.readFileSync(path.resolve(start.path), 'utf8'));
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const visibleChain = (n) => {
    let cur = n;
    for (let d = 0; cur && d < 64; d++) {
      if (cur.visible === false) return false;
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    return true;
  };
  const compOf = (n) => n.components.find((c) => c.kind === 'MeshRenderer');
  const nodes = doc.nodes.filter(
    (n) =>
      n.components.some((c) => c.kind === 'MeshRenderer' && c.enabled !== false) &&
      visibleChain(n) &&
      compOf(n).source?.type === 'builtin',
  );
  const background = nodes.filter((n) => compOf(n).background === true).map((n) => n.name);
  return {
    path: start.path,
    objects: nodes.length,
    hierarchy: nodes.length - background.length,
    names: nodes.map((n) => n.name),
    background,
    category: Object.fromEntries(nodes.map((n) => [n.name, n.category ?? '道具'])),
    pickable: Object.fromEntries(nodes.map((n) => [n.name, n.pickable ?? false])),
    // 功能体期望：场景文档里的 SpawnPoint 组件数（层级 ✦ 行数按它断言）
    spawnPoints: doc.nodes.filter((n) => n.components.some((c) => c.kind === 'SpawnPoint')).length,
  };
}
