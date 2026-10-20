import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * 查询串 bytes：把任意二进制资产作为 Uint8Array 导入（测试专用）。
 *
 * 为什么需要：raw 查询会把文件按 UTF-8 解码成字符串，GLB 的 BIN chunk 是二进制，
 * 读出来再 TextEncoder 编码已被替换字符污染（实测 chunk-0001.glb 2480172 字节
 * 只剩 2349234 个码位），无法证明「真实 GLB 被解析」。本加载器在配置层用 Node 读
 * 原始字节并以内联 base64 交给测试，测试代码本身仍不 import node:fs
 * （AGENTS 2.5：门禁测试不引入 @types/node 依赖）。
 */
function bytesLoader() {
  return {
    name: 'aether-bytes-asset',
    enforce: 'pre' as const,
    load(id: string) {
      const [file, query] = id.split('?');
      if (query !== 'bytes' || file === undefined) return null;
      const b64 = readFileSync(file).toString('base64');
      return 'const raw = atob(' + JSON.stringify(b64) + ');\n'
        + 'const out = new Uint8Array(raw.length);\n'
        + 'for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);\n'
        + 'export default out;\n';
    },
  };
}

/**
 * 项目此前没有 vitest 配置，靠默认发现规则扫描全仓库 ——
 * 一旦工作区里出现任何第三方 *.test.js / *.spec.js（例如 Chrome 调试用 profile 里
 * 自带扩展的测试文件），`npm test` 就会被这些无关文件污染并报假失败。
 * 这里显式收口：只跑 apps/ 与 packages/ 下的源码测试，排除所有生成物与工作区目录。
 *
 * resolve.alias 让包体基座以 @aether/* 命名空间消费（ADR-005），与
 * apps/lab/shader-lab/vite.config.ts 的别名保持一致，保证 `npm test` 也能解析。
 */
export default defineConfig({
  plugins: [bytesLoader()],
  resolve: {
    alias: [
      {
        find: /^@aether\/zombie-game\/presentation\/(.+)$/,
        replacement: fileURLToPath(new URL('./packages/zombie-game/src/presentation/$1.ts', import.meta.url)),
      },
      {
        find: /^@aether\/([^/]+)$/,
        replacement: fileURLToPath(new URL('./packages/$1/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.workbuddy/**',
      '**/assets/**',
      '**/tools/**',
    ],
    environment: 'node',
  },
});
