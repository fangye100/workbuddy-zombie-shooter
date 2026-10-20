/** Minimal GLB container IO for the offline fracture pipeline (Node tools only).
 * Reader supports the accessor layouts actually produced by this repo's asset chain
 * (FLOAT/USHORT/UINT/UBYTE, non-sparse). Writer generalizes the deterministic
 * container packing already used by tools/level/authored-glb.mjs (multi-mesh,
 * multi-material, optional skin attributes and reused image buffer). */
import { readFileSync } from 'node:fs';

const COMPONENT = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binHeader = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binHeader);
  const bin = buf.subarray(binHeader + 8, binHeader + 8 + binLen);
  return { json, bin };
}

export function readAccessor({ json, bin }, index) {
  const a = json.accessors[index];
  if (!a || a.sparse) throw new Error('unsupported sparse accessor ' + index);
  const view = json.bufferViews[a.bufferView];
  const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const n = a.count * TYPE_N[a.type];
  const bytes = bin.subarray(start, start + n * COMPONENT[a.componentType]);
  switch (a.componentType) {
    case 5126: return new Float32Array(bytes.buffer, bytes.byteOffset, n);
    case 5123: return new Uint16Array(bytes.buffer, bytes.byteOffset, n);
    case 5125: return new Uint32Array(bytes.buffer, bytes.byteOffset, n);
    case 5121: return new Uint8Array(bytes.buffer, bytes.byteOffset, n);
    default: throw new Error('unsupported componentType ' + a.componentType);
  }
}

/** Extracts primitive 0 of a mesh as flat attribute arrays; indices become Uint32. */
export function extractMesh(doc, meshIndex = 0) {
  const prim = doc.json.meshes[meshIndex].primitives[0];
  const at = key => prim.attributes[key] === undefined ? null : readAccessor(doc, prim.attributes[key]);
  return {
    positions: at('POSITION'), normals: at('NORMAL'), uvs: at('TEXCOORD_0'),
    joints: at('JOINTS_0'), weights: at('WEIGHTS_0'),
    indices: new Uint32Array(readAccessor(doc, prim.indices)),
  };
}

export function nodeTransform(node) {
  return {
    translation: node.translation ?? [0, 0, 0],
    rotation: node.rotation ?? [0, 0, 0, 1],
    scale: node.scale ?? [1, 1, 1],
  };
}

/** Exact-welds vertices by quantized position (UV/normal seams keep their first
 * attributes). The fracture CSG kernel requires identical positions to merge. */
export function weldByPosition(mesh, scale = 1e5) {
  const keyOf = v => Math.round(mesh.positions[v * 3] * scale) + ',' + Math.round(mesh.positions[v * 3 + 1] * scale) + ',' + Math.round(mesh.positions[v * 3 + 2] * scale);
  const map = new Map();
  const positions = [], normals = [], uvs = [], joints = [], weights = [];
  const remap = new Array(mesh.positions.length / 3);
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const key = keyOf(v);
    if (map.has(key)) { remap[v] = map.get(key); continue; }
    const index = positions.length / 3;
    map.set(key, index);
    remap[v] = index;
    for (let k = 0; k < 3; k++) { positions.push(mesh.positions[v * 3 + k]); normals.push(mesh.normals[v * 3 + k]); }
    for (let k = 0; k < 2; k++) uvs.push(mesh.uvs[v * 2 + k]);
    if (mesh.joints) for (let k = 0; k < 4; k++) joints.push(mesh.joints[v * 4 + k]);
    if (mesh.weights) for (let k = 0; k < 4; k++) weights.push(mesh.weights[v * 4 + k]);
  }
  return {
    positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs),
    joints: mesh.joints ? new Uint16Array(joints) : null, weights: mesh.weights ? new Float32Array(weights) : null,
    indices: new Uint32Array(Array.from(mesh.indices, i => remap[i])),
  };
}

// ---------------------------------------------------------------- writer

export class GlbBuilder {
  constructor(generator) {
    this.generator = generator;
    this.parts = [];
    this.views = [];
    this.offset = 0;
    this.accessors = [];
  }

  view(bytes) {
    const view = { buffer: 0, byteOffset: this.offset, byteLength: bytes.length };
    this.offset += (bytes.length + 3) & ~3;
    this.parts.push(bytes);
    this.views.push(view);
    return this.views.length - 1;
  }

  #accessor(view, componentType, count, type, extra = {}) {
    const accessor = { bufferView: view, componentType, count, type, ...extra };
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  vec3Float(values) {
    const bytes = Buffer.from(new Float32Array(values).buffer);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < values.length; i++) { const k = i % 3; min[k] = Math.min(min[k], values[i]); max[k] = Math.max(max[k], values[i]); }
    return this.#accessor(this.view(bytes), 5126, values.length / 3, 'VEC3', { min, max });
  }

  vec2Float(values) { return this.#accessor(this.view(Buffer.from(new Float32Array(values).buffer)), 5126, values.length / 2, 'VEC2'); }
  vec4Float(values) { return this.#accessor(this.view(Buffer.from(new Float32Array(values).buffer)), 5126, values.length / 4, 'VEC4'); }
  vec4UShort(values) { return this.#accessor(this.view(Buffer.from(new Uint16Array(values).buffer)), 5123, values.length / 4, 'VEC4'); }
  scalarUint(values) { return this.#accessor(this.view(Buffer.from(new Uint32Array(values).buffer)), 5125, values.length, 'SCALAR'); }
  rawBytes(bytes) { return this.view(bytes); }

  build({ nodes, meshes, materials, textures, images, skins, sceneNodes }) {
    const json = {
      asset: { version: '2.0', generator: this.generator },
      scene: 0, scenes: [{ nodes: sceneNodes }], nodes,
      meshes, accessors: this.accessors, bufferViews: this.views,
      buffers: [{ byteLength: this.offset }],
      materials, ...(textures ? { textures } : {}), ...(images ? { images } : {}), ...(skins ? { skins } : {}),
    };
    const raw = Buffer.from(JSON.stringify(json));
    const js = Buffer.alloc((raw.length + 3) & ~3, 32); raw.copy(js);
    const bin = Buffer.alloc(this.offset);
    this.parts.forEach((bytes, i) => bytes.copy(bin, this.views[i].byteOffset));
    const glb = Buffer.alloc(28 + js.length + bin.length);
    glb.writeUInt32LE(0x46546c67); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(js.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); js.copy(glb, 20);
    glb.writeUInt32LE(bin.length, 20 + js.length); glb.writeUInt32LE(0x004e4942, 24 + js.length); bin.copy(glb, 28 + js.length);
    return glb;
  }
}
