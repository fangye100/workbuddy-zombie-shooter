import { describe, it, expect } from 'vitest';
import type { SceneDocument } from '@aether/scene';
import {
  SpawnEditStore,
  applySpawnEdit,
  cloneDocument,
  findSpawnComponent,
  invertSpawnEdit,
  listSpawnPoints,
  readSpawnField,
  validateSpawnValue,
  SPAWN_RADIUS_MAX,
  SPAWN_COUNT_MAX,
} from '../src/spawn-edit';
import { changedPathsOnly } from '../src/doc-diff';

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function fixture(): SceneDocument {
  const key = Object.keys(MODULES)[0]!;
  return JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
}

/** 第一个刷怪点（房间 1 内，玩家出生即触发） */
function firstSpawn(doc: SceneDocument): string {
  const s = listSpawnPoints(doc);
  if (s.length === 0) throw new Error('夹具里没有 SpawnPoint');
  return s[0]!.nodeId;
}

describe('validateSpawnValue —— 参数校验', () => {
  it('radius：拒绝 NaN / Infinity / 负数 / 超上界', () => {
    expect(validateSpawnValue('radius', NaN)).not.toBeNull();
    expect(validateSpawnValue('radius', Infinity)).not.toBeNull();
    expect(validateSpawnValue('radius', -1)).not.toBeNull();
    expect(validateSpawnValue('radius', SPAWN_RADIUS_MAX + 1)).not.toBeNull();
  });

  it('radius：0 与合法区间内通过', () => {
    expect(validateSpawnValue('radius', 0)).toBeNull();
    expect(validateSpawnValue('radius', 2.5)).toBeNull();
    expect(validateSpawnValue('radius', SPAWN_RADIUS_MAX)).toBeNull();
  });

  it('count：非整数一律拒绝（半个僵尸没有意义）', () => {
    expect(validateSpawnValue('count', 3.5)).not.toBeNull();
    expect(validateSpawnValue('count', 3)).toBeNull();
    expect(validateSpawnValue('count', 0)).toBeNull();
    expect(validateSpawnValue('count', SPAWN_COUNT_MAX + 1)).not.toBeNull();
    expect(validateSpawnValue('count', -1)).not.toBeNull();
  });
});

describe('SpawnEditStore —— 领域编辑命令', () => {
  it('构造即深拷贝：改工作副本不污染传入的文档', () => {
    const src = fixture();
    const store = new SpawnEditStore(src);
    const id = firstSpawn(src);
    const before = readSpawnField(src, id, 'radius');
    store.set(id, 'radius', 9);
    expect(readSpawnField(src, id, 'radius')).toBe(before);
    expect(store.dirty).toBe(true);
  });

  it('listSpawnPoints 摘要与文档字段一致', () => {
    const doc = fixture();
    const list = listSpawnPoints(doc);
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(readSpawnField(doc, s.nodeId, 'radius')).toBe(s.radius);
      expect(readSpawnField(doc, s.nodeId, 'count')).toBe(s.count);
    }
  });

  it('set 改 radius：工作副本变了，已提交版本没变', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const before = readSpawnField(store.document, id, 'radius')!;
    expect(store.set(id, 'radius', before + 3).ok).toBe(true);
    expect(readSpawnField(store.document, id, 'radius')).toBeCloseTo(before + 3, 6);
    expect(readSpawnField(store.committedDocument, id, 'radius')).toBe(before);
  });

  it('🔴 保存前自检：一次编辑只产生一条差异路径（未消费组件与无关字段一个没动）', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const before = readSpawnField(store.document, id, 'radius')!;
    const r = store.set(id, 'radius', before + 2);
    expect(r.ok).toBe(true);

    const paths = changedPathsOnly(store.committedDocument, store.document);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^nodes\[\d+\]\.components\[\d+\]\.radius$/);
  });

  it('undo 精确回到原值，差异归零', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const before = readSpawnField(store.document, id, 'radius')!;
    store.set(id, 'radius', before + 4);
    const undone = store.undo();
    expect(undone).not.toBeNull();
    expect(undone!.from).toBe(before);
    expect(readSpawnField(store.document, id, 'radius')).toBe(before);
    expect(changedPathsOnly(store.committedDocument, store.document)).toEqual([]);
    expect(store.dirty).toBe(false);
  });

  it('多步撤销按后进先出；栈空后 undo 返回 null', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const r0 = readSpawnField(store.document, id, 'radius')!;
    store.set(id, 'radius', r0 + 1);
    store.set(id, 'radius', r0 + 2);
    expect(store.undoDepth).toBe(2);
    expect(store.undo()!.from).toBeCloseTo(r0 + 1, 6);
    expect(readSpawnField(store.document, id, 'radius')).toBeCloseTo(r0 + 1, 6);
    expect(store.undo()).not.toBeNull();
    expect(store.undo()).toBeNull();
    expect(store.undoDepth).toBe(0);
  });

  it('revertAll 一次清空，返回撤了几步', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const r0 = readSpawnField(store.document, id, 'radius')!;
    store.set(id, 'radius', r0 + 1);
    store.set(id, 'count', 7);
    expect(store.revertAll()).toBe(2);
    expect(changedPathsOnly(store.committedDocument, store.document)).toEqual([]);
  });

  it('commit 后 dirty 归零，已提交版本追上工作副本', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const r0 = readSpawnField(store.document, id, 'radius')!;
    store.set(id, 'radius', r0 + 5);
    const snap = store.beginSave();
    store.confirmSave(snap.doc, snap.editsIncluded);
    expect(store.dirty).toBe(false);
    expect(readSpawnField(store.committedDocument, id, 'radius')).toBeCloseTo(r0 + 5, 6);
    // commit 之后再来一次编辑，差异仍然只有一条（基线已经前移）
    store.set(id, 'radius', r0 + 6);
    expect(changedPathsOnly(store.committedDocument, store.document)).toHaveLength(1);
  });

  /**
   * 保存竞态（复审 #1 的验收场景）：
   * 「发送 radius 2 → 等待写盘期间改成 3 → 保存返回后，3 仍为未保存修改」。
   * 曾经"保存返回 = 提交当前工作副本"，把快照之后的编辑一并标记为已保存并清空撤销栈 ——
   * 未落盘的数据被说成落了盘。
   */
  it('保存竞态：快照之后的编辑不被吞 —— 仍是未保存，且可撤销', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const r0 = readSpawnField(store.document, id, 'radius')!;

    store.set(id, 'radius', r0 + 0.5); // 相当于"发送 radius 2"
    const snap = store.beginSave(); // 序列化的是 radius = r0+0.5
    store.set(id, 'radius', r0 + 1.5); // 等待写盘期间作者改成 3

    store.confirmSave(snap.doc, snap.editsIncluded); // 只提交快照（radius = r0+0.5）
    // 🔴 关键断言：3（r0+1.5）仍是未保存修改
    expect(store.dirty).toBe(true);
    expect(readSpawnField(store.document, id, 'radius')).toBeCloseTo(r0 + 1.5, 6);
    expect(readSpawnField(store.committedDocument, id, 'radius')).toBeCloseTo(r0 + 0.5, 6);
    // 且能撤销回来（撤销栈只保留了快照之后的那一步）
    expect(store.undoDepth).toBe(1);
    store.undo();
    expect(readSpawnField(store.document, id, 'radius')).toBeCloseTo(r0 + 0.5, 6);
    expect(store.dirty).toBe(false);
  });

  it('保存竞态边界：等待期间撤销了已发送的编辑，dirty 也要如实为真', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const r0 = readSpawnField(store.document, id, 'radius')!;

    store.set(id, 'radius', r0 + 0.5);
    const snap = store.beginSave();
    store.undo(); // 快照之后的瞬间作者反悔，撤销了刚发出去的那一步
    store.confirmSave(snap.doc, snap.editsIncluded);
    // 磁盘有这一笔，工作副本没有 —— 两者不一致，dirty 必须如实为真，不能数栈为 0 就说干净
    expect(store.dirty).toBe(true);
    expect(readSpawnField(store.document, id, 'radius')).toBeCloseTo(r0, 6);
  });

  it('拒绝：节点不存在 / 值非法 / 值没变化，且只有成功才进撤销栈', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const r0 = readSpawnField(store.document, id, 'radius')!;

    expect(store.set('nd_not_exist', 'radius', 3).ok).toBe(false);
    expect(store.set(id, 'radius', Number.NaN).ok).toBe(false);
    expect(store.set(id, 'radius', r0).ok).toBe(false); // 值没变化
    expect(store.undoDepth).toBe(0);

    expect(store.set(id, 'radius', r0 + 1).ok).toBe(true);
    expect(store.undoDepth).toBe(1);
  });

  it('reload 换场景后旧编辑与撤销栈一起丢弃', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    store.set(id, 'radius', 12);
    store.reload(fixture());
    expect(store.dirty).toBe(false);
    expect(readSpawnField(store.document, id, 'radius')).not.toBe(12);
  });
});

describe('applySpawnEdit / invertSpawnEdit —— 纯函数', () => {
  it('apply 只写目标字段，invert 是它自己的逆', () => {
    const doc = fixture();
    const id = firstSpawn(doc);
    const before = readSpawnField(doc, id, 'radius')!;
    const edit = { field: 'radius' as const, nodeId: id, from: before, to: before + 1.5 };
    expect(applySpawnEdit(doc, edit).ok).toBe(true);
    expect(readSpawnField(doc, id, 'radius')).toBeCloseTo(before + 1.5, 6);
    expect(applySpawnEdit(doc, invertSpawnEdit(edit)).ok).toBe(true);
    expect(readSpawnField(doc, id, 'radius')).toBe(before);
  });

  it('apply 到不存在的节点返回错误而不是抛异常（也不改任何东西）', () => {
    const doc = fixture();
    const snapshot = JSON.stringify(doc);
    const r = applySpawnEdit(doc, { field: 'radius', nodeId: 'nd_nope', from: 0, to: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).not.toBeNull();
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('findSpawnComponent 对非刷怪点节点返回 null', () => {
    const doc = fixture();
    const nonSpawn = doc.nodes.find((n) => !n.components.some((c) => c.kind === 'SpawnPoint'));
    expect(nonSpawn).toBeDefined();
    expect(findSpawnComponent(doc, nonSpawn!.id)).toBeNull();
  });

  it('cloneDocument 是深拷贝（嵌套组件互相独立）', () => {
    const doc = fixture();
    const copy = cloneDocument(doc);
    const id = firstSpawn(doc);
    applySpawnEdit(copy, { field: 'count', nodeId: id, from: 0, to: 99 });
    expect(readSpawnField(doc, id, 'count')).not.toBe(99);
  });
});
