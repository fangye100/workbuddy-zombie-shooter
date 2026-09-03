/**
 * dock-probe —— 资产库（Asset Library，底部 dock）运行时体检探针。
 *
 * 用途：当用户报「资产库面板不见了」时，一次性拿到能区分故障层的证据。
 * 关键点：本脚本**不依赖看图**——全部结论由 DOM 几何数字得出，可复现、可比对。
 *
 * 检查项：
 *   ① 应用有没有起来（#fatal 是否显形）
 *   ② #asset-dock 在不在 DOM 里、有没有子内容（= AssetBrowser 是否构造成功）
 *   ③ 是不是 collapsed 折叠态（localStorage 持久化，最容易误判成「消失」）
 *   ④ 多视口扫描：有没有某个常见窗口尺寸会让 dock 掉出视口或被压成 0 高
 *   ⑤ 控制台错误与未捕获异常
 *
 * 视口扫描实现：加载一次页面，之后用 CDP 的 Emulation.setDeviceMetricsOverride
 * 改视口再测，不重开浏览器。dock 是 `flex:0 0 auto; height:var(--dock-h)`，
 * 理论上不可压缩；如果某个尺寸下它真的没了，那才是布局 bug。
 *
 * 与 editor-smoke 的关系：smoke 是「全绿门禁」，不覆盖资产库 DOM；
 * 本探针只查资产库，便于单独复现。两者共用同一套 Chrome+SwiftShader 配方。
 *
 * 用法：
 *   node tools/verify/dock-probe.mjs [--url https://100.124.237.93:5100/]
 *                                    [--chrome <path>] [--cdp 9334] [--shot <png>]
 *                                    [--sizes 1280x800,1366x768,1920x1080,1024x600]
 * 注意：走 https 时必须带 --ignore-certificate-errors（Tailscale 自签证书）。
 *
 * ── 用户侧自助诊断 ────────────────────────────────────────────────
 * 服务端侧全部排干净、但用户仍报「面板不见了」时，把下面这段粘进浏览器
 * DevTools 控制台（F12 → Console），把输出贴回来即可与无头探针的数字逐项比对。
 * 它测的是同一批指标，只是跑在用户真实浏览器里：
 *
 * (()=>{const d=document.getElementById('asset-dock'),c=document.getElementById('gpu'),n=document.getElementById('center'),r=e=>{const b=e.getBoundingClientRect();return{top:Math.round(b.top),bottom:Math.round(b.bottom),h:Math.round(b.height)}};const v=r(d);return{视口:innerWidth+'x'+innerHeight,dock:v,dock可见:v.h>0&&v.top<innerHeight&&v.bottom>0,被裁掉:Math.max(0,v.bottom-innerHeight),collapsed:d.classList.contains('collapsed'),dockH:getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),canvas:r(c),center:r(n),fatal:getComputedStyle(document.getElementById('fatal')).display!=='none',树行数:document.querySelectorAll('.ad-tree [data-path]').length,内容项:document.querySelector('.ad-content')?.children.length??null,面包屑:document.querySelector('.ad-crumb')?.textContent?.trim(),ls:{collapsed:localStorage.getItem('zh.assets.collapsed'),dockH:localStorage.getItem('zh.ui.dockH')}}})()
 *
 * 判读：dock.h 为 0 或 被裁掉 > 0 → 布局问题；collapsed 为 true → 折叠态，
 * 清 localStorage 即可；dock 各项正常但用户说看不见 → 检查 fatal 与浏览器缩放。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};

const OUT_DIR = '.workbuddy/tmp';
const APP_URL = arg('url', 'https://100.124.237.93:5100/');
const CDP_PORT = Number(arg('cdp', 9334)); // 与 smoke 的 9333 错开，避免并行打架
const SHOT = arg('shot', path.join(OUT_DIR, 'dock-probe.png'));
const SIZES = arg('sizes', '1280x800,1366x768,1920x1080,1024x600,800x480').split(',');
const CHROME =
  arg('chrome', '') ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 单次取样：dock 的几何 + 视口关系。返回纯数字，便于跨视口比对。
const MEASURE = `(() => {
  const dock = document.getElementById('asset-dock');
  const canvas = document.getElementById('gpu');
  const center = document.getElementById('center');
  const q = (s) => document.querySelector(s);
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
  const cs = dock ? getComputedStyle(dock) : null;
  const d = dock ? r(dock) : null;
  const vh = window.innerHeight, vw = window.innerWidth;
  return {
    vw, vh,
    dock: d,
    dockH: d ? d.h : null,
    // >0 表示被视口下缘裁掉；这个值非零 = 用户根本看不到 dock
    clippedBelow: d ? Math.max(0, d.bottom - vh) : null,
    // dock 顶缘跑到视口上方 = 被 canvas 顶出去
    aboveTop: d ? Math.max(0, -d.top) : null,
    dockVisible: d ? (d.h > 0 && d.top < vh && d.bottom > 0) : false,
    canvasH: canvas ? r(canvas).h : null,
    centerH: center ? r(center).h : null,
    // dock 高 + canvas 高 应约等于 center 高；差太多说明溢出
    sumVsCenter: (d && canvas && center) ? Math.round((d.h + r(canvas).h) - r(center).h) : null,
    bodyScrollH: document.body.scrollHeight,
    display: cs ? cs.display : null,
    heightCss: cs ? cs.height : null,
    varDockH: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
    collapsed: dock ? dock.classList.contains('collapsed') : null,
    children: dock ? dock.children.length : null,
    htmlLen: dock ? dock.innerHTML.length : null,
    treeRows: document.querySelectorAll('.ad-tree [data-path]').length,
    contentItems: document.querySelectorAll('.ad-content [data-path]').length,
    contentChildren: q('.ad-content') ? q('.ad-content').children.length : null,
    crumb: (q('.ad-crumb')?.textContent || '').trim().slice(0, 60),
    lsCollapsed: localStorage.getItem('zh.assets.collapsed'),
    lsDockH: localStorage.getItem('zh.ui.dockH'),
    fatalVisible: (() => { const f = document.getElementById('fatal'); return f ? getComputedStyle(f).display !== 'none' : null; })(),
  };
})()`;

async function cdpVersion() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('Chrome 调试端口 20s 内未就绪');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`探针目标：${APP_URL}\n`);

  const flags = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader',
    '--use-webgpu-adapter=swiftshader',
    '--enable-features=Vulkan',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.resolve('.workbuddy/tmp/chrome-probe')}`,
    '--window-size=1280,800',
  ];
  if (APP_URL.startsWith('https://')) flags.push('--ignore-certificate-errors');

  const chrome = spawn(CHROME, [...flags, 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    const ver = await cdpVersion();
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    const consoleErrors = [];
    const exceptions = [];
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const t = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (!consoleErrors.includes(t)) consoleErrors.push(t);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails ?? {};
        const t = d.exception?.description ?? d.text ?? 'unknown';
        if (!exceptions.includes(t)) exceptions.push(t);
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Page.navigate', { url: APP_URL }, sessionId);
    await sleep(6000); // 等 WebGPU 初始化 + 资产库 boot() 拉目录

    // ---- 多视口扫描：同一次加载，只改视口再测 ----
    const rows = [];
    for (const size of SIZES) {
      const [w, h] = size.split('x').map(Number);
      if (!w || !h) continue;
      await send(
        'Emulation.setDeviceMetricsOverride',
        { width: w, height: h, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      await sleep(700); // 等布局重排
      const res = await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true }, sessionId);
      if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
      rows.push({ size, ...res.result.value });
    }

    // 复原视口后截图，方便人工核对
    await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));

    // ---- 输出：先摘要表，再逐项明细 ----
    console.log('===== 多视口扫描（dock 是否可见）=====');
    console.log('视口        dock高  canvas高  center高  dock顶→底    被裁  可见  collapsed  --dock-h');
    for (const r of rows) {
      const span = r.dock ? `${r.dock.top}→${r.dock.bottom}` : 'n/a';
      console.log(
        `${r.size.padEnd(11)} ${String(r.dockH).padEnd(6)} ${String(r.canvasH).padEnd(9)} ` +
          `${String(r.centerH).padEnd(9)} ${span.padEnd(13)} ${String(r.clippedBelow).padEnd(5)} ` +
          `${String(r.dockVisible).padEnd(5)} ${String(r.collapsed).padEnd(10)} ${r.varDockH}`,
      );
    }

    const bad = rows.filter((r) => !r.dockVisible || r.clippedBelow > 0 || r.dockH === 0);
    console.log(
      bad.length === 0
        ? '\n✅ 所有受测视口下 dock 均可见且未被裁剪 → 布局层面没有问题。'
        : `\n❌ ${bad.length} 个视口下 dock 不可见：${bad.map((b) => b.size).join(', ')}`,
    );
    const anyCollapsed = rows.some((r) => r.collapsed === true);
    if (anyCollapsed) console.log('⚠️ 检测到 collapsed 折叠态 —— 「面板不见了」多半是这个，不是 bug。');

    console.log('\n===== 首个视口完整状态 =====');
    if (rows[0]) {
      for (const [k, v] of Object.entries(rows[0])) {
        if (k === 'size') continue;
        console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      }
    }

    console.log(`\nCONSOLE ERRORS (${consoleErrors.length}):`);
    consoleErrors.slice(0, 10).forEach((e) => console.log('  - ' + e.slice(0, 300)));
    console.log(`EXCEPTIONS (${exceptions.length}):`);
    exceptions.slice(0, 10).forEach((e) => console.log('  - ' + e.slice(0, 300)));
    console.log(`\n截图：${path.resolve(SHOT)}`);
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error('探针失败：', e);
  process.exit(1);
});
