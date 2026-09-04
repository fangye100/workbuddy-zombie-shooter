/**
 * 场景格式迁移链（ADR-013）。S1。
 *
 * ## 为什么现在就建，哪怕当前只有 v1、一个迁移都没有
 *
 * 因为**迁移链的代价随已落盘场景数量增长**。
 * 现在 `assets/scenes/` 一个文件都没有，schema 随便改；
 * 等 S2 保存功能上线、场景文件铺开之后再补迁移链，
 * 每改一次 schema 都要回头手动修存量文件 —— 那才是真正的债。
 *
 * 现在建好骨架，将来加 v2 只是**追加一行 `registerMigration`**。
 *
 * ## 铁律
 *
 * 1. **只能向前，不能向后。** 遇到比当前更新的版本直接报错，
 *    绝不"尽力猜着降级" —— 猜错的场景比打不开的场景危险得多。
 * 2. **逐步迁移，不许跳步。** v1 → v3 必须走 v1→v2→v3。
 *    跨版本直跳的迁移函数会让"中间版本的历史场景"失去迁移路径。
 * 3. **链断了要立刻报。** 缺 v2→v3 这一环时，报"迁移链断裂"，
 *    而不是让 v2 的场景被静默当成最新版加载。
 * 4. **迁移完必须重新校验。** 迁移函数写错是常态，校验是唯一防线。
 */

import {
  SCHEMA_VERSION,
  validateSceneDocument,
  type SceneDiagnostic,
  type SceneDocument,
} from './document';

/** 一档迁移。`to` 必须等于 `from + 1` —— 不允许跨版本直跳 */
export interface MigrationStep {
  from: number;
  to: number;
  /** 迁移名，报错时用来定位是哪一环出的问题 */
  name: string;
  /**
   * 就地变换。**可以抛异常** —— 抛了说明这个场景没法迁，
   * 让调用方拿到明确错误，好过返回一个半残的文档。
   */
  run(doc: Record<string, unknown>): Record<string, unknown>;
}

/** 迁移结果。即便没做任何迁移，`doc` 也一定是校验过的 */
export interface MigrateResult {
  doc: SceneDocument;
  from: number;
  to: number;
  /** 按顺序应用过的迁移名。空数组 = 本来就是最新版 */
  applied: string[];
  /** 迁移后重新校验的诊断 */
  diagnostics: SceneDiagnostic[];
}

/**
 * 迁移注册表。键是 `from` 版本。
 * 目前为空 —— SCHEMA_VERSION 还是 1，没有历史要迁。
 */
const registry = new Map<number, MigrationStep>();

/** 注册一档迁移。**启动时调用**，重复的 `from` 直接抛（宁可崩也不要静默覆盖） */
export function registerMigration(step: MigrationStep): void {
  if (step.to !== step.from + 1) {
    throw new Error(
      `迁移 ${step.name} 必须跨且仅跨一个版本：${step.from} → ${step.to}。` +
        `跨版本直跳会让中间版本的历史场景失去迁移路径。`,
    );
  }
  const existing = registry.get(step.from);
  if (existing !== undefined) {
    throw new Error(
      `迁移 ${step.from} → ${step.to} 已注册过（${existing.name}），重复注册会静默覆盖。`,
    );
  }
  registry.set(step.from, step);
}

/** 清空注册表。测试用 —— 注册表是模块级单例，用例之间必须隔离 */
export function clearMigrations(): void {
  registry.clear();
}

/** 已注册的迁移（按 from 升序） */
export function listMigrations(): MigrationStep[] {
  return [...registry.values()].sort((a, b) => a.from - b.from);
}

/** 这个文档需要迁移吗（版本低于当前） */
export function needsMigration(doc: unknown): boolean {
  return readVersion(doc) < SCHEMA_VERSION;
}

/** 读出 schemaVersion。缺失或非数字返回 0 —— 0 会被当作"未知版本"报错 */
function readVersion(doc: unknown): number {
  if (typeof doc !== 'object' || doc === null) return 0;
  const v = (doc as { schemaVersion?: unknown }).schemaVersion;
  return typeof v === 'number' && Number.isInteger(v) ? v : 0;
}

/**
 * 迁移到最新版本。
 *
 * **不抛异常**（除版本回退这种明确的用户错误）：迁移链路上的问题
 * 变成 `diagnostics` 里的一条 error，调用方自行决定要不要加载。
 * 唯二抛错的是「版本比当前新」和「版本读不出来」—— 这两种情况
 * 我们没有任何合理的降级行为。
 */
export function migrateToLatest(doc: unknown): MigrateResult {
  const from = readVersion(doc);
  if (from === 0) {
    throw new Error(
      `读不出 schemaVersion（应为正整数）。这不是场景文件，或文件已损坏。`,
    );
  }
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `场景是 v${from}，但编辑器只认到 v${SCHEMA_VERSION}。` +
        `场景来自更新版本的编辑器，请升级后再打开 —— 绝不猜着降级加载。`,
    );
  }

  const { doc: migrated, applied } = runMigrationChain(doc as Record<string, unknown>, from, SCHEMA_VERSION);
  const diagnostics = validateSceneDocument(migrated);
  return {
    doc: migrated as unknown as SceneDocument,
    from,
    to: SCHEMA_VERSION,
    applied,
    diagnostics,
  };
}

/**
 * 执行迁移链（**纯执行，不做版本合法性判断**）。
 *
 * 单独抽出来是因为：版本合法性是"编辑器能不能开这个文件"的问题，
 * 而链执行是"怎么把 A 变成 B"的问题 —— 后者对批量重写存量文件的
 * 维护工具同样有用（它可以合法地指定任意 to）。
 * 抽开之后多步链路也能独立测试，不必等到 SCHEMA_VERSION 涨到 2。
 */
export function runMigrationChain(
  doc: Record<string, unknown>,
  from: number,
  to: number,
): { doc: Record<string, unknown>; applied: string[] } {
  let cur = doc;
  const applied: string[] = [];

  for (let v = from; v < to; v += 1) {
    const step = registry.get(v);
    if (step === undefined) {
      throw new Error(
        `迁移链断裂：缺 v${v} → v${v + 1}。` +
          `补一档 registerMigration({ from: ${v}, to: ${v + 1}, ... })。`,
      );
    }
    cur = step.run(cur);
    // 迁移函数必须自己把版本号推上去，这里强制对齐 —— 防止写漏
    cur.schemaVersion = step.to;
    applied.push(step.name);
  }

  return { doc: cur, applied };
}

/**
 * 迁移到指定版本。给"我就要停在 v2"这类维护场景用（如批量重写存量文件）。
 * 目标版本高于当前 SCHEMA_VERSION 时抛错 —— 编辑器不认识未来的格式。
 */
export function migrateTo(doc: unknown, target: number): MigrateResult {
  if (target > SCHEMA_VERSION) {
    throw new Error(`目标版本 v${target} 高于编辑器支持的 v${SCHEMA_VERSION}`);
  }
  const from = readVersion(doc);
  if (from > target) {
    throw new Error(`不能向后迁移：v${from} → v${target}`);
  }

  const { doc: migrated, applied } = runMigrationChain(doc as Record<string, unknown>, from, target);
  const diagnostics = validateSceneDocument(migrated);
  return { doc: migrated as unknown as SceneDocument, from, to: target, applied, diagnostics };
}
