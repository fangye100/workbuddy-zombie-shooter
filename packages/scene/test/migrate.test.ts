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
  registerSceneMigrations,
  runMigrationChain,
  type MigrationStep,
} from '../src/migrate';
import {
  SCHEMA_VERSION,
  createEmptySceneDocument,
  defaultEnvironment,
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

describe('migrateV1ToV2 · S2a userData 转正', () => {
  beforeEach(() => {
    clearMigrations();
    registerSceneMigrations();
  });
  afterEach(() => clearMigrations());

  /** 造一个 v1 假文档：天空（background+category）与角色（ao+bob+category）两类典型节点 */
  function v1Doc(): Record<string, unknown> {
    const mesh = (extra: Record<string, unknown>): Record<string, unknown> => ({
      kind: 'MeshRenderer',
      enabled: true,
      source: { type: 'builtin', shape: 'box', params: [1, 1, 1] },
      materials: [],
      visible: true,
      layer: 0,
      importScale: 1,
      ...extra,
    });
    return {
      schemaVersion: 1,
      id: 'sc_v1',
      name: '转正测试',
      act: null,
      environment: defaultEnvironment(),
      editorCamera: { target: [0, 1, 0], distance: 8, yaw: 0.6, elevation: 0.45 },
      entryCamera: null,
      dependencies: [],
      nodes: [
        {
          id: 'nd_sky',
          name: 'Sky',
          parent: null,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          visible: true,
          pickable: false,
          components: [mesh({})],
          prefab: null,
          userData: { background: true, category: '环境' },
        },
        {
          id: 'nd_char',
          name: 'Char',
          parent: null,
          transform: { position: [0, 0.84, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          visible: true,
          pickable: true,
          components: [mesh({})],
          prefab: null,
          userData: { aoMin: -0.84, aoMax: 0.84, category: '角色', bob: 1.2 },
        },
      ],
      meta: {},
    };
  }

  it('v1 → v2：userData 的 bob/ao*/background 提到 MeshRenderer，category 提到节点', () => {
    const r = migrateToLatest(v1Doc());
    expect(r.from).toBe(1);
    expect(r.to).toBe(2);
    expect(r.applied).toEqual(['userdata-to-schema']);

    const nodes = (r.doc as unknown as { nodes: Array<Record<string, any>> }).nodes;
    const sky = nodes.find((n) => n.id === 'nd_sky')!;
    const char = nodes.find((n) => n.id === 'nd_char')!;

    expect(sky.category).toBe('环境');
    expect(sky.userData).toBeUndefined();
    expect(sky.components.find((c: any) => c.kind === 'MeshRenderer').background).toBe(true);

    expect(char.category).toBe('角色');
    expect(char.userData).toBeUndefined();
    const charMesh = char.components.find((c: any) => c.kind === 'MeshRenderer');
    expect(charMesh.bob).toBe(1.2);
    expect(charMesh.aoMin).toBe(-0.84);
    expect(charMesh.aoMax).toBe(0.84);
  });

  it('迁移后文档仍能通过校验（转正不引入 error）', () => {
    const r = migrateToLatest(v1Doc());
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('已转正的 v2 文档再跑迁移链 → 不重复应用（幂等）', () => {
    const once = migrateToLatest(v1Doc());
    const twice = migrateToLatest(once.doc as unknown as Record<string, unknown>);
    expect(twice.applied).toEqual([]);
    expect(twice.from).toBe(2);
    expect(twice.to).toBe(2);
  });
});
