/**
 * 资产库共用工具：路径处理、格式化、类型图标。
 * asset-browser（底部浏览器）与 asset-inspector（右侧属性面板）都从这里取，
 * 避免两处各写一份导致行为漂移。
 */

/** 文件系统 API 返回的一条目录项（与 vite.config.ts 的 /__fs/list 对应） */
export interface FsEntry {
  name: string;
  kind: 'dir' | 'file';
  size: number;
  mtime: number;
  ext: string;
}

/** 浏览器选中资产时抛给 Inspector 的数据包 */
export interface AssetSelection {
  /** 相对项目根的路径（POSIX 分隔符，空串 = 根） */
  path: string;
  entry: FsEntry;
}

/** 拖拽资产时 dataTransfer 用的自定义 MIME（drop 方据此识别是不是资产拖拽） */
export const ASSET_MIME = 'application/x-zh-asset';

/** 相对路径拼接（全程 POSIX 风格，服务端 resolve 时自己转平台分隔符） */
export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

export function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** 去扩展名的文件名（生成场景物体名用） */
export function stemName(p: string): string {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? b : b.slice(0, i);
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);
const TEXT_EXTS = new Set([
  '.json', '.md', '.txt', '.py', '.ts', '.js', '.mjs', '.css', '.html', '.wgsl', '.csv', '.xml', '.yml', '.yaml', '.toml',
]);

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase());
}

export function isTextExt(ext: string): boolean {
  return TEXT_EXTS.has(ext.toLowerCase());
}

/** 文件内容的 URL（图片缩略图 / GLB fetch / 文本预览共用） */
export function fileUrl(path: string): string {
  return `/__fs/file?path=${encodeURIComponent(path)}`;
}

export async function listDir(dir: string): Promise<FsEntry[]> {
  const resp = await fetch(`/__fs/list?dir=${encodeURIComponent(dir)}`);
  if (!resp.ok) throw new Error(`目录读取失败 HTTP ${resp.status}`);
  const body = (await resp.json()) as { entries: FsEntry[] };
  return body.entries;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtTime(ms: number): string {
  if (ms <= 0) return '—';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 资产类型分类（图标 + 配色共用一套语义） */
export type AssetKind =
  | 'dir'
  | 'model'
  | 'image'
  | 'json'
  | 'script'
  | 'doc'
  | 'audio'
  | 'archive'
  | 'font'
  | 'file';

export function kindOf(entry: FsEntry): AssetKind {
  if (entry.kind === 'dir') return 'dir';
  const e = entry.ext.toLowerCase();
  if (['.glb', '.gltf', '.obj', '.fbx', '.ply', '.stl', '.dae', '.usdz'].includes(e)) return 'model';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (e === '.json') return 'json';
  if (['.py', '.ts', '.js', '.mjs', '.wgsl', '.css'].includes(e)) return 'script';
  if (['.md', '.txt', '.html', '.csv'].includes(e)) return 'doc';
  if (['.wav', '.mp3', '.ogg', '.flac'].includes(e)) return 'audio';
  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(e)) return 'archive';
  if (['.ttf', '.otf', '.woff', '.woff2'].includes(e)) return 'font';
  return 'file';
}

/** 类型名中文标签（Inspector 用） */
export const KIND_LABEL: Record<AssetKind, string> = {
  dir: '文件夹',
  model: '3D 模型',
  image: '图片',
  json: 'JSON 数据',
  script: '脚本',
  doc: '文档',
  audio: '音频',
  archive: '压缩包',
  font: '字体',
  file: '文件',
};

/**
 * 类型图标（内联 SVG，fill=currentColor，配色由 CSS 按 .akind-<kind> 给）。
 * 全部 24×24 viewBox，粗描边剪影风，贴合项目的美漫描边调性。
 */
const ICONS: Record<AssetKind, string> = {
  dir: '<svg viewBox="0 0 24 24"><path d="M2.5 5.5c0-1.1.9-2 2-2h4.6c.5 0 1 .2 1.4.6l1.7 1.7c.2.2.5.3.8.3h6.5c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2h-15c-1.1 0-2-.9-2-2v-12.5z"/></svg>',
  model: '<svg viewBox="0 0 24 24"><path d="M12 1.8l9 4.5v11.4l-9 4.5-9-4.5V6.3l9-4.5zm0 2.3L5.5 7.2 12 10.3l6.5-3.1L12 4.1zM4.5 8.9v8.2l6.5 3.2v-8.2L4.5 8.9zm15 0L13 12.1v8.2l6.5-3.2V8.9z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><path d="M3 4h18c.6 0 1 .4 1 1v14c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V5c0-.6.4-1 1-1zm1 2v10.6l4.3-4.3c.4-.4 1-.4 1.4 0l3.3 3.3 2.3-2.3c.4-.4 1-.4 1.4 0L20 16.6V6H4zm3.5 1a2 2 0 110 4 2 2 0 010-4z"/></svg>',
  json: '<svg viewBox="0 0 24 24"><path d="M7.6 4.5c.3.2.4.6.2 1-.3.5-.8.9-1.3 1.1-.6.3-1 .4-1.5.4-.3 0-.5.2-.5.5s.2.5.5.5c1.1 0 2.1.4 2.8 1.2.6.7.9 1.6.9 2.8s-.3 2.1-.9 2.8c-.7.8-1.7 1.2-2.8 1.2-.3 0-.5.2-.5.5s.2.5.5.5c.5 0 1 .1 1.5.4.5.2 1 .6 1.3 1.1.2.4.1.8-.2 1-.4.2-.8.1-1-.3-.2-.3-.5-.6-.8-.7-.4-.2-.8-.3-1.2-.3-.8 0-1.5-.3-2-.8-.5-.5-.8-1.2-.8-2 0-.5.1-.9.3-1.3.2-.4.5-.8.9-1-.4-.2-.7-.6-.9-1-.2-.4-.3-.8-.3-1.3 0-.8.3-1.5.8-2 .5-.5 1.2-.8 2-.8.4 0 .8-.1 1.2-.3.3-.1.6-.4.8-.7.2-.4.6-.5 1-.3zm8.8 0c.4-.2.8-.1 1 .3.2.3.5.6.8.7.4.2.8.3 1.2.3.8 0 1.5.3 2 .8.5.5.8 1.2.8 2 0 .5-.1.9-.3 1.3-.2.4-.5.8-.9 1 .4.2.7.6.9 1 .2.4.3.8.3 1.3 0 .8-.3 1.5-.8 2-.5.5-1.2.8-2 .8-.4 0-.8.1-1.2.3-.3.1-.6.4-.8.7-.2.4-.6.5-1 .3-.3-.2-.4-.6-.2-1 .3-.5.8-.9 1.3-1.1.6-.3 1-.4 1.5-.4.3 0 .5-.2.5-.5s-.2-.5-.5-.5c-1.1 0-2.1-.4-2.8-1.2-.6-.7-.9-1.6-.9-2.8s.3-2.1.9-2.8c.7-.8 1.7-1.2 2.8-1.2.3 0 .5-.2.5-.5s-.2-.5-.5-.5c-.5 0-1-.1-1.5-.4-.5-.2-1-.6-1.3-1.1-.2-.4-.1-.8.2-1z"/></svg>',
  script: '<svg viewBox="0 0 24 24"><path d="M8.7 5.3c.5.4.6 1.1.2 1.6L5.6 11l3.3 4.1c.4.5.3 1.2-.2 1.6-.5.4-1.2.3-1.6-.2l-4-5c-.4-.5-.4-1.2 0-1.7l4-5c.4-.5 1.1-.6 1.6-.2zm6.6 0c.5-.4 1.2-.3 1.6.2l4 5c.4.5.4 1.2 0 1.7l-4 5c-.4.5-1.1.6-1.6.2-.5-.4-.6-1.1-.2-1.6l3.3-4.1-3.3-4.1c-.4-.5-.3-1.2.2-1.6zm-4.1-2c.7-.1 1.3.5 1.2 1.2l-1.6 14c-.1.7-.8 1.2-1.5 1-.7-.1-1.2-.8-1-1.5l1.6-14c.1-.6.7-1.1 1.3-.7z"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M5 2h9.2c.5 0 1 .2 1.4.6l4.8 4.8c.4.4.6.9.6 1.4V21c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V3c0-.6.4-1 1-1zm8 2H6v16h12V9.5L14.5 6H14V4zm-6 6h10c.6 0 1 .4 1 1s-.4 1-1 1H7c-.6 0-1-.4-1-1s.4-1 1-1zm0 4h10c.6 0 1 .4 1 1s-.4 1-1 1H7c-.6 0-1-.4-1-1s.4-1 1-1z"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M12 3v10.6c-.4-.1-.9-.2-1.4-.2-2.2 0-4 1.5-4 3.3s1.8 3.3 4 3.3 4-1.5 4-3.3V7h5V3h-7.6z"/></svg>',
  archive: '<svg viewBox="0 0 24 24"><path d="M5 2h14c.6 0 1 .4 1 1v18c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V3c0-.6.4-1 1-1zm6 2v2h2V4h-2zm2 2v2h-2v2h2V6h-2v2h2V6h0v2h0V6zM6 4v16h12V4h-3v2h-2V4H9v2H7V4H6zm5 8h2v6h-2v-6z"/></svg>',
  font: '<svg viewBox="0 0 24 24"><path d="M10.7 4h2.6L18 18.5c.2.7-.2 1.4-.9 1.5-.5.1-1-.1-1.2-.6l-1.2-3.4H9.3l-1.2 3.4c-.2.6-1 .9-1.5.6-.6-.2-.9-1-.7-1.5L10.7 4zm1.3 3.2L10 14h4l-2-6.8z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M5 2h14c.6 0 1 .4 1 1v18c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V3c0-.6.4-1 1-1z"/></svg>',
};

export function iconSvg(kind: AssetKind): string {
  return ICONS[kind];
}
