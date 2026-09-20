/**
 * 刷怪点编辑面板（WU-5）—— **最小控件**，不是通用 Inspector。
 *
 * ## 边界
 *
 * 本模块只做两件事：把 `SpawnPanelVm` 画成 DOM，把用户动作转成 `SpawnPanelHooks` 回调。
 * **不持有任何状态、不做校验、不碰文档**：校验在 `SpawnEditStore`，文档在 store 里，
 * 保存与重跑在 main.ts。这不是洁癖 —— 面板一旦开始"自己记一份当前值"，就会出现
 * 「面板显示 8、场景里其实还是 3」这种只有刷页面才复现的错位。
 *
 * ## 为什么只画两个字段
 *
 * docs/17 WU-5：「默认选择已有 SpawnPoint.radius 作为本轮编辑参数，
 * **显示"生成散布半径（米）"，不要误作角色碰撞半径**。使用已有 count 作为补充可选项。」
 * label 直接照抄这句 —— 这个字段太容易被读成碰撞半径。
 */

import type { NodeId } from '@aether/scene';
import type { SpawnPointSummary } from '@aether/runtime';

/** Play 中选中的运行实体（来源刷怪点 / 当前目标 / 行为状态） */
export interface SpawnEntityInfo {
  characterId: string;
  sourceNodeId: NodeId | null;
  targetId: number;
  behavior: number;
  x: number;
  z: number;
}

export type SpawnMessageKind = 'info' | 'warn' | 'ok';

/** 面板的完整输入。每次状态变化由 main.ts 重算一份整传进来（无增量更新） */
export interface SpawnPanelVm {
  scenePath: string | null;
  spawns: SpawnPointSummary[];
  selectedNodeId: NodeId | null;
  entity: SpawnEntityInfo | null;
  dirty: boolean;
  undoDepth: number;
  message: string | null;
  messageKind: SpawnMessageKind;
  /** A/B 指标行（before → after），空数组 = 还没做过对比 */
  abLines: string[];
  /** 参与对比的刷怪点里，本次有变化的个数 / 总数 */
  abSummary: string | null;
  playing: boolean;
}

export interface SpawnPanelHooks {
  onSelect(nodeId: NodeId | null): void;
  onEdit(field: 'radius' | 'count', value: number): void;
  onUndo(): void;
  onSave(): void;
  onRerun(): void;
  /** 定位到当前选中实体的来源刷怪点节点 */
  onFocusSource(): void;
}

const BEHAVIOR_TEXT: Record<number, string> = { 0: '待机 idle', 1: '追击 chase' };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class SpawnPanel {
  private readonly pick: HTMLSelectElement;
  private readonly radius: HTMLInputElement;
  private readonly countInput: HTMLInputElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly rerunBtn: HTMLButtonElement;
  private readonly focusBtn: HTMLButtonElement;
  private readonly entityBox: HTMLElement;
  private readonly msgBox: HTMLElement;
  private readonly abBox: HTMLElement;
  private readonly abSummaryBox: HTMLElement;
  private readonly dirtyTag: HTMLElement;
  private readonly pathBox: HTMLElement;

  constructor(host: HTMLElement, private readonly hooks: SpawnPanelHooks) {
    host.innerHTML = `
      <div class="sp-wrap">
        <div class="sp-head">
          <b>刷怪点编辑</b>
          <span class="sp-tag" data-sp="dirty"></span>
        </div>
        <div class="sp-path" data-sp="path"></div>
        <div class="sp-sec">
          <div class="sp-lab">选中实体（Play 中点僵尸）</div>
          <div class="sp-body" data-sp="entity"></div>
        </div>
        <div class="sp-sec">
          <div class="sp-lab">刷怪点</div>
          <select class="sp-sel" data-sp="pick"></select>
          <div class="sp-row">
            <label for="sp-radius">生成散布半径（米）</label>
            <input class="sp-num" type="number" step="0.25" min="0" max="50" data-sp="radius" id="sp-radius">
          </div>
          <div class="sp-row">
            <label for="sp-count">生成数量</label>
            <input class="sp-num" type="number" step="1" min="0" max="200" data-sp="count" id="sp-count">
          </div>
          <div class="sp-btns">
            <button class="sp-btn" data-sp="undo">↶ 撤销</button>
            <button class="sp-btn accent" data-sp="save">保存</button>
            <button class="sp-btn" data-sp="rerun">↻ 重跑</button>
            <button class="sp-btn" data-sp="focus">⌖ 定位来源</button>
          </div>
          <div class="sp-msg" data-sp="msg"></div>
        </div>
        <div class="sp-sec">
          <div class="sp-lab">A/B · 同种子初始散布</div>
          <div class="sp-absum" data-sp="absum"></div>
          <div class="sp-ab" data-sp="ab"></div>
        </div>
      </div>`;

    const q = <T extends HTMLElement>(key: string): T => {
      const el = host.querySelector<HTMLElement>(`[data-sp="${key}"]`);
      if (el === null) throw new Error(`刷怪点面板缺少节点 data-sp="${key}"`);
      return el as T;
    };

    this.pick = q<HTMLSelectElement>('pick');
    this.radius = q<HTMLInputElement>('radius');
    this.countInput = q<HTMLInputElement>('count');
    this.undoBtn = q<HTMLButtonElement>('undo');
    this.saveBtn = q<HTMLButtonElement>('save');
    this.rerunBtn = q<HTMLButtonElement>('rerun');
    this.focusBtn = q<HTMLButtonElement>('focus');
    this.entityBox = q('entity');
    this.msgBox = q('msg');
    this.abBox = q('ab');
    this.abSummaryBox = q('absum');
    this.dirtyTag = q('dirty');
    this.pathBox = q('path');

    // `change` 而不是 `input`：边打字边应用会把撤销栈灌满（每敲一个字符一次编辑）
    this.pick.addEventListener('change', () => {
      this.hooks.onSelect(this.pick.value === '' ? null : this.pick.value);
    });
    this.radius.addEventListener('change', () => this.hooks.onEdit('radius', Number(this.radius.value)));
    this.countInput.addEventListener('change', () => this.hooks.onEdit('count', Number(this.countInput.value)));
    this.undoBtn.addEventListener('click', () => this.hooks.onUndo());
    this.saveBtn.addEventListener('click', () => this.hooks.onSave());
    this.rerunBtn.addEventListener('click', () => this.hooks.onRerun());
    this.focusBtn.addEventListener('click', () => this.hooks.onFocusSource());
  }

  /** 整量重绘。面板不 diff —— 状态全在 main.ts 的 store 里，重绘永远与真源一致 */
  render(vm: SpawnPanelVm): void {
    this.pathBox.textContent = vm.scenePath === null ? '未载入场景文件' : vm.scenePath;

    this.dirtyTag.textContent = vm.dirty ? `未保存 ${vm.undoDepth} 处` : '已保存';
    this.dirtyTag.classList.toggle('dirty', vm.dirty);

    // ---- 选中实体 ----
    if (vm.entity === null) {
      this.entityBox.innerHTML =
        vm.playing
          ? '<span class="sp-dim">点画面里的僵尸查看它的来源刷怪点</span>'
          : '<span class="sp-dim">进入 Play 后可选中运行实体</span>';
    } else {
      const e = vm.entity;
      this.entityBox.innerHTML =
        `<div class="sp-kv"><span>角色</span><b>${esc(e.characterId)}</b></div>` +
        `<div class="sp-kv"><span>来源刷怪点</span><b>${esc(e.sourceNodeId ?? '—')}</b></div>` +
        `<div class="sp-kv"><span>当前目标</span><b>${e.targetId >= 0 ? `#${e.targetId}` : '—'}</b></div>` +
        `<div class="sp-kv"><span>状态</span><b>${esc(BEHAVIOR_TEXT[e.behavior] ?? String(e.behavior))}</b></div>` +
        `<div class="sp-kv"><span>位置</span><b>${e.x.toFixed(2)}, ${e.z.toFixed(2)}</b></div>`;
    }

    // ---- 刷怪点下拉 ----
    const keep = vm.selectedNodeId;
    this.pick.innerHTML = vm.spawns
      .map(
        (s) =>
          `<option value="${esc(s.nodeId)}"${s.nodeId === keep ? ' selected' : ''}>` +
          `${esc(s.name || s.nodeId)} · ${esc(s.characterId)} ×${s.count} · r=${s.radius}` +
          `</option>`,
      )
      .join('');
    if (vm.spawns.length === 0) {
      this.pick.innerHTML = '<option value="">（场景里没有 SpawnPoint）</option>';
    }

    const sel = vm.spawns.find((s) => s.nodeId === vm.selectedNodeId) ?? null;
    // 正在输入时不要覆盖控件值：否则用户敲 "1" 想接着敲 "2"，被回填成 "1" 的光标跳走
    if (document.activeElement !== this.radius) {
      this.radius.value = sel === null ? '' : String(sel.radius);
    }
    if (document.activeElement !== this.countInput) {
      this.countInput.value = sel === null ? '' : String(sel.count);
    }
    const has = sel !== null;
    this.radius.disabled = !has;
    this.countInput.disabled = !has;

    this.undoBtn.disabled = vm.undoDepth === 0;
    this.saveBtn.disabled = !vm.dirty;
    this.rerunBtn.disabled = false;
    this.focusBtn.disabled = vm.entity === null || vm.entity.sourceNodeId === null;

    this.msgBox.textContent = vm.message ?? '';
    this.msgBox.className = `sp-msg ${vm.message === null ? '' : vm.messageKind}`;

    this.abSummaryBox.textContent = vm.abSummary ?? '';
    this.abBox.innerHTML =
      vm.abLines.length === 0
        ? '<span class="sp-dim">改一次参数就会自动抓 A/B（同种子重跑，只比初始散布）</span>'
        : vm.abLines.map((l) => `<div class="sp-abline${l.includes('[已改]') ? ' changed' : ''}">${esc(l)}</div>`).join('');
  }
}
