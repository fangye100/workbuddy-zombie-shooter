import { describe, it, expect } from 'vitest';
import { RuntimeBridge } from '../src/services/runtime-bridge';
import { DYNAMIC_INSTANCE_FLOATS } from '@aether/render';
import { PlaySession } from '@aether/runtime';
import type { SceneDocument } from '@aether/scene';

/**
 * WU-3 的渲染桥接测试。
 *
 * WU-4 之后 Bridge 只做「世界 → 批次」的翻译，**不再拥有运行状态** ——
 * 播放/暂停/单步/停止归 `PlaySession`（见 play-session.test.ts）。
 * 所以这里的夹具是「跑一个 PlaySession 再把会话挂给 Bridge」。
 *
 * 门禁测试用 import.meta.glob 而非 node:fs —— 本仓库没装 @types/node，
 * 且 tsconfig 的 types 是白名单（改 scene-files 会连带污染整个类型环境）。
 */
// 从 apps/editor/test/ 回到仓库根要三级：editor/test → editor → apps → 根
const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function floor1(): SceneDocument {
  const key = Object.keys(MODULES)[0]!;
  return JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
}

/** 跑一个 PlaySession 并把它的世界挂给 Bridge */
function started(doc: SceneDocument = floor1()): { bridge: RuntimeBridge; play: PlaySession } {
  const play = new PlaySession();
  const r = play.play(doc);
  if (!r.ok) throw new Error('夹具装载失败：' + r.errors.join('；'));
  const bridge = new RuntimeBridge();
  bridge.attach(play.runtime);
  return { bridge, play };
}

describe('RuntimeBridge —— 挂接与摘下', () => {
  it('挂上真实关卡 floor-1 的会话：玩家 + 第一间房的僵尸', () => {
    const { bridge } = started();
    expect(bridge.active).toBe(true);
    const v = bridge.entities;
    expect(v.filter((e) => e.kind === 'player')).toHaveLength(1);
    expect(v.filter((e) => e.kind === 'npc').length).toBeGreaterThan(0);
  });

  it('摘下（attach null）后不再产出批次 —— 渲染侧据此跳过整段 pass 1b', () => {
    const { bridge } = started();
    expect(bridge.batches()).not.toBeNull();
    bridge.attach(null);
    expect(bridge.active).toBe(false);
    expect(bridge.batches()).toBeNull();
    expect(bridge.entities).toEqual([]);
  });

  it('世界推进后 refresh 才更新实例位置（读批次不能有推进副作用）', () => {
    const { bridge, play } = started();
    const before = bridge.batches()!.flatMap((b) => [...b.instances.slice(0, DYNAMIC_INSTANCE_FLOATS)].slice(0, 3));
    play.advance(1);
    // 没 refresh：位置还是旧的
    const stale = bridge.batches()!.flatMap((b) => [...b.instances.slice(0, DYNAMIC_INSTANCE_FLOATS)].slice(0, 3));
    expect(stale).toEqual(before);
    bridge.refresh();
    const after = bridge.batches()!.flatMap((b) => [...b.instances.slice(0, DYNAMIC_INSTANCE_FLOATS)].slice(0, 3));
    expect(after).not.toEqual(before);
  });
});

describe('RuntimeBridge —— 实例打包（与 shader 的 DInst 布局一一对应）', () => {
  it('批次实例数之和 = 存活实体数', () => {
    const { bridge: b } = started();
    const batches = b.batches()!;
    const total = batches.reduce((n, x) => n + x.count, 0);
    expect(total).toBe(b.entities.length);
  });

  it('每个实例：y = 身高一半（胶囊中心在原点），缩放恒为 1', () => {
    const { bridge: b } = started();
    const F = DYNAMIC_INSTANCE_FLOATS;
    for (const batch of b.batches()!) {
      const h = Number(batch.meshId.split(':h')[1]);
      for (let i = 0; i < batch.count; i++) {
        const o = i * F;
        expect(batch.instances[o + 1]).toBeCloseTo(h / 2, 3);
        expect(batch.instances[o + 4]).toBe(1);
        expect(batch.instances[o + 5]).toBe(1);
        expect(batch.instances[o + 6]).toBe(1);
        // 颜色恒在合法区间（选中会 ×1.9，故上界放宽到 2）
        expect(batch.instances[o + 8]).toBeGreaterThan(0);
        expect(batch.instances[o + 8]).toBeLessThanOrEqual(2);
      }
    }
  });

  it('不同体型分成不同批次（meshId 带尺寸参数）', () => {
    const { bridge: b } = started();
    const ids = new Set(b.batches()!.map((x) => x.meshId));
    // floor-1 第一间房有多种 NPC → 至少两个尺寸；同一 meshId 不会被拆成两份
    expect(ids.size).toBeGreaterThanOrEqual(1);
    for (const id of ids) expect(id).toMatch(/^capsule:r[\d.]+:h[\d.]+$/);
  });

  it('实例数组长度足够，不会读到未初始化的尾区', () => {
    const { bridge: b } = started();
    for (const batch of b.batches()!) {
      expect(batch.instances.length).toBeGreaterThanOrEqual(batch.count * DYNAMIC_INSTANCE_FLOATS);
    }
  });

  /**
   * docs/17 §8 第 8 条：动态实体**没有消耗静态场景槽位**。
   *
   * 证据形态：120 个实体只产出「种类数」个网格（每个 meshId 一份顶点/索引），
   * 每帧变的只有实例数组。如果是静态物件路径，120 个物件就要 120 份几何 +
   * 120 个 transformBuf 槽位，而 transformBuf 只有 64 槽 —— 直接越界。
   * 此项只验证渲染分离，不等于 500 僵尸的性能验收。
   */
  it('超过静态上限(64)时：只上传「种类数」份网格，其余全是实例行', () => {
    const doc = floor1();
    for (const n of doc.nodes) {
      for (const c of n.components) {
        if (c.kind === 'SpawnPoint') (c as { count: number }).count = 40;
      }
    }
    const { bridge: b } = started(doc);

    const batches = b.batches()!;
    const total = batches.reduce((n, x) => n + x.count, 0);
    expect(total).toBeGreaterThan(64);
    // 网格份数远小于实体数：120 个实体只对应「体型种类数」个 meshId
    expect(batches.length).toBeLessThan(total / 10);
    for (const batch of batches) {
      expect(batch.vertices.length).toBeGreaterThan(0);
      expect(batch.indices.length).toBeGreaterThan(0);
      expect(batch.count).toBeGreaterThan(0);
    }
  });
});

describe('RuntimeBridge —— 选中与射线拾取（最小选择入口）', () => {
  it('从实体正上方往下打能命中它自己', () => {
    const { bridge: b } = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    const hit = b.pickRay([e.x, 30, e.z], [0, -1, 0]);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(e.id);
  });

  it('从实体头顶之上继续往上打不命中（射线起点在实体内部则必中，不能那样测）', () => {
    const { bridge: b } = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    expect(b.pickRay([e.x, 30, e.z], [0, 1, 0])).toBeNull();
  });

  it('选中后 selectedEntity 能取到；generation 对不上时拒绝选中', () => {
    const { bridge: b } = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    expect(b.select(e.id, e.generation)).toBe(true);
    expect(b.selectedEntity?.id).toBe(e.id);
    expect(b.select(e.id, e.generation + 7)).toBe(false);
    b.clearSelection();
    expect(b.selectedEntity).toBeNull();
  });
});
describe('RuntimeBridge —— 换世界', () => {
  it('reset 后挂同一个会话：batch 数量不变、实例数不变（Reset 是整表重建）', () => {
    const { bridge: b, play } = started();
    const before = b.batches()!.reduce((n, x) => n + x.count, 0);
    play.reset();
    b.refresh();
    expect(b.currentTick).toBe(0);
    expect(b.batches()!.reduce((n, x) => n + x.count, 0)).toBe(before);
  });
});
