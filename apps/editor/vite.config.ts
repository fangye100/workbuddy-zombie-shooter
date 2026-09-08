import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createFsApiHandler } from './devfs';

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
// 浏览器读不到本地磁盘，资产浏览器的目录树/缩略图/GLB 拖入全靠这几个端点：
//   GET  /__fs/list?dir=<相对路径>   → 目录条目 JSON（懒加载，只列一层）
//   GET  /__fs/file?path=<相对路径>  → 原始文件流（GLB fetch、图片缩略图）
//   POST /__fs/write                 → 写回项目内文件（编辑器存盘底座）
// 根 = 工作区根目录（整个游戏项目）。
// 逻辑抽到了 src/services/devfs.ts（可单测、root 可注入），这里只组装 dev server 插件。
// =========================================================================
const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function fsApiPlugin(): Plugin {
  return {
    name: 'zh-fs-api',
    configureServer(server) {
      const handler = createFsApiHandler(projectRoot);
      server.middlewares.use((req, res, next) => {
        handler(req, res, next);
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
