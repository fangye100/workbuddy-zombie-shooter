import { describe, it, expect } from 'vitest';
import { assetScopeRoots, scanAssetRoots, filterAssetEntries, AssetListingRequest, assetStatus } from '../src/services/asset-listing';
import type { FsEntry } from '../src/asset-util';

const entry = (name: string, kind: 'file' | 'dir' = 'file'): FsEntry => ({ name, kind, ext: kind === 'dir' ? '' : name.slice(name.lastIndexOf('.')), size: 1, mtime: 0 });

describe('项目资产递归浏览', () => {
  it('当前子目录限定范围；项目根/任一资产根合并assetRoots并去重', () => {
    expect(assetScopeRoots(['assets', 'assets/art', 'shared'], 'assets')).toEqual(['assets', 'shared']);
    expect(assetScopeRoots(['assets', 'shared'], 'assets/art')).toEqual(['assets/art']);
    expect(() => assetScopeRoots(['../assets'], '')).toThrow();
    expect(() => assetScopeRoots(['assets'], 'tools')).toThrow();
  });
  it('同名跨目录模型保留真实完整路径，重叠根不重复，筛选匹配路径及类型', async () => {
    const tree: Record<string, FsEntry[]> = {
      assets: [entry('source', 'dir'), entry('lod', 'dir')],
      'assets/source': [entry('WPN.glb'), entry('preview.png')],
      'assets/lod': [entry('WPN.glb')],
    };
    const result = await scanAssetRoots(['assets', 'assets/lod'], async p => tree[p] ?? []);
    expect(result.errors).toEqual([]);
    expect(filterAssetEntries(result.entries, 'wpn', 'model').map(e => e.path)).toEqual(['assets/lod/WPN.glb', 'assets/source/WPN.glb']);
    expect(filterAssetEntries(result.entries, 'source/', 'model').map(e => e.path)).toEqual(['assets/source/WPN.glb']);
    expect(filterAssetEntries(result.entries, '', 'image')).toHaveLength(1);
  });
  it('局部目录失败仍保留成功项且明确不完整，不静默当空目录', async () => {
    const result = await scanAssetRoots(['assets', 'shared'], async p => {
      if (p === 'shared') throw new Error('permission denied');
      return [entry('ok.glb')];
    });
    expect(result.entries.map(e => e.path)).toEqual(['assets/ok.glb']);
    expect(result.errors[0]).toContain('shared: Error: permission denied');
  });
  it('快速导航丢弃晚到旧列表，取消后不继续递归', async () => {
    const requests = new AssetListingRequest();
    let finish!: () => void;
    const old = requests.run(async () => { await new Promise<void>(r => { finish = r; }); return { entries: [], errors: ['old'] }; });
    const latest = await requests.run(async () => ({ entries: [], errors: ['latest'] }));
    finish();
    expect(await old).toBeNull();
    expect(latest?.errors).toEqual(['latest']);
    let active = true;
    const reads: string[] = [];
    await scanAssetRoots(['assets'], async p => { reads.push(p); active = false; return [entry('child', 'dir')]; }, () => active);
    expect(reads).toEqual(['assets']);
  });
  it('只显示已有候选状态，不由路径或缺少状态推断批准', () => {
    expect(assetStatus({ userData: { variant: 'without-mag', status: 'visual-review-candidate' } })).toBe('without-mag · visual-review-candidate');
    expect(assetStatus({ userData: {} })).toBeNull();
    expect(assetStatus(null)).toBeNull();
  });
});
