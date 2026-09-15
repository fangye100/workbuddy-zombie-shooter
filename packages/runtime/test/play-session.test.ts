import { describe, it, expect } from 'vitest';
import { PlaySession } from '../src/play-session';
import type { SceneDocument } from '@aether/scene';

/**
 * WU-4：PlaySession 状态机与清理测试（docs/17 §6 "测试 owner"）。
 *
 * 这些用例是**纯 CPU** 的，不需要 GPU、不需要浏览器 —— 这正是把状态机放进
 * runtime 包而不是塞进 UI 代码的原因：「按钮显示暂停但循环还在推进」这类
 * 只有实机才复现的鬼故事，在这里就是一行断言。
 */
const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function floor1(): SceneDocument {
  const key = Object.keys(MODULES)[0]!;
  return JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
}

describe('PlaySession —— 状态机', () => {
  it('初始是 stopped，没有世界', () => {
    const s = new PlaySession();
    expect(s.state).toBe('stopped');
    expect(s.running).toBe(false);
    expect(s.runtime).toBeNull();
    expect(s.entities).toEqual([]);
    expect(s.tick).toBe(0);
  });

  it('play 成功后进入 playing，世界已刷出第一间房', () => {
    const s = new PlaySession();
    expect(s.play(floor1()).ok).toBe(true);
    expect(s.state).toBe('playing');
    expect(s.running).toBe(true);
    expect(s.entities.length).toBeGreaterThan(1);
  });

  it('pause → paused，resume → playing', () => {
    const s = new PlaySession();
    s.play(floor1());
    s.pause();
    expect(s.state).toBe('paused');
    s.resume();
    expect(s.state).toBe('playing');
  });

  it('stop → stopped 且世界被释放（引用断开，不留半运行世界）', () => {
    const s = new PlaySession();
    s.play(floor1());
    s.stop();
    expect(s.state).toBe('stopped');
    expect(s.runtime).toBeNull();
    expect(s.entities).toEqual([]);
  });

  it('stopped 状态下 pause/resume/step 都是空操作，不会偷偷造世界', () => {
    const s = new PlaySession();
    s.pause();
    s.resume();
    s.stepOnce();
    expect(s.state).toBe('stopped');
    expect(s.runtime).toBeNull();
  });
});

describe('PlaySession —— 固定步调度', () => {
  it('渲染帧率不决定游戏步数：同样 1 秒，大帧小帧走的总步数一致', () => {
    const a = new PlaySession({ maxCatchUpSteps: 1000 });
    const b = new PlaySession({ maxCatchUpSteps: 1000 });
    a.play(floor1());
    b.play(floor1());
    for (let i = 0; i < 60; i++) a.advance(1 / 60); // 60fps
    for (let i = 0; i < 10; i++) b.advance(0.1); // 10fps
    // fixedStep = 1/30 → 1 秒 ≈ 30 步（浮点累加会有 ±1 的尾差）
    expect(Math.abs(a.tick - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(b.tick - 30)).toBeLessThanOrEqual(1);
  });

  it('单帧追赶有上限：一次喂 10 秒不会瞬移 300 步', () => {
    const s = new PlaySession({ maxCatchUpSteps: 5 });
    s.play(floor1());
    const n = s.advance(10);
    expect(n).toBe(5);
    expect(s.tick).toBe(5);
  });

  it('追赶上限用尽后丢弃积压，不会在下一帧补得更凶', () => {
    const s = new PlaySession({ maxCatchUpSteps: 5 });
    s.play(floor1());
    s.advance(10); // 补 5 步，积压被丢
    const n = s.advance(0.001); // 远不足一步
    expect(n).toBe(0);
    expect(s.tick).toBe(5);
  });

  it('暂停期间不推进；恢复后不补算暂停的墙钟', () => {
    const s = new PlaySession();
    s.play(floor1());
    for (let i = 0; i < 10; i++) s.advance(0.1);
    const t = s.tick;
    s.pause();
    for (let i = 0; i < 50; i++) s.advance(0.1); // 暂停 5 秒
    expect(s.tick).toBe(t);
    s.resume();
    s.advance(0.001);
    expect(s.tick).toBe(t); // 恢复瞬间不补 5 秒
  });

  it('坏 dt（0 / 负数 / NaN）不会污染累加器', () => {
    const s = new PlaySession();
    s.play(floor1());
    expect(s.advance(0)).toBe(0);
    expect(s.advance(-1)).toBe(0);
    expect(s.advance(NaN)).toBe(0);
    expect(s.tick).toBe(0);
  });

  it('单步只在暂停下生效', () => {
    const s = new PlaySession();
    s.play(floor1());
    s.stepOnce(); // playing 下忽略
    expect(s.tick).toBe(0);
    s.pause();
    s.stepOnce();
    expect(s.tick).toBe(1);
    s.stepOnce();
    expect(s.tick).toBe(2);
  });
});

describe('PlaySession —— 启动失败清理（docs/17 §7）', () => {
  it('缺玩家起点：不建世界、状态回 stopped、错误带中文原因', () => {
    const doc = floor1();
    doc.playerStart = null;
    const s = new PlaySession();
    const r = s.play(doc);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(s.state).toBe('stopped');
    expect(s.runtime).toBeNull();
  });

  it('启动失败会清掉上一次的残留世界（不留半运行世界）', () => {
    const s = new PlaySession();
    expect(s.play(floor1()).ok).toBe(true);
    s.advance(0.5);
    const bad = floor1();
    bad.playerStart = 'nd_不存在';
    expect(s.play(bad).ok).toBe(false);
    expect(s.runtime).toBeNull();
    expect(s.state).toBe('stopped');
    expect(s.entities).toEqual([]);
  });

  it('启动失败不增加启停计数（没真的开过就不算一次）', () => {
    const s = new PlaySession();
    const bad = floor1();
    bad.playerStart = null;
    s.play(bad);
    expect(s.cycleCount).toBe(0);
    s.play(floor1());
    expect(s.cycleCount).toBe(1);
  });
});

describe('PlaySession —— Reset 与 20 次启停账目', () => {
  it('reset 回到 tick 0，实体数不累积', () => {
    const s = new PlaySession();
    s.play(floor1());
    const n = s.entities.length;
    for (let i = 0; i < 20; i++) s.advance(0.1);
    s.reset();
    expect(s.tick).toBe(0);
    expect(s.entities.length).toBe(n);
  });

  it('同种子重跑逐位一致（这是 A/B 对比的前提）', () => {
    const a = new PlaySession({ seed: 7 });
    const b = new PlaySession({ seed: 7 });
    a.play(floor1());
    b.play(floor1());
    for (let i = 0; i < 10; i++) {
      a.advance(0.1);
      b.advance(0.1);
    }
    const va = a.entities.map((e) => `${e.id}:${e.generation}:${e.x.toFixed(6)}:${e.z.toFixed(6)}`);
    const vb = b.entities.map((e) => `${e.id}:${e.generation}:${e.x.toFixed(6)}:${e.z.toFixed(6)}`);
    expect(va).toEqual(vb);
  });

  /**
   * docs/17 WU-4「20 次启停资源账目平衡」。
   *
   * runtime 侧没有 GPU 资源，能测的是**引用账目**：每次 play 都是全新的会话对象、
   * 每次 stop 后旧世界不可达、启停 N 次结果与第一次完全一致（没有跨次泄漏的状态）。
   * 真正的显存账目在浏览器侧配 `debugDynamicInstanceCount()` 回落到 0 验证。
   */
  it('20 次启停：每次都是新世界，结果一致，无跨次残留', () => {
    const s = new PlaySession({ seed: 3 });
    let reference: string[] | null = null;
    const seen = new Set<object>();

    for (let i = 0; i < 20; i++) {
      expect(s.play(floor1()).ok).toBe(true);
      const world = s.runtime!;
      expect(seen.has(world)).toBe(false); // 每次都是新对象，没有复用旧世界
      seen.add(world);

      for (let k = 0; k < 5; k++) s.advance(0.1);
      const snap = s.entities.map((e) => `${e.characterId}@${e.x.toFixed(4)},${e.z.toFixed(4)}`);
      if (reference === null) reference = snap;
      else expect(snap).toEqual(reference);

      s.stop();
      expect(s.runtime).toBeNull();
    }
    expect(s.cycleCount).toBe(20);
  });
});
