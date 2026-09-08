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
import https from 'node:https';
import http from 'node:http';

/** 用原生 http/https 探活：自签 HTTPS 证书下 fetch(undici) 会因 TLS 握手挂起，
 *  必须显式 rejectUnauthorized:false 才能稳定拿到 200。 */
function aliveRaw(url, timeoutMs = 8000) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(
      url,
      { rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
async function alive(url, timeoutMs = 8000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    // fetch 在自签证书下会抛错 → 退回原生 http/https（忽略证书）
    return aliveRaw(url, timeoutMs);
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

  // vite 往 pipe 写带 ANSI 颜色码（\x1b[1m / \x1b[36m），会把 `localhost:5188/`
  // 拆成 `localhost:\x1b[1m5188\x1b[22m/`，正则匹配不到 → 误判「30s 未就绪」。
  // 匹配前先剥离 ANSI 转义序列。
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const m = stripAnsi(buf).match(/(https?:\/\/localhost:(\d+)\/)/);
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

  // 本沙箱 headless + SwiftShader 起不来 CDP（Chrome 进程直接退出，日志为空），
  // 但 headed + 真实 GPU 可以（见 cdp-verify.mjs）。用 --headed 切到 headed，
  // 默认仍 headless（CI 无显示器场景）。两者都靠真实/软件 WebGPU，断言逻辑不变。
  const HEADED = has('headed');
  console.log(`启动 ${HEADED ? 'headed' : 'headless'} Chrome（WebGPU）→ ${APP_URL}`);
  // 这四条 WebGPU flag 是一个整体，缺一条 requestAdapter() 就返回 null，
  // 页面打出「找不到可用的 GPU 适配器」——极易被误判成选择器写错。
  const flags = [
    '--enable-unsafe-webgpu',
    `--remote-debugging-port=${CDP_PORT}`,
    // 与 cdp-verify 复用同一份可用 profile 目录（本沙箱里 --no-sandbox 反而让
    // Chrome 起不来 CDP，去掉后 headed + 真实 GPU 才能连上）
    `--user-data-dir=${path.resolve('.workbuddy/tmp/chrome-profile')}`,
    '--window-size=1280,800',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (HEADED) {
    // headed + 真实 GPU：不需要 SwiftShader / Vulkan 软件回退
  } else {
    flags.unshift('--headless=new');
    flags.push(
      '--enable-unsafe-swiftshader',
      '--use-webgpu-adapter=swiftshader',
      '--enable-features=Vulkan',
    );
  }
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
      'category 来自正式字段（S2a 转正；角色=角色，敌人6=敌人，地面=环境）',
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
        '27 个 HumanIK joint 全部就位（22 骨干 + 5 tip）',
        Object.keys(p0).length === 27,
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

      // UI/UX 重分组（docs/15 §3.1–3.6）：头部按语义分组、破坏性操作降级、
      // 半径双输入、帮助折叠、产出状态常驻徽标。DOM 结构断言，防止以后又被摊平。
      const uxRes = await cdp.eval(`(() => {
        const dock = document.getElementById('binding-dock');
        const groups = [...dock.querySelectorAll('.bd-head-group')];
        const badge = dock.querySelector('[data-bd="export-badge"]');
        const tip = dock.querySelector('[data-bd="tip"]');
        return {
          groups: groups.map((e) => e.getAttribute('data-group')),
          labelled: groups.filter((e) => e.querySelector('.bd-glabel') !== null).length,
          headViewportToggle: dock.querySelector('.bd-head [data-bd="skin-view3d"]') !== null,
          subViewportToggle: dock.querySelector('.bd-skin [data-bd="skin-view3d"]') !== null,
          radiusNums: dock.querySelectorAll('[data-bd="r-top-n"],[data-bd="r-medium-n"],[data-bd="r-bottom-n"]').length,
          danger: [...dock.querySelectorAll('.bd-btn.danger')].map((e) => e.getAttribute('data-bd')),
          tipHidden: tip === null ? null : tip.hidden,
          badge: badge === null ? null : { hidden: badge.hidden, text: badge.textContent.trim(), cls: badge.className },
        };
      })()`);
      check(
        '头部按语义分 5 组（编辑/镜像/姿态/产出/保存）',
        JSON.stringify(uxRes.groups) === JSON.stringify(['编辑', '镜像', '姿态', '产出', '保存']),
        `groups=${JSON.stringify(uxRes.groups)}`,
      );
      check('每个分组都有文字标签', uxRes.labelled === uxRes.groups.length, `labelled=${uxRes.labelled}/${uxRes.groups.length}`);
      check(
        '破坏性操作降级为 danger 次要样式（重置 / Detach）',
        JSON.stringify(uxRes.danger) === JSON.stringify(['reset', 'detach']),
        `danger=${JSON.stringify(uxRes.danger)}`,
      );
      check('「在 3D 视图显示包裹器」已提到头部（不再埋在 Skin 子面板）',
        uxRes.headViewportToggle === true && uxRes.subViewportToggle === false,
        `head=${uxRes.headViewportToggle} sub=${uxRes.subViewportToggle}`);
      check('半径三段都有数字输入框（滑块 + 数字框双向同步）', uxRes.radiusNums === 3, `nums=${uxRes.radiusNums}`);
      check('操作说明默认收起（不再 10 行常驻）', uxRes.tipHidden === true, `hidden=${uxRes.tipHidden}`);
      check(
        '载入后产出状态徽标常驻显示「● 未导出」',
        uxRes.badge !== null && uxRes.badge.hidden === false && uxRes.badge.text === '● 未导出',
        `badge=${JSON.stringify(uxRes.badge)}`,
      );

      // 头部「?」能展开/收起说明
      const helpRes = await cdp.eval(`(() => {
        const dock = document.getElementById('binding-dock');
        const btn = dock.querySelector('[data-bd="help"]');
        const tip = dock.querySelector('[data-bd="tip"]');
        btn.click();
        const afterOpen = tip.hidden;
        btn.click();
        return { afterOpen, afterClose: tip.hidden, aria: btn.getAttribute('aria-expanded') };
      })()`);
      check('头部「?」可展开操作说明', helpRes.afterOpen === false, `hidden=${helpRes.afterOpen}`);
      check('头部「?」可再次收起', helpRes.afterClose === true, `hidden=${helpRes.afterClose}`);
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
        // tip 必须跟着手一起转：它是 LeftHand 的子骨，不转就成了「手腕转了、指尖没转」
        const handTip = b.state().positions.LeftHandTip;
        const r = (-45 * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        const rot = (p) => {
          const x = p[0] - arm[0], y = p[1] - arm[1];
          return [arm[0] + x * c - y * s, arm[1] + x * s + y * c, p[2]];
        };
        b.pose('LeftForeArm', rot(fore));
        b.pose('LeftHand', rot(hand));
        b.pose('LeftHandTip', rot(handTip));
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
        // 手尖保持标准骨向（+X 0.10）：末端不跟着走就会被报成「离轴骨」
        b.pose('LeftHandTip', [0.87, 1.42, 0.05]);
        document.querySelector('#binding-dock .bd-btn[data-bd="mirror-lr"]').click();
        const st = b.state();
        return {
          left: st.positions.LeftHand,
          right: st.positions.RightHand,
          leftTip: st.positions.LeftHandTip,
          rightTip: st.positions.RightHandTip,
        };
      })()`);
      check(
        '镜像 L→R：右侧 = 左侧 x 取反，y/z 原样（tip 也一起镜像）',
        Math.abs(mir.right[0] + mir.left[0]) < 1e-9 &&
          Math.abs(mir.right[1] - mir.left[1]) < 1e-9 &&
          Math.abs(mir.right[2] - mir.left[2]) < 1e-9 &&
          Math.abs(mir.rightTip[0] + mir.leftTip[0]) < 1e-9 &&
          Math.abs(mir.rightTip[1] - mir.leftTip[1]) < 1e-9,
        `L=${JSON.stringify(mir.left)} R=${JSON.stringify(mir.right)} ` +
          `LTip=${JSON.stringify(mir.leftTip)} RTip=${JSON.stringify(mir.rightTip)}`,
      );

      // ── 镜像必须连 Skin Wrapper 半径一起翻（之前「skin wrapper 没法镜像」的真因）──
      const mirCyl = await cdp.eval(`(() => {
        const c = window.__editor.binding.wrappers.cylinders();
        return { l: c.LeftHand.radii, r: c.RightHand.radii };
      })()`);
      const rEq = (a, b) =>
        Math.abs(a.top - b.top) < 1e-9 &&
        Math.abs(a.medium - b.medium) < 1e-9 &&
        Math.abs(a.bottom - b.bottom) < 1e-9;
      check(
        '镜像 L→R：Skin Wrapper 半径一并镜像（RightHand 半径 == LeftHand）',
        rEq(mirCyl.l, mirCyl.r),
        `L=${JSON.stringify(mirCyl.l)} R=${JSON.stringify(mirCyl.r)}`,
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
      check('导出含 27 根骨', es?.bones === 27, `bones=${es?.bones}`);
      check('无零权重顶点（兜底生效）', es?.zeroWeightVerts === 0, `zero=${es?.zeroWeightVerts}`);
      // 末端可控的关键证据：Head / Hand / ToeBase 原本是叶子（胶囊退化成点），
      // 加了 tip 之后它们的胶囊才拿到长度 —— 断言这三个骨长 > 0。
      const tips = await cdp.eval(`(() => {
        const st = window.__editor.binding.state();
        const p = st && st.positions;
        if (!p) return null;
        const d = (a, b) => Math.hypot(p[b][0]-p[a][0], p[b][1]-p[a][1], p[b][2]-p[a][2]);
        return {
          hasTips: ['HeadTip','LeftHandTip','RightHandTip','LeftToeTip','RightToeTip']
            .every(n => !!p[n]),
          headLen: +d('Head','HeadTip').toFixed(4),
          handLen: +d('LeftHand','LeftHandTip').toFixed(4),
          toeLen: +d('LeftToeBase','LeftToeTip').toFixed(4),
          handTipIsLeafBeyondHand:
            Math.abs(p['LeftHandTip'][1] - p['LeftHand'][1]) < 0.35,
        };
      })()`);
      check('★ 5 个 tip 节点都在骨架里', tips?.hasTips === true, JSON.stringify(tips));
      check(
        '★ tip 让末端骨段拿到长度（Head→HeadTip / Hand→HandTip / ToeBase→ToeTip 均 > 0）',
        tips !== null && tips.headLen > 0 && tips.handLen > 0 && tips.toeLen > 0,
        `head=${tips?.headLen} hand=${tips?.handLen} toe=${tips?.toeLen}`,
      );
      // 「tip 不参与 skin 计算」的硬证据：导出的权重里 tip 总权重必须为 0
      check(
        '★ tip 权重恒为 0（不参与 skin 计算）',
        es?.tipWeightSum === 0 && es?.tipRefVerts === 0,
        `tipWeightSum=${es?.tipWeightSum} tipRefVerts=${es?.tipRefVerts}`,
      );
      // 「tip 权重恒 0」与「半径表无 tip」分别在 L2 / L2d 段断言
      // （那里已经切到蒙皮模式，半径表才初始化出来）。
      check(
        '反解是刚体变换，身高不跳变',
        es !== null && es !== undefined && Math.abs(es.heightAfter - es.heightBefore) < 0.35,
        `height ${es?.heightBefore?.toFixed(3)} → ${es?.heightAfter?.toFixed(3)} m`,
      );
      check(
        '统计如实报出「离轴骨」= 被摆动的那两根（tip 已随手走，不该再报）',
        Array.isArray(es?.offAxisBones) && es.offAxisBones.length === 2,
        `offAxis=${JSON.stringify(es?.offAxisBones)}`,
      );
      // 「绑定是动词」铁律：导出只回灌**网格**，骨架姿势原地不动，绝不跳回 T-pose。
      // ΔR 清零看的是导出出去的那份骨架（fit.tposePositions），
      // 上面「★ 重建的 T-pose 里左臂重新水平」已经断言过，这里守的是姿势不被改写。
      check(
        '★ 导出后摆放姿势原地不动（绑完骨架姿势即定，绝不跳回 T-pose）',
        Math.abs(exp.state.positions.LeftHand[1] - mir.left[1]) < 1e-9 &&
          Math.abs(exp.state.positions.LeftHandTip[1] - mir.left[1]) < 1e-9,
        `Hand.y=${exp.state.positions.LeftHand[1]?.toFixed(6)} ` +
          `Tip.y=${exp.state.positions.LeftHandTip[1]?.toFixed(6)}（应保持摆放值 ${mir.left[1]}）`,
      );
      check(
        '面板统计区仍是当前模型（导出流程没把它清空）',
        /顶点/.test(exp.statsHtml) && /面/.test(exp.statsHtml),
        exp.statsHtml,
      );

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

      // ---- L2. Skin Wrapper 包裹器圆柱体在主 3D 视口可见 ----
      //
      // 守的是用户的定性要求：「模型每个 joint 上应当显示一个圆柱形状的皮肤权重包裹器」。
      // 几何由 binding 模块按**实时关节矩阵**算，再交给引擎的半透明 X-ray 管线画。
      // 这里要证的是渲染链路真的通 —— WGSL 编译错误 / usage 错配只在运行时暴露，
      // tsc 与 vite build 全绿也查不出来。
      console.log('\nL2. Skin Wrapper 圆柱体（主 3D 视口）');
      // 先切到「蒙皮包裹」模式：每 joint 的默认 wrapper 半径表是**惰性**初始化的，
      // 未进 skin 模式时 getCylinders() 为 null，3D 视口退回「骨长×0.35」默认半径。
      // 这里显式切模式，才能验证「面板半径 → 3D 几何」这条链路而不仅是默认值。
      const skinMode = await cdp.eval(`(() => {
        const b = document.querySelector('[data-bd="mode-skin"]');
        if (b) b.click();
        return !!b;
      })()`);
      check('可切到「蒙皮包裹 skin」编辑模式', skinMode === true);

      const wrapOn = await cdp.eval(`(() => window.__editor.binding.wrappers.set(true))()`);
      check('3D 视口包裹器开关可打开', wrapOn === true, `set→${wrapOn}`);
      await sleep(600); // 让几帧真正画过去（含圆柱体管线）
      const wrap = await cdp.eval(`(() => ({
        on: window.__editor.binding.wrappers.get(),
        verts: window.__editor.binding.wrappers.verts(),
        cyls: Object.keys(window.__editor.binding.wrappers.cylinders() || {}).length,
      }))()`);
      check(
        '★ 圆柱体几何已产出并送进管线（顶点数 > 0）',
        wrap.verts > 0,
        JSON.stringify(wrap),
      );
      check(
        '★ 顶点数是 stride 9 的整数倍（pos+nrm+col 交错，stride 36B）',
        wrap.verts > 0 && wrap.verts % 9 === 0,
        `verts=${wrap.verts}`,
      );
      check('包裹器半径表非空（每 joint 一个 wrapper）', wrap.cyls > 0, `cyls=${wrap.cyls}`);

      // ---- L2d. tip（尖端）骨的三条硬约束 ----
      //
      // tip 存在的意义：Head / Hand / ToeBase 原本是叶子，影响胶囊退化成点 → 末端
      // 外形与旋转无法控制。补上 tip 后它们的胶囊才拿到长度。但 tip 自己必须满足：
      //   ① 不产生 wrapper mesh / skin wrapper；② 不参与 skin 计算。
      // 这里断言的正是「该有的有、不该有的没有」。
      console.log('\nL2d. tip（尖端）骨约束');
      const tipWrap = await cdp.eval(`(() => {
        const c = window.__editor.binding.wrappers.cylinders() || {};
        return {
          total: Object.keys(c).length,
          tipKeys: Object.keys(c).filter((k) => /Tip$/.test(k)),
        };
      })()`);
      check(
        '★ 半径表里没有 tip（不产生 skin wrapper）',
        tipWrap.tipKeys.length === 0,
        `total=${tipWrap.total} tipKeys=${JSON.stringify(tipWrap.tipKeys)}`,
      );
      check(
        '★ 22 骨干各有 wrapper（tip 只是让它们拿到长度，不是替换）',
        tipWrap.total === 22,
        `total=${tipWrap.total}`,
      );

      // ---- L2e. 改半径 → 几何必须真的变（「拖了滑块没反应」的回归闸门）----
      //
      // 顶点数看不出半径变化（改半径不增不减顶点），所以判据是几何指纹
      // `sum`（顶点坐标绝对值之和）：圆柱一粗一细它就得动。
      // 主 3D 视口与面板正/侧视两条路径都要验 —— 它们用不同的输入
      // （实时关节矩阵 vs boneSegments），一条通了不代表另一条通。
      console.log('\nL2e. 改半径 → 几何真的变');
      const nFrames = (n) =>
        `new Promise((r) => { let k = 0; const step = () => (++k >= ${n} ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); })`;
      const rad = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const wait = () => ${nFrames(4)};
        const snap = () => ({ vp: b.wrappers.stats(), v3d: b.view3d() });
        const src = b.wrappers.cylinders().LeftArm;
        const orig = { ...src.radii };
        const set3 = (v) => ['top', 'medium', 'bottom'].forEach((s) => b.wrappers.setRadius('LeftArm', s, v));

        // 对照组：写入**同一个值**（半径没变，但 refresh() 照样跑一遍）
        // → 量出「刷新副作用」本身带来的几何漂移，真变化必须显著大于它
        const c0 = snap();
        set3(orig.top);
        await wait();
        const c1 = snap();

        const before = snap();
        const ok = ['top', 'medium', 'bottom']
          .every((s) => b.wrappers.setRadius('LeftArm', s, 0.55));
        await wait();
        const after = snap();
        // 还原，再验一次「改回去也得变回去」
        set3(orig.top);
        await wait();
        const restored = snap();
        return { ok, c0, c1, before, after, restored, orig };
      })()`);
      const sum = (s) => s?.vp?.sum ?? 0;
      const dCtrlVp = Math.abs(sum(rad.c1) - sum(rad.c0));
      const dVp = Math.abs(sum(rad.after) - sum(rad.before));
      const dFront = Math.abs((rad.after?.v3d?.frontCylSum ?? 0) - (rad.before?.v3d?.frontCylSum ?? 0));
      const dSide = Math.abs((rad.after?.v3d?.sideCylSum ?? 0) - (rad.before?.v3d?.sideCylSum ?? 0));
      const backVp = Math.abs(sum(rad.restored) - sum(rad.before));
      check(
        '★ 改半径真的写进半径表（setRadius 返回 true）',
        rad.ok === true,
        `ok=${rad.ok} orig=${JSON.stringify(rad.orig)}`,
      );
      console.log(
        `  诊断：对照组（写入同值）Δsum=${dCtrlVp.toFixed(4)} · 真改半径 Δsum=${dVp.toFixed(4)}` +
          ` · 主视口 sum ${sum(rad.before).toFixed(2)} → ${sum(rad.after).toFixed(2)}` +
          ` · verts ${rad.before?.vp?.verts} → ${rad.after?.vp?.verts}` +
          ` · bboxMin ${JSON.stringify(rad.before?.vp?.min)} → ${JSON.stringify(rad.after?.vp?.min)}` +
          ` · bboxMax ${JSON.stringify(rad.before?.vp?.max)} → ${JSON.stringify(rad.after?.vp?.max)}` +
          ` · first ${JSON.stringify(rad.before?.vp?.first)} → ${JSON.stringify(rad.after?.vp?.first)}`,
      );
      check(
        '★ 主 3D 视口：改半径后圆柱体几何变了（且远大于刷新副作用）',
        dVp > 1e-3 && dVp > dCtrlVp * 10,
        `Δsum=${dVp.toFixed(4)} vs 对照组 ${dCtrlVp.toFixed(4)}`,
      );
      check(
        '★ 面板正视：改半径后圆柱体几何变了',
        dFront > 1e-3,
        `Δsum=${dFront.toFixed(4)}（${rad.before?.v3d?.frontCylSum?.toFixed(2)} → ${rad.after?.v3d?.frontCylSum?.toFixed(2)}）`,
      );
      check(
        '★ 面板侧视：改半径后圆柱体几何变了',
        dSide > 1e-3,
        `Δsum=${dSide.toFixed(4)}（${rad.before?.v3d?.sideCylSum?.toFixed(2)} → ${rad.after?.v3d?.sideCylSum?.toFixed(2)}）`,
      );
      check(
        '★ 改回原值后几何回到基线（不是单向漂移）',
        backVp < 1e-6,
        `Δsum=${backVp.toExponential(2)}`,
      );

      // ---- L2g. 在视图里直接拖圆柱体 = 改半径（拖了要有反应） ----
      //
      // 蒙皮模式下 pointerdown 只做点选、拖动没有任何行为 —— 用户「在视图里调整
      // 这些圆柱体」却看不到变化，根因就在这。现在语义是：
      //   半径 = 指针到骨轴的垂距（米）
      // 这里用合成 PointerEvent 走真实的事件链（不是绕过 UI 直接调 API），
      // 才能同时证明「点得到」和「拖得动」。
      console.log('\nL2g. 视图里拖圆柱体 = 改半径');
      const drag = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const c = document.querySelector('[data-bd="front"]');
        const w = c.clientWidth, h = c.clientHeight;
        // ① 扫格子找「包裹器**边缘**」的点（不硬编码坐标，换模型也不会失效）。
        //
        //    ⚠️ 不能取第一个命中点就收工：命中判定用的是到**子段**的距离，
        //    骨端帽上方、贴着骨轴延长线的点也会命中，但它到骨轴的垂距可能只有
        //    2~3px，小于 rPx×0.45 → 被判成「抓核心 = 沿轴移动偏移」，改不了半径。
        //    本断言验的是「拖边缘 = 改半径」，所以取**垂距最大**的命中点。
        const axisCache = {};
        const axisOf = (bn) => {
          if (axisCache[bn] === undefined) axisCache[bn] = b.wrappers.axis(bn, 'front');
          return axisCache[bn];
        };
        const perpDist = (px, py, sg) => (sg === null ? -1
          : Math.abs((px - sg.a[0]) * (sg.b[1] - sg.a[1]) - (py - sg.a[1]) * (sg.b[0] - sg.a[0]))
            / (Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) || 1));
        let hit = null;
        let at = null;
        let bestDr = -1;
        for (let y = Math.round(h * 0.2); y < h * 0.8; y += 4) {
          for (let x = Math.round(w * 0.2); x < w * 0.8; x += 4) {
            const p = b.wrappers.pick('front', x, y);
            if (p === null) continue;
            const dr = perpDist(x, y, axisOf(p.bone));
            if (dr > bestDr) { bestDr = dr; hit = p; at = { x, y }; }
          }
        }
        if (hit === null) return { found: false };
        const before = { ...b.wrappers.cylinders()[hit.bone].radii };
        // ② 按下 → 沿**垂直于骨轴**的方向拖 60px → 松开。
        //    半径 = 指针到骨轴的垂距，沿轴方向拖垂距不变、半径**本就不该动**；
        //    Head 的骨轴在正视里恰好垂直，固定「向下 60px」会取到退化方向，
        //    于是看起来像「拖动没反应」，实际是断言拖错了方向。
        const seg = axisOf(hit.bone);
        let dx = 0;
        let dy = 60;
        if (seg !== null) {
          const ax = seg.b[0] - seg.a[0];
          const ay = seg.b[1] - seg.a[1];
          const L = Math.hypot(ax, ay) || 1;
          let nx = -ay / L;
          let ny = ax / L;
          // 朝**远离**骨轴的那一侧拖，保证垂距一定变大（半径 = 垂距）
          if ((at.x - seg.a[0]) * nx + (at.y - seg.a[1]) * ny < 0) { nx = -nx; ny = -ny; }
          dx = Math.round(nx * 60);
          dy = Math.round(ny * 60);
        }
        const cylOf = () => b.wrappers.cylinders()[hit.bone];
        const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
          clientX: c.getBoundingClientRect().left + x,
          clientY: c.getBoundingClientRect().top + y,
          bubbles: true, pointerId: 1, isPrimary: true,
        }));
        ev('pointerdown', at.x, at.y);
        ev('pointermove', at.x + dx, at.y + dy);
        await ${nFrames(2)};
        const after = { ...cylOf().radii };
        ev('pointerup', at.x + dx, at.y + dy);
        // ③ 还原，别把半径留在奇怪的值上
        for (const s of ['top', 'medium', 'bottom']) b.wrappers.setRadius(hit.bone, s, before[s]);
        return {
          found: true, hit, before, after, dir: { dx, dy },
          moved: Math.abs(after[hit.seg] - before[hit.seg]),
          hitDrPx: bestDr,
        };
      })()`);
      check(
        '★ 视图里能点中圆柱体子段（点选判定没坏）',
        drag.found === true,
        JSON.stringify(drag.hit ?? null),
      );
      check(
        '★ 在视图里拖圆柱体 = 改半径（拖动真的有反应）',
        drag.found === true && drag.moved > 0.01,
        `${drag.hit?.bone}.${drag.hit?.seg} ${drag.before?.[drag.hit?.seg]?.toFixed(3)} → ` +
          `${drag.after?.[drag.hit?.seg]?.toFixed(3)} · 拖动方向 ${JSON.stringify(drag.dir)} · ` +
          `off ${JSON.stringify(drag.offBefore)} → ${JSON.stringify(drag.offAfter)} · ` +
          `起点垂距 ${drag.hitDrPx?.toFixed(1)}px`,
      );
      check(
        '★ 只改点中的那一段，另两段不动',
        drag.found === true &&
          ['top', 'medium', 'bottom']
            .filter((s) => s !== drag.hit.seg)
            .every((s) => Math.abs(drag.after[s] - drag.before[s]) < 1e-9),
        JSON.stringify(drag.after ?? null),
      );

      // ---- L2h. 侧边栏滑块（真实 DOM 路径）→ 半径真的改，且不被自动算法覆盖 ----
      //
      // L2e / L2g 走的是自动化钩子与合成 pointer，**从没碰过那三个 range 滑块本身**。
      // 用户报的正是「在侧边栏拖 top / bottom 没反应」—— 只有走真实 DOM 事件链
      // （改 value + 派发 input）才能证明这条路径没断。
      //
      // 另一半是「自动算法 override 手动值」：拖 joint 会改骨长，而默认半径
      // r = clamp(骨长 × 0.35, 0.04, 0.22) 正是骨长的函数 —— 手动值一旦被它
      // 重算覆盖，表现就是「拖 joint 包裹器自己变大变小，手动调的却总是不见」。
      console.log('\nL2h. 侧边栏滑块 与「自动半径不覆盖手动值」');
      const sl = await cdp.eval(`(async () => {
        const b = window.__editor.binding;
        const wait = () => ${nFrames(4)};
        b.setMode('skin');
        await wait();
        // ① 在视图里点中一段，让侧边栏出现可编辑的圆柱体
        const c = document.querySelector('[data-bd="front"]');
        const w = c.clientWidth, h = c.clientHeight;
        let hit = null, at = null;
        for (let y = Math.round(h * 0.2); y < h * 0.8 && hit === null; y += 6) {
          for (let x = Math.round(w * 0.2); x < w * 0.8; x += 6) {
            const p = b.wrappers.pick('front', x, y);
            if (p !== null) { hit = p; at = { x, y }; break; }
          }
        }
        if (hit === null) return { found: false };
        const rect = c.getBoundingClientRect();
        const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
          clientX: rect.left + x, clientY: rect.top + y,
          bubbles: true, pointerId: 1, isPrimary: true,
        }));
        ev('pointerdown', at.x, at.y);
        ev('pointerup', at.x, at.y);
        await wait();

        // ② 真实 DOM 滑块路径：改 value + 派发 input
        const el = document.querySelector('#binding-dock [data-bd="r-top"]');
        if (el === null) return { found: true, noSlider: true, hit };
        const domBefore = el.value;
        const rBefore = { ...b.wrappers.cylinders()[hit.bone].radii };
        const v3Before = b.view3d();
        el.value = '0.3';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await wait();
        const domAfter = document.querySelector('#binding-dock [data-bd="r-top"]').value;
        const rAfter = { ...b.wrappers.cylinders()[hit.bone].radii };
        const v3After = b.view3d();

        // ③ 自动半径会不会覆盖手动值？拖 joint 改骨长（默认半径 r = 骨长×0.35
        //    正是骨长的函数），再看手动值还在不在
        const p0 = b.state().positions[hit.bone];
        b.pose(hit.bone, [p0[0] + 0.06, p0[1] + 0.06, p0[2]]);
        await wait();
        const rAfterDrag = { ...b.wrappers.cylinders()[hit.bone].radii };

        // ④ 模式往返（skin → skeleton → skin）后手动值还在不在
        b.setMode('skeleton');
        await wait();
        b.setMode('skin');
        await wait();
        const rAfterRoundTrip = { ...b.wrappers.cylinders()[hit.bone].radii };

        // ⑤ 关节模式下 3D 层也必须吃半径表（之前传 null → 回退成骨长×0.35 自动半径，
        //    正是「拖 joint 包裹器自己变大变小、侧边栏调的看不到」的根因）
        b.setMode('skeleton');
        await wait();
        const skBefore = b.view3d().frontCylSum;
        b.wrappers.setRadius(hit.bone, 'top', 0.45);
        await wait();
        const skAfter = b.view3d().frontCylSum;
        b.setMode('skin');
        await wait();
        const sknSum = b.view3d().frontCylSum;

        // ⑥ 自动适配（显式按钮）只碰未手动改过的骨：
        //    手动骨在 ⑤ 已被设成 top=0.45 且 manual=true；另取一根**非手动**骨
        //    RightArm，把其子骨 RightForeArm 大幅挪开使骨长变化，autofit 后它的半径
        //    必须等于公式值 clamp(骨长×0.35, 0.04, 0.22)；手动骨绝不被动。
        const other = 'RightArm';
        const otherChild = 'RightForeArm';
        const headTopBefore = b.wrappers.cylinders()[hit.bone].radii.top;
        const otherOrig = { ...b.wrappers.cylinders()[other].radii };
        const op = b.state().positions[otherChild];
        b.pose(otherChild, [op[0] + 0.3, op[1] + 0.3, op[2]]);
        await wait();
        const autoBtn = document.querySelector('#binding-dock [data-bd="cyl-autofit"]');
        const autoBtnFound = autoBtn !== null;
        const lfBefore = b.state().positions[otherChild];
        if (autoBtn !== null) autoBtn.click();
        // autofit 是同步写入：click() 返回前 this.cylinders 已原地改好（引用不变），
        // 立即读就是 autofit 的真实产出。去掉原本夹在 click 与读取之间的 await wait()，
        // 避免 4 帧等待引入的非确定性（渲染/帧回调不会写半径，无需等帧）。
        const oRadiiImmediate = b.wrappers.cylinders()[other].radii.top;
        const posImmediate = b.state().positions[otherChild];
        const oRadii = b.wrappers.cylinders()[other].radii;
        // 持久性：再等几帧，确认没有任何渲染/帧回调把半径写回默认值
        await wait();
        const oRadiiPersist = b.wrappers.cylinders()[other].radii.top;
        const oManual = b.wrappers.cylinders()[other].manual === true;
        const pa = b.state().positions[other];
        const pb = b.state().positions[otherChild];
        const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
        const expR = Math.min(0.22, Math.max(0.04, len * 0.35));
        const headTopAfter = b.wrappers.cylinders()[hit.bone].radii.top;

        // 还原（关节 + 手动骨 + 自动骨都回到测试前）
        b.pose(otherChild, op);
        b.pose(hit.bone, p0);
        for (const s of ['top', 'medium', 'bottom']) b.wrappers.setRadius(hit.bone, s, rBefore[s]);
        for (const s of ['top', 'medium', 'bottom']) b.wrappers.setRadius(other, s, otherOrig[s]);
        await wait();
        return {
          found: true, hit, domBefore, domAfter,
          rBefore, rAfter, rAfterDrag, rAfterRoundTrip,
          v3Before, v3After,
          spanText: document.querySelector('#binding-dock [data-bd="r-top-v"]').textContent,
          skBefore, skAfter, sknSum,
          oRadii, expR, headTopBefore, headTopAfter,
          autoBtnFound, oManual, lfBefore,
          oRadiiImmediate: (typeof oRadiiImmediate !== 'undefined') ? oRadiiImmediate : undefined,
          oRadiiPersist: (typeof oRadiiPersist !== 'undefined') ? oRadiiPersist : undefined,
          posImmediate: (typeof posImmediate !== 'undefined') ? posImmediate : undefined,
        };
      })()`);
      check(
        '★ 点中圆柱体后侧边栏滑块就位（可编辑）',
        sl.found === true && sl.noSlider !== true,
        JSON.stringify({ hit: sl.hit ?? null, noSlider: sl.noSlider ?? false }),
      );
      check(
        '★ 拖侧边栏滑块 → 半径表真的改了（真实 DOM input 事件路径）',
        sl.found === true && Math.abs((sl.rAfter?.top ?? 0) - 0.3) < 1e-6,
        `r-top ${sl.domBefore} → ${sl.domAfter} · radii.top ${sl.rBefore?.top} → ${sl.rAfter?.top}`,
      );
      check(
        '★ 拖侧边栏滑块 → 面板 3D 视图几何跟着变（不是只改了数字）',
        sl.found === true &&
          Math.abs((sl.v3After?.frontCylSum ?? 0) - (sl.v3Before?.frontCylSum ?? 0)) > 1e-3,
        `ΔfrontSum=${Math.abs((sl.v3After?.frontCylSum ?? 0) - (sl.v3Before?.frontCylSum ?? 0)).toFixed(4)}`,
      );
      check(
        '★ 滑块位置不被回弹覆盖（改完 value 仍是新值，没被自动刷新写回旧值）',
        sl.found === true && Math.abs(Number(sl.domAfter) - 0.3) < 1e-6,
        `domAfter=${sl.domAfter} span=${sl.spanText}`,
      );
      check(
        '★ 拖 joint 改骨长后，手动半径不被自动算法覆盖（r 仍是 0.3）',
        sl.found === true && Math.abs((sl.rAfterDrag?.top ?? 0) - 0.3) < 1e-9,
        `radii=${JSON.stringify(sl.rAfterDrag ?? null)}`,
      );
      check(
        '★ skin → skeleton → skin 往返后手动半径仍在',
        sl.found === true && Math.abs((sl.rAfterRoundTrip?.top ?? 0) - 0.3) < 1e-9,
        `radii=${JSON.stringify(sl.rAfterRoundTrip ?? null)}`,
      );
      check(
        '★ 关节模式也吃半径表（不在该模式用 null 回退成自动半径）',
        sl.found === true && Math.abs(sl.skAfter - sl.skBefore) > 1e-3,
        `ΔfrontSum(skeleton 模式)=${Math.abs((sl.skAfter ?? 0) - (sl.skBefore ?? 0)).toFixed(4)}`,
      );
      check(
        '★ 关节模式与蒙皮模式的几何一致（同一个半径表，不再两套真源）',
        sl.found === true && Math.abs((sl.sknSum ?? 0) - (sl.skAfter ?? 0)) < 1e-6,
        `skn=${sl.sknSum?.toFixed(3)} sk=${sl.skAfter?.toFixed(3)}`,
      );
      check(
        '★ 自动适配只重算非手动骨：手动骨（⑤ 置的 top）一点没动',
        sl.found === true && Math.abs((sl.headTopAfter ?? 0) - (sl.headTopBefore ?? 0)) < 1e-9,
        `headTop ${sl.headTopBefore} → ${sl.headTopAfter}`,
      );
      check(
        '★ 自动适配把非手动骨重算成公式值 clamp(骨长×0.35, 0.04, 0.22)',
        sl.found === true &&
          Math.abs((sl.oRadii?.top ?? 0) - sl.expR) < 1e-9 &&
          Math.abs((sl.oRadii?.medium ?? 0) - sl.expR) < 1e-9 &&
          Math.abs((sl.oRadii?.bottom ?? 0) - sl.expR) < 1e-9,
        `LeftArm=${JSON.stringify(sl.oRadii)} 预期=${sl.expR?.toFixed(4)} · oRadiiImmediate=${sl.oRadiiImmediate} · oRadiiPersist=${sl.oRadiiPersist}`,
      );
      check(
        '★ 自动适配结果在若干帧后仍保持（无帧回调覆盖半径）',
        sl.found === true && Math.abs((sl.oRadiiPersist ?? 0) - (sl.oRadiiImmediate ?? 0)) < 1e-9,
        `oRadiiImmediate=${sl.oRadiiImmediate} · oRadiiPersist=${sl.oRadiiPersist}`,
      );

      // ---- L2f. 主 3D 视口：改半径 → 画面像素必须跟着变 ----
      //
      // L2e 证的是「几何数据变了」，这里证的是「用户眼睛看到的变了」。
      // 中间还隔着一次 GPU 上传 + 一次 draw，任何一环被条件跳过（比如按顶点数
      // 判断要不要重建缓冲）都会让几何变了但画面没变 —— 那正是用户报的现象。
      console.log('\nL2f. 主 3D 视口像素：改半径前后画面必须不同');
      const vpRect = await cdp.eval(`(() => {
        const e = document.querySelector('canvas#gpu');
        if (e === null) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`);
      const grabAvg = async () => {
        const snap = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: vpRect.x, y: vpRect.y, width: vpRect.w, height: vpRect.h, scale: 1 },
        });
        return await cdp.eval(`(async (b64) => {
          const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
          const bmp = await createImageBitmap(blob);
          const c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
          return +(sum / n).toFixed(3);
        })('${snap.data}')`);
      };
      if (vpRect === null || vpRect.w < 2) {
        check('★ 主 3D 视口有可采样区域', false, JSON.stringify(vpRect));
      } else {
        const p0 = await grabAvg();
        // 把所有 wrapper 撑到最大：任何一个包裹器生效，画面都得动。
        // 撑完必须还原 —— 后面 L2c 的像素健康度断言依赖原始半径。
        await cdp.eval(`(() => {
          const c = window.__editor.binding.wrappers.cylinders();
          window.__radOrig = {};
          for (const k of Object.keys(c)) window.__radOrig[k] = { ...c[k].radii };
          return Object.keys(window.__radOrig).length;
        })()`);
        await cdp.eval(`(async () => {
          const b = window.__editor.binding;
          for (const k of Object.keys(window.__radOrig)) {
            for (const s of ['top', 'medium', 'bottom']) b.wrappers.setRadius(k, s, 0.55);
          }
          await ${nFrames(4)};
          return true;
        })()`);
        const p1 = await grabAvg();
        // 必须还原成原值：后面 L2c 的像素健康度断言依赖原始半径
        await cdp.eval(`(async () => {
          const b = window.__editor.binding;
          for (const k of Object.keys(window.__radOrig)) {
            for (const s of ['top', 'medium', 'bottom']) {
              b.wrappers.setRadius(k, s, window.__radOrig[k][s]);
            }
          }
          await ${nFrames(4)};
          return true;
        })()`);
        check(
          '★ 主 3D 视口：撑大所有包裹器后画面亮度变了（半径真的画出来了）',
          Math.abs(p1 - p0) > 0.05,
          `avg ${p0} → ${p1}`,
        );
      }

      // ---- L2b. 绑定面板正/侧视 = 3D 正交视图 ----
      //
      // 守的是「正/侧视要能真正看出包裹器体积和穿插」：2D 粗描边看不出体积，
      // 必须换成带深度的正交 3D（网格实体 + 半透明 X-ray 圆柱体）。
      // 与 L2 同理：WGSL / usage 错配只有运行时才暴露，必须实测顶点数。
      console.log('\nL2b. 绑定面板正/侧视（3D 正交视图）');
      await cdp.eval(`(() => window.__editor.binding.redraw())()`);
      await sleep(600);
      const v3 = await cdp.eval(`(() => window.__editor.binding.view3d())()`);
      check('★ 正/侧视 3D 层已建立（非 null = WebGPU 可用）', v3 !== null, JSON.stringify(v3));
      if (v3 !== null) {
        check('★ 正视 3D 层已上传网格缓冲', v3.frontMesh === true, JSON.stringify(v3));
        check('★ 侧视 3D 层已上传网格缓冲', v3.sideMesh === true, JSON.stringify(v3));
        // 顶点数 = 骨数 × 每骨 240（3 段侧壁 3×10×6 + 两端盖 2×10×3）—— 结构自证
        check(
          '★ 正视 3D 层已画出包裹器圆柱体（顶点数 = 骨数 × 240）',
          v3.frontCylVerts > 0 && v3.frontCylVerts % 240 === 0,
          `frontCylVerts=${v3.frontCylVerts}（${v3.frontCylVerts / 240} 骨）`,
        );
        check(
          '★ 侧视 3D 层已画出包裹器圆柱体（顶点数 = 骨数 × 240）',
          v3.sideCylVerts > 0 && v3.sideCylVerts % 240 === 0,
          `sideCylVerts=${v3.sideCylVerts}（${v3.sideCylVerts / 240} 骨）`,
        );
        check(
          '正/侧视两个 3D 视图画出的圆柱体一致（同一批骨段）',
          v3.frontCylVerts === v3.sideCylVerts,
          `front=${v3.frontCylVerts} side=${v3.sideCylVerts}`,
        );
      }

      // ---- L2c. 面板 3D 视图的像素健康度（过曝 / 全黑 / 被包裹器糊死） ----
      //
      // 只断言「顶点数 > 0」是不够的：管线通了也可能因为 alpha 层层叠加把模型糊成
      // 一片白，或者 tonemap / 相机取景错了整块黑掉。这里直接把 WebGPU canvas 画到
      // 2D canvas 上采样，用亮度分布把这两类回归钉死。
      //
      // ⚠️ 不能直接 `drawImage(glCanvas)`：WebGPU canvas 在 present 之后 drawing buffer
      // 已被丢弃，headless 下采样出来是**全 0**，会把真黑和「取不到像素」混为一谈。
      // 必须走 Page.captureScreenshot 拿到真实合成结果，再回传页面用
      // createImageBitmap 解码成像素（Node 侧没有 PNG 解码器）。
      console.log('\nL2c. 面板 3D 视图像素健康度（防过曝 / 全黑 / 被包裹器糊死）');
      for (const [key, label] of [['front', '正视'], ['side', '侧视']]) {
        const rect = await cdp.eval(`(() => {
          const e = document.querySelector('[data-bd="${key}-gl"]');
          if (e === null) return null;
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })()`);
        if (rect === null || rect.w < 2 || rect.h < 2) {
          check(`★ ${label} 3D 视图有可采样区域`, false, JSON.stringify(rect));
          continue;
        }
        const snap = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
        });
        const pngPath = path.join(OUT_DIR, `editor-binding-${key}-3d.png`);
        fs.writeFileSync(pngPath, Buffer.from(snap.data, 'base64'));

        const px = await cdp.eval(`(async (b64) => {
          const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
          const bmp = await createImageBitmap(blob);
          const c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0, n = 0, white = 0, dark = 0, maxL = 0;
          const hist = [0, 0, 0, 0, 0];
          for (let i = 0; i < d.length; i += 4) {
            const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
            sum += l; n++;
            if (l > 235) white++;
            if (l < 20) dark++;
            if (l > maxL) maxL = l;
            hist[Math.min(4, Math.floor(l / 51))]++;
          }
          return { w: c.width, h: c.height, avg: +(sum / n).toFixed(1),
                   white: +(white / n).toFixed(3), dark: +(dark / n).toFixed(3),
                   maxL, hist: hist.map((x) => +(x / n).toFixed(3)) };
        })('${snap.data}')`);
        console.log(`  ${label} 像素：${JSON.stringify(px)} → ${pngPath}`);
        check(
          `★ ${label} 3D 视图不是全黑（相机取景 / 灯光没坏）`,
          px.avg > 8 && px.dark < 0.98,
          `avg=${px.avg} dark=${px.dark}`,
        );
        check(
          `★ ${label} 3D 视图不过曝（近白像素 < 30%）`,
          px.white < 0.3,
          `white=${px.white} avg=${px.avg} maxL=${px.maxL}`,
        );
        // 中亮档（102~255）占比：太低 = 模型被压成一团黑看不清轮廓，
        // 太高 = 又回到过曝。这一条和上面那条一起，把「模型 vs 包裹器」的对比夹住。
        const mid = px.hist[2] + px.hist[3] + px.hist[4];
        check(
          `★ ${label} 3D 视图里模型看得见（中亮像素 3%~60%）`,
          mid > 0.03 && mid < 0.6,
          `mid=${mid.toFixed(3)} hist=${JSON.stringify(px.hist)}`,
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
