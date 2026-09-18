// 终验：① E-01 角色 LOD0 原生高模真贴图 ② P-11/P-42 环境 LOD1 tex2 真贴图
// 用法: node verify-final.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const OUT = 'C:/Users/fangy/WorkBuddy/game-design-zombie/.workbuddy/tmp';
mkdirSync(OUT, { recursive: true });
const PORT = 9400 + (process.pid % 500);
const URL = 'http://127.0.0.1:5612/asset-browser.html';

const chromePaths = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
];
const chrome = chromePaths.find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    throw new Error('page eval: ' + (d.exception?.description ?? d.exception?.value ?? d.text) + ' @' + expr.slice(0, 60));
  }
  return r.result?.value;
}
async function pixelStats(sel) {
  const rect = await evalJs(`(() => { const c = document.querySelector('${sel}'); if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width * 0.15, y: r.y + r.height * 0.1, width: r.width * 0.7, height: r.height * 0.8 }; })()`);
  if (!rect) throw new Error('canvas not found: ' + sel);
  const snap = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
  return evalJs(`(async (b64) => {
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
  })('${snap.data}')`, true);
}

const proc = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader',
  '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan',
  '--ignore-certificate-errors',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/chrome-prof-${Date.now()}`,
  'about:blank',
], { stdio: 'ignore' });

const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail });
const console_ = [];

try {
  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(500); }
  }
  if (!version) throw new Error('CDP not reachable');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console_.push(m.params.args?.map?.(a => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') console_.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 150));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await sleep(4000);

  // ---- A. 角色 tab：E-01 LOD0 原生 ----
  const lod0 = await evalJs(`(async () => {
    try { const mf = await (await fetch('_data/asset-manifest.json')).json();
      return { c: mf.characters[0].lods[0], n: mf.characters.length, en: mf.environments.length }; }
    catch (e) { return { err: String(e) }; }
  })()`, true);
  ok('char LOD0 = raw glb', /\d{8}_\d{6}\.glb$/.test(lod0.c?.file ?? ''), JSON.stringify(lod0.c ?? lod0));
  ok('manifest counts 8+38', lod0.n === 8 && lod0.en === 38, `char=${lod0.n} env=${lod0.en}`);

  // 打开 E-01，等默认（rigged_animated）加载，点 LOD0
  await evalJs(`document.querySelector('#cards .card')?.click()`);
  await sleep(2000);
  await evalJs(`document.querySelector('#lodbtns button')?.click()`);
  let vstat = '';
  for (let i = 0; i < 90; i++) {
    vstat = await evalJs(`(document.getElementById('vstat')||{}).textContent||''`);
    const loading = await evalJs(`(document.getElementById('loading')||{style:{}}).style.display==='grid'`);
    if (/原生高模/.test(vstat) && !loading) break;
    await sleep(1000);
  }
  ok('E-01 raw LOD0 loaded', /原生高模/.test(vstat), vstat);
  const px1 = await pixelStats('#v3d canvas');
  ok('E-01 raw colored', px1.colored > 0.05 && px1.dark < 0.9, JSON.stringify(px1));
  await evalJs(`(() => { const b = document.getElementById('vclose'); if (b) b.click(); return true; })()`);
  await sleep(500);

  // ---- B. 环境 tab：P-11 与 P-42 的 LOD1 = tex2 真贴图 ----
  await evalJs(`(() => { const bs = [...document.querySelectorAll('nav button, .tabs button, button')];
    const t = bs.find(b => /环境|道具/.test(b.textContent)); t?.click(); return t?.textContent ?? null; })()`);
  await sleep(1500);
  for (const pid of ['P-11', 'P-42']) {
    await evalJs(`(() => { const c = [...document.querySelectorAll('#cards .card')].find(x => x.dataset.id === '${pid}');
      c?.click(); return c ? 'ok' : 'missing'; })()`);
    await sleep(2500);
    // 点 LOD1（tex2）
    await evalJs(`(() => { const bs = document.querySelectorAll('#lodbtns button');
      const b = bs[1]; b?.click(); return b?.textContent ?? null; })()`);
    let vs2 = '';
    for (let i = 0; i < 45; i++) {
      vs2 = await evalJs(`(document.getElementById('vstat')||{}).textContent||''`);
      const loading = await evalJs(`(document.getElementById('loading')||{style:{}}).style.display==='grid'`);
      if (/tex2|原贴图/.test(vs2) && !loading) break;
      await sleep(1000);
    }
    ok(`${pid} LOD1 tex2 loaded`, /原贴图|tex2/.test(vs2), vs2);
    const px2 = await pixelStats('#v3d canvas');
    ok(`${pid} tex2 colored`, px2.colored > 0.03 && px2.dark < 0.92, JSON.stringify(px2));
    await evalJs(`(() => { const b = document.getElementById('vclose'); if (b) b.click(); return true; })()`);
    await sleep(600);
  }

  const full = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/final-verify.png`, Buffer.from(full.data, 'base64'));

  let fails = 0;
  for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ?? ''}`); if (!r.pass) fails++; }
  console.log(`CONSOLE ERRORS: ${console_.length}`);
  console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
  process.exitCode = fails === 0 ? 0 : 1;
} catch (e) {
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ?? ''}`);
  console.error('HARNESS ERROR:', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  await new Promise((r) => { const t = setTimeout(r, 5000); proc.once('exit', () => { clearTimeout(t); r(); }); });
}
