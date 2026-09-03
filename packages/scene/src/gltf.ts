/**
 * 极简 glTF 2.0 Binary（.glb）加载器。
 *
 * 用途：把「AI 生成的游戏模型」直接拖进 Shader Lab 预览，不用改任何代码。
 * 输出统一转成 lab 的顶点契约（与 scene 包的 geometry.ts 一致，stride 60B / 15 floats）：
 *   pos(3) + normal(3) + smoothNormal(3) + uv(2) + color(4)
 *   color.r = 描边倍率(1.0)，color.g = 烘焙 AO（有 COLOR_0 才用，否则 1.0）
 *
 * 模型规整化（与 export_labmesh.py 同一套约定）：
 *   - 轴：自动检测。AI 生成管线的 glb 常是 Z-up（高度在 Z），检测到 zSpan > ySpan×1.5
 *     就按 (x,y,z)→(x,-z,y) 转成 Y-up（det=+1 的纯旋转，绕序不翻转）。
 *     注意：混元 3D 产物脚底在 z-max（+Z 朝下），必须是这个带 180° X 翻转的极性才正立；
 *     早期版本写成 (x,z,-y) 会让模型上下颠倒，13:58 已修正，别再改回去。
 *   - 平移：X/Z 居中，脚底贴 y=0
 *   - 缩放：统一缩到 targetHeight 米（**由调用方传入**，见 models.ts 的 MODEL_RULER_HEIGHT_M，
 *     真源是 assets/characters/roster.json 的 height 字段；这里不硬编码身高）
 *
 * 已知限制（预览够用，别过度设计）：
 *   - 只取 POSITION / NORMAL / TEXCOORD_0 / COLOR_0，无视 morph / skin
 *   - 多 primitive / 多 mesh 会合并成一张（按 primitive 拆成子网格区间，见 subMeshes）
 *   - 外部 .bin / 外部纹理文件不解析（glb 内嵌的才支持）
 *
 * 注：早期版本「忽略 node 层级变换」，这是导入后模型稀碎的根因（Blender 把 Z-up→Y-up
 * 烘在 node 上，E-04 的 node 带 90°X 旋转）。现已改为 collectMeshInstances 遍历场景图
 * 累乘世界矩阵，法线走 3x3 逆转置；烘完再做轴检测，避免双重旋转。别再改回去。
 */

import type { MeshData } from './geometry';
import * as m4 from '@aether/core';
import { nameAllocator } from '@aether/core';

export const VF = 15;

/**
 * 子网格在合并后索引缓冲中的区间（与 Unity sub-mesh 同语义）。
 *
 * 后 5 个字段是「换模型继承材质绑定」的身份信息（见 binding.ts）：
 * nodeId 是第一层防护（精确匹配），nodePath 是第二层防护（反向路径匹配），
 * primitiveKey / primitiveIndex 是节点内部 primitive 粒度的匹配键。
 */
export interface SubMeshRange {
  name: string;
  indexStart: number;
  indexCount: number;
  /** mesh 节点稳定 ID：node.extras 里的字符串优先，缺省 auto-<nodeIndex>（同一文件重导恒定） */
  nodeId: string;
  /** 场景根 → 该节点的名字链（leaf 在最后）。反向匹配时从 leaf 往 root 比 */
  nodePath: string[];
  /** mesh 节点自身的名字（层级树显示用；与 sub-mesh 的显示名 name 不是一回事） */
  nodeName: string;
  /** primitive 级身份：材质名优先，缺省 #<primitive 在 mesh 内序号> */
  primitiveKey: string;
  /** 该 primitive 在同一 mesh 节点内的序号（key 失效时的兜底匹配键） */
  primitiveIndex: number;
}

/**
 * GLB 原始场景树的显示节点（层级面板据此还原父子结构，不再 flat）。
 * 只有「mesh 节点」与「有后代的组节点」会进树；空叶子（灯光/相机/locator）不进。
 */
export interface GltfNodeTree {
  /** 显示名（node.name，缺省 node_<index>） */
  name: string;
  /** mesh 节点：其 primitive 在 subMeshes 里的起始下标；非 mesh 节点为 null */
  subStart: number | null;
  /** mesh 节点的 primitive 条数（实际解析成功的，可能少于 glTF 里的条数） */
  subCount: number;
  children: GltfNodeTree[];
}

export interface GltfResult {
  mesh: MeshData;
  /** 网格名（mesh.name 或 image.name，取得到才给） */
  name: string;
  vertices: number;
  triangles: number;
  /** 规整化后的身高（米） */
  heightMeters: number;
  /**
   * 子网格（sub-mesh）：每个 primitive 在合并后索引缓冲里的区间。
   * Unity 里一个 Mesh 可以有多个 sub-mesh，各自挂不同材质槽 —— 这里照同一套落地，
   * 层级面板据此展开子节点，渲染据此分 draw call、材质据此分槽位。
   */
  subMeshes: SubMeshRange[];
  /** GLB 原始父子层级（多个场景根就有多条）；叶子 mesh 节点引用 subMeshes 下标 */
  nodeTree: GltfNodeTree[];
  /** 第一张内嵌 image 的字节；没有则为 null。主线程里用 createImageBitmap 解码 */
  image: Blob | null;

  /**
   * 骨骼数据（skinned mesh 才有，否则 null）。
   * 约定全部基于 glTF 规范：joint 节点是世界空间（场景根空间）的，inverseBind 也是；
   * 渲染时 jointMatrix_i = jointWorld_i * inverseBind_i，顶点已是「mesh 节点世界矩阵烘过的」
   * 场景空间坐标，二者同空间，公式自洽（详见 renderer 的 updateSkinning）。
   */
  skeleton: SkeletonData | null;
  /** 动画片段（skinned+animated 才有，否则空数组） */
  animations: AnimClip[];
}

/** 单根骨骼的本地变换（与 glTF node 的 T/R/S 同义；无 T/R/S 时为零向量/单位四元数） */
export interface NodeLocal {
  t: [number, number, number];
  r: [number, number, number, number];
  s: [number, number, number];
}

/**
 * 打包好的骨骼 + 动画驱动数据。渲染器直接消费，不需要再回去翻 json。
 * joints 是节点索引（指向 nodesLocal / parent 数组）；inverseBind 按 joints 同序。
 */
export interface SkeletonData {
  /** 该 skin 的关节节点索引（glTF skin.joints），length = 关节数 */
  joints: number[];
  /** 关节显示名（Mixamo/HumanIK 约定名：Hips/Spine/...），用于权重可视化与 Mixamo 重定向映射 */
  jointNames: (string | null)[];
  /** inverseBindMatrices，列主序，length = joints.length * 16 */
  inverseBind: Float32Array;
  /** 每个节点的父节点下标，-1 = 场景根 */
  parent: number[];
  /** 每个节点的初始本地变换（bind pose 来源） */
  locals: NodeLocal[];
  /** 场景根节点下标（parent === -1 的节点） */
  roots: number[];
  /**
   * 顶点规整化矩阵 T（列主序 mat4）：把「未规整化的场景根空间」映射到
   * 「顶点实际所在空间」(v' = T·v)。由上面的轴旋转 + 居中 + 缩放构成，
   * 蒙皮求值时会用它共轭关节矩阵，否则蒙皮与顶点不在同一空间 → 整体错位。
   * 已是 Y-up 居中模型时退化为单位阵。
   */
  normalization: Float32Array;
}

/** 一段动画轨道：驱动某个节点的某个变换路径 */
export interface AnimTrack {
  node: number;
  path: 'translation' | 'rotation' | 'scale';
  /** 关键帧时间（秒），升序 */
  times: Float32Array;
  /** 关键帧值，按 track 平铺：rotation=stride4（四元数 xyzw），translation/scale=stride3 */
  values: Float32Array;
  stride: number;
  interpolation: 'LINEAR' | 'STEP';
}

/** 一个动画片段（如 Mixamo 的 Idle / Walk / Run / Attack） */
export interface AnimClip {
  name: string;
  /** 时长（秒）= 各 sampler 最大关键帧时间 */
  duration: number;
  tracks: AnimTrack[];
}

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5124: 4,
  5125: 4,
  5126: 4,
};

const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

interface GltfJson {
  buffers?: { byteLength?: number; uri?: string }[];
  bufferViews?: {
    buffer?: number;
    byteOffset?: number;
    byteLength?: number;
    byteStride?: number;
  }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    count?: number;
    type?: string;
    normalized?: boolean;
  }[];
  meshes?: {
    name?: string;
    primitives?: { attributes?: Record<string, number>; indices?: number; material?: number }[];
  }[];
  /** 场景图：模型分件 / Z-up 转换就藏在这里的变换上，不能忽略 */
  nodes?: NodeJson[];
  scenes?: { nodes?: number[] }[];
  /** 骨骼：joints 节点索引数组 + inverseBindMatrices 访问器（列主序 mat4，按 joints 同序） */
  skins?: {
    name?: string;
    joints: number[];
    inverseBindMatrices?: number;
    skeleton?: number;
  }[];
  /** 动画：channels 指向节点 + 变换路径，samplers 指向关键帧输入/输出 */
  animations?: {
    name?: string;
    channels: { sampler: number; target: { node: number; path: string } }[];
    samplers: { input: number; output: number; interpolation?: string }[];
  }[];
  materials?: {
    name?: string;
    pbrMetallicRoughness?: { baseColorTexture?: { index?: number } };
  }[];
  textures?: { source?: number }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string; name?: string }[];
}

/** 读一个 accessor 的原始元素（含 byteStride 展开 / 整数归一化），返回 f32 */
function readFloats(
  json: GltfJson,
  bin: ArrayBuffer,
  binStart: number,
  accessor: NonNullable<GltfJson['accessors']>[number],
): Float32Array | null {
  const compType = accessor.componentType ?? 0;
  const type = accessor.type ?? 'SCALAR';
  const count = accessor.count ?? 0;
  const compSize = COMPONENT_SIZE[compType];
  const typeSize = TYPE_SIZE[type] ?? 1;
  if (compSize === undefined || count === 0) return null;

  const bv = json.bufferViews?.[accessor.bufferView ?? -1];
  if (bv === undefined) return null;
  const buffer = json.buffers?.[bv.buffer ?? -1];
  if (buffer === undefined || buffer.uri !== undefined) return null;

  const stride = bv.byteStride ?? compSize * typeSize;
  const start = binStart + (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(bin);

  const out = new Float32Array(count * typeSize);
  const isFloat = compType === 5126;

  for (let i = 0; i < count; i++) {
    const elem = start + i * stride;
    for (let c = 0; c < typeSize; c++) {
      let v: number;
      switch (compType) {
        case 5126:
          v = view.getFloat32(elem + c * 4, true);
          break;
        case 5121:
          v = view.getUint8(elem + c);
          break;
        case 5120:
          v = view.getInt8(elem + c);
          break;
        case 5123:
          v = view.getUint16(elem + c * 2, true);
          break;
        case 5122:
          v = view.getInt16(elem + c * 2, true);
          break;
        case 5125:
          v = view.getUint32(elem + c * 4, true);
          break;
        case 5124:
          v = view.getInt32(elem + c * 4, true);
          break;
        default:
          return null;
      }
      out[i * typeSize + c] = v;
    }
  }

  // 整数分量归一化：规范只认 accessor.normalized=true。这里额外兜底非规范导出器
  // （整数分量却没设 normalized，值域 0..255 之类的），按数据范围判断，避免坐标爆炸几个数量级。
  if (!isFloat) {
    let maxAbs = 0;
    for (let i = 0; i < out.length; i++) {
      const a = Math.abs(out[i]!);
      if (a > maxAbs) maxAbs = a;
    }
    const specNorm = accessor.normalized === true;
    if (specNorm || maxAbs > 1.0001) {
      // glTF 归一化量程：有符号是 2^(n-1)-1，无符号是 2^n-1
      const d =
        compType === 5120 ? 127
        : compType === 5121 ? 255
        : compType === 5122 ? 32767
        : compType === 5123 ? 65535
        : compType === 5124 ? 2147483647
        : 1;
      if (d !== 1) for (let i = 0; i < out.length; i++) out[i] = out[i]! / d;
    }
  }
  return out;
}

/** 读索引 accessor（u8/u16/u32 → Uint32Array） */
function readIndices(json: GltfJson, bin: ArrayBuffer, binStart: number, index: number): Uint32Array | null {
  const acc = json.accessors?.[index];
  if (acc === undefined) return null;
  const bv = json.bufferViews?.[acc.bufferView ?? -1];
  if (bv === undefined) return null;
  const compType = acc.componentType ?? 0;
  const count = acc.count ?? 0;
  const stride = bv.byteStride ?? COMPONENT_SIZE[compType] ?? 2;
  const start = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const view = new DataView(bin);

  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const e = start + i * stride;
    if (compType === 5125) out[i] = view.getUint32(e, true);
    else if (compType === 5121) out[i] = view.getUint8(e);
    else out[i] = view.getUint16(e, true);
  }
  return out;
}

/**
 * 读整数分量访问器（JOINTS_0 专用）。JOINTS 是整数索引，绝不归一化，
 * 所以不能用 readFloats（它会把归一化的整数当 0..1）。compType 只可能是
 * 5121(u8) / 5123(u16) / 5125(u32)；每顶点 comps 个分量（JOINTS 固定 4）。
 * 返回 Float32Array（*comps 长度），方便与 WEIGHTS 同序拼接、零拷贝合并。
 */
function readInts(
  json: GltfJson,
  bin: ArrayBuffer,
  binStart: number,
  index: number,
  comps: number,
): Float32Array | null {
  const acc = json.accessors?.[index];
  if (acc === undefined) return null;
  const bv = json.bufferViews?.[acc.bufferView ?? -1];
  if (bv === undefined) return null;
  const compType = acc.componentType ?? 0;
  const count = acc.count ?? 0;
  const stride = bv.byteStride ?? comps * COMPONENT_SIZE[compType]!;
  const start = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const view = new DataView(bin);
  const out = new Float32Array(count * comps);
  for (let i = 0; i < count; i++) {
    const e = start + i * stride;
    for (let c = 0; c < comps; c++) {
      const o = e + c * COMPONENT_SIZE[compType]!;
      out[i * comps + c] =
        compType === 5125 ? view.getUint32(o, true)
        : compType === 5121 ? view.getUint8(o)
        : view.getUint16(o, true);
    }
  }
  return out;
}

/** 按位置焊接顶点，把法线平均成描边专用的 smoothNormal（硬边几何的着色法线在棱角不连续，直接外扩会裂） */
function smoothNormals(pos: Float32Array, normal: Float32Array): Float32Array {
  const count = pos.length / 3;
  // 用量化后的精确坐标字符串做键：早期版本用哈希整数取键，56k 顶点下碰撞概率约三成，
  // 一旦撞上就会把两个毫不相干的顶点法线平均 → 描边炸出尖刺（表现为模型「稀碎」）。
  const accum = new Map<string, [number, number, number]>();
  const key = (i: number): string => {
    const x = Math.round(pos[i * 3]! * 10000);
    const y = Math.round(pos[i * 3 + 1]! * 10000);
    const z = Math.round(pos[i * 3 + 2]! * 10000);
    return `${x},${y},${z}`;
  };

  for (let i = 0; i < count; i++) {
    const k = key(i);
    const prev = accum.get(k) ?? [0, 0, 0];
    prev[0] += normal[i * 3]!;
    prev[1] += normal[i * 3 + 1]!;
    prev[2] += normal[i * 3 + 2]!;
    accum.set(k, prev);
  }

  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = accum.get(key(i));
    if (v === undefined) {
      out[i * 3 + 1] = 1;
      continue;
    }
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-8) {
      out[i * 3 + 1] = 1;
    } else {
      out[i * 3] = v[0] / len;
      out[i * 3 + 1] = v[1] / len;
      out[i * 3 + 2] = v[2] / len;
    }
  }
  return out;
}

/** 没有法线属性时，按三角形面法线累计一份顶点法线 */
function faceNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(pos.length);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const i0 = idx[t]!;
    const i1 = idx[t + 1]!;
    const i2 = idx[t + 2]!;
    const ax = pos[i1 * 3]! - pos[i0 * 3]!;
    const ay = pos[i1 * 3 + 1]! - pos[i0 * 3 + 1]!;
    const az = pos[i1 * 3 + 2]! - pos[i0 * 3 + 2]!;
    const bx = pos[i2 * 3]! - pos[i0 * 3]!;
    const by = pos[i2 * 3 + 1]! - pos[i0 * 3 + 1]!;
    const bz = pos[i2 * 3 + 2]! - pos[i0 * 3 + 2]!;
    const fx = ay * bz - az * by;
    const fy = az * bx - ax * bz;
    const fz = ax * by - ay * bx;
    for (const i of [i0, i1, i2]) {
      n[i * 3]! += fx;
      n[i * 3 + 1]! += fy;
      n[i * 3 + 2]! += fz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!);
    if (len < 1e-8) {
      n[i + 1] = 1;
    } else {
      n[i] = n[i]! / len;
      n[i + 1] = n[i + 1]! / len;
      n[i + 2] = n[i + 2]! / len;
    }
  }
  return n;
}

/** 绕序校正为 CCW（inverted hull 描边用 cullMode:'front'，绕序错会整个涂黑） */
function fixWinding(pos: Float32Array, normal: Float32Array, idx: Uint32Array): void {
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const i0 = idx[t]!;
    const i1 = idx[t + 1]!;
    const i2 = idx[t + 2]!;
    const ax = pos[i1 * 3]! - pos[i0 * 3]!;
    const ay = pos[i1 * 3 + 1]! - pos[i0 * 3 + 1]!;
    const az = pos[i1 * 3 + 2]! - pos[i0 * 3 + 2]!;
    const bx = pos[i2 * 3]! - pos[i0 * 3]!;
    const by = pos[i2 * 3 + 1]! - pos[i0 * 3 + 1]!;
    const bz = pos[i2 * 3 + 2]! - pos[i0 * 3 + 2]!;
    const fx = ay * bz - az * by;
    const fy = az * bx - ax * bz;
    const fz = ax * by - ay * bx;
    if (fx * fx + fy * fy + fz * fz < 1e-20) continue;
    const nx = normal[i0 * 3]! + normal[i1 * 3]! + normal[i2 * 3]!;
    const ny = normal[i0 * 3 + 1]! + normal[i1 * 3 + 1]! + normal[i2 * 3 + 1]!;
    const nz = normal[i0 * 3 + 2]! + normal[i1 * 3 + 2]! + normal[i2 * 3 + 2]!;
    if (fx * nx + fy * ny + fz * nz < 0) {
      const tmp = idx[t + 1]!;
      idx[t + 1] = idx[t + 2]!;
      idx[t + 2] = tmp;
    }
  }
}

/* ===================== 场景图（纯函数，可单测） ===================== */

interface NodeJson {
  mesh?: number;
  name?: string;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  /** 该节点引用的 skin 下标（glTF node.skin）。有 skin 的节点通常是蒙皮网格节点 */
  skin?: number;
  /** DCC / 导出器可写入的自定义数据。绑定继承的第一层防护（稳定节点 ID）就读这里 */
  extras?: Record<string, unknown>;
}

/** 单位阵（列主序，与 WGSL mat4x4f 同约定） */
function identity4(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** a · b（列主序，先应用 b） */
function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!;
    const b1 = b[c * 4 + 1]!;
    const b2 = b[c * 4 + 2]!;
    const b3 = b[c * 4 + 3]!;
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r]! * b0 + a[4 + r]! * b1 + a[8 + r]! * b2 + a[12 + r]! * b3;
    }
  }
  return o;
}

/** node 的局部矩阵：优先 matrix，否则 T·R·S（glTF 规定顺序） */
export function nodeMatrix(n: NodeJson): Float32Array {
  if (n.matrix !== undefined && n.matrix.length === 16) return new Float32Array(n.matrix);

  const t = n.translation ?? [0, 0, 0];
  const r = n.rotation ?? [0, 0, 0, 1];
  const s = n.scale ?? [1, 1, 1];
  const x = r[0] ?? 0;
  const y = r[1] ?? 0;
  const z = r[2] ?? 0;
  const w = r[3] ?? 1;

  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  const m = new Float32Array(16);
  m[0] = (1 - (yy + zz)) * (s[0] ?? 1);
  m[1] = (xy + wz) * (s[0] ?? 1);
  m[2] = (xz - wy) * (s[0] ?? 1);
  m[4] = (xy - wz) * (s[1] ?? 1);
  m[5] = (1 - (xx + zz)) * (s[1] ?? 1);
  m[6] = (yz + wx) * (s[1] ?? 1);
  m[8] = (xz + wy) * (s[2] ?? 1);
  m[9] = (yz - wx) * (s[2] ?? 1);
  m[10] = (1 - (xx + yy)) * (s[2] ?? 1);
  m[12] = t[0] ?? 0;
  m[13] = t[1] ?? 0;
  m[14] = t[2] ?? 0;
  m[15] = 1;
  return m;
}

/** 4x4 取左上 3x3 的逆转置，行主序 9 个数（法线变换用；非等比缩放也正确） */
export function normalMatrix(m: Float32Array): Float32Array {
  // 列主序 4x4 的 3x3 部分：a[col*4+row]
  const a00 = m[0]!;
  const a10 = m[1]!;
  const a20 = m[2]!;
  const a01 = m[4]!;
  const a11 = m[5]!;
  const a21 = m[6]!;
  const a02 = m[8]!;
  const a12 = m[9]!;
  const a22 = m[10]!;

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (Math.abs(det) < 1e-12) det = 1;
  const id = 1 / det;

  // inverse(M3) 行主序，再转置 → 等于 inverse 的转置
  const inv = [
    b01 * id,
    (-a22 * a01 + a02 * a21) * id,
    (a12 * a01 - a02 * a11) * id,
    b11 * id,
    (a22 * a00 - a02 * a20) * id,
    (-a12 * a00 + a02 * a10) * id,
    b21 * id,
    (-a21 * a00 + a01 * a20) * id,
    (a11 * a00 - a01 * a10) * id,
  ];
  // transpose(inv) 行主序
  return new Float32Array([
    inv[0]!, inv[3]!, inv[6]!,
    inv[1]!, inv[4]!, inv[7]!,
    inv[2]!, inv[5]!, inv[8]!,
  ]);
}

/**
 * node.extras 里认这几个键当稳定节点 ID（按优先级取第一个非空字符串）。
 * 美术在 DCC 里重命名节点不影响它；重导同一文件时它是材质绑定继承的第一层防护。
 * 约定键：zombieNodeId（本编辑器写回用的官方键） > meshId / nodeId / id（兼容外来管线）。
 */
const EXTRA_ID_KEYS = ['zombieNodeId', 'meshId', 'nodeId', 'id'] as const;

function extraNodeId(n: NodeJson): string | null {
  const ex = n.extras;
  if (ex === undefined) return null;
  for (const k of EXTRA_ID_KEYS) {
    const v = ex[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/** 节点显示名：缺名节点给确定性占位名（路径匹配与层级树都靠它） */
function nodeName(n: NodeJson, index: number): string {
  const raw = n.name?.trim() ?? '';
  return raw === '' ? `node_${index}` : raw;
}

/** 场景图遍历产物：mesh 实例（含身份）+ 原始父子层级树 */
export interface SceneGraph {
  instances: {
    mesh: number;
    m: Float32Array;
    nodeIndex: number; // -1 = 兜底合成节点（mesh 没被任何 node 引用）
    nodeId: string;
    nodeName: string;
    /** 场景根 → 该节点的名字链，leaf 在最后 */
    path: string[];
    /** 该节点引用的 skin 下标（glTF node.skin），无则 undefined */
    skin: number | undefined;
  }[];
  /**
   * 显示树（subStart/subCount 此阶段为 -1/0 占位，parseGlb 收集 primitive 时回填）。
   * 空叶子（无 mesh 无后代）已被剪掉。
   */
  tree: GltfNodeTree[];
}

/**
 * 遍历 glTF 场景图：既收集「mesh 实例 → 世界矩阵 + 节点身份」，
 * 也保出原始父子层级（层级面板要按它还原树形，而不是把所有 mesh 压平）。
 */
export function collectSceneGraph(json: GltfJson): SceneGraph {
  const nodes = json.nodes ?? [];
  const out: SceneGraph['instances'] = [];
  const seen = new Set<number>();

  // 返回建好的显示节点；空叶子返回 null（剪掉）
  const walk = (i: number, parent: Float32Array, parentPath: string[]): GltfNodeTree | null => {
    const n = nodes[i];
    if (n === undefined) return null;
    const m = mul4(parent, nodeMatrix(n));
    const name = nodeName(n, i);
    const path = [...parentPath, name];

    let hasMesh = false;
    if (n.mesh !== undefined) {
      out.push({
        mesh: n.mesh,
        m,
        nodeIndex: i,
        nodeId: extraNodeId(n) ?? `auto-${i}`,
        nodeName: name,
        path,
        skin: n.skin,
      });
      seen.add(n.mesh);
      hasMesh = true;
    }

    const kids: GltfNodeTree[] = [];
    for (const c of n.children ?? []) {
      const k = walk(c, m, path);
      if (k !== null) kids.push(k);
    }
    if (!hasMesh && kids.length === 0) return null; // 空叶子：灯光/相机/locator，不进树
    return { name, subStart: hasMesh ? -1 : null, subCount: 0, children: kids };
  };

  const tree: GltfNodeTree[] = [];
  const scene = json.scenes?.[0];
  if (scene !== undefined || json.scenes !== undefined) {
    for (const r of scene?.nodes ?? []) {
      const t = walk(r, identity4(), []);
      if (t !== null) tree.push(t);
    }
  } else {
    // 没有 scene：所有 node 都当根节点，各自用本地变换
    for (let i = 0; i < nodes.length; i++) {
      const t = walk(i, identity4(), []);
      if (t !== null) tree.push(t);
    }
  }

  // 兜底：不在场景图里的 mesh 合成伪节点收进来，不丢件
  const meshes = json.meshes ?? [];
  for (let i = 0; i < meshes.length; i++) {
    if (seen.has(i)) continue;
    const name = meshes[i]?.name?.trim() || `mesh_${i}`;
    out.push({ mesh: i, m: identity4(), nodeIndex: -1, nodeId: `auto-mesh-${i}`, nodeName: name, path: [name], skin: undefined });
    tree.push({ name, subStart: -1, subCount: 0, children: [] });
  }
  return { instances: out, tree };
}

/**
 * 收集「mesh 实例 → 世界矩阵」。一个 mesh 被多个 node 引用就产生多个实例（正确行为）。
 * 没有被任何 node 引用的 mesh 兜底按 identity 处理，避免模型凭空少一块。
 * （身份信息见 collectSceneGraph；本接口保留给只关心矩阵的老调用方）
 */
export function collectMeshInstances(json: GltfJson): { mesh: number; m: Float32Array }[] {
  return collectSceneGraph(json).instances.map(({ mesh, m }) => ({ mesh, m }));
}

export function parseGlb(buf: ArrayBuffer, targetHeight = 2.05): GltfResult {
  if (buf.byteLength < 20) throw new Error('文件太小，不是合法的 glb');
  const head = new DataView(buf);
  if (head.getUint32(0, true) !== 0x46546c67) throw new Error('不是 glTF 二进制（缺 glTF magic）');
  if (head.getUint32(4, true) !== 2) throw new Error(`不支持的 glTF 版本 ${head.getUint32(4, true)}`);

  // ---- 切 chunk ----
  let jsonBuf: ArrayBuffer | null = null;
  let binStart = 0;
  let binEnd = 0;
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const len = head.getUint32(off, true);
    const type = head.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) {
      jsonBuf = buf.slice(start, start + len);
    } else if (type === 0x004e4942) {
      binStart = start;
      binEnd = start + len;
    }
    off = start + len + ((4 - (len % 4)) % 4); // chunk 按 4 字节对齐
  }
  if (jsonBuf === null) throw new Error('glb 里没有 JSON chunk');

  const json = JSON.parse(new TextDecoder().decode(jsonBuf)) as GltfJson;
  const bin = buf.slice(binStart, binEnd);

  // ---- 场景图：把 node 的世界变换烘进顶点 ----
  // glTF 规范步骤，不能省。AI / Blender 导出常把 Z-up→Y-up 烘在 node 的 rotation 上，
  // 或把武器、盾牌做成带独立变换的子节点；忽略 node 变换会让这类模型直接散架 ——
  // 这正是「导入后模型稀碎」的根因。烘焙后再做轴向规整，两把尺子不会重复生效。
  // graph 同时带回每个 mesh 节点的身份（nodeId / 路径）与原始父子层级 ——
  // 前者是换模型继承材质绑定的匹配键，后者让层级面板能还原树形结构。
  const graph = collectSceneGraph(json);
  const instances = graph.instances;

  // ---- 合并所有 primitive ----
  // 两趟：先按 primitive 收集（readFloats 本来就是类型化数组，零拷贝），
  // 再按总顶点数一次性预分配。80k 顶点的高模实测 —— 避免百万次 Array.push 的扩容抖动。
  interface PrimChunk {
    name: string;
    pos: Float32Array;
    nor: Float32Array;
    uv: Float32Array | null;
    col: Float32Array | null;
    ind: Uint32Array;
    nodeId: string;
    nodePath: string[];
    nodeName: string;
    primitiveKey: string;
    primitiveIndex: number;
    /** 蒙皮关节索引（4/顶点，0..nJoints-1）；无 skin 的 primitive 为 null */
    joints: Uint16Array | null;
    /** 蒙皮权重（4/顶点，已归一化）；无 skin 为 null */
    weights: Float32Array | null;
  }
  const chunks: PrimChunk[] = [];
  const primNames = nameAllocator(); // 同名 primitive（同材质被复用）自动加序号，避免层级树里分不清
  let base = 0;
  /** 与 instances 同序：每个 mesh 节点实际产出的子网格区间（回填显示树用） */
  const instSubs: { start: number; count: number }[] = [];

  for (const inst of instances) {
    const subStart = chunks.length;
    const mesh = json.meshes?.[inst.mesh];
    if (mesh === undefined) {
      instSubs.push({ start: subStart, count: 0 });
      continue;
    }
    const prims = mesh.primitives ?? [];
    for (let pi = 0; pi < prims.length; pi++) {
      const prim = prims[pi]!;
      const attr = prim.attributes ?? {};
      const raw = attr.POSITION === undefined ? null : readFloats(json, bin, 0, json.accessors?.[attr.POSITION]!);
      if (raw === null || raw.length === 0) continue;
      // 把 node 世界变换烘进局部顶点（位置 = M·p，法线 = 逆转置·n 再归一化）
      const p = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i += 3) {
        const x = raw[i]!;
        const y = raw[i + 1]!;
        const z = raw[i + 2]!;
        p[i] = inst.m[0]! * x + inst.m[4]! * y + inst.m[8]! * z + inst.m[12]!;
        p[i + 1] = inst.m[1]! * x + inst.m[5]! * y + inst.m[9]! * z + inst.m[13]!;
        p[i + 2] = inst.m[2]! * x + inst.m[6]! * y + inst.m[10]! * z + inst.m[14]!;
      }

      const rawNor =
        attr.NORMAL === undefined ? null : readFloats(json, bin, 0, json.accessors?.[attr.NORMAL]!);
      const rawUv =
        attr.TEXCOORD_0 === undefined ? null : readFloats(json, bin, 0, json.accessors?.[attr.TEXCOORD_0]!);
      const rawCol =
        attr.COLOR_0 === undefined ? null : readFloats(json, bin, 0, json.accessors?.[attr.COLOR_0]!);

      // 蒙皮：仅当该节点引用了 skin 且 primitive 带 JOINTS_0 / WEIGHTS_0 才读取。
      // JOINTS_0 的值直接索引 skin.joints[] 与 inverseBind[]（glTF 规范），渲染器按同序建调色板，无需重映射。
      let joints: Uint16Array | null = null;
      let weights: Float32Array | null = null;
      if (inst.skin !== undefined) {
        const ji = attr.JOINTS_0;
        const wi = attr.WEIGHTS_0;
        if (ji !== undefined && wi !== undefined) {
          const jf = readInts(json, bin, 0, ji, 4);
          const wf = readFloats(json, bin, 0, json.accessors?.[wi]!);
          if (jf !== null && wf !== null) {
            joints = new Uint16Array(jf); // f32 暂存 → u16（JOINTS 都是小整数）
            weights = wf;
          }
        }
      }

      let ind =
        prim.indices === undefined ? null : readIndices(json, bin, 0, prim.indices);
      if (ind === null) {
        ind = new Uint32Array(p.length / 3);
        for (let i = 0; i < ind.length; i++) ind[i] = i;
      }

      const localNor = rawNor ?? faceNormals(p, ind);
      fixWinding(p, localNor, ind);
      // 法线：M 的 3x3 逆转置（非等比缩放也不会歪），再归一化
      const nm = normalMatrix(inst.m);
      const normal = new Float32Array(localNor.length);
      for (let i = 0; i < localNor.length; i += 3) {
        const x = localNor[i]!;
        const y = localNor[i + 1]!;
        const z = localNor[i + 2]!;
        const nx = nm[0]! * x + nm[1]! * y + nm[2]! * z;
        const ny = nm[3]! * x + nm[4]! * y + nm[5]! * z;
        const nz = nm[6]! * x + nm[7]! * y + nm[8]! * z;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-12) {
          normal[i + 1] = 1;
        } else {
          normal[i] = nx / len;
          normal[i + 1] = ny / len;
          normal[i + 2] = nz / len;
        }
      }

      const count = p.length / 3;
      // 命名优先级：材质名 > mesh 名 > primitive_N。
      //
      // **材质名必须排第一**：glTF 的 primitive 就是按材质拆的（身体/武器/盾牌各一条），
      // 而同一个 mesh 下的所有 primitive 共用 mesh.name。Blender 导出的模型几乎都带
      // mesh.name，按「mesh.name 优先」会让 3 条子网格全叫同一个名字 —— 层级树里
      // 根本分不清哪个是盾牌哪个是武器。只有单 primitive（用不上材质名区分）时才用 mesh 名。
      const matName =
        prim.material === undefined ? undefined : json.materials?.[prim.material]?.name;
      const rawName =
        matName ?? ((mesh.primitives?.length ?? 0) === 1 ? mesh.name : undefined) ?? '';
      const primName =
        rawName.trim() === '' ? `primitive_${chunks.length}` : primNames.take(rawName.trim());
      // primitive 级匹配键：材质名最稳（artist 重排 primitive 顺序也不怕）；
      // 没材质名才退到 #<序号> —— 此时顺序就是唯一信号
      const primitiveKey =
        matName !== undefined && matName.trim() !== '' ? matName.trim() : `#${pi}`;
      chunks.push({
        name: primName,
        pos: p,
        nor: normal,
        uv: rawUv,
        col: rawCol,
        ind,
        nodeId: inst.nodeId,
        nodePath: inst.path,
        nodeName: inst.nodeName,
        primitiveKey,
        primitiveIndex: pi,
        joints,
        weights,
      });
      base += count;
    }
    instSubs.push({ start: subStart, count: chunks.length - subStart });
  }

  if (base === 0) throw new Error('glb 里没有可用的 POSITION 网格');

  const posArr = new Float32Array(base * 3);
  const norArr = new Float32Array(base * 3);
  const uvArr = new Float32Array(base * 2);
  const colArr = new Float32Array(base * 4);
  const idxArr = new Uint32Array(chunks.reduce((n, c) => n + c.ind.length, 0));

  // 蒙皮输出：仅当任一 primitive 带 joints 才分配（否则保持 null → 渲染器走 identity 蒙皮）。
  // 调色板末尾永远留一个「恒等关节」(index = jointCount)，未蒙皮的 primitive 顶点全部绑到它，
  // 既不随骨骼运动、也不会因权重全 0 而坍缩。
  let skinJointCount = 0;
  for (const inst of instances) {
    if (inst.skin !== undefined) {
      const sk = json.skins?.[inst.skin];
      if (sk !== undefined) { skinJointCount = sk.joints.length; break; }
    }
  }
  let jointsOut: Uint16Array | null = null;
  let weightsOut: Float32Array | null = null;
  {
    let hasSkin = false;
    for (const c of chunks) if (c.joints !== null) { hasSkin = true; break; }
    if (hasSkin) {
      jointsOut = new Uint16Array(base * 4);
      weightsOut = new Float32Array(base * 4);
    }
  }

  let vOff = 0;
  let iOff = 0;
  const subMeshes: SubMeshRange[] = [];
  for (const c of chunks) {
    subMeshes.push({
      name: c.name,
      indexStart: iOff,
      indexCount: c.ind.length,
      nodeId: c.nodeId,
      nodePath: c.nodePath,
      nodeName: c.nodeName,
      primitiveKey: c.primitiveKey,
      primitiveIndex: c.primitiveIndex,
    });
    posArr.set(c.pos, vOff * 3);
    norArr.set(c.nor, vOff * 3);
    if (c.uv !== null) uvArr.set(c.uv.subarray(0, (c.pos.length / 3) * 2), vOff * 2);
    // COLOR_0 可能是 vec3（无 alpha）也可能是 vec4，按长度取 G 通道当 AO
    const count = c.pos.length / 3;
    if (c.col !== null) {
      const vec4 = c.col.length >= count * 4;
      for (let i = 0; i < count; i++) {
        const ao = vec4 ? c.col[i * 4 + 1]! : c.col[i * 3 + 1]!;
        const o = (vOff + i) * 4;
        colArr[o] = 1;
        colArr[o + 1] = ao;
        colArr[o + 2] = 0;
        colArr[o + 3] = 1;
      }
    } else {
      for (let i = 0; i < count; i++) {
        const o = (vOff + i) * 4;
        colArr[o] = 1;
        colArr[o + 1] = 1;
        colArr[o + 2] = 0;
        colArr[o + 3] = 1;
      }
    }
    for (let i = 0; i < c.ind.length; i++) idxArr[iOff + i] = vOff + c.ind[i]!;
    // 蒙皮数据：有则原样拷贝；无（该 primitive 未蒙皮）则绑到末尾的恒等关节，保持静止
    if (jointsOut !== null && weightsOut !== null) {
      if (c.joints !== null && c.weights !== null) {
        jointsOut.set(c.joints, vOff * 4);
        weightsOut.set(c.weights, vOff * 4);
      } else {
        for (let i = 0; i < count; i++) {
          jointsOut[(vOff + i) * 4] = skinJointCount; // 恒等关节
          weightsOut[(vOff + i) * 4] = 1;
        }
      }
    }
    vOff += count;
    iOff += c.ind.length;
  }

  // 规整化矩阵 T（顶点用的同一把尺子；蒙皮求值时用它共轭关节矩阵，否则蒙皮错位）
  let normMat: m4.Mat4 = m4.mat4();
  let zUp = false;
  // ---- 轴检测：生成管线常出 Z-up（高度在 Z）。zSpan 明显大于 ySpan 就按 Z-up 转 ----
  {
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < posArr.length; i += 3) {
      minY = Math.min(minY, posArr[i + 1]!);
      maxY = Math.max(maxY, posArr[i + 1]!);
      minZ = Math.min(minZ, posArr[i + 2]!);
      maxZ = Math.max(maxZ, posArr[i + 2]!);
    }
    zUp = (maxZ - minZ) > (maxY - minY) * 1.5;
    if (zUp) {
      // (x, y, z) → (x, -z, y)，det=+1 纯旋转，绕序与法线方向都保持不变
      // 混元产物脚底在 z-max（+Z 朝下），必须带这个 180° X 翻转才正立；
      // 与 export_labmesh.to_y_up / verify_alignment.py 的归一化保持同一把尺子
      for (let i = 0; i < posArr.length; i += 3) {
        const y = posArr[i + 1]!;
        const z = posArr[i + 2]!;
        posArr[i + 1] = -z;
        posArr[i + 2] = y;
        const ny = norArr[i + 1]!;
        const nz = norArr[i + 2]!;
        norArr[i + 1] = -nz;
        norArr[i + 2] = ny;
      }
    }
  }

  // ---- 规整化：XZ 居中、脚底贴地、统一身高 ----
  const smooth = smoothNormals(posArr, norArr);
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < posArr.length; i += 3) {
    minX = Math.min(minX, posArr[i]!);
    maxX = Math.max(maxX, posArr[i]!);
    minY = Math.min(minY, posArr[i + 1]!);
    maxY = Math.max(maxY, posArr[i + 1]!);
    minZ = Math.min(minZ, posArr[i + 2]!);
    maxZ = Math.max(maxZ, posArr[i + 2]!);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const height = Math.max(1e-5, maxY - minY);
  const s = targetHeight / height;

  // 规整化矩阵 T：v' = s·(R·v − center) = Tc(−s·center) · S(s) · R（v 齐次）。
  // R 为 Z-up→Y-up 旋转（或 I），与上方顶点旋转一致；蒙皮求值端会用它共轭关节矩阵。
  {
    const R = m4.mat4();
    if (zUp) {
      R[0] = 1; R[1] = 0; R[2] = 0; R[3] = 0;
      R[4] = 0; R[5] = 0; R[6] = -1; R[7] = 0;
      R[8] = 0; R[9] = 1; R[10] = 0; R[11] = 0;
      R[12] = 0; R[13] = 0; R[14] = 0; R[15] = 1;
    } else {
      R[0] = 1; R[5] = 1; R[10] = 1; R[15] = 1;
    }
    const S = m4.mat4();
    S[0] = s; S[5] = s; S[10] = s; S[15] = 1;
    const Tc = m4.mat4();
    Tc[0] = 1; Tc[5] = 1; Tc[10] = 1; Tc[15] = 1;
    Tc[12] = -s * cx; Tc[13] = -s * minY; Tc[14] = -s * cz;
    const SR = m4.mat4();
    m4.multiply(SR, S, R);
    m4.multiply(normMat, Tc, SR);
  }

  const verts = new Float32Array(posArr.length + norArr.length + smooth.length + (posArr.length / 3) * 6);
  for (let i = 0; i < base; i++) {
    const o = i * VF;
    verts[o] = (posArr[i * 3]! - cx) * s;
    verts[o + 1] = (posArr[i * 3 + 1]! - minY) * s;
    verts[o + 2] = (posArr[i * 3 + 2]! - cz) * s;
    verts[o + 3] = norArr[i * 3]!;
    verts[o + 4] = norArr[i * 3 + 1]!;
    verts[o + 5] = norArr[i * 3 + 2]!;
    verts[o + 6] = smooth[i * 3]!;
    verts[o + 7] = smooth[i * 3 + 1]!;
    verts[o + 8] = smooth[i * 3 + 2]!;
    verts[o + 9] = uvArr[i * 2]!;
    verts[o + 10] = uvArr[i * 2 + 1]!;
    verts[o + 11] = colArr[i * 4]!;
    verts[o + 12] = colArr[i * 4 + 1]!;
    verts[o + 13] = colArr[i * 4 + 2]!;
    verts[o + 14] = colArr[i * 4 + 3]!;
  }

  // ---- 内嵌 baseColor 图 ----
  // 必须按 material.pbrMetallicRoughness.baseColorTexture -> texture.source 找，
  // 不能取 images[0]：像 E-04 的 glb，images[0] 是法线图、images[1] 才是 baseColor，
  // 直接取第一张会把法线图当 albedo 显示（看起来就是「没贴图」）。
  let image: Blob | null = null;
  let albedoIndex: number | undefined;
  const mat0 = json.materials?.[0];
  const bct = mat0?.pbrMetallicRoughness?.baseColorTexture;
  if (bct?.index !== undefined) {
    albedoIndex = json.textures?.[bct.index]?.source;
  }
  if (albedoIndex === undefined) albedoIndex = 0; // 无材质信息时退回第一张
  const img = albedoIndex !== undefined ? json.images?.[albedoIndex] : undefined;
  if (img !== undefined && img.bufferView !== undefined) {
    const bv = json.bufferViews?.[img.bufferView];
    if (bv !== undefined && bin.byteLength > 0) {
      const start = bv.byteOffset ?? 0;
      const bytes = bin.slice(start, start + (bv.byteLength ?? 0));
      image = new Blob([bytes], { type: img.mimeType ?? 'image/png' });
    }
  }

  const meshName = json.meshes?.find((m) => m.name !== undefined)?.name;

  // ---- 回填显示树：mesh 节点 → 其子网格区间 ----
  // instances 与「DFS 前序收集 mesh 树节点」同序（walk 时先入实例、再递归子节点），一一对应。
  // 一个 primitive 都没解析出来的 mesh 节点（全缺 POSITION）从树上剪掉，层级面板不挂空壳。
  {
    let cursor = 0;
    const fill = (nodes: GltfNodeTree[]): GltfNodeTree[] => {
      const keep: GltfNodeTree[] = [];
      for (const n of nodes) {
        n.children = fill(n.children);
        if (n.subStart === -1) {
          const subs = instSubs[cursor] ?? { start: 0, count: 0 };
          cursor++;
          if (subs.count === 0 && n.children.length === 0) continue; // 空壳，剪掉
          n.subStart = subs.start;
          n.subCount = subs.count;
        }
        keep.push(n);
      }
      return keep;
    };
    graph.tree = fill(graph.tree);
  }

  // ---- 骨骼（skinned mesh 才有）----
  // 关节的世界矩阵用「节点父子链累乘」算（与 glTF 规范一致），inverseBind 也是场景根空间，
  // 与上面烘进顶点的 mesh 节点世界矩阵同空间 → jointMatrix = jointWorld * inverseBind 自洽。
  let skeleton: SkeletonData | null = null;
  {
    const firstSkinInst = instances.find((i) => i.skin !== undefined);
    if (firstSkinInst !== undefined) {
      const sk = json.skins?.[firstSkinInst.skin!];
      if (sk !== undefined && sk.joints.length > 0) {
        const ibm = sk.inverseBindMatrices !== undefined
          ? readFloats(json, bin, 0, json.accessors?.[sk.inverseBindMatrices]!)
          : null;
        const nodeCount = json.nodes?.length ?? 0;
        const parent = new Array<number>(nodeCount).fill(-1);
        const locals: NodeLocal[] = [];
        for (let i = 0; i < nodeCount; i++) {
          const n = json.nodes?.[i];
          locals.push({
            t: (n?.translation as [number, number, number]) ?? [0, 0, 0],
            r: (n?.rotation as [number, number, number, number]) ?? [0, 0, 0, 1],
            s: (n?.scale as [number, number, number]) ?? [1, 1, 1],
          });
          for (const c of n?.children ?? []) if (c >= 0 && c < nodeCount) parent[c] = i;
        }
        const roots: number[] = [];
        for (let i = 0; i < nodeCount; i++) if (parent[i] === -1) roots.push(i);
        skeleton = {
          joints: sk.joints.slice(),
          jointNames: sk.joints.map((j) => json.nodes?.[j]?.name ?? null),
          inverseBind: ibm ?? new Float32Array(sk.joints.length * 16),
          parent,
          locals,
          roots,
          normalization: normMat,
        };
      }
    }
  }

  // ---- 动画（skinned + animated 才有）----
  const animations: AnimClip[] = [];
  for (const a of json.animations ?? []) {
    const tracks: AnimTrack[] = [];
    let duration = 0;
    for (const ch of a.channels) {
      const samp = a.samplers[ch.sampler];
      if (samp === undefined) continue;
      const inAcc = json.accessors?.[samp.input];
      const outAcc = json.accessors?.[samp.output];
      if (inAcc === undefined || outAcc === undefined) continue;
      const times = readFloats(json, bin, 0, inAcc);
      const values = readFloats(json, bin, 0, outAcc);
      if (times === null || values === null) continue;
      const path = ch.target.path;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale') continue;
      const stride = path === 'rotation' ? 4 : 3;
      tracks.push({
        node: ch.target.node,
        path,
        times,
        values,
        stride,
        interpolation: samp.interpolation === 'STEP' ? 'STEP' : 'LINEAR',
      });
      if (times.length > 0) duration = Math.max(duration, times[times.length - 1]!);
    }
    if (tracks.length > 0) {
      animations.push({ name: a.name?.trim() || `clip_${animations.length}`, duration, tracks });
    }
  }

  return {
    mesh: { vertices: verts, indices: idxArr, joints: jointsOut, weights: weightsOut },
    name: meshName ?? img?.name ?? '',
    vertices: base,
    triangles: idxArr.length / 3,
    heightMeters: targetHeight,
    subMeshes,
    nodeTree: graph.tree,
    image,
    skeleton,
    animations,
  };
}
