/**
 * WU-07 headed 真实 GPU/原生输入验收：NPC 致死碎裂。
 * - 原生数字键切枪 + 原生 J 开火，真实狙击（贯穿）致死正式 E-04；
 * - 死亡瞬间冻结最后可见姿态（非 bind，冲锋/行进途中），真 Rapier/GPU 接管；
 * - 成功接管才抑制该身份死亡尾部；未配置 E-01 对照走普通死亡；
 * - Reset 恢复两个 NPC 与干净碎片态，Stop 释放账目。
 * 冲锋型近战 NPC 无法站桩瞄准：逐发「暂停中投影瞄准 → 短暂恢复运行态 →
 * 原生 J 击发 → 再暂停」。每次击发与伤害都发生在真实运行态，暂停只是玩家
 * 合法操作；世界每周期只推进 ~0.4s，NPC 全程留在远程。
 */
import fs from 'node:fs';
import path from 'node:path';
import {sleep, waitFor, createRecorder, makeArgParser} from './editor-smoke-lib.mjs';
import {runGameProbe, navigateProbeScene, playPaused, stopProbe} from './game-probe-lib.mjs';

const {arg, has} = makeArgParser(process.argv);
const OUT_DIR = path.resolve(arg('out', '.workbuddy/tmp/wu07-npc-death'));
fs.mkdirSync(OUT_DIR, {recursive: true});
const {results, check, summary} = createRecorder();
const SCENE = 'assets/scenes/sandbox/fracture-wu07.scene.json';
const shotLog = [];

async function shot(cdp, name) {
  const s = await cdp.send('Page.captureScreenshot', {format: 'png'});
  fs.writeFileSync(path.join(OUT_DIR, name + '.png'), Buffer.from(s.data, 'base64'));
}

async function equip(cdp, key, id) {
  await cdp.eval("(()=>{const a=document.activeElement;if(a instanceof HTMLElement)a.blur();document.body.setAttribute('tabindex','-1');document.body.focus();})()");
  await sleep(120);
  for (let attempt = 0; attempt < 3; attempt++) {
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key, code: 'Digit' + key, windowsVirtualKeyCode: 48 + Number(key)});
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key, code: 'Digit' + key, windowsVirtualKeyCode: 48 + Number(key)});
    const r = await waitFor(async () => {
      const equipped = await cdp.eval('window.__editor.playCtl.session.runtime.weapons.equippedId');
      return equipped === id ? {equipped} : null;
    }, {timeout: 3000, interval: 60, label: '原生数字键切到 ' + id});
    if (r !== null) return r;
    await sleep(400);
  }
  console.log('  [equip-diag] ' + JSON.stringify(await cdp.eval("(()=>{const c=window.__editor.playCtl;const r=c.session.runtime;return {equipped:r.weapons.equippedId,paused:c.isPaused,outcome:r.outcome};})()")));
  return null;
}

const npcView = (cdp, characterId) => cdp.eval(
  "(()=>{const v=window.__editor.playCtl.session.runtime.view().find(v=>v.kind==='npc'&&v.characterId==='" + characterId + "');return v?{id:v.id,generation:v.generation,runId:v.runId,x:v.x,y:v.y??0,z:v.z,behavior:v.behavior,hp:v.hp}:null;})()");

const playerHp = (cdp) => cdp.eval('window.__editor.playCtl.session.runtime.player().hp');

const isPaused = (cdp) => cdp.eval('window.__editor.playCtl.isPaused');
const togglePause = (cdp) => cdp.eval("document.querySelector('#btn-pause').click()");

async function click(cdp, selector) {
  const p = await cdp.eval(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  if (!p) throw new Error('控件不可用：' + selector);
  await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',...p,button:'left',clickCount:1});
  await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',...p,button:'left',clickCount:1});
}

async function chooseReward(cdp) {
  if (!await cdp.eval('!!window.__editor.playCtl.session.runtime.progress?.choosing')) return;
  await click(cdp, '.talent-choices button:last-child');
  const chosen = await waitFor(() => cdp.eval('!window.__editor.playCtl.session.runtime.progress?.choosing'), {timeout:2000,interval:50,label:'原生点击完成强化选择'});
  if (!chosen) throw new Error('强化面板仍在阻止战斗输入');
}

async function verifyObservation(cdp, details) {
  const camera = () => cdp.eval('(()=>{const e=window.__editor;return {yaw:e.camera.yaw,distance:e.camera.distance,target:[...e.camera.target],observing:e.playCtl.observing,tick:e.playCtl.tick};})()');
  const before = await camera();
  await click(cdp, '#btn-observation-camera');
  const p = await cdp.eval("(()=>{const c=document.querySelector('#gpu'),r=c.getBoundingClientRect();for(const fy of [.5,.4,.6,.3])for(const fx of [.25,.3,.65,.7]){const x=r.left+r.width*fx,y=r.top+r.height*fy;if([[x,y],[x+80,y+20],[x+25,y+15]].every(([a,b])=>document.elementFromPoint(a,b)===c))return {x,y};}throw new Error('没有未遮挡的观察拖拽区域');})()");
  async function drag(button, dx, dy) {
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button,clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+dx,y:p.y+dy,button,buttons:button==='left'?1:2});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x+dx,y:p.y+dy,button,clickCount:1});
    await sleep(100);
  }
  await drag('left',80,20);
  const orbit = await camera();
  await drag('right',25,15);
  const pan = await camera();
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaY:-160,deltaX:0});
  await sleep(100);
  const zoom = await camera();
  check('Pause 观察视角原生环绕/平移/缩放且不推进模拟', orbit.observing && Math.abs(orbit.yaw-before.yaw)>.1 && JSON.stringify(pan.target)!==JSON.stringify(orbit.target) && zoom.distance<pan.distance && zoom.tick===before.tick,JSON.stringify({before,orbit,pan,zoom}));
  await shot(cdp,'camera-observation');
  await click(cdp,'#btn-observation-camera');
  const restored = await camera();
  check('退出观察回到原游戏相机',!restored.observing && Math.abs(restored.yaw-before.yaw)<1e-6 && Math.abs(restored.distance-before.distance)<1e-6,JSON.stringify(restored));
  details.camera = {before,orbit,pan,zoom,restored};
}

/** 分段射击：暂停中投影瞄准 → 恢复 → 验 aimPoint → 原生 J 击发 → 再暂停。 */
async function shootNpc(cdp, characterId, maxRounds) {
  for (let round = 0; round < maxRounds; round++) {
    await chooseReward(cdp);
    const alive = await npcView(cdp, characterId);
    if (alive === null) return {outcome: 'dead', rounds: round};
    const hp = await playerHp(cdp);
    if (hp < 30) return {outcome: 'player-dead', rounds: round};
    if (!(await isPaused(cdp))) { await togglePause(cdp); await sleep(150); }
    await togglePause(cdp); // 恢复运行态：鼠标移动必须在运行态（暂停下 pointermove 被 enabled 守卫丢弃）
    await sleep(100); // 等一帧让 GameControls 重新 enable（恢复当帧仍是 disabled，事件会被丢）
    // GameControls 把指针与 y=.9 平面相交。投影相同高度，避免猜测屏幕偏移。
    const proj = await cdp.eval(`(()=>{const e=window.__editor,v=e.playCtl.session.runtime.view().find(v=>v.kind==='npc'&&v.characterId===${JSON.stringify(characterId)});return v?e.renderer.worldToScreen([v.x,.9,v.z]):null;})()`);
    const hpBefore = alive.hp;
    if (!proj || proj.behind) throw new Error('NPC 不在可见射击方向');
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: proj.x, y: proj.y});
    await sleep(70);
    const aim = await cdp.eval('window.__editor.playCtl.session.runtime.aimPoint');
    if(characterId==='E-04') await shot(cdp,'e04-live-'+round);
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    await sleep(1200); // 武器 CD 使用固定模拟时钟，必须在运行态推进。
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    const fired = true;
    await sleep(fired ? 160 : 120);
    if (await isPaused(cdp) === false) await togglePause(cdp); // 再暂停（世界只在击发窗口推进）
    const afterNpc = await npcView(cdp, characterId);
    shotLog.push({key: characterId + ':' + round, fired, proj, aim, hpBefore, hpAfter: afterNpc?.hp ?? null, npc: afterNpc, player: await playerHp(cdp)});
    await sleep(150);
  }
  return {outcome: (await npcView(cdp, characterId)) === null ? 'dead' : 'alive', rounds: maxRounds};
}

async function main() {
  return runGameProbe({
    name: 'wu07-npc-death', outDir: OUT_DIR, port: Number(arg('port', 5100)), cdpPort: Number(arg('cdp', 9482)),
    chromePath: arg('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), headed: has('headed'),
    windowSize: arg('window-size', '1280,800'), windowPosition: arg('window-position', '1920,80'), url: arg('url', null),
    scene: arg('scene', SCENE), results, check, summary,
  }, async ({cdp, details, url}) => {
    await navigateProbeScene(cdp, url, SCENE);
    try {
      const win = await cdp.send('Browser.getWindowForTarget');
      const bounds = await cdp.send('Browser.getWindowBounds', {windowId: win.windowId});
      check('验证窗口固定在 DISPLAY1', bounds.bounds.left >= 1900, JSON.stringify(bounds.bounds));
      details.window = bounds.bounds;
    } catch (e) { check('验证窗口固定在 DISPLAY1', false, String(e)); }

    await cdp.eval("document.querySelector('.scene-current')?.click()");
    await sleep(200);
    const listed = await cdp.eval("[...document.querySelectorAll('.scene-choice')].some(b=>b.textContent.includes('致死碎裂'))");
    await cdp.eval("document.querySelector('.scene-browser')?.close()");
    check('WU-07 场景由原场景选择器可达', listed === true);

    await playPaused(cdp); // 保持暂停完成装备；射击阶段逐发恢复/暂停
    for (let i = 0; i < 100; i++) { if (await cdp.eval('!!window.__editor.playCtl.fracture?.backend()')) break; await sleep(50); }
    await sleep(600);
    await verifyObservation(cdp, details);

    const initial = await cdp.eval("(()=>{const e=window.__editor,r=e.playCtl.session.runtime;const e04=r.desc.spawns.find(s=>s.nodeId==='nd_w7_spawn_e04');const e01=r.desc.spawns.find(s=>s.nodeId==='nd_w7_spawn_e01');return {e04Cfg:JSON.stringify(e04&&e04.deathFracture),e01Cfg:JSON.stringify(e01&&e01.deathFracture),npc:r.view().filter(v=>v.kind==='npc').map(v=>({c:v.characterId,hp:v.hp})),player:r.player().hp,batches:e.playCtl.fractureBatches.length,error:e.playCtl.destructibleError};})()");
    details.initial = initial;
    check('E-04 刷怪点携带 deathFracture、E-01 对照未配置', initial.e04Cfg.includes('as_e04frct') && initial.e01Cfg === 'null', JSON.stringify({e04: initial.e04Cfg, e01: initial.e01Cfg}));
    check('两个 NPC 装载（E-04 hp220 + E-01）', initial.npc.length === 2 && initial.npc.some(n => n.c === 'E-04' && n.hp === 220), JSON.stringify(initial.npc));

    // 暂停中切枪（GameControls 在运行态才吃键：暂停不可切 → 先恢复切枪再立刻暂停）
    await togglePause(cdp);
    await sleep(150);
    const equipped = await equip(cdp, '4', 'sniper');
    check('原生数字键切到 sniper', !!equipped);
    await togglePause(cdp);
    await sleep(150);

    // 对照组先行（远程一发普通死亡）：E-01 走得慢，但若拖到 E-04 长循环之后会贴脸。
    const plain01 = await shootNpc(cdp, 'E-01', 6);
    await sleep(500);
    const contrastEarly = await cdp.eval("(()=>{const c=window.__editor.playCtl;const rt=c.fracture.runtime;return {active:rt.active.length,queued:rt.stats.queuedEvents,error:c.destructibleError};})()");
    details.contrastEarly = {plain01, contrastEarly};
    check('对照 E-01 普通死亡：不触发碎裂、无诊断', plain01.outcome === 'dead' && contrastEarly.active === 0 && contrastEarly.queued === 0 && contrastEarly.error === null, JSON.stringify({plain01, contrastEarly}));
    await shot(cdp, 'contrast-death');

    const spawn04 = await npcView(cdp, 'E-04') ?? {x: 2.5, z: -5.3};
    const kill04 = await shootNpc(cdp, 'E-04', 18);
    details.playerHpAfterKill04 = await playerHp(cdp);
    details.kill04 = kill04;
    if (await isPaused(cdp)) await togglePause(cdp); // 碎片激活需要运行态 tick
    let killed04 = null;
    if (kill04.outcome === 'dead') {
      killed04 = await waitFor(async () => {
        const s = await cdp.eval("(()=>{const c=window.__editor.playCtl;const rt=c.fracture.runtime;const gpu=new Set(c.fractureBatches.map(b=>b.meshId)).size;const corpse=c.bridge.batches().filter(b=>b.meshId==='actor:E-04').reduce((n,b)=>n+b.count,0);return rt.active.length===10&&gpu===10&&corpse===0?{active:rt.active.length,rigid:rt.stats.rigidActive,queued:rt.stats.queuedEvents,error:c.destructibleError,gpu,corpse}:null;})()");
        return s;
      }, {timeout: 6000, interval: 100, label: 'E-04 碎片激活（10 块）'});
    }
    check('原生狙击真实致死 E-04 并激活 10 块（3 大 7 小）', killed04 !== null && killed04.active === 10 && killed04.rigid === 3, JSON.stringify({kill04, killed04}));
    check('致死碎裂无诊断错误', killed04 !== null && killed04.error === null, JSON.stringify(killed04?.error));
    const last04 = shotLog.filter(s => s.key.startsWith('E-04:') && s.npc !== null).pop();
    const displacement04 = last04 && last04.npc ? Math.hypot(last04.npc.x - spawn04.x, last04.npc.z - spawn04.z) : 0;
    details.e04Move = {spawn: spawn04, last: last04?.npc ?? null, displacement: displacement04};
    check('E-04 在冲锋/行进途中被击杀（非 bind 的活体姿态）', displacement04 > 0.3 || (last04?.npc?.behavior ?? 0) >= 1, JSON.stringify(details.e04Move));
    await shot(cdp, 'e04-walking');

    const suppressed = await cdp.eval("(()=>{const b=window.__editor.playCtl.bridge.batches();const mine=b.filter(x=>x.meshId==='actor:E-04');return {count:mine.reduce((a,x)=>a+x.count,0),batches:b.length};})()");
    details.deathSuppressed = suppressed;
    check('成功接管抑制该身份死亡尾部（E-04 批次 0 实例）', killed04 !== null && suppressed.count === 0, JSON.stringify(suppressed));

    const frag = await cdp.eval("(()=>{const c=window.__editor.playCtl,rows=[];for(const a of c.fracture.runtime.active){const b=c.fractureBatches.find(b=>b.vertices===a.bakedVertices);if(!b||!b.rigid||!a.pivot)continue;const r=b.rigid,p=a.pivot,t=b.instances;rows.push([t[0]+r[0]*p[0]+r[4]*p[1]+r[8]*p[2],t[1]+r[1]*p[0]+r[5]*p[1]+r[9]*p[2],t[2]+r[2]*p[0]+r[6]*p[1]+r[10]*p[2]]);}return {batches:c.fractureBatches.length,rows,initial:c.fracture.runtime.active.map(a=>({id:a.handle.chunkId,position:a.worldPosition,radius:a.supportRadius}))};})()");
    details.fragments = frag;
    check('碎块在死亡位置接管（非原点/bind）', frag.rows.length >= 10 && frag.rows.every(p => Math.abs(p[0]) < 8 && Math.abs(p[2]) < 8 && p[1] > -0.5 && p[1] < 4), JSON.stringify(frag.rows.slice(0, 4)));
    await shot(cdp, 'e04-fractured');
    // 迟到激活核对：E-04 的 10 块在击杀后（运行态）激活，E-01 未新增任何碎片。
    const after04 = await cdp.eval("(()=>{const c=window.__editor.playCtl;const rt=c.fracture.runtime;return {active:rt.active.length,queued:rt.stats.queuedEvents,error:c.destructibleError};})()");
    details.after04 = after04;
    check('对照 E-01 无新增碎片（仅 E-04 的 10 块）', after04.active === 10 && after04.queued === 0 && after04.error === null, JSON.stringify(after04));

    if(!await isPaused(cdp)) await click(cdp,'#btn-pause');
    const frozen = await cdp.eval('window.__editor.playCtl.fracture.runtime.stats.ticks');
    await sleep(350);
    check('Pause 冻结真实碎片时钟',await cdp.eval('window.__editor.playCtl.fracture.runtime.stats.ticks')===frozen,String(frozen));
    await click(cdp,'#btn-step');
    const stepped=await cdp.eval('window.__editor.playCtl.fracture.runtime.stats.ticks');
    check('原生 Step 恰推进一次碎片固定步',stepped===frozen+1,JSON.stringify({frozen,stepped}));
    const alignment=await cdp.eval(`(()=>{const c=window.__editor.playCtl,rt=c.fracture.runtime,bk=c.fracture.backend();let error=0,matched=0;for(const a of rt.active){const b=c.fractureBatches.find(b=>b.vertices===a.bakedVertices);const p=a.pivot;if(!b||!p||!b.rigid)continue;const s=a.layer==='rigid'?bk.snapshot(a.handle):a.sim;const row=b.instances,r=b.rigid;const actual=[row[0]+r[0]*p[0]+r[4]*p[1]+r[8]*p[2],row[1]+r[1]*p[0]+r[5]*p[1]+r[9]*p[2],row[2]+r[2]*p[0]+r[6]*p[1]+r[10]*p[2]];error=Math.max(error,...actual.map((v,i)=>Math.abs(v-s.position[i])));matched++;}return {matched,error};})()`);
    details.alignment=alignment;
    check('同帧真实后端/简化位置与原动态 GPU 实例/pivot 一致',alignment.matched===10&&alignment.error<1e-4,JSON.stringify(alignment));
    await click(cdp,'#btn-observation-camera');
    const canvasPoint=await cdp.eval("(()=>{const c=document.querySelector('#gpu'),r=c.getBoundingClientRect();for(const f of [.3,.7,.2]){const p={x:r.left+r.width*f,y:r.top+r.height*.5};if(document.elementFromPoint(p.x,p.y)===c)return p;}throw new Error('近景缩放区域被遮挡');})()");
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...canvasPoint});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...canvasPoint,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:canvasPoint.x+520,y:canvasPoint.y+70,buttons:1,button:'left'});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:canvasPoint.x+520,y:canvasPoint.y+70,button:'left',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...canvasPoint,deltaX:0,deltaY:-450});
    await sleep(200);
    const framing=await cdp.eval("(()=>{const e=window.__editor,c=e.playCtl,a=c.fracture.runtime.active.find(a=>a.handle.chunkId==='torso');const s=a.layer==='rigid'?c.fracture.backend().snapshot(a.handle):a.sim;return e.renderer.worldToScreen(s.position);})()");
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...canvasPoint,button:'right',clickCount:1});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:canvasPoint.x+900-framing.x,y:canvasPoint.y+410-framing.y,buttons:2,button:'right'});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:canvasPoint.x+900-framing.x,y:canvasPoint.y+410-framing.y,button:'right',clickCount:1});
    await sleep(200);await shot(cdp,'e04-cut-close');
    await click(cdp,'#btn-observation-camera');
    await cdp.eval('(()=>{const c=window.__editor.playCtl;window.__wu07Old={runtime:c.fracture.runtime,backend:c.fracture.backend()};})()');

    await cdp.eval('window.__editor.playCtl.reset()');
    await sleep(1000);
    const reset = await cdp.eval("(()=>{const c=window.__editor.playCtl;const r=c.session.runtime;return {npc:r.view().filter(v=>v.kind==='npc').map(v=>({c:v.characterId,hp:v.hp})),active:c.fracture.runtime.active.length,batches:c.fractureBatches.length,error:c.destructibleError};})()");
    details.reset = reset;
    check('Reset 恢复两个 NPC 与干净碎片态', reset.npc.length === 2 && reset.npc.some(n => n.c === 'E-04' && n.hp === 220) && reset.active === 0 && reset.batches === 0 && reset.error === null, JSON.stringify(reset));
    const old=await cdp.eval('(()=>{const o=window.__wu07Old;return {disposed:o.runtime.disposed,active:o.runtime.active.length,pool:o.runtime.stats.poolActive,ledger:o.backend.ledger,newRuntime:window.__editor.playCtl.fracture.runtime!==o.runtime};})()');
    details.resetReleased=old;
    check('Reset 核旧 runtime/租约/真实后端已释放并换新代',old.disposed&&old.active===0&&old.pool===0&&old.ledger.dynamicBodies===0&&old.ledger.destroyed&&old.newRuntime,JSON.stringify(old));

    if (await isPaused(cdp)) await togglePause(cdp);
    await stopProbe(cdp, check);
    const stopped = await cdp.eval("(()=>{const c=window.__editor.playCtl;return {pending:c.ledger.pending,state:c.state};})()");
    details.stopped = stopped;
    check('Stop 后资源账目归零', stopped.pending === 0 && stopped.state === 'stopped', JSON.stringify(stopped));
    details.shots = shotLog;
    await shot(cdp, 'after-stop');
  });
}

main().catch(e => { console.error(e); process.exit(1); });

