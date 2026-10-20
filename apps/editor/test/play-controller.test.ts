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
import type { RuntimeWeapons } from '../src/services/runtime-weapons';
import {
  resolveEntryCamera,
  type ViewCameraControl,
  type ViewCameraState,
  type WorldPosOf,
} from '../src/services/play-camera';
import type { SceneDocument } from '@aether/scene';
import { frozenFractureEvent } from '@aether/runtime';

// 本套件使用无GPU的renderer替身，验证控制器快照/相机；真实VFX由专属GPU验收覆盖。
// 正式Act1配置现在含VFX，不能再依赖“关卡恰好没有特效”来避开GPU装配。
vi.mock('../src/services/play-vfx', () => ({ PlayVfx: class {
  start() {} stop() {} update() {}
} }));

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
  let objects = doc === null ? [] : doc.nodes.map((n) => ({ name: n.name, visible: true }));
  let selectedIndex: number | null = 0;
  return {
    // 门姿态同步会读 renderer.state.objects[i]（与真实渲染器同形）
    get state() { return { objects }; },
    getDocument: () => doc,
    findObjectIndexByNodeId: (id: string) => { const i = doc?.nodes.findIndex(n => n.id === id) ?? -1; return i < 0 ? null : i; },
    setObjectVisible: vi.fn((index: number, visible: boolean) => { objects[index]!.visible = visible; }),
    snapshotAuthorState: (): AuthorSnapshot => ({
      count: objects.length,
      objects: objects.map((o) => ({
        pos: [0, 0, 0] as [number, number, number],
        rot: [0, 0, 0] as [number, number, number],
        quat: [0, 0, 0, 1] as [number, number, number, number],
        scale: 1,
        bob: 0,
        visible: o.visible,
        removed: false,
        pickable: true,
        name: o.name,
        category: '环境',
        subVisible: [],
      })),
      selectedIndex,
    }),
    restoreAuthorState: (snap: AuthorSnapshot) => {
      objects = snap.objects.map((o) => ({ name: o.name, visible: o.visible }));
      selectedIndex = snap.selectedIndex;
      return { restored: Math.min(snap.objects.length, snap.objects.length), mismatched: false };
    },
    /** 测试钩子：模拟 Play 期间作者改动了场景 */
    mutateDuringPlay: (name: string, sel: number | null) => {
      objects = objects.map((o, i) => (i === 0 ? { ...o, name } : o));
      selectedIndex = sel;
    },
    // Play 期渲染侧 GPU 资源的释放入口（动态实例 buffer + 代理网格缓存）。
    // PlayController 必须把它登记进 PlaySession 的账目，否则账目显示 pending = 0
    // 而 GPU 上仍留着 Play 期分配物（PR #3 review）。
    core: { releaseDynamicResources: vi.fn() },
    read: () => ({ count: objects.length, names: objects.map((o) => o.name), visible: objects.map(o => o.visible), selectedIndex }),
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

describe('PlayController —— 碎片运行时接线（WU-04 R3 回归）', () => {
  /** 一份最小激活：small 块走简化层，不需要资产 IO，只验证宿主是否在驱动物理。 */
  function smallActivation(nodeId: string) {
    return {
      event: frozenFractureEvent({
        sequence: 1, tick: 0, seed: 7,
        profile: { path: 'assets/fracture/p01-barrel/p01-barrel.fracture.json', guid: 'as_p01frct' },
        target: { kind: 'scene-object', runId: 'run-1', nodeId },
        position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        contact: [0, 3, 0], normal: [0, 1, 0], impulse: [1, 2, 0.5],
        source: { weaponId: 'w_pistol', hitSequence: 1 },
      }),
      chunks: [{
        chunkId: 'c1', cls: 'small' as const,
        mesh: { path: 'assets/fracture/p01-barrel/chunk-0001.glb', guid: 'as_29a7ad90' },
        position: [0, 3, 0] as [number, number, number],
        rotation: [0, 0, 0, 1] as [number, number, number, number], scale: 1,
        shape: { type: 'sphere' as const, radius: 0.25 },
        mass: 1.5, friction: 0.6, restitution: 0,
        linearVelocity: [0, 0, 0] as [number, number, number],
        angularVelocity: [0, 0, 0] as [number, number, number],
      }],
      priority: 2, lifetimeSec: 4, fadeSec: 0.8,
    };
  }

  it('真实 PlayController.update 推进碎片物理（删除宿主驱动会失败）', async () => {
    const { ctl } = make();
    expect(ctl.start()).toBe(true);
    const binding = ctl.fracture;
    expect(binding).not.toBeNull();
    // 等 Rapier WASM 与首次场景镜像就绪（异步，非测试手动泵）
    await expect(binding!.ready).resolves.toBe(true);
    expect(binding!.backend()).not.toBeNull();
    expect(binding!.backend()!.ledger.destroyed).toBe(false);

    // 激活先入队（准入在分配前完成），首个固定 tick 才真正 spawn
    expect(binding!.runtime.play(smallActivation('nd_frag')).accepted).toBe(true);
    expect(binding!.runtime.stats.queuedEvents).toBe(1);
    const tick0 = binding!.runtime.stats.ticks;
    expect(tick0).toBe(0);

    // 唯一驱动路径：控制器 update（宿主按 PlaySession 固定步分发）
    const n = ctl.update(1 / 30);
    expect(n).toBeGreaterThan(0);
    const tick1 = binding!.runtime.stats.ticks;
    expect(tick1).toBe(tick0 + n);
    expect(binding!.runtime.active.length).toBe(1);
    const y0 = binding!.runtime.active[0]!.sim!.position[1];

    ctl.update(1 / 30);
    const y1 = binding!.runtime.active[0]!.sim!.position[1];
    expect(y1).not.toBe(y0); // 物理真的被推进了
    const tick2 = binding!.runtime.stats.ticks;
    expect(tick2).toBeGreaterThan(tick1);

    // Pause 后 update 不再推进（宿主停调）
    ctl.pause();
    ctl.update(1 / 30);
    expect(binding!.runtime.stats.ticks).toBe(tick2);

    // Step 单步只推进一个固定步
    ctl.step();
    expect(binding!.runtime.stats.ticks).toBe(tick2 + 1);

    // Stop：完整释放链（不是只销毁 World 就完事）
    const backendBefore = binding!.backend()!;
    const oldRuntime = binding!.runtime; // 被丢引用对象的观测手柄
    // 再排一个未消费的事件：Stop 必须清队列，而不是把它留在旧代里
    expect(oldRuntime.play(smallActivation('nd_queued')).accepted).toBe(true);
    expect(oldRuntime.stats.queuedEvents).toBe(1);

    ctl.stop();
    expect(ctl.fracture).toBeNull();
    expect(ctl.ledger.pending).toBe(0);
    // 被丢引用的旧 runtime 必须一并关闭：活动块清空、租约归还、队列清空
    expect(oldRuntime.disposed).toBe(true);
    const st = oldRuntime.stats;
    expect(st.rigidActive).toBe(0);
    expect(st.simplifiedActive).toBe(0);
    expect(st.poolActive).toBe(0);
    expect(st.queuedEvents).toBe(0);
    // 旧代的迟到请求必须被拒（不能"引用还在就继续接受"）
    expect(oldRuntime.play(smallActivation('nd_late')).accepted).toBe(false);
    // 物理 World 真销毁
    expect(backendBefore.ledger.destroyed).toBe(true);
    expect(backendBefore.ledger.dynamicBodies).toBe(0);
    expect(binding!.backend()).toBeNull();
  }, 30000);

  it('reset 换绑碎片代数：旧代释放、新代接管且不新增账目项', async () => {
    const { ctl } = make();
    expect(ctl.start()).toBe(true);
    await expect(ctl.fracture!.ready).resolves.toBe(true);
    const first = ctl.fracture!;
    const pendingAfterStart = ctl.ledger.pending;
    expect(first.runtime.play(smallActivation('nd_frag')).accepted).toBe(true);
    ctl.update(1 / 30); // 入队 → 首个固定 tick 激活
    expect(first.runtime.stats.simplifiedActive).toBe(1);

    const firstBackend = first.backend()!;
    const firstRuntime = first.runtime;
    // 排队中再放一个事件：Reset 必须把它连同上一个活动块一起清掉
    expect(firstRuntime.play(smallActivation('nd_queued')).accepted).toBe(true);

    ctl.reset();
    const second = ctl.fracture;
    expect(second === null).toBe(false);
    // 换绑必须是新对象（旧会话已 dispose，不能继续复用）
    expect(second === first).toBe(false);
    // 旧代完整释放：disposed、活动块、租约、队列都归零，后端真销毁
    expect(firstRuntime.disposed).toBe(true);
    expect(firstRuntime.stats.rigidActive).toBe(0);
    expect(firstRuntime.stats.simplifiedActive).toBe(0);
    expect(firstRuntime.stats.poolActive).toBe(0);
    expect(firstRuntime.stats.queuedEvents).toBe(0);
    expect(firstRuntime.play(smallActivation('nd_late')).accepted).toBe(false);
    expect(firstBackend.ledger.destroyed).toBe(true);
    await expect(second!.ready).resolves.toBe(true);
    expect(second!.runtime.stats.simplifiedActive).toBe(0);
    // 账目项数不随重跑增长（仍是单一项）
    expect(ctl.ledger.pending).toBe(pendingAfterStart);

    ctl.stop();
    expect(ctl.fracture).toBeNull();
    expect(ctl.ledger.pending).toBe(0);
  }, 30000);
});

describe('PlayController —— 运行期门姿态同步到碎片镜像（WU-04 F3 回归）', () => {
  // 真实沙盒场景：含 nd_gate_ramp 导航门；关掉刷怪与自动清房，只留门这一条变量。
  const SANDBOX = import.meta.glob('../../../assets/scenes/sandbox/dynamic-navigation-whitebox.scene.json', { eager: true });
  const sandbox = (): SceneDocument => {
    const key = Object.keys(SANDBOX)[0]!;
    const doc = JSON.parse(JSON.stringify((SANDBOX[key] as { default: unknown }).default)) as SceneDocument;
    for (const n of doc.nodes) {
      for (const c of n.components as unknown as { kind: string; count?: number; clearRule?: string }[]) {
        if (c.kind === 'SpawnPoint') c.count = 0;
        if (c.kind === 'RoomVolume') c.clearRule = 'interact';
      }
    }
    return doc;
  };

  it('门在玩法中升起后，碎片静态镜像跟随运行姿态（不是作者文档的初始位置）', async () => {
    const { ctl } = make(sandbox());
    expect(ctl.start()).toBe(true);
    const binding = ctl.fracture!;
    await expect(binding.ready).resolves.toBe(true);
    const backend = binding.backend()!;
    const rt = ctl.session.runtime!;

    const key = 'scene-mirror:nd_gate_ramp';
    const before = backend.staticPose(key);
    expect(before).not.toBeNull();
    const gateBefore = rt.gateSnapshot().find((g) => g.nodeId === 'nd_gate_ramp')!;
    expect(gateBefore.state).toBe('closed');
    // 作者文档的初始位置就是镜像初始位置
    expect(before!.y).toBeCloseTo(gateBefore.position[1], 5);

    // 只走真实控制器：开门 + 逐帧 update，不手动泵碎片也不手动 sync
    rt.setGateOpen('nd_gate_ramp', true);
    for (let i = 0; i < 100; i++) ctl.update(1 / 60);

    const gateAfter = rt.gateSnapshot().find((g) => g.nodeId === 'nd_gate_ramp')!;
    expect(gateAfter.state).toBe('open');
    expect(gateAfter.position[1]).toBeGreaterThan(gateBefore.position[1]);
    const after = backend.staticPose(key)!;
    // 镜像必须等于门的权威运行姿态（旧实现停在作者文档的 y=3）
    expect(after.y).toBeCloseTo(gateAfter.position[1], 4);
    expect(after.x).toBeCloseTo(gateAfter.position[0], 4);
    expect(after.z).toBeCloseTo(gateAfter.position[2], 4);

    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 30000);
});

describe('PlayController —— 资源账目平衡（docs/17 §8-7 后半 + AGENTS.md §2.4）', () => {
  it('Play 期登记的资源在 Stop 时全部释放；20 次启停 pending 恒为 0', () => {
    const { ctl, b, r } = make();
    for (let i = 0; i < 20; i++) {
      expect(ctl.start()).toBe(true);
      // 每轮登记三项：Bridge 批次（CPU 侧）+ 渲染核心动态实例资源（GPU 侧）
      // + 碎片运行时（WU-04 R3，单一账目项；Stop 释放 runtime.session）。
      expect(ctl.ledger.pending).toBe(3);
      expect(b.attached).toBe(1);
      ctl.stop();
      // 🔴 判据不是"看着没泄漏"，是账目：登记数 == 释放数，且无未释放项
      expect(ctl.ledger.pending).toBe(0);
      expect(ctl.ledger.registered).toBe(ctl.ledger.disposed);
      expect(b.attached).toBe(0);
    }
    // 20 轮 × 3 项（Bridge 批次 + 动态实例 + 碎片运行时）
    expect(ctl.ledger.registered).toBe(60);
    expect(ctl.ledger.disposed).toBe(60);
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

  /**
   * 期望的相机姿态**从场景组件读**，不要硬编码 12 / 55。
   *
   * 硬编码会让"有人改了 floor-1 的相机数值"变成"测试红但代码没错"——
   * 这类误报会训练人忽略红灯，比没有测试更糟。
   */
  function expectedFromScene() {
    const entry = resolveEntryCamera(scene());
    if (entry === null) throw new Error('夹具 floor-1 应有可用 Camera 组件');
    return { distance: entry.cam.distance, elevationDeg: entry.cam.pitchDeg };
  }

  it('🔴 start 切到游戏相机，stop 精确还原编辑机位', () => {
    const vc = fakeViewCamera();
    const before = vc.view.get();
    const exp = expectedFromScene();
    const { ctl } = make(scene(), { viewCamera: vc.view, worldPosOf: posOf(camPos) });

    expect(ctl.start()).toBe(true);
    // 真的写了相机，且值来自场景的 Camera 组件
    expect(vc.writes.length).toBeGreaterThan(0);
    expect(vc.cur.distance).toBe(exp.distance);
    expect(vc.cur.elevationDeg).toBe(exp.elevationDeg);
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
    // 原三项（Bridge 批次 + 动态实例 + 碎片运行时）+ 相机 = 4
    expect(ctl.ledger.pending).toBe(4);
    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
    expect(ctl.ledger.registered).toBe(ctl.ledger.disposed);
  });

  it('20 次启停：相机始终还原，不累积（还原用错会越跑越偏）', () => {
    const vc = fakeViewCamera();
    const before = vc.view.get();
    const exp = expectedFromScene();
    const { ctl } = make(scene(), { viewCamera: vc.view, worldPosOf: posOf(camPos) });
    for (let i = 0; i < 20; i++) {
      expect(ctl.start()).toBe(true);
      expect(vc.cur.distance).toBe(exp.distance);
      ctl.stop();
      expect(vc.cur).toEqual(before);
    }
  });
});

describe('PlayController —— 状态机透传', () => {
  it('Pause仍同步同相位装配（迟到资产/草稿），不推进模拟与动作时钟；Stop不再调用',()=>{
    const r=fakeRenderer(scene()),b=fakeBridge(),weapons={start:vi.fn(),stop:vi.fn(),sync:vi.fn()};
    const ctl=new PlayController(r as unknown as LabRenderer,b as unknown as RuntimeBridge,{weapons:weapons as unknown as RuntimeWeapons});expect(ctl.start()).toBe(true);ctl.update(.1);ctl.pause();
    const tick=ctl.tick,phase=ctl.session.runtime!.weapons.poseIntent.phase;weapons.sync.mockClear();ctl.update(.5);ctl.update(.5);
    expect(weapons.sync).toHaveBeenCalledTimes(2);expect(ctl.tick).toBe(tick);expect(ctl.session.runtime!.weapons.poseIntent.phase).toBe(phase);ctl.stop();weapons.sync.mockClear();ctl.update(.1);expect(weapons.sync).not.toHaveBeenCalled();
  });
  it('converts runtime heading for a target-follow camera and restores the authored camera', () => {
    const doc = scene();
    for (const node of doc.nodes) for (const c of node.components) if (c.kind === 'Camera') {
      c.mode = 'orbit-follow'; c.yawMode = 'target'; c.yawOffsetDeg = 0;
    }
    const vc = fakeViewCamera(), before = vc.view.get();
    const { ctl } = make(doc, { viewCamera: vc.view,
      worldPosOf: id => doc.nodes.find(n => n.id === id)?.transform.position ?? null });
    expect(ctl.start()).toBe(true);
    for (const [x, z] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      ctl.session.setInput(x!, z!); ctl.update(1 / 30);
      expect(Math.sin(vc.cur.yaw)).toBeCloseTo(x!, 5);
      expect(Math.cos(vc.cur.yaw)).toBeCloseTo(z!, 5);
    }
    ctl.stop(); expect(vc.cur).toEqual(before);
  });
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


it('hides editor helpers only during Play and restores original visibility on Stop', () => {
  const doc = scene();
  const helperIndices = doc.nodes.flatMap((n, i) => n.components.some(c => c.kind === 'MeshRenderer' && c.editorOnly) ? [i] : []);
  expect(helperIndices.length).toBeGreaterThan(0);
  const { ctl, r } = make(doc); const before = r.read();
  expect(ctl.start()).toBe(true);
  for (const i of helperIndices) expect(r.read().visible[i]).toBe(false);
  // No presentation host in this fixture: the player start mesh is also a marker.
  expect(r.read().visible.filter(v => !v)).toHaveLength(helperIndices.length + 1);
  ctl.stop(); expect(r.read()).toEqual(before);
});
