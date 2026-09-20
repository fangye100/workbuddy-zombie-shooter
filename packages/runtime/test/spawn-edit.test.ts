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
  readTransformValues,
  findNode,
  formatAuthorEdit,
  SPAWN_RADIUS_MAX,
  SPAWN_COUNT_MAX,
  type SpawnEdit,
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
    store.confirmSave(snap.doc, snap.lastEditId);
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

    store.confirmSave(snap.doc, snap.lastEditId); // 只提交快照（radius = r0+0.5）
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
    store.confirmSave(snap.doc, snap.lastEditId);
    // 磁盘有这一笔，工作副本没有 —— 两者不一致，dirty 必须如实为真，不能数栈为 0 就说干净
    expect(store.dirty).toBe(true);
    expect(readSpawnField(store.document, id, 'radius')).toBeCloseTo(r0, 6);
  });

  /**
   * 复审 P2-3：等待期间「撤销 + 再编辑」—— 栈长不变但栈里换了一条。
   * 按栈长出队会把**新编辑误删**（撤销历史没了），必须把确认范围记在编辑身份上。
   */
  it('保存竞态边界：发送 2 → 撤销 → 改成 3 → 确认保存，3 的撤销记录不能被误删', () => {
    const store = new SpawnEditStore(fixture());
    const id = firstSpawn(store.document);
    const r0 = readSpawnField(store.document, id, 'radius')!;

    store.set(id, 'radius', r0 + 0.5); // 发送 radius 2
    const snap = store.beginSave();
    store.undo(); // 撤销了刚发送的那一步
    store.set(id, 'radius', r0 + 1.5); // 再改成 3（新的编辑身份）
    store.confirmSave(snap.doc, snap.lastEditId);

    // 3 仍是未保存（工作副本 3，已提交快照 2）
    expect(store.dirty).toBe(true);
    expect(readSpawnField(store.document, id, 'radius')).toBeCloseTo(r0 + 1.5, 6);
    // 🔴 且撤销栈里**必须还有这一条** —— 按栈长出队时它被误删了，撤销历史丢了
    expect(store.undoDepth).toBe(1);
    store.undo();
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
    const edit: SpawnEdit = { kind: 'spawn', id: 1, field: 'radius', nodeId: id, from: before, to: before + 1.5 };
    expect(applySpawnEdit(doc, edit).ok).toBe(true);
    expect(readSpawnField(doc, id, 'radius')).toBeCloseTo(before + 1.5, 6);
    expect(applySpawnEdit(doc, invertSpawnEdit(edit)).ok).toBe(true);
    expect(readSpawnField(doc, id, 'radius')).toBe(before);
  });

  it('apply 到不存在的节点返回错误而不是抛异常（也不改任何东西）', () => {
    const doc = fixture();
    const snapshot = JSON.stringify(doc);
    const r = applySpawnEdit(doc, { kind: 'spawn', id: 1, field: 'radius', nodeId: 'nd_nope', from: 0, to: 5 });
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
    applySpawnEdit(copy, { kind: 'spawn', id: 1, field: 'count', nodeId: id, from: 0, to: 99 });
    expect(readSpawnField(doc, id, 'count')).not.toBe(99);
  });
});

// ---------------------------------------------------------------- 节点变换编辑（复审 B1）

/** 房间 1 的掩体：普通网格节点（有父节点、父带平移）——"视口拖拽写回"的真实形态 */
const COVER = 'nd_f1r0_cv0';

describe('TransformEdit —— 视口变换写回文档（复审 B1）', () => {
  it('一次拖拽 = 一条编辑：三个位置分量一起改、撤销一起退', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const before = readTransformValues(store.document, COVER, ['posX', 'posY', 'posZ'])!;
    const r = store.setTransform(COVER, { posX: -5, posY: 0.9, posZ: -3.5 });
    expect(r.ok).toBe(true);
    expect(store.undoDepth).toBe(1); // 不是 3：整条拖拽是一条编辑
    expect(store.dirty).toBe(true);
    expect(readTransformValues(store.document, COVER, ['posX', 'posY', 'posZ'])).toEqual({
      posX: -5, posY: 0.9, posZ: -3.5,
    });
    // 撤销一步回到起点（三个分量一起退）
    const undone = store.undo();
    expect(undone!.kind).toBe('transform');
    expect(readTransformValues(store.document, COVER, ['posX', 'posY', 'posZ'])).toEqual(before);
    expect(store.dirty).toBe(false);
  });

  it('只改动写过的分量：同节点的其它分量与其它节点一个字节都不动', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const otherBefore = JSON.stringify(findNode(store.document, 'nd_f1r0_cv1'));
    const rotBefore = JSON.stringify(findNode(store.document, COVER)!.transform.rotation);
    store.setTransform(COVER, { posY: 1.4 });
    expect(JSON.stringify(findNode(store.document, 'nd_f1r0_cv1'))).toBe(otherBefore);
    expect(JSON.stringify(findNode(store.document, COVER)!.transform.rotation)).toBe(rotBefore);
    // 差异路径只有一条，且落在 position 的 y 分量上
    const paths = changedPathsOnly(store.committedDocument, store.document);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('transform');
    expect(paths[0]).toContain('1');
  });

  it('缩放写三分量（等比是无解约束，写单分量会造出隐藏的非等比）', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    expect(store.setTransform(COVER, { scale: 2.5 }).ok).toBe(true);
    expect(findNode(store.document, COVER)!.transform.scale).toEqual([2.5, 2.5, 2.5]);
    const paths = changedPathsOnly(store.committedDocument, store.document);
    expect(paths).toHaveLength(3); // x/y/z 三个分量都变了
  });

  it('拖回原处（值没变）→ 不记编辑、不进撤销栈、不弄脏文档', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const cur = readTransformValues(store.document, COVER, ['posX', 'posY', 'posZ'])!;
    const r = store.setTransform(COVER, cur);
    expect(r.ok).toBe(false);
    expect(r.edit).toBeNull();
    expect(store.undoDepth).toBe(0);
    expect(store.dirty).toBe(false);
  });

  it('越界值被拒绝：位置 ±500m 之外、缩放 ≤0 或 >100（不写进文件）', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const snapshot = JSON.stringify(store.document);
    expect(store.setTransform(COVER, { posX: 1e6 }).ok).toBe(false);
    expect(store.setTransform(COVER, { posY: Number.NaN }).ok).toBe(false);
    expect(store.setTransform(COVER, { scale: 0 }).ok).toBe(false);
    expect(store.setTransform(COVER, { scale: 1e3 }).ok).toBe(false);
    expect(JSON.stringify(store.document)).toBe(snapshot); // 全部拒绝 → 文档未被碰过
    expect(store.undoDepth).toBe(0);
  });

  it('不存在的节点 → 报错拒绝（不抛异常、不改文档）', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const snapshot = JSON.stringify(store.document);
    const r = store.setTransform('nd_nope', { posX: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).not.toBeNull();
    expect(JSON.stringify(store.document)).toBe(snapshot);
  });

  it('两条命令族共用一条撤销栈（LIFO 跨族正确）', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const sp = firstSpawn(doc);
    const radius0 = readSpawnField(store.document, sp, 'radius')!;
    const pos0 = readTransformValues(store.document, COVER, ['posX'])!;
    expect(store.set(sp, 'radius', radius0 + 2).ok).toBe(true);
    expect(store.setTransform(COVER, { posX: 42 }).ok).toBe(true);
    // 后进先出：先退变换，再退 radius
    expect(store.undo()!.kind).toBe('transform');
    expect(readTransformValues(store.document, COVER, ['posX'])).toEqual(pos0);
    expect(readSpawnField(store.document, sp, 'radius')).toBeCloseTo(radius0 + 2, 6);
    expect(store.undo()!.kind).toBe('spawn');
    expect(readSpawnField(store.document, sp, 'radius')).toBeCloseTo(radius0, 6);
    expect(store.dirty).toBe(false);
  });

  it('formatAuthorEdit：两条命令族都能给出一句话描述（UI 不自己拼字段名）', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const sp = firstSpawn(doc);
    const a = store.set(sp, 'count', 7);
    expect(formatAuthorEdit(a.edit!)).toContain('生成数量');
    const b = store.setTransform(COVER, { posY: 1.1, scale: 1.2 });
    const line = formatAuthorEdit(b.edit!);
    expect(line).toContain('位置 Y');
    expect(line).toContain('统一缩放');
  });

  it('变换编辑随保存一起提交：confirmSave 后 dirty 归假、committed 含新值', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    store.setTransform(COVER, { posZ: -2.25 });
    const snap = store.beginSave();
    expect(findNode(snap.doc, COVER)!.transform.position[2]).toBeCloseTo(-2.25, 6);
    store.confirmSave(snap.doc, snap.lastEditId);
    expect(store.dirty).toBe(false);
    expect(findNode(store.committedDocument, COVER)!.transform.position[2]).toBeCloseTo(-2.25, 6);
    expect(changedPathsOnly(store.committedDocument, store.document)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- 旋转（复审 codex/Copilot P1）

describe('TransformEdit —— 旋转（四元数）必须能持久化', () => {
  /** 绕 Y 轴 90° 的规范四元数 */
  const YAW90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2] as const;

  it('纯旋转拖拽 = 一条编辑，且写进文档的是那条四元数', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    // 只有旋转、没有位置/缩放改动 —— 旧实现只看标量分量，这种拖拽会被当成"值没有变化"
    const r = store.setTransform(COVER, { rotation: YAW90 });
    expect(r.ok).toBe(true);
    expect(store.undoDepth).toBe(1);
    expect(store.dirty).toBe(true);
    expect(findNode(store.document, COVER)!.transform.rotation).toEqual([...YAW90]);
    // 差异路径全部落在 rotation 上（位置/缩放一个字节都没动）。数组分量按元素出路径，
    // 所以这里是"变了几个分量就有几条"，不锁死条数以免夹具初值一变就假红。
    const paths = changedPathsOnly(store.committedDocument, store.document);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.includes('transform.rotation'))).toBe(true);
    // 撤销把旋转也退回去
    const undone = store.undo();
    expect(undone!.kind).toBe('transform');
    expect(findNode(store.document, COVER)!.transform.rotation).toEqual([0, 0, 0, 1]);
    expect(store.dirty).toBe(false);
  });

  it('位置 + 旋转一次提交：两条分量都写、撤销一起退', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    expect(store.setTransform(COVER, { posX: 7, rotation: YAW90 }).ok).toBe(true);
    const n = findNode(store.document, COVER)!;
    expect(n.transform.position[0]).toBe(7);
    expect(n.transform.rotation).toEqual([...YAW90]);
    store.undo();
    const back = findNode(store.document, COVER)!;
    expect(back.transform.position[0]).toBe(-6); // 夹具初值
    expect(back.transform.rotation).toEqual([0, 0, 0, 1]);
  });

  it('q 与 −q 是同一姿态 → 不算一次编辑（转一圈回到原处不该进撤销栈）', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const cur = findNode(store.document, COVER)!.transform.rotation;
    const negated = cur.map((x) => -x) as unknown as [number, number, number, number];
    const r = store.setTransform(COVER, { rotation: negated });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('值没有变化');
    expect(store.undoDepth).toBe(0);
  });

  it('非归一 / 非有限四元数被拒绝（不写进文件）', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const snapshot = JSON.stringify(store.document);
    expect(store.setTransform(COVER, { rotation: [0, 0, 0, 2] }).ok).toBe(false);
    expect(store.setTransform(COVER, { rotation: [0, 0, 0, Number.NaN] }).ok).toBe(false);
    expect(store.setTransform(COVER, { rotation: [0, 0, 0] as unknown as [number, number, number, number] }).ok).toBe(false);
    expect(JSON.stringify(store.document)).toBe(snapshot);
    expect(store.undoDepth).toBe(0);
  });

  it('formatAuthorEdit 会写出旋转（面板状态行不吞掉这条改动）', () => {
    const doc = fixture();
    const store = new SpawnEditStore(doc);
    const r = store.setTransform(COVER, { rotation: YAW90 });
    expect(formatAuthorEdit(r.edit!)).toContain('旋转');
  });
});
