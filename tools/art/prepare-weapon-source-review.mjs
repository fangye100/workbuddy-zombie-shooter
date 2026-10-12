/** 五件原交付的源模型检视入口。只新增 sidecar/场景，不修改源 GLB 或生成 LOD。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = path.join(root, '.workbuddy/tmp/wpn-integration');
fs.mkdirSync(scratch, { recursive: true });
const bundle = path.join(scratch, 'source-review-scene.mjs');
await build({ entryPoints: [path.join(root, 'packages/scene/src/index.ts')], bundle: true,
  platform: 'node', format: 'esm', outfile: bundle, tsconfig: path.join(root, 'tsconfig.check.json') });
const { createEmptySceneDocument, createDefaultAssetMeta, validateAssetMeta, validateSceneDocument,
  validateProject, parseGlb, VERTEX_FLOATS } = await import(pathToFileURL(bundle).href);
const ids = ['WPN-07-LAUNCHER', 'WPN-MAG-01', 'WPN-MAG-02-SMG', 'WPN-SHELL-01', 'WPN-FUEL-01'];
const batch = 'assets/_delivery/WPN-20261011';
const scenePath = 'assets/scenes/sandbox/weapon-source-review.scene.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const write = (p, data) => fs.writeFileSync(path.join(root, p), JSON.stringify(data, null, 2) + '\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = process.argv.includes('--check');
function valid(label, diagnostics) {
  const errors = diagnostics.filter(d => d.severity === 'error');
  if (errors.length) throw new Error(`${label}: ${JSON.stringify(errors)}`);
}
function bounds(vertices) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += VERTEX_FLOATS) for (let k = 0; k < 3; k++) {
    const n = vertices[i + k];
    if (!Number.isFinite(n)) throw new Error('源模型存在非有限位置');
    low[k] = Math.min(low[k], n); high[k] = Math.max(high[k], n);
  }
  return high.map((v, k) => v - low[k]);
}
function inspect(id) {
  const source = `${batch}/${id}/${id}.glb`, bytes = fs.readFileSync(path.join(root, source));
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2
    || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${source}: 非完整 GLB2`);
  const jsonLength = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const primitives = json.meshes.flatMap(m => m.primitives);
  if (primitives.length !== 1 || json.skins?.length || json.animations?.length) throw new Error(`${source}: 期望单 primitive 静态源模型`);
  // 与编辑器场景装载相同 parser，显式 Y-up：应用 GLB 节点变换、居中贴底，不额外转轴/缩放。
  const model = parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), null, 'y');
  const span = bounds(model.mesh.vertices), hash = sha(bytes), sidePath = source + '.meta.json';
  const existing = fs.existsSync(path.join(root, sidePath));
  if (check && !existing) throw new Error(`${sidePath}: 缺失`);
  const meta = existing ? read(sidePath) : createDefaultAssetMeta('as_' + sha(Buffer.from(source)).slice(0, 12), 'gltf');
  if (existing && meta.sourceHash !== 'sha256:' + hash) throw new Error(`${sidePath}: 源 hash 不一致，拒绝静默修复`);
  if (!existing) {
    meta.sourceHash = 'sha256:' + hash;
    meta.userData = { assetId: id, variant: 'raw-source-review', status: 'source-review-pending',
      sourceDelivery: `${batch}/delivery.json`, sourceUnits: '未标定的生成模型单位',
      axisContract: '保留 GLB 节点变换后的 Y-up；尚未标定 +X 武器轴',
      inspectionScene: scenePath, sourceTriangles: model.triangles };
  }
  valid(sidePath, validateAssetMeta(meta));
  if (meta.importer.normalizeHeightM !== null || meta.importer.upAxisFlip) throw new Error(`${sidePath}: 源检视不能归一化或额外翻转轴`);
  const binStart = 20 + jsonLength + 8;
  const textureIndex = json.materials[primitives[0].material ?? 0].pbrMetallicRoughness.baseColorTexture.index;
  const image = json.images[json.textures[textureIndex].source], view = json.bufferViews[image.bufferView];
  const png = bytes.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength);
  if (image.mimeType !== 'image/png' || png.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${source}: 期望内嵌 PNG BaseColor`);
  if (!check && !existing) write(sidePath, meta);
  return { id, source, guid: meta.guid, sourceHash: hash, bytes: bytes.length, triangles: model.triangles,
    vertices: model.vertices, nodeRotations: json.nodes.map(n => n.rotation ?? [0, 0, 0, 1]),
    dimensionsAfterNodeTransform: span, sourceUnitStatus: 'unscaled-generated-units',
    baseColorSize: [png.readUInt32BE(16), png.readUInt32BE(20)], displayScale: 1.6 / Math.max(...span) };
}

const inspected = ids.map(inspect);
if (check) {
  const doc = read(scenePath), project = read('aether.project.json');
  valid(scenePath, validateSceneDocument(doc)); valid('aether.project.json', validateProject(project));
  if (!project.scenes.some(s => s.id === doc.id && s.path === scenePath && s.enabled)) throw new Error('检视场景未登记');
  const meshes = doc.nodes.flatMap(n => n.components.filter(c => c.kind === 'MeshRenderer'));
  if (meshes.length !== ids.length) throw new Error('检视模型数量失配');
  for (const item of inspected) {
    if (!doc.dependencies.includes(item.source) || meshes.filter(m => m.source.type === 'asset'
      && m.source.ref.path === item.source && m.source.ref.guid === item.guid).length !== 1) throw new Error(`${item.id}: 场景引用失配`);
  }
} else {
  const doc = createEmptySceneDocument('WPN-20261011 · 五件源模型检视（未验收）');
  doc.id = 'sc_weapon_source_review';
  doc.editorCamera = { target: [0, .8, 0], distance: 9, yaw: .35, elevation: .3 };
  doc.environment.fog.density = 0;
  doc.environment.ambient = { color: '#a4afbf', intensity: .45 };
  doc.environment.hemisphere = { sky: '#dbe5f1', skyIntensity: .4, ground: '#9298a2', groundIntensity: .2 };
  doc.environment.rim.intensity = .1;
  doc.environment.comic = structuredClone(read('assets/scenes/sandbox/p0-art-gallery.scene.json').environment.comic);
  doc.environment.comic.halftoneStrength = 0;
  doc.environment.comic.outlineWidth = .5;
  doc.environment.comic.vignette = 0;
  doc.nodes.find(n => n.id === doc.entryCamera).components[0] = {
    kind: 'Camera', enabled: true, mode: 'fixed', fovDeg: 45, near: .01, far: 80,
    followTarget: null, pitchDeg: 18, distance: 9, yawOffsetDeg: 20, yawMode: 'world',
  };
  inspected.forEach((item, i) => doc.nodes.push({ id: `nd_wpn_source_${i}`, name: `${item.id} · 源 ${item.triangles} tris · 展示缩放（非米制）`,
    parent: null, prefab: null, visible: true, pickable: true, category: '武器源检视',
    transform: { position: [(i - 2) * 2.3, 0, 0], rotation: [0, 0, 0, 1], scale: Array(3).fill(item.displayScale) },
    components: [{ kind: 'MeshRenderer', enabled: true, source: { type: 'asset', ref: { path: item.source, guid: item.guid } },
      materials: [{ match: { by: 'index', value: 0 }, material: { type: 'override', base: { type: 'shared', id: 's1' },
        patch: { albedo: '#ffffff', roughness: .8, metallic: 0, specMix: 0, outlineScale: .1, halftoneScale: 0 } } }],
      visible: true, layer: 4, importScale: 1 }],
  }));
  doc.dependencies = inspected.map(item => item.source);
  doc.meta.notes = '源模型目检用；保留源 GLB。展示比例不等于米制归一化、LOD或握点认证。底火端/燃料管线需独立近景；当前导入器显示 BaseColor，不认证完整 PBR。';
  valid(scenePath, validateSceneDocument(doc)); write(scenePath, doc);
  const project = read('aether.project.json');
  if (!project.scenes.some(s => s.id === doc.id)) project.scenes.push({ id: doc.id, path: scenePath, name: doc.name, enabled: true });
  valid('aether.project.json', validateProject(project)); write('aether.project.json', project);
  fs.writeFileSync(path.join(scratch, 'source-inspection.json'), JSON.stringify(inspected, null, 2) + '\n');
}
console.log(JSON.stringify({ mode: check ? 'check' : 'prepare', scenePath, inspected }, null, 2));
