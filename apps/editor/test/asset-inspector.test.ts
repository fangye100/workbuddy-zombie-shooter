import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAssetMeta, newAssetGuid, parseGlb } from '@aether/scene';
import { assetServer } from '../src/models';
import { loadAssetInspectorModel } from '../src/asset-inspector';

vi.mock('@aether/scene', async importOriginal => ({ ...await importOriginal<object>(), parseGlb: vi.fn(() => ({ heightMeters: 0.25 })) }));

describe('资产Inspector导入契约', () => {
  const path = 'assets/art/WPN-TEST/game_ready/LOD0.glb';
  const buffer = new ArrayBuffer(8);
  afterEach(() => { assetServer.clearCache(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it.each([false, true])('同一真实路径读取sidecar，null米制与upAxisFlip=%s进入解析器', async flip => {
    const meta = createDefaultAssetMeta(newAssetGuid(), 'gltf');
    meta.importer.normalizeHeightM = null;
    meta.importer.upAxisFlip = flip;
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { paths.push(url); return { ok: true, status: 200, arrayBuffer: async () => buffer, text: async () => JSON.stringify(meta) }; });
    const result = await loadAssetInspectorModel(path);
    expect(parseGlb).toHaveBeenCalledWith(buffer, null, flip ? 'z' : 'y');
    expect(result.guid).toBe(meta.guid);
    expect(paths).toEqual([`/__fs/file?path=${encodeURIComponent(path)}`, `/__fs/file?path=${encodeURIComponent(path + '.meta.json')}`]);
  });
  it('缺失或坏元数据明确失败，不套角色标尺或伪造属性', async () => {
    vi.stubGlobal('fetch', async (url: string) => ({ ok: !decodeURIComponent(url).endsWith('.meta.json'), status: 404, arrayBuffer: async () => buffer, text: async () => '' }));
    await expect(loadAssetInspectorModel(path)).rejects.toThrow('资产元数据缺失或无效');
    expect(parseGlb).not.toHaveBeenCalled();
  });
});
