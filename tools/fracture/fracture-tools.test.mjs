import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GlbBuilder, readGlb, weldByPosition } from './glb-io.mjs';
import { VertexPool, chunkStats } from './split-core.mjs';

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
  // Write to a temp file so readGlb can parse the real container layout.
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

test('weldByPosition merges seam duplicates and keeps attributes of the first vertex', () => {
  const mesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0]),
    normals: new Float32Array([...Array(12)].map(() => 1)),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 9, 9]),
    joints: null, weights: null,
    indices: new Uint32Array([0, 1, 2, 3, 1, 2]),
  };
  const welded = weldByPosition(mesh);
  assert.equal(welded.positions.length / 3, 3);
  assert.equal(welded.uvs[2], 1);
  assert.deepEqual([...welded.indices], [0, 1, 2, 1, 1, 2]);
});

test('chunkStats reports closed unit cube', () => {
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
  assert.ok(Math.abs(stats.volume - 1) < 1e-9);
});
