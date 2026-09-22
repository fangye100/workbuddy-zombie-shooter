/**
 * aether 绑定领域 MCP server（stdio，零依赖 .mjs shell —— WU-2）。
 *
 * 架构：本文件只做四件事 —— ① NDJSON stdio 帧（MCP stdio = 换行分隔 JSON-RPC 2.0，
 * 不是 LSP 的 Content-Length）；② node:fs 实现 FsPort 注入领域层；③ PNG 编码
 * （node:zlib deflate + CRC32，render 核心只产 RGBA）；④ 协议版本协商白名单
 * （PR #9 评审收口：只回显自己实际支持的版本，绝不回显任意输入）。
 * 全部领域逻辑在 dist/domain.mjs（esbuild 打包 src/，先跑 pnpm run mcp-binding:build）。
 *
 * 路径纪律：仓内相对路径一律经 resolveRepo() 锚到仓库根（以本文件位置推，与
 * spawn 时的 cwd 无关），并拒绝目录穿越 —— Agent 传什么路径都出不了仓库。
 *
 * 注册到 ZCode：见同目录 README.md。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根 = tools/mcp-binding 的上两级（与进程 cwd 解耦） */
const REPO_ROOT = path.resolve(HERE, '..', '..');
/** realpath 后的仓库根：写侧校验要与它同尺比较（根路径自身可能含 junction） */
const REAL_ROOT = realpathSync(REPO_ROOT);

// 领域层是 esbuild 构建产物：缺失时给出可操作的提示而不是裸 ERR_MODULE_NOT_FOUND
const DOMAIN_BUNDLE = path.resolve(HERE, 'dist', 'domain.mjs');
if (!existsSync(DOMAIN_BUNDLE)) {
  process.stderr.write(
    '[aether-binding] 未找到 dist/domain.mjs —— 先跑 pnpm run mcp-binding:build\n',
  );
  process.exit(1);
}
// Windows 动态 import 必须走 file:// URL（裸路径会被当裸说明符解析）
const { TOOLS_TABLE, BindingDomain, ToolError, dispatchTool } = await import(
  pathToFileURL(DOMAIN_BUNDLE).href
);

const SERVER_INFO = { name: 'aether-binding', version: '0.2.0' };
/** 本 server 实际支持的协议版本（同 mcp-hello 探针：能力实现在这两个版本下一致） */
const SUPPORTED_VERSIONS = ['2025-03-26', '2025-06-18'];
const PROTOCOL_VERSION = '2025-06-18';

// ─────────────────────────── FsPort（node:fs 实现） ───────────────────────────

/** 仓内相对路径 → 绝对路径；解析结果必须仍在仓库内（防目录穿越） */
function resolveRepo(rel) {
  // 跨平台拒绝绝对路径：POSIX 的 path.resolve 不认 Windows 盘符，会把
  // 'C:/Windows/x.glb' 当相对路径拼进仓库（PR #10 评审）——win32/posix 两套都查
  if (path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) {
    throw new ToolError(`路径必须是仓内相对路径：${rel}`);
  }
  const abs = path.resolve(REPO_ROOT, rel);
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + path.sep)) {
    throw new ToolError(`路径越出仓库：${rel}`);
  }
  return abs;
}

/**
 * 写侧的真实路径校验：resolveRepo 是词法检查，writeFileSync 会跟随 symlink ——
 * 仓内一个指出去的符号链接就能把写穿透到仓外（Codex PR #11）。realpath 父目录
 * 再比对真实根。mkdir 在 assert 之前：穿过 symlink 顶多留下空目录，文件写不出去
 */
function assertRealInside(abs) {
  const real = realpathSync(path.dirname(abs));
  if (real !== REAL_ROOT && !real.startsWith(REAL_ROOT + path.sep)) {
    throw new ToolError(`路径经符号链接越出仓库：${abs}`);
  }
}

const fsPort = {
  resolve: resolveRepo,
  readBinary(abs) {
    const buf = readFileSync(abs);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  readText(abs) {
    if (!existsSync(abs)) return null;
    return readFileSync(abs, 'utf8');
  },
  writeText(abs, text) {
    assertRealInside(abs);
    writeFileSync(abs, text, 'utf8');
  },
  writeBinary(abs, data, exclusive) {
    // 导出到还不存在的子目录不该炸成 -32603 ENOENT（路径已过 resolveRepo 仓内校验）
    mkdirSync(path.dirname(abs), { recursive: true });
    assertRealInside(abs);
    // exclusive → wx：目标已存在抛 EEXIST，检查+写在 FS 层原子（防并发双写互盖）
    writeFileSync(abs, Buffer.from(data), exclusive ? { flag: 'wx' } : undefined);
  },
  exists(abs) {
    return existsSync(abs);
  },
  sameFile(a, b) {
    try {
      const sa = statSync(a);
      const sb = statSync(b);
      return sa.dev === sb.dev && sa.ino === sb.ino;
    } catch {
      return false;
    }
  },
  // 与 tools/scene/gen-asset-meta.mjs 的 sha256Of 同算法（hex），保证 hash 门禁一致
  sha256(abs) {
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  },
};

const domain = new BindingDomain(fsPort);

// ─────────────────────────── PNG 编码（RGBA → PNG，zlib deflate） ───────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA 位图 → PNG Buffer（每行前置 filter 字节 0，IDAT 走 deflate level 9 压白底） */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      rowStart + 1,
    );
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─────────────────────────── JSON-RPC / NDJSON stdio ───────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// WU-3 起 dispatchTool 是异步（export_glb 要 await Blob.arrayBuffer() 解码贴图）；
// 响应按 id 配对，并发处理不影响正确性
async function handleRequest(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          // 版本协商（MCP spec，PR #9 评审收口）：客户端所报版本 ∈ 支持集 → 回显；
          // 否则回己方最新支持版本，由客户端决定是否断开
          protocolVersion:
            typeof params?.protocolVersion === 'string' &&
            SUPPORTED_VERSIONS.includes(params.protocolVersion)
              ? params.protocolVersion
              : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS_TABLE } });
      return;
    case 'tools/call': {
      const name = params?.name;
      try {
        const r = await dispatchTool(domain, name, params?.arguments);
        const content = [];
        if (r.image !== undefined) {
          const png = encodePng(r.image.width, r.image.height, r.image.rgba);
          content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
          content.push({
            type: 'text',
            text: JSON.stringify({ ...r.json, pngBytes: png.length }),
          });
        } else {
          content.push({ type: 'text', text: JSON.stringify(r.json) });
        }
        send({ jsonrpc: '2.0', id, result: { content } });
      } catch (err) {
        if (err instanceof ToolError) {
          sendError(id, -32602, err.message);
        } else {
          sendError(id, -32603, `internal: ${String(err)}`);
        }
      }
      return;
    }
    default:
      sendError(id, -32601, `method not found: ${String(method)}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 坏行忽略：stdio 上噪声不该打死 server
    }
    if (msg !== null && typeof msg === 'object' && 'id' in msg) {
      // 异步处理：拒绝必须兜成 -32603，不能让未捕获 rejection 打死 stdio 循环
      handleRequest(msg).catch((err) => {
        sendError(msg.id, -32603, `internal: ${String(err)}`);
      });
    }
  }
});
