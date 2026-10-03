import { checkScene, readSceneChoices, sceneUrl } from './scene-workspace';
import { createEmptySceneDocument, type SceneDocument } from '@aether/scene';

export interface EditorMenuActions {
  dirty(): boolean;
  playing(): boolean;
  current(): { path: string; name: string } | null;
  document(): SceneDocument | null;
  save(): Promise<void>;
  undo(): void;
  redo(): void;
  inspect(tab: 'inspector' | 'scene' | 'render' | 'asset'): void;
}

/** Menus only dispatch existing author/play commands; no parallel document state. */
export class EditorMenu {
  private readonly status: HTMLElement;
  private readonly sceneLabel: HTMLButtonElement;
  private readonly dialog = document.createElement('dialog');
  constructor(private readonly actions: EditorMenuActions) {
    const host = document.querySelector<HTMLElement>('.tb-menus')!;
    const groups: [string, [string, () => void][]][] = [
      ['文件', [['新建场景…', () => this.createScene(false)], ['打开场景…  Ctrl+O', () => void this.openScenes()], ['保存场景  Ctrl+S', () => void this.save()],
        ['另存为新场景…', () => this.createScene(true)],
        ['重新载入当前场景', () => { const s = actions.current(); if (s) void this.openPath(s.path); }]]],
      ['编辑', [['撤销  Ctrl+Z', actions.undo], ['重做  Ctrl+Y', actions.redo]]],
      ['场景', [['场景与光照', () => actions.inspect('scene')], ['物体检视', () => actions.inspect('inspector')]]],
      ['渲染', [['材质、描边与后处理', () => actions.inspect('render')]]],
      ['资产', [['资产检视', () => actions.inspect('asset')], ['显示 / 隐藏资产库', () => {
        const dock = document.getElementById('asset-dock'); if (dock) dock.hidden = !dock.hidden;
      }]]],
      ['运行', [['播放 / 继续', () => document.getElementById('btn-play')?.click()],
        ['暂停', () => document.getElementById('btn-pause')?.click()],
        ['单步', () => document.getElementById('btn-step')?.click()],
        ['重跑', () => document.getElementById('btn-reset')?.click()],
        ['停止', () => document.getElementById('btn-stop')?.click()]]],
      ['视图', [['性能与诊断信息', () => { const h = document.getElementById('hud'); if (h) h.hidden = !h.hidden; }],
        ['自由相机  V', () => document.getElementById('btn-freecam')?.click()]]],
    ];
    for (const [label, items] of groups.reverse()) {
      const details = document.createElement('details'); details.className = 'editor-menu';
      const summary = document.createElement('summary'); summary.textContent = label;
      const list = document.createElement('div'); list.className = 'editor-menu-items';
      for (const [name, run] of items) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = name;
        b.onclick = () => { details.open = false; run(); }; list.append(b);
      }
      details.append(summary, list); host.prepend(details);
      details.addEventListener('toggle', () => {
        if (details.open) host.querySelectorAll<HTMLDetailsElement>('details').forEach(d => { if (d !== details) d.open = false; });
      });
    }
    document.addEventListener('click', e => {
      if (!host.contains(e.target as Node)) host.querySelectorAll<HTMLDetailsElement>('details').forEach(d => d.open = false);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') host.querySelectorAll<HTMLDetailsElement>('details').forEach(d => d.open = false);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); void this.openScenes(); }
    });
    this.sceneLabel = document.createElement('button'); this.sceneLabel.className = 'scene-current';
    this.sceneLabel.onclick = () => void this.openScenes();
    this.status = document.createElement('span'); this.status.className = 'scene-status'; this.status.setAttribute('role', 'status');
    document.getElementById('topbar')!.append(this.sceneLabel, this.status);
    this.dialog.className = 'scene-browser'; document.body.append(this.dialog);
    window.addEventListener('beforeunload', e => { if (actions.dirty()) { e.preventDefault(); e.returnValue = ''; } });
    this.refresh();
  }
  refresh(): void {
    const s = this.actions.current();
    this.sceneLabel.textContent = s ? `${this.actions.dirty() ? '● ' : ''}${s.name}` : '选择场景…';
    this.sceneLabel.title = s?.path ?? '打开项目场景';
  }
  message(text: string): void { this.status.textContent = text; this.status.title = text; this.refresh(); }
  private async save(): Promise<void> { await this.actions.save(); this.refresh(); }
  private createScene(copy: boolean): void {
    if (this.actions.playing()) { this.message('请先停止运行'); return; }
    this.dialog.replaceChildren();
    const title = document.createElement('h2'); title.textContent = copy ? '另存为新场景' : '新建场景';
    const name = document.createElement('input'); name.placeholder = '场景名称'; name.setAttribute('aria-label', '场景名称');
    const path = document.createElement('input'); path.placeholder = 'assets/scenes/custom/my-scene.scene.json'; path.setAttribute('aria-label', '新场景路径');
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const submit = document.createElement('button'); submit.textContent = '创建并登记';
    const close = document.createElement('button'); close.textContent = '取消'; close.onclick = () => this.dialog.close();
    submit.onclick = async () => {
      if (!name.value.trim() || !path.value.trim()) { status.textContent = '请填写场景名称与路径'; return; }
      submit.disabled = true;
      try {
        const current = this.actions.document();
        if (copy && current === null) throw new Error('没有可复制的作者场景');
        const doc = copy ? structuredClone(current!) : createEmptySceneDocument(name.value.trim());
        doc.id = `sc_${crypto.randomUUID().replaceAll('-', '')}`; doc.name = name.value.trim();
        const resp = await fetch('/__fs/create-scene', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: path.value.trim(), document: doc }) });
        const result = await resp.json() as { ok?: boolean; error?: string };
        if (!resp.ok || !result.ok) throw new Error(result.error ?? `HTTP ${resp.status}`);
        status.textContent = '已创建并登记；打开新场景前请保存或放弃当前场景的修改。';
        submit.textContent = '打开新场景'; submit.onclick = () => void this.openPath(path.value.trim());
        name.disabled = true; path.disabled = true;
      } catch (e) { status.textContent = String(e); }
      finally { submit.disabled = false; }
    };
    this.dialog.append(title, name, path, status, submit, close); if (!this.dialog.open) this.dialog.showModal(); name.focus();
  }
  async openPath(path: string): Promise<void> {
    if (this.actions.playing()) { this.message('请先停止运行，再切换场景'); return; }
    try {
      await checkScene(path);
      // Browser beforeunload is the single discard confirmation; cancelling leaves everything intact.
      window.location.assign(sceneUrl(window.location.href, path));
    } catch (e) { this.message(String(e)); }
  }
  async openScenes(): Promise<void> {
    this.dialog.replaceChildren();
    const title = document.createElement('h2'); title.textContent = '项目场景';
    const hint = document.createElement('p'); hint.textContent = '选择场景开始编辑 · 起始场景由项目设置决定';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索名称或路径'; search.setAttribute('aria-label', '搜索场景');
    const list = document.createElement('div'); list.className = 'scene-browser-list';
    const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => this.dialog.close();
    this.dialog.append(title, hint, search, list, close);
    if (!this.dialog.open) this.dialog.showModal();
    try {
      const scenes = await readSceneChoices();
      const render = (): void => {
        list.replaceChildren();
        const matches = scenes.filter(s => `${s.name} ${s.path}`.toLowerCase().includes(search.value.toLowerCase()));
        for (const s of matches) {
          const b = document.createElement('button'); b.className = 'scene-choice';
          const name = document.createElement('strong'); name.textContent = `${s.start ? '★ ' : ''}${s.name}`;
          const path = document.createElement('small'); path.textContent = s.path;
          const note = document.createElement('span'); note.textContent = s.path.includes('/sim/') ? '模拟快照' : s.enabled ? '项目场景' : '仅编辑器';
          b.append(name, path, note); b.onclick = () => void this.openPath(s.path); list.append(b);
        }
        if (!matches.length) list.textContent = '没有匹配的场景';
      };
      search.oninput = render; render(); search.focus();
    } catch (e) { list.textContent = `无法读取场景清单：${String(e)}`; }
  }
}
