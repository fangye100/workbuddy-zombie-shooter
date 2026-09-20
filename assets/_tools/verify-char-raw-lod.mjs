// 验证 asset-browser 角色 LOD0（原生混元高模）显示真贴图（非顶点色平涂）。
// 用法: node verify-char-raw-lod.mjs
// 判据: ① LOD0 默认文件 = <ID>_<时间戳>.glb（原生）② 屏幕像素有彩色（sat>0.22 占比 > 5%）
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 输出目录：从脚本自身位置推导（assets/_tools → 仓库根），不再写死某台机器的绝对路径
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.workbuddy/tmp');
// 固定自动化 profile（与 tools/verify/editor-smoke.mjs 共用；保证书/登录态/窗口状态）
const PROFILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.workbuddy/tmp/chrome-profile');
mkdirSync(OUT, { recursive: true });
const PORT = 9400 + (process.pid % 500);
const URL = 'http://127.0.0.1:5612/asset-browser.html';

const chromePaths = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
];
const chrome = chromePaths.find((p) => existsSync(p));
if (!chrome) { console.error('chrome not found'); process.exit(1); }

// 固定 profile（= 上面声明的 PROFILE）：复用证书/登录态/窗口状态，不每次新建临时目录
const profile = PROFILE;
const proc = spawn(chrome, [
  '--enable-unsafe-webgpu',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(u) { const r = await fetch(u); return r.json(); }

let ws, id = 0, sessionId;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
}

async function evalJs(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('page eval: ' + (d.exception?.description ?? d.exception?.value ?? d.text)
      + ' @expr[0..80]=' + expr.slice(0, 80));
  }
  return r.result?.value;
}

try {
  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await httpJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(500); }
  }
  if (!version) throw new Error('CDP not reachable');

  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  const console_ = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console_.push(m.params.args?.map?.(a => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') console_.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  await send('Page.navigate', { url: URL });
  await sleep(4000);

  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail });

  // 1. 页面起来了，角色 tab 有 8 项
  const nCards = await evalJs(`document.querySelectorAll('#cards .card').length`);
  ok('page loaded with cards', nCards > 0, `cards=${nCards}`);

  // 2. manifest LOD0 = 原生高模
  const lod0 = await evalJs(`(async () => {
    try {
      const mf = await (await fetch('_data/asset-manifest.json')).json();
      const c = mf.characters[0];
      return { id: c.id, l0: c.lods[0].label, f0: c.lods[0].file };
    } catch (e) { return { err: String(e) }; }
  })()`, true);
  if (lod0.err) throw new Error('manifest fetch failed: ' + lod0.err);
  ok('manifest LOD0 = raw', /原生高模/.test(lod0.l0) && /\d{8}_\d{6}\.glb$/.test(lod0.f0), JSON.stringify(lod0));

  // 3. 打开第一个角色 viewer，默认应加载 rigged_animated（LOD3），手动点 LOD0
  const clicked = await evalJs(`(() => {
    const card = document.querySelector('#cards .card');
    card?.click();
    return card?.dataset.id ?? null;
  })()`);
  if (!clicked) throw new Error('card click failed (no card)');
  await sleep(2000);
  // 点第一个 LOD 按钮（LOD0 原生高模）
  await evalJs(`(() => { const b = document.querySelector('#lodbtns button'); b?.click(); return b?.textContent; })()`);
  // 等 40MB 高模加载（轮询 loading 消失 + vstat 更新）
  let vstat = '';
  for (let i = 0; i < 60; i++) {
    vstat = await evalJs(`(document.getElementById('vstat')||{}).textContent||''`);
    if (/原生高模/.test(vstat) && !(await evalJs(`(document.getElementById('loading')||{style:{}}).style.display==='grid'`))) break;
    await sleep(1000);
  }
  ok('LOD0 raw loaded', /原生高模/.test(vstat), vstat);

  // 4. 像素断言：截图采样中心区域，要求有彩色（原贴图≠顶点色平涂的关键是色彩丰富+有纹理感）
  const rect = await evalJs(`(() => { const c = document.querySelector('#v3d canvas'); if (!c) return null; const r = c.getBoundingClientRect();
    return { x: r.x + r.width * 0.15, y: r.y + r.height * 0.1, width: r.width * 0.7, height: r.height * 0.8 }; })()`);
  if (!rect) throw new Error('#v3d canvas not found (viewer not open?)');
  const snap = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
  const px = await evalJs(`(async (b64) => {
    try {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0, dark = 0, colored = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2]; const l = (r + g + b) / 3;
        n++; if (l < 20) dark++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (l > 26 && (mx - mn) / mx > 0.22) colored++;
      }
      return { colored: +(colored / n).toFixed(3), dark: +(dark / n).toFixed(3) };
    } catch (e) { return { err: String(e) }; }
  })('${snap.data}')`, true);
  if (px.err) throw new Error('pixel sample failed: ' + px.err);
  ok('LOD0 pixels not all dark', px.dark < 0.9, JSON.stringify(px));
  ok('LOD0 pixels colored (real texture)', px.colored > 0.05, `colored=${px.colored}`);

  // 5. 截图存档
  const full = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/char-raw-lod0.png`, Buffer.from(full.data, 'base64'));

  let fails = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ?? ''}`);
    if (!r.pass) fails++;
  }
  console.log(`CONSOLE ERRORS: ${console_.length}`);
  console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
  process.exitCode = fails === 0 ? 0 : 1;
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  await new Promise((r) => { const t = setTimeout(r, 5000); proc.once('exit', () => { clearTimeout(t); r(); }); });
}
