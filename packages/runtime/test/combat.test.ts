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

// ---------------------------------------------------------------------------
// P5 C3：四态攻击机 + 玩家手枪（docs/23 §2.2/§2.3）
// 数值全部来自 stats 真源：E-01 挥抓 8 伤 / 0.8s 前摇 / 1.6s CD / 2.2m；
// 手枪 12 伤 / 0.35s CD / 18m —— 断言锁的是「数值驱动的时序」，不是魔法数字。
// ---------------------------------------------------------------------------

describe('NPC 四态 · windup → strike → CD（E-01 数值驱动）', () => {
  it('玩家站桩：僵尸追入 2.2m → 前摇 0.8s（24 tick 站定）→ 玩家掉 8 血 → CD 1.6s 后再来', () => {
    const s = make();
    const p = s.playerEntityId;
    const hp0 = s.table.health[p]!;
    // 跑到第一只僵尸开始挥抓（黑盒：玩家血量第一次下降的时刻）
    let hitTick = -1;
    for (let k = 0; k < 600 && hitTick < 0; k++) {
      s.step();
      if (s.table.health[p]! < hp0) hitTick = s.tick;
    }
    expect(hitTick).toBeGreaterThan(0); // 追上了并造成了伤害
    // 单 tick 减量 = 同 tick 命中的 E-01(8×a) 与 E-02(18×b) 之和——组合枚举断言
    const combo = new Set<number>();
    for (let a = 0; a <= 7; a++) for (let b = 0; b <= 3; b++) if (a + b > 0) combo.add(8 * a + 18 * b);
    expect(combo.has(hp0 - s.table.health[p]!)).toBe(true);
    // 同一只僵尸的连续打击 ≥ CD 1.6s = 48 tick：不同僵尸轮流打没有 CD 关系，
    // 必须按 combatEvents 的同 slot 相邻两次 damage 断言
    s.run(200);
    const bySlot = new Map<number, number[]>();
    for (const ev of s.combatEvents) {
      if (ev.type !== 'damage') continue;
      // 🔴 ev.slot 是受击者（恒玩家）——连续打击节奏必须按攻击者 sourceSlot 分组
      const list = bySlot.get(ev.sourceSlot) ?? [];
      list.push(ev.tick);
      bySlot.set(ev.sourceSlot, list);
    }
    let minGap = Infinity;
    let repeatAttacker = 0;
    for (const ticks of bySlot.values()) {
      for (let k = 1; k < ticks.length; k++) {
        minGap = Math.min(minGap, ticks[k]! - ticks[k - 1]!);
        repeatAttacker++;
      }
    }
    expect(repeatAttacker).toBeGreaterThan(0); // 有僵尸打出了第二击
    expect(minGap).toBeGreaterThanOrEqual(48); // 不早于 CD（1.6s / (1/30)）
  });

  it('windup 期间僵尸站定（位置冻结）', () => {
    const s = make();
    // 等任一僵尸进入 WINDUP 态（2）
    let slot = -1;
    for (let k = 0; k < 600 && slot < 0; k++) {
      s.step();
      for (let i = 0; i < s.table.capacity; i++) {
        if (s.table.isAlive(i) && s.table.behavior[i] === 2) { slot = i; break; }
      }
    }
    expect(slot).toBeGreaterThanOrEqual(0);
    const x = s.table.posX[slot]!;
    const z = s.table.posZ[slot]!;
    s.step();
    expect(s.table.posX[slot]).toBe(x); // 蓄力站定
    expect(s.table.posZ[slot]).toBe(z);
  });

  it('确定性：同种子两个会话逐步对跑，玩家血量序列逐位一致', () => {
    const a = make();
    const b = make();
    const hpA: number[] = [];
    for (let k = 0; k < 400; k++) {
      a.step();
      b.step();
      hpA.push(a.table.health[a.playerEntityId]!);
      expect(a.table.health[b.playerEntityId]!).toBe(hpA[k]!);
    }
    expect(new Set(hpA).size).toBeGreaterThan(1); // 确实发生了战斗（序列有变化）
  });
});

describe('玩家手枪 · 射线命中与 CD（12 伤 / 0.35s / 18m）', () => {
  it('朝僵尸开火：5 枪打死一只 E-01（hp60 / 12 伤），CD 节流命中间隔 ≥ 10 tick', () => {
    const s = make();
    const target = firstNpc(s);
    const hp0 = s.table.health[target]!;
    expect(hp0).toBe(60);
    // 摆位：目标僵尸 teleport 到玩家 +x 侧 3m（🔴 不能挪玩家——会跨房间触发再刷一批；
    // 也不能 setInput(1,0)——那是移动输入，玩家会跑图。零输入站桩，fireStep 用
    // 玩家 yaw（初始 0 = 朝 +x）作为射击方向 → 正对僵尸）
    s.table.posX[target] = s.table.posX[s.playerEntityId]! + 3;
    s.table.posZ[target] = s.table.posZ[s.playerEntityId]!;
    s.setInput(0, 0);
    s.setFire(true);
    let killTick = -1;
    let firstHitTick = -1;
    let hits = 0;
    let lastHp = hp0;
    for (let k = 0; k < 300 && killTick < 0; k++) {
      s.step();
      const hp = s.table.health[target]!;
      if (hp < lastHp) {
        if (firstHitTick < 0) firstHitTick = s.tick;
        hits++;
        expect(lastHp - hp).toBe(12); // 每枪 12（真源）
        lastHp = hp;
      }
      if (!s.table.isAlive(target)) killTick = s.tick;
    }
    s.setFire(false);
    expect(killTick).toBeGreaterThan(0); // 打死了
    expect(hits).toBe(5); // 60/12 = 5 枪，一发不多
    expect(killTick - firstHitTick).toBeGreaterThanOrEqual(4 * 10); // 4 个 CD 间隔（0.35s≈10.5 tick）
  });

  it('kill 事件后槽位回收，其余僵尸不受牵连（单点伤害）', () => {
    const s = make();
    const before = s.countNpc();
    const target = firstNpc(s);
    s.table.posX[target] = s.table.posX[s.playerEntityId]! + 3;
    s.table.posZ[target] = s.table.posZ[s.playerEntityId]!;
    s.setInput(0, 0);
    s.setFire(true);
    for (let k = 0; k < 300 && s.table.isAlive(target); k++) s.step();
    s.setFire(false);
    expect(s.countNpc()).toBe(before - 1); // 只死了被打的
    expect(s.table.isAlive(s.playerEntityId)).toBe(true);
  });

  it('真源断言：B-02/B-03 的 attack=null（combatStep 对 null 永不进 windup 的数据前提）', () => {
    // 真源断言：stats 里 B-02/B-03 的 attack 确为 null（数据前提）
    const b02 = NPC_STATS.find((n) => n.id === 'B-02')!;
    const b03 = NPC_STATS.find((n) => n.id === 'B-03')!;
    expect(b02.attack).toBeNull();
    expect(b03.attack).toBeNull();
  });
});
