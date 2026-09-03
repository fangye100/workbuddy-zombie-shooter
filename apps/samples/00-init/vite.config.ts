import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

// 经 Tailscale 访问必须用 HTTPS（与 Game Editor 同套证书）。证书由
// `tailscale cert <magicdns>` 生成，放 .workbuddy/tmp/certs/（已 gitignore）。
// 证书存在才开 https，缺失则退回 HTTP（仅本机 localhost 可用）。
const certName = 'fangye-win11-office.tail6b29a2.ts.net';
const certDir = fileURLToPath(new URL('../../../.workbuddy/tmp/certs/', import.meta.url));
const certFile = `${certDir}${certName}.crt`;
const keyFile = `${certDir}${certName}.key`;
const https = fs.existsSync(certFile) && fs.existsSync(keyFile)
  ? { cert: certFile, key: keyFile }
  : undefined;

export default defineConfig({
  root,
  build: {
    outDir: '../../dist/sample-00',
    emptyOutDir: true,
    // WebGPU 依赖 top-level await 与较新的语法，不做降级
    target: 'esnext',
  },
  server: {
    port: 5101,
    strictPort: true,
    // host:true = 监听所有网卡，含 Tailscale 虚拟网卡（100.124.237.93 / *.ts.net）。
    // 手机或异地设备经 Tailscale 访问最终游戏必须开这个，否则只绑 localhost 收不到外部请求。
    host: true,
    // 经 Tailscale 域名（*.ts.net:5101）访问时，Vite 默认 host-check 会拦截
    // （Blocked request. This host is not allowed.）。allowedHosts:true 放行任意 Host。
    allowedHosts: true,
    // SharedArrayBuffer（Job System 跨 Worker 通信）需要这两个头
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    https,
  },
});
