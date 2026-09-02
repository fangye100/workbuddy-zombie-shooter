import { describe, expect, it } from 'vitest';
import { weldMesh } from './geometry';
import type { MeshData } from './geometry';

/**
 * 焊接（Merge Points）回归测试。
 *
 * 背景（2026 严重缺陷）：早期 weldMesh 只按 (x,y,z) 量化建键，
 * 同位置但 UV 不同的顶点（UV 岛接缝、镜像点）被错误合并 → 贴图破碎。
 * 行业标准做法（Blender Merge by Distance / Maya merge verts）：键必须包含 UV。
 */

const VF = 15;

/** 造一个 stride 15 的顶点。UV 槽位是 o+9 / o+10 */
function v(x: number, y: number, z: number, u: number, v: number): number[] {
  const a = new Array(VF).fill(0);
  a[0] = x;
  a[1] = y;
  a[2] = z;
  a[9] = u;
  a[10] = v;
  return a;
}

/** 把若干顶点 + 三角形索引打成 MeshData */
function makeMesh(verts: number[][], indices: number[]): MeshData {
  const flat = new Float32Array(verts.length * VF);
  for (let i = 0; i < verts.length; i++) {
    for (let j = 0; j < VF; j++) flat[i * VF + j] = verts[i]![j]!;
  }
  return { vertices: flat, indices: new Uint32Array(indices) };
}

describe('weldMesh（合并点）—— 关键 UV 安全规则', () => {
  it('位置 + UV 都相同 → 合并', () => {
    // 构造"每个顶点都被重复一次"的真实合并场景：原 4 顶点 + 4 个全等副本 = 8 顶点
    const quad = [
      v(0, 0, 0, 0.1, 0.2),
      v(1, 0, 0, 0.5, 0.2),
      v(0, 1, 0, 0.1, 0.5),
      v(1, 1, 0, 0.5, 0.5),
    ];
    const withDup: number[][] = [];
    const idx: number[] = [];
    for (let i = 0; i < 4; i++) {
      withDup.push(quad[i % 4]!); // 原点
      withDup.push(quad[i % 4]!); // 同位置同 UV 的副本
    }
    for (let i = 0; i < 8; i += 4) {
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    const mesh = makeMesh(withDup, idx);
    const w = weldMesh(mesh);
    expect(w.vertices.length / VF).toBe(4);
    expect(w.indices.length).toBe(mesh.indices.length);
  });

  it('位置相同 UV 不同（UV 岛接缝）→ 不合并', () => {
    // 同一个空间点，但在两个不同的 UV 岛上（接缝点）—— 绝不能合并
    const mesh = makeMesh(
      [
        v(0, 0, 0, 0.1, 0.2), // UV 岛 A
        v(0, 0, 0, 0.9, 0.8), // UV 岛 B（位置完全相同！）
      ],
      [0, 1, 0], // 退化三角形不影响顶点计数
    );
    const w = weldMesh(mesh);
    expect(w.vertices.length / VF).toBe(2); // 必须保持两个
  });

  it('位置接近（容差内）UV 相同 → 合并', () => {
    const mesh = makeMesh(
      [
        v(0, 0, 0, 0.5, 0.5),
        v(1e-5, 1e-5, -1e-5, 0.5, 0.5), // 在 1e-4 容差内，UV 同
      ],
      [0, 1, 0],
    );
    const w = weldMesh(mesh);
    expect(w.vertices.length / VF).toBe(1);
  });

  it('位置接近（容差内）UV 不同 → 不合并（双胞胎硬边点）', () => {
    const mesh = makeMesh(
      [
        v(0, 0, 0, 0.0, 0.0),
        v(1e-5, 1e-5, -1e-5, 1.0, 1.0), // UV 完全不同（典型镜像点）
      ],
      [0, 1, 0],
    );
    const w = weldMesh(mesh);
    expect(w.vertices.length / VF).toBe(2);
  });

  it('重映射索引不破：原指同一顶点的新索引全部合并到唯一目标', () => {
    const mesh = makeMesh(
      [
        v(0, 0, 0, 0.5, 0.5),
        v(0, 0, 0, 0.5, 0.5), // 与顶点 0 全等
      ],
      [0, 1, 0, 1, 0, 0],
    );
    const w = weldMesh(mesh);
    const u = w.indices;
    expect(w.vertices.length / VF).toBe(1);
    // 所有索引必须是同一个值，且合法
    const unique = new Set<number>(u);
    expect(unique.size).toBe(1);
    const idx = u[0]!;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(w.vertices.length / VF);
  });
});