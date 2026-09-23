/**
 * retarget-workbench.ts —— 重定向工作台面板（MR-06 的呈现层）。
 *
 * 布局按对话定稿的 UX 骨架（顶部流程与状态 / 中央源·目标同步预览 / 右侧
 * 标定·动作适配·质量结果 / 底部接触时间轴与问题帧 / 操作区生成·应用·导出）。
 *
 * 分层纪律（与 BindingPanel 同构）：面板不认识渲染器、不认识 session 实现，
 * 只消费 `RetargetWorkbenchState` 快照 + 回调；状态判定（通过/部分完成/失败/待更新）
 * 与同一版本守门全部在 session 侧，面板只渲染，不重算业务规则。
 *
 * 时间轴：支撑段按标记分行画条（support=绿、slide/roll=黄、标注未兑现=描边），
 * 问题帧来自逐约束残差段与带帧号的诊断；点击跳帧、可播放。
 */

import { t } from '../../i18n';
import type {
  RetargetSessionSummary,
  RetargetSourceInfo,
} from './retarget-session';

export interface RetargetWorkbenchState {
  summary: RetargetSessionSummary;
  source: RetargetSourceInfo | null;
  /** 当前预览帧下标 */
  frame: number;
  /** 源骨架正视投影片段 [x1,y1,x2,y2]（米，规范世界系）；null = 无源帧 */
  sourceSegments: ReadonlyArray<readonly [number, number, number, number]> | null;
  /** 目标骨架正视投影片段；null = 无解帧 */
  targetSegments: ReadonlyArray<readonly [number, number, number, number]> | null;
  /** 目标接触标记 [x, y, label]（米） */
  markers: ReadonlyArray<readonly [number, number, string]>;
  /** 两视口统一的包围盒（同尺度对比；null = 无内容） */
  bounds: { minX: number; maxX: number; minY: number; maxY: number } | null;
  /** 目标支撑平面高度（世界 Y，米；目标视口的地线画这里；null = 未设目标） */
  groundY: number | null;
  canApply: boolean;
  canExport: boolean;
  /** 入口 A/B：A=绑定面板（导出动画），B=场景物体（应用到角色） */
  entry: 'binding' | 'object';
  /** 源标定 sidecar 路径（保存/载入用；编辑即回传） */
  calSrcPath: string;
  /** 目标标定 sidecar 路径；空串 = 该入口无 sidecar（保存禁用） */
  calTgtPath: string;
  /** 最近一次载入失败等信息（保留上一份结果的提示）；null = 无 */
  notice: string | null;
}

export interface RetargetWorkbenchHooks {
  onLoadBvh(): void;
  onSolve(): void;
  onApply(): void;
  onExport(): void;
  onSpaceModeChange(mode: 'normalize-gait' | 'preserve-world'): void;
  /** 纠正源的动作位移声明（invalidated → 待更新） */
  onRootMotionChange(mode: 'auto' | 'world-trajectory' | 'in-place-with-trajectory'): void;
  /** 标定 sidecar 动作：load = 读入会话；save = 写回 sidecar */
  onCalAction(side: 'source' | 'target', action: 'load' | 'save', path: string): void;
  /** 标定路径输入变化（面板不持有真值，主循环回传下一帧 state） */
  onCalPathInput(side: 'source' | 'target', path: string): void;
  onFrameChange(frame: number): void;
  onClose(): void;
}

const STATUS_LABEL: Record<RetargetSessionSummary['status'], string> = {
  idle: '未载入',
  ready: '可生成',
  pass: '通过',
  partial: '部分完成',
  failed: '生成失败',
  stale: '结果待更新',
};

const ROOT_MODE_LABEL: Record<string, string> = {
  'world-trajectory': '包含场景位移',
  'in-place-with-trajectory': '原地（有轨迹）',
  'in-place-with-phase': '原地（仅相位）',
  unknown: '轨迹不可信',
};

/** 时间轴布局常量：左侧标记名标签区 / 右侧留白（绘制与点击换算必须共用） */
const TL_LABEL_W = 60;
const TL_RIGHT_PAD = 10;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export class RetargetWorkbench {
  private readonly host: HTMLElement;
  private readonly hooks: RetargetWorkbenchHooks;

  private flowEl!: HTMLElement;
  private badgeEl!: HTMLElement;
  private calSrcStatusEl!: HTMLElement;
  private calTgtStatusEl!: HTMLElement;
  private calSrcPathInput!: HTMLInputElement;
  private calTgtPathInput!: HTMLInputElement;
  private calSrcLoadBtn!: HTMLButtonElement;
  private calSrcSaveBtn!: HTMLButtonElement;
  private calTgtLoadBtn!: HTMLButtonElement;
  private calTgtSaveBtn!: HTMLButtonElement;
  private rootModeEl!: HTMLElement;
  private rootMotionSel!: HTMLSelectElement;
  private contactNoteEl!: HTMLElement;
  private spaceModeSel!: HTMLSelectElement;
  private metricsEl!: HTMLElement;
  private violationsEl!: HTMLElement;
  private solveBtn!: HTMLButtonElement;
  private applyBtn!: HTMLButtonElement;
  private exportBtn!: HTMLButtonElement;
  private actionNoteEl!: HTMLElement;
  private srcCanvas!: HTMLCanvasElement;
  private tgtCanvas!: HTMLCanvasElement;
  private tlCanvas!: HTMLCanvasElement;
  private frameLabelEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private diagsEl!: HTMLElement;
  private noticeEl!: HTMLElement;

  private state: RetargetWorkbenchState | null = null;
  private playing = false;
  private playTimer = 0;
  /** 问题帧列表（帧号升序；从残差段/带帧诊断派生，供前后跳转） */
  private issueFrames: number[] = [];

  constructor(host: HTMLElement, hooks: RetargetWorkbenchHooks) {
    this.host = host;
    this.hooks = hooks;
    this.buildDom();
  }

  open(): void {
    this.host.classList.add('open');
    this.resizeCanvases();
  }

  close(): void {
    this.stopPlay();
    this.host.classList.remove('open');
  }

  isOpen(): boolean {
    return this.host.classList.contains('open');
  }

  resize(): void {
    this.resizeCanvases();
    this.render();
  }

  update(state: RetargetWorkbenchState): void {
    this.state = state;
    this.render();
  }

  /** 当前帧跳转（外部播放驱动时也会走这里） */
  setFrame(frame: number): void {
    if (this.state === null) return;
    const max = Math.max(0, (this.state.summary.frames ?? 1) - 1);
    const f = Math.max(0, Math.min(frame, max));
    if (f === this.state.frame) return;
    this.state = { ...this.state, frame: f };
    this.drawViews();
    this.drawTimeline();
    this.frameLabelEl.textContent = this.frameLabelText();
  }

  // ── DOM ───────────────────────────────────────────────────────────

  private buildDom(): void {
    this.host.replaceChildren();
    const head = document.createElement('div');
    head.className = 'rw-head';
    this.flowEl = document.createElement('span');
    this.flowEl.className = 'rw-flow';
    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'rw-badge';
    const title = document.createElement('span');
    title.className = 'rw-title';
    title.textContent = t('重定向工作台');
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = t('载入动作 (BVH)…');
    loadBtn.addEventListener('click', () => this.hooks.onLoadBvh());
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = t('退出');
    closeBtn.addEventListener('click', () => this.hooks.onClose());
    head.append(title, this.flowEl, this.badgeEl, loadBtn, closeBtn);
    this.host.appendChild(head);

    const body = document.createElement('div');
    body.className = 'rw-body';
    body.appendChild(this.buildSide());
    body.appendChild(this.buildMain());
    this.host.appendChild(body);
  }

  private buildSide(): HTMLElement {
    const side = document.createElement('div');
    side.className = 'rw-side';

    // 一次性通知（载入失败但保留上一份结果等）
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'rw-notice';
    this.noticeEl.style.display = 'none';

    // 标定（载入 / 保存 sidecar —— 标定流程的闭环入口）
    const calSec = document.createElement('section');
    const calH = document.createElement('h4');
    calH.textContent = t('角色标定');
    calSec.append(calH, this.buildCalRow('source'), this.buildCalRow('target'));

    // 动作适配
    const adaptSec = document.createElement('section');
    const adaptH = document.createElement('h4');
    adaptH.textContent = t('动作适配');
    const rootRow = document.createElement('div');
    rootRow.className = 'rw-row';
    rootRow.innerHTML = '<span>动作位移</span>';
    this.rootMotionSel = document.createElement('select');
    for (const [v, label] of [
      ['auto', '自动检测'],
      ['world-trajectory', '包含场景位移'],
      ['in-place-with-trajectory', '原地（有轨迹）'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      this.rootMotionSel.appendChild(opt);
    }
    this.rootMotionSel.addEventListener('change', () => {
      this.hooks.onRootMotionChange(this.rootMotionSel.value as 'auto' | 'world-trajectory' | 'in-place-with-trajectory');
    });
    rootRow.appendChild(this.rootMotionSel);
    this.rootModeEl = document.createElement('div');
    this.rootModeEl.className = 'rw-row';
    this.rootModeEl.innerHTML = '<span>检测结果</span><em style="font-style:normal"></em>';
    const spaceRow = document.createElement('div');
    spaceRow.className = 'rw-row';
    spaceRow.innerHTML = '<span>适配目标</span>';
    this.spaceModeSel = document.createElement('select');
    for (const [v, label] of [
      ['normalize-gait', '步幅随角色比例'],
      ['preserve-world', '保持场景落点'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      this.spaceModeSel.appendChild(opt);
    }
    this.spaceModeSel.addEventListener('change', () => {
      this.hooks.onSpaceModeChange(this.spaceModeSel.value as 'normalize-gait' | 'preserve-world');
    });
    spaceRow.appendChild(this.spaceModeSel);
    this.contactNoteEl = document.createElement('div');
    this.contactNoteEl.style.cssText = 'font-size:10.5px;color:var(--text-dim);margin-top:4px';
    adaptSec.append(adaptH, rootRow, this.rootModeEl, spaceRow, this.contactNoteEl);

    // 质量结果
    const qSec = document.createElement('section');
    const qH = document.createElement('h4');
    qH.textContent = t('质量结果');
    this.metricsEl = document.createElement('div');
    this.violationsEl = document.createElement('div');
    this.violationsEl.style.cssText = 'font-size:10.5px';
    qSec.append(qH, this.metricsEl, this.violationsEl);

    // 操作区
    const actSec = document.createElement('section');
    const actH = document.createElement('h4');
    actH.textContent = t('操作');
    const actions = document.createElement('div');
    actions.className = 'rw-actions';
    this.solveBtn = document.createElement('button');
    this.solveBtn.type = 'button';
    this.solveBtn.className = 'primary';
    this.solveBtn.textContent = t('生成预览');
    this.solveBtn.addEventListener('click', () => this.hooks.onSolve());
    this.applyBtn = document.createElement('button');
    this.applyBtn.type = 'button';
    this.applyBtn.textContent = t('应用到角色');
    this.applyBtn.addEventListener('click', () => this.hooks.onApply());
    this.exportBtn = document.createElement('button');
    this.exportBtn.type = 'button';
    this.exportBtn.textContent = t('导出动画 GLB');
    this.exportBtn.addEventListener('click', () => this.hooks.onExport());
    this.actionNoteEl = document.createElement('span');
    this.actionNoteEl.className = 'rw-action-note';
    actions.append(this.solveBtn, this.applyBtn, this.exportBtn, this.actionNoteEl);
    actSec.append(actH, actions);

    // 诊断列表
    const diagSec = document.createElement('section');
    const diagH = document.createElement('h4');
    diagH.textContent = t('诊断');
    this.diagsEl = document.createElement('div');
    diagSec.append(diagH, this.diagsEl);

    side.append(this.noticeEl, calSec, adaptSec, qSec, actSec, diagSec);
    return side;
  }

  /** 一侧标定的操作行：状态徽标 + 路径输入 + 载入/保存 */
  private buildCalRow(side: 'source' | 'target'): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'rw-cal-row';
    const head = document.createElement('div');
    head.className = 'rw-row';
    const label = document.createElement('span');
    label.textContent = side === 'source' ? '源标定' : '目标标定';
    const status = document.createElement('em');
    status.style.fontStyle = 'normal';
    if (side === 'source') this.calSrcStatusEl = status;
    else this.calTgtStatusEl = status;
    head.append(label, status);
    const pathRow = document.createElement('div');
    pathRow.className = 'rw-cal-path';
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = side === 'source'
      ? 'assets/…/clip.bvh.meta.json'
      : 'assets/…/model.glb.meta.json';
    input.addEventListener('change', () => this.hooks.onCalPathInput(side, input.value.trim()));
    if (side === 'source') this.calSrcPathInput = input;
    else this.calTgtPathInput = input;
    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = t('载入');
    loadBtn.addEventListener('click', () => this.hooks.onCalAction(side, 'load', input.value.trim()));
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = t('保存');
    saveBtn.addEventListener('click', () => this.hooks.onCalAction(side, 'save', input.value.trim()));
    if (side === 'source') {
      this.calSrcLoadBtn = loadBtn;
      this.calSrcSaveBtn = saveBtn;
    } else {
      this.calTgtLoadBtn = loadBtn;
      this.calTgtSaveBtn = saveBtn;
    }
    pathRow.append(input, loadBtn, saveBtn);
    wrap.append(head, pathRow);
    return wrap;
  }

  private buildMain(): HTMLElement {
    const main = document.createElement('div');
    main.className = 'rw-main';

    const views = document.createElement('div');
    views.className = 'rw-views';
    views.append(this.buildView('源 · 世界投影（诊断）', (c) => {
      this.srcCanvas = c;
    }), this.buildView('目标 · 求解世界投影（最终动画 = 应用/导出后的蒙皮播放）', (c) => {
      this.tgtCanvas = c;
    }));
    main.appendChild(views);

    const tl = document.createElement('div');
    tl.className = 'rw-timeline';
    this.tlCanvas = document.createElement('canvas');
    this.tlCanvas.addEventListener('pointerdown', (e) => {
      const rect = this.tlCanvas.getBoundingClientRect();
      // 与绘制共用同一坐标映射：左侧 60px 是标记名标签区，右侧留 10px——
      // 点击换算必须扣掉标签区，否则点段起点会跳到中段（UX 审核 P2）
      const frac = clamp01((e.clientX - rect.left - TL_LABEL_W) / (rect.width - TL_LABEL_W - TL_RIGHT_PAD));
      const s = this.state;
      if (s === null || s.summary.durationS === null || s.summary.durationS <= 0) return;
      const t = frac * s.summary.durationS;
      const times = this.frameTimes();
      if (times === null) return;
      let best = 0;
      let bestD = Infinity;
      for (let f = 0; f < times.length; f++) {
        const d = Math.abs(times[f]! - t);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
      this.hooks.onFrameChange(best);
    });
    const controls = document.createElement('div');
    controls.className = 'rw-tl-controls';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.textContent = t('◀ 问题帧');
    prevBtn.addEventListener('click', () => this.stepIssue(-1));
    this.playBtn = document.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.textContent = t('播放');
    this.playBtn.addEventListener('click', () => this.togglePlay());
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.textContent = t('问题帧 ▶');
    nextBtn.addEventListener('click', () => this.stepIssue(1));
    this.frameLabelEl = document.createElement('span');
    controls.append(prevBtn, this.playBtn, nextBtn, this.frameLabelEl);
    tl.append(this.tlCanvas, controls);
    main.appendChild(tl);
    return main;
  }

  private buildView(label: string, grab: (c: HTMLCanvasElement) => void): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'rw-view';
    const lab = document.createElement('span');
    lab.className = 'rw-view-label';
    lab.textContent = label;
    const canvas = document.createElement('canvas');
    grab(canvas);
    wrap.append(lab, canvas);
    return wrap;
  }

  // ── 渲染 ──────────────────────────────────────────────────────────

  private render(): void {
    const s = this.state;
    if (s === null) return;
    const sum = s.summary;
    // 先量尺寸再画：画布 width/height 赋值会清空内容（首帧空白的根因）
    this.resizeCanvases();
    this.flowEl.textContent = `${sum.clipName ?? '（未载入）'} → ${sum.targetName ?? '（未设目标）'}`;
    this.badgeEl.textContent = STATUS_LABEL[sum.status];
    this.badgeEl.className = `rw-badge ${sum.status}`;
    this.renderCalRow(this.calSrcStatusEl, this.calSrcPathInput, this.calSrcLoadBtn, this.calSrcSaveBtn, sum.sourceCalibrated, sum.canWorldLock, s.calSrcPath);
    this.renderCalRow(this.calTgtStatusEl, this.calTgtPathInput, this.calTgtLoadBtn, this.calTgtSaveBtn, sum.targetCalibrated, true, s.calTgtPath);
    if (s.notice !== null) {
      this.noticeEl.style.display = 'block';
      this.noticeEl.textContent = s.notice;
    } else {
      this.noticeEl.style.display = 'none';
    }
    const detected = this.rootModeEl.querySelector('em');
    if (detected !== null) {
      detected.textContent = sum.rootMode === null ? '—' : (ROOT_MODE_LABEL[sum.rootMode] ?? sum.rootMode);
      detected.className = sum.canWorldLock ? 'rw-ok' : 'rw-warn';
    }
    if (sum.rootMotionSetting !== null) this.rootMotionSel.value = sum.rootMotionSetting;
    this.contactNoteEl.textContent = this.contactNote(sum);
    // 回显来自会话配方（summary.spaceMode），不自持 DOM 状态——换目标 / 重绑后不残留旧选择
    if (sum.spaceMode !== null) this.spaceModeSel.value = sum.spaceMode;
    this.renderMetrics(sum);
    this.renderDiagnostics(sum);
    const busy = sum.status === 'idle';
    this.solveBtn.disabled = busy;
    this.applyBtn.disabled = busy || !s.canApply || sum.status === 'stale' || (sum.status !== 'pass' && sum.status !== 'partial');
    this.exportBtn.disabled = busy || !s.canExport || sum.status === 'stale' || (sum.status !== 'pass' && sum.status !== 'partial');
    this.actionNoteEl.textContent = this.actionNote(s);
    this.frameLabelEl.textContent = this.frameLabelText();
    this.drawViews();
    this.drawTimeline();
  }

  private renderCalRow(
    statusEl: HTMLElement,
    pathInput: HTMLInputElement,
    loadBtn: HTMLButtonElement,
    saveBtn: HTMLButtonElement,
    calibrated: boolean,
    ok: boolean,
    path: string,
  ): void {
    statusEl.className = calibrated ? (ok ? 'rw-ok' : 'rw-warn') : 'rw-warn';
    statusEl.textContent = calibrated ? (ok ? '已标定' : '已标定（轨迹受限）') : '需标定';
    // 聚焦时不回写：播放定时器每帧全量 render，正在敲入的路径不能被旧值顶掉
    if (document.activeElement !== pathInput && pathInput.value !== path) {
      pathInput.value = path;
    }
    const hasPath = path !== '';
    loadBtn.disabled = !hasPath;
    saveBtn.disabled = !hasPath || !calibrated;
    if (saveBtn.disabled && calibrated && !hasPath) saveBtn.title = t('该入口没有 sidecar 路径（场景物体不支持保存）');
    else if (saveBtn.disabled && !calibrated) saveBtn.title = t('先载入或设置标定后再保存');
    else saveBtn.title = '';
  }

  private contactNote(sum: RetargetSessionSummary): string {
    if (!sum.hasSource) return t('地面接触：先载入动作');
    if (sum.coverage.includes('contact-uncalibrated')) {
      return t('地面接触：能力受限 —— 源缺足底标定，本次为自由运动预览（不承诺世界锁脚）；SourceCalibration.markers 提供足底标记后可解锁');
    }
    if (sum.coverage.includes('world-lock')) return t('地面接触：已启用世界锁脚（支撑段锚定）');
    if (sum.coverage.includes('phase-only')) return t('地面接触：仅相位指导（原地 / 无可信轨迹，不做世界锁脚）');
    if (sum.canWorldLock) return t('地面接触：有可信轨迹，生成后按检测结果启用');
    return t('地面接触：不可用（源无世界轨迹）');
  }

  private renderMetrics(sum: RetargetSessionSummary): void {
    // 接触指标只在「真的评估过接触」时给数：没有已兑现的支撑段时显示"未评估"，
    // 不给 0.00mm 冒充质量通过（穿透只在接触段内计量，同样未评估）
    const contactEvaluated = sum.segments.some((sg) => sg.mode === 'support' && sg.anchor !== null);
    const mm = (v: number): string => `${(v * 1000).toFixed(2)} mm`;
    const rows: Array<[string, string]> = [];
    const m = sum.metrics;
    if (m !== null) {
      rows.push(['锚点偏差', contactEvaluated ? mm(m.maxAnchorDeviationM) : '未评估（无已兑现支撑段）']);
      rows.push(['累计滑动', contactEvaluated ? mm(m.cumulativeSlideM) : '未评估']);
      rows.push(['穿透', contactEvaluated ? mm(m.maxPenetrationM) : '未评估']);
      rows.push(['根修正', mm(m.maxRootCorrectionM)]);
      rows.push(['求解耗时', `${m.durationMs.toFixed(0)} ms`]);
    } else {
      rows.push(['质量指标', '尚未求解']);
    }
    this.metricsEl.replaceChildren();
    for (const [k, v] of rows) {
      const div = document.createElement('div');
      div.className = 'rw-row';
      const span = document.createElement('span');
      span.textContent = k;
      const val = document.createElement('em');
      val.style.fontStyle = 'normal';
      val.textContent = v;
      val.className = v.startsWith('未评估') ? 'rw-warn' : '';
      div.append(span, val);
      this.metricsEl.appendChild(div);
    }
    const errs = sum.diagnostics.filter((d) => d.severity === 'error');
    const warns = sum.diagnostics.filter((d) => d.severity === 'warning');
    this.violationsEl.replaceChildren();
    const line = document.createElement('div');
    line.className = errs.length > 0 ? 'rw-warn' : 'rw-ok';
    line.textContent = errs.length > 0
      ? `错误 ${errs.length} 条 · 警告 ${warns.length} 条`
      : warns.length > 0
        ? `警告 ${warns.length} 条（能力受限项见诊断）`
        : '无违例';
    this.violationsEl.appendChild(line);
  }

  private renderDiagnostics(sum: RetargetSessionSummary): void {
    this.diagsEl.replaceChildren();
    // 问题帧 = 「warning/error 且带帧号」的诊断 + 未兑现段 + 残差超限段。
    // info 不进问题导航（成功补偿的提示不是问题）；正常兑现且残差在容差内的支撑段也不是
    const issues: number[] = [];
    for (const d of sum.diagnostics) {
      if (d.frame !== undefined && d.severity !== 'info') issues.push(d.frame);
      const div = document.createElement('div');
      div.className = `rw-diag${d.frame !== undefined && d.severity !== 'info' ? ' clickable' : ''}`;
      const head = document.createElement('div');
      head.className = 'dhead';
      const sev = document.createElement('span');
      sev.className = `sev ${d.severity}`;
      sev.textContent = d.severity === 'error' ? '错误' : d.severity === 'warning' ? '警告' : '信息';
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = `${d.code}${d.constraint !== undefined ? ` · ${d.constraint}` : ''}`;
      head.append(sev, code);
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = d.message;
      div.append(head, msg);
      if (d.frame !== undefined && d.severity !== 'info') {
        const f = d.frame;
        div.title = `跳到第 ${f} 帧`;
        div.addEventListener('click', () => this.hooks.onFrameChange(f));
      }
      this.diagsEl.appendChild(div);
    }
    const times = this.frameTimes();
    if (sum.frames !== null && times !== null && times.length > 0) {
      const midFrameOf = (startS: number, endS: number): number => {
        const mid = (startS + endS) / 2;
        let best = 0;
        let bestD = Infinity;
        for (let f = 0; f < times.length; f++) {
          const d = Math.abs(times[f]! - mid);
          if (d < bestD) {
            bestD = d;
            best = f;
          }
        }
        return best;
      };
      const overLimit = new Set<string>();
      if (sum.tolerances !== null) {
        for (const r of sum.constraintResiduals) {
          if (r.maxDeviationM > sum.tolerances.anchorM) overLimit.add(r.segmentId);
        }
      }
      for (const seg of sum.segments) {
        // 只把「有问题的接触」标进导航：未兑现（无锚）、非支撑模式、或残差超容差
        if (seg.anchor !== null && seg.mode === 'support' && !overLimit.has(seg.id)) continue;
        issues.push(midFrameOf(seg.startS, seg.endS));
      }
    }
    this.issueFrames = [...new Set(issues)].sort((a, b) => a - b);
  }

  private actionNote(s: RetargetWorkbenchState): string {
    if (s.summary.status === 'stale') return t('结果待更新：重新「生成预览」后再应用 / 导出');
    if (s.summary.status === 'failed') return t('生成失败：上一份结果已保留（见诊断）');
    if (s.summary.status === 'ready') return t('输入就绪，点「生成预览」');
    return '';
  }

  private frameLabelText(): string {
    const s = this.state;
    if (s === null || s.summary.frames === null) return '';
    const times = this.frameTimes();
    const t = times !== null ? times[s.frame] ?? 0 : 0;
    return `帧 ${s.frame + 1}/${s.summary.frames} · t=${t.toFixed(3)}s`;
  }

  /** 帧时间轴（来自当前结果或源采样；面板只读，不持有采样数据本身） */
  private frameTimes(): Float64Array | null {
    const s = this.state;
    if (s === null) return null;
    // summary 不携带完整时间轴；帧↔秒换算按 fps 近似（时间轴点击/标签显示足够精确）
    const frames = s.summary.frames;
    const fps = s.summary.fps;
    if (frames === null || fps === null || fps <= 0) return null;
    const out = new Float64Array(frames);
    for (let f = 0; f < frames; f++) out[f] = f / fps;
    return out;
  }

  // ── 预览视口 ──────────────────────────────────────────────────────

  private drawViews(): void {
    const s = this.state;
    if (s === null) return;
    this.drawSkeletonView(this.srcCanvas, s.sourceSegments, s.bounds, '#FFC531');
    this.drawSkeletonView(this.tgtCanvas, s.targetSegments, s.bounds, '#8FD14F', s.markers, s.groundY);
  }

  private drawSkeletonView(
    canvas: HTMLCanvasElement,
    segments: ReadonlyArray<readonly [number, number, number, number]> | null,
    bounds: RetargetWorkbenchState['bounds'],
    color: string,
    markers?: ReadonlyArray<readonly [number, number, string]>,
    groundY?: number | null,
  ): void {
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0A0812';
    ctx.fillRect(0, 0, w, h);
    if (bounds === null || segments === null) {
      ctx.fillStyle = '#9AA0A6';
      ctx.font = '12px sans-serif';
      ctx.fillText(segments === null ? '无数据（先载入 / 生成）' : '', 10, 20);
      return;
    }
    const pad = 24;
    const spanX = Math.max(0.3, bounds.maxX - bounds.minX);
    const spanY = Math.max(0.3, bounds.maxY - bounds.minY);
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const ox = w / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
    const oy = h / 2 + ((bounds.minY + bounds.maxY) / 2) * scale;
    const px = (x: number): number => ox + x * scale;
    const py = (y: number): number => oy - y * scale;

    // 支撑平面：按目标 rig 的真实平面高度画地线（穿透/接触目检的基准，不是硬编码 0）
    if (groundY !== undefined && groundY !== null) {
      ctx.strokeStyle = '#2BC4D6';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, py(groundY));
      ctx.lineTo(w, py(groundY));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of segments) {
      ctx.moveTo(px(x1), py(y1));
      ctx.lineTo(px(x2), py(y2));
    }
    ctx.stroke();

    if (markers !== undefined) {
      ctx.font = '10px sans-serif';
      for (const [x, y, label] of markers) {
        ctx.fillStyle = '#FF9F1C';
        ctx.beginPath();
        ctx.arc(px(x), py(y), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#9AA0A6';
        ctx.fillText(label, px(x) + 5, py(y) + 3);
      }
    }
  }

  // ── 时间轴 ────────────────────────────────────────────────────────

  private drawTimeline(): void {
    const s = this.state;
    if (s === null) return;
    const ctx = this.tlCanvas.getContext('2d');
    if (ctx === null) return;
    const w = this.tlCanvas.width;
    const h = this.tlCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0A0812';
    ctx.fillRect(0, 0, w, h);
    const dur = s.summary.durationS;
    if (dur === null || dur <= 0) return;

    // 行：按标记骨分组（LeftFoot/RightFoot/…）；每行画段条
    const rows = new Map<string, Array<{ start: number; end: number; mode: string; honored: boolean }>>();
    for (const seg of s.summary.segments) {
      const bone = seg.marker.split('.')[0]!;
      if (!rows.has(bone)) rows.set(bone, []);
      rows.get(bone)!.push({
        start: seg.startS / dur,
        end: seg.endS / dur,
        mode: seg.mode,
        honored: seg.anchor !== null,
      });
    }
    const rowH = 14;
    const rowNames = [...rows.keys()].sort();
    rowNames.forEach((name, r) => {
      const y = 6 + r * rowH;
      ctx.fillStyle = '#9AA0A6';
      ctx.font = '9px sans-serif';
      ctx.fillText(name, 4, y + 9);
      for (const seg of rows.get(name)!) {
        const x1 = TL_LABEL_W + seg.start * (w - TL_LABEL_W - TL_RIGHT_PAD);
        const x2 = Math.max(x1 + 2, TL_LABEL_W + seg.end * (w - TL_LABEL_W - TL_RIGHT_PAD));
        ctx.fillStyle = seg.mode === 'support'
          ? (seg.honored ? '#8FD14F' : '#FF9F1C')
          : '#FFC531';
        ctx.fillRect(x1, y + 2, x2 - x1, 9);
        if (!seg.honored) {
          ctx.strokeStyle = '#E8402A';
          ctx.strokeRect(x1 + .5, y + 2.5, x2 - x1 - 1, 8);
        }
      }
    });

    // 问题帧刻度
    ctx.fillStyle = '#E8402A';
    for (const f of this.issueFrames) {
      const times = this.frameTimes();
      if (times === null) continue;
      const t = times[f] ?? 0;
      ctx.fillRect(TL_LABEL_W + (t / dur) * (w - TL_LABEL_W - TL_RIGHT_PAD) - 1, 2, 2, h - 4);
    }

    // 当前帧指针
    const times = this.frameTimes();
    const t = times !== null ? times[s.frame] ?? 0 : 0;
    ctx.strokeStyle = '#F5E7C8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const cx = TL_LABEL_W + (t / dur) * (w - TL_LABEL_W - TL_RIGHT_PAD);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
  }

  // ── 播放 / 问题帧跳转 ─────────────────────────────────────────────

  private togglePlay(): void {
    if (this.playing) {
      this.stopPlay();
    } else {
      this.playing = true;
      this.playBtn.textContent = t('暂停');
      const fps = this.state?.summary.fps ?? 30;
      const step = 1000 / Math.max(1, fps);
      this.playTimer = window.setInterval(() => {
        const s = this.state;
        if (s === null || s.summary.frames === null) {
          this.stopPlay();
          return;
        }
        const next = s.frame + 1 >= s.summary.frames ? 0 : s.frame + 1;
        this.hooks.onFrameChange(next);
      }, step);
    }
  }

  private stopPlay(): void {
    this.playing = false;
    this.playBtn.textContent = t('播放');
    if (this.playTimer !== 0) {
      window.clearInterval(this.playTimer);
      this.playTimer = 0;
    }
  }

  private stepIssue(dir: 1 | -1): void {
    if (this.issueFrames.length === 0) return;
    const cur = this.state?.frame ?? 0;
    const next = dir === 1
      ? this.issueFrames.find((f) => f > cur) ?? this.issueFrames[0]!
      : [...this.issueFrames].reverse().find((f) => f < cur) ?? this.issueFrames[this.issueFrames.length - 1]!;
    this.hooks.onFrameChange(next);
  }

  // ── 画布尺寸 ──────────────────────────────────────────────────────

  private resizeCanvases(): void {
    for (const c of [this.srcCanvas, this.tgtCanvas, this.tlCanvas]) {
      const rect = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
  }
}
