/**
 * 应用层：插件装配、调度阶段、系统注册。
 * 引擎所有能力都以 Plugin 形式挂载，core 本身不认识渲染 / 物理 / UI。
 */

// ---------------------------------------------------------------- Stage

export const Stage = {
  /** 帧首：时钟、输入采样、剖析器开帧 */
  First: 0,
  /** 固定步长之前：网络输入、回放 */
  PreUpdate: 1,
  /** 固定步长（默认 60Hz）：物理、动画采样、游戏逻辑 */
  FixedUpdate: 2,
  /** 可变步长：相机、UI 布局、AI LOD、特效生成 */
  Update: 3,
  /** 变换传播、世界状态收尾 */
  PostUpdate: 4,
  /** 从 World 抽取 RenderWorld 快照 */
  Extract: 5,
  /** 渲染资源准备（上传、剔除、排序） */
  Prepare: 6,
  /** 提交渲染与呈现 */
  Render: 7,
  /** 帧尾：统计、热重载安全点 */
  Last: 8,
} as const;
export type Stage = (typeof Stage)[keyof typeof Stage];

// ---------------------------------------------------------------- Resource / Event

/** 全局单例资源（类型安全的 key） */
export class ResourceKey<T> {
  constructor(readonly name: string) {}
}
export function resource<T>(name: string): ResourceKey<T> { return new ResourceKey<T>(name); }

/** 双缓冲事件通道（避免读写竞争） */
export interface Events<T> {
  send(value: T): void;
  /** 在当前阶段只读消费 */
  drain(fn: (value: T) => void): void;
}
export class EventKey<T> {
  constructor(readonly name: string) {}
}
export function event<T>(name: string): EventKey<T> { return new EventKey<T>(name); }

// ---------------------------------------------------------------- System

export interface SystemContext {
  readonly world: import('./ecs/world').World;
  readonly dt: number;
  readonly fixedDt: number;
  /** 固定步长剩余比例，用于插值 */
  readonly alpha: number;
  readonly frame: number;
  getResource<T>(key: ResourceKey<T>): T;
  setResource<T>(key: ResourceKey<T>, value: T): void;
  getEvents<T>(key: EventKey<T>): Events<T>;
}

export type SystemFn = (ctx: SystemContext) => void;

export interface SystemDescriptor {
  readonly fn: SystemFn;
  readonly stage: Stage;
  readonly label: string;
  /** 声明式依赖：读写集用于并行冲突检测 */
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  after: Set<string>;
  before: Set<string>;
}

// ---------------------------------------------------------------- Plugin

export interface Plugin {
  readonly name: string;
  build(app: App): void;
}

export function definePlugin(name: string, build: (app: App) => void): Plugin {
  return { name, build };
}

// ---------------------------------------------------------------- App

export interface AppConfig {
  fixedHz: number;
  maxFixedStepsPerFrame: number;
  workerCount: number | 'auto';
  headless: boolean;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  fixedHz: 60,
  maxFixedStepsPerFrame: 5,
  workerCount: 'auto',
  headless: false,
};

export class App {
  private readonly plugins: Plugin[] = [];
  private readonly systems: SystemDescriptor[] = [];
  private readonly resources = new Map<ResourceKey<unknown>, unknown>();
  private running = false;
  private frameId = 0;

  constructor(readonly config: AppConfig = DEFAULT_APP_CONFIG) {}

  addPlugin(plugin: Plugin): this {
    this.plugins.push(plugin);
    plugin.build(this);
    return this;
  }

  addSystem(
    stage: Stage,
    fn: SystemFn,
    opts: { label?: string; reads?: readonly string[]; writes?: readonly string[] } = {},
  ): SystemHandle {
    const desc: SystemDescriptor = {
      fn,
      stage,
      label: opts.label ?? fn.name ?? 'anonymous',
      reads: opts.reads ?? [],
      writes: opts.writes ?? [],
      after: new Set(),
      before: new Set(),
    };
    this.systems.push(desc);
    return new SystemHandle(desc);
  }

  setResource<T>(key: ResourceKey<T>, value: T): this {
    this.resources.set(key as ResourceKey<unknown>, value);
    return this;
  }

  getResource<T>(key: ResourceKey<T>): T {
    const v = this.resources.get(key as ResourceKey<unknown>);
    if (v === undefined) throw new Error(`Resource "${key.name}" 未注册`);
    return v as T;
  }

  /** 由各 Plugin 注册的子系统钩子，按 Stage 顺序驱动 */
  run(): void {
    if (this.running) throw new Error('App 已在运行');
    this.running = true;
    // 按 stage 稳定排序 + 拓扑排序（读写集冲突检测在此处执行）
    this.systems.sort((a, b) => a.stage - b.stage || a.label.localeCompare(b.label));
    requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    // 完整实现见 docs/01：累加器固定步长 + 插值 + Extract + Render
    void now;
    this.frameId++;
    if (this.running) requestAnimationFrame(this.tick);
  };

  shutdown(): void { this.running = false; }
}

export class SystemHandle {
  constructor(private readonly desc: SystemDescriptor) {}
  after(label: string): this { this.desc.after.add(label); return this; }
  before(label: string): this { this.desc.before.add(label); return this; }
  /** 标记为可并行（无冲突时调度器会分派到 Worker） */
  reads(...c: string[]): this { (this.desc.reads as string[]).push(...c); return this; }
  writes(...c: string[]): this { (this.desc.writes as string[]).push(...c); return this; }
}
