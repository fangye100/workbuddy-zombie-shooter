#!/usr/bin/env node
/** WU-02 fix: offline fracture asset builder (formal P-01 barrel + E-04 Bulwark).
 * Barrel chunks come from manifold-3d CSG with UV/normals carried as per-vertex
 * properties (seams preserved through booleans). NPC chunks partition by dominant
 * bone with corner-exact attributes, dedicated flat cut-face normals, and the
 * source skeleton contract (joint order + inverse bind matrices) fully copied.
 * Every chunk is written as its own loader-compatible GLB; sidecars merge-preserve
 * author fields. Deterministic chunkIds and digests. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ManifoldModule from 'manifold-3d';
import { readGlb, extractMesh, readSkin, GlbBuilder } from './glb-io.mjs';
import { VertexPool, buildChunkWithCaps, chunkStats, triangleNormal, dot } from './split-core.mjs';

const NL = String.fromCharCode(10);
const sha256Hex = bytes => createHash('sha256').digest ? createHash('sha256').update(bytes).digest('hex') : createHash('sha256').update(bytes).digest('hex');
const guidFor = seed => 'as_' + createHash('sha256').update(seed).digest('hex').slice(0, 8);
const identityBind = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const writeText = (file, text) => writeFileSync(file, text + NL);

/** Merge-preserving sidecar: author fields survive rebuilds; only the source
 * digest and build record update; identity mismatch is an explicit error. */
export function writeSidecar(absPath, kind, guid, buildRecord) {
  const bytes = readFileSync(absPath);
  const metaPath = absPath + '.meta.json';
  let meta;
  if (existsSync(metaPath)) {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (meta.guid !== guid) throw new Error('sidecar 身份冲突：' + metaPath + '（' + meta.guid + ' ≠ ' + guid + '），拒绝静默改写');
  } else {
    meta = {
      schemaVersion: 1, guid, kind,
      importer: { normalizeHeightM: null, weldTolerance: 0.0001, upAxisFlip: false, aoBakeFloor: null, splitSubMeshes: true, maxSubMeshes: 8 },
      bindings: [], rig: null, animations: null, userData: {},
    };
  }
  meta.sourceHash = 'sha256:' + sha256Hex(bytes);
  meta.updatedAt = new Date().toISOString();
  meta.userData = { ...(meta.userData ?? {}) };
  if (meta.userData.builtBy !== undefined || !meta.userData.reviewAuthor) meta.userData.builtBy = 'tools/fracture/build-fracture-assets.mjs';
  meta.userData.fractureBuild = buildRecord;
  writeText(metaPath, JSON.stringify(meta, null, 2));
}

function sourceImage(doc) {
  const image = doc.json.images?.[0];
  if (!image) return null;
  const view = doc.json.bufferViews[image.bufferView];
  return { name: image.name ?? 'baseColor', mimeType: image.mimeType ?? 'image/jpeg', bytes: Buffer.from(doc.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)) };
}

function writeSingleMeshGlb(file, generator, name, packed, image, skeleton) {
  const builder = new GlbBuilder(generator);
  const materials = [
    { name: 'outer', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.1, roughnessFactor: 0.75 } },
    { name: 'inner', pbrMetallicRoughness: { baseColorFactor: [0.09, 0.062, 0.055, 1], metallicFactor: 0.05, roughnessFactor: 0.9 } },
  ];
  const pos = builder.vec3Float(packed.positions), nrm = builder.vec3Float(packed.normals), uv = builder.vec2Float(packed.uvs);
  const jnt = packed.joints ? builder.vec4UShort(packed.joints) : null;
  const wgt = packed.weights ? builder.vec4Float(packed.weights) : null;
  const attrs = { POSITION: pos, NORMAL: nrm, TEXCOORD_0: uv, ...(jnt !== null ? { JOINTS_0: jnt, WEIGHTS_0: wgt } : {}) };
  const prims = [];
  if (packed.outer.length) prims.push({ attributes: attrs, indices: builder.scalarUint(packed.outer.flat()), material: 0 });
  if (packed.caps.length) prims.push({ attributes: attrs, indices: builder.scalarUint(packed.caps.flat()), material: 1 });
  const imageView = image ? builder.rawBytes(image.bytes) : null;
  const nodes = [];
  const sceneNodes = [];
  if (skeleton) {
    for (const node of skeleton.nodes) nodes.push(node);
    for (const root of skeleton.roots) sceneNodes.push(root);
  }
  nodes.push({ name, mesh: 0, ...(skeleton ? { skin: 0 } : {}) });
  sceneNodes.push(nodes.length - 1);
  const skin = skeleton ? { name: skeleton.name, joints: [...skeleton.joints], inverseBindMatrices: builder.mat4Float(skeleton.ibm) } : null;
  const glb = builder.build({
    nodes, meshes: [{ name, primitives: prims }], materials,
    ...(imageView !== null ? { images: [{ name: image.name, bufferView: imageView, mimeType: image.mimeType }], textures: [{ source: 0 }] } : {}),
    ...(skin ? { skins: [skin] } : {}),
    sceneNodes,
  });
  writeFileSync(file, glb);
  return glb.length;
}

function packPart(pool, triangles) {
  const used = new Map();
  const remap = i => { if (!used.has(i)) used.set(i, used.size); return used.get(i); };
  const mapped = triangles.map(t => t.map(remap));
  const n = used.size;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
  const skinned = pool.weights.length > 0;
  const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
  for (const [src, dst] of used) {
    for (let k = 0; k < 3; k++) { positions[dst * 3 + k] = pool.positions[src * 3 + k]; normals[dst * 3 + k] = pool.normals[src * 3 + k]; }
    const len = Math.hypot(normals[dst * 3], normals[dst * 3 + 1], normals[dst * 3 + 2]);
    if (Math.abs(len - 1) > 0.01 && len > 0.5) for (let k = 0; k < 3; k++) normals[dst * 3 + k] /= len; // fix gross CSG blends only; source-exact corners stay untouched
    for (let k = 0; k < 2; k++) uvs[dst * 2 + k] = pool.uvs[src * 2 + k];
    if (skinned) for (let k = 0; k < 4; k++) { joints[dst * 4 + k] = pool.joints[src * 4 + k] ?? 0; weights[dst * 4 + k] = pool.weights[src * 4 + k] ?? 0; }
  }
  return { positions, normals, uvs, joints: skinned ? joints : null, weights: skinned ? weights : null, triangles: mapped };
}

let manifoldRuntime = null;
async function manifold() {
  if (!manifoldRuntime) {
    const module = await ManifoldModule();
    module.setup();
    manifoldRuntime = module;
  }
  return manifoldRuntime;
}

// ---------------------------------------------------------------- P-01 barrel

export async function buildBarrel(sourcePath, outDir) {
  const { Manifold, Mesh } = await manifold();
  const doc = readGlb(sourcePath);
  const mesh = extractMesh(doc);
  // Carry UV + normal as per-vertex properties through the booleans: Manifold
  // preserves property boundaries (seam-duplicated verts) and interpolates on cuts.
  const numProp = 8;
  const vertProperties = new Float32Array((mesh.positions.length / 3) * numProp);
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    for (let k = 0; k < 3; k++) vertProperties[v * numProp + k] = mesh.positions[v * 3 + k];
    for (let k = 0; k < 2; k++) vertProperties[v * numProp + 3 + k] = mesh.uvs[v * 2 + k];
    for (let k = 0; k < 3; k++) vertProperties[v * numProp + 5 + k] = mesh.normals[v * 3 + k];
  }
  // Seam-duplicated corners keep their properties; merge vectors declare the
  // topology identity so Manifold accepts the input and preserves boundaries.
  const canonical = new Map();
  const mergeFromVert = [], mergeToVert = [];
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const q = k => Math.round(mesh.positions[v * 3 + k] * 1e5);
    const key = q(0) + ',' + q(1) + ',' + q(2);
    if (!canonical.has(key)) canonical.set(key, v);
    else if (canonical.get(key) !== v) { mergeFromVert.push(v); mergeToVert.push(canonical.get(key)); }
  }
  const solid = new Manifold(new Mesh({ numProp, vertProperties, triVerts: new Uint32Array(mesh.indices), mergeFromVert: new Uint32Array(mergeFromVert), mergeToVert: new Uint32Array(mergeToVert) }));
  if (solid.status() !== 'NoError') throw new Error('barrel source not manifold: ' + solid.status());
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], mesh.positions[i + k]); max[k] = Math.max(max[k], mesh.positions[i + k]); }
  const planes = [
    { normal: [0, 1, 0], d: min[1] + (max[1] - min[1]) / 3 },
    { normal: [0, 1, 0], d: min[1] + 2 * (max[1] - min[1]) / 3 },
    { normal: [1, 0, 0], d: (min[0] + max[0]) / 2 },
    { normal: [0, 0, 1], d: (min[2] + max[2]) / 2 },
  ];
  const bands = [[min[1], planes[0].d], [planes[0].d, planes[1].d], [planes[1].d, max[1]]];
  const quadrants = [
    [planes[2].d, max[0], planes[3].d, max[2]], [min[0], planes[2].d, planes[3].d, max[2]],
    [min[0], planes[2].d, min[2], planes[3].d], [planes[2].d, max[0], min[2], planes[3].d],
  ];
  const onPlane = (p, tol = 1e-5) => planes.find(pl => Math.abs(dot(p, pl.normal) - pl.d) <= tol);
  const image = sourceImage(doc);
  mkdirSync(outDir, { recursive: true });
  const chunks = [];
  let cellIndex = 0;
  for (const [y0, y1] of bands) {
    for (const [x0, x1, z0, z1] of quadrants) {
      const piece = solid.intersect(Manifold.cube([x1 - x0, y1 - y0, z1 - z0], true).translate([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
      if (piece.status() !== 'NoError') throw new Error('cell ' + cellIndex + ' CSG failed: ' + piece.status());
      const out = piece.getMesh();
      const local = new VertexPool();
      const verts = [];
      for (let v = 0; v < out.vertProperties.length / numProp; v++) {
        const vp = out.vertProperties;
        verts.push(local.add([vp[v * numProp], vp[v * numProp + 1], vp[v * numProp + 2]], [vp[v * numProp + 5], vp[v * numProp + 6], vp[v * numProp + 7]], [vp[v * numProp + 3], vp[v * numProp + 4]]));
      }
      const outer = [], caps = [];
      const capCopy = new Map();
      const capVertex = (v, planeTag) => {
        const p = local.p(v);
        const k = p.map(x => Math.round(x * 1e6)).join(',') + '@' + planeTag;
        if (capCopy.has(k)) return capCopy.get(k);
        const index = local.add(p, [0, 1, 0], [p[0], p[2]]);
        capCopy.set(k, index);
        return index;
      };
      for (let t = 0; t < out.triVerts.length; t += 3) {
        const tri = [out.triVerts[t], out.triVerts[t + 1], out.triVerts[t + 2]];
        const ps = tri.map(v => local.p(v));
        const perVert = tri.map(v => planes.filter(pl => Math.abs(dot(local.p(v), pl.normal) - pl.d) <= 1e-5));
        const common = perVert[0].filter(pl => perVert.every(list => list.includes(pl)));
        const isCap = common.length >= 1 && Math.abs(dot(triangleNormal(...ps), common[0].normal)) > 0.99;
        if (!isCap) { outer.push(tri); continue; }
        const n = dot(triangleNormal(...ps), common[0].normal) >= 0 ? common[0].normal : common[0].normal.map(v => -v);
        const planeTag = planes.indexOf(common[0]);
        const copies = tri.map(v => capVertex(v, planeTag));
        for (const c of copies) { local.normals[c * 3] = n[0]; local.normals[c * 3 + 1] = n[1]; local.normals[c * 3 + 2] = n[2]; }
        caps.push(copies);
      }
      const key = 'chunk-' + String(++cellIndex).padStart(4, '0');
      const file = path.join(outDir, key + '.glb');
      const packed = { ...packPart(local, [...outer, ...caps]), outer: outer.map(t => t), caps };
      // packPart remaps jointly; split outer/caps by count for primitives.
      const bytes = writeSingleMeshGlb(file, 'aether fracture offline v2 (P-01 CSG)', key,
        { ...packed, outer: packed.triangles.slice(0, outer.length), caps: packed.triangles.slice(outer.length) }, image, null);
      const guid = guidFor('p01/' + key);
      writeSidecar(file, 'gltf', guid, { chunk: key, builtAt: new Date().toISOString() });
      chunks.push({ key, file, bytes, local, triangles: [...outer, ...caps.map(c => c)], outerTriangles: outer.length, capTriangles: caps.length });
    }
  }
  const stats = chunks.map(c => chunkStats(c.local, c.triangles));
  const totalVolume = stats.reduce((acc, s) => acc + Math.abs(s.volume), 0);
  const densityKgPerM3 = 18 / totalVolume;
  const sourceGuid = JSON.parse(readFileSync('assets/environment/models/P-01/tex2/P-01_baked.glb.meta.json', 'utf8')).guid;
  const fracture = {
    version: 1, id: 'as_p01frct', name: '油桶 P-01 碎裂', status: 'accepted', kind: 'object',
    source: { model: { path: 'assets/environment/models/P-01/tex2/P-01_baked.glb', guid: sourceGuid }, origin: 'P0 正式环境资产（TokenHub 混元 3D 产物，Git LFS，LOD1 tex2 烘焙版）' },
    assemblyScale: 1,
    chunks: chunks.map((c, i) => ({
      chunkId: c.key, class: 'large',
      mesh: { path: 'assets/fracture/p01-barrel/' + c.key + '.glb', guid: guidFor('p01/' + c.key), sub: 'node:' + c.key },
      bind: identityBind, pivot: stats[i].centroid.map(v => +v.toFixed(6)),
      proxy: { shape: { type: 'box', halfExtents: [0, 1, 2].map(k => +((stats[i].aabb.max[k] - stats[i].aabb.min[k]) / 2).toFixed(4)) }, mass: +(Math.abs(stats[i].volume) * densityKgPerM3).toFixed(3), friction: 0.6, restitution: 0.35, collisionGroup: 'environment' },
    })),
    npc: null,
    playback: { priority: 2, lifetimeSec: 4, fadeSec: 0.8, companionVfx: null },
  };
  writeText(path.join(outDir, 'p01-barrel.fracture.json'), JSON.stringify(fracture, null, 2));
  const recipe = { chunks: chunks.length, planes, densityKgPerM3: +densityKgPerM3.toFixed(3), totalVolume: +totalVolume.toFixed(6), chunkTriangles: stats.map(s => s.triangles), files: chunks.map(c => path.basename(c.file)) };
  writeFileSync('.workbuddy/tmp/wu02-fix/p01-build.json', JSON.stringify(recipe, null, 2) + NL);
  return recipe;
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
  const mesh = extractMesh(doc);
  const skin = readSkin(doc);
  if (!skin || !skin.inverseBindMatrices) throw new Error('source skin lacks inverseBindMatrices');
  const jointRegion = new Map();
  for (const [region, names] of Object.entries(REGIONS)) for (const n of names) jointRegion.set(n, region);
  for (const name of skin.jointNames) if (!jointRegion.has(name)) throw new Error('unmapped joint: ' + name);
  const pool = new VertexPool();
  const addVertex = v => pool.add(mesh.positions.subarray(v * 3, v * 3 + 3), mesh.normals.subarray(v * 3, v * 3 + 3), mesh.uvs.subarray(v * 2, v * 2 + 2), Array.from(mesh.joints.subarray(v * 4, v * 4 + 4)), Array.from(mesh.weights.subarray(v * 4, v * 4 + 4)));
  const regionOfVertex = v => {
    let best = 0, region = null;
    for (let k = 0; k < 4; k++) {
      const w = mesh.weights[v * 4 + k];
      if (w > best) { best = w; region = jointRegion.get(skin.jointNames[mesh.joints[v * 4 + k]]); }
    }
    return region ?? 'torso';
  };
  const byRegion = new Map(Object.keys(REGIONS).map(r => [r, []]));
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const vs = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    const tally = new Map();
    for (const v of vs) { const r = regionOfVertex(v); tally.set(r, (tally.get(r) ?? 0) + 1); }
    byRegion.get([...tally.entries()].sort((a, b) => b[1] - a[1])[0][0]).push(vs.map(addVertex));
  }
  const image = sourceImage(doc);
  mkdirSync(outDir, { recursive: true });
  const nameToNew = new Map();
  const skeletonNodes = doc.json.nodes.map(n => ({ name: n.name, children: n.children, translation: n.translation, rotation: n.rotation, scale: n.scale }));
  skeletonNodes.forEach((n, i) => nameToNew.set(n.name, i));
  const skeleton = {
    nodes: skeletonNodes, roots: doc.json.scenes[0].nodes.filter(n => doc.json.nodes[n].name !== 'E04_Bulwark'),
    joints: skin.joints.map((j, i) => nameToNew.get(skin.jointNames[i])), name: 'HumanIK',
    ibm: skin.inverseBindMatrices,
  };
  const chunks = Object.keys(REGIONS).map(key => buildChunkWithCaps(pool, byRegion.get(key), key));
  const stats = chunks.map(c => chunkStats(c.local, c.triangles));
  const totalVolume = stats.reduce((acc, s) => acc + Math.abs(s.volume), 0);
  const densityKgPerM3 = 80 / totalVolume;
  for (const chunk of chunks) {
    const packed = packPart(chunk.local, chunk.triangles);
    const file = path.join(outDir, chunk.key + '.glb');
    const bytes = writeSingleMeshGlb(file, 'aether fracture offline v2 (E-04 bone regions)', chunk.key,
      { ...packed, outer: packed.triangles.slice(0, chunk.outerTriangles), caps: packed.triangles.slice(chunk.outerTriangles) }, image, skeleton);
    writeSidecar(file, 'gltf', guidFor('e04/' + chunk.key), { chunk: chunk.key, builtAt: new Date().toISOString() });
    chunk.file = file; chunk.bytes = bytes;
  }
  const sourceGuid = JSON.parse(readFileSync('assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb.meta.json', 'utf8')).guid;
  const fracture = {
    version: 1, id: 'as_e04frct', name: '盾卫 E-04 致死碎裂', status: 'accepted', kind: 'npc',
    source: { model: { path: 'assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb', guid: sourceGuid }, origin: '正式 rigged NPC（E-04 盾卫，Git LFS，HumanIK 蒙皮，6 个动画含 death）' },
    assemblyScale: 1,
    chunks: chunks.map((c, i) => ({
      chunkId: c.key, class: Math.abs(stats[i].volume) * densityKgPerM3 > 8 ? 'large' : 'small',
      mesh: { path: 'assets/fracture/e04-bulwark/' + c.key + '.glb', guid: guidFor('e04/' + c.key), sub: 'node:' + c.key },
      bind: identityBind, pivot: stats[i].centroid.map(v => +v.toFixed(6)),
      proxy: { shape: { type: 'box', halfExtents: [0, 1, 2].map(k => +((stats[i].aabb.max[k] - stats[i].aabb.min[k]) / 2).toFixed(4)) }, mass: +(Math.abs(stats[i].volume) * densityKgPerM3).toFixed(3), friction: 0.7, restitution: 0.2, collisionGroup: 'debris' },
    })),
    npc: { actorId: 'E-04', mode: 'skinned', boneMap: { ...PRIMARY_BONE }, normalizeHeightM: 2.05, footOffsetM: 0 },
    playback: { priority: 2, lifetimeSec: 5, fadeSec: 1, companionVfx: null },
  };
  writeText(path.join(outDir, 'e04-bulwark.fracture.json'), JSON.stringify(fracture, null, 2));
  const recipe = { chunks: chunks.length, regions: Object.fromEntries(chunks.map((c, i) => [c.key, stats[i].triangles])), densityKgPerM3: +densityKgPerM3.toFixed(3), totalVolume: +totalVolume.toFixed(6), files: chunks.map(c => path.basename(c.file)) };
  writeFileSync('.workbuddy/tmp/wu02-fix/e04-build.json', JSON.stringify(recipe, null, 2) + NL);
  return recipe;
}

const invoked = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invoked) {
  mkdirSync('.workbuddy/tmp/wu02-fix', { recursive: true });
  const recipe = {
    barrel: await buildBarrel('assets/environment/models/P-01/tex2/P-01_baked.glb', 'assets/fracture/p01-barrel'),
    actor: buildActor('assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb', 'assets/fracture/e04-bulwark'),
  };
  console.log(JSON.stringify(recipe, null, 1));
}
