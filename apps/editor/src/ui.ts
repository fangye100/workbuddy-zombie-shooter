import {
  PARAM_GROUPS,
  defaultParams,
  MATERIAL_OPTIONS,
  type ControlDef,
  type LabParams,
  type MaterialState,
  type SelectionInfo,
} from './params';
import { LIGHT_PRESETS, MATERIAL_PRESETS } from './presets';
import { BUILTIN_MODELS } from './models';
import {
  type HierarchyNode,
  type HierarchySubNode,
  type HierarchyTreeNode,
  type LabRenderer,
  type MaterialSlotInfo,
} from './renderer';

/**
 * Game Editor 参数面板（原 Shader Lab）。
 *
 * 曲线预览在 CPU 上复刻了着色器的数学：改 WGSL 里的分阶/调色逻辑时，
 * 这里的 rampLinearAt / gradeAt 必须同步改，否则预览会骗人。
 */

type V3 = [number, number, number];

const LUMA_W: V3 = [0.2126, 0.7152, 0.0722];

function luma(c: V3): number {
  return c[0] * LUMA_W[0] + c[1] * LUMA_W[1] + c[2] * LUMA_W[2];
}

function srgbToLinear(c: V3): V3 {
  return c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))) as V3;
}

function linearToSrgb(c: V3): V3 {
  return c.map((v) => {
    const x = Math.max(0, v);
    return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  }) as V3;
}

function mix3(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scale3(c: V3, s: number): V3 {
  return [c[0] * s, c[1] * s, c[2] * s];
}

function saturate3(c: V3, amount: number): V3 {
  const l = luma(c);
  return c.map((v) => Math.max(0, l + (v - l) * amount)) as V3;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * 「Mesh 材质」面板的控件清单：从「材质」分组克隆，material-* → slot-*。
 * 保证两边参数集合永远同步，不维护第二份清单。
 */
function slotControlDefs(): ControlDef[] {
  const matGroup = PARAM_GROUPS.find((g) => g.id === 'material');
  if (matGroup === undefined) return [];
  const out: ControlDef[] = [];
  for (const c of matGroup.controls) {
    if (c.kind === 'material-slider') {
      out.push({
        kind: 'slot-slider',
        field: c.field,
        label: c.label,
        min: c.min,
        max: c.max,
        step: c.step,
        ...(c.hint !== undefined ? { hint: c.hint } : {}),
      });
    } else if (c.kind === 'material-color') {
      out.push({
        kind: 'slot-color',
        field: c.field,
        label: c.label,
        ...(c.hint !== undefined ? { hint: c.hint } : {}),
      });
    } else if (c.kind === 'material-toggle') {
      out.push({
        kind: 'slot-toggle',
        field: c.field,
        label: c.label,
        ...(c.hint !== undefined ? { hint: c.hint } : {}),
      });
    }
    // 'select'（editTarget）属于共享材质面板，这里跳过
  }
  return out;
}

/** 绕开 TS 对泛型下标写入的限制，读写参数/材质字段都走这里 */
function setField(obj: object, key: string, value: number | string | boolean): void {
  (obj as Record<string, number | string | boolean>)[key] = value;
}

function readField(obj: object, key: string): number | string | boolean {
  return (obj as Record<string, number | string | boolean>)[key] ?? 0;
}

// 列主序，与 WGSL mat3x3f 的构造顺序一致
const AGX_INSET = [
  0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591,
  0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859,
];
const AGX_OUTSET = [
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323,
  1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257,
  1.2519364065950405,
];

function mul3(m: number[], v: V3): V3 {
  return [
    m[0]! * v[0] + m[3]! * v[1] + m[6]! * v[2],
    m[1]! * v[0] + m[4]! * v[1] + m[7]! * v[2],
    m[2]! * v[0] + m[5]! * v[1] + m[8]! * v[2],
  ];
}

function agxContrast(x: number): number {
  const x2 = x * x;
  const x4 = x2 * x2;
  return (
    15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
  );
}

function tonemapApply(c: V3, mode: number): V3 {
  if (mode < 0.5) {
    return c.map((v) => Math.min(1, Math.max(0, v))) as V3;
  }
  if (mode < 1.5) {
    return c.map((v) => v / (v + 1)) as V3;
  }
  if (mode < 2.5) {
    const a = 2.51;
    const b = 0.03;
    const cc = 2.43;
    const d = 0.59;
    const e = 0.14;
    return c.map((v) => Math.min(1, Math.max(0, (v * (a * v + b)) / (v * (cc * v + d) + e)))) as V3;
  }
  const v = mul3(AGX_INSET, c);
  const o = mul3(AGX_OUTSET, v.map(agxContrast) as V3);
  return o.map((x) => Math.min(1, Math.max(0, x))) as V3;
}

function hexToRgb(hex: string): V3 {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return [1, 0, 1];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

function css(c: V3): string {
  const q = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));
  return `rgb(${q(c[0])},${q(c[1])},${q(c[2])})`;
}

function fmt(v: number, step: number): string {
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return v.toFixed(dec);
}

/** 复刻 fs_main 的分阶逻辑，得到某个 NdotL 下的线性色 */
function rampLinearAt(p: LabParams, m: MaterialState, ndotl: number): V3 {
  const albedo = srgbToLinear(hexToRgb(m.albedo));
  if (m.unlit) return albedo;

  const shadowEnd = m.shadowEnd >= 0 ? m.shadowEnd : p.shadowEnd;
  const specMix = m.specMix >= 0 ? m.specMix : p.specMix;
  const softness = p.edgeSoftness * Math.max(0.01, m.softnessScale);

  const litMask = smoothstep(shadowEnd - softness, shadowEnd + softness, ndotl);
  const shadowCol = saturate3(
    mix3(scale3(albedo, p.shadowMult), srgbToLinear(hexToRgb(p.shadowTint)), p.shadowMix),
    p.shadowSat,
  );
  const litCol = saturate3(albedo, p.litSat);

  let c = mix3(shadowCol, litCol, litMask);
  if (specMix > 0.001) {
    const specMask = smoothstep(p.specStart - softness, p.specStart + softness, ndotl);
    c = mix3(c, mix3(c, srgbToLinear(hexToRgb(p.specTint)), specMix), specMask);
  }
  return c;
}

/** 复刻 post.wgsl 的 gradeThreeBand（工作在 sRGB display-referred 空间） */
function gradeAt(p: LabParams, cIn: V3): V3 {
  const lum = luma(cIn);
  const e = Math.max(0.001, p.gradeEdge);
  const mShadow = 1 - smoothstep(p.gradeShadowRange - e, p.gradeShadowRange + e, lum);
  const mLight = smoothstep(p.gradeMidRange - e, p.gradeMidRange + e, lum);
  const mMid = Math.min(1, Math.max(0, 1 - mShadow - mLight));

  const band = (c: V3, mask: number, mult: number, tint: V3, mixAmt: number, sat: number): V3 => {
    const g = saturate3(mix3(scale3(c, mult), tint, mixAmt), sat);
    return mix3(c, g, mask);
  };

  let r = band(
    cIn,
    mShadow,
    p.gradeShadowMult,
    hexToRgb('#0E0C16'),
    p.gradeShadowMix,
    p.gradeShadowSat,
  );
  r = band(r, mMid, 0.98, r, 0, p.gradeMidSat);
  r = band(r, mLight, p.gradeLightMult, hexToRgb('#FFF6E2'), p.gradeLightMix, p.gradeLightSat);
  return r;
}

export class Panel {
  readonly params: LabParams;

  private readonly syncs: (() => void)[] = [];
  /** slot-* 控件（Mesh 材质面板）的同步器，独立于全局 syncs，只在选中/材质变化时跑 */
  private readonly slotSyncs: (() => void)[] = [];
  private readonly ramp!: HTMLCanvasElement;
  private readonly grade!: HTMLCanvasElement;
  private readonly note!: HTMLElement;

  onChange: (() => void) | null = null;

  /** 模型浏览器：切换内置模型（null = 场景角色），GLB 文件导入 */
  onModelSelect: ((id: string | null) => void) | null = null;
  onModelFile: ((buffer: ArrayBuffer, name: string) => void) | null = null;

  // ---- 场景层级 Hierarchy 回调 ----
  /** 单击行 → 选中。subIndex 非 null = 点到的是子网格（mesh）节点 */
  onHierarchySelect: ((index: number, subIndex: number | null) => void) | null = null;
  onHierarchyToggle: ((index: number, visible: boolean) => void) | null = null;
  onHierarchyDelete: ((index: number) => void) | null = null;
  /** 悬停行 → 场景里对应物体/子网格高亮（index=null = 移出）。不重绘面板 */
  onHierarchyHover: ((index: number | null, subIndex: number | null) => void) | null = null;
  /** 双击行 → 选中并聚焦（与视图里双击物体同义） */
  onHierarchyFocus: ((index: number) => void) | null = null;
  /** 子网格的显隐开关 */
  onSubMeshToggle: ((index: number, subIndex: number, visible: boolean) => void) | null = null;

  private readonly renderer: LabRenderer;

  // ---- 选择/变换面板状态 ----
  private selIndex: number | null = null;
  /** 选中的子网格下标（材质面板的作用对象）；null = 只选了物体 */
  private selSub: number | null = null;
  private selEmpty!: HTMLElement;
  private selBox!: HTMLElement;
  private selName!: HTMLElement;
  private selPos!: { input: HTMLInputElement; val: HTMLElement }[];
  private selRot!: { input: HTMLInputElement; val: HTMLElement }[];
  private selScale!: { input: HTMLInputElement; val: HTMLElement };
  private selMaterial!: HTMLSelectElement;
  private selStats!: HTMLElement;

  private modelInfo!: HTMLElement;
  private modelSelect!: HTMLSelectElement;

  // ---- 动画 Animation 面板 ----
  private animClip!: HTMLSelectElement;
  private animPlayBtn!: HTMLButtonElement;
  private animStopBtn!: HTMLButtonElement;
  private animLoop!: HTMLInputElement;
  private animSpeed!: { input: HTMLInputElement; val: HTMLElement };
  private animScrub!: { input: HTMLInputElement; val: HTMLElement };
  private animWeight!: HTMLInputElement;
  private animHint!: HTMLElement;
  /** 播放/暂停按钮当前语义，与渲染器 isAnimationPlaying 对齐 */
  private animPlaying = false;
  /** 用户正在拖时间轴时不让每帧 tick 抢写值 */
  private animScrubbing = false;

  // ---- 场景层级 ----
  private hierBody!: HTMLElement;
  private hierEmpty!: HTMLElement;
  private hierSummary!: HTMLElement;
  /** 展开/收起状态按物体索引记；两个集合都没记的用默认值（子网格 > 1 才默认展开） */
  private readonly hierExpanded = new Set<number>();
  private readonly hierCollapsed = new Set<number>();
  /** GLB 组节点的折叠态（key = 对象下标:节点路径），默认全部展开 */
  private readonly hierGrpCollapsed = new Set<string>();

  // ---- Mesh 材质（材质槽编辑）----
  private mmEmpty!: HTMLElement;
  private mmBox!: HTMLElement;
  private mmTarget!: HTMLElement;
  private mmBadge!: HTMLElement;
  private mmLib!: HTMLSelectElement;
  private mmNameRow!: HTMLElement;
  private mmName!: HTMLInputElement;
  private mmBtnSave!: HTMLButtonElement;
  private mmBtnDiscard!: HTMLButtonElement;
  private mmBtnDelete!: HTMLButtonElement;
  private mmNotice!: HTMLElement;

  constructor(root: HTMLElement, renderer: LabRenderer) {
    this.renderer = renderer;
    this.params = defaultParams();

    for (const group of PARAM_GROUPS) {
      const details = document.createElement('details');
      details.className = 'group';
      details.id = group.id;
      details.open = group.open;

      const summary = document.createElement('summary');
      summary.textContent = group.title;
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'group-body';
      details.appendChild(body);

      if (group.id === 'model') {
        body.appendChild(this.buildModelBrowser());
      }
      if (group.id === 'preset') {
        this.note = document.createElement('p');
        this.note.className = 'hint';
        this.note.style.marginBottom = '8px';
        this.note.textContent = LIGHT_PRESETS[0]?.note ?? '';
        body.appendChild(this.note);
        body.appendChild(this.buildPresetButtons());
      }

      for (const control of group.controls) {
        body.appendChild(this.buildControl(control));
      }

      if (group.id === 'selection') {
        body.appendChild(this.buildSelectionControls());
      }
      if (group.id === 'hierarchy') {
        body.appendChild(this.buildHierarchy());
      }
      if (group.id === 'mesh-material') {
        body.appendChild(this.buildMeshMaterial());
      }

      if (group.id === 'material') {
        body.appendChild(this.buildMaterialPresetButtons());
      }
      if (group.id === 'toon') {
        body.appendChild(this.caption('上半：NdotL → 屏幕实际颜色（含 key 色 / 曝光 / tonemap）｜折线：输出亮度'));
        this.ramp = document.createElement('canvas');
        this.ramp.className = 'curve';
        body.appendChild(this.ramp);
      }
      if (group.id === 'grading') {
        body.appendChild(this.caption('输入灰度 → Grading 后灰度。台阶就是段边界。'));
        this.grade = document.createElement('canvas');
        this.grade.className = 'curve';
        body.appendChild(this.grade);
      }
      if (group.id === 'debug') {
        body.appendChild(this.buildExportButtons());
      }

      // 折叠时 canvas 的 clientWidth 是 0，展开后必须重画
      details.addEventListener('toggle', () => {
        if (details.open) this.redrawCurves();
      });

      root.appendChild(details);
    }

    root.appendChild(this.buildAnimation());

    this.syncAll();
  }

  private caption(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'curve-cap';
    el.textContent = text;
    return el;
  }

  /** 模型浏览器：内置模型下拉 + GLB 导入 + 信息行 */
  private buildModelBrowser(): HTMLElement {
    const wrap = document.createElement('div');

    const row = document.createElement('div');
    row.className = 'row';
    const head = document.createElement('div');
    head.className = 'row-head';
    const label = document.createElement('label');
    label.textContent = '角色模型';
    head.appendChild(label);
    row.appendChild(head);

    const select = document.createElement('select');
    const optScene = document.createElement('option');
    optScene.value = 'scene';
    optScene.textContent = '场景角色（程序化胶囊）';
    select.appendChild(optScene);
    for (const bm of BUILTIN_MODELS) {
      const o = document.createElement('option');
      o.value = bm.id;
      o.textContent = bm.label;
      select.appendChild(o);
    }
    select.value = BUILTIN_MODELS[0]?.id ?? 'scene';
    this.modelSelect = select;
    select.addEventListener('change', () => {
      this.onModelSelect?.(select.value === 'scene' ? null : select.value);
    });
    row.appendChild(select);
    wrap.appendChild(row);

    const fileRow = document.createElement('div');
    fileRow.className = 'btn-row';
    const btn = document.createElement('button');
    btn.textContent = '导入 GLB…';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.glb,model/gltf-binary';
    input.style.display = 'none';
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f === undefined) return;
      void f.arrayBuffer().then((buf) => {
        this.onModelFile?.(buf, f.name);
        input.value = '';
      });
    });
    fileRow.append(btn, input);
    wrap.appendChild(fileRow);

    this.modelInfo = document.createElement('div');
    this.modelInfo.className = 'hint';
    this.modelInfo.style.marginTop = '6px';
    this.modelInfo.textContent = '';
    wrap.appendChild(this.modelInfo);

    return wrap;
  }

  /** 模型信息行（顶点/面数/身高/贴图状态），由 main.ts 在加载后写入 */
  setModelInfo(text: string): void {
    if (this.modelInfo !== undefined) this.modelInfo.textContent = text;
  }

  /** 让下拉框高亮项与当前实际加载的模型一致（默认加载的不一定是列表第一项） */
  setSelectedModel(id: string): void {
    if (this.modelSelect !== undefined) this.modelSelect.value = id;
  }

  // ===================== 动画 Animation 面板 =====================

  /** 构建「动画」分组：片段下拉 + 播放/暂停/停止 + 循环 + 速率 + 时间轴 + 蒙皮权重可视化 */
  private buildAnimation(): HTMLElement {
    const details = document.createElement('details');
    details.className = 'group';
    details.id = 'animation';
    details.open = true;

    const summary = document.createElement('summary');
    summary.textContent = '动画 Animation';
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'group-body';

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.style.marginBottom = '8px';
    hint.textContent = '选中带骨骼的模型后可用。无骨骼动画时控件灰显。';
    this.animHint = hint;
    body.appendChild(hint);

    // 本地滑块构造器（与 buildSelectionControls 里的 mkSlider 同形，但挂在动画容器上）
    const mkSlider = (
      lbl: string,
      min: number,
      max: number,
      step: number,
      onInput: (v: number) => void,
    ): { row: HTMLElement; input: HTMLInputElement; val: HTMLElement } => {
      const row = document.createElement('div');
      row.className = 'row';
      const head = document.createElement('div');
      head.className = 'row-head';
      const label = document.createElement('label');
      label.textContent = lbl;
      const val = document.createElement('span');
      val.className = 'val';
      head.append(label, val);
      row.appendChild(head);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        val.textContent = fmt(v, step);
        onInput(v);
      });
      row.appendChild(input);
      return { row, input, val };
    };

    // 片段下拉
    body.appendChild(
      this.mkRow('片段 Clip', (row) => {
        const sel = document.createElement('select');
        sel.dataset.anim = 'clip';
        sel.addEventListener('change', () => {
          if (!this.renderer.hasAnimation()) return;
          const idx = Number(sel.value);
          this.renderer.playAnimation(idx);
          this.setPlayLabel(true);
        });
        this.animClip = sel;
        row.appendChild(sel);
      }),
    );

    // 播放/暂停 + 停止
    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    const play = document.createElement('button');
    play.textContent = '▶ 播放';
    play.dataset.anim = 'play';
    play.addEventListener('click', () => {
      if (!this.renderer.hasAnimation()) return;
      if (this.renderer.isAnimationPlaying()) {
        this.renderer.pauseAnimation();
        this.setPlayLabel(false);
      } else {
        const cur = this.renderer.getCurrentClip();
        if (cur < 0) this.renderer.playAnimation(0);
        else this.renderer.playAnimation();
        this.setPlayLabel(true);
      }
    });
    this.animPlayBtn = play;
    const stop = document.createElement('button');
    stop.textContent = '■ 停止';
    stop.addEventListener('click', () => {
      if (!this.renderer.hasAnimation()) return;
      this.renderer.stopAnimation();
      this.setPlayLabel(false);
    });
    this.animStopBtn = stop;
    btnRow.append(play, stop);
    body.appendChild(btnRow);

    // 循环
    const loopWrap = this.toggleRow('循环 Loop', (checked) => {
      if (!this.renderer.hasAnimation()) return;
      this.renderer.setAnimationLoop(checked);
    });
    this.animLoop = loopWrap.input;
    body.appendChild(loopWrap.el);

    // 速率
    const speed = mkSlider('速率 Speed', 0.1, 3, 0.05, (v) => {
      if (!this.renderer.hasAnimation()) return;
      this.renderer.setAnimationSpeed(v);
    });
    body.appendChild(speed.row);
    this.animSpeed = speed;

    // 时间轴
    const scrub = mkSlider('时间 Time', 0, 1, 0.01, (v) => {
      if (!this.renderer.hasAnimation()) return;
      this.animScrubbing = true;
      this.renderer.seekAnimation(v);
    });
    scrub.input.addEventListener('change', () => {
      this.animScrubbing = false;
    });
    scrub.input.addEventListener('pointerup', () => {
      this.animScrubbing = false;
    });
    body.appendChild(scrub.row);
    this.animScrub = scrub;

    // 蒙皮权重可视化（切到 shader debugMode 9）
    const weightWrap = this.toggleRow('蒙皮权重可视化 Skin Weights', (checked) => {
      this.params.debugMode = checked ? 9 : 0;
      this.syncValues();
      this.onChange?.();
    });
    this.animWeight = weightWrap.input;
    body.appendChild(weightWrap.el);

    details.appendChild(body);
    return details;
  }

  private setPlayLabel(playing: boolean): void {
    this.animPlaying = playing;
    this.animPlayBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
  }

  /** 选中对象 / 导入模型后重建动画控件状态（片段列表、启用态、当前帧） */
  refreshAnimation(): void {
    if (this.animClip === undefined) return;
    const has = this.renderer.hasAnimation();

    this.animClip.replaceChildren();
    const names = this.renderer.getClipNames();
    names.forEach((name, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = name;
      this.animClip.appendChild(o);
    });
    const clip = this.renderer.getCurrentClip();
    if (clip >= 0 && clip < names.length) this.animClip.value = String(clip);

    const dis = !has;
    this.animClip.disabled = dis;
    this.animPlayBtn.disabled = dis;
    this.animStopBtn.disabled = dis;
    this.animLoop.disabled = dis;
    this.animSpeed.input.disabled = dis;
    this.animScrub.input.disabled = dis;
    this.animWeight.disabled = dis;

    this.animHint.textContent = has
      ? '骨骼动画已就绪。选择片段并播放即可预览。'
      : '当前模型无骨骼动画（静态网格，或导入的 GLB 没有 skin/anim）。';

    if (has) {
      this.animLoop.checked = this.renderer.getAnimationLoop();
      const sp = this.renderer.getAnimationSpeed();
      this.animSpeed.input.value = String(sp);
      this.animSpeed.val.textContent = fmt(sp, 0.05);
      this.setPlayLabel(this.renderer.isAnimationPlaying());
      const dur = this.renderer.getAnimationDuration();
      this.animScrub.input.max = String(dur > 0 ? dur : 1);
      const t = this.renderer.getAnimationTime();
      this.animScrub.input.value = String(t);
      this.animScrub.val.textContent = `${t.toFixed(2)}s`;
    }
  }

  /** 每帧由渲染循环调用：把时间轴拖到当前播放位置，并同步播放按钮（处理播完自动停） */
  tickAnimation(): void {
    if (this.animClip === undefined || !this.renderer.hasAnimation()) return;
    if (this.animScrubbing) return;
    const dur = this.renderer.getAnimationDuration();
    this.animScrub.input.max = String(dur > 0 ? dur : 1);
    const t = this.renderer.getAnimationTime();
    this.animScrub.input.value = String(t);
    this.animScrub.val.textContent = `${t.toFixed(2)}s`;
    const playing = this.renderer.isAnimationPlaying();
    if (playing !== this.animPlaying) this.setPlayLabel(playing);
  }

  // ===================== 对象选择 / 变换面板 =====================

  private applySel(fn: (i: number) => void): void {
    if (this.selIndex === null) return;
    fn(this.selIndex);
  }

  /** 构建「对象选择与变换」分组里所有控件（只建一次，之后只同步值） */
  private buildSelectionControls(): HTMLElement {
    const body = document.createElement('div');

    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '点击场景中的物体（角色 / 敌人 / 道具）进行选择。地面不可选。';
    this.selEmpty = empty;
    body.appendChild(empty);

    const box = document.createElement('div');
    this.selBox = box;
    box.style.display = 'none';
    body.appendChild(box);

    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = '已选对象';
    const nameVal = document.createElement('span');
    nameVal.className = 'val';
    nameVal.style.color = 'var(--accent, #FFC531)';
    nameVal.style.fontWeight = '700';
    nameRow.append(nameLabel, nameVal);
    box.appendChild(nameRow);
    this.selName = nameVal;

    const mkSlider = (
      lbl: string,
      min: number,
      max: number,
      step: number,
      onInput: (v: number) => void,
    ): { input: HTMLInputElement; val: HTMLElement } => {
      const row = document.createElement('div');
      row.className = 'row';
      const head = document.createElement('div');
      head.className = 'row-head';
      const label = document.createElement('label');
      label.textContent = lbl;
      const val = document.createElement('span');
      val.className = 'val';
      head.append(label, val);
      row.appendChild(head);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        val.textContent = fmt(v, step);
        onInput(v);
      });
      row.appendChild(input);
      box.appendChild(row);
      return { input, val };
    };

    this.selPos = [
      mkSlider('位置 X', -12, 12, 0.05, (v) => this.applySel((i) => this.renderer.setObjectPos(i, 0, v))),
      mkSlider('位置 Y', -4, 6, 0.05, (v) => this.applySel((i) => this.renderer.setObjectPos(i, 1, v))),
      mkSlider('位置 Z', -12, 12, 0.05, (v) => this.applySel((i) => this.renderer.setObjectPos(i, 2, v))),
    ];
    this.selRot = [
      mkSlider('旋转 X°', -180, 180, 1, (v) => this.applySel((i) => this.renderer.setObjectRotDeg(i, 0, v))),
      mkSlider('旋转 Y°', -180, 180, 1, (v) => this.applySel((i) => this.renderer.setObjectRotDeg(i, 1, v))),
      mkSlider('旋转 Z°', -180, 180, 1, (v) => this.applySel((i) => this.renderer.setObjectRotDeg(i, 2, v))),
    ];
    this.selScale = mkSlider('缩放', 0.1, 5, 0.05, (v) => this.applySel((i) => this.renderer.setObjectScale(i, v)));

    const matRow = document.createElement('div');
    matRow.className = 'row';
    const matHead = document.createElement('div');
    matHead.className = 'row-head';
    const matLabel = document.createElement('label');
    matLabel.textContent = '整体材质（所有 mesh）';
    matHead.appendChild(matLabel);
    matRow.appendChild(matHead);
    const matSelect = document.createElement('select');
    for (const opt of MATERIAL_OPTIONS) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.label;
      matSelect.appendChild(o);
    }
    matSelect.addEventListener('change', () => {
      this.applySel((i) => this.renderer.setObjectMaterial(i, Number(matSelect.value)));
      // 换整体材质会清掉各 mesh 的覆盖，层级徽章与材质面板都得跟着变
      this.updateSubRowBadges();
      this.refreshMaterialSlot();
      this.onChange?.();
    });
    matRow.appendChild(matSelect);
    box.appendChild(matRow);
    const matHint = document.createElement('div');
    matHint.className = 'hint';
    matHint.textContent = '给该物体所有 mesh 换成同一个共享材质，并清空各自的局部覆盖。要单独调某条 mesh，用上面的「Mesh 材质」面板。';
    box.appendChild(matHint);
    this.selMaterial = matSelect;

    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    btnRow.style.marginTop = '8px';
    const weld = document.createElement('button');
    weld.textContent = 'Merge Points（焊接顶点）';
    weld.addEventListener('click', () => {
      if (this.selIndex === null) return;
      this.renderer.weldObject(this.selIndex);
      const info = this.renderer.getObjectState(this.selIndex);
      if (info !== null) this.fillSelection(info);
    });
    const deselect = document.createElement('button');
    deselect.textContent = '取消选择';
    deselect.addEventListener('click', () => {
      this.renderer.selectObject(null);
      this.setSelection(null);
    });
    btnRow.append(weld, deselect);
    box.appendChild(btnRow);

    const stats = document.createElement('div');
    stats.className = 'hint';
    stats.style.marginTop = '6px';
    this.selStats = stats;
    box.appendChild(stats);

    return body;
  }

  // ===================== 场景层级 Hierarchy =====================

  /** 分组容器 + 摘要行（只建一次，之后 refreshHierarchy 重建内部行） */
  private buildHierarchy(): HTMLElement {
    const wrap = document.createElement('div');
    const summary = document.createElement('div');
    summary.className = 'hier-summary';
    this.hierSummary = summary;
    wrap.appendChild(summary);
    const body = document.createElement('div');
    this.hierBody = body;
    wrap.appendChild(body);
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '场景里没有对象。';
    empty.style.display = 'none';
    this.hierEmpty = empty;
    wrap.appendChild(empty);
    this.refreshHierarchy();
    return wrap;
  }

  /**
   * 重建层级列表：按 category 分组 → 每个对象一行（可展开）→ 其下每条子网格一行。
   * 只在场景结构真的变了（增删、显隐、换模型）时调用；鼠标悬停走 CSS，绝不触发这里。
   */
  refreshHierarchy(): void {
    if (this.hierBody === undefined) return;
    const list = this.renderer.getObjectList();
    this.hierBody.replaceChildren();
    this.hierEmpty.style.display = list.length === 0 ? '' : 'none';
    this.hierSummary.textContent = this.hierarchySummary();

    // 保持插入顺序的分类桶
    const order: string[] = [];
    const buckets = new Map<string, HierarchyNode[]>();
    for (const o of list) {
      let b = buckets.get(o.category);
      if (b === undefined) {
        b = [];
        buckets.set(o.category, b);
        order.push(o.category);
      }
      b.push(o);
    }

    for (const cat of order) {
      const items = buckets.get(cat) ?? [];
      const details = document.createElement('details');
      details.className = 'hier-cat';
      details.open = true;
      const sum = document.createElement('summary');
      sum.textContent = `${cat} (${items.length})`;
      details.appendChild(sum);
      for (const item of items) {
        details.appendChild(this.buildHierarchyRow(item));
      }
      this.hierBody.appendChild(details);
    }
  }

  /** 对象节点：展开三角 + 眼睛 + 名称 + 面数 + 删除；下方挂子网格行 */
  private buildHierarchyRow(item: HierarchyNode): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'hier-item';

    const row = document.createElement('div');
    row.className = 'hier-row';
    row.dataset.index = String(item.index);
    if (item.index === this.selIndex && this.selSub === null) row.classList.add('sel');
    if (!item.visible) row.classList.add('hidden');

    const expanded = this.hierExpanded.has(item.index)
      ? true
      : this.hierCollapsed.has(item.index)
        ? false
        : item.subMeshes.length > 1; // 默认：只有拆了多个 primitive 的才自动展开

    const tw = document.createElement('button');
    tw.className = 'hier-tw';
    tw.type = 'button';
    tw.title = expanded ? '收起子 mesh' : '展开子 mesh';
    tw.textContent = expanded ? '▾' : '▸';

    const eye = document.createElement('button');
    eye.className = 'hier-eye';
    eye.type = 'button';
    eye.title = item.visible ? '隐藏' : '显示';
    eye.textContent = item.visible ? '◉' : '◌';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !item.visible;
      this.onHierarchyToggle?.(item.index, next);
      item.visible = next; // 本地同步，等外层 refresh 前也别显示错状态
      eye.textContent = next ? '◉' : '◌';
      eye.title = next ? '隐藏' : '显示';
      row.classList.toggle('hidden', !next);
      this.refreshCountsOnly(); // 只刷新顶部计数，不重建列表（避免闪烁）
    });

    const name = document.createElement('span');
    name.className = 'hier-name';
    name.textContent = item.name;

    const meta = document.createElement('span');
    meta.className = 'hier-meta';
    meta.textContent = item.subMeshes.length > 1 ? `${item.subMeshes.length} mesh` : `${(item.triangles / 1000).toFixed(1)}k`;

    const del = document.createElement('button');
    del.className = 'hier-del';
    del.type = 'button';
    del.title = '从场景删除';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onHierarchyDelete?.(item.index);
    });

    const kids = document.createElement('div');
    kids.className = 'hier-kids';
    kids.style.display = expanded ? '' : 'none';
    if (item.tree.length > 0) {
      // GLB 导入：按原始父子层级还原树（组节点可折叠，mesh 节点 = 子网格行）
      item.tree.forEach((n, ti) => {
        for (const el of this.buildHierarchyTree(item.index, n, 1, `${item.index}/${ti}`)) {
          kids.appendChild(el);
        }
      });
    } else {
      // 程序化网格 / 无层级资产：平铺子网格
      for (let s = 0; s < item.subMeshes.length; s++) {
        kids.appendChild(this.buildHierarchySubRow(item.index, s, item.subMeshes[s]!));
      }
    }

    tw.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = kids.style.display === 'none';
      kids.style.display = next ? '' : 'none';
      tw.textContent = next ? '▾' : '▸';
      this.hierExpanded.delete(item.index);
      this.hierCollapsed.delete(item.index);
      (next ? this.hierExpanded : this.hierCollapsed).add(item.index);
    });

    row.append(tw, eye, name, meta, del);

    // 单击选中；悬停只发索引给渲染器高亮，不重建任何 DOM；双击 = 选中 + 聚焦
    row.addEventListener('click', () => this.onHierarchySelect?.(item.index, null));
    row.addEventListener('dblclick', () => this.onHierarchyFocus?.(item.index));
    row.addEventListener('mouseenter', () => this.onHierarchyHover?.(item.index, null));
    row.addEventListener('mouseleave', () => this.onHierarchyHover?.(null, null));

    wrap.append(row, kids);
    return wrap;
  }

  /** 子网格（mesh）节点：缩进一级，眼睛独立显隐，右侧跟当前材质名；indent 供 GLB 树按需加深 */
  private buildHierarchySubRow(
    objIndex: number,
    subIndex: number,
    sm: HierarchySubNode,
    indent: string | null = null,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'hier-row hier-sub';
    if (indent !== null) row.style.marginLeft = indent;
    row.dataset.obj = String(objIndex);
    row.dataset.sub = String(subIndex);
    if (objIndex === this.selIndex && subIndex === this.selSub) row.classList.add('sel');
    if (!sm.visible) row.classList.add('hidden');

    const eye = document.createElement('button');
    eye.className = 'hier-eye';
    eye.type = 'button';
    eye.title = sm.visible ? '隐藏这个 mesh' : '显示这个 mesh';
    eye.textContent = sm.visible ? '◉' : '◌';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !sm.visible;
      this.onSubMeshToggle?.(objIndex, subIndex, next);
      sm.visible = next;
      eye.textContent = next ? '◉' : '◌';
      eye.title = next ? '隐藏这个 mesh' : '显示这个 mesh';
      row.classList.toggle('hidden', !next);
    });

    const name = document.createElement('span');
    name.className = 'hier-name';
    name.textContent = sm.name;

    const mat = document.createElement('span');
    mat.className = `hier-mat ${sm.source}`;
    mat.textContent = sm.materialName;

    const meta = document.createElement('span');
    meta.className = 'hier-meta';
    meta.textContent = `${(sm.triangles / 1000).toFixed(1)}k`;

    row.append(eye, name, mat, meta);

    // 单击 = 选中该 mesh（材质面板的作用对象）；双击还是聚焦整个物体
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onHierarchySelect?.(objIndex, subIndex);
    });
    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.onHierarchyFocus?.(objIndex);
    });
    row.addEventListener('mouseenter', () => this.onHierarchyHover?.(objIndex, subIndex));
    row.addEventListener('mouseleave', () => this.onHierarchyHover?.(null, null));
    return row;
  }

  /**
   * GLB 层级树 → 面板行。组节点（含多 primitive 的 mesh 节点）产「折叠行 + 子容器」；
   * 单 primitive 的纯叶子不产组行，直接给子网格行，少一层噪音。
   * key 用对象下标 + 兄弟序号链（与名字无关，同名节点不串折叠态）。
   */
  private buildHierarchyTree(objIndex: number, node: HierarchyTreeNode, depth: number, key: string): HTMLElement[] {
    const indent = `${30 + (depth - 1) * 14}px`;

    // 纯叶子：单 primitive 的 mesh 节点 → 直接一行
    if (node.children.length === 0 && node.subs.length === 1) {
      const s = node.subs[0]!;
      return [this.buildHierarchySubRow(objIndex, s.subIndex, s.node, indent)];
    }

    const row = document.createElement('div');
    row.className = 'hier-row hier-grp';
    row.style.marginLeft = indent;

    const collapsed = this.hierGrpCollapsed.has(key);
    const tw = document.createElement('button');
    tw.className = 'hier-tw';
    tw.type = 'button';
    tw.title = collapsed ? '展开' : '收起';
    tw.textContent = collapsed ? '▸' : '▾';

    const name = document.createElement('span');
    name.className = 'hier-name';
    name.textContent = node.name;

    const countSubs = (n: HierarchyTreeNode): number =>
      n.subs.length + n.children.reduce((acc, c) => acc + countSubs(c), 0);
    const meta = document.createElement('span');
    meta.className = 'hier-meta';
    meta.textContent = `${countSubs(node)} mesh`;

    const kids = document.createElement('div');
    kids.className = 'hier-kids';
    kids.style.display = collapsed ? 'none' : '';
    for (const s of node.subs) {
      kids.appendChild(this.buildHierarchySubRow(objIndex, s.subIndex, s.node, `${30 + depth * 14}px`));
    }
    node.children.forEach((c, i) => {
      for (const el of this.buildHierarchyTree(objIndex, c, depth + 1, `${key}/${i}`)) {
        kids.appendChild(el);
      }
    });

    const toggle = (): void => {
      const opening = kids.style.display === 'none';
      kids.style.display = opening ? '' : 'none';
      tw.textContent = opening ? '▾' : '▸';
      tw.title = opening ? '收起' : '展开';
      if (opening) this.hierGrpCollapsed.delete(key);
      else this.hierGrpCollapsed.add(key);
    };
    tw.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
    // 组节点没有 GPU 存在：不发选中/悬停，点行 = 折叠展开
    row.addEventListener('click', toggle);

    row.append(tw, name, meta);

    const wrap = document.createElement('div');
    wrap.className = 'hier-item';
    wrap.append(row, kids);
    return [wrap];
  }

  /** 视图里选中 ↔ 层级面板高亮同步：遍历行数很少，每次拾取调一次毫无压力 */
  private syncHierarchySelection(): void {
    if (this.hierBody === undefined) return;
    for (const el of Array.from(this.hierBody.querySelectorAll<HTMLElement>('.hier-row'))) {
      const isSub = el.classList.contains('hier-sub');
      const obj = Number(isSub ? el.dataset.obj : el.dataset.index);
      const sub = isSub ? Number(el.dataset.sub) : null;
      el.classList.toggle('sel', obj === this.selIndex && sub === this.selSub);
    }
  }

  /**
   * 材质名/来源变了就地更新子行文字，不重建整棵树（重建会让鼠标悬停态丢失）。
   * 一次性把 getObjectList() 建成 Map，避免「每行一次 list.find」的 O(行数 × 对象数)。
   */
  private updateSubRowBadges(): void {
    if (this.hierBody === undefined) return;
    const byIndex = new Map(this.renderer.getObjectList().map((n) => [n.index, n]));
    for (const el of Array.from(this.hierBody.querySelectorAll<HTMLElement>('.hier-sub'))) {
      const obj = Number(el.dataset.obj);
      const sub = Number(el.dataset.sub);
      const sm = byIndex.get(obj)?.subMeshes[sub];
      if (sm === undefined) continue;
      const badge = el.querySelector<HTMLElement>('.hier-mat');
      if (badge !== null) {
        badge.textContent = sm.materialName;
        badge.className = `hier-mat ${sm.source}`;
      }
    }
  }

  /** 顶部摘要文案。refreshHierarchy 与 refreshCountsOnly 共用，避免两处各写一份字符串 */
  private hierarchySummary(): string {
    const list = this.renderer.getObjectList();
    let visible = 0;
    let meshes = 0;
    for (const o of list) {
      if (o.visible) visible++;
      meshes += o.subMeshes.length;
    }
    return `共 ${list.length} 个对象 · ${visible} 个可见 · ${meshes} 个 mesh`;
  }

  /** 只更新顶部摘要的可见/总数字，不动列表 DOM */
  private refreshCountsOnly(): void {
    this.hierSummary.textContent = this.hierarchySummary();
  }

  /**
   * 设置当前选中对象（null = 取消）。由 main.ts 在拾取后调用。
   * subIndex 省略时按子网格数量自动定：只有一条子网格的对象直接把材质面板落到它身上，
   * 多条的留在对象层，等用户在层级树里点开选具体 mesh。
   */
  setSelection(index: number | null, subIndex?: number | null): void {
    let sub = index === null ? null : (subIndex ?? null);
    if (index !== null && sub === null && this.renderer.getSubMeshCount(index) === 1) sub = 0;
    this.selIndex = index;
    this.selSub = sub;
    this.syncHierarchySelection(); // 只 toggle 一个 class，不重建列表
    if (index === null) {
      this.selEmpty.style.display = '';
      this.selBox.style.display = 'none';
      this.refreshMaterialSlot();
      this.refreshAnimation();
      return;
    }
    const info = this.renderer.getObjectState(index);
    if (info === null) {
      this.selEmpty.style.display = '';
      this.selBox.style.display = 'none';
      this.refreshMaterialSlot();
      this.refreshAnimation();
      return;
    }
    this.selEmpty.style.display = 'none';
    this.selBox.style.display = '';
    this.fillSelection(info);
    this.refreshMaterialSlot();
    this.refreshAnimation();
  }

  // ===================== Mesh 材质（材质槽编辑）=====================

  /**
   * 面板构建。控件定义从「材质」分组克隆（material-* → slot-*），
   * 两处参数集合永远一致，不用维护第二份清单。
   */
  private buildMeshMaterial(): HTMLElement {
    const wrap = document.createElement('div');

    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent =
      '在「场景层级」里展开某个对象、点它的 mesh 子节点，即可在这里编辑该 mesh 的材质。';
    this.mmEmpty = empty;
    wrap.appendChild(empty);

    const box = document.createElement('div');
    this.mmBox = box;
    box.style.display = 'none';
    wrap.appendChild(box);

    // 目标行：对象 › mesh + 来源徽章
    const head = document.createElement('div');
    head.className = 'mm-head';
    const target = document.createElement('span');
    target.className = 'mm-target';
    const badge = document.createElement('span');
    badge.className = 'mm-badge';
    head.append(target, badge);
    box.appendChild(head);
    this.mmTarget = target;
    this.mmBadge = badge;

    // 材质槽：从材质库里挑一条（共享材质 / 用户实例）
    box.appendChild(
      this.mkRow('材质槽（换成库里已有材质）', (row) => {
        const sel = document.createElement('select');
        sel.addEventListener('change', () => {
          if (this.selIndex === null || this.selSub === null) return;
          this.renderer.assignSlotMaterial(this.selIndex, this.selSub, sel.value);
          this.afterSlotChange('已替换为库里的材质。');
        });
        row.appendChild(sel);
        this.mmLib = sel;
      }),
    );

    // 实例名（仅实例态可重命名）
    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    const nameHead = document.createElement('div');
    nameHead.className = 'row-head';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = '实例名';
    nameHead.appendChild(nameLabel);
    nameRow.appendChild(nameHead);
    const nameBox = document.createElement('div');
    nameBox.className = 'btn-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'mm-input';
    const renameBtn = document.createElement('button');
    renameBtn.textContent = '重命名';
    renameBtn.addEventListener('click', () => {
      if (this.selIndex === null || this.selSub === null) return;
      const info = this.renderer.getSlotMaterial(this.selIndex, this.selSub);
      if (info === null) return;
      this.renderer.renameMaterial(info.materialId, nameInput.value);
      this.afterSlotChange('实例已重命名。');
    });
    nameBox.append(nameInput, renameBtn);
    nameRow.appendChild(nameBox);
    box.appendChild(nameRow);
    this.mmNameRow = nameRow;
    this.mmName = nameInput;

    // 操作按钮
    const btnRow = document.createElement('div');
    btnRow.className = 'btn-row';
    // data-mm 是自动化验证（CDP）的稳定钩子，别删
    const mkBtn = (text: string, key: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = title;
      b.dataset.mm = key;
      b.addEventListener('click', fn);
      btnRow.appendChild(b);
      return b;
    };
    mkBtn('新建实例', 'instance', '以当前材质为模板建一个实例并赋给这个 mesh（来源材质不受影响）', () => {
      if (this.selIndex === null || this.selSub === null) return;
      this.renderer.createSlotInstance(this.selIndex, this.selSub);
      this.afterSlotChange('已新建材质实例并赋给该 mesh。');
    });
    this.mmBtnSave = mkBtn('保存覆盖', 'save', '把本 mesh 的覆盖修改存成材质库实例（共享材质不变）', () => {
      if (this.selIndex === null || this.selSub === null) return;
      this.renderer.promoteOverride(this.selIndex, this.selSub);
      this.afterSlotChange('覆盖已保存为实例，共享材质未被改动。');
    });
    this.mmBtnDiscard = mkBtn('放弃覆盖', 'discard', '丢弃本 mesh 的覆盖，回到共享/实例材质', () => {
      if (this.selIndex === null || this.selSub === null) return;
      this.renderer.discardOverride(this.selIndex, this.selSub);
      this.afterSlotChange('覆盖已丢弃，回到库里的材质。');
    });
    this.mmBtnDelete = mkBtn('删除实例', 'delete', '从材质库删除该实例；引用它的 mesh 回退到来源材质', () => {
      if (this.selIndex === null || this.selSub === null) return;
      const info = this.renderer.getSlotMaterial(this.selIndex, this.selSub);
      if (info === null || info.source !== 'instance') return;
      this.renderer.removeMaterial(info.materialId);
      this.afterSlotChange('实例已删除，引用它的 mesh 已回退到来源材质。');
    });
    box.appendChild(btnRow);

    // 参数：与「材质」分组同源，只是读写目标换成当前 mesh 的生效材质
    for (const def of slotControlDefs()) box.appendChild(this.buildControl(def));

    const notice = document.createElement('div');
    notice.className = 'hint';
    notice.style.marginTop = '8px';
    this.mmNotice = notice;
    box.appendChild(notice);

    return wrap;
  }

  private mkRow(label: string, fill: (row: HTMLElement) => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    const head = document.createElement('div');
    head.className = 'row-head';
    const l = document.createElement('label');
    l.textContent = label;
    head.appendChild(l);
    row.appendChild(head);
    fill(row);
    return row;
  }

  /** 材质槽变动后的统一收尾：同步面板、层级徽章、曲线预览 */
  private afterSlotChange(notice: string): void {
    this.refreshMaterialSlot();
    this.updateSubRowBadges();
    this.mmNotice.textContent = notice;
    this.onChange?.();
  }

  /** 把材质面板同步到当前选中的 mesh（无选中 → 显示空提示） */
  private refreshMaterialSlot(): void {
    const i = this.selIndex;
    const s = this.selSub;
    const info = i === null || s === null ? null : this.renderer.getSlotMaterial(i, s);
    if (info === null) {
      this.mmEmpty.style.display = '';
      this.mmBox.style.display = 'none';
      return;
    }
    this.mmEmpty.style.display = 'none';
    this.mmBox.style.display = '';
    this.mmTarget.textContent = `${info.objectName} › ${info.meshName}`;
    this.applyBadge(info.source);

    // 下拉重建：实例会增删，选项集合每次都可能变
    this.mmLib.replaceChildren();
    for (const ref of this.renderer.getMaterialLibrary()) {
      const o = document.createElement('option');
      o.value = ref.id;
      o.textContent = ref.kind === 'instance' ? `${ref.name}（实例）` : ref.name;
      this.mmLib.appendChild(o);
    }
    this.mmLib.value = info.materialId;

    const isInst = info.source === 'instance';
    this.mmNameRow.style.display = isInst ? '' : 'none';
    if (isInst) this.mmName.value = info.materialName;
    this.mmBtnSave.disabled = !info.hasOverride;
    this.mmBtnDiscard.disabled = !info.hasOverride;
    this.mmBtnDelete.style.display = isInst ? '' : 'none';
    this.mmNotice.textContent = this.slotNotice(info);
    this.syncSlotControls();
  }

  private applyBadge(source: string): void {
    const text =
      source === 'override'
        ? 'OVERRIDE · 仅本 Mesh'
        : source === 'instance'
          ? 'INSTANCE · 实例'
          : 'SHARED · 共享';
    this.mmBadge.textContent = text;
    this.mmBadge.className = `mm-badge ${source}`;
  }

  private slotNotice(info: MaterialSlotInfo): string {
    if (info.source === 'override') {
      return '覆盖中：改动只作用于这一条 mesh。点「保存覆盖」把这份修改存进材质库，共享材质不受影响。';
    }
    if (info.source === 'instance') {
      return '材质实例：改动影响所有引用这个实例的 mesh，但不影响它的来源材质。';
    }
    return '共享材质（默认）：直接调参会写回材质库、影响所有引用它的 mesh —— 所以第一次调参会自动转为本 mesh 的覆盖。';
  }

  /** 只跑 slot-* 控件的同步（选中变化与材质操作后调，不用全量 syncAll） */
  private syncSlotControls(): void {
    for (const s of this.slotSyncs) s();
  }

  /** 当前 mesh 的生效材质（只读，无副作用）—— 同步控件值用 */
  private slotMaterialRead(): MaterialState | null {
    if (this.selIndex === null || this.selSub === null) return null;
    return this.renderer.getSlotMaterial(this.selIndex, this.selSub)?.state ?? null;
  }

  /**
   * 当前 mesh 的可写材质 —— 控件改动用。
   * 关键：命中共享材质时**自动转覆盖**，用户「调这个 mesh」绝不会误改全局共享材质。
   */
  private slotMaterialEdit(): MaterialState | null {
    if (this.selIndex === null || this.selSub === null) return null;
    const before = this.renderer.getSlotMaterial(this.selIndex, this.selSub);
    if (before === null) return null;
    if (before.source === 'shared') {
      this.renderer.ensureOverride(this.selIndex, this.selSub);
      const after = this.renderer.getSlotMaterial(this.selIndex, this.selSub);
      if (after !== null) {
        this.applyBadge(after.source);
        this.mmBtnSave.disabled = false;
        this.mmBtnDiscard.disabled = false;
        this.mmNotice.textContent = '已自动创建覆盖：你的改动只作用于这条 mesh，共享材质未被改动。';
        this.updateSubRowBadges();
      }
      return after?.state ?? null;
    }
    return before.state;
  }

  /** gizmo 拖拽时把面板滑块同步到渲染器最新状态（不重切显示态） */
  syncSelectionFromRenderer(): void {
    if (this.selIndex === null) return;
    const info = this.renderer.getObjectState(this.selIndex);
    if (info !== null) this.fillSelection(info);
  }

  /** 把渲染器返回的状态同步到选择面板控件 */
  private fillSelection(info: SelectionInfo): void {
    this.selName.textContent = info.name;
    const setS = (s: { input: HTMLInputElement; val: HTMLElement }, v: number, step: number): void => {
      s.input.value = String(v);
      s.val.textContent = fmt(v, step);
    };
    setS(this.selPos[0]!, info.pos[0], 0.05);
    setS(this.selPos[1]!, info.pos[1], 0.05);
    setS(this.selPos[2]!, info.pos[2], 0.05);
    setS(this.selRot[0]!, (info.rot[0] * 180) / Math.PI, 1);
    setS(this.selRot[1]!, (info.rot[1] * 180) / Math.PI, 1);
    setS(this.selRot[2]!, (info.rot[2] * 180) / Math.PI, 1);
    setS(this.selScale!, info.scale, 0.05);
    this.selMaterial.value = String(info.materialIndex);
    const s = info.stats;
    const healthy = s.boundaryEdges === 0 && s.components === 1;
    this.selStats.textContent =
      `顶点 ${s.vertices} · 面 ${s.triangles} · 边界边 ${s.boundaryEdges} · 连通分量 ${s.components}` +
      (healthy ? ' ✓ 拓扑完整' : ' ⚠ 网格破碎，点 Merge Points');
  }

  private buildPresetButtons(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'btn-row';
    for (const preset of LIGHT_PRESETS) {
      const b = document.createElement('button');
      b.textContent = preset.name.replace(/^Act\d\s*/, '');
      b.addEventListener('click', () => {
        Object.assign(this.params, preset.apply);
        this.note.textContent = preset.note;
        this.syncAll();
        this.onChange?.();
      });
      row.appendChild(b);
    }
    return row;
  }

  private buildMaterialPresetButtons(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '4px';
    const row = document.createElement('div');
    row.className = 'btn-row';
    const note = document.createElement('div');
    note.className = 'hint';
    note.style.marginTop = '6px';
    note.textContent = MATERIAL_PRESETS[0]?.note ?? '';

    for (const preset of MATERIAL_PRESETS) {
      const b = document.createElement('button');
      b.textContent = preset.name.split(' ')[0] ?? preset.name;
      b.addEventListener('click', () => {
        const target = this.params.materials[this.params.editTarget];
        if (target !== undefined) {
          Object.assign(target, preset.apply);
          note.textContent = preset.note;
          this.syncAll();
          this.onChange?.();
        }
      });
      row.appendChild(b);
    }
    wrap.appendChild(row);
    wrap.appendChild(note);
    return wrap;
  }

  private buildExportButtons(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.style.marginTop = '12px';

    const copy = document.createElement('button');
    copy.textContent = '复制 JSON';
    copy.addEventListener('click', () => {
      const text = JSON.stringify(this.exportState(), null, 2);
      if (navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(text);
      }
      copy.textContent = '已复制 ✓';
      window.setTimeout(() => {
        copy.textContent = '复制 JSON';
      }, 1200);
    });

    const save = document.createElement('button');
    save.textContent = '导出 .json';
    save.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(this.exportState(), null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'game-editor-params.json';
      // 两个坑：① 未挂到 document 的 <a> 在 Firefox 上 click() 不触发下载；
      // ② click() 之后立刻 revoke 存在竞态 —— 下载是异步发起的，URL 可能先被撤掉。
      // 所以：先 append → click → remove → 下一轮任务再 revoke。
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    });

    const reset = document.createElement('button');
    reset.textContent = '重置';
    reset.addEventListener('click', () => {
      Object.assign(this.params, defaultParams());
      this.syncAll();
      this.onChange?.();
    });

    row.append(copy, save, reset);
    return row;
  }

  private currentMaterial(): MaterialState | undefined {
    return this.params.materials[this.params.editTarget];
  }

  /**
   * 导出快照：参数 + 材质库实例 + 各 mesh 的材质槽绑定。
   * 只导出这三类，是因为它们才是「用户创作」；场景里的变换/显隐属于运行时状态。
   */
  private exportState(): object {
    return {
      params: this.params,
      materialInstances: this.renderer.exportInstances(),
      materialSlots: this.renderer.exportSlots(),
    };
  }

  private buildControl(def: ControlDef): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';

    const head = document.createElement('div');
    head.className = 'row-head';
    const label = document.createElement('label');
    label.textContent = def.label;
    head.appendChild(label);

    const value = document.createElement('span');
    value.className = 'val';
    head.appendChild(value);
    row.appendChild(head);

    const num = (v: number | string | boolean): number => (typeof v === 'number' ? v : 0);
    const str = (v: number | string | boolean): string => (typeof v === 'string' ? v : '#000000');
    const bool = (v: number | string | boolean): boolean => v === true;

    switch (def.kind) {
      case 'slider': {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.addEventListener('input', () => {
          setField(this.params, def.key, Number(input.value));
          value.textContent = fmt(Number(input.value), def.step);
          this.onChange?.();
        });
        this.syncs.push(() => {
          const v = num(readField(this.params, def.key));
          input.value = String(v);
          value.textContent = fmt(v, def.step);
        });
        row.appendChild(input);
        break;
      }
      case 'color': {
        const input = document.createElement('input');
        input.type = 'color';
        input.addEventListener('input', () => {
          setField(this.params, def.key, input.value);
          value.textContent = input.value.toUpperCase();
          this.onChange?.();
        });
        this.syncs.push(() => {
          const v = str(readField(this.params, def.key));
          input.value = v;
          value.textContent = v.toUpperCase();
        });
        row.appendChild(input);
        break;
      }
      case 'toggle': {
        const wrap = this.toggleRow(def.label, (checked) => {
          setField(this.params, def.key, checked);
          this.onChange?.();
        });
        this.syncs.push(() => wrap.set(bool(readField(this.params, def.key))));
        head.remove();
        row.appendChild(wrap.el);
        break;
      }
      case 'select': {
        const select = document.createElement('select');
        for (const opt of def.options) {
          const o = document.createElement('option');
          o.value = String(opt.value);
          o.textContent = opt.label;
          select.appendChild(o);
        }
        select.addEventListener('change', () => {
          setField(this.params, def.key, Number(select.value));
          this.syncAll();
          this.onChange?.();
        });
        this.syncs.push(() => {
          select.value = String(num(readField(this.params, def.key)));
        });
        value.remove();
        row.appendChild(select);
        break;
      }
      case 'material-slider': {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.addEventListener('input', () => {
          const m = this.currentMaterial();
          if (m !== undefined) {
            setField(m, def.field, Number(input.value));
            value.textContent = fmt(Number(input.value), def.step);
            this.onChange?.();
          }
        });
        this.syncs.push(() => {
          const m = this.currentMaterial();
          if (m !== undefined) {
            const v = num(readField(m, def.field));
            input.value = String(v);
            value.textContent = fmt(v, def.step);
          }
        });
        row.appendChild(input);
        break;
      }
      case 'material-color': {
        const input = document.createElement('input');
        input.type = 'color';
        input.addEventListener('input', () => {
          const m = this.currentMaterial();
          if (m !== undefined) {
            setField(m, def.field, input.value);
            value.textContent = input.value.toUpperCase();
            this.onChange?.();
          }
        });
        this.syncs.push(() => {
          const m = this.currentMaterial();
          if (m !== undefined) {
            const v = str(readField(m, def.field));
            input.value = v;
            value.textContent = v.toUpperCase();
          }
        });
        row.appendChild(input);
        break;
      }
      case 'material-toggle': {
        const wrap = this.toggleRow(def.label, (checked) => {
          const m = this.currentMaterial();
          if (m !== undefined) {
            setField(m, def.field, checked);
            this.onChange?.();
          }
        });
        this.syncs.push(() => {
          const m = this.currentMaterial();
          if (m !== undefined) wrap.set(bool(readField(m, def.field)));
        });
        head.remove();
        row.appendChild(wrap.el);
        break;
      }
      // ---- Mesh 材质面板：读写目标是当前选中的那条子网格 ----
      case 'slot-slider': {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.addEventListener('input', () => {
          const m = this.slotMaterialEdit();
          if (m !== null) {
            setField(m, def.field, Number(input.value));
            value.textContent = fmt(Number(input.value), def.step);
            this.onChange?.();
          }
        });
        this.slotSyncs.push(() => {
          const m = this.slotMaterialRead();
          input.disabled = m === null;
          if (m !== null) {
            const v = num(readField(m, def.field));
            input.value = String(v);
            value.textContent = fmt(v, def.step);
          }
        });
        row.appendChild(input);
        break;
      }
      case 'slot-color': {
        const input = document.createElement('input');
        input.type = 'color';
        input.addEventListener('input', () => {
          const m = this.slotMaterialEdit();
          if (m !== null) {
            setField(m, def.field, input.value);
            value.textContent = input.value.toUpperCase();
            this.onChange?.();
          }
        });
        this.slotSyncs.push(() => {
          const m = this.slotMaterialRead();
          input.disabled = m === null;
          if (m !== null) {
            const v = str(readField(m, def.field));
            input.value = v;
            value.textContent = v.toUpperCase();
          }
        });
        row.appendChild(input);
        break;
      }
      case 'slot-toggle': {
        const wrap = this.toggleRow(def.label, (checked) => {
          const m = this.slotMaterialEdit();
          if (m !== null) {
            setField(m, def.field, checked);
            this.onChange?.();
          }
        });
        this.slotSyncs.push(() => {
          const m = this.slotMaterialRead();
          wrap.input.disabled = m === null;
          if (m !== null) wrap.set(bool(readField(m, def.field)));
        });
        head.remove();
        row.appendChild(wrap.el);
        break;
      }
    }

    if (def.hint !== undefined) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = def.hint;
      row.appendChild(hint);
    }

    return row;
  }

  private toggleRow(
    text: string,
    onInput: (checked: boolean) => void,
  ): { el: HTMLElement; input: HTMLInputElement; set: (v: boolean) => void } {
    const wrap = document.createElement('label');
    wrap.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const box = document.createElement('span');
    box.className = 'box';
    const textEl = document.createElement('span');
    textEl.textContent = text;
    wrap.append(input, box, textEl);
    input.addEventListener('change', () => onInput(input.checked));
    return { el: wrap, input, set: (v: boolean) => (input.checked = v) };
  }

  /** 只同步控件值，不重画曲线（拖相机时每帧都会调，重画太贵） */
  syncValues(): void {
    for (const s of this.syncs) s();
    for (const s of this.slotSyncs) s();
  }

  syncAll(): void {
    this.syncValues();
    this.redrawCurves();
  }

  redrawCurves(): void {
    this.drawRamp();
    this.drawGrade();
  }

  private prepare(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return null; // 折叠状态下无从下手，等展开再画

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  private drawRamp(): void {
    const ctx = this.prepare(this.ramp);
    if (ctx === null) return;
    const W = this.ramp.clientWidth;
    const H = this.ramp.clientHeight;
    const stripH = H - 26;
    const p = this.params;
    const m = p.materials[p.editTarget] ?? p.materials[0]!;

    const key = srgbToLinear(hexToRgb(p.keyColor));
    const lum: number[] = [];

    for (let x = 0; x < W; x++) {
      const ndotl = x / Math.max(1, W - 1);
      const linear = rampLinearAt(p, m, ndotl);
      const lit: V3 = [
        linear[0] * key[0] * p.keyIntensity,
        linear[1] * key[1] * p.keyIntensity,
        linear[2] * key[2] * p.keyIntensity,
      ];
      const shaded = linearToSrgb(tonemapApply(lit, p.tonemapMode));
      const display = p.gradeEnabled ? gradeAt(p, shaded) : shaded;
      lum.push(luma(display));
      ctx.fillStyle = css(display);
      ctx.fillRect(x, 0, 1, stripH);
    }

    ctx.strokeStyle = 'rgba(255,197,49,0.9)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const t of [p.shadowEnd, p.specStart]) {
      const x = Math.round(t * (W - 1)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, stripH);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#FFF6E2';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < lum.length; i++) {
      const y = stripH + 22 - lum[i]! * 20;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(154,160,166,0.9)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText('0', 2, H - 2);
    ctx.fillText('NdotL 1', W - 42, H - 2);
  }

  private drawGrade(): void {
    const ctx = this.prepare(this.grade);
    if (ctx === null) return;
    const W = this.grade.clientWidth;
    const H = this.grade.clientHeight;
    const p = this.params;
    const plotH = H - 18;

    for (let x = 0; x < W; x++) {
      const v = x / Math.max(1, W - 1);
      const out = p.gradeEnabled ? gradeAt(p, [v, v, v]) : ([v, v, v] as V3);
      ctx.fillStyle = css(out);
      ctx.fillRect(x, 0, 1, plotH);
    }

    ctx.strokeStyle = '#8FD14F';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const v = x / Math.max(1, W - 1);
      const out = p.gradeEnabled ? gradeAt(p, [v, v, v]) : ([v, v, v] as V3);
      const y = H - 2 - luma(out) * (plotH - 4);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(0, H - 2);
    ctx.lineTo(W, H - 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(154,160,166,0.9)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillText('in 0 → 1', 2, H - 4);
  }
}
