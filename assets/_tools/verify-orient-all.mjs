// 逐角色逐 LOD 朝向体检：加载每个角色每个 LOD，量屏幕模型的包围盒最高轴。
// 判据：立姿 = 高度(y) 是最大轴（容差 1.15）；侧躺/倒立 = FAIL。
// 用法: node verify-orient-all.mjs
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
    throw new Error('page eval: ' + (d.exception?.description ?? d.text) + ' @' + expr.slice(0, 60));
  }
  return r.result?.value;
}

const proc = spawn(chrome, [
  '--enable-unsafe-webgpu',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const results = [];
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
    if (m.method === 'Runtime.exceptionThrown') console_.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 150));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await sleep(4000);

  // 拿全部角色 id
  const ids = await evalJs(`(async () => (await (await fetch('_data/asset-manifest.json')).json()).characters.map(c => c.id))()`, true);

  for (const pid of ids) {
    // 回角色 tab → 打开该角色
    await evalJs(`(() => { const bs = [...document.querySelectorAll('button')];
      const t = bs.find(b => /^角色/.test(b.textContent)); t?.click(); return true; })()`);
    await sleep(800);
    await evalJs(`(() => { const c = [...document.querySelectorAll('#cards .card')].find(x => x.dataset.id === '${pid}');
      c?.click(); return true; })()`);
    await sleep(2500);
    // 逐 LOD
    const nLods = await evalJs(`document.querySelectorAll('#lodbtns button').length`);
    for (let li = 0; li < nLods; li++) {
      await evalJs(`(() => { document.querySelectorAll('#lodbtns button')[${li}]?.click(); return true; })()`);
      let vstat = '';
      for (let t = 0; t < 60; t++) {
        vstat = await evalJs(`(document.getElementById('vstat')||{}).textContent||''`);
        const loading = await evalJs(`(document.getElementById('loading')||{style:{}}).style.display==='grid'`);
        if (vstat && !loading && !/加载/.test(vstat)) break;
        await sleep(1000);
      }
      await sleep(600); // 等动画首帧 + frameObject 完成
      // 用 THREE 量世界包围盒（页面已暴露 window.__viewer？若无则从 vstat 判断文件并重新用骨骼包围盒）
      const dim = await evalJs(`(() => {
        try {
          const v = window.__viewer; if (!v) return null;
          const root = v.state.current; if (!root) return null;
          const box = new v.THREE.Box3();
          let has = false;
          root.traverse(o => {
            if (o.isSkinnedMesh && o.skeleton) {
              has = true;
              o.skeleton.bones.forEach(b => { b.updateWorldMatrix(true, false);
                box.expandByPoint(new v.THREE.Vector3().setFromMatrixPosition(b.matrixWorld)); });
            }
          });
          if (!has) box.setFromObject(root);
          const s = box.getSize(new v.THREE.Vector3());
          return { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) };
        } catch (e) { return { err: String(e) }; }
      })()`);
      results.push({ pid, lod: li, vstat, dim });
    }
    await evalJs(`(() => { const b = document.getElementById('vclose'); if (b) b.click(); return true; })()`);
    await sleep(500);
  }

  let fails = 0;
  for (const r of results) {
    const d = r.dim;
    if (!d || d.err) { console.log(`FAIL  ${r.pid} LOD${r.lod}  measure-error ${JSON.stringify(d)}`); fails++; continue; }
    const ok = d.y >= d.x * 0.87 && d.y >= d.z * 0.87; // y 至少接近最大轴（A-pose 手臂会加宽 x）
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.pid} LOD${r.lod}  size(x,y,z)=${JSON.stringify(d)}  ${r.vstat.slice(0, 40)}`);
    if (!ok) fails++;
  }
  console.log(`EXCEPTIONS: ${console_.length}`);
  console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
  process.exitCode = fails === 0 ? 0 : 1;
} catch (e) {
  for (const r of results) console.log(`${r.pid} LOD${r.lod}: ${JSON.stringify(r.dim)}`);
  console.error('HARNESS ERROR:', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  await new Promise((r) => { const t = setTimeout(r, 5000); proc.once('exit', () => { clearTimeout(t); r(); }); });
}
