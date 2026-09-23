/**
 * Game Editor 无头 WebGPU 冒烟验证（可复跑）。
 *
 * 为什么需要它：
 *   docs/11 §13.6 记录过一次「0b.8 headless WebGPU 冒烟 30/30 PASS」，但那份脚本
 *   跑在临时目录、从未入库，截图 `editor-0b8-smoke.png` 也不在仓库里 —— 结论不可复现。
 *   本文件把那条验证固化成 `npm run editor:smoke`，任何人一条命令就能复跑出同样的判据。
 *
 * 与 cdp-verify.mjs 的分工（别再互相覆盖）：
 *   - cdp-verify.mjs  —— 视觉验证：导入真实 GLB → 截图 → 像素统计（UV / 贴图是否错乱）
 *   - editor-smoke.mjs —— 结构冒烟：驱动 services 公开 API，断言状态机与渲染器不炸
 *   两者都走真实 Chrome，但本文件默认 headless（SwiftShader 软件 WebGPU），
 *   因为断言的是「代码路径不抛错」，不是「像素好不好看」。
 *
 * 用法：
 *   node tools/verify/editor-smoke.mjs                      # 自起 dev server + 默认胶囊场景
 *   node tools/verify/editor-smoke.mjs --glb <file.glb>     # 额外跑蒙皮/动画一组断言
 *   node tools/verify/editor-smoke.mjs --port 5181 --cdp 9334
 *
 * 退出码：0 = 全部通过；1 = 有断言失败或捕获到 console error / 未捕获异常。
 */
import fs from 'node:fs';
import path from 'node:path';
// 共享库（2026-09-23 拆分，docs/21）：断言记账 / waitFor 轮询 / dev server / CDP 会话 / 真源推导
import {
  sleep,
  waitFor,
  createRecorder,
  makeArgParser,
  ensureServer,
  launchEditorSession,
  normalizeEditorState,
  readStartSceneExpectation,
} from './editor-smoke-lib.mjs';

// ---------------------------------------------------------------- 参数
const { arg, has } = makeArgParser(process.argv);

const PORT = Number(arg('port', 5100));
const CDP_PORT = Number(arg('cdp', 9333));
const GLB = arg('glb', 'assets/characters/models/E-01/rigged/E01_Shambler_900_rigged_animated.glb').split(path.sep).join('/');
/** 已绑定的 rigged GLB（22 根 HumanIK 骨）→ L 段「应用动画到场景物体」用 */
const RIGGED_GLB = arg(
  'rigged',
  'assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged.glb',
).split(path.sep).join('/');
const OUT_DIR = path.resolve(arg('out', '.workbuddy/tmp'));
const CHROME =
  arg('chrome', '') ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let APP_URL = ''; // 由 ensureServer() 探测后确定（http 还是 https）

const { results, check, skip, summary } = createRecorder();

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { server, url } = await ensureServer(PORT, 'apps/editor/vite.config.ts');
  APP_URL = url;
  const HEADED = has('headed');

  const { chrome, cdp } = await launchEditorSession({
    chromePath: CHROME,
    cdpPort: CDP_PORT,
    headed: HEADED,
    appUrl: APP_URL,
    grantClipboard: true,
  });
  await cdp.send('Page.navigate', { url: APP_URL });
  // 就绪等待（原固定 6s）：__editor 挂上且画布立起即继续
  await waitFor(
    () => cdp.eval('(() => (window.__editor && document.getElementById("gpu")) ? document.getElementById("gpu").clientHeight : 0)()').then((h) => typeof h === 'number' && h > 100),
    { timeout: 20000, interval: 300, label: '首帧就绪' },
  );
  // 编辑器状态归一（共享库）：清持久化 UI 残留 + 锁 zh + reload 等就绪
  await normalizeEditorState(cdp);

  try {
    // ---- A. 启动 ----
    console.log('\nA. 启动与 WebGPU 上下文');
    // showFatal() 是把 #fatal 的 style.display 改成 'flex' 来显形的，
    // 所以判据必须用 getComputedStyle，不能只看 class 或 inline style 的初值。
    const fatal = await cdp.eval(`(() => {
      const box = document.getElementById('fatal');
      if (box === null) return { shown: false, vis: 'no-node' };
      const shown = getComputedStyle(box).display !== 'none';
      if (!shown) return { shown: false, vis: 'display:none' };
      return {
        shown: true,
        title: (document.getElementById('fatal-title') || {}).innerText || '',
        body: ((document.getElementById('fatal-body') || {}).innerText || '').slice(0, 400),
      };
    })()`);
    check(
      '#fatal 错误卡片未出现',
      fatal.shown !== true,
      fatal.shown !== true ? fatal.vis : `${fatal.title} — ${fatal.body}`,
    );

    const hookType = await cdp.eval('typeof window.__editor');
    check('window.__editor 调试钩子已挂载', hookType === 'object', `typeof=${hookType}`);

    const canvas = await cdp.eval(
      `(()=>{const c=document.getElementById('gpu');return c?{w:c.width,h:c.height}:null})()`,
    );
    // h>200 是硬门槛：窗口几何残留把画布压扁（622×1）时，后面所有视口断言都会假失败
    check('canvas 尺寸有效（高度立得住，>200px）', canvas !== null && canvas.w > 0 && canvas.h > 200, JSON.stringify(canvas));

    // 布局自适应回归（用户报告：窗口缩放后 3D 视图不自适应）：根因是持久化的
    // zh.ui.dockH 在窗口缩小后超出窗口高度，把中心列挤到 1px。注入超大残留值
    // → 重载 → 必须被启动钳制收敛，画布高度立得住。
    const staleDock = await cdp.eval(`(async () => {
      localStorage.setItem('zh.ui.dockH', '5000');
      location.reload();
      return true;
    })()`);
    await sleep(6000);
    const clamped = await cdp.eval(
      `(() => { const c = document.getElementById('gpu'); const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(), 10) || 0; return { w: c.width, h: c.height, dockH: v, vh: window.innerHeight }; })()`,
    );
    check('陈旧超大 dockH 被启动钳制（dock 高 ≤ 窗口-160）', clamped.dockH > 0 && clamped.dockH <= clamped.vh - 160 + 2, `dockH=${clamped.dockH} vh=${clamped.vh}`);
    check('钳制后画布高度立得住（>100px，中心列未被挤死）', clamped.h > 100, JSON.stringify(clamped));

    // 收尾还原：清掉注入的残留（按窗口高度钳出的 545px 对后续绑定段太高），回默认档
    await cdp.eval(`(() => { localStorage.removeItem('zh.ui.dockH'); location.reload(); return true; })()`);
    await sleep(6000);

    const gpuName = await cdp.eval(`(document.getElementById('hud')||{}).innerText||''`);
    check('HUD 拿到 GPU adapter 名', /GPU/.test(gpuName) && !/GPU\s*\?/.test(gpuName), (gpuName.match(/GPU.*/) || [''])[0].slice(0, 80));

    // ---- B. 渲染 ----
    console.log('\nB. 帧循环与绘制统计');
    const stats = await cdp.eval(
      `(()=>{const s=window.__editor.renderer.stats;return {draws:s.drawCalls,tris:s.triangles,w:s.width,h:s.height}})()`,
    );
    check('drawCalls > 0（管线真的在画）', stats.draws > 0, `draws=${stats.draws}`);
    check('triangles > 0', stats.tris > 0, `tris=${stats.tris}`);
    const hudFps = (gpuName.match(/FPS\s*(\d+)/) || [])[1];
    check('FPS 有读数（SwiftShader 下 10 左右属正常）', Number(hudFps) > 0, `fps=${hudFps}`);

    // 出帧稳定性（原独立 I 段并入：B 与 I 本在测同一件事，docs/21 §2.3）。
    // ⚠️ stats.drawCalls 是**每帧**绘制数（稳态恒定 ~29），不是累计值——原 I 段
    // 断言语义就是「两次读数都为正」（帧循环活着），不是增长。
    const draws1 = await waitFor(
      () => cdp.eval('window.__editor.renderer.stats.drawCalls').then((d) => (d > 0 ? d : false)),
      { timeout: 5000, interval: 250, label: 'drawCalls 为正' },
    );
    check('持续出帧（前后两次 drawCalls 均为正）', draws1 !== false && stats.draws > 0, `${stats.draws} → ${draws1}`);

    // ---- B2. 场景来自文件（ADR-010 / S1）----
    // 关键判据：**不能只看物体数** —— 硬编码 fallback 也可能与场景文件撞上同样的数量
    // 与名字。必须查 getSceneSource()，它为 null 就说明读的根本不是文件；
    // 而"应该有几个、叫什么"由起始场景文件本身推导（见 readStartSceneExpectation）。
    console.log('\nB2. 场景来自文件（ADR-010：场景是唯一数据载体；期望值由真源推导）');
    const expect = readStartSceneExpectation();
    const src = await cdp.eval(`(()=>window.__editor.renderer.getSceneSource())()`);
    check('场景来源非 null（不是硬编码 fallback）', src !== null, JSON.stringify(src));
    check(
      '场景来源指向 .scene.json',
      src !== null && /\.scene\.json$/.test(src.url),
      src === null ? 'null' : src.url,
    );
    check(
      `场景来源 = 项目文件的起始场景（${expect.path}）`,
      src !== null && (src.url === expect.path || src.url.endsWith(expect.path)),
      src === null ? 'null' : src.url,
    );
    check(
      `物体数 = 起始场景的可渲染节点数（${expect.objects}）`,
      src !== null && src.objects === expect.objects,
      `objects=${src === null ? 'null' : src.objects} 期望=${expect.objects}`,
    );

    const sceneObjs = await cdp.eval(
      `(()=>window.__editor.renderer.getObjectList().map(o=>({n:o.name,c:o.category,p:o.pickable})))()`,
    );
    const byName = Object.fromEntries(sceneObjs.map((o) => [o.n, o]));
    // 层级列表按定义排除 background（天空/虚空底）——逐个比对时同样要排除，
    // 否则会拿"文档里有、列表里本就不该有"的名字去比（这正是上一版断言的错法）
    const wantListed = expect.names.filter((n) => !expect.background.includes(n)).slice().sort();
    const gotListed = sceneObjs.map((o) => o.n).slice().sort();
    check(
      `层级列表物体名与起始场景逐个一致（${wantListed.length} 个）`,
      JSON.stringify(gotListed) === JSON.stringify(wantListed),
      `多=${wantListed.filter((n) => !gotListed.includes(n)).join(',') || '无'} 少=${
        gotListed.filter((n) => !wantListed.includes(n)).join(',') || '无'
      }`.slice(0, 200),
    );
    check(
      `层级列表 = 可渲染 − background（${expect.hierarchy}）`,
      sceneObjs.length === expect.hierarchy &&
        expect.background.every((n) => byName[n] === undefined),
      `list=${sceneObjs.length} 期望=${expect.hierarchy} background=${expect.background.join(',')}`,
    );
    const catBad = sceneObjs.filter((o) => expect.category[o.n] !== undefined && expect.category[o.n] !== o.c);
    check(
      'category 来自场景文件（逐名比对）',
      catBad.length === 0,
      catBad.length === 0
        ? `${sceneObjs.length} 个全对`
        : catBad.map((o) => `${o.n}:${o.c}≠${expect.category[o.n]}`).join(' · ').slice(0, 200),
    );
    const pickBad = sceneObjs.filter((o) => expect.pickable[o.n] !== undefined && expect.pickable[o.n] !== o.p);
    check(
      'pickable 来自场景文件（逐名比对）',
      pickBad.length === 0,
      pickBad.length === 0
        ? `${sceneObjs.length} 个全对`
        : pickBad.map((o) => `${o.n}:${o.p}≠${expect.pickable[o.n]}`).join(' · ').slice(0, 200),
    );

    // ---- C. SelectionService ----
    console.log('\nC. SelectionService（选中/悬停状态机）');
    const objCount = await cdp.eval('window.__editor.renderer.getObjectList().length');
    check('场景对象列表非空', objCount > 0, `objects=${objCount}`);
    const sel = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.selectObject(0,null);return {sel:r.getSelected(),name:r.selectedName()}})()`,
    );
    check('selectObject → getSelected 往返一致', sel.sel === 0, JSON.stringify(sel));
    check('selectedName 返回字符串', typeof sel.name === 'string' && sel.name.length > 0, String(sel.name));
    const hov = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.setHovered(0,null);return r.getHovered()})()`,
    );
    check('setHovered → getHovered 往返一致', hov === 0, `hovered=${hov}`);
    const cleared = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.selectObject(null,null);return r.getSelected()})()`,
    );
    check('取消选中后 getSelected 为 null', cleared === null, `selected=${cleared}`);

    // ---- D. HierarchyService ----
    console.log('\nD. HierarchyService（层级/显隐/统计）');
    const hier = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;const n=r.getSubMeshCount(0);r.setSubMeshVisible(0,0,false);r.setSubMeshVisible(0,0,true);r.setObjectVisible(0,true);return {sub:n,state:!!r.getObjectState(0)}})()`,
    );
    check('getSubMeshCount 返回正整数', Number.isInteger(hier.sub) && hier.sub > 0, `sub=${hier.sub}`);
    check('子网格显隐切换不抛错', hier.state === true);
    const stats2 = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.recountTriangles();return r.stats.triangles})()`,
    );
    check('recountTriangles 后三角形数仍为正', stats2 > 0, `tris=${stats2}`);
    const bounds = await cdp.eval(
      `(()=>{const b=window.__editor.renderer.getObjectBounds(0);return b?{r:b.radius,c:b.center.length}:null})()`,
    );
    check('getObjectBounds 返回有限半径', bounds !== null && Number.isFinite(bounds.r) && bounds.r > 0, JSON.stringify(bounds));

    // ---- E. MaterialPanelService ----
    console.log('\nE. MaterialPanelService（材质三层语义）');
    const lib = await cdp.eval('window.__editor.renderer.getMaterialLibrary().length');
    check('材质库可读', typeof lib === 'number', `materials=${lib}`);
    const slot = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.selectObject(0,null);const s=r.getSlotMaterial(0,0);return s?Object.keys(s).length:-1})()`,
    );
    check('getSlotMaterial 返回槽位对象', slot > 0, `keys=${slot}`);
    const override = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.createSlotInstance(0,0);r.ensureOverride(0,0);return !!r.getSlotMaterial(0,0)})()`,
    );
    check('createSlotInstance + ensureOverride 不抛错', override === true);
    const discard = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.discardOverride(0,0);return !!r.getSlotMaterial(0,0)})()`,
    );
    check('discardOverride 后槽位仍可读', discard === true);
    const exported = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;return {inst:r.exportInstances().length,slots:Array.isArray(r.exportSlots())}})()`,
    );
    check('exportInstances / exportSlots 可导出', typeof exported.inst === 'number' && exported.slots, JSON.stringify(exported));

    // ---- F. PickingService ----
    console.log('\nF. PickingService（屏幕↔世界）');
    const eye = await cdp.eval(`(()=>{const e=window.__editor.renderer.getEye();return e?e.length:0})()`);
    check('getEye 返回 3 分量', eye === 3, `len=${eye}`);
    const ray = await cdp.eval(
      `(()=>{const r=window.__editor.renderer.pointerRay(640,400);return r?{o:r.o.length,d:r.d.length}:null})()`,
    );
    check('pointerRay 返回原点+方向', ray !== null && ray.o === 3 && ray.d === 3, JSON.stringify(ray));
    const round = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;const p=r.worldToScreen([0,1,0]);return p?{x:p.x,y:p.y,behind:p.behind}:null})()`,
    );
    check(
      'worldToScreen 返回有限像素坐标',
      round !== null && Number.isFinite(round.x) && Number.isFinite(round.y),
      JSON.stringify(round),
    );
    const pick = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;const c=r.canvasRect();const nx=((c.width/2)/c.width)*2-1;const ny=1-((c.height/2)/c.height)*2;return r.pickAt(nx,ny)})()`,
    );
    check('pickAt 屏幕中心返回索引或 null（不抛错）', pick === null || Number.isInteger(pick), `hit=${pick}`);

    // ---- G. GizmoService ----
    console.log('\nG. GizmoService（变换/检视）');
    const gizmo = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.selectObject(0,null);r.setGizmoMode('rotate');r.setGizmoSpace('local');const g=r.getGizmoInfo();r.setGizmoMode('translate');r.setGizmoSpace('world');return g?Object.keys(g).length:0})()`,
    );
    check('gizmo mode/space 切换 + getGizmoInfo 可读', gizmo > 0, `keys=${gizmo}`);
    const xform = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.setObjectPos(0,1,0.5);r.setObjectRotDeg(0,1,45);r.setObjectScale(0,1.2);const s=r.getObjectState(0);return s?{p:s.pos,r:s.rot,sc:s.scale}:null})()`,
    );
    check('位置/旋转/缩放写入后状态可读回', xform !== null, JSON.stringify(xform));
    const axis = await cdp.eval(
      `(()=>{const r=window.__editor.renderer;r.setGizmoActiveAxis(1);r.setGizmoActiveAxis(null);return true})()`,
    );
    check('setGizmoActiveAxis 设置/清空不抛错', axis === true);
    const quat = await cdp.eval(
      `(()=>{const q=window.__editor.renderer.getObjectQuat(0);return q?q.length:0})()`,
    );
    check('getObjectQuat 返回 4 分量四元数', quat === 4, `len=${quat}`);

    // ---- G2. 视口拖拽写回场景文档（复审 B1）----
    //
    // 过去 gizmo 拖拽只写渲染器内存：拖完点保存不落盘、点 Play 也看不见（文档里还是旧值），
    // 是「编辑器拥有场景状态」的活标本（AGENTS.md §2.1）。这条断言用**真实事件链**拖手柄，
    // 然后拿「从文档重新解算出的世界位置」与「视口位置」对账 —— 这个判据能抓出
    // 「世界值当局部值写进文件」（父偏移非恒等时，两者相差一个父位移）。
    console.log('\nG2. 视口拖拽写回场景文档（不再有"两份真源"）');
    const b1 = await cdp.eval(`(async () => {
      const r = window.__editor.renderer;
      const ve = window.__editor.viewportEdit;
      const canvas = document.querySelector('canvas');
      if (canvas === null) return { err: 'no canvas' };
      const rect = canvas.getBoundingClientRect();
      const frames = (n) => new Promise((res) => { let k = n; const step = () => (--k <= 0 ? res() : requestAnimationFrame(step)); requestAnimationFrame(step); });
      const ev = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
        clientX: rect.left + x, clientY: rect.top + y,
        bubbles: true, pointerId: 1, isPrimary: true,
      }));
      // ① 挑一个**局部 ≠ 世界**的物体（挂在带平移的父节点下）——这正是过去会写错的形态
      const list = r.getObjectList();
      let idx = -1, nodeId = null;
      for (const item of list) {
        const id = r.getObjectNodeId(item.index);
        if (id === null) continue;
        const w = ve.worldPosFromDoc(id), l = ve.localPos(id);
        if (w === null || l === null) continue;
        if (Math.hypot(w[0] - l[0], w[1] - l[1], w[2] - l[2]) > 1e-6) { idx = item.index; nodeId = id; break; }
      }
      if (idx < 0) return { found: false, reason: '起始场景里没有"局部≠世界"的网格节点' };
      r.selectObject(idx, null);
      await frames(2);
      const posBefore = [...r.getObjectState(idx).pos];
      const docBefore = ve.worldPosFromDoc(nodeId);
      const undoBefore = ve.state().undoDepth;
      // ② 扫格子找 gizmo 手柄（不硬编码坐标：换相机/换场景都不失效）
      //    ⚠️ hitTestGizmo 收的是 **client** 坐标（内部 worldToScreen 也返回 client），
      //    而 dispatchPointer 要的是 canvas 局部坐标 → 扫描要加 rect 偏移，别把两者混了
      let hit = null, at = null;
      outer: for (let y = 0; y < rect.height; y += 3) {
        for (let x = 0; x < rect.width; x += 3) {
          const h = ve.hitTest(rect.left + x, rect.top + y);
          if (h !== null && h.axis >= 0) { hit = h; at = { x, y }; break outer; }
        }
      }
      if (hit === null) return { found: true, hitFound: false };
      // ③ 真事件链拖拽；轴向手柄可能对某些方向不敏感，四个方向里取第一个真出位移的
      let usedDir = null, moved = 0;
      for (const [dx, dy] of [[60, 0], [-60, 0], [0, 60], [0, -60], [45, 45], [-45, -45]]) {
        ev('pointerdown', at.x, at.y);
        ev('pointermove', at.x + dx, at.y + dy);
        await frames(2);
        ev('pointerup', at.x + dx, at.y + dy);
        await frames(2);
        const p = r.getObjectState(idx).pos;
        moved = Math.hypot(p[0] - posBefore[0], p[1] - posBefore[1], p[2] - posBefore[2]);
        if (moved > 1e-4) { usedDir = [dx, dy]; break; }
      }
      const posAfter = [...r.getObjectState(idx).pos];
      const docAfter = ve.worldPosFromDoc(nodeId);
      const docIfWrong = ve.localPos(nodeId); // 旧实现会把世界值写进局部：这条能暴露
      const st = ve.state();
      const consistency = Math.hypot(
        docAfter[0] - posAfter[0], docAfter[1] - posAfter[1], docAfter[2] - posAfter[2],
      );
      // ④ 撤销一步：文档与视口都应回到起点
      ve.undo();
      await frames(2);
      const posUndone = [...r.getObjectState(idx).pos];
      const docUndone = ve.worldPosFromDoc(nodeId);
      return {
        found: true, hitFound: true, nodeId, axis: hit.axis, at, usedDir, moved,
        posBefore, posAfter, docBefore, docAfter, docIfWrong, consistency,
        undoBefore, undoAfterDrag: st.undoDepth, undoAfter: ve.state().undoDepth, dirtyAfterDrag: st.dirty,
        backDelta: Math.hypot(posUndone[0] - posBefore[0], posUndone[1] - posBefore[1], posUndone[2] - posBefore[2]),
        docBackDelta: Math.hypot(docUndone[0] - docBefore[0], docUndone[1] - docBefore[1], docUndone[2] - docBefore[2]),
      };
    })()`);
    check('★ 找到视口里的 gizmo 手柄（可点中）', b1.found === true && b1.hitFound === true, JSON.stringify(b1.at ?? b1.reason ?? null));
    check('★ 拖拽真的移动了物体（视口有反应）', b1.found === true && b1.moved > 1e-4, `moved=${b1.moved?.toFixed(4)}m 方向=${JSON.stringify(b1.usedDir ?? null)}`);
    check(
      '★ 文档被写入且与视口一致（从文档重算的世界位置 == 视口位置）',
      b1.found === true &&
        b1.consistency < 1e-6 &&
        JSON.stringify(b1.docAfter) !== JSON.stringify(b1.docBefore),
      `一致性=${b1.consistency?.toExponential(2)} 文档 ${JSON.stringify(b1.docBefore)} → ${JSON.stringify(b1.docAfter)}`,
    );
    check(
      '★ 写入的是**局部**变换（不是把世界值当局部值写进去）',
      b1.found === true && b1.docIfWrong !== null &&
        Math.abs(b1.docIfWrong[0] - b1.posAfter[0]) > 1e-6,
      `局部 ${JSON.stringify(b1.docIfWrong)} vs 世界 ${JSON.stringify(b1.posAfter)}`,
    );
    check(
      '★ 一次拖拽 = 一条撤销编辑；撤销后文档与视口都回到起点',
      b1.found === true &&
        b1.undoAfterDrag === b1.undoBefore + 1 &&
        b1.undoAfter === b1.undoBefore &&
        b1.backDelta < 1e-6 &&
        b1.docBackDelta < 1e-6,
      `undo ${b1.undoBefore} →(拖拽后) ${b1.undoAfterDrag} →(撤销后) ${b1.undoAfter}；` +
        `视口回退 ${b1.backDelta?.toExponential(2)} 文档回退 ${b1.docBackDelta?.toExponential(2)}`,
    );
    check('拖拽后 dirty 亮起（面板显示未保存）', b1.dirtyAfterDrag === true, `dirty=${b1.dirtyAfterDrag}`);

    // ---- G2b. 拖父节点：可渲染子节点必须在视口里跟着走（codex 评审 P1）----
    //
    // 视口物体是**扁平**的（每个物体一份世界变换），而文档是层级：拖父节点时子物体在文档里
    // 跟着走，视口里若不主动推就留在原地，松手/保存/Play 之后才跳过去 —— 又一份"两份真源"。
    console.log('\nG2b. 拖父节点时子树跟随（视口物体是扁平的）');
    const g2b = await cdp.eval(`(async () => {
      const r = window.__editor.renderer;
      const ve = window.__editor.viewportEdit;
      const canvas = document.querySelector('canvas');
      if (canvas === null) return { err: 'no canvas' };
      const rect = canvas.getBoundingClientRect();
      const frames = (n) => new Promise((res) => { let k = n; const step = () => (--k <= 0 ? res() : requestAnimationFrame(step)); requestAnimationFrame(step); });
      const ev = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
        clientX: rect.left + x, clientY: rect.top + y, bubbles: true, pointerId: 1, isPrimary: true,
      }));
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      // 挑一个"带可渲染子节点"的物体（父节点编辑才会暴露这个问题）
      let idx = -1, nodeId = null, kids = [];
      for (const o of r.getObjectList()) {
        const id = r.getObjectNodeId(o.index);
        if (id === null) continue;
        const renderable = (ve.childIds(id) ?? []).filter((k) => r.findObjectIndexByNodeId(k) !== null);
        if (renderable.length > 0) { idx = o.index; nodeId = id; kids = renderable; break; }
      }
      if (idx < 0) return { found: false, reason: '起始场景里没有"带可渲染子节点"的节点' };
      r.selectObject(idx, null);
      await frames(2);
      const parentBefore = [...r.getObjectState(idx).pos];
      const childBefore = kids.map((k) => ({ k, pos: [...r.getObjectState(r.findObjectIndexByNodeId(k)).pos] }));
      // 扫格子找手柄（不硬编码坐标）
      let at = null;
      outer2: for (let y = 0; y < rect.height; y += 3) {
        for (let x = 0; x < rect.width; x += 3) {
          const h = ve.hitTest(rect.left + x, rect.top + y);
          if (h !== null && h.axis >= 0) { at = { x, y }; break outer2; }
        }
      }
      if (at === null) return { found: true, hitFound: false };
      let moved = 0;
      for (const [dx, dy] of [[60, 0], [-60, 0], [0, 60], [0, -60], [45, 45], [-45, -45]]) {
        ev('pointerdown', at.x, at.y);
        ev('pointermove', at.x + dx, at.y + dy);
        await frames(2);
        ev('pointerup', at.x + dx, at.y + dy);
        await frames(2);
        moved = dist([...r.getObjectState(idx).pos], parentBefore);
        if (moved > 1e-4) break;
      }
      const parentAfter = [...r.getObjectState(idx).pos];
      const childAfter = childBefore.map(({ k }) => {
        const i = r.findObjectIndexByNodeId(k);
        return { k, view: [...r.getObjectState(i).pos], doc: ve.worldPosFromDoc(k) };
      });
      // 撤销：父与子都必须回到起点
      ve.undo();
      await frames(2);
      const childUndone = childBefore.map(({ k }) => [...r.getObjectState(r.findObjectIndexByNodeId(k)).pos]);
      return { found: true, hitFound: true, nodeId, kids, parentBefore, parentAfter, moved, childBefore, childAfter, childUndone };
    })()`);
    check('★ 找到"带可渲染子节点"的节点可拖（G2b 前提）', g2b.found === true && g2b.hitFound === true, JSON.stringify(g2b.reason ?? g2b.nodeId ?? null));
    check('★ 父节点真的被拖动了（G2b 前提）', g2b.found === true && g2b.moved > 1e-4, `moved=${g2b.moved?.toFixed(4)}m`);
    const g2bKidFollowed = g2b.found === true && g2b.hitFound === true &&
      g2b.childAfter.every((c, i) => {
        const before = g2b.childBefore[i].pos;
        return Math.hypot(c.view[0] - c.doc[0], c.view[1] - c.doc[1], c.view[2] - c.doc[2]) < 1e-6 &&
          Math.hypot(c.view[0] - before[0], c.view[1] - before[1], c.view[2] - before[2]) > 1e-4;
      });
    check(
      '★ 拖父节点时子物体跟着走，且视口与文档一致',
      g2bKidFollowed,
      `节点 ${g2b.nodeId ?? '-'}：子 ${JSON.stringify(g2b.childAfter?.map((c, i) => {
        const before = g2b.childBefore[i].pos;
        return Math.hypot(c.view[0] - before[0], c.view[1] - before[1], c.view[2] - before[2]).toFixed(4);
      }) ?? null)}（位移量）`,
    );
    const g2bUndone = g2b.found === true && g2b.hitFound === true &&
      g2b.childUndone.every((p, i) => {
        const before = g2b.childBefore[i].pos;
        return Math.hypot(p[0] - before[0], p[1] - before[1], p[2] - before[2]) < 1e-6;
      });
    check('★ 撤销后子物体也回到起点（子树一起回写）', g2bUndone, `children=${g2b.kids?.length ?? 0}`);

    // ---- G2c. 旋转拖拽也要落盘（codex / Copilot 评审 P1）----
    //
    // 曾经的漏项：把世界量反解成局部量时只取了位置与缩放，`local.rotation` 被直接丢弃；
    // 纯旋转拖拽期间位置/缩放都没变 → 整条编辑被当成"值没有变化"丢掉，保存/Play 后
    // 旋转回到旧值。这条断言用真事件链转手柄，把"文档重算的世界四元数"与"视口四元数"对账。
    console.log('\nG2c. 旋转拖拽写回场景文档');
    const g2c = await cdp.eval(`(async () => {
      const r = window.__editor.renderer;
      const ve = window.__editor.viewportEdit;
      const canvas = document.querySelector('canvas');
      if (canvas === null) return { err: 'no canvas' };
      const rect = canvas.getBoundingClientRect();
      const frames = (n) => new Promise((res) => { let k = n; const step = () => (--k <= 0 ? res() : requestAnimationFrame(step)); requestAnimationFrame(step); });
      const ev = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
        clientX: rect.left + x, clientY: rect.top + y, bubbles: true, pointerId: 1, isPrimary: true,
      }));
      const dot = (a, b) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
      // 选一个有文档来源的物体
      let idx = -1, nodeId = null;
      for (const o of r.getObjectList()) {
        const id = r.getObjectNodeId(o.index);
        if (id !== null) { idx = o.index; nodeId = id; break; }
      }
      if (idx < 0) return { found: false };
      r.setGizmoMode('rotate');
      r.selectObject(idx, null);
      await frames(3);
      const viewBefore = [...r.getObjectQuat(idx)];
      const docBefore = ve.quatOfDoc(nodeId);
      const undoBefore = ve.state().undoDepth;
      let at = null;
      outer3: for (let y = 0; y < rect.height; y += 3) {
        for (let x = 0; x < rect.width; x += 3) {
          const h = ve.hitTest(rect.left + x, rect.top + y);
          if (h !== null && h.axis >= 0) { at = { x, y }; break outer3; }
        }
      }
      if (at === null) { r.setGizmoMode('translate'); return { found: true, hitFound: false }; }
      // 圆环手柄：绕圈拖一段弧（同一方向连续两次，确保产生非零角）
      ev('pointerdown', at.x, at.y);
      for (const step of [[40, 0], [40, 30], [10, 50]]) {
        ev('pointermove', at.x + step[0], at.y + step[1]);
        await frames(2);
      }
      ev('pointerup', at.x + 40, at.y + 50);
      await frames(2);
      const viewAfter = [...r.getObjectQuat(idx)];
      const docAfter = ve.quatOfDoc(nodeId);
      const undoAfterDrag = ve.state().undoDepth;
      ve.undo();
      await frames(2);
      const viewUndone = [...r.getObjectQuat(idx)];
      const docUndone = ve.quatOfDoc(nodeId);
      r.setGizmoMode('translate');
      await frames(2);
      return {
        found: true, hitFound: true, nodeId, viewBefore, docBefore, viewAfter, docAfter,
        viewUndone, docUndone, undoBefore, undoAfterDrag,
        viewVsDoc: dot(viewAfter, docAfter), beforeVsAfter: dot(docBefore, docAfter),
        undoneViewVsBefore: dot(viewUndone, viewBefore), undoneDocVsBefore: dot(docUndone, docBefore),
      };
    })()`);
    check('★ 转到旋转手柄（G2c 前提）', g2c.found === true && g2c.hitFound === true, JSON.stringify(g2c.nodeId ?? null));
    check(
      '★★ 旋转拖拽写回文档（旋转真的变了，不是被丢弃）',
      g2c.found === true && g2c.hitFound === true &&
        g2c.beforeVsAfter < 1 - 1e-6 &&
        Math.abs(g2c.viewVsDoc - 1) < 1e-6,
      `文档旋转前后 |dot|=${g2c.beforeVsAfter?.toFixed(6)}（1 = 没变）；视口 vs 文档 |dot|=${g2c.viewVsDoc?.toFixed(6)}（1 = 一致）`,
    );
    check(
      '★ 撤销旋转后文档与视口一起回到原姿态',
      g2c.found === true && g2c.hitFound === true &&
        Math.abs(g2c.undoneViewVsBefore - 1) < 1e-6 &&
        Math.abs(g2c.undoneDocVsBefore - 1) < 1e-6 &&
        g2c.undoAfterDrag === g2c.undoBefore + 1,
      `undo ${g2c.undoBefore}→${g2c.undoAfterDrag}；视口回退 |dot|=${g2c.undoneViewVsBefore?.toFixed(6)} 文档回退 |dot|=${g2c.undoneDocVsBefore?.toFixed(6)}`,
    );

    // ---- H. 动画面板（检视页条件分组 + 资产库生成路径）----
    // 「模型预览」面板已收掉（2026-09-23 布局改造）：模型进场景的唯一路径是
    // 底部资产库生成（addObject + 自动选中），不再走 setCharacter 换角色槽——
    // 旧槽位假设在场景化世界里会把场景物体的网格换掉（导入"没反应"的根因）。
    // 动画面板并入右侧检视页：选中带骨物体才出现。断言用的 rigged GLB 就在
    // 仓库 assets/ 里，此段因此从「需 --glb」升级为常开。
    console.log('\nH. 动画面板（检视页条件分组 / 资产库生成路径）');
    {
      if (!fs.existsSync(path.resolve(GLB))) {
        skip('动画断言', `rigged GLB 不存在: ${GLB}`);
      } else {
        // 布局收敛断言：左栏只剩场景层级；动画分组在检视页且无骨时隐藏；顶栏状态行在位
        const layout = await cdp.eval(`(() => {
          const leftIds = [...document.querySelectorAll('#groups > details')].map((d) => d.id);
          const dock = document.getElementById('asset-dock').getBoundingClientRect();
          const leftCol = document.querySelector('#mainrow > .panel').getBoundingClientRect();
          const insp = document.getElementById('inspector').getBoundingClientRect();
          const animInInsp = document.querySelector('#inspector .insp-pane[data-pane=\"inspector\"] details#animation');
          return {
            leftIds,
            modelPanelGone: document.querySelector('#groups details#model') === null,
            animInLeft: document.querySelector('#groups details#animation') !== null,
            animHidden: animInInsp !== null ? animInInsp.hidden : null,
            topStatus: document.getElementById('model-info') !== null,
            objects: window.__editor.renderer.getObjectList().length,
            dockLeft: Math.round(dock.left),
            dockRight: Math.round(dock.right),
            inspLeft: Math.round(insp.left),
            leftBottom: Math.round(leftCol.bottom),
            dockTop: Math.round(dock.top),
          };
        })()`);
        check('左栏不再有「模型预览」分组（面板已收掉）', layout.modelPanelGone === true);
        check('动画分组不在左栏（已并入检视页）', layout.animInLeft === false);
        check('动画分组在检视页且默认隐藏（场景无带骨物体）', layout.animHidden === true);
        check('顶栏状态行 #model-info 存在（原模型预览信息行迁移）', layout.topStatus === true);
        check('左栏分组只剩场景层级', layout.leftIds.join(',') === 'hierarchy', layout.leftIds.join(','));
        check('资产库 dock 左缘贴屏幕（x=0）', layout.dockLeft === 0, `dockLeft=${layout.dockLeft}`);
        check('资产库 dock 右缘接到 Inspector 前', layout.dockRight <= layout.inspLeft + 6, `dockRight=${layout.dockRight} inspLeft=${layout.inspLeft}`);
        check('场景层级下边缘 = 资产库上边缘', Math.abs(layout.leftBottom - layout.dockTop) <= 1, `leftBottom=${layout.leftBottom} dockTop=${layout.dockTop}`);

        // 功能体（✦）模式：刷怪点进层级、选中才出属性分组、顶级 tab 已移除
        const fn = await cdp.eval(`(() => {
          const rows = [...document.querySelectorAll('#groups .hier-row.fn')];
          const group = document.getElementById('spawn-group');
          return {
            spawnTabGone: document.querySelector('#inspector .insp-tab[data-tab="spawn"]') === null,
            spawnPaneGone: document.querySelector('#inspector .insp-pane[data-pane="spawn"]') === null,
            fnRows: rows.length,
            groupExists: group !== null,
            groupHidden: group !== null ? group.hidden : null,
            firstFnNode: rows[0]?.dataset.fnNode ?? null,
          };
        })()`);
        check('顶级「刷怪点」tab 与独立 pane 已移除', fn.spawnTabGone === true && fn.spawnPaneGone === true);
        check(
          `层级功能体（✦）行数 = 起始场景 SpawnPoint 组件数（${expect.spawnPoints}）`,
          fn.fnRows === expect.spawnPoints,
          `rows=${fn.fnRows}`,
        );
        check('刷怪点分组存在于检视页且未选中时隐藏（选中驱动）', fn.groupExists === true && fn.groupHidden === true);

        if (fn.firstFnNode !== null) {
          const FN_NODE_ID = fn.firstFnNode;
          const picked = await cdp.eval(`(async () => {
            document.querySelector('#groups .hier-row.fn').click();
            await new Promise((r) => setTimeout(r, 300));
            return {
              groupHidden: document.getElementById('spawn-group')?.hidden ?? null,
              sel: window.__editor.spawn.state().selectedNodeId,
              rowSel: document.querySelector('#groups .hier-row.fn')?.classList.contains('sel') ?? false,
            };
          })()`);
          check('点选 ✦ 功能体行后刷怪点分组出现', picked.groupHidden === false);
          check('选中态回读到该功能体（selectedNodeId 一致）', picked.sel === FN_NODE_ID);
          check('✦ 行高亮 .sel', picked.rowSel === true);
          // 收尾取消选中，分组应收起（不污染后续断言）
          const cleared = await cdp.eval(`(async () => {
            window.__editor.spawn.select(null);
            await new Promise((r) => setTimeout(r, 200));
            return document.getElementById('spawn-group')?.hidden ?? null;
          })()`);
          check('取消选中后分组收起', cleared === true);
        }

        // 资产库生成 → addObject + 自动选中 → 动画分组出现
        const spawned = await cdp.eval(`(async () => {
          window.__editor.spawnAsset(${JSON.stringify(GLB)});
          await new Promise((r) => setTimeout(r, 4000));
          const r = window.__editor.renderer;
          const anim = document.querySelector('#inspector .insp-pane[data-pane=\"inspector\"] details#animation');
          return {
            objects: r.getObjectList().length,
            animHidden: anim !== null ? anim.hidden : null,
            has: r.hasAnimation(),
            clips: r.getClipNames(),
          };
        })()`);
        check(
          '生成后对象数 +1（addObject 新增，不再替换角色槽）',
          spawned.objects === layout.objects + 1,
          `${layout.objects} → ${spawned.objects}`,
        );
        check('选中带骨物体后动画分组出现', spawned.animHidden === false);
        check('hasAnimation 为真且能列出 clip', spawned.has === true && spawned.clips.length > 0, JSON.stringify({ has: spawned.has, clips: spawned.clips.length }));
        const play = await cdp.eval(
          `(()=>{const r=window.__editor.renderer;r.playAnimation(0);const a=r.isAnimationPlaying();r.setAnimationSpeed(0.5);r.seekAnimation(0.2);const t=r.getAnimationTime();r.pauseAnimation();const b=r.isAnimationPlaying();r.stopAnimation();return {a,b,t}})()`,
        );
        check('播放/暂停状态机正确', play.a === true && play.b === false, JSON.stringify(play));
        check('seekAnimation 后时间被写入', Number.isFinite(play.t), `t=${play.t}`);

        // 收尾：删掉生成的物体，对象数回落，不污染后续段（K/L 绑定段沿用基线）
        const cleaned = await cdp.eval(`(() => {
          const r = window.__editor.renderer;
          r.removeObject(r.state.objects.length - 1);
          return r.getObjectList().length;
        })()`);
        check('清理生成物体后对象数回落', cleaned === layout.objects, `${cleaned} vs 基线 ${layout.objects}`);
      }
    }

    // ---- J. AssetPreview（右侧栏 3D 预览 + 动画 Timeline + 骨骼 X-ray）----
    console.log('\nJ. AssetPreview（资产预览 / 动画时间轴 / 骨骼 X-ray）');
    const previewDom = await cdp.eval(
      `(()=>{const h=document.getElementById('asset-preview-host');const x=document.querySelector('.gz-xray');return {host:h!==null, xray:x!==null, preview:typeof window.__editor.preview}})()`,
    );
    check('资产预览宿主 #asset-preview-host 存在', previewDom.host === true);
    check('主视图骨骼 X-ray 按钮 .gz-xray 存在', previewDom.xray === true);
    check('window.__editor.preview 调试钩子已挂载', previewDom.preview === 'object');

    const PREVIEW_GLB = arg(
      'preview',
      'assets/characters/models/E-01/rigged/E01_Shambler_900_rigged_animated.glb',
    );
    if (!fs.existsSync(path.resolve(PREVIEW_GLB))) {
      skip('AssetPreview 载入 rigged GLB', `预览 GLB 不存在: ${PREVIEW_GLB}`);
    } else {
      const loadRes = await cdp.eval(`(async () => {
        window.__editor.previewShow(${JSON.stringify(PREVIEW_GLB)});
        const tab = document.querySelector('.insp-tab[data-tab="asset"]');
        if (tab) tab.click();
        await new Promise((r) => setTimeout(r, 3500));
        const c = document.querySelector('#asset-preview-host .ap-canvas');
        const st = window.__editor.preview.getState();
        return {
          state: st,
          canvas: c ? { w: c.width, h: c.height, disp: getComputedStyle(c).display } : null,
          clipOpts: document.querySelectorAll('#asset-preview-host .ap-clip option').length,
          timeText: (document.querySelector('#asset-preview-host .ap-time') || {}).innerText || '',
        };
      })()`);
      check('载入 rigged GLB 后预览有对象', loadRes.state.hasObject === true, JSON.stringify(loadRes.state));
      check('预览物体带骨骼动画（isAnim）', loadRes.state.isAnim === true, `isAnim=${loadRes.state.isAnim}`);
      check('预览自动播放（playing）', loadRes.state.playing === true, `playing=${loadRes.state.playing}`);
      check(
        '预览画布有有效尺寸',
        loadRes.canvas !== null && loadRes.canvas.w > 0 && loadRes.canvas.h > 0,
        JSON.stringify(loadRes.canvas),
      );
      check('Timeline 片段下拉有选项', loadRes.clipOpts > 0, `clips=${loadRes.clipOpts}`);
      check(
        'Timeline 时间轴文本格式正确',
        /\d+\.\d+ \/ \d+\.\d+ s/.test(loadRes.timeText),
        loadRes.timeText,
      );

      // 动画推进：主循环持续 advance，time 应增长 → Timeline 实时更新。
      // 注意 clip 是循环的（duration≈1.97s），直接 t2>t1 会因 wrap 误判，
      // 用「模 duration 后的前进量」判定是否真的在向前走。
      const t1 = loadRes.state.time;
      const dur = loadRes.state.duration;
      await sleep(1200);
      const t2 = await cdp.eval('window.__editor.preview.getState().time');
      const adv = (((Number(t2) - Number(t1)) % dur) + dur) % dur;
      check(
        '动画时间在推进（考虑循环 wrap，Timeline 实时更新）',
        Number.isFinite(adv) && adv > 0.05,
        `${t1.toFixed(3)} → ${t2.toFixed(3)}（前进 ${adv.toFixed(3)} / 时长 ${dur.toFixed(3)}）`,
      );

      // 骨骼 X-ray 开关（gizmo-bar 按钮，同时驱动预览 + 主视图）
      const xray = await cdp.eval(`(async () => {
        const btn = document.querySelector('.gz-xray');
        btn.click();
        await new Promise((r) => setTimeout(r, 600));
        return { active: btn.classList.contains('active'), previewXray: window.__editor.preview.getState().skeletonVisible };
      })()`);
      check('骨骼 X-ray 按钮激活', xray.active === true);
      check('预览骨骼 X-ray 叠加开启', xray.previewXray === true);

      // 预览增强（2026-09-23）：贴图 / 渲染风格 / LOD 切换
      const pv = await cdp.eval(`(async () => {
        const st0 = window.__editor.preview.getState();
        // ① 贴图根因：materialData 的「有贴图」flag 必须立起（历史上 packMaterial 每帧重置导致永假）
        // ② 风格切换：白模 = textured false；切回贴图 = true
        const swTex = document.querySelector('#asset-preview-host .ap-sw-tex');
        const before = { textured: st0.textured, tris: st0.tris, lodCount: st0.lodCount };
        swTex.checked = false; // 贴图开关 off = 白模
        swTex.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        const clay = window.__editor.preview.getState();
        swTex.checked = true;
        swTex.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        const back = window.__editor.preview.getState();
        return { before, clay: { style: clay.style, textured: clay.textured }, back: { style: back.style, textured: back.textured } };
      })()`);
      check('预览贴图生效（textured=true，根因：flags 位每帧被 packMaterial 重置）', pv.before.textured === true);
      check('白模切换生效（textured=false）', pv.clay.style === 'clay' && pv.clay.textured === false);
      check('切回贴图生效', pv.back.style === 'textured' && pv.back.textured === true);
      check(
        `LOD 家族下拉就位（≥2 档，manifest lods[]）`,
        pv.before.lodCount >= 2,
        `lodCount=${pv.before.lodCount}`,
      );

      if (pv.before.lodCount >= 2) {
        const lod = await cdp.eval(`(async () => {
          const sel = document.querySelector('#asset-preview-host .ap-lod');
          const tris0 = window.__editor.preview.getState().tris;
          const orig = sel.selectedIndex; // 切走前记住原档（骨骼开关等后续断言依赖它是有骨架的档）
          sel.value = '0'; // LOD0（原生高模）
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 5000)); // 高模 44MB：fetch+parse 给足
          const st1 = window.__editor.preview.getState();
          // 切回原档，不把后续段的预览留在大模型上
          sel.selectedIndex = orig >= 0 ? orig : sel.options.length - 1;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 3000));
          return { tris0, tris1: st1.tris, back: window.__editor.preview.getState().tris };
        })()`);
        check('LOD0 切换后面数显著变化（高模 vs 低模）', lod.tris1 > lod.tris0 * 2, `${lod.tris0} → ${lod.tris1}`);
        check('切回低档面数回落', lod.back <= lod.tris0 * 2, `back=${lod.back}`);
      }

      // 3D 视图尺寸空格调档 + 骨骼按钮进风格行（rigged 资产）
      const sp = await cdp.eval(`(async () => {
        const P = window.__editor.preview;
        const host = document.getElementById('asset-preview-host');
        const h0 = P.getState().viewH;
        const tier0 = P.getState().sizeTier;
        // ① 直接调 cycleSize（自动化入口）
        P.cycleSize(1);
        await new Promise((r) => setTimeout(r, 400));
        const h1 = P.getState().viewH;
        P.cycleSize(-1);
        await new Promise((r) => setTimeout(r, 300));
        const h2 = P.getState().viewH;
        // ② 真键盘事件：悬停预览区按空格（capture 拦截，不触发全局 Play）
        host.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 300));
        const tierSpace = P.getState().sizeTier;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 300));
        const tierShift = P.getState().sizeTier;
        host.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
        P.cycleSize(-tierShift);
        return { h0, h1, h2, tier0, tierSpace, tierShift };
      })()`);
      check('cycleSize(+1) 视图变高', sp.h1 > sp.h0, `${sp.h0} → ${sp.h1}px`);
      check('cycleSize(-1) 回落', sp.h2 === sp.h0, `${sp.h1} → ${sp.h2}px`);
      check('悬停空格 = 下一档（capture 拦截生效）', sp.tierSpace === (sp.tier0 + 1 + 3) % 3, `tier ${sp.tier0} → ${sp.tierSpace}`);
      check('Shift+空格 = 上一档', sp.tierShift === (sp.tierSpace + 2) % 3, `tier ${sp.tierSpace} → ${sp.tierShift}`);

      // 显示开关（标准开关形式）：贴图 / 骨骼 排在 3D 视图下方；rigged 可用、纯网格禁用
      const xrow = await cdp.eval(`(async () => {
        const switches = [...document.querySelectorAll('#asset-preview-host .ap-view .ap-switch > span')].map((b) => b.textContent.trim());
        const swX = document.querySelector('#asset-preview-host .ap-sw-xray');
        const riggedEnabled = swX ? !swX.disabled : null;
        // 切到纯网格资产（baked，无骨架）验证禁用
        window.__editor.previewShow('assets/characters/models/E-01/textured/E01_Shambler_900_baked.glb');
        await new Promise((r) => setTimeout(r, 2500));
        const swB = document.querySelector('#asset-preview-host .ap-sw-xray');
        const baked = { disabled: swB?.disabled ?? null,
                        checked: swB?.checked ?? null,
                        title: swB?.parentElement?.title ?? '' };
        // 切回 rigged
        window.__editor.previewShow(${JSON.stringify('PREVIEW_GLB_PLACEHOLDER')});
        await new Promise((r) => setTimeout(r, 2500));
        return { switches, riggedEnabled, baked };
      })()`.replace('PREVIEW_GLB_PLACEHOLDER', PREVIEW_GLB));
      check('3D 视图下方标准开关：贴图 / 骨骼', xrow.switches.length === 2 && xrow.switches[0] === '贴图' && xrow.switches[1] === '骨骼', JSON.stringify(xrow.switches));
      check('rigged 资产骨骼开关可用', xrow.riggedEnabled === true);
      check('纯网格资产骨骼开关禁用 + 复位 + 明示原因', xrow.baked.disabled === true && xrow.baked.checked === false && /无骨骼/.test(xrow.baked.title), JSON.stringify(xrow.baked));
      const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const shot2Path = path.join(OUT_DIR, 'editor-preview-smoke.png');
      fs.writeFileSync(shot2Path, Buffer.from(shot2.data, 'base64'));
      console.log(`预览截图：${shot2Path}`);
    }

    // ---- J2. AssetBrowser UI（返回上一层 / 右键菜单 / 行内重命名）----
    // 探针文件放 .workbuddy/tmp/（gitignored）：改名动作真实落盘，但不弄脏工作区。
    console.log('\nJ2. AssetBrowser UI（上一层按钮 / 右键菜单四件套 / 行内重命名）');
    {
      const upDom = await cdp.eval(`(() => {
        const b = document.querySelector('#asset-dock .asset-up');
        return { exists: b !== null, disabled: b ? b.disabled : null };
      })()`);
      check('返回上一层按钮 .asset-up 存在', upDom.exists === true);

      // 导航态 → 按钮可用 → 点击回上一层 → 到根后置灰
      const nav = await cdp.eval(`(async () => {
        const A = window.__editor.assets;
        await A.selectDir('assets/scenes');
        const s1 = A.getState();
        document.querySelector('#asset-dock .asset-up').click();
        await new Promise((r) => setTimeout(r, 300));
        const s2 = A.getState();
        await A.selectDir('');
        const s3 = A.getState();
        await A.selectDir('assets'); // 复位，别影响后面的段
        return { s1, s2, s3 };
      })()`);
      check('子目录里上一层可用', nav.s1.dir === 'assets/scenes' && nav.s1.upDisabled === false);
      check('点击上一层回到父目录', nav.s2.dir === 'assets' && nav.s2.upDisabled === false, nav.s2.dir);
      check('项目根上置灰', nav.s3.dir === '' && nav.s3.upDisabled === true);

      // 探针文件 + 右键菜单结构。每轮先清空探针目录：上一轮改名留下的
      // probe2.json 会让「probe.json → probe2.json」撞目标占用 409，假失败。
      const PROBE_DIR = '.workbuddy/tmp/ui-refine';
      const PROBE = `${PROBE_DIR}/probe.json`;
      fs.rmSync(path.resolve(PROBE_DIR), { recursive: true, force: true });
      const menuRes = await cdp.eval(`(async () => {
        const w = await fetch('/__fs/write', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: ${JSON.stringify(PROBE)}, content: '{"probe":1}' }) });
        if (!(w.ok && (await w.json()).ok === true)) throw new Error('探针文件写入失败');
        const A = window.__editor.assets;
        await A.selectDir(${JSON.stringify(PROBE_DIR)});
        const el = document.querySelector('.asset-content [data-name="probe.json"]');
        if (el === null) throw new Error('探针条目未渲染');
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 300 }));
        await new Promise((r) => setTimeout(r, 100));
        const menu = document.getElementById('ctx-menu');
        const items = [...menu.querySelectorAll('.ctx-item')].map((b) => b.textContent);
        const seps = menu.querySelectorAll('.ctx-sep').length;
        const open = menu.classList.contains('open');
        return { open, items, seps, sel: A.getState().names.includes('probe.json') };
      })()`);
      check('右键后菜单打开且条目被选中', menuRes.open === true && menuRes.sel === true);
      check('菜单恰好一条分隔线', menuRes.seps === 1, `seps=${menuRes.seps}`);
      check('分隔线后依次是四个通用文件动作（zh 源文案）', menuRes.items.length === 7
        && menuRes.items[3] === '复制相对路径'
        && menuRes.items[4] === '复制绝对路径'
        && menuRes.items[5] === '重命名…'
        && menuRes.items[6] === '在资源管理器中显示', JSON.stringify(menuRes.items));

      // 复制相对路径：菜单动作端到端（HUD 反馈 + 剪贴板尽力核对——无头环境剪贴板
      // 权限不一定给，剪贴板对不上不算 FAIL，但 HUD 必须有明确反馈）。
      // 剪贴板权限挂起时 writeText 会停一会儿才落判，等 1.2s 而不是 400ms。
      const copyRes = await cdp.eval(`(async () => {
        const menu = document.getElementById('ctx-menu');
        const btn = [...menu.querySelectorAll('.ctx-item')].find((b) => b.textContent.includes('复制相对路径'));
        btn.click();
        await new Promise((r) => setTimeout(r, 1200));
        let clip = null;
        try { clip = await navigator.clipboard.readText(); } catch { clip = null; }
        return { hud: (document.getElementById('model-info') || {}).textContent || '', clip };
      })()`);
      check('复制相对路径有 HUD 反馈', /已复制相对路径|复制失败/.test(copyRes.hud), copyRes.hud);
      if (copyRes.clip === null) {
        // 读不到（无授权/无头环境）才降级为环境 skip；读到了但内容不对 = 真失败
        skip('剪贴板内容核对', '当前环境读不到剪贴板（HUD 反馈已验证）');
      } else {
        check('剪贴板内容 = 相对路径', copyRes.clip === PROBE, copyRes.clip);
      }

      // 行内重命名：Enter 提交 → 服务端落盘 → 浏览器刷新
      const renameRes = await cdp.eval(`(async () => {
        const A = window.__editor.assets;
        const started = A.beginRename(${JSON.stringify(PROBE)});
        const st = A.getState();
        const input = document.querySelector('.asset-content .asset-rename');
        if (input === null) return { started, st, disk: null, err: '输入框未出现' };
        const v0 = input.value; // 预填旧名要在赋新值前读走
        input.value = 'probe2.json';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 900));
        const after = A.getState();
        const check = await fetch('/__fs/file?path=' + encodeURIComponent(${JSON.stringify(`${PROBE_DIR}/probe2.json`)}));
        const old = await fetch('/__fs/file?path=' + encodeURIComponent(${JSON.stringify(PROBE)}));
        return { started, st: { renaming: st.renaming, v: v0 }, after, disk: { neu: check.status, old: old.status }, err: null };
      })()`);
      check('beginRename 进入编辑态（输入框出现且预填旧名）', renameRes.started === true && renameRes.st.renaming === true && renameRes.st.v === 'probe.json');
      check('Enter 提交后编辑态退出 + 列表刷新出新名', renameRes.after.renaming === false && renameRes.after.names.includes('probe2.json'), JSON.stringify(renameRes.after.names));
      check('改名真实落盘（新路径 200 / 旧路径 404）', renameRes.disk.neu === 200 && renameRes.disk.old === 404, JSON.stringify(renameRes.disk));

      // Esc 取消：编辑态退出、名字不动
      const escRes = await cdp.eval(`(async () => {
        const A = window.__editor.assets;
        A.beginRename(${JSON.stringify(`${PROBE_DIR}/probe2.json`)});
        const input = document.querySelector('.asset-content .asset-rename');
        input.value = 'should-not-exist.json';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 200));
        const ghost = await fetch('/__fs/file?path=' + encodeURIComponent(${JSON.stringify(`${PROBE_DIR}/should-not-exist.json`)}));
        return { renaming: A.getState().renaming, names: A.getState().names, ghost: ghost.status };
      })()`);
      check('Esc 取消编辑态且不落盘', escRes.renaming === false && !escRes.names.includes('should-not-exist.json') && escRes.ghost === 404);

      // 复位浏览目录，探针文件留在 .workbuddy/tmp（gitignored，不污染工作区）
      await cdp.eval(`(async () => { await window.__editor.assets.selectDir('assets'); })()`);
    }

    // ---- 截图 ----
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(OUT_DIR, 'editor-smoke.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`\n截图：${shotPath}`);

    // ---- N. 多语言切换（i18n：zh 源文案 + en 词典 + 持久化刷新）----
    // 前面所有断言都在 zh 下跑（boot 时显式锁定）；这里点**真按钮**切 en 验证
    // 用户路径（持久化 + 整页刷新 + 词典生效），再点回 zh 收尾。
    console.log('\nN. 多语言切换（zh ↔ en）');
    {
      const clicked = await cdp.eval(`(() => {
        const btn = document.querySelector('[data-lang-toggle]');
        if (btn === null) return false;
        btn.click();
        return true;
      })()`);
      check('语言切换按钮 [data-lang-toggle] 存在且可点', clicked === true);
      await sleep(6000);
      const enState = await cdp.eval(`(() => {
        const title = document.querySelector('#asset-dock .asset-title');
        const up = document.querySelector('#asset-dock .asset-up');
        const filter = document.querySelector('#asset-dock .asset-filter');
        return {
          lang: localStorage.getItem('zh.ui.lang'),
          title: title ? title.textContent.trim() : null,
          upTitle: up ? up.title : null,
          filterPh: filter ? filter.placeholder : null,
        };
      })()`);
      check('点击后持久化 lang=en', enState.lang === 'en');
      check('en 模式资产库标题 = Asset Library', enState.title === 'Asset Library', JSON.stringify(enState.title));
      check('en 模式「上一层」tooltip = Up One Level', enState.upTitle === 'Up One Level', JSON.stringify(enState.upTitle));
      check('en 模式筛选占位符已翻译', typeof enState.filterPh === 'string' && /filter/i.test(enState.filterPh), JSON.stringify(enState.filterPh));
      // 收尾切回 zh：直接写 localStorage 即可（省一次整页 reload，docs/21 §2.5）——
      // 切换按钮的双向路径已由上面的 en 断言覆盖，下一轮 boot 归一也会锁 zh
      const backZh = await cdp.eval(`(() => { localStorage.setItem('zh.ui.lang', 'zh'); return localStorage.getItem('zh.ui.lang'); })()`);
      check('收尾切回 zh（localStorage，免 reload）', backZh === 'zh', backZh);
    }

    // ---- 汇总 ----
    return summary(cdp.consoleErrors, cdp.exceptions);
    return ok ? 0 : 1;
  } finally {
    try {
      chrome.kill();
    } catch {
      /* 已退出 */
    }
    if (server !== null) {
      try {
        server.kill();
      } catch {
        /* 已退出 */
      }
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('冒烟验证异常终止：', err.message);
    process.exit(1);
  });
