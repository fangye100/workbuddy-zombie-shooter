/**
 * SceneGraph 测试（ADR-009：测试与被测代码同位）。
 *
 * 分四组：结构 / 变换传播 / 与 Document 互转 / 数学。
 * 数学单独测是因为**变换错了画面必定错**，而这类 bug 极难从截图定位。
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_NODES,
  SceneGraph,
  composeTransform,
  quatRotateVec3,
  trsToMat4,
  type TransformData,
} from '../src/graph';
import { createEmptySceneDocument, identityTransform } from '../src/document';

function t(over: Partial<TransformData> = {}): TransformData {
  return { ...identityTransform(), ...over };
}

/** 绕 Z 轴 90°（右手系，逆时针） */
const QUARTER_Z: TransformData['rotation'] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

// ---------------------------------------------------------------- 结构

describe('SceneGraph · 结构', () => {
  it('addNode 默认参数：根级、可见、可拾取、无组件', () => {
    const g = new SceneGraph();
    const id = g.addNode({ name: 'A' });

    const n = g.getNode(id);
    expect(n?.parent).toBeNull();
    expect(n?.visible).toBe(true);
    expect(n?.pickable).toBe(true);
    expect(n?.components).toEqual([]);
    expect(n?.depth).toBe(0);
  });

  it('子节点 depth = 父 + 1，多层链正确', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'A' });
    const b = g.addNode({ name: 'B', parent: a });
    const c = g.addNode({ name: 'C', parent: b });

    expect(g.getNode(a)?.depth).toBe(0);
    expect(g.getNode(b)?.depth).toBe(1);
    expect(g.getNode(c)?.depth).toBe(2);
  });

  it('childrenOf 按插入序', () => {
    const g = new SceneGraph();
    const root = g.addNode({ name: 'root' });
    const x = g.addNode({ name: 'x', parent: root });
    const y = g.addNode({ name: 'y', parent: root });
    const z = g.addNode({ name: 'z', parent: root });

    expect(g.childrenOf(root)).toEqual([x, y, z]);
    expect(g.roots()).toEqual([root]);
  });

  it('removeNode 连带删子孙（孤儿节点没有父级，变换无解，不能留）', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'A' });
    const b = g.addNode({ name: 'B', parent: a });
    g.addNode({ name: 'C', parent: b });

    expect(g.removeNode(a)).toBe(true);
    expect(g.size).toBe(0);
    expect(g.getNode(b)).toBeNull();
  });

  it('removeNode 不存在的 id → false，不抛', () => {
    const g = new SceneGraph();
    expect(g.removeNode('nope')).toBe(false);
  });

  it('descendantsOf 是深度优先且不含自己', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'A' });
    const b = g.addNode({ name: 'B', parent: a });
    const c = g.addNode({ name: 'C', parent: a });
    const d = g.addNode({ name: 'D', parent: b });

    expect(g.descendantsOf(a)).toEqual([b, d, c]);
  });

  it('reparent：提到根 / 换父，depth 重算', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'A' });
    const b = g.addNode({ name: 'B', parent: a });
    const c = g.addNode({ name: 'C' });

    g.reparent(b, c);
    expect(g.getNode(b)?.parent).toBe(c);
    expect(g.getNode(b)?.depth).toBe(1);

    g.reparent(b, null);
    expect(g.getNode(b)?.parent).toBeNull();
    expect(g.getNode(b)?.depth).toBe(0);
  });

  it('🔴 reparent 成环 → 抛错（把自己挂到子孙下会让变换传播死循环）', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'A' });
    const b = g.addNode({ name: 'B', parent: a });

    expect(() => g.reparent(a, b)).toThrow(/成环/);
  });

  it('reparent 到自己 → 抛错', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'A' });
    expect(() => g.reparent(a, a)).toThrow();
  });

  it('addNode 父级不存在 → 抛错（不能造出悬空引用）', () => {
    const g = new SceneGraph();
    expect(() => g.addNode({ name: 'A', parent: 'ghost' })).toThrow(/父节点不存在/);
  });

  it('🔴 超过 MAX_NODES 抛错，不静默丢弃（静默丢弃表现为"第 65 个物件神秘消失"）', () => {
    const g = new SceneGraph();
    for (let i = 0; i < MAX_NODES; i += 1) g.addNode({ name: `n${i}` });
    expect(g.size).toBe(MAX_NODES);
    expect(g.capacity).toBe(0);

    expect(() => g.addNode({ name: 'overflow' })).toThrow(/上限/);
    expect(g.size).toBe(MAX_NODES); // 不能加进去
  });
});

// ---------------------------------------------------------------- 变换传播

describe('SceneGraph · 变换传播', () => {
  it('根节点的 world = local', () => {
    const g = new SceneGraph();
    const a = g.addNode({ transform: { position: [1, 2, 3] } });
    g.updateWorldTransforms();

    expect(g.getNode(a)?.world.position).toEqual([1, 2, 3]);
  });

  it('父子位移叠加', () => {
    const g = new SceneGraph();
    const p = g.addNode({ transform: { position: [10, 0, 0] } });
    const c = g.addNode({ parent: p, transform: { position: [0, 5, 0] } });
    g.updateWorldTransforms();

    expect(g.getNode(c)?.world.position).toEqual([10, 5, 0]);
  });

  it('父级缩放作用于子的位移', () => {
    const g = new SceneGraph();
    const p = g.addNode({ transform: { scale: [2, 2, 2] } });
    const c = g.addNode({ parent: p, transform: { position: [1, 0, 0] } });
    g.updateWorldTransforms();

    expect(g.getNode(c)?.world.scale).toEqual([2, 2, 2]);
    expect(g.getNode(c)?.world.position[0]).toBeCloseTo(2, 6);
  });

  it('父级旋转作用于子的位移（90° 绕 Z：+x → +y）', () => {
    const g = new SceneGraph();
    const p = g.addNode({ transform: { rotation: QUARTER_Z } });
    const c = g.addNode({ parent: p, transform: { position: [1, 0, 0] } });
    g.updateWorldTransforms();

    const w = g.getNode(c)?.world.position;
    expect(w?.[0]).toBeCloseTo(0, 6);
    expect(w?.[1]).toBeCloseTo(1, 6);
    expect(w?.[2]).toBeCloseTo(0, 6);
  });

  it('三代链：缩放与旋转逐级累乘', () => {
    const g = new SceneGraph();
    const a = g.addNode({ transform: { scale: [2, 2, 2] } });
    const b = g.addNode({ parent: a, transform: { scale: [3, 3, 3] } });
    const c = g.addNode({ parent: b, transform: { position: [1, 0, 0] } });
    g.updateWorldTransforms();

    // scale 2 × 3 = 6；位移 1 × 6 = 6
    expect(g.getNode(c)?.world.scale).toEqual([6, 6, 6]);
    expect(g.getNode(c)?.world.position[0]).toBeCloseTo(6, 6);
  });

  it('updateWorldTransforms 幂等（连跑两次结果一致）', () => {
    const g = new SceneGraph();
    const p = g.addNode({ transform: { position: [1, 2, 3], rotation: QUARTER_Z } });
    const c = g.addNode({ parent: p, transform: { position: [4, 0, 0] } });

    g.updateWorldTransforms();
    const first = g.getNode(c)?.world.position;
    g.updateWorldTransforms();
    const second = g.getNode(c)?.world.position;

    expect(second).toEqual(first);
  });

  it('dirty 标记：结构变更/改变换置脏，update 后清掉', () => {
    const g = new SceneGraph();
    const a = g.addNode();
    expect(g.isDirty).toBe(true);

    g.updateWorldTransforms();
    expect(g.isDirty).toBe(false);

    g.setLocalTransform(a, { position: [9, 9, 9] });
    expect(g.isDirty).toBe(true);
  });

  it('worldMatrix 与 world 变换一致（位移落在第 4 列）', () => {
    const g = new SceneGraph();
    const a = g.addNode({ transform: { position: [3, 4, 5] } });
    g.updateWorldTransforms();

    const m = g.worldMatrix(a);
    expect(m[12]).toBeCloseTo(3, 6);
    expect(m[13]).toBeCloseTo(4, 6);
    expect(m[14]).toBeCloseTo(5, 6);
    expect(m[15]).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------- Document 互转

describe('SceneGraph · 与 Document 互转', () => {
  it('fromDocument 还原节点、层级与变换', () => {
    const doc = createEmptySceneDocument('测试场景');
    const g = SceneGraph.fromDocument(doc);
    // 空场景自带 Key Light + Main Camera —— 每个场景至少要有光和相机
    expect(g.size).toBe(2);
    expect(g.findByName('Key Light')).toHaveLength(1);
    expect(g.findByName('Main Camera')).toHaveLength(1);

    const a = g.addNode({ name: 'A', transform: { position: [1, 0, 0] } });
    g.addNode({ name: 'B', parent: a });
    g.updateWorldTransforms();

    const round = SceneGraph.fromDocument({
      ...doc,
      nodes: g.toNodes(),
    });
    expect(round.size).toBe(4);
    expect(round.getNode(a)?.name).toBe('A');
    expect(round.childrenOf(a).length).toBe(1);
  });

  it('🔴 toNodes 不吐派生量（world / depth 不落盘 —— 落了就是冗余真源）', () => {
    const g = new SceneGraph();
    g.addNode({ name: 'A' });
    g.updateWorldTransforms();

    for (const n of g.toNodes()) {
      expect(n).not.toHaveProperty('world');
      expect(n).not.toHaveProperty('depth');
    }
  });

  it('fromDocument 遇到悬空父级 → 抛错（不静默降级成根节点）', () => {
    const doc = createEmptySceneDocument('坏场景');
    expect(() =>
      SceneGraph.fromDocument({
        ...doc,
        nodes: [{ ...mkNode('orphan', 'ghost') }],
      }),
    ).toThrow(/不存在的父级/);
  });

  it('fromDocument 后 world 已算好（建图即传播，调用方不必手动 update）', () => {
    const doc = createEmptySceneDocument('t');
    const g = SceneGraph.fromDocument({
      ...doc,
      nodes: [
        mkNode('p', null, [10, 0, 0]),
        mkNode('c', 'p', [0, 5, 0]),
      ],
    });
    const c = g.findByName('c')[0];
    expect(g.getNode(c ?? '')?.world.position).toEqual([10, 5, 0]);
  });
});

function mkNode(
  name: string,
  parent: string | null,
  position: [number, number, number] = [0, 0, 0],
) {
  return {
    id: name,
    name,
    parent,
    transform: t({ position }),
    visible: true,
    pickable: true,
    components: [],
    prefab: null,
  };
}

// ---------------------------------------------------------------- ADR-014 快照

describe('SceneGraph · 快照与回滚', () => {
  it('snapshot 是深拷贝（Play 期改动不污染快照）', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'A', transform: { position: [1, 1, 1] } });
    const snap = g.snapshot();

    g.setLocalTransform(a, { position: [99, 99, 99] });
    g.updateWorldTransforms();

    const saved = snap.nodes[0];
    expect(saved?.transform.position).toEqual([1, 1, 1]);
  });

  it('restore 完整回滚（含结构变更：Play 期新建的节点要消失）', () => {
    const g = new SceneGraph();
    g.addNode({ name: 'A' });
    const snap = g.snapshot();

    g.addNode({ name: 'PlayTemp' });
    expect(g.size).toBe(2);

    g.restore(snap);
    expect(g.size).toBe(1);
    expect(g.findByName('PlayTemp')).toEqual([]);
    expect(g.findByName('A')).toHaveLength(1);
  });

  it('restore 后 depth 与 world 重算正确', () => {
    const g = new SceneGraph();
    const p = g.addNode({ name: 'p', transform: { position: [10, 0, 0] } });
    g.addNode({ name: 'c', parent: p, transform: { position: [0, 5, 0] } });
    g.updateWorldTransforms();
    const snap = g.snapshot();

    g.reparent(p, null);
    g.restore(snap);

    const c = g.findByName('c')[0] ?? '';
    expect(g.getNode(c)?.depth).toBe(1);
    expect(g.getNode(c)?.world.position).toEqual([10, 5, 0]);
  });
});

// ---------------------------------------------------------------- 查询

describe('SceneGraph · 查询', () => {
  it('pathOf 从根到叶的名字链', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'Root' });
    const b = g.addNode({ name: 'Mid', parent: a });
    const c = g.addNode({ name: 'Leaf', parent: b });

    expect(g.pathOf(c)).toEqual(['Root', 'Mid', 'Leaf']);
  });

  it('isEffectivelyVisible：父级隐藏则整棵子树不可见', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'A' });
    const b = g.addNode({ name: 'B', parent: a, visible: false });
    const c = g.addNode({ name: 'C', parent: b });

    expect(g.isEffectivelyVisible(a)).toBe(true);
    expect(g.isEffectivelyVisible(b)).toBe(false);
    expect(g.isEffectivelyVisible(c)).toBe(false); // 自己可见，但祖先不可见
  });

  it('traverse 深度优先，从头到尾覆盖全部节点', () => {
    const g = new SceneGraph();
    const a = g.addNode({ name: 'A' });
    const b = g.addNode({ name: 'B', parent: a });
    const c = g.addNode({ name: 'C', parent: a });
    const seen: string[] = [];
    g.traverse((n) => seen.push(n.name));

    expect(seen).toEqual(['A', 'B', 'C']);
    expect([a, b, c].every((id) => g.has(id))).toBe(true);
  });
});

// ---------------------------------------------------------------- 数学

describe('变换数学', () => {
  it('quatRotateVec3：绕 Z 转 90°，+x → +y', () => {
    const v = quatRotateVec3([1, 0, 0], QUARTER_Z);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[1]).toBeCloseTo(1, 6);
    expect(v[2]).toBeCloseTo(0, 6);
  });

  it('quatRotateVec3：单位四元数不动向量', () => {
    const v = quatRotateVec3([1, 2, 3], [0, 0, 0, 1]);
    expect(v[0]).toBeCloseTo(1, 6);
    expect(v[1]).toBeCloseTo(2, 6);
    expect(v[2]).toBeCloseTo(3, 6);
  });

  it('trsToMat4：单位变换 → 单位矩阵', () => {
    const m = trsToMat4(identityTransform(), new Float32Array(16));
    for (let i = 0; i < 16; i += 1) {
      const expectOne = i % 5 === 0; // 0,5,10,15
      expect(m[i]).toBeCloseTo(expectOne ? 1 : 0, 6);
    }
  });

  it('trsToMat4：缩放落在对角线上', () => {
    const m = trsToMat4(t({ scale: [2, 3, 4] }), new Float32Array(16));
    expect(m[0]).toBeCloseTo(2, 6);
    expect(m[5]).toBeCloseTo(3, 6);
    expect(m[10]).toBeCloseTo(4, 6);
  });

  it('trsToMat4：90° 绕 Z 把 +x 映射到 +y（列主序，第 0 列即 x 轴像）', () => {
    const m = trsToMat4(t({ rotation: QUARTER_Z }), new Float32Array(16));
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[1]).toBeCloseTo(1, 6);
    expect(m[2]).toBeCloseTo(0, 6);
  });

  it('composeTransform：不修改入参（返回写入 out）', () => {
    const parent = t({ position: [10, 0, 0] });
    const local = t({ position: [0, 5, 0] });
    const out = identityTransform();

    composeTransform(parent, local, out);

    expect(parent.position).toEqual([10, 0, 0]); // 入参未被改
    expect(local.position).toEqual([0, 5, 0]);
    expect(out.position).toEqual([10, 5, 0]);
  });

  it('composeTransform：旋转累乘（父 90° + 子 90° = 180°）', () => {
    const out = composeTransform(
      t({ rotation: QUARTER_Z }),
      t({ rotation: QUARTER_Z, position: [1, 0, 0] }),
      identityTransform(),
    );
    // 父先转：位移 (1,0,0) 经父旋转 → (0,1,0)
    expect(out.position[0]).toBeCloseTo(0, 6);
    expect(out.position[1]).toBeCloseTo(1, 6);
    // 合成旋转应为 180°：+x → -x
    const v = quatRotateVec3([1, 0, 0], out.rotation);
    expect(v[0]).toBeCloseTo(-1, 6);
  });
});
