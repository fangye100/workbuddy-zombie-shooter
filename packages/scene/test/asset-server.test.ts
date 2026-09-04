/**
 * AssetServer 测试（ADR-009：测试与被测代码同位）。
 *
 * 只测**加载与降级行为**，不打真实网络。fetch 全部注入假实现 ——
 * 这也是 `AssetFetch` 鸭子类型存在的理由。
 */
import { describe, it, expect } from 'vitest';
import {
  AssetServer,
  normalizeAssetPath,
  DIAG_MISSING,
  DIAG_UNREADABLE,
  DIAG_BAD_JSON,
  DIAG_NOT_OBJECT,
  type AssetFetch,
  type AssetFetchResponse,
} from '../src/asset-server';
import { createDefaultAssetMeta, newAssetGuid, type AssetMeta } from '../src/asset-meta';

/** 造一个假 fetch。`handler` 返回响应，或抛错（模拟网络异常） */
function makeFetch(
  handler: (url: string) => { status: number; body?: string } | Promise<{ status: number; body?: string }>,
): AssetFetch {
  let calls = 0;
  const fn = async (url: string): Promise<AssetFetchResponse> => {
    calls += 1;
    const r = await handler(url);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body ?? '',
    };
  };
  (fn as unknown as { calls: () => number }).calls = () => calls;
  return fn as AssetFetch & { calls: () => number };
}

const ASSET = '/assets/characters/models/E-04/rigged/E04.glb';
const SIDECAR = `${ASSET}.meta.json`;

/** 一份干净的合法 meta，身高设为 2.05（E-04 的真值） */
function goodMeta(height: number | null = 2.05): AssetMeta {
  const m = createDefaultAssetMeta(newAssetGuid(), 'gltf');
  if (m.importer) m.importer.normalizeHeightM = height;
  return m;
}

function codes(d: { code: string }[]): string[] {
  return d.map((x) => x.code);
}

describe('normalizeAssetPath', () => {
  it('补前导斜杠，去掉尾随斜杠', () => {
    expect(normalizeAssetPath('assets/x/a.glb')).toBe('/assets/x/a.glb');
    expect(normalizeAssetPath('/assets/x/a.glb')).toBe('/assets/x/a.glb');
    expect(normalizeAssetPath('/assets/x/')).toBe('/assets/x');
    expect(normalizeAssetPath('  /assets/x/a.glb  ')).toBe('/assets/x/a.glb');
  });

  it('同一文件的两种写法规范化后相同（否则缓存会有两条键）', () => {
    expect(normalizeAssetPath('assets/x/a.glb')).toBe(normalizeAssetPath('/assets/x/a.glb'));
  });
});

describe('AssetServer.loadMeta · 成功路径', () => {
  it('读到合法 sidecar → meta 原样返回，无 error，missing=false', async () => {
    const meta = goodMeta();
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 200, body: JSON.stringify(meta) })) });

    const load = await server.loadMeta(ASSET);

    expect(load.missing).toBe(false);
    expect(load.errors).toEqual([]);
    expect(load.meta.guid).toBe(meta.guid);
    expect(load.meta.importer?.normalizeHeightM).toBe(2.05);
  });

  it('请求的 URL 是 sidecar 而不是源资产', async () => {
    const seen: string[] = [];
    const server = new AssetServer({
      fetchImpl: makeFetch((url) => {
        seen.push(url);
        return { status: 200, body: JSON.stringify(goodMeta()) };
      }),
    });

    await server.loadMeta(ASSET);
    expect(seen).toEqual([SIDECAR]);
  });

  it('合法 JSON 但 schema 非法 → 带 schema 诊断，且诊断 path 带 sidecar 前缀', async () => {
    const meta = goodMeta();
    if (meta.importer) meta.importer.maxSubMeshes = 0; // 触发 E_META_MAXSUB
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 200, body: JSON.stringify(meta) })) });

    const load = await server.loadMeta(ASSET);

    expect(codes(load.diagnostics)).toContain('E_META_MAXSUB');
    expect(load.errors.length).toBeGreaterThan(0);
    expect(load.diagnostics[0]?.path.startsWith(SIDECAR)).toBe(true);
    // 即便 schema 有问题，meta 本身仍要返回 —— 调用方能用多少用多少
    expect(load.meta.guid).toBe(meta.guid);
  });
});

describe('AssetServer.loadMeta · 降级路径（全部不抛异常）', () => {
  it('404 → 默认 meta + W_ASSET_META_MISSING（缺 sidecar 是正常状态，不是错误）', async () => {
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 404 })) });

    const load = await server.loadMeta(ASSET);

    expect(load.missing).toBe(true);
    expect(codes(load.diagnostics)).toContain(DIAG_MISSING);
    expect(load.errors).toEqual([]);
    // 默认 meta 必须能直接用，不能是 undefined
    expect(load.meta.importer?.normalizeHeightM).toBeNull();
    expect(load.meta.bindings).toEqual([]);
  });

  it('HTTP 500 → E_ASSET_META_UNREADABLE（这是错误，不是缺失）', async () => {
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 500 })) });

    const load = await server.loadMeta(ASSET);

    expect(load.missing).toBe(false);
    expect(codes(load.diagnostics)).toContain(DIAG_UNREADABLE);
    expect(load.errors.length).toBe(1);
  });

  it('JSON 坏了 → E_ASSET_META_BAD_JSON', async () => {
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 200, body: '{ 这不是 json' })) });

    const load = await server.loadMeta(ASSET);

    expect(codes(load.diagnostics)).toContain(DIAG_BAD_JSON);
    expect(load.errors.length).toBe(1);
    expect(load.meta.bindings).toEqual([]);
  });

  it('顶层是数组 → E_ASSET_META_NOT_OBJECT', async () => {
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 200, body: '[]' })) });

    const load = await server.loadMeta(ASSET);

    expect(codes(load.diagnostics)).toContain(DIAG_NOT_OBJECT);
  });

  it('顶层是 null → E_ASSET_META_NOT_OBJECT', async () => {
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 200, body: 'null' })) });

    expect(codes((await server.loadMeta(ASSET)).diagnostics)).toContain(DIAG_NOT_OBJECT);
  });

  it('fetch 抛错 → E_ASSET_META_UNREADABLE，不向外冒泡', async () => {
    const server = new AssetServer({
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });

    const load = await server.loadMeta(ASSET);

    expect(codes(load.diagnostics)).toContain(DIAG_UNREADABLE);
    expect(load.errors[0]?.message).toContain('network down');
  });

  it('没有 fetch 实现 → E_ASSET_META_UNREADABLE，不抛（测试环境可能没 globalThis.fetch）', async () => {
    // 不注入 fetchImpl，构造时 environment 也没 fetch 时会走这条；
    // 有 globalThis.fetch 时也至少不能抛异常。
    const server = new AssetServer({});
    await expect(server.loadMeta(ASSET)).resolves.toBeTruthy();
  });
});

describe('AssetServer · 缓存', () => {
  it('同一路径第二次不发起请求', async () => {
    const fetchImpl = makeFetch(() => ({ status: 200, body: JSON.stringify(goodMeta()) })) as AssetFetch & {
      calls: () => number;
    };
    const server = new AssetServer({ fetchImpl });

    await server.loadMeta(ASSET);
    await server.loadMeta(ASSET);

    expect(fetchImpl.calls()).toBe(1);
  });

  it('两种写法（有无前导斜杠）命中同一条缓存', async () => {
    const fetchImpl = makeFetch(() => ({ status: 200, body: JSON.stringify(goodMeta()) })) as AssetFetch & {
      calls: () => number;
    };
    const server = new AssetServer({ fetchImpl });

    await server.loadMeta('assets/x/a.glb');
    await server.loadMeta('/assets/x/a.glb');

    expect(fetchImpl.calls()).toBe(1);
    expect(server.cachedPaths()).toEqual(['/assets/x/a.glb']);
  });

  it('clearCache 之后重新加载（编辑 .meta 后的正确姿势）', async () => {
    const fetchImpl = makeFetch(() => ({ status: 200, body: JSON.stringify(goodMeta()) })) as AssetFetch & {
      calls: () => number;
    };
    const server = new AssetServer({ fetchImpl });

    await server.loadMeta(ASSET);
    server.clearCache();
    await server.loadMeta(ASSET);

    expect(fetchImpl.calls()).toBe(2);
    expect(server.cachedPaths()).toHaveLength(1);
  });

  it('cache:false 每次都重新读', async () => {
    const fetchImpl = makeFetch(() => ({ status: 200, body: JSON.stringify(goodMeta()) })) as AssetFetch & {
      calls: () => number;
    };
    const server = new AssetServer({ fetchImpl, cache: false });

    await server.loadMeta(ASSET);
    await server.loadMeta(ASSET);

    expect(fetchImpl.calls()).toBe(2);
    expect(server.cachedPaths()).toEqual([]);
  });
});

describe('AssetServer.resolveHeightM', () => {
  it('sidecar 配了身高 → 用 sidecar 的（这是 .meta 存在的意义）', async () => {
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 200, body: JSON.stringify(goodMeta(4.0)) })) });

    // B-02 母体 4.0m，不再被 E-04 的 2.05 硬编码覆盖
    await expect(server.resolveHeightM(ASSET, 2.05)).resolves.toBe(4.0);
  });

  it('sidecar 没配（null）→ 回落调用方的 fallback', async () => {
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 200, body: JSON.stringify(goodMeta(null)) })) });

    await expect(server.resolveHeightM(ASSET, 2.05)).resolves.toBe(2.05);
  });

  it('sidecar 缺失 → 回落 fallback', async () => {
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 404 })) });

    await expect(server.resolveHeightM(ASSET, 2.05)).resolves.toBe(2.05);
  });

  it('sidecar 配了 0 → 回落 fallback（生成器铁律：解析失败是 null 不是 0，0 同样是非法身高）', async () => {
    const server = new AssetServer({ fetchImpl: makeFetch(() => ({ status: 200, body: JSON.stringify(goodMeta(0)) })) });

    await expect(server.resolveHeightM(ASSET, 2.05)).resolves.toBe(2.05);
  });
});
