/** Deterministic authored asphalt assets. No runtime scene construction.
 * Rebuild: node tools/level/bake-road-surfaces.mjs && pnpm run scene:gen
 * A shared metre-scale wear pattern keeps texel density consistent between rooms.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'assets/environment/models/road/synthetic');
fs.mkdirSync(dir, { recursive: true });
const size = 512;
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
const hash = (x, y) => {
  let h = Math.imul(x + 17, 374761393) ^ Math.imul(y + 31, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177); return (h >>> 0) / 4294967295;
};
const pixels = Buffer.alloc((size * 3 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  // Aggregate, faded repair patches and narrow branching fissures; no baked light/shadows.
  const grain = (hash(x, y) - 0.5) * 13;
  const broad = Math.sin(x * Math.PI * 2 / size) * Math.cos(y * Math.PI * 4 / size) * 5;
  const crackA = Math.abs(y - (200 + 23 * Math.sin(x / 37) + 8 * Math.sin(x / 11)));
  const crackB = x > 110 && x < 330 ? Math.abs(y - (x * 0.53 + 85 + 5 * Math.sin(x / 9))) : 99;
  const crack = Math.min(crackA, crackB) < 1.2 ? -30 : 0;
  const patched = x > 325 && x < 460 && y > 50 && y < 175 ? -9 : 0;
  const base = 125 + grain + broad + crack + patched;
  const o = y * (size * 3 + 1) + 1 + x * 3;
  pixels[o] = base - 5; pixels[o + 1] = base; pixels[o + 2] = base + 1;
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);

// Surface dimensions are shared assets, not gameplay rooms. Scene transforms remain authoritative.
for (const [w, d] of [[86,18], [20,16], [14,14], [6,4]]) {
  // The importer grounds GLBs at minY=0. Keep an underside so the top remains .1 m
  // above the scene's room-parent origin (-.1 m), exactly like the former box.
  const positions = new Float32Array([-w/2,.1,-d/2, -w/2,.1,d/2, w/2,.1,d/2, w/2,.1,-d/2,
    -w/2,0,-d/2, -w/2,0,d/2, w/2,0,d/2, w/2,0,-d/2]);
  const normals = new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0]);
  const uv = new Float32Array([0,0, 0,d/8, w/8,d/8, w/8,0, 0,0, 0,d/8, w/8,d/8, w/8,0]);
  const indices = new Uint16Array([0,1,2,0,2,3,4,6,5,4,7,6]);
  const parts = [Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(uv.buffer), Buffer.from(indices.buffer), png];
  let offset = 0;
  const views = parts.map(p => { const v = { buffer: 0, byteOffset: offset, byteLength: p.length }; offset += (p.length + 3) & ~3; return v; });
  const bin = Buffer.alloc(offset); parts.forEach((p, i) => p.copy(bin, views[i].byteOffset));
  const json = { asset: { version: '2.0', generator: 'Aether deterministic asphalt v1' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ name: `asphalt-${w}x${d}`, mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-w/2,0,-d/2], max: [w/2,0.1,d/2] },
      { bufferView: 1, componentType: 5126, count: 8, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 8, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 12, type: 'SCALAR' },
    ], bufferViews: views, buffers: [{ byteLength: bin.length }],
    materials: [{ name: 'weathered-asphalt', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.96 } }],
    textures: [{ sampler: 0, source: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], images: [{ bufferView: 4, mimeType: 'image/png' }],
  };
  const raw = Buffer.from(JSON.stringify(json)); const js = Buffer.alloc((raw.length + 3) & ~3, 32); raw.copy(js);
  const glb = Buffer.alloc(28 + js.length + bin.length);
  glb.writeUInt32LE(0x46546c67); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(js.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); js.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + js.length); glb.writeUInt32LE(0x004e4942, 24 + js.length); bin.copy(glb, 28 + js.length);
  fs.writeFileSync(path.join(dir, `asphalt-${w}x${d}.glb`), glb);
}
console.log('Baked four reusable asphalt surfaces; run scene:gen, then gen-level.');
