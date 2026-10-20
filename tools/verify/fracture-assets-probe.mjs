import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeArgParser, ensureServer, launchEditorSession, waitForEditorReady, createRecorder } from './editor-smoke-lib.mjs';

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
const aim = async (target, distance, elevation, yaw) => { await cdp.eval('window.__editor.renderer.setEditorCamera && window.__editor.renderer.setEditorCamera(' + JSON.stringify({ target, distance, elevation, yaw }) + '); true'); };

try {
  await cdp.send('Page.navigate', { url: url + '?scene=' + encodeURIComponent('assets/scenes/sandbox/fracture-wu02.scene.json') });
  await waitForEditorReady(cdp, { timeout: 60000, expectedScene: 'assets/scenes/sandbox/fracture-wu02.scene.json' });
  evidence.gpu = await cdp.eval('(async()=>{const a=await navigator.gpu.requestAdapter({powerPreference:"high-performance"});return {secure:isSecureContext,isFallbackAdapter:a?.info?.isFallbackAdapter??a?.isFallbackAdapter??null,info:a?.info?{vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description}:null};})()');
  check('secure + nonfallback硬件GPU', evidence.gpu.secure && evidence.gpu.isFallbackAdapter === false && !/swiftshader|llvmpipe|software/i.test(JSON.stringify(evidence.gpu.info)), JSON.stringify(evidence.gpu.info));
  const doc = await cdp.eval('window.__editor.renderer.getDocument()');
  const kinds = doc.nodes.flatMap(n => n.components.map(c => c.kind));
  check('场景含 Destructible 与 deathFracture 引用', kinds.includes('Destructible') && doc.nodes.some(n => n.components.some(c => c.kind === 'SpawnPoint' && c.deathFracture)), { destructible: kinds.filter(k => k === 'Destructible').length });
  check('12 油桶分块 + 4 盾卫分块静态展示', kinds.filter(k => k === 'MeshRenderer').length >= 17, { meshRenderers: kinds.filter(k => k === 'MeshRenderer').length });
  evidence.gpuErrors = await cdp.eval('window.__editor.renderer.gpuErrors?.length ?? 0');
  check('渲染无 GPU 错误', evidence.gpuErrors === 0, String(evidence.gpuErrors));
  await aim([0, 0.55, 0], 1.6, 0.18, 0.7);
  await capture('01-barrel-original-closeup');
  await aim([2.6, 0.8, -0.6], 2.6, 0.35, -1.35);
  await capture('02-barrel-chunks-closeup');
  await aim([-0.9, 1.0, -0.6], 2.4, 0.2, 1.25);
  await capture('03-npc-chunks-closeup');
  evidence.screenshots = fs.readdirSync(out).filter(f => f.endsWith('.png'));
  check('三张近景截图落盘', evidence.screenshots.length >= 3, evidence.screenshots.join(','));
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(evidence, null, 2));
  try { await chrome.kill(); } catch {}
}
const failed = results.filter(r => !r.ok).length;
console.log(JSON.stringify({ out, passed: results.length - failed, failed }, null, 1));
process.exit(failed ? 1 : 0);
