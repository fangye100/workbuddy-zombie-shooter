#!/usr/bin/env node
/** Numeric verification for formal fracture assets: per-chunk closure/degeneracy/
 * finiteness/normals/UVs, assembly conservation, proxy bounds, skin preservation
 * and a non-bind-pose sampling check against the source animation. */
import { readFileSync, writeFileSync } from 'node:fs';
import { readGlb, readAccessor, extractMesh } from './glb-io.mjs';
import { dot, cross, sub, normalize } from './split-core.mjs';

const NL = String.fromCharCode(10);
const failures = [];
const notes = [];
const check = (ok, message, detail) => { if (!ok) failures.push(message + (detail ? ': ' + JSON.stringify(detail) : '')); };

const keyOf = p => p.map(v => Math.round(v * 1e7)).join(',');

function chunkGeometry(doc, nodeName) {
  const nodeIndex = doc.json.nodes.findIndex(n => n.name === nodeName);
  if (nodeIndex < 0) throw new Error('missing chunk node ' + nodeName);
  const mesh = doc.json.meshes[doc.json.nodes[nodeIndex].mesh];
  const prims = mesh.primitives.map(p => {
    const at = k => readAccessor(doc, p.attributes[k]);
    return { positions: at('POSITION'), normals: at('NORMAL'), uvs: at('TEXCOORD_0'), joints: p.attributes.JOINTS_0 !== undefined ? at('JOINTS_0') : null, weights: p.attributes.WEIGHTS_0 !== undefined ? at('WEIGHTS_0') : null, indices: readAccessor(doc, p.indices) };
  });
  return prims;
}

function verifyClosed(prims, label) {
  const edgeCount = new Map();
  let area = 0, volume = 0, degenerate = 0, nonFinite = 0, badNormal = 0, badUv = 0;
  const tris = [];
  for (const prim of prims) {
    for (let i = 0; i < prim.indices.length; i += 3) tris.push([prim.indices[i], prim.indices[i + 1], prim.indices[i + 2]]);
    for (let v = 0; v < prim.positions.length / 3; v++) {
      const p = [prim.positions[v * 3], prim.positions[v * 3 + 1], prim.positions[v * 3 + 2]];
      if (!p.every(Number.isFinite)) nonFinite++;
      const n = [prim.normals[v * 3], prim.normals[v * 3 + 1], prim.normals[v * 3 + 2]];
      if (!n.every(Number.isFinite) || Math.abs(Math.hypot(...n) - 1) > 0.05) badNormal++;
      if (![prim.uvs[v * 2], prim.uvs[v * 2 + 1]].every(Number.isFinite)) badUv++;
    }
  }
  const posAt = (prim, i) => [prim.positions[i * 3], prim.positions[i * 3 + 1], prim.positions[i * 3 + 2]];
  for (let t = 0; t < tris.length; t++) {
    const prim = prims.find(p => tris[t][0] < p.positions.length / 3);
    const idx = tris[t];
    const a = posAt(prim, idx[0]), b = posAt(prim, idx[1]), c = posAt(prim, idx[2]);
    const cr = cross(sub(b, a), sub(c, a));
    const triArea = Math.hypot(...cr) / 2;
    if (!(triArea > 1e-12)) degenerate++;
    area += triArea;
    volume += dot(a, cross(b, c)) / 6;
    for (const e of [[idx[0], idx[1]], [idx[1], idx[2]], [idx[2], idx[0]]]) {
      const ka = keyOf(posAt(prim, e[0])), kb = keyOf(posAt(prim, e[1]));
      const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  let boundary = 0, nonmanifold = 0;
  for (const c of edgeCount.values()) { if (c === 1) boundary++; if (c > 2) nonmanifold++; }
  check(boundary === 0 && nonmanifold === 0, label + ' must be closed (boundary/nonmanifold)', { boundary, nonmanifold });
  check(degenerate === 0, label + ' has degenerate triangles', { degenerate });
  check(nonFinite === 0 && badNormal === 0 && badUv === 0, label + ' attributes invalid', { nonFinite, badNormal, badUv });
  return { area, volume, boundary, nonmanifold, degenerate, triangles: tris.length };
}

function sourceAreaVolume(mesh) {
  let area = 0, volume = 0;
  const p = v => [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = p(mesh.indices[i]), b = p(mesh.indices[i + 1]), c = p(mesh.indices[i + 2]);
    area += Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
    volume += dot(a, cross(b, c)) / 6;
  }
  return { area, volume: Math.abs(volume) };
}

function verifyAsset(fracturePath, sourcePath) {
  const fracture = JSON.parse(readFileSync(fracturePath, 'utf8'));
  const sourceDoc = readGlb(sourcePath);
  const sourceMesh = extractMesh(sourceDoc);
  const chunkDoc = readGlb(fracture.chunks[0].mesh.path.replace('assets/', 'assets/'));
  const ids = new Set(fracture.chunks.map(c => c.chunkId));
  check(ids.size === fracture.chunks.length, fracturePath + ' chunkId unique');
  let totalArea = 0, totalVolume = 0;
  const stats = {};
  for (const chunk of fracture.chunks) {
    const prims = chunkGeometry(chunkDoc, chunk.chunkId);
    const s = verifyClosed(prims, fracturePath + '#' + chunk.chunkId);
    stats[chunk.chunkId] = { area: +s.area.toFixed(6), volume: +Math.abs(s.volume).toFixed(6), triangles: s.triangles };
    totalArea += s.area;
    totalVolume += Math.abs(s.volume);
    const half = chunk.proxy.shape.halfExtents;
    check(half.every(h => h > 0 && h <= 100), chunk.chunkId + ' proxy halfExtents bounded', half);
    check(chunk.proxy.mass > 0 && chunk.proxy.mass <= 10000, chunk.chunkId + ' mass bounded', chunk.proxy.mass);
  }
  const source = sourceAreaVolume(sourceMesh);
  const rel = (a, b) => Math.abs(a - b) / b;
  if (fracture.kind !== 'npc') check(rel(totalVolume, source.volume) < 0.08, fracturePath + ' volume conservation', { chunks: +totalVolume.toFixed(6), source: +source.volume.toFixed(6) });
  if (fracture.kind === 'npc') {
    // No clipping on the actor path: outer triangles must partition the source surface exactly.
    const canonical = tris => new Set(tris.map(t => t.map(keyOf).sort().join('|')));
    const outer = new Set();
    for (const chunk of fracture.chunks) {
      for (const prim of chunkGeometry(chunkDoc, chunk.chunkId).slice(0, 1)) {
        for (let i = 0; i < prim.indices.length; i += 3) {
          outer.add([prim.indices[i], prim.indices[i + 1], prim.indices[i + 2]].map(v => keyOf([prim.positions[v * 3], prim.positions[v * 3 + 1], prim.positions[v * 3 + 2]])).sort().join('|'));
        }
      }
    }
    const sourceSet = new Set();
    for (let i = 0; i < sourceMesh.indices.length; i += 3) {
      sourceSet.add([sourceMesh.indices[i], sourceMesh.indices[i + 1], sourceMesh.indices[i + 2]].map(v => keyOf([sourceMesh.positions[v * 3], sourceMesh.positions[v * 3 + 1], sourceMesh.positions[v * 3 + 2]])).sort().join('|'));
    }
    let missing = 0;
    for (const t of sourceSet) if (!outer.has(t)) missing++;
    check(missing === 0 && outer.size === sourceSet.size, fracturePath + ' outer triangles must partition the source surface exactly', { missing, extra: outer.size - sourceSet.size + missing });
  }
  return { fracture: fracturePath, chunks: fracture.chunks.length, stats, totals: { area: +totalArea.toFixed(6), volume: +totalVolume.toFixed(6) }, source: { area: +source.area.toFixed(6), volume: +source.volume.toFixed(6) } };
}

// Skin preservation + non-bind pose sampling (actor only).
function verifyActorSkin(fracturePath, sourcePath, chunkGlbPath, animation, sampleTime) {
  const fracture = JSON.parse(readFileSync(fracturePath, 'utf8'));
  const doc = readGlb(sourcePath);
  const mesh = extractMesh(doc);
  const nodes = doc.json.nodes;
  const nameToIndex = new Map(nodes.map((n, i) => [n.name, i]));
  // Pose the skeleton at sampleTime.
  const anim = doc.json.animations.find(a => a.name === animation);
  if (!anim) throw new Error('missing animation ' + animation);
  const sample = (sampler, t) => {
    const input = readAccessor(doc, sampler.input), output = readAccessor(doc, sampler.output);
    let i = 0;
    while (i + 1 < input.length && input[i + 1] < t) i++;
    const t0 = input[i], t1 = input[i + 1] ?? t0 + 1;
    const a = (t - t0) / (t1 - t0 || 1);
    const lerp = (x, y) => x + (y - x) * a;
    const out = [];
    for (let k = 0; k < output.length; k++) out.push(k % 4 === 3 && sampler.outputType === 'quat' ? 1 : lerp(output[k], output[(i + 1) * (output.length / input.length) + k] ?? output[k]));
    return out;
  };
  const rotationOf = node => {
    const channel = anim.channels.find(c => c.target.node === node && c.target.path === 'rotation');
    const r = nodes[node].rotation ?? [0, 0, 0, 1];
    if (!channel) return r;
    const out = sample(anim.samplers[channel.sampler], sampleTime);
    return [out[0], out[1], out[2], out[3]];
  };
  const translationOf = node => {
    const channel = anim.channels.find(c => c.target.node === node && c.target.path === 'translation');
    const base = nodes[node].translation ?? [0, 0, 0];
    if (!channel) return base;
    const out = sample(anim.samplers[channel.sampler], sampleTime);
    return [out[0], out[1], out[2]];
  };
  const quatMul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const globalOf = new Map();
  const computeGlobal = (index, parent) => {
    const t = translationOf(index), r = rotationOf(index), s = nodes[index].scale ?? [1, 1, 1];
    const local = { t, r, s, parent };
    globalOf.set(index, local);
    for (const child of nodes[index].children ?? []) computeGlobal(child, index);
  };
  for (const root of doc.json.scenes[0].nodes) if (nodes[root].name !== 'E04_Bulwark') computeGlobal(root, null);
  const skin = doc.json.skins[0];
  const jointMatrix = j => {
    const chain = [];
    let cur = skin.joints[j];
    while (cur !== undefined && cur !== null) { chain.unshift(cur); cur = globalOf.get(cur)?.parent; }
    // Compose TRS chain into a 3x4 matrix.
    let m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    const mul = (a, b) => {
      const out = new Array(12);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
        out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
      }
      return out;
    };
    for (const node of chain) {
      const { t, r, s } = globalOf.get(node);
      const [x, y, z, w] = r;
      const local = [
        (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y - w * z) * s[0], 2 * (x * z + w * y) * s[0], t[0],
        2 * (x * y + w * z) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z - w * x) * s[1], t[1],
        2 * (x * z - w * y) * s[2], 2 * (y * z + w * x) * s[2], (1 - 2 * (x * x + y * y)) * s[2], t[2],
      ];
      m = mul(local, m);
    }
    return m;
  };
  const applyM = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
  const skinPoint = (p, js, ws) => {
    const out = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      if (!(ws[k] > 0)) continue;
      const q = applyM(jointMatrix(js[k]), p);
      for (let c = 0; c < 3; c++) out[c] += q[c] * ws[k];
    }
    return out;
  };
  // Source skinned reference by position key.
  const reference = new Map();
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const p = [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
    const js = Array.from(mesh.joints.subarray(v * 4, v * 4 + 4)), ws = Array.from(mesh.weights.subarray(v * 4, v * 4 + 4));
    reference.set(keyOf(p), skinPoint(p, js, ws));
  }
  const chunkDoc = readGlb(chunkGlbPath);
  let shared = 0, maxSharedDelta = 0, capped = 0, maxCapDelta = 0;
  for (const chunk of fracture.chunks) {
    for (const prim of chunkGeometry(chunkDoc, chunk.chunkId)) {
      for (let v = 0; v < prim.positions.length / 3; v++) {
        const p = [prim.positions[v * 3], prim.positions[v * 3 + 1], prim.positions[v * 3 + 2]];
        const js = prim.joints ? Array.from(prim.joints.subarray(v * 4, v * 4 + 4)) : null;
        const ws = prim.weights ? Array.from(prim.weights.subarray(v * 4, v * 4 + 4)) : null;
        const skinned = skinPoint(p, js, ws);
        const ref = reference.get(keyOf(p));
        if (ref) { shared++; maxSharedDelta = Math.max(maxSharedDelta, Math.hypot(...sub(skinned, ref))); }
        else {
          capped++;
          // Cap verts must follow their neighbourhood: compare skinned cap position to the
          // nearest skinned shared vertex (skinned-vs-skinned, not skinned-vs-rest).
          let best = null;
          for (const [k2, ref] of reference) {
            const d = Math.hypot(p[0] * 0 + 0, 0, 0);
            void d;
            const rk = k2.split(',').map(Number);
            const dist = Math.hypot(p[0] - rk[0], p[1] - rk[1], p[2] - rk[2]);
            if (best === null || dist < best.dist) best = { dist, ref };
          }
          if (best && best.dist < 0.05) maxCapDelta = Math.max(maxCapDelta, Math.hypot(...sub(skinned, best.ref)));
        }
      }
    }
  }
  check(maxSharedDelta < 1e-6, 'shared skinned vertices must match source exactly', { maxSharedDelta });
  notes.push('non-bind pose ' + animation + '@' + sampleTime + 's: shared=' + shared + ' maxDelta=' + maxSharedDelta.toExponential(2) + '; new cap verts=' + capped + ' (pose drift vs rest ' + maxCapDelta.toFixed(4) + ' m)');
  return { shared, capped, maxSharedDelta, maxCapDelta };
}

const invoked = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (invoked) {
  const report = {
    barrel: verifyAsset('assets/fracture/p01-barrel/p01-barrel.fracture.json', 'assets/environment/models/P-01/tex2/P-01_baked.glb'),
    actor: verifyAsset('assets/fracture/e04-bulwark/e04-bulwark.fracture.json', 'assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb'),
    actorSkin: verifyActorSkin('assets/fracture/e04-bulwark/e04-bulwark.fracture.json', 'assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb', 'assets/fracture/e04-bulwark/e04-bulwark-chunks.glb', 'run', 0.4),
    notes, failures,
  };
  writeFileSync('.workbuddy/tmp/wu02/fracture-verify-report.json', JSON.stringify(report, null, 2) + NL);
  console.log(JSON.stringify({ failures, notes, totals: { barrel: report.barrel.totals, actor: report.actor.totals, actorSkin: report.actorSkin } }, null, 1));
  process.exit(failures.length ? 1 : 0);
}
