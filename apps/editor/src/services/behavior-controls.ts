/**
 * 行为参数控件渲染（ADR-018 P2）——**纯函数，不碰 DOM**。
 *
 * ## 为什么做成纯函数
 *
 * 项目 vitest 环境是 `node`，**没有 jsdom**（docs/19 §1 已列为已知限制），
 * 面板逻辑没法在单测里挂载 DOM。所以这里只负责「schema + 值 → HTML 字符串」，
 * 事件绑定由 `behavior-panel.ts`（宿主侧）负责。这样控件渲染本身是可单测的。
 *
 * ## 这层就是 ADR-018 R2 的「契约面」
 *
 * Agent 在 `assets/behaviors/*.ts` 里写逻辑（不受 UI 限制），
 * 靠 `BehaviorDef.params` 的 schema 把可调项**反向暴露**给人类。
 * 人类在 Inspector 上看到的就是 Agent 声明的那几个旋钮——
 * 多一个 schema 项就多一个控件，不改这里的代码。
 *
 * ## 类名前缀
 *
 * 一律 `bh-`。**禁止 `ad-` / `adk-`**——那是广告拦截过滤列表的头号命中模式，
 * 会被注入 `display:none !important` 让整个面板在装了拦截插件的浏览器里消失
 * （见 `tools/verify/guard-classprefix.mjs`）。
 *
 * ## 安全
 *
 * 本函数产出的 HTML 会被 `innerHTML` 注入 DOM，而参数值**来自场景 JSON**
 * （可能是下载的第三方场景）。所有插值一律转义，绝不裸拼。
 */

import type { BehaviorDef, BehaviorParamSchema, BehaviorScalar } from '@aether/scene';

/** HTML 转义。场景 JSON 不可信，任何插值前都必须过这一道 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把值转成控件需要的字符串形态 */
function asString(v: BehaviorScalar | undefined): string {
  if (v === undefined || v === null) return '';
  return String(v);
}

/**
 * 单个参数的控件 HTML。
 *
 * 每种 kind 对应一种控件（ADR-017 要求覆盖八种）：
 *   number → number 输入（有 min/max 时附加 range 滑块）
 *   int    → number 输入 + step=1
 *   bool   → checkbox
 *   string → 文本输入
 *   color  → color 拾取器
 *   nodeRef → 文本输入（NodeId）+ 提示
 *   assetRef → 文本输入（资产路径）+ 提示
 *   enum   → select 下拉
 */
export function controlHtml(schema: BehaviorParamSchema, value: BehaviorScalar | undefined): string {
  const key = escapeHtml(schema.key);
  const v = asString(value);
  const hint = schema.hint !== undefined ? ` title="${escapeHtml(schema.hint)}"` : '';

  switch (schema.kind) {
    case 'bool': {
      const checked = value === true ? ' checked' : '';
      return `<input class="bh-bool" type="checkbox" data-bh="${key}"${checked}${hint}>`;
    }
    case 'enum': {
      const opts = schema.options ?? [];
      const items = opts
        .map(
          (o) =>
            `<option value="${escapeHtml(o)}"${o === v ? ' selected' : ''}>${escapeHtml(o)}</option>`,
        )
        .join('');
      // 没有候选值时不能画出空下拉——注册期已报 SCHEMA_INVALID，这里给可见的占位
      const body =
        opts.length > 0 ? items : `<option value="">(该 enum 未声明候选值)</option>`;
      return `<select class="bh-enum" data-bh="${key}"${hint}>${body}</select>`;
    }
    case 'color': {
      // input[type=color] 只接受 #rrggbb；其余原样退回文本框，避免浏览器把它洗成黑
      const isHex = /^#[0-9a-fA-F]{6}$/.test(v);
      if (isHex || v === '') {
        return `<input class="bh-color" type="color" data-bh="${key}" value="${escapeHtml(isHex ? v : '#000000')}"${hint}>`;
      }
      return `<input class="bh-color-text" type="text" data-bh="${key}" value="${escapeHtml(v)}"${hint}>`;
    }
    case 'int':
    case 'number': {
      const step = schema.kind === 'int' ? '1' : (schema.step !== undefined ? String(schema.step) : 'any');
      const min = schema.min !== undefined ? ` min="${schema.min}"` : '';
      const max = schema.max !== undefined ? ` max="${schema.max}"` : '';
      const attrs = `class="bh-num" type="number" data-bh="${key}" value="${escapeHtml(v)}" step="${step}"${min}${max}${hint}`;
      // 有明确区间时额外给一个 range 滑块：滑块调手感，数字框保精度
      if (schema.min !== undefined && schema.max !== undefined) {
        const rmin = String(schema.min);
        const rmax = String(schema.max);
        const rstep = schema.kind === 'int' ? '1' : (schema.step !== undefined ? String(schema.step) : String((schema.max - schema.min) / 100));
        return (
          `<input ${attrs}>` +
          `<input class="bh-range" type="range" data-bh-range="${key}" value="${escapeHtml(v)}" min="${rmin}" max="${rmax}" step="${rstep}"${hint}>`
        );
      }
      return `<input ${attrs}>`;
    }
    case 'nodeRef':
    case 'assetRef':
    case 'string':
    default: {
      const placeholder =
        schema.kind === 'nodeRef' ? '节点 id' : schema.kind === 'assetRef' ? '资产路径' : '';
      const ph = placeholder !== '' ? ` placeholder="${escapeHtml(placeholder)}"` : '';
      return `<input class="bh-text" type="text" data-bh="${key}" value="${escapeHtml(v)}"${ph}${hint}>`;
    }
  }
}

/**
 * 把控件的原始值转回 `BehaviorScalar`（纯函数，**不碰 DOM**）。
 *
 * 抽出来是为了可测：`script-panel.ts` 里的事件回调依赖 DOM，在 node 环境的
 * vitest 里跑不了，而"字符串 → int/number/bool"的转换恰恰是最容易出错的地方。
 *
 * @param kind  参数的 kind
 * @param raw   控件的原始值（checkbox 传 boolean，其余传字符串）
 */
export function parseControlValue(
  kind: BehaviorParamSchema['kind'],
  raw: string | boolean,
): BehaviorScalar {
  if (typeof raw === 'boolean') return raw;
  switch (kind) {
    case 'int': {
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    }
    case 'number': {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : 0;
    }
    case 'bool':
      return raw === 'true' || raw === 'on';
    default:
      return raw;
  }
}

/**
 * 把整段控件 HTML 里的 input/select 全部置灰。
 *
 * 用于"能看不能改"的只读态——**宁可置灰也不要让控件看起来能改却存不下去**：
 * 那是最难查的一类假象（用户以为改了，刷新一看还在原值）。
 */
export function disableControls(html: string): string {
  return html.replace(/<(input|select|textarea)\b/g, '<$1 disabled');
}

/**
 * 整个行为参数面板的 HTML（label + 控件 + hint）。
 *
 * 没有可调参数时给出明确说明，而不是画一个空面板让人以为坏了。
 *
 * @param readonly 只读态。为 true 时所有控件置灰（见 `disableControls`）。
 */
export function paramsPanelHtml(
  def: BehaviorDef,
  params: Readonly<Record<string, BehaviorScalar>>,
  readonly = false,
): string {
  if (def.params.length === 0) {
    return (
      `<div class="bh-empty">行为「${escapeHtml(def.label)}」没有可调参数` +
      `（schema 未声明 params）。</div>`
    );
  }
    const rows = def.params
    .map((s) => {
      const v = Object.prototype.hasOwnProperty.call(params, s.key) ? params[s.key] : s.default;
      const label = `<label class="bh-label" for="bh-${escapeHtml(s.key)}">${escapeHtml(s.label)}</label>`;
      const raw = controlHtml(s, v);
      const ctl = readonly ? disableControls(raw) : raw;
      const hint =
        s.hint !== undefined ? `<div class="bh-hint">${escapeHtml(s.hint)}</div>` : '';
      return `<div class="bh-row">${label}<div class="bh-ctl">${ctl}${hint}</div></div>`;
    })
    .join('');
  return `<div class="bh-panel">${rows}</div>`;
}
