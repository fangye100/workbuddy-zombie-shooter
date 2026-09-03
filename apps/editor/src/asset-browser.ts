/**
 * 资产库浏览器（Unity Project 窗口 / Unreal Content Browser 同语义）。
 *
 * 布局（底部 dock）：
 *   左：目录层级树（懒加载，选中即递进展开）
 *   右：当前目录的子集（文件夹 + 文件），滑杆在「文件名列表 ↔ 超大图标」间连续调节
 *
 * 交互：
 *   单击文件        → 选中，右侧 Inspector 显示静态资源属性
 *   单击树节点      → 内容区显示该目录子集（层级递进）
 *   双击文件夹      → 进入；双击 .glb → 抛 onSpawn 载入场景
 *   拖出文件到画布  → dataTransfer 带 ASSET_MIME，main.ts 负责落点生成
 *
 * 尺寸不锁死：dock 顶缘拖拽调高（--dock-h）、树/内容分隔条拖拽调宽（--tree-w），
 * 全部持久化到 localStorage。
 */

import {
  ASSET_MIME,
  fmtSize,
  fmtTime,
  iconSvg,
  joinPath,
  kindOf,
  listDir,
  fileUrl,
  type AssetSelection,
  type FsEntry,
} from './asset-util';
import { makeSplitter, readCssVarPx, restoreCssVar } from './splitter';

export interface AssetBrowserHooks {
  /** 选中变化（文件或文件夹；null = 无选中） */
  onSelect(sel: AssetSelection | null): void;
  /** 请求把某个 .glb 资产生成到场景（双击 / Inspector 按钮 / 拖放共用） */
  onSpawn(path: string): void;
}

interface TreeNode {
  path: string;
  name: string;
  row: HTMLElement;
  kids: HTMLElement;
  expanded: boolean;
  loaded: boolean;
}

const LS_DIR = 'zh.assets.dir';
const LS_ZOOM = 'zh.assets.zoom';
const LS_COLLAPSED = 'zh.assets.collapsed';
const LS_DOCK_H = 'zh.ui.dockH';
const LS_TREE_W = 'zh.ui.treeW';

const ROOT_NAME = 'game-design-zombie';

export class AssetBrowser {
  private readonly dock: HTMLElement;
  private readonly hooks: AssetBrowserHooks;

  private treeEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private crumbEl!: HTMLElement;
  private filterEl!: HTMLInputElement;
  private zoomEl!: HTMLInputElement;
  private bodyEl!: HTMLElement;

  private currentDir = '';
  private filter = '';
  private entries: FsEntry[] = [];
  private selectedPath: string | null = null;
  private readonly nodes = new Map<string, TreeNode>();
  /** 展开状态跨 refresh 保留 */
  private readonly expandedPaths = new Set<string>(['']);

  constructor(dock: HTMLElement, hooks: AssetBrowserHooks) {
    this.dock = dock;
    this.hooks = hooks;
    this.currentDir = localStorage.getItem(LS_DIR) ?? 'assets';
    this.buildDom();
    void this.boot();
  }

  // ================= DOM 骨架 =================

  private buildDom(): void {
    restoreCssVar('--dock-h', LS_DOCK_H, 260);
    restoreCssVar('--tree-w', LS_TREE_W, 210);

    this.dock.innerHTML = `
      <div class="asset-grip" data-asset="grip" title="拖拽调整资产库高度"></div>
      <div class="asset-head">
        <span class="asset-title">资产库 <em>Asset Library</em></span>
        <span class="asset-crumb" data-asset="crumb"></span>
        <input class="asset-filter" data-asset="filter" type="search" placeholder="筛选当前目录…">
        <span class="asset-zoom-label">列表</span>
        <input class="asset-zoom" data-asset="zoom" type="range" min="0" max="100" step="1" title="视图缩放：列表 ↔ 大图标">
        <span class="asset-zoom-label">图标</span>
        <button class="asset-collapse" data-asset="collapse" title="收起 / 展开资产库">▾</button>
      </div>
      <div class="asset-body" data-asset="body">
        <div class="asset-tree" data-asset="tree"></div>
        <div class="asset-split" data-asset="split" title="拖拽调整目录树宽度"></div>
        <div class="asset-content" data-asset="content"></div>
      </div>`;

    this.treeEl = this.dock.querySelector('[data-asset="tree"]')!;
    this.contentEl = this.dock.querySelector('[data-asset="content"]')!;
    this.crumbEl = this.dock.querySelector('[data-asset="crumb"]')!;
    this.filterEl = this.dock.querySelector('[data-asset="filter"]')!;
    this.zoomEl = this.dock.querySelector('[data-asset="zoom"]')!;
    this.bodyEl = this.dock.querySelector('[data-asset="body"]')!;

    // 顶缘拖拽 → dock 高；分隔条拖拽 → 树宽。指针捕获在 splitter 里做
    const grip = this.dock.querySelector<HTMLElement>('[data-asset="grip"]')!;
    makeSplitter(grip, {
      cssVar: '--dock-h',
      valueFromPointer: (e) => window.innerHeight - e.clientY,
      min: 140,
      // 每次拖动现算：窗口缩放后静态值会过期；给画布至少留 160px
      max: () => Math.max(320, window.innerHeight - 160),
      persistKey: LS_DOCK_H,
    });
    const split = this.dock.querySelector<HTMLElement>('[data-asset="split"]')!;
    makeSplitter(split, {
      cssVar: '--tree-w',
      valueFromPointer: (e) => {
        const r = this.bodyEl.getBoundingClientRect();
        return e.clientX - r.left;
      },
      min: 140,
      max: 480,
      persistKey: LS_TREE_W,
    });

    // 视图缩放滑杆：0 = 文件名列表；1-100 = 图标网格（连续变大）
    const savedZoom = Number(localStorage.getItem(LS_ZOOM) ?? '60');
    this.zoomEl.value = String(Number.isFinite(savedZoom) ? savedZoom : 60);
    this.zoomEl.addEventListener('input', () => {
      const v = Number(this.zoomEl.value);
      localStorage.setItem(LS_ZOOM, String(v));
      this.applyZoom(true);
    });

    this.filterEl.addEventListener('input', () => {
      this.filter = this.filterEl.value.trim().toLowerCase();
      this.renderContent();
    });

    // 点内容区空白处取消选中（只注册一次；条目点击有 stopPropagation 不会误触）
    this.contentEl.addEventListener('click', (ev) => {
      if (ev.target === this.contentEl && this.selectedPath !== null) {
        this.selectedPath = null;
        this.markContentSelection();
        this.hooks.onSelect(null);
      }
    });

    const collapseBtn = this.dock.querySelector<HTMLButtonElement>('[data-asset="collapse"]')!;
    collapseBtn.addEventListener('click', () => this.setCollapsed(!this.dock.classList.contains('collapsed')));
    if (localStorage.getItem(LS_COLLAPSED) === '1') this.setCollapsed(true);
  }

  private setCollapsed(v: boolean): void {
    this.dock.classList.toggle('collapsed', v);
    localStorage.setItem(LS_COLLAPSED, v ? '1' : '0');
    const btn = this.dock.querySelector<HTMLButtonElement>('[data-asset="collapse"]');
    if (btn !== null) btn.textContent = v ? '▴' : '▾';
  }

  // ================= 启动 / 刷新 =================

  private async boot(): Promise<void> {
    await this.buildTree();
    // 持久化的目录可能已被删掉，逐段回退到存在的祖先
    let dir = this.currentDir;
    for (;;) {
      try {
        this.entries = await listDir(dir);
        break;
      } catch {
        if (dir === '') return;
        dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
      }
    }
    this.currentDir = dir;
    await this.expandTo(dir);
    this.renderCrumb();
    this.renderContent();
    this.markTreeSelection();
  }

  /** 重新拉取（文件系统被外部改动后调） */
  async refresh(): Promise<void> {
    await this.boot();
  }

  // ================= 目录树 =================

  private async buildTree(): Promise<void> {
    this.treeEl.innerHTML = '';
    this.nodes.clear();
    const root = this.makeTreeNode('', ROOT_NAME, 0);
    this.treeEl.appendChild(root.row);
    this.treeEl.appendChild(root.kids);
    this.nodes.set('', root);
    await this.expandNode(root);
  }

  private makeTreeNode(path: string, name: string, depth: number): TreeNode {
    const row = document.createElement('div');
    row.className = 'asset-tnode';
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = path;
    row.innerHTML = `
      <span class="asset-tarrow">▸</span>
      <span class="asset-tico akind-dir">${iconSvg('dir')}</span>
      <span class="asset-tname" title="${name}">${name}</span>`;
    const kids = document.createElement('div');
    kids.className = 'asset-tkids';
    kids.style.display = 'none';

    const node: TreeNode = { path, name, row, kids, expanded: false, loaded: false };
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.selectDir(path);
    });
    row.querySelector('.asset-tarrow')!.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.toggleNode(node);
    });
    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      void this.toggleNode(node);
    });
    return node;
  }

  private async toggleNode(node: TreeNode): Promise<void> {
    if (node.expanded) this.collapseNode(node);
    else await this.expandNode(node);
  }

  private async expandNode(node: TreeNode): Promise<void> {
    if (!node.loaded) {
      try {
        const all = await listDir(node.path);
        const dirs = all.filter((e) => e.kind === 'dir');
        for (const d of dirs) {
          const childPath = joinPath(node.path, d.name);
          const depth = node.path === '' ? 1 : node.path.split('/').length + 1;
          const child = this.makeTreeNode(childPath, d.name, depth);
          node.kids.appendChild(child.row);
          node.kids.appendChild(child.kids);
          this.nodes.set(childPath, child);
        }
        node.loaded = true;
      } catch {
        return; // 目录不可读（权限/被删）：保持未展开，不炸整棵树
      }
    }
    node.expanded = true;
    this.expandedPaths.add(node.path);
    node.kids.style.display = '';
    node.row.querySelector('.asset-tarrow')!.textContent = '▾';
  }

  private collapseNode(node: TreeNode): void {
    node.expanded = false;
    this.expandedPaths.delete(node.path);
    node.kids.style.display = 'none';
    node.row.querySelector('.asset-tarrow')!.textContent = '▸';
  }

  /** 展开到指定路径（恢复上次浏览位置用）；失败的段跳过 */
  private async expandTo(path: string): Promise<void> {
    if (path === '') return;
    const segs = path.split('/');
    let cur = '';
    for (const s of segs) {
      const node = this.nodes.get(cur);
      if (node === undefined) return;
      await this.expandNode(node);
      cur = cur === '' ? s : `${cur}/${s}`;
    }
  }

  private markTreeSelection(): void {
    for (const n of this.nodes.values()) n.row.classList.toggle('sel', n.path === this.currentDir);
  }

  // ================= 内容区 =================

  async selectDir(path: string): Promise<void> {
    if (this.currentDir !== path) {
      this.currentDir = path;
      localStorage.setItem(LS_DIR, path);
      try {
        this.entries = await listDir(path);
      } catch (err) {
        this.contentEl.innerHTML = `<div class="asset-empty">目录读取失败：${String(err)}</div>`;
        return;
      }
      this.renderCrumb();
      this.renderContent();
      this.markTreeSelection();
    }
    // 程序化跳目录时把树链展开到目标（否则内容变了、树上却看不到自己在哪）
    await this.expandTo(path);
    this.markTreeSelection();
    // 选中目录本身也抛给 Inspector（显示「文件夹 · 包含 N 项」），并确保树节点展开可见
    const node = this.nodes.get(path);
    if (node !== undefined && !node.expanded) await this.expandNode(node);
    this.hooks.onSelect({
      path,
      entry: {
        name: path === '' ? ROOT_NAME : path.slice(path.lastIndexOf('/') + 1),
        kind: 'dir',
        size: 0,
        mtime: 0,
        ext: '',
      },
    });
  }

  private renderCrumb(): void {
    const segs = this.currentDir === '' ? [] : this.currentDir.split('/');
    const parts: string[] = [`<span class="asset-cseg" data-path="">项目根</span>`];
    let cur = '';
    for (const s of segs) {
      cur = cur === '' ? s : `${cur}/${s}`;
      parts.push(`<span class="asset-csep">›</span><span class="asset-cseg" data-path="${cur}">${s}</span>`);
    }
    this.crumbEl.innerHTML = parts.join('');
    for (const el of this.crumbEl.querySelectorAll<HTMLElement>('.asset-cseg')) {
      el.addEventListener('click', () => void this.selectDir(el.dataset.path ?? ''));
    }
  }

  private get zoom(): number {
    return Number(this.zoomEl.value);
  }

  /** 滑杆驱动：0 → 列表；>0 → 图标网格，单元格 74→152px 连续缩放 */
  private applyZoom(rerender: boolean): void {
    const z = this.zoom;
    const wasList = this.contentEl.classList.contains('list');
    const isList = z === 0;
    if (wasList !== isList || rerender) {
      this.contentEl.classList.toggle('list', isList);
      this.renderContent();
    }
    if (!isList) {
      const cell = Math.round(74 + z * 0.78);
      this.contentEl.style.setProperty('--asset-cell', `${cell}px`);
    }
  }

  private renderContent(): void {
    const z = this.zoom;
    const isList = z === 0;
    this.contentEl.classList.toggle('list', isList);
    if (!isList) this.contentEl.style.setProperty('--asset-cell', `${Math.round(74 + z * 0.78)}px`);

    const items = this.filter === ''
      ? this.entries
      : this.entries.filter((e) => e.name.toLowerCase().includes(this.filter));

    this.contentEl.innerHTML = '';
    if (items.length === 0) {
      const msg = this.entries.length === 0 ? '空目录' : '没有匹配筛选项';
      this.contentEl.innerHTML = `<div class="asset-empty">${msg}</div>`;
      return;
    }

    if (isList) {
      const head = document.createElement('div');
      head.className = 'asset-row asset-lhead';
      head.innerHTML = `<span class="asset-rname">名称</span><span class="asset-rsize">大小</span><span class="asset-rtime">修改时间</span>`;
      this.contentEl.appendChild(head);
    }

    for (const entry of items) {
      this.contentEl.appendChild(isList ? this.makeRow(entry) : this.makeCell(entry));
    }
    this.markContentSelection();
  }

  private makeCell(entry: FsEntry): HTMLElement {
    const kind = kindOf(entry);
    const el = document.createElement('div');
    el.className = `asset-item akind-${kind}`;
    el.dataset.name = entry.name;
    const ico = document.createElement('div');
    ico.className = 'asset-ico';
    if (kind === 'image') {
      const img = document.createElement('img');
      img.src = fileUrl(joinPath(this.currentDir, entry.name));
      img.loading = 'lazy';
      img.draggable = false;
      img.alt = entry.name;
      ico.appendChild(img);
    } else {
      ico.innerHTML = iconSvg(kind);
    }
    const name = document.createElement('div');
    name.className = 'asset-name';
    name.textContent = entry.name;
    name.title = entry.name;
    el.appendChild(ico);
    el.appendChild(name);
    this.wireItem(el, entry);
    return el;
  }

  private makeRow(entry: FsEntry): HTMLElement {
    const kind = kindOf(entry);
    const el = document.createElement('div');
    el.className = `asset-row akind-${kind}`;
    el.dataset.name = entry.name;
    el.innerHTML = `
      <span class="asset-rname"><span class="asset-ric">${iconSvg(kind)}</span><span class="asset-rname-t" title="${entry.name}">${entry.name}</span></span>
      <span class="asset-rsize">${entry.kind === 'dir' ? '—' : fmtSize(entry.size)}</span>
      <span class="asset-rtime">${fmtTime(entry.mtime)}</span>`;
    this.wireItem(el, entry);
    return el;
  }

  /** 单元格与列表行共用的交互：选中 / 双击 / 拖出 */
  private wireItem(el: HTMLElement, entry: FsEntry): void {
    const path = joinPath(this.currentDir, entry.name);

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectedPath = path;
      this.markContentSelection();
      this.hooks.onSelect({ path, entry });
    });

    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (entry.kind === 'dir') {
        void this.selectDir(path);
      } else if (entry.ext.toLowerCase() === '.glb') {
        this.hooks.onSpawn(path);
      }
    });

    if (entry.kind === 'file') {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        if (e.dataTransfer === null) return;
        e.dataTransfer.setData(ASSET_MIME, path);
        e.dataTransfer.setData('text/plain', entry.name);
        e.dataTransfer.effectAllowed = 'copy';
      });
    }
  }

  private markContentSelection(): void {
    const selName = this.selectedPath === null ? null : this.selectedPath.slice(this.selectedPath.lastIndexOf('/') + 1);
    for (const el of this.contentEl.querySelectorAll<HTMLElement>('[data-name]')) {
      el.classList.toggle('sel', selName !== null && el.dataset.name === selName);
    }
  }

  // ================= 自动化钩子 =================

  /** 给无头验证 / 控制台用：当前可见状态快照 */
  getState(): { dir: string; zoom: number; collapsed: boolean; count: number; names: string[] } {
    return {
      dir: this.currentDir,
      zoom: this.zoom,
      collapsed: this.dock.classList.contains('collapsed'),
      count: this.contentEl.querySelectorAll('[data-name]').length,
      names: [...this.contentEl.querySelectorAll<HTMLElement>('[data-name]')].map((e) => e.dataset.name ?? ''),
    };
  }

  /** 程序化触发「载入场景」（双击与拖放走同一个 hook，这里只是转发） */
  spawnPath(path: string): void {
    this.hooks.onSpawn(path);
  }

  /** 滑杆程序化设置（测试用） */
  setZoom(v: number): void {
    this.zoomEl.value = String(v);
    localStorage.setItem(LS_ZOOM, String(v));
    this.applyZoom(true);
  }

  dockHeight(): number {
    return readCssVarPx('--dock-h', 260);
  }
}
