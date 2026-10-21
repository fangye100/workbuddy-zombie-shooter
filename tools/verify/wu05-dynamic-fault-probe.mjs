/**
 * WU-05 S2 真实 GPU 事务探针（headed，DISPLAY1）。
 *
 * 目的：在真实 nvidia GPU 上，让动态实例槽/材质的各个新增分配阶段依次失败，
 * 检查产品自身是否立即回收本次新建资源、记录可见诊断、且不把异常抛进主帧；
 * 恢复后继续绘制，Stop 后所有本次跟踪资源真实销毁。
 *
 * 用法：pnpm run editor 已在 5100 运行时执行
 *   node tools/verify/wu05-dynamic-fault-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchEditorSession, waitForEditorReady, isHardwareGpu, sleep } from './editor-smoke-lib.mjs';

const OUT = path.resolve('.workbuddy/tmp/wu05-faults');
fs.mkdirSync(OUT, { recursive: true });
const SCENE = 'assets/scenes/act1/floor-1.scene.json';
const APP = 'https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=' + encodeURIComponent(SCENE);
const results = { app: APP, stages: [] };
let session = null;

const spawnArgs = {
  sequence: 1, tick: 0, seed: 11,
  profile: { path: 'assets/fracture/p01-barrel/p01-barrel.fracture.json', guid: 'as_p01frct' },
  target: { kind: 'scene-object', runId: 'wu05-fault', nodeId: 'barrel' },
  rotation: [0, 0, 0, 1], scale: [3, 3, 3], normal: [0, 1, 0], impulse: [2, 3, 1],
  source: { weaponId: 'w_pistol', hitSequence: 1 },
};

try {
  session = await launchEditorSession({
    chromePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    cdpPort: 9471, headed: true, appUrl: APP,
    windowPosition: '1920,80', ignoreCertificateErrors: false, setupTimeoutMs: 20000,
  });
  const c = session.cdp;
  await c.send('Page.navigate', { url: APP });
  await c.send('Page.bringToFront');
  await waitForEditorReady(c, { expectedScene: SCENE, timeout: 60000 });

  try {
    const win = await c.send('Browser.getWindowForTarget');
    results.window = (await c.send('Browser.getWindowBounds', { windowId: win.windowId })).bounds;
  } catch { results.window = null; }

  results.gpu = await c.eval(`(()=>{const i=window.__editor.renderer.core.device.adapterInfo;
    return {secure:isSecureContext,fallback:i?.isFallbackAdapter??null,
      info:{vendor:i?.vendor,architecture:i?.architecture,description:i?.description}};})()`);
  assert.ok(isHardwareGpu(results.gpu), '真实硬件 GPU 必需');

  // 在真实 device 上包一层：按 stage 注入一次失败，并跟踪 dyn-/dynamic-/贴图对象。
  await c.eval(`(()=>{
    const core=window.__editor.renderer.core,d=core.device;
    const origBuffer=d.createBuffer.bind(d),origTexture=d.createTexture.bind(d),origGroup=d.createBindGroup.bind(d);
    const state={stage:null,tracked:[]};
    // 只跟踪动态批次材质阶段创建的贴图；场景/编辑器静态材质不属于本 owner。
    const origMaterialFor=core.materialFor.bind(core);
    core.materialFor=(b)=>{state.inMaterial=true;try{return origMaterialFor(b);}finally{state.inMaterial=false;}};
    state.track=(res,label)=>{const rec={res,label,destroyed:false};const destroy=res.destroy.bind(res);
      res.destroy=()=>{rec.destroyed=true;return destroy();};state.tracked.push(rec);};
    d.createBuffer=(desc)=>{
      const label=String(desc?.label??''),s=state.stage;
      if(s==='pose'&&label.startsWith('dynamic-pose-snapshots-')){state.stage=null;throw new Error('INJECT pose buffer');}
      if(s==='instances'&&label.startsWith('dynamic-instances-')){state.stage=null;throw new Error('INJECT instances buffer');}
      if(s==='rigid'&&label.startsWith('dynamic-rigid-')){state.stage=null;throw new Error('INJECT rigid buffer');}
      const b=origBuffer(desc);
      if(/^(dyn-|dynamic-)/.test(label))state.track(b,label);
      return b;
    };
    d.createTexture=(desc)=>{
      const label=String(desc?.label??''),s=state.stage;
      if(s==='material-texture'&&state.inMaterial&&label==='mipmapped-albedo'){state.stage=null;throw new Error('INJECT texture');}
      const t=origTexture(desc);
      if(state.inMaterial&&(label==='mipmapped-albedo'||label==='dyn-solid'))state.track(t,label);
      return t;
    };
    d.createBindGroup=(desc)=>{
      const label=String(desc?.label??''),s=state.stage;
      if(s==='slot-bindgroup'&&/^dynamic-\\d+$/.test(label)){state.stage=null;throw new Error('INJECT slot bindgroup');}
      if(s==='material-bindgroup'&&desc.layout===core.dynamicMaterialLayout){state.stage=null;throw new Error('INJECT material bindgroup');}
      if(s==='solid-bindgroup'&&label==='dyn-solid-material'){state.stage=null;throw new Error('INJECT solid bindgroup');}
      return origGroup(desc);
    };
    window.__wu05Fault=state;
    return true;
  })()`);

  const startPlay = async () => {
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
  };

  const spawn = () => c.eval(`(async()=>{const e=window.__editor,c=e.playCtl,p=c.session.runtime.player(),eye=e.renderer.getEye();
    const pos=[eye[0]+(p.x-eye[0])*0.2,eye[1]+((p.y??0)-eye[1])*0.2+0.1,eye[2]+(p.z-eye[2])*0.2];
    return c.spawnFracture(Object.assign(${JSON.stringify(spawnArgs)},{position:pos,contact:pos}));})()`);

  const waitBatches = async () => {
    for (let i = 0; i < 120; i++) {
      await c.eval('window.__editor.playCtl.step()');
      await sleep(30);
      if (await c.eval('window.__editor.playCtl.fractureBatches.length') > 0) return;
    }
    throw new Error('碎片批次未出现');
  };

  const observe = () => c.eval(`(()=>{const e=window.__editor,c=e.playCtl,core=e.renderer.core;
    const reg=new Set();
    for(const s of core.dynamicInstSlots){if(!s)continue;reg.add(s.buf);reg.add(s.poseBuf);reg.add(s.rigidBuf);}
    for(const m of core.dynamicMeshes.values()){reg.add(m.vbuf);reg.add(m.ibuf);reg.add(m.skinVb);}
    for(const m of core.dynamicMaterials.values())reg.add(m.texture);
    if(core.solidDynamicTexture)reg.add(core.solidDynamicTexture);
    if(core.dynamicPaletteBuf)reg.add(core.dynamicPaletteBuf);
    const alive=window.__wu05Fault.tracked.filter(r=>!r.destroyed);
    return {stage:window.__wu05Fault.stage,error:c.fractureRenderError,failures:c.fractureRenderFailures,
      batches:c.fractureBatches.length,draws:e.renderer.stats.drawCalls,slots:core.dynamicInstSlots.length,
      alive:alive.map(r=>r.label),orphans:alive.filter(r=>!reg.has(r.res)).map(r=>r.label)};})()`);

  const stopAndCheck = async (label) => {
    const closed = await c.eval(`(()=>{const e=window.__editor;e.playCtl.stop();
      return {slots:e.renderer.core.dynamicInstSlots.length,meshes:e.renderer.core.dynamicMeshes.size,
        materials:e.renderer.core.dynamicMaterials.size,alive:window.__wu05Fault.tracked.filter(r=>!r.destroyed).map(r=>r.label),
        ledger:e.playCtl.ledger};})()`);
    assert.equal(closed.alive.length, 0, label + ' Stop 后仍有未销毁资源: ' + closed.alive.join(','));
    assert.equal(closed.slots, 0, label + ' Stop 后实例槽未清空');
    assert.equal(closed.meshes, 0, label + ' Stop 后动态网格未清空');
    return closed;
  };

  const stages = ['pose', 'instances', 'rigid', 'slot-bindgroup', 'material-texture', 'material-bindgroup', 'solid-bindgroup'];
  for (const stage of stages) {
    await startPlay();
    const before = await observe();
    // 先注入再 spawn：新 play 的实例槽已随 Stop 清空，第一帧动态分配就会消费本次注入。
    await c.eval('window.__wu05Fault.stage=' + JSON.stringify(stage));
    const spawnRes = await spawn();
    assert.equal(spawnRes.accepted, true, stage + ' spawn 必须 accepted');
    await waitBatches();
    let consumed = false;
    for (let i = 0; i < 40; i++) {
      if (await c.eval('window.__wu05Fault.stage') === null) { consumed = true; break; }
      await c.eval('window.__editor.playCtl.step()');
      await sleep(30);
    }
    let mode = 'frame';
    // 若主帧已经把全部批次槽建好，用产品同一事务方法再触发一次（仍走真实 device）。
    if (!consumed && /^(pose|instances|rigid|slot-bindgroup)$/.test(stage)) {
      await c.eval('window.__wu05Fault.stage=' + JSON.stringify(stage));
      await c.eval('window.__editor.renderer.core.dynamicInstSlot(77,120,64)');
      consumed = await c.eval('window.__wu05Fault.stage===null');
      mode = 'direct';
    }
    if (!consumed && stage === 'solid-bindgroup') {
      // 纯色切口材质可能已被其它动态批建好；清掉缓存后走同一产品方法验证事务。
      await c.eval(`(()=>{const core=window.__editor.renderer.core;
        core.solidDynamicTexture?.destroy();core.solidDynamicTexture=null;core.solidDynamicMaterialCache=null;
        window.__wu05Fault.stage='solid-bindgroup';return core.solidDynamicMaterial();})()`);
      consumed = await c.eval('window.__wu05Fault.stage===null');
      mode = 'direct';
    }
    assert.ok(consumed, stage + ' 注入未被真实代码消费');
    const failed = await observe();
    assert.equal(failed.orphans.length, 0, stage + ' 失败瞬间存在未登记孤儿: ' + failed.orphans.join(','));
    assert.ok(failed.failures > before.failures, stage + ' 失败计数未增加');
    assert.ok(failed.error !== null, stage + ' 诊断不可见');
    assert.ok(failed.batches > 0, stage + ' 失败后其余批次应继续存在');
    // 恢复：解除注入后同一帧循环应重建并继续 draw，诊断回到“曾发生/已恢复”或 null。
    for (let i = 0; i < 40; i++) { await c.eval('window.__editor.playCtl.step()'); await sleep(25); }
    const recovered = await observe();
    assert.equal(recovered.orphans.length, 0, stage + ' 恢复后仍有孤儿');
    assert.ok(recovered.draws > 0, stage + ' 恢复后没有继续绘制');
    assert.ok(recovered.error === null || /曾发生/.test(recovered.error), stage + ' 恢复诊断口径不对: ' + recovered.error);
    const closed = await stopAndCheck(stage);
    results.stages.push({ stage, mode, before, spawn: spawnRes, failed, recovered, closed });
    console.log('STAGE', JSON.stringify({ stage, mode, failed, recovered: { draws: recovered.draws, error: recovered.error }, closed: { slots: closed.slots, alive: closed.alive } }));
  }

  // 重复失败：同一槽位连续两次失败，不得累积孤儿。
  await startPlay();
  await spawn();
  await waitBatches();
  const repeatBefore = await observe();
  for (let i = 0; i < 2; i++) {
    await c.eval('window.__wu05Fault.stage="rigid"');
    await c.eval('window.__editor.renderer.core.dynamicInstSlot(90, 120, 64)');
  }
  const repeat = await observe();
  assert.ok(repeat.failures >= repeatBefore.failures + 2, '重复失败计数应累计');
  assert.equal(repeat.orphans.length, 0, '重复失败产生孤儿: ' + repeat.orphans.join(','));
  const repeatClosed = await stopAndCheck('repeat');
  results.repeat = { before: repeatBefore, after: repeat, closed: repeatClosed };
  console.log('REPEAT', JSON.stringify({ failures: repeat.failures, orphans: repeat.orphans, aliveAfterStop: repeatClosed.alive }));

  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));
  console.log('RESULT', path.join(OUT, 'result.json'));
} finally {
  if (session) { try { session.ws.close(); } catch { /* 已关闭 */ } try { session.chrome.kill(); } catch { /* 已退出 */ } }
}
