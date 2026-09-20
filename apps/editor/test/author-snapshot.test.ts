/**
 * 作者状态快照 / 恢复 —— **真实实现**的验收（复审 #3）。
 *
 * 之前这一条只测了"替身返回 mismatched=true 并检查告警"，等于没测恢复实现。
 * 快照/恢复现在抽成了纯函数（`services/author-snapshot.ts`，渲染器就是委托它），
 * 这里的每一个断言跑的都是**产品里真正执行的那段代码**，不需要 GPU。
 */

import { describe, it, expect } from 'vitest';
import { snapshotObjects, restoreObjects, type SnapshotObjectLike } from '../src/services/author-snapshot';

function obj(name: string, x = 0): SnapshotObjectLike {
  return {
    pos: [x, 0, 0],
    rot: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: 1,
    bob: 0,
    visible: true,
    removed: false,
    pickable: true,
    name,
    category: '环境',
    subMeshes: [{ visible: true }, { visible: true }],
  };
}

describe('author-snapshot —— 真实恢复实现（复审 #3）', () => {
  it('快照 → 编辑每个字段 → 恢复后逐字段回到快照值', () => {
    const objs = [obj('掩体 1', 1), obj('掩体 2', 5)];
    const snap = snapshotObjects(objs, 1);

    // 模拟 Play 期间作者改了场景（位置 / 旋转 / 缩放 / 显隐 / 名字 / 子网格 / 选中）
    objs[0]!.pos = [99, 0, 0];
    objs[0]!.scale = 3;
    objs[0]!.visible = false;
    objs[0]!.name = '被改过的掩体';
    objs[0]!.subMeshes[0]!.visible = false;
    objs[1]!.pos = [-7, 0, 2];
    objs[1]!.quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

    const r = restoreObjects(objs, snap);
    expect(r.restored).toBe(2);
    expect(r.mismatched).toBe(false);
    expect(objs[0]!.pos).toEqual([1, 0, 0]);
    expect(objs[0]!.scale).toBe(1);
    expect(objs[0]!.visible).toBe(true);
    expect(objs[0]!.name).toBe('掩体 1');
    expect(objs[0]!.subMeshes[0]!.visible).toBe(true);
    expect(objs[1]!.pos).toEqual([5, 0, 0]);
    expect(objs[1]!.quat).toEqual([0, 0, 0, 1]);
    expect(r.selectedIndex).toBe(1);
  });

  it('Play 期间新增了物体：保守恢复（能对上的恢复、新增的原样留着）+ mismatched', () => {
    const objs = [obj('掩体 1'), obj('掩体 2')];
    const snap = snapshotObjects(objs, 0);
    // Play 期间 import 完成（异步）或拖入资产 → 物体数变了
    objs.push(obj('Play 中冒出来的资产'));
    objs[0]!.pos = [42, 0, 0];

    const r = restoreObjects(objs, snap);
    expect(r.restored).toBe(2); // 只能恢复能对上的两个
    expect(r.mismatched).toBe(true); // 且必须如实报"数量不一致"
    expect(objs[0]!.pos).toEqual([0, 0, 0]); // 恢复的
    expect(objs[2]!.name).toBe('Play 中冒出来的资产'); // 新增的原样留着，不强行删
  });

  it('快照不持有活引用：打完快照再改，快照内容不能被污染', () => {
    const objs = [obj('掩体 1', 1)];
    const snap = snapshotObjects(objs, 0);
    objs[0]!.pos[0] = 777;
    objs[0]!.subMeshes[0]!.visible = false;
    // 快照里的值必须还是拍摄那一刻的
    expect(snap.objects[0]!.pos).toEqual([1, 0, 0]);
    expect(snap.objects[0]!.subVisible).toEqual([true, true]);
  });

  it('选中索引越界时不回写（不制造一个指向不存在的选中）', () => {
    const objs = [obj('a'), obj('b')];
    const snap = snapshotObjects(objs, 1);
    // 快照之后只剩 0 个物体（极端边界）
    const r = restoreObjects([], snap);
    expect(r.restored).toBe(0);
    expect(r.selectedIndex).toBeNull();
  });
});
