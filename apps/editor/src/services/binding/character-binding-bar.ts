import { normalizeManifestPath, parseAssetManifest } from '@aether/scene';

export interface CharacterBindingChoice { path: string; label: string }

/** Binding sources come from the roster manifest, never from a second character registry. */
export function characterBindingChoices(manifest: unknown): CharacterBindingChoice[] {
  if (manifest === null || typeof manifest !== 'object') return [];
  const chars = (manifest as { characters?: unknown }).characters;
  if (!Array.isArray(chars)) return [];
  const families = parseAssetManifest(manifest).families;
  return chars.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return [];
    const e = entry as { id?: unknown; name?: unknown; kind?: unknown; lods?: unknown };
    if (typeof e.id !== 'string' || !Array.isArray(e.lods)) return [];
    const paths = e.lods.flatMap((lod: unknown) => {
      if (lod === null || typeof lod !== 'object') return [];
      const file = (lod as { file?: unknown }).file;
      if (typeof file !== 'string' || !file.toLowerCase().endsWith('.glb')) return [];
      const path = normalizeManifestPath(file);
      return families.has(path) && !path.split('/').includes('..') ? [path] : [];
    });
    // The player edits LOD0; NPCs edit the textured source used to build their rig.
    const path = e.kind === 'player' ? paths[0] : paths.find(p => p.includes('/textured/')) ?? paths[0];
    return path === undefined ? [] : [{ path, label: `${e.id} · ${typeof e.name === 'string' ? e.name : e.id}` }];
  });
}

/** Header navigation only. BindingSession and BindingPersistence retain data ownership. */
export class CharacterBindingBar {
  private readonly select = document.createElement('select');
  private readonly status = document.createElement('span');
  private readonly pathLabel = document.createElement('span');
  private currentPath = '';
  private cleanState = '';
  constructor(root: HTMLElement, choices: CharacterBindingChoice[], open: (path: string) => void) {
    const bar = document.createElement('div'); bar.className = 'bd-assets';
    const label = document.createElement('label'); label.textContent = '角色绑定 ';
    this.select.setAttribute('aria-label', '角色绑定'); this.select.dataset.bd = 'character';
    this.select.add(new Option('选择角色…', ''));
    for (const c of choices) this.select.add(new Option(c.label, c.path));
    label.append(this.select);
    const reload = document.createElement('button'); reload.className = 'bd-btn'; reload.textContent = '重载 meta';
    reload.addEventListener('click', () => { if (this.currentPath !== '') open(this.currentPath); });
    this.select.addEventListener('change', () => {
      const path = this.select.value; this.select.value = this.currentPath;
      if (path !== '') open(path);
    });
    this.pathLabel.className = 'bd-metapath'; this.pathLabel.dataset.bd = 'meta-path';
    this.status.setAttribute('role', 'status'); this.status.dataset.bd = 'meta-state';
    bar.append(label, reload, this.status, this.pathLabel);
    root.querySelector('.bd-head')!.before(bar);
  }
  setSource(path: string | null, restored: boolean): void {
    this.currentPath = path ?? '';
    if (this.currentPath !== '' && !Array.from(this.select.options).some(o => o.value === this.currentPath)) {
      this.select.add(new Option(this.currentPath.split('/').pop()!, this.currentPath));
    }
    this.select.value = this.currentPath;
    this.pathLabel.textContent = path === null ? '场景网格 · 无 sidecar 路径' : `${path}.meta.json`;
    this.pathLabel.title = this.pathLabel.textContent;
    this.cleanState = restored ? '已读取绑定数据' : '模板起点';
    this.status.textContent = this.cleanState;
  }
  setDirty(dirty: boolean): void { this.status.textContent = dirty ? '有未保存修改' : this.cleanState; }
  saved(): void { this.cleanState = '已保存绑定数据'; this.status.textContent = this.cleanState; }
}
