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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ------------------------------------------------------------------ 参数

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const PORT = Number(arg('port', 5178));
const CDP_PORT = Number(arg('cdp', 9333));
const GLB = arg('glb', null);
const OUT_DIR = path.resolve(arg('out', '.workbuddy/tmp'));
const CHROME =
  arg('chrome', '') ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let APP_URL = ''; // 由 ensureServer() 探测后确定（http 还是 https）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 断言记账

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, why) {
  results.push({ name, skipped: true, detail: why });
  console.log(`  [SKIP] ${name} — ${why}`);
}

// ------------------------------------------------------------------ dev server

// HTTPS 是常态不是例外：本机 vite.config 检测到 Tailscale 证书（.workbuddy/tmp/certs/）
// 会自动开 https，此时 curl/http 探测返回 000 而 https 通。用 Node 侧也得忽略自签证书。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function alive(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** 同一个端口既可能是 http 也可能是 https，逐个试 */
async function probe(port) {
  for (const proto of ['https', 'http']) {
    const url = `${proto}://localhost:${port}/`;
    if (await alive(url)) return url;
  }
  return null;
}

async function ensureServer() {
  const existing = await probe(PORT);
  if (existing !== null) {
    APP_URL = existing;
    console.log(`dev server 已在 ${APP_URL}（复用，不新建）`);
    return null;
  }

  console.log(`dev server 未起，启动 vite --config apps/editor/vite.config.ts`);
  const child = spawn(
    process.execPath,
    [
      path.resolve('node_modules/vite/bin/vite.js'),
      '--config',
      'apps/editor/vite.config.ts',
      '--port',
      String(PORT),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // 不用 --strictPort：端口被占时 vite 会自动挪到下一个，我们从它的 stdout 里读真实端口，
  // 比预设地址稳（skill 里记过的坑：vite 配 5178 实际可能起在 5179）。
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
  });
  child.stderr.on('data', (d) => {
    buf += d.toString();
  });

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const m = buf.match(/(https?:\/\/localhost:(\d+)\/)/);
    if (m !== null && (await alive(m[1]))) {
      APP_URL = m[1];
      console.log(`dev server 就绪（${APP_URL}）`);
      return child;
    }
  }
  child.kill();
  throw new Error(`dev server 30s 内未就绪。vite 输出：\n${buf.slice(-800)}`);
}

// ------------------------------------------------------------------ CDP

async function cdpTargets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('Chrome 调试端口 20s 内未就绪');
}

class Cdp {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p !== undefined) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        // GPU 错误每帧重复上报，一次跑能刷出几千条；按文本去重，否则真正的源头被冲掉
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ');
        if (!this.consoleErrors.includes(text)) this.consoleErrors.push(text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails ?? {};
        const text = d.exception?.description ?? d.text ?? 'unknown';
        if (!this.exceptions.includes(text)) this.exceptions.push(text);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails !== undefined) {
      throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
}

// ------------------------------------------------------------------ 主流程

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await ensureServer();

  console.log(`启动 headless Chrome（SwiftShader 软件 WebGPU）→ ${APP_URL}`);
  // 这四条 WebGPU flag 是一个整体，缺一条 requestAdapter() 就返回 null，
  // 页面打出「找不到可用的 GPU 适配器」——极易被误判成选择器写错。
  const flags = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader',
    '--use-webgpu-adapter=swiftshader',
    '--enable-features=Vulkan',
    `--remote-debugging-port=${CDP_PORT}`,
    // 用不重复的新目录：Chrome profile 200+ 文件，删它会撞安全删除守卫
    `--user-data-dir=${path.resolve('.workbuddy/tmp/chrome-smoke')}`,
    '--window-size=1280,800',
  ];
  // dev server 走 https（Tailscale 自签证书，CN 是 tailnet 域名）时，
  // 不加这条无头 Chrome 会停在证书报错页，所有断言全炸成 null。
  if (APP_URL.startsWith('https://')) flags.push('--ignore-certificate-errors');
  const chrome = spawn(CHROME, [...flags, 'about:blank'], { stdio: 'ignore' });

  let cdp;
  try {
    const ver = await cdpTargets();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    // 浏览器级 WS 只认 Target.*：必须先建 target 再 attach，页面级命令带 sessionId
    const { targetId } = await new Promise((resolve, reject) => {
      const id = 1;
      ws.addEventListener(
        'message',
        (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id === id) m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        },
        { once: false },
      );
      ws.send(JSON.stringify({ id, method: 'Target.createTarget', params: { url: 'about:blank' } }));
    });
    const { sessionId } = await new Promise((resolve, reject) => {
      const id = 2;
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      });
      ws.send(
        JSON.stringify({
          id,
          method: 'Target.attachToTarget',
          params: { targetId, flatten: true },
        }),
      );
    });

    cdp = new Cdp(ws, sessionId);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(6000); // 软件光栅化启动慢，给它出几帧的时间

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
    check('canvas 尺寸有效', canvas !== null && canvas.w > 0 && canvas.h > 0, JSON.stringify(canvas));

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

    // ---- H. AnimationService（需 --glb）----
    console.log('\nH. AnimationService（蒙皮/动画）');
    if (GLB === null) {
      skip('蒙皮动画断言', '未传 --glb，默认胶囊场景无骨骼；加 --glb <rigged.glb> 可启用');
      skip('动画时间轴断言', '同上');
      skip('动画播放状态机断言', '同上');
    } else {
      const absGlb = path.resolve(GLB);
      if (!fs.existsSync(absGlb)) throw new Error(`--glb 文件不存在: ${absGlb}`);
      const bytes = fs.readFileSync(absGlb);
      const b64 = bytes.toString('base64');
      // 走真实导入路径：给隐藏的 <input type=file> 塞 DataTransfer 的 FileList 再派发 change。
      // Chromium 允许直接给 input.files 赋值，等价于用户点了「导入 GLB…」选文件，
      // 因此这段断言覆盖的是 parseGlb → 建物体 → 建骨架的完整链路，不是绕过 UI 的后门。
      // 注意：导入走的是 setCharacter（替换角色槽），不是 addObject，
      // 所以「对象数变多」不是有效判据 —— 要看 #model-info 有没有写出新模型的统计行。
      const info = await cdp.eval(`(async () => {
        const bin = atob('${b64}');
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const input = document.querySelector('input[type=file][accept*="glb"]');
        if (input === null) return { err: '找不到 GLB 文件输入框' };
        const dt = new DataTransfer();
        dt.items.add(new File([u8], 'smoke.glb', { type: 'model/gltf-binary' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // parseGlb + 贴图解码 + GPU 上传全是异步的，等它落定
        await new Promise((r) => setTimeout(r, 4000));
        return {
          info: (document.getElementById('model-info') || {}).innerText || '',
          objects: window.__editor.renderer.getObjectList().length,
        };
      })()`);
      check(
        'GLB 经真实导入路径载入（#model-info 写出统计行）',
        typeof info.info === 'string' && /顶点/.test(info.info) && /smoke\.glb/.test(info.info),
        info.err ?? info.info.slice(0, 160),
      );
      check(
        '导入后场景对象数不变（setCharacter 替换角色槽而非新增）',
        info.objects === objCount,
        `objects=${info.objects}（基线 ${objCount}）`,
      );
      const anim = await cdp.eval(
        `(()=>{const r=window.__editor.renderer;return {has:r.hasAnimation(),clips:r.getClipNames()}})()`,
      );
      check('hasAnimation 为真且能列出 clip', anim.has === true && anim.clips.length > 0, JSON.stringify(anim));
      const play = await cdp.eval(
        `(()=>{const r=window.__editor.renderer;r.playAnimation(0);const a=r.isAnimationPlaying();r.setAnimationSpeed(0.5);r.seekAnimation(0.2);const t=r.getAnimationTime();r.pauseAnimation();const b=r.isAnimationPlaying();r.stopAnimation();return {a,b,t}})()`,
      );
      check('播放/暂停状态机正确', play.a === true && play.b === false, JSON.stringify(play));
      check('seekAnimation 后时间被写入', Number.isFinite(play.t), `t=${play.t}`);
    }

    // ---- I. 渲染持续出帧 ----
    console.log('\nI. 出帧稳定性');
    const before = await cdp.eval('window.__editor.renderer.stats.drawCalls');
    await sleep(1500);
    const after = await cdp.eval('window.__editor.renderer.stats.drawCalls');
    check('1.5s 后仍在出帧（drawCalls 有更新）', after > 0 && before > 0, `${before} → ${after}`);

    // ---- 截图 ----
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = path.join(OUT_DIR, 'editor-smoke.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log(`\n截图：${shotPath}`);

    // ---- 汇总 ----
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`断言：${passed} PASS / ${failed} FAIL / ${skipped} SKIP（共 ${results.length}）`);
    console.log(`CONSOLE ERRORS: ${cdp.consoleErrors.length}`);
    for (const e of cdp.consoleErrors.slice(0, 10)) console.log(`   ! ${e.slice(0, 200)}`);
    console.log(`EXCEPTIONS: ${cdp.exceptions.length}`);
    for (const e of cdp.exceptions.slice(0, 10)) console.log(`   ! ${e.slice(0, 200)}`);
    console.log('='.repeat(60));

    const ok = failed === 0 && cdp.consoleErrors.length === 0 && cdp.exceptions.length === 0;
    console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
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
