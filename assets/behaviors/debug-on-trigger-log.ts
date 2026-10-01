/**
 * 示例行为（ADR-018 P1 的目录占位 + 链路验证）。
 *
 * 🔴 诚实声明：本行为**只做"每次被触发时记一条日志"**，不含波次/战斗语义。
 * 波次推进在 P5 实现，届时会有真正的 `spawn-wave`。这里不摆一个"看起来是波次
 * 实际什么都不做"的空壳——那是本项目最忌讳的假象（docs/19：「明确未做，不是
 * 看起来像做了」）。
 *
 * 它的作用是让 P1 的目录、schema、注册链路有一条真实的端到端验证对象。
 */

import { defineBehavior } from '@aether/scene';

/** 最小执行上下文。P3 接线后 runtime 会提供更完整的视图，此处只取需要的字段 */
interface DebugCtx {
  log: string[];
}

export default defineBehavior<DebugCtx>({
  id: 'debug-on-trigger-log',
  label: '调试：触发时记录',
  category: 'debug',
  params: [
    { key: 'message', label: '记录内容', kind: 'string', default: 'triggered' },
    { key: 'maxCount', label: '最多记录条数', kind: 'int', default: 5, min: 1, max: 100 },
    { key: 'enabled', label: '启用', kind: 'bool', default: true },
    { key: 'tag', label: '标记', kind: 'enum', default: 'info', options: ['info', 'warn'] },
  ],
  run(ctx, params) {
    if (params.enabled !== true) return;
    if (ctx.log.length >= Number(params.maxCount)) return;
    ctx.log.push(`[${String(params.tag)}] ${String(params.message)}`);
  },
});
