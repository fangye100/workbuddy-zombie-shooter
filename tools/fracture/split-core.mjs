/** Offline fracture geometry core: planar recursive splitting with attribute
 * interpolation, planar ear-clip capping, bone-region partition with weighted
 * fan capping, and topology/volume statistics. Pure functions, no IO. */

export const EPS = 1e-7;

// ---------------------------------------------------------------- vertex pool

export class VertexPool {
  constructor() { this.positions = []; this.normals = []; this.uvs = []; this.joints = []; this.weights = []; this.origins = []; }
  add(position, normal, uv, joints = null, weights = null) {
    this.positions.push(position[0], position[1], position[2]);
    this.normals.push(normal[0], normal[1], normal[2]);
    this.uvs.push(uv[0], uv[1]);
    if (joints) this.joints.push(...joints);
    if (weights) this.weights.push(...weights);
    const index = this.positions.length / 3 - 1;
    this.origins.push(null);
    return index;
  }
  p(i) { return [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]]; }
  n(i) { return [this.normals[i * 3], this.normals[i * 3 + 1], this.normals[i * 3 + 2]]; }
  t(i) { return [this.uvs[i * 2], this.uvs[i * 2 + 1]]; }
  j(i) { return this.joints.length ? [this.joints[i * 4], this.joints[i * 4 + 1], this.joints[i * 4 + 2], this.joints[i * 4 + 3]] : null; }
  w(i) { return this.weights.length ? [this.weights[i * 4], this.weights[i * 4 + 1], this.weights[i * 4 + 2], this.weights[i * 4 + 3]] : null; }
  lerp(a, b, t) {
    const l = (x, y) => x + (y - x) * t;
    const p = [l(this.positions[a * 3], this.positions[b * 3]), l(this.positions[a * 3 + 1], this.positions[b * 3 + 1]), l(this.positions[a * 3 + 2], this.positions[b * 3 + 2])];
    let n = [l(this.normals[a * 3], this.normals[b * 3]), l(this.normals[a * 3 + 1], this.normals[b * 3 + 1]), l(this.normals[a * 3 + 2], this.normals[b * 3 + 2])];
    const nl = Math.hypot(...n) || 1; n = [n[0] / nl, n[1] / nl, n[2] / nl];
    const uv = [l(this.uvs[a * 2], this.uvs[b * 2]), l(this.uvs[a * 2 + 1], this.uvs[b * 2 + 1])];
    let joints = null, weights = null;
    if (this.weights.length) {
      const byJoint = new Map();
      for (const [src, tt] of [[a, 1 - t], [b, t]]) {
        const js = this.j(src), ws = this.w(src);
        for (let k = 0; k < 4; k++) if (ws[k] > 0) byJoint.set(js[k], (byJoint.get(js[k]) ?? 0) + ws[k] * tt);
      }
      const top = [...byJoint.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
      const sum = top.reduce((acc, [, w]) => acc + w, 0) || 1;
      joints = [0, 0, 0, 0]; weights = [0, 0, 0, 0];
      top.forEach(([j, w], k) => { joints[k] = j; weights[k] = w / sum; });
      for (let k = top.length; k < 4; k++) { joints[k] = top[0]?.[0] ?? 0; }
    }
    const index = this.add(p, n, uv, joints, weights);
    this.origins[index] = [a, b, +t.toFixed(4)];
    return index;
  }
}

// ---------------------------------------------------------------- plane split

/** plane: { normal:[x,y,z] (unit), d } keeping dot(p,n) <= d. Returns { behind, ahead }. */
export function splitTrianglesByPlane(pool, triangles, plane) {
  const behind = [], ahead = [];
  for (const tri of triangles) {
    // A triangle coplanar with the cut plane belongs to neither side; caps
    // regenerate that face. Keeping it would duplicate it into both cells.
    if (tri.every(v => Math.abs(sideValue(pool, v, plane)) <= EPS)) continue;
    for (const [list, inside] of [[behind, s => s <= 0], [ahead, s => s >= 0]]) {
      const poly = clipPolygon(pool, tri, plane, inside);
      for (let i = 1; i + 1 < poly.length; i++) pushNonDegenerate(list, pool, [poly[0], poly[i], poly[i + 1]]);
    }
  }
  return { behind, ahead };
}

/** Sutherland-Hodgman clip of one triangle against a half-space; plane-touching
 * vertices count as inside both sides so neighbours share exact boundary verts. */
function clipPolygon(pool, tri, plane, inside) {
  const out = [];
  for (let i = 0; i < tri.length; i++) {
    const a = tri[i], b = tri[(i + 1) % tri.length];
    const sa = sideValue(pool, a, plane), sb = sideValue(pool, b, plane);
    const ain = inside(sa), bin = inside(sb);
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = sa / (sa - sb);
      out.push(pool.lerp(a, b, Math.max(0, Math.min(1, t))));
    }
  }
  return out;
}

/** Vertices exactly on the cut plane make one split piece collapse to zero area;
 * such slivers carry no surface and would corrupt the boundary census. */
function pushNonDegenerate(list, pool, tri) {
  const [a, b, c] = tri.map(i => pool.p(i));
  const e1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], e2 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  const cr = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
  if (Math.hypot(...cr) / 2 > 1e-12) list.push(tri);
}

function sideValue(pool, i, plane) {
  return pool.positions[i * 3] * plane.normal[0] + pool.positions[i * 3 + 1] * plane.normal[1] + pool.positions[i * 3 + 2] * plane.normal[2] - plane.d;
}

/** Recursive cell split. planes is applied in order; emit(cellIndex, triangles, cellPlanes)
 * where cellPlanes records {plane, side:+1|-1} boundaries actually constraining the cell. */
export function splitByPlanes(pool, triangles, planes, emit, cellPlanes = [], cellIndex = { n: 0 }) {
  if (planes.length === 0) { emit(cellIndex.n++, triangles, cellPlanes); return; }
  const [plane, ...rest] = planes;
  const { behind, ahead } = splitTrianglesByPlane(pool, triangles, plane);
  if (behind.length) splitByPlanes(pool, behind, rest, emit, [...cellPlanes, { plane, side: -1 }], cellIndex);
  if (ahead.length) splitByPlanes(pool, ahead, rest, emit, [...cellPlanes, { plane, side: +1 }], cellIndex);
}

// ---------------------------------------------------------------- chunk assembly

/** Packs a triangle subset into a local chunk with planar loop caps. */
export function buildChunkWithPlanarCaps(pool, triangles, cellPlanes, key) {
  const remap = new Map();
  const local = new VertexPool();
  const map = i => {
    if (!remap.has(i)) remap.set(i, local.add(pool.p(i), pool.n(i), pool.t(i), pool.j(i), pool.w(i)));
    return remap.get(i);
  };
  const rep = new Map();
  const representative = i => {
    const k = positionKey(local, i);
    if (!rep.has(k)) rep.set(k, i);
    return rep.get(k);
  };
  const outer = triangles.map(t => t.map(map).map(representative));
  const caps = planarLoopCaps(local, outer, cellPlanes);
  return { key, local, triangles: [...outer, ...caps], outerTriangles: outer.length, capTriangles: caps.length };
}

/** Packs a region-assigned subset with 3D fan caps (weights interpolated from loop). */
export function buildChunkWithFanCaps(pool, triangles, key) {
  const remap = new Map();
  const local = new VertexPool();
  const map = i => {
    if (!remap.has(i)) remap.set(i, local.add(pool.p(i), pool.n(i), pool.t(i), pool.j(i), pool.w(i)));
    return remap.get(i);
  };
  const outer = triangles.map(t => t.map(map));
  const chunk = buildChunkCommon(local, outer, key, () => 'fan', loop => fanClip3D(local, loop));
  return dedupeCoincidentTriangles(chunk);
}

/** Surface pinch vertices can make a boundary loop traverse one edge twice,
 * producing coincident fan triangles; duplicates are removed by canonical key. */
function dedupeCoincidentTriangles(chunk) {
  const seen = new Set();
  const triangles = [];
  let outerTriangles = 0;
  for (const t of chunk.triangles) {
    const k = t.map(i => positionKey(chunk.local, i)).sort().join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    if (triangles.length < chunk.outerTriangles) outerTriangles = triangles.length + 1;
    triangles.push(t);
  }
  return { ...chunk, triangles, outerTriangles: Math.min(outerTriangles, triangles.length), capTriangles: triangles.length - Math.min(outerTriangles, triangles.length) };
}

/** Cut crossings create duplicate vertices at the same position (one per adjacent
 * triangle). Topology and cap bookkeeping run on quantized position keys so loops
 * close, while render vertices keep their UV/normal seams (plan §5.5). */
function positionKey(local, i) {
  const q = v => Math.round(v * 1e6);
  return q(local.positions[i * 3]) + ',' + q(local.positions[i * 3 + 1]) + ',' + q(local.positions[i * 3 + 2]);
}

function planarLoopCaps(local, outer, cellPlanes) {
  if (cellPlanes.length === 0) return [];
  const directed = new Map();
  for (const t of outer) for (const e of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) directed.set(e[0] + ':' + e[1], (directed.get(e[0] + ':' + e[1]) ?? 0) + 1);
  const open = [...directed.entries()].filter(([k, c]) => c === 1 && !directed.has(k.split(':').map(Number).reverse().join(':'))).map(([k]) => k.split(':').map(Number));
  const byPlane = new Map();
  for (const cellPlane of cellPlanes) {
    const onPlane = new Map();
    for (const [a, b] of open) {
      if (Math.abs(sideValue(local, a, cellPlane.plane)) <= 1e-5) onPlane.set(a, true);
      if (Math.abs(sideValue(local, b, cellPlane.plane)) <= 1e-5) onPlane.set(b, true);
    }
    if (onPlane.size >= 3) byPlane.set(cellPlane, [...onPlane.keys()]);
  }
  const caps = [];
  for (const [cellPlane, points] of byPlane) {
    const n = [...cellPlane.plane.normal].map(v => v * (cellPlane.side === -1 ? 1 : -1)); // cap faces away from the cell interior
    // Section polygons of the formal assets are star-shaped w.r.t. their centroid
    // (barrel quadrant/band sections); angular order reproduces the boundary walk.
    const helper = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = normalize(cross(n, helper)), v = cross(n, u);
    const centroid = [0, 0, 0];
    for (const p of points) { const q = local.p(p); for (let k = 0; k < 3; k++) centroid[k] += q[k] / points.length; }
    const polygon = [...points].sort((a, b) => {
      const pa = local.p(a), pb = local.p(b);
      const aa = Math.atan2(dot(pa, v) - dot(centroid, v), dot(pa, u) - dot(centroid, u));
      const ab = Math.atan2(dot(pb, v) - dot(centroid, v), dot(pb, u) - dot(centroid, u));
      return aa - ab;
    });
    for (const t of earClipInPlane(local, polygon, n)) caps.push(t);
  }
  return caps;
}
function earClipInPlane(local, indices, n) {
  const helper = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const basisU = normalize(cross(n, helper)), basisV = cross(n, basisU);
  let pts = indices.map(i => { const p = local.p(i); return { i, x: dot(p, basisU), y: dot(p, basisV) }; });
  // Drop near-duplicates and collinear runs so dense clip boundaries stay ear-clippable.
  const simplified = [];
  for (const p of pts) {
    const last = simplified[simplified.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-7) continue;
    simplified.push(p);
  }
  pts = simplified;
  for (let guard = 0; guard < pts.length * 2 && pts.length > 3; guard++) {
    let changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const scale = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) || 1;
      if (Math.abs(cross2) < 1e-9 * scale * scale) { pts.splice(i, 1); changed = true; break; }
    }
    if (!changed) break;
  }
  const area = pts.reduce((acc, p, k) => { const q = pts[(k + 1) % pts.length]; return acc + p.x * q.y - q.x * p.y; }, 0) / 2;
  const list = area >= 0 ? [...pts] : [...pts].reverse();
  const crosses = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const contains = (a, b, c, p) => {
    const d1 = crosses(a, b, p), d2 = crosses(b, c, p), d3 = crosses(c, a, p);
    const eps = 1e-9;
    return !((d1 < -eps || d2 < -eps || d3 < -eps) && (d1 > eps || d2 > eps || d3 > eps));
  };
  const tris = [];
  let guard = list.length * list.length + 100;
  while (list.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[(i + list.length - 1) % list.length], b = list[i], c = list[(i + 1) % list.length];
      if (crosses(a, b, c) <= 1e-12) continue;
      if (list.some(p => p !== a && p !== b && p !== c && contains(a, b, c, p))) continue;
      tris.push([a.i, b.i, c.i]);
      list.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (list.length === 3) {
    const [a, b, c] = list;
    if (crosses(a, b, c) > 1e-12) tris.push([a.i, b.i, c.i]);
  }
  if (list.length > 3) throw new Error('planar ear clipping stalled on ' + list.length + ' points');
  return tris;
}

function buildChunkCommon(local, outer, key, edgeGroup, triangulateGroup) {
  const rep = new Map();
  const representative = i => {
    const k = positionKey(local, i);
    if (!rep.has(k)) rep.set(k, i);
    return rep.get(k);
  };
  const canon = outer.map(t => t.map(representative));
  const caps = closeResidualEdges(local, canon, capBoundary(local, canon, edgeGroup, triangulateGroup));
  return { key, local, triangles: [...canon, ...caps], outerTriangles: canon.length, capTriangles: caps.length };
}

function capBoundary(local, outer, edgeGroup, triangulateGroup) {
  // Directed edge census: a manifold interior edge appears once per orientation;
  // exactly-one-direction edges are the open boundary with correct winding.
  const directed = new Map();
  for (const t of outer) for (const e of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
    const k = e[0] + ':' + e[1];
    directed.set(k, (directed.get(k) ?? 0) + 1);
  }
  const undirected = new Map();
  for (const [k, c] of directed) {
    if (c > 1) continue;
    const [a, b] = k.split(':').map(Number);
    if (directed.get(b + ':' + a)) continue; // interior pair
    const uk = a < b ? a + ':' + b : b + ':' + a;
    undirected.set(uk, (undirected.get(uk) ?? 0) + 1);
  }
  const open = [...directed.entries()].filter(([k, c]) => c === 1 && (() => { const [a, b] = k.split(':').map(Number); return !directed.has(b + ':' + a); })()).map(([k]) => k.split(':').map(Number));
  if (open.length === 0) return [];
  // Pinch hubs host several boundary strands; duplicate the hub per strand so each
  // chained loop stays simple (copies share the position key, keeping the census valid).
  const groups = new Map();
  for (const edge of open) {
    const g = edgeGroup(edge);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(edge);
  }
  if (process.env.FRACTURE_DEBUG) console.error('capBoundary open', open.length, 'groups', [...groups.keys()].map(k => k === 'fan' ? 'fan' : 'plane'));
  const caps = [];
  for (const [group, edges] of groups) {
    if (process.env.FRACTURE_DEBUG) console.error('group', group === 'fan' ? 'fan' : 'plane', 'edges', edges.length);
    for (const loop of chainLoops(edges, local)) {
      if (process.env.FRACTURE_DEBUG) console.error(' loop len', loop.length);
      const tris = triangulateGroup(loop, group !== 'fan' ? group : null);
      if (process.env.FRACTURE_DEBUG) console.error(' tris', tris.length);
      caps.push(...tris);
    }
  }
  return caps;
}

/** Final sweep for pinch residues: fan any still-open edges around their centroid. */
function closeResidualEdges(local, outer, caps) {
  const directed = new Map();
  for (const t of [...outer, ...caps]) for (const e of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) directed.set(e[0] + ':' + e[1], (directed.get(e[0] + ':' + e[1]) ?? 0) + 1);
  const open = [...directed.entries()].filter(([k, c]) => c === 1 && !directed.has(k.split(':').map(Number).reverse().join(':'))).map(([k]) => k.split(':').map(Number));
  if (open.length === 0) return caps;
  const centroid = [0, 0, 0];
  for (const [a, b] of open) { const pa = local.p(a), pb = local.p(b); for (let k = 0; k < 3; k++) centroid[k] += (pa[k] + pb[k]) / (open.length * 2); }
  const normal = [0, 0, 0];
  for (const [a, b] of open) { const cr = cross(sub(local.p(b), local.p(a)), sub(centroid, local.p(a))); for (let k = 0; k < 3; k++) normal[k] += cr[k]; }
  if (Math.hypot(...normal) < 1e-9) for (const [a, b] of open) for (const v of [a, b]) for (let k = 0; k < 3; k++) normal[k] += local.n(v)[k] / (open.length * 2);
  const center = local.add(centroid, normalize(normal.length ? normal : [0, 1, 0]), [0, 0], local.j(open[0][0]), local.w(open[0][0]));
  const extra = open.map(([a, b]) => [a, b, center]);
  return [...caps, ...extra];
}

function chainLoops(edges, local) {
  const byVertex = new Map();
  for (const [a, b] of edges) {
    if (!byVertex.has(a)) byVertex.set(a, []);
    byVertex.get(a).push(b);
  }
  const loops = [];
  const used = new Set();
  for (const [a, b] of edges) {
    const key = a + ':' + b;
    if (used.has(key)) continue;
    const loop = [a];
    let cur = a, next = b;
    while (true) {
      used.add(cur + ':' + next);
      loop.push(next);
      const candidates = (byVertex.get(next) ?? []).filter(n => !used.has(next + ':' + n));
      if (candidates.length === 0) break;
      [cur, next] = [next, candidates[0]];
      if (next === loop[0]) { used.add(cur + ':' + next); break; }
    }
    // A loop that revisits a vertex is a figure-8 through a pinch: split it there
    // so each fan cap stays on one strand.
    const split = [];
    let current = [];
    const seenInLoop = new Set();
    for (const v of loop) {
      if (seenInLoop.has(v) && current.length > 1) { split.push(current); current = [v]; seenInLoop.clear(); seenInLoop.add(v); continue; }
      current.push(v);
      seenInLoop.add(v);
    }
    if (current.length > 1) split.push(current);
    loops.push(...split.filter(seg => seg.length >= 3));
  }
  return loops.filter(loop => loop.length >= 3 && loop[loop.length - 1] === loop[0] || loop.length >= 3);
}

function classifyPlanarEdge(local, edge, cellPlanes) {
  for (const cellPlane of cellPlanes) {
    const plane = cellPlane.plane;
    const onPlane = edge.every(v => Math.abs(sideValue(local, v, plane)) <= 1e-5);
    if (onPlane) return cellPlane;
  }
  return 'fan';
}

function earClipPlanar(local, loop, plane) {
  const n = plane.plane.normal;
  // Build 2D basis on the plane.
  const helper = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(n, helper)), v = cross(n, u);
  const pts = loop.slice(0, -1).map(i => { const p = local.p(i); return { i, x: dot(p, u), y: dot(p, v) }; });
  const area = polygonArea(pts);
  const desired = plane.side === -1 ? 1 : -1; // cap faces away from the cell interior
  let list = area * desired > 0 ? pts : [...pts].reverse();
  const tris = [];
  const crosses = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const contains = (a, b, c, p) => {
    const d1 = crosses(a, b, p), d2 = crosses(b, c, p), d3 = crosses(c, a, p);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  let guard = list.length * list.length + 100;
  while (list.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[(i + list.length - 1) % list.length], b = list[i], c = list[(i + 1) % list.length];
      if (crosses(a, b, c) <= 1e-12) continue;
      if (list.some(p => p !== a && p !== b && p !== c && contains(a, b, c, p))) continue;
      tris.push([a.i, b.i, c.i]);
      list.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (list.length === 3) tris.push([list[0].i, list[1].i, list[2].i]);
  else if (list.length > 3) throw new Error('ear clipping stalled on ' + list.length + ' points');
  return tris;
}

function fanClip3D(local, loopInput) {
  const loop = loopInput[loopInput.length - 1] === loopInput[0] ? loopInput.slice(0, -1) : loopInput;
  const centroidP = [0, 0, 0], centroidN = [0, 0, 0], centroidUV = [0, 0];
  for (const i of loop) {
    const p = local.p(i), n = local.n(i), t = local.t(i);
    for (let k = 0; k < 3; k++) { centroidP[k] += p[k] / loop.length; centroidN[k] += n[k] / loop.length; }
    centroidUV[0] += t[0] / loop.length; centroidUV[1] += t[1] / loop.length;
  }
  const joints = new Array(4).fill(0), weights = new Array(4).fill(0);
  if (local.weights.length) {
    const byJoint = new Map();
    for (const i of loop) {
      const js = local.j(i), ws = local.w(i);
      for (let k = 0; k < 4; k++) if (ws[k] > 0) byJoint.set(js[k], (byJoint.get(js[k]) ?? 0) + ws[k] / loop.length);
    }
    const top = [...byJoint.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((acc, [, w]) => acc + w, 0) || 1;
    top.forEach(([j, w], k) => { joints[k] = j; weights[k] = w / sum; });
    for (let k = top.length; k < 4; k++) joints[k] = top[0][0];
  }
  const nl = Math.hypot(...centroidN) || 1;
  const center = local.add(centroidP, [centroidN[0] / nl, centroidN[1] / nl, centroidN[2] / nl], centroidUV, local.weights.length ? joints : null, local.weights.length ? weights : null);
  // Orient the fan so triangles face along the average boundary normal (outward cut face).
  const a = local.p(loop[0]), b = local.p(loop[1]);
  const e1 = sub(b, a), e2 = sub(centroidP, a);
  const nrm = normalize(cross(e1, e2));
  const tris = [];
  for (let i = 0; i < loop.length; i++) tris.push([loop[i], loop[(i + 1) % loop.length], center]);
  const t0 = tris[0];
  const tn = triangleNormal(local.p(t0[0]), local.p(t0[1]), local.p(t0[2]));
  if (dot(tn, nrm) < 0) return tris.map(t => [t[0], t[2], t[1]]);
  return tris;
}

// ---------------------------------------------------------------- stats

export function chunkStats(local, triangles) {
  const aabb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < local.positions.length / 3; i++) {
    const p = local.p(i);
    for (let k = 0; k < 3; k++) { aabb.min[k] = Math.min(aabb.min[k], p[k]); aabb.max[k] = Math.max(aabb.max[k], p[k]); }
  }
  let volume = 0, area = 0, degenerate = 0;
  const edgeCount = new Map();
  const keyOf = i => { const q = v => Math.round(v * 1e6); return q(local.positions[i * 3]) + ',' + q(local.positions[i * 3 + 1]) + ',' + q(local.positions[i * 3 + 2]); };
  for (const t of triangles) {
    const [a, b, c] = t.map(i => local.p(i));
    const cr = cross(sub(b, a), sub(c, a));
    const triArea = Math.hypot(...cr) / 2;
    if (!(triArea > 1e-12)) degenerate++;
    area += triArea;
    volume += dot(a, cross(b, c)) / 6;
    const keys = t.map(keyOf);
    for (const e of [[keys[0], keys[1]], [keys[1], keys[2]], [keys[2], keys[0]]]) {
      const k = e[0] < e[1] ? e[0] + '|' + e[1] : e[1] + '|' + e[0];
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
  }
  }
  let boundary = 0, nonmanifold = 0;
  for (const c of edgeCount.values()) { if (c === 1) boundary++; if (c > 2) nonmanifold++; }
  const centroid = [0, 0, 0];
  const total = local.positions.length / 3;
  for (let i = 0; i < total; i++) { const p = local.p(i); for (let k = 0; k < 3; k++) centroid[k] += p[k] / total; }
  return { aabb, volume: Math.abs(volume), area, degenerate, boundary, nonmanifold, centroid, vertices: total, triangles: triangles.length };
}

function finalizeChunk(local, outer, caps, key) {
  return { key, local, triangles: [...outer, ...caps], outerTriangles: outer.length, capTriangles: caps.length };
}

// ---------------------------------------------------------------- small math

export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const normalize = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const triangleNormal = (a, b, c) => normalize(cross(sub(b, a), sub(c, a)));
const polygonArea = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y; } return s / 2; };
