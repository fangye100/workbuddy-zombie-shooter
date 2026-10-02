/**
 * 行为注册表测试（ADR-018 P1）。
 *
 * 重点不是「能注册」，而是**失效路径必须降级而不是抛异常**——
 * 一个挂掉的行为不该让整个场景打不开（ADR-017）。
 *
 * 每条断言都要能抓住真实的错误；禁止"必然成立"的恒真断言
 * （例如断言"结果里没有 schema 之外的键"——结果本就只按 schema 构建，恒真）。
 */

import { describe, expect, it } from 'vitest';
import { BehaviorRegistry, defineBehavior } from '../src/behavior';
import type { BehaviorScalar } from '../src/document';

/** 测试用执行上下文。P1 阶段形状随意，只要 run 能被调起来 */
interface Ctx {
  log: string[];
}

function makeRegistry(): BehaviorRegistry {
  const reg = new BehaviorRegistry();
  reg.register(
    defineBehavior<Ctx>({
      id: 'test-wave',
      label: '测试波次',
      params: [
        { key: 'count', label: '数量', kind: 'int', default: 8, min: 1, max: 50 },
        { key: 'interval', label: '间隔', kind: 'number', default: 1.5, min: 0.1, max: 10 },
        { key: 'mode', label: '模式', kind: 'enum', default: 'burst', options: ['burst', 'drip'] },
        { key: 'enabled', label: '启用', kind: 'bool', default: true },
      ],
      run(ctx, params) {
        ctx.log.push(`wave:${String(params.count)}/${String(params.mode)}`);
      },
    }),
  );
  return reg;
}

describe('BehaviorRegistry · 注册与查询', () => {
  it('注册后可按 id 取回', () => {
    const reg = makeRegistry();
    expect(reg.size).toBe(1);
    expect(reg.has('test-wave')).toBe(true);
    expect(reg.get('test-wave')?.id).toBe('test-wave');
  });

  it('list 按 id 稳定排序（多元素才验得出排序）', () => {
    const reg = new BehaviorRegistry();
    for (const id of ['zeta', 'alpha', 'mid']) {
      reg.register(
        defineBehavior<Ctx>({ id, label: id, params: [], run: () => undefined }),
      );
    }
    expect(reg.list().map((m) => m.id)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('重复注册同一 id 必须抛错（静默覆盖会让行为被偷偷换掉）', () => {
    const reg = makeRegistry();
    const dup = defineBehavior<Ctx>({
      id: 'test-wave',
      label: '重复的',
      params: [],
      run: () => undefined,
    });
    expect(() => reg.register(dup)).toThrow(/重复注册/);
  });

  it('未注册的 id 查询返回 undefined', () => {
    const reg = makeRegistry();
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.has('nope')).toBe(false);
  });

  it('clear 清空全部条目与 schema 诊断', () => {
    const reg = new BehaviorRegistry();
    // 先塞一个 schema 有问题的行为，才能验证 schemaDiagnostics 也被清掉
    reg.register(
      defineBehavior<Ctx>({
        id: 'bad',
        label: 'x',
        params: [{ key: 'n', label: 'n', kind: 'int', default: 999, min: 1, max: 50 }],
        run: () => undefined,
      }),
    );
    expect(reg.size).toBe(1);
    expect(reg.schemaDiagnostics.length).toBeGreaterThan(0); // 前置：确实有诊断
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.get('bad')).toBeUndefined();
    expect(reg.schemaDiagnostics).toEqual([]); // 关键：schema 诊断也要清空
  });
});

describe('BehaviorRegistry · 注册期形状校验（保证注册表里没有坏条目）', () => {
  it('params 不是数组 → 拒绝注册', () => {
    const reg = new BehaviorRegistry();
    expect(() =>
      reg.register({ id: 'broken', label: 'b', params: {} as never, run: () => undefined }),
    ).toThrow(/params 必须是数组/);
  });

  it('缺少 run → 拒绝注册', () => {
    const reg = new BehaviorRegistry();
    expect(() =>
      reg.register({ id: 'norun', label: 'b', params: [], run: undefined as never }),
    ).toThrow(/缺少 run/);
  });

  it('registerAll 遇到坏行为不炸，好行为照常注册（一个坏行为不该毁掉整批）', () => {
    const reg = new BehaviorRegistry();
    const good = defineBehavior<Ctx>({ id: 'good', label: 'g', params: [], run: () => undefined });
    const bad = { id: 'bad', label: 'b', params: {}, run: () => undefined } as never;
    const res = reg.registerAll([good, bad]);
    expect(res.registered).toEqual(['good']);
    expect(res.rejected.length).toBe(1);
    expect(res.rejected[0]?.code).toBe('BEHAVIOR_DEF_INVALID');
    expect(reg.has('good')).toBe(true);
    expect(reg.size).toBe(1);
  });
});

describe('BehaviorRegistry · 注册期 schema 自身校验', () => {
  it('default 越界 → SCHEMA_INVALID（否则每个缺失该参数的场景都静默拿到非法值）', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'bad-default',
        label: 'x',
        params: [{ key: 'n', label: 'n', kind: 'int', default: 999, min: 1, max: 50 }],
        run: () => undefined,
      }),
    );
    const issues = reg.schemaDiagnostics.filter((d) => d.code === 'SCHEMA_INVALID');
    expect(issues.length).toBe(1);
    expect(issues[0]?.paramKey).toBe('n');
  });

  it('enum 的 default 不在候选内 → SCHEMA_INVALID', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'bad-enum',
        label: 'x',
        params: [
          { key: 'm', label: 'm', kind: 'enum', default: 'zzz', options: ['a', 'b'] },
        ],
        run: () => undefined,
      }),
    );
    expect(reg.schemaDiagnostics.some((d) => d.code === 'SCHEMA_INVALID' && d.paramKey === 'm')).toBe(
      true,
    );
  });

  it('enum 缺 options → SCHEMA_INVALID（Inspector 会画出空下拉）', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'no-opts',
        label: 'x',
        params: [{ key: 'm', label: 'm', kind: 'enum', default: 'a' }],
        run: () => undefined,
      }),
    );
    expect(reg.schemaDiagnostics.some((d) => d.code === 'SCHEMA_INVALID' && d.paramKey === 'm')).toBe(
      true,
    );
  });

  it('string 系（string/color/nodeRef/assetRef）的 default 非字符串 → SCHEMA_INVALID', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'bad-str',
        label: 'x',
        params: [{ key: 's', label: 's', kind: 'string', default: 5 as never }],
        run: () => undefined,
      }),
    );
    expect(reg.schemaDiagnostics.some((d) => d.code === 'SCHEMA_INVALID' && d.paramKey === 's')).toBe(
      true,
    );
  });

  it('schema 自洽时 schemaDiagnostics 为空', () => {
    expect(makeRegistry().schemaDiagnostics).toEqual([]);
  });
});

describe('BehaviorRegistry · 参数校验', () => {
  it('参数齐全且合法时不产生任何诊断', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', {
      count: 12,
      interval: 2,
      mode: 'drip',
      enabled: false,
    });
    expect(r.def).not.toBeNull();
    expect(r.diagnostics).toEqual([]);
    expect(r.params).toEqual({ count: 12, interval: 2, mode: 'drip', enabled: false });
  });

  it('参数缺失 → 补 schema 默认值并报 PARAM_MISSING', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', { count: 5 });
    expect(r.params.count).toBe(5);
    expect(r.params.interval).toBe(1.5); // default
    expect(r.params.mode).toBe('burst'); // default
    expect(r.params.enabled).toBe(true); // default
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes.filter((c) => c === 'PARAM_MISSING').length).toBe(3);
  });

  it('int 传了非整数 → 回退默认值并报 PARAM_TYPE_MISMATCH', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', {
      count: 3.7,
      interval: 1,
      mode: 'burst',
      enabled: true,
    });
    expect(r.params.count).toBe(8); // default
    expect(
      r.diagnostics.some((d) => d.code === 'PARAM_TYPE_MISMATCH' && d.paramKey === 'count'),
    ).toBe(true);
  });

  it('数值越界 → 钳制到边界并报 PARAM_OUT_OF_RANGE', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', {
      count: 999, // max 50
      interval: -5, // min 0.1
      mode: 'burst',
      enabled: true,
    });
    expect(r.params.count).toBe(50);
    expect(r.params.interval).toBe(0.1);
    expect(r.diagnostics.filter((d) => d.code === 'PARAM_OUT_OF_RANGE').length).toBe(2);
  });

  it('🔴 default 本身越界时，缺失也要被钳制并报 PARAM_OUT_OF_RANGE', () => {
    // 这是"取了 default 就跳过校验"短路分支的回归测试
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'bad-default',
        label: 'x',
        params: [{ key: 'n', label: 'n', kind: 'int', default: 999, min: 1, max: 50 }],
        run: () => undefined,
      }),
    );
    const r = reg.resolve('bad-default', {}); // 缺失 → 取 default 999
    expect(r.params.n).toBe(50); // 必须被钳制，不能是 999
    expect(r.diagnostics.some((d) => d.code === 'PARAM_OUT_OF_RANGE')).toBe(true);
  });

  it('🔴 类型不符回退到 default 后，仍要过范围校验', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'bad-default2',
        label: 'x',
        params: [{ key: 'n', label: 'n', kind: 'int', default: 888, min: 1, max: 50 }],
        run: () => undefined,
      }),
    );
    const r = reg.resolve('bad-default2', { n: 'abc' }); // 类型错 → 回退 default 888
    expect(r.params.n).toBe(50); // 不能停在 888
    expect(r.diagnostics.some((d) => d.code === 'PARAM_OUT_OF_RANGE')).toBe(true);
  });

  it('🔴 int 的 max 是小数时，钳制结果必须仍是整数', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'int-frac',
        label: 'x',
        params: [{ key: 'n', label: 'n', kind: 'int', default: 5, min: 0, max: 10.5 }],
        run: () => undefined,
      }),
    );
    const r = reg.resolve('int-frac', { n: 999 });
    expect(Number.isInteger(r.params.n)).toBe(true);
    expect(r.params.n).toBe(10); // floor(10.5) = 10
  });

  it('enum 取值不在候选内 → 回退合法值并报 PARAM_ENUM_UNKNOWN', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', {
      count: 1,
      interval: 1,
      mode: 'nonsense',
      enabled: true,
    });
    expect(r.params.mode).toBe('burst');
    expect(r.diagnostics.some((d) => d.code === 'PARAM_ENUM_UNKNOWN')).toBe(true);
  });

  it('🔴 enum 的 default 也不合法时，回退到 options[0] 而不是停在非法值', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'bad-enum-default',
        label: 'x',
        params: [{ key: 'm', label: 'm', kind: 'enum', default: 'zzz', options: ['a', 'b'] }],
        run: () => undefined,
      }),
    );
    const r = reg.resolve('bad-enum-default', { m: 'nonsense' });
    expect(r.params.m).toBe('a'); // options[0]，不能是 'zzz'
  });

  it('enum 无 options → 报 PARAM_ENUM_NO_OPTIONS 而非静默放行', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'no-opts',
        label: 'x',
        params: [{ key: 'm', label: 'm', kind: 'enum', default: 'a' }],
        run: () => undefined,
      }),
    );
    const r = reg.resolve('no-opts', { m: 'WHATEVER' });
    expect(r.diagnostics.some((d) => d.code === 'PARAM_ENUM_NO_OPTIONS')).toBe(true);
  });

  it('🔴 default 类型本身错误时，解析期也要兜底成类型安全值（不能把 number 塞给 string）', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({
        id: 'bad-str-default',
        label: 'x',
        params: [{ key: 's', label: 's', kind: 'string', default: 5 as never }],
        run: () => undefined,
      }),
    );
    const r = reg.resolve('bad-str-default', {});
    expect(typeof r.params.s).toBe('string'); // 不能是 number 5
    expect(r.params.s).toBe('');
    expect(r.diagnostics.some((d) => d.code === 'PARAM_TYPE_MISMATCH')).toBe(true);
  });

  it('多余参数 → 报 PARAM_UNKNOWN（结果键集合恰等于 schema 键集合）', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', {
      count: 1,
      interval: 1,
      mode: 'burst',
      enabled: true,
      legacyKey: 'old',
    });
    expect(Object.keys(r.params).sort()).toEqual(['count', 'enabled', 'interval', 'mode']);
    expect(r.diagnostics.some((d) => d.code === 'PARAM_UNKNOWN' && d.paramKey === 'legacyKey')).toBe(
      true,
    );
  });
});

describe('BehaviorRegistry · 失效降级（关键：不阻塞加载）', () => {
  it('行为未注册 → def 为 null + BEHAVIOR_NOT_FOUND，且**不抛异常**', () => {
    const reg = makeRegistry();
    let r: ReturnType<typeof reg.resolve> | null = null;
    expect(() => {
      r = reg.resolve('deleted-behavior', { count: 3 });
    }).not.toThrow();
    expect(r).not.toBeNull();
    expect(r!.def).toBeNull();
    expect(r!.params).toEqual({});
    expect(r!.diagnostics[0]?.code).toBe('BEHAVIOR_NOT_FOUND');
  });

  it('行为无参数 → 提示 BEHAVIOR_NO_PARAMS（零参数合法，不是错误）', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({ id: 'no-schema', label: '无参数', params: [], run: () => undefined }),
    );
    const r = reg.resolve('no-schema', {});
    expect(r.def).not.toBeNull(); // 仍然可用
    expect(r.diagnostics.some((d) => d.code === 'BEHAVIOR_NO_PARAMS')).toBe(true);
  });

  it('params 传 undefined 也不炸（等价于空对象）', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', undefined);
    expect(r.def).not.toBeNull();
    expect(r.params.count).toBe(8);
  });

  it('🔴 即使内部出现异常也降级为 def=null，绝不冒泡', () => {
    // 构造一个会让 resolve 内部抛错的行为：params 被事后改成非数组
    const reg = new BehaviorRegistry();
    const mod = defineBehavior<Ctx>({
      id: 'corrupt',
      label: 'x',
      params: [{ key: 'a', label: 'a', kind: 'int', default: 1, min: 0, max: 5 }],
      run: () => undefined,
    });
    reg.register(mod);
    (mod as unknown as { params: unknown }).params = '不是数组了'; // 绕过 register 校验直接破坏
    let r: ReturnType<typeof reg.resolve> | null = null;
    expect(() => {
      r = reg.resolve('corrupt', {});
    }).not.toThrow();
    expect(r!.def).toBeNull();
    expect(r!.diagnostics.some((d) => d.code === 'BEHAVIOR_DEF_INVALID')).toBe(true);
  });
});

describe('BehaviorModule · 执行体', () => {
  it('run 能被调起，并读到按 schema 修正后的参数', () => {
    const reg = makeRegistry();
    const r = reg.resolve<Ctx>('test-wave', { count: 3, mode: 'drip' });
    expect(r.def).not.toBeNull();
    const ctx: Ctx = { log: [] };
    r.def!.run(ctx, r.params);
    expect(ctx.log).toEqual(['wave:3/drip']);
  });

  it('参数值类型始终是 BehaviorScalar 域内（不含 undefined）', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', {});
    for (const v of Object.values(r.params)) {
      expect(['number', 'string', 'boolean']).toContain(typeof v);
      expect(v as BehaviorScalar).not.toBeUndefined();
    }
  });
});
