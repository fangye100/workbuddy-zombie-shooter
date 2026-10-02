import { describe, it, expect } from 'vitest';
import { RuntimeSession } from '../src/session';
import { loadLevelRuntime } from '../src/loader';
import { NPC_STATS, PLAYER_STATS } from '@aether/content';
import type { SceneDocument } from '@aether/scene';

/**
 * P5 C2 战斗内核测试（docs/23 §2.1/§2.3）：
 *  - applyDamage 单入口：减血 / 事件 / 受击高亮
 *  - kill 回收：NPC 槽位销毁回 freelist（aliveCount 有减）、generation 防冒名
 *  - 玩家不死槽：血量归零但槽位保留（C5 失败冻结的语义前提）
 *  - 血量真源链：spawn 时 health = maxHp = stats.hp（roster 交叉校验过的数）
 */

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function make(): RuntimeSession {
  const key = Object.keys(MODULES)[0]!;
  const doc = (MODULES[key] as { default: unknown }).default as SceneDocument;
  const r = loadLevelRuntime(doc);
  if (r.desc === null) throw new Error('夹具装载失败：' + JSON.stringify(r.diagnostics));
  return new RuntimeSession({ desc: r.desc, seed: 1 });
}

/** 第一只存活 NPC 的槽位（floor-1 首间房刷出的 E-01 之一） */
function firstNpc(s: RuntimeSession): number {
  for (let i = 0; i < s.table.capacity; i++) {
    if (s.table.isAlive(i) && i !== s.playerEntityId) return i;
  }
  throw new Error('夹具里没有存活 NPC');
}

describe('applyDamage · 单入口与事件（docs/23 §2.1a）', () => {
  it('减血 + hpAfter + 受击高亮 + damage 事件（字段逐项）', () => {
    const s = make();
    const slot = firstNpc(s);
    const hp0 = s.table.health[slot]!;
    const r = s.applyDamage(slot, 10, s.playerEntityId);
    expect(r).toEqual({ died: false, hpAfter: hp0 - 10 });
    expect(s.table.health[slot]).toBe(hp0 - 10);
    expect(s.table.hitFlash[slot]).toBeCloseTo(0.15, 5);
    const ev = s.combatEvents.at(-1)!;
    expect(ev.type).toBe('damage');
    expect(ev.amount).toBe(10);
    expect(ev.hpAfter).toBe(hp0 - 10);
    expect(ev.slot).toBe(slot);
    expect(ev.sourceSlot).toBe(s.playerEntityId);
  });

  it('血量真源链：E-01 出生血量 = stats.hp（roster 交叉校验过的 60）', () => {
    const s = make();
    const e01 = NPC_STATS.find((n) => n.id === 'E-01')!;
    expect(e01.hp).toBe(60); // 锁死真源数值——stats.json 改动必须是有意识的
    let seen = 0;
    for (let i = 0; i < s.table.capacity; i++) {
      if (!s.table.isAlive(i) || i === s.playerEntityId) continue;
      expect(s.table.maxHp[i]).toBe(s.table.health[i]); // 满血出生
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('kill · NPC 死亡回收（docs/23 §2.3）', () => {
  it('血量归零 → died + 槽位销毁（view 消失、aliveCount 减）+ kill 事件', () => {
    const s = make();
    const slot = firstNpc(s);
    const before = s.countNpc();
    const id = s.view().find((e) => e.id === slot)!.characterId;
    const r = s.applyDamage(slot, s.table.health[slot]!, s.playerEntityId);
    expect(r.died).toBe(true);
    expect(r.hpAfter).toBe(0);
    expect(s.table.isAlive(slot)).toBe(false);
    expect(s.countNpc()).toBe(before - 1);
    expect(s.view().some((e) => e.id === slot)).toBe(false); // 渲染批次自动减员
    const ev = s.combatEvents.at(-1)!;
    expect(ev.type).toBe('kill');
    expect(ev.characterId).toBe(id);
    expect(ev.hpAfter).toBe(0);
  });

  it('回收的槽位可被再次分配，且 generation 递增（旧引用防冒名）', () => {
    const s = make();
    const slot = firstNpc(s);
    const genBefore = s.table.generation[slot]!;
    s.applyDamage(slot, s.table.health[slot]!, s.playerEntityId);
    // 手动在回收槽上再生成（模拟后续波次复用 freelist）
    const re = s.table.spawn(s.table.defId[slot]!);
    expect(re).toBe(slot); // LIFO freelist：刚还回去的槽位先被再分配
    expect(s.table.generation[slot]!).toBeGreaterThan(genBefore);
  });

  it('打死一只后剩余实体照常推进（回收不破坏遍历）', () => {
    const s = make();
    const slot = firstNpc(s);
    s.applyDamage(slot, s.table.health[slot]!, s.playerEntityId);
    const reports = s.run(30);
    expect(reports).toHaveLength(30); // 不抛异常 = 表遍历/求解器没被死槽绊倒
    expect(s.countNpc()).toBeGreaterThan(0);
  });
});

describe('applyDamage · 玩家不死槽（docs/23 §2.3「保留死状」）', () => {
  it('玩家血量归零 → died=true 但槽位保留（失败冻结是 C5 的消费方）', () => {
    const s = make();
    const hp = s.table.health[s.playerEntityId]!;
    expect(hp).toBe(PLAYER_STATS.hp); // 100，C1 落的作者数据
    const r = s.applyDamage(s.playerEntityId, hp + 1);
    expect(r.died).toBe(true);
    expect(s.table.health[s.playerEntityId]).toBe(0);
    expect(s.table.isAlive(s.playerEntityId)).toBe(true); // 🔴 不销毁：死了要看得见
    expect(s.combatEvents.at(-1)!.type).toBe('kill');
    expect(s.combatEvents.at(-1)!.characterId).toBe('P-01');
  });
});

describe('applyDamage · 边界', () => {
  it('对死槽再打：无副作用、无事件、返回 died=false', () => {
    const s = make();
    const slot = firstNpc(s);
    s.applyDamage(slot, 9999);
    const evCount = s.combatEvents.length;
    const r = s.applyDamage(slot, 10);
    expect(r).toEqual({ died: false, hpAfter: 0 });
    expect(s.combatEvents.length).toBe(evCount);
  });

  it('溢出伤害钳到 0（负血量会让 HUD/血条渲染出脏值）', () => {
    const s = make();
    const slot = firstNpc(s);
    const r = s.applyDamage(slot, s.table.health[slot]! + 12345);
    expect(r.hpAfter).toBe(0);
    expect(s.table.health[slot]).toBe(0);
  });

  it('reset 换代清空战斗事件（跨代残留 = 击杀统计重复计账）', () => {
    const s = make();
    s.applyDamage(firstNpc(s), 5);
    expect(s.combatEvents.length).toBeGreaterThan(0);
    s.reset();
    expect(s.combatEvents.length).toBe(0);
  });
});
