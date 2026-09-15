#!/usr/bin/env node
/**
 * 关卡模拟：场景 .scene.json → headless runtime → 各时刻快照 .scene.json
 *
 * ## 这是「先做 headless」这条路的兑现点
 * 玩法逻辑完全在 packages/runtime 里跑（纯 CPU、可断言、可复现），
 * 跑完把某一帧的世界状态**导出成一份普通场景文件** —— 编辑器不用改一行代码，
 * 打开就能看到「僵尸朝玩家推进了 N 秒之后长什么样」。
 * 于是"人能看到画面"这件事不必等 Play 模式（S3）。
 *
 * ## 用法
 *   npm run sim                      # 默认跑 floor-1，导出 t=0/1/3/5s
 *   node tools/level/sim-level.mjs --floor=2 --times=0,2,5
 *
 * 产物落在 assets/scenes/sim/ 并自动登记进 aether.project.json 的 scenes[]
 * （ADR-015：没登记的场景过不了 scene:check）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { World, makeRng } = require(path.join(ROOT, '.workbuddy/tmp/runtime/index.js'));

const SIM_DIR = 'assets/scenes/sim';
const TICK = 1 / 30; // 固定步长 30Hz，与快照时刻对齐

// ---------------------------------------------------------------- 参数

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const floor = Number(arg('floor', 1));
const times = arg('times', '0,1,3,5')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const seed = Number(arg('seed', 20260915));

const srcRel = `assets/scenes/act1/floor-${floor}.scene.json`;
const src = JSON.parse(fs.readFileSync(path.join(ROOT, srcRel), 'utf8'));

// ---------------------------------------------------------------- 角色数值（真源 roster.json）

/**
 * 从 roster 解析 speed / height。
 * roster 里这两个字段是人类可读字符串（"1.4 m/s" / "1.75 m"），这里只取数值。
 * 碰撞半径 roster 没有，按体型给常数 —— 等 CharacterDef 落地（记忆里缺的 11 项）再换成真值。
 */
const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/characters/roster.json'), 'utf8'));
const statsTable = new Map();
for (const c of [...(roster.npcs ?? []), ...(roster.bosses ?? [])]) {
  const speed = Number.parseFloat(String(c.speed ?? '1.4'));
  const height = Number.parseFloat(String(c.height ?? '1.75'));
  statsTable.set(c.id, {
    id: c.id,
    speed: Number.isFinite(speed) ? speed : 1.4,
    radius: c.id.startsWith('B-') ? 0.6 : 0.35,
    height: Number.isFinite(height) ? height : 1.75,
  });
}
const fallbackStats = { id: 'UNKNOWN', speed: 1.4, radius: 0.35, height: 1.75 };
const statsOf = (id) => statsTable.get(id) ?? fallbackStats;

// ---------------------------------------------------------------- 场景 → 世界

/**
 * 世界坐标：沿 parent 链累加 position。
 * 切片场景里父节点只有平移（无旋转/缩放），够用；将来接真 prefab 层级时要
 * 换成 packages/scene 的 SceneGraph.updateWorldTransforms()，别在这里重复实现。
 */
function worldPosition(node, byId) {
  let x = 0;
  let z = 0;
  let cur = node;
  let guard = 0;
  while (cur !== undefined && guard++ < 32) {
    x += cur.transform.position[0];
    z += cur.transform.position[2];
    cur = cur.parent === null || cur.parent === undefined ? undefined : byId.get(cur.parent);
  }
  return [x, z];
}

const byId = new Map(src.nodes.map((n) => [n.id, n]));
const rooms = src.nodes.filter((n) => n.components.some((c) => c.kind === 'RoomVolume'));
const spawns = src.nodes.filter((n) => n.components.some((c) => c.kind === 'SpawnPoint'));

if (rooms.length === 0) throw new Error(`${srcRel} 里没有 RoomVolume，无法确定关卡起点`);

// 玩家放在第一个房间（关卡入口）的中心
const [px, pz] = worldPosition(rooms[0], byId);

const totalSpawn = spawns.reduce(
  (s, n) => s + (n.components.find((c) => c.kind === 'SpawnPoint')?.count ?? 0),
  0,
);

const world = new World({ capacity: Math.max(64, totalSpawn + 8) });
world.addPlayer(px, pz, { id: 'PLAYER', speed: 4.0, radius: 0.4, height: 1.8 });

const rng = makeRng(seed);
for (const node of spawns) {
  const sp = node.components.find((c) => c.kind === 'SpawnPoint');
  const [x, z] = worldPosition(node, byId);
  world.spawn(
    { x, z, characterId: sp.characterId, count: sp.count, spread: sp.radius, stats: statsOf(sp.characterId) },
    rng,
  );
}

console.log(`[sim] ${srcRel}：房间 ${rooms.length} · 刷怪点 ${spawns.length} · 投放 ${totalSpawn} 只 · 玩家在 (${px.toFixed(1)}, ${pz.toFixed(1)})`);

// ---------------------------------------------------------------- 跑 + 导出

/** 把世界状态转成场景节点（capsule gizmo，沿用 gen-level 的 gizmo 约定） */
function agentNodes(agents) {
  return agents.map((a, i) => {
    const r = a.radius;
    const cylH = Math.max(0.2, a.height - 2 * r);
    return {
      id: `nd_sim_${a.index}`,
      name: `${a.kind === 0 ? '玩家' : a.characterId} #${i}`,
      parent: null,
      transform: { position: [a.x, a.height / 2, a.z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      visible: true,
      pickable: true,
      category: a.kind === 0 ? '角色' : '敌人',
      components: [
        {
          kind: 'MeshRenderer',
          enabled: true,
          source: { type: 'builtin', shape: 'capsule', params: [r, cylH, 10, 6] },
          materials: [{ match: { by: 'index', value: 0 }, material: { type: 'shared', id: a.kind === 0 ? 's3' : 's4' } }],
          visible: true,
          layer: 5, // Character 层（BUILTIN_LAYERS 索引 5）；当前引擎不消费，先占好位
          importScale: 1,
        },
      ],
      prefab: null,
    };
  });
}

function writeSnapshot(t) {
  const doc = {
    schemaVersion: src.schemaVersion,
    id: `sc_sim_floor${floor}_t${String(t).replace('.', '_')}`,
    name: `模拟快照 · ${src.name} · t=${t}s`,
    act: src.act,
    environment: src.environment,
    editorCamera: src.editorCamera,
    entryCamera: null,
    dependencies: [],
    // 源场景的静态几何（房间地板 / 掩体 / 走廊）+ 模拟出来的实体
    nodes: [...src.nodes, ...agentNodes(world.snapshot())],
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      author: 'sim-level.mjs',
      notes: `headless runtime 模拟 t=${t}s（seed=${seed}，步长 ${TICK.toFixed(4)}s）`,
    },
  };
  const rel = `${SIM_DIR}/floor${floor}-t${String(t).replace('.', '_')}.scene.json`;
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return { rel, id: doc.id, objects: doc.nodes.length };
}

// 按时刻推进（times 需升序）
const sorted = [...times].sort((a, b) => a - b);
const written = [];
let elapsed = 0;
for (const t of sorted) {
  const steps = Math.round((t - elapsed) / TICK);
  for (let k = 0; k < steps; k++) world.tick(TICK);
  elapsed = t;
  written.push({ t, ...writeSnapshot(t) });
}

// ---------------------------------------------------------------- 登记进项目容器

const projPath = path.join(ROOT, 'aether.project.json');
const project = JSON.parse(fs.readFileSync(projPath, 'utf8'));
const scenes = Array.isArray(project.scenes) ? [...project.scenes] : [];
for (const w of written) {
  const i = scenes.findIndex((s) => s.path === w.rel);
  const entry = { path: w.rel, id: w.id, enabled: true };
  if (i >= 0) scenes[i] = { ...scenes[i], ...entry };
  else scenes.push(entry);
}
project.scenes = scenes;

// --focus=<t>：把编辑器启动场景直接指到该时刻的快照（省得手改 startIndex）
const focus = arg('focus', null);
if (focus !== null) {
  const want = `sc_sim_floor${floor}_t${focus}`;
  const i = scenes.findIndex((s) => s.id === want);
  if (i < 0) throw new Error(`--focus=${focus} 没找到对应快照（应为 ${want}）`);
  project.startIndex = i;
}

fs.writeFileSync(projPath, `${JSON.stringify(project, null, 2)}\n`, 'utf8');

console.table(written.map((w) => ({ 时刻: `${w.t}s`, 文件: w.rel, 节点数: w.objects })));
console.log(`登记完成 · startIndex=${project.startIndex} → ${scenes[project.startIndex]?.path ?? '(空)'}`);
console.log('编辑器里看：刷新 https://localhost:5100/ 即可；换时刻重跑本脚本加 --focus=<秒数>');
