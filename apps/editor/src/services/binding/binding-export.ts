/**
 * 绑定导出：把「用户摆好的**当前姿态**骨架 + **当前姿态**网格」变成
 * 「**干净 T-pose** 的 rigged GLB」。
 *
 * 这是用户强调的那条铁律的落点：
 *
 *   初始 T-pose 的数值只能采纳 joint 的**长度**；
 *   joint 之间的**旋转差值**全都是 currentPose 与 T-pose 之间的 pose 差值。
 *
 * 所以流程必须是这三步，顺序不能换：
 *
 *   1. 用**当前姿态**的骨架 + **当前姿态**的网格算 LBS 权重 w。
 *      此刻骨架与模型真实肢体重合，权重才会分配到正确的骨上。
 *      （若先摆成 T-pose 再算，权重会按 T 字形算，A-pose 的手臂就全错了。）
 *   2. 用 ΔR 把网格**反解回 T-pose**：v_T = Σ w_k · M_T_k · M_P_k⁻¹ · v_P。
 *      ΔR 在此被**消耗掉**，不再存在于产物里。
 *   3. 写骨架：每根骨只有 translation = 标准朝向 × 采纳骨长，**rotation 恒为
 *      单位四元数（JSON 里直接省略该字段）**；inverseBind = M_T⁻¹ = T(−p)。
 *
 * 产物 bind pose 是干净的 T-pose，BVH / Mixamo / 动捕动画可以直接接进来，
 * 不会带任何 A-pose 的 offset。
 */

import { HUMANIK_BONES, HUMANIK_ORDER, tposeDirections } from './humanik-template';
import {
  boneSegments,
  computeLbsWeights,
  fitSkeleton,
  unposeMesh,
  unposeNormals,
  type FitResult,
  type JointPositions,
  type SkinWeights,
} from './binding-math';

/** 引擎顶点布局：pos3 / normal3 / smoothNormal3 / uv2 / color4 */
export const BINDING_VERTEX_FLOATS = 15;
const NORMAL_OFFSET = 3;
const UV_OFFSET = 9;

export interface BindExportInput {
  /** 导出文件名（不含扩展名） */
  name: string;
  /** 当前姿态的网格顶点（引擎 15-float 布局） */
  vertices: Float32Array;
  indices: Uint32Array;
  /** 原始 baseColor 贴图；有则一并嵌入，保证 T-pose 产物仍带贴图 */
  image: Blob | null;
  /** 用户摆放的关节坐标（当前姿态、模型 local 空间、Y-up） */
  placed: JointPositions;
  falloff?: number;
  eps?: number;
  maxInfluences?: number;
}

export interface BindExportStats {
  vertices: number;
  triangles: number;
  bones: number;
  /** 采纳的骨长（米） */
  lengths: Record<string, number>;
  /** 最大的单骨姿态偏移角（度）——「这个模型离标准 T-pose 有多远」的量化 */
  maxPoseAngleDeg: number;
  /** 姿态偏移超过 15° 的骨，提示用户这个模型不是标准 T-pose */
  offAxisBones: string[];
  /** 反解前后的身高（米）。反解是刚体变换，两者应几乎相等，差太多说明权重/骨位有问题 */
  heightBefore: number;
  heightAfter: number;
  /** 零权重顶点数，应为 0（兜底逻辑保证） */
  zeroWeightVerts: number;
  bytes: number;
}

export interface BindExportResult {
  glb: ArrayBuffer;
  fit: FitResult;
  skin: SkinWeights;
  /** T-pose 网格顶点（可回灌编辑器显示，让用户立刻看到「摆正了」） */
  tposeVertices: Float32Array;
  stats: BindExportStats;
}

// ─────────────────────────── 对外入口 ───────────────────────────

/** 同步导出（不带贴图）。贴图版本用 rigToTPoseWithImage。 */
export function rigToTPose(input: BindExportInput): BindExportResult {
  return runExport(input, null, '');
}

/** 异步导出：先把 Blob 贴图解成字节再嵌进 GLB（Blob 只能在主线程异步读） */
export async function rigToTPoseWithImage(input: BindExportInput): Promise<BindExportResult> {
  if (input.image === null) return runExport(input, null, '');
  try {
    const bytes = new Uint8Array(await input.image.arrayBuffer());
    if (bytes.byteLength === 0) return runExport(input, null, '');
    return runExport(input, bytes, input.image.type || 'image/png');
  } catch (err) {
    console.warn('[绑定] 贴图解码失败，导出将不带贴图', err);
    return runExport(input, null, '');
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

function runExport(
  input: BindExportInput,
  imageBytes: Uint8Array | null,
  mime: string,
): BindExportResult {
  const {
    name, vertices, indices, placed,
    falloff = 3.0, eps = 0.02, maxInfluences = 4,
  } = input;
  const VF = BINDING_VERTEX_FLOATS;
  const vertexCount = vertices.length / VF;
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) {
    throw new Error(`顶点数组长度 ${vertices.length} 不是 stride ${VF} 的正整数倍`);
  }

  // ① 拟合：拆出「采纳的骨长」与「不入骨架的 ΔR」
  const fit = fitSkeleton(placed);

  // ② 在**当前姿态**骨架上算权重（此时骨架与模型真实肢体重合）
  const segs = boneSegments(placed);
  const skin = computeLbsWeights(
    vertices, VF, vertexCount, segs, falloff, eps, maxInfluences,
  );

  // ③ 反解：顶点 → T-pose，法线同步旋转
  let tposeVertices = unposeMesh(vertices, VF, vertexCount, skin, fit);
  tposeVertices = unposeNormals(tposeVertices, VF, vertexCount, skin, fit, NORMAL_OFFSET);

  const glb = buildGlb(
    name, tposeVertices, indices, VF, vertexCount, skin, fit, imageBytes, mime,
  );
  const stats = buildStats(vertices, tposeVertices, VF, vertexCount, indices, fit, skin);

  return { glb, fit, skin, tposeVertices, stats: { ...stats, bytes: glb.byteLength } };
}

function buildStats(
  before: Float32Array,
  after: Float32Array,
  VF: number,
  vertexCount: number,
  indices: Uint32Array,
  fit: FitResult,
  skin: SkinWeights,
): Omit<BindExportStats, 'bytes'> {
  const spanY = (v: Float32Array): number => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const y = v[i * VF + 1]!;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    return hi - lo;
  };

  let maxDeg = 0;
  const offAxis: string[] = [];
  for (const n of HUMANIK_ORDER) {
    const q = fit.poseRotations[n]!;
    const deg = (2 * Math.acos(Math.min(1, Math.abs(q[3])))) * 180 / Math.PI;
    if (deg > maxDeg) maxDeg = deg;
    if (deg > 15) offAxis.push(n);
  }

  let zero = 0;
  for (let i = 0; i < vertexCount; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += skin.weights[i * 4 + k]!;
    if (s <= 1e-6) zero++;
  }

  return {
    vertices: vertexCount,
    triangles: indices.length / 3,
    bones: HUMANIK_ORDER.length,
    lengths: { ...fit.lengths },
    maxPoseAngleDeg: maxDeg,
    offAxisBones: offAxis,
    heightBefore: spanY(before),
    heightAfter: spanY(after),
    zeroWeightVerts: zero,
  };
}

// ─────────────────────────── GLB 写出 ───────────────────────────

const COMPONENT_FLOAT = 5126;
const COMPONENT_USHORT = 5123;
const COMPONENT_UINT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

interface BufView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
}

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4';
  min?: number[];
  max?: number[];
}

/** 累加字节块，自动补 4 字节对齐（glTF 对 bufferView 的硬性要求） */
class GlbParts {
  private readonly parts: Uint8Array[] = [];
  private cursor = 0;
  readonly views: BufView[] = [];

  add(u8: Uint8Array, target?: number): number {
    const aligned = (this.cursor + 3) & ~3;
    const pad = aligned - this.cursor;
    if (pad > 0) {
      this.parts.push(new Uint8Array(pad));
      this.cursor += pad;
    }
    const view: BufView = { buffer: 0, byteOffset: this.cursor, byteLength: u8.byteLength };
    if (target !== undefined) view.target = target;
    this.views.push(view);
    this.parts.push(u8);
    this.cursor += u8.byteLength;
    return this.views.length - 1;
  }

  concat(): Uint8Array {
    const aligned = (this.cursor + 3) & ~3;
    if (aligned > this.cursor) {
      this.parts.push(new Uint8Array(aligned - this.cursor));
      this.cursor = aligned;
    }
    const out = new Uint8Array(this.cursor);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }
}

function f32(src: Float32Array | number[]): Uint8Array {
  const a = src instanceof Float32Array ? src : new Float32Array(src);
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

function u16(src: Uint16Array): Uint8Array {
  return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}

function buildGlb(
  name: string,
  verts: Float32Array,
  indices: Uint32Array,
  VF: number,
  vertexCount: number,
  skin: SkinWeights,
  fit: FitResult,
  imageBytes: Uint8Array | null,
  mime: string,
): ArrayBuffer {
  const parts = new GlbParts();
  const accessors: Accessor[] = [];

  // ── 属性抽出（POSITION 要顺带算 min/max，glTF 对它强制要求） ──
  const pos = new Float32Array(vertexCount * 3);
  const nrm = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    const o = i * VF;
    const x = verts[o]!;
    const y = verts[o + 1]!;
    const z = verts[o + 2]!;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    nrm[i * 3] = verts[o + NORMAL_OFFSET]!;
    nrm[i * 3 + 1] = verts[o + NORMAL_OFFSET + 1]!;
    nrm[i * 3 + 2] = verts[o + NORMAL_OFFSET + 2]!;
    uv[i * 2] = verts[o + UV_OFFSET]!;
    uv[i * 2 + 1] = verts[o + UV_OFFSET + 1]!;
    if (x < lo[0]) lo[0] = x;
    if (x > hi[0]) hi[0] = x;
    if (y < lo[1]) lo[1] = y;
    if (y > hi[1]) hi[1] = y;
    if (z < lo[2]) lo[2] = z;
    if (z > hi[2]) hi[2] = z;
  }

  const idxU32 = vertexCount > 65535;
  const idxData = idxU32
    ? new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength)
    : u16(new Uint16Array(indices));
  const idxAcc = accessors.push({
    bufferView: parts.add(idxData, TARGET_ELEMENT_ARRAY_BUFFER),
    componentType: idxU32 ? COMPONENT_UINT : COMPONENT_USHORT,
    count: indices.length,
    type: 'SCALAR',
  }) - 1;

  const posAcc = accessors.push({
    bufferView: parts.add(f32(pos), TARGET_ARRAY_BUFFER),
    componentType: COMPONENT_FLOAT,
    count: vertexCount,
    type: 'VEC3',
    min: [...lo],
    max: [...hi],
  }) - 1;

  const nrmAcc = accessors.push({
    bufferView: parts.add(f32(nrm), TARGET_ARRAY_BUFFER),
    componentType: COMPONENT_FLOAT,
    count: vertexCount,
    type: 'VEC3',
  }) - 1;

  const uvAcc = accessors.push({
    bufferView: parts.add(f32(uv), TARGET_ARRAY_BUFFER),
    componentType: COMPONENT_FLOAT,
    count: vertexCount,
    type: 'VEC2',
  }) - 1;

  const jntAcc = accessors.push({
    bufferView: parts.add(u16(skin.joints), TARGET_ARRAY_BUFFER),
    componentType: COMPONENT_USHORT,
    count: vertexCount,
    type: 'VEC4',
  }) - 1;

  const wgtAcc = accessors.push({
    bufferView: parts.add(f32(skin.weights), TARGET_ARRAY_BUFFER),
    componentType: COMPONENT_FLOAT,
    count: vertexCount,
    type: 'VEC4',
  }) - 1;

  // inverseBind = M_T⁻¹。T-pose 世界矩阵是纯平移 T(p)（旋转 identity），故逆即 T(−p)。
  // 这里就是「ΔR 不进骨架」的最终落点：产物里再也找不到任何当前姿态的旋转。
  const ibm = new Float32Array(HUMANIK_ORDER.length * 16);
  HUMANIK_ORDER.forEach((n, i) => {
    const p = fit.tposePositions[n]!;
    ibm.set(new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      -p[0], -p[1], -p[2], 1,
    ]), i * 16);
  });
  const ibmAcc = accessors.push({
    bufferView: parts.add(f32(ibm)),
    componentType: COMPONENT_FLOAT,
    count: HUMANIK_ORDER.length,
    type: 'MAT4',
  }) - 1;

  // ── 节点：索引 0 = mesh 节点，1..22 = 骨骼──
  const dirs = tposeDirections();
  const nodes: Array<Record<string, unknown>> = [
    { mesh: 0, skin: 0, name: `${name}_Skinned` },
  ];
  const nodeOfJoint: Record<string, number> = {};
  HUMANIK_ORDER.forEach((n) => {
    const parent = HUMANIK_BONES[n]!.parent;
    const u = dirs[n]!;
    const L = fit.lengths[n]!;
    const node: Record<string, unknown> = { name: n };
    if (parent === null) {
      // 根骨：沿用用户摆放的 Hips 位置（T-pose 里骨盆的高度就是它）
      const p = fit.tposePositions[n]!;
      node.translation = [p[0], p[1], p[2]];
    } else {
      // 子骨：translation = T-pose 标准朝向 × 采纳骨长；不写 rotation = 单位四元数
      node.translation = [u[0] * L, u[1] * L, u[2] * L];
      const pn = nodeOfJoint[parent]!;
      const kids = nodes[pn]!.children as unknown[] | undefined;
      if (kids === undefined) nodes[pn]!.children = [nodes.length];
      else kids.push(nodes.length);
    }
    nodeOfJoint[n] = nodes.length;
    nodes.push(node);
  });

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Aether Editor · Binding Panel (T-pose unpose)' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [{
      name,
      primitives: [{
        attributes: {
          POSITION: posAcc,
          NORMAL: nrmAcc,
          TEXCOORD_0: uvAcc,
          JOINTS_0: jntAcc,
          WEIGHTS_0: wgtAcc,
        },
        indices: idxAcc,
        material: 0,
      }],
    }],
    skins: [{
      joints: HUMANIK_ORDER.map((n) => nodeOfJoint[n]!),
      inverseBindMatrices: ibmAcc,
      skeleton: nodeOfJoint.Hips,
    }],
    materials: [{
      name: `${name}_Mat`,
      pbrMetallicRoughness: {
        metallicFactor: 1,
        roughnessFactor: 1,
      },
    }],
  };

  if (imageBytes !== null && imageBytes.byteLength > 0) {
    const imgView = parts.add(imageBytes);
    json.images = [{ bufferView: imgView, mimeType: mime || 'image/png', name: `${name}_baseColor` }];
    json.textures = [{ source: 0 }];
    (json.materials as Array<Record<string, unknown>>)[0]!.pbrMetallicRoughness = {
      baseColorTexture: { index: 0 },
      metallicFactor: 1,
      roughnessFactor: 1,
    };
  }

  const bin = parts.concat();
  json.accessors = accessors;
  json.bufferViews = parts.views;
  json.buffers = [{ byteLength: bin.byteLength }];

  return assembleGlb(json, bin);
}

/** 组装 GLB 容器：12B 头 + JSON chunk（空格补齐）+ BIN chunk（0 补齐） */
function assembleGlb(json: unknown, bin: Uint8Array): ArrayBuffer {
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  if (jPad > 0) {
    const padded = new Uint8Array(jsonBytes.byteLength + jPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const bPad = (4 - (bin.byteLength % 4)) % 4;
  let binPadded = bin;
  if (bPad > 0) {
    binPadded = new Uint8Array(bin.byteLength + bPad);
    binPadded.set(bin);
  }

  const total = 12 + 8 + jsonBytes.byteLength + 8 + binPadded.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.byteLength;
  dv.setUint32(binAt, binPadded.byteLength, true);
  dv.setUint32(binAt + 4, 0x004e4942, true); // 'BIN\0'
  out.set(binPadded, binAt + 8);
  return out.buffer;
}

/** 触发浏览器下载 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 下一帧再回收：某些浏览器在 click 还没发起传输时就 revoke 会导致下载空文件
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
