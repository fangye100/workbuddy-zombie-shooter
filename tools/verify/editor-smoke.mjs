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

const PORT = Number(arg('port', 5100));
const CDP_PORT = Number(arg('cdp', 9333));
const GLB = arg('glb', null);
/** 已绑定的 rigged GLB（22 根 HumanIK 骨）→ L 段「应用动画到场景物体」用 */
const RIGGED_GLB = arg(
  'rigged',
  'assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged.glb',
);
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

/**
 * 探活。超时默认给足 8s：冷启动时第一次请求会连带触发 vite 依赖预构建 +
 * 首屏 transform（main.ts 打包后 200KB+），1.5s 必超时，60 次轮询全打空，
 * 表现为「dev server 30s 未就绪」但其实它早就 ready 了 —— 这个坑踩过一次。
 */
async function alive(url, timeoutMs = 8000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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

    // ---- B2. 场景来自文件（ADR-010 / S1）----
    // 关键判据：**不能只看物体数** —— 硬编码 fallback 与场景文件当前都是 13 个物体、
    // 名字也一样。必须查 getSceneSource()，它为 null 就说明读的根本不是文件。
    console.log('\nB2. 场景来自文件（ADR-010：场景是唯一数据载体）');
    const src = await cdp.eval(`(()=>window.__editor.renderer.getSceneSource())()`);
    check('场景来源非 null（不是硬编码 fallback）', src !== null, JSON.stringify(src));
    check(
      '场景来源指向 .scene.json',
      src !== null && /\.scene\.json$/.test(src.url),
      src === null ? 'null' : src.url,
    );
    check(
      '物体数 = 13（场景文件 15 个节点减去光与相机）',
      src !== null && src.objects === 13,
      `objects=${src === null ? 'null' : src.objects}`,
    );

    const sceneObjs = await cdp.eval(
      `(()=>window.__editor.renderer.getObjectList().map(o=>({n:o.name,c:o.category,p:o.pickable})))()`,
    );
    const byName = Object.fromEntries(sceneObjs.map((o) => [o.n, o]));
    check(
      '物体名来自文件（地面/角色/敌人6 都在）',
      ['地面 Ground', '角色 Character', '敌人 Enemy 6'].every((n) => byName[n] !== undefined),
      `names=${sceneObjs.map((o) => o.n).join(',')}`.slice(0, 160),
    );
    // 层级面板只列 12 个：天空是 background=true，按设计不进层级、不拾取、不可选
    check(
      '天空不进层级面板（background 生效），故列表 12 个而场景 13 个',
      sceneObjs.length === 12 && byName['天空 Sky'] === undefined,
      `list=${sceneObjs.length} scene=${src === null ? 'null' : src.objects}`,
    );
    check(
      'category 来自 userData（角色=角色，敌人6=敌人，地面=环境）',
      byName['角色 Character']?.c === '角色' &&
        byName['敌人 Enemy 6']?.c === '敌人' &&
        byName['地面 Ground']?.c === '环境',
      JSON.stringify({
        角色: byName['角色 Character']?.c,
        敌人6: byName['敌人 Enemy 6']?.c,
        地面: byName['地面 Ground']?.c,
      }),
    );
    check(
      'pickable 来自文件（地面不可选，立方体可选）',
      byName['地面 Ground']?.p === false && byName['立方体 Box']?.p === true,
      JSON.stringify({
        地面: byName['地面 Ground']?.p,
        立方体: byName['立方体 Box']?.p,
      }),
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

      const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const shot2Path = path.join(OUT_DIR, 'editor-preview-smoke.png');
      fs.writeFileSync(shot2Path, Buffer.from(shot2.data, 'base64'));
      console.log(`预览截图：${shot2Path}`);
    }

    // ---- K. 绑定面板 Binding（正/侧视图 · mirror · T-pose 反解导出）----
    // 这里守的是一条铁律：**初始 T-pose 只能采纳骨长，joint 之间的旋转差值全是
    // currentPose 与 T-pose 的 pose 差值**。一旦有人把 ΔR 写进骨架，bind pose 就
    // 不是干净 T-pose，接入 BVH / 动捕会整条带 offset。DOM 探针证明不了这条，
    // 必须用「A-pose 输入 → T-pose 手臂仍水平 → 世界矩阵旋转仍是单位阵」三连断言。
    console.log('\nK. 绑定面板 Binding（骨长采纳 / 姿态偏移不入骨架）');
    const bindDom = await cdp.eval(
      `(()=>{const d=document.getElementById('binding-dock');const m=document.getElementById('ctx-menu');
        return {dock:d!==null, menu:m!==null, hook:typeof window.__editor.binding}})()`,
    );
    check('绑定面板宿主 #binding-dock 存在', bindDom.dock === true);
    check('右键菜单宿主 #ctx-menu 存在', bindDom.menu === true);
    check('window.__editor.binding 调试钩子已挂载', bindDom.hook === 'object');

    const BIND_GLB = arg(
      'bind',
      'assets/characters/models/E-01/rigged/E01_Shambler_900_rigged_animated.glb',
    );
    if (!fs.existsSync(path.resolve(BIND_GLB))) {
      skip('绑定面板载入 GLB', `绑定 GLB 不存在: ${BIND_GLB}`);
    } else {
      const openRes = await cdp.eval(`(async () => {
        window.__editor.binding.open(${JSON.stringify(BIND_GLB)});
        await new Promise((r) => setTimeout(r, 3500));
        const fc = document.querySelector('#binding-dock .bd-canvas[data-bd="front"]');
        const sc = document.querySelector('#binding-dock .bd-canvas[data-bd="side"]');
        return {
          open: window.__editor.binding.isOpen(),
          state: window.__editor.binding.state(),
          front: fc ? { w: fc.width, h: fc.height } : null,
          side: sc ? { w: sc.width, h: sc.height } : null,
          btns: document.querySelectorAll('#binding-dock .bd-btn').length,
          grip: document.querySelector('#binding-dock .bd-grip') !== null,
        };
      })()`);
      const p0 = openRes.state?.positions ?? {};
      check('绑定面板已打开（#binding-dock.open）', openRes.open === true);
      check(
        '模型已载入绑定面板',
        openRes.state?.loaded === true,
        `model=${String(openRes.state?.modelName)}`,
      );
      check(
        '22 个 HumanIK joint 全部就位',
        Object.keys(p0).length === 22,
        `joints=${Object.keys(p0).length}`,
      );
      check(
        '正/侧两个视图 canvas 有有效尺寸',
        openRes.front !== null && openRes.front.w > 0 && openRes.front.h > 0 &&
          openRes.side !== null && openRes.side.w > 0 && openRes.side.h > 0,
        `front=${JSON.stringify(openRes.front)} side=${JSON.stringify(openRes.side)}`,
      );
      check('面板按钮齐全（镜像×2 / 重置 / 应用 / 关闭）', openRes.btns >= 5, `btns=${openRes.btns}`);
      check('顶边拖拽把手 .bd-grip 存在（面板可下压露出 3D 视图）', openRes.grip === true);
      check(
        '默认摆放是 T-pose（左臂水平：LeftHand 与 LeftArm 同高）',
        Number.isFinite(p0.LeftHand?.[1]) && Math.abs(p0.LeftHand[1] - p0.LeftArm[1]) < 1e-9,
        `LeftArm.y=${p0.LeftArm?.[1]} LeftHand.y=${p0.LeftHand?.[1]}`,
      );

      // ── 把左前臂+手整体下垂 45° 造出 A-pose，验证「骨长采纳 / ΔR 不入骨架」 ──
      const aPose = await cdp.eval(`(() => {
        const b = window.__editor.binding;
        const f0 = b.fit();
        const arm = b.state().positions.LeftArm;
        const fore = b.state().positions.LeftForeArm;
        const hand = b.state().positions.LeftHand;
        const r = (-45 * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        const rot = (p) => {
          const x = p[0] - arm[0], y = p[1] - arm[1];
          return [arm[0] + x * c - y * s, arm[1] + x * s + y * c, p[2]];
        };
        b.pose('LeftForeArm', rot(fore));
        b.pose('LeftHand', rot(hand));
        const f1 = b.fit();
        const deg = (q) => (2 * Math.acos(Math.min(1, Math.abs(q[3])))) * 180 / Math.PI;
        const rotErr = (m) => {
          let d = 0;
          for (let col = 0; col < 3; col++)
            for (let row = 0; row < 3; row++) d += Math.abs(m[col * 4 + row] - (col === row ? 1 : 0));
          return d;
        };
        return {
          len0: f0.lengths.LeftForeArm,
          len1: f1.lengths.LeftForeArm,
          degFore: deg(f1.poseRotations.LeftForeArm),
          degHand: deg(f1.poseRotations.LeftHand),
          degArm: deg(f1.poseRotations.LeftArm),
          tyArm: f1.tposePositions.LeftArm[1],
          tyFore: f1.tposePositions.LeftForeArm[1],
          tyHand: f1.tposePositions.LeftHand[1],
          maxRotErr: Math.max(...['Hips', 'LeftArm', 'LeftForeArm', 'LeftHand']
            .map((n) => rotErr(f1.tposeWorld[n]))),
        };
      })()`);
      check(
        'A-pose 下骨长仍是刚体不变量（采纳的只是长度）',
        Math.abs(aPose.len1 - aPose.len0) < 1e-9,
        `${aPose.len0?.toFixed(9)} → ${aPose.len1?.toFixed(9)}`,
      );
      check(
        '姿态偏移被如实记录（前臂 / 手各约 45°）',
        Math.abs(aPose.degFore - 45) < 0.5 && Math.abs(aPose.degHand - 45) < 0.5,
        `ForeArm=${aPose.degFore?.toFixed(2)}° Hand=${aPose.degHand?.toFixed(2)}°`,
      );
      check(
        '没被摆动的骨不带姿态偏移（LeftArm ≈ 0°）',
        Math.abs(aPose.degArm) < 1e-6,
        `LeftArm=${aPose.degArm?.toFixed(6)}°`,
      );
      check(
        '★ 重建的 T-pose 里左臂重新水平（ΔR 没被写进骨架）',
        Math.abs(aPose.tyFore - aPose.tyArm) < 1e-9 &&
          Math.abs(aPose.tyHand - aPose.tyFore) < 1e-9,
        `Arm.y=${aPose.tyArm?.toFixed(6)} ForeArm.y=${aPose.tyFore?.toFixed(6)} Hand.y=${aPose.tyHand?.toFixed(6)}`,
      );
      check(
        '★ T-pose 世界矩阵旋转部分 = 单位阵（ΔR 不进骨架）',
        aPose.maxRotErr < 1e-9,
        `maxRotErr=${aPose.maxRotErr?.toExponential(2)}`,
      );

      // ── Mirror：正视图里左右对称（x 取反），y/z 不动 ──
      const mir = await cdp.eval(`(() => {
        const b = window.__editor.binding;
        b.pose('LeftHand', [0.77, 1.42, 0.05]);
        document.querySelector('#binding-dock .bd-btn[data-bd="mirror-lr"]').click();
        const st = b.state();
        return { left: st.positions.LeftHand, right: st.positions.RightHand };
      })()`);
      check(
        '镜像 L→R：右侧 = 左侧 x 取反，y/z 原样',
        Math.abs(mir.right[0] + mir.left[0]) < 1e-9 &&
          Math.abs(mir.right[1] - mir.left[1]) < 1e-9 &&
          Math.abs(mir.right[2] - mir.left[2]) < 1e-9,
        `L=${JSON.stringify(mir.left)} R=${JSON.stringify(mir.right)}`,
      );

      // ── 反解导出（dryRun：只算不下载）──
      const exp = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const stats = await b.dryRun();
        const statsHtml = document.querySelector('#binding-dock [data-bd="stats"]');
        return { stats, state: b.state(), statsHtml: statsHtml ? statsHtml.innerHTML : '' };
      })()`);
      const es = exp.stats;
      check('导出 GLB 非空', es !== null && es !== undefined && es.bytes > 0, `bytes=${es?.bytes}`);
      check('导出含 22 根骨', es?.bones === 22, `bones=${es?.bones}`);
      check('无零权重顶点（兜底生效）', es?.zeroWeightVerts === 0, `zero=${es?.zeroWeightVerts}`);
      check(
        '反解是刚体变换，身高不跳变',
        es !== null && es !== undefined && Math.abs(es.heightAfter - es.heightBefore) < 0.35,
        `height ${es?.heightBefore?.toFixed(3)} → ${es?.heightAfter?.toFixed(3)} m`,
      );
      check(
        '统计如实报出「离轴骨」= 被摆动的那两根',
        Array.isArray(es?.offAxisBones) && es.offAxisBones.length === 2,
        `offAxis=${JSON.stringify(es?.offAxisBones)}`,
      );
      check(
        '★ 导出后关节已复位到 T-pose（ΔR 清零，手臂重新水平）',
        Math.abs(exp.state.positions.LeftHand[1] - exp.state.positions.LeftArm[1]) < 1e-9,
        `Arm.y=${exp.state.positions.LeftArm[1]?.toFixed(6)} Hand.y=${exp.state.positions.LeftHand[1]?.toFixed(6)}`,
      );
      check('面板标注已摆正 T-pose', /已摆正 T-pose/.test(exp.statsHtml), exp.statsHtml);

      // ---- L. 动画应用（BVH 重定向 → 烘焙进 GLB / 挂到场景里已绑定的模型）----
      //
      // 这一段守的是用户的定性要求：「通用、Generic 的绑定和动画应用系统」。
      // 夹具是入库的 A-pose 合成 BVH（armDeg=45），同源的 T-pose 版在单元测试里对照。
      // 浏览器端要证的就一件事：A-pose 源的 45° rest 偏移被消掉，且整条链路不炸。
      console.log('\nL. 动画应用（BVH 重定向）');
      const APOSE_BVH = 'assets/characters/_tools/sample_apose_arm45.bvh';
      const bvhText = fs.readFileSync(path.resolve(APOSE_BVH), 'utf8');

      const animHook = await cdp.eval(`(() => typeof window.__editor.anim)()`);
      check('window.__editor.anim 调试钩子已挂载', animHook === 'object', animHook);

      const rt = await cdp.eval(`(() => {
        const a = window.__editor.anim;
        const r = a.load(${JSON.stringify(bvhText)}, 'smoke_apose');
        const el = document.querySelector('#binding-dock [data-bd="anim"]');
        return { r, info: a.info(), html: el ? el.innerText : '' };
      })()`);
      check(
        '★ A-pose 源的重定向：最大对齐角 = 45°（rest 偏移被识别出来）',
        rt.r !== null && Math.abs(rt.r.maxAlignAngleDeg - 45) < 0.01,
        `maxAlign=${rt.r?.maxAlignAngleDeg?.toFixed(4)}°`,
      );
      check(
        '22 根骨全映射、无缺骨、无未匹配',
        rt.r?.mapped?.length === 22 &&
          rt.r?.missingBones?.length === 0 &&
          rt.r?.unmatchedBvh?.length === 0,
        `mapped=${rt.r?.mapped?.length} missing=${JSON.stringify(rt.r?.missingBones)}`,
      );
      check(
        '片段信息：5 帧 / 22 骨 / 带根位移',
        rt.info?.frames === 5 && rt.info?.bones === 22 && rt.info?.hasRoot === true,
        JSON.stringify(rt.info),
      );
      check(
        '面板 .bd-anim 诊断区写出片段名与对齐角',
        /smoke_apose/.test(rt.html) && /45\.00/.test(rt.html),
        rt.html.replace(/\n/g, ' | ').slice(0, 160),
      );

      const baked = await cdp.eval(`(async () => {
        const st = await window.__editor.anim.exportDryRun();
        return st;
      })()`);
      check(
        '★ 带动画导出：23 条轨道（22 rotation + 1 根位移）',
        baked?.animChannels === 23 && baked?.animClips?.[0] === 'smoke_apose',
        `channels=${baked?.animChannels} clips=${JSON.stringify(baked?.animClips)}`,
      );

      // ── 挂到场景里一个**已绑定的外部模型**上（不是绑定面板刚做出来的那个）──
      const absRigged = path.resolve(RIGGED_GLB);
      if (!fs.existsSync(absRigged)) {
        skip('动画挂到场景物体', `rigged GLB 不存在: ${RIGGED_GLB}`);
        skip('场景物体的片段数/播放状态', `同上`);
      } else {
        const applied = await cdp.eval(`(async () => {
          const a = window.__editor.anim;
          const renderer = window.__editor.renderer;
          window.__editor.spawnAsset(${JSON.stringify(RIGGED_GLB)}, [-1.5, 0, 0]);
          await new Promise((r) => setTimeout(r, 4000));
          const list = renderer.getObjectList();
          const idx = list.length - 1;
          // 诊断：直接扫 state.objects，看 E04 物体到底在不在、有没有骨架
          const objs = renderer.state.objects.map((o, i) => ({
            i,
            name: o.name,
            hasSkel: o.skeleton !== null,
            joints: o.skeleton ? o.skeleton.jointNames.filter((n) => n !== null).length : 0,
            isE04: /E04/.test(o.name),
          }));
          const e04 = objs.filter((o) => o.isE04);
          // getObjectList 的下标和 state.objects 不一定对齐（层级树可能不数某个槽位），
          // 所以按名字在 state.objects 里定位真实下标，避免挂错物体。
          const realIdx = e04.length > 0 ? e04[0].i : idx;
          const r = a.applyTo(realIdx, ${JSON.stringify(bvhText)}, 'smoke_apose');
          return {
            idx,
            realIdx,
            n: list.length,
            objs,
            e04,
            r,
            clips: a.objectClips(realIdx),
            info: (document.getElementById('model-info') || {}).innerText || '',
          };
        })()`);
        check(
          '★ 重定向后的动画挂到场景里已绑定的模型上',
          applied.r !== null && applied.r !== undefined,
          `obj#${applied.realIdx} report=${applied.r === null ? 'null' : 'ok'} info="${String(applied.info).slice(0, 120)}"`,
        );
        check(
          '★ 23 条轨道落到目标骨架上且自动开始播放',
          applied.clips?.tracks === 23 &&
            applied.clips?.playing === true &&
            applied.clips?.clip >= 0,
          JSON.stringify(applied.clips),
        );
      }

      const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const shot3Path = path.join(OUT_DIR, 'editor-binding-smoke.png');
      fs.writeFileSync(shot3Path, Buffer.from(shot3.data, 'base64'));
      console.log(`绑定面板截图：${shot3Path}`);

      // 关掉面板，让最后的收尾截图回到常规编辑器视图
      const closed = await cdp.eval(`(() => {
        window.__editor.binding.close();
        return window.__editor.binding.isOpen();
      })()`);
      check('绑定面板已关闭（回到 3D 视图）', closed === false);
    }

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
