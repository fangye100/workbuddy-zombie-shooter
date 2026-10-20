/** Offline fracture geometry core (WU-02 fix): bone-region partition with
 * corner-exact attribute preservation, directed-edge topology, cut-face caps
 * with dedicated flat normals, and topology/volume statistics. The hand-written
 * planar cutting path was superseded by the manifold-3d CSG builder and removed
 * (plan §11.5 dedup; history preserved in git). */

export const EPS = 1e-7;

// ---------------------------------------------------------------- vertex pool

export class VertexPool {
  constructor() { this.positions = []; this.normals = []; this.uvs = []; this.joints = []; this.weights = []; }
  add(position, normal, uv, joints = null, weights = null) {
    this.positions.push(position[0], position[1], position[2]);
    this.normals.push(normal[0], normal[1], normal[2]);
    this.uvs.push(uv[0], uv[1]);
    if (joints) this.joints.push(...joints);
    if (weights) this.weights.push(...weights);
    return this.positions.length / 3 - 1;
  }
  p(i) { return [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]]; }
  n(i) { return [this.normals[i * 3], this.normals[i * 3 + 1], this.normals[i * 3 + 2]]; }
  t(i) { return [this.uvs[i * 2], this.uvs[i * 2 + 1]]; }
  j(i) { return this.joints.length ? [this.joints[i * 4], this.joints[i * 4 + 1], this.joints[i * 4 + 2], this.joints[i * 4 + 3]] : null; }
  w(i) { return this.weights.length ? [this.weights[i * 4], this.weights[i * 4 + 1], this.weights[i * 4 + 2], this.weights[i * 4 + 3]] : null; }
  count() { return this.positions.length / 3; }
}

/** Topology position key: cut crossings duplicate vertices at the same position;
 * only the topology census and cap bookkeeping run on these keys, while render
 * vertices keep their UV/normal/skin seams untouched (plan §5.4/§5.5). */
export function positionKey(local, i) {
  const q = v => Math.round(v * 1e6);
  return q(local.positions[i * 3]) + ',' + q(local.positions[i * 3 + 1]) + ',' + q(local.positions[i * 3 + 2]);
}

// ---------------------------------------------------------------- chunk assembly

/** Packs a region-assigned triangle subset with cut-face caps. Outer corners keep
 * their original indices (attributes/seams exact). Caps traverse the boundary
 * loops in the REVERSE direction so every shared edge is used in opposite
 * orientations (directed closure), and cap vertices are per-face copies with
 * flat geometric normals; skin weights are blended per joint id (discrete). */
export function buildChunkWithCaps(pool, triangles, key) {
  const local = new VertexPool();
  const remap = new Map();
  const map = i => {
    if (!remap.has(i)) remap.set(i, local.add(pool.p(i), pool.n(i), pool.t(i), pool.j(i), pool.w(i)));
    return remap.get(i);
  };
  const outer = triangles.map(t => t.map(map));

  const directed = new Map();
  for (const t of outer) for (const e of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
    const k = positionKey(local, e[0]) + '>' + positionKey(local, e[1]);
    directed.set(k, (directed.get(k) ?? 0) + 1);
  }
  const open = [...directed.entries()].filter(([k, c]) => c === 1 && !directed.has(k.split('>').reverse().join('>'))).map(([k]) => k.split('>').map(k2 => indexOfKey(local, k2)));
  const caps = open.length ? capOpenEdges(local, open) : [];
  return { key, local, triangles: [...outer, ...caps.triangles], outerTriangles: outer.length, capTriangles: caps.triangles.length, capVertices: caps.capVertices, openEdgesBefore: open.length };
}

function indexOfKey(local, key) {
  const [x, y, z] = key.split(',').map(Number);
  for (let i = 0; i < local.count(); i++) {
    const q = v => Math.round(v * 1e6);
    if (q(local.positions[i * 3]) === x && q(local.positions[i * 3 + 1]) === y && q(local.positions[i * 3 + 2]) === z) return i;
  }
  throw new Error('vertex key not found: ' + key);
}

/** Caps open boundary edges with directed-consistent triangles on cut faces. */
function capOpenEdges(local, open) {
  // Cap copies are keyed per (position, loop): pinch vertices hosting several
  // boundary strands get one copy per strand so every fan ring is a simple cycle.
  const capIndex = new Map();
  const seenPositions = new Map();
  const capVertex = (i, loopId, joints = null, weights = null) => {
    let k = positionKey(local, i);
    const seen = seenPositions.get(k) ?? 0;
    seenPositions.set(k, seen + 1);
    if (seen > 0) k = k + '#' + loopId;
    if (capIndex.has(k)) return capIndex.get(k);
    const index = local.add(local.p(i), [0, 1, 0], [0, 0], joints ?? local.j(i), weights ?? local.w(i));
    capIndex.set(k, index);
    return index;
  };
  const triangles = [];
  const fanFromLoop = (loop, loopId) => {
    const open2 = loop[loop.length - 1] === loop[0] ? loop.slice(0, -1) : loop;
    if (open2.length < 3) return;
    // Reverse traversal keeps shared edges opposite to the outer triangles.
    // Reverse traversal keeps shared edges opposite to the outer triangles.
    const rev = [...open2].reverse();
    const centroidP = [0, 0, 0], centroidUV = [0, 0];
    for (const i of rev) {
      const p = local.p(i), t = local.t(i);
      for (let k = 0; k < 3; k++) centroidP[k] += p[k] / rev.length;
      centroidUV[0] += t[0] / rev.length; centroidUV[1] += t[1] / rev.length;
    }
    // Cap boundary copies inherit the FULL mixed skin binding of their
    // corresponding outer-surface corner; the centre blends all loop corner
    // bindings so the cut face follows the neighbourhood under any pose.
    const centreJ = local.weights.length ? new Array(4).fill(0) : null;
    const centreW = local.weights.length ? new Array(4).fill(0) : null;
    if (local.weights.length) {
      const byJoint = new Map();
      for (const i of rev) {
        const js = local.j(i), ws = local.w(i);
        for (let k = 0; k < 4; k++) if (ws[k] > 0) byJoint.set(js[k], (byJoint.get(js[k]) ?? 0) + ws[k] / rev.length);
      }
      const top = [...byJoint.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((acc, [, w]) => acc + w, 0) || 1;
      top.forEach(([j, w], k) => { centreJ[k] = j; centreW[k] = w / sum; });
      for (let k = top.length; k < 4; k++) centreJ[k] = top[0][0];
    }
    const center = local.add(centroidP, [0, 1, 0], centroidUV, centreJ, centreW);
    // Per-triangle cap copies with flat geometric normals and the ORIGINAL corner
    // skin binding (boundary continuity under animation, plan §5.3).
    for (let i = 0; i < rev.length; i++) {
      const next = rev[(i + 1) % rev.length];
      const pa = local.p(rev[i]), pb = local.p(next), pc = centroidP;
      const gn = triangleNormal(pa, pb, pc);
      const v0 = local.add(pa, gn, local.t(rev[i]), local.j(rev[i]), local.w(rev[i]));
      const v1 = local.add(pb, gn, local.t(next), local.j(next), local.w(next));
      const v2 = local.add(pc, gn, centroidUV, centreJ, centreW);
      triangles.push([v0, v1, v2]);
    }
  };
  let loopId = 0;
  for (const loop of chainLoops(local, open)) fanFromLoop(loop, loopId++);
  // Global residual over the COMBINED census (outer open edges + kept caps):
  // a cap edge whose reverse lives in the outer set is already closed.
  const census = new Map();
  for (const [a, b] of open) census.set(positionKey(local, a) + '>' + positionKey(local, b), 1);
  for (const t of triangles) for (const e of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
    const k = positionKey(local, e[0]) + '>' + positionKey(local, e[1]);
    census.set(k, (census.get(k) ?? 0) + 1);
  }
  const stillOpen = [];
  for (const [k] of census) if ((census.get(k.split('>').reverse().join('>')) ?? 0) === 0) stillOpen.push(k);
  if (stillOpen.length) {
    const centroid = [0, 0, 0];
    for (const k of stillOpen) { const p = local.p(indexOfKey(local, k.split('>')[0])); for (let q = 0; q < 3; q++) centroid[q] += p[q] / stillOpen.length; }
    // Centre binding: average of all residual endpoints' bindings.
    const centreJ = local.weights.length ? new Array(4).fill(0) : null;
    const centreW = local.weights.length ? new Array(4).fill(0) : null;
    if (local.weights.length) {
      const byJoint = new Map();
      for (const k of stillOpen) for (const end of [0, 1]) {
        const idx = indexOfKey(local, k.split('>')[end]);
        const js = local.j(idx), ws = local.w(idx);
        for (let q = 0; q < 4; q++) if (ws[q] > 0) byJoint.set(js[q], (byJoint.get(js[q]) ?? 0) + ws[q] / (stillOpen.length * 2));
      }
      const top = [...byJoint.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((acc, [, w]) => acc + w, 0) || 1;
      top.forEach(([j, w], k) => { centreJ[k] = j; centreW[k] = w / sum; });
      for (let k = top.length; k < 4; k++) centreJ[k] = top[0][0];
    }
    const center = local.add(centroid, [0, 1, 0], [0, 0], centreJ, centreW);
    for (const k of stillOpen) {
      const idxA = indexOfKey(local, k.split('>')[1]);
      const idxB = indexOfKey(local, k.split('>')[0]);
      const pa = local.p(idxA);
      const pb = local.p(idxB);
      const gn = triangleNormal(pa, pb, centroid);
      const v0 = local.add(pa, gn, [0, 0], local.j(idxA), local.w(idxA));
      const v1 = local.add(pb, gn, [0, 0], local.j(idxB), local.w(idxB));
      const v2 = local.add(centroid, gn, [0, 0], centreJ, centreW);
      triangles.push([v0, v1, v2]);
    }
  }
  return { triangles, capVertices: capIndex.size };
}

function chainLoops(local, edges) {
  const byVertex = new Map();
  for (const [a, b] of edges) {
    const ka = positionKey(local, a);
    if (!byVertex.has(ka)) byVertex.set(ka, []);
    byVertex.get(ka).push(b);
  }
  const loops = [];
  const used = new Set();
  for (const [a, b] of edges) {
    if (used.has(positionKey(local, a) + '>' + positionKey(local, b))) continue;
    const loop = [a];
    let cur = a, next = b;
    for (;;) {
      used.add(positionKey(local, cur) + '>' + positionKey(local, next));
      loop.push(next);
      const candidates = (byVertex.get(positionKey(local, next)) ?? []).filter(n => !used.has(positionKey(local, next) + '>' + positionKey(local, n)));
      if (candidates.length === 0) break;
      [cur, next] = [next, candidates[0]];
      if (next === loop[0]) { used.add(positionKey(local, cur) + '>' + positionKey(local, next)); break; }
    }
    // Split figure-8 strands at revisited vertices so each fan stays simple.
    const split = [];
    let current = [];
    const seenInLoop = new Set();
    for (const v of loop) {
      const k = positionKey(local, v);
      if (seenInLoop.has(k) && current.length > 1) { split.push([...current, v]); current = [v]; seenInLoop.clear(); seenInLoop.add(k); continue; }
      current.push(v);
      seenInLoop.add(k);
    }
    if (current.length > 1) split.push(current);
    loops.push(...split.filter(seg => seg.length >= 3));
  }
  return loops;
}

// ---------------------------------------------------------------- stats

/** Directed-edge census: a consistently oriented closed surface uses every
 * undirected edge exactly once per direction. */
export function chunkStats(local, triangles) {
  const aabb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < local.count(); i++) {
    const p = local.p(i);
    for (let k = 0; k < 3; k++) { aabb.min[k] = Math.min(aabb.min[k], p[k]); aabb.max[k] = Math.max(aabb.max[k], p[k]); }
  }
  let volume = 0, area = 0, degenerate = 0, nonFinite = 0;
  const forward = new Map();
  for (const t of triangles) {
    const [a, b, c] = t.map(i => local.p(i));
    const cr = cross(sub(b, a), sub(c, a));
    const triArea = Math.hypot(...cr) / 2;
    if (!(triArea > 1e-12)) degenerate++;
    area += triArea;
    volume += dot(a, cross(b, c)) / 6;
    if (![...a, ...b, ...c].every(Number.isFinite)) nonFinite++;
    const keys = t.map(i => positionKey(local, i));
    for (const e of [[keys[0], keys[1]], [keys[1], keys[2]], [keys[2], keys[0]]]) {
      forward.set(e[0] + '>' + e[1], (forward.get(e[0] + '>' + e[1]) ?? 0) + 1);
    }
  }
  let boundary = 0, nonmanifold = 0, sameDirection = 0;
  for (const [k, c] of forward) {
    const rev = k.split('>').reverse().join('>');
    const rc = forward.get(rev) ?? 0;
    if (c > 1) sameDirection += c - 1;
    if (rc === 0) boundary++;
    else if (c > 1 || rc > 1) nonmanifold++;
  }
  const centroid = [0, 0, 0];
  const total = local.count();
  for (let i = 0; i < total; i++) { const p = local.p(i); for (let k = 0; k < 3; k++) centroid[k] += p[k] / total; }
  return { aabb, volume, area, degenerate, nonFinite, boundary, nonmanifold, sameDirection, centroid, vertices: total, triangles: triangles.length };
}

// ---------------------------------------------------------------- small math

export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const normalize = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const triangleNormal = (a, b, c) => normalize(cross(sub(b, a), sub(c, a)));
