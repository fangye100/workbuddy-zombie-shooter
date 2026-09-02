import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  build: {
    outDir: '../../dist/sample-00',
    emptyOutDir: true,
    // WebGPU 依赖 top-level await 与较新的语法，不做降级
    target: 'esnext',
  },
  server: {
    port: 5173,
    // SharedArrayBuffer（Job System 跨 Worker 通信）需要这两个头
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
