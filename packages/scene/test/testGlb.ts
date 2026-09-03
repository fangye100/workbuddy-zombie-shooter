/**
 * 测试用 GLB 构造器（多 primitive）。
 *
 * 为什么需要：项目里唯一的真实资产（E-04）只有 1 个 mesh / 1 个 primitive，
 * 「层级树展开多个子 mesh 节点」这条主功能没有真实数据可验。这里按 glTF 2.0
 * 二进制规范手搓一份 N-primitive 的 GLB，让单测与无头 CDP 都能覆盖多槽位场景。
 *
 * 只依赖 ArrayBuffer / TypedArray，Node 与浏览器都能跑。
 */

export interface TestPrim {
  /** 材质名；parseGlb 会拿它当子网格名（mesh.name 未设时） */
  name: string;
  /** 三角形数量 */
  triangles: number;
}

/** 生成一段竖立的三角带：顶点绕 Y 轴一圈排开，保证有真实高度可归一化 */
function ringVertices(triangles: number, yBase: number, radius: number): Float32Array {
  const count = triangles * 3;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    out[i * 3] = Math.cos(a) * radius;
    out[i * 3 + 1] = yBase + i * (1.0 / Math.max(1, count));
    out[i * 3 + 2] = Math.sin(a) * radius;
  }
  return out;
}

interface GltfLike {
  asset: { version: string };
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: { mesh: number }[];
  meshes: { name?: string; primitives: { attributes: { POSITION: number }; material: number }[] }[];
  materials: { name: string }[];
  accessors: { bufferView: number; componentType: number; count: number; type: string }[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
  buffers: { byteLength: number }[];
}

/**
 * 构造 GLB。每个 primitive 用**独立**的 bufferView / accessor，
 * 尽量贴近 Blender 导出的真实结构（不是所有 primitive 共用一段）。
 *
 * @param prims    每条 primitive 的材质名与面数
 * @param meshName 可选：给 mesh 设 name。Blender 导出的模型几乎都带这个名字，
 *                 而同一 mesh 下所有 primitive 共用它 —— 命名优先级回归测试需要这个开关。
 */
export function makeGlb(prims: TestPrim[], meshName?: string): ArrayBuffer {
  const bins: Uint8Array[] = [];
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const accessors: { bufferView: number; componentType: number; count: number; type: string }[] = [];
  const materials: { name: string }[] = [];
  const primitives: { attributes: { POSITION: number }; material: number }[] = [];

  let offset = 0;
  for (const prim of prims) {
    const verts = ringVertices(Math.max(1, prim.triangles), 0, 0.4);
    const bytes = new Uint8Array(verts.buffer.slice(0));
    bins.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126, // FLOAT
      count: verts.length / 3,
      type: 'VEC3',
    });
    materials.push({ name: prim.name });
    primitives.push({
      attributes: { POSITION: accessors.length - 1 },
      material: materials.length - 1,
    });
    offset += bytes.byteLength;
  }

  const json: GltfLike = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    // exactOptionalPropertyTypes 下不能用 name: undefined，必须有值时才展开
    meshes: [{ ...(meshName === undefined ? {} : { name: meshName }), primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const binPad = (4 - (offset % 4)) % 4;
  const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + offset + binPad;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true); // version
  dv.setUint32(8, total, true); // 文件总长

  let p = 12;
  dv.setUint32(p, jsonBytes.byteLength + jsonPad, true);
  dv.setUint32(p + 4, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, p + 8);
  // 规范：JSON chunk 必须用空格 0x20 补齐，BIN chunk 才用 0x00。
  // 用 0x00 补 JSON 会让 JSON.parse 撞上 NUL（它不是合法空白）直接抛错。
  for (let i = 0; i < jsonPad; i++) out[p + 8 + jsonBytes.byteLength + i] = 0x20;
  p += 8 + jsonBytes.byteLength + jsonPad;

  dv.setUint32(p, offset + binPad, true);
  dv.setUint32(p + 4, 0x004e4942, true); // 'BIN\0'
  for (const b of bins) {
    out.set(b, p + 8);
    p += b.byteLength;
  }

  return out.buffer;
}
