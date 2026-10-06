/**
 * PlayController —— 编辑器侧的**装配层**（WU-4）。
 *
 * 严格遵守 docs/17「编辑器入口只装配服务与按钮」：这里**没有任何玩法逻辑，也没有
 * 运行状态**。状态机在 `PlaySession`（runtime 包，纯 CPU 可测），渲染翻译在
 * `RuntimeBridge`。本类只做三件装配工作：
 *
 *   1. Play 前给作者状态打快照，Stop 时整份恢复（不从磁盘重载）；
 *   2. 把 PlaySession 的世界推进同步给 Bridge（推进后 refresh 一次）；
 *   3. 把状态变化通知给 UI（按钮启用/禁用、层级面板刷新）。
 *
 * ## 相机（ADR-018 P6，已改）
 *
 * 早期（docs/17 WU-4）定的是 A 方案：**不引入游戏相机**，编辑相机在 Play 中
 * 照常自由移动，理由是"改之前/改之后要能同机位对比"。
 *
 * 🔴 **该方案已被 P6 取代**：现在 Play 会切到场景的游戏相机（`entryCamera` →
 * 第一个启用的 Camera 组件），Stop 精确还原编辑机位。上面那段旧说明已作废，
 * 保留这段是为了说明"为什么变了"——别照旧注释理解现状。
 *
 * 不接管的情况（场景无可用 Camera / 未注入 viewCamera）仍保持编辑相机自由移动，
 * 即旧的 A 方案行为，所以调试对比能力没有丢。
 */

import { PlaySession, type PlayState } from '@aether/runtime';
import type { BehaviorExecutor } from '@aether/runtime';
import {
  PlayCameraController,
  type ViewCameraControl,
  type WorldPosOf,
} from './play-camera';
import type { RuntimeBridge } from './runtime-bridge';
import type { AuthorSnapshot, LabRenderer } from '../renderer';
import type { PlayerPresentation } from './player-presentation';
import type { RuntimeSceneMotion } from './runtime-scene-motion';

export interface PlayControllerOptions {
  sharedMotions?: RuntimeSceneMotion;
  playerPresentation?: PlayerPresentation;
  seed?: number;
  capacity?: number;
  /**
   * 行为执行器（ADR-018 P3）。由**编辑器宿主**注入（`behavior-host.ts` 提供），
   * runtime 侧保持纯 CPU、不 import 行为代码。
   */
  executor?: BehaviorExecutor;
  /**
   * 主视图相机控制（ADR-018 P6）。传入后 Play 会切到场景的游戏相机。
   *
   * **不传 = 保持编辑相机不动**（此前的行为）。必须显式传入，避免"悄悄改了视角"
   * 这种没有声明的副作用。
   */
  viewCamera?: ViewCameraControl;
  /** 取场景节点世界坐标（Play 相机定位用） */
  worldPosOf?: WorldPosOf;
  /** 状态变化时回调（UI 据此刷新按钮与面板） */
  onStateChange?: () => void;
}

export class PlayController {
  readonly session: PlaySession;
  private readonly bridge: RuntimeBridge;
  private readonly renderer: LabRenderer;
  private readonly onStateChange: (() => void) | null;
  /** Play 相机控制器。null = 不接管相机（保持编辑相机） */
  private readonly playCamera: PlayCameraController | null;
  private readonly worldPosOf: WorldPosOf | null;
  private snap: AuthorSnapshot | null = null;
  private lastError: string | null = null;
  private readonly playerPresentation: PlayerPresentation | null;
  private readonly sharedMotions: RuntimeSceneMotion | null;

  constructor(renderer: LabRenderer, bridge: RuntimeBridge, opts: PlayControllerOptions = {}) {
    this.renderer = renderer;
    this.playerPresentation = opts.playerPresentation ?? null;
    this.sharedMotions = opts.sharedMotions ?? null;
    this.bridge = bridge;
    this.onStateChange = opts.onStateChange ?? null;
    // 没传 viewCamera 就是"不接管相机"，此时控制器存在但 attach 恒为 false
    this.playCamera =
      opts.viewCamera === undefined
        ? null
        : new PlayCameraController(opts.viewCamera);
    this.worldPosOf = opts.worldPosOf ?? null;
    this.session = new PlaySession({
      seed: opts.seed ?? 1,
      capacity: opts.capacity ?? 512,
      ...(opts.executor !== undefined ? { executor: opts.executor } : {}),
    });
  }

  get state(): PlayState {
    return this.session.state;
  }

  /** 是否处于 Play 模式（含暂停）。Play 中要禁掉会改变物体数的编辑操作 */
  get isPlaying(): boolean {
    return this.session.state !== 'stopped';
  }

  get isPaused(): boolean {
    return this.session.state === 'paused';
  }

  get tick(): number {
    return this.session.tick;
  }

  /** 最近一次启动失败的原因；null = 没有失败 */
  get error(): string | null {
    return this.lastError;
  }

  get diagnostics() {
    return this.session.diagnostics;
  }

  /** 运行期诊断（容量不足整批拒绝等）。装载期诊断在 `diagnostics`，两者语义不同 */
  get runtimeDiagnostics() {
    return this.session.runtimeDiagnostics;
  }

  /** 资源账目。`pending === 0` = Stop 后无未释放的 Play 期资源 */
  get ledger() {
    return this.session.ledger;
  }

  /**
   * 进入 Play。
   *
   * 失败时**不动作者状态**（快照都还没打），只把原因留在 `error` 里给 UI 显示 ——
   * 装载失败还把场景快照一遍再恢复，是纯粹的自我感动。
   */
  start(): boolean {
    const doc = this.renderer.getDocument();
    if (doc === null) {
      this.lastError = '场景尚未加载，无法进入 Play';
      return false;
    }
    let playerNode: string | null = null;
    try { playerNode = this.playerPresentation?.prepare(doc) ?? null; }
    catch (error) { this.lastError = String(error); return false; }
    const r = this.session.play(doc);
    if (!r.ok) {
      this.lastError = r.errors.length > 0 ? r.errors.join('；') : '场景装载失败';
      return false;
    }
    // 快照必须在装载成功之后：装载失败不该动作者状态
    this.snap = this.renderer.snapshotAuthorState();
    for (const node of doc.nodes) {
      if (!node.components.some(c => c.kind === 'MeshRenderer' &&
        (c.editorOnly === true || (node.id === doc.playerStart && playerNode === null)))) continue;
      const index = this.renderer.findObjectIndexByNodeId(node.id);
      if (index !== null) this.renderer.setObjectVisible(index, false);
    }

    // Play 相机（ADR-018 P6）。相机不在 AuthorSnapshot 里，所以必须自己存/还原：
    // attach 内部先存编辑相机再切游戏相机，顺序反了就还原不回去。
    if (this.playCamera !== null && this.worldPosOf !== null) {
      const took = this.playCamera.attach(doc, this.worldPosOf);
      if (took) {
        // 🔴 登记顺序 = 释放顺序，勿随意调整。
        // 相机登记在 bridge-batches（下面）**之前**，是为了保证 Stop 时先还原相机、
        // 再摘 Bridge —— 反序会闪一下"关卡回到编辑态但视角还在游戏里"的鬼影。
        // stop() 里另有一句显式 detach 作为第一重保险；两重都在，去掉任一重仍成立，
        // 但**不要两重都去**。
        this.session.registerResource('play-camera', () => this.playCamera?.detach());
      }
    }

    this.bridge.attach(this.session.runtime);
    this.sharedMotions?.start(doc);
    if (this.playerPresentation) this.bridge.setPlayerPresentation(playerNode);
    this.playerPresentation?.sync(this.session.runtime?.player() ?? null);
    this.sharedMotions?.sync(this.session.runtime);
    // Play 期分配的句柄必须进 PlaySession 的账目（AGENTS.md §2.4），
    // 否则"Stop 后无残留"只能靠人眼观察 —— 项目正是这么踩过泄漏坑的。
    this.session.registerResource('bridge-batches', () => this.bridge.attach(null));
    // 🔴 渲染侧的动态实例资源也要进账目：只摘 CPU 侧 bridge 的话，账目显示 pending = 0
    // 而 GPU 上仍留着 Play 期分配的实例 buffer 与代理网格缓存（由 renderer-core 持有）。
    // 见 PR #3 review / AGENTS.md §2.4「Play 期每次 GPU 分配都必须登记并在 Stop 释放」。
    this.session.registerResource('dynamic-instances', () => this.renderer.core.releaseDynamicResources());
    this.lastError = null;
    this.notify();
    return true;
  }

  pause(): void {
    this.session.pause();
    this.notify();
  }

  resume(): void {
    this.session.resume();
    this.notify();
  }

  togglePause(): void {
    if (this.session.state === 'playing') this.pause();
    else if (this.session.state === 'paused') this.resume();
  }

  /** 单步。只在暂停下有效（语义由 PlaySession 保证） */
  step(): void {
    this.session.stepOnce();
    this.sharedMotions?.sync(this.session.runtime);
    this.playerPresentation?.sync(this.session.runtime?.player() ?? null);
    this.syncPlayCamera();
    this.bridge.refresh();
    this.notify();
  }

  /** 同种子重跑 */
  reset(): void {
    this.session.reset();
    this.sharedMotions?.sync(this.session.runtime);
    this.playerPresentation?.sync(this.session.runtime?.player() ?? null);
    this.syncPlayCamera();
    this.bridge.refresh();
    this.notify();
  }

  /**
   * 退出 Play 并恢复作者状态。
   *
   * 顺序很关键：**先恢复场景，再断会话**。反过来做的话，恢复期间画面上还挂着
   * 上一帧的动态实例，会闪一下"僵尸还在但关卡回到编辑态"的鬼影。
   */
  stop(): void {
    this.sharedMotions?.stop();
    this.playerPresentation?.detach();
    if (this.snap !== null) {
      const res = this.renderer.restoreAuthorState(this.snap);
      if (res.mismatched) {
        console.warn(
          `[play] Stop 时物体数与快照不一致（快照 ${this.snap.count}，当前 ${res.restored} 起），` +
            'Play 期间发生过增删 —— 已按索引逐个恢复，请检查是否张冠李戴',
        );
      }
      this.snap = null;
    }
    // 先还原相机，再断会话：反过来做的话，恢复期间画面还挂着游戏机位，
    // 会闪一下"关卡回到编辑态但视角还在游戏里"的鬼影。
    this.playCamera?.detach();
    this.session.stop();
    this.bridge.attach(null);
    this.notify();
  }

  /** 每帧调用：推进固定步 → 同步实例数据 → 跟随相机。返回本帧走的步数 */
  update(dt: number): number {
    const n = this.session.advance(dt);
    if (n > 0) {
      this.sharedMotions?.sync(this.session.runtime);
      this.playerPresentation?.sync(this.session.runtime?.player() ?? null);
      this.bridge.refresh();
      this.syncPlayCamera();
    }
    return n;
  }

  /**
   * 让游戏相机跟随玩家（仅 orbit-follow 模式生效）。
   *
   * 玩家位置取自**运行时实体**而不是场景节点——场景里的节点是静态的，
   * 只有玩家实体会在 Play 中移动。取不到玩家（还没生成/已死亡）就传 null，
   * 相机保持上一次的位置，不抖动。
   */
  private syncPlayCamera(): void {
    if (this.playCamera === null || !this.playCamera.active) return;
    const rt = this.session.runtime;
    if (rt === null) {
      this.playCamera.update(null);
      return;
    }
    // O(1) 取玩家（旧实现是 view().find() —— 每帧全表扫 + 建整个数组）
    const p = rt.player();
    this.playCamera.update(p === null ? null : { x: p.x, z: p.z, yaw: p.yaw });
  }

  private notify(): void {
    this.onStateChange?.();
  }
}
