/** Reproducible authored acceptance scene and asset-default bindings. */
import { readFileSync, writeFileSync } from 'node:fs';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const library = { path: 'assets/animations/mixamo/shared.motion.json', guid: 'as_mixamo_shared_motion' };
const binding = (profile, state = 'idle') => ({ library, profile, defaultState: state, speed: 1 });
const manifest = read('assets/_data/asset-manifest.json');
for (const c of manifest.characters) {
  for (const lod of c.lods.filter(l => l.label.includes('+骨骼'))) {
    const p = `assets/${lod.file}.meta.json`, meta = read(p);
    meta.sharedMotion = binding(c.kind === 'player' ? 'player' : 'npc'); write(p, meta);
  }
}
const h01 = 'assets/characters/models/H-01/rigged/H01_SCAVENGER_LOD0_animation_ready.glb';
const hmeta = read(`${h01}.meta.json`); hmeta.sharedMotion = binding('player'); write(`${h01}.meta.json`, hmeta);
const base = read('assets/scenes/sandbox/default.scene.json');
const floor = read('assets/scenes/act1/floor-1.scene.json');
const scene = structuredClone(base);
scene.schemaVersion = 11; scene.id = 'sc_shared_motion_runtime'; scene.name = 'Shared Motion · Runtime Retarget';
scene.entryCamera = null; scene.playerStart = 'nd_motion_player'; scene.dependencies = [];
scene.editorCamera = { target: [0, 1, 0], distance: 9, yaw: .12, elevation: .22 };
scene.nodes = base.nodes.filter(n => ['nd_key0000', 'nd_ground0000'].includes(n.id));
scene.nodes.find(n => n.id === 'nd_ground0000').components[0].materials[0].material.id = 's1';
scene.environment.fog.density = 0;
const model = (id, name, path, pos, player = false) => {
  const n = structuredClone(floor.nodes.find(n => n.id === floor.playerStart));
  n.id = id; n.name = name; n.transform.position = pos;
  const mesh = n.components[0]; mesh.source.ref = { path, guid: read(`${path}.meta.json`).guid };
  delete mesh.playBinding; if (player) mesh.playBinding = 'player';
  mesh.sharedMotion = binding('player', player ? 'idle' : 'walk');
  return n;
};
scene.nodes.push(model('nd_motion_player', 'Player · 清道夫 LOD0 · 27 bones', h01, [0, 0, 2.5], true));
scene.nodes.push(model('nd_motion_h01', '清道夫 · 同一 Walking · 27 bones', h01, [-2.8, 0, 0]));
for (const [id, x] of [['E-01', 0], ['E-04', 2.8]]) {
  const c = manifest.characters.find(c => c.id === id), lod = c.lods.find(l => l.label.includes('+骨骼'));
  scene.nodes.push(model(`nd_motion_${id}`, `${c.name} · 同一 Walking · 22 bones`, `assets/${lod.file}`, [x, 0, 0]));
}
const room = structuredClone(floor.nodes.find(n => n.id === 'nd_f1r0'));
room.id = 'nd_motion_room'; room.name = 'Runtime NPC test room'; room.transform.position = [0, 0, 0];
room.components = room.components.filter(c => c.kind === 'RoomVolume');
room.components[0].bounds = { center: [0, 0, 0], size: [30, 4, 20] }; scene.nodes.push(room);
const nav = structuredClone(floor.nodes.find(n => n.components.some(c => c.kind === 'NavZone')));
nav.id = 'nd_motion_nav'; nav.transform.position = [0, 0, 0]; nav.components[0].bounds = { center: [0, 0, 0], size: [30, 4, 20] }; scene.nodes.push(nav);
for (const [id, x] of [['E-01', -5], ['E-04', 5]]) {
  const spawn = structuredClone(floor.nodes.find(n => n.components.some(c => c.kind === 'SpawnPoint')));
  spawn.id = `nd_motion_spawn_${id}`; spawn.parent = room.id; spawn.name = `Shared NPC · ${id}`;
  spawn.transform.position = [x, 0, -4]; spawn.components = spawn.components.filter(c => c.kind === 'SpawnPoint');
  Object.assign(spawn.components[0], { characterId: id, count: 1, radius: .1, delaySec: 8 }); scene.nodes.push(spawn);
}
scene.meta.notes = 'Three target rigs reuse one Walking source. WASD controls the LOD0 player; J fires with Shoot Rifle. Runtime NPCs use the shared NPC profile. Stop restores authored animation state.';
const path = 'assets/scenes/sandbox/shared-motion-runtime.scene.json'; write(path, scene);
const project = read('aether.project.json');
if (!project.scenes.some(s => s.id === scene.id)) project.scenes.push({ path, id: scene.id, name: scene.name, enabled: true });
write('aether.project.json', project);
console.log(path);
