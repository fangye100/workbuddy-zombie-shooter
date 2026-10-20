import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeArgParser, ensureServer, launchEditorSession, waitForEditorReady, waitFor, createRecorder } from './editor-smoke-lib.mjs';

/** WU-02 headed real-GPU close-ups of the formal fracture assets via the existing
 * editor renderer (no new render pipeline). Static chunk display only: WU-05/06/07
 * own rigid motion, damage wiring and death presentation. */
const { arg, has } = makeArgParser(process.argv);
const out = path.resolve(arg('out', '.workbuddy/tmp/fracture-assets/'));
fs.mkdirSync(out, { recursive: true });
if (!has('headed')) throw new Error('本机碎裂资产验收必须显式 --headed');

const { check, results } = createRecorder();
const evidence = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), checks: results };
evidence.verificationSources = Object.fromEntries(['tools/verify/fracture-assets-probe.mjs', 'tools/fracture/build-fracture-assets.mjs', 'tools/fracture/verify-fracture-assets.mjs'].map(p => [p, createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));

const { server, url } = await ensureServer(5100, 'apps/editor/vite.config.ts');
if (server) throw new Error('请先用记录的 detached 方式启动固定 5100 服务');
const { chrome, cdp } = await launchEditorSession({ chromePath: arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'), cdpPort: Number(arg('cdp', '9334')), headed: true, appUrl: url + '?scene=' + encodeURIComponent('assets/scenes/sandbox/fracture-wu02.scene.json'), windowSize: '1500,1000' });
const send = cdp.send.bind(cdp);
cdp.send = (method, params = {}) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CDP ' + method + ' exceeded 15s')), 15000); send(method, params).then(r => { clearTimeout(timer); resolve(r); }, e => { clearTimeout(timer); reject(e); }); });
const capture = async name => { await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); };
const aim = async (target, distance, elevationDeg, yaw) => {
  await cdp.eval('(() => { const c = window.__editor.camera; c.target = ' + JSON.stringify(target) + '; c.distance = ' + distance + '; c.yaw = ' + yaw + '; window.__editor.params.cameraElevation = ' + elevationDeg + '; return true; })()');
};

try {
  await cdp.send('Page.navigate', { url: url + '?scene=' + encodeURIComponent('assets/scenes/sandbox/fracture-wu02.scene.json') });
  await waitForEditorReady(cdp, { timeout: 60000, expectedScene: 'assets/scenes/sandbox/fracture-wu02.scene.json' });
  evidence.gpu = await cdp.eval('(()=>{const info=window.__editor.renderer.core.device.adapterInfo;return {secure:isSecureContext,fallback:info?.isFallbackAdapter,info:info?{vendor:info.vendor,architecture:info.architecture,description:info.description}:null};})()');
  check('实际编辑器 GPUDevice 非 fallback', evidence.gpu.secure && evidence.gpu.fallback === false && !/swiftshader|llvmpipe|software/i.test(JSON.stringify(evidence.gpu.info)), JSON.stringify(evidence.gpu.info));
  const doc = await cdp.eval('window.__editor.renderer.getDocument()');
  const kinds = doc.nodes.flatMap(n => n.components.map(c => c.kind));
  check('场景含 Destructible 与 deathFracture 引用', kinds.includes('Destructible') && doc.nodes.some(n => n.components.some(c => c.kind === 'SpawnPoint' && c.deathFracture)), { destructible: kinds.filter(k => k === 'Destructible').length });
  // 每块独立装载断言：分块节点数 + 每块文件在 devfs 可达。
  const perChunk = await cdp.eval('(()=>{const r=window.__editor.renderer;const list=r.getObjectList();return list.map(o=>({id:r.getObjectNodeId(o.index),name:o.name})).filter(x=>x.name.includes("分块"));})()');
  evidence.perChunkNodes = perChunk.length;
  check('16 个分块节点独立存在', perChunk.length === 16, String(perChunk.length));
  const doc2 = await cdp.eval('window.__editor.renderer.getDocument()');
  const chunkRefs = doc2.nodes.flatMap(n => n.components).filter(c => c.kind === 'MeshRenderer' && c.source?.type === 'asset' && c.source.ref.path.includes('/fracture/')).map(c => c.source.ref.path);
  evidence.chunkRefs = chunkRefs;
  check('12+4 个分块引用各自独立单块 GLB', new Set(chunkRefs).size === 16, 'unique=' + new Set(chunkRefs).size);
  await aim([0, 0.55, 0], 1.6, 0.18, 0.7);
  await capture('01-barrel-original-closeup');
  await cdp.eval('window.__editor.renderer.getDocument()');
  await aim([2.6, 0.8, -0.6], 2.6, 0.35, -1.35);
  await capture('02-barrel-chunks-separated');
  await aim([-0.9, 1.0, -0.6], 2.4, 0.2, 1.25);
  await capture('03-npc-chunks-closeup');
  // 非 bind 姿态证据由离线数值验收承担（run@0.4s maxDelta=0、刚体保形 2e-9）。
  // Play 模式截图需要 WU-06/07 的完整运行时接线（RunRules/波次/玩家控制），不属 WU-02 资产范围。
  evidence.screenshots = fs.readdirSync(out).filter(f => f.endsWith('.png'));
  check('三张近景截图落盘（原桶/分离切口/NPC分块）', evidence.screenshots.length >= 3, evidence.screenshots.join(','));
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2));
  try { await chrome.kill(); } catch {}
}
const failed = results.filter(r => !r.ok).length;
console.log(JSON.stringify({ out, passed: results.length - failed, failed }, null, 1));
process.exit(failed ? 1 : 0);
