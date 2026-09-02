import { defineConfig } from 'vitest/config';

/**
 * 项目此前没有 vitest 配置，靠默认发现规则扫描全仓库 ——
 * 一旦工作区里出现任何第三方 *.test.js / *.spec.js（例如 Chrome 调试用 profile 里
 * 自带扩展的测试文件），`npm test` 就会被这些无关文件污染并报假失败。
 * 这里显式收口：只跑 apps/ 与 packages/ 下的源码测试，排除所有生成物与工作区目录。
 */
export default defineConfig({
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
