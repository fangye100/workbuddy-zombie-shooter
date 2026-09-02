import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

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
  resolve: {
    alias: [
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
