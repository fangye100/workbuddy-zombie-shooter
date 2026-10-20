/**
 * WU-05 headed 真实 GPU 验收探针。
 *
 * 前置：pnpm run editor 已在 5100（HTTPS/Tailscale 自签证书）启动。
 * 流程：启动 Play → 受控 spawnFracture（正式 P-01 profile）→ 推进固定帧 →
 *       统计 drawCall/三角形/碎片实例 → 截图 → Stop → 核动态 GPU 资源已释放。
 * 说明：这里的碎裂是渲染验收注入，不是真实武器破坏（WU-06）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_APP = process.env.WU05_URL ?? 'https://localhost:5100/';
const PORT = Number(process.env.WU05_CDP ?? 9444);
const OUT = path.resolve('.workbuddy/tmp/wu05-gpu');
const USER_DIR = path.join(OUT, 'profile');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--no-first-run', '--no-default-browser-check',
  '--ignore-certificate-errors',
  '--window-size=1280,800',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DIR}`,
  'about:blank',
], { detached: false, stdio: 'ignore' });

async function json(url) {
  const r = await fetch(url);
  return r.json();
}

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await json(`http://127.0.0.1:${PORT}/json/list`);
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('Chrome CDP 未就绪');
}

const ws = new WebSocket(await getWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
  } else if (msg.method === 'Runtime.exceptionThrown') {
    console.log('PAGE_EXCEPTION', JSON.stringify(msg.params.exceptionDetails?.text ?? ''));
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    console.log('PAGE_CONSOLE_ERROR', JSON.stringify(msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')));
  }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: URL_APP });

// 等编辑器与 GPU 就绪
let ready = false;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  try { if (await evalJs('typeof window.__editor === "object" && !!window.__editor.renderer.core.device')) { ready = true; break; } } catch { /* 加载中 */ }
}
if (!ready) throw new Error('编辑器未就绪（window.__editor / device 未出现）');

const gpu = await evalJs(`(()=>{const i=window.__editor.renderer.core.device.adapterInfo;return {secure:isSecureContext,fallback:i?.isFallbackAdapter??null,vendor:i?.vendor,arch:i?.architecture,desc:i?.description};})()`);
console.log('GPU', JSON.stringify(gpu));

// 启动 Play：玩家外观资产是异步加载的，加载完成前 start 会失败——按真实就绪轮询重试
let started = null;
for (let i = 0; i < 60; i++) {
  started = await evalJs(`(()=>{const c=window.__editor.playCtl;const ok=c.start();return {ok,state:c.state,error:c.error};})()`);
  if (started.ok) break;
  await sleep(500);
}
console.log('PLAY_START', JSON.stringify(started));
for (let i = 0; i < 60; i++) { await sleep(200); if (await evalJs('window.__editor.playCtl.fracture !== null && window.__editor.playCtl.fracture.backend() !== null')) break; }

// 受控激活正式 P-01 profile（渲染验收注入，非真实武器）
const spawnRes = await evalJs(`(async()=>{
  const c=window.__editor.playCtl;
  const pl=c.session.runtime?.player();
  // 近景取证：放在相机与玩家之间（碎片 ~0.3m，远看只有几个像素）
  const eye=window.__editor.renderer.getEye?.();
  // 近景：放在相机与玩家之间靠相机一侧，0.3m 的碎块才看得清切面/贴图
  const spawnPos=pl?(eye?[eye[0]+(pl.x-eye[0])*0.2, eye[1]+(pl.y-eye[1])*0.2+0.1, eye[2]+(pl.z-eye[2])*0.2]
    :[pl.x,pl.y+2.0,pl.z]):[0,3,0];
  const ev={sequence:1,tick:0,seed:11,
    profile:{path:'assets/fracture/p01-barrel/p01-barrel.fracture.json',guid:'as_p01frct'},
    target:{kind:'scene-object',runId:'wu05-probe',nodeId:'wu05-barrel'},
    position:spawnPos,rotation:[0,0,0,1],scale:[3,3,3],
    contact:spawnPos,normal:[0,1,0],impulse:[2,3,1],
    source:{weaponId:'w_pistol',hitSequence:1}};
  const r=await c.spawnFracture(ev);
  return {accepted:r.accepted,rejection:r.rejection??null};
})()`);
console.log('SPAWN', JSON.stringify(spawnRes));

// 编辑器主循环本身按 rAF 连续 update；先截空中翻滚，再等落地后截第二张
await sleep(900);
const shotAir = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, 'fracture-air.png'), Buffer.from(shotAir.data, 'base64'));
console.log('SHOT_AIR', path.join(OUT, 'fracture-air.png'));
await sleep(3000);
// Pause/Step 语义：暂停后碎片 tick 不变，单步 +1（与游戏时钟一致）
const pauseStep = await evalJs(
  "(()=>{const c=window.__editor.playCtl;const t0=c.fracture.runtime.stats.ticks;" +
  "c.pause();const tPause0=c.fracture.runtime.stats.ticks;" +
  "c.update(1/30);const tPause=c.fracture.runtime.stats.ticks;" +
  "c.step();const tStep=c.fracture.runtime.stats.ticks;c.resume();" +
  "return {t0,tPause0,tPause,tStep,frozen:tPause===tPause0,stepped:tStep===tPause+1};})()");
console.log('PAUSE_STEP', JSON.stringify(pauseStep));

// 原角色动态批次仍在（palette/skin 分支没有被刚体模式影响）
const charInfo = await evalJs(
  "(()=>{const bs=window.__editor.playCtl.fractureBatches;" +
  "const rb=window.__editor.renderer;" +
  "return {paletteUploaded:!!rb.core.dynamicPaletteBuf, charBatches:(window.__editor.bridge?.batches?.()??[]).length};})()");
console.log('CHARACTERS', JSON.stringify(charInfo));
const stats = await evalJs(`(()=>{
  const c=window.__editor.playCtl,r=window.__editor.renderer;
  return {frag:c.fractureRenderStats, batches:c.fractureBatches.length,
    draws:r.stats.drawCalls, tris:r.stats.triangles,
    dynSlots:r.core.dynamicInstSlots?.length??null,
    mats:c.fractureBatches.map(b=>({tex:!!b.albedo,tint:[b.instances[8],b.instances[9],b.instances[10]]})),
    solidMat:!!r.core.solidDynamicMaterialCache,
    dynMeshes:r.core.dynamicMeshes?.size??null, pending:r.core.ledger??null};
})()`);
console.log('STATS', JSON.stringify(stats));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(OUT, 'fracture-play.png'), Buffer.from(shot.data, 'base64'));
console.log('SHOT', path.join(OUT, 'fracture-play.png'));

// Stop：核 GPU 动态资源释放
const stopped = await evalJs(`(()=>{
  const c=window.__editor.playCtl,r=window.__editor.renderer;
  c.stop();
  return {state:c.state,batches:c.fractureBatches.length,
    dynSlots:r.core.dynamicInstSlots?.length??null,
    dynMeshes:r.core.dynamicMeshes?.size??null,pending:c.ledger.pending};
})()`);
console.log('STOP', JSON.stringify(stopped));

ws.close();
chrome.kill();
process.exit(0);
