/**
 * 资产 Inspector（右侧面板）：显示资产浏览器里选中项的静态资源属性。
 *
 * 分层递进关系：浏览器左侧目录树 → 选中目录出子集 → 选中文件 → 这里出属性。
 * 按类型加码：
 *   图片   → 预览图 + 像素尺寸
 *   .glb   → 异步解析出 顶点/三角面/子网格/身高/贴图，附「载入场景」按钮
 *   文本   → 前 30 行预览（≤256 KB 才读）
 *   文件夹 → 子项数量
 * 只读，不提供任何写操作（重命名/删除不做，避免编辑器变成文件管理器）。
 */

import {
  KIND_LABEL,
  fileUrl,
  fmtSize,
  fmtTime,
  iconSvg,
  isImageExt,
  isTextExt,
  kindOf,
  listDir,
  type AssetSelection,
} from './asset-util';
import { parseGlb } from '@aether/scene';
import { MODEL_RULER_HEIGHT_M } from './models';

const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
const TEXT_PREVIEW_LINES = 30;

export interface AssetInspectorHooks {
  /** 「载入场景」按钮（与浏览器双击 .glb 同一条路径） */
  onSpawn(path: string): void;
}

export class AssetInspector {
  private readonly rootEl: HTMLElement;
  private readonly hooks: AssetInspectorHooks;
  /** 异步加载竞态令牌：快速连选两个资产时，后到的结果覆盖先到的 */
  private token = 0;

  constructor(rootEl: HTMLElement, hooks: AssetInspectorHooks) {
    this.rootEl = rootEl;
    this.hooks = hooks;
    this.clear();
  }

  clear(): void {
    this.token++;
    this.rootEl.innerHTML = `
      <div class="ai-head"><span class="ai-title">资产<em>属性</em></span></div>
      <div class="ai-empty">在资产库中选中一个文件或文件夹<br>这里会显示它的静态资源属性</div>`;
  }

  showAsset(sel: AssetSelection): void {
    const token = ++this.token;
    const { entry, path } = sel;
    const kind = kindOf(entry);

    this.rootEl.innerHTML = `
      <div class="ai-head"><span class="ai-title">资产<em>属性</em></span></div>
      <div class="ai-hero akind-${kind}">
        <span class="ai-ico">${iconSvg(kind)}</span>
        <span class="ai-name" title="${entry.name}">${entry.name}</span>
      </div>
      <div class="ai-rows">
        <div class="ai-row"><span>类型</span><b>${KIND_LABEL[kind]}${entry.ext !== '' ? `（${entry.ext}）` : ''}</b></div>
        ${entry.kind === 'file' ? `<div class="ai-row"><span>大小</span><b>${fmtSize(entry.size)}</b></div>` : ''}
        ${entry.mtime > 0 ? `<div class="ai-row"><span>修改时间</span><b>${fmtTime(entry.mtime)}</b></div>` : ''}
        <div class="ai-row ai-path"><span>路径</span><b title="${path === '' ? '(项目根)' : path}">${path === '' ? '(项目根)' : path}</b></div>
      </div>
      <div class="ai-extra" data-ai="extra"></div>`;

    const extra = this.rootEl.querySelector<HTMLElement>('[data-ai="extra"]')!;
    const alive = (): boolean => this.token === token;

    if (entry.kind === 'dir') {
      void listDir(path)
        .then((kids) => {
          if (!alive()) return;
          const dirs = kids.filter((k) => k.kind === 'dir').length;
          extra.innerHTML = `<div class="ai-row"><span>包含</span><b>${dirs} 个文件夹 / ${kids.length - dirs} 个文件</b></div>`;
        })
        .catch(() => undefined);
      return;
    }

    if (isImageExt(entry.ext)) {
      const box = document.createElement('div');
      box.className = 'ai-preview';
      const img = document.createElement('img');
      img.src = fileUrl(path);
      img.alt = entry.name;
      img.addEventListener('load', () => {
        if (!alive()) return;
        const dim = document.createElement('div');
        dim.className = 'ai-row';
        dim.innerHTML = `<span>尺寸</span><b>${img.naturalWidth} × ${img.naturalHeight} px</b>`;
        extra.appendChild(dim);
      });
      box.appendChild(img);
      extra.appendChild(box);
      return;
    }

    if (entry.ext === '.glb') {
      const btn = document.createElement('button');
      btn.className = 'ai-spawn accent';
      btn.textContent = '载入场景 Spawn';
      btn.addEventListener('click', () => this.hooks.onSpawn(path));
      extra.appendChild(btn);
      const stat = document.createElement('div');
      stat.className = 'ai-dim';
      stat.textContent = '解析模型中…';
      extra.appendChild(stat);
      void fetch(fileUrl(path))
        .then(async (resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return parseGlb(await resp.arrayBuffer(), MODEL_RULER_HEIGHT_M);
        })
        .then((model) => {
          if (!alive()) return;
          stat.remove();
          const subs = model.subMeshes
            .map((s) => `<div class="ai-sub">· ${s.name} <i>${Math.round(s.indexCount / 3)} 面</i></div>`)
            .join('');
          extra.insertAdjacentHTML(
            'beforeend',
            `<div class="ai-row"><span>顶点</span><b>${model.vertices}</b></div>
             <div class="ai-row"><span>三角面</span><b>${model.triangles}</b></div>
             <div class="ai-row"><span>身高</span><b>${model.heightMeters.toFixed(2)} m（已按角色尺归一）</b></div>
             <div class="ai-row"><span>贴图</span><b>${model.image !== null ? '内嵌 ✓' : '无（平色预览）'}</b></div>
             <div class="ai-row"><span>子网格</span><b>${model.subMeshes.length} 条</b></div>
             ${subs}`,
          );
        })
        .catch((err) => {
          if (!alive()) return;
          stat.textContent = `解析失败：${String(err)}`;
        });
      return;
    }

    if (isTextExt(entry.ext) && entry.size > 0 && entry.size <= TEXT_PREVIEW_MAX_BYTES) {
      void fetch(fileUrl(path))
        .then(async (resp) => (resp.ok ? resp.text() : Promise.reject(new Error(`HTTP ${resp.status}`))))
        .then((text) => {
          if (!alive()) return;
          const lines = text.split('\n');
          const cut = lines.slice(0, TEXT_PREVIEW_LINES).join('\n');
          const more = lines.length > TEXT_PREVIEW_LINES ? `\n… 共 ${lines.length} 行` : '';
          const pre = document.createElement('pre');
          pre.className = 'ai-text';
          pre.textContent = cut + more;
          extra.appendChild(pre);
        })
        .catch(() => undefined);
      return;
    }

    if (['.gltf', '.obj', '.fbx', '.ply', '.stl', '.dae', '.usdz'].includes(entry.ext)) {
      extra.innerHTML = `<div class="ai-dim">编辑器当前只支持 .glb 拖入场景；该格式请先转换</div>`;
    }
  }

  /** 测试/控制台用：当前面板是否显示了某个资产的属性 */
  showing(): string | null {
    return this.rootEl.querySelector('.ai-name')?.textContent ?? null;
  }
}
