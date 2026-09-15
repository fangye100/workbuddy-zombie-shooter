import { describe, it, expect } from 'vitest';
import { RuntimeSession } from '../src/session';
import { loadLevelRuntime } from '../src/loader';
import type { SceneDocument } from '@aether/scene';
import type { LevelRuntimeDesc } from '../src/loader';

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function desc(): LevelRuntimeDesc {
  const key = Object.keys(MODULES)[0]!;
  const doc = (MODULES[key] as { default: unknown }).default as SceneDocument;
  const r = loadLevelRuntime(doc);
  if (r.desc === null) throw new Error('测试夹具装载失败：' + JSON.stringify(r.diagnostics));
  return r.desc;
}

function make(opts: { seed?: number; capacity?: number } = {}): RuntimeSession {
  return new RuntimeSession({ desc: desc(), seed: opts.seed ?? 1, ...(opts.capacity ? { capacity: opts.capacity } : {}) });
}

/** 把全部刷怪点的数量改写成 n，用来造「超过静态上限」的压测场景 */
function makeScaled(count: number, capacity: number): RuntimeSession {
  const key = Object.keys(MODULES)[0]!;
  const doc = JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
  for (const n of doc.nodes) {
    for (const c of n.components) {
      if (c.kind === 'SpawnPoint') (c as { count: number }).count = count;
    }
  }
  const r = loadLevelRuntime(doc);
  if (r.desc === null) throw new Error('压测夹具装载失败：' + JSON.stringify(r.diagnostics));
  return new RuntimeSession({ desc: r.desc, seed: 1, capacity });
}

/** 僵尸中心是否落在障碍内部（留 0.05 容差）。这是"没有穿墙"的最低标准 */
function insideAnyObstacle(s: RuntimeSession, x: number, z: number): boolean {
  const eps = 0.05;
  for (const o of s.desc.obstacles) {
    if (!o.enabled) continue;
    if (Math.abs(x - o.x) < o.halfX - eps && Math.abs(z - o.z) < o.halfZ - eps) return true;
  }
  return false;
}

describe('RuntimeSession —— 房间进入触发', () => {
  it('玩家出生所在的房间立即触发，未进入的房间不刷', () => {
    const s = make();
    // 房间 1 = 5+4+3 = 12 只；房间 3 = 12 只（玩家在 x≈3，房间 3 在 x≈56）
    expect(s.countNpc()).toBe(12);
    expect(s.triggeredRooms()).toEqual(['nd_f1r0']);
  });

  it('再次跨越边界不重复投放同一波', () => {
    const s = make();
    s.run(200);
    expect(s.countNpc()).toBe(12);
    expect(s.triggeredRooms()).toEqual(['nd_f1r0']);
  });

  it('实体能追溯到来源刷怪点（一处刷怪点可生成多个实体）', () => {
    const s = make();
    const v = s.view();
    const fromSp0 = v.filter((e) => e.sourceNodeId === 'nd_f1r0_sp0');
    expect(fromSp0).toHaveLength(5); // E-01 ×5
    expect(v.filter((e) => e.kind === 'player')[0]?.sourceNodeId).toBe('nd_f1_start');
  });

  it('身份带 generation，不是裸数组下标', () => {
    const s = make();
    const v = s.view();
    expect(v.every((e) => Number.isInteger(e.generation))).toBe(true);
    expect(new Set(v.map((e) => e.id)).size).toBe(v.length);
  });
});

describe('RuntimeSession —— 障碍真实参与约束', () => {
  it('推进过程中没有僵尸停在障碍内部', () => {
    const s = make({ seed: 7 });
    for (const t of [0, 10, 50, 200]) {
      s.run(t === 0 ? 0 : t - s.tick);
      for (const e of s.view()) {
        if (e.kind !== 'npc') continue;
        expect(insideAnyObstacle(s, e.x, e.z)).toBe(false);
      }
    }
  });

  it('僵尸确实朝玩家收敛（不是原地不动）', () => {
    const s = make({ seed: 3 });
    const before = s.view().filter((e) => e.kind === 'npc');
    const dBefore =
      before.reduce((a, e) => a + Math.hypot(e.x - s.desc.playerStart.x, e.z - s.desc.playerStart.z), 0) /
      before.length;
    s.run(300);
    const after = s.view().filter((e) => e.kind === 'npc');
    const dAfter =
      after.reduce((a, e) => a + Math.hypot(e.x - s.desc.playerStart.x, e.z - s.desc.playerStart.z), 0) /
      after.length;
    expect(dAfter).toBeLessThan(dBefore);
  });
});

describe('RuntimeSession —— 确定性与容量', () => {
  it('同种子：reset 后重跑到同一 tick，结果逐位一致', () => {
    const s = make({ seed: 42 });
    s.run(60);
    const a = s.view().map((e) => `${e.characterId}:${e.x.toFixed(6)},${e.z.toFixed(6)}`);
    s.reset();
    s.run(60);
    const b = s.view().map((e) => `${e.characterId}:${e.x.toFixed(6)},${e.z.toFixed(6)}`);
    expect(b).toEqual(a);
  });

  it('不同种子得到不同散布（种子真的被用上了）', () => {
    const a = make({ seed: 1 }).view().map((e) => e.x.toFixed(6));
    const b = make({ seed: 999 }).view().map((e) => e.x.toFixed(6));
    expect(b).not.toEqual(a);
  });

  it('容量不足 → 整批原子拒绝，不留半批实体', () => {
    const s = make({ capacity: 6 }); // 玩家占 1，房间 1 需要 12
    expect(s.countNpc()).toBe(0);
    expect(s.triggeredRooms()).toEqual([]);
  });

  it('reset 回到初始状态（房间需要重新触发，实体数不累积）', () => {
    const s = make();
    s.run(30);
    s.reset();
    expect(s.tick).toBe(0);
    expect(s.countNpc()).toBe(12);
  });
});

/**
 * WU-3 验收（docs/17 §8 第 8 条）：动态实体**不消耗静态场景槽位**。
 *
 * 静态世界的上限 MAX_OBJECTS = 64 来自 transformBuf 的 buffer 大小，是渲染侧约束；
 * 运行时实体走独立路径，所以「一波超过 64 只」必须能在纯 CPU 侧成立。
 * 此项只证明路径独立，不等于 500 僵尸的性能验收。
 */
describe('WU-3 验收：动态实体数量不受 MAX_OBJECTS(64) 约束', () => {
  it('同一关能同时存在远超静态上限的实体', () => {
    const s = makeScaled(40, 512); // 3 个刷怪点 × 40 = 120 只 + 玩家
    const v = s.view();
    expect(s.countNpc()).toBe(120);
    expect(v.length).toBeGreaterThan(64);
  });

  it('超出容量时整批拒绝 —— 上限是显式声明的，不是悄悄截断', () => {
    const s = makeScaled(40, 100); // 需要 121 槽位，只有 100
    expect(s.countNpc()).toBe(0);
    expect(s.triggeredRooms()).toEqual([]);
  });

  it('超量实体跑起来仍然不穿障碍（寻路对大批量同样有效）', () => {
    const s = makeScaled(20, 256);
    s.run(60);
    const bad = s.view().filter((e) => e.kind === 'npc' && insideAnyObstacle(s, e.x, e.z));
    expect(bad).toEqual([]);
    expect(s.countNpc()).toBe(60);
  });
});

/**
 * WU-5 前置属性：**刷怪随机流的局部性**。
 *
 * 每个刷怪点用 `mixSeed(会话种子, nodeId)` 派生自己的随机流（见 session.ts）。
 * 共用一条流时，改 A 的 count 会多消耗几个随机数、把 B/C 的取点整体平移 ——
 * 于是「改一处」在效果上等于「整关重排」，WU-5 的局部编辑闭环就立不住。
 */
describe('WU-5 前置：改一处刷怪点不牵动其它刷怪点', () => {
  /** 只改指定刷怪点的 count，返回一个新会话 */
  function withCount(nodeId: string, count: number): RuntimeSession {
    const key = Object.keys(MODULES)[0]!;
    const doc = JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
    let found = false;
    for (const n of doc.nodes) {
      if (n.id !== nodeId) continue;
      for (const c of n.components) {
        if (c.kind === 'SpawnPoint') {
          (c as { count: number }).count = count;
          found = true;
        }
      }
    }
    if (!found) throw new Error(`夹具里没有刷怪点 ${nodeId}`);
    const r = loadLevelRuntime(doc);
    if (r.desc === null) throw new Error('装载失败：' + JSON.stringify(r.diagnostics));
    return new RuntimeSession({ desc: r.desc, seed: 11 });
  }

  const posOf = (s: RuntimeSession, nodeId: string): string[] =>
    s
      .view()
      .filter((e) => e.kind === 'npc' && e.sourceNodeId === nodeId)
      .map((e) => `${e.x.toFixed(6)},${e.z.toFixed(6)}`)
      .sort();

  it('🔴 改 sp0 的 count，sp1 / sp2 的初始位置逐位不变', () => {
    const base = posOf(withCount('nd_f1r0_sp0', 5), 'nd_f1r0_sp1');
    const after = posOf(withCount('nd_f1r0_sp0', 13), 'nd_f1r0_sp1');
    expect(base.length).toBeGreaterThan(0);
    expect(after).toEqual(base);
  });

  it('改 count 只影响被改的那一处，总数变化正确', () => {
    const s = withCount('nd_f1r0_sp0', 13);
    expect(s.view().filter((e) => e.sourceNodeId === 'nd_f1r0_sp0')).toHaveLength(13);
    expect(s.countNpc()).toBe(20); // 13 + 4 + 3
  });

  it('派生流仍然随会话种子变化（局部性不是把种子废掉）', () => {
    const a = new RuntimeSession({ desc: desc(), seed: 1 }).view().map((e) => e.x.toFixed(6));
    const b = new RuntimeSession({ desc: desc(), seed: 2 }).view().map((e) => e.x.toFixed(6));
    expect(b).not.toEqual(a);
  });
});
