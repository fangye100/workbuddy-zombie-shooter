/**
 * 资产库文件系统 API（dev server 中间件 + 可单测的纯逻辑）。
 *
 * 浏览器读不到本地磁盘，资产浏览器 / 编辑器存盘全靠这几个端点：
 *   GET  /__fs/list?dir=<相对路径>   → 目录条目 JSON（懒加载，只列一层）
 *   GET  /__fs/file?path=<相对路径>  → 原始文件流（GLB fetch、图片缩略图）
 *   POST /__fs/write                 → 写回项目内文件（编辑器存盘的底座）
 *
 * 根 = 工作区根目录（整个游戏项目）。读端点只读；写端点做了三重护栏：
 *   ① 路径必须落在项目根内（resolveInside 防 `../../` 穿越）；
 *   ② 只允许写 `.json`（杜绝浏览器写二进制 / 源码进项目）；
 *   ③ 原子写（temp + rename），中途崩溃不会留半截文件。
 *
 * ## 写入协议（复审 P1，如实声明保护边界）
 *
 * **`POST /__fs/write` 是唯一受协调的写路径。** 规则：
 *
 *   1. 客户端带 `baseHash`（它认为磁盘当前的版本指纹）→ 服务端在**逐路径串行队列**内
 *      先核后写：不一致 → **409 conflict**（回传 `currentHash`），绝不覆盖。
 *   2. 浏览器保存（编辑器）与 Agent 写入**都必须走这里**。直接 `fsp.writeFile` 的写入
 *      **不受保护** —— 进程内队列约束不了别的进程/程序。
 *   3. 即使用队列 + 即时校验，`rename` 前仍存在毫秒级窗口（别的进程此时写入仍可能
 *      被覆盖）。这个窗口**无法在本机无锁文件系统上彻底消除**；遇到时按 409 +
 *      人工合并处理。因此：**不要宣称队列提供了"完整保护"**，它的保证是
 *      「经过 API 的写者互不可覆盖 + 直接写者能被判出 409（前提是他们先读了基准）」。
 *   4. 写入失败（500）不会终止进程、不会卡死队列：下一次同路径写入照常执行。
 *
 * ⚠️ 该中间件仅 dev 存在（`vite dev` 的 `zh-fs-api` 插件）；生产构建产物里没有。
 *    生产部署时需在托管产物的 Node server 复刻同一套写路由。
 */

import { createReadStream, existsSync, promises as fsp, statSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
// 与浏览器侧保存共用同一个指纹实现 —— 版本校验必须逐位一致，各算一份必然漂移。
// ⚠️ 必须带 .ts 扩展名：vite/esbuild 能解析无扩展名 import，但 `node --experimental-strip-types`
// （verify:fs 的执行环境）按 Node ESM 规则要求显式扩展名 —— 漏掉就是 ERR_MODULE_NOT_FOUND。
import { sceneFingerprint } from '../../packages/runtime/src/doc-diff.ts';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** 把客户端给的相对路径解析成绝对路径；越出项目根返回 null（防 ../../ 穿越） */
export function resolveInside(root: string, rel: string): string | null {
  const rootLower = root.toLowerCase();
  // 客户端约定用 POSIX 分隔符；先把所有分隔符统一交给 path.resolve 处理
  const abs = path.resolve(root, rel);
  const lower = abs.toLowerCase();
  if (lower !== rootLower && !lower.startsWith(rootLower + path.sep)) return null;
  return abs;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** 收集 POST 请求体并 JSON.parse（空体返回 {}） */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export interface WriteBody {
  /** 项目内相对路径（POSIX 分隔符） */
  path: string;
  /** 替换模式：整文件写入此字符串内容（.json 会校验合法 JSON） */
  content?: string;
  /** 合并模式：浅合并进现有 JSON 的顶层键（不破坏其它键，如 importer / userData） */
  patch?: Record<string, unknown>;
  /**
   * 乐观并发控制（复审 P1）：客户端认为磁盘当前的版本指纹
   * （`sceneFingerprint`，与浏览器侧保存同一个实现）。
   *
   * 🔴 版本校验与写入必须落在**同一个服务端操作**里：浏览器「先读盘比对、再发
   * 覆盖请求」是两步，Agent 恰好在这两步之间改文件就仍会被覆盖 —— 那是
   * TOCTOU 竞态。浏览器的预检只能给**提前提示**，真正的判定只能在这里做。
   */
  baseHash?: string;
}

export interface WriteResult {
  ok: boolean;
  status: number;
  bytes?: number;
  error: string | null;
}

/** 逐文件的写入串行队列：同一路径的写请求严格排队，校验+写入在队列体内原子完成 */
const writeQueues = new Map<string, Promise<unknown>>();

async function handleWrite(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '写端点仅支持 POST' });
    return;
  }
  let body: Partial<WriteBody>;
  try {
    body = (await readJsonBody(req)) as Partial<WriteBody>;
  } catch {
    sendJson(res, 400, { error: '请求体不是合法 JSON' });
    return;
  }
  const rel = (body.path ?? '').replace(/^\/+/, '');
  if (!rel) {
    sendJson(res, 400, { error: '缺少 path' });
    return;
  }
  const abs = resolveInside(root, rel);
  if (abs === null) {
    sendJson(res, 400, { error: '路径越出项目根（拒绝 ../../ 穿越）' });
    return;
  }
  // 护栏②：只允许写 .json（scene / meta / 任意未来 JSON 数据）
  if (path.extname(abs).toLowerCase() !== '.json') {
    sendJson(res, 403, { error: '仅允许写 .json 文件' });
    return;
  }

  // 🔴 校验 + 写入必须串行完成（复审 P1）。把这次写排进该路径的队列尾部：
  // 前一个写完（或失败）才轮到它，从此没有「两个写请求交错执行」的窗口。
  const prev = writeQueues.get(abs) ?? Promise.resolve();
  const task = prev.catch(() => undefined).then(() => performWrite(abs, rel, body, res));
  // 🔴 队列里存的是**尾巴本身**，且这里 await 的也是它（复审 P1）：
  // 曾经存 `task.finally()` 派生的新 Promise、却只 await 原始 task ——
  // 写入失败后派生 Promise 的拒绝无人消费，进程会以 unhandled rejection 崩掉；
  // 清理时拿原始 task 跟派生 Promise 比，条件永不成立，队列记录永远清不掉。
  const tail = task.finally(() => {
    if (writeQueues.get(abs) === tail) writeQueues.delete(abs);
  });
  writeQueues.set(abs, tail);
  await tail; // 拒绝向上冒到中间件的 try/catch → HTTP 500，进程与队列都活着
}

/** 队列体内执行的一次写入（校验 → 组装 → 原子落盘） */
async function performWrite(
  abs: string,
  rel: string,
  body: Partial<WriteBody>,
  res: ServerResponse,
): Promise<void> {
  // ① 乐观并发控制：客户端带了基准指纹就先核再写，绝不静默覆盖对方。
  // 这一刻起，到本文件落盘完成，同一路径没有其它写请求在跑（队列保证）。
  if (body.baseHash !== undefined) {
    let current: unknown = null;
    let currentHash = 'missing';
    if (existsSync(abs)) {
      const txt = await fsp.readFile(abs, 'utf8');
      try {
        current = JSON.parse(txt);
        currentHash = sceneFingerprint(current);
      } catch {
        sendJson(res, 409, { ok: false, code: 'conflict', error: '现有文件不是合法 JSON，无法做版本校验' });
        return;
      }
    }
    if (currentHash !== body.baseHash) {
      sendJson(res, 409, {
        ok: false,
        code: 'conflict',
        currentHash,
        error: `磁盘版本与客户端基准不一致（基准 ${body.baseHash} → 磁盘 ${currentHash}），拒绝覆盖`,
      });
      return;
    }
  }

  // 确保父目录存在（首次保存 .scene.json / 新建 sidecar 也成立）
  await fsp.mkdir(path.dirname(abs), { recursive: true });

  let out: string;
  if (body.patch !== undefined) {
    if (typeof body.patch !== 'object' || body.patch === null || Array.isArray(body.patch)) {
      sendJson(res, 400, { error: 'patch 必须是对象' });
      return;
    }
    // 合并模式：读现有 JSON（不存在则当 {}），顶层浅合并，保留其它键
    let existing: Record<string, unknown> = {};
    if (existsSync(abs)) {
      const txt = await fsp.readFile(abs, 'utf8');
      try {
        const parsed = JSON.parse(txt) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          sendJson(res, 409, { error: '现有文件顶层不是对象，拒绝合并避免破坏' });
          return;
        }
        existing = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, 409, { error: '现有文件不是合法 JSON，拒绝合并避免破坏' });
        return;
      }
    }
    out = JSON.stringify({ ...existing, ...body.patch }, null, 2);
  } else if (body.content !== undefined) {
    out = String(body.content);
    try { JSON.parse(out); } catch {
      sendJson(res, 400, { error: 'content 不是合法 JSON' });
      return;
    }
  } else {
    sendJson(res, 400, { error: '需要 content（替换）或 patch（合并）之一' });
    return;
  }

  // 护栏③：原子写 = 写 temp 再 rename（同卷内 rename 原子，崩溃不留半截文件）
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  await fsp.writeFile(tmp, out, 'utf8');
  await fsp.rename(tmp, abs);
  const st = statSync(abs);
  sendJson(res, 200, { ok: true, path: rel, bytes: st.size });
}

export type FsApiHandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/**
 * 生成一个项目根绑定的 FS API 中间件（handler）。root 可注入 → 单测用临时目录验证。
 */
export function createFsApiHandler(root: string): FsApiHandler {
  return (req, res, next): void => {
    const url = req.url ?? '';
    if (!url.startsWith('/__fs/')) {
      next();
      return;
    }
    void (async (): Promise<void> => {
      try {
        const u = new URL(url, 'http://localhost');
        if (u.pathname === '/__fs/list') {
          const dir = u.searchParams.get('dir') ?? '';
          const abs = resolveInside(root, dir);
          if (abs === null || !fsExistsDir(abs)) {
            sendJson(res, 404, { error: '目录不存在或越界' });
            return;
          }
          const dirents = await fsp.readdir(abs, { withFileTypes: true });
          const entries = await Promise.all(
            dirents.map(async (d) => {
              const st = await fsp.lstat(path.join(abs, d.name)).catch(() => null);
              const isDir = d.isDirectory();
              return {
                name: d.name,
                kind: isDir ? ('dir' as const) : ('file' as const),
                size: isDir || st === null ? 0 : st.size,
                mtime: st === null ? 0 : Math.round(st.mtimeMs),
                ext: isDir ? '' : path.extname(d.name).toLowerCase(),
              };
            }),
          );
          entries.sort((a, b) =>
            a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh'),
          );
          sendJson(res, 200, { dir, entries });
          return;
        }
        if (u.pathname === '/__fs/file') {
          const rel = u.searchParams.get('path') ?? '';
          const abs = resolveInside(root, rel);
          if (abs === null || !fsExistsFile(abs)) {
            sendJson(res, 404, { error: '文件不存在或越界' });
            return;
          }
          const st = statSync(abs);
          res.statusCode = 200;
          res.setHeader('Content-Type', MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
          res.setHeader('Content-Length', st.size);
          res.setHeader('Cache-Control', 'no-cache');
          createReadStream(abs).pipe(res);
          return;
        }
        if (u.pathname === '/__fs/write') {
          await handleWrite(req, res, root);
          return;
        }
        sendJson(res, 404, { error: '未知端点' });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
    })();
  };
}

// 用 existsSync 的封装，避免与上面 import 的 fsp 混淆语义（list/file 只需存在性判断）
function fsExistsDir(abs: string): boolean {
  try { return existsSync(abs) && statSync(abs).isDirectory(); } catch { return false; }
}
function fsExistsFile(abs: string): boolean {
  try { return existsSync(abs) && statSync(abs).isFile(); } catch { return false; }
}
