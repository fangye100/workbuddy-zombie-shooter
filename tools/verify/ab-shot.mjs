#!/usr/bin/env node
/**
 * asset browser 3D viewer 截图 —— 复用页面自己的 GLTFLoader/灯光/轨道，
 * 不另起渲染器（本机另写探针渲出过全黑，页面这条路是通的）。
 *
 * 用法：node tools/verify/ab-shot.mjs <资产ID> [tab]
 *   例：node tools/verify/ab-shot.mjs P-41 env
 * 产出：.workbuddy/tmp/ab-verify/AB_<ID>_<LOD>.png
 *
 * 前置：serve_assets.mjs 已在 5612 跑着。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = 'C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01';
const ID = process.argv[2] || 'P-41';
const TAB = process.argv[3] === 'char' ? 'char' : 'env';
const OUT = path.join(ROOT, '.workbuddy/tmp/ab-verify');
const URL_PAGE = 'http://localhost:5612/asset-browser.html';
const CDP = 9350 + (process.pid % 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--enable-unsafe-webgpu', '--ignore-certificate-errors',
  '--no-first-run', `--remote-debugging-port=${CDP}`,
  '--user-data-dir=' + path.join(OUT, 'chrome-ab-' + process.pid),
  '--window-size=1600,1000', URL_PAGE,
], { stdio: 'ignore' });

let code = 1;
try {
  let t = null;
  for (let i = 0; i < 50 && !t; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${CDP}/json/list`);
      t = list.find((x) => x.type === 'page' && /asset-browser/.test(x.url || ''));
    } catch { /* CDP 未就绪 */ }
    if (!t) await sleep(400);
  }
  if (!t) throw new Error('找不到 asset-browser 页面 target');

  const { default: WS } = await import('ws');
  const ws = new WS(t.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pend = new Map(); const logs = [];
  ws.on('message', (m) => {
    const x = JSON.parse(m);
    if (x.id && pend.has(x.id)) { pend.get(x.id)(x); pend.delete(x.id); }
    if (x.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(x.params.type))
      logs.push(x.params.type + ': ' + x.params.args.map((a) => a.value ?? a.description).join(' '));
    if (x.method === 'Runtime.exceptionThrown')
      logs.push('EXC: ' + (x.params.exceptionDetails?.exception?.description ?? '?'));
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send('Runtime.enable'); await send('Page.enable');
  await sleep(4500);

  // 切 tab（角色/环境）
  await ev(`(()=>{const b=[...document.querySelectorAll('button,.tab,[data-tab]')].find(x=>/${TAB === 'env' ? '环|场景|道具|环境' : '角色|人物'}/.test(x.textContent||''));if(b)b.click();return b?b.textContent.trim():'?'})()`);
  await sleep(1800);

  // 点开目标卡片（点 h3 而不是 img，img 会走大图）
  const opened = await ev(`(()=>{const c=document.querySelector('.card[data-id="${ID}"]');if(!c)return null;c.querySelector('h3').click();return c.dataset.id})()`);
  if (!opened) throw new Error(`页面上找不到卡片 ${ID}`);
  await sleep(4000);

  const info = await ev(`(()=>{
    const btns=[...document.querySelectorAll('[data-lod]')];
    return {lodButtons: btns.map(b=>b.dataset.lod+':'+b.textContent.trim()),
            viewerVisible: !!document.getElementById('v3d')?.offsetParent};
  })()`);
  console.log(`${ID} 打开成功 | LOD 按钮: ${(info.lodButtons || []).join(' | ')}`);

  // 逐档截图
  const shots = [];
  for (const b of info.lodButtons) {
    const idx = b.split(':')[0];
    await ev(`(()=>{const x=document.querySelector('[data-lod="${idx}"]');if(x)x.click();return !!x})()`);
    await sleep(3200);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, `AB_${ID}_LOD${idx}.png`);
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    shots.push(path.relative(ROOT, f));
    console.log('  → ' + path.relative(ROOT, f) + '  [' + b.split(':')[1] + ']');
  }
  console.log('CONSOLE ERRORS: ' + logs.length);
  logs.slice(0, 8).forEach((l) => console.log('  ' + l));
  code = logs.length === 0 ? 0 : 1;
  ws.close();
} catch (e) {
  console.log('[FATAL] ' + (e?.message ?? e));
} finally {
  chrome.kill();
}
process.exit(code);