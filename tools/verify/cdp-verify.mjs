/**
 * 自主验证：用带界面的 Chrome（真实 GPU，非无头软渲染）+ CDP 完成
 *   1) 打开 Game Editor
 *   2) 通过 DOM.setFileInputFiles 把 GLB 塞进隐藏文件框，触发真实导入流程
 *   3) Page.captureScreenshot 截图（默认视图 + UV 棋盘格视图）
 *   4) Node 侧用 zlib 解码 PNG，做像素级统计判定贴图是否正常
 *
 * 注意：本项目铁律禁止 headless / CPU 软渲染验证，这里全程是 headed Chrome + 真实 GPU。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_APP = 'http://localhost:5178/';
const PORT = 9222;
const USER_DIR = path.resolve('.workbuddy/tmp/chrome-profile');
const GLB = path.resolve('assets/characters/models/E-04/E04_20260901_010134.glb');
const OUT = path.resolve('.workbuddy/tmp');

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`无法连接 ${url}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p !== undefined) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
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

/** 极简 PNG 解码（zlib + 反滤波），仅支持 8bit RGB/RGBA 非隔行 —— 截图正好是这种 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`不支持位深 ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`不支持色彩类型 ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev !== null ? prev[x] : 0;
      const c = prev !== null && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = v + a; break;
        case 2: v = v + b; break;
        case 3: v = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('未知滤波器 ' + filter);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

/** 区域统计：颜色丰富度 + 局部方差（纹理细节的直接度量） */
function analyzeRegion(img, x0, y0, x1, y1) {
  const { w, channels, data } = img;
  let sum = 0;
  let n = 0;
  let varSum = 0;
  const colors = new Set();
  const lums = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      const i = (y * w + x) * channels;
      const j = (y * w + x + 1) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const r2 = data[j];
      const g2 = data[j + 1];
      const b2 = data[j + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const lum2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
      sum += lum;
      lums.push(lum);
      varSum += Math.abs(lum - lum2);
      n++;
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
  }
  lums.sort((a, b) => a - b);
  return {
    meanLum: +(sum / Math.max(1, n)).toFixed(1),
    localVariance: +(varSum / Math.max(1, n)).toFixed(2),
    distinctColors: colors.size,
    p05: Math.round(lums[Math.floor(lums.length * 0.05)] ?? 0),
    p50: Math.round(lums[Math.floor(lums.length * 0.5)] ?? 0),
    p95: Math.round(lums[Math.floor(lums.length * 0.95)] ?? 0),
  };
}

// ============================ 主流程 ============================
console.log('启动 headed Chrome（真实 GPU，非无头软渲染）…');
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${USER_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1600,900',
  URL_APP,
], { detached: false, stdio: 'ignore' });

try {
  const ver = await httpJson(`http://127.0.0.1:${PORT}/json/version`);
  console.log('浏览器已就绪:', ver.Browser);

  let targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`, 60);
  let page = targets.find((t) => t.type === 'page' && t.url.includes('5178'));
  if (page === undefined) {
    await sleep(3000);
    targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    page = targets.find((t) => t.type === 'page');
  }
  console.log('页面目标:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  console.log('CDP 已连接');

  // 等应用启动（WebGPU 初始化 + 面板建好）
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const st = await cdp.eval(`(() => {
      const f = document.getElementById('fatal');
      if (f && getComputedStyle(f).display !== 'none') return 'FATAL';
      const inp = document.querySelector('input[type=file]');
      const hud = document.getElementById('hud');
      return (inp && hud && hud.innerText.includes('FPS')) ? 'READY' : 'BOOTING';
    })()`);
    if (st === 'READY') { ready = true; break; }
    if (st === 'FATAL') {
      const msg = await cdp.eval(`document.getElementById('fatal-body')?.innerText ?? ''`);
      throw new Error('应用致命错误: ' + msg);
    }
    await sleep(1000);
  }
  if (!ready) throw new Error('应用启动超时');
  console.log('应用已启动（无致命错误）');

  // 注入 GLB 触发真实导入
  const doc = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input[type=file]',
  });
  if (nodeId === 0) throw new Error('找不到文件输入框');
  await cdp.send('DOM.setFileInputFiles', { files: [GLB], nodeId });
  console.log('已注入 GLB，等待导入完成…');

  // 等导入完成（模型信息行出现文件名）
  let imported = false;
  for (let i = 0; i < 90; i++) {
    const txt = await cdp.eval(`document.body.innerText`);
    if (txt.includes('E04_20260901_010134.glb')) { imported = true; break; }
    await sleep(1000);
  }
  if (!imported) throw new Error('导入超时');
  const info = await cdp.eval(`(() => {
    const m = document.body.innerText.match(/E04_[^\\n]*\\.glb[^\\n]*/);
    return m ? m[0] : '';
  })()`);
  console.log('模型信息行:', info);

  await sleep(2500); // 等首帧稳定

  async function shot(name) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    const file = path.join(OUT, name);
    fs.writeFileSync(file, buf);
    return decodePng(buf);
  }

  // --- 视图 A：最终画面 ---
  const imgDefault = await shot('import-default.png');
  console.log(`截图 A 最终画面: ${imgDefault.w}x${imgDefault.h}`);

  // --- 视图 B：UV 棋盘格（debugMode = 8）---
  const switched = await cdp.eval(`(() => {
    const sels = [...document.querySelectorAll('select')];
    const sel = sels.find(s => [...s.options].some(o => o.textContent.includes('UV 棋盘格')));
    if (!sel) return false;
    const opt = [...sel.options].find(o => o.textContent.includes('UV 棋盘格'));
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  console.log('切换到 UV 棋盘格:', switched);
  await sleep(1500);
  const imgUv = await shot('import-uvchecker.png');

  // ================= 像素分析 =================
  // 画布区域：左侧面板约 330px，取画布中心带作为角色所在区域
  const W = imgDefault.w;
  const H = imgDefault.h;
  const panelW = Math.round(330 * (W / 1600));
  const cx0 = panelW + Math.round((W - panelW) * 0.28);
  const cx1 = panelW + Math.round((W - panelW) * 0.72);
  const cy0 = Math.round(H * 0.22);
  const cy1 = Math.round(H * 0.80);
  // 地面参照区（下方平坦处）
  const gx0 = panelW + Math.round((W - panelW) * 0.10);
  const gx1 = panelW + Math.round((W - panelW) * 0.30);
  const gy0 = Math.round(H * 0.88);
  const gy1 = Math.round(H * 0.97);

  const charRegion = analyzeRegion(imgDefault, cx0, cy0, cx1, cy1);
  const groundRegion = analyzeRegion(imgDefault, gx0, gy0, gx1, gy1);
  const uvRegion = analyzeRegion(imgUv, cx0, cy0, cx1, cy1);

  console.log('\n=============== 像素统计 ===============');
  console.log('角色区域（最终画面）:', JSON.stringify(charRegion));
  console.log('地面参照区（平坦）  :', JSON.stringify(groundRegion));
  console.log('角色区域（UV棋盘格）:', JSON.stringify(uvRegion));

  const detailRatio = charRegion.localVariance / Math.max(0.01, groundRegion.localVariance);
  console.log('\n--- 判定 ---');
  console.log('角色/地面 局部方差比:', detailRatio.toFixed(1), '（>3 表示有明显纹理细节，≈1 表示平色）');
  console.log('角色区域不同颜色数:', charRegion.distinctColors, '（平色通常 <50，带贴图通常 >300）');
  console.log('棋盘格亮度分布 p05/p50/p95:', uvRegion.p05, '/', uvRegion.p50, '/', uvRegion.p95,
    '（规整棋盘格应呈双峰：接近 38 与 217）');

  fs.writeFileSync(path.join(OUT, 'analysis.json'), JSON.stringify({
    charRegion, groundRegion, uvRegion, detailRatio, info,
  }, null, 2));
  console.log('\n截图已保存:', path.join(OUT, 'import-default.png'), '|', path.join(OUT, 'import-uvchecker.png'));
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
}
