import { describe, it, expect } from 'vitest';
import { RuntimeSession, DEFAULT_LOD_THRESHOLDS } from '../src/session';
import { loadLevelRuntime } from '../src/loader';
import type { SceneDocument } from '@aether/scene';

/**
 * P4 M4「规模与降级」（docs/20 §M4）：
 *  - refreshLod：按相机距离定档（近 Full / 远 Proxy 退胶囊）
 *  - debugSpawn：200 只压测的注入通道（调试用，不进玩法路径）
 */
const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function make(): RuntimeSession {
  const key = Object.keys(MODULES)[0]!;
  const doc = (MODULES[key] as { default: unknown }).default as SceneDocument;
  const r = loadLevelRuntime(doc);
  if (r.desc === null) throw new Error('夹具装载失败：' + JSON.stringify(r.diagnostics));
  return new RuntimeSession({ desc: r.desc, seed: 3 });
}

/** 视野内的 NPC 档位分布（0 = Full / 1 = Vat / 2 = Proxy） */
function tiers(s: RuntimeSession): { full: number; vat: number; proxy: number } {
  const out = { full: 0, vat: 0, proxy: 0 };
  for (const e of s.view()) {
    if (e.kind !== 'npc') continue;
    if (e.lodTier === 0) out.full++;
    else if (e.lodTier === 1) out.vat++;
    else out.proxy++;
  }
  return out;
}

describe('refreshLod · 按相机距离定档（P4 M4）', () => {
  it('相机贴脸：全部 Full(0)（真模型）', () => {
    const s = make();
    const p = s.playerEntityId;
    s.refreshLod(s.table.posX[p]!, s.table.posZ[p]!);
    const t = tiers(s);
    expect(t.proxy).toBe(0); // 没有一只退胶囊
    expect(t.full + t.vat).toBe(s.countNpc());
  });

  it('相机拉到 200m 外：全部 Proxy(2)（退胶囊）', () => {
    const s = make();
    const p = s.playerEntityId;
    s.refreshLod(s.table.posX[p]! + 200, s.table.posZ[p]!);
    const t = tiers(s);
    expect(t.proxy).toBe(s.countNpc());
    expect(t.full).toBe(0);
  });

  it('分档：近处 Full + 远处 Proxy 同时存在（降级不是「全开或全关」）', () => {
    const s = make();
    const p = s.playerEntityId;
    // 一半留在玩家身边，一半搬到 150m 外（跨过 vatDistance=60）
    const far = Math.floor(s.countNpc() / 2);
    let moved = 0;
    for (const e of s.view()) {
      if (e.kind !== 'npc') continue;
      if (moved < far) {
        s.table.posX[e.id] = s.table.posX[p]! + 150;
        s.table.posZ[e.id] = s.table.posZ[p]!;
        moved++;
      } else {
        // 近处组显式摆到玩家身边（房间可能有 25m 宽，不摆会整组掉出 Full 阈值）
        s.table.posX[e.id] = s.table.posX[p]! + 3;
        s.table.posZ[e.id] = s.table.posZ[p]!;
      }
    }
    // 调**两次**：LOD 是渐进升级的（Proxy → Vat → Full，一帧只跨一档，
    // 这是迟滞的设计），单帧刷新只能从 Proxy 升到 Vat
    s.refreshLod(s.table.posX[p]!, s.table.posZ[p]!);
    s.refreshLod(s.table.posX[p]!, s.table.posZ[p]!);
    const t = tiers(s);
    expect(t.full).toBeGreaterThan(0);
    expect(t.proxy).toBeGreaterThan(0);
  });

  it('阈值真源：30m 处落在 Full~Vat 之间（不是 Proxy）', () => {
    const s = make();
    const p = s.playerEntityId;
    for (const e of s.view()) {
      if (e.kind !== 'npc') continue;
      s.table.posX[e.id] = s.table.posX[p]! + 30; // fullDistance=25 < 30 < vatDistance=60
      s.table.posZ[e.id] = s.table.posZ[p]!;
    }
    s.refreshLod(s.table.posX[p]!, s.table.posZ[p]!);
    expect(tiers(s).proxy).toBe(0);
    expect(DEFAULT_LOD_THRESHOLDS.fullDistance).toBeLessThan(30);
    expect(DEFAULT_LOD_THRESHOLDS.vatDistance).toBeGreaterThan(30);
  });

  it('迟滞：在降级线附近来回不抖（同一相机位置重复刷新 → 切换数为 0）', () => {
    const s = make();
    const p = s.playerEntityId;
    s.refreshLod(s.table.posX[p]! + 60, s.table.posZ[p]!); // 拉到降级线附近
    const second = s.refreshLod(s.table.posX[p]! + 60, s.table.posZ[p]!);
    expect(second).toBe(0); // 没有实体再次切档
  });
});

describe('debugSpawn · 压测注入通道（P4 M4）', () => {
  it('生成指定数量，且都是 npc（走与玩法相同的槽位初始化）', () => {
    const s = make();
    const p = s.playerEntityId;
    const before = s.countNpc();
    const made = s.debugSpawn('E-01', s.table.posX[p]!, s.table.posZ[p]!, 50, 12);
    expect(made).toBe(50);
    expect(s.countNpc()).toBe(before + 50);
    // 血量来自真源（不是 0 —— 0 血的僵尸一碰就死，压测测不出真实负载）
    for (const e of s.view()) {
      if (e.kind !== 'npc') continue;
      expect(e.hp).toBeGreaterThan(0);
    }
  });

  it('🔴 不进房间计数：只清玩法刷出的那批，房间就判定清空（注入的不算房内敌）', () => {
    const s = make();
    const p = s.playerEntityId;
    s.debugSpawn('E-01', s.table.posX[p]! + 5, s.table.posZ[p]!, 30, 6);
    // 只杀**玩法刷出的** NPC（sourceNodeId ≠ null），注入的 30 只（null）全部留着。
    // 判别力：若注入的被算进房间存活数，房间永远不会"清空"，wave2 也就永不投放。
    let killed = 0;
    for (const e of s.view()) {
      if (e.kind === 'npc' && e.sourceNodeId !== null) {
        s.applyDamage(e.id, s.table.health[e.id]!);
        killed++;
      }
    }
    expect(killed).toBeGreaterThan(0);
    s.run(70); // 跨过 60 tick 波间隔
    expect(s.sessionEvents.some((e) => e.type === 'wave-start' && e.wave === 2)).toBe(true);
  });

  it('容量用尽：返回实际生成数，不抛也不静默少给', () => {
    const s = make();
    const p = s.playerEntityId;
    const free = s.table.capacity - s.table.aliveCount;
    const made = s.debugSpawn('E-01', s.table.posX[p]!, s.table.posZ[p]!, free + 500, 20);
    expect(made).toBe(free);
    expect(s.table.aliveCount).toBe(s.table.capacity);
  });

  it('未知 characterId → 0（不抛，压测脚本不会因此中断）', () => {
    const s = make();
    expect(s.debugSpawn('E-99', 0, 0, 10)).toBe(0);
  });
});
