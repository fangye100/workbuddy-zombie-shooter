/**
 * 行为注册表（ADR-017「脚本 = 行为注册表」的执行侧，ADR-018 P1）。
 *
 * ## 权威 owner
 *
 * **编辑会话持有唯一实例**，P3 由它把执行器注入 runtime（ADR-018 R3）。
 * 不允许编辑器与 runtime-bridge 各建一张表——那会变成两张可独立修改的行为表
 * （docs/17 §3.5：每类运行状态只能有一个权威 owner）。
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
 * ## 参数 schema 的两道校验
 *
 * - **注册期**：校验 schema 自身一致性（`default` 是否在范围内、enum 的 `default`
 *   是否在候选里、`min <= max`……）。`default` 是使用频率最高的值，一个越界的
 *   default 会让 Inspector 滑块画到界外、并让每个缺失该参数的场景静默拿到非法值，
 *   所以必须在注册期就暴露，而不是等到场景加载。
 * - **解析期**：校验场景里存的参数值，缺失补 `default`、越界钳制、类型不符回退。
 *
 * 注意：`params: []` 对**真正零参数**的行为是合法值，只给提示不视为错误。
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
  | 'BEHAVIOR_DEF_INVALID'
  | 'BEHAVIOR_NO_PARAMS'
  | 'SCHEMA_INVALID'
  | 'PARAM_MISSING'
  | 'PARAM_UNKNOWN'
  | 'PARAM_TYPE_MISMATCH'
  | 'PARAM_OUT_OF_RANGE'
  | 'PARAM_ENUM_NO_OPTIONS'
  | 'PARAM_ENUM_UNKNOWN';

export interface BehaviorDiagnostic {
  code: BehaviorDiagnosticCode;
  behaviorId: string;
  /** 出问题的参数键；与具体参数无关时（如 BEHAVIOR_NOT_FOUND）为 null */
  paramKey: string | null;
  message: string;
  // TODO(P3)：与 `asset-server.ts` 的 MetaDiagnostic 对齐 severity / path 字段。
  // 目前全部诊断都是 warning 级（本层没有致命错误），P3 接线时补上显式字段，
  // 属纯增量，现有断言（只断言 code）不会受影响。
}

/** `resolve()` 的结果。`def === null` 表示应降级为空操作 */
export interface ResolvedBehavior<Ctx = unknown> {
  def: BehaviorModule<Ctx> | null;
  /** 按 schema 修正后的参数（缺失补 default、越界已钳制、多余项已剔除） */
  params: Record<string, BehaviorScalar>;
  diagnostics: BehaviorDiagnostic[];
}

/** `registerAll()` 的结果：坏行为不影响好行为，逐个报诊断而不是整批炸掉 */
export interface RegisterResult {
  registered: string[];
  rejected: BehaviorDiagnostic[];
}

const PARAM_KINDS = new Set([
  'number',
  'int',
  'bool',
  'string',
  'color',
  'nodeRef',
  'assetRef',
  'enum',
]);

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
      return `未知参数类型「${String(schema.kind)}」`;
  }
}

/**
 * 注册期校验 schema 自身的一致性。返回诊断列表，空数组 = 合法。
 */
function validateSchema(
  behaviorId: string,
  params: readonly BehaviorParamSchema[],
): BehaviorDiagnostic[] {
  const out: BehaviorDiagnostic[] = [];
  for (const s of params) {
    if (s === null || typeof s !== 'object') {
      out.push({
        code: 'SCHEMA_INVALID',
        behaviorId,
        paramKey: null,
        message: `参数 schema 不是对象`,
      });
      continue;
    }
    if (typeof s.key !== 'string' || s.key.length === 0) {
      out.push({
        code: 'SCHEMA_INVALID',
        behaviorId,
        paramKey: null,
        message: `参数 schema 缺少合法的 key`,
      });
      continue;
    }
    if (!PARAM_KINDS.has(s.kind)) {
      out.push({
        code: 'SCHEMA_INVALID',
        behaviorId,
        paramKey: s.key,
        message: `参数「${s.key}」的 kind「${String(s.kind)}」不是受支持的类型`,
      });
      continue;
    }
    if (s.kind === 'number' || s.kind === 'int') {
      if (s.min !== undefined && s.max !== undefined && s.min > s.max) {
        out.push({
          code: 'SCHEMA_INVALID',
          behaviorId,
          paramKey: s.key,
          message: `参数「${s.key}」的 min(${s.min}) > max(${s.max})`,
        });
      }
      if (typeof s.default !== 'number' || !Number.isFinite(s.default)) {
        out.push({
          code: 'SCHEMA_INVALID',
          behaviorId,
          paramKey: s.key,
          message: `参数「${s.key}」是 ${s.kind}，但 default 不是有限数字（${String(s.default)}）`,
        });
      } else if (
        (s.min !== undefined && s.default < s.min) ||
        (s.max !== undefined && s.default > s.max)
      ) {
        out.push({
          code: 'SCHEMA_INVALID',
          behaviorId,
          paramKey: s.key,
          message: `参数「${s.key}」的 default(${s.default}) 越界 [${s.min ?? '-∞'}, ${s.max ?? '+∞'}]`,
        });
      }
    }
    if (s.kind === 'enum') {
      const opts = s.options ?? [];
      if (opts.length === 0) {
        out.push({
          code: 'SCHEMA_INVALID',
          behaviorId,
          paramKey: s.key,
          message: `参数「${s.key}」是 enum 但没有 options，Inspector 会画出空下拉`,
        });
      } else if (!opts.includes(String(s.default))) {
        out.push({
          code: 'SCHEMA_INVALID',
          behaviorId,
          paramKey: s.key,
          message: `参数「${s.key}」的 default(${String(s.default)}) 不在候选 [${opts.join(', ')}] 内`,
        });
      }
    }
    if (s.kind === 'bool' && typeof s.default !== 'boolean') {
      out.push({
        code: 'SCHEMA_INVALID',
        behaviorId,
        paramKey: s.key,
        message: `参数「${s.key}」是 bool，但 default 不是 boolean（${String(s.default)}）`,
      });
    }
    if (
      (s.kind === 'string' || s.kind === 'color' || s.kind === 'nodeRef' || s.kind === 'assetRef') &&
      typeof s.default !== 'string'
    ) {
      out.push({
        code: 'SCHEMA_INVALID',
        behaviorId,
        paramKey: s.key,
        message: `参数「${s.key}」是 ${s.kind}，但 default 不是 string（${String(s.default)}）`,
      });
    }
  }
  return out;
}

/** 类型兜底值：当 schema 的 default 本身类型就错了（注册期已报 SCHEMA_INVALID），解析期仍需产出类型安全的值 */
function safeFallback(schema: BehaviorParamSchema): BehaviorScalar {
  switch (schema.kind) {
    case 'int':
    case 'number':
      return 0;
    case 'bool':
      return false;
    case 'enum':
      return schema.options?.[0] ?? '';
    default:
      return '';
  }
}

/**
 * 把「原始取值 / 回退到 default」统一送进同一条后处理流水线。
 *
 * 🔴 这是「default 越界不被校验」的修复点：**default 与用户传入值走完全相同的
 * 类型 → 范围 → enum 校验**，不存在"取了 default 就跳过校验"的短路分支。
 */
function coerce(
  behaviorId: string,
  schema: BehaviorParamSchema,
  raw: BehaviorScalar | undefined,
  has: boolean,
  diagnostics: BehaviorDiagnostic[],
): BehaviorScalar {
  let v: BehaviorScalar;

  if (!has) {
    v = schema.default;
    diagnostics.push({
      code: 'PARAM_MISSING',
      behaviorId,
      paramKey: schema.key,
      message: `参数「${schema.key}」缺失，已用默认值 ${String(schema.default)}`,
    });
  } else {
    const err = typeError(schema, raw);
    if (err !== null) {
      v = schema.default;
      diagnostics.push({
        code: 'PARAM_TYPE_MISMATCH',
        behaviorId,
        paramKey: schema.key,
        message: `参数「${schema.key}」类型不符：${err}，已回退默认值 ${String(schema.default)}`,
      });
    } else {
      v = raw as BehaviorScalar;
    }
  }

  // ---- 数值：范围钳制（int 必须保持整数）----
  if (schema.kind === 'number' || schema.kind === 'int') {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      diagnostics.push({
        code: 'PARAM_TYPE_MISMATCH',
        behaviorId,
        paramKey: schema.key,
        message: `参数「${schema.key}」取值 ${String(v)} 不是有限数字，已兜底为 0`,
      });
      return 0;
    }
    let min = schema.min;
    let max = schema.max;
    if (schema.kind === 'int') {
      // 边界先取整，否则会把 int 钳到小数上（如 max=10.5 → 钳出 10.5）
      if (min !== undefined) min = Math.ceil(min);
      if (max !== undefined) max = Math.floor(max);
    }
    let out = v;
    if (min !== undefined && out < min) out = min;
    if (max !== undefined && out > max) out = max;
    if (schema.kind === 'int') out = Math.round(out);
    if (out !== v) {
      diagnostics.push({
        code: 'PARAM_OUT_OF_RANGE',
        behaviorId,
        paramKey: schema.key,
        message: `参数「${schema.key}」取值 ${String(v)} 超出 [${schema.min ?? '-∞'}, ${schema.max ?? '+∞'}]，已钳制为 ${String(out)}`,
      });
    }
    return out;
  }

  // ---- enum：候选校验 ----
  if (schema.kind === 'enum') {
    const opts = schema.options ?? [];
    if (opts.length === 0) {
      diagnostics.push({
        code: 'PARAM_ENUM_NO_OPTIONS',
        behaviorId,
        paramKey: schema.key,
        message: `参数「${schema.key}」是 enum 但没有候选值，无法校验，原样放行`,
      });
      return v;
    }
    if (!opts.includes(String(v))) {
      const fallback = opts.includes(String(schema.default)) ? schema.default : opts[0]!;
      diagnostics.push({
        code: 'PARAM_ENUM_UNKNOWN',
        behaviorId,
        paramKey: schema.key,
        message: `参数「${schema.key}」取值「${String(v)}」不在候选 [${opts.join(', ')}] 内，已回退为 ${String(fallback)}`,
      });
      return fallback;
    }
    return v;
  }

  // ---- 安全网：schema 的 default 本身类型就错时（注册期已报 SCHEMA_INVALID），
  // 解析期仍必须产出类型安全的值，不能把 number 塞给期望 string 的行为。
  if (typeError(schema, v) !== null) {
    const fb = safeFallback(schema);
    diagnostics.push({
      code: 'PARAM_TYPE_MISMATCH',
      behaviorId,
      paramKey: schema.key,
      message: `参数「${schema.key}」最终取值 ${String(v)} 仍不符合 ${schema.kind}（schema 的 default 类型有误），已兜底为 ${String(fb)}`,
    });
    return fb;
  }

  return v;
}

export class BehaviorRegistry {
  private readonly mods = new Map<string, BehaviorModule<unknown>>();
  /** 注册期产出的 schema 诊断（供 Inspector / 门禁查询） */
  private readonly schemaIssues: BehaviorDiagnostic[] = [];

  /** 已注册数量 */
  get size(): number {
    return this.mods.size;
  }

  /** 注册期发现的 schema 自身问题（空数组 = 全部行为 schema 自洽） */
  get schemaDiagnostics(): readonly BehaviorDiagnostic[] {
    return this.schemaIssues;
  }

  /**
   * 注册一个行为。
   *
   * 重复 id 与形状残缺都**拒绝注册**（抛错）。理由：注册期是代码资产装载期，
   * 快速失败能让 Agent 立刻看到问题；同时保证注册表里没有坏条目，
   * 从而 `resolve()` 永远不必面对畸形模块（ADR-017 的"不阻塞"是解析期的承诺）。
   *
   * 🔴 宿主批量收集请一律用 `registerAll()`，**不要逐个调 `register()`**：
   * 单个坏行为抛错会让整批收集中断并留下半张表。`registerAll` 逐个 try/catch，
   * 坏行为只进 `rejected`，不影响其余。
   */
  register<Ctx>(mod: BehaviorModule<Ctx>): void {
    if (mod === null || typeof mod !== 'object') {
      throw new Error(`[behavior] 行为模块不是对象（${typeof mod}）`);
    }
    if (typeof mod.id !== 'string' || mod.id.length === 0) {
      throw new Error(`[behavior] 行为模块缺少合法 id`);
    }
    if (!Array.isArray(mod.params)) {
      throw new Error(
        `[behavior] 行为「${mod.id}」的 params 必须是数组（实际 ${typeof mod.params}）`,
      );
    }
    if (typeof mod.run !== 'function') {
      throw new Error(`[behavior] 行为「${mod.id}」缺少 run 函数`);
    }
    if (this.mods.has(mod.id)) {
      throw new Error(`[behavior] 重复注册行为 id「${mod.id}」，已存在同 id 定义`);
    }

    const issues = validateSchema(mod.id, mod.params);
    this.schemaIssues.push(...issues);
    this.mods.set(mod.id, mod as unknown as BehaviorModule<unknown>);
  }

  /**
   * 批量注册。**逐个独立 try/catch**：一个坏行为不该让整批注册炸掉并留下半张表
   * （与 ADR-017「一个挂掉的行为不该让整个场景打不开」同一精神）。
   */
  registerAll(mods: readonly BehaviorModule<unknown>[]): RegisterResult {
    const registered: string[] = [];
    const rejected: BehaviorDiagnostic[] = [];
    for (const m of mods) {
      try {
        this.register(m);
        registered.push(m.id);
      } catch (e) {
        rejected.push({
          code: 'BEHAVIOR_DEF_INVALID',
          behaviorId: (m as { id?: string } | null)?.id ?? '(未知 id)',
          paramKey: null,
          message: `行为注册失败，已跳过：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    return { registered, rejected };
  }

  /** 清空（测试 / 重新收集前用） */
  clear(): void {
    this.mods.clear();
    this.schemaIssues.length = 0;
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
   * - 参数缺失 → 补 schema 的 `default` + warning（default 同样要过范围/enum 校验）
   * - 参数多余 → 剔除 + warning（不能原样留着，否则行为内部可能读到脏键）
   * - 类型不符 / 越界 / enum 越界 → warning + 修正为合法值
   *
   * 🔴 整体包 try/catch：任何未预料到的异常都降级为 `def = null` 而不是抛出去。
   * 本层的契约是「永不阻塞加载」，宁可少一个行为也不能让场景打不开。
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

    try {
      if (!Array.isArray(def.params)) {
        throw new Error(`行为「${behaviorId}」的 params 不是数组`);
      }
      if (def.params.length === 0) {
        // 零参数行为合法，这里只是提示 Inspector 没有可调控件
        diagnostics.push({
          code: 'BEHAVIOR_NO_PARAMS',
          behaviorId,
          paramKey: null,
          message: `行为「${behaviorId}」没有可调参数（params 为空），Inspector 不显示控件`,
        });
      }

      const input = raw ?? {};
      const out: Record<string, BehaviorScalar> = {};

      for (const schema of def.params) {
        if (schema === null || typeof schema !== 'object') continue;
        const has = Object.prototype.hasOwnProperty.call(input, schema.key);
        out[schema.key] = coerce(
          behaviorId,
          schema,
          has ? input[schema.key] : undefined,
          has,
          diagnostics,
        );
      }

      // ---- 剔除 schema 里没有的多余键 ----
      for (const k of Object.keys(input)) {
        if (!def.params.some((s) => s?.key === k)) {
          diagnostics.push({
            code: 'PARAM_UNKNOWN',
            behaviorId,
            paramKey: k,
            message: `参数「${k}」不在行为「${behaviorId}」的 schema 中，已忽略（可能是参数改名后的残留）`,
          });
        }
      }

      return { def, params: out, diagnostics };
    } catch (e) {
      diagnostics.push({
        code: 'BEHAVIOR_DEF_INVALID',
        behaviorId,
        paramKey: null,
        message: `行为「${behaviorId}」解析失败，已降级为空操作：${e instanceof Error ? e.message : String(e)}`,
      });
      return { def: null, params: {}, diagnostics };
    }
  }
}
