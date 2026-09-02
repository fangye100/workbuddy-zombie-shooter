import { describe, expect, it } from 'vitest';
import { defaultParams, type LabParams, type MaterialState } from './params';
import {
  cloneMaterial,
  isInstanceId,
  MaterialLibrary,
  planSubMeshCount,
  sharedId,
  sharedIndex,
  slotSource,
  slotState,
  type MaterialSlot,
} from './materials';
import { nameAllocator, uniqueName } from './naming';

/**
 * 材质三层语义的回归测试（override > instance > shared）。
 *
 * 这套语义是「改一个 mesh 不能污染全局共享材质」的保证，光靠眼睛看 UI 是验不出来的，
 * 所以在这里用断言钉死：任何一层被写，另外两层必须纹丝不动。
 */

const ALBEDO = '#8FD14F';

function slot(id: string, override: MaterialState | null = null): MaterialSlot {
  return { materialId: id, override };
}

function setup(): { p: LabParams; lib: MaterialLibrary } {
  const p = defaultParams();
  p.materials[0]!.albedo = ALBEDO;
  return { p, lib: new MaterialLibrary() };
}

describe('材质 id', () => {
  it('共享 id 与下标可互转，实例 id 不会被误判', () => {
    expect(sharedId(3)).toBe('s3');
    expect(sharedIndex('s3')).toBe(3);
    expect(sharedIndex('i1')).toBeNull();
    expect(sharedIndex('nope')).toBeNull();
    expect(isInstanceId('i12')).toBe(true);
    expect(isInstanceId('s0')).toBe(false);
  });
});

describe('槽位优先级与数据隔离', () => {
  it('默认走共享材质，且拿到的是共享材质本体（改它 = 全局改）', () => {
    const { p, lib } = setup();
    const s = slot(sharedId(0));
    expect(slotSource(s)).toBe('shared');
    expect(slotState(s, lib, p)).toBe(p.materials[0]);
  });

  it('instance 层：写实例不污染它的来源共享材质', () => {
    const { p, lib } = setup();
    const id = lib.createInstance(p.materials[0]!, sharedId(0), '僵尸绿');
    const s = slot(id);

    expect(slotSource(s)).toBe('instance');
    const inst = slotState(s, lib, p);
    inst.albedo = '#FF0000';
    inst.roughness = 0.05;

    // 共享材质一动没动
    expect(p.materials[0]!.albedo).toBe(ALBEDO);
    expect(p.materials[0]!.roughness).not.toBe(0.05);
    // 实例自己记着改动
    expect(lib.find(id)?.state.albedo).toBe('#FF0000');
  });

  it('override 层：写覆盖既不动共享材质，也不动库里的实例', () => {
    const { p, lib } = setup();
    const instId = lib.createInstance(p.materials[0]!, sharedId(0), '僵尸绿');
    const s = slot(instId, cloneMaterial(p.materials[0]!));

    expect(slotSource(s)).toBe('override');
    const ov = slotState(s, lib, p);
    ov.albedo = '#0000FF';
    ov.metallic = 0.9;

    expect(p.materials[0]!.albedo).toBe(ALBEDO); // 共享没动
    expect(lib.find(instId)?.state.albedo).toBe(ALBEDO); // 实例没动
    expect(s.override?.albedo).toBe('#0000FF'); // 只有覆盖动了
  });

  it('覆盖保存为实例（promote）后，值原样带过去，共享材质仍未受影响', () => {
    const { p, lib } = setup();
    const s = slot(sharedId(0), cloneMaterial(p.materials[0]!));
    s.override!.albedo = '#00FF00';
    s.override!.emissiveStrength = 2.5;

    // 模拟 renderer.promoteOverride：以覆盖为模板建实例 → 指向它 → 清覆盖
    const newId = lib.createInstance(s.override!, s.materialId, '僵尸绿');
    s.materialId = newId;
    s.override = null;

    expect(slotSource(s)).toBe('instance');
    expect(slotState(s, lib, p).albedo).toBe('#00FF00');
    expect(slotState(s, lib, p).emissiveStrength).toBe(2.5);
    expect(p.materials[0]!.albedo).toBe(ALBEDO);
    expect(p.materials[0]!.emissiveStrength).toBe(0);
  });

  it('丢弃覆盖后回落到库条目', () => {
    const { p, lib } = setup();
    const instId = lib.createInstance(p.materials[0]!, sharedId(0), '僵尸绿');
    const s = slot(instId, cloneMaterial(p.materials[0]!));
    s.override!.albedo = '#123456';
    s.override = null;

    expect(slotSource(s)).toBe('instance');
    expect(slotState(s, lib, p).albedo).toBe(ALBEDO);
  });

  it('未知 id 回落到 0 号共享材质，不抛异常', () => {
    const { p, lib } = setup();
    expect(slotState(slot('i999'), lib, p)).toBe(p.materials[0]);
  });
});

describe('材质库管理', () => {
  it('下拉列表 = 共享材质 + 实例，顺序稳定', () => {
    const { p, lib } = setup();
    const ids = [lib.createInstance(p.materials[0]!, sharedId(0), '僵尸绿'), lib.createInstance(p.materials[1]!, sharedId(1), '地面灰')];
    const refs = lib.refs(p);

    expect(refs).toHaveLength(p.materials.length + 2);
    expect(refs.slice(0, p.materials.length).every((r) => r.kind === 'shared')).toBe(true);
    expect(refs.slice(p.materials.length).map((r) => r.id)).toEqual(ids);
    expect(refs.slice(p.materials.length).every((r) => r.kind === 'instance')).toBe(true);
  });

  it('实例命名去重', () => {
    const { p, lib } = setup();
    const a = lib.createInstance(p.materials[0]!, sharedId(0), '僵尸绿');
    const b = lib.createInstance(p.materials[0]!, sharedId(0), '僵尸绿');
    expect(lib.find(a)?.name).not.toBe(lib.find(b)?.name);
  });

  it('重命名忽略空串', () => {
    const { p, lib } = setup();
    const id = lib.createInstance(p.materials[0]!, sharedId(0), '僵尸绿');
    const before = lib.find(id)?.name;
    lib.rename(id, '   ');
    expect(lib.find(id)?.name).toBe(before);
    lib.rename(id, ' 毒液绿 ');
    expect(lib.find(id)?.name).toBe('毒液绿');
  });

  it('删除实例只删自己，且能回退到 baseId', () => {
    const { p, lib } = setup();
    const id = lib.createInstance(p.materials[2]!, sharedId(2), '皮肤');
    expect(lib.find(id)?.baseId).toBe(sharedId(2));
    expect(lib.remove('s0')).toBe(false); // 共享材质不可删
    expect(lib.remove(id)).toBe(true);
    expect(lib.find(id)).toBeNull();
  });

  it('serialize 是深拷贝，改导出结果不回写库', () => {
    const { p, lib } = setup();
    const id = lib.createInstance(p.materials[0]!, sharedId(0), '僵尸绿');
    const snap = lib.serialize();
    snap[0]!.state.albedo = '#FFFFFF';
    expect(lib.find(id)?.state.albedo).toBe(ALBEDO);
  });

  it('重命名撞别人名字时自动加后缀，下拉框不会出现两个同名项', () => {
    const { p, lib } = setup();
    const a = lib.createInstance(p.materials[0]!, sharedId(0), 'A');
    const b = lib.createInstance(p.materials[0]!, sharedId(0), 'B');
    lib.rename(b, lib.find(a)!.name);
    const names = [lib.find(a)!.name, lib.find(b)!.name];
    expect(new Set(names).size).toBe(2);

    // 重命名为自己的当前名字 = 无操作（不该被判成「和自己重名」而加后缀）
    const keep = lib.find(b)!.name;
    lib.rename(b, keep);
    expect(lib.find(b)!.name).toBe(keep);
  });

  it('删除后按 id 查不到（Map 索引与顺序数组同步失效）', () => {
    const { p, lib } = setup();
    const id = lib.createInstance(p.materials[0]!, sharedId(0), 'X');
    lib.remove(id);
    expect(lib.find(id)).toBeNull();
    expect(lib.refs(p).filter((r) => r.kind === 'instance')).toHaveLength(0);
  });
});

describe('子网格条数的预算裁剪（防 uniform 槽位写越界）', () => {
  it('没给 primitive 信息 → 退化成 1 条', () => {
    expect(planSubMeshCount(0, 0, 256)).toBe(1);
    expect(planSubMeshCount(-3, 0, 256)).toBe(1);
  });

  it('装得下就原样拆', () => {
    expect(planSubMeshCount(12, 11, 256)).toBe(12);
  });

  it('刚好装满边界也放行（used + requested === capacity 是合法的）', () => {
    expect(planSubMeshCount(245, 11, 256)).toBe(245);
  });

  it('装不下 → 整体退化为 1 条，绝不截断（截断会静默丢几何）', () => {
    expect(planSubMeshCount(246, 11, 256)).toBe(1);
    expect(planSubMeshCount(9999, 0, 256)).toBe(1);
  });

  it('别人已把容量吃光时仍至少保留 1 条（不能返回 0）', () => {
    expect(planSubMeshCount(8, 256, 256)).toBe(1);
    expect(planSubMeshCount(8, 9999, 256)).toBe(1);
  });
});

describe('uniqueName', () => {
  it('不冲突就原样返回', () => {
    expect(uniqueName('皮肤', new Set(['骨骼']))).toBe('皮肤');
  });

  it('冲突时加数字后缀并继续往后找空位', () => {
    expect(uniqueName('皮肤', new Set(['皮肤']))).toBe('皮肤 2');
    expect(uniqueName('皮肤', new Set(['皮肤', '皮肤 2', '皮肤 3']))).toBe('皮肤 4');
  });
});

describe('nameAllocator', () => {
  it('连续取名互不重复，且自动登记已取的名字', () => {
    const a = nameAllocator();
    const got = [a.take('身体'), a.take('身体'), a.take('身体')];
    expect(got).toEqual(['身体', '身体 2', '身体 3']);
    expect([...a.taken].sort()).toEqual(['身体', '身体 2', '身体 3']);
  });

  it('初始已占用的名字会被避让', () => {
    const a = nameAllocator(['盾牌']);
    expect(a.take('盾牌')).toBe('盾牌 2');
    expect(a.take('武器')).toBe('武器');
  });
});
