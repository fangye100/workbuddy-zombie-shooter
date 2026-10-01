/**
 * 行为注册表测试（ADR-018 P1）。
 *
 * 重点不是「能注册」，而是**失效路径必须降级而不是抛异常**——
 * 一个挂掉的行为不该让整个场景打不开（ADR-017）。
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
  it('注册后可按 id 取回，list 按 id 稳定排序', () => {
    const reg = makeRegistry();
    expect(reg.size).toBe(1);
    expect(reg.has('test-wave')).toBe(true);
    expect(reg.get('test-wave')?.id).toBe('test-wave');
    expect(reg.list().map((m) => m.id)).toEqual(['test-wave']);
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
    expect(r.diagnostics.some((d) => d.code === 'PARAM_TYPE_MISMATCH' && d.paramKey === 'count')).toBe(
      true,
    );
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

  it('enum 取值不在候选内 → 回退默认值并报 PARAM_ENUM_UNKNOWN', () => {
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

  it('多余参数 → 从结果里剔除并报 PARAM_UNKNOWN', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', {
      count: 1,
      interval: 1,
      mode: 'burst',
      enabled: true,
      legacyKey: 'old',
    });
    expect(Object.prototype.hasOwnProperty.call(r.params, 'legacyKey')).toBe(false);
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

  it('行为未声明 params schema → 报 BEHAVIOR_NO_PARAMS_SCHEMA（Inspector 画不出控件）', () => {
    const reg = new BehaviorRegistry();
    reg.register(
      defineBehavior<Ctx>({ id: 'no-schema', label: '无 schema', params: [], run: () => undefined }),
    );
    const r = reg.resolve('no-schema', {});
    expect(r.def).not.toBeNull();
    expect(r.diagnostics.some((d) => d.code === 'BEHAVIOR_NO_PARAMS_SCHEMA')).toBe(true);
  });

  it('params 传 undefined 也不炸（等价于空对象）', () => {
    const reg = makeRegistry();
    const r = reg.resolve('test-wave', undefined);
    expect(r.def).not.toBeNull();
    expect(r.params.count).toBe(8);
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
      const t = typeof v;
      expect(['number', 'string', 'boolean']).toContain(t);
      expect(v as BehaviorScalar).not.toBeUndefined();
    }
  });
});
