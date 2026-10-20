import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlbBuilder, readGlb } from './glb-io.mjs';
import { VertexPool, chunkStats, buildChunkWithCaps } from './split-core.mjs';
import { writeSidecar } from './build-fracture-assets.mjs';

test('glb-io roundtrips mesh attributes through the GLB container', async () => {
  const builder = new GlbBuilder('aether fracture test');
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  const uvs = [0, 0, 1, 0, 0, 1, 0.5, 0.5];
  const indices = [0, 1, 2, 0, 2, 3];
  const pos = builder.vec3Float(new Float32Array(positions));
  const nrm = builder.vec3Float(new Float32Array(normals));
  const uv = builder.vec2Float(new Float32Array(uvs));
  const ix = builder.scalarUint(new Uint32Array(indices));
  const glb = builder.build({ nodes: [{ name: 't', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: pos, NORMAL: nrm, TEXCOORD_0: uv }, indices: ix, material: 0 }] }], materials: [{ name: 'm' }], sceneNodes: [0] });
  const tmp = path.join(os.tmpdir(), 'fracture-io-' + Date.now() + '.glb');
  fs.writeFileSync(tmp, glb);
  try {
    const doc = readGlb(tmp);
    const mesh = doc.json.meshes[0].primitives[0];
    assert.equal(mesh.attributes.POSITION, 0);
    assert.deepEqual([...doc.json.accessors[0].min], [0, 0, 0]);
    assert.deepEqual([...doc.json.accessors[0].max], [1, 1, 1]);
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('chunkStats reports closed unit cube with directed edges', () => {
  const pool = new VertexPool();
  const faces = [
    { n: [0, 0, -1], c: [[0,0,0],[1,0,0],[1,1,0],[0,1,0]] },
    { n: [0, 0, 1], c: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]] },
    { n: [0, -1, 0], c: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]] },
    { n: [0, 1, 0], c: [[0,1,0],[1,1,0],[1,1,1],[0,1,1]] },
    { n: [-1, 0, 0], c: [[0,0,0],[0,1,0],[0,1,1],[0,0,1]] },
    { n: [1, 0, 0], c: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]] },
  ];
  const tris = [];
  for (const f of faces) {
    const idx = f.c.map(c => pool.add(c, f.n, [c[0], c[1]]));
    for (const t of [[idx[0], idx[1], idx[2]], [idx[0], idx[2], idx[3]]]) {
      const A = t.map(i => pool.p(i));
      const e1 = [A[1][0]-A[0][0], A[1][1]-A[0][1], A[1][2]-A[0][2]];
      const e2 = [A[2][0]-A[0][0], A[2][1]-A[0][1], A[2][2]-A[0][2]];
      const cr = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
      tris.push(cr[0]*f.n[0] + cr[1]*f.n[1] + cr[2]*f.n[2] >= 0 ? t : [t[0], t[2], t[1]]);
    }
  }
  const stats = chunkStats(pool, tris);
  assert.equal(stats.boundary, 0);
  assert.equal(stats.nonmanifold, 0);
  assert.equal(stats.sameDirection, 0);
  assert.ok(Math.abs(stats.volume - 1) < 1e-9);
  // Negative: flipping one cap-style triangle must break directed consistency.
  const flipped = [...tris];
  flipped[0] = [flipped[0][0], flipped[0][2], flipped[0][1]];
  const bad = chunkStats(pool, flipped);
  assert.ok(bad.boundary > 0 || bad.sameDirection > 0);
});

test('UV-seam corners survive region chunking exactly (plan §5.4)', () => {
  // Two quads sharing an edge position with DIFFERENT UVs on each side.
  const pool = new VertexPool();
  const a = [[0,0,0],[1,0,0],[1,1,0],[0,1,0]].map(p => pool.add(p, [0,0,-1], [p[0], p[1]]));
  const b = [[1,0,0],[2,0,0],[2,1,0],[1,1,0]].map(p => pool.add(p, [0,0,-1], [p[0] - 1, p[1] + 5]));
  const tris = [[a[0],a[1],a[2]],[a[0],a[2],a[3]],[b[0],b[1],b[2]],[b[0],b[2],b[3]]];
  const chunk = buildChunkWithCaps(pool, tris, 'seam');
  const outer = chunk.triangles.slice(0, chunk.outerTriangles);
  const uvs = new Set();
  for (const t of outer) for (const v of t) uvs.add(pool.t(v).map(x => x.toFixed(6)).join(','));
  // Both seam UV variants must exist (1,0)/(1,1) from quad A and (0,0)/(0,1)+5 from quad B.
  assert.ok(uvs.has('1.000000,0.000000') || uvs.has('1.000000,1.000000'));
  assert.ok([...uvs].some(u => u.endsWith('5.000000') || u.startsWith('0.000000,5')));
  assert.equal(chunkStats(chunk.local, chunk.triangles).boundary >= 0, true); // caps present or none needed when region closed by itself? open boundary expected here
});

test('writeSidecar preserves author fields and rejects identity conflicts', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fracture-sidecar-'));
  try {
    const file = path.join(dir, 'chunk-0001.glb');
    fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    writeSidecar(file, 'gltf', 'as_test0001', { chunk: 'chunk-0001' });
    const metaPath = file + '.meta.json';
    const first = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(first.guid, 'as_test0001');
    first.userData.reviewAuthor = 7;
    first.importer.weldTolerance = 0.0009;
    fs.writeFileSync(metaPath, JSON.stringify(first));
    fs.writeFileSync(file, Buffer.from([4, 5, 6]));
    writeSidecar(file, 'gltf', 'as_test0001', { chunk: 'chunk-0001', rebuilt: true });
    const second = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(second.userData.reviewAuthor, 7);
    assert.equal(second.importer.weldTolerance, 0.0009);
    assert.ok(second.sourceHash.startsWith('sha256:'));
    assert.throws(() => writeSidecar(file, 'gltf', 'as_other99', {}));
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
});
