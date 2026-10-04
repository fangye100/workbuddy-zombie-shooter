#!/usr/bin/env node
/**
 * LOD 渲染对照探针 —— 真 Chrome + 真 WebGL，把 P-01 的 LOD0/LOD1 各渲一张图。
 * 用法：node tools/verify/lod-render-probe.mjs <环境ID> [输出PNG]
 *   例：node tools/verify/lod-render-probe.mjs P-01
 *
 * 为什么要有这个：贴图内容 / 彩度 / baseColorFactor 都是**间接指标**，
 * 「色彩有没有继承」最终得看渲染结果。这里用页面同一套 GLTFLoader + 灯光
 * 渲染两档，输出并排对照图。
 *
 * ⚠️ 本沙箱 headless+SwiftShader 起不来 WebGPU/WebGL 上下文（见 AGENTS.md §4.1），
 *    故默认走 --headless=new + swiftshader（仅本探针；editor 冒烟仍必须 headed）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const ID = process.argv[2] || 'P-01';
const OUT = process.argv[3] || path.join(ROOT, '.workbuddy/tmp/lodtest', `RENDER_${ID}.png`);
const PORT = 5620 + (process.pid % 300);
const CDP = 9400 + (process.pid % 300);
const TMP = path.join(ROOT, '.workbuddy/tmp/lodtest');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
});

/** 极简静态服务（只服务 assets/ 与探针页），避免依赖另一个进程。 */
function serve() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.obj': 'text/plain' };
  const srv = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    let abs = path.join(ROOT, rel);
    if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((r) => srv.listen(PORT, '127.0.0.1', () => r(srv)));
}

const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#20202a">
<div id="row" style="display:flex;gap:8px;padding:8px"></div>
<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.169.0/build/three.module.js",
"three/addons/":"https://unpkg.com/three@0.169.0/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
window.__result = { shots: [], errors: [] };
window.addEventListener('error', (e) => window.__result.errors.push(String(e.message)));
const host = document.getElementById('row');
// 🔴 路径必须以 / 开头（站点根= 仓库根）。相对路径会按页面所在子目录
//    /.workbuddy/tmp/lodtest/ 解析 → 全部 404。
const lods = [
  ['LOD0 混元raw', '/assets/environment/models/${ID}/${ID}.glb'],
  ['LOD1 路线A',    '/assets/environment/models/${ID}/tex2/${ID}_baked.glb'],
];
for (const [label, url] of lods) {
  const wrap = document.createElement('div');
  const w = 380, h = 420;
  wrap.innerHTML = '<div style="color:#ddd;font:13px sans-serif;padding:4px">' + label + '</div>';
  const cv = document.createElement('canvas');
  cv.width = w * devicePixelRatio; cv.height = h * devicePixelRatio;
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  wrap.appendChild(cv); host.appendChild(wrap);
  let gltf;
  try { gltf = await new GLTFLoader().loadAsync(url); }
  catch (e) { window.__result.errors.push(label + ': ' + e.message); continue; }
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(devicePixelRatio); r.setSize(w, h);
  const sc = new THREE.Scene(); sc.background = new THREE.Color(0x2a2a34);
  const cam = new THREE.PerspectiveCamera(45, w / h, 0.01, 200);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const ctr = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const dist = size * 1.6;
  // 🔴 无灯 = 全黑。这与资产无关，是探针自己的锅（asset-browser.html 里有灯）。
  //    用与 asset browser 同款的三点布光，保证渲染结果可比。
  sc.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(3, 6, 4); sc.add(key);
  const rim = new THREE.DirectionalLight(0x88aaff, 1.1); rim.position.set(-4, 3, -3); sc.add(rim);
  sc.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.0));
  // 相机：绕包围盒中心的水平圆周 + 俯角，高度按 size 的比例给（不是 dist*el，
  // dist 本身已含size，再乘 el 会把相机甩到天上/模型背后 → 渲出全黑）。
  const place = (ang, elevRatio) => {
    const h = size * elevRatio;
    const r = size * 1.5;
    cam.position.set(ctr.x + Math.cos(ang) * r, ctr.y + h, ctr.z + Math.sin(ang) * r);
    cam.lookAt(ctr);
    cam.updateMatrixWorld();
  };
  for (const [ang, elevRatio] of [[0.6, 0.45], [2.4, 0.30], [4.2, 0.60]]) {
    place(ang, elevRatio);
    r.render(gltf.scene, cam);
    // 🔴 WebGL 绘制缓冲在composite 后即失效，toDataURL 必须同帧同步读回
    const url2 = cv.toDataURL('image/png');
    window.__result.shots.push({ label, view: ang, data: url2 });
  }
  // 同时记录材质参数（诊断用）
  const mats = [];
  gltf.scene.traverse((o) => { if (o.isMesh) mats.push({
    name: o.name || '(unnamed)',
    vertexColors: !!o.material.vertexColors,
    color: o.material.color ? o.material.color.toArray().map((v) => +v.toFixed(3)) : null,
    hasMap: !!o.material.map,
  }); });
  window.__result.shots.push({ label, mats });
  const gl = r.getContext();
  const px = new Uint8Array(4);
  gl.readPixels(10, 10, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  window.__result.shots.push({ label, diag: {
    ctxLost: gl.isContextLost(), ver: gl.getParameter(gl.VERSION),
    renderer: gl.getParameter(gl.RENDERER),
    pixelAt_10_10: Array.from(px), drawing: [gl.drawingBufferWidth, gl.drawingBufferHeight],
  }});
  r.dispose();
}
window.__done = true;
</script></body>`;

const srv = await serve();
const pagePath = path.join(TMP, '_lod_probe.html');
fs.writeFileSync(pagePath, page, 'utf8');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const chrome = spawn(process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new',
  '--ignore-certificate-errors', '--no-first-run', '--enable-unsafe-webgpu',
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(TMP, 'chrome-lodprobe-' + process.pid)}`,
  `--window-size=1240,560`,
  `http://127.0.0.1:${PORT}/.workbuddy/tmp/lodtest/_lod_probe.html`,
], { stdio: 'ignore' });

let exitCode = 1;
try {
  let pageTarget = null;
  for (let i = 0; i < 60 && !pageTarget; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${CDP}/json/list`);
      pageTarget = list.find((t) => t.type === 'page' && /_lod_probe/.test(t.url || ''));
    } catch { /* CDP 未就绪 */ }
    if (!pageTarget) await sleep(500);
  }
  if (!pageTarget) throw new Error('找不到页面 target');
  const { default: WS } = await import('ws');
  const ws = new WS(pageTarget.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pend = new Map(); const logs = [];
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))
      logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown')
      logs.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description ?? '?'));
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send('Runtime.enable'); await send('Page.enable');
  for (let i = 0; i < 60; i++) { if (await evalJs('window.__done === true')) break; await sleep(500); }
  const res = await evalJs('JSON.stringify(window.__result)');
  const parsed = JSON.parse(res ?? '{}');
  console.log(`渲染错误 ${parsed.errors?.length ?? 0} | console ${logs.length}`);
  (parsed.errors ?? []).forEach((e) => console.log('  ERR ' + e));
  logs.slice(0, 6).forEach((l) => console.log('  ' + l));
  for (const s of parsed.shots ?? []) {
    if (s.diag) { console.log(`\n${s.label} WebGL 诊断:`, JSON.stringify(s.diag)); continue; }
    if (s.mats) { console.log(`\n${s.label} 材质:`, JSON.stringify(s.mats)); continue; }
    const f = path.join(TMP, `_shot_${ID}_${s.label.replace(/\\W+/g, '_')}_${s.view}.png`);
    fs.writeFileSync(f, Buffer.from(s.data.split(',')[1], 'base64'));
    console.log('  → ' + path.relative(ROOT, f));
  }
  exitCode = (parsed.errors?.length ?? 0) === 0 && logs.length === 0 ? 0 : 1;
  ws.close();
} catch (e) {
  console.log('[FATAL] ' + (e?.message ?? e));
} finally {
  chrome.kill();
  srv.close();
  try { fs.unlinkSync(pagePath); } catch { /* ignore */ }
}
process.exit(exitCode);