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
 * 相机按 A 方案：**不引入游戏相机，编辑相机在 Play 中照常自由移动**。
 * docs/17 要求的是「检查视角可以自由移动，不能反向改变玩家状态」——
 * 编辑相机写的是 `camera` 对象，玩家位置在 RuntimeSession 的实体表里，两条路径
 * 本来就互不干涉，加一个游戏相机反而会让"改之前/改之后"没法同机位对比。
 */

import { PlaySession, type PlayState } from '@aether/runtime';
import type { RuntimeBridge } from './runtime-bridge';
import type { AuthorSnapshot, LabRenderer } from '../renderer';

export interface PlayControllerOptions {
  seed?: number;
  capacity?: number;
  /** 状态变化时回调（UI 据此刷新按钮与面板） */
  onStateChange?: () => void;
}

export class PlayController {
  readonly session: PlaySession;
  private readonly bridge: RuntimeBridge;
  private readonly renderer: LabRenderer;
  private readonly onStateChange: (() => void) | null;
  private snap: AuthorSnapshot | null = null;
  private lastError: string | null = null;

  constructor(renderer: LabRenderer, bridge: RuntimeBridge, opts: PlayControllerOptions = {}) {
    this.renderer = renderer;
    this.bridge = bridge;
    this.onStateChange = opts.onStateChange ?? null;
    this.session = new PlaySession({ seed: opts.seed ?? 1, capacity: opts.capacity ?? 512 });
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
    const r = this.session.play(doc);
    if (!r.ok) {
      this.lastError = r.errors.length > 0 ? r.errors.join('；') : '场景装载失败';
      return false;
    }
    // 快照必须在装载成功之后：装载失败不该动作者状态
    this.snap = this.renderer.snapshotAuthorState();
    this.bridge.attach(this.session.runtime);
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
    this.bridge.refresh();
    this.notify();
  }

  /** 同种子重跑 */
  reset(): void {
    this.session.reset();
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
    this.session.stop();
    this.bridge.attach(null);
    this.notify();
  }

  /** 每帧调用：推进固定步 → 同步实例数据。返回本帧走的步数 */
  update(dt: number): number {
    const n = this.session.advance(dt);
    if (n > 0) this.bridge.refresh();
    return n;
  }

  private notify(): void {
    this.onStateChange?.();
  }
}
