import { describe, it, expect } from 'vitest';
import type { SceneDocument } from '@aether/scene';
import { SpawnEditStore, listSpawnPoints } from '../src/spawn-edit';
import { captureInitialScatter, compareScatter, describeDelta } from '../src/spawn-ab';
import { changedPathsOnly } from '../src/doc-diff';

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function fixture(): SceneDocument {
  const key = Object.keys(MODULES)[0]!;
  return JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
}

const SEED = 7;

/** 已触发（玩家出生房间内）的刷怪点：初始散布只有对它们才有意义 */
function triggeredSeeds(doc: SceneDocument): string[] {
  const fp = captureInitialScatter(doc, { seed: SEED });
  if (fp.error !== null) throw new Error(`夹具指纹失败：${fp.error}`);
  return fp.spawns.filter((s) => s.spawned > 0).map((s) => s.nodeId);
}

describe('captureInitialScatter —— 初始散布指纹', () => {
  it('装载成功，刷怪点一一对应，未进入的房间 spawned = 0', () => {
    const doc = fixture();
    const fp = captureInitialScatter(doc, { seed: SEED });
    expect(fp.error).toBeNull();
    expect(fp.spawns.length).toBe(listSpawnPoints(doc).length);
    // 房间 1 = 5+4+3 = 12 只（与 session.test 的触发断言一致），房间 3 未进入 → 0
    expect(fp.npcCount).toBe(12);
    expect(fp.spawns.filter((s) => s.spawned > 0).length).toBeGreaterThan(0);
    expect(fp.spawns.filter((s) => s.spawned === 0).length).toBeGreaterThan(0);
  });

  it('同种子两次捕获逐位一致（A/B 的前提）', () => {
    const a = captureInitialScatter(fixture(), { seed: SEED });
    const b = captureInitialScatter(fixture(), { seed: SEED });
    expect(b.spawns).toEqual(a.spawns);
  });

  it('不同种子得到不同散布（否则 A/B 就是在比同一份数据）', () => {
    const a = captureInitialScatter(fixture(), { seed: 1 });
    const b = captureInitialScatter(fixture(), { seed: 2 });
    expect(b.spawns).not.toEqual(a.spawns);
  });

  it('失败不抛：缺 NavZone 的场景返回 error 而不是假指纹', () => {
    const doc = fixture();
    doc.nodes = doc.nodes.filter((n) => !n.components.some((c) => c.kind === 'NavZone'));
    const fp = captureInitialScatter(doc, { seed: SEED });
    expect(fp.error).not.toBeNull();
    expect(fp.spawns).toEqual([]);
  });
});

describe('compareScatter —— 改动是局部的', () => {
  it('🔴 改一处 radius：只有它变，其余刷怪点逐位不变', () => {
    const store = new SpawnEditStore(fixture());
    const target = triggeredSeeds(store.document)[0]!;
    const before = captureInitialScatter(store.document, { seed: SEED });

    const r0 = before.spawns.find((s) => s.nodeId === target)!.radius;
    expect(store.set(target, 'radius', r0 + 6).ok).toBe(true);
    const after = captureInitialScatter(store.document, { seed: SEED });

    const cmp = compareScatter(before, after);
    expect(cmp.usable).toBe(true);
    expect(cmp.sameSeed).toBe(true);
    expect(cmp.changedNodeIds).toEqual([target]);
    expect(cmp.unchangedNodeIds).not.toContain(target);
    expect(cmp.unchangedNodeIds.length).toBe(cmp.deltas.length - 1);
  });

  it('散布指标随 radius 单调变大（不是"变了"，而是"按预期方向变了"）', () => {
    const store = new SpawnEditStore(fixture());
    const target = triggeredSeeds(store.document)[0]!;
    const before = captureInitialScatter(store.document, { seed: SEED });
    const b0 = before.spawns.find((s) => s.nodeId === target)!;

    store.set(target, 'radius', b0.radius + 6);
    const after = captureInitialScatter(store.document, { seed: SEED });
    const d = compareScatter(before, after).deltas.find((x) => x.nodeId === target)!;

    expect(d.meanAfter).toBeGreaterThan(d.meanBefore);
    expect(d.maxAfter).toBeGreaterThan(d.maxBefore);
    expect(d.spawnedAfter).toBe(d.spawnedBefore); // 半径不改数量
  });

  it('改 count：实体数变化，其它刷怪点仍逐位不变', () => {
    const store = new SpawnEditStore(fixture());
    const target = triggeredSeeds(store.document)[0]!;
    const before = captureInitialScatter(store.document, { seed: SEED });
    const c0 = before.spawns.find((s) => s.nodeId === target)!.count;

    store.set(target, 'count', c0 + 4);
    const after = captureInitialScatter(store.document, { seed: SEED });
    const cmp = compareScatter(before, after);
    const d = cmp.deltas.find((x) => x.nodeId === target)!;

    expect(d.spawnedAfter).toBe(d.spawnedBefore + 4);
    expect(cmp.changedNodeIds).toEqual([target]);
    expect(cmp.npcAfter).toBe(cmp.npcBefore + 4);
  });

  it('撤销后指纹回到原样（A/B 也能证明撤销是真的）', () => {
    const store = new SpawnEditStore(fixture());
    const target = triggeredSeeds(store.document)[0]!;
    const before = captureInitialScatter(store.document, { seed: SEED });
    store.set(target, 'radius', before.spawns.find((s) => s.nodeId === target)!.radius + 5);
    store.undo();
    const after = captureInitialScatter(store.document, { seed: SEED });
    expect(after.spawns).toEqual(before.spawns);
    expect(compareScatter(before, after).changedNodeIds).toEqual([]);
  });

  it('撤销后文档差异也归零：未修改的作者字段一个没动', () => {
    const store = new SpawnEditStore(fixture());
    const target = triggeredSeeds(store.document)[0]!;
    store.set(target, 'radius', 9);
    store.set(target, 'count', 2);
    store.revertAll();
    expect(changedPathsOnly(store.committedDocument, store.document)).toEqual([]);
  });

  it('一侧装载失败时 usable=false，不给出"全都没变"的假结论', () => {
    const ok = captureInitialScatter(fixture(), { seed: SEED });
    const broken = { ...ok, error: 'boom', spawns: [] };
    const cmp = compareScatter(ok, broken);
    expect(cmp.usable).toBe(false);
    expect(cmp.deltas).toEqual([]);
  });

  it('describeDelta 标出改/未变，且带 before→after（不是只展示改后）', () => {
    const store = new SpawnEditStore(fixture());
    const target = triggeredSeeds(store.document)[0]!;
    const before = captureInitialScatter(store.document, { seed: SEED });
    store.set(target, 'radius', before.spawns.find((s) => s.nodeId === target)!.radius + 4);
    const after = captureInitialScatter(store.document, { seed: SEED });
    const cmp = compareScatter(before, after);

    const changed = describeDelta(cmp.deltas.find((d) => d.nodeId === target)!);
    const untouched = describeDelta(cmp.deltas.find((d) => d.nodeId !== target)!);
    expect(changed).toContain('已改');
    expect(changed).toContain('→');
    expect(untouched).toContain('未变');
  });
});
