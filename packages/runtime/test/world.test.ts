/**
 * runtime 内核单测。
 *
 * 这里验的是**行为**而不是结构 —— headless runtime 的全部价值就在于
 * 「不打开编辑器也能证明玩法逻辑是对的」，所以每条断言都对应一个玩法事实：
 * 僵尸会靠近玩家、不会被叠在一起、同种子必然重演出同一场战斗。
 */
import { describe, it, expect } from 'vitest';
import { AgentKind, World, makeRng, type CharacterStats } from '../src';

const ZOMBIE: CharacterStats = { id: 'E-01', speed: 1.4, radius: 0.35, height: 1.75 };
const PLAYER: CharacterStats = { id: 'PLAYER', speed: 4.0, radius: 0.4, height: 1.8 };

function dist(w: World, a: number, b: number): number {
  const dx = w.x[a]! - w.x[b]!;
  const dz = w.z[a]! - w.z[b]!;
  return Math.hypot(dx, dz);
}

/** 一步到位的常用场景：玩家在原点，一群僵尸在 +X 方向 20 米处 */
function setup(count: number, seed = 42): { w: World; player: number } {
  const w = new World({ capacity: 256 });
  const player = w.addPlayer(0, 0, PLAYER);
  w.spawn({ x: 20, z: 0, characterId: ZOMBIE.id, count, spread: 1.5, stats: ZOMBIE }, makeRng(seed));
  return { w, player };
}

describe('World', () => {
  it('spawn 生成指定数量，且类别是僵尸', () => {
    const { w } = setup(6);
    expect(w.size).toBe(7); // 1 玩家 + 6 僵尸
    expect(w.kind[0]).toBe(AgentKind.Player);
    for (let i = 1; i <= 6; i++) expect(w.kind[i]).toBe(AgentKind.Zombie);
  });

  it('tick 后僵尸朝玩家靠近（追击生效）', () => {
    const { w, player } = setup(4);
    const before = [1, 2, 3, 4].map((i) => dist(w, i, player));
    for (let k = 0; k < 60; k++) w.tick(1 / 30); // 2 秒
    const after = [1, 2, 3, 4].map((i) => dist(w, i, player));
    after.forEach((d, k) => expect(d).toBeLessThan(before[k]!));
  });

  it('移动速度不超过角色 speed（1.4 m/s）', () => {
    const { w } = setup(1);
    const x0 = w.x[1]!;
    w.tick(1); // 1 秒
    expect(Math.abs(w.x[1]! - x0)).toBeLessThanOrEqual(ZOMBIE.speed + 1e-3);
  });

  it('同种子完全可复现 —— 这是能写回归断言的前提', () => {
    const a = setup(12, 20260915);
    const b = setup(12, 20260915);
    for (let k = 0; k < 90; k++) {
      a.w.tick(1 / 30);
      b.w.tick(1 / 30);
    }
    for (let i = 0; i < a.w.size; i++) {
      expect(b.w.x[i]).toBeCloseTo(a.w.x[i]!, 5);
      expect(b.w.z[i]).toBeCloseTo(a.w.z[i]!, 5);
    }
  });

  it('不同种子给出不同散布（随机确实生效）', () => {
    const a = setup(8, 1);
    const b = setup(8, 999);
    expect(b.w.z[1]).not.toBeCloseTo(a.w.z[1]!, 3);
  });

  it('分离力阻止实体叠在一点', () => {
    const { w } = setup(10);
    for (let k = 0; k < 30; k++) w.tick(1 / 30);
    for (let i = 1; i < w.size; i++) {
      for (let j = i + 1; j < w.size; j++) {
        expect(dist(w, i, j)).toBeGreaterThan(0.05);
      }
    }
  });

  it('容量满了抛错，不静默丢弃', () => {
    const w = new World({ capacity: 4 });
    w.addPlayer(0, 0, PLAYER);
    expect(() => {
      w.spawn({ x: 5, z: 0, characterId: ZOMBIE.id, count: 10, spread: 1, stats: ZOMBIE }, makeRng(1));
    }).toThrow(/容量已满/);
  });

  it('没有存活玩家时僵尸原地不动（不是乱跑）', () => {
    const w = new World({ capacity: 32 });
    w.spawn({ x: 10, z: 10, characterId: ZOMBIE.id, count: 3, spread: 1, stats: ZOMBIE }, makeRng(7));
    const x0 = w.x[0]!;
    const z0 = w.z[0]!;
    for (let k = 0; k < 30; k++) w.tick(1 / 30);
    expect(w.x[0]).toBeCloseTo(x0, 5);
    expect(w.z[0]).toBeCloseTo(z0, 5);
  });

  it('snapshot 只返回存活实体', () => {
    const { w } = setup(3);
    w.alive[2] = 0;
    expect(w.snapshot()).toHaveLength(3); // 4 个里死了一个
    expect(w.snapshot().every((a) => a.alive)).toBe(true);
  });
});
