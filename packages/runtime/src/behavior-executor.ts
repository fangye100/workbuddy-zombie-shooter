/**
 * 行为执行器**端口**（ADR-018 P3，R3：runtime 不 import 行为代码）。
 *
 * ## 为什么是端口而不是直接 import
 *
 * `packages/runtime` 必须保持**纯 CPU / headless / 可在 CLI 与 vitest 里跑**，
 * 这是 `verify:parity-host`（Node ↔ 浏览器逐实体一致）成立的前提。
 * 行为代码住在 `assets/behaviors/*.ts`，由浏览器宿主（`import.meta.glob`）收集。
 * 若 runtime 直接 import 它们：
 *   - CLI 宿主解析不到那些模块 → parity 立刻断；
 *   - 行为代码可能碰 DOM / GPU → 违反 docs/17 §3.5 的 headless 解耦要求。
 *
 * 所以 runtime 只声明「我需要一个能执行行为的东西」，由宿主注入实现。
 *
 * ## 代次语义
 *
 * 行为注册表在**装载期冻结**（本轮 Play 内行为代码不可变；改代码要 Stop 后重跑）。
 * 执行器实例与 `runId` 对齐——跨代引用一律失效并由宿主显式告知。
 */

import type { BehaviorScalar } from '@aether/scene';

/**
 * 行为执行上下文。runtime 侧能给出的最小信息集。
 *
 * 刻意只放**与玩法无关**的通用量：行为不该反向依赖 runtime 的内部结构，
 * 也不能拿到实体表的写权限（否则"运行时中心"就守不住了）。
 */
export interface BehaviorContext {
  /** 当前 tick（固定步计数，不是墙钟） */
  tick: number;
  /** 本次会话的 runId（代次标识，跨代失效判据） */
  runId: number;
  /**
   * 行为输出通道。**行为不该直接 `console.log`**：
   * 那会污染宿主日志、在 CLI 与浏览器里表现不一致、且没法被测试断言。
   * 走这里由 runtime 收集，可查询、可复现。
   */
  log(message: string): void;
}

/** 一条行为日志（供 UI / 测试查询，不落盘） */
export interface BehaviorLogEntry {
  tick: number;
  nodeId: string;
  behavior: string;
  message: string;
}

/** 单个待执行脚本（由 loader 从场景节点的 Script 组件收集而来） */
export interface ScriptDesc {
  /** 来源场景节点（诊断与"选中后定位到节点"都靠它） */
  nodeId: string;
  behavior: string;
  params: Readonly<Record<string, BehaviorScalar>>;
}

/**
 * 行为执行器。宿主注入，runtime 只调 `run`。
 *
 * `run` 返回 **false = 行为未注册/不可用**，调用方应记 diagnostic 而不是抛异常
 * （ADR-017：一个挂掉的行为不该让整个场景打不开）。
 */
export interface BehaviorExecutor {
  run(
    script: ScriptDesc,
    ctx: BehaviorContext,
  ): boolean;
}

/**
 * 空执行器（CLI / 单测默认）。**全部返回 false**，让调用方走降级路径。
 *
 * 存在的意义是让"没注入执行器"这件事显式可见：与其静默什么都不做，
 * 不如让每个脚本都产出一条未注册诊断。
 */
export const NULL_BEHAVIOR_EXECUTOR: BehaviorExecutor = {
  run: () => false,
};
