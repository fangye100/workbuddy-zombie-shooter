import { loadLevelRuntime, type LoadDiagnostic } from './loader';
import { createSession } from './session';
import type { RuntimeSession, EntityView } from './session';
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
   * runtime 侧没有 GPU 资源，释放 = 断开引用让整棵世界可回收；GPU 侧的
   * 动态实例 buffer 由渲染核心持有，Bridge 不再产出批次即自然不画。
   */
  stop(): void {
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
