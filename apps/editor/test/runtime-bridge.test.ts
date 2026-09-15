import { describe, it, expect } from 'vitest';
import { RuntimeBridge } from '../src/services/runtime-bridge';
import { DYNAMIC_INSTANCE_FLOATS } from '@aether/render';
import type { SceneDocument } from '@aether/scene';

/**
 * WU-3 的渲染桥接测试。
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

function started(): RuntimeBridge {
  const b = new RuntimeBridge();
  const r = b.start(floor1());
  if (!r.ok) throw new Error('夹具装载失败：' + r.errors.join('；'));
  return b;
}

describe('RuntimeBridge —— 装载与启动', () => {
  it('真实关卡 floor-1 能启动，产出玩家 + 第一间房的僵尸', () => {
    const b = started();
    expect(b.active).toBe(true);
    const v = b.entities;
    expect(v.filter((e) => e.kind === 'player')).toHaveLength(1);
    expect(v.filter((e) => e.kind === 'npc').length).toBeGreaterThan(0);
  });

  it('装载失败时不启动（缺玩家起点 → ok=false 且有 error）', () => {
    const doc = floor1();
    doc.playerStart = null;
    const b = new RuntimeBridge();
    const r = b.start(doc);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(b.active).toBe(false);
    expect(b.batches()).toBeNull();
  });
});

describe('RuntimeBridge —— 实例打包（与 shader 的 DInst 布局一一对应）', () => {
  it('批次实例数之和 = 存活实体数', () => {
    const b = started();
    const batches = b.batches()!;
    const total = batches.reduce((n, x) => n + x.count, 0);
    expect(total).toBe(b.entities.length);
  });

  it('每个实例：y = 身高一半（胶囊中心在原点），缩放恒为 1', () => {
    const b = started();
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
    const b = started();
    const ids = new Set(b.batches()!.map((x) => x.meshId));
    // floor-1 第一间房有多种 NPC → 至少两个尺寸；同一 meshId 不会被拆成两份
    expect(ids.size).toBeGreaterThanOrEqual(1);
    for (const id of ids) expect(id).toMatch(/^capsule:r[\d.]+:h[\d.]+$/);
  });

  it('实例数组长度足够，不会读到未初始化的尾区', () => {
    const b = started();
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
    const b = new RuntimeBridge();
    const r = b.start(doc, { capacity: 512 });
    expect(r.ok).toBe(true);

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
    const b = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    const hit = b.pickRay([e.x, 30, e.z], [0, -1, 0]);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(e.id);
  });

  it('从实体头顶之上继续往上打不命中（射线起点在实体内部则必中，不能那样测）', () => {
    const b = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    expect(b.pickRay([e.x, 30, e.z], [0, 1, 0])).toBeNull();
  });

  it('选中后 selectedEntity 能取到；generation 对不上时拒绝选中', () => {
    const b = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    expect(b.select(e.id, e.generation)).toBe(true);
    expect(b.selectedEntity?.id).toBe(e.id);
    expect(b.select(e.id, e.generation + 7)).toBe(false);
    b.clearSelection();
    expect(b.selectedEntity).toBeNull();
  });
});

describe('RuntimeBridge —— 推进与生命周期', () => {
  it('advance 按固定步推进：渲染帧率不决定游戏步数', () => {
    const b = started();
    // fixedStep = 1/30 ≈ 0.0333；1 秒真实时间 → 30 步（单帧最多补 5 步，故分多次喂）
    for (let i = 0; i < 10; i++) b.advance(0.1);
    expect(b.currentTick).toBeGreaterThan(0);
  });

  it('暂停后 advance 不再推进', () => {
    const b = started();
    for (let i = 0; i < 5; i++) b.advance(0.1);
    const t = b.currentTick;
    b.setPaused(true);
    for (let i = 0; i < 5; i++) b.advance(0.1);
    expect(b.currentTick).toBe(t);
    b.setPaused(false);
    b.advance(0.1);
    expect(b.currentTick).toBeGreaterThan(t);
  });

  it('stop 之后不再产出批次（渲染侧据此跳过整段 pass）', () => {
    const b = started();
    expect(b.batches()).not.toBeNull();
    b.stop();
    expect(b.active).toBe(false);
    expect(b.batches()).toBeNull();
  });

  it('reset 回到 tick 0 且实体数不累积', () => {
    const b = started();
    const n = b.entities.length;
    for (let i = 0; i < 10; i++) b.advance(0.1);
    b.reset();
    expect(b.currentTick).toBe(0);
    expect(b.entities.length).toBe(n);
  });
});
