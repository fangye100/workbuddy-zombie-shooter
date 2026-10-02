import { describe, it, expect } from 'vitest';
import { RuntimeSession } from '../src/session';
import { loadLevelRuntime } from '../src/loader';
import type { SceneDocument } from '@aether/scene';

/**
 * P5 C4 WaveScheduler 测试（docs/23 §2.4/§3）。
 *
 * floor-1 第一间房（nd_f1r0）C4 重制后的数据：
 *   wave 1 = E-01×5 + E-02×3（8 只）  wave 2 = E-01×4
 * 验收口径（docs/23 §4-2）：wave 时序确定（wave2 投放的 tick 与组成可断言）；
 * 清空才进下一波；同种子复现一致。
 */

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function make(): RuntimeSession {
  const key = Object.keys(MODULES)[0]!;
  const doc = (MODULES[key] as { default: unknown }).default as SceneDocument;
  const r = loadLevelRuntime(doc);
  if (r.desc === null) throw new Error('夹具装载失败：' + JSON.stringify(r.diagnostics));
  return new RuntimeSession({ desc: r.desc, seed: 7 });
}

/** 清空当前全部存活 NPC（走 applyDamage 单入口——也是对本轮红线的一次复用） */
function clearAllNpcs(s: RuntimeSession): void {
  for (const e of s.view()) {
    if (e.kind === 'npc') s.applyDamage(e.id, s.table.health[e.id]!);
  }
}

describe('WaveScheduler · 触发即投 wave1，wave2 等清空（docs/23 §2.4）', () => {
  it('首房触发只投 wave1（8 只：E-01×5+E-02×3），wave2 的 E-01×4 不出现', () => {
    const s = make();
    expect(s.countNpc()).toBe(8);
    const kinds = s.view().filter((e) => e.kind === 'npc');
    expect(kinds.filter((e) => e.characterId === 'E-01')).toHaveLength(5);
    expect(kinds.filter((e) => e.characterId === 'E-02')).toHaveLength(3);
    // wave-start 事件：wave 1 已投
    const starts = s.sessionEvents.filter((e) => e.type === 'wave-start');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.wave).toBe(1);
    expect(starts[0]!.roomNodeId).toBe('nd_f1r0');
  });

  it('wave1 不清空：跑 300 tick（>> 2s 间隔）wave2 绝不投放', () => {
    const s = make();
    s.run(300);
    expect(s.countNpc()).toBe(8); // 一只没死（没有外界伤害），也没新增
    expect(s.sessionEvents.some((e) => e.type === 'wave-start' && e.wave === 2)).toBe(false);
    expect(s.clearedRooms()).not.toContain('nd_f1r0');
  });

  it('清空 wave1 → 间隔 2s（60 tick）→ wave2 投放（E-01×4，tick 精确可断言）', () => {
    const s = make();
    s.run(10); // 稳定在 wave1
    clearAllNpcs(s);
    const clearedTick = s.tick;
    expect(s.countNpc()).toBe(0);
    // 内部时序：updateWaves 在 tickCount 自增**前**跑——下一 step 用 tickCount=clearedTick
    // 检测清空 → nextWaveAtTick = clearedTick+60；到点 step 的事件 tick 也记内部值
    while (s.tick < clearedTick + 62) s.step();
    const wave2 = s.sessionEvents.find((e) => e.type === 'wave-start' && e.wave === 2);
    expect(wave2).toBeDefined();
    expect(wave2!.tick).toBe(clearedTick + 60); // 🔴 时序确定：清空 tick + 60（2s）
    expect(s.countNpc()).toBe(4);
    expect(s.view().filter((e) => e.kind === 'npc').every((e) => e.characterId === 'E-01')).toBe(true);
  });

  it('wave2 也清空 → 房间 cleared 事件 + clearedRooms 收录', () => {
    const s = make();
    clearAllNpcs(s);
    s.run(70); // 跨过 wave2 投放
    expect(s.countNpc()).toBe(4);
    clearAllNpcs(s);
    s.run(5);
    expect(s.clearedRooms()).toContain('nd_f1r0');
    const cleared = s.sessionEvents.find((e) => e.type === 'room-cleared');
    expect(cleared).toBeDefined();
    expect(cleared!.roomNodeId).toBe('nd_f1r0');
  });

  it('同种子复现：相同操作序列下 wave2 投放 tick 与实体集合逐位一致', () => {
    const run = () => {
      const s = make();
      s.run(10);
      clearAllNpcs(s);
      for (let k = 0; k < 75; k++) s.step();
      return {
        tick: s.tick,
        wave2Tick: s.sessionEvents.find((e) => e.type === 'wave-start' && e.wave === 2)?.tick ?? -1,
        npcs: s
          .view()
          .filter((e) => e.kind === 'npc')
          .map((e) => `${e.id}:${e.characterId}:${e.x.toFixed(4)},${e.z.toFixed(4)}`)
          .sort(),
      };
    };
    const a = run();
    const b = run();
    expect(b.wave2Tick).toBe(a.wave2Tick);
    expect(b.npcs).toEqual(a.npcs);
  });

  it('wave=0 旧语义兼容：单波全量（第二间房触发时一次性投放，无 wave2）', () => {
    const s = make();
    // 房间 r1（nd_f1r1）的刷怪点 wave 全 0 → 归 1 → 单波；玩家不动不触发，直接查 desc 语义：
    const r1Spawns = s.desc.spawns.filter((sp) => sp.roomNodeId === 'nd_f1r2');
    expect(r1Spawns.length).toBeGreaterThan(0);
    // 合成触发：把玩家 teleport 进 r1 边界（房间边界从 desc.rooms 取）
    const r1 = s.desc.rooms.find((r) => r.nodeId === 'nd_f1r2')!;
    s.table.posX[s.playerEntityId] = (r1.minX + r1.maxX) / 2;
    s.table.posZ[s.playerEntityId] = (r1.minZ + r1.maxZ) / 2;
    s.step();
    const total = r1Spawns.reduce((a, sp) => a + sp.count, 0);
    expect(s.countNpc()).toBe(8 + total); // wave1 的 8 只还在 + r1 全量
    // 单波房间：当前波清空即 cleared（没有 wave2）
    expect(s.sessionEvents.some((e) => e.type === 'wave-start' && e.roomNodeId === 'nd_f1r2' && e.wave === 1)).toBe(true);
  });

  it('reset 换代清空波次状态（重跑从 wave1 开始，无跨代残留）', () => {
    const s = make();
    clearAllNpcs(s);
    s.run(70);
    expect(s.sessionEvents.some((e) => e.type === 'wave-start' && e.wave === 2)).toBe(true);
    s.reset();
    // reset 重建世界会**立即**触发首房 wave1 → 新代事件恰 1 条（不是残留是重生）
    expect(s.sessionEvents.filter((e) => e.type === 'wave-start')).toHaveLength(1);
    expect(s.sessionEvents.some((e) => e.type === 'wave-start' && e.wave === 2)).toBe(false);
    expect(s.clearedRooms()).toEqual([]);
    expect(s.countNpc()).toBe(8); // 回到 wave1
  });
});
