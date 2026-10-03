#!/usr/bin/env node
/**
 * 相机探针（两个用户实报问题的回归防线）。
 *
 * ## 为什么要单独一个探针
 *
 * 这两个缺陷**单元测试抓不到**（free-camera.test.ts / play-camera.test.ts 已经把数学
 * 锁死了），真正会复发的都是「接线断了」这类：
 *   - 按钮/快捷键没接上 → 数学再对也进不去模式
 *   - 帧循环没合成输入 → 按了键相机不动
 *   - Play 期间两套机位抢 camera → 相机乱飘
 * 这些只能在真浏览器里用**真键盘 / 真点击**验证，所以必须有一个常驻探针。
 *
 * 断言：
 *   K1 自由相机（编辑态）：按钮进入 → HUD 可见 → 真键盘 W 让 eye 沿视线前进
 *      → 真鼠标拖拽转视角且 **eye 不动**（不是 orbit 甩）→ Esc 退出
 *      → Play 期间拒绝进入（AGENTS.md §2.4 编辑器/游戏相机分离）
 *   K2 Play 上帝视角不跟转身：真键盘按住左右移动 → 相机 yaw **纹丝不动**
 *      （schema v5 `yawMode='world'` 的验收；位置仍要跟随）
 *
 * 用法：node tools/verify/camera-probe.mjs --headed
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  sleep,
  waitFor,
  createRecorder,
  makeArgParser,
  ensureServer,
  launchEditorSession,
  normalizeEditorState,
} from './editor-smoke-lib.mjs';

const { arg, has } = makeArgParser(process.argv);
const PORT = Number(arg('port', 5100));
const CDP_PORT = Number(arg('cdp', 9347));
const OUT_DIR = path.resolve(arg('out', '.workbuddy/tmp'));
const CHROME = arg('chrome', '') || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const { results, check, summary } = createRecorder();

/** 页面内：从 orbit 参数反算 eye（与 m4.orbitEye 同式，Node 侧不再抄第二遍三角） */
const EYE_JS = `(s) => {
  const el = (s.elevationDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  return [
    s.target[0] + Math.sin(s.yaw) * ce * s.distance,
    s.target[1] + Math.sin(el) * s.distance,
    s.target[2] + Math.cos(s.yaw) * ce * s.distance,
  ];
}`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { server, url } = await ensureServer(PORT, 'apps/editor/vite.config.ts');
  const { chrome, cdp } = await launchEditorSession({
    chromePath: CHROME,
    cdpPort: CDP_PORT,
    headed: has('headed'),
    appUrl: url,
    windowSize: '1500,950',
  });
  try {
    await cdp.send('Page.navigate', { url });
    await normalizeEditorState(cdp);
    await waitFor(
      () => cdp.eval('(() => !!window.__editor && !!window.__editor.freeCam)()').then((r) => r === true),
      { timeout: 20000, interval: 300, label: '编辑器就绪' },
    );

    // ---- 场景机位就绪闸门（独立审核 P1-1 / 复审 P2-6）----
    // 场景 editorCamera 是**异步**施加的（main.ts applySceneCamera），比"画布就绪"
    // 晚约 100ms。基线若取在它落地前，位移里会混进一次 DEFAULT_VIEW→场景机位的
    // 整机瞬移（distance 9→62、cos 被拉到 -0.6），防线哑火。
    // 期望值从**真源**反推（aether.project.json → startIndex → 场景 editorCamera），
    // 不硬编码、也不靠"连续两拍不变"的启发式 —— 启发式在冷启动慢盘上会假就绪。
    let expectedSig = null;
    try {
      const proj = JSON.parse(fs.readFileSync('aether.project.json', 'utf8'));
      const entry = (proj.scenes ?? [])[proj.startIndex ?? 0];
      const scene = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
      const ec = scene.editorCamera;
      const el = (ec.elevation * 180) / Math.PI; // 主视图存的是度（panel.params.cameraElevation）
      expectedSig = [ec.target[0], ec.target[1], ec.target[2], ec.distance, ec.yaw, el]
        .map((v) => +Number(v).toFixed(6))
        .join(',');
      console.log(`期望机位（真源 ${entry.path}）：${expectedSig}`);
    } catch (e) {
      // 真源解析失败不阻断（结构变了不该让探针直接崩），退回启发式：连续两拍不变
      console.warn(`[camera-probe] 真源期望机位解析失败，退回启发式闸门：${e.message}`);
    }
    const camSig = () =>
      cdp.eval(
        `(() => { const c = window.__editor.camera;
          return [c.target[0], c.target[1], c.target[2], c.distance, c.yaw, window.__editor.elevation()]
            .map((v) => +v.toFixed(6)).join(','); })()`,
      );
    let prevSig = null;
    await waitFor(
      async () => {
        const s = await camSig();
        if (expectedSig !== null) return s === expectedSig;
        const stable = prevSig !== null && s === prevSig; // 启发式兜底
        prevSig = s;
        return stable;
      },
      { timeout: 10000, interval: 250, label: '场景机位就绪（等于真源期望值）' },
    );
    // 超时也要能看出来：waitFor 不抛错只返回 last，这里显式核对一次，
    // 不匹配就把期望值打进失败信息（否则闸门失效会伪装成后面的断言失败）
    const readySig = await camSig();
    check(
      '🔴 场景机位已按真源落地（基线不被 DEFAULT_VIEW 污染）',
      expectedSig === null || readySig === expectedSig,
      expectedSig === null ? `启发式就绪：${readySig}` : `期望 ${expectedSig} 实际 ${readySig}`,
    );

    // =================================================================
    // K1 · 自由相机（编辑态）
    // =================================================================
    console.log('\nK1. 自由相机（编辑态 Scene View 飞行机位）');

    const before = await cdp.eval(`(() => {
      const c = window.__editor.camera;
      const s = { target: [c.target[0], c.target[1], c.target[2]], distance: c.distance, yaw: c.yaw, elevationDeg: window.__editor.elevation() };
      const eye = (${EYE_JS})(s);
      return { s, eye, free: window.__editor.freeCam() };
    })()`);
    check('初始为编辑态且自由相机关闭', before.free.on === false, JSON.stringify(before.free));

    // 真点击按钮进入（不是调 API —— 按钮没接线这条能抓出来）
    const clicked = await cdp.eval(`(() => {
      const b = document.querySelector('#btn-freecam');
      if (b === null) return false;
      b.click();
      return true;
    })()`);
    check('「✈ 自由相机」按钮存在且可点', clicked === true);
    await sleep(300);
    const onState = await cdp.eval(`(() => ({
      free: window.__editor.freeCam(),
      active: document.querySelector('#btn-freecam').classList.contains('active'),
      hud: (document.getElementById('hud') || {}).innerText || '',
      cursor: (document.getElementById('gpu') || {}).style?.cursor || '',
    }))()`);
    check('点击后进入自由相机模式', onState.free.on === true, JSON.stringify(onState.free));
    check('按钮高亮（模式可见，否则用户不知道自己在模式里）', onState.active === true);
    check('HUD 显示「自由相机」模式行', /自由相机/.test(onState.hud), onState.hud.split('\n').filter((l) => /自由相机/.test(l))[0] ?? '(缺失)');

    // ---- 真键盘 W：eye 必须沿视线前进 ----
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
    await sleep(700);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
    await sleep(120);
    const afterW = await cdp.eval(`(() => {
      const c = window.__editor.camera;
      const s = { target: [c.target[0], c.target[1], c.target[2]], distance: c.distance, yaw: c.yaw, elevationDeg: window.__editor.elevation() };
      return { s, eye: (${EYE_JS})(s) };
    })()`);
    {
      const d = [
        afterW.eye[0] - before.eye[0],
        afterW.eye[1] - before.eye[1],
        afterW.eye[2] - before.eye[2],
      ];
      const dist = Math.hypot(d[0], d[1], d[2]);
      // 视线方向（eye → target），与位移做点积：>0.99 才算"沿视线走"
      const f = [
        before.s.target[0] - before.eye[0],
        before.s.target[1] - before.eye[1],
        before.s.target[2] - before.eye[2],
      ];
      const fl = Math.hypot(f[0], f[1], f[2]) || 1;
      const cos = (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / (dist * fl || 1);
      check('W 键让 eye 真的动了（>0.5m）', dist > 0.5, `位移=${dist.toFixed(3)}m`);
      check('W 键沿视线前进（与视线夹角余弦 > 0.99）', cos > 0.99, `cos=${cos.toFixed(4)}`);
      check('飞行不改 orbit 半径（distance 保持）', Math.abs(afterW.s.distance - before.s.distance) < 1e-6,
        `${before.s.distance} → ${afterW.s.distance}`);
    }

    // ---- 真鼠标拖拽转视角：朝向变，**eye 不动**（原地转头，不是绕 target 甩）----
    const box = await cdp.eval(`(() => {
      const c = document.getElementById('gpu');
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const preDrag = await cdp.eval(`(() => {
      const c = window.__editor.camera;
      const s = { target: [c.target[0], c.target[1], c.target[2]], distance: c.distance, yaw: c.yaw, elevationDeg: window.__editor.elevation() };
      return { s, eye: (${EYE_JS})(s) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + i * 18, y: box.y + i * 6, button: 'left', buttons: 1 });
      await sleep(30);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 144, y: box.y + 48, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(200);
    const postDrag = await cdp.eval(`(() => {
      const c = window.__editor.camera;
      const s = { target: [c.target[0], c.target[1], c.target[2]], distance: c.distance, yaw: c.yaw, elevationDeg: window.__editor.elevation() };
      return { s, eye: (${EYE_JS})(s) };
    })()`);
    {
      const turned = Math.abs(postDrag.s.yaw - preDrag.s.yaw);
      const eyeDrift = Math.hypot(
        postDrag.eye[0] - preDrag.eye[0],
        postDrag.eye[1] - preDrag.eye[1],
        postDrag.eye[2] - preDrag.eye[2],
      );
      check('拖拽真的转了视角（yaw 变化 > 0.2rad）', turned > 0.2, `Δyaw=${turned.toFixed(3)}`);
      check('🔴 转视角是原地转头：eye 漂移 < 0.05m（orbit 甩动会漂移数米）', eyeDrift < 0.05, `eye 漂移=${eyeDrift.toFixed(4)}m`);
    }

    // ---- 🔴 拖拽绝不能被当成轻点拾取（终审抓的回归防线）----
    // 必须在**自由相机开启时**做（回归只发生在 freecam 手势路径），所以放在 Esc 退出之前。
    // 飞行分支若漏算 downMoved，松手就会被 endPointer 当成轻点 → 拖拽看完一圈，
    // 选中的物体莫名其妙变了。这里**运行时**扫网格找出「可拾取点 P」与「空点 E」，
    // 不硬编码像素（画布尺寸不固定）：先点 E 清空选中，再从 E 拖到 P ——
    // 修复生效 → 松手不拾取、选中仍为 null；回归 → P 处的物体被选中。
    {
      const pts = await cdp.eval(`(() => {
        const c = document.getElementById('gpu'); const r = c.getBoundingClientRect(); const out = [];
        for (let gy = 0.25; gy <= 0.75; gy += 0.08) for (let gx = 0.25; gx <= 0.75; gx += 0.08)
          out.push([Math.round(r.left + r.width * gx), Math.round(r.top + r.height * gy)]);
        return out;
      })()`);
      const getSel = () => cdp.eval('(() => window.__editor.renderer.getSelected())()');
      const tap = async (x, y) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
        await sleep(90);
      };
      let P = null;
      let E = null;
      for (const [x, y] of pts) {
        await tap(x, y);
        const sel = await getSel();
        if (sel !== null && P === null) P = { x, y };
        if (sel === null && E === null) E = { x, y };
        if (P !== null && E !== null) break;
      }
      if (P !== null && E !== null) {
        await tap(E.x, E.y); // 清空选中
        const selCleared = await getSel();
        check('拖拽拾取防线前置条件：已找到可拾取点与空点并清空选中', selCleared === null, `sel=${selCleared}`);
        // 从 E 拖到 P（带中间步，确保是拖拽不是点击）
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: E.x, y: E.y, button: 'left', clickCount: 1, buttons: 1 });
        for (let i = 1; i <= 5; i++) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(E.x + ((P.x - E.x) * i) / 5),
            y: Math.round(E.y + ((P.y - E.y) * i) / 5),
            button: 'left',
            buttons: 1,
          });
          await sleep(30);
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: P.x, y: P.y, button: 'left', clickCount: 1, buttons: 0 });
        await sleep(200);
        const selAfterDrag = await getSel();
        check(
          '🔴 飞行中拖拽松手**不**触发拾取（downMoved 必须累计）',
          selAfterDrag === null,
          `拖拽后选中=${selAfterDrag}（非 null 即回归：拖拽被当成了轻点）`,
        );
      } else {
        skip('拖拽拾取防线', `画布上找不到${P === null ? '可拾取点' : '空点'}，无法构造对照（不影响相机本体断言）`);
      }
    }

    // ---- Esc 退出 ----
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    const offState = await cdp.eval(`(() => ({
      free: window.__editor.freeCam(),
      active: document.querySelector('#btn-freecam').classList.contains('active'),
    }))()`);
    check('Esc 退出自由相机', offState.free.on === false && offState.active === false, JSON.stringify(offState));

    // =================================================================
    // K2 · Play 期间相机归属（编辑器机位必须让位游戏机位）
    // =================================================================
    console.log('\nK2. Play 期间相机归属与上帝视角不跟转身');

    // 进 Play 前先开自由相机，验证 startPlay 会强制关掉它
    await cdp.eval(`(() => { window.__editor.setFreeCam(true); return window.__editor.freeCam(); })()`);
    await waitFor(
      () =>
        cdp
          .eval(
            `(() => { const stop = document.querySelector('#btn-stop');
               if (stop && stop.disabled) { document.querySelector('#btn-play').click(); return false; }
               return true; })()`,
          )
          .then((r) => r === true),
      { timeout: 20000, interval: 500, label: 'Play 激活' },
    );
    await sleep(1200);

    const playFree = await cdp.eval(`(() => window.__editor.freeCam())()`);
    check('🔴 进入 Play 自动退出自由相机（两套机位不抢 camera）', playFree.on === false, JSON.stringify(playFree));

    const refuse = await cdp.eval(`(() => {
      window.__editor.setFreeCam(true);
      return window.__editor.freeCam();
    })()`);
    check('🔴 Play 期间拒绝进入自由相机（先停止 Play）', refuse.on === false, JSON.stringify(refuse));

    // ---- 上帝视角：按住左右移动，相机 yaw 必须不动 ----
    const yawBefore = await cdp.eval(`(() => {
      const rt = window.__editor.playCtl.session.runtime;
      return {
        yaw: window.__editor.camera.yaw,
        t: [window.__editor.camera.target[0], window.__editor.camera.target[2]],
        px: rt.table.posX[rt.playerEntityId],
        pz: rt.table.posZ[rt.playerEntityId],
        pyaw: rt.player() === null ? null : rt.player().yaw,
      };
    })()`);
    // 采样必须在**按住期间**做：松开后输入归零，yaw 停在最后一次朝向，
    // 先按左再按右会得到「左=π → 右=0」，首尾都是初始值的假象（探针自己踩过）。
    const sample = () =>
      cdp.eval(`(() => {
        const rt = window.__editor.playCtl.session.runtime;
        const p = rt.player();
        return {
          camYaw: window.__editor.camera.yaw,
          camT: [window.__editor.camera.target[0], window.__editor.camera.target[2]],
          px: rt.table.posX[rt.playerEntityId],
          pz: rt.table.posZ[rt.playerEntityId],
          pyaw: p === null ? null : p.yaw,
          tick: rt.tick,
        };
      })()`);

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await sleep(800);
    const onLeft = await sample();
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await sleep(250);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await sleep(800);
    const onRight = await sample();
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await sleep(250);

    {
      // 相机 yaw：三次采样（初始 / 按住左 / 按住右）必须完全一致
      const dLeft = Math.abs(onLeft.camYaw - yawBefore.yaw);
      const dRight = Math.abs(onRight.camYaw - yawBefore.yaw);
      check(
        '🔴 左右移动时相机 yaw 纹丝不动（上帝视角，Δyaw < 1e-6）',
        dLeft < 1e-6 && dRight < 1e-6,
        `yaw ${yawBefore.yaw.toFixed(6)} → 按左 ${onLeft.camYaw.toFixed(6)} / 按右 ${onRight.camYaw.toFixed(6)}`,
      );

      // 判别力守卫 ①：玩家自己确实动了（否则"相机不动"是假通过）
      const pMoved = Math.hypot(onRight.px - yawBefore.px, onRight.pz - yawBefore.pz);
      check('🔴 玩家自身确实位移了（否则「相机不动」是假通过）', pMoved > 0.3, `Δplayer=${pMoved.toFixed(3)}m`);

      // 判别力守卫 ②：玩家朝向确实相反（左 vs 右差 π）。这条过了，才说明
      // 「相机不转」是修复生效，而不是"压根没转身所以相机没得转"。
      const dFacing =
        onLeft.pyaw === null || onRight.pyaw === null
          ? 0
          : Math.abs(Math.atan2(Math.sin(onRight.pyaw - onLeft.pyaw), Math.cos(onRight.pyaw - onLeft.pyaw)));
      check(
        '🔴 玩家朝向在左/右之间真的翻转了（相机不跟才是真修复，不是没转）',
        dFacing > 2.0,
        `按左 yaw=${Number(onLeft.pyaw).toFixed(3)} / 按右 yaw=${Number(onRight.pyaw).toFixed(3)}（Δ=${dFacing.toFixed(3)}）`,
      );

      // 位置仍要跟随（上帝视角跟的是位置不是朝向）
      const camMoved = Math.hypot(onRight.camT[0] - yawBefore.t[0], onRight.camT[1] - yawBefore.t[1]);
      check('相机仍跟随玩家位置（跟位置不是跟朝向）', camMoved > 0.3, `ΔcamTarget=${camMoved.toFixed(3)}m`);
    }

    // ---- 停止 Play，收尾 ----
    await cdp.eval(`(() => { const b = document.querySelector('#btn-stop'); if (b && !b.disabled) b.click(); return true; })()`);
    await sleep(800);

    // ---- console 卫生 + 截图 ----
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(OUT_DIR, 'camera.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    check('截图留档（相机验收视觉复核）', true, shotPath);
    check('无 console error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | ').slice(0, 300));
    check('无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.slice(0, 3).join(' | ').slice(0, 300));
  } finally {
    await chrome.kill();
    if (server !== null) server.kill();
  }

  const code = summary(cdp.consoleErrors, cdp.exceptions);
  process.exit(code);
}

main().catch((err) => {
  console.error('探针异常终止：', err.message);
  process.exit(1);
});
