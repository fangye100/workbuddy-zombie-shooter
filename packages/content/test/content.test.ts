import { describe, expect, it } from 'vitest';
import { CORE_COLORS, GRADING, TOON_RAMP } from '@aether/content';
import { ROSTER_CHARACTERS, requireCharacter } from '@aether/content';

/**
 * content/ 生成层回归测试（ADR-008：验证资产与结论同入库）
 *
 * 这里钉死**生成物的取值与解析规则**：复合描述串（"1.25 m（四足）/ 1.60 m（直立）"）
 * 怎么取数必须有断言，否则后人改解析器会静默改变上游行为。
 *
 * ⚠️ 「生成物是否与真源同步」**不在这里测** —— 本仓没装 @types/node，
 * TS 测试里用不了 node:child_process。同步性由独立门禁 `npm run content:check`
 * 承担（不同步即 exit 1，已自测有效）。两者都要跑。
 */
const stopOf = (curve: typeof GRADING, name: string) => {
  const s = curve.stops.find((x) => x.name === name);
  if (!s) throw new Error(`找不到停靠点 ${name}（现有：${curve.stops.map((x) => x.name).join(', ')}）`);
  return s;
};

describe('A. grading 三挡（packPost 的三处硬编码就是从这里来的）', () => {
  it('三挡顺序为 shadow / mid / light，区间首尾相接且覆盖 0→1', () => {
    expect(GRADING.stops.map((s) => s.name)).toEqual(['shadow', 'mid', 'light']);
    const [a, b, c] = GRADING.stops;
    expect(a!.range[0]).toBe(0);
    expect(a!.range[1]).toBe(b!.range[0]);
    expect(b!.range[1]).toBe(c!.range[0]);
    expect(c!.range[1]).toBe(1);
  });

  it('中间调倍率 0.98 —— packPost 里 dst[8] 曾经的硬编码值', () => {
    expect(stopOf(GRADING, 'mid').multiply).toBe(0.98);
  });

  it('暗部混向 night-deep(#0E0C16)、亮部混向 bone(#FFF6E2) —— packPost 另两处硬编码', () => {
    expect(stopOf(GRADING, 'shadow').mixToHex).toBe('#0E0C16');
    expect(stopOf(GRADING, 'light').mixToHex).toBe('#FFF6E2');
    // 且与 core 色组自洽：mixTo 必须能在 CORE_COLORS 里查到同名键
    expect(CORE_COLORS['night-deep']).toBe('#0E0C16');
    expect(CORE_COLORS.bone).toBe('#FFF6E2');
  });

  it('中间调不做混色（mixTo 为 null）', () => {
    expect(stopOf(GRADING, 'mid').mixTo).toBeNull();
    expect(stopOf(GRADING, 'mid').mixToHex).toBeNull();
  });
});

describe('B. toonRamp（生产分阶唯一真源）', () => {
  it('三挡 shadow / lit / spec，且 spec 叠加在 lit 之上（区间重叠）', () => {
    expect(TOON_RAMP.stops.map((s) => s.name)).toEqual(['shadow', 'lit', 'spec']);
    const lit = stopOf(TOON_RAMP, 'lit');
    const spec = stopOf(TOON_RAMP, 'spec');
    expect(spec.range[0]).toBeGreaterThan(lit.range[0]);
    expect(spec.range[1]).toBe(lit.range[1]);
  });

  it('与 grading 共用同一套 core 色，解析结果一致', () => {
    expect(stopOf(TOON_RAMP, 'shadow').mixToHex).toBe('#0E0C16');
    expect(stopOf(TOON_RAMP, 'spec').mixToHex).toBe('#FFF6E2');
  });
});

describe('C. roster 解析规则', () => {
  it('共 8 个角色：npc 5 + boss 3，id 唯一', () => {
    expect(ROSTER_CHARACTERS).toHaveLength(8);
    expect(ROSTER_CHARACTERS.filter((c) => c.kind === 'npc')).toHaveLength(5);
    expect(ROSTER_CHARACTERS.filter((c) => c.kind === 'boss')).toHaveLength(3);
    expect(new Set(ROSTER_CHARACTERS.map((c) => c.id)).size).toBe(8);
  });

  it('简单身高串取数值', () => {
    expect(requireCharacter('E-01').heightMeters).toBe(1.75);
    expect(requireCharacter('B-01').heightMeters).toBe(3.2);
  });

  it('复合身高串取第一个数值（基准姿态），原始串原样保留不丢信息', () => {
    const e02 = requireCharacter('E-02');
    expect(e02.heightRaw).toBe('1.25 m（四足）/ 1.60 m（直立）');
    expect(e02.heightMeters).toBe(1.25);

    const b02 = requireCharacter('B-02');
    expect(b02.heightRaw).toBe('4.0 m（上半身 2.4 m）');
    expect(b02.heightMeters).toBe(4);

    const e05 = requireCharacter('E-05');
    expect(e05.heightRaw).toBe('1.60 m / 直径 1.50 m');
    expect(e05.heightMeters).toBe(1.6);
  });

  it('速度取第一个数值，括号内的冲锋速度不取', () => {
    const b01 = requireCharacter('B-01');
    expect(b01.speedRaw).toBe('2.2 m/s（冲锋 9 m/s）');
    expect(b01.speedMps).toBe(2.2);
  });

  it('B-02 明示不可移动 → speedMps 为 null，而不是编一个 0', () => {
    const b02 = requireCharacter('B-02');
    expect(b02.speedRaw).toBe('本体固定不可移动');
    expect(b02.speedMps).toBeNull();
  });

  it('所有身高落在 1~5 m 的合理区间（解析跑飞会挂）', () => {
    for (const c of ROSTER_CHARACTERS) {
      expect(c.heightMeters, c.id).toBeGreaterThan(1);
      expect(c.heightMeters, c.id).toBeLessThan(5);
    }
  });

  it('requireCharacter 取不存在的 id 抛错（不给 undefined 让 bug 潜伏）', () => {
    expect(() => requireCharacter('E-99')).toThrow(/E-99/);
  });
});
