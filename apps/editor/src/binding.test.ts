import { describe, expect, it } from 'vitest';
import {
  inheritPrimitives,
  matchBindings,
  reversePathScore,
  summarizeMatch,
  type MeshNodeBinding,
  type MeshNodeStub,
  type PrimitiveBinding,
} from './binding';

/**
 * 换模型材质绑定继承的回归测试。
 * 场景源自用户需求：
 *   - extras 里的稳定 ID 是第一层防护；
 *   - artist 改名 / 删了又补回 mesh 导致 ID 丢失时，靠「leaf → root 反向路径」
 *     连续匹配段数判可信度，区分不同父分支下的同名 mesh；
 *   - 节点内部再到 primitive（材质槽）粒度逐个对：材质名 → 序号 → 顺序。
 */

function prim(key: string, index: number, materialId = 's0', visible = true): PrimitiveBinding {
  return { primitiveKey: key, primitiveIndex: index, materialId, override: null, visible };
}

function binding(nodeId: string, path: string[], prims: PrimitiveBinding[]): MeshNodeBinding {
  return { nodeId, nodePath: path, prims };
}

function stub(nodeId: string, path: string[], prims: { primitiveKey: string; primitiveIndex: number }[]): MeshNodeStub {
  return { nodeId, nodePath: path, prims };
}

describe('reversePathScore：从 leaf 往 root 数连续匹配段', () => {
  it('完全一致 = 路径长度；leaf 不同 = 0', () => {
    expect(reversePathScore(['Root', 'A', 'B'], ['Root', 'A', 'B'])).toBe(3);
    expect(reversePathScore(['Root', 'A', 'B'], ['Root', 'A', 'C'])).toBe(0);
  });

  it('中间改名只断那一段：leaf 与更上层仍然连续', () => {
    // 旧 ['Root','Arm','Hand']，新 ['Root','Arm2','Hand'] → 只有 leaf 匹配
    expect(reversePathScore(['Root', 'Arm2', 'Hand'], ['Root', 'Arm', 'Hand'])).toBe(1);
    // 新 ['Root','Arm','Hand','Finger'] vs 旧 ['Root','Arm','Hand'] → 比到旧路径耗尽
    expect(reversePathScore(['Root', 'Arm', 'Hand'], ['X', 'Arm', 'Hand'])).toBe(2);
  });
});

describe('inheritPrimitives：primitive 粒度三级匹配', () => {
  it('材质名 key 优先：顺序打乱也照 key 对上', () => {
    const oldPrims = [prim('身体', 0, 's1'), prim('盾牌', 1, 'i2')];
    const { prims, inheritedCount } = inheritPrimitives(oldPrims, [
      { primitiveKey: '盾牌', primitiveIndex: 0 },
      { primitiveKey: '身体', primitiveIndex: 1 },
    ]);
    expect(inheritedCount).toBe(2);
    expect(prims[0]!.materialId).toBe('i2');
    expect(prims[1]!.materialId).toBe('s1');
  });

  it('材质名丢了（#序号）→ 按 primitiveIndex 兜底', () => {
    const oldPrims = [prim('身体', 0, 's3'), prim('盾牌', 1, 's4')];
    const { prims, inheritedCount } = inheritPrimitives(oldPrims, [
      { primitiveKey: '#0', primitiveIndex: 0 },
      { primitiveKey: '#1', primitiveIndex: 1 },
    ]);
    expect(inheritedCount).toBe(2);
    expect(prims.map((p) => p!.materialId)).toEqual(['s3', 's4']);
  });

  it('key 与序号全变 → 按剩余顺序对齐；多出来的 primitive 返回 null', () => {
    const oldPrims = [prim('a', 7, 's1')];
    const { prims, inheritedCount } = inheritPrimitives(oldPrims, [
      { primitiveKey: 'x', primitiveIndex: 0 },
      { primitiveKey: 'y', primitiveIndex: 1 },
    ]);
    expect(inheritedCount).toBe(1);
    expect(prims[0]!.materialId).toBe('s1');
    expect(prims[1]).toBeNull();
  });

  it('override 深拷贝：继承来的覆盖不是同一份引用', () => {
    const o: PrimitiveBinding = { ...prim('a', 0, 's0'), override: { albedo: '#fff' } as never };
    const { prims } = inheritPrimitives([o], [{ primitiveKey: 'a', primitiveIndex: 0 }]);
    expect(prims[0]!.override).not.toBe(o.override);
    expect(prims[0]!.override).toEqual(o.override);
  });
});

describe('matchBindings · 第一层：nodeId 精确', () => {
  it('extras 稳定 ID：路径全变了也照 ID 继承（artist 改名/移动节点都不怕）', () => {
    const old = [binding('zb-7f', ['旧根', '旧父', '旧名'], [prim('a', 0, 'i5')])];
    const stubs = [stub('zb-7f', ['Root', 'NewParent', 'NewName'], [{ primitiveKey: 'a', primitiveIndex: 0 }])];
    const r = matchBindings(old, [], stubs);
    expect(r.report[0]!.how).toBe('id');
    expect(r.inherited[0]![0]!.materialId).toBe('i5');
  });

  it('auto-ID 撞车不接：换了完全不同的模型，auto-3 对 auto-3 但 leaf 名不同 → 不让第一层乱接', () => {
    const old = [binding('auto-3', ['Root', '身体'], [prim('a', 0, 'i9')])];
    const stubs = [stub('auto-3', ['Root', '炮管'], [{ primitiveKey: 'a', primitiveIndex: 0 }])];
    const r = matchBindings(old, [], stubs);
    expect(r.report[0]!.how).toBe('none');
    expect(r.inherited[0]).toBeNull();
  });
});

describe('matchBindings · 第二层：反向路径', () => {
  it('ID 丢了（mesh 删了重建）→ 同路径接住', () => {
    const old = [binding('auto-1', ['Root', 'Arm', 'Hand'], [prim('skin', 0, 'i1')])];
    const stubs = [stub('auto-9', ['Root', 'Arm', 'Hand'], [{ primitiveKey: 'skin', primitiveIndex: 0 }])];
    const r = matchBindings(old, [], stubs);
    expect(r.report[0]!.how).toBe('path');
    expect(r.report[0]!.score).toBe(3);
    expect(r.inherited[0]![0]!.materialId).toBe('i1');
  });

  it('中间节点改名：整链没全断，leaf 以上仍连续 → 接住', () => {
    const old = [binding('auto-1', ['Root', 'Arm', 'Hand'], [prim('skin', 0, 'i1')])];
    const stubs = [stub('auto-2', ['Root', 'Arm改', 'Hand'], [{ primitiveKey: 'skin', primitiveIndex: 0 }])];
    const r = matchBindings(old, [], stubs);
    expect(r.report[0]!.how).toBe('path');
    expect(r.report[0]!.score).toBe(1);
  });

  it('同名歧义：两个分支下都叫 Mesh_1，父链更完整的那个赢', () => {
    const old = [
      binding('auto-1', ['Root', '左臂', 'Mesh_1'], [prim('a', 0, 'i1')]),
      binding('auto-2', ['Root', '右臂', 'Mesh_1'], [prim('a', 0, 'i2')]),
    ];
    const stubs = [
      stub('auto-10', ['Root', '右臂', 'Mesh_1'], [{ primitiveKey: 'a', primitiveIndex: 0 }]),
    ];
    const r = matchBindings(old, [], stubs);
    expect(r.inherited[0]![0]!.materialId).toBe('i2');
    expect(r.report[0]!.score).toBe(3);
  });

  it('完全平局：两个候选路径得分一模一样 → 拒绝继承并留痕（不瞎猜）', () => {
    // 新模型的父链被改名，导致对两个旧候选都只剩 leaf 一段匹配
    const old = [
      binding('auto-1', ['左臂', 'Mesh_1'], [prim('a', 0, 'i1')]),
      binding('auto-2', ['右臂', 'Mesh_1'], [prim('a', 0, 'i2')]),
    ];
    const stubs = [stub('auto-10', ['新分支', 'Mesh_1'], [{ primitiveKey: 'a', primitiveIndex: 0 }])];
    const r = matchBindings(old, [], stubs);
    expect(r.report[0]!.how).toBe('none');
    expect(r.report[0]!.note).toContain('平局');
    expect(r.inherited[0]).toBeNull();
  });

  it('全路径一致打破半路径平局', () => {
    const old = [
      binding('auto-1', ['Root', 'A', 'Mesh_1'], [prim('a', 0, 'i1')]),
      binding('auto-2', ['B', 'Mesh_1'], [prim('a', 0, 'i2')]),
    ];
    // 新节点与 auto-1 全路径一致；与 auto-2 只有 leaf 一段 → 全路径赢
    const stubs = [stub('auto-10', ['Root', 'A', 'Mesh_1'], [{ primitiveKey: 'a', primitiveIndex: 0 }])];
    const r = matchBindings(old, [], stubs);
    expect(r.report[0]!.how).toBe('path');
    expect(r.inherited[0]![0]!.materialId).toBe('i1');
  });

  it('一个旧绑定只认领一次：新模型里同路径的两个节点，第二个落到 none', () => {
    const old = [binding('auto-1', ['Root', 'Hand'], [prim('a', 0, 'i1')])];
    const stubs = [
      stub('auto-10', ['Root', 'Hand'], [{ primitiveKey: 'a', primitiveIndex: 0 }]),
      stub('auto-11', ['Root', 'Hand'], [{ primitiveKey: 'a', primitiveIndex: 0 }]),
    ];
    const r = matchBindings(old, [], stubs);
    expect(r.report[0]!.how).toBe('path');
    expect(r.report[1]!.how).toBe('none');
  });
});

describe('孤儿绑定：artist 删掉又补回的 mesh 能接回原材质', () => {
  it('上一轮没人认领的绑定进入孤儿池，下一轮全路径一致时接住', () => {
    const orphan = binding('zb-old', ['Root', 'Arm', 'Shield'], [prim('a', 0, 'i7')]);
    const stubs = [stub('auto-1', ['Root', 'Arm', 'Shield'], [{ primitiveKey: 'a', primitiveIndex: 0 }])];
    const r = matchBindings([], [orphan], stubs);
    expect(r.report[0]!.how).toBe('path');
    expect(r.inherited[0]![0]!.materialId).toBe('i7');
  });

  it('孤儿降权：快照同分优先，孤儿半路径不抢', () => {
    const orphan = binding('zb-old', ['Root', 'Arm', 'Hand'], [prim('a', 0, 'i7')]);
    const snap = binding('auto-1', ['Root', 'Leg', 'Hand'], [prim('a', 0, 'i8')]);
    // 新节点 ['Root','Arm改','Hand']：对孤儿是 1 段（leaf），对快照也是 1 段。
    // 孤儿非全路径要降 0.5 → 快照赢
    const stubs = [stub('auto-9', ['Root', 'Arm改', 'Hand'], [{ primitiveKey: 'a', primitiveIndex: 0 }])];
    const r = matchBindings([snap], [orphan], stubs);
    expect(r.inherited[0]![0]!.materialId).toBe('i8');
  });

  it('没用完的旧绑定全部留进孤儿池（含本轮快照里没人认领的）', () => {
    const old = [
      binding('zb-a', ['Root', 'A'], [prim('x', 0, 'i1')]),
      binding('zb-b', ['Root', 'B'], [prim('y', 0, 'i2')]),
    ];
    const r = matchBindings(old, [], [stub('zb-a', ['Root', 'A'], [{ primitiveKey: 'x', primitiveIndex: 0 }])]);
    expect(r.orphans).toHaveLength(1);
    expect(r.orphans[0]!.nodeId).toBe('zb-b');
  });
});

describe('summarizeMatch：导入后的一行摘要', () => {
  it('按继承方式计数；全匹配成功时没有「未匹配」段', () => {
    const s = summarizeMatch([
      { nodeName: 'a', how: 'id', score: 2, inheritedPrims: 1, totalPrims: 1 },
      { nodeName: 'b', how: 'path', score: 3, inheritedPrims: 2, totalPrims: 2 },
      { nodeName: 'c', how: 'none', score: 0, inheritedPrims: 0, totalPrims: 1 },
    ]);
    expect(s).toContain('1 节点按 ID 继承');
    expect(s).toContain('1 节点按路径继承');
    expect(s).toContain('1 节点未匹配');
  });

  it('空报告返回 null（不打扰模型信息行）', () => {
    expect(summarizeMatch([])).toBeNull();
  });
});
