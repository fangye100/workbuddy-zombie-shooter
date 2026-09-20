/**
 * 场景灯光按 `priority` 降级（AGENTS.md §2.3）。
 *
 * 为什么单开一个文件：这条曾经**完全没有实现**（取节点顺序第一个、无落选提示），
 * 是独立评审抓出来的阻断（A3）。修完之后评审又指出它**零测试**且入库场景全是单盏
 * directional，降级分支永远触发不到 —— 那就等于没修。所以把选灯抽成纯函数
 * `pickSceneLights()`，用构造数据把降级分支跑出来。
 *
 * 它不需要 GPU，也不需要真场景文件。
 */

import { describe, it, expect } from 'vitest';
import { pickSceneLights, type SceneNodeLike } from '../src/renderer';

function light(
  id: string,
  opts: { type?: string; priority?: number; enabled?: boolean; intensity?: number; range?: number; color?: string } = {},
): SceneNodeLike {
  return {
    id,
    components: [
      {
        kind: 'Light',
        enabled: opts.enabled ?? true,
        type: opts.type ?? 'directional',
        color: opts.color ?? '#ffffff',
        intensity: opts.intensity ?? 1,
        range: opts.range ?? 0,
        priority: opts.priority ?? 0,
      },
    ],
  };
}

describe('pickSceneLights —— 按 priority 取 top-1 + top-1', () => {
  it('主光取 priority 最高的那盏，而不是节点顺序第一个', () => {
    const r = pickSceneLights([light('nd_a', { priority: 1 }), light('nd_b', { priority: 99 }), light('nd_c', { priority: 5 })]);
    expect(r.key?.nodeId).toBe('nd_b');
    expect(r.point).toBeNull();
  });

  it('directional 与 point 各取一盏（top-1 + top-1）', () => {
    const r = pickSceneLights([
      light('nd_key', { type: 'directional', priority: 10 }),
      light('nd_key2', { type: 'directional', priority: 20 }),
      light('nd_pt', { type: 'point', priority: 3, range: 6 }),
      light('nd_pt2', { type: 'point', priority: 8, range: 9 }),
    ]);
    expect(r.key?.nodeId).toBe('nd_key2');
    expect(r.point?.nodeId).toBe('nd_pt2');
    expect(r.point?.range).toBe(9);
  });

  it('落选的灯**每一盏**都有明确提示，且点名占用者', () => {
    const r = pickSceneLights([
      light('nd_a', { priority: 5 }),
      light('nd_b', { priority: 50 }),
      light('nd_c', { priority: 7 }),
    ]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join('\n')).toContain('nd_a');
    expect(r.warnings.join('\n')).toContain('nd_c');
    // 提示要能回答"被谁挤掉了"，否则用户只知道不亮、不知道为什么
    for (const w of r.warnings) expect(w).toContain('nd_b');
    expect(r.warnings[0]).toContain('priority 50');
  });

  it('只有一盏时不产生降级提示', () => {
    const r = pickSceneLights([light('nd_only', { priority: 100 })]);
    expect(r.key?.nodeId).toBe('nd_only');
    expect(r.warnings).toEqual([]);
  });

  it('priority 相同时保持节点顺序（同输入同结果，灯光不会随机跳）', () => {
    const nodes = [light('nd_1'), light('nd_2'), light('nd_3')];
    const a = pickSceneLights(nodes);
    const b = pickSceneLights(nodes);
    expect(a.key?.nodeId).toBe('nd_1');
    expect(b.key?.nodeId).toBe('nd_1');
    expect(a.warnings).toEqual(b.warnings);
  });

  it('禁用的灯不参与竞争，也不算落选', () => {
    const r = pickSceneLights([light('nd_off', { priority: 999, enabled: false }), light('nd_on', { priority: 1 })]);
    expect(r.key?.nodeId).toBe('nd_on');
    expect(r.warnings).toEqual([]);
  });

  it('非 Light 组件被忽略', () => {
    const r = pickSceneLights([
      { id: 'nd_x', components: [{ kind: 'RoomVolume', enabled: true }] },
      light('nd_ok', { priority: 3 }),
    ]);
    expect(r.key?.nodeId).toBe('nd_ok');
    expect(r.warnings).toEqual([]);
  });

  it('没有灯时全部为 null', () => {
    const r = pickSceneLights([]);
    expect(r.key).toBeNull();
    expect(r.point).toBeNull();
    expect(r.warnings).toEqual([]);
  });
});
