import { loadLevelRuntime, type LoadDiagnostic } from './loader';
import { createSession } from './session';
import type { RuntimeSession, EntityView, RuntimeDiagnostic } from './session';
import type { SceneDocument } from '@aether/scene';

/**
 * PlaySession —— 运行状态的**唯一权威**（WU-4）。
 *
 * 为什么它必须在 runtime 包里、而不是编辑器里（docs/17 §3 "编辑器入口只装配服务
 * 与按钮"）：运行状态一旦散在 UI 代码里，就会出现「按钮显示暂停但循环还在推进」
 * 这类只有实机才复现的鬼故事。状态机是纯 CPU 的、可测的，就该放可测的地方。
 *
 * 与 `RuntimeSession` 的分工：
 *   - `RuntimeSession` = **世界**（实体、寻路、触发），不知道自己被播放还是被单步；
 *   - `PlaySession`     = **播放控制**（状态、时钟、生命周期），不产玩法。
 *
 * 固定步语义：**渲染帧率不决定游戏步数**。`advance(dt)` 只把真实时间累加进
 * 累加器，够一个 step 就走一步；浏览器卡顿后一帧只补 `maxCatchUpSteps` 步，
 * 宁可慢放也不瞬移（docs/17 §7 失败矩阵：「暂停后继续或浏览器卡顿 → 不补算
 * 暂停墙钟；追赶策略受控」）。
 */

export type PlayState = 'stopped' | 'playing' | 'paused';

export interface PlaySessionOptions {
  seed?: number;
  fixedStep?: number;
  /** 实体容量上限；超过则整批拒绝（原子性） */
  capacity?: number;
  /** 单帧最多补几步。默认 5 —— 卡顿后补几百步等于瞬移，宁可慢放 */
  maxCatchUpSteps?: number;
}

export interface PlayResult {
  ok: boolean;
  diagnostics: LoadDiagnostic[];
  /** 装载期 error 的中文摘要；空数组 = 可以跑 */
  errors: string[];
}

/** 一项已登记的 Play 期资源 */
export interface PlayResource {
  label: string;
  dispose: () => void;
}

/**
 * 资源账目。
 *
 * AGENTS.md §2.4 明文：**Play 期的每一次资源分配都必须登记进 PlaySession，
 * Stop 时逐个释放**。这条规则是拿"只打墓碑不释放"的泄漏坑换来的，所以账目本身
 * 必须是可查询、可断言的 —— 否则"账目平衡"又变成一句无法证伪的口号。
 */
export interface ResourceLedger {
  /** 本次（及历次）累计登记数 */
  registered: number;
  /** 累计已释放数 */
  disposed: number;
  /** 当前仍未释放数。Stop 之后必须为 0 */
  pending: number;
}

export class PlaySession {
  private session: RuntimeSession | null = null;
  private _state: PlayState = 'stopped';
  private accumulator = 0;
  private diag: LoadDiagnostic[] = [];
  private errs: string[] = [];

  readonly seed: number;
  readonly fixedStep: number;
  readonly capacity: number;
  readonly maxCatchUpSteps: number;

  /** 启停次数。资源账目平衡断言用它（浏览器侧配 draw call / 实例数回落） */
  private cycles = 0;

  /** Play 期登记的资源。Stop 时逐个释放 —— 见 AGENTS.md §2.4 */
  private resources: PlayResource[] = [];
  private registeredCount = 0;
  private disposedCount = 0;

  constructor(opts: PlaySessionOptions = {}) {
    this.seed = opts.seed ?? 1;
    this.fixedStep = opts.fixedStep ?? 1 / 30;
    this.capacity = opts.capacity ?? 512;
    this.maxCatchUpSteps = opts.maxCatchUpSteps ?? 5;
  }

  get state(): PlayState {
    return this._state;
  }

  get running(): boolean {
    return this.session !== null;
  }

  get cycleCount(): number {
    return this.cycles;
  }

  /**
   * 登记一项 Play 期资源，Stop 时自动释放。
   *
   * runtime 侧自己不碰 GPU（依赖方向禁止），但**宿主**在 Play 期分配的句柄
   * （Bridge 批次、临时代理网格、临时 buffer）必须在这里挂号，否则"Stop 后无残留"
   * 只能靠人眼观察。重复登记同一 label 不会覆盖，逐条释放。
   */
  registerResource(label: string, dispose: () => void): void {
    this.resources.push({ label, dispose });
    this.registeredCount++;
  }

  /** 资源账目。`pending === 0` 是「Stop 后无残留」的可断言判据 */
  get ledger(): ResourceLedger {
    return {
      registered: this.registeredCount,
      disposed: this.disposedCount,
      pending: this.resources.length,
    };
  }

  /** 运行期诊断（容量拒绝等）。与 `diagnostics`（装载期）语义不同，别混用 */
  get runtimeDiagnostics(): readonly RuntimeDiagnostic[] {
    return this.session?.diagnostics() ?? [];
  }

  /** 当前世界；stopped 时为 null。调用方不得长期持有 —— 每次 play 都是新对象 */
  get runtime(): RuntimeSession | null {
    return this.session;
  }

  get diagnostics(): LoadDiagnostic[] {
    return this.diag;
  }

  get errors(): string[] {
    return this.errs;
  }

  get tick(): number {
    return this.session?.tick ?? 0;
  }

  get entities(): EntityView[] {
    return this.session?.view() ?? [];
  }

  /**
   * 装载并开跑。
   *
   * 装载失败时**不建会话、不动状态**（`docs/17 §7`：不创建半运行世界），
   * 失败细节走 `diagnostics` / `errors` 由调用方显示 —— 静默跑一个残缺世界，
   * 比明确告诉用户「这份场景还跑不起来」糟糕得多。
   */
  play(doc: SceneDocument): PlayResult {
    const loaded = loadLevelRuntime(doc);
    this.diag = loaded.diagnostics;
    this.errs = loaded.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);

    if (loaded.desc === null || this.errs.length > 0) {
      // 启动失败清理：确保一个残留的旧会话都不会留下
      this.session = null;
      this._state = 'stopped';
      this.accumulator = 0;
      return { ok: false, diagnostics: this.diag, errors: this.errs };
    }

    this.session = createSession(loaded.desc, {
      seed: this.seed,
      capacity: this.capacity,
      fixedStep: this.fixedStep,
    });
    this._state = 'playing';
    this.accumulator = 0;
    this.cycles++;
    return { ok: true, diagnostics: this.diag, errors: [] };
  }

  pause(): void {
    if (this._state !== 'playing') return;
    this._state = 'paused';
    // 丢弃已累积的时间：暂停 10 秒后恢复不该瞬间补 300 步
    this.accumulator = 0;
  }

  resume(): void {
    if (this._state !== 'paused') return;
    this._state = 'playing';
    this.accumulator = 0;
  }

  /** 单步。只在 paused 下生效 —— playing 时"再走一步"没有意义，静默忽略 */
  stepOnce(): void {
    if (this._state !== 'paused' || this.session === null) return;
    this.session.step();
  }

  /** 同种子重跑。stopped 时无世界可重置，静默忽略 */
  reset(): void {
    if (this.session === null) return;
    this.session.reset();
    this.accumulator = 0;
    // Reset 的语义是"回到初始态继续跑"，不是"停在原地"——保持当前播放状态
  }

  /**
   * 停止并释放。
   *
   * 顺序：**先逐个释放登记的资源，再断开世界引用**。反过来做的话，释放回调里
   * 还想读一次运行时状态就会拿到 null。
   *
   * runtime 侧自身不持有 GPU 句柄（依赖方向禁止），所以这里释放的是**宿主登记进来**的
   * 那些（Bridge 批次等）；动态实例 buffer 由渲染核心持有、按 meshId 缓存跨 Play 复用，
   * 不随单次 Stop 销毁（见 docs/19 §6）。
   */
  stop(): void {
    for (const r of this.resources) {
      try {
        r.dispose();
        this.disposedCount++;
      } catch (e) {
        // 一个释放失败不能挡住其余的，也不能挡住"停止"本身
        console.warn(`[play] 释放资源 ${r.label} 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.resources.length = 0;
    this.session = null;
    this._state = 'stopped';
    this.accumulator = 0;
  }

  /**
   * 按真实时间推进固定步，返回本帧实际走的步数。只在 playing 下有效。
   *
   * 单帧最多 `maxCatchUpSteps` 步；超出部分**丢弃**而不是攒着 —— 攒着会让
   * 下一次卡顿后的追赶更凶，最终变成"卡一下然后快进"。
   */
  advance(dt: number): number {
    if (this._state !== 'playing' || this.session === null) return 0;
    if (!(dt > 0)) return 0; // NaN / 负数 / 0 一律不推进，别把坏 dt 喂给累加器

    const step = this.fixedStep;
    this.accumulator += dt;
    let n = 0;
    while (this.accumulator >= step && n < this.maxCatchUpSteps) {
      this.session.step();
      this.accumulator -= step;
      n++;
    }
    // 追赶上限用尽：剩下的时间直接丢掉，避免下帧补得更凶
    if (this.accumulator > step * this.maxCatchUpSteps) this.accumulator = 0;
    return n;
  }
}
