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
import type {
  ViewCameraControl,
  ViewCameraState,
  WorldPosOf,
} from '../src/services/play-camera';
import type { SceneDocument } from '@aether/scene';

/**
 * 记录型主视图相机替身。
 *
 * 为什么需要它：`AuthorSnapshot` **不含相机**，P6 必须自己存/还原。
 * 没有这个替身，"Stop 后相机还原了吗"就只能靠肉眼看——而删掉还原代码
 * 测试依然全绿（独立审核的 M7/M8 变异），那就成了假象。
 */
function fakeViewCamera(initial?: Partial<ViewCameraState>) {
  let cur: ViewCameraState = {
    target: [0, 0.95, 0],
    distance: 9,
    yaw: 0.35,
    elevationDeg: 20,
    ...initial,
  };
  const writes: ViewCameraState[] = [];
  const view: ViewCameraControl = {
    get: () => ({ ...cur, target: [cur.target[0], cur.target[1], cur.target[2]] }),
    set: (s: ViewCameraState) => {
      cur = { ...s, target: [s.target[0], s.target[1], s.target[2]] };
      writes.push({ ...cur, target: [...cur.target] as [number, number, number] });
    },
  };
  return {
    view,
    writes,
    get cur() {
      return cur;
    },
  };
}

/** 只有指定节点有世界坐标，其余返回 null */
function posOf(map: Record<string, [number, number, number]>): WorldPosOf {
  return (id: string) => map[id] ?? null;
}

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
    // Play 期渲染侧 GPU 资源的释放入口（动态实例 buffer + 代理网格缓存）。
    // PlayController 必须把它登记进 PlaySession 的账目，否则账目显示 pending = 0
    // 而 GPU 上仍留着 Play 期分配物（PR #3 review）。
    core: { releaseDynamicResources: vi.fn() },
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

function make(
  doc: SceneDocument | null = scene(),
  opts: { viewCamera?: ViewCameraControl; worldPosOf?: WorldPosOf } = {},
) {
  const r = fakeRenderer(doc);
  const b = fakeBridge();
  const ctl = new PlayController(r as unknown as LabRenderer, b as unknown as RuntimeBridge, {
    seed: 3,
    ...(opts.viewCamera !== undefined ? { viewCamera: opts.viewCamera } : {}),
    ...(opts.worldPosOf !== undefined ? { worldPosOf: opts.worldPosOf } : {}),
  });
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

  it('Play 期间发生了增删（restore 报 mismatched）→ 不吞掉，明确告警', () => {
    const { ctl, r } = make();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctl.start();
    // 渲染器返回 mismatched=true 表示 Play 期间物体数变了 —— 控制器必须告警，不能当没事发生
    r.restoreAuthorState = () => ({ restored: 1, mismatched: true });
    ctl.stop();
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0] ?? '')).toContain('不一致');
    spy.mockRestore();
  });
});

describe('PlayController —— 资源账目平衡（docs/17 §8-7 后半 + AGENTS.md §2.4）', () => {
  it('Play 期登记的资源在 Stop 时全部释放；20 次启停 pending 恒为 0', () => {
    const { ctl, b, r } = make();
    for (let i = 0; i < 20; i++) {
      expect(ctl.start()).toBe(true);
      // 每轮登记两项：Bridge 批次（CPU 侧）+ 渲染核心动态实例资源（GPU 侧）
      expect(ctl.ledger.pending).toBe(2);
      expect(b.attached).toBe(1);
      ctl.stop();
      // 🔴 判据不是"看着没泄漏"，是账目：登记数 == 释放数，且无未释放项
      expect(ctl.ledger.pending).toBe(0);
      expect(ctl.ledger.registered).toBe(ctl.ledger.disposed);
      expect(b.attached).toBe(0);
    }
    expect(ctl.ledger.registered).toBe(40);
    expect(ctl.ledger.disposed).toBe(40);
    // 渲染侧的释放入口必须真的被调用过（登记了却不调 = 假账目）
    expect(r.core.releaseDynamicResources).toHaveBeenCalledTimes(20);
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

describe('PlayController —— Play 相机（ADR-018 P6）', () => {
  // floor-1 自带：entryCamera = nd_f1_cam，Camera（enabled / orbit-follow /
  // pitchDeg 55 / distance 12 / yawOffsetDeg 0）。回退链路上它应被直接命中。
  const camPos = { nd_f1_cam: [10, 0, 0] as [number, number, number] };

  it('🔴 start 切到游戏相机，stop 精确还原编辑机位', () => {
    const vc = fakeViewCamera();
    const before = vc.view.get();
    const { ctl } = make(scene(), { viewCamera: vc.view, worldPosOf: posOf(camPos) });

    expect(ctl.start()).toBe(true);
    // 真的写了相机，且值来自场景的 Camera 组件
    expect(vc.writes.length).toBeGreaterThan(0);
    expect(vc.cur.distance).toBe(12);
    expect(vc.cur.elevationDeg).toBe(55);
    expect(vc.cur.target).toEqual([10, 0, 0]);

    ctl.stop();
    // AuthorSnapshot 不含相机 → 这一条全靠 PlayController 自己还原
    expect(vc.cur).toEqual(before);
  });

  it('🔴 场景没有可用相机时，相机一次都没被写（保持编辑机位）', () => {
    const vc = fakeViewCamera();
    const d = scene();
    for (const n of d.nodes) {
      for (const c of n.components) {
        if (c.kind === 'Camera') (c as unknown as { enabled: boolean }).enabled = false;
      }
    }
    const { ctl } = make(d, { viewCamera: vc.view, worldPosOf: posOf({}) });
    expect(ctl.start()).toBe(true);
    expect(vc.writes).toEqual([]); // 一次都没动
  });

  it('🔴 没注入 viewCamera 时不接管相机（不产生未声明的视角副作用）', () => {
    const { ctl } = make(scene()); // 不传 viewCamera
    expect(() => {
      expect(ctl.start()).toBe(true);
      ctl.stop();
    }).not.toThrow();
  });

  it('相机进入资源账目：接管后 Stop 释放，pending 归零', () => {
    const vc = fakeViewCamera();
    const { ctl } = make(scene(), { viewCamera: vc.view, worldPosOf: posOf(camPos) });
    ctl.start();
    // 原两项（Bridge 批次 + 动态实例）+ 相机 = 3
    expect(ctl.ledger.pending).toBe(3);
    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
    expect(ctl.ledger.registered).toBe(ctl.ledger.disposed);
  });

  it('20 次启停：相机始终还原，不累积（还原用错会越跑越偏）', () => {
    const vc = fakeViewCamera();
    const before = vc.view.get();
    const { ctl } = make(scene(), { viewCamera: vc.view, worldPosOf: posOf(camPos) });
    for (let i = 0; i < 20; i++) {
      expect(ctl.start()).toBe(true);
      expect(vc.cur.distance).toBe(12);
      ctl.stop();
      expect(vc.cur).toEqual(before);
    }
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
