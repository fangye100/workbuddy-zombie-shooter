/**
 * PlayController —— docs/17 §8 第 7 条「Stop 恢复 Play 前作者状态」的入库测试。
 *
 * ## 为什么要补它
 *
 * 这条之前**零测试**，唯一证据是躺在 gitignore 目录里的实机探针 —— 半年后没人能复跑。
 * 评审（B-7）据此判为阻断。本文件用最小替身把 `PlayController` 的装配逻辑测出来：
 * 它不需要 GPU，也不需要真渲染器，只需要 `getDocument / snapshotAuthorState /
 * restoreAuthorState` 这三个方法。
 *
 * 顺带把同一条的**资源账目**也测了：AGENTS.md §2.4 要求 Play 期资源登记进
 * PlaySession、Stop 时逐个释放，所以「20 次启停后 pending === 0」必须是可断言的。
 */

import { describe, expect, it, vi } from 'vitest';
import { PlayController } from '../src/services/play-controller';
import type { AuthorSnapshot, LabRenderer } from '../src/renderer';
import type { RuntimeBridge } from '../src/services/runtime-bridge';
import type { SceneDocument } from '@aether/scene';

/** 最小替身：只实现 PlayController 真正用到的三个方法 */
function fakeRenderer(doc: SceneDocument | null) {
  let objects = doc === null ? [] : doc.nodes.map((n) => ({ name: n.name }));
  let selectedIndex: number | null = 0;
  return {
    getDocument: () => doc,
    snapshotAuthorState: (): AuthorSnapshot => ({
      count: objects.length,
      objects: objects.map((o) => ({
        pos: [0, 0, 0] as [number, number, number],
        rot: [0, 0, 0] as [number, number, number],
        quat: [0, 0, 0, 1] as [number, number, number, number],
        scale: 1,
        bob: 0,
        visible: true,
        removed: false,
        pickable: true,
        name: o.name,
        category: '环境',
        subVisible: [],
      })),
      selectedIndex,
    }),
    restoreAuthorState: (snap: AuthorSnapshot) => {
      objects = snap.objects.map((o) => ({ name: o.name }));
      selectedIndex = snap.selectedIndex;
      return { restored: Math.min(snap.objects.length, snap.objects.length), mismatched: false };
    },
    /** 测试钩子：模拟 Play 期间作者改动了场景 */
    mutateDuringPlay: (name: string, sel: number | null) => {
      objects = objects.map((o, i) => (i === 0 ? { name } : o));
      selectedIndex = sel;
    },
    read: () => ({ count: objects.length, names: objects.map((o) => o.name), selectedIndex }),
  };
}

function fakeBridge() {
  return {
    attached: 0,
    attach(_s: unknown) {
      this.attached = _s === null ? 0 : 1;
    },
    refresh() {},
  };
}

// 用真实关卡做夹具：手搓一份"看起来合法"的场景很容易在某个 loader 校验上栽跟头，
// 而本文件要测的是 PlayController，不是装载器。
const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

const scene = (): SceneDocument => {
  const key = Object.keys(MODULES)[0]!;
  return JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
};

function make(doc: SceneDocument | null = scene()) {
  const r = fakeRenderer(doc);
  const b = fakeBridge();
  const ctl = new PlayController(r as unknown as LabRenderer, b as unknown as RuntimeBridge, { seed: 3 });
  return { ctl, r, b };
}

describe('PlayController —— Stop 恢复作者状态（docs/17 §8-7 前半）', () => {
  it('Play 期间改动场景，Stop 后逐字段回到 Play 前（不从磁盘重载）', () => {
    const { ctl, r } = make();
    const before = r.read();
    expect(ctl.start()).toBe(true);
    // 模拟 Play 期间作者动了场景（正常被 UI 守卫挡住，这里专门测恢复路径）
    r.mutateDuringPlay('被改过的掩体', 1);
    expect(r.read().names[0]).toBe('被改过的掩体');

    ctl.stop();
    expect(r.read()).toEqual(before);
  });

  it('装载失败时不动作者状态，且 error 有原因', () => {
    // 没有 playerStart → loader 报 E_PLAYER_START_UNSET → play() 返回 false
    const bad = scene();
    bad.playerStart = null;
    const { ctl, r } = make(bad);
    const before = r.read();
    expect(ctl.start()).toBe(false);
    expect(ctl.error).not.toBeNull();
    expect(ctl.state).toBe('stopped');
    expect(r.read()).toEqual(before);
  });

  it('场景未加载时 start 直接失败且不抛异常', () => {
    const { ctl } = make(null);
    expect(ctl.start()).toBe(false);
    expect(ctl.error).toContain('场景尚未加载');
    expect(ctl.state).toBe('stopped');
  });
});

describe('PlayController —— 资源账目平衡（docs/17 §8-7 后半 + AGENTS.md §2.4）', () => {
  it('Play 期登记的资源在 Stop 时全部释放；20 次启停 pending 恒为 0', () => {
    const { ctl, b } = make();
    for (let i = 0; i < 20; i++) {
      expect(ctl.start()).toBe(true);
      expect(ctl.ledger.pending).toBe(1); // Bridge 批次已登记
      expect(b.attached).toBe(1);
      ctl.stop();
      // 🔴 判据不是"看着没泄漏"，是账目：登记数 == 释放数，且无未释放项
      expect(ctl.ledger.pending).toBe(0);
      expect(ctl.ledger.registered).toBe(ctl.ledger.disposed);
      expect(b.attached).toBe(0);
    }
    expect(ctl.ledger.registered).toBe(20);
    expect(ctl.ledger.disposed).toBe(20);
  });

  it('释放回调抛错不会挡住停止，账目仍记为已处理', () => {
    const { ctl } = make();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctl.start();
    ctl.session.registerResource('会炸的资源', () => {
      throw new Error('故意的');
    });
    expect(() => ctl.stop()).not.toThrow();
    expect(ctl.ledger.pending).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('PlayController —— 状态机透传', () => {
  it('pause / resume / step 的语义由 PlaySession 保证，控制器只做透传', () => {
    const { ctl } = make();
    expect(ctl.state).toBe('stopped');
    ctl.start();
    expect(ctl.state).toBe('playing');
    ctl.pause();
    expect(ctl.isPaused).toBe(true);
    const t0 = ctl.tick;
    ctl.step();
    expect(ctl.tick).toBe(t0 + 1); // Step 只增加一个 tick
    ctl.resume();
    expect(ctl.state).toBe('playing');
    ctl.stop();
    expect(ctl.state).toBe('stopped');
  });
});
