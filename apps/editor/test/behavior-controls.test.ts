/**
 * 行为参数控件渲染测试（ADR-018 P2）。
 *
 * 纯字符串断言——项目 vitest 环境是 node、无 jsdom，所以控件层刻意做成
 * 返回 HTML 字符串的纯函数，这样渲染逻辑本身可测。
 */

import { describe, expect, it } from 'vitest';
import {
  controlHtml,
  disableControls,
  escapeHtml,
  paramsPanelHtml,
  parseControlValue,
} from '../src/services/behavior-controls';
import type { BehaviorDef, BehaviorParamSchema } from '@aether/scene';

function schema(p: Partial<BehaviorParamSchema> & { key: string; kind: BehaviorParamSchema['kind'] }): BehaviorParamSchema {
  return { label: p.key, default: '', ...p } as BehaviorParamSchema;
}

describe('escapeHtml', () => {
  it('转义 HTML 特殊字符（场景 JSON 不可信，防注入）', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(escapeHtml(`a"b'c&d`)).toBe('a&quot;b&#39;c&amp;d');
  });
});

describe('controlHtml · 八种控件', () => {
  it('int → number 输入 + step=1', () => {
    const html = controlHtml(schema({ key: 'n', kind: 'int', default: 8, min: 1, max: 50 }), 12);
    expect(html).toContain('type="number"');
    expect(html).toContain('step="1"');
    expect(html).toContain('value="12"');
    expect(html).toContain('data-bh="n"');
  });

  it('number 有明确区间时，除数字框外额外给 range 滑块', () => {
    const html = controlHtml(
      schema({ key: 't', kind: 'number', default: 1.5, min: 0.1, max: 10 }),
      2,
    );
    expect(html).toContain('type="number"');
    expect(html).toContain('class="bh-range"');
    expect(html).toContain('type="range"');
  });

  it('number 无区间时不画 range（没法给滑块定界）', () => {
    const html = controlHtml(schema({ key: 't', kind: 'number', default: 1 }), 1);
    expect(html).not.toContain('type="range"');
  });

  it('bool → checkbox，值 true 时 checked', () => {
    expect(controlHtml(schema({ key: 'b', kind: 'bool', default: false }), true)).toContain(
      'checked',
    );
    const off = controlHtml(schema({ key: 'b', kind: 'bool', default: true }), false);
    expect(off).toContain('type="checkbox"');
    expect(off).not.toContain('checked');
  });

  it('string → 文本输入，值被转义', () => {
    const html = controlHtml(schema({ key: 's', kind: 'string', default: 'x' }), 'a<b');
    expect(html).toContain('type="text"');
    expect(html).toContain('value="a&lt;b"');
    expect(html).not.toContain('value="a<b"');
  });

  it('color 是 #rrggbb → color 拾取器', () => {
    expect(controlHtml(schema({ key: 'c', kind: 'color', default: '#ff0000' }), '#00ff00')).toContain(
      'type="color"',
    );
  });

  it('color 非 hex 字面量 → 退回文本框（避免浏览器把它洗成黑）', () => {
    const html = controlHtml(schema({ key: 'c', kind: 'color', default: 'red' }), 'red');
    expect(html).toContain('type="text"');
    expect(html).not.toContain('type="color"');
  });

  it('enum → select，候选全在且当前值 selected', () => {
    const html = controlHtml(
      schema({ key: 'm', kind: 'enum', default: 'burst', options: ['burst', 'drip'] }),
      'drip',
    );
    expect(html).toContain('<select');
    expect(html).toContain('<option value="burst"');
    // 只有 drip 带 selected
    expect(html).toContain('<option value="drip" selected>');
    expect(html).not.toContain('<option value="burst" selected>');
  });

  it('enum 无候选 → 画可见占位而不是空下拉', () => {
    const html = controlHtml(schema({ key: 'm', kind: 'enum', default: 'a' }), 'a');
    expect(html).toContain('未声明候选值');
  });

  it('nodeRef / assetRef → 文本输入 + 对应占位提示', () => {
    expect(controlHtml(schema({ key: 'n', kind: 'nodeRef', default: '' }), '')).toContain(
      '节点 id',
    );
    expect(controlHtml(schema({ key: 'a', kind: 'assetRef', default: '' }), '')).toContain(
      '资产路径',
    );
  });

  it('hint 渲染为 title（悬浮说明）', () => {
    const html = controlHtml(
      schema({ key: 's', kind: 'string', default: '', hint: '这是提示' }),
      '',
    );
    expect(html).toContain('title="这是提示"');
  });
});

describe('parseControlValue · 控件值 → BehaviorScalar', () => {
  it('int 走 parseInt（小数字符串被截断为整数，不是四舍五入）', () => {
    expect(parseControlValue('int', '12')).toBe(12);
    expect(parseControlValue('int', '3.7')).toBe(3);
  });

  it('number 走 parseFloat', () => {
    expect(parseControlValue('number', '1.5')).toBe(1.5);
    expect(parseControlValue('number', '2')).toBe(2);
  });

  it('int/number 遇到非数字兜底为 0，不产出 NaN', () => {
    expect(parseControlValue('int', 'abc')).toBe(0);
    expect(parseControlValue('number', '')).toBe(0);
    expect(Number.isNaN(parseControlValue('int', 'x'))).toBe(false);
  });

  it('bool 接受 boolean（checkbox）与字符串（select）两种来源', () => {
    expect(parseControlValue('bool', true)).toBe(true);
    expect(parseControlValue('bool', false)).toBe(false);
    expect(parseControlValue('bool', 'true')).toBe(true);
    expect(parseControlValue('bool', 'on')).toBe(true); // HTML checkbox 的默认 value
    // 只有 'true' / 'on' 判真，'false' 必须判假——否则字符串 'false' 会被读成真
    expect(parseControlValue('bool', 'false')).toBe(false);
    expect(parseControlValue('bool', '')).toBe(false);
  });

  it('string/color/nodeRef/assetRef/enum 原样返回字符串', () => {
    expect(parseControlValue('string', 'hello')).toBe('hello');
    expect(parseControlValue('enum', 'drip')).toBe('drip');
    expect(parseControlValue('nodeRef', 'node-7')).toBe('node-7');
  });

  it('往返一致性：常见值 parse 后仍等于原值', () => {
    for (const [kind, v] of [
      ['int', '8'],
      ['number', '1.5'],
      ['string', 'abc'],
      ['enum', 'burst'],
    ] as const) {
      expect(parseControlValue(kind, v)).toBe(v === '8' ? 8 : v === '1.5' ? 1.5 : v);
    }
  });
});

describe('disableControls · 只读态置灰', () => {
  it('给 input / select / textarea 都加上 disabled', () => {
    const out = disableControls('<input type="text"><select></select><textarea></textarea>');
    expect(out).toContain('<input disabled');
    expect(out).toContain('<select disabled');
    expect(out).toContain('<textarea disabled');
  });

  it('幂等：重复调用不会叠加 disabled', () => {
    const once = disableControls('<input type="text">');
    const twice = disableControls(once);
    expect(twice.match(/disabled/g)?.length).toBe(1);
  });

  it('🔴 class / data-* 里的 "disabled" 字样不算属性，仍要置灰', () => {
    // 只看"有没有这个词"会误判，导致只读态静默停止置灰（看起来置灰其实没有）
    expect(disableControls('<input class="bh-disabled">')).toBe(
      '<input disabled class="bh-disabled">',
    );
    expect(disableControls('<input data-mode="disabled-mode">')).toContain('<input disabled');
  });

  it('只作用于控件标签，不误伤 label / div', () => {
    const out = disableControls('<div class="bh-row"><label>数量</label><input type="number"></div>');
    expect(out).not.toContain('<div disabled');
    expect(out).not.toContain('<label disabled');
    expect(out).toContain('<input disabled');
  });
});

describe('paramsPanelHtml · readonly 参数', () => {
  const def: BehaviorDef = {
    id: 'ro',
    label: '只读示例',
    params: [
      { key: 'n', label: '数量', kind: 'int', default: 8, min: 1, max: 50 },
      { key: 'm', label: '模式', kind: 'enum', default: 'a', options: ['a', 'b'] },
    ],
  };

  it('readonly=true → 产出含 disabled；readonly=false → 不含', () => {
    expect(paramsPanelHtml(def, {}, true)).toContain('disabled');
    expect(paramsPanelHtml(def, {}, false)).not.toContain('disabled');
  });

  it('默认（不传）是可编辑态，避免调用方忘了传就变成只读', () => {
    expect(paramsPanelHtml(def, {})).not.toContain('disabled');
  });

  it('🔴 只读态下仍要显示参数值（置灰 ≠ 不显示）', () => {
    const ro = paramsPanelHtml(def, { n: 12, m: 'b' }, true);
    expect(ro).toContain('value="12"');
    expect(ro).toContain('<option value="b" selected>');
  });
});

describe('paramsPanelHtml', () => {
  const def: BehaviorDef = {
    id: 'demo',
    label: '示例行为',
    params: [
      { key: 'count', label: '数量', kind: 'int', default: 8, min: 1, max: 50 },
      { key: 'mode', label: '模式', kind: 'enum', default: 'burst', options: ['burst', 'drip'] },
    ],
  };

  it('每个 schema 项画一行，含 label 与控件', () => {
    const html = paramsPanelHtml(def, { count: 12, mode: 'drip' });
    expect(html).toContain('class="bh-row"');
    expect(html).toContain('数量');
    expect(html).toContain('data-bh="count"');
    expect(html).toContain('模式');
    expect(html).toContain('data-bh="mode"');
  });

  it('场景未存该参数时用 schema 的 default 填充', () => {
    const html = paramsPanelHtml(def, {});
    expect(html).toContain('value="8"'); // default
    expect(html).toContain('<option value="burst" selected>'); // default
  });

  it('无可调参数时给明确说明，而不是空面板', () => {
    const html = paramsPanelHtml({ id: 'x', label: '零参数', params: [] }, {});
    expect(html).toContain('没有可调参数');
    expect(html).not.toContain('class="bh-row"');
  });

  it('label 里的 HTML 被转义（防第三方场景注入）', () => {
    const evil: BehaviorDef = {
      id: 'evil',
      label: '<img src=x onerror=alert(1)>',
      params: [{ key: 'a', label: '<script>x</script>', kind: 'string', default: '' }],
    };
    const html = paramsPanelHtml(evil, {});
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
    expect(html).toContain('&lt;script&gt;');
  });
});
