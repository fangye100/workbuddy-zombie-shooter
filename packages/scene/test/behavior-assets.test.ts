/**
 * 资产目录行为的收集与自检（ADR-018 P1 的 "glob 注册" 验收）。
 *
 * 为什么必须有这个文件：ADR-018 R2 把 `assets/behaviors/*.ts` 定为 **Agent 的创作空间**。
 * 如果这个目录既不被 typecheck 收录、也不被任何测试收集，那它就是"三无区域"
 * —— Agent 往里丢任何东西都不会有反馈，等于没有契约。
 *
 * 本文件用 `import.meta.glob` 真收集该目录，并断言：
 *   ① 每个模块都是合法的 BehaviorModule（有 id / params / run）
 *   ② 全部能注册成功，且 id 不冲突
 *   ③ schema 自身一致（无 SCHEMA_INVALID）
 *   ④ 场景引用任一行为 id 都能 resolve 成功
 *
 * 注：vite 的 `import.meta.glob` 在 vitest 下可用（`scene-files.test.ts` 已有 `/assets/**` 先例）。
 */

import { describe, expect, it } from 'vitest';
import { BehaviorRegistry } from '../src/behavior';
import type { BehaviorModule } from '../src/behavior';

// 用 ** 而非 *：将来行为放进子目录（如 assets/behaviors/combat/*.ts）也能被收集，
// 单星会在那时静默漏掉整目录。
const modules = import.meta.glob('/assets/behaviors/**/*.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

/** 从 glob 结果里取出 BehaviorModule（兼容 default 导出与命名导出） */
function collectModules(): BehaviorModule<unknown>[] {
  const out: BehaviorModule<unknown>[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const candidates = [mod.default, ...Object.values(mod)];
    const hit = candidates.find(
      (c) =>
        c !== null &&
        typeof c === 'object' &&
        typeof (c as { id?: unknown }).id === 'string' &&
        Array.isArray((c as { params?: unknown }).params) &&
        typeof (c as { run?: unknown }).run === 'function',
    );
    if (hit !== undefined) out.push(hit as BehaviorModule<unknown>);
    else throw new Error(`[behavior] ${path} 未导出合法的 BehaviorModule（缺 id / params / run）`);
  }
  return out;
}

describe('assets/behaviors · 目录收集', () => {
  it('目录非空——至少有一个行为（否则本测试失去意义）', () => {
    expect(Object.keys(modules).length).toBeGreaterThan(0);
  });

  it('每个文件都能取到合法 BehaviorModule', () => {
    const list = collectModules();
    expect(list.length).toBe(Object.keys(modules).length);
    for (const m of list) {
      expect(typeof m.id).toBe('string');
      expect(m.id.length).toBeGreaterThan(0);
      expect(Array.isArray(m.params)).toBe(true);
      expect(typeof m.run).toBe('function');
    }
  });

  it('全部注册成功，无 rejected，无 id 冲突', () => {
    const reg = new BehaviorRegistry();
    const res = reg.registerAll(collectModules());
    expect(res.rejected).toEqual([]);
    expect(res.registered.length).toBe(collectModules().length);
    expect(reg.size).toBe(collectModules().length);
  });

  it('全部行为的 schema 自身一致（无 SCHEMA_INVALID）', () => {
    const reg = new BehaviorRegistry();
    reg.registerAll(collectModules());
    const invalid = reg.schemaDiagnostics.filter((d) => d.code === 'SCHEMA_INVALID');
    expect(invalid).toEqual([]);
  });

  it('任一行为 id 都能被 resolve 到（不是"注册了但查不到"）', () => {
    const reg = new BehaviorRegistry();
    reg.registerAll(collectModules());
    for (const m of collectModules()) {
      const r = reg.resolve(m.id, {});
      expect(r.def).not.toBeNull();
      expect(r.def!.id).toBe(m.id);
      // 零参数行为会提示 BEHAVIOR_NO_PARAMS，其余不应有"未找到/非法"类诊断
      const fatal = r.diagnostics.filter(
        (d) => d.code === 'BEHAVIOR_NOT_FOUND' || d.code === 'BEHAVIOR_DEF_INVALID',
      );
      expect(fatal).toEqual([]);
    }
  });

  it('行为的 run 可被调起而不抛（冒烟执行）', () => {
    const reg = new BehaviorRegistry();
    reg.registerAll(collectModules());
    for (const m of collectModules()) {
      const r = reg.resolve<{ log: string[] }>(m.id, {});
      const ctx = { log: [] as string[] };
      expect(() => r.def!.run(ctx, r.params)).not.toThrow();
    }
  });
});
