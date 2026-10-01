/**
 * 行为注册表（ADR-017「脚本 = 行为注册表」的执行侧，ADR-018 P1）。
 *
 * ## 为什么存在这一层
 *
 * 场景只存 `{ behavior: 'spawn-wave', params: { count: 12 } }`（绝不存代码字符串，
 * 理由见 `document.ts` 的 `ScriptComponent`）。那么「`spawn-wave` 到底是一段什么代码、
 * 它的 `count` 该是滑块还是文本框」就必须有另一个真源 —— 本文件就是那个真源。
 *
 * ## 三条边界
 *
 * 1. **本模块不 import 任何行为代码**。行为文件在 `assets/behaviors/*.ts`，
 *    由宿主（编辑器用 `import.meta.glob`、CLI 用显式列表）收集后调用 `register()`。
 *    注册表只管「收进来、查得到、校验得住」，不关心它们从哪来。
 * 2. **`run` 的 ctx 形状不由本层决定**。用泛型 `Ctx` 占位，具体形状由 runtime 在
 *    P3 注入执行器时给出（ADR-018 R3：runtime 不 import 行为代码，反过来
 *    scene 也不该反向依赖 runtime 的类型）。
 * 3. **失效一律 warning，绝不抛异常阻塞加载**。一个挂掉的行为不该让整个场景打不开
 *    （ADR-017 明写）。调用方拿到 `def === null` 就降级为空操作。
 *
 * ## 参数 schema 是必需项，不是可选项
 *
 * 如果行为只有 `run` 而不声明 `params`，Inspector 就画不出控件，Script 组件只能
 * 手改 JSON —— 功能等于没有。所以 `BehaviorDef.params` 缺失时这里会直接报错。
 */

import type { BehaviorDef, BehaviorParamSchema, BehaviorScalar } from './document';

/**
 * 行为模块 = 定义（id / label / params schema）+ 执行体。
 *
 * `Ctx` 由宿主提供。P1 阶段用 `unknown` 默认，P3 接线后 runtime 会传具体视图。
 */
export interface BehaviorModule<Ctx = unknown> extends BehaviorDef {
  run(ctx: Ctx, params: Readonly<Record<string, BehaviorScalar>>): void;
}

/**
 * 行为作者入口。语义上只是把对象收窄成 `BehaviorModule`，
 * 存在的意义是**给 Agent 和人类一个明确的书写约定**（并让 TS 推断 Ctx 泛型）。
 */
export function defineBehavior<Ctx = unknown>(mod: BehaviorModule<Ctx>): BehaviorModule<Ctx> {
  return mod;
}

/** 行为诊断码。全部是 warning 级——本层没有"致命错误"这个概念 */
export type BehaviorDiagnosticCode =
  | 'BEHAVIOR_NOT_FOUND'
  | 'BEHAVIOR_NO_PARAMS_SCHEMA'
  | 'PARAM_MISSING'
  | 'PARAM_UNKNOWN'
  | 'PARAM_TYPE_MISMATCH'
  | 'PARAM_OUT_OF_RANGE'
  | 'PARAM_ENUM_UNKNOWN';

export interface BehaviorDiagnostic {
  code: BehaviorDiagnosticCode;
  behaviorId: string;
  /** 出问题的参数键；与具体参数无关时（如 BEHAVIOR_NOT_FOUND）为 null */
  paramKey: string | null;
  message: string;
}

/** `resolve()` 的结果。`def === null` 表示应降级为空操作 */
export interface ResolvedBehavior<Ctx = unknown> {
  def: BehaviorModule<Ctx> | null;
  /** 按 schema 修正后的参数（缺失补 default、越界已 clamp、多余项已剔除） */
  params: Record<string, BehaviorScalar>;
  diagnostics: BehaviorDiagnostic[];
}

/** 单个参数值的类型判定。返回 null 表示类型合法 */
function typeError(schema: BehaviorParamSchema, v: unknown): string | null {
  switch (schema.kind) {
    case 'int':
      return typeof v === 'number' && Number.isInteger(v)
        ? null
        : `期望 int，实际 ${typeof v === 'number' ? `非整数 ${v}` : typeof v}`;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
        ? null
        : `期望 number，实际 ${typeof v}`;
    case 'bool':
      return typeof v === 'boolean' ? null : `期望 bool，实际 ${typeof v}`;
    case 'string':
    case 'color':
    case 'nodeRef':
    case 'assetRef':
    case 'enum':
      return typeof v === 'string' ? null : `期望 string（${schema.kind}），实际 ${typeof v}`;
    default:
      return null;
  }
}

/** 数值范围钳制。非数值类型直接原样返回 */
function clampNumber(schema: BehaviorParamSchema, v: BehaviorScalar): BehaviorScalar {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  let out = v;
  if (schema.min !== undefined && out < schema.min) out = schema.min;
  if (schema.max !== undefined && out > schema.max) out = schema.max;
  return out;
}

export class BehaviorRegistry {
  private readonly mods = new Map<string, BehaviorModule<unknown>>();

  /** 已注册数量 */
  get size(): number {
    return this.mods.size;
  }

  /**
   * 注册一个行为。重复 id 直接抛错——静默覆盖会让「场景里明明写了 A 却跑成 B」
   * 这种最难查的问题变成常态。
   */
  register<Ctx>(mod: BehaviorModule<Ctx>): void {
    const found = this.mods.get(mod.id);
    if (found !== undefined) {
      throw new Error(`[behavior] 重复注册行为 id「${mod.id}」，已存在同 id 定义`);
    }
    this.mods.set(mod.id, mod as unknown as BehaviorModule<unknown>);
  }

  /** 批量注册。宿主 glob 收集后一次塞进来 */
  registerAll(mods: readonly BehaviorModule<unknown>[]): void {
    for (const m of mods) this.register(m);
  }

  /** 清空（测试 / 重新收集前用） */
  clear(): void {
    this.mods.clear();
  }

  has(id: string): boolean {
    return this.mods.has(id);
  }

  get<Ctx = unknown>(id: string): BehaviorModule<Ctx> | undefined {
    return this.mods.get(id) as BehaviorModule<Ctx> | undefined;
  }

  /** 全部行为定义（Inspector 下拉列表用），按 id 稳定排序 */
  list(): BehaviorModule<unknown>[] {
    return [...this.mods.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 解析一个 Script 组件：**校验参数 + 产出可直接执行的 { def, params }**。
   *
   * 这是「失效降级」的唯一入口。约定：
   * - 行为未注册 → `def = null` + `BEHAVIOR_NOT_FOUND`，调用方降级空操作（不阻塞加载）
   * - 参数缺失 → 补 schema 的 `default` + warning
   * - 参数多余 → 剔除 + warning（不能原样留着，否则行为内部可能读到脏键）
   * - 类型不符 / 越界 / enum 越界 → warning + 修正为合法值
   */
  resolve<Ctx = unknown>(
    behaviorId: string,
    raw: Readonly<Record<string, BehaviorScalar>> | undefined,
  ): ResolvedBehavior<Ctx> {
    const diagnostics: BehaviorDiagnostic[] = [];
    const def = this.mods.get(behaviorId) as BehaviorModule<Ctx> | undefined;

    if (def === undefined) {
      diagnostics.push({
        code: 'BEHAVIOR_NOT_FOUND',
        behaviorId,
        paramKey: null,
        message: `行为「${behaviorId}」未注册（可能已删除或尚未收集），该 Script 组件降级为空操作`,
      });
      return { def: null, params: {}, diagnostics };
    }

    if (def.params.length === 0) {
      // schema 缺失不是致命错误，但必须抱怨：没有 schema 就没有 Inspector 控件
      diagnostics.push({
        code: 'BEHAVIOR_NO_PARAMS_SCHEMA',
        behaviorId,
        paramKey: null,
        message: `行为「${behaviorId}」未声明 params schema，Inspector 无法生成控件`,
      });
    }

    const input = raw ?? {};
    const out: Record<string, BehaviorScalar> = {};

    // ---- 按 schema 逐个校验 ----
    for (const schema of def.params) {
      const has = Object.prototype.hasOwnProperty.call(input, schema.key);
      if (!has) {
        out[schema.key] = schema.default;
        diagnostics.push({
          code: 'PARAM_MISSING',
          behaviorId,
          paramKey: schema.key,
          message: `参数「${schema.key}」缺失，已用默认值 ${String(schema.default)}`,
        });
        continue;
      }

      let v: BehaviorScalar = input[schema.key]!;
      const err = typeError(schema, v);
      if (err !== null) {
        diagnostics.push({
          code: 'PARAM_TYPE_MISMATCH',
          behaviorId,
          paramKey: schema.key,
          message: `参数「${schema.key}」类型不符：${err}，已回退默认值 ${String(schema.default)}`,
        });
        v = schema.default;
        out[schema.key] = v;
        continue;
      }

      // enum 候选值
      if (schema.kind === 'enum') {
        const opts = schema.options ?? [];
        if (opts.length > 0 && !opts.includes(String(v))) {
          diagnostics.push({
            code: 'PARAM_ENUM_UNKNOWN',
            behaviorId,
            paramKey: schema.key,
            message: `参数「${schema.key}」取值「${String(v)}」不在候选 [${opts.join(', ')}] 内，已回退默认值 ${String(schema.default)}`,
          });
          out[schema.key] = schema.default;
          continue;
        }
      }

      // 数值范围
      if (schema.kind === 'number' || schema.kind === 'int') {
        const clamped = clampNumber(schema, v);
        if (clamped !== v) {
          diagnostics.push({
            code: 'PARAM_OUT_OF_RANGE',
            behaviorId,
            paramKey: schema.key,
            message: `参数「${schema.key}」取值 ${String(v)} 超出 [${schema.min ?? '-∞'}, ${schema.max ?? '+∞'}]，已钳制为 ${String(clamped)}`,
          });
        }
        out[schema.key] = clamped;
        continue;
      }

      out[schema.key] = v;
    }

    // ---- 剔除 schema 里没有的多余键 ----
    for (const k of Object.keys(input)) {
      if (!def.params.some((s) => s.key === k)) {
        diagnostics.push({
          code: 'PARAM_UNKNOWN',
          behaviorId,
          paramKey: k,
          message: `参数「${k}」不在行为「${behaviorId}」的 schema 中，已忽略（可能是参数改名后的残留）`,
        });
      }
    }

    return { def, params: out, diagnostics };
  }
}
