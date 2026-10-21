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

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { PlayController } from '../src/services/play-controller';
import type { AuthorSnapshot, LabRenderer } from '../src/renderer';
import { RuntimeBridge } from '../src/services/runtime-bridge';
import type { ActorMesh } from '../src/services/runtime-actors';
import type { RuntimeWeapons } from '../src/services/runtime-weapons';
import {
  resolveEntryCamera,
  type ViewCameraControl,
  type ViewCameraState,
  type WorldPosOf,
} from '../src/services/play-camera';
import { parseGlb, type SceneDocument } from '@aether/scene';
import { frozenFractureEvent, type FractureAssetIO, type FractureActivation, type WeaponWorld } from '@aether/runtime';
import { bakePosePalette, bindPoseIndex } from '@aether/render';

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
  let cur = doc;
  let objects = doc === null ? [] : doc.nodes.map((n) => ({ name: n.name, visible: true }));
  let selectedIndex: number | null = 0;
  return {
    // 门姿态同步会读 renderer.state.objects[i]（与真实渲染器同形）
    get state() { return { objects }; },
    getDocument: () => cur,
    // 换场景路径：真实渲染器会替换整个文档（Play 中直接 start 的新代从这里读）
    setDocument: (d: SceneDocument) => { cur = d; objects = d.nodes.map((n) => ({ name: n.name, visible: true })); },
    findObjectIndexByNodeId: (id: string) => { const i = cur?.nodes.findIndex(n => n.id === id) ?? -1; return i < 0 ? null : i; },
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
    core: { releaseDynamicResources: vi.fn(), dynamicBatchState:vi.fn(()=>'ready'), releaseDynamicMeshesWithPrefix:vi.fn(), dynamicError:null as string|null },
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
  opts: { viewCamera?: ViewCameraControl; worldPosOf?: WorldPosOf; fractureIO?: FractureAssetIO } = {},
) {
  const r = fakeRenderer(doc);
  const b = fakeBridge();
  const ctl = new PlayController(r as unknown as LabRenderer, b as unknown as RuntimeBridge, {
    seed: 3,
    ...(opts.viewCamera !== undefined ? { viewCamera: opts.viewCamera } : {}),
    ...(opts.worldPosOf !== undefined ? { worldPosOf: opts.worldPosOf } : {}),
    ...(opts.fractureIO !== undefined ? { fractureIO: opts.fractureIO } : {}),
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

  /** 混合激活：1 个 large（真实 Rapier body）+ 1 个 small（简化层），覆盖两层账目。 */
  function mixedActivation(nodeId: string) {
    const a = smallActivation(nodeId);
    a.chunks.push({
      ...a.chunks[0]!,
      chunkId: 'c2', cls: 'large' as never,
      mesh: { path: 'assets/fracture/p01-barrel/chunk-0002.glb', guid: 'as_6b0d0d0b' },
      position: [1, 4, 0] as [number, number, number],
    });
    return a;
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
    expect(binding!.runtime.play(mixedActivation('nd_frag')).accepted).toBe(true);
    expect(binding!.runtime.stats.queuedEvents).toBe(1);
    const tick0 = binding!.runtime.stats.ticks;
    expect(tick0).toBe(0);

    // 唯一驱动路径：控制器 update（宿主按 PlaySession 固定步分发）
    const n = ctl.update(1 / 30);
    expect(n).toBeGreaterThan(0);
    const tick1 = binding!.runtime.stats.ticks;
    expect(tick1).toBe(tick0 + n);
    expect(binding!.runtime.active.length).toBe(2);
    // 两层都在：1 large 真实 body + 1 small 简化
    const st0 = binding!.runtime.stats;
    expect(st0.rigidActive).toBe(1);
    expect(st0.simplifiedActive).toBe(1);
    expect(st0.poolActive).toBe(2);
    const simChunk = binding!.runtime.active.find((a) => a.sim !== null)!;
    const y0 = simChunk.sim!.position[1];

    ctl.update(1 / 30);
    const y1 = simChunk.sim!.position[1];
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

  it('未 Stop 直接再次 start（换场景）：新绑定重新登记，Stop 释放新 runtime', async () => {
    const { ctl } = make();
    expect(ctl.start()).toBe(true);
    const first = ctl.fracture!;
    await expect(first.ready).resolves.toBe(true);
    const firstRuntime = first.runtime;
    expect(firstRuntime.play(smallActivation('nd_a')).accepted).toBe(true);
    ctl.update(1 / 30);

    // 支持的生命周期：换场景直接再 start（PlaySession 会释放旧登记资源）
    expect(ctl.start()).toBe(true);
    const second = ctl.fracture;
    expect(second === null).toBe(false);
    expect(second === first).toBe(false);
    expect(firstRuntime.disposed).toBe(true); // 旧代随旧会话释放
    await expect(second!.ready).resolves.toBe(true);

    // 新代可正常激活并推进
    expect(second!.runtime.play(smallActivation('nd_b')).accepted).toBe(true);
    ctl.update(1 / 30);
    expect(second!.runtime.stats.simplifiedActive).toBe(1);

    // Stop 必须释放**新**绑定（旧实现这里不登记 → 新 runtime 泄漏）
    const secondRuntime = second!.runtime;
    const secondBackend = second!.backend()!;
    ctl.stop();
    expect(secondRuntime.disposed).toBe(true);
    expect(secondRuntime.stats.poolActive).toBe(0);
    expect(secondBackend.ledger.destroyed).toBe(true);
    expect(ctl.ledger.pending).toBe(0);
  }, 30000);

  it('initialOpen:true 的门在启动 ready 后立即同步（不等第一帧）', async () => {
    const SANDBOX3 = import.meta.glob('../../../assets/scenes/sandbox/dynamic-navigation-whitebox.scene.json', { eager: true });
    const key = Object.keys(SANDBOX3)[0]!;
    const doc = JSON.parse(JSON.stringify((SANDBOX3[key] as { default: unknown }).default)) as SceneDocument;
    for (const n of doc.nodes) {
      for (const c of n.components as unknown as { kind: string; count?: number; clearRule?: string }[]) {
        if (c.kind === 'SpawnPoint') c.count = 0;
        if (c.kind === 'RoomVolume') c.clearRule = 'interact';
      }
    }
    const { ctl } = make(doc);
    expect(ctl.start()).toBe(true);
    const binding = ctl.fracture!;
    await expect(binding.ready).resolves.toBe(true);
    // ready 回调已经把运行期门姿态灌进镜像：不推进任何帧也应一致
    const rt = ctl.session.runtime!;
    const gate = rt.gateSnapshot().find((g) => g.nodeId === 'nd_gate_stairs')!;
    expect(gate.state).toBe('open');
    const mirror = binding.backend()!.staticPose('scene-mirror:nd_gate_stairs')!;
    expect(mirror.y).toBeCloseTo(gate.position[1], 4);
    // 作者文档的初始位置是关闭态（y 更低），证明镜像不是照抄作者文档
    expect(mirror.y).toBeGreaterThan(3.5);
    ctl.stop();
  }, 30000);

  it('reset 后新代 ready 时 initialOpen 门镜像已对齐（不等下一帧）', async () => {
    const SANDBOX4 = import.meta.glob('../../../assets/scenes/sandbox/dynamic-navigation-whitebox.scene.json', { eager: true });
    const key = Object.keys(SANDBOX4)[0]!;
    const doc = JSON.parse(JSON.stringify((SANDBOX4[key] as { default: unknown }).default)) as SceneDocument;
    for (const n of doc.nodes) {
      for (const c of n.components as unknown as { kind: string; count?: number; clearRule?: string }[]) {
        if (c.kind === 'SpawnPoint') c.count = 0;
        if (c.kind === 'RoomVolume') c.clearRule = 'interact';
      }
    }
    const { ctl } = make(doc);
    expect(ctl.start()).toBe(true);
    await expect(ctl.fracture!.ready).resolves.toBe(true);
    ctl.reset();
    const second = ctl.fracture!;
    await expect(second.ready).resolves.toBe(true);
    const rt = ctl.session.runtime!;
    const gate = rt.gateSnapshot().find((g) => g.nodeId === 'nd_gate_stairs')!;
    const mirror = second.backend()!.staticPose('scene-mirror:nd_gate_stairs')!;
    expect(mirror.y).toBeCloseTo(gate.position[1], 4);
    expect(mirror.y).toBeGreaterThan(3.5); // 不是作者文档的关闭位置
    ctl.stop();
  }, 30000);

  it('资产读取期间 Stop：迟到的 spawnFracture 返回结构化拒绝而非抛错', async () => {
    // 真实资产 + 人为延迟：让准备成功完成，只是"完成得比 Stop 晚"。
    const textG = import.meta.glob('../../../assets/fracture/*/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    const metaG = import.meta.glob('../../../assets/environment/models/*/*/*.glb.meta.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    const binG = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
    const modelG = import.meta.glob('../../../assets/environment/models/*/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
    const rel = (k: string) => k.replace(/^.*?(?=assets\/)/, '');
    const text = new Map(Object.entries({ ...textG, ...metaG }).map(([k, v]) => [rel(k), v] as const));
    const bins = new Map(Object.entries({ ...binG, ...modelG }).map(([k, v]) => [rel(k), v] as const));
    let firstRead = true;
    const io = {
      async readText(path: string) {
        if (firstRead) { firstRead = false; await new Promise((r) => setTimeout(r, 60)); }
        const v = text.get(path);
        if (v === undefined) throw new Error('未找到：' + path);
        return v;
      },
      async readBinary(path: string) {
        const l = bins.get(path);
        if (l === undefined) throw new Error('未找到二进制：' + path);
        const b = await l();
        return b.slice().buffer;
      },
    };
    const { ctl } = make(scene(), { fractureIO: io });
    expect(ctl.start()).toBe(true);
    await expect(ctl.fracture!.ready).resolves.toBe(true);
    const event = frozenFractureEvent({
      sequence: 1, tick: 0, seed: 1,
      profile: { path: 'assets/fracture/p01-barrel/p01-barrel.fracture.json', guid: 'as_p01frct' },
      target: { kind: 'scene-object', runId: 'run-1', nodeId: 'nd_x' },
      position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      contact: [0, 3, 0], normal: [0, 1, 0], impulse: [1, 2, 0.5],
      source: { weaponId: 'w_pistol', hitSequence: 1 },
    });
    const pending = ctl.spawnFracture(event);
    ctl.stop(); // 读取期间 Stop
    const res = await pending;
    expect(res.accepted).toBe(false);
    expect(res.rejection?.reason).toBe('session-closed');
  }, 30000);

  it('旧代挂起的资产读取完成后不污染新代：新代坏资源仍被拒，恢复后可重试', async () => {
    const textG = import.meta.glob('../../../assets/fracture/*/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    const metaG = import.meta.glob('../../../assets/environment/models/*/*/*.glb.meta.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
    const binG = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
    const modelG = import.meta.glob('../../../assets/environment/models/*/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
    const rel = (k: string) => k.replace(/^.*?(?=assets\/)/, '');
    const text = new Map(Object.entries({ ...textG, ...metaG }).map(([k, v]) => [rel(k), v] as const));
    const bins = new Map(Object.entries({ ...binG, ...modelG }).map(([k, v]) => [rel(k), v] as const));

    const target = 'assets/fracture/p01-barrel/chunk-0001.glb';
    let suspend = false;
    let releaseHeld: (() => void) | null = null;
    let chunkBroken = false;
    const io = {
      async readText(path: string) {
        const v = text.get(path);
        if (v === undefined) throw new Error('未找到：' + path);
        return v;
      },
      async readBinary(path: string) {
        // 挂起的那次读取已经拿到真实字节（旧代）；之后的读取才看到"资源失效"
        const isSuspendedCall = path === target && suspend;
        if (isSuspendedCall) {
          suspend = false;
          await new Promise<void>((r) => { releaseHeld = r; });
        }
        if (!isSuspendedCall && path === target && chunkBroken) throw new Error('EIO 资源已不可读');
        const l = bins.get(path);
        if (l === undefined) throw new Error('未找到二进制：' + path);
        const b = await l();
        return b.slice().buffer;
      },
    };

    const mkEvent = (nodeId: string, seq: number) => frozenFractureEvent({
      sequence: seq, tick: 0, seed: 5,
      profile: { path: 'assets/fracture/p01-barrel/p01-barrel.fracture.json', guid: 'as_p01frct' },
      target: { kind: 'scene-object', runId: 'run-1', nodeId },
      position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      contact: [0, 3, 0], normal: [0, 1, 0], impulse: [1, 2, 0.5],
      source: { weaponId: 'w_pistol', hitSequence: seq },
    });

    const { ctl } = make(scene(), { fractureIO: io });
    expect(ctl.start()).toBe(true);
    await expect(ctl.fracture!.ready).resolves.toBe(true);

    // 旧代读到 chunk 时挂起
    suspend = true;
    const oldPending = ctl.spawnFracture(mkEvent('nd_old', 1));
    // 等到真的挂在该 chunk 的读取上（前面的源模型读取也要时间，不能写死 sleep）
    for (let i = 0; i < 200 && releaseHeld === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(releaseHeld).not.toBeNull();

    // Stop → 换场景重开 → 新代就绪；此时该 chunk 在新代不可读
    ctl.stop();
    expect(ctl.start()).toBe(true);
    const second = ctl.fracture!;
    await expect(second.ready).resolves.toBe(true);
    chunkBroken = true;

    // 放行旧代读取：它必须返回 session-closed，且不得让新代跳过校验
    releaseHeld!();
    const oldRes = await oldPending;
    expect(oldRes.accepted).toBe(false);
    expect(oldRes.rejection?.reason).toBe('session-closed');

    // 新代对同一个坏资源必须被拒，且不产生队列/body
    const bad = await ctl.spawnFracture(mkEvent('nd_new_bad', 2));
    expect(bad.accepted).toBe(false);
    expect(bad.rejection?.reason).toBe('ref-binary');
    expect(second.runtime.stats.queuedEvents).toBe(0);
    expect(second.backend()!.ledger.dynamicBodies).toBe(0);

    // 恢复合法源后可重试成功（不是把坏状态永久缓存）
    chunkBroken = false;
    const good = await ctl.spawnFracture(mkEvent('nd_new_ok', 3));
    expect(good.accepted).toBe(true);
    ctl.update(1 / 30);
    expect(second.runtime.stats.rigidActive).toBe(12);

    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 60000);

  it('门镜像在碎片 tick 之前同步（帧内不滞后）', async () => {
    const SANDBOX2 = import.meta.glob('../../../assets/scenes/sandbox/dynamic-navigation-whitebox.scene.json', { eager: true });
    const key = Object.keys(SANDBOX2)[0]!;
    const doc = JSON.parse(JSON.stringify((SANDBOX2[key] as { default: unknown }).default)) as SceneDocument;
    for (const n of doc.nodes) {
      for (const c of n.components as unknown as { kind: string; count?: number; clearRule?: string }[]) {
        if (c.kind === 'SpawnPoint') c.count = 0;
        if (c.kind === 'RoomVolume') c.clearRule = 'interact';
      }
    }
    const { ctl } = make(doc);
    expect(ctl.start()).toBe(true);
    const binding = ctl.fracture!;
    await expect(binding.ready).resolves.toBe(true);
    const rt = ctl.session.runtime!;
    rt.setGateOpen('nd_gate_ramp', true);

    // 在每次碎片 tick 的入口采样：镜像 y 必须已经等于该时刻的门权威 y
    const samples: { gate: number; mirror: number }[] = [];
    const originalTick = binding.runtime.tick.bind(binding.runtime);
    binding.runtime.tick = (dt: number) => {
      const gate = rt.gateSnapshot().find((g) => g.nodeId === 'nd_gate_ramp')!;
      const mirror = binding.backend()!.staticPose('scene-mirror:nd_gate_ramp')!;
      samples.push({ gate: gate.position[1], mirror: mirror.y });
      originalTick(dt);
    };
    for (let i = 0; i < 20; i++) ctl.update(1 / 60);
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) expect(s.mirror).toBeCloseTo(s.gate, 4);
    ctl.stop();
  }, 30000);

  it('终态（game-over）后碎片跟随世界冻结，不再推进', async () => {
    const { ctl } = make();
    expect(ctl.start()).toBe(true);
    const binding = ctl.fracture!;
    await expect(binding.ready).resolves.toBe(true);
    expect(binding.runtime.play(smallActivation('nd_frag')).accepted).toBe(true);
    ctl.update(1 / 30);
    const frozenAt = binding.runtime.stats.ticks;
    expect(frozenAt).toBeGreaterThan(0);

    // 游戏进入终态：PlaySession 仍可能返回步数，但世界已冻结
    const spy = vi.spyOn(ctl.session, 'outcome', 'get').mockReturnValue('game-over');
    const n = ctl.update(1 / 30);
    expect(n).toBeGreaterThan(0); // 会话确实"推进"了
    expect(binding.runtime.stats.ticks).toBe(frozenAt); // 碎片不跟着动
    // 暂停单步同样不推进碎片（仍在终态下）
    ctl.pause();
    const before = binding.runtime.stats.ticks;
    ctl.step();
    expect(binding.runtime.stats.ticks).toBe(before);
    spy.mockRestore();
    // 恢复 running 后单步重新生效（证明守卫只针对终态，不是把 step 永久关掉）
    ctl.step();
    expect(binding.runtime.stats.ticks).toBe(before + 1);
    ctl.stop();
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

describe('PlayController —— 生产激活入口（WU-04 W04-01/09 回归）', () => {
  // 真实 profile/sidecar/GLB 经 import.meta.glob 提供字节（禁 node:fs）。
  const textGlob = import.meta.glob('../../../assets/fracture/*/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  // 源模型的 sidecar（准入要核验引用身份）
  const modelMetaGlob = import.meta.glob('../../../assets/environment/models/*/*/*.glb.meta.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  const charMetaGlob = import.meta.glob('../../../assets/characters/models/*/*/*.glb.meta.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  const binGlob = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
  const modelGlob = import.meta.glob('../../../assets/environment/models/*/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
  const rel = (k: string) => k.replace(/^.*?(?=assets\/)/, '');

  function makeIO() {
    const text = new Map<string, string>();
    for (const [k, v] of Object.entries({ ...textGlob, ...modelMetaGlob, ...charMetaGlob })) text.set(rel(k), v);
    const bins = new Map<string, () => Promise<Uint8Array>>();
    for (const [k, v] of Object.entries({ ...binGlob, ...modelGlob })) bins.set(rel(k), v);
    return {
      async readText(path: string) {
        const v = text.get(path);
        if (v === undefined) throw new Error('未找到：' + path);
        return v;
      },
      async readBinary(path: string) {
        const loader = bins.get(path);
        if (loader === undefined) throw new Error('未找到二进制：' + path);
        const bytes = await loader();
        return bytes.slice().buffer;
      },
    };
  }

  it('spawnFracture 走 prepareFractureActivation 真资产准入并进入运行时', async () => {
    const { ctl } = make(scene(), { fractureIO: makeIO() });
    expect(ctl.start()).toBe(true);
    await expect(ctl.fracture!.ready).resolves.toBe(true);

    const event = frozenFractureEvent({
      sequence: 1, tick: 0, seed: 11,
      profile: { path: 'assets/fracture/p01-barrel/p01-barrel.fracture.json', guid: 'as_p01frct' },
      target: { kind: 'scene-object', runId: 'run-1', nodeId: 'nd_barrel' },
      position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      contact: [0, 3, 0], normal: [0, 1, 0], impulse: [1, 2, 0.5],
      source: { weaponId: 'w_pistol', hitSequence: 1 },
    });
    const res = await ctl.spawnFracture(event);
    expect(res.accepted).toBe(true);
    // 准入产生的是正式 P-01 profile 的 12 块
    expect(ctl.fracture!.runtime.stats.queuedEvents).toBe(1);
    ctl.update(1 / 30);
    expect(ctl.fracture!.runtime.active.length).toBe(12);
    expect(ctl.fracture!.runtime.stats.rigidActive).toBe(12);

    // 零四元数经真实生产入口同样在分配前拒绝（不是只有准备层测试）
    const zeroQ = frozenFractureEvent({
      ...event,
      sequence: 3,
      rotation: [0, 0, 0, 0] as [number, number, number, number],
      target: { kind: 'scene-object', runId: 'run-1', nodeId: 'nd_zeroq' },
    });
    const resQ = await ctl.spawnFracture(zeroQ);
    expect(resQ.accepted).toBe(false);
    expect(resQ.rejection?.reason).toBe('transform');
    expect(ctl.fracture!.runtime.stats.queuedEvents).toBe(0);

    // 坏输入（GUID 不符）在分配前拒绝，且不进入运行时
    const bad = frozenFractureEvent({
      ...event,
      sequence: 2,
      profile: { path: 'assets/fracture/p01-barrel/p01-barrel.fracture.json', guid: 'as_wrong' },
      target: { kind: 'scene-object', runId: 'run-1', nodeId: 'nd_barrel2' },
    });
    const res2 = await ctl.spawnFracture(bad);
    expect(res2.accepted).toBe(false);
    expect(res2.rejection?.reason).toBe('identity');
    expect(ctl.fracture!.runtime.stats.queuedEvents).toBe(0);

    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 60000);
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
      // 每轮登记四项：Bridge 批次（CPU 侧）+ 渲染核心动态实例资源（GPU 侧）
      // + 碎片运行时（WU-04 R3）+ 碎片渲染装配（WU-05）。
      expect(ctl.ledger.pending).toBe(4);
      expect(b.attached).toBe(1);
      ctl.stop();
      // 🔴 判据不是"看着没泄漏"，是账目：登记数 == 释放数，且无未释放项
      expect(ctl.ledger.pending).toBe(0);
      expect(ctl.ledger.registered).toBe(ctl.ledger.disposed);
      expect(b.attached).toBe(0);
    }
    // 20 轮 × 4 项（Bridge 批次 + 动态实例 + 碎片运行时 + 碎片渲染装配）
    expect(ctl.ledger.registered).toBe(80);
    expect(ctl.ledger.disposed).toBe(80);
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
    // 原四项（Bridge 批次 + 动态实例 + 碎片运行时 + 碎片渲染装配）+ 相机 = 5
    expect(ctl.ledger.pending).toBe(5);
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

describe('PlayController —— 旧代异步事件跨代隔离（WU-06 S6-03/R6-02 真实消费者链路）', () => {
  // WU-06 正式可破坏庭院：破坏事实由真实 RuntimeSession 产生，经真实
  // PlayController.update → consumeDestructibleEvents → spawnFracture 消费。
  // 被测的责任点在 play-controller.ts 的 then 消费者，不是 spawnFracture 返回值本身。
  const W6 = import.meta.glob('../../../assets/scenes/sandbox/fracture-wu06.scene.json', { eager: true });
  const sceneA = (): SceneDocument => JSON.parse(JSON.stringify((Object.values(W6)[0] as { default: unknown }).default)) as SceneDocument;
  const sceneB = (): SceneDocument => { const d = sceneA(); d.id = 'sc_fracture_wu06_second'; d.name = '第二场景'; return d; };

  const textGlob = import.meta.glob('../../../assets/fracture/*/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  const modelMetaGlob = import.meta.glob('../../../assets/environment/models/*/*/*.glb.meta.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  const binGlob = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
  const modelGlob = import.meta.glob('../../../assets/environment/models/*/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
  const rel = (k: string) => k.replace(/^.*?(?=assets\/)/, '');
  const textMap = new Map(Object.entries({ ...textGlob, ...modelMetaGlob }).map(([k, v]) => [rel(k), v] as const));
  const binMap = new Map(Object.entries({ ...binGlob, ...modelGlob }).map(([k, v]) => [rel(k), v] as const));

  function realIO(): FractureAssetIO {
    return {
      async readText(path) { const v = textMap.get(path); if (v === undefined) throw new Error('未找到：' + path); return v; },
      async readBinary(path) { const l = binMap.get(path); if (l === undefined) throw new Error('未找到二进制：' + path); const b = await l(); return b.slice().buffer; },
    };
  }

  /** 把第一次 readText 挂起：旧代 spawnFracture 的 profile 读取停在半路，直到 release。 */
  function heldIO(mode: 'success' | 'failure') {
    let entered = false; let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const base = realIO();
    const io: FractureAssetIO = {
      async readText(path) {
        if (!entered) { entered = true; await gate; if (mode === 'failure') throw new Error('LATE_OLD_IO_FAILURE'); }
        return base.readText(path);
      },
      readBinary: (path) => base.readBinary(path),
    };
    return { io, entered: () => entered, release: () => release() };
  }

  const makeW6 = (io: FractureAssetIO) => make(sceneA(), { fractureIO: io });

  async function ready(ctl: PlayController) { expect(ctl.start()).toBe(true); await ctl.fracture!.ready; }
  /** 真实破坏事实 + 真实宿主消费：RuntimeSession 破坏 → update(0) → consumeDestructibleEvents。 */
  function fire(ctl: PlayController) {
    ctl.session.runtime!.damageSceneObject('nd_fr_barrel', 40, { weaponId: 'w_pistol' }, 'direct');
    ctl.update(0);
  }
  const intact = (ctl: PlayController) => ctl.session.runtime?.destructibleSnapshot().find(x => x.nodeId === 'nd_fr_barrel')?.hp === 40;
  const barrelVisible = (ctl: PlayController, r: { read(): { visible: boolean[] } }) => {
    void ctl;
    const i = r.read().visible.length > 0 ? (r as unknown as { findObjectIndexByNodeId(id: string): number | null }).findObjectIndexByNodeId('nd_fr_barrel') : null;
    return i === null ? null : r.read().visible[i];
  };

  // 六格矩阵：三种换代 × 迟到成功/失败，全部走真实消费者链路。
  for (const action of ['reset', 'stop-newplay', 'scene-change'] as const) {
    const label = { reset: 'Reset', 'stop-newplay': 'Stop→新 Play', 'scene-change': '换场景' }[action];
    const switchGen = async (ctl: PlayController, r: { setDocument(d: SceneDocument): void }) => {
      if (action === 'reset') ctl.reset();
      else if (action === 'stop-newplay') { ctl.stop(); r.setDocument(sceneA()); await ready(ctl); }
      else { r.setDocument(sceneB()); await ready(ctl); }
    };

    it('旧代读取迟到失败 after ' + label + '：不写新代 destructibleError，新代状态/可见性/队列完好', async () => {
      const h = heldIO('failure');
      const { ctl, r } = makeW6(h.io);
      await ready(ctl);
      await fire(ctl);
      for (let i = 0; i < 400 && !h.entered(); i++) await new Promise(res => setTimeout(res, 5));
      expect(h.entered()).toBe(true); // 旧代 profile 读取确实挂起
      await switchGen(ctl, r);
      h.release();
      await new Promise(res => setTimeout(res, 150)); // 旧代失败返回
      expect(ctl.destructibleError).toBeNull();
      expect(intact(ctl)).toBe(true);
      expect(barrelVisible(ctl, r)).toBe(true);
      expect(ctl.session.runtime!.takeDestructibleEvents()).toEqual([]);
      expect(ctl.fracture!.runtime.stats.queuedEvents).toBe(0);
      ctl.stop();
      expect(ctl.ledger.pending).toBe(0);
    }, 30000);

    it('旧代读取迟到成功 after ' + label + '：不进入新代队列/事件，释放后账目归零', async () => {
      const h = heldIO('success');
      const { ctl, r } = makeW6(h.io);
      await ready(ctl);
      await fire(ctl);
      for (let i = 0; i < 400 && !h.entered(); i++) await new Promise(res => setTimeout(res, 5));
      expect(h.entered()).toBe(true);
      await switchGen(ctl, r);
      h.release();
      await new Promise(res => setTimeout(res, 150)); // 旧代成功完成
      expect(ctl.destructibleError).toBeNull();
      expect((ctl as unknown as { pendingDestructibleEvents: unknown[] }).pendingDestructibleEvents).toHaveLength(0);
      expect(intact(ctl)).toBe(true);
      expect(barrelVisible(ctl, r)).toBe(true);
      expect(ctl.fracture!.runtime.stats.queuedEvents).toBe(0);
      ctl.stop();
      expect(ctl.ledger.pending).toBe(0);
    }, 30000);
  }

  it('新代自身资源失败确实到达 destructibleError（用户可见），Reset 后恢复', async () => {
    const { ctl } = makeW6(realIO());
    await ready(ctl);
    ctl.reset();
    await ctl.fracture!.ready;
    (ctl as unknown as { fractureIO: FractureAssetIO }).fractureIO = {
      readText: async () => { throw new Error('NEW_GEN_FAIL'); },
      readBinary: async () => { throw new Error('NEW_GEN_FAIL'); },
    };
    await fire(ctl);
    await new Promise(res => setTimeout(res, 150));
    expect(ctl.destructibleError).toContain('nd_fr_barrel');
    expect(ctl.destructibleError).toContain('profile-read');
    // 事实不回滚：运行时会话里目标已破坏
    expect(ctl.session.runtime!.destructibleSnapshot().find(x => x.nodeId === 'nd_fr_barrel')!.broken).toBe(true);
    ctl.reset();
    await ctl.fracture!.ready;
    expect(ctl.destructibleError).toBeNull();
    expect(intact(ctl)).toBe(true);
    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 30000);

  it('旧 ready retry 真正挂起：换代后释放不消费新代事件、不写诊断', async () => {
    const { ctl } = makeW6(realIO());
    await ready(ctl);
    const old = ctl.fracture!;
    let release!: () => void;
    (old as unknown as { ready: Promise<boolean> }).ready = new Promise<boolean>(r => { release = () => r(true); });
    const backend = old.backend.bind(old);
    (old as unknown as { backend: () => null }).backend = () => null; // 强制 backend 未就绪路径
    await fire(ctl);
    expect((ctl as unknown as { pendingDestructibleEvents: unknown[] }).pendingDestructibleEvents.length).toBe(1);
    ctl.reset();
    await ctl.fracture!.ready;
    // 新代只产生事实，不 update/consume：若旧 retry 误跑，会把它吃掉
    ctl.session.runtime!.damageSceneObject('nd_w6_barrel_b', 40, { weaponId: 'w_pistol' }, 'direct');
    release();
    await new Promise(res => setTimeout(res, 120));
    expect((ctl as unknown as { brokenNodes: Set<string> }).brokenNodes.size).toBe(0);
    expect(ctl.destructibleError).toBeNull();
    expect(ctl.session.runtime!.destructibleSnapshot().find(x => x.nodeId === 'nd_w6_barrel_b')!.broken).toBe(true);
    (old as unknown as { backend: () => unknown }).backend = backend;
    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 30000);

  /** 在 start() 之前安装覆写：把第 nth 次 createFractureBinding 产出的 binding.ready 换成可控挂起。
   *  nth=1 即 start() 创建的启动代；nth=2 是第一次 reset/rebuild 创建的重建代（R6-02a）。 */
  function holdNthBindingReady(ctl: PlayController, nth: number): { release: () => void } {
    let release!: () => void;
    const anyCtl = ctl as unknown as Record<string, unknown>;
    const orig = (anyCtl.createFractureBinding as (g: unknown) => unknown).bind(ctl);
    let created = 0;
    anyCtl.createFractureBinding = (graph: unknown) => {
      const b = orig(graph) as { ready: Promise<boolean> };
      created += 1;
      if (created === nth) {
        (b as unknown as { ready: Promise<boolean> }).ready = new Promise<boolean>(res => { release = () => res(true); });
      }
      return b;
    };
    return { release: () => release() };
  }

  /** 新代 ready 落定后统计 syncGateMirrors 的额外触发次数（旧代迟到 ready 不得再触发）。 */
  function spyGateSync(ctl: PlayController): () => number {
    const anyCtl = ctl as unknown as { syncGateMirrors: () => void };
    const orig = anyCtl.syncGateMirrors.bind(ctl);
    let calls = 0;
    anyCtl.syncGateMirrors = () => { calls += 1; orig(); };
    return () => calls;
  }

  it('启动路径门镜像 ready 守卫：Stop→新 Play 后旧代 ready 迟到不触碰新代镜像', async () => {
    const { ctl } = makeW6(realIO());
    const hold = holdNthBindingReady(ctl, 1);
    expect(ctl.start()).toBe(true);
    const first = ctl.fracture!;
    ctl.stop();                    // 旧代释放（其 mirror ready 回调仍挂在起上）
    await ready(ctl);
    const second = ctl.fracture!;
    expect(second === first).toBe(false);
    const syncCalls = spyGateSync(ctl);
    hold.release();                // 旧代 ready 此刻才完成
    await new Promise(res => setTimeout(res, 100));
    expect(syncCalls()).toBe(0);   // 守卫丢弃：旧回调不得再 sync 新代镜像
    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 30000);

  it('reset 重建路径门镜像 ready 守卫：重建代 ready 迟到于第三代之后释放，不触碰新代镜像', async () => {
    const { ctl } = makeW6(realIO());
    // 挂起目标必须是 rebuildFractureBinding 创建的 binding（第 2 次 createFractureBinding），
    // 不是 start() 创建的启动代 —— 否则测的还是启动守卫（监督裁决 R6-02a）。
    const hold = holdNthBindingReady(ctl, 2);
    expect(ctl.start()).toBe(true);
    await ctl.fracture!.ready;     // 启动代正常就绪（不挂起）
    ctl.reset();                   // 第二代由 rebuild 创建，其 ready 被挂起、重建回调注册在挂起 Promise 上
    const second = ctl.fracture!;
    ctl.reset();                   // 第三代创建并正常就绪，使第二代成为旧代
    const third = ctl.fracture!;
    expect(third === second).toBe(false);
    await third.ready;
    const syncCalls = spyGateSync(ctl);
    hold.release();                // 重建代（第二代）ready 此刻才完成
    await new Promise(res => setTimeout(res, 100));
    expect(syncCalls()).toBe(0);
    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 30000);
});

describe('PlayController —— NPC 致死碎裂（WU-07 真实消费者链路）', () => {
  const originalBitmap = globalThis.createImageBitmap;
  beforeAll(()=>{ globalThis.createImageBitmap = vi.fn(async()=>({width:1,height:1,close(){}})) as unknown as typeof createImageBitmap; });
  afterAll(()=>{ globalThis.createImageBitmap = originalBitmap; });
  // WU-07 正式场景：E-04 配置 deathFracture + E-01 未配置对照。
  // 真实 RuntimeBridge + 真实 E-04 ActorMesh（真实 GLB→palette，纯 CPU），
  // kill 事实由 RuntimeSession.applyDamage 产生，经 consumeDeathFractures 消费。
  const W7 = import.meta.glob('../../../assets/scenes/sandbox/fracture-wu07.scene.json', { eager: true });
  const scene7 = (): SceneDocument => JSON.parse(JSON.stringify((Object.values(W7)[0] as { default: unknown }).default)) as SceneDocument;
  const charGlbs = import.meta.glob('../../../assets/characters/models/*/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
  const textG7 = import.meta.glob('../../../assets/fracture/*/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  const metaG7 = import.meta.glob('../../../assets/environment/models/*/*/*.glb.meta.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  const charMetaG7 = import.meta.glob('../../../assets/characters/models/*/*/*.glb.meta.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  const binG7 = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
  const modelG7 = import.meta.glob('../../../assets/environment/models/*/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
  const rel7 = (k: string) => k.replace(/^.*?(?=assets\/)/, '');
  const text7 = new Map(Object.entries({ ...textG7, ...metaG7, ...charMetaG7 }).map(([k, v]) => [rel7(k), v] as const));
  const bins7 = new Map(Object.entries({ ...binG7, ...modelG7, ...charGlbs }).map(([k, v]) => [rel7(k), v] as const));
  function realIO7(): FractureAssetIO {
    return {
      async readText(path: string) { const v = text7.get(path); if (v === undefined) throw new Error('未找到：' + path); return v; },
      async readBinary(path: string) { const l = bins7.get(path); if (l === undefined) throw new Error('未找到二进制：' + path); const b = await l(); return b.slice().buffer; },
    };
  }

  let e04Actor: ActorMesh | null = null;
  async function ensureE04Actor(): Promise<ActorMesh> {
    if (e04Actor !== null) return e04Actor;
    const key = Object.keys(charGlbs).find(k => k.includes('E-04/rigged/E04_Bulwark_1600_rigged_animated.glb'))!;
    const bytes = await charGlbs[key]!();
    const glb = parseGlb(bytes.slice().buffer, null);
    if (glb.skeleton === null || glb.mesh.joints == null || glb.mesh.weights == null) throw new Error('E-04 GLB 缺骨架/蒙皮数据');
    const palette = bakePosePalette(glb.skeleton, glb.animations, { fps: 24 });
    let minY = Infinity;
    for (let i = 1; i < glb.mesh.vertices.length; i += 15) minY = Math.min(minY, glb.mesh.vertices[i]!);
    e04Actor = {
      characterId: 'E-04', meshId: 'actor:E-04',
      vertices: glb.mesh.vertices, indices: glb.mesh.indices,
      joints: glb.mesh.joints, weights: glb.mesh.weights,
      jointNames: glb.skeleton.jointNames,
      normalization: new Float32Array(glb.skeleton.normalization),
      paletteBase: 0, restPose: bindPoseIndex(palette), feetOffset: minY,
      palette,
      clips: palette.clips.map((c, i) => ({ name: c.name, basePose: palette.clipBasePose[i]!, frameCount: c.frameCount, durationSec: c.durationSec })),
    };
    return e04Actor;
  }

  async function make7(opts: { io?: FractureAssetIO; gpuReady?:boolean; scene?:SceneDocument; gpuState?:'pending'|'ready'|'failed' } = {}) {
    const actor = await ensureE04Actor();
    const bridge = new RuntimeBridge({ get: (id: string) => (id === 'E-04' ? actor : null), request: () => {} });
    const r = fakeRenderer(opts.scene ?? scene7());
    Object.assign(r.core, {dynamicBatchState:vi.fn(()=>opts.gpuState ?? (opts.gpuReady===false?'failed':'ready')),dynamicError:opts.gpuReady===false?'injected GPU allocation failure':null});
    const ctl = new PlayController(r as unknown as LabRenderer, bridge as unknown as RuntimeBridge, { seed: 3, fractureIO: opts.io ?? realIO7() });
    return { ctl, bridge, renderer:r };
  }
  const e04of = (ctl: PlayController) => ctl.session.runtime?.view().find(e => e.kind === 'npc' && e.characterId === 'E-04');
  const e01of = (ctl: PlayController) => ctl.session.runtime?.view().find(e => e.kind === 'npc' && e.characterId === 'E-01');
  async function waitQueue7(ctl: PlayController, n: number) {
    for (let i = 0; i < 400 && ctl.fracture!.runtime.stats.queuedEvents < n; i++) await new Promise(res => setTimeout(res, 10));
  }
  const actorBatchCount = (bridge: RuntimeBridge, meshId: string) => (bridge.batches() ?? []).find(b => b.meshId === meshId)?.count ?? 0;

  // 只改内存中的正式场景组件；奖励选择阈值推迟，以便多 tick 仍由宿主推进。
  function cohort7(configured = true): SceneDocument {
    const doc = scene7();
    const enabled = doc.nodes.flatMap(n => n.components).find(c => c.kind === 'SpawnPoint' && c.characterId === 'E-04')!;
    if (enabled.kind !== 'SpawnPoint') throw new Error('缺少正式 E-04 SpawnPoint');
    for (const n of doc.nodes) for (const c of n.components) {
      if (c.kind === 'RunRules') c.firstChoiceKills = 100;
      if (c.kind === 'SpawnPoint' && c.characterId === 'E-01') {
        c.characterId = 'E-04';
        c.deathFracture = configured ? structuredClone(enabled.deathFracture!) : null;
      }
    }
    return doc;
  }
  async function until7(condition: () => boolean, pump = () => {}) {
    for (let i = 0; i < 800 && !condition(); i++) {
      await new Promise(r => setTimeout(r, 10));
      pump();
    }
    expect(condition()).toBe(true);
  }
  const identity7 = (v: {runId:number;id:number;generation:number}) => ({runId:v.runId,id:v.id,generation:v.generation});
  // CPU 补边界：调用原 weapon.fire，跳过原生键鼠/射速门控；不替换 trace/damage/爆炸/DOT。
  function fire7(ctl: PlayController, target: {id:number;x:number;y?:number;z:number}, weaponId: string, damage: number) {
    const rt = ctl.session.runtime!;
    const world = (rt as unknown as {weaponWorld():WeaponWorld}).weaponWorld();
    const weapon = rt.weapons.definitions.find(w => w.id === weaponId)!;
    expect(weapon).toBeTruthy();
    rt.weaponCombat.fire(weapon, [target.x, (target.y ?? 0) + 1, target.z + 0.3], [0, 0, -1], damage, rt.tick, world);
    return world;
  }
  function decoration7(i: number): FractureActivation {
    return {
      event: frozenFractureEvent({sequence:i,tick:0,seed:i+1,
        profile:{path:'assets/fracture/p01-barrel/p01-barrel.fracture.json',guid:'as_p01frct'},
        target:{kind:'scene-object',runId:'queue-oracle',nodeId:'nd_queue_'+i},
        position:[0,3,0],rotation:[0,0,0,1],scale:[1,1,1],contact:null,normal:null,impulse:null,
        source:{weaponId:'queue-oracle',hitSequence:i}}),
      chunks:[{chunkId:'decor',cls:'small',mesh:{path:'assets/fracture/p01-barrel/chunk-0001.glb',guid:'as_29a7ad90'},
        position:[0,3,0],rotation:[0,0,0,1],scale:1,shape:{type:'sphere',radius:0.1},
        mass:1,friction:0.5,restitution:0,linearVelocity:[0,0,0],angularVelocity:[0,0,0]}],
      priority:1,lifetimeSec:100,fadeSec:0.1,
    };
  }

  it.each(['shotgun','launcher'])('W07-02 原 %s 同 tick 重复伤害/多 tick 消费：身份、奖励和十块仅一次（CPU fire 边界）', async weaponId => {
    const {ctl,bridge} = await make7({scene:cohort7()});
    try {
      expect(ctl.start()).toBe(true); await ctl.fracture!.ready; ctl.update(1/30);
      const rt = ctl.session.runtime!, victim = e04of(ctl)!, identity = identity7(victim);
      const reward = vi.spyOn(rt.progress!, 'recordKill');
      const recycle = vi.spyOn(rt.table, 'destroy');
      const spawn = vi.spyOn(ctl, 'spawnFracture');
      const suppress = vi.spyOn(bridge, 'suppressDeath');
      const before = {kills:rt.progress!.kills,scrap:rt.progress!.scrap,reserve:rt.progress!.reserve};
      const world = fire7(ctl,victim,weaponId,weaponId === 'shotgun' ? 50 : 9999);
      if (weaponId === 'launcher') {
        fire7(ctl,victim,weaponId,9999);
        fire7(ctl,victim,weaponId,9999);
        // 正式 projectile.step -> explode -> 原 WeaponWorld.damage，仍是同一游戏 tick。
        for(let i=0;i<180&&rt.weaponCombat.pendingProjectiles>0;i++)rt.weaponCombat.step(rt.tick,1/30,world);
        expect(rt.weaponCombat.effects.filter(e => e.kind === 'explosion')).toHaveLength(3);
      } else {
        expect(rt.weaponCombat.effects.filter(e => e.kind === 'pellet')).toHaveLength(7);
        expect(rt.combatEvents.filter(e => e.slot === victim.id && e.type === 'damage').length).toBeGreaterThan(1);
      }
      world.damage(victim.id,9999); world.damage(victim.id,9999);
      const kill = rt.combatEvents.filter(e => e.type === 'kill' && e.slot === victim.id);
      expect(kill).toHaveLength(1);
      expect(kill[0]).toMatchObject({...{runId:identity.runId,slot:identity.id,generation:identity.generation},weaponId,sourceSlot:rt.playerEntityId});
      expect(kill[0]!.weaponEvent).toBeGreaterThan(0);
      expect(reward).toHaveBeenCalledTimes(1); expect(recycle).toHaveBeenCalledTimes(1);
      expect(recycle).toHaveBeenCalledWith(victim.id);
      expect(rt.progress!.kills).toBe(before.kills+1);
      expect(rt.progress!.scrap).toBe(before.scrap+rt.progress!.rules.scrapPerKill);
      expect(rt.progress!.reserve).toBe(before.reserve+rt.progress!.rules.weapon.ammoPerKill);
      ctl.update(0); await until7(()=>ctl.fracture!.runtime.stats.queuedEvents===1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]![0]).toMatchObject({target:{kind:'npc',runId:String(identity.runId),slot:identity.id,generation:identity.generation},source:{weaponId,hitSequence:kill[0]!.weaponEvent}});
      ctl.update(1/30);
      await until7(()=>suppress.mock.calls.length===1,()=>ctl.update(0));
      const chunks = [...ctl.fracture!.runtime.active];
      expect(chunks).toHaveLength(10);
      expect(new Set(chunks.map(c=>c.eventKey)).size).toBe(1);
      expect(new Set(chunks.map(c=>c.handle.key)).size).toBe(10);
      expect(suppress).toHaveBeenCalledWith(identity);
      for(let i=0;i<8;i++) ctl.update(1/30);
      expect(ctl.fracture!.runtime.active).toEqual(chunks);
      expect(spawn).toHaveBeenCalledTimes(1); expect(suppress).toHaveBeenCalledTimes(1);
      expect(reward).toHaveBeenCalledTimes(1); expect(recycle).toHaveBeenCalledTimes(1);
      expect(rt.view().some(e=>e.id===victim.id&&e.generation===victim.generation)).toBe(false);
    } finally {ctl.stop();}
  },60000);

  it.each(['enabled','null','absent'] as const)('W07-02 原 flame 状态 DOT 致死（SpawnPoint=%s）：burn 来源不借直接命中序号',async mode=>{
    const doc=cohort7(false);
    for(const n of doc.nodes) for(const c of n.components) if(c.kind==='SpawnPoint'&&n.id==='nd_w7_spawn_e04') {
      if(mode==='null')c.deathFracture=null;
      if(mode==='absent')delete c.deathFracture;
    }
    const {ctl,bridge}=await make7({scene:doc});
    try {
      ctl.start();await ctl.fracture!.ready;ctl.update(1/30);
      const rt=ctl.session.runtime!,victim=e04of(ctl)!,reward=vi.spyOn(rt.progress!,'recordKill');
      const spawn=vi.spyOn(ctl,'spawnFracture'),suppress=vi.spyOn(bridge,'suppressDeath');
      fire7(ctl,victim,'flame',victim.hp-0.01);
      const direct=rt.combatEvents.find(e=>e.slot===victim.id&&e.type==='damage')!;
      expect(direct.weaponEvent).toBeGreaterThan(0);expect(direct.damageKind).toBeUndefined();
      expect(rt.weaponCombat.burning).toContainEqual(expect.objectContaining({id:victim.id,generation:victim.generation}));
      ctl.update(1/30); // RuntimeSession.step -> WeaponCombat.step 的真实 burn 消费。
      const kill=rt.combatEvents.find(e=>e.slot===victim.id&&e.type==='kill')!;
      expect(kill).toMatchObject({weaponId:'flame',damageKind:'burn',sourceSlot:rt.playerEntityId});
      expect(kill.weaponEvent).toBeUndefined();expect(reward).toHaveBeenCalledTimes(1);
      if(mode==='enabled') {
        await until7(()=>spawn.mock.calls.length===1);await waitQueue7(ctl,1);ctl.update(1/30);
        await until7(()=>suppress.mock.calls.length===1,()=>ctl.update(0));
        expect(spawn.mock.calls[0]![0].source).toMatchObject({weaponId:'flame',damageKind:'burn'});
        expect(ctl.fracture!.runtime.active).toHaveLength(10);
        expect(suppress).toHaveBeenCalledWith(identity7(victim));
        expect(actorBatchCount(bridge,'actor:E-04')).toBe(1); // 另一活体仍可见。
      } else {
        for(let i=0;i<3;i++)ctl.update(1/30);
        expect(spawn).not.toHaveBeenCalled();expect(suppress).not.toHaveBeenCalled();
        expect(actorBatchCount(bridge,'actor:E-04')).toBe(2); // 活体+原 death，而非仅检查零碎块。
      }
      expect(ctl.destructibleError).toBeNull();expect(reward).toHaveBeenCalledTimes(1);
    } finally {ctl.stop();}
  },60000);

  it('W07-03 两个正式 SpawnPoint 的 E-04 并发准备倒序完成：冻结各自身份/TRS/palette，不混快照',async()=>{
    const base=realIO7();const gates:Array<()=>void>=[];
    const {ctl,bridge}=await make7({scene:cohort7(),io:{readBinary:p=>base.readBinary(p),async readText(p){
      if(p.endsWith('.fracture.json')&&gates.length<2)await new Promise<void>(r=>gates.push(r));return base.readText(p);
    }}});
    try {
      ctl.start();await ctl.fracture!.ready;for(let i=0;i<5;i++)ctl.update(1/30);
      const rt=ctl.session.runtime!,victims=rt.view().filter(e=>e.kind==='npc');
      expect(victims.map(v=>v.sourceNodeId).sort()).toEqual(['nd_w7_spawn_e01','nd_w7_spawn_e04']);
      const poses=victims.map(v=>bridge.deathPoseSnapshot(v)!);
      const spawn=vi.spyOn(ctl,'spawnFracture'),suppress=vi.spyOn(bridge,'suppressDeath');
      for(const v of victims)rt.applyDamage(v.id,9999,rt.playerEntityId);
      ctl.update(0);await until7(()=>gates.length===2);
      // 让桥继续走死亡帧；旧请求仍应保有致死前的拷贝。
      ctl.update(1/30);gates[1]!();await until7(()=>ctl.fracture!.runtime.stats.queuedEvents===1);
      ctl.update(1/30);await until7(()=>suppress.mock.calls.length===1,()=>ctl.update(0));
      expect(suppress.mock.calls[0]![0]).toEqual(identity7(victims[1]!));
      expect(actorBatchCount(bridge,'actor:E-04')).toBe(1);
      gates[0]!();await until7(()=>ctl.fracture!.runtime.stats.queuedEvents===1);
      ctl.update(1/30);await until7(()=>suppress.mock.calls.length===2,()=>ctl.update(0));
      expect(spawn).toHaveBeenCalledTimes(2);
      for(let i=0;i<2;i++) {
        const victim=victims[i]!,pose=poses[i]!;
        const event=spawn.mock.calls.find(([e])=>e.target.kind==='npc'&&e.target.id===victim.id)![0];
        expect(event.target).toEqual({kind:'npc',runId:String(victim.runId),slot:victim.id,id:victim.id,generation:victim.generation});
        expect(event.position).toEqual(pose.position);
        expect(event.rotation).toEqual([0,Math.sin(pose.yaw/2),0,Math.cos(pose.yaw/2)]);
        const joint=pose.jointNames.findIndex(n=>n!==null);
        expect(event.npcPose![pose.jointNames[joint]!]).toEqual(Array.from(pose.matrices.subarray(joint*16,joint*16+16)));
        expect(event.npcNormalization).toEqual(Array.from(pose.normalization));
        expect(Object.isFrozen(event)).toBe(true);
      }
      expect(spawn.mock.calls[0]![0].position).not.toEqual(spawn.mock.calls[1]![0].position);
      expect(ctl.fracture!.runtime.active).toHaveLength(20);
      expect(new Set(ctl.fracture!.runtime.active.map(c=>c.eventKey)).size).toBe(2);
      expect(actorBatchCount(bridge,'actor:E-04')).toBe(0);
    } finally {for(const release of gates)release();ctl.stop();}
  },60000);

  it.each(['guid','quarantined','meta'] as const)('W07-08 当前 %s 故障经真实死亡消费者保底，恢复后下一合法 NPC 成功',async fault=>{
    const base=realIO7();let broken=true;
    const {ctl,bridge}=await make7({scene:cohort7(),io:{readBinary:p=>base.readBinary(p),async readText(p){
      const raw=await base.readText(p);if(!broken)return raw;
      if(p.endsWith('e04-bulwark.fracture.json')) {const v=JSON.parse(raw);if(fault==='quarantined')v.status='quarantined';return JSON.stringify(v);}
      if(p.endsWith('e04-bulwark.fracture.json.meta.json')) {if(fault==='meta')throw new Error('current meta unreadable');if(fault==='guid'){const v=JSON.parse(raw);v.guid='as_wrong_current';return JSON.stringify(v);}}
      return raw;
    }}});
    try {
      ctl.start();await ctl.fracture!.ready;ctl.update(1/30);
      const rt=ctl.session.runtime!,victims=rt.view().filter(e=>e.kind==='npc');
      const reward=vi.spyOn(rt.progress!,'recordKill'),suppress=vi.spyOn(bridge,'suppressDeath');
      rt.applyDamage(victims[0]!.id,9999,rt.playerEntityId);ctl.update(0);
      await until7(()=>ctl.destructibleError!==null);
      expect(ctl.destructibleError).toContain(fault==='guid'?'identity':fault==='meta'?'sidecar-read':'quarantined');
      expect(suppress).not.toHaveBeenCalled();expect(actorBatchCount(bridge,'actor:E-04')).toBe(2);
      expect(ctl.fracture!.runtime.active).toHaveLength(0);expect(ctl.fracture!.runtime.stats.poolActive).toBe(0);
      broken=false;rt.applyDamage(victims[1]!.id,9999,rt.playerEntityId);ctl.update(0);
      await until7(()=>ctl.fracture!.runtime.stats.queuedEvents===1);ctl.update(1/30);
      await until7(()=>suppress.mock.calls.length===1,()=>ctl.update(0));
      expect(suppress).toHaveBeenCalledWith(identity7(victims[1]!));
      expect(actorBatchCount(bridge,'actor:E-04')).toBe(1); // 失败者 death 仍在。
      expect(ctl.fracture!.runtime.active).toHaveLength(10);expect(reward).toHaveBeenCalledTimes(2);
      expect(rt.progress!.kills).toBe(2);expect(rt.progress!.scrap).toBe(2*rt.progress!.rules.scrapPerKill);
    } finally {ctl.stop();}
  },60000);

  it('W07-08 队列真实满载拒绝死亡消费者：保留 death 与已有活动装饰块/租约',async()=>{
    const {ctl,bridge}=await make7({scene:cohort7()});
    try {
      ctl.start();await ctl.fracture!.ready;ctl.update(1/30);
      const binding=ctl.fracture!,rt=ctl.session.runtime!,victims=rt.view().filter(v=>v.kind==='npc');
      rt.applyDamage(victims[0]!.id,9999,rt.playerEntityId);ctl.update(0);
      await until7(()=>binding.runtime.stats.queuedEvents===1);ctl.update(1/30);
      await until7(()=>actorBatchCount(bridge,'actor:E-04')===1,()=>ctl.update(0));
      const existing=[...binding.runtime.active],leases=existing.map(c=>c.lease);
      const backend=binding.backend()!,rigid=existing.filter(c=>c.layer==='rigid');
      expect(rigid).toHaveLength(3);for(const c of rigid)expect(backend.snapshot(c.handle)).not.toBeNull();
      let filled=0;
      for(let i=1;i<=256;i++){expect(binding.runtime.play(decoration7(i)).accepted).toBe(true);filled++;}
      expect(binding.runtime.stats.queuedEvents).toBe(filled);
      rt.applyDamage(victims[1]!.id,9999,rt.playerEntityId);ctl.update(0);
      await until7(()=>ctl.destructibleError!==null);
      expect(ctl.destructibleError).toContain('queue-full');
      expect(actorBatchCount(bridge,'actor:E-04')).toBe(1);
      expect(binding.runtime.active).toEqual(existing);expect(existing.map(c=>c.lease)).toEqual(leases);
      expect(existing.every(c=>!c.expired)).toBe(true);expect(binding.runtime.stats.poolActive).toBe(10);
      for(const c of rigid)expect(backend.snapshot(c.handle)).not.toBeNull();
      expect(backend.ledger.dynamicBodies).toBe(3);
      expect(binding.runtime.stats.queuedEvents).toBe(256);expect(rt.progress!.kills).toBe(2);
    } finally {ctl.stop();}
  },60000);

  it.each(['rigid','small','both'] as const)('W07-08 %s 预算真实满载：撤销该死亡的部分接管，保留其他活动租约',async(full)=>{
    const {ctl,bridge}=await make7({scene:cohort7()});
    try {
      ctl.start();await ctl.fracture!.ready;ctl.update(1/30);
      const binding=ctl.fracture!,rt=ctl.session.runtime!,victim=e04of(ctl)!,sample=decoration7(777),base=sample.chunks[0]!;
      const large=full==='small'?0:32,small=full==='rigid'?0:256;
      const chunks=Array.from({length:large+small},(_,i)=>({...base,chunkId:'occupied-'+i,cls:i<large?'large' as const:'small' as const,position:[20+i*.3,3,0] as const}));
      expect(binding.runtime.play({...sample,chunks,priority:999}).accepted).toBe(true);ctl.update(1/30);
      const existing=[...binding.runtime.active],suppress=vi.spyOn(bridge,'suppressDeath');
      expect(binding.runtime.stats.rigidActive).toBe(large);expect(binding.runtime.stats.simplifiedActive).toBe(small);
      rt.applyDamage(victim.id,9999,rt.playerEntityId);ctl.update(0);
      await until7(()=>binding.runtime.stats.queuedEvents===1);ctl.update(1/30);
      expect(ctl.destructibleError).toContain('容量不足');expect(suppress).not.toHaveBeenCalled();
      expect(binding.runtime.active).toEqual(existing);expect(binding.runtime.stats.poolActive).toBe(large+small);
      expect(existing.every(c=>!c.expired&&c.lease!==null)).toBe(true);expect(binding.backend()!.ledger.dynamicBodies).toBe(large);
      expect(rt.progress!.kills).toBe(1);
    } finally {ctl.stop();expect(ctl.ledger.pending).toBe(0);}
  },60000);

  it('W07-03 原槽位回收后新 generation 已呈现，旧 GPU ready 只能抑制旧 death',async()=>{
    const {ctl,bridge,renderer}=await make7({scene:cohort7(),gpuState:'pending'});
    try {
      ctl.start();await ctl.fracture!.ready;ctl.update(1/30);
      const rt=ctl.session.runtime!,old=e04of(ctl)!,suppress=vi.spyOn(bridge,'suppressDeath');
      fire7(ctl,old,'sniper',9999);ctl.update(0);await until7(()=>ctl.fracture!.runtime.stats.queuedEvents===1);
      ctl.update(1/30);await until7(()=>renderer.core.dynamicBatchState.mock.calls.length>0,()=>ctl.update(0));
      expect(suppress).not.toHaveBeenCalled();
      // 明确的受控补边界：正式 debugSpawn -> 原 CharacterTable freelist/initNpcSlot；
      // 不伪称场景波次刷怪。新代和旧 death 的消费者仍是原 RuntimeBridge/NpcMotion。
      expect(rt.debugSpawn('E-04',old.x,old.z+1,1)).toBe(1);
      const next=rt.view().find(v=>v.id===old.id)!;
      expect(next.generation).toBeGreaterThan(old.generation);expect(next.runId).toBe(old.runId);
      bridge.refresh();expect(bridge.deathPoseSnapshot(next)).not.toBeNull();
      expect(actorBatchCount(bridge,'actor:E-04')).toBe(3); // 另一个活体+新代+旧 death。
      renderer.core.dynamicBatchState.mockReturnValue('ready');ctl.update(0);
      expect(suppress).toHaveBeenCalledTimes(1);expect(suppress).toHaveBeenCalledWith(identity7(old));
      expect(actorBatchCount(bridge,'actor:E-04')).toBe(2);
      expect(rt.view().find(v=>v.id===old.id)).toMatchObject(identity7(next));
      expect(bridge.deathPoseSnapshot(next)).not.toBeNull();
      // 新代普通死亡也必须保留；旧 suppress 不得按 slot 留下永久屏蔽。
      rt.applyDamage(next.id,9999,rt.playerEntityId);ctl.update(0);
      expect(actorBatchCount(bridge,'actor:E-04')).toBe(2);
      expect(suppress).toHaveBeenCalledTimes(1);
      expect(ctl.fracture!.runtime.active).toHaveLength(10);
    } finally {ctl.stop();}
  },60000);

  // 每个 await 阶段各自有迟到成功/失败。已有 profile/Reset 不重复；这里 profile/Stop，
  // meta/Reset，source GLB/真换场景，chunk GLB/Stop。生产守卫不同，不能只测纯 prepare。
  const lateCases7 = [
    {stage:'profile',change:'stop'}, {stage:'meta',change:'reset'},
    {stage:'source-glb',change:'scene'}, {stage:'chunk-glb',change:'stop'},
  ] as const;
  it.each(lateCases7.flatMap(c=>[false,true].map(fail=>({...c,fail}))))(
    'W07-09 $stage 挂起后 $change 换代，迟到失败=$fail：旧真实资源释放、新代诊断与播放隔离',async({stage,change,fail})=>{
      const base=realIO7();
      let armed=false,held=false,release:(()=>void)|undefined,badNew=false;
      const reads:string[]=[];
      const shouldHold=(p:string,binary:boolean)=>armed&&!held&&(
        stage==='profile'&&!binary&&p.endsWith('.fracture.json')||
        stage==='meta'&&!binary&&p.endsWith('e04-bulwark.fracture.json.meta.json')||
        stage==='source-glb'&&binary&&p.includes('/E-04/rigged/')||
        stage==='chunk-glb'&&binary&&p==='assets/fracture/e04-bulwark/head.glb');
      async function gate(p:string,binary:boolean) {
        reads.push(p);
        if(!shouldHold(p,binary))return;
        held=true;await new Promise<void>(r=>release=r);
        if(fail)throw new Error('LATE_'+stage+'_FAIL');
      }
      const {ctl,bridge,renderer}=await make7({scene:cohort7(),io:{
        async readText(p){await gate(p,false);const raw=await base.readText(p);
          if(badNew&&p.endsWith('.fracture.json')){const v=JSON.parse(raw);v.npc.actorId='E-01';return JSON.stringify(v);}return raw;},
        async readBinary(p){await gate(p,true);return base.readBinary(p);},
      }});
      try {
        ctl.start();await ctl.fracture!.ready;ctl.update(1/30);
        const oldBinding=ctl.fracture!,oldRuntime=oldBinding.runtime,backend=oldBinding.backend()!;
        const oldPlay=vi.spyOn(oldRuntime,'play');
        // 只观察原消费者 promise，不替换其行为；用于等待其 then 诊断也已消费。
        const deathTasks=vi.spyOn(ctl as unknown as {playDeathFracture(...args:unknown[]):Promise<{accepted:boolean;rejection:{reason:string}|null}>},'playDeathFracture');
        const rt=ctl.session.runtime!,oldRun=rt.runId,victims=rt.view().filter(v=>v.kind==='npc');
        // 先有一次成功接管，保留实际 body/租约；再把另一死亡准备停在指定 IO。
        rt.applyDamage(victims[0]!.id,9999,rt.playerEntityId);ctl.update(0);
        await until7(()=>oldRuntime.stats.queuedEvents===1);ctl.update(1/30);
        await until7(()=>actorBatchCount(bridge,'actor:E-04')===1,()=>ctl.update(0));
        const chunks=[...oldRuntime.active],rigid=chunks.filter(c=>c.layer==='rigid');
        expect(chunks).toHaveLength(10);expect(rigid).toHaveLength(3);
        for(const c of rigid)expect(backend.snapshot(c.handle)).not.toBeNull();
        for(const c of chunks)expect(c.lease).not.toBeNull();
        armed=true;rt.applyDamage(victims[1]!.id,9999,rt.playerEntityId);ctl.update(0);
        await until7(()=>held);
        const lateDeath=deathTasks.mock.results[1]!.value;
        // 除活动资源外还留一条真队列请求：dispose 必须把它一起清掉。
        expect(oldRuntime.play(decoration7(900))).toMatchObject({accepted:true});
        expect(oldRuntime.stats.queuedEvents).toBe(1);
        const callsBefore=oldPlay.mock.calls.length;
        const authorBefore=structuredClone(renderer.getDocument());
        if(change==='reset')ctl.reset();
        else {
          ctl.stop();expect(ctl.ledger.pending).toBe(0);
          if(change==='scene') {
            const replacement=cohort7();replacement.id='sc_w7_replacement';replacement.name='WU07 真换场景';
            replacement.nodes.find(n=>n.id==='nd_w7_spawn_e04')!.transform.position[0]=1.25;
            renderer.setDocument(replacement);
          }
          expect(ctl.start()).toBe(true);
        }
        const fresh=ctl.fracture!;await fresh.ready;ctl.update(1/30);
        // 比较引用布尔值，避免断言库遍历已 dispose binding 的抛错 runtime getter。
        expect(fresh===oldBinding).toBe(false);expect(ctl.session.runtime!.runId).not.toBe(oldRun);
        expect(oldBinding.backend()).toBeNull();expect(oldRuntime.disposed).toBe(true);
        expect(oldRuntime.active).toHaveLength(0);
        expect(oldRuntime.stats).toMatchObject({queuedEvents:0,poolActive:0,rigidActive:0,simplifiedActive:0});
        expect(backend.ledger).toMatchObject({destroyed:true,dynamicBodies:0,staticColliders:0});
        for(const c of chunks){expect(c.expired).toBe(true);expect(c.lease).toBeNull();}
        for(const c of rigid)expect(backend.snapshot(c.handle)).toBeNull();
        if(change==='reset')expect(renderer.getDocument()).toEqual(authorBefore);
        if(change==='scene')expect(renderer.getDocument()).toMatchObject({id:'sc_w7_replacement',name:'WU07 真换场景'});
        // 新代自己先报错；释放旧 IO 后不得把它清除或替换成旧错误。
        const newRt=ctl.session.runtime!,newVictims=newRt.view().filter(v=>v.kind==='npc');
        badNew=true;newRt.applyDamage(newVictims[0]!.id,9999,newRt.playerEntityId);ctl.update(0);
        await until7(()=>ctl.destructibleError?.includes('actor-mismatch')===true);
        const diagnostic=ctl.destructibleError;
        expect(diagnostic).toContain('@'+newRt.runId+':');
        badNew=false;release!();
        const lateResult=await lateDeath;
        // 不只检查最终 UI：删掉 spawnFracture 的 await 后守卫会变成 runtime-unavailable，
        // 即使外层 then 守卫仍阻止诊断污染，这条返回值 oracle 也必须能识别。
        expect(lateResult).toMatchObject({accepted:false,rejection:{reason:
          stage==='profile'||!fail?'session-closed':stage==='meta'?'sidecar-read':'ref-binary'}});
        await Promise.resolve();await Promise.resolve();ctl.update(0);
        expect(oldPlay).toHaveBeenCalledTimes(callsBefore);
        expect(oldRuntime.stats).toMatchObject({queuedEvents:0,poolActive:0});
        expect(fresh.runtime.active).toHaveLength(0);expect(fresh.runtime.stats.queuedEvents).toBe(0);
        expect(ctl.destructibleError).toBe(diagnostic);
        expect(actorBatchCount(bridge,'actor:E-04')).toBe(2);
        expect(reads.some(p=>stage==='profile'?p.endsWith('.fracture.json'):stage==='meta'?p.endsWith('.meta.json'):p.endsWith('.glb'))).toBe(true);
        // 同一新 binding 的后续合法 NPC 仍可完整准备/激活/抑制，不只检查清零。
        newRt.applyDamage(newVictims[1]!.id,9999,newRt.playerEntityId);ctl.update(0);
        await until7(()=>fresh.runtime.stats.queuedEvents===1);ctl.update(1/30);
        await until7(()=>actorBatchCount(bridge,'actor:E-04')===1,()=>ctl.update(0));
        expect(fresh.runtime.active).toHaveLength(10);expect(fresh.backend()!.ledger.dynamicBodies).toBe(3);
        expect(fresh.runtime.active.every(c=>c.eventKey.includes('npc:'+newRt.runId+':'))).toBe(true);
      } finally {release?.();ctl.stop();expect(ctl.ledger.pending).toBe(0);}
    },60000,
  );

  it('真实 kill 冻结最后可见姿态：10 块激活（3 大 7 小）且只抑制该身份死亡尾部', async () => {
    const { ctl, bridge } = await make7();
    expect(ctl.start()).toBe(true);
    await ctl.fracture!.ready;
    const rt = ctl.session.runtime!;
    const victim = e04of(ctl);
    expect(victim).toBeTruthy();
    for (let i = 0; i < 30; i++) ctl.update(1 / 30); // 走向玩家：walk 相位推进 + bridge 记录姿态行
    const identity = { runId: victim!.runId, id: victim!.id, generation: victim!.generation };
    const snap = bridge.deathPoseSnapshot(identity);
    expect(snap).not.toBeNull();
    // 非参照证：快照与 bind 行至少在一个映射骨骼上显著不同（walk 相位生效）
    const actor = await ensureE04Actor();
    const hips = snap!.jointNames.indexOf('Hips');
    const bindBase = actor.restPose * actor.palette.jointCount * 16 + hips * 16;
    let maxDiff = 0;
    for (let i = 0; i < 16; i++) maxDiff = Math.max(maxDiff, Math.abs(snap!.matrices[hips * 16 + i]! - actor.palette.data[bindBase + i]!));
    expect(maxDiff).toBeGreaterThan(1e-3);
    // 真实致死（一次性；奖励/槽位由会话原路径完成）
    rt.applyDamage(victim!.id, 99999, rt.playerEntityId, { weaponId: 'w_pistol', vfxSequence: 77 });
    ctl.update(1 / 30);
    await waitQueue7(ctl, 1);
    expect(ctl.fracture!.runtime.stats.queuedEvents).toBe(1);
    ctl.update(1 / 30);
    expect(ctl.fracture!.runtime.active.length).toBe(10);
    expect(ctl.fracture!.runtime.stats.rigidActive).toBe(3);
    ctl.update(1 / 30);
    // 成功接管：该身份死亡尾部隐藏（批次计数 0）
    for (let i=0;i<200 && actorBatchCount(bridge,'actor:E-04')>0;i++) { await new Promise(r=>setTimeout(r,10)); ctl.update(1/30); }
    expect(actorBatchCount(bridge, 'actor:E-04')).toBe(0);
    expect(ctl.destructibleError).toBeNull();
    expect(rt.view().some(x => x.id === identity.id && x.generation === identity.generation)).toBe(false);
    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 60000);

  it('profile 读取失败：死亡保底保留（不隐藏尸体），诊断可见且不产生碎片', async () => {
    const base = realIO7();
    const io: FractureAssetIO = {
      async readText(path: string) {
        if (path.includes('e04-bulwark.fracture.json')) throw new Error('EIO profile 不可读');
        return base.readText(path);
      },
      readBinary: (p) => base.readBinary(p),
    };
    const { ctl, bridge } = await make7({ io });
    expect(ctl.start()).toBe(true);
    await ctl.fracture!.ready;
    for (let i = 0; i < 5; i++) ctl.update(1 / 30);
    const victim = e04of(ctl)!;
    ctl.session.runtime!.applyDamage(victim.id, 99999, ctl.session.runtime!.playerEntityId, { weaponId: 'w_pistol' });
    ctl.update(1 / 30);
    for (let i = 0; i < 200 && ctl.destructibleError === null; i++) await new Promise(res => setTimeout(res, 10));
    expect(ctl.destructibleError).toContain('E-04');
    expect(ctl.destructibleError).toContain('profile');
    // 失败保底：死亡尾部保留（批次仍有 1 个 E-04 尸体实例），无碎片
    expect(actorBatchCount(bridge, 'actor:E-04')).toBe(1);
    expect(ctl.fracture!.runtime.stats.queuedEvents).toBe(0);
    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 60000);

  it('坏 boneMap=null 进入原死亡保底诊断，没有未处理异步异常', async()=>{
    const base=realIO7();
    const {ctl,bridge}=await make7({io:{readBinary:p=>base.readBinary(p),async readText(p){const s=await base.readText(p);if(!p.endsWith('.fracture.json'))return s;const v=JSON.parse(s);v.npc.boneMap=null;return JSON.stringify(v);}}});
    ctl.start();await ctl.fracture!.ready;ctl.update(1/30);
    const v=e04of(ctl)!;ctl.session.runtime!.applyDamage(v.id,99999,ctl.session.runtime!.playerEntityId);ctl.update(1/30);
    for(let i=0;i<100&&!ctl.destructibleError;i++)await new Promise(r=>setTimeout(r,10));
    expect(ctl.destructibleError).toContain('profile-read');expect(actorBatchCount(bridge,'actor:E-04')).toBe(1);
    expect(ctl.fracture!.runtime.active.length).toBe(0);ctl.stop();
  },60000);

  it('GPU owner 分配失败只撤销该事件的真刚体/租约，保留普通 death',async()=>{
    const {ctl,bridge,renderer}=await make7({gpuReady:false});ctl.start();await ctl.fracture!.ready;ctl.update(1/30);
    const v=e04of(ctl)!;ctl.session.runtime!.applyDamage(v.id,99999,ctl.session.runtime!.playerEntityId);ctl.update(1/30);await waitQueue7(ctl,1);ctl.update(1/30);
    expect(ctl.fracture!.runtime.active.length).toBe(10);
    for(let i=0;i<200&&!ctl.destructibleError;i++){await new Promise(r=>setTimeout(r,10));ctl.update(0);}
    expect(renderer.core.dynamicBatchState).toHaveBeenCalled();expect(ctl.destructibleError).toContain('GPU allocation failure');
    expect(actorBatchCount(bridge,'actor:E-04')).toBe(1);expect(ctl.fracture!.runtime.active.length).toBe(0);expect(ctl.fracture!.runtime.stats.poolActive).toBe(0);
    ctl.stop();expect(ctl.ledger.pending).toBe(0);
  },60000);

  it('几何齐备但原绘制上传仍pending时保留尸体，收到实际ready回执才抑制',async()=>{
    const {ctl,bridge,renderer}=await make7();renderer.core.dynamicBatchState.mockReturnValue('pending');
    ctl.start();await ctl.fracture!.ready;ctl.update(1/30);const v=e04of(ctl)!;
    ctl.session.runtime!.applyDamage(v.id,99999,ctl.session.runtime!.playerEntityId);ctl.update(1/30);await waitQueue7(ctl,1);ctl.update(1/30);
    for(let i=0;i<200&&!renderer.core.dynamicBatchState.mock.calls.length;i++){await new Promise(r=>setTimeout(r,10));ctl.update(0);}
    expect(renderer.core.dynamicBatchState).toHaveBeenCalled();expect(ctl.fractureBatches.length).toBe(20);
    expect(actorBatchCount(bridge,'actor:E-04')).toBe(1);expect(ctl.destructibleError).toBeNull();
    renderer.core.dynamicBatchState.mockReturnValue('ready');ctl.update(0);expect(actorBatchCount(bridge,'actor:E-04')).toBe(0);ctl.stop();
  },60000);

  it.each([false,true])('Stop/Start 新 run 首次 kill 不被旧游标跳过（空帧=%s）',async(emptyFrame)=>{
    const base=realIO7();const {ctl}=await make7({io:{readBinary:p=>base.readBinary(p),async readText(p){if(p.endsWith('.fracture.json'))throw new Error('cursor oracle');return base.readText(p);}}});
    for(let run=0;run<2;run++){
      ctl.start();await ctl.fracture!.ready;if(run===0||emptyFrame)ctl.update(1/30);
      const v=e04of(ctl)!;ctl.session.runtime!.applyDamage(v.id,99999,ctl.session.runtime!.playerEntityId);ctl.update(1/30);
      for(let i=0;i<100&&!ctl.destructibleError;i++)await new Promise(r=>setTimeout(r,10));
      expect(ctl.destructibleError).toContain('profile-read');ctl.stop();
    }
  },60000);

  it('受控同slot跨generation迟到失败不能覆盖新身份诊断（真实死亡消费者）',async()=>{
    const base=realIO7();let release!:()=>void,calls=0;
    const {ctl,bridge}=await make7({io:{readBinary:p=>base.readBinary(p),async readText(p){if(!p.endsWith('.fracture.json'))return base.readText(p);calls++;if(calls===1){await new Promise<void>(r=>release=r);throw new Error('old generation');}const raw=JSON.parse(await base.readText(p));raw.npc.actorId='E-01';return JSON.stringify(raw);}}});
    ctl.start();await ctl.fracture!.ready;ctl.update(1/30);const rt=ctl.session.runtime!,victim=e04of(ctl)!,snap=bridge.deathPoseSnapshot(victim)!;
    rt.applyDamage(victim.id,99999,rt.playerEntityId);const old=rt.combatEvents.find(e=>e.type==='kill')!;
    ctl.update(1/30);for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10));expect(release).toBeTypeOf('function');
    const next={...old,generation:old.generation+1,defeated:{...old.defeated!,generation:old.generation+1}};
    // 仅替换输入事实/姿态边界，保留 consumeDeathFractures→异步准备→诊断的生产链。
    vi.spyOn(rt,'combatEvents','get').mockReturnValue([old,next]);vi.spyOn(bridge,'deathPoseSnapshot').mockReturnValue(snap);
    ctl.update(1/30);for(let i=0;i<100&&!ctl.destructibleError;i++)await new Promise(r=>setTimeout(r,10));
    expect(ctl.destructibleError).toContain('actor-mismatch');const newest=ctl.destructibleError;
    release();await new Promise(r=>setTimeout(r,50));expect(ctl.destructibleError).toBe(newest);ctl.stop();
  },60000);

  it('未配置对照 E-01 普通死亡：不触发碎裂、无诊断', async () => {
    const { ctl } = await make7();
    expect(ctl.start()).toBe(true);
    await ctl.fracture!.ready;
    for (let i = 0; i < 5; i++) ctl.update(1 / 30);
    const plain = e01of(ctl)!;
    ctl.session.runtime!.applyDamage(plain.id, 99999, ctl.session.runtime!.playerEntityId, { weaponId: 'w_pistol' });
    ctl.update(1 / 30);
    await new Promise(res => setTimeout(res, 150));
    expect(ctl.fracture!.runtime.stats.queuedEvents).toBe(0);
    expect(ctl.destructibleError).toBeNull();
    ctl.stop();
  }, 60000);

  it('非致死伤害不碎裂：受击反馈照常，事件缓冲无 kill', async () => {
    const { ctl } = await make7();
    expect(ctl.start()).toBe(true);
    await ctl.fracture!.ready;
    for (let i = 0; i < 5; i++) ctl.update(1 / 30);
    const victim = e04of(ctl)!;
    ctl.session.runtime!.applyDamage(victim.id, 100, ctl.session.runtime!.playerEntityId, { weaponId: 'w_pistol' });
    ctl.update(1 / 30);
    await new Promise(res => setTimeout(res, 100));
    expect(ctl.fracture!.runtime.stats.queuedEvents).toBe(0);
    expect(ctl.destructibleError).toBeNull();
    // 仍未死：继续存在于视图
    expect(e04of(ctl)).toBeTruthy();
    ctl.stop();
  }, 60000);

  it('读取期间 Reset 换代：迟到的死亡碎裂不作用于新代', async () => {
    const base = realIO7();
    let hold: (() => void) | null = null;
    const io: FractureAssetIO = {
      async readText(path: string) {
        if (path.includes('e04-bulwark.fracture.json') && hold === null) {
          await new Promise<void>(r => { hold = r; });
        }
        return base.readText(path);
      },
      readBinary: (p) => base.readBinary(p),
    };
    const { ctl } = await make7({ io });
    expect(ctl.start()).toBe(true);
    await ctl.fracture!.ready;
    for (let i = 0; i < 5; i++) ctl.update(1 / 30);
    const victim = e04of(ctl)!;
    ctl.session.runtime!.applyDamage(victim.id, 99999, ctl.session.runtime!.playerEntityId, { weaponId: 'w_pistol' });
    ctl.update(1 / 30);
    for (let i = 0; i < 400 && hold === null; i++) await new Promise(res => setTimeout(res, 10));
    expect(hold).not.toBeNull();
    ctl.reset();
    const second = ctl.fracture!;
    await second.ready;
    hold!();
    await new Promise(res => setTimeout(res, 150));
    // 新代未被污染：无碎片、无诊断、E-04 复活完整
    expect(second.runtime.stats.queuedEvents).toBe(0);
    expect(ctl.destructibleError).toBeNull();
    expect(e04of(ctl)).toBeTruthy();
    ctl.stop();
    expect(ctl.ledger.pending).toBe(0);
  }, 60000);
});
