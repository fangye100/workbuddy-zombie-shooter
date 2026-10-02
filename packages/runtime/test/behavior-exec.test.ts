/**
 * 行为执行接线测试（ADR-018 P3）。
 *
 * 核心要证明的不是「loader 能收集 Script 组件」，而是：
 * **注入执行器之后，场景里的脚本在 step() 中真的被执行了**——
 * 有可观测输出（ctx.log 落到 session.behaviorLog），而不是静默什么都不做。
 *
 * 端到端链路：真实场景 floor-1 + 真实行为文件 assets/behaviors/*.ts。
 */

import { describe, expect, it } from 'vitest';
import { loadLevelRuntime } from '../src/loader';
import { RuntimeSession } from '../src/session';
import type { BehaviorExecutor, ScriptDesc } from '../src/behavior-executor';
import { BehaviorRegistry, type BehaviorModule } from '@aether/scene';
import type { SceneDocument } from '@aether/scene';

const SCENE = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });
const BEHAVIORS = import.meta.glob('/assets/behaviors/**/*.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

function floor1(): SceneDocument {
  const key = Object.keys(SCENE)[0]!;
  return JSON.parse(JSON.stringify((SCENE[key] as { default: unknown }).default)) as SceneDocument;
}

/**
 * 清空场景自带的 Script 组件后的副本。
 *
 * floor-1 本身挂了一个演示脚本（让真机 Play 有东西可看），但多数用例需要
 * **精确控制**脚本集合，否则断言会随场景内容漂移（场景加一个脚本，一堆用例就红）。
 */
function floor1Clean(): SceneDocument {
  const doc = floor1();
  for (const n of doc.nodes) {
    n.components = n.components.filter((c) => c.kind !== 'Script');
  }
  return doc;
}

/** 收集真实行为文件并注册（与编辑器侧 behavior-host.ts 同一套做法） */
function realRegistry(): BehaviorRegistry {
  const reg = new BehaviorRegistry();
  const mods: BehaviorModule<unknown>[] = [];
  for (const mod of Object.values(BEHAVIORS)) {
    const hit = [mod.default, ...Object.values(mod)].find(
      (c): c is BehaviorModule<unknown> =>
        c !== null &&
        typeof c === 'object' &&
        typeof (c as { id?: unknown }).id === 'string' &&
        Array.isArray((c as { params?: unknown }).params) &&
        typeof (c as { run?: unknown }).run === 'function',
    );
    if (hit !== undefined) mods.push(hit);
  }
  const res = reg.registerAll(mods);
  expect(res.rejected).toEqual([]);
  return reg;
}

/** 真实执行器：registry.resolve → run，异常一律降级为 false（不让坏行为炸掉运行时） */
function realExecutor(reg: BehaviorRegistry): BehaviorExecutor {
  return {
    run(script: ScriptDesc, ctx) {
      const r = reg.resolve(script.behavior, script.params);
      if (r.def === null) return false;
      try {
        r.def.run(ctx, r.params);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 给场景某个节点挂一个 Script 组件 */
function attachScript(doc: SceneDocument, nodeId: string, behavior: string, params: Record<string, unknown> = {}): void {
  const n = doc.nodes.find((x) => x.id === nodeId);
  if (n === undefined) throw new Error(`夹具缺少节点 ${nodeId}`);
  n.components.push({
    kind: 'Script',
    enabled: true,
    behavior,
    params: params as Record<string, number | string | boolean>,
  } as never);
}

const SCRIPT_NODE = 'nd_f1_start'; // 玩家起点节点，一定存在

describe('loader · 收集场景 Script 组件', () => {
  it('带 Script 组件的节点被收进 desc.scripts，含 nodeId 与 params', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log', { message: 'hello', maxTick: 2 });
    const d = loadLevelRuntime(doc).desc!;
    expect(d.scripts.length).toBe(1);
    expect(d.scripts[0]!.nodeId).toBe(SCRIPT_NODE);
    expect(d.scripts[0]!.behavior).toBe('debug-on-trigger-log');
    expect(d.scripts[0]!.params.message).toBe('hello');
  });

  it('params 被拷贝：改 desc 不污染作者文档', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log', { message: 'orig' });
    const d = loadLevelRuntime(doc).desc!;
    (d.scripts[0]!.params as Record<string, unknown>).message = 'changed';
    const comp = doc.nodes
      .find((x) => x.id === SCRIPT_NODE)!
      .components.find((c) => c.kind === 'Script') as { params: Record<string, unknown> };
    expect(comp.params.message).toBe('orig');
  });

  it('节点被隐藏（visible=false）→ 不收集并报 W_SCRIPT_HIDDEN', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log');
    doc.nodes.find((x) => x.id === SCRIPT_NODE)!.visible = false;
    const r = loadLevelRuntime(doc);
    expect(r.desc!.scripts).toEqual([]);
    expect(r.diagnostics.some((x) => x.code === 'W_SCRIPT_HIDDEN')).toBe(true);
  });

  it('🔴 组件 enabled=false → 不收集并报 W_SCRIPT_DISABLED（PR#16 review）', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log');
    const n = doc.nodes.find((x) => x.id === SCRIPT_NODE)!;
    const sc = n.components.find((c) => c.kind === 'Script') as unknown as { enabled: boolean };
    sc.enabled = false;
    const r = loadLevelRuntime(doc);
    expect(r.desc!.scripts).toEqual([]);
    expect(r.diagnostics.some((x) => x.code === 'W_SCRIPT_DISABLED')).toBe(true);
  });

  it('🔴 祖先隐藏 = 整个子树隐藏（有效可见，PR#16 review）', () => {
    const doc = floor1Clean();
    // 掩体挂在房间 nd_f1r0 下（有父链），脚本挂它身上再藏房间
    attachScript(doc, 'nd_f1r0_cv0', 'debug-on-trigger-log');
    const parent = doc.nodes.find((x) => x.id === 'nd_f1r0');
    expect(parent).toBeDefined();
    parent!.visible = false; // 子自身 visible 保持 true
    const r = loadLevelRuntime(doc);
    expect(r.desc!.scripts).toEqual([]);
    expect(r.diagnostics.some((x) => x.code === 'W_SCRIPT_HIDDEN')).toBe(true);
  });

  it('behavior id 为空 → 忽略并报 W_SCRIPT_EMPTY', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, '   ');
    const r = loadLevelRuntime(doc);
    expect(r.desc!.scripts).toEqual([]);
    expect(r.diagnostics.some((x) => x.code === 'W_SCRIPT_EMPTY')).toBe(true);
  });

  it('没有 Script 组件时 scripts 为空数组（不是 undefined）', () => {
    const d = loadLevelRuntime(floor1Clean()).desc!;
    expect(d.scripts).toEqual([]);
  });

  it('🔴 真实场景 floor-1 自带演示脚本能被收集（真机 Play 有东西可看的前提）', () => {
    const d = loadLevelRuntime(floor1()).desc!;
    expect(d.scripts.length).toBeGreaterThanOrEqual(1);
    const demo = d.scripts.find((s) => s.behavior === 'debug-on-trigger-log');
    expect(demo).toBeDefined();
    // 挂在独立节点（生成器产出 nd_f1_demo_script，无 MeshRenderer 不渲染但被收集）
    expect(demo!.nodeId).toBe('nd_f1_demo_script');
  });
});

describe('RuntimeSession · 脚本真正被执行', () => {
  it('🔴 注入执行器后，step() 会让脚本产生可观测输出', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log', { message: 'ran', maxTick: 5 });
    const d = loadLevelRuntime(doc).desc!;
    const reg = realRegistry();
    const s = new RuntimeSession({ desc: d, seed: 1, executor: realExecutor(reg) });

    expect(s.behaviorLog).toEqual([]); // 前置：执行前没有日志
    s.step();
    s.step();

    // 关键断言：脚本真的跑了，而且带上了我们传的 message
    expect(s.behaviorLog.length).toBeGreaterThan(0);
    expect(s.behaviorLog[0]!.behavior).toBe('debug-on-trigger-log');
    expect(s.behaviorLog[0]!.nodeId).toBe(SCRIPT_NODE);
    expect(s.behaviorLog.some((e) => e.message.includes('ran'))).toBe(true);
  });

  it('ctx.tick 随推进递增（行为能感知当前步）', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log', { maxTick: 3 });
    const d = loadLevelRuntime(doc).desc!;
    const s = new RuntimeSession({ desc: d, seed: 1, executor: realExecutor(realRegistry()) });
    s.step();
    s.step();
    s.step();
    const ticks = s.behaviorLog.map((e) => e.tick);
    expect(new Set(ticks).size).toBeGreaterThan(1); // 至少跨了两个 tick
    expect(ticks.every((t) => t >= 1)).toBe(true);
  });

  it('🔴 未注入执行器 → 每个脚本产出 W_BEHAVIOR_UNAVAILABLE，且**不抛异常、不中断推进**', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log');
    const d = loadLevelRuntime(doc).desc!;
    // 故意不传 executor
    const s = new RuntimeSession({ desc: d, seed: 1 });
    expect(() => {
      s.step();
      s.step();
    }).not.toThrow();
    expect(s.behaviorLog).toEqual([]);
    expect(
      s.diagnostics().some((x) => x.code === 'W_BEHAVIOR_UNAVAILABLE'),
    ).toBe(true);
  });

  it('行为未注册 → 记诊断并降级，其余步骤照常推进', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'no-such-behavior');
    const d = loadLevelRuntime(doc).desc!;
    const s = new RuntimeSession({ desc: d, seed: 1, executor: realExecutor(realRegistry()) });
    expect(() => s.step()).not.toThrow();
    expect(
      s.diagnostics().some((x) => x.code === 'W_BEHAVIOR_UNAVAILABLE'),
    ).toBe(true);
  });

  it('参数按 schema 修正后再交给 run（越界被钳制）', () => {
    const doc = floor1Clean();
    // maxTick 的 max 是 600，传 9999 应被钳到 600
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log', { maxTick: 9999, message: 'clamped' });
    const d = loadLevelRuntime(doc).desc!;
    const seen: Record<string, unknown>[] = [];
    const s = new RuntimeSession({
      desc: d,
      seed: 1,
      executor: {
        run(script, ctx) {
          const reg = realRegistry();
          const r = reg.resolve(script.behavior, script.params);
          if (r.def === null) return false;
          seen.push({ ...r.params });
          r.def.run(ctx, r.params);
          return true;
        },
      },
    });
    s.step();
    expect(seen[0]!.maxTick).toBe(600); // 已被钳制，不是 9999
  });

  it('🔴 日志封顶 200：长时间跑不会无限增长，且保留最近的', () => {
    const doc = floor1Clean();
    // maxTick 设到上限，让它每 tick 都打日志
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log', { maxTick: 600, message: 'x' });
    const d = loadLevelRuntime(doc).desc!;
    const s = new RuntimeSession({ desc: d, seed: 1, executor: realExecutor(realRegistry()) });

    for (let i = 0; i < 250; i++) s.step();

    // 250 条里丢掉最早的 50 条，保留最近 200 条（tick 51..250）
    expect(s.behaviorLog.length).toBe(200);
    expect(s.behaviorLog[0]!.tick).toBe(51);
    expect(s.behaviorLog[199]!.tick).toBe(250);
  });

  it('reset() 清空行为日志（跨代日志混进来会让"重跑了没"说不清）', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log', { maxTick: 5 });
    const d = loadLevelRuntime(doc).desc!;
    const s = new RuntimeSession({ desc: d, seed: 1, executor: realExecutor(realRegistry()) });
    s.step();
    expect(s.behaviorLog.length).toBeGreaterThan(0);
    s.reset();
    expect(s.behaviorLog).toEqual([]);
  });

  it('🔴 执行器抛异常 → step 不崩，只记 W_BEHAVIOR_THREW（不叠加矛盾诊断，PR#16 review）', () => {
    const doc = floor1Clean();
    attachScript(doc, SCRIPT_NODE, 'debug-on-trigger-log');
    const d = loadLevelRuntime(doc).desc!;
    const s = new RuntimeSession({
      desc: d,
      seed: 1,
      executor: {
        // 一个"不自觉"的执行器：自己不兜异常
        run: () => {
          throw new Error('行为内部炸了');
        },
      },
    });
    expect(() => {
      s.step();
      s.step();
    }).not.toThrow();
    const diags = s.diagnostics();
    // 只允许 THREW，不允许再出 UNAVAILABLE（一次失败两条矛盾诊断 = 误导）
    expect(diags.some((x) => x.code === 'W_BEHAVIOR_THREW')).toBe(true);
    expect(diags.some((x) => x.code === 'W_BEHAVIOR_UNAVAILABLE')).toBe(false);
    // 推进没被中断：tick 仍在走
    expect(s.tick).toBeGreaterThan(0);
  });
});
