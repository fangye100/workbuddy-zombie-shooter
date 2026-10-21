/**
 * WU-06 headed 真实 GPU/原生输入验收：
 * - 原生数字键切枪、原生鼠标瞄准与 J 开火，真实武器伤害破坏正式 P-01 物体；
 * - 一次状态转换、完整显示隐藏、射线穿透、动态导航撤销与对照保留；
 * - 真实爆炸的范围/遮挡语义与 Reset/Stop 恢复。
 */
import fs from 'node:fs';
import path from 'node:path';
import {sleep, waitFor, createRecorder, makeArgParser} from './editor-smoke-lib.mjs';
import {runGameProbe, navigateProbeScene, playPaused, stopProbe} from './game-probe-lib.mjs';

const {arg, has} = makeArgParser(process.argv);
const OUT_DIR = path.resolve(arg('out', '.workbuddy/tmp/wu06-destructible'));
fs.mkdirSync(OUT_DIR, {recursive: true});
const {results, check, summary} = createRecorder();
const SCENE = 'assets/scenes/sandbox/fracture-wu06.scene.json';

async function shot(cdp, name) {
  const s = await cdp.send('Page.captureScreenshot', {format: 'png'});
  fs.writeFileSync(path.join(OUT_DIR, name + '.png'), Buffer.from(s.data, 'base64'));
}

async function equip(cdp, key, id) {
  // 关掉场景选择器后焦点可能落在输入控件；键位事件必须回到页面主体。
  await cdp.eval("(()=>{const a=document.activeElement;if(a instanceof HTMLElement)a.blur();document.body.setAttribute('tabindex','-1');document.body.focus();})()");
  // 原生输入要求运行态：前面若因终态/测试暂停，先恢复再发键。
  if (await cdp.eval('window.__editor.playCtl.isPaused')) await cdp.eval('window.__editor.playCtl.resume()');
  await sleep(80);
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key, code: 'Digit' + key, windowsVirtualKeyCode: 48 + Number(key)});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key, code: 'Digit' + key, windowsVirtualKeyCode: 48 + Number(key)});
  return waitFor(async () => {
    const equipped = await cdp.eval('window.__editor.playCtl.session.runtime.weapons.equippedId');
    return equipped === id ? {equipped} : null;
  }, {timeout: 4000, interval: 60, label: '原生数字键切到 ' + id});
}

async function aimAt(cdp) {
  const proj = await cdp.eval("(()=>{const e=window.__editor;const p=e.renderer.worldToScreen([0,0.9,0]);const r=document.querySelector('#gpu').getBoundingClientRect();return {p,rect:{l:r.left,t:r.top,w:r.width,h:r.height}};})()");
  const baseX = proj.p && !proj.p.behind ? proj.p.x : proj.rect.l + proj.rect.w / 2;
  const baseY = proj.p && !proj.p.behind ? proj.p.y : proj.rect.t + proj.rect.h / 2;
  let best = null;
  for (let dy = -50; dy <= 50; dy += 10) {
    for (let dx = -90; dx <= 90; dx += 10) {
      const x = baseX + dx, y = baseY + dy;
      if (x < proj.rect.l || x > proj.rect.l + proj.rect.w || y < proj.rect.t || y > proj.rect.t + proj.rect.h) continue;
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
      await sleep(18);
      const p = await cdp.eval("window.__editor.playCtl.session.runtime['aimPoint']");
      if (!Array.isArray(p)) continue;
      const d = Math.hypot(p[0], p[1]);
      if (best === null || d < best.d) best = {x, y, d, point: p};
    }
  }
  if (best === null) return {canvas: false, behind: true};
  await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: best.x, y: best.y});
  await sleep(80);
  return {x: best.x, y: best.y, d: best.d, point: best.point, canvas: true, behind: false};
}

async function waitBroken(cdp, nodeId, timeout = 9000) {
  return waitFor(async () => {
    const v = await cdp.eval(`(()=>{const c=window.__editor.playCtl;const s=c.session.runtime.destructibleSnapshot().find(x=>x.nodeId==='${nodeId}');return s&&s.broken?{snap:c.session.runtime.destructibleSnapshot(),batches:c.fractureBatches.length}:null;})()`);
    return v;
  }, {timeout, interval: 100, label: nodeId + ' broken'});
}

async function main() {
  return runGameProbe({
    name: 'wu06-destructible', outDir: OUT_DIR, port: Number(arg('port', 5100)), cdpPort: Number(arg('cdp', 9481)),
    chromePath: arg('chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), headed: has('headed'),
    windowSize: arg('window-size', '1280,800'), windowPosition: arg('window-position', '1920,80'), url: arg('url', null),
    scene: arg('scene', SCENE), results, check, summary,
  }, async ({cdp, details, url}) => {
    const scenePath = arg('scene', SCENE);
    await navigateProbeScene(cdp, url, scenePath);
    try {
      const win = await cdp.send('Browser.getWindowForTarget');
      const bounds = await cdp.send('Browser.getWindowBounds', {windowId: win.windowId});
      check('验证窗口固定在 DISPLAY1', bounds.bounds.left >= 1900, JSON.stringify(bounds.bounds));
      details.window = bounds.bounds;
    } catch (e) { check('验证窗口固定在 DISPLAY1', false, String(e)); }

    // 场景必须由原场景选择器可达（W06-01）；在进入 Play 前检查，避免对话框影响玩法帧。
    await cdp.eval("document.querySelector('.scene-current')?.click()");
    await sleep(200);
    const listed = await cdp.eval("[...document.querySelectorAll('.scene-choice')].some(b=>b.textContent.includes('可破坏庭院'))");
    await cdp.eval("document.querySelector('.scene-browser')?.close()");
    check('WU-06 场景由原场景选择器可达', listed === true);

    await playPaused(cdp);
    // 真实原生输入需要运行态（暂停下 J/切枪不推进）；命中/导航取真实时钟。
    await cdp.eval("document.querySelector('#btn-pause').click()");
    check('原生输入前恢复运行态', !(await cdp.eval('window.__editor.playCtl.isPaused')));
    for (let i = 0; i < 100; i++) { if (await cdp.eval('!!window.__editor.playCtl.fracture?.backend()')) break; await sleep(50); }

    const initial = await cdp.eval(`(()=>{const e=window.__editor,r=e.playCtl.session.runtime,s=r.destructibleSnapshot(),p=r.player();
      return {snapshot:s,collision:r.collisionSnapshot(),player:{x:p.x,z:p.z},weapons:r.weapons.definitions.map(d=>d.id),
        npc:r.view().filter(v=>v.kind==='npc').map(v=>({x:v.x,z:v.z,id:v.id,generation:v.generation})),
        batches:e.playCtl.fractureBatches.length,error:e.playCtl.destructibleError};})()`);
    details.initial = initial;
    check('正式场景装载 3 个可破坏对象（初始 intact）', initial.snapshot.length === 3 && initial.snapshot.every(s => s.hp === 40 && !s.broken), JSON.stringify(initial.snapshot));
    check('可破坏对象初始参与射线与导航阻挡', ['nd_fr_barrel','nd_w6_barrel_b','nd_w6_barrel_c'].every(n => initial.collision.solids.includes(n)), JSON.stringify(initial.collision));
    check('未配置对照与独立墙体仍在静态碰撞中', initial.collision.solids.includes('nd_w6_control') && initial.collision.solids.includes('nd_w6_wall_l'), JSON.stringify(initial.collision));

    const npcSpawn = await waitFor(async () => {
      const n = await cdp.eval("(()=>{const r=window.__editor.playCtl.session.runtime;const n=r.view().find(v=>v.kind==='npc');return n?{x:n.x,z:n.z}:null;})()");
      return n;
    }, {timeout: 6000, interval: 100, label: 'NPC 生成'});
    details.npcSpawn = npcSpawn;

    // 破坏前：NPC 不能穿过被油桶封住的全宽屏障
    await sleep(5000);
    const blocked = await cdp.eval("(()=>{const r=window.__editor.playCtl.session.runtime;const n=r.view().find(v=>v.kind==='npc');const nav=r.navigation.snapshot();return n?{x:n.x,z:n.z,unreachable:nav.crowd.unreachableAgents}:null;})()");
    details.blockedNpc = blocked;
    check('破坏前 NPC 被可破坏屏障挡在另一侧', !!blocked && blocked.z < -0.45 && blocked.unreachable >= 1, JSON.stringify(blocked));

    // 原生输入：1=手枪、鼠标瞄准、J 开火；真实耐久回合
    check('原生数字键切到 pistol', !!(await equip(cdp, '1', 'pistol')));
    const aim = await aimAt(cdp);
    check('瞄准点落在游戏画布', aim.canvas && !aim.behind, JSON.stringify(aim));
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    let broken = null;
    try {
      broken = await waitFor(async () => {
        const v = await cdp.eval(`(()=>{const e=window.__editor,c=e.playCtl,r=c.session.runtime;
          const s=r.destructibleSnapshot().find(x=>x.nodeId==='nd_fr_barrel');
          return s&&s.broken?{snapshot:r.destructibleSnapshot(),collision:r.collisionSnapshot(),batches:c.fractureBatches.length,
            error:c.destructibleError,brokenNodes:[...c.brokenNodes],hit:r.lastShot}:null;})()`);
        return v;
      }, {timeout: 10000, interval: 100, label: '真实手枪击碎油桶'});
    } finally {
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    }
    check('原生手枪攻击真实击碎正式油桶', !!broken, JSON.stringify(broken?.snapshot));
    check('破坏后完整物体 collider 从射线与导航中移除', !!broken && !broken.collision.solids.includes('nd_fr_barrel') && !broken.collision.dynamicObstacles.includes('nd_fr_barrel'), JSON.stringify(broken?.collision));
    const frag = broken ? await waitFor(async () => {
      const v = await cdp.eval("(()=>{const bs=window.__editor.playCtl.fractureBatches;if(bs.length===0)return null;return {batches:bs.length,rows:bs.slice(0,2).map(b=>({count:b.count,p:[b.instances[0],b.instances[1],b.instances[2]]}))};})()");
      return v;
    }, {timeout: 5000, interval: 40, label: '碎片批次出现'}) : null;
    check('破坏只发生一次且进入碎片表现', !!broken && broken.snapshot.find(x=>x.nodeId==='nd_fr_barrel').broken && !!frag && broken.error === null, JSON.stringify({broken, frag}));
    if (frag) {
      details.fragmentRows = frag.rows;
      check('碎片在目标世界位置接管（非原点/T-pose）', frag.rows.length>0 && frag.rows.every(r=>Math.abs(r.p[0])<2 && r.p[2]>-2 && r.p[2]<2 && (Math.abs(r.p[0])+Math.abs(r.p[1])+Math.abs(r.p[2]))>0.05), JSON.stringify(frag.rows));
    }
    if (broken) check('完整显示按稳定 NodeId 隐藏', broken.brokenNodes.includes('nd_fr_barrel'), JSON.stringify(broken.brokenNodes));
    const mirror = await cdp.eval("(()=>{const b=window.__editor.playCtl.fracture.backend();return b?b.staticKeys():[];})()");
    details.mirror = mirror;
    check('破坏后碎片物理静态镜像同步移除目标', !mirror.includes('scene-mirror:nd_fr_barrel'), JSON.stringify(mirror.filter(k=>k.includes('nd_fr_barrel'))));

    // 射线实证：同一从玩家沿 -Z 的 trace 不再命中油桶
    const ray = await cdp.eval(`(()=>{const r=window.__editor.playCtl.session.runtime,w=r.weaponWorld();
      return w.trace([0,0.5,4.5],[0,0,-1],30,new Set());})()`);
    details.rayAfter = ray;
    check('破坏后真实射线穿透原完整 collider', ray.nodeId !== 'nd_fr_barrel', JSON.stringify(ray));

    // 再次开火不应重复破坏/重复事件
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    await sleep(1200);
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    const repeated = await cdp.eval("(()=>{const r=window.__editor.playCtl.session.runtime;return {snapshot:r.destructibleSnapshot(),pending:window.__editor.playCtl.pendingDestructibleEvents.length,batches:window.__editor.playCtl.fractureBatches.length};})()");
    details.repeated = repeated;
    check('重复命中不重复破坏/不重复碎块', repeated.snapshot.filter(s=>s.nodeId==='nd_fr_barrel'&&s.broken).length===1 && repeated.pending===0, JSON.stringify(repeated));

    // 导航实证：破坏后 NPC 应通过同一缺口
    await sleep(5000);
    const passed = await cdp.eval("(()=>{const r=window.__editor.playCtl.session.runtime;const n=r.view().find(v=>v.kind==='npc');return n?{x:n.x,z:n.z}:null;})()");
    details.navPassed = passed;
    check('破坏后 NPC 通过原屏障缺口（导航同步）', !!passed && passed.z > 0.5, JSON.stringify(passed));
    await shot(cdp, 'direct-broken');

    // Reset 恢复完整物体/导航/显示；先暂停并释放开火状态，避免旧按键在重置后立刻再次破坏。
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    await cdp.eval("document.querySelector('#btn-pause').click()");
    await sleep(150);
    await cdp.eval('window.__editor.playCtl.reset()');
    await sleep(1200);
    const restored = await cdp.eval("(()=>{const e=window.__editor,r=e.playCtl.session.runtime;return {snapshot:r.destructibleSnapshot(),collision:r.collisionSnapshot(),brokenNodes:[...e.playCtl.brokenNodes]};})()");
    details.reset = restored;
    check('Reset 恢复完整物体/碰撞/导航与显示状态', restored.snapshot.every(s=>s.hp===40&&!s.broken) && restored.collision.solids.includes('nd_fr_barrel') && restored.collision.dynamicObstacles.includes('nd_fr_barrel') && restored.brokenNodes.length===0, JSON.stringify(restored));

    // 原生电锯（范围 direct）与狙击（贯穿）不能只靠手枪/爆炸证明。
    check('原生数字键切到 chainsaw', !!(await equip(cdp, '5', 'chainsaw')));
    await aimAt(cdp);
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    const saw = await waitBroken(cdp, 'nd_fr_barrel', 8000);
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    details.chainsaw = saw;
    check('原生电锯在射程内真实击碎目标（忽略自身 collider）', !!saw, JSON.stringify(saw?.snap));
    await cdp.eval('window.__editor.playCtl.reset()');
    await sleep(800);

    check('原生数字键切到 sniper', !!(await equip(cdp, '4', 'sniper')));
    await aimAt(cdp);
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    await sleep(120);
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    const snipe = await waitBroken(cdp, 'nd_fr_barrel', 5000);
    details.sniper = snipe;
    check('原生贯穿狙击真实击碎目标', !!snipe, JSON.stringify(snipe?.snap));
    await cdp.eval('window.__editor.playCtl.reset()');
    await sleep(800);

    await cdp.eval("document.querySelector('#btn-pause').click()");
    await sleep(120);
    check('原生数字键切到 launcher', !!(await equip(cdp, '7', 'launcher')));
    const blastAim = await aimAt(cdp);
    check('爆炸瞄准点落在游戏画布', blastAim.canvas && !blastAim.behind, JSON.stringify(blastAim));
    await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    let blast = null;
    try {
      blast = await waitFor(async () => {
        const v = await cdp.eval(`(()=>{const c=window.__editor.playCtl,r=c.session.runtime;
          const s=r.destructibleSnapshot();
          const a=s.find(x=>x.nodeId==='nd_fr_barrel'),b=s.find(x=>x.nodeId==='nd_w6_barrel_b');
          return a?.broken&&b?.broken?{snapshot:s,collision:r.collisionSnapshot(),batches:c.fractureBatches.length,error:c.destructibleError,controlSolid:r.collisionSnapshot().solids.includes('nd_w6_control')}:null;})()`);
        return v;
      }, {timeout: 12000, interval: 100, label: '真实爆炸范围破坏'});
    } finally {
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74});
    }
    check('真实爆炸同时击碎范围内 A/B', !!blast, JSON.stringify(blast?.snapshot));
    check('墙后 C 未被爆炸破坏（真实遮挡）', !!blast && blast.snapshot.find(x=>x.nodeId==='nd_w6_barrel_c').hp===40 && !blast.snapshot.find(x=>x.nodeId==='nd_w6_barrel_c').broken, JSON.stringify(blast?.snapshot));
    check('未配置对照不受爆炸影响', !!blast && blast.controlSolid, JSON.stringify(blast?.collision));
    await shot(cdp, 'explosion');

    details.final = await cdp.eval("(()=>{const e=window.__editor,c=e.playCtl,r=c.session.runtime;return {error:c.destructibleError,batches:c.fractureBatches.length,snapshot:r.destructibleSnapshot()};})()");
    check('破坏表现无诊断错误', details.final.error===null, JSON.stringify(details.final));

    // 迟到表现：破坏事实尚未表现就 Reset，旧代请求不能作用于新 run。
    await cdp.eval("document.querySelector('#btn-pause').click()");
    await sleep(120);
    await cdp.eval('window.__editor.playCtl.reset()');
    await sleep(400);
    await cdp.eval("document.querySelector('#btn-pause').click()");
    await sleep(120);
    await cdp.eval("window.__editor.playCtl.session.runtime.damageSceneObject('nd_fr_barrel',40,{weaponId:'w'},'direct')");
    await cdp.eval('window.__editor.playCtl.reset()');
    await sleep(1800);
    const late = await cdp.eval("(()=>{const e=window.__editor,c=e.playCtl,r=c.session.runtime;return {snap:r.destructibleSnapshot(),batches:c.fractureBatches.length,broken:[...c.brokenNodes].length,error:c.destructibleError};})()");
    details.late = late;
    check('Reset 后旧代破坏表现不作用于新 run', late.snap.find(x=>x.nodeId==='nd_fr_barrel').hp===40 && !late.snap.find(x=>x.nodeId==='nd_fr_barrel').broken && late.batches===0 && late.broken===0, JSON.stringify(late));

    // 碎片后端未就绪：先切换显示/物理镜像并给可见诊断；恢复后同一事实重试成功。
    await cdp.eval("document.querySelector('#btn-pause').click()");
    await sleep(120);
    await cdp.eval('window.__editor.playCtl.reset()');
    await sleep(400);
    await cdp.eval("document.querySelector('#btn-pause').click()");
    await sleep(100);
    await cdp.eval("(()=>{const b=window.__editor.playCtl.fracture;window.__origBackend=b.backend.bind(b);b.backend=()=>null;})()");
    await cdp.eval("window.__editor.playCtl.session.runtime.damageSceneObject('nd_w6_barrel_b',40,{weaponId:'w'},'direct')");
    await sleep(700);
    const notReady = await cdp.eval("(()=>{const e=window.__editor,c=e.playCtl,r=c.session.runtime;return {error:c.destructibleError,pending:c.pendingDestructibleEvents.length,broken:[...c.brokenNodes],collision:r.collisionSnapshot(),snap:r.destructibleSnapshot()};})()");
    details.notReady = notReady;
    check('后端未就绪仍先隐藏完整对象并移除镜像', notReady.broken.includes('nd_w6_barrel_b') && !notReady.collision.solids.includes('nd_w6_barrel_b') && notReady.pending>=1, JSON.stringify(notReady));
    check('后端未就绪给出可见诊断', !!notReady.error && notReady.error.includes('未就绪'), JSON.stringify(notReady.error));
    await cdp.eval("(()=>{const b=window.__editor.playCtl.fracture;b.backend=window.__origBackend;})()");
    await sleep(1800);
    const recoveredBackend = await cdp.eval("(()=>{const c=window.__editor.playCtl;return {error:c.destructibleError,pending:c.pendingDestructibleEvents.length,batches:c.fractureBatches.length,broken:[...c.brokenNodes]};})()");
    details.recoveredBackend = recoveredBackend;
    check('后端恢复后同一破坏事实重试成功', recoveredBackend.pending===0 && recoveredBackend.batches>0 && recoveredBackend.error===null && recoveredBackend.broken.includes('nd_w6_barrel_b'), JSON.stringify(recoveredBackend));
    await cdp.eval('window.__editor.playCtl.reset()');
    await sleep(600);

    // 表现失败保底：游戏事实仍成立，诊断可见，不留下不可见完整 collider。
    await cdp.eval("document.querySelector('#btn-pause').click()");
    await sleep(120);
    await cdp.eval('window.__editor.playCtl.reset()');
    await sleep(400);
    await cdp.eval("document.querySelector('#btn-pause').click()");
    await sleep(100);
    await cdp.eval("(()=>{const fr=window.__editor.playCtl.fractureIO;fr.readText=async()=>{throw new Error('probe-bad-profile')};fr.readBinary=async()=>{throw new Error('probe-bad-profile')};})()");
    await cdp.eval("window.__editor.playCtl.session.runtime.damageSceneObject('nd_w6_barrel_c',40,{weaponId:'w'},'direct')");
    await sleep(1800);
    const failed = await cdp.eval("(()=>{const e=window.__editor,c=e.playCtl,r=c.session.runtime;return {error:c.destructibleError,snap:r.destructibleSnapshot(),collision:r.collisionSnapshot(),broken:[...c.brokenNodes]};})()");
    details.failed = failed;
    check('表现失败保留玩法事实且诊断可见', failed.snap.find(x=>x.nodeId==='nd_w6_barrel_c').broken && !failed.collision.solids.includes('nd_w6_barrel_c') && !!failed.error, JSON.stringify({error:failed.error,snap:failed.snap}));
    check('表现失败仍隐藏完整对象，不留幽灵 collider', failed.broken.includes('nd_w6_barrel_c'), JSON.stringify(failed.broken));

    // Pause 不推进、Step 恰一次（不重复消费已发生的破坏）
    await cdp.eval("document.querySelector('#btn-pause').click()");
    const paused = await cdp.eval("(()=>{const c=window.__editor.playCtl;const t=c.session.runtime.tick;c.update(1/30);return {tick:t,after:c.session.runtime.tick,isPaused:c.isPaused};})()");
    await cdp.eval('window.__editor.playCtl.step()');
    const stepped = await cdp.eval("window.__editor.playCtl.session.runtime.tick");
    check('Pause 不推进、Step 恰一次', paused.isPaused && paused.after===paused.tick && stepped===paused.tick+1, JSON.stringify({paused,stepped}));
    await cdp.eval("document.querySelector('#btn-pause').click()");

    await stopProbe(cdp, check);
    const afterStop = await cdp.eval("(()=>{const e=window.__editor;return {playing:e.playCtl.isPlaying,batches:e.playCtl.fractureBatches.length,broken:[...e.playCtl.brokenNodes].length,error:e.playCtl.destructibleError};})()");
    details.afterStop = afterStop;
    check('Stop 后恢复且不再残留破坏表现', !afterStop.playing && afterStop.batches===0 && afterStop.broken===0 && afterStop.error===null, JSON.stringify(afterStop));
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
