import { describe, expect, it } from 'vitest';
import * as m4 from '@aether/core';

/**
 * 拾取数学回归测试（纯 CPU，零 GPU 依赖）。
 *
 * 背景：rayTri 曾把 Möller–Trumbore 的 q = tvec × edge1 误写成 tvec × edge2，
 * v 几乎恒为负 → 拾取从未命中过任何物体，typecheck 查不出这种数学错误。
 * 本文件用已知几何基准 + 投影往返把守。
 *
 * 2026-09-03 归位：原 `apps/editor/src/gpu/math.test.ts`，随数学真源迁回 packages/core。
 */

/** 最小网格形状（与 @aether/scene 的 MeshData 同构，此处本地声明避免 L0 反向依赖 L4） */
interface TriMesh {
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * 单位立方体（stride 15）。
 *
 * 为什么不 import `@aether/scene` 的 createBox：core 是 L0、scene 是 L4，
 * 测试反向依赖上层会把分层图撑成环。这里只需要「一个闭合的三角形网格」
 * 验证 rayTri 端到端，12 个三角形手搓即可，不值得为此引入跨层依赖。
 */
function unitBox(): TriMesh {
  const P: readonly (readonly number[])[] = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ];
  const F: readonly (readonly number[])[] = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const vertices = new Float32Array(P.length * 15);
  P.forEach((p, i) => {
    vertices[i * 15] = p[0]!;
    vertices[i * 15 + 1] = p[1]!;
    vertices[i * 15 + 2] = p[2]!;
  });
  return { vertices, indices: new Uint32Array(F.flat()) };
}

/** 基准三角形：(-1,-1,5) (1,-1,5) (0,1,5)，射线原点沿 +z → 应命中 t=5, u=0.25, v=0.5 */
const BASE_TRI = [-1, -1, 5, 1, -1, 5, 0, 1, 5] as const;

describe('rayTri（Möller–Trumbore）', () => {
  it('基准命中：t=5', () => {
    const t = m4.rayTri(0, 0, 0, 0, 0, 1, ...BASE_TRI);
    expect(t).toBeCloseTo(5, 5);
  });

  it('双面命中：从背面 -z 方向打也应命中 t=5（无剔除）', () => {
    const t = m4.rayTri(0, 0, 10, 0, 0, -1, ...BASE_TRI);
    expect(t).toBeCloseTo(5, 5);
  });

  it('平行射线不命中', () => {
    // 射线在三角形平面外沿 x 方向，与 z=5 平面平行
    const t = m4.rayTri(0, 0, 0, 1, 0, 0, ...BASE_TRI);
    expect(t).toBe(-1);
  });

  it('射线在三角形平面内滑动不命中（det≈0 分支）', () => {
    const t = m4.rayTri(-1, -1, 5, 1, 0, 0, ...BASE_TRI);
    expect(t).toBe(-1);
  });

  it('u 超界不命中（三角形外侧）', () => {
    // 指向 x=3（三角形右边界外）
    const t = m4.rayTri(3, -0.9, 0, 0, 0, 1, ...BASE_TRI);
    expect(t).toBe(-1);
  });

  it('u+v 超界不命中（斜边外侧）', () => {
    // 指向 (0, 1.5)：v = 1.25 > 1
    const t = m4.rayTri(0, 1.5, 0, 0, 0, 1, ...BASE_TRI);
    expect(t).toBe(-1);
  });
});

describe('投影 → 反投影往返（拾取射线正确性）', () => {
  // 复刻 main.ts / renderer.ts 的相机约定：45° FOV、WebGPU 深度 [0,1]、orbitEye + lookAt
  const W = 1920;
  const H = 1080;
  const camera = { yaw: 0.35, distance: 9, target: [0, 0.95, 0] as const };
  const elevation = 55;

  const proj = m4.mat4();
  const view = m4.mat4();
  const viewProj = m4.mat4();
  const inv = m4.mat4();
  m4.perspective(proj, (45 * Math.PI) / 180, W / H, 0.1, 200);
  const eye = m4.orbitEye(camera.target, camera.distance, camera.yaw, elevation);
  m4.lookAt(view, eye, camera.target, [0, 1, 0]);
  m4.multiply(viewProj, proj, view);
  m4.invert(inv, viewProj);

  function worldToNdc(p: readonly [number, number, number]): [number, number] {
    const cx = viewProj[0]! * p[0] + viewProj[4]! * p[1] + viewProj[8]! * p[2] + viewProj[12]!;
    const cy = viewProj[1]! * p[0] + viewProj[5]! * p[1] + viewProj[9]! * p[2] + viewProj[13]!;
    const cw = viewProj[3]! * p[0] + viewProj[7]! * p[1] + viewProj[11]! * p[2] + viewProj[15]!;
    return [cx / cw, cy / cw];
  }

  function unproject(x: number, y: number, z: number): [number, number, number] {
    const wx = inv[0]! * x + inv[4]! * y + inv[8]! * z + inv[12]!;
    const wy = inv[1]! * x + inv[5]! * y + inv[9]! * z + inv[13]!;
    const wz = inv[2]! * x + inv[6]! * y + inv[10]! * z + inv[14]!;
    const w = inv[3]! * x + inv[7]! * y + inv[11]! * z + inv[15]!;
    const iw = Math.abs(w) < 1e-9 ? 1 : 1 / w;
    return [wx * iw, wy * iw, wz * iw];
  }

  it('世界点投影 → 反投影回的射线过该点（误差 < 1e-4）', () => {
    const points: [number, number, number][] = [
      [2.4, 0.5, 0.6], // 立方体
      [-2.4, 0.55, 0.6], // 球体
      [0, 0.84, 0], // 角色
      [0, 0, 0], // 原点
    ];
    for (const p of points) {
      const [nx, ny] = worldToNdc(p);
      expect(Math.abs(nx)).toBeLessThan(1);
      expect(Math.abs(ny)).toBeLessThan(1);
      const near = unproject(nx, ny, 0);
      const far = unproject(nx, ny, 1);
      let dx = far[0]! - near[0]!;
      let dy = far[1]! - near[1]!;
      let dz = far[2]! - near[2]!;
      const dl = Math.hypot(dx, dy, dz);
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const w = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const tp = w[0]! * dx + w[1]! * dy + w[2]! * dz;
      const dist = Math.hypot(w[0]! - dx * tp, w[1]! - dy * tp, w[2]! - dz * tp);
      expect(dist).toBeLessThan(1e-4);
    }
  });

  it('NDC z=0 对应近平面、z=1 对应远平面（WebGPU [0,1] 深度约定）', () => {
    const near = unproject(0, 0, 0);
    const far = unproject(0, 0, 1);
    // 近点在相机前方 0.1，远点在前方 200
    const dn = Math.hypot(near[0] - eye[0], near[1] - eye[1], near[2] - eye[2]);
    const df = Math.hypot(far[0] - eye[0], far[1] - eye[1], far[2] - eye[2]);
    expect(dn).toBeCloseTo(0.1, 3);
    expect(df).toBeCloseTo(200, 1);
  });

  it('盒子网格：射线过中心必命中某三角形（端到端 rayTri + 真实 createBox 网格）', () => {
    const boxPos: [number, number, number] = [2.4, 0.5, 0.6];
    const mesh = unitBox();
    const M = m4.mat4();
    m4.composeQuat(M, boxPos[0], boxPos[1], boxPos[2], [0, 0, 0, 1], 1);
    const [nx, ny] = worldToNdc(boxPos);
    const near = unproject(nx, ny, 0);
    const far = unproject(nx, ny, 1);
    let dx = far[0]! - near[0]!;
    let dy = far[1]! - near[1]!;
    let dz = far[2]! - near[2]!;
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl;
    dy /= dl;
    dz /= dl;
    const idx = mesh.indices;
    const v = mesh.vertices;
    let hit = false;
    for (let t = 0; t < idx.length; t += 3) {
      const tri = [idx[t]!, idx[t + 1]!, idx[t + 2]!].map((j) => {
        const vx = v[j * 15]!;
        const vy = v[j * 15 + 1]!;
        const vz = v[j * 15 + 2]!;
        return [
          M[0]! * vx + M[4]! * vy + M[8]! * vz + M[12]!,
          M[1]! * vx + M[5]! * vy + M[9]! * vz + M[13]!,
          M[2]! * vx + M[6]! * vy + M[10]! * vz + M[14]!,
        ];
      });
      const tHit = m4.rayTri(
        near[0]!, near[1]!, near[2]!, dx, dy, dz,
        tri[0]![0]!, tri[0]![1]!, tri[0]![2]!,
        tri[1]![0]!, tri[1]![1]!, tri[1]![2]!,
        tri[2]![0]!, tri[2]![1]!, tri[2]![2]!,
      );
      if (tHit > 1e-4) hit = true;
    }
    expect(hit).toBe(true);
  });
});

describe('rayAabb（拾取预剔除）', () => {
  const min: [number, number, number] = [-1, -1, 4];
  const max: [number, number, number] = [1, 1, 6];

  it('正对命中：返回进入距离 4', () => {
    expect(m4.rayAabb(0, 0, 0, 0, 0, 1, min, max)).toBeCloseTo(4, 6);
  });

  it('盒子在射线背后 → 不命中', () => {
    expect(m4.rayAabb(0, 0, 0, 0, 0, -1, min, max)).toBe(-1);
  });

  it('侧面掠过（y 偏出盒外）→ 不命中', () => {
    expect(m4.rayAabb(0, 5, 0, 0, 0, 1, min, max)).toBe(-1);
  });

  it('斜射命中：斜率小到 z=4 时 x 仍在盒内（x=0.4）', () => {
    const t = m4.rayAabb(0, 0, 0, 0.1, 0, 1, min, max);
    expect(t).toBeCloseTo(4, 6);
  });

  it('斜射但偏出盒外：z=4 时 x 已到 2.0，越界 → 不命中', () => {
    expect(m4.rayAabb(0, 0, 0, 0.5, 0, 1, min, max)).toBe(-1);
  });

  it('射线原点在盒内 → 返回 0（不判为不命中）', () => {
    expect(m4.rayAabb(0, 0, 5, 0, 0, 1, min, max)).toBe(0);
  });

  it('平行于某轴且起点在盒外 → 不命中（退化分支）', () => {
    expect(m4.rayAabb(0, 5, 0, 1, 0, 0, min, max)).toBe(-1);
  });
});
