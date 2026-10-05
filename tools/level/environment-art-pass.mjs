/** Offline authoring pass. Persisted scene JSON remains the runtime's sole input.
 * Keeps gameplay node identities/room contracts; only authored scenery and lighting change.
 */
import fs from 'node:fs';
import path from 'node:path';

export function applyEnvironmentArtPass(doc, root) {
  const depth = Number(/floor(\d+)/.exec(doc.id)?.[1]);
  if (![1, 2, 3].includes(depth)) throw new Error(`Unsupported art-pass scene ${doc.id}`);
  const props = JSON.parse(fs.readFileSync(path.join(root, 'assets/environment/props.json'), 'utf8')).entries;
  const prefix = `nd_f${depth}`;
  const find = id => { const n = doc.nodes.find(n => n.id === id); if (!n) throw new Error(`Missing author node ${id}`); return n; };
  const mesh = n => n.components.find(c => c.kind === 'MeshRenderer');
  const patch = (color, extra = {}) => [{ match: { by: 'index', value: 0 }, material: {
    type: 'override', base: { type: 'shared', id: 's1' },
    patch: { albedo: color, roughness: 0.94, metallic: 0, outlineScale: 0.18, halftoneScale: 0.18, specMix: 0, ...extra },
  } }];
  function place(id, propId, x, z, yaw = 0, { lod = 2, solid = false, parent, name } = {}) {
    const prop = props.find(p => p.id === propId);
    if (!prop) throw new Error(`Unknown prop ${propId}`);
    const file = `assets/environment/models/${propId}/tex2/${propId}_${lod === 1 ? 'baked' : 'lod2'}.glb`;
    const meta = JSON.parse(fs.readFileSync(path.join(root, `${file}.meta.json`), 'utf8'));
    let n = doc.nodes.find(n => n.id === id);
    if (!n) { n = { id, name: '', parent: parent ?? null, prefab: null, visible: true, pickable: true, transform: {}, components: [] }; doc.nodes.push(n); }
    if (parent !== undefined) n.parent = parent;
    n.name = name ?? `${propId} · ${prop.name}`;
    n.category = propId.startsWith('S') ? '建筑' : '道具';
    // Parent room floors sit at -0.1; all delivered GLBs have baseY=0 metres.
    const floorY = n.parent ? find(n.parent).transform.position[1] : 0;
    n.transform = { position: [x, -floorY, z], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], scale: [1, 1, 1] };
    n.components = [{ kind: 'MeshRenderer', enabled: true, source: { type: 'asset', ref: { path: file, guid: meta.guid } },
      materials: patch('#ffffff', { outlineScale: propId.startsWith('S') ? 0.3 : 0.45, halftoneScale: 0.12 }),
      visible: true, layer: 0, importScale: 1, aoMin: 0, aoMax: Math.min(0.65, prop.footprint[2] * 0.35) }];
    if (solid) {
      const [w, d, h] = prop.footprint;
      n.components.push({ kind: 'Collider', enabled: true, shape: { type: 'box', halfExtents: [w / 2, h / 2, d / 2] }, isTrigger: false, layer: 0 });
    }
    return n;
  }
  function roomProp(room, suffix, prop, x, z, yaw = 0, opts = {}) {
    return place(`${prefix}r${room}_${suffix}`, prop, x, z, yaw, { parent: `${prefix}r${room}`, ...opts });
  }

  // Remove only redundant decorative lane dashes; no cross-node reference targets.
  // This frees draw/object slots for meaningful scenery without raising the engine cap.
  doc.nodes = doc.nodes.filter(n => !/_lane_[13]$/.test(n.id));
  for (const n of doc.nodes) {
    const m = mesh(n); if (!m || m.source.type !== 'builtin') continue;
    if (n.id.endsWith('_void')) m.materials = patch(depth === 1 ? '#566f75' : '#4c536b', { outlineScale: 0 });
    else if (n.id.endsWith('_street') || /^nd_f\dr\d$/.test(n.id) || /^nd_f\dc\d$/.test(n.id)) {
      m.materials = patch(depth === 1 ? '#7d8885' : '#747e89', { outlineScale: 0 });
    } else if (n.id.includes('_walk_')) m.materials = patch('#898c84', { outlineScale: 0.15 });
    else if (n.id.includes('_lane_') || n.id.includes('_crosswalk_') || n.id.includes('_edge_')) {
      m.materials = patch(n.id.includes('_lane_') ? '#d6b66a' : '#beb9a3', { outlineScale: 0, halftoneScale: 0.1 });
      // Paint sits 15 mm above the road, rather than reading as raised yellow blocks.
      m.source.params[1] = 0.012;
      n.transform.position[1] = n.parent ? 0.115 : 0.015;
    }
  }

  if (depth === 1) {
    doc.name = '第一层 · 火场公路';
    // Accident approach → gas-station respite → fortified toll checkpoint.
    roomProp(0, 'building_-1', 'S-02', 0, -13.5, 0, { lod: 1, name: '破窗便利店 · 事故街口' });
    roomProp(0, 'building_1', 'P-12', 1, 10.3, 0.1, { name: '废弃货车 · 路肩' });
    roomProp(1, 'building_-1', 'S-02', -8, -13, 0, { lod: 1, name: '便利店 · 补给地标' });
    // Tall roofs belong behind the play lane; foreground roofs hid the supply approach.
    roomProp(1, 'building_1', 'S-01', 7, -14, 0, { lod: 1, name: '加油站雨棚 · 避难区' });
    roomProp(2, 'building_-1', 'P-15', 3, -11, Math.PI, { name: '出口广告牌' });
    roomProp(2, 'building_1', 'P-16', 8, 7.3, Math.PI / 2, { solid: true, name: '收费岗亭 · 封锁口' });
    roomProp(0, 'cv0', 'P-11', -4.2, -4.8, 0.17, { lod: 1, solid: true });
    roomProp(0, 'cv1', 'P-02', 7, 5.5, -0.12, { solid: true });
    roomProp(0, 'cv2', 'P-04', -4.8, 4.9, 0.08, { solid: true });
    roomProp(2, 'cv0', 'P-06', -5.2, -4.8, 0.15, { solid: true });
    roomProp(2, 'cv1', 'P-03', 6.5, 4.8, -0.12, { solid: true });
    roomProp(2, 'cv2', 'P-05', -5.3, 4.8, 0, { solid: true });
    roomProp(1, 'supply', 'P-14', 0, -3, 0, { lod: 1, name: '补给泵 · 按 E 领取并购买补给' });
    roomProp(0, 'barrel', 'P-01', -0.8, -6.5, 0.3, { solid: true });
    roomProp(0, 'guardrail', 'P-13', -6, -8.6, 0);
    roomProp(1, 'pump', 'P-14', 8, -8.4, 0);
    roomProp(1, 'crates', 'P-04', -4.9, -6.1, -0.2, { solid: true });
    roomProp(2, 'barrel', 'P-01', 7.8, -5.3, 0, { solid: true });
    roomProp(2, 'guardrail', 'P-13', 5.5, -8.5, 0);
    roomProp(2, 'checkpoint', 'P-02', 9, -4.5, 0, { solid: true });
    doc.editorCamera = { target: [16, 0, 0], distance: 38, yaw: 0.65, elevation: 0.9 };
  } else if (depth === 2) {
    doc.name = '第二层 · 尸潮仓储区';
    roomProp(0, 'building_-1', 'S-03', 0, -26, 0, { name: '仓库外壳 · 装卸场背景' });
    roomProp(0, 'building_1', 'P-26', -2, 11.5);
    roomProp(1, 'building_-1', 'S-04', 0, -12, Math.PI);
    roomProp(1, 'building_1', 'P-25', 1, 9, 0);
    roomProp(2, 'building_-1', 'P-22', -5, -10, Math.PI);
    roomProp(2, 'building_1', 'P-21', 4, 11, Math.PI);
    roomProp(0, 'cv0', 'P-23', -5.5, -4.8, 0.1, { solid: true, lod: 1 });
    roomProp(0, 'cv1', 'P-21', 6, 5, 0, { solid: true });
    roomProp(0, 'cv2', 'P-04', -6, 4.8, 0, { solid: true });
    roomProp(2, 'cv0', 'P-24', -5.2, -6, 0, { solid: true });
    roomProp(2, 'cv1', 'P-26', 7, 6, 0, { solid: true });
    roomProp(2, 'cv2', 'P-06', -6, 5.5, 0, { solid: true });
    roomProp(1, 'supply', 'P-04', 0, -3, 0, { name: '物资托盘 · 按 E 开启补给' });
  } else {
    doc.name = '第三层 · 暗巷撤离站';
    roomProp(0, 'building_-1', 'S-05', 0, -15, 0, { name: '封闭隧道 · 远侧边界' });
    roomProp(0, 'building_1', 'S-06', 9, 13, 0, { name: '撤离站台' });
    roomProp(1, 'building_-1', 'S-07', 6, -17, Math.PI, { name: '临时隔离病房' });
    roomProp(1, 'building_1', 'S-08', 8, 17, 0);
    roomProp(0, 'cv0', 'P-34', -6.5, -6, 0, { solid: true });
    roomProp(0, 'cv1', 'P-35', 7, 6, 0, { solid: true });
    roomProp(0, 'cv2', 'P-36', -6, 6, 0, { solid: true });
    roomProp(1, 'cv0', 'P-41', -10, -7, 0, { solid: true });
    roomProp(1, 'cv1', 'P-44', 10, 8, 0.2, { solid: true });
    roomProp(1, 'cv2', 'P-45', -10, 7, 0, { solid: true, lod: 1 });
    roomProp(1, 'cv3', 'P-46', 10, -8, 0, { solid: true });
    roomProp(0, 'track', 'P-31', 0, -10.3);
    roomProp(0, 'carriage', 'P-32', 5, -11.8);
    roomProp(0, 'cable', 'P-33', -7, -8.5);
    roomProp(1, 'iv', 'P-42', -10.8, -8.6);
    roomProp(1, 'wheelchair', 'P-43', 10, 9.5);
  }

  const warm = depth === 1;
  const key = find(`${prefix}_key`).components.find(c => c.kind === 'Light');
  key.color = warm ? '#ffe6c2' : '#d8e4fa'; key.intensity = 1.1;
  // Low side key retains visible shadow planes from the authored god-view camera.
  const azimuth = 125 * Math.PI / 180, elevation = 30 * Math.PI / 180;
  const dir = [Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth)];
  const qw = Math.sqrt((1 + dir[1]) / 2);
  find(`${prefix}_key`).transform.rotation = [dir[2] / (2 * qw), 0, -dir[0] / (2 * qw), qw];
  doc.environment = { ...doc.environment,
    ambient: { color: '#737b9c', intensity: 0.28 },
    hemisphere: { sky: '#9ebcdb', skyIntensity: 0.42, ground: '#5e536e', groundIntensity: 0.2 },
    fog: { color: warm ? '#81949c' : '#667899', density: 0.008, heightFalloff: 0.1 },
    rim: { color: '#9bdbe0', intensity: 0.3, power: 3, topBias: 0.45 }, exposure: 0.9,
    sky: { zenith: warm ? '#364662' : '#292e50', horizon: warm ? '#dbb695' : '#8a92ad',
      ground: warm ? '#425566' : '#373e58', cloud: '#d6cbbb', cloudCoverage: 0.54, cloudScale: 1.7,
      cloudSpeed: 0.002, sunColor: '#ffe3a0', sunDirection: dir, sunSize: 0.065 },
    comic: { tonemapMode: 2, contactShadowOpacity: 0.45, outlineWidth: 1.6, inkColor: '#14110f', shadowMult: 0.72, shadowMix: 0.2, shadowTint: '#30283e',
      litSat: 1.08, halftoneStrength: 0.18, halftoneSize: 5, vignette: 0.04 },
  };
  const point = find(`${prefix}_beacon`).components.find(c => c.kind === 'Light');
  point.enabled = true; point.intensity = 2.4; point.range = 11; point.color = warm ? '#ffc06b' : '#6ce0cb';
  const camera = find(`${prefix}_cam`).components.find(c => c.kind === 'Camera');
  camera.distance = 24; camera.pitchDeg = 52; camera.yawOffsetDeg = -15;
  for (const n of doc.nodes) {
    if (!(n.id.endsWith('_street') || /^nd_f[123][rc]\d$/.test(n.id))) continue;
    const m = mesh(n);
    const dims = m.source.type === 'builtin' ? [m.source.params[0], m.source.params[2]]
      : /asphalt-(\d+)x(\d+)/.exec(m.source.ref.path)?.slice(1).map(Number);
    if (!dims) throw new Error(`Missing road dimensions: ${n.id}`);
    if (n.id.endsWith('_street')) dims[0] = 130;
    const file = `assets/environment/models/road/synthetic/asphalt-${dims[0]}x${dims[1]}.glb`;
    const meta = JSON.parse(fs.readFileSync(path.join(root, `${file}.meta.json`), 'utf8'));
    m.source = { type: 'asset', ref: { path: file, guid: meta.guid } };
    m.materials = patch('#ffffff', { outlineScale: 0, halftoneScale: 0.1 });
    // Surface vertices are at local y=.1; preserve parent transforms and keep the
    // continuous underlay below room/corridor surfaces to avoid coplanar z-fighting.
    if (n.id.endsWith('_street')) n.transform.position[1] = -0.23;
  }
  const player = find(doc.playerStart);
  const playerMesh = mesh(player);
  const playerFile = 'assets/characters/models/H-01/textured/H01_SCAVENGER_10500tris_baked.glb';
  const playerMeta = JSON.parse(fs.readFileSync(path.join(root, `${playerFile}.meta.json`), 'utf8'));
  player.name = '玩家 · 清道夫（T-pose）';
  player.transform.position[1] = 0.02;
  playerMesh.source = { type: 'asset', ref: { path: playerFile, guid: playerMeta.guid } };
  playerMesh.playBinding = 'player';
  playerMesh.editorOnly = false;
  playerMesh.materials = patch('#ffffff', { roughness: 0.85, metallic: 0, outlineScale: 0.55, halftoneScale: 0.1 });
  const backdropFile = 'assets/environment/models/backdrop/synthetic/industrial-quarter.glb';
  const backdropMeta = JSON.parse(fs.readFileSync(path.join(root, `${backdropFile}.meta.json`), 'utf8'));
  const backdropId = `${prefix}_backdrop`;
  doc.nodes = doc.nodes.filter(n => n.id !== backdropId);
  doc.nodes.push({ id: backdropId, name: '远景街区 · 冷色剪影', parent: null, prefab: null,
    visible: true, pickable: false, category: '背景',
    transform: { position: [33, -0.4, -27], rotation: [0,0,0,1], scale: [1,1,1] },
    components: [{ kind: 'MeshRenderer', enabled: true, visible: true, layer: 0, importScale: 1,
      source: { type: 'asset', ref: { path: backdropFile, guid: backdropMeta.guid } },
      materials: patch('#ffffff', { outlineScale: 0.18, halftoneScale: 0.6, unlit: true }),
    }],
  });
  // Continue the visual road behind the entry camera without extending playable bounds.
  const street = find(`${prefix}_street`);
  street.transform.scale = [1, 1, 1];
  doc.dependencies = [...new Set(doc.nodes.flatMap(n => n.components.flatMap(c => c.kind === 'MeshRenderer' && c.source.type === 'asset' ? [c.source.ref.path] : [])))];
  const count = doc.nodes.filter(n => n.components.some(c => c.kind === 'MeshRenderer')).length;
  if (count > 64) throw new Error(`Art pass exceeds object budget: ${doc.id}: ${count}`);
  return doc;
}
