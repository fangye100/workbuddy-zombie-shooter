/**
 * 编辑器侧行为收集（ADR-018 P2 的宿主责任）。
 *
 * ## 为什么这个文件存在
 *
 * `packages/scene` 的 `BehaviorRegistry` **刻意不 import 任何行为代码**
 * （ADR-018 R3：runtime 保持纯 CPU，scene 也不该反向依赖宿主）。
 * 那么「去哪儿把 `assets/behaviors/*.ts` 捡进来」就是宿主的责任——本文件负责这件事。
 *
 * ## 唯一 owner
 *
 * 全编辑器**只有这一个实例**（ADR-018 / docs/17 §3.5：每类运行状态只能有一个
 * 权威 owner）。P3 时由它把执行器注入 runtime；Inspector 也从它取 schema 画控件。
 * 不允许别处再 `new BehaviorRegistry()`。
 *
 * ## 收集方式
 *
 * Vite 的 `import.meta.glob` + `eager: true`：构建期就把行为模块内联进来。
 * 用 `**` 而不是 `*`，将来行为放进子目录也能收到。
 *
 * 🔴 收集失败**不抛异常**：一个坏行为只进 `rejected`，其余照常可用
 * （与 ADR-017「一个挂掉的行为不该让整个场景打不开」同一精神）。
 * 编辑器启动不该因为某个 Agent 写错文件就白屏。
 */

import { BehaviorRegistry, type BehaviorModule } from '@aether/scene';
import type { BehaviorContext, BehaviorExecutor, ScriptDesc } from '@aether/runtime';

const modules = import.meta.glob('/assets/behaviors/**/*.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

/** 从 glob 结果里取出 BehaviorModule（兼容 default 导出与命名导出） */
function pickModule(path: string, mod: Record<string, unknown>): BehaviorModule<unknown> | null {
  const candidates = [mod.default, ...Object.values(mod)];
  const hit = candidates.find(
    (c): c is BehaviorModule<unknown> =>
      c !== null &&
      typeof c === 'object' &&
      typeof (c as { id?: unknown }).id === 'string' &&
      Array.isArray((c as { params?: unknown }).params) &&
      typeof (c as { run?: unknown }).run === 'function',
  );
  if (hit === undefined) {
    console.warn(`[behavior] ${path} 未导出合法的 BehaviorModule（缺 id / params / run），已跳过`);
    return null;
  }
  return hit;
}

export const behaviorRegistry = new BehaviorRegistry();

const collected: BehaviorModule<unknown>[] = [];
for (const [path, mod] of Object.entries(modules)) {
  const m = pickModule(path, mod);
  if (m !== null) collected.push(m);
}

/** 收集结果：注册成功的 id 列表与被拒绝的诊断（供 UI / 诊断面板显示） */
export const behaviorCollectResult = behaviorRegistry.registerAll(collected);

if (behaviorCollectResult.rejected.length > 0) {
  console.warn(
    `[behavior] ${behaviorCollectResult.rejected.length} 个行为注册失败：`,
    behaviorCollectResult.rejected.map((d) => `${d.behaviorId} — ${d.message}`),
  );
}

/** schema 自身有问题的行为（注册期发现，Agent 写完立刻可见） */
export function behaviorSchemaIssues() {
  return behaviorRegistry.schemaDiagnostics;
}

/**
 * 创建行为执行器，交给 runtime 注入（ADR-018 P3 的注入端）。
 *
 * ## 为什么执行器长在宿主侧
 *
 * runtime 只声明端口（`BehaviorExecutor`），不 import 任何行为代码——否则 CLI 宿主
 * 解析不到那些模块，`verify:parity-host` 的 Node↔浏览器一致性立刻断。
 * 执行器持有 registry，是唯一知道"行为代码在哪"的地方。
 *
 * ## 失效语义
 *
 * 行为未注册 → 返回 false（runtime 会记 W_BEHAVIOR_UNAVAILABLE 并降级，不阻塞）。
 * 行为内部抛异常 → 捕获并返回 false：内容层是 Agent 自由创作区，
 * 一个写错的行为不该让整个 Play 崩掉（runtime 侧另有一层兜底，这里先兜）。
 */
export function createBehaviorExecutor(): BehaviorExecutor {
  return {
    run(script: ScriptDesc, ctx: BehaviorContext): boolean {
      const r = behaviorRegistry.resolve(script.behavior, script.params);
      if (r.def === null) return false;
      // 参数被 schema 修正过（缺失补默认、越界钳制）——作者应当知道
      if (r.diagnostics.length > 0) {
        console.warn(
          `[behavior] 脚本「${script.behavior}」参数已按 schema 修正：`,
          r.diagnostics.map((d) => d.message),
        );
      }
      try {
        r.def.run(ctx, r.params);
        return true;
      } catch (e) {
        console.warn(
          `[behavior] 脚本「${script.behavior}」执行时抛出异常，本轮跳过：`,
          e instanceof Error ? e.message : String(e),
        );
        return false;
      }
    },
  };
}
