/**
 * 迁移链测试（ADR-009：测试与被测代码同位）。
 *
 * 当前 SCHEMA_VERSION=1、注册表为空，所以测的是**骨架本身的行为**：
 * 版本判定、跳步拒绝、链断裂报错、迁移后必校验。
 * 等真出现 v2 时，这些用例一个都不用改，只需追加新的。
 *
 * 注册表是模块级单例 —— **每个用例前后必须 clearMigrations()**，
 * 否则用例之间会互相污染（这类 bug 表现为"单跑绿、全跑红"）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clearMigrations,
  listMigrations,
  migrateTo,
  migrateToLatest,
  needsMigration,
  registerMigration,
  runMigrationChain,
  type MigrationStep,
} from '../src/migrate';
import {
  SCHEMA_VERSION,
  createEmptySceneDocument,
  validateSceneDocument,
} from '../src/document';

/** 造一个指定版本的假文档（绕过类型，迁移链要能处理"历史/损坏"输入） */
function docAt(version: number): Record<string, unknown> {
  const base = createEmptySceneDocument('测试') as unknown as Record<string, unknown>;
  return { ...base, schemaVersion: version };
}

/** 一档什么都不做的迁移，只推版本号 */
function noopStep(from: number, name = `v${from}→v${from + 1}`): MigrationStep {
  return { from, to: from + 1, name, run: (d) => ({ ...d }) };
}

describe('registerMigration', () => {
  beforeEach(() => clearMigrations());
  afterEach(() => clearMigrations());

  it('🔴 跨版本直跳 → 抛错（会让中间版本的历史场景失去迁移路径）', () => {
    expect(() =>
      registerMigration({ from: 1, to: 3, name: 'skip', run: (d) => d }),
    ).toThrow(/跨且仅跨一个版本/);
  });

  it('🔴 同一 from 重复注册 → 抛错（静默覆盖最可怕）', () => {
    registerMigration(noopStep(1, 'a'));
    expect(() => registerMigration(noopStep(1, 'b'))).toThrow(/已注册过/);
  });

  it('注册后按 from 升序列出', () => {
    registerMigration(noopStep(2));
    registerMigration(noopStep(1));
    expect(listMigrations().map((m) => m.from)).toEqual([1, 2]);
  });

  it('clearMigrations 清空（用例隔离的关键）', () => {
    registerMigration(noopStep(1));
    clearMigrations();
    expect(listMigrations()).toEqual([]);
  });
});

describe('needsMigration / 版本判定', () => {
  beforeEach(() => clearMigrations());
  afterEach(() => clearMigrations());

  it('当前版本 → 不需要迁移', () => {
    expect(needsMigration(docAt(SCHEMA_VERSION))).toBe(false);
  });

  it('低于当前版本 → 需要迁移', () => {
    expect(needsMigration(docAt(SCHEMA_VERSION - 1))).toBe(true);
  });

  it('🔴 高于当前版本 → 抛错，绝不猜着降级加载', () => {
    expect(() => migrateToLatest(docAt(SCHEMA_VERSION + 1))).toThrow(/请升级/);
  });

  it('读不出 schemaVersion → 抛错（0 或缺失都算坏文件）', () => {
    expect(() => migrateToLatest({})).toThrow(/读不出 schemaVersion/);
    expect(() => migrateToLatest(null)).toThrow(/读不出 schemaVersion/);
    expect(() => migrateToLatest(docAt(0))).toThrow(/读不出 schemaVersion/);
  });
});

describe('migrateToLatest · 链路行为', () => {
  beforeEach(() => clearMigrations());
  afterEach(() => clearMigrations());

  it('已是最新版 → applied 为空，但仍会校验一遍', () => {
    const r = migrateToLatest(docAt(SCHEMA_VERSION));
    expect(r.applied).toEqual([]);
    expect(r.from).toBe(SCHEMA_VERSION);
    expect(r.to).toBe(SCHEMA_VERSION);
    expect(r.diagnostics).toBeInstanceOf(Array);
  });

  // 「迁移链断裂」不在这里测：当前 SCHEMA_VERSION=1，比它低的合法版本不存在
  // （v0 是"读不出版本"的坏文件，已在上面覆盖），构造不出"有历史版本要迁"的场景。
  // 该行为由下面 runMigrationChain 那组覆盖，等 SCHEMA_VERSION ≥ 2 时这里自动可测。

  it('注册了对应迁移 → 按顺序应用并推动版本号', () => {
    // 走 runMigrationChain 而非 migrateTo：后者不允许 target 超过 SCHEMA_VERSION
    // （编辑器不认识未来格式），而当前 SCHEMA_VERSION=1，多步链路只能这样测。
    const v1 = docAt(1);
    const seen: number[] = [];
    registerMigration({
      from: 1,
      to: 2,
      name: 'add-fog',
      run: (d) => {
        seen.push(1);
        return { ...d, fog: true };
      },
    });
    registerMigration({
      from: 2,
      to: 3,
      name: 'split-lights',
      run: (d) => {
        seen.push(2);
        return { ...d, lights: [] };
      },
    });

    const r = runMigrationChain(v1, 1, 3);

    expect(r.applied).toEqual(['add-fog', 'split-lights']);
    expect(seen).toEqual([1, 2]); // 严格按序
    expect(r.doc).toHaveProperty('fog', true);
    expect(r.doc).toHaveProperty('lights');
    expect(r.doc.schemaVersion).toBe(3);
  });

  it('迁移函数忘了推版本号 → 框架强制对齐（防止写漏）', () => {
    registerMigration({
      from: 1,
      to: 2,
      name: 'forgetful',
      run: (d) => ({ ...d, schemaVersion: 1 }), // 故意写漏
    });

    const r = runMigrationChain(docAt(1), 1, 2);
    expect(r.doc.schemaVersion).toBe(2);
  });

  it('迁移函数写坏了 → 迁移后的文档能被校验器抓到（迁移写错是常态，校验是唯一防线）', () => {
    registerMigration({
      from: 1,
      to: 2,
      name: 'corrupt',
      run: (d) => ({ ...d, nodes: 'not-an-array' }), // 故意写坏
    });

    const r = runMigrationChain(docAt(1), 1, 2);
    expect(validateSceneDocument(r.doc).some((x) => x.severity === 'error')).toBe(true);
  });

  it('迁移链断裂（中间缺一环）→ 报出缺哪一环', () => {
    registerMigration(noopStep(1)); // 有 v1→v2
    // 缺 v2→v3
    expect(() => runMigrationChain(docAt(1), 1, 3)).toThrow(/缺 v2 → v3/);
  });
});

describe('migrateTo · 指定目标版本', () => {
  beforeEach(() => clearMigrations());
  afterEach(() => clearMigrations());

  it('目标高于编辑器支持的版本 → 抛错', () => {
    expect(() => migrateTo(docAt(1), SCHEMA_VERSION + 1)).toThrow(/高于编辑器支持/);
  });

  it('🔴 向后迁移 → 抛错（只能向前，绝不猜着降级）', () => {
    registerMigration(noopStep(1));
    expect(() => migrateTo(docAt(2), 1)).toThrow(/不能向后迁移/);
  });

  it('目标 = 当前版本 → 不应用任何迁移', () => {
    registerMigration(noopStep(1));
    const r = migrateTo(docAt(SCHEMA_VERSION), SCHEMA_VERSION);
    expect(r.applied).toEqual([]);
    expect(r.diagnostics).toBeInstanceOf(Array);
  });
});
