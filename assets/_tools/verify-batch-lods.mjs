// 批量验证：8 角色 × 全部 LOD，逐档加载确认无报错 + 贴图非空 + 立姿 + 记录量化数据
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 输出目录：从脚本自身位置推导（assets/_tools → 仓库根），不再写死某台机器的绝对路径
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.workbuddy/tmp');
// 固定自动化 profile（与 tools/verify/editor-smoke.mjs 共用；保证书/登录态/窗口状态）
const PROFILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.workbuddy/tmp/chrome-profile');
const SHOTS = `${OUT}/batch-shots`;
mkdirSync(SHOTS, { recursive: true });
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
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id; pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 160));
  return r.result?.value;
}

const proc = spawn(chrome, [
  '--enable-unsafe-webgpu',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--window-size=1280,800', '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

let fails = 0, checks = 0;
const ok = (name, cond, extra = '') => {
  checks++;
  if (!cond) { fails++; console.log(`  FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
  else if (extra) console.log(`  pass  ${name}  — ${extra}`);
};

try {
  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(500); }
  }
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const pageErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      pageErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown')
      pageErrors.push('EXC: ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  });
  const { targetId } = await send('Target.createTarget', { url: URL });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: URL });
  await sleep(4500);

  // 角色 tab 的全部条目
  const entries = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('#cards .card')];
    return cards.map(c => c.dataset.id || (c.querySelector('.id')||{}).textContent || c.textContent.slice(0,12));
  })()`);
  console.log(`角色卡：${entries.length} 个 -> ${JSON.stringify(entries)}\n`);

  const rows = [];
  for (let ci = 0; ci < entries.length; ci++) {
    const cid = entries[ci];
    console.log(`=== ${cid} ===`);
    await evalJs(`(() => { document.querySelectorAll('#cards .card')[${ci}]?.click(); return true; })()`);
    await sleep(3500);
    const nLods = await evalJs(`document.querySelectorAll('#lodbtns button').length`);
    for (let n = 0; n < nLods; n++) {
      await evalJs(`(() => { document.querySelectorAll('#lodbtns button')[${n}]?.click(); return true; })()`);
      let st = '';
      for (let i = 0; i < 60; i++) {
        st = await evalJs(`(document.getElementById('vstat')||{}).textContent||''`);
        const busy = await evalJs(`(document.getElementById('loading')||{style:{}}).style.display==='grid'`);
        if (new RegExp(`LOD${n}\\b`).test(st) && !busy) break;
        await sleep(700);
      }
      await sleep(900);
      // 探针：几何/贴图/朝向
      const p = await evalJs(`(() => {
        try {
          const st = window.__viewer?.state; const root = st && st.current;
          if (!root) return { err: 'no root' };
          let tris = 0, verts = 0, withTex = 0;
          root.traverse(o => { if (o.isMesh) {
            const g = o.geometry;
            tris += g.index ? g.index.count/3 : g.attributes.position.count/3;
            verts += g.attributes.position.count;
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            if (ms.some(m => m && m.map)) withTex++;
          } });
          let box = new window.__viewer.THREE.Box3(); let hasSk = false;
          root.traverse(o => { if (o.isSkinnedMesh && o.skeleton) { hasSk = true;
            o.skeleton.bones.forEach(b => { b.updateWorldMatrix(true,false);
              box.expandByPoint(new window.__viewer.THREE.Vector3().setFromMatrixPosition(b.matrixWorld)); }); } });
          if (!hasSk) box.setFromObject(root);
          const s = box.getSize(new window.__viewer.THREE.Vector3());
          return { tris: Math.round(tris), verts, withTex,
                   size: [ +s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3) ] };
        } catch (e) { return { err: String(e).slice(0,120) }; }
      })()`);
      const label = (st.split(' · ')[1] || `LOD${n}`).trim();
      const upOk = p && p.size && p.size[1] >= p.size[0] && p.size[1] >= p.size[2];
      ok(`${cid} LOD${n} 加载`, /LOD\d/.test(st) && !/失败/.test(st), st.slice(0, 52));
      ok(`${cid} LOD${n} 有贴图`, p?.withTex > 0, `meshes_with_tex=${p?.withTex}`);
      ok(`${cid} LOD${n} 立姿(y最大轴)`, upOk, `size=${JSON.stringify(p?.size)}`);
      rows.push({ cid, lod: n, label, tris: p?.tris, verts: p?.verts, size: p?.size });
      const r = await evalJs(`(() => { const c = document.querySelector('#v3d canvas'); const b = c.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
      writeFileSync(`${SHOTS}/${cid}_lod${n}.png`, Buffer.from(shot.data, 'base64'));
    }
    await evalJs(`document.getElementById('vclose')?.click()`);
    await sleep(600);
  }

  console.log('\n===== 量化汇总 =====');
  console.log('角色   档  面数      顶点    包围盒');
  for (const r of rows) {
    console.log(`${r.cid.padEnd(6)} L${r.lod}  ${String(r.tris).padStart(7)}  ${String(r.verts).padStart(7)}  ${JSON.stringify(r.size)}`);
  }
  writeFileSync(`${OUT}/batch-verify.json`, JSON.stringify(rows, null, 1));
  console.log(`\n断言 ${checks - fails}/${checks} 通过`);
  console.log('CONSOLE ERRORS:', pageErrors.length, pageErrors.slice(0, 3).join(' | '));
  if (fails === 0) console.log('ALL PASS');
  // 🔴 断言失败必须映射到非零退出码，否则自动化会把失败的批量检查当成通过（门禁失效）
  else { console.log(`${fails} FAILED`); process.exitCode = 1; }
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  await new Promise((r) => { const t = setTimeout(r, 4000); proc.once('exit', () => { clearTimeout(t); r(); }); });
}
