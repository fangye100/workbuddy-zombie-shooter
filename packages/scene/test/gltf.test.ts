import { describe, expect, it } from 'vitest';
import {
  collectMeshInstances,
  decomposeMatrixToTrs,
  nodeMatrix,
  normalMatrix,
  normalizeMeshHeight,
  parseGlb,
  type MeshData,
} from '@aether/scene';

/**
 * 导入器与身高归一化的回归测试。
 * 背景（审计发现）：
 *   1) 导入器曾直接忽略 glTF node 变换 —— 带旋转/分件的模型会散架（"稀碎"）；
 *   2) 三档 LOD 各自带着导出时的身高（2.050/2.108/2.187），切换 LOD 角色会变高。
 *
 * 2026-09-03 归位：原 `apps/editor/src/gpu/gltf.test.ts`，随 glTF/几何真源迁回 packages/scene。
 * 目标身高属内容域常量（roster.json 派生），引擎侧只认「调用方传入值」契约，故这里钉字面量。
 */
const TARGET_HEIGHT_M = 2.05;

/** 造一个 stride 15 的最小网格（两个顶点，高度 h） */
function makeMesh(h: number, footY = 0): MeshData {
  const v = new Float32Array(2 * 15);
  v[1] = footY;
  v[16] = footY + h;
  return { vertices: v, indices: new Uint32Array([0, 1, 0]) };
}

function meshHeight(m: MeshData): number {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < m.vertices.length; i += 15) {
    minY = Math.min(minY, m.vertices[i + 1]!);
    maxY = Math.max(maxY, m.vertices[i + 1]!);
  }
  return maxY - minY;
}

/**
 * 把 GLB 的 JSON chunk 里所有 material.name 抹掉，用来逼出「只有 mesh 名可用」的
 * 命名兜底分支。只改 JSON chunk，BIN chunk 原样搬过去。
 */
function stripMaterialNames(glb: ArrayBuffer): ArrayBuffer {
  const dv = new DataView(glb);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen)),
  ) as { materials?: Record<string, unknown>[] };
  for (const m of json.materials ?? []) delete m['name'];

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const binStart = 20 + jsonLen; // 12 文件头 + 8 chunk 头 + 已补齐的 JSON
  const binLen = glb.byteLength - binStart;

  const out = new Uint8Array(12 + 8 + jsonBytes.byteLength + jsonPad + binLen);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x46546c67, true); // 'glTF'
  ov.setUint32(4, 2, true);
  ov.setUint32(8, out.byteLength, true);
  ov.setUint32(12, jsonBytes.byteLength + jsonPad, true);
  ov.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  // JSON chunk 必须用空格 0x20 补齐（0x00 会让 JSON.parse 撞上 NUL）
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.byteLength + i] = 0x20;
  out.set(new Uint8Array(glb, binStart), 20 + jsonBytes.byteLength + jsonPad);
  return out.buffer;
}

describe('glTF 场景图', () => {
  it('单节点带 90° X 旋转：等价于 (x,-z,y)（Blender 把 Z-up→Y-up 烘在 node 上）', () => {
    const m = nodeMatrix({ rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
    // 变换 (0,0,1) → 应为 (0,-1,0)
    const x = m[0]! * 0 + m[4]! * 0 + m[8]! * 1;
    const y = m[1]! * 0 + m[5]! * 0 + m[9]! * 1;
    const z = m[2]! * 0 + m[6]! * 0 + m[10]! * 1;
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(-1, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('父子节点变换累乘：父平移 × 子缩放', () => {
    const inst = collectMeshInstances({
      scenes: [{ nodes: [0] }],
      nodes: [
        { children: [1] },
        { mesh: 0, scale: [2, 2, 2] },
      ],
    });
    expect(inst).toHaveLength(1);
    expect(inst[0]!.m[0]).toBeCloseTo(2, 6); // 缩放生效
    expect(inst[0]!.m[10]).toBeCloseTo(2, 6);
  });

  it('同一 mesh 被两个 node 引用 → 两个实例（分件模型不会被吞）', () => {
    const inst = collectMeshInstances({
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0 }, { mesh: 0, translation: [1, 0, 0] }],
    });
    expect(inst).toHaveLength(2);
    expect(inst[1]!.m[12]).toBeCloseTo(1, 6);
  });

  it('不在场景图里的 mesh 兜底按 identity 收进来，不丢件', () => {
    const inst = collectMeshInstances({ scenes: [{ nodes: [] }], nodes: [], meshes: [{}] });
    expect(inst).toHaveLength(1);
    expect(inst[0]!.m[0]).toBeCloseTo(1, 6);
  });

  it('法线矩阵：等比缩放不改变法线方向；非等比缩放用逆转置修正', () => {
    const uniform = normalMatrix(
      new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]),
    );
    // n=(0,1,0) 经等比缩放的逆转置 → 方向不变（归一化后）
    const ny = uniform[3]! * 0 + uniform[4]! * 1 + uniform[5]! * 0;
    expect(Math.abs(ny)).toBeGreaterThan(0);

    // 沿 X 拉长 3 倍：法线 (1,0,0) 应变短（逆转置 = 1/3），方向不变
    const nonUni = normalMatrix(
      new Float32Array([3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    );
    const nx = nonUni[0]! * 1 + nonUni[1]! * 0 + nonUni[2]! * 0;
    const nz = nonUni[6]! * 1 + nonUni[7]! * 0 + nonUni[8]! * 0;
    expect(nx).toBeCloseTo(1 / 3, 6);
    expect(nz).toBeCloseTo(0, 6);
  });
});

describe('身高归一化（LOD 共用一把尺子）', () => {
  it('按目标高度缩放，脚底归零', () => {
    const m = normalizeMeshHeight(makeMesh(2.4, 0.3), TARGET_HEIGHT_M);
    expect(meshHeight(m)).toBeCloseTo(TARGET_HEIGHT_M, 5);
    expect(m.vertices[1]).toBeCloseTo(0, 6);
  });

  it('已达标时原样返回（幂等），不重复缩放', () => {
    const once = normalizeMeshHeight(makeMesh(2.4, 0.3), TARGET_HEIGHT_M);
    const twice = normalizeMeshHeight(once, TARGET_HEIGHT_M);
    expect(meshHeight(twice)).toBeCloseTo(TARGET_HEIGHT_M, 5);
  });

  it('不改入参（纯函数）', () => {
    const src = makeMesh(2.4, 0.3);
    normalizeMeshHeight(src, TARGET_HEIGHT_M);
    expect(meshHeight(src)).toBeCloseTo(2.4, 5);
  });

  it('等比缩放：X/Z 与 Y 同比例，体型不失真', () => {
    const src = makeMesh(2.4, 0);
    src.vertices[0] = 1.2; // X 半径
    const out = normalizeMeshHeight(src, TARGET_HEIGHT_M);
    expect(out.vertices[0]! / 1.2).toBeCloseTo(TARGET_HEIGHT_M / 2.4, 5);
  });

  it('退化输入安全：零高度网格不会被缩放成 NaN', () => {
    const flat = makeMesh(0, 0.5);
    const out = normalizeMeshHeight(flat, TARGET_HEIGHT_M);
    expect(Number.isFinite(out.vertices[1]!)).toBe(true);
  });
});

describe('parseGlb · 多 primitive → 子网格区间', () => {
  /**
   * 层级树能「展开子 mesh 节点」全靠这份 subMeshes：每个 primitive 在合并索引缓冲里
   * 的区间。项目里唯一的真实资产只有 1 个 primitive，这里用手搓的 GLB 把多槽位钉死。
   */
  it('3 个 primitive → 3 条子网格，区间首尾相接且总数守恒', async () => {
    const { parseGlb } = await import('@aether/scene');
    const { makeGlb } = await import('./testGlb');
    const glb = makeGlb([
      { name: '身体', triangles: 4 },
      { name: '头部', triangles: 3 },
      { name: '盾牌', triangles: 2 },
    ]);
    const r = parseGlb(glb, 2.05);

    expect(r.subMeshes).toHaveLength(3);
    expect(r.subMeshes.map((s) => s.name)).toEqual(['身体', '头部', '盾牌']);
    expect(r.subMeshes.map((s) => s.indexCount)).toEqual([12, 9, 6]);

    let cursor = 0;
    for (const s of r.subMeshes) {
      expect(s.indexStart).toBe(cursor);
      cursor += s.indexCount;
    }
    expect(cursor).toBe(r.mesh.indices.length); // 区间覆盖全部索引，不重不漏
    expect(r.triangles).toBe(9);
  });

  it('单 primitive 退化成一条覆盖全部的子网格', async () => {
    const { parseGlb } = await import('@aether/scene');
    const { makeGlb } = await import('./testGlb');
    const r = parseGlb(makeGlb([{ name: '整体', triangles: 5 }]), 2.05);

    expect(r.subMeshes).toHaveLength(1);
    expect(r.subMeshes[0]!.indexStart).toBe(0);
    expect(r.subMeshes[0]!.indexCount).toBe(r.mesh.indices.length);
  });

  /**
   * 命名优先级回归。glTF 的 primitive 就是按材质拆的（身体/武器/盾牌各一条），
   * 而同一 mesh 下的所有 primitive **共用 mesh.name**。Blender 导出的模型几乎都带
   * mesh.name，若按「mesh.name 优先」取名，层级树里三条子网格会全叫同一个名字 ——
   * 用户根本分不清哪个是盾牌。所以材质名必须排在 mesh 名之前。
   */
  it('多 primitive 且 mesh 带 name → 用材质名，不能全叫成 mesh 名', async () => {
    const { parseGlb } = await import('@aether/scene');
    const { makeGlb } = await import('./testGlb');
    const r = parseGlb(
      makeGlb(
        [
          { name: '身体', triangles: 4 },
          { name: '武器', triangles: 3 },
          { name: '盾牌', triangles: 2 },
        ],
        'BlenderMeshName',
      ),
      2.05,
    );
    expect(r.subMeshes.map((s) => s.name)).toEqual(['身体', '武器', '盾牌']);
  });

  it('没有材质名时退到 mesh 名，而不是 primitive_0', async () => {
    const { parseGlb } = await import('@aether/scene');
    const { makeGlb } = await import('./testGlb');
    const glb = makeGlb([{ name: 'X', triangles: 4 }], 'Cube.001');
    // 抹掉 materials，逼出「只有 mesh 名可用」的分支
    const stripped = stripMaterialNames(glb);
    const r = parseGlb(stripped, 2.05);
    expect(r.subMeshes[0]!.name).toBe('Cube.001');
  });

  it('同名 primitive（同材质被复用）自动加序号，层级树里不会出现两个一模一样的节点', async () => {
    const { parseGlb } = await import('@aether/scene');
    const { makeGlb } = await import('./testGlb');
    const r = parseGlb(
      makeGlb([
        { name: '护甲', triangles: 2 },
        { name: '护甲', triangles: 2 },
        { name: '护甲', triangles: 2 },
      ]),
      2.05,
    );
    const names = r.subMeshes.map((s) => s.name);
    expect(names).toEqual(['护甲', '护甲 2', '护甲 3']);
    expect(new Set(names).size).toBe(3);
  });

  it('身高归一化不受 primitive 数量影响（多件模型不会变高）', async () => {
    const { parseGlb } = await import('@aether/scene');
    const { makeGlb } = await import('./testGlb');
    const one = parseGlb(makeGlb([{ name: '整体', triangles: 6 }]), 2.05);
    const many = parseGlb(
      makeGlb([
        { name: 'a', triangles: 2 },
        { name: 'b', triangles: 2 },
        { name: 'c', triangles: 2 },
      ]),
      2.05,
    );
    expect(many.heightMeters).toBeCloseTo(one.heightMeters, 6);
    expect(many.heightMeters).toBeCloseTo(2.05, 6);
  });
});

describe('decomposeMatrixToTrs（matrix 节点 → TRS，PR #13 评审修复）', () => {
  it('纯平移矩阵：t 取平移列，r/s 为单位', () => {
    const d = decomposeMatrixToTrs([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1]);
    expect(d.t).toEqual([3, 4, 5]);
    expect(d.r).toEqual([0, 0, 0, 1]);
    expect(d.s).toEqual([1, 1, 1]);
  });

  it('TRS 合成往返：nodeMatrix 输出分解回原文（t/s 精确，四元数 |dot|≈1）', () => {
    const q90z = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number];
    const m = nodeMatrix({ translation: [1, 2, 3], rotation: q90z, scale: [2, 3, 4] });
    const d = decomposeMatrixToTrs(m);
    expect(d.t[0]).toBeCloseTo(1, 5);
    expect(d.t[1]).toBeCloseTo(2, 5);
    expect(d.t[2]).toBeCloseTo(3, 5);
    expect(d.s[0]).toBeCloseTo(2, 5);
    expect(d.s[1]).toBeCloseTo(3, 5);
    expect(d.s[2]).toBeCloseTo(4, 5);
    const dot =
      d.r[0] * q90z[0] + d.r[1] * q90z[1] + d.r[2] * q90z[2] + d.r[3] * q90z[3];
    expect(Math.abs(dot)).toBeCloseTo(1, 5);
  });

  it('镜像矩阵（行列式<0）：负号挂 sx，旋转为单位阵', () => {
    const d = decomposeMatrixToTrs([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1]);
    expect(d.t).toEqual([0, 1, 0]);
    expect(d.s[0]).toBeCloseTo(-1, 6);
    expect(d.s[1]).toBeCloseTo(1, 6);
    expect(d.s[2]).toBeCloseTo(1, 6);
    for (const [i, want] of [0, 0, 0, 1].entries()) expect(d.r[i]).toBeCloseTo(want, 6);
  });

  it('零缩放轴（退化文件）：旋转给单位四元数，t/s 仍保真', () => {
    const d = decomposeMatrixToTrs([0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 7, 8, 9, 1]);
    expect(d.t).toEqual([7, 8, 9]);
    expect(d.s[0]).toBe(0);
    expect(d.s[1]).toBeCloseTo(2, 6);
    expect(d.s[2]).toBeCloseTo(3, 6);
    expect(d.r).toEqual([0, 0, 0, 1]);
  });
});

describe('parseGlb：matrix 属性关节的 locals 必须分解（顶点与蒙皮同值）', () => {
  /** 最小合法 skinned GLB：node0=matrix 关节（scale2+t[0,1,0]），node1=网格（skin:0） */
  function buildMatrixJointGlb(): ArrayBuffer {
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [
        { name: 'Hips', matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 1, 0, 1] },
        { name: 'Body', mesh: 0, skin: 0 },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      skins: [{ joints: [0] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'VEC3', min: [0, 0, 0], max: [0, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 24 },
        { buffer: 0, byteOffset: 24, byteLength: 6 },
      ],
      buffers: [{ byteLength: 32 }],
    };
    const bin = new Uint8Array(32);
    const dv = new DataView(bin.buffer);
    dv.setFloat32(16, 1, true); // 第二个顶点 y=1（身高 1m）
    dv.setUint16(26, 1, true); // 索引 [0,1,0]
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
    const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + bin.byteLength;
    const out = new Uint8Array(total);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, 0x46546c67, true);
    odv.setUint32(4, 2, true);
    odv.setUint32(8, total, true);
    odv.setUint32(12, jsonBytes.byteLength + jsonPad, true);
    odv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20);
    for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.byteLength + i] = 0x20;
    const binStart = 20 + jsonBytes.byteLength + jsonPad;
    odv.setUint32(binStart, bin.byteLength, true);
    odv.setUint32(binStart + 4, 0x004e4942, true);
    out.set(bin, binStart + 8);
    return out.buffer;
  }

  it('matrix 关节分解进 SkeletonData.locals（不再是单位 TRS）', () => {
    const r = parseGlb(buildMatrixJointGlb(), TARGET_HEIGHT_M);
    expect(r.skeleton).not.toBeNull();
    const L = r.skeleton!.locals[0]!;
    expect(L.t[0]).toBeCloseTo(0, 5);
    expect(L.t[1]).toBeCloseTo(1, 5);
    expect(L.t[2]).toBeCloseTo(0, 5);
    expect(L.s[0]).toBeCloseTo(2, 5);
    expect(L.s[1]).toBeCloseTo(2, 5);
    expect(L.s[2]).toBeCloseTo(2, 5);
    expect(L.r).toEqual([0, 0, 0, 1]);
    expect(r.skeleton!.jointNames[0]).toBe('Hips');
  });
});
