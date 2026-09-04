/**
 * 真实资产文件的门禁测试（`npm run scene:check`）。
 *
 * 与 `document.test.ts` / `asset-meta.test.ts` 的区别：那两个测**校验器本身**，
 * 这个测**仓库里实际存在的文件** —— 它是 CI 门禁，不是单元测试。
 *
 * 校验逻辑全部复用 `packages/scene/src/*` 的 TS 校验器，本文件不重复实现任何规则
 * （单一真源的延伸：校验规则也只能有一份）。
 *
 * ## 为什么用 import.meta.glob 而不是 node:fs
 *
 * 本仓库没装 `@types/node`，而 tsconfig 的 `types` 是白名单（只有 `@webgpu/types` + `vite/client`）。
 * 用 `import.meta.glob` 走 Vite 编译期静态分析，既拿得到文件清单又不需要 node 类型，
 * 还天然与 vitest 的模块图同步（新增资产文件不必手动登记）。
 *
 * 覆盖：
 *   1. aether.project.json 合法
 *   2. 每个 *.meta.json 合法
 *   3. 每个 *.scene.json 合法（当前没有场景文件时不算失败）
 *   4. **跨文件约束**：guid 全局唯一（单个文件的校验器查不到这一层）
 *   5. **孤儿检查**：*.meta.json 必须有对应的源资产
 */
import { describe, it, expect } from 'vitest';
import { validateProject, PROJECT_FILE_NAME } from '../src/project';
import { validateAssetMeta, META_FILE_SUFFIX } from '../src/asset-meta';
import { validateSceneDocument } from '../src/document';

/** eager + import:'default' → 直接拿解析后的 JSON 对象 */
const projectModules = import.meta.glob('/aether.project.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const metaModules = import.meta.glob('/assets/**/*.meta.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const sceneModules = import.meta.glob('/assets/**/*.scene.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

/** eager:false 只拿键不加载内容 —— 用于孤儿检查（清单比内容便宜） */
const allAssetPaths = Object.keys(import.meta.glob('/assets/**/*', { eager: false }));

describe('项目文件', () => {
  const key = `/${PROJECT_FILE_NAME}`;

  it('仓库根存在 aether.project.json', () => {
    expect(Object.keys(projectModules)).toContain(key);
  });

  it(`项目文件通过 validateProject（零 error）`, () => {
    const doc = projectModules[key];
    if (doc === undefined) return;
    const errors = validateProject(doc).filter((d) => d.severity === 'error');
    expect(errors.map((e) => `${e.path} ${e.code} ${e.message}`)).toEqual([]);
  });

  it('层表前 8 项是引擎内置层（layer 索引语义靠它稳定）', () => {
    const doc = projectModules[key] as { layers?: string[] } | undefined;
    expect(doc?.layers?.slice(0, 8)).toEqual([
      'Default',
      'TransparentFX',
      'IgnoreRaycast',
      'Background',
      'Environment',
      'Character',
      'Pickup',
      'Trigger',
    ]);
  });
});

describe('资产元数据文件', () => {
  it('assets 下至少有一个 .meta.json（否则说明还没跑 scene:gen）', () => {
    expect(Object.keys(metaModules).length).toBeGreaterThan(0);
  });

  it('每个 .meta.json 通过 validateAssetMeta（零 error）', () => {
    const failures: string[] = [];
    for (const [path, doc] of Object.entries(metaModules)) {
      for (const d of validateAssetMeta(doc)) {
        if (d.severity === 'error') failures.push(`${path} ${d.path} ${d.code} ${d.message}`);
      }
    }
    // 一次性报全部，不要一个一个失败重跑
    expect(failures).toEqual([]);
  });

  it('guid 全局唯一（跨文件约束，单个文件的校验器看不到）', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const [path, doc] of Object.entries(metaModules)) {
      const g = (doc as { guid?: string }).guid;
      if (g === undefined) continue;
      const prev = seen.get(g);
      if (prev !== undefined) dups.push(`${g}：${prev} 与 ${path}`);
      else seen.set(g, path);
    }
    expect(dups).toEqual([]);
  });

  it('没有孤儿元数据（每个 .meta.json 都有对应的源资产）', () => {
    const assets = new Set(allAssetPaths);
    const orphans = Object.keys(metaModules).filter(
      (p) => !assets.has(p.slice(0, -META_FILE_SUFFIX.length)),
    );
    expect(orphans).toEqual([]);
  });
});

describe('场景文件', () => {
  it('每个 .scene.json 通过 validateSceneDocument（零 error）', () => {
    const failures: string[] = [];
    for (const [path, doc] of Object.entries(sceneModules)) {
      for (const d of validateSceneDocument(doc)) {
        if (d.severity === 'error') failures.push(`${path} ${d.path} ${d.code} ${d.message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('场景文件的 id 全局唯一（跨场景引用靠它）', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const [path, doc] of Object.entries(sceneModules)) {
      const id = (doc as { id?: string }).id;
      if (id === undefined) continue;
      const prev = seen.get(id);
      if (prev !== undefined) dups.push(`${id}：${prev} 与 ${path}`);
      else seen.set(id, path);
    }
    expect(dups).toEqual([]);
  });
});
