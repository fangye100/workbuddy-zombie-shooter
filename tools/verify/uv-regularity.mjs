/**
 * 棋盘格空间规整度分析：区分「规整棋盘格（UV 正确）」与「随机噪点（UV 错乱）」。
 *
 * 判定原理：把棋盘格图里接近 38 / 217 的像素二值化，沿扫描线统计同色游程长度。
 *   - UV 正确：UV 在三角形内连续变化 → 同色游程较长（数像素到数十像素）
 *   - UV 错乱：每个像素取值接近随机 → 游程长度趋近 1~2 像素（噪点化）
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const IMG = '.workbuddy/tmp/import-uvchecker.png';
const buf = fs.readFileSync(IMG);

// --- 复用极简 PNG 解码 ---
function decodePng(buf) {
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
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
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

const img = decodePng(buf);
const { w, h, channels, data } = img;

// 画布区域（左侧面板 330/1600 比例换算）
const panelW = Math.round(330 * (w / 1600));
const x0 = panelW + Math.round((w - panelW) * 0.25);
const x1 = panelW + Math.round((w - panelW) * 0.75);
const y0 = Math.round(h * 0.20);
const y1 = Math.round(h * 0.85);

const DARK = 38, LIGHT = 217, TOL = 8;
let runs = [];
let transitions = 0;
let counted = 0;
let darkPx = 0, lightPx = 0;

for (let y = y0; y < y1; y++) {
  let curState = -1;
  let curLen = 0;
  for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * channels;
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    let s = -1;
    if (Math.abs(lum - DARK) <= TOL) { s = 0; darkPx++; }
    else if (Math.abs(lum - LIGHT) <= TOL) { s = 1; lightPx++; }
    if (s === -1) {
      if (curLen > 0) { runs.push(curLen); curLen = 0; }
      curState = -1;
      continue;
    }
    counted++;
    if (s !== curState) {
      if (curLen > 0) { runs.push(curLen); transitions++; }
      curState = s;
      curLen = 1;
    } else {
      curLen++;
    }
  }
  if (curLen > 0) runs.push(curLen);
}

runs.sort((a, b) => a - b);
const mean = runs.reduce((a, b) => a + b, 0) / Math.max(1, runs.length);
const median = runs[Math.floor(runs.length / 2)] ?? 0;
const p90 = runs[Math.floor(runs.length * 0.9)] ?? 0;
const noiseRatio = runs.filter((r) => r <= 2).length / Math.max(1, runs.length);

console.log('========== UV 棋盘格空间规整度 ==========');
console.log(`分析区域: x ${x0}..${x1}, y ${y0}..${y1}`);
console.log(`棋盘格像素: 暗 ${darkPx} / 亮 ${lightPx}（合计 ${counted}）`);
console.log(`同色游程数: ${runs.length}`);
console.log(`游程长度 平均 ${mean.toFixed(2)} | 中位 ${median} | P90 ${p90}`);
console.log(`长度≤2 的游程占比: ${(noiseRatio * 100).toFixed(1)}%`);
console.log('');
console.log('--- 判定 ---');
console.log('UV 正确（规整棋盘格）: 平均游程应 >> 2 像素，且长度≤2 的占比低');
console.log('UV 错乱（随机噪点）  : 平均游程接近 1~2 像素，长度≤2 的占比 > 60%');
const verdict = mean > 3 && noiseRatio < 0.5
  ? '✅ 规整棋盘格 → UV 展开与采样均正常，贴图映射正确'
  : mean <= 2 || noiseRatio > 0.6
    ? '❌ 接近随机噪点 → UV 数据错乱'
    : '⚠ 介于两者之间，需进一步确认';
console.log('结论:', verdict);
console.log('========================================');
