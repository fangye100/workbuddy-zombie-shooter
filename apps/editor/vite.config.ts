import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const root = fileURLToPath(new URL('.', import.meta.url));

// WebGPU 只在 secure context 下可用：localhost 走 HTTP 即可，但 Tailscale IP
// (100.x.x.x) 走 HTTP 不是 secure context，navigator.gpu 为 undefined → 黑屏。
// 故经 Tailscale 访问必须用 HTTPS。证书用 `tailscale cert <magicdns>` 生成，
// 放 .workbuddy/tmp/certs/（已 gitignore）。证书存在才开 https，缺失则退回 HTTP。
const certName = 'fangye-win11-office.tail6b29a2.ts.net';
const certDir = fileURLToPath(new URL('../../.workbuddy/tmp/certs/', import.meta.url));
const certFile = `${certDir}${certName}.crt`;
const keyFile = `${certDir}${certName}.key`;
const https = fs.existsSync(certFile) && fs.existsSync(keyFile)
  ? { cert: certFile, key: keyFile }
  : undefined;

// =========================================================================
// 资产库文件系统 API（Asset Library 后端）
// 浏览器读不到本地磁盘，资产浏览器的目录树/缩略图/GLB 拖入全靠这两个端点：
//   GET /__fs/list?dir=<相对路径>   → 目录条目 JSON（懒加载，只列一层）
//   GET /__fs/file?path=<相对路径>  → 原始文件流（GLB fetch、图片缩略图）
// 根 = 工作区根目录（整个游戏项目）。只读，不提供任何写操作。
// =========================================================================
const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const projectRootLower = projectRoot.toLowerCase();

/** 把客户端给的相对路径解析成绝对路径；越出项目根返回 null（防 ../../ 穿越） */
function resolveInside(rel: string): string | null {
  // 客户端约定用 POSIX 分隔符；先把所有分隔符统一交给 path.resolve 处理
  const abs = path.resolve(projectRoot, rel);
  const lower = abs.toLowerCase();
  if (lower !== projectRootLower && !lower.startsWith(projectRootLower + path.sep)) return null;
  return abs;
}

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function handleFsApi(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  const url = req.url ?? '';
  if (!url.startsWith('/__fs/')) {
    next();
    return;
  }
  try {
    const u = new URL(url, 'http://localhost');
    if (u.pathname === '/__fs/list') {
      const dir = u.searchParams.get('dir') ?? '';
      const abs = resolveInside(dir);
      if (abs === null || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        sendJson(res, 404, { error: '目录不存在或越界' });
        return;
      }
      const dirents = await fs.promises.readdir(abs, { withFileTypes: true });
      const entries = await Promise.all(
        dirents.map(async (d) => {
          // 符号链接不跟进（lstat），避免树里钻进项目外的目录
          const st = await fs.promises.lstat(path.join(abs, d.name)).catch(() => null);
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
      // 目录在前、文件在后，各自按名称排（中文按拼音/locale 规则）
      entries.sort((a, b) =>
        a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh'),
      );
      sendJson(res, 200, { dir, entries });
      return;
    }
    if (u.pathname === '/__fs/file') {
      const rel = u.searchParams.get('path') ?? '';
      const abs = resolveInside(rel);
      if (abs === null || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        sendJson(res, 404, { error: '文件不存在或越界' });
        return;
      }
      const st = fs.statSync(abs);
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      // 缩略图与 GLB 都会被反复请求，给个短缓存省点 IO
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(abs).pipe(res);
      return;
    }
    sendJson(res, 404, { error: '未知端点' });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
}

function fsApiPlugin(): Plugin {
  return {
    name: 'zh-fs-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handleFsApi(req, res, next);
      });
    },
  };
}

export default defineConfig({
  root,
  plugins: [fsApiPlugin()],
  // 包体基座以 @aether/* 命名空间消费（ADR-005），避免深相对路径跨包。
  // 仅匹配 `@aether/<pkg>`（不含子路径），解析到 packages/<pkg>/src。
  resolve: {
    alias: [
      {
        find: /^@aether\/([^/]+)$/,
        // 直接解析到包的 index.ts 入口，避免目录解析歧义
        // config 位于 apps/editor，回退两级到项目根再进 packages
        replacement: fileURLToPath(new URL('../../packages/$1/src/index.ts', import.meta.url)),
      },
    ],
  },
  server: {
    port: 5100,
    strictPort: true,
    // host:true = 监听所有网卡，含 Tailscale 虚拟网卡（100.124.237.93 /
    // fangye-win11-office.tail6b29a2.ts.net）。手机或另一台设备经 Tailscale
    // 访问编辑器必须开这个，否则只绑 localhost 收不到外部请求。
    host: true,
    // 经 Tailscale 域名（*.ts.net:5100）访问时，Vite 默认 host-check 会拦截
    // （Blocked request. This host is not allowed.）。allowedHosts:true 放行任意
    // Host，否则 Tailscale 链路在应用层被挡、连得上但 403。
    allowedHosts: true,
    open: false,
    https,
  },
  build: {
    // 0b.8A 已把 apps/lab/shader-lab 物理搬迁为 apps/editor，产物目录同步改名；
    // dist/shader-lab 是历史名，留着只会让人以为编辑器还叫 Shader Lab。
    outDir: '../../dist/editor',
    emptyOutDir: true,
    // WebGPU 依赖较新的语法（含 top-level await），不做降级
    target: 'esnext',
  },
});
