import { AnimationDebugCollector, type DebugView, type DebugTarget } from './collector';
import { selectionGraph, poseGraph, type DebugGraph, type DebugGraphNode } from './graph';
import './panel.css';
const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}
function button(text: string, action: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.onclick = action; return b;
}
const targetKey = (t: DebugTarget): string => t.kind === 'scene' ? `scene:${t.nodeId}` : `entity:${t.runId}:${t.id}:${t.generation}`;
/** UI controls affect only observation, navigation and retained CPU views. */
export class AnimationDebugPanel {
  private readonly toggle: HTMLButtonElement;
  private readonly body = document.createElement('section');
  private readonly targets = document.createElement('select');
  private readonly status = document.createElement('p');
  private readonly viewport = document.createElement('div');
  private readonly detail = document.createElement('div');
  private readonly timeline = document.createElement('ol');
  private readonly freeze: HTMLButtonElement;
  private readonly selectionTab: HTMLButtonElement;
  private readonly poseTab: HTMLButtonElement;
  private readonly returnLive: HTMLButtonElement;
  private readonly zoomLabel = document.createElement('output');
  private open = false;
  private mode: 'selection' | 'pose' = 'selection';
  private view: DebugView | null = null;
  private selectedNode = '';
  private selectedEvent: number | null = null;
  private zoom = .8;
  private graph: DebugGraph | null = null;
  private svgElement: SVGSVGElement | null = null;
  constructor(private readonly host: HTMLElement, private readonly collector: AnimationDebugCollector) {
    host.className = 'animation-debug';
    this.toggle = button('动画调试图 · 只读', () => this.setOpen(!this.open));
    this.toggle.className = 'animation-debug-toggle'; this.toggle.setAttribute('aria-expanded', 'false');
    this.body.className = 'animation-debug-body'; this.body.hidden = true; this.body.setAttribute('aria-label', '动画只读调试图');
    const toolbar = document.createElement('div'); toolbar.className = 'animation-debug-toolbar';
    const title = document.createElement('strong'); title.textContent = '动画调试图 · 只读';
    toolbar.append(title, button('关闭', () => this.setOpen(false)));
    const controls = document.createElement('div'); controls.className = 'animation-debug-controls';
    const label = document.createElement('label'); label.textContent = '观察角色 '; this.targets.setAttribute('aria-label', '观察角色'); label.append(this.targets);
    this.targets.onchange = () => {
      const target = this.view?.targets.find(t => targetKey(t) === this.targets.value) ?? null;
      this.selectedEvent = null; this.selectedNode = ''; this.collector.select(target); this.update(performance.now());
    };
    this.freeze = button('冻结观察画面', () => { this.collector.setFrozen(!this.view?.frozen); this.update(performance.now()); });
    this.freeze.title = '只冻结图与历史显示；游戏和动画继续运行';
    this.selectionTab = button('状态与条件', () => this.setMode('selection'));
    this.poseTab = button('姿态管线', () => this.setMode('pose'));
    this.returnLive = button('返回当前观察', () => { this.selectedEvent = null; this.renderGraph(); }); this.returnLive.hidden = true;
    controls.append(label, this.freeze, this.selectionTab, this.poseTab, this.returnLive);
    const navigation = document.createElement('div'); navigation.className = 'animation-debug-controls';
    navigation.append(button('缩小图', () => this.setZoom(this.zoom / 1.2)), button('放大图', () => this.setZoom(this.zoom * 1.2)),
      button('复位图', () => { this.setZoom(.8); this.viewport.scrollTo(0, 0); }), this.zoomLabel);
    const hint = document.createElement('span'); hint.textContent = '拖拽空白平移 · Ctrl+滚轮缩放 · 点节点查看原因'; navigation.append(hint);
    this.status.className = 'animation-debug-status'; this.viewport.className = 'animation-debug-viewport';
    this.viewport.tabIndex = 0; this.viewport.setAttribute('aria-label', '动画节点图，可滚动和平移');
    this.detail.className = 'animation-debug-detail'; this.detail.setAttribute('aria-label', '节点详情');
    const historyTitle = document.createElement('strong'); historyTitle.textContent = '最近切换（最多 32 条；仅查看记录）';
    this.timeline.className = 'animation-debug-history'; this.timeline.setAttribute('aria-label', '最近动画切换');
    this.body.append(toolbar, controls, navigation, this.status, this.viewport, this.detail, historyTitle, this.timeline);
    host.append(this.toggle, this.body);
    // Preserve native button/select keyboard behavior, but block editor/game shortcuts.
    // Key releases still bubble so an already-held movement/fire key can be released safely.
    host.addEventListener('keydown', e => e.stopPropagation());
    host.addEventListener('wheel', e => e.stopPropagation());
    this.viewport.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault(); this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });
    let drag: { pointerId: number; x: number; y: number; left: number; top: number } | null = null;
    this.viewport.addEventListener('pointerdown', e => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest('[data-debug-node]'))) return;
      e.preventDefault(); this.viewport.setPointerCapture(e.pointerId);
      drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, left: this.viewport.scrollLeft, top: this.viewport.scrollTop };
    });
    this.viewport.addEventListener('pointermove', e => { if (drag?.pointerId === e.pointerId) this.viewport.scrollTo(drag.left - e.clientX + drag.x, drag.top - e.clientY + drag.y); });
    const end = (): void => { drag = null; };
    this.viewport.addEventListener('pointerup', end); this.viewport.addEventListener('pointercancel', end); this.viewport.addEventListener('lostpointercapture', end);
  }
  private setOpen(open: boolean): void {
    this.open = open; this.body.hidden = !open; this.toggle.setAttribute('aria-expanded', String(open));
    this.collector.setOpen(open); this.view = null; this.selectedEvent = null; this.selectedNode = '';
    if (open) this.update(performance.now()); else { this.viewport.replaceChildren(); this.timeline.replaceChildren(); this.detail.replaceChildren(); this.toggle.focus(); }
  }
  private setMode(mode: 'selection' | 'pose'): void { this.mode = mode; this.selectedNode = ''; this.renderGraph(); }
  private setZoom(zoom: number): void {
    this.zoom = Math.max(.35, Math.min(2, zoom)); this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    if (this.svgElement && this.graph) { this.svgElement.style.width = `${this.graph.width * this.zoom}px`; this.svgElement.style.height = `${this.graph.height * this.zoom}px`; }
  }
  update(now: number): void {
    const view = this.collector.update(now); if (!view || !this.open) return;
    this.view = view;
    const optionsKey = JSON.stringify(view.targets.map(t => [targetKey(t), t.label]));
    if (this.targets.dataset.options !== optionsKey && document.activeElement !== this.targets) {
      this.targets.replaceChildren(); this.targets.dataset.options = optionsKey;
      for (const t of view.targets) { const option = document.createElement('option'); option.value = targetKey(t); option.textContent = t.label; this.targets.append(option); }
    }
    this.targets.value = view.target ? targetKey(view.target) : '';
    this.freeze.textContent = view.frozen ? '恢复实时观察' : '冻结观察画面'; this.freeze.setAttribute('aria-pressed', String(view.frozen)); this.freeze.disabled = !view.snapshot;
    this.timeline.replaceChildren();
    for (const entry of [...view.history].reverse()) {
      const item = document.createElement('li'); const b = button(`#${entry.sequence} · tick ${entry.tick} · ${entry.from} → ${entry.to}`, () => { this.selectedEvent = entry.sequence; this.selectedNode = ''; this.renderGraph(); });
      b.title = entry.reason; b.setAttribute('aria-pressed', String(entry.sequence === this.selectedEvent)); item.append(b); this.timeline.append(item);
    }
    this.renderGraph();
  }
  private renderGraph(): void {
    this.selectionTab.setAttribute('aria-pressed', String(this.mode === 'selection')); this.poseTab.setAttribute('aria-pressed', String(this.mode === 'pose'));
    const event = this.view?.history.find(e => e.sequence === this.selectedEvent);
    if (this.selectedEvent !== null && !event) this.selectedEvent = null;
    const snapshot = event?.snapshot ?? this.view?.snapshot;
    this.returnLive.hidden = !event;
    if (!snapshot) {
      this.status.textContent = this.view?.active ? '等待选定角色的管线数据；目标可能已移除或尚未装配。' : '请进入 Play；打开时只观察选定角色。';
      this.viewport.replaceChildren(); this.detail.replaceChildren(); return;
    }
    this.status.textContent = `${event ? `查看记录 #${event.sequence}` : this.view?.frozen ? '观察画面已冻结（游戏继续运行）' : '实时观察'} · ${snapshot.label} · tick ${snapshot.tick} · ${snapshot.pipeline} · ${snapshot.status}`;
    const graph = this.mode === 'selection' ? selectionGraph(snapshot) : poseGraph(snapshot); this.graph = graph;
    const focused = document.activeElement instanceof Element ? document.activeElement.getAttribute('data-debug-node') : null;
    const drawing = svg('svg', { viewBox: `0 0 ${graph.width} ${graph.height}`, role: 'group', 'aria-label': this.mode === 'selection' ? '状态选择规则图' : '姿态处理图' });
    const defs = svg('defs'), marker = svg('marker', { id: 'animation-debug-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke' })); defs.append(marker); drawing.append(defs);
    for (const edge of graph.edges) {
      const from = graph.nodes.find(n => n.id === edge.from)!, to = graph.nodes.find(n => n.id === edge.to)!;
      const x1 = from.x + 220, y1 = from.y + 40, x2 = to.x, y2 = to.y + 40;
      const path = svg('path', { d: `M ${x1} ${y1} C ${x1 + 35} ${y1}, ${x2 - 35} ${y2}, ${x2} ${y2}`, 'marker-end': 'url(#animation-debug-arrow)' });
      path.classList.add('animation-debug-edge'); if (edge.active) path.classList.add('active'); drawing.append(path);
    }
    for (const node of graph.nodes) {
      const group = svg('g', { transform: `translate(${node.x},${node.y})`, role: 'button', tabindex: 0, 'data-debug-node': node.id, 'aria-label': `${node.label}: ${node.subtitle}` });
      group.classList.add('animation-debug-node'); group.classList.toggle('active', node.active); group.classList.toggle('warning', node.warning); group.classList.toggle('selected', node.id === this.selectedNode);
      group.append(svg('rect', { width: 220, height: 80, rx: 8 }));
      const label = svg('text', { x: 12, y: 28 }), subtitle = svg('text', { x: 12, y: 53 }); subtitle.classList.add('subtitle');
      label.textContent = node.label.length > 16 ? `${node.label.slice(0, 15)}…` : node.label;
      subtitle.textContent = node.subtitle.length > 26 ? `${node.subtitle.slice(0, 25)}…` : node.subtitle;
      const title = svg('title'); title.textContent = `${node.label}\n${node.subtitle}\n${node.details.join('\n')}`; group.append(label, subtitle, title);
      const show = (): void => { this.selectedNode = node.id; this.showDetail(node); for (const g of drawing.querySelectorAll('[data-debug-node]')) g.classList.toggle('selected', g.getAttribute('data-debug-node') === node.id); };
      group.addEventListener('click', show); group.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); show(); } }); drawing.append(group);
    }
    this.svgElement = drawing; this.viewport.replaceChildren(drawing); this.setZoom(this.zoom);
    const detail = graph.nodes.find(n => n.id === this.selectedNode) ?? graph.nodes.find(n => n.id === (this.mode === 'selection' ? 'actual' : 'transition'))!;
    this.showDetail(detail);
    if (focused) [...drawing.querySelectorAll<SVGGElement>('[data-debug-node]')].find(g => g.dataset.debugNode === focused)?.focus({ preventScroll: true });
  }
  private showDetail(node: DebugGraphNode): void {
    this.detail.replaceChildren(); const title = document.createElement('strong'); title.textContent = `${node.label} · ${node.subtitle}`; this.detail.append(title);
    for (const line of node.details.filter(Boolean)) { const p = document.createElement('p'); p.textContent = line; this.detail.append(p); }
  }
  snapshot(): DebugView | null { return this.collector.inspect(); }
  dispose(): void { this.collector.dispose(); this.host.remove(); }
}
