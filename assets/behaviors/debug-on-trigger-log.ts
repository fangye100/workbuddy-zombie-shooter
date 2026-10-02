/**
 * 示例行为（ADR-018 P1 建目录 / P3 首次真执行）。
 *
 * 🔴 诚实声明：本行为**只在 Play 中每个 tick 打一条日志**，不含波次/战斗语义。
 * 波次推进在 P5 实现，届时会有真正的 `spawn-wave`。这里不摆一个"看起来是波次
 * 实际什么都不做"的空壳——那是本项目最忌讳的假象（docs/19：「明确未做，不是
 * 看起来像做了」）。
 *
 * 它的作用是让「目录 → schema → 注册 → 执行」链路有一条端到端验证对象：
 * - P1/P2：`packages/scene/test/behavior-assets.test.ts` 用 glob 收集并断言可注册、可 resolve
 * - P3：`packages/runtime/test/behavior-exec.test.ts` 注入执行器后断言它**真的被执行**
 *
 * ## ctx 从哪来
 *
 * runtime 每个固定步传入 `BehaviorContext`（见 `packages/runtime/src/behavior-executor.ts`）：
 * `{ tick, runId, log(message) }`。行为**不要**直接 `console.log`——那会污染宿主日志、
 * 在 CLI 与浏览器里表现不一致、也没法被测试断言。
 */

import { defineBehavior } from '@aether/scene';

/** 本行为需要的上下文子集（与 BehaviorContext 兼容） */
interface DebugCtx {
  tick: number;
  log(message: string): void;
}

export default defineBehavior<DebugCtx>({
  id: 'debug-on-trigger-log',
  label: '调试：每 tick 记录',
  category: 'debug',
  params: [
    { key: 'message', label: '记录内容', kind: 'string', default: 'triggered' },
    { key: 'maxTick', label: '记录到第几 tick 为止', kind: 'int', default: 3, min: 1, max: 600 },
    { key: 'enabled', label: '启用', kind: 'bool', default: true },
    { key: 'tag', label: '标记', kind: 'enum', default: 'info', options: ['info', 'warn'] },
  ],
  run(ctx, params) {
    if (params.enabled !== true) return;
    // 只在开头若干个 tick 记录：不设限的话长时间跑会把日志刷满（runtime 侧虽有
    // 200 条封顶，但那是兜底，不该指望它）。
    if (ctx.tick > Number(params.maxTick)) return;
    ctx.log(`[${String(params.tag)}] ${String(params.message)}`);
  },
});
