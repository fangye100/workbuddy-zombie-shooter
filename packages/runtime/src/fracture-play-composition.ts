/**
 * WU-04 宿主窄组合：把碎片运行时接入既有 Play 生命周期（R3）。
 *
 * 责任：在 Play 启动时创建物理 session（经 createFracturePhysicsSession），用场景
 * collider 真源（SceneGraph）做初始 syncStaticMirrorsFromScene，登记 Stop 释放资源，
 * 场景 collider 变化后再次正式 sync。复用既有 PlaySession 固定步长与 registerResource
 * 账目，不复制第二套时钟、不另造碰撞源。
 *
 * 分层：本模块只做装配；SceneGraph/PlaySession/资产 IO 由宿主注入，runtime 不直接
 * 碰 fs/DOM/编辑器。伤害→激活的策略接线属 WU-06/07，本模块不提前实现。
 */

import { syncStaticMirrorsFromScene, syncStaticMirrorPoses } from './fracture-scene-mirror';
import { createFracturePhysicsSession, type FracturePhysicsSession } from './fracture-physics-session';
import { createFractureRuntime, type FractureRuntime, type FractureRuntimeOptions } from './fracture-runtime';
import type { RapierFractureBackend } from './fracture-rapier';
import type { SceneGraph } from '@aether/scene';

/** 宿主 Play 生命周期端口（由 zombie-game PlaySession/编辑器适配注入）。 */
export interface FracturePlayHost {
  /** 登记 Stop 时释放的资源（账目进既有 PlaySession ledger）。 */
  registerResource(label: string, dispose: () => void): void;
  /** 当前固定步长（秒）；碎片 runtime 与之共享同一物理时钟。 */
  readonly fixedStepSec: number;
}

export interface FracturePlayBinding {
  /** 物理 session（generation 守卫 + dispose 释放）。 */
  readonly session: FracturePhysicsSession & { start(opts: { fixedStepSec: number }): Promise<unknown> };
  /** 碎片运行时（宿主按固定 tick 驱动；渲染层读 active）。 */
  readonly runtime: FractureRuntime;
  /**
   * 完整、幂等的释放合同（Stop/Reset 唯一入口）：
   * 先退役活动块/归还租约/清队列并关闭 runtime，再销毁物理 World。
   * 未就绪时取消进行中的初始化；重复调用安全。
   */
  dispose(): void;
  /** 装配/推进失败原因（诊断；null = 无失败）。宿主可据此提示或重试，不再静默。 */
  readonly failure: { readonly stage: string; readonly detail: string } | null;
  /** 场景 collider 状态变化后再次正式 sync（差分移除失效镜像，保留其他 owner）。 */
  syncScene(graph: SceneGraph): void;
  /** 运行期 collider 权威姿态变化后重定位对应镜像（导航门等），不重建整张场景图。 */
  syncRuntimePoses(poses: readonly { nodeId: string; position: readonly [number, number, number] }[]): void;
  /** 物理后端（启动完成前为 null）。 */
  backend(): RapierFractureBackend | null;
  /** 后端就绪（含首次场景镜像 sync 完成）；cancelled/rejected 时 resolve false。 */
  readonly ready: Promise<boolean>;
}

export interface FracturePlayBindingOptions extends FractureRuntimeOptions {
  /** 初始场景（启动时做首次镜像 sync）。 */
  readonly initialScene: SceneGraph;
}

/**
 * 在 Play 启动时装配碎片运行时：
 * - 校验宿主固定步长与后端 timestep 一致（createFractureRuntime 内部强制）；
 * - 创建物理 session 并异步 start（Rapier WASM 加载）；
 * - 就绪后做首次场景镜像 sync；
 * - 登记 registerResource：Stop 时先还租约/退役碎片，再销毁后端 World；
 * - 重开 = 宿主 dispose 旧 binding/session 后 create 新 binding（已 dispose 的 session 不再 start）。
 *
 * 异步迟到/Stop/换场景由 session generation 守卫：就绪回调核对 session 仍是当前代。
 */
export function bindFractureToPlay(
  host: FracturePlayHost,
  opts: FracturePlayBindingOptions,
): FracturePlayBinding {
  const session = createFracturePhysicsSession();
  let backend: RapierFractureBackend | null = null;
  let runtime: FractureRuntime | null = null;

  let failure: { stage: string; detail: string } | null = null;
  const startPromise = session.start({ fixedStepSec: host.fixedStepSec });
  const ready: Promise<boolean> = startPromise.then((r: unknown) => {
    const res = r as { status: string; backend: RapierFractureBackend | null };
    if (res.status === 'rejected') {
      // 重复/并发启动是宿主用法问题，必须能看见，而不是"没准备好"。
      failure = { stage: 'session-rejected', detail: '物理 session 重复启动被拒绝（已有活动/初始化中的后端）' };
      return false;
    }
    if (res.status !== 'started' || res.backend === null) { // cancelled：Stop/换代，正常
      failure = { stage: 'session-cancelled', detail: '物理 session 已取消（Stop/换代）' };
      return false;
    }
    backend = res.backend;
    // 时钟一致性由 createFractureRuntime 强制（不一致抛错，不静默分离）。
    try {
      runtime = createFractureRuntime(backend, { ...opts, fixedStepSec: host.fixedStepSec });
    } catch (e) {
      // 失败原子清理：立即销毁已创建 session（不留活动 World 到未来 Stop）。
      failure = { stage: 'runtime-create', detail: String(e) };
      session.dispose();
      backend = null;
      return false;
    }
    // 首次场景镜像（同一 collider 真源）。
    try {
      syncStaticMirrorsFromScene(opts.initialScene, backend);
    } catch (e) {
      // 首次 sync 失败同样原子清理半装配资源。
      failure = { stage: 'initial-sync', detail: String(e) };
      session.dispose();
      backend = null;
      runtime = null;
      return false;
    }
    return true;
  }).catch((e: unknown) => {
    // WASM 加载/初始化失败：清理 session，记录诊断，返回 false（不产生未处理 rejection）。
    failure = { stage: 'backend-init', detail: String(e) };
    session.dispose();
    backend = null;
    runtime = null;
    return false;
  });

  /**
   * 唯一释放链（幂等）：runtime 先退役活动块/归还租约/清队列并关闭，
   * 再销毁物理 World。宿主 Stop/Reset 与账目回调都走这里，避免只销毁 World
   * 而把活动租约、排队请求和 disposed 状态留在旧代里。
   */
  const dispose = (): void => {
    if (runtime !== null) {
      runtime.dispose(); // 退役活动块 + 归还租约 + 清队列 + 标记 disposed + 销毁 backend
      runtime = null;
    }
    session.dispose(); // 未就绪/已取消时取消初始化；已销毁时幂等
    backend = null;
  };

  const binding: FracturePlayBinding = {
    session,
    ready,
    get runtime(): FractureRuntime {
      if (runtime === null) throw new Error('碎片运行时未就绪（后端异步初始化未完成或已取消）');
      return runtime;
    },
    backend: () => backend,
    get failure() { return failure; },
    dispose,
    syncScene(graph: SceneGraph): void {
      if (backend !== null) syncStaticMirrorsFromScene(graph, backend);
    },
    syncRuntimePoses(poses): void {
      if (backend !== null) syncStaticMirrorPoses(poses, backend);
    },
  };

  // Stop 释放：登记进既有 PlaySession 账目（AGENTS.md §2.4）；与控制器共用同一条释放链。
  host.registerResource('fracture-runtime', dispose);

  return binding;
}

/**
 * 真实 PlaySession 宿主适配（R3）：把碎片运行时挂进 zombie-game PlaySession 的
 * registerResource / fixedStep 链路，非模拟替身。宿主在游戏固定步（PlaySession.advance
 * 的 session.step() 之后）调用返回值的 onFixedTick 推进碎片物理。
 */
export function bindFractureToPlaySession(
  playSession: { registerResource(label: string, dispose: () => void): void; readonly fixedStep: number },
  opts: FracturePlayBindingOptions,
): FracturePlayBinding & { onFixedTick(dtSec: number): void } {
  const host: FracturePlayHost = {
    fixedStepSec: playSession.fixedStep,
    registerResource: (label, dispose) => playSession.registerResource(label, dispose),
  };
  return attachFixedTick(bindFractureToPlay(host, opts));
}

/**
 * 给绑定接上固定步分发（R3 唯一实现，宿主适配器与编辑器控制器共用）。
 * 后端未就绪（Rapier WASM 加载中）或已释放时不抛异常，静默跳过本步：
 * 碎片是装饰，宁可延迟几帧也不阻断整个 Play 帧。
 */
export function attachFixedTick(
  binding: FracturePlayBinding,
): FracturePlayBinding & { onFixedTick(dtSec: number): void; lastTickError: string | null } {
  let lastTickError: string | null = null;
  const attached = Object.assign(binding, {
    onFixedTick(dtSec: number): void {
      // 未就绪（WASM 加载中）或已释放：跳过本步，不阻断 Play 帧。
      if (binding.backend() === null) return;
      try {
        binding.runtime.tick(dtSec);
      } catch (e) {
        // 不再完全静默：记录首次失败原因供宿主诊断，同时保持帧不中断。
        if (lastTickError === null) lastTickError = String(e);
      }
    },
  });
  // Object.assign 会"求值"对象字面量里的 getter；用 defineProperty 才能真正暴露诊断。
  Object.defineProperty(attached, 'lastTickError', {
    get: () => lastTickError, enumerable: true, configurable: true,
  });
  return attached as FracturePlayBinding & { onFixedTick(dtSec: number): void; lastTickError: string | null };
}
