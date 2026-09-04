import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  BUILTIN_MODELS,
  MODEL_RULER_HEIGHT_M,
  normalizeMeshHeight,
  assetServer,
  resolveModelHeightM,
} from '../src/models';
import { ROSTER_CHARACTERS, requireCharacter } from '@aether/content';
import { createDefaultAssetMeta, newAssetGuid } from '@aether/scene';

/**
 * 内置模型清单的不变量测试（编辑器域）。
 *
 * 背景：BUILTIN_MODELS 目前是空数组（2026-09-01 把 E-04 三档 LOD 全清了，
 * 统一走「导入 GLB…」唯一路径）。空数组让这条测试变成空跑，但它守护的是
 * **将来**重新加内置档时那条最容易犯的错：忘记用同一把尺子归一化身高——
 * 历史上三档 LOD 身高 2.050/2.108/2.187，切档角色会长高最多 6.7%。
 *
 * 归一化实现本身已上提 `packages/scene`（引擎域纯几何），其回归见
 * `packages/scene/test/gltf.test.ts` 的「身高归一化」分组。
 */

function meshHeight(m: { vertices: Float32Array }): number {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < m.vertices.length; i += 15) {
    minY = Math.min(minY, m.vertices[i + 1]!);
    maxY = Math.max(maxY, m.vertices[i + 1]!);
  }
  return maxY - minY;
}

describe('内置模型清单', () => {
  it('每条内置档的实际身高都等于 roster 真源身高（防漂移回归）', () => {
    for (const bm of BUILTIN_MODELS) {
      expect(meshHeight(bm.mesh)).toBeCloseTo(MODEL_RULER_HEIGHT_M, 3);
      expect(bm.meta.heightMeters).toBeCloseTo(MODEL_RULER_HEIGHT_M, 6);
    }
  });

  it('身高常量来自 roster.json 的 E-04 盾卫（2.05 m），不得就地魔改', () => {
    expect(MODEL_RULER_HEIGHT_M).toBeCloseTo(2.05, 6);
  });

  // L-4：2026-09-03 起这个常量由 content 生成层从 roster.json 派生，不再是手抄的 2.05。
  // 光断言"等于 2.05"是不够的 —— 那样有人改回硬编码照样绿。这里直接比对生成物。
  it('归一化标尺严格等于 roster 里 E-04 的身高（溯源，防改回硬编码）', () => {
    expect(MODEL_RULER_HEIGHT_M).toBe(requireCharacter('E-04').heightMeters);
  });

  it('标尺是"一把尺子"而非"所有角色的身高"——roster 里身高本就各不相同', () => {
    const heights = ROSTER_CHARACTERS.map((c) => c.heightMeters);
    expect(new Set(heights).size).toBeGreaterThan(1);
    // 标尺必须落在 roster 的取值范围内，否则归一化会把角色拉成别的东西
    expect(MODEL_RULER_HEIGHT_M).toBeGreaterThanOrEqual(Math.min(...heights));
    expect(MODEL_RULER_HEIGHT_M).toBeLessThanOrEqual(Math.max(...heights));
  });

  it('归一化函数由引擎层提供，编辑器不再维护第二份实现', () => {
    // 手搓 2.4 m 高的两点网格，归一化后应为 2.05 m 且脚底贴 y=0
    const v = new Float32Array(2 * 15);
    v[1] = 0.3;
    v[16] = 2.7;
    const out = normalizeMeshHeight({ vertices: v, indices: new Uint32Array([0, 1, 0]) }, MODEL_RULER_HEIGHT_M);
    expect(meshHeight(out)).toBeCloseTo(MODEL_RULER_HEIGHT_M, 5);
    expect(out.vertices[1]).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------- .meta 接线

/**
 * `resolveModelHeightM` 是 `.meta.json` 在运行时被消费的**第一处**，
 * 所以这里测的不是底层 AssetServer（它有自己的 20 例），
 * 而是「编辑器这条链路真的会去读 sidecar」这件事本身。
 *
 * 单例用 `globalThis.fetch`，测试期用 `vi.stubGlobal` 顶掉。
 * 每次跑完必须 `clearCache()` —— 否则单例缓存会污染下一个用例。
 */
describe('resolveModelHeightM · .meta 接线', () => {
  const B02 = '/assets/characters/models/B-02/textured/B02_THE BROODMOTHER_6000_baked.glb';

  function stubFetch(handler: (url: string) => { status: number; body?: string }): void {
    vi.stubGlobal('fetch', async (url: string) => {
      const r = handler(url);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? '' };
    });
  }

  it('sidecar 指定了身高 → 用它，且 fromMeta=true（B-02 母体 4.0 m 不再被 E-04 的 2.05 覆盖）', async () => {
    const meta = createDefaultAssetMeta(newAssetGuid(), 'gltf');
    if (meta.importer) meta.importer.normalizeHeightM = 4.0;
    stubFetch(() => ({ status: 200, body: JSON.stringify(meta) }));
    assetServer.clearCache();

    const r = await resolveModelHeightM(B02);

    expect(r.meters).toBe(4.0);
    expect(r.fromMeta).toBe(true);
    expect(r.meters).not.toBe(MODEL_RULER_HEIGHT_M); // 2.05 —— 这就是修掉的那个 bug
  });

  it('没有 sidecar → 回落全局标尺，fromMeta=false（降级不能让加载失败）', async () => {
    stubFetch(() => ({ status: 404 }));
    assetServer.clearCache();

    const r = await resolveModelHeightM(B02);

    expect(r.meters).toBe(MODEL_RULER_HEIGHT_M);
    expect(r.fromMeta).toBe(false);
  });

  it('sidecar 损坏 → 回落全局标尺，不抛异常（便利层不是单点故障）', async () => {
    stubFetch(() => ({ status: 200, body: '{ 坏掉的 json' }));
    assetServer.clearCache();

    await expect(resolveModelHeightM(B02)).resolves.toEqual({
      meters: MODEL_RULER_HEIGHT_M,
      fromMeta: false,
    });
  });

  it('请求的是 sidecar 路径，不是源 GLB', async () => {
    const seen: string[] = [];
    const meta = createDefaultAssetMeta(newAssetGuid(), 'gltf');
    if (meta.importer) meta.importer.normalizeHeightM = 1.25;
    stubFetch((url) => {
      seen.push(url);
      return { status: 200, body: JSON.stringify(meta) };
    });
    assetServer.clearCache();

    await resolveModelHeightM(B02);

    expect(seen).toEqual([`${B02}.meta.json`]);
  });

  afterEach(() => {
    assetServer.clearCache();
    vi.unstubAllGlobals();
  });
});
