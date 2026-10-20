#!/usr/bin/env node
/** WU-02 offline fracture asset builder (formal P-01 barrel + E-04 Bulwark).
 * Deterministic chunkIds, planar rectangle caps for axis-aligned cuts, bone-region
 * partition with preserved skin weights and weighted fan caps for the NPC.
 * Inputs/parameters/digests are printed as a rebuildable recipe (see the WU-02 guide). */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readGlb, extractMesh, GlbBuilder, weldByPosition } from './glb-io.mjs';
import { VertexPool, splitByPlanes, buildChunkWithPlanarCaps, buildChunkWithFanCaps, chunkStats } from './split-core.mjs';
import ManifoldModule from 'manifold-3d';

let manifoldRuntime = null;
async function manifold() {
  if (!manifoldRuntime) {
    const module = await ManifoldModule();
    module.setup();
    manifoldRuntime = module;
  }
  return manifoldRuntime;
}

const NL = String.fromCharCode(10);
const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const guidFor = seed => 'as_' + sha256Hex(seed).slice(0, 8);
const identityBind = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const writeText = (file, text) => writeFileSync(file, text + NL);

function writeSidecar(absPath, kind, guid) {
  const bytes = readFileSync(absPath);
  const meta = {
    schemaVersion: 1, guid, kind,
    importer: { normalizeHeightM: null, weldTolerance: 0.0001, upAxisFlip: false, aoBakeFloor: null, splitSubMeshes: true, maxSubMeshes: 8 },
    bindings: [], rig: null, animations: null, userData: { builtBy: 'tools/fracture/build-fracture-assets.mjs' },
    sourceHash: 'sha256:' + sha256Hex(bytes), updatedAt: new Date().toISOString(),
  };
  writeText(absPath + '.meta.json', JSON.stringify(meta, null, 2));
}

/** Compacts a chunk into typed arrays for GLB writing, split into outer/cap primitives. */
function packChunk(chunk) {
  const used = new Map();
  const remap = i => { if (!used.has(i)) used.set(i, used.size); return used.get(i); };
  const outer = chunk.triangles.slice(0, chunk.outerTriangles).map(t => t.map(remap));
  const caps = chunk.triangles.slice(chunk.outerTriangles).map(t => t.map(remap));
  const n = used.size, L = chunk.local;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
  const skinned = L.weights.length > 0;
  const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
  for (const [src, dst] of used) {
    for (let k = 0; k < 3; k++) { positions[dst * 3 + k] = L.positions[src * 3 + k]; normals[dst * 3 + k] = L.normals[src * 3 + k]; }
    for (let k = 0; k < 2; k++) uvs[dst * 2 + k] = L.uvs[src * 2 + k];
    if (skinned) for (let k = 0; k < 4; k++) { joints[dst * 4 + k] = L.joints[src * 4 + k] ?? 0; weights[dst * 4 + k] = L.weights[src * 4 + k] ?? 0; }
  }
  return { positions, normals, uvs, joints: skinned ? joints : null, weights: skinned ? weights : null, outer, caps };
}

function writeChunkGlb(file, generator, chunks, image, skeleton) {
  const builder = new GlbBuilder(generator);
  const materials = [
    { name: 'outer', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.1, roughnessFactor: 0.75 } },
    { name: 'inner', pbrMetallicRoughness: { baseColorFactor: [0.09, 0.062, 0.055, 1], metallicFactor: 0.05, roughnessFactor: 0.9 } },
  ];
  const meshList = [];
  for (const chunk of chunks) {
    const p = packChunk(chunk);
    const pos = builder.vec3Float(p.positions), nrm = builder.vec3Float(p.normals), uv = builder.vec2Float(p.uvs);
    const jnt = p.joints ? builder.vec4UShort(p.joints) : null, wgt = p.weights ? builder.vec4Float(p.weights) : null;
    const attrs = { POSITION: pos, NORMAL: nrm, TEXCOORD_0: uv, ...(jnt !== null ? { JOINTS_0: jnt, WEIGHTS_0: wgt } : {}) };
    const prims = [];
    if (p.outer.length) prims.push({ attributes: attrs, indices: builder.scalarUint(p.outer.flat()), material: 0 });
    if (p.caps.length) prims.push({ attributes: attrs, indices: builder.scalarUint(p.caps.flat()), material: 1 });
    meshList.push({ name: chunk.key, primitives: prims });
  }
  const imageView = image ? builder.rawBytes(image.bytes) : null;
  const nodes = [];
  const sceneNodes = [];
  if (skeleton) {
    for (const node of skeleton.nodes) nodes.push(node);
    for (const root of skeleton.roots) sceneNodes.push(root);
  }
  chunks.forEach((chunk, i) => {
    nodes.push({ name: chunk.key, mesh: i, ...(skeleton ? { skin: 0 } : {}) });
    sceneNodes.push(nodes.length - 1);
  });
  const glb = builder.build({
    nodes, meshes: meshList, materials,
    ...(imageView !== null ? { images: [{ name: image.name, bufferView: imageView, mimeType: image.mimeType }], textures: [{ source: 0 }] } : {}),
    ...(skeleton ? { skins: [{ name: skeleton.name, joints: skeleton.joints }] } : {}),
    sceneNodes,
  });
  writeFileSync(file, glb);
  return glb.length;
}

function sourceImage(doc) {
  const image = doc.json.images?.[0];
  if (!image) return null;
  const view = doc.json.bufferViews[image.bufferView];
  return { name: image.name ?? 'baseColor', mimeType: image.mimeType ?? 'image/jpeg', bytes: Buffer.from(doc.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)) };
}

// ---------------------------------------------------------------- P-01 barrel

export async function buildBarrel(sourcePath, outDir) {
  const doc = readGlb(sourcePath);
  const mesh = weldByPosition(extractMesh(doc));
  const { Manifold, Mesh } = await manifold();
  const solid = new Manifold(new Mesh({ numProp: 3, vertProperties: new Float32Array(mesh.positions), triVerts: new Uint32Array(mesh.indices), tolerance: 1e-9 }));
  if (solid.status() !== 'NoError') throw new Error('source mesh not manifold: ' + solid.status());
  const pool = new VertexPool();
  const sourceTris = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    sourceTris.push([mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]].map(v => pool.add(mesh.positions.subarray(v * 3, v * 3 + 3), mesh.normals.subarray(v * 3, v * 3 + 3), mesh.uvs.subarray(v * 2, v * 2 + 2))));
  }
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], mesh.positions[i + k]); max[k] = Math.max(max[k], mesh.positions[i + k]); }
  const planes = [
    { normal: [0, 1, 0], d: min[1] + (max[1] - min[1]) / 3 },
    { normal: [0, 1, 0], d: min[1] + 2 * (max[1] - min[1]) / 3 },
    { normal: [1, 0, 0], d: (min[0] + max[0]) / 2 },
    { normal: [0, 0, 1], d: (min[2] + max[2]) / 2 },
  ];
  // 12 cells = 3 bands × 4 quadrants, cut by robust CSG intersection.
  const bands = [[min[1], planes[0].d], [planes[0].d, planes[1].d], [planes[1].d, max[1]]];
  const quadrants = [[planes[2].d, max[0], planes[3].d, max[2]], [min[0], planes[2].d, planes[3].d, max[2]], [min[0], planes[2].d, min[2], planes[3].d], [planes[2].d, max[0], min[2], planes[3].d]];
  const cutAxes = [planes[0], planes[1], planes[2], planes[3]];
  const onCutPlane = (p, tol = 1e-5) => cutAxes.some(plane => Math.abs(p[0] * plane.normal[0] + p[1] * plane.normal[1] + p[2] * plane.normal[2] - plane.d) <= tol);
  // Source triangle locator for outer attribute recovery (barycentric UV/normal).
  const sourceTrisData = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const idx = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    const p = idx.map(v => [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]);
    sourceTrisData.push({ idx, p, centroid: [(p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3, (p[0][2] + p[1][2] + p[2][2]) / 3] });
  }
  const grid = new Map();
  const cellOf = (p) => Math.floor(p[0] / 0.05) + ',' + Math.floor(p[1] / 0.05) + ',' + Math.floor(p[2] / 0.05);
  for (const tri of sourceTrisData) {
    const k = cellOf(tri.centroid);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(tri);
  }
  const barycentric = (tri, point) => {
    const [a, b, c] = tri.p;
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const ap = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
    const d00 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2];
    const d01 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
    const d11 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
    const d20 = ap[0] * e1[0] + ap[1] * e1[1] + ap[2] * e1[2];
    const d21 = ap[0] * e2[0] + ap[1] * e2[1] + ap[2] * e2[2];
    const den = d00 * d11 - d01 * d01;
    if (!(Math.abs(den) > 1e-14)) return null;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
    if (v < -0.002 || w < -0.002 || v + w > 1.002) return null;
    return [1 - v - w, v, w];
  };
  const locate = point => {
    for (let r = 1; r <= 4; r++) {
      const cx = Math.floor(point[0] / 0.05), cy = Math.floor(point[1] / 0.05), cz = Math.floor(point[2] / 0.05);
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        const bucket = grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
        if (!bucket) continue;
        for (const tri of bucket) {
          const bary = barycentric(tri, point);
          if (bary) return { tri, bary };
        }
      }
    }
    return null;
  };
  const chunks = [];
  let cellIndex = 0;
  for (const [y0, y1] of bands) {
    for (const [x0, x1, z0, z1] of quadrants) {
      const size = [x1 - x0, y1 - y0, z1 - z0];
      const center = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
      const box = Manifold.cube(size, true).translate(center);
      const piece = solid.intersect(box);
      if (piece.status() !== 'NoError') throw new Error('cell ' + cellIndex + ' CSG failed: ' + piece.status());
      const out = piece.getMesh();
      const positions = out.vertProperties;
      const indices = out.triVerts;
      const local = new VertexPool();
      const vertexInfo = [];
      for (let v = 0; v < positions.length / 3; v++) {
        const p = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
        const hit = locate(p);
        let n, uv;
        if (hit) {
          const { tri, bary } = hit;
          n = [0, 0, 0]; uv = [0, 0];
          for (let k = 0; k < 3; k++) {
            const vi = tri.idx[k], w = bary[k];
            for (let c = 0; c < 3; c++) n[c] += mesh.normals[vi * 3 + c] * w;
            for (let c = 0; c < 2; c++) uv[c] += mesh.uvs[vi * 2 + c] * w;
          }
          const len = Math.hypot(...n) || 1;
          n = n.map(vv => vv / len);
        } else {
          n = [0, 1, 0];
          uv = [p[0], p[2]];
        }
        vertexInfo.push({ outer: !!hit, onPlane: onCutPlane(p) });
        local.add(p, n, uv);
      }
      const outer = [], caps = [];
      for (let t = 0; t < indices.length; t += 3) {
        const tri = [indices[t], indices[t + 1], indices[t + 2]];
        const isCap = tri.every(v => vertexInfo[v].onPlane);
        (isCap ? caps : outer).push(tri);
      }
      const key = 'chunk-' + String(++cellIndex).padStart(4, '0');
      chunks.push({ key, local, triangles: [...outer, ...caps], outerTriangles: outer.length, capTriangles: caps.length });
    }
  }
  const image = sourceImage(doc);
  mkdirSync(outDir, { recursive: true });
  const glbFile = path.join(outDir, 'p01-barrel-chunks.glb');
  const bytes = writeChunkGlb(glbFile, 'aether fracture offline v1 (P-01 planar cuts)', chunks, image, null);
  const guid = guidFor('p01-barrel-chunks');
  writeSidecar(glbFile, 'gltf', guid);
  const stats = chunks.map(c => chunkStats(c.local, c.triangles));
  const totalVolume = stats.reduce((acc, s) => acc + s.volume, 0);
  const densityKgPerM3 = 18 / totalVolume; // ~18 kg empty 55-gallon steel barrel
  const sourceGuid = JSON.parse(readFileSync('assets/environment/models/P-01/tex2/P-01_baked.glb.meta.json', 'utf8')).guid;
  const fracture = {
    version: 1, id: 'as_p01frct', name: '油桶 P-01 碎裂', status: 'accepted', kind: 'object',
    source: { model: { path: 'assets/environment/models/P-01/tex2/P-01_baked.glb', guid: sourceGuid }, origin: 'P0 正式环境资产（TokenHub 混元 3D 产物，Git LFS，LOD1 tex2 烘焙版）' },
    assemblyScale: 1,
    chunks: chunks.map((c, i) => ({
      chunkId: c.key, class: 'large',
      mesh: { path: 'assets/fracture/p01-barrel/p01-barrel-chunks.glb', guid, sub: 'node:' + c.key },
      bind: identityBind, pivot: stats[i].centroid.map(v => +v.toFixed(6)),
      proxy: { shape: { type: 'box', halfExtents: [0, 1, 2].map(k => +((stats[i].aabb.max[k] - stats[i].aabb.min[k]) / 2).toFixed(4)) }, mass: +(stats[i].volume * densityKgPerM3).toFixed(3), friction: 0.6, restitution: 0.35, collisionGroup: 'environment' },
    })),
    npc: null,
    playback: { priority: 2, lifetimeSec: 4, fadeSec: 0.8, companionVfx: null },
  };
  writeText(path.join(outDir, 'p01-barrel.fracture.json'), JSON.stringify(fracture, null, 2));
  return { chunks: chunks.length, bytes, planes, densityKgPerM3: +densityKgPerM3.toFixed(3), totalVolume: +totalVolume.toFixed(6), chunkTriangles: stats.map(s => s.triangles) };
}

// ---------------------------------------------------------------- E-04 actor

const REGIONS = {
  head: ['Neck', 'Head'], torso: ['Hips', 'Spine', 'Spine1', 'Spine2'],
  'arm-l-upper': ['LeftShoulder', 'LeftArm'], 'arm-l-forearm': ['LeftForeArm', 'LeftHand'],
  'arm-r-upper': ['RightShoulder', 'RightArm'], 'arm-r-forearm': ['RightForeArm', 'RightHand'],
  'leg-l-thigh': ['LeftUpLeg'], 'leg-l-shin': ['LeftLeg', 'LeftFoot', 'LeftToeBase'],
  'leg-r-thigh': ['RightUpLeg'], 'leg-r-shin': ['RightLeg', 'RightFoot', 'RightToeBase'],
};
const PRIMARY_BONE = {
  head: 'Head', torso: 'Spine1', 'arm-l-upper': 'LeftArm', 'arm-l-forearm': 'LeftForeArm',
  'arm-r-upper': 'RightArm', 'arm-r-forearm': 'RightForeArm', 'leg-l-thigh': 'LeftUpLeg',
  'leg-l-shin': 'LeftLeg', 'leg-r-thigh': 'RightUpLeg', 'leg-r-shin': 'RightLeg',
};

export function buildActor(sourcePath, outDir) {
  const doc = readGlb(sourcePath);
  const mesh = weldByPosition(extractMesh(doc));
  const skin = doc.json.skins[0];
  const jointNames = skin.joints.map(j => doc.json.nodes[j].name);
  const jointRegion = new Map();
  for (const [region, names] of Object.entries(REGIONS)) for (const n of names) jointRegion.set(n, region);
  for (const name of jointNames) if (!jointRegion.has(name)) throw new Error('unmapped joint: ' + name);
  const pool = new VertexPool();
  const addVertex = v => pool.add(mesh.positions.subarray(v * 3, v * 3 + 3), mesh.normals.subarray(v * 3, v * 3 + 3), mesh.uvs.subarray(v * 2, v * 2 + 2), Array.from(mesh.joints.subarray(v * 4, v * 4 + 4)), Array.from(mesh.weights.subarray(v * 4, v * 4 + 4)));
  const regionOfVertex = v => {
    let best = 0, region = null;
    for (let k = 0; k < 4; k++) {
      const w = mesh.weights[v * 4 + k];
      if (w > best) { best = w; region = jointRegion.get(jointNames[mesh.joints[v * 4 + k]]); }
    }
    return region ?? 'torso';
  };
  const byRegion = new Map(Object.keys(REGIONS).map(r => [r, []]));
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const vs = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    const tally = new Map();
    for (const v of vs) { const r = regionOfVertex(v); tally.set(r, (tally.get(r) ?? 0) + 1); }
    const region = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    byRegion.get(region).push(vs.map(addVertex));
  }
  const chunks = Object.keys(REGIONS).map(key => buildChunkWithFanCaps(pool, byRegion.get(key), key));
  const image = sourceImage(doc);
  mkdirSync(outDir, { recursive: true });
  const glbFile = path.join(outDir, 'e04-bulwark-chunks.glb');
  const nameToNew = new Map();
  const skeletonNodes = doc.json.nodes.map(n => ({ name: n.name, children: n.children, translation: n.translation, rotation: n.rotation, scale: n.scale }));
  skeletonNodes.forEach((n, i) => nameToNew.set(n.name, i));
  const skeleton = {
    nodes: skeletonNodes, roots: doc.json.scenes[0].nodes.filter(n => doc.json.nodes[n].name !== 'E04_Bulwark'),
    joints: skin.joints.map((j, i) => nameToNew.get(jointNames[i])), name: skin.name ?? 'HumanIK',
  };
  const bytes = writeChunkGlb(glbFile, 'aether fracture offline v1 (E-04 bone regions)', chunks, image, skeleton);
  const guid = guidFor('e04-bulwark-chunks');
  writeSidecar(glbFile, 'gltf', guid);
  const stats = chunks.map(c => chunkStats(c.local, c.triangles));
  const totalVolume = stats.reduce((acc, s) => acc + s.volume, 0);
  const densityKgPerM3 = 80 / totalVolume; // ~80 kg enemy
  const sourceGuid = JSON.parse(readFileSync('assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb.meta.json', 'utf8')).guid;
  const fracture = {
    version: 1, id: 'as_e04frct', name: '盾卫 E-04 致死碎裂', status: 'accepted', kind: 'npc',
    source: { model: { path: 'assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb', guid: sourceGuid }, origin: '正式 rigged NPC（E-04 盾卫，Git LFS，HumanIK 蒙皮，6 个动画含 death）' },
    assemblyScale: 1,
    chunks: chunks.map((c, i) => ({
      chunkId: c.key, class: stats[i].volume * densityKgPerM3 > 8 ? 'large' : 'small',
      mesh: { path: 'assets/fracture/e04-bulwark/e04-bulwark-chunks.glb', guid, sub: 'node:' + c.key },
      bind: identityBind, pivot: stats[i].centroid.map(v => +v.toFixed(6)),
      proxy: { shape: { type: 'box', halfExtents: [0, 1, 2].map(k => +((stats[i].aabb.max[k] - stats[i].aabb.min[k]) / 2).toFixed(4)) }, mass: +(stats[i].volume * densityKgPerM3).toFixed(3), friction: 0.7, restitution: 0.2, collisionGroup: 'debris' },
    })),
    npc: { actorId: 'E-04', mode: 'skinned', boneMap: { ...PRIMARY_BONE }, normalizeHeightM: 2.05, footOffsetM: 0 },
    playback: { priority: 2, lifetimeSec: 5, fadeSec: 1, companionVfx: null },
  };
  writeText(path.join(outDir, 'e04-bulwark.fracture.json'), JSON.stringify(fracture, null, 2));
  return { chunks: chunks.length, bytes, regions: Object.fromEntries(chunks.map((c, i) => [c.key, stats[i].triangles])), densityKgPerM3: +densityKgPerM3.toFixed(3), totalVolume: +totalVolume.toFixed(6) };
}

const invoked = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invoked) {
  const recipe = {
    barrel: buildBarrel('assets/environment/models/P-01/tex2/P-01_baked.glb', 'assets/fracture/p01-barrel'),
    actor: buildActor('assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb', 'assets/fracture/e04-bulwark'),
  };
  console.log(JSON.stringify(recipe, null, 1));
}
