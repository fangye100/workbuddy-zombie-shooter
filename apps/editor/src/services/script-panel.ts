/**
 * Script 组件 Inspector 面板（ADR-018 P2）。
 *
 * ## 这一层是 R2「契约面」的落地点
 *
 * Agent 在 `assets/behaviors/*.ts` 里写逻辑，靠 `BehaviorDef.params` 的 schema
 * 把可调项暴露出来。本面板按 schema 画控件，**不改一行代码就能显示新行为的新参数**。
 *
 * ## 纪律
 *
 * - **面板不持有状态**：每次改动由调用方重算并重绘，杜绝「面板显示 8、场景里还是 3」
 *   这种只有刷新才复现的错位（与 SpawnPanel 同一约定）。
 * - 用 `change` 而不是 `input`：边打字边应用会把撤销栈灌满（每敲一个字符一次编辑）。
 * - 行为未注册时**明确显示降级**，不画一个沉默的空面板——否则用户以为参数没保存。
 */

import type { BehaviorRegistry, BehaviorParamSchema, BehaviorScalar, ScriptComponent } from '@aether/scene';
import { escapeHtml, paramsPanelHtml, parseControlValue } from './behavior-controls';

export interface ScriptPanelOptions {
  registry: BehaviorRegistry;
  /** 参数改动回调。index 是 Script 组件在节点上的序号（Script 允许重复挂载） */
  onChange: (index: number, params: Record<string, BehaviorScalar>) => void;
  /**
   * 只读态。**当前必须为 true**——保存链路的白名单只覆盖 SpawnPoint 的
   * radius/count，Script 参数改了不会进 diffs、也就不会落盘。
   * 与其让控件看起来能改却存不下去（刷新就回原值，极难排查），不如置灰并说明。
   * 待 spawn-edit 支持通用组件编辑后可放开。
   */
  readonly?: boolean;
}

/**
 * 按 schema 的 kind 把 DOM 值转回 BehaviorScalar。
 *
 * 转换本体在 `parseControlValue`（纯函数，可单测），这里只负责从 DOM 取原始值。
 */
function readValue(
  schema: BehaviorParamSchema,
  el: HTMLInputElement | HTMLSelectElement,
): BehaviorScalar {
  const raw: string | boolean =
    el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
  return parseControlValue(schema.kind, raw);
}

export class ScriptPanel {
  private readonly host: HTMLElement;
  private readonly opts: ScriptPanelOptions;
  private scripts: readonly ScriptComponent[] = [];

  constructor(host: HTMLElement, opts: ScriptPanelOptions) {
    this.host = host;
    this.opts = opts;
    // 事件委托：面板会被反复重绘，逐个绑定容易漏/重复绑
    this.host.addEventListener('change', this.onChangeEvent);
    // range 滑块在拖动时同步数字框（不提交，提交仍走数字框的 change）
    this.host.addEventListener('input', this.onInputEvent);
  }

  /** 渲染一组 Script 组件 */
  render(scripts: readonly ScriptComponent[]): void {
    this.scripts = scripts;
    if (scripts.length === 0) {
      this.host.innerHTML = '';
      this.host.classList.add('bh-hidden');
      return;
    }
    this.host.classList.remove('bh-hidden');
    this.host.innerHTML = scripts.map((s, i) => this.renderOne(s, i)).join('');
  }

  private renderOne(s: ScriptComponent, index: number): string {
    const def = this.opts.registry.get(s.behavior);
    const head =
      `<div class="bh-head">` +
      `<span class="bh-id">${escapeHtml(s.behavior)}</span>` +
      (def !== undefined ? `<span class="bh-name">${escapeHtml(def.label)}</span>` : '') +
      `</div>`;

    if (def === undefined) {
      // 🔴 行为未注册：明确告知会降级为空操作，不能画个沉默的空面板
      return (
        `<div class="bh-script bh-missing" data-bh-index="${index}">${head}` +
        `<div class="bh-warn">行为未注册，该脚本在 Play 中降级为空操作` +
        `（可能已删除或尚未被收集）。</div></div>`
      );
    }

    // 按 schema 修正后渲染：场景里存了脏值也按合法值显示（与 resolve 一致）
    const resolved = this.opts.registry.resolve(s.behavior, s.params);
    const ro = this.opts.readonly === true;
    return (
      `<div class="bh-script" data-bh-index="${index}">${head}` +
      (ro ? `<div class="bh-ro">只读：保存链路暂未覆盖脚本参数，改了不会落盘</div>` : '') +
      paramsPanelHtml(def, resolved.params, ro) +
      `</div>`
    );
  }

  private readonly onChangeEvent = (e: Event): void => {
    if (this.opts.readonly === true) return; // 只读态不接受编辑
    const el = e.target;
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) return;
    const key = el.getAttribute('data-bh');
    if (key === null) return;
    const wrap = el.closest('.bh-script');
    const idxAttr = wrap?.getAttribute('data-bh-index');
    if (idxAttr === null || idxAttr === undefined) return;
    const index = Number.parseInt(idxAttr, 10);
    const script = this.scripts[index];
    if (script === undefined) return;

    const def = this.opts.registry.get(script.behavior);
    if (def === undefined) return;
    const schema = def.params.find((p) => p.key === key);
    if (schema === undefined) return;

    const next: Record<string, BehaviorScalar> = { ...script.params };
    next[key] = readValue(schema, el);
    this.opts.onChange(index, next);
  };

  /** range 拖动时把值同步到同参数的数据框（不提交） */
  private readonly onInputEvent = (e: Event): void => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'range') return;
    const key = el.getAttribute('data-bh-range');
    if (key === null) return;
    const wrap = el.parentElement;
    if (wrap === null) return;
    const num = wrap.querySelector<HTMLInputElement>(`input[data-bh="${key}"]`);
    if (num !== null) num.value = el.value;
  };

  dispose(): void {
    this.host.removeEventListener('change', this.onChangeEvent);
    this.host.removeEventListener('input', this.onInputEvent);
  }
}
