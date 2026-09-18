#!/usr/bin/env node
/**
 * 关卡模拟 CLI（WU-1e）。
 *
 * ## 这个文件的职责边界
 *
 * 它**只做三件事**：解析参数、调用共享能力、把结果显式导出。
 * 场景怎么解释、实体怎么生成、移动怎么受障碍约束，全在 `@aether/runtime` 里 ——
 * 以前这些逻辑就写在本文件里，编辑器要做 Play 时只能复制一份，两份语义必然漂移。
 * 现在 CLI 与浏览器共用同一个入口（docs/17 §4）。
 *
 * ## 为什么产物是 .scene.json
 *
 * 人要看画面。headless 跑完把某一帧导出成**普通场景文件**，
 * 编辑器零改动就能打开 —— 不必等 Play 模式（S3）做完。
 *
 * ⚠️ 这些是**派生产物**（docs/17 §3.3），不是作者场景：
 * 不要手改它们，也不要让它们反过来成为关卡的真源。
 *
 * 用法：
 *   npm run sim -- --floor=1 --times=0,3,5
 *   npm run sim -- --floor=1 --times=5 --focus=5   # 把项目启动场景指到 t=5
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 共享能力：esbuild 打出来的 CJS bundle（npm run runtime:build）
const { loadLevelRuntime, createSession } = require(join(ROOT, '.workbuddy/tmp/runtime/index.js'));

const PROJECT_FILE = 'aether.project.json';
const SUPPORTED_SCHEMA = 3;

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { floor: 1, times: [0, 1, 3, 5], seed: 1, focus: null };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m === null) continue;
    const [, k, v] = m;
    if (k === 'floor') out.floor = Number(v);
    else if (k === 'times') out.times = v.split(',').map((x) => Number(x.trim()));
    else if (k === 'seed') out.seed = Number(v);
    else if (k === 'focus') out.focus = Number(v);
  }
  return out;
}

// ---------------------------------------------------------------- 导出：运行实体 → 场景节点

const identity = () => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

function agentNode(e, seq) {
  const isPlayer = e.kind === 'player';
  return {
    id: `nd_sim_a${seq}`,
    name: `${e.characterId}${isPlayer ? ' · 玩家' : ' #' + seq}`,
    parent: null,
    transform: { ...identity(), position: [e.x, isPlayer ? 0.9 : 0.85, e.z] },
    visible: true,
    pickable: true,
    category: isPlayer ? '角色' : '敌人',
    components: [
      {
        kind: 'MeshRenderer',
        enabled: true,
        source: { type: 'builtin', shape: 'capsule', params: [0.34, 1.1, 8, 4] },
        materials: [
          { match: { by: 'index', value: 0 }, material: { type: 'shared', id: isPlayer ? 's3' : 's4' } },
        ],
        visible: true,
        layer: 5, // Character 层占位：引擎暂不消费，但语义正确
        importScale: 1,
      },
    ],
    prefab: null,
  };
}

/** 作者场景 + 某一帧的实体 → 可打开的场景文件 */
function buildSnapshotScene(src, entities, seconds, seed, floor) {
  return {
    schemaVersion: SUPPORTED_SCHEMA,
    // 🔴 id 必须与 `aether.project.json` 的 SceneEntry.id 一致（它是文档 id 的副本）。
    // 曾写成 `sc_sim_floor${src.id}_t${seconds}`，而 src.id = `sc_act1_floor1`，
    // 于是产出 `sc_sim_floorsc_act1_floor1_t0` —— 按 id 查场景会拿到与登记项不同的身份。
    id: `sc_sim_floor${floor}_t${seconds}`,
    name: `${src.name} · t=${seconds}s 快照（派生产物）`,
    act: src.act,
    environment: src.environment,
    editorCamera: src.editorCamera,
    entryCamera: src.entryCamera,
    playerStart: src.playerStart,
    dependencies: [],
    // 保留作者布局（房间 / 掩体 / 刷怪点是观察参照），再叠上这一帧的实体
    nodes: [...src.nodes.map((n) => ({ ...n, components: n.components.map((c) => ({ ...c })) })), ...entities],
    meta: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      author: 'sim-level.mjs',
      notes: `派生产物：种子 ${seed} · 固定步 1/30 · t=${seconds}s。不要手改，重跑即被覆盖。`,
    },
  };
}

// ---------------------------------------------------------------- 项目登记

function readProject() {
  return JSON.parse(readFileSync(join(ROOT, PROJECT_FILE), 'utf8'));
}

function writeProject(project) {
  writeFileSync(join(ROOT, PROJECT_FILE), JSON.stringify(project, null, 2) + '\n', 'utf8');
}

function registerScene(rel, name, id) {
  const project = readProject();
  const scenes = Array.isArray(project.scenes) ? [...project.scenes] : [];
  const i = scenes.findIndex((s) => s.path === rel);
  // id 是文档 id 的副本 —— 登记时一起写，否则登记项与文档各说各话（见 buildSnapshotScene）
  if (i >= 0) scenes[i] = { ...scenes[i], path: rel, name, id };
  else scenes.push({ path: rel, name, id });
  project.scenes = scenes;
  writeProject(project);
}

function setStartIndex(targetPath) {
  const project = readProject();
  const i = project.scenes.findIndex((s) => s.path === targetPath);
  if (i < 0) return -1;
  project.startIndex = i;
  writeProject(project);
  return i;
}

// ---------------------------------------------------------------- 主流程

const args = parseArgs(process.argv);
const relScene = `assets/scenes/act1/floor-${args.floor}.scene.json`;
const srcRaw = JSON.parse(readFileSync(join(ROOT, relScene), 'utf8'));

if (srcRaw.schemaVersion !== SUPPORTED_SCHEMA) {
  console.error(
    `[sim] ${relScene} 是 v${srcRaw.schemaVersion}，本工具只处理 v${SUPPORTED_SCHEMA}。\n` +
      `      先跑 node tools/level/gen-level.mjs 重新生成关卡。`,
  );
  process.exit(1);
}

const loaded = loadLevelRuntime(srcRaw);
if (loaded.desc === null) {
  console.error('[sim] 场景装载失败：');
  for (const d of loaded.diagnostics) console.error(`  [${d.severity}] ${d.code} ${d.message}`);
  process.exit(1);
}
for (const d of loaded.diagnostics) {
  if (d.severity === 'warning') console.warn(`[sim] warning ${d.code} ${d.message}`);
}

const desc = loaded.desc;
const session = createSession(desc, { seed: args.seed });
const STEP_PER_SEC = Math.round(1 / session.fixedStep);

console.log(
  `[sim] ${relScene}：房间 ${desc.rooms.length} · 刷怪点 ${desc.spawns.length} · ` +
    `障碍 ${desc.obstacles.length} · 玩家在 (${desc.playerStart.x.toFixed(1)}, ${desc.playerStart.z.toFixed(1)})`,
);

const ordered = [...args.times].sort((a, b) => a - b);
let elapsed = 0;

for (const sec of ordered) {
  const want = Math.round(sec * STEP_PER_SEC);
  if (want > elapsed) {
    session.run(want - elapsed);
    elapsed = want;
  }
  const entities = session.view().map((e, k) => agentNode(e, k));
  const scene = buildSnapshotScene(srcRaw, entities, sec, args.seed, args.floor);
  const rel = `assets/scenes/sim/floor${args.floor}-t${sec}.scene.json`;
  writeFileSync(join(ROOT, rel), JSON.stringify(scene, null, 2) + '\n', 'utf8');
  registerScene(rel, scene.name, scene.id);
  console.log(
    `[sim] t=${sec}s → ${rel}（tick ${session.tick} · 实体 ${entities.length} · ` +
      `已触发房间 ${session.triggeredRooms().length}/${desc.rooms.length}）`,
  );
}

if (args.focus !== null) {
  const target = `assets/scenes/sim/floor${args.floor}-t${args.focus}.scene.json`;
  const i = setStartIndex(target);
  if (i < 0) console.warn(`[sim] --focus=${args.focus} 没有对应快照，已忽略`);
  else console.log(`[sim] 项目启动场景已指向 ${target}（startIndex=${i}）`);
}

console.log('[sim] 提示：编辑器切换预览场景需要刷新浏览器页面');
