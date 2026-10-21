/**
 * WU-05 S1 Reset/换代 GPU 几何身份探针（headed，DISPLAY1）。
 *
 * 同一路径在 Reset 后返回不同的 GLB 字节：CPU 顶点必须更新，core 必须建立新的
 * fracture GPU mesh 并重新上传顶点，不能复用旧 vbuf。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchEditorSession, waitForEditorReady, isHardwareGpu, sleep } from './editor-smoke-lib.mjs';

const OUT = path.resolve('.workbuddy/tmp/wu05-reset-geometry');
fs.mkdirSync(OUT, { recursive: true });
const SCENE = 'assets/scenes/act1/floor-1.scene.json';
const APP = 'https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=' + encodeURIComponent(SCENE);
const result = {};
let session = null;

try {
  session = await launchEditorSession({
    chromePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    cdpPort: 9473, headed: true, appUrl: APP,
    windowPosition: '1920,80', ignoreCertificateErrors: false, setupTimeoutMs: 20000,
  });
  const c = session.cdp;
  await c.send('Page.navigate', { url: APP });
  await c.send('Page.bringToFront');
  await waitForEditorReady(c, { expectedScene: SCENE, timeout: 60000 });
  const gpu = await c.eval(`(()=>{const i=window.__editor.renderer.core.device.adapterInfo;
    return {secure:isSecureContext,fallback:i?.isFallbackAdapter??null,
      info:{vendor:i?.vendor,architecture:i?.architecture}};})()`);
  assert.ok(isHardwareGpu(gpu), '真实硬件 GPU 必需');

  let started = false;
  for (let i = 0; i < 60 && !started; i++) {
    started = await c.eval('(()=>{const e=window.__editor;if(!e.playCtl.start())return false;e.playCtl.pause();return true;})()');
    if (!started) await sleep(250);
  }
  assert.ok(started, 'Play 必须能启动');
  for (let i = 0; i < 100; i++) { if (await c.eval('!!window.__editor.playCtl.fracture?.backend()')) break; await sleep(50); }

  await c.eval(`(()=>{
    window.__probeX=10;
    window.__mkGlb=(x)=>{
      const positions=new Float32Array([x,2,20, x+2,2,20, x,6,24]);
      const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
        meshes:[{primitives:[{attributes:{POSITION:0}}]}],
        accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3'}],
        bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength}],
        buffers:[{byteLength:positions.byteLength}]};
      const enc=new TextEncoder().encode(JSON.stringify(json));
      const jsonSize=Math.ceil(enc.length/4)*4;
      const out=new Uint8Array(28+jsonSize+positions.byteLength);
      const dv=new DataView(out.buffer);
      dv.setUint32(0,0x46546c67,true);dv.setUint32(4,2,true);dv.setUint32(8,out.length,true);
      dv.setUint32(12,jsonSize,true);dv.setUint32(16,0x4e4f534a,true);
      out.fill(32,20,20+jsonSize);out.set(enc,20);
      dv.setUint32(20+jsonSize,positions.byteLength,true);dv.setUint32(24+jsonSize,0x004e4942,true);
      out.set(new Uint8Array(positions.buffer),28+jsonSize);
      return out.buffer;
    };
    const fr=window.__editor.playCtl.fractureRenderer;
    fr.io.readBinary=async()=>window.__mkGlb(window.__probeX);
    const q=window.__editor.renderer.core.device.queue,orig=q.writeBuffer.bind(q);
    window.__probeVWrites=[];
    q.writeBuffer=(buf,offset,data,...rest)=>{
      if(/^dyn-.*-v$/.test(String(buf.label??'')))
        window.__probeVWrites.push({label:String(buf.label),first:Array.from(data).slice(0,1)});
      return orig(buf,offset,data,...rest);
    };
    return true;})()`);

  const makeEvent = (sequence) => ({
    sequence, tick: 0, seed: 1,
    profile: { path: 'p.fracture.json', guid: 'g' },
    target: { kind: 'scene-object', runId: 's1-reset-' + sequence, nodeId: 'n' },
    position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    contact: [0, 0, 0], normal: [0, 1, 0], impulse: [1, 0, 0],
    source: { weaponId: 'w', hitSequence: sequence },
  });
  const chunk = (id) => ({
    chunkId: id, cls: 'large', mesh: { path: 'probe-same.glb', guid: 'probe' },
    position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: 1,
    shape: { type: 'sphere', radius: 0.25 }, mass: 1, friction: 0.5, restitution: 0,
    pivot: [0, 0, 0], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
  });

  const play = (sequence) => c.eval(`(async()=>{const e=window.__editor,rt=e.playCtl.fracture.runtime;
    return rt.play({event:${JSON.stringify(makeEvent(sequence))},chunks:[${JSON.stringify(chunk('c' + sequence))}],
      priority:1,lifetimeSec:10,fadeSec:0});})()`);

  assert.equal((await play(1)).accepted, true);
  for (let i = 0; i < 80; i++) { await c.eval('window.__editor.playCtl.step()'); await sleep(30); if (await c.eval('window.__editor.playCtl.fractureBatches.length') > 0) break; }
  const before = await c.eval(`(()=>{const e=window.__editor,c=e.playCtl,core=e.renderer.core,b=c.fractureBatches[0];
    window.__probeMeshBefore=core.dynamicMeshes.get(b.meshId);
    return {vertex0:b.vertices[0],meshId:b.meshId,meshes:core.dynamicMeshes.size,writes:window.__probeVWrites.slice()};})()`);
  assert.ok(Math.abs(before.vertex0 - 10) < 1e-5, '首代 CPU 顶点应为 10');
  assert.ok(before.writes.some((w) => Math.abs(w.first[0] - 10) < 1e-5), '首代应真实上传顶点 10');

  await c.eval('window.__probeX=20; window.__editor.playCtl.reset(); true');
  for (let i = 0; i < 100; i++) { if (await c.eval('!!window.__editor.playCtl.fracture?.backend()')) break; await sleep(50); }
  await c.eval('window.__probeVWrites=[]');
  assert.equal((await play(2)).accepted, true);
  for (let i = 0; i < 80; i++) { await c.eval('window.__editor.playCtl.step()'); await sleep(30); if (await c.eval('window.__editor.playCtl.fractureBatches.length') > 0) break; }
  const after = await c.eval(`(()=>{const e=window.__editor,c=e.playCtl,core=e.renderer.core,b=c.fractureBatches[0];
    return {vertex0:b.vertices[0],meshId:b.meshId,meshes:core.dynamicMeshes.size,
      sameMeshEntry:core.dynamicMeshes.get(b.meshId)===window.__probeMeshBefore,writes:window.__probeVWrites.slice()};})()`);

  result.before = before;
  result.after = after;
  assert.ok(Math.abs(after.vertex0 - 20) < 1e-5, 'Reset 后 CPU 顶点应为 20');
  assert.notEqual(after.meshId, before.meshId, 'Reset 后几何身份必须变化');
  assert.equal(after.sameMeshEntry, false, '不得复用旧 GPU mesh 条目');
  assert.ok(after.writes.some((w) => Math.abs(w.first[0] - 20) < 1e-5), 'Reset 后必须真实上传新顶点 20');
  assert.equal(after.meshes, before.meshes, '旧 fracture mesh 应在 Reset 时释放，不累积');

  const closed = await c.eval('(()=>{const e=window.__editor;e.playCtl.stop();return {slots:e.renderer.core.dynamicInstSlots.length,meshes:e.renderer.core.dynamicMeshes.size};})()');
  assert.equal(closed.slots, 0); assert.equal(closed.meshes, 0);
  result.closed = closed;
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log('RESET_GEOMETRY_OK', JSON.stringify({ beforeMesh: before.meshId, afterMesh: after.meshId, vertex0: after.vertex0, meshes: after.meshes }));
} finally {
  if (session) { try { session.ws.close(); } catch { /* closed */ } try { session.chrome.kill(); } catch { /* exited */ } }
}
