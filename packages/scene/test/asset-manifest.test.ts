import { describe, expect, it } from 'vitest';
import {
  normalizeManifestPath,
  parseAssetManifest,
  lodDeltaVsLod0,
  formatLodStats,
} from '../src/asset-manifest';

/** 最小可用清单夹具：一个角色（3 档 LOD）+ 一个环境（1 档）+ 各类坏条目 */
const FIXTURE = {
  characters: [
    {
      id: 'E-01',
      lods: [
        { label: 'LOD0 · 原生高模', file: 'characters/models/E-01/E01_raw.glb', tris: 79744, verts: 54414, bytes: 44274008 },
        { label: 'LOD1 · 贴图低模', file: 'characters/models/E-01/textured/E01_baked.glb', tris: 3000, verts: 4209, bytes: 2963204 },
        { label: 'LOD2 · +动画', file: 'characters/models/E-01/rigged/E01_anim.glb', tris: 3000, verts: 4209 },
      ],
    },
    { id: 'E-02', lods: 'not-an-array' }, // 坏条目：lods 非数组
    { id: 'E-03', lods: [{ label: '缺 file' }] }, // 坏条目：LOD 无 file
    { id: 'E-04' }, // 坏条目：没有 lods
  ],
  environments: [
    { id: 'gas-station', lods: [{ file: 'environments/gas/gas_baked.glb', tris: 1200, verts: 900 }] },
  ],
  // 未知 section 应被忽略
  props: [{ id: 'barrel', lods: [{ file: 'props/barrel.glb' }] }],
};

describe('normalizeManifestPath', () => {
  it('相对 assets/ 的路径补上前缀', () => {
    expect(normalizeManifestPath('characters/models/E-01/a.glb')).toBe('assets/characters/models/E-01/a.glb');
  });
  it('已带 assets/ 前缀的不重复补', () => {
    expect(normalizeManifestPath('assets/characters/a.glb')).toBe('assets/characters/a.glb');
  });
  it('反斜杠与 ./ 前缀归一', () => {
    expect(normalizeManifestPath('.\\characters\\a.glb')).toBe('assets/characters/a.glb');
  });
});

describe('parseAssetManifest', () => {
  const { families, skipped } = parseAssetManifest(FIXTURE);

  it('家族成员都指向同一数组（查任一档即得全家）', () => {
    const a = families.get('assets/characters/models/E-01/E01_raw.glb');
    const b = families.get('assets/characters/models/E-01/rigged/E01_anim.glb');
    expect(a).toBeDefined();
    expect(a).toBe(b); // 同一引用
    expect(a!.map((l) => l.label)).toEqual(['LOD0 · 原生高模', 'LOD1 · 贴图低模', 'LOD2 · +动画']);
  });

  it('路径全部归一化为项目根相对（带 assets/ 前缀）', () => {
    for (const key of families.keys()) expect(key.startsWith('assets/')).toBe(true);
    expect(families.has('assets/environments/gas/gas_baked.glb')).toBe(true);
  });

  it('可选统计字段透传、缺失不造数', () => {
    const lod2 = families.get('assets/characters/models/E-01/rigged/E01_anim.glb')![2]!;
    expect(lod2.bytes).toBeUndefined();
    expect(lod2.tris).toBe(3000);
  });

  it('坏条目跳过并计数，不抛异常', () => {
    // 4 = E-02(lods 非数组) + E-03 的坏 LOD(缺 file) + E-03 家族因此为空再计一次 + E-04(无 lods)
    expect(skipped).toBe(4);
    expect([...families.keys()].length).toBe(4); // 角色家族 3 档 + 环境 1 档
  });

  it('未知 section（props）被忽略', () => {
    expect(families.has('assets/props/barrel.glb')).toBe(false);
  });

  it('非对象输入安全返回空', () => {
    expect(parseAssetManifest(null).families.size).toBe(0);
    expect(parseAssetManifest('str').families.size).toBe(0);
    expect(parseAssetManifest(42).skipped).toBe(0);
  });
});

describe('LOD 统计', () => {
  const { families } = parseAssetManifest(FIXTURE);
  const fam = families.get('assets/characters/models/E-01/textured/E01_baked.glb')!;

  it('降幅相对 LOD0（负 = 减少）', () => {
    expect(lodDeltaVsLod0(fam, 'assets/characters/models/E-01/textured/E01_baked.glb', 'tris')).toBe('-96%');
  });
  it('LOD0 自身或基准缺失返回 null', () => {
    expect(lodDeltaVsLod0(fam, 'assets/characters/models/E-01/E01_raw.glb', 'tris')).toBeNull();
    expect(lodDeltaVsLod0(fam, 'assets/characters/models/E-01/rigged/E01_anim.glb', 'bytes')).toBeNull();
  });
  it('统计行：千分位 + Δ 降幅；LOD0 无 Δ', () => {
    expect(formatLodStats(fam, 'assets/characters/models/E-01/textured/E01_baked.glb')).toBe('3,000 tris · 4,209 verts · Δ-96%');
    expect(formatLodStats(fam, 'assets/characters/models/E-01/E01_raw.glb')).toBe('79,744 tris · 54,414 verts');
    expect(formatLodStats(fam, 'assets/not/in/family.glb')).toBe('');
  });
});
