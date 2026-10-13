import { DECAL_PATTERNS, DEFAULT_DECAL_STYLE, type DecalStyle, type DecalMark, type SceneDocument, type SceneNode, validateDecalMark } from '@aether/scene';
import { DecalPreviewRenderer, packDecalMark, DECAL_INSTANCE_FLOATS } from '@aether/render';
import type { GpuContext } from '@aether/gfx';
import type { EditResult } from '@aether/runtime';
import * as m4 from '@aether/core';
import { DecalDraft, decalReceivers, newDecalMark } from './decal-draft';
import { t } from '../i18n';
import './decal-workbench.css';

interface DecalWorkbenchPort {
  document(): SceneDocument | null;
  locked(): boolean;
  edit(label: string, mutate: (nodes: SceneNode[]) => void, rebuild: boolean): EditResult;
  save(): Promise<void>;
  changed(): void;
}
const PATTERN_LABELS = ['飞溅血迹', '焦痕', '裂纹', '警戒斜纹', '弹孔', '酸液痕迹', '油污', '散纸', '碎石斑块'];
const PATTERN_COLORS:Record<DecalMark['pattern'],string> = {splatter:'#932F32',scorch:'#353542',crack:'#29323D',hazard:'#E8BB31','bullet-hole':'#AEA18C',acid:'#91BC38',oil:'#25384E',paper:'#DFCFAD',rubble:'#A77862'};

/** 独立编辑工作区；草稿只进预览，Apply 才写作者命令。 */
export class DecalWorkbench {
  private readonly dialog = document.createElement('dialog');
  private readonly draft = new DecalDraft();
  private readonly canvas = document.createElement('canvas');
  private readonly controls = document.createElement('fieldset');
  private readonly status = document.createElement('p');
  private readonly receiver = document.createElement('select');
  private readonly marks = document.createElement('select');
  private readonly fields = document.createElement('div');
  private preview: DecalPreviewRenderer | null = null;
  private markId = ''; private view = 'pattern'; private renderedKey = ''; private needsDraw = true;
  get hasDraft(): boolean { return this.draft.dirty; }
  constructor(private readonly gpu: GpuContext, private readonly port: DecalWorkbenchPort) {
    this.dialog.className = 'decal-workbench'; this.dialog.setAttribute('aria-label', t('程序贴花工作区'));
    const header = document.createElement('header');
    const title = document.createElement('h2'); title.textContent = t('程序贴花工作区'); header.append(title);
    this.button(header, '关闭工作区', () => this.close());
    const body = document.createElement('div'); body.className = 'dw-body';
    const viewport = document.createElement('section'); viewport.className = 'dw-viewport';
    const views = document.createElement('div');
    for (const [value, label] of [['pattern', '图案正视'], ['top', '局部俯视'], ['front', '局部前视'], ['angle', '局部立体视角']]) this.button(views, label!, () => { this.view = value!; this.needsDraw = true; });
    this.canvas.setAttribute('aria-label', t('贴花 GPU 预览')); viewport.append(views, this.canvas);
    const hint = document.createElement('p'); hint.textContent = t('棋盘格表示透明区。预览自动居中，位置与法线偏移在应用后的场景中查看；局部视角用于检查朝向。'); viewport.append(hint);
    const sidebar = document.createElement('section'); sidebar.className = 'dw-sidebar';
    this.receiver.setAttribute('aria-label', t('贴花接收物体')); this.marks.setAttribute('aria-label', t('程序贴花列表'));
    this.receiver.onchange = () => {
      if (this.hasDraft) { this.receiver.value = this.draft.receiver; this.message('请先应用或放弃草稿'); return; }
      const doc = this.port.document(); if (doc) { this.draft.select(doc, this.receiver.value); this.markId = ''; this.populate(); }
    };
    this.marks.onchange = () => { this.markId = this.marks.value; this.renderFields(); };
    this.label(this.controls, '接收物体', this.receiver); this.label(this.controls, '贴花实例', this.marks);
    const actions = document.createElement('div'); actions.className = 'dw-actions'; this.controls.append(actions);
    this.button(actions, '新增贴花', () => this.add(false)); this.button(actions, '复制贴花', () => this.add(true));
    this.button(actions, '删除贴花', () => { if (!this.mark()) return; this.draft.component!.marks = this.draft.component!.marks.filter(m => m.id !== this.markId); this.markId = ''; this.populate(); this.changed(); });
    this.controls.append(this.fields);
    this.button(this.controls, '应用到场景', () => {
      if (this.port.locked()) return;
      const doc = this.port.document(); if (!doc) return;
      const result = this.draft.apply(doc, mutate => this.port.edit('编辑程序贴花', mutate, false));
      this.message(result.ok ? '已应用到场景，可撤销；请保存场景' : result.error ?? '修改被拒绝');
      if (result.ok) { this.populate(); this.port.changed(); }
    });
    this.button(this.controls, '放弃草稿', () => this.resetDraft());
    this.button(this.controls, '保存场景', () => {
      if (this.hasDraft) { this.message('请先应用草稿，再保存场景'); return; }
      void this.port.save().then(() => this.message('保存结果见编辑器顶部状态栏')).catch(e => this.message(String(e)));
    });
    this.status.setAttribute('role', 'status'); sidebar.append(this.controls, this.status);
    body.append(viewport, sidebar); this.dialog.append(header, body); document.body.append(this.dialog);
    this.dialog.addEventListener('cancel', e => { e.preventDefault(); this.close(); });
  }
  open(selected: string | null): void {
    const doc = this.port.document();
    if (!doc || this.port.locked()) { this.message('请先停止 Play 并等待场景加载'); return; }
    if (!this.dialog.open) {
      this.dialog.show();
      this.preview = new DecalPreviewRenderer(this.gpu.device, this.canvas.getContext('webgpu')!, this.gpu.format);
    }
    if (!this.hasDraft) {
      const nodes = decalReceivers(doc);
      const id = nodes.find(n => n.id === selected)?.id ?? nodes.find(n => n.components.some(c => c.kind === 'Decal'))?.id ?? nodes[0]?.id;
      if (id) this.draft.select(doc, id); else this.draft.clear();
      this.populate();
    }
    this.dialog.focus(); this.needsDraw = true;
  }
  private close(): void {
    if (this.hasDraft) { this.message('请先应用或放弃草稿，再关闭工作区'); return; }
    this.preview?.destroy(); this.preview = null; this.dialog.close();
  }
  resetDraft(): void {
    const doc = this.port.document();
    if (doc && decalReceivers(doc).some(n => n.id === this.draft.receiver)) this.draft.select(doc, this.draft.receiver); else this.draft.clear();
    this.populate(); this.message('草稿已放弃'); this.port.changed();
  }
  refresh(): void {
    if (!this.dialog.open) return;
    this.controls.disabled = this.port.locked();
    const doc = this.port.document(); const key = JSON.stringify(doc?.nodes);
    if (!this.hasDraft && key !== this.renderedKey) {
      if (doc) {
        const nodes = decalReceivers(doc); const id = nodes.find(n => n.id === this.draft.receiver)?.id ?? nodes[0]?.id;
        if (id) this.draft.select(doc, id); else this.draft.clear();
      } else this.draft.clear();
      this.populate();
    }
  }
  private mark(): DecalMark | undefined { return this.draft.component?.marks.find(m => m.id === this.markId); }
  private add(copy: boolean): void {
    if (!this.draft.component) return;
    const source = this.mark(); if (copy && !source) return;
    const id = `decal_${crypto.randomUUID().replaceAll('-', '')}`;
    const mark = copy ? { ...structuredClone(source!), id } : newDecalMark(id);
    this.draft.component.marks.push(mark); this.markId = id; this.populate(); this.changed();
  }
  private populate(): void {
    const doc = this.port.document(); this.renderedKey = JSON.stringify(doc?.nodes);
    this.receiver.replaceChildren(); for (const n of doc ? decalReceivers(doc) : []) this.receiver.add(new Option(`${n.name} · ${n.id}`, n.id)); this.receiver.value = this.draft.receiver;
    this.marks.replaceChildren();
    for (const m of this.draft.component?.marks ?? []) this.marks.add(new Option(`${PATTERN_LABELS[DECAL_PATTERNS.indexOf(m.pattern)]} · ${m.id}`, m.id));
    if (!this.mark()) this.markId = this.draft.component?.marks[0]?.id ?? '';
    this.marks.value = this.markId; this.controls.disabled = this.port.locked() || !this.draft.component;
    this.renderFields();
  }
  private renderFields(): void {
    this.fields.replaceChildren(); const component = this.draft.component; const mark = this.mark();
    if (component) {
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = component.enabled;
      enabled.onchange = () => { component.enabled = enabled.checked; this.changed(); }; this.label(this.fields, '显示接收物体贴花', enabled);
    }
    if (!mark) { this.needsDraw = true; return; }
    const pattern = document.createElement('select');
    DECAL_PATTERNS.forEach((p, i) => pattern.add(new Option(t(PATTERN_LABELS[i]!), p))); pattern.value = mark.pattern;
    pattern.onchange = () => { mark.pattern = pattern.value as DecalMark['pattern']; this.changed(); }; this.label(this.fields, '图案', pattern);
    const color = document.createElement('input'); color.type = 'color'; color.value = mark.color;
    color.oninput = () => { mark.color = color.value; this.changed(); }; this.label(this.fields, '颜色', color);
    this.button(this.fields, '使用图案推荐色与形态', () => { mark.color = PATTERN_COLORS[mark.pattern]; mark.style = { ...DEFAULT_DECAL_STYLE }; this.renderFields(); this.changed(); });
    const number = (label: string, value: number, min: number, max: number, step: number, update: (v: number) => void, range = false): void => {
      const row = document.createElement('div'); row.className = 'dw-number';
      const input = document.createElement('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
      const slider = range ? document.createElement('input') : null;
      if (slider) { slider.type = 'range'; slider.min = String(min); slider.max = String(max); slider.step = String(step); slider.value = String(value); slider.setAttribute('aria-label', t(`${label}滑杆`)); row.append(slider); }
      input.oninput = () => { const v = input.value.trim() ? Number(input.value) : NaN; update(v); if (slider) slider.value = input.value; this.changed(); };
      if (slider) slider.oninput = () => { input.value = slider.value; update(Number(slider.value)); this.changed(); };
      row.append(input); this.label(this.fields, label, row); input.setAttribute('aria-label', t(label));
    };
    number('不透明度', mark.opacity, 0, 1, .01, v => mark.opacity = v, true);
    number('随机种子', mark.seed, 0, 65535, 1, v => mark.seed = v);
    const style = mark.style ?? DEFAULT_DECAL_STYLE;
    const styleNumber = (label: string, key: keyof DecalStyle, min: number, max: number, step: number): void => number(label, style[key], min, max, step, v => { mark.style = { ...(mark.style ?? DEFAULT_DECAL_STYLE), [key]: v }; }, true);
    styleNumber('图案覆盖率', 'coverage', .2, 1, .01);
    if (mark.pattern !== 'hazard') styleNumber('墨边宽度', 'edgeWidth', 0, .1, .001);
    styleNumber('不规则度', 'irregularity', 0, 1, .01);
    styleNumber('细节密度', 'detail', 0, 1, .01);
    number('宽度（米）', mark.size[0], .01, 100, .01, v => mark.size[0] = v);
    number('深度（米）', mark.size[1], .01, 100, .01, v => mark.size[1] = v);
    ['X', 'Y', 'Z'].forEach((axis, i) => number(`局部位置 ${axis}`, mark.position[i]!, -100000, 100000, .01, v => mark.position[i] = v));
    ['X', 'Y', 'Z', 'W'].forEach((axis, i) => number(`朝向四元数 ${axis}`, mark.rotation[i]!, -1, 1, .001, v => mark.rotation[i] = v));
    const presets = document.createElement('div'); this.fields.append(presets);
    for (const [label, q] of [['朝上', [0, 0, 0, 1]], ['朝前', [Math.SQRT1_2, 0, 0, Math.SQRT1_2]], ['朝右', [0, 0, -Math.SQRT1_2, Math.SQRT1_2]]] as const) this.button(presets, label, () => { mark.rotation = [...q]; this.renderFields(); this.changed(); });
    this.button(presets, '归一化朝向', () => { const n = Math.hypot(...mark.rotation); if (Number.isFinite(n) && n > 0) mark.rotation = mark.rotation.map(v => v / n) as DecalMark['rotation']; this.renderFields(); this.changed(); });
    number('法线偏移（米）', mark.normalOffset, .001, .05, .001, v => mark.normalOffset = v);
    number('绘制优先级', mark.priority, -100, 100, 1, v => mark.priority = v);
    this.needsDraw = true;
  }
  private changed(): void { this.needsDraw = true; const errors = this.mark() ? validateDecalMark(this.mark()) : []; this.message(errors.length ? errors.join('；') : '实时预览中；应用后才写入场景'); this.port.changed(); }
  private message(text: string): void { this.status.textContent = t(text); }
  private button(host: HTMLElement, text: string, run: () => void): void { const button = document.createElement('button'); button.type = 'button'; button.textContent = t(text); button.onclick = run; host.append(button); }
  private label(host: HTMLElement, text: string, control: HTMLElement): void { const label = document.createElement('label'); label.append(document.createTextNode(t(text)), control); if ((control instanceof HTMLInputElement || control instanceof HTMLSelectElement) && !control.getAttribute('aria-label')) control.setAttribute('aria-label', t(text)); host.append(label); }
  tick(): void {
    if (!this.dialog.open || !this.preview) return;
    this.controls.disabled = this.port.locked() || !this.draft.component;
    const rect = this.canvas.getBoundingClientRect(); const width = Math.max(1, Math.round(rect.width * Math.min(2, devicePixelRatio))), height = Math.max(1, Math.round(rect.height * Math.min(2, devicePixelRatio)));
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; this.needsDraw = true; }
    if (!this.needsDraw) return; this.needsDraw = false;
    const mark = this.mark(); const valid = mark && this.draft.component?.enabled && !validateDecalMark(mark).length;
    const data = new Float32Array(valid ? DECAL_INSTANCE_FLOATS : 0);
    const extent = valid ? Math.max(mark.size[0], mark.size[1]) * .8 : 1;
    if (valid) packDecalMark(data, 0, { ...mark, position: [0, 0, 0], rotation: this.view === 'pattern' ? [0, 0, 0, 1] : mark.rotation, normalOffset: .001 }, m4.mat4());
    const view = m4.mat4(), projection = m4.mat4(), vp = m4.mat4();
    const eye: m4.Vec3 = this.view === 'front' ? [0, 0, extent * 4] : this.view === 'angle' ? [extent * 3, extent * 3, extent * 3] : [0, extent * 4, 0];
    m4.lookAt(view, eye, [0, 0, 0], this.view === 'pattern' || this.view === 'top' ? [0, 0, -1] : [0, 1, 0]);
    m4.ortho(projection, extent / Math.min(1, width / height), width / height, .01, Math.max(10, extent * 10)); m4.multiply(vp, projection, view);
    this.preview.draw(data, vp, width, height);
  }
  snapshot() { return { open: this.dialog.open, dirty: this.hasDraft, receiver: this.draft.receiver, selectedMark: this.markId, preview: this.preview?.snapshot() ?? null }; }
  destroy(): void { this.preview?.destroy(); this.preview = null; this.dialog.remove(); this.draft.clear(); }
}
