// 验证 LOD 量化 HUD：四个 LOD 全切一遍，读 HUD 文本 + 截图
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const OUT = 'C:/Users/fangy/WorkBuddy/game-design-zombie/.workbuddy/tmp';
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
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}

const proc = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/chrome-prof-hud-${Date.now()}`,
  'about:blank',
], { stdio: 'ignore' });

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fails++;
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

  await evalJs(`document.querySelector('#cards .card')?.click()`);
  await sleep(4000);

  ok('HUD 元素存在', await evalJs(`!!document.getElementById('vhud')`));

  const seen = [];
  for (const n of [0, 1, 2, 3]) {
    await evalJs(`(() => { document.querySelectorAll('#lodbtns button')[${n}]?.click(); return true; })()`);
    let st = '';
    for (let i = 0; i < 90; i++) {
      st = await evalJs(`(document.getElementById('vstat')||{}).textContent||''`);
      const busy = await evalJs(`(document.getElementById('loading')||{style:{}}).style.display==='grid'`);
      if (new RegExp(`LOD${n}\\b`).test(st) && !busy) break;
      await sleep(1000);
    }
    await sleep(1200);
    const hud = await evalJs(`(document.getElementById('vhud')||{}).textContent||''`);
    const vis = await evalJs(`!document.getElementById('vhud').classList.contains('hidden')`);
    const bars = await evalJs(`document.querySelectorAll('#vhud [data-hudlod]').length`);
    const stats = await evalJs(`JSON.stringify(window.__viewer?.state?.lodStats ?? null)`);
    console.log(`\n--- LOD${n} ---`);
    console.log('  HUD可见:', vis, '| 切换按钮:', bars);
    console.log('  HUD文本:', hud.replace(/\s+/g, ' ').trim());
    console.log('  lodStats:', stats);
    seen.push({ n, hud, vis, bars });
    // 截全画布（含 HUD），否则裁剪区会把 HUD 左半边切掉
    const rect = await evalJs(`(() => { const c = document.querySelector('#v3d canvas'); const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
    writeFileSync(`${OUT}/hud-lod${n}.png`, Buffer.from(shot.data, 'base64'));
  }

  // LOD3 动画活动性：🔴 只测骨骼「位置」是错的 —— idle/attack 这类动画只驱动 rotation
  // （E-01 idle 仅 6 条通道 / 22 joints），骨骼世界位置几乎不动。改测：
  //   ① mixer.time 是否推进  ② 骨骼 world matrix 全 16 元素的整体变化量
  // 🔴 字段名是 state.current（不是 state.root）—— 写错会让探针静默返回 null。
  const boneProbe = `(() => {
    try {
      const st = window.__viewer?.state;
      const root = st && st.current;
      if (!root) return { err: 'no current root' };
      const m = [];
      root.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) {
        for (const b of o.skeleton.bones) {
          b.updateWorldMatrix(true, false);
          for (const x of b.matrixWorld.elements) m.push(x);
        }
      } });
      return { t: st.mixer ? st.mixer.time : null, n: m.length, m };
    } catch (e) { return { err: String(e) }; }
  })()`;
  const a1 = await evalJs(boneProbe);
  await sleep(900);
  const a2 = await evalJs(boneProbe);
  const matrixDelta = a1 && a2 && a1.m ? a1.m.reduce((s, v, i) => s + Math.abs(v - a2.m[i]), 0) : 0;
  const timeDelta = a1 && a2 && a1.t != null ? a2.t - a1.t : 0;
  ok('LOD3 mixer 时间在推进', timeDelta > 0.3,
     `${JSON.stringify({ err: a1?.err, t1: a1?.t, t2: a2?.t, Δt: +timeDelta.toFixed(3) })}`);
  ok('LOD3 骨骼矩阵在变化（动画真实生效）', matrixDelta > 0.05,
     `Σ|Δ|=${matrixDelta.toFixed(4)} 采样元素=${a1?.n ?? 0}`);

  ok('每档 HUD 都可见', seen.every((s) => s.vis));
  ok('HUD 有 4 个切换按钮', seen.every((s) => s.bars === 4));
  ok('LOD0 HUD 含 79,744', /79,744/.test(seen[0].hud), seen[0].hud.slice(0, 60));
  ok('LOD1 HUD 含 3,000', /3,000/.test(seen[1].hud), seen[1].hud.slice(0, 60));
  ok('LOD1 有降幅百分比', /-9\d(\.\d)?%/.test(seen[1].hud), (seen[1].hud.match(/-[\d.]+%/) ?? ['无'])[0]);
  ok('LOD2 HUD 标注骨骼', /joints/.test(seen[2].hud), (seen[2].hud.match(/\d+ joints/) ?? ['无'])[0]);
  ok('LOD3 HUD 标注动画', /段/.test(seen[3].hud), (seen[3].hud.match(/\d+ 段/) ?? ['无'])[0]);
  console.log('\nCONSOLE ERRORS:', pageErrors.length, pageErrors.slice(0, 3).join(' | '));
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  await new Promise((r) => { const t = setTimeout(r, 4000); proc.once('exit', () => { clearTimeout(t); r(); }); });
}
