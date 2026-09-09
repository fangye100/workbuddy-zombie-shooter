#!/usr/bin/env node
/**
 * 关卡预览验证：用 headed Chrome + 真实 GPU 打开编辑器，抓 boot 日志与截图。
 *
 * 为什么必须跑这一遍：`npm test` 只能证明「场景数据能实例化出 18 个物件」，
 * 证明不了 **WebGPU 真的把它们画出来了**。这条链路只有运行时能验。
 *
 * 铁律（AGENTS.md §4.1）：本沙箱 headless + SwiftShader 起不来 CDP，
 * 必须 headed + 真实 GPU。🔴 不要加 --no-sandbox / --disable-dev-shm-usage。
 *
 * 用法：node tools/level/verify-level.mjs [--keep]
 *   --keep 保留浏览器不关（想自己看画面时加）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9222;
const USER_DIR = path.resolve(ROOT, '.workbuddy/tmp/chrome-profile');
const OUT_DIR = path.resolve(ROOT, '.workbuddy/tmp');
// vite 检测到证书就走 HTTPS，WebGPU 需要 secure context
const APP_URL = 'https://localhost:5100/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keep = process.argv.includes('--keep');

async function httpJson(url, tries = 60, init) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`无法连接 ${url}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let chrome = null;
  if ((await fetch(`http://localhost:${PORT}/json/version`).catch(() => null)) === null) {
    console.log('启动 Chrome（headed + 真实 GPU）…');
    chrome = spawn(
      CHROME,
      [
        '--enable-unsafe-webgpu',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${USER_DIR}`,
        '--window-size=1440,900',
        '--no-first-run',
        '--ignore-certificate-errors',
        APP_URL,
      ],
      { detached: false, stdio: 'ignore' },
    );
  } else {
    console.log('复用已在运行的 Chrome');
  }

  try {
    const version = await httpJson(`http://localhost:${PORT}/json/version`);
    console.log('已连接：', version.Browser);

    const tab = await httpJson(`http://localhost:${PORT}/json/new?${encodeURIComponent(APP_URL)}`, 60, {
      method: 'PUT',
    });
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let id = 0;
    const pending = new Map();
    const logs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p !== undefined) {
          pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ');
        logs.push(`[${msg.params.type}] ${text}`);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: APP_URL });

    // 场景加载是 async boot，给足时间（WebGPU 初始化 + 18 个物件的 buffer 上传）
    await sleep(9000);

    // 页面内第一手状态：boot 日志会说谎的空间很小，但 DOM 不会 —— 直接读页面
    const probe = await send('Runtime.evaluate', {
      expression: `(async () => {
        const proj = await fetch('/__fs/file?path=aether.project.json').then(r => r.json()).catch(() => null);
        const txt = document.body.innerText;
        const m = txt.match(/共 \\d+ 个对象[^\\n]*/);
        return JSON.stringify({
          url: location.href,
          startIndex: proj?.startIndex,
          sceneCount: proj?.scenes?.length,
          hasRoomNode: txt.includes('刷怪点'),
          hasSandboxEnemy: txt.includes('Enemy 1'),
          hierarchyLine: m ? m[0] : null,
        });
      })()`,
      awaitPromise: true,
    });
    console.log('\n===== 页面内探针 =====');
    console.log(probe.result?.value ?? JSON.stringify(probe));

    console.log('\n===== 浏览器控制台（boot 相关）=====');
    const boot = logs.filter((l) => l.includes('boot') || l.includes('场景'));
    for (const l of (boot.length > 0 ? boot : logs).slice(0, 25)) console.log('  ' + l);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(OUT_DIR, 'level-preview.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`\n截图：${out}`);

    const loaded = boot.find((l) => l.includes('场景已加载'));
    if (loaded === undefined) {
      console.log('\n⚠️ 没抓到「场景已加载」—— 关卡可能没被加载，看上面的完整日志');
      process.exitCode = 1;
    } else {
      console.log(`\n✅ ${loaded.replace(/^\[\w+\]\s*/, '')}`);
    }

    if (!keep) await send('Browser.close').catch(() => {});
    ws.close();
  } finally {
    if (chrome !== null && !keep) chrome.kill();
  }
}

main().catch((e) => {
  console.error('验证失败：', e.message);
  process.exitCode = 1;
});
