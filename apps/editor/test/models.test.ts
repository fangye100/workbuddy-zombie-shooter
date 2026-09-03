import { describe, expect, it } from 'vitest';
import { BUILTIN_MODELS, MODEL_RULER_HEIGHT_M, normalizeMeshHeight } from '../src/models';
import { ROSTER_CHARACTERS, requireCharacter } from '@aether/content';

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
