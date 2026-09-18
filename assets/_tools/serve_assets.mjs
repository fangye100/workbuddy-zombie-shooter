#!/usr/bin/env node
/**
 * 资产总览静态服务：root = assets/。
 *
 * 用法：node serve_assets.mjs [port]   （默认 5612）
 * 打开：http://localhost:<port>/asset-browser.html
 *
 * 为什么需要它：GLB 30MB+ 无法内嵌 HTML；内置单文件预览也不托管兄弟目录。
 * 本服务把 assets/ 整个挂出来，浏览器按相对路径取 manifest 里的模型/贴图。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] ?? 5612);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.fbx': 'application/octet-stream',
  '.zip': 'application/zip',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, `http://x`).pathname);
    let rel = url.replace(/^\/+/, '') || 'asset-browser.html';
    let abs = path.resolve(ROOT, rel);
    // 目录 → index
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      abs = path.join(abs, 'asset-browser.html');
    }
    // 🔴 前缀碰撞防护：只判断 `startsWith(ROOT)` 的话，`assets-other/...` 这类
    // 同级目录也满足条件（`/x/assets` 是 `/x/assets-other` 的前缀）。必须比到分隔符。
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404: /${rel}`);
      return;
    }
    // 🔴 大文件必须支持 Range（GLTFLoader 不强制，但视频/未来资产需要；至少 stream）
    const st = fs.statSync(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.writeHead(500); res.end(String(e?.message ?? e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`asset server: http://127.0.0.1:${PORT}/asset-browser.html  (root=${ROOT})`);
});
