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

  it('第二间战斗房（nd_f1r2）：触发只投 wave1，wave2 等清空', () => {
    const s = make();
    // C4 数据重制后该房编成：wave1 = E-01×4 + E-02×4，wave2 = E-01×4
    const r1Spawns = s.desc.spawns.filter((sp) => sp.roomNodeId === 'nd_f1r2');
    expect(r1Spawns).toHaveLength(3);
    const wave1Total = r1Spawns
      .filter((sp) => Math.max(1, sp.wave) === 1)
      .reduce((a, sp) => a + sp.count, 0);
    expect(wave1Total).toBe(8);
    // 合成触发：把玩家 teleport 进房间中心（边界从 desc.rooms 取）
    const r1 = s.desc.rooms.find((r) => r.nodeId === 'nd_f1r2')!;
    s.table.posX[s.playerEntityId] = (r1.minX + r1.maxX) / 2;
    s.table.posZ[s.playerEntityId] = (r1.minZ + r1.maxZ) / 2;
    s.step();
    expect(s.countNpc()).toBe(8 + wave1Total); // 首房 wave1 的 8 只还在 + 本房 wave1
    const starts = s.sessionEvents.filter((e) => e.type === 'wave-start' && e.roomNodeId === 'nd_f1r2');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.wave).toBe(1); // 🔴 wave2 不在触发时投放
  });

  it('wave≤0 旧数据兼容：整房刷怪点归 1 → 单波全量，清空即 cleared（无 wave2）', () => {
    // 合成：把 nd_f1r2 的 wave 全抹成 0（模拟 C4 之前的旧场景），验证兼容语义仍在
    const key = Object.keys(MODULES)[0]!;
    const doc = JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
    let touched = 0;
    for (const n of doc.nodes) {
      for (const c of n.components) {
        // 房间归属是运行时按 parent 链算的（组件上没有 roomNodeId），
        // 所以直接把整层刷怪点的 wave 抹成 0 —— 这就是 C4 之前旧场景的真实形态
        if (c.kind === 'SpawnPoint') {
          (c as { wave: number }).wave = 0;
          touched++;
        }
      }
    }
    expect(touched).toBe(6); // floor-1 共 6 个刷怪点
    const r = loadLevelRuntime(doc);
    if (r.desc === null) throw new Error('夹具装载失败');
    const s = new RuntimeSession({ desc: r.desc, seed: 7 });
    // 归 1 后整房单波：构造期首房触发即全量投放（E-01×5 + E-01×4 + E-02×3 = 12）
    expect(s.countNpc()).toBe(12);
    expect(s.sessionEvents.some((e) => e.type === 'wave-start' && e.wave === 2)).toBe(false);
    // 清完这一波即 cleared（没有第二波可投）
    for (const e of s.view()) if (e.kind === 'npc') s.applyDamage(e.id, s.table.health[e.id]!);
    s.run(5);
    expect(s.clearedRooms()).toContain('nd_f1r0');
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

// ---------------------------------------------------------------------------
// P5 C5：胜负终态（docs/23 §2.5）—— game-over 冻结 / floor-clear / 不自动清场
// ---------------------------------------------------------------------------

describe('胜负终态 · game-over 与 floor-clear', () => {
  it('玩家被围殴致死 → game-over 事件 + 世界冻结（tick 不走、实体不清场）', () => {
    const s = make();
    s.setInput(0, 0); // 站桩挨打
    let died = false;
    for (let k = 0; k < 3000 && !died; k++) {
      s.step();
      died = s.table.health[s.playerEntityId]! <= 0;
    }
    expect(died).toBe(true); // wave1 的 8 只围殴致死（100hp）
    expect(s.outcome).toBe('game-over');
    expect(s.sessionEvents.some((e) => e.type === 'game-over')).toBe(true);
    const tickAtDeath = s.tick;
    const npcsAtDeath = s.countNpc();
    s.run(50); // 冻结：世界定格
    expect(s.tick).toBe(tickAtDeath);
    expect(s.countNpc()).toBe(npcsAtDeath); // 不自动清场（死状保留）
    expect(s.table.isAlive(s.playerEntityId)).toBe(true); // 玩家槽位保留
  });

  it('终态后 step 返回空报告（宿主无需各自判终态）', () => {
    const s = make();
    s.applyDamage(s.playerEntityId, 9999);
    expect(s.outcome).toBe('game-over');
    const r = s.step();
    expect(r).toEqual({ tick: s.tick, spawned: 0, rejectedRooms: 0, rejections: [] });
  });

  it('全图清空 → floor-clear（触发全部房间并清完每间）', () => {
    const s = make();
    // 依次把玩家 teleport 进每个 enabled 房间触发，再清空全部波
    for (const room of s.desc.rooms) {
      if (!room.enabled) continue;
      s.table.posX[s.playerEntityId] = (room.minX + room.maxX) / 2;
      s.table.posZ[s.playerEntityId] = (room.minZ + room.maxZ) / 2;
      s.step();
      // 循环清波直到该房 cleared（wave2 等间隔投放）
      for (let k = 0; k < 10 && !s.clearedRooms().includes(room.nodeId); k++) {
        clearAllNpcs(s);
        s.run(65); // 跨过 60 tick 波间隔
      }
      expect(s.clearedRooms()).toContain(room.nodeId);
    }
    expect(s.outcome).toBe('floor-clear');
    expect(s.sessionEvents.some((e) => e.type === 'floor-clear')).toBe(true);
  });

  it('reset 复位终态：重跑是新的一局', () => {
    const s = make();
    s.applyDamage(s.playerEntityId, 9999);
    expect(s.outcome).toBe('game-over');
    s.reset();
    expect(s.outcome).toBe('running');
    expect(s.countNpc()).toBe(8);
  });
});


// ---------------------------------------------------------------------------
// P5 C4 补防线（评审 P2）：wave2 容量不足 → 推迟重试不丢波 + 诊断可见
// ---------------------------------------------------------------------------

describe('WaveScheduler · 容量不足的推迟重试（评审补防线）', () => {
  /** wave2 的 sp1 count 放大到 20：清空 wave1 后 free=9 < 20 → 推迟循环 */
  function makeTight(capacity: number): RuntimeSession {
    const key = Object.keys(MODULES)[0]!;
    const doc = JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
    for (const n of doc.nodes) {
      if (n.id !== 'nd_f1r0_sp1') continue;
      for (const c of n.components) {
        if (c.kind === 'SpawnPoint') (c as { count: number }).count = 20;
      }
    }
    const r = loadLevelRuntime(doc);
    if (r.desc === null) throw new Error('夹具装载失败');
    return new RuntimeSession({ desc: r.desc, seed: 7, capacity });
  }

  it('wave2 需求 > 剩余容量：推迟重试循环中不投放、不丢波、W_SPAWN_CAPACITY 诊断可见', () => {
    const s = makeTight(10); // 玩家1+wave1 8=9，wave2 需 20 > 清空后 free 9
    expect(s.countNpc()).toBe(8);
    clearAllNpcs(s);
    // 跨过多个重试间隔（60 tick × 4）：仍不投放、波未丢（nextWave 未跳过）
    s.run(260);
    expect(s.countNpc()).toBe(0);
    expect(s.sessionEvents.some((e) => e.type === 'wave-start' && e.wave === 2)).toBe(false);
    expect(s.diagnostics().some((d) => d.code === 'W_SPAWN_CAPACITY')).toBe(true);
    expect(s.clearedRooms()).toEqual([]); // 波没投完，房间不 cleared
  });

  it('容量足够时同操作 wave2 正常投放（对照：推迟不是死锁）', () => {
    const s = makeTight(64);
    expect(s.countNpc()).toBe(8);
    clearAllNpcs(s);
    for (let k = 0; k < 75; k++) s.step();
    expect(s.countNpc()).toBe(20);
    expect(s.sessionEvents.some((e) => e.type === 'wave-start' && e.wave === 2)).toBe(true);
  });
});
