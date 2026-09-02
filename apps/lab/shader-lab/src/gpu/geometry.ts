/**
 * 程序化测试几何。
 *
 * 顶点布局（stride 60B）：
 *   0 position vec3f  1 normal vec3f  2 smoothNormal vec3f  3 uv vec2f  4 color vec4f
 *
 * color.r = 描边宽度倍率，color.g = 烘焙 AO，与 docs/07 §4.3 的顶点布局约定一致。
 *
 * smoothNormal 是描边专用的平滑法线：硬边几何（立方体）的着色法线在棱角处不连续，
 * 直接拿去外扩会让描边在棱角处裂开，所以按位置合并顶点后重新平均一份。
 *
 * 绕序在 build() 里自动校正为 CCW。inverted hull 描边用 cullMode:'front'，
 * 绕序错了会把整个物体涂黑，手算容易出错，交给代码判定更可靠。
 */

export const VERTEX_STRIDE = 60;
export const VERTEX_FLOATS = 15;

export const VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x3' },
    { shaderLocation: 3, offset: 36, format: 'float32x2' },
    { shaderLocation: 4, offset: 44, format: 'float32x4' },
  ],
};

/**
 * 蒙皮顶点布局（第二个顶点缓冲槽，stride 24B）：
 *   joints  : uint16 ×4（shaderLocation 5，偏移 0）  —— 指向关节矩阵调色板
 *   weights : float32 ×4（shaderLocation 6，偏移 8） —— 4 个影响权重，已归一化
 * 未蒙皮的顶点绑到「恒等关节」(index 0)、权重 [1,0,0,0]，蒙皮结果 = 顶点原样。
 */
export const SKIN_STRIDE = 24;

export const SKIN_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: SKIN_STRIDE,
  attributes: [
    { shaderLocation: 5, offset: 0, format: 'uint16x4' },
    { shaderLocation: 6, offset: 8, format: 'float32x4' },
  ],
};

/**
 * 把蒙皮数据打包成 GPU 顶点缓冲（interleaved u16×4 + f32×4）。
 * joints/weights 为 null（无蒙皮）时退化为「恒等关节 + 权重 1」的静止缓冲。
 */
export function packSkin(
  joints: Uint16Array | null,
  weights: Float32Array | null,
  count: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(count * SKIN_STRIDE);
  // 交错布局：每个顶点 24 字节 = [j0..j3 (u16, 8B)] [w0..w3 (f32, 16B)]。
  // 顶点 i 的关节落在 u16 元素 [12i .. 12i+3]，权重落在 f32 元素 [6i+2 .. 6i+5]，
  // 不能用连续的 set()（续顶点会错位并覆盖上一顶点的权重）。
  const jv = new Uint16Array(buf);
  const wv = new Float32Array(buf);
  if (joints && weights && joints.length >= count * 4 && weights.length >= count * 4) {
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 4; k++) {
        jv[12 * i + k] = joints[i * 4 + k]!;
        wv[6 * i + 2 + k] = weights[i * 4 + k]!;
      }
    }
  } else {
    for (let i = 0; i < count; i++) {
      jv[12 * i] = 0; // 关节 0 = 恒等关节（静态，不受骨骼驱动）
      wv[6 * i + 2] = 1; // 权重全压在恒等关节上
    }
  }
  return buf;
}

export interface MeshData {
  vertices: Float32Array;
  indices: Uint32Array;
  /** 蒙皮关节索引（4/顶点，0..nJoints-1；末尾恒等关节 = nJoints）。无蒙皮为 null */
  joints?: Uint16Array | null;
  /** 蒙皮权重（4/顶点，已归一化）。无蒙皮为 null */
  weights?: Float32Array | null;
}

type Vec3 = readonly [number, number, number];

class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  addVertex(p: Vec3, n: Vec3, uv: readonly [number, number]): number {
    const index = this.positions.length / 3;
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(uv[0], uv[1]);
    return index;
  }

  addTriangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  addQuad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  build(outlineWidth = 1, ao?: (y: number) => number): MeshData {
    const count = this.positions.length / 3;

    const posKey = (i: number): string => {
      const x = Math.round(this.positions[i * 3]! * 10000);
      const y = Math.round(this.positions[i * 3 + 1]! * 10000);
      const z = Math.round(this.positions[i * 3 + 2]! * 10000);
      return `${x},${y},${z}`;
    };

    const accum = new Map<string, [number, number, number]>();
    for (let i = 0; i < count; i++) {
      const k = posKey(i);
      const prev = accum.get(k) ?? [0, 0, 0];
      prev[0] += this.normals[i * 3]!;
      prev[1] += this.normals[i * 3 + 1]!;
      prev[2] += this.normals[i * 3 + 2]!;
      accum.set(k, prev);
    }

    const smoothNormals: number[] = new Array<number>(count * 3);
    for (let i = 0; i < count; i++) {
      const v = accum.get(posKey(i))!;
      const len = Math.hypot(v[0], v[1], v[2]);
      if (len < 1e-8) {
        smoothNormals[i * 3] = 0;
        smoothNormals[i * 3 + 1] = 1;
        smoothNormals[i * 3 + 2] = 0;
      } else {
        smoothNormals[i * 3] = v[0] / len;
        smoothNormals[i * 3 + 1] = v[1] / len;
        smoothNormals[i * 3 + 2] = v[2] / len;
      }
    }

    // 绕序校正：三角形面法线必须与顶点外法线同向，否则翻转
    const indices = [...this.indices];
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t]!;
      const i1 = indices[t + 1]!;
      const i2 = indices[t + 2]!;

      const ax = this.positions[i1 * 3]! - this.positions[i0 * 3]!;
      const ay = this.positions[i1 * 3 + 1]! - this.positions[i0 * 3 + 1]!;
      const az = this.positions[i1 * 3 + 2]! - this.positions[i0 * 3 + 2]!;
      const bx = this.positions[i2 * 3]! - this.positions[i0 * 3]!;
      const by = this.positions[i2 * 3 + 1]! - this.positions[i0 * 3 + 1]!;
      const bz = this.positions[i2 * 3 + 2]! - this.positions[i0 * 3 + 2]!;

      const fx = ay * bz - az * by;
      const fy = az * bx - ax * bz;
      const fz = ax * by - ay * bx;
      if (fx * fx + fy * fy + fz * fz < 1e-20) continue;

      const nx = smoothNormals[i0 * 3]! + smoothNormals[i1 * 3]! + smoothNormals[i2 * 3]!;
      const ny = smoothNormals[i0 * 3 + 1]! + smoothNormals[i1 * 3 + 1]! + smoothNormals[i2 * 3 + 1]!;
      const nz = smoothNormals[i0 * 3 + 2]! + smoothNormals[i1 * 3 + 2]! + smoothNormals[i2 * 3 + 2]!;

      if (fx * nx + fy * ny + fz * nz < 0) {
        const tmp = indices[t + 1]!;
        indices[t + 1] = indices[t + 2]!;
        indices[t + 2] = tmp;
      }
    }

    const vertices = new Float32Array(count * VERTEX_FLOATS);
    for (let i = 0; i < count; i++) {
      const o = i * VERTEX_FLOATS;
      const py = this.positions[i * 3 + 1]!;
      vertices[o] = this.positions[i * 3]!;
      vertices[o + 1] = py;
      vertices[o + 2] = this.positions[i * 3 + 2]!;
      vertices[o + 3] = this.normals[i * 3]!;
      vertices[o + 4] = this.normals[i * 3 + 1]!;
      vertices[o + 5] = this.normals[i * 3 + 2]!;
      vertices[o + 6] = smoothNormals[i * 3]!;
      vertices[o + 7] = smoothNormals[i * 3 + 1]!;
      vertices[o + 8] = smoothNormals[i * 3 + 2]!;
      vertices[o + 9] = this.uvs[i * 2]!;
      vertices[o + 10] = this.uvs[i * 2 + 1]!;
      vertices[o + 11] = outlineWidth;
      vertices[o + 12] = ao !== undefined ? ao(py) : 1;
      vertices[o + 13] = 0;
      vertices[o + 14] = 0;
    }

    return { vertices, indices: new Uint32Array(indices) };
  }
}

export function createSphere(radius: number, segments = 40, rings = 24): MeshData {
  const b = new MeshBuilder();
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const nx = sp * Math.cos(theta);
      const nz = sp * Math.sin(theta);
      b.addVertex(
        [nx * radius, cp * radius, nz * radius],
        [nx, cp, nz],
        [s / segments, r / rings],
      );
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const c = a + segments + 1;
      b.addQuad(a, c, c + 1, a + 1);
    }
  }
  return b.build(1);
}

export function createBox(w: number, h: number, d: number): MeshData {
  const b = new MeshBuilder();
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;

  const faces: { n: Vec3; corners: [Vec3, Vec3, Vec3, Vec3] }[] = [
    { n: [0, 0, 1], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], corners: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { n: [1, 0, 0], corners: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], corners: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], corners: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], corners: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
  ];

  for (const f of faces) {
    const i0 = b.addVertex(f.corners[0], f.n, [0, 0]);
    const i1 = b.addVertex(f.corners[1], f.n, [1, 0]);
    const i2 = b.addVertex(f.corners[2], f.n, [1, 1]);
    const i3 = b.addVertex(f.corners[3], f.n, [0, 1]);
    b.addQuad(i0, i1, i2, i3);
  }
  return b.build(1);
}

export function createCylinder(radius: number, height: number, segments = 36): MeshData {
  const b = new MeshBuilder();
  const hy = height / 2;

  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    const theta = t * Math.PI * 2;
    const nx = Math.cos(theta);
    const nz = Math.sin(theta);
    b.addVertex([nx * radius, -hy, nz * radius], [nx, 0, nz], [t, 0]);
    b.addVertex([nx * radius, hy, nz * radius], [nx, 0, nz], [t, 1]);
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2;
    b.addQuad(a, a + 2, a + 3, a + 1);
  }

  const centerTop = b.addVertex([0, hy, 0], [0, 1, 0], [0.5, 0.5]);
  const centerBottom = b.addVertex([0, -hy, 0], [0, -1, 0], [0.5, 0.5]);

  for (let s = 0; s <= segments; s++) {
    const theta = (s / segments) * Math.PI * 2;
    const cx = Math.cos(theta);
    const cz = Math.sin(theta);
    const uv: [number, number] = [0.5 + cx * 0.5, 0.5 + cz * 0.5];
    b.addVertex([cx * radius, hy, cz * radius], [0, 1, 0], uv);
  }
  for (let s = 0; s <= segments; s++) {
    const theta = (s / segments) * Math.PI * 2;
    const cx = Math.cos(theta);
    const cz = Math.sin(theta);
    const uv: [number, number] = [0.5 + cx * 0.5, 0.5 + cz * 0.5];
    b.addVertex([cx * radius, -hy, cz * radius], [0, -1, 0], uv);
  }

  const topStart = centerBottom + 1;
  const bottomStart = topStart + segments + 1;
  for (let s = 0; s < segments; s++) {
    b.addTriangle(centerTop, topStart + s, topStart + s + 1);
    b.addTriangle(centerBottom, bottomStart + s + 1, bottomStart + s);
  }

  return b.build(1);
}

/** 胶囊：总高 = cylinderHeight + 2 * radius，中心在原点 */
export function createCapsule(radius: number, cylinderHeight: number, segments = 32, rings = 12): MeshData {
  const b = new MeshBuilder();
  const hy = cylinderHeight / 2;

  // 上半球：phi 0 = 极点，PI/2 = 赤道
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI / 2);
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const y = hy + cp * radius;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const nx = Math.cos(theta) * sp;
      const nz = Math.sin(theta) * sp;
      b.addVertex([nx * radius, y, nz * radius], [nx, cp, nz], [s / segments, r / rings]);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      b.addQuad(a, a + segments + 1, a + segments + 2, a + 1);
    }
  }

  // 下半球
  const bottomStart = (rings + 1) * (segments + 1);
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI / 2);
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const y = -hy - cp * radius;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const nx = Math.cos(theta) * sp;
      const nz = Math.sin(theta) * sp;
      b.addVertex([nx * radius, y, nz * radius], [nx, -cp, nz], [s / segments, r / rings]);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = bottomStart + r * (segments + 1) + s;
      b.addQuad(a, a + segments + 1, a + segments + 2, a + 1);
    }
  }

  // 中段圆柱
  const sideStart = bottomStart + (rings + 1) * (segments + 1);
  for (let s = 0; s <= segments; s++) {
    const theta = (s / segments) * Math.PI * 2;
    const nx = Math.cos(theta);
    const nz = Math.sin(theta);
    b.addVertex([nx * radius, hy, nz * radius], [nx, 0, nz], [s / segments, 1]);
    b.addVertex([nx * radius, -hy, nz * radius], [nx, 0, nz], [s / segments, 0]);
  }
  for (let s = 0; s < segments; s++) {
    const a = sideStart + s * 2;
    b.addQuad(a, a + 2, a + 3, a + 1);
  }

  return b.build(1);
}

export function createPlane(size: number, subdivisions = 8): MeshData {
  const b = new MeshBuilder();
  const half = size / 2;
  for (let z = 0; z <= subdivisions; z++) {
    for (let x = 0; x <= subdivisions; x++) {
      const u = x / subdivisions;
      const v = z / subdivisions;
      b.addVertex([-half + u * size, 0, -half + v * size], [0, 1, 0], [u * 4, v * 4]);
    }
  }
  for (let z = 0; z < subdivisions; z++) {
    for (let x = 0; x < subdivisions; x++) {
      const a = z * (subdivisions + 1) + x;
      const c = a + subdivisions + 1;
      b.addQuad(a, c, c + 1, a + 1);
    }
  }
  return b.build(1);
}

/**
 * 焊接（Merge Points）：按量化位置把重合顶点合并成一个，重映射索引。
 * 这是修「碎网格」的核心操作——decimation 把共面边界吃掉后，本该共享的顶点会重复，
 * 焊接把它们并回一个，边界边和连通块数量随之归位。
 *
 * @param mesh     源网格（15 floats/顶点）
 * @param tolerance 量化步长（米），默认 1e-4 ≈ 0.1mm，足够吃掉浮点误差又不会误并不同点
 */
export function weldMesh(mesh: MeshData, tolerance = 1e-4): MeshData {
  const src = mesh.vertices;
  const idx = mesh.indices;
  const count = src.length / VERTEX_FLOATS;

  const mapKey = new Map<string, number>();
  const remap = new Int32Array(count);
  const rep = new Int32Array(count).fill(-1);
  let newCount = 0;

  // 行业级做法：键里必须带上 UV，否则同位置不同 UV 岛的接缝点会被合并 → 贴图破碎。
  // 早期版本只按 (x,y,z) 量化建键，是「合并点破坏 UV」的教科书反模式（用户已发现此缺陷并要求修正）。
  // UV 量化精度：1e-6 ≈ 一张 1024² 贴图 0.001 像素，远低于浮点精度，足够。
  const qPos = (v: number): number => Math.round(v / tolerance);
  const qUv = (v: number): number => Math.round(v / 1e-6);
  for (let i = 0; i < count; i++) {
    const o = i * VERTEX_FLOATS;
    const k = `${qPos(src[o]!)}_${qPos(src[o + 1]!)}_${qPos(src[o + 2]!)}_${qUv(src[o + 9]!)}_${qUv(src[o + 10]!)}`;
    let u = mapKey.get(k);
    if (u === undefined) {
      u = newCount++;
      mapKey.set(k, u);
      rep[u] = i;
    }
    remap[i] = u;
  }

  const outVerts = new Float32Array(newCount * VERTEX_FLOATS);
  for (let u = 0; u < newCount; u++) {
    const srcO = rep[u]! * VERTEX_FLOATS;
    outVerts.set(src.subarray(srcO, srcO + VERTEX_FLOATS), u * VERTEX_FLOATS);
  }

  const outIdx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) outIdx[i] = remap[idx[i]!]!;

  return { vertices: outVerts, indices: outIdx };
}

/** 网格拓扑体检：顶点数、面数、边界边（只被一个三角形共享的边）、连通块数。 */
export function meshStats(mesh: MeshData): {
  vertices: number;
  triangles: number;
  boundaryEdges: number;
  components: number;
} {
  const verts = mesh.vertices.length / VERTEX_FLOATS;
  const tris = mesh.indices.length / 3;

  // 边计数：无序顶点对 → 出现次数
  const edgeCount = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]!;
    const b = mesh.indices[t + 1]!;
    const c = mesh.indices[t + 2]!;
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  let boundaryEdges = 0;
  for (const n of edgeCount.values()) if (n === 1) boundaryEdges++;

  // 连通块：并查集，沿边合并顶点
  const parent = new Int32Array(verts);
  for (let i = 0; i < verts; i++) parent[i] = i;
  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]!]!;
      cur = parent[cur]!;
    }
    return cur;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let t = 0; t < mesh.indices.length; t += 3) {
    union(mesh.indices[t]!, mesh.indices[t + 1]!);
    union(mesh.indices[t + 1]!, mesh.indices[t + 2]!);
  }
  const roots = new Set<number>();
  for (let i = 0; i < verts; i++) roots.add(find(i));

  return { vertices: verts, triangles: tris, boundaryEdges, components: roots.size };
}
