/**
 * WU-05 S1 真实 GPU pivto 合批探针（headed，DISPLAY1）。
 *
 * 同一真实 GLB（chunk-0001）用两个不同合法 pivot 同时激活，检查：
 * - CPU 批次保留原始坐标、每实例平移补偿各自 pivot，世界坐标符合闭式参照；
 * - 这两个实例真正写进了 GPU 的 dynamic-instances buffer（拦截 queue.writeBuffer）；
 * - 同一路径仍只建一个 GPU mesh（同几何合批，不按 pivot 复制）。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchEditorSession, waitForEditorReady, isHardwareGpu, sleep } from './editor-smoke-lib.mjs';

const OUT = path.resolve('.workbuddy/tmp/wu05-pivot-gpu');
fs.mkdirSync(OUT, { recursive: true });
const SCENE = 'assets/scenes/act1/floor-1.scene.json';
const APP = 'https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=' + encodeURIComponent(SCENE);
const result = { app: APP };
let session = null;

try {
  session = await launchEditorSession({
    chromePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    cdpPort: 9472, headed: true, appUrl: APP,
    windowPosition: '1920,80', ignoreCertificateErrors: false, setupTimeoutMs: 20000,
  });
  const c = session.cdp;
  await c.send('Page.navigate', { url: APP });
  await c.send('Page.bringToFront');
  await waitForEditorReady(c, { expectedScene: SCENE, timeout: 60000 });
  result.gpu = await c.eval(`(()=>{const i=window.__editor.renderer.core.device.adapterInfo;
    return {secure:isSecureContext,fallback:i?.isFallbackAdapter??null,
      info:{vendor:i?.vendor,architecture:i?.architecture,description:i?.description}};})()`);
  assert.ok(isHardwareGpu(result.gpu), '真实硬件 GPU 必需');

  let started = false;
  for (let n = 0; n < 60 && !started; n++) {
    started = await c.eval('(()=>{const e=window.__editor;if(!e.playCtl.start())return false;e.playCtl.pause();return true;})()');
    if (!started) await sleep(250);
  }
  assert.ok(started, 'Play 必须能启动');
  for (let i = 0; i < 100; i++) {
    if (await c.eval('!!window.__editor.playCtl.fracture?.backend()')) break;
    await sleep(50);
  }

  // 真实 GPU 写入拦截：只记录实例行，不改数据。
  await c.eval(`(()=>{const core=window.__editor.renderer.core,q=core.device.queue;
    const orig=q.writeBuffer.bind(q);window.__pivotWrites=[];
    q.writeBuffer=(buf,offset,data,...rest)=>{
      if(data instanceof Float32Array&&String(buf.label??'').startsWith('dynamic-instances-'))
        window.__pivotWrites.push({label:buf.label,head:Array.from(data).slice(0,40)});
      return orig(buf,offset,data,...rest);
    };return true;})()`);

  const meshCountBefore = await c.eval("window.__editor.renderer.core.dynamicMeshes.size");
  const playRes = await c.eval(`(()=>{
    const rt=window.__editor.playCtl.fracture.runtime;
    const event={sequence:1,tick:0,seed:1,profile:{path:'p.fracture.json',guid:'g'},
      target:{kind:'scene-object',runId:'pivot-probe',nodeId:'n'},position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],
      contact:[0,0,0],normal:[0,1,0],impulse:[1,0,0],source:{weaponId:'w',hitSequence:1}};
    const chunk=(id,pivot,x)=>({chunkId:id,cls:'large',mesh:{path:'assets/fracture/p01-barrel/chunk-0001.glb',guid:'as_p01c1'},
      position:[x,3,0],rotation:[0,0,0,1],scale:1,shape:{type:'sphere',radius:0.25},mass:1,friction:0.5,restitution:0,
      pivot,linearVelocity:[0,0,0],angularVelocity:[0,0,0]});
    const r=rt.play({event,chunks:[chunk('a',[0,0,0],0),chunk('b',[0.162673,0.114231,0.168472],0.5)],
      priority:1,lifetimeSec:10,fadeSec:0});
    return {accepted:r.accepted,rejection:r.rejection??null};})()`);
  assert.equal(playRes.accepted, true, 'runtime.play 必须 accepted');
  await c.eval('window.__pivotWrites=[]');
  for (let i = 0; i < 20; i++) { await c.eval('window.__editor.playCtl.step()'); await sleep(40); }
  await sleep(300);

  const observed = await c.eval(`(()=>{const e=window.__editor,c=e.playCtl,core=e.renderer.core;
    const bs=c.fractureBatches;
    const rows=[];
    for(const b of bs)for(let n=0;n<b.count;n++)rows.push({x:b.instances[n*20],raw:b.vertices[0],mesh:b.meshId});
    const heads=bs.map(b=>Array.from(b.instances).slice(0,40));
    const isFracture=(w)=>heads.some(h=>h.length===w.length&&h.every((v,i)=>Math.abs(v-w[i])<1e-6));
    return {batches:bs.length,counts:bs.map(b=>b.count),rows,
      meshCount:core.dynamicMeshes.size,
      writes:window.__pivotWrites.map(w=>({label:w.label,head:w.head,fracture:isFracture(w.head)}))};})()`);

  result.play = playRes;
  result.observed = observed;
  fs.writeFileSync(path.join(OUT, 'debug.json'), JSON.stringify({ rows: observed.rows, meshCount: observed.meshCount,
    writes: observed.writes.map((w) => ({ label: w.label, fracture: w.fracture, head: w.head.slice(0, 6) })) }, null, 2));
  console.log('DEBUG_WRITES', JSON.stringify(observed.writes.map((w) => w.label + ':' + w.fracture).slice(0, 20)));
  assert.equal(observed.batches, 2, '外表面/切口应为 2 个批次');
  assert.deepEqual(observed.counts, [2, 2], '每个批次应含两条实例（同几何合批）');
  assert.equal(observed.meshCount, meshCountBefore + 1, '同一路径只应新增 1 个 GPU mesh');
  assert.ok(observed.rows.every((r) => r.raw === observed.rows[0].raw), '同几何两条实例应共享同一份原始顶点');

  const xs = observed.rows.map((r) => r.x);
  // 同一 GLB、pivot 0 与 0.162673，body x=0 / 0.5 → 世界 x 的实例平移应差 0.5-0.162673。
  const mine = xs.filter((x) => Math.abs(x) < 1e-4);
  const other = xs.filter((x) => Math.abs(x - 0.337327) < 1e-3);
  assert.equal(mine.length, 2, '两个 pivot=0 的 part 平移应为 0');
  assert.equal(other.length, 2, '两个 pivot=0.162673 的 part 平移应为 0.337327');
  assert.equal(xs.some((x) => Math.abs(x - 0.5) < 1e-4), false, '不得退化成把第二个 pivot 当 0');

  // GPU 实际写入必须与 CPU 批次一致（不是只检查 key 字符串）。
  const uploads = observed.writes.filter((w) => w.fracture).flatMap((w) => w.head);
  assert.ok(uploads.length >= 40, '应捕获到碎片实例的 GPU 写入');
  assert.ok(uploads.some((x) => Math.abs(x) < 1e-4), 'GPU 实例写入应包含 0 平移');
  assert.ok(uploads.some((x) => Math.abs(x - 0.337327) < 1e-3), 'GPU 实例写入应包含补偿后的 0.337327');
  assert.equal(uploads.some((x) => Math.abs(x - 0.5) < 1e-4), false, 'GPU 写入不得出现未补偿的 0.5');

  const closed = await c.eval("(()=>{const e=window.__editor;e.playCtl.stop();return {slots:e.renderer.core.dynamicInstSlots.length,meshes:e.renderer.core.dynamicMeshes.size};})()");
  result.closed = closed;
  assert.equal(closed.slots, 0);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log('PIVOT_GPU_OK', JSON.stringify({ batches: observed.batches, counts: observed.counts, xs: xs.slice(0, 4), meshesAdded: observed.meshCount - meshCountBefore }));
  console.log('RESULT', path.join(OUT, 'result.json'));
} finally {
  if (session) { try { session.ws.close(); } catch { /* closed */ } try { session.chrome.kill(); } catch { /* exited */ } }
}

