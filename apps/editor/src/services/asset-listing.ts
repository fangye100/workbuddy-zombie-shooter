/** 项目真实文件的派生浏览视图；不保存资产索引或内容分类。 */
import { joinPath, kindOf, type FsEntry, type AssetKind } from '../asset-util';

export interface AssetEntry extends FsEntry { path: string }
export interface AssetListing { entries: AssetEntry[]; errors: string[] }
export type DirectoryReader = (path: string) => Promise<FsEntry[]>;
const safePath = (p: string): boolean => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(s => !s || s === '.' || s === '..');

export function assetScopeRoots(roots: readonly string[], dir: string): string[] {
  if (!roots.length || roots.some(p => !safePath(p))) throw new Error('项目assetRoots缺失或路径无效');
  const unique = [...new Set(roots)].filter(p => !roots.some(q => q !== p && p.startsWith(q + '/')));
  if (dir === '' || unique.includes(dir)) return unique;
  if (unique.some(p => dir.startsWith(p + '/'))) return [dir];
  throw new Error('递归浏览仅在项目assetRoots内可用');
}

/** 有界分批枚举；失败与容量边界显式返回，不能把部分列表称为完整。 */
export async function scanAssetRoots(roots: readonly string[], read: DirectoryReader, current: () => boolean = () => true): Promise<AssetListing> {
  const queue = [...new Set(roots)], seen = new Set<string>(), files = new Map<string, AssetEntry>(), errors: string[] = [];
  while (queue.length && current()) {
    const batch = queue.splice(0, 8).filter(p => !seen.has(p));
    if (seen.size + batch.length > 2000) { errors.push('目录超过2000项，列举不完整'); break; }
    batch.forEach(p => seen.add(p));
    const results = await Promise.all(batch.map(async dir => {
      try { return { dir, entries: await read(dir), error: null }; }
      catch (e) { return { dir, entries: [] as FsEntry[], error: String(e) }; }
    }));
    for (const result of results) {
      if (result.error) errors.push(result.dir + ': ' + result.error);
      for (const entry of result.entries) {
        if (!entry.name || entry.name.includes('/') || entry.name.includes('\\') || ['.', '..'].includes(entry.name)) { errors.push(result.dir + ': 无效目录条目'); continue; }
        const path = joinPath(result.dir, entry.name);
        if (entry.kind === 'dir') { if (!seen.has(path) && !queue.includes(path)) queue.push(path); }
        else files.set(path, { ...entry, path });
      }
    }
    if (files.size > 20000) { errors.push('文件超过20000项，列举不完整'); break; }
  }
  return { entries: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh')), errors };
}

export function filterAssetEntries(entries: readonly AssetEntry[], query: string, kind: AssetKind | 'all'): AssetEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter(e => (kind === 'all' || kindOf(e) === kind) && (!needle || e.path.toLowerCase().includes(needle)));
}

/** 导航与异步列表共用世代；过期响应不能写回当前目录。 */
export class AssetListingRequest {
  private revision = 0;
  invalidate(): void { this.revision++; }
  async run(load: (current: () => boolean) => Promise<AssetListing>): Promise<AssetListing | null> {
    const revision = ++this.revision, current = (): boolean => revision === this.revision;
    const result = await load(current);
    return current() ? result : null;
  }
}

/** 仅显示已有状态，不根据文件名或派生目录授予美术/玩法批准。 */
export function assetStatus(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const data = (meta as { userData?: unknown }).userData;
  if (!data || typeof data !== 'object') return null;
  const { status, variant } = data as { status?: unknown; variant?: unknown };
  return [variant, status].filter((v): v is string => typeof v === 'string' && !!v).join(' · ') || null;
}
