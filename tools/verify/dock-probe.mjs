/**
 * dock-probe —— 资产库（Asset Library，底部 dock）运行时体检探针。
 *
 * 用途：当用户报「资产库面板不见了」时，一次性拿到能区分故障层的证据：
 *   ① 应用有没有起来（#fatal 是否显形）
 *   ② #asset-dock 在不在 DOM 里、有没有子内容（= AssetBrowser 是否构造成功）
 *   ③ 是不是 collapsed 折叠态（localStorage 持久化，最容易误判成「消失」）
 *   ④ 计算后的真实高度 / CSS 变量 --dock-h（高度被压成 0 时视觉上等同消失）
 *   ⑤ 控制台错误与未捕获异常
 *
 * 与 editor-smoke 的关系：smoke 是「全绿门禁」，不覆盖资产库 DOM；
 * 本探针只查资产库，便于单独复现。两者共用同一套 Chrome+SwiftShader 配方。
 *
 * 用法：
 *   node tools/verify/dock-probe.mjs [--url https://100.124.237.93:5100/]
 *                                    [--chrome <path>] [--cdp 9334] [--shot <png>]
 * 注意：走 https 时必须带 --ignore-certificate-errors（Tailscale 自签证书）。
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
const CHROME =
  arg('chrome', '') ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  console.log(`探针目标：${APP_URL}`);
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

    const probe = await send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const dock = document.getElementById('asset-dock');
          const fatal = document.getElementById('fatal');
          const center = document.getElementById('center');
          const insp =
            document.querySelector('#inspector .insp-pane[data-pane="asset"]');
          const cs = dock ? getComputedStyle(dock) : null;
          const r = dock ? dock.getBoundingClientRect() : null;
          return {
            fatalVisible: fatal ? getComputedStyle(fatal).display !== 'none' : null,
            fatalText: fatal ? (fatal.textContent || '').slice(0, 200) : null,
            dockExists: dock !== null,
            dockChildren: dock ? dock.children.length : null,
            dockClass: dock ? dock.className : null,
            dockHtmlLen: dock ? dock.innerHTML.length : null,
            dockRect: r ? { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) } : null,
            dockDisplay: cs ? cs.display : null,
            dockVisibility: cs ? cs.visibility : null,
            dockHeightCss: cs ? cs.height : null,
            dockOverflow: cs ? cs.overflow : null,
            varDockH: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
            centerH: center ? Math.round(center.getBoundingClientRect().height) : null,
            centerDisplay: center ? getComputedStyle(center).display : null,
            inspectorAssetPaneExists: insp !== null,
            treeRows: document.querySelectorAll('.ad-tree [data-path]').length,
            contentItems: document.querySelectorAll('.ad-content [data-path]').length,
            lsCollapsed: localStorage.getItem('zh.assets.collapsed'),
            lsDockH: localStorage.getItem('zh.ui.dockH'),
            lsDir: localStorage.getItem('zh.assets.dir'),
            hasAdTitle: document.querySelector('.ad-title') !== null,
            adTitleText: (document.querySelector('.ad-title')?.textContent || '').trim(),
            windowH: window.innerHeight,
          };
        })()`,
        returnByValue: true,
      },
      sessionId,
    );
    if (probe.exceptionDetails) throw new Error(JSON.stringify(probe.exceptionDetails));

    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));

    console.log('\n===== 资产库运行时状态 =====');
    for (const [k, v] of Object.entries(probe.result.value)) {
      console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
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
