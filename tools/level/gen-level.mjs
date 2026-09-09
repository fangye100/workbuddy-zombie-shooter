#!/usr/bin/env node
/**
 * 关卡生成器：GDD §4.1–4.4 的关卡设计表 → assets/scenes/act1/floor-N.scene.json
 *
 * ## 为什么是脚本而不是手写 JSON
 * S2（保存 / Inspector）还没做完 —— 编辑器打开场景后**改了存不回去**。
 * 所以关卡数据只能靠"源设计 → 生成"单向产出，任何人工在编辑器里的微调都会丢。
 * 本脚本必须**可重复运行**（幂等）：同一份设计表永远产出同一份场景。
 *
 * ## 粒度：一层一关（一关 = 一个 .scene.json）
 * GDD §4.1 固定 3 层，每层只有 2–3 个房间，物件预算远低于 MAX_OBJECTS=64，
 * 所以整层能装进单个场景文件，不必一房一文件。
 *
 * ## 🔴 gizmo 约定（不看这条生成的关卡在编辑器里是隐形的）
 * `packages/scene/src/instantiate.ts:137` —— `instantiateScene` **只处理 MeshRenderer**，
 * 其余组件（SpawnPoint / RoomVolume / NavZone / Collider / Script）一律进 `skipped`。
 * 因此每个语义节点**必须同时挂一个 MeshRenderer 当可视化代理**：
 *   房间   → 扁平 box 地板（不挡俯视视线）
 *   刷怪点 → 细圆柱（s4 亮红 unlit，最醒目）
 * 语义数据仍在 RoomVolume / SpawnPoint 组件里，gizmo 只是它长什么样。
 *
 * ## 🔴 材质：只能用共享材质 id（s0..s6）
 * `resolveMaterialId()` 遇到 `override` 只剥到最内层 base 取 id，**patch 会被丢弃**，
 * 所以现在给 gizmo 指定自定义颜色是无效的。颜色语义化要等 S2 让 override 真正生效。
 * 当前色板（apps/editor/src/params.ts 的共享材质默认值）：
 *   s0 亮绿 #8FD14F · s1 深蓝黑 #1B1F2B · s2 亮绿 #8FD14F
 *   s3 金属灰 #7A8290（青色自发光）· s4 亮红 #E8402A（unlit 发光）
 *   s5 米色 #C8B89A · s6 白（天空穹顶）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCENE_DIR = 'assets/scenes/act1';
const PROJECT_FILE = 'aether.project.json';
const SCHEMA_VERSION = 2;

// ---------------------------------------------------------------- 设计表（源真源）

/**
 * 楼层主题（GDD §4.3）。主题会同时改写 environment —— 环境是场景内容，
 * 每层有自己的光照/雾，这正是把 environment 从 LabParams 收进场景的意义。
 */
const THEMES = {
  fire: {
    label: '火场',
    env: {
      ambient: { color: '#4a2a12', intensity: 0.45 },
      hemisphere: { sky: '#d98f4f', skyIntensity: 0.4, ground: '#3a1a08', groundIntensity: 0.3 },
      fog: { color: '#2a1206', density: 0.02, heightFalloff: 0.1 },
      rim: { color: '#ffb066', intensity: 0.7, power: 2.5, topBias: 0.35 },
      exposure: 1.05,
    },
  },
  swarm: {
    label: '尸潮',
    env: {
      ambient: { color: '#3a3428', intensity: 0.4 },
      hemisphere: { sky: '#9aa88c', skyIntensity: 0.42, ground: '#2a2418', groundIntensity: 0.2 },
      fog: { color: '#14100c', density: 0.015, heightFalloff: 0.08 },
      rim: { color: '#d8e0c0', intensity: 0.5, power: 2.5, topBias: 0.35 },
      exposure: 1.0,
    },
  },
  corrosion: {
    label: '腐液',
    env: {
      ambient: { color: '#2a3a2a', intensity: 0.42 },
      hemisphere: { sky: '#8fc49a', skyIntensity: 0.4, ground: '#1a2a1a', groundIntensity: 0.25 },
      fog: { color: '#0e1a12', density: 0.018, heightFalloff: 0.09 },
      rim: { color: '#a8ffb0', intensity: 0.6, power: 2.2, topBias: 0.3 },
      exposure: 0.98,
    },
  },
  dark: {
    label: '暗巷',
    env: {
      ambient: { color: '#1a1f2a', intensity: 0.22 },
      hemisphere: { sky: '#4a5a72', skyIntensity: 0.2, ground: '#14161c', groundIntensity: 0.12 },
      fog: { color: '#05070a', density: 0.035, heightFalloff: 0.12 },
      rim: { color: '#9fb4d9', intensity: 0.45, power: 2.8, topBias: 0.4 },
      exposure: 0.85,
    },
  },
};

/** 房间类型中文名（Hierarchy 面板直接显示节点名，别让英文直出） */
const ROOM_LABEL = { combat: '战斗', event: '事件', elite: '精英', boss: 'Boss', shop: '商店', rest: '休息' };

/**
 * 房间规格。地板尺寸即房间可玩范围；cover 是掩体数（纯装饰，撑满房间用）。
 * floorMat 用共享材质 id —— 房间类型目前主要靠**尺寸 + 刷怪点密度**表达，
 * 颜色只做弱区分（override 不生效，见文件头）。
 */
const ROOM_SPECS = {
  combat: { w: 20, h: 16, floorMat: 's0', cover: 3 },
  event: { w: 14, h: 14, floorMat: 's5', cover: 0 },
  elite: { w: 22, h: 18, floorMat: 's3', cover: 3 },
  boss: { w: 30, h: 24, floorMat: 's1', cover: 4 },
  shop: { w: 14, h: 14, floorMat: 's5', cover: 0 },
  rest: { w: 14, h: 14, floorMat: 's5', cover: 0 },
};

/** 清场条件（GDD §4.2 表格） */
const CLEAR_RULE = {
  combat: 'kill-all',
  event: 'interact',
  elite: 'elite-dead',
  boss: 'kill-all',
  shop: 'none',
  rest: 'none',
};

/**
 * roster.json 的角色机制（决定每层的投放配方）：
 *   E-01 游荡者 教学兵，教侧移绕后与打头   → 层 1 主力
 *   E-02 扑跃者 打断站桩，逼玩家留位移     → 层 2 起混入
 *   E-03 呕吐者 占场型，逼玩家离开掩体     → 层 2 起混入
 *   E-04 盾卫   正面硬刚必亏，要绕侧背     → 精英位
 *   E-05 爆尸   走位惩罚，可引爆清群       → 层 3 高潮
 *   B-01 屠夫 / B-02 母体 / B-03 零号（GDD：各带 1 个反 build 机制）
 */
const BOSS_OF_RUN = 'B-01';

/** 走廊尺寸（连接相邻房间） */
const CORRIDOR = { len: 6, width: 4 };

/**
 * 楼层设计表（GDD §4.1 房间序列 + §4.4 难度曲线）。
 * spawns 数组 = 每个刷怪点的僵尸数，和即该房间的投放量。
 */
const FLOORS = [
  {
    depth: 1,
    theme: 'fire',
    id: 'sc_act1_floor1',
    name: '第一层 · 火场',
    rooms: [
      // 层 1 = 教学：只上 E-01，最后一个点混 2 只 E-02 给第一次「站桩会被打断」的信号
      { type: 'combat', spawns: [{ count: 5, char: 'E-01' }, { count: 4, char: 'E-01' }, { count: 3, char: 'E-02' }] },
      { type: 'event', spawns: [] },
      { type: 'combat', spawns: [{ count: 4, char: 'E-01' }, { count: 4, char: 'E-02' }, { count: 4, char: 'E-01' }] },
    ],
  },
  {
    depth: 2,
    theme: 'swarm',
    id: 'sc_act1_floor2',
    name: '第二层 · 尸潮',
    rooms: [
      // 层 2 = 压力升级：三系混编（GDD §4.4 战斗房 14–20）
      { type: 'combat', spawns: [{ count: 6, char: 'E-01' }, { count: 6, char: 'E-02' }, { count: 6, char: 'E-03' }] },
      { type: 'event', spawns: [] },
      // 精英房：1 精英 + 小兵（GDD §4.2 清场条件 = 精英死）
      { type: 'elite', spawns: [{ count: 1, char: 'E-04' }, { count: 8, char: 'E-01' }, { count: 8, char: 'E-02' }] },
    ],
  },
  {
    depth: 3,
    theme: 'dark',
    id: 'sc_act1_floor3',
    name: '第三层 · 暗巷',
    rooms: [
      // 层 3 前置（GDD：10 只）
      { type: 'elite', spawns: [{ count: 1, char: 'E-04' }, { count: 5, char: 'E-02' }, { count: 4, char: 'E-03' }] },
      // BOSS 房：1 BOSS + 爆尸/呕吐者（E-05 可被引爆，给玩家环境解法）
      { type: 'boss', spawns: [{ count: 1, char: BOSS_OF_RUN }, { count: 4, char: 'E-05' }, { count: 4, char: 'E-03' }] },
    ],
  },
];

// ---------------------------------------------------------------- 构造原语

const identityTransform = (position = [0, 0, 0]) => ({
  position,
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});

function baseEnvironment() {
  return {
    ambient: { color: '#2a2f3a', intensity: 0.35 },
    hemisphere: {
      sky: '#8fb4d9',
      skyIntensity: 0.45,
      ground: '#3a2f28',
      groundIntensity: 0.18,
    },
    fog: { color: '#0e1013', density: 0.012, heightFalloff: 0.08 },
    rim: { color: '#ffffff', intensity: 0.5, power: 2.5, topBias: 0.35 },
    exposure: 1,
    postOverride: null,
  };
}

/** 共享材质绑定。index:0 = 整个网格用这一个材质 */
function binding(materialId) {
  return [{ match: { by: 'index', value: 0 }, material: { type: 'shared', id: materialId } }];
}

function meshRenderer(source, materialId, extra = {}) {
  return {
    kind: 'MeshRenderer',
    enabled: true,
    source,
    materials: binding(materialId),
    visible: true,
    layer: 0,
    importScale: 1,
    ...extra,
  };
}

/** 扁平地板 gizmo：高 0.2，顶面贴 y=0，不挡俯视视线 */
function floorGizmo(w, d, materialId) {
  return meshRenderer({ type: 'builtin', shape: 'box', params: [w, 0.2, d] }, materialId);
}

function node(id, name, opts) {
  return {
    id,
    name,
    parent: opts.parent ?? null,
    transform: identityTransform(opts.position ?? [0, 0, 0]),
    visible: true,
    pickable: opts.pickable ?? true,
    ...(opts.category ? { category: opts.category } : {}),
    components: opts.components ?? [],
    prefab: null,
  };
}

// ---------------------------------------------------------------- 布局

/**
 * 线性布局：房间沿 X 轴串成一排，中间插走廊。
 * 返回每间房的 { x, z } 中心（世界坐标）。
 */
function layoutRooms(rooms) {
  let cursor = 0;
  return rooms.map((room, i) => {
    const spec = ROOM_SPECS[room.type];
    if (i > 0) cursor += CORRIDOR.len;
    const centerX = cursor + spec.w / 2;
    cursor += spec.w;
    return { ...room, index: i, x: centerX, z: 0, spec };
  });
}

/** 刷怪点在房间内确定性环形散布（固定种子，保证可重复生成） */
function spawnOffsets(count, roomW, roomH) {
  if (count === 0) return [];
  const radius = Math.min(roomW, roomH) * 0.28;
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + 0.6;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.7];
  });
}

/** 掩体固定点位（房间内四角偏内，避开中心战斗区） */
function coverOffsets(count, roomW, roomH) {
  const base = [
    [-roomW * 0.3, -roomH * 0.25],
    [roomW * 0.3, roomH * 0.25],
    [-roomW * 0.3, roomH * 0.25],
    [roomW * 0.3, -roomH * 0.25],
  ];
  return base.slice(0, count);
}

// ---------------------------------------------------------------- 生成

function buildFloor(floor) {
  const theme = THEMES[floor.theme];
  if (theme === undefined) throw new Error(`未知楼层主题：${floor.theme}`);

  const placed = layoutRooms(floor.rooms);
  const nodes = [];

  // ---- 主光 + 游戏相机（无 MeshRenderer，不占物件槽位）----
  const keyLightId = `nd_f${floor.depth}_key`;
  const cameraId = `nd_f${floor.depth}_cam`;
  nodes.push(
    node(keyLightId, 'Key Light', {
      pickable: false,
      category: '灯光',
      components: [
        {
          kind: 'Light',
          enabled: true,
          type: 'directional',
          color: '#fff3e0',
          intensity: 1.2,
          range: 0,
          spotAngle: 0,
          castShadow: false,
          priority: 100,
        },
      ],
    }),
    node(cameraId, 'Main Camera', {
      pickable: false,
      category: '相机',
      components: [
        {
          kind: 'Camera',
          enabled: true,
          fovDeg: 45,
          near: 0.1,
          far: 200,
          mode: 'orbit-follow',
          followTarget: null,
          pitchDeg: 55,
          distance: 12,
          yawOffsetDeg: 0,
        },
      ],
    }),
  );

  // ---- 虚空底：防止房间之间看起来悬空 ----
  const spanX = placed[placed.length - 1].x + placed[placed.length - 1].spec.w / 2 + 20;
  nodes.push(
    node(`nd_f${floor.depth}_void`, '虚空底', {
      pickable: false,
      category: '环境',
      position: [spanX / 2 - 10, -0.6, 0],
      components: [meshRenderer({ type: 'builtin', shape: 'plane', params: [220, 1] }, 's1', { background: true })],
    }),
  );

  // ---- 房间 + 走廊 + 刷怪点 ----
  placed.forEach((room, i) => {
    const roomId = `nd_f${floor.depth}r${room.index}`;
    const spec = room.spec;

    nodes.push(
      node(roomId, `房间 ${room.index + 1} · ${ROOM_LABEL[room.type] ?? room.type}`, {
        position: [room.x, -0.1, room.z],
        category: '房间',
        components: [
          {
            kind: 'RoomVolume',
            enabled: true,
            roomType: room.type,
            theme: floor.theme,
            bounds: { center: [room.x, 0, room.z], size: [spec.w, 4, spec.h] },
            clearRule: CLEAR_RULE[room.type] ?? 'none',
            depth: floor.depth,
          },
          floorGizmo(spec.w, spec.h, spec.floorMat),
        ],
      }),
    );

    // 掩体（挂在房间下，随房间移动）
    coverOffsets(spec.cover, spec.w, spec.h).forEach(([dx, dz], ci) => {
      nodes.push(
        node(`${roomId}_cv${ci}`, `掩体 ${ci + 1}`, {
          parent: roomId,
          pickable: false,
          category: '道具',
          position: [dx, 0.7, dz],
          components: [
            meshRenderer({ type: 'builtin', shape: 'box', params: [2.4, 1.4, 2.4] }, 's1'),
            { kind: 'Collider', enabled: true, shape: { type: 'box', halfExtents: [1.2, 0.7, 1.2] }, isTrigger: false, layer: 0 },
          ],
        }),
      );
    });

    // 刷怪点（s4 亮红 unlit，俯视最醒目）。Boss 点用更粗的圆柱，一眼能认出来。
    spawnOffsets(room.spawns.length, spec.w, spec.h).forEach(([dx, dz], si) => {
      const spawn = room.spawns[si];
      const isBoss = spawn.char.startsWith('B-');
      nodes.push(
        node(`${roomId}_sp${si}`, `刷怪点 ${si + 1} · ${spawn.char} ×${spawn.count}`, {
          parent: roomId,
          category: '敌人',
          position: [dx, isBoss ? 1.1 : 0.8, dz],
          components: [
            {
              kind: 'SpawnPoint',
              enabled: true,
              characterId: spawn.char,
              count: spawn.count,
              wave: 0,
              trigger: 'room-enter',
              delaySec: 0,
              radius: isBoss ? 2.5 : 1.5,
              prefab: null,
            },
            meshRenderer(
              { type: 'builtin', shape: 'cylinder', params: isBoss ? [1.2, 2.2, 12] : [0.6, 1.6, 8] },
              's4',
            ),
          ],
        }),
      );
    });

    // 走廊（连接下一间房）
    if (i < placed.length - 1) {
      const next = placed[i + 1];
      const midX = (room.x + spec.w / 2 + next.x - next.spec.w / 2) / 2;
      nodes.push(
        node(`nd_f${floor.depth}c${i}`, `走廊 ${i + 1}`, {
          pickable: false,
          category: '环境',
          position: [midX, -0.1, 0],
          components: [floorGizmo(CORRIDOR.len, CORRIDOR.width, 's1')],
        }),
      );
    }
  });

  // ---- 导航区：覆盖整层，供 packages/ai 流场寻路烘焙 ----
  const first = placed[0];
  const last = placed[placed.length - 1];
  const navMinX = first.x - first.spec.w / 2;
  const navMaxX = last.x + last.spec.w / 2;
  const navW = navMaxX - navMinX;
  const navD = Math.max(...placed.map((r) => r.spec.h));
  nodes.push(
    node(`nd_f${floor.depth}_nav`, '导航区', {
      pickable: false,
      category: '环境',
      components: [
        {
          kind: 'NavZone',
          enabled: true,
          bounds: { center: [(navMinX + navMaxX) / 2, 0, 0], size: [navW, 4, navD] },
          cellSize: 0.5,
          baked: null,
        },
      ],
    }),
  );

  const env = { ...baseEnvironment(), ...theme.env };
  const now = new Date().toISOString();

  return {
    schemaVersion: SCHEMA_VERSION,
    id: floor.id,
    name: floor.name,
    act: 'Act1',
    environment: env,
    editorCamera: { target: [spanX / 2 - 10, 0, 0], distance: 62, yaw: 1.1, elevation: 0.75 },
    entryCamera: cameraId,
    dependencies: [],
    nodes,
    meta: { createdAt: now, updatedAt: now, author: 'gen-level.mjs', notes: `GDD §4.1 层 ${floor.depth} · 主题 ${theme.label}` },
  };
}

// ---------------------------------------------------------------- 落盘

function writeJson(relPath, data) {
  const abs = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return abs;
}

/**
 * 把场景登记进 aether.project.json 的 scenes[]。
 *
 * 必须登记 —— `packages/scene/test/scene-files.test.ts` 有一条断言：
 * 「每个 .scene.json 都登记在项目容器的 scenes[]」（ADR-015 项目容器是锚点）。
 * 只改 scenes 段，其余字段原样保留。
 */
function registerScenes(entries, startHint) {
  const abs = path.join(ROOT, PROJECT_FILE);
  const project = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const scenes = Array.isArray(project.scenes) ? [...project.scenes] : [];

  for (const e of entries) {
    const i = scenes.findIndex((s) => s.path === e.path);
    if (i >= 0) scenes[i] = { ...scenes[i], ...e };
    else scenes.push(e);
  }

  project.scenes = scenes;
  // startIndex 决定编辑器启动加载哪个场景（scene-boot.ts 读它）。
  // 默认指向第一个生成的关卡 —— 生成完就能直接在编辑器里看到，不用手改 JSON。
  const idx = scenes.findIndex((s) => s.path.includes(startHint));
  if (idx < 0) throw new Error(`--start=${startHint} 没匹配到任何已登记场景`);
  project.startIndex = idx;
  fs.writeFileSync(abs, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  return { total: scenes.length, startIndex: idx, startPath: scenes[idx].path };
}

// ---------------------------------------------------------------- 主流程

function main() {
  // --start=floor-2 → 编辑器启动加载第二层；默认第一层
  const startArg = process.argv.find((a) => a.startsWith('--start='));
  const startHint = startArg === undefined ? 'floor-1' : startArg.slice('--start='.length);

  const created = [];
  const register = [];

  for (const floor of FLOORS) {
    const doc = buildFloor(floor);
    const relPath = `${SCENE_DIR}/floor-${floor.depth}.scene.json`;
    writeJson(relPath, doc);
    register.push({ path: relPath, id: doc.id, enabled: true });

    const gizmoCount = doc.nodes.filter((n) => n.components.some((c) => c.kind === 'MeshRenderer')).length;
    const spawnTotal = floor.rooms.reduce(
      (s, r) => s + r.spawns.reduce((a, sp) => a + sp.count, 0),
      0,
    );
    created.push({
      文件: relPath,
      房间数: floor.rooms.length,
      节点数: doc.nodes.length,
      渲染物件: gizmoCount,
      投放僵尸: spawnTotal,
      主题: THEMES[floor.theme].label,
    });
  }

  const reg = registerScenes(register, startHint);
  console.table(created);
  console.log(`已登记场景 ${reg.total} 个 · 启动场景 startIndex=${reg.startIndex} → ${reg.startPath}`);
  console.log('（渲染物件一列须远低于 MAX_OBJECTS=64，超了会整体退回默认场景）');
  console.log('切换预览层：node tools/level/gen-level.mjs --start=floor-2  然后刷新编辑器页面');
}

main();
