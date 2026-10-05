#!/usr/bin/env node
/**
 * 关卡生成器：GDD §4.1–4.4 的关卡设计表 → assets/scenes/act1/floor-N.scene.json
 *
 * ## 为什么是脚本而不是手写 JSON
 * This explicit rebuild tool produces the baseline campaign, including its art pass.
 * The editor can save scene edits directly. Regeneration replaces those authored edits;
 * review the diff before committing. Runtime reads the persisted scene JSON only.
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
 * ## Materials
 * Serialized override patches define the road palette. The editor resolves them
 * after builtin instantiation and again after external GLB primitives are loaded.
 * Spawn marker meshes are editorOnly and restored when Play stops.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEnvironmentArtPass } from './environment-art-pass.mjs';
import { applyP0Art } from '../art/apply-p0-art.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCENE_DIR = 'assets/scenes/act1';
const PROJECT_FILE = 'aether.project.json';
// 🔴 必须与 packages/scene/src/document.ts 的 SCHEMA_VERSION 一致。
// 曾停在 4 而 schema 已抬到 v5：重跑生成器会把三张作者楼层**降级**回 v4，
// 且 Camera 模板漏掉 v5 的 yawMode → `migrate-scenes --check` 当场失败。
// 一致性由 packages/scene/test/level-scenes.test.ts 的「工具常量 = 真源」断言守住。
const SCHEMA_VERSION = 10;

// ---------------------------------------------------------------- 设计表（源真源）

/**
 * 楼层主题（GDD §4.3）。主题会同时改写 environment —— 环境是场景内容，
 * 每层有自己的光照/雾，这正是把 environment 从 LabParams 收进场景的意义。
 */
const THEMES = {
  fire: {
    label: '火场',
    env: {
      ambient: { color: '#66708e', intensity: 0.55 },
      hemisphere: { sky: '#a0b0d3', skyIntensity: 0.55, ground: '#342d43', groundIntensity: 0.35 },
      fog: { color: '#3b3030', density: 0.004, heightFalloff: 0.1 },
      rim: { color: '#ffb066', intensity: 0.7, power: 2.5, topBias: 0.35 },
      exposure: 1.05,
    },
  },
  swarm: {
    label: '尸潮',
    env: {
      ambient: { color: '#8d8b83', intensity: 0.7 },
      hemisphere: { sky: '#9aa88c', skyIntensity: 0.55, ground: '#2a2418', groundIntensity: 0.3 },
      fog: { color: '#303731', density: 0.004, heightFalloff: 0.08 },
      rim: { color: '#d8e0c0', intensity: 0.5, power: 2.5, topBias: 0.35 },
      exposure: 1.0,
    },
  },
  corrosion: {
    label: '腐液',
    env: {
      ambient: { color: '#2a3a2a', intensity: 0.5 },
      hemisphere: { sky: '#8fc49a', skyIntensity: 0.52, ground: '#1a2a1a', groundIntensity: 0.3 },
      fog: { color: '#0e1a12', density: 0.018, heightFalloff: 0.09 },
      rim: { color: '#a8ffb0', intensity: 0.6, power: 2.2, topBias: 0.3 },
      exposure: 0.98,
    },
  },
  dark: {
    label: '暗巷',
    env: {
      ambient: { color: '#737e9b', intensity: 0.6 },
      hemisphere: { sky: '#899bbd', skyIntensity: 0.5, ground: '#38364b', groundIntensity: 0.3 },
      fog: { color: '#161d2b', density: 0.006, heightFalloff: 0.12 },
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

const assetManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/_data/asset-manifest.json'), 'utf8'));
function propRef(id) {
  const entry = assetManifest.environments.find(c => c.id === id);
  const lod = entry?.lods.find(l => l.label.includes('原贴图') && l.file.endsWith('.glb'));
  if (!lod) throw new Error(`环境资产 ${id} 缺少清单中的原贴图成品`);
  const rel = `assets/${lod.file}`;
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, `${rel}.meta.json`), 'utf8'));
  return { path: rel, guid: meta.guid };
}
function storefrontMesh() {
  const rel = 'assets/environment/models/S-02/synthetic/storefront.glb';
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, `${rel}.meta.json`), 'utf8'));
  const palette = { masonry: '#bdbda0', trim: '#303746', interior: '#121a21', glass: '#81c8bd', sign: '#b84440', accent: '#e6bd4b' };
  return meshRenderer({ type: 'asset', ref: { path: rel, guid: meta.guid } }, 's1', {
    materials: Object.entries(palette).map(([name, albedo]) => ({
      match: { by: 'primitiveKey', value: name }, material: { type: 'override', base: { type: 'shared', id: 's1' },
        patch: { albedo, roughness: name === 'glass' ? 0.35 : 0.9, metallic: 0, outlineScale: 0.7, halftoneScale: 0.4 } },
    })),
  });
}

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
      { type: 'combat', spawns: [{ count: 5, char: 'E-01', wave: 1 }, { count: 4, char: 'E-01', wave: 2 }, { count: 3, char: 'E-02', wave: 1 }] },
      { type: 'event', spawns: [] },
      { type: 'combat', spawns: [{ count: 4, char: 'E-01', wave: 1 }, { count: 4, char: 'E-02', wave: 1 }, { count: 4, char: 'E-01', wave: 2 }] },
    ],
  },
  {
    depth: 2,
    theme: 'swarm',
    id: 'sc_act1_floor2',
    name: '第二层 · 尸潮',
    rooms: [
      // 层 2 = 压力升级：三系混编（GDD §4.4 战斗房 14–20）
      { type: 'combat', spawns: [{ count: 6, char: 'E-01', wave: 1 }, { count: 6, char: 'E-02', wave: 1 }, { count: 6, char: 'E-03', wave: 2 }] },
      { type: 'event', spawns: [] },
      // 精英房：1 精英 + 小兵（GDD §4.2 清场条件 = 精英死）
      { type: 'elite', spawns: [{ count: 1, char: 'E-04', wave: 1 }, { count: 8, char: 'E-01', wave: 1 }, { count: 8, char: 'E-02', wave: 2 }] },
    ],
  },
  {
    depth: 3,
    theme: 'dark',
    id: 'sc_act1_floor3',
    name: '第三层 · 暗巷',
    rooms: [
      // 层 3 前置（GDD：10 只）
      { type: 'elite', spawns: [{ count: 1, char: 'E-04', wave: 1 }, { count: 5, char: 'E-02', wave: 1 }, { count: 4, char: 'E-03', wave: 2 }] },
      // BOSS 房：1 BOSS + 爆尸/呕吐者（E-05 可被引爆，给玩家环境解法）
      { type: 'boss', spawns: [{ count: 1, char: BOSS_OF_RUN, wave: 1 }, { count: 4, char: 'E-05', wave: 1 }, { count: 4, char: 'E-03', wave: 2 }] },
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
function binding(materialId, patch = null) {
  const base = { type: 'shared', id: materialId };
  return [{ match: { by: 'index', value: 0 }, material: patch ? { type: 'override', base, patch } : base }];
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

/**
 * 每个幕可用的「高掩体」道具（cover=high/full，来自 props.json 设计表）。
 * 幕号由楼层主题推得（当前 FLOORS 全是 Act1：fire→1）。
 * 道具循环使用：掩体数量多于道具种类时取模轮换，保证同房间不重样。
 *
 * footprint（W×D×H，米）同步自 props.json —— Collider 按它生成，
 * 保证视觉与碰撞一致（P4b 复审：一刀切 2.4m 方块会让 6m 轿车头尾悬出碰撞体）。
 */
/**
 * 每个幕可用的「高掩体」道具（cover=high/full，**直读 props.json**）。
 *
 * 🔴 真源直读（P4b 复审二轮修）：此前这里是一份手抄 footprint 表，复审实测
 * 抄错 4 处数值（P-14/P-16/P-22/P-25，最狠差 10 倍）、轴序混 8 处，且从未与
 * props.json 对账 —— 手抄表成了"第二真源"，违背局部真源原则。
 * 现在直接读 `assets/environment/props.json` 的 entries[].footprint，永不错抄。
 *
 * 道具循环使用：掩体数量多于道具种类时取模轮换。
 * 排列原则：**按占地从大到小**排槽（cv0 在远离刷怪点一侧），大件先占，
 * 保证任一 footprint 与刷怪散布区不重叠（session.test"不穿障碍"看守）。
 */
function actCoverProps(theme) {
  const THEME_TO_ACT = { fire: 1, industrial: 2, subway: 3, lab: 4 };
  const act = THEME_TO_ACT[theme] ?? 1;
  const props = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'assets/environment/props.json'), 'utf8'),
  );
  const usable = props.entries.filter(
    (e) =>
      // 只要「道具」：structure 是建筑模块（如 S-02 便利店 12×8m），
      // 不是掩体摆件，混进来会吞掉整个刷怪区
      e.kind === 'prop' &&
      Array.isArray(e.acts) &&
      e.acts.includes(act) &&
      (e.cover === 'high' || e.cover === 'full') &&
      Array.isArray(e.footprint) &&
      e.footprint.length === 3,
  );
  if (usable.length === 0) throw new Error(`props.json 里没有 Act${act} 的高掩体道具`);
  // 🔴 占地**升序**：小件在前（cv1/cv2 贴近刷怪散布区一侧的空间窄），
  // 大件殿后。coverOffsets 的 cv0 在 -0.3W/-0.25H（离刷怪点最远）——
  // 但槽序是 cv0→cv1→cv2，小件先占 cv0 也没问题（小件哪都放得下）。
  // 真正要防的是"大件进窄槽"：升序保证轮到大件时只剩远槽或下一房间。
  // session.test 的"不穿障碍"是这条布局的回归看守（P4b 复审一轮的教训）。
  usable.sort((a, b) => {
    const area = (fp) => fp[0] * fp[1];
    return area(a.footprint) - area(b.footprint);
  });
  return usable.map((e) => [e.id, e.footprint]);
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
    transform: { ...identityTransform(opts.position ?? [0, 0, 0]), rotation: opts.rotation ? opts.rotation.map(v => v / Math.hypot(...opts.rotation)) : [0, 0, 0, 1] },
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
    // Entrances are on the west edge. Keep the entry lane clear for reaction/kiting;
    // enemy stats stay untouched, and the authored points remain editable.
    return [radius * (0.45 + Math.cos(angle) * 0.3), Math.sin(angle) * radius * 0.7];
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
  const beaconRoom = placed.find(r => r.type === 'event') ?? placed[placed.length - 1];
  nodes.push(node(`nd_f${floor.depth}_beacon`, '街区暖光', { position: [beaconRoom.x, 4.5, -3], category: '灯光',
    components: [{ kind: 'Light', enabled: true, type: 'point', color: '#ffc56c', intensity: 2.2, range: 15, spotAngle: 0, castShadow: false, priority: 100 }] }));
  // GDD §5–6 prototype tuning. Hypothesis: a first-kill choice establishes a build
  // before 90 s, then every eight kills; validate timing and purchase choices in playtests.
  nodes.push(node(`nd_f${floor.depth}_run`, '局内成长与补给规则', { category: '游戏规则', components: [{
    kind: 'RunRules', enabled: true, campaign: 'act1', scrapPerKill: 3,
    firstChoiceKills: 1, choiceEveryKills: 8, eventScrap: 25,
    healCost: 18, healAmount: 35, talentCost: 30, floorEssence: floor.depth * 5, aimAssist: true,
    weapon: { magazineSize: 18, reserveRounds: 120, reloadSec: 1.6, ammoPerKill: 8, ammoCost: 12, ammoSupply: 60 },
    // [PLACEHOLDER] 1.8 s telegraph permits a 3 m escape at base speed; verify with headed play.
    bossAttack: floor.depth === 3 ? { source: 'nd_f3r1_sp0', radius: 3, windupSec: 1.8, cooldownSec: 5, damage: 28 } : null,
    talents: [
      { id: 'heavy', name: '重型弹头', description: '每层伤害 +35%；叠满三层形成高伤流派。', effect: 'damage', value: 0.35, maxStacks: 3 },
      { id: 'rapid', name: '快速供弹', description: '每层射速 +30%，持续压制尸潮。', effect: 'haste', value: 0.3, maxStacks: 3 },
      { id: 'leech', name: '尸髓回流', description: '命中恢复实际伤害的 8% 生命。', effect: 'leech', value: 0.08, maxStacks: 3 },
      { id: 'shock', name: '震荡弹池', description: '解锁新的范围流派选项：每层 2 米半额冲击波。', effect: 'blast', value: 2, maxStacks: 3, unlockCost: 15 },
      { id: 'blast', name: '破片弹药', description: '命中造成半额范围伤害；每层扩大 1.2 米。', effect: 'blast', value: 1.2, maxStacks: 3 },
      { id: 'dash', name: '轻装步伐', description: '每层移动速度 +15%，更容易拉开距离。', effect: 'speed', value: 0.15, maxStacks: 3 },
    ],
  }] }));

  // ---- 主光 + 游戏相机（无 MeshRenderer，不占物件槽位）----
  const keyLightId = `nd_f${floor.depth}_key`;
  const cameraId = `nd_f${floor.depth}_cam`;
  nodes.push(
    node(keyLightId, 'Key Light', {
      // 48 degree elevation, 130 degree azimuth: readable contrast from the god-view camera.
      rotation: [-0.230350, 0, -0.274516, 0.933580],
      pickable: false,
      category: '灯光',
      components: [
        {
          kind: 'Light',
          enabled: true,
          type: 'directional',
          color: '#fff3e0',
          // 美卡 toon 的 lit band ≈ albedo × key × exposure，1.4 让亮部接近满色而不炸白
          intensity: 1.4,
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
          yawMode: 'world',
          enabled: true,
          fovDeg: 45,
          near: 0.1,
          far: 200,
          mode: 'orbit-follow',
          followTarget: null,
          pitchDeg: 55,
          distance: 26,
          yawOffsetDeg: 0,
          // v5：'world' = 上帝视角不随角色转身（第三人称顶视射击的默认）。
          // 不写会退化成缺省值 —— 那是"读了字段没落数据"，迁移链会把它补回来
          // 从而每次重生成都产生一次无意义 diff。
        },
      ],
    }),
    // 演示脚本（ADR-018 P3）：挂在第一间房上，Play 时每 tick 记日志，
    // 供「脚本真的被执行」在真机上可观察。行为本体在
    // assets/behaviors/debug-on-trigger-log.ts（注册表收集）。
    // 🔴 必须由生成器产出而不是手工挂 —— 手工挂的会被下次重生成冲掉
    //（P4b 重生成时就丢过一次，靠 behavior-exec 测试抓回）。
    node(`nd_f${floor.depth}_demo_script`, '演示脚本 · 触发记录', {
      pickable: false,
      category: '道具',
      components: [
        {
          kind: 'Script',
          enabled: true,
          behavior: 'debug-on-trigger-log',
          params: { message: `${theme.label}心跳`, maxTick: 3, enabled: true, tag: 'info' },
        },
      ],
    }),
  );

  // ---- 虚空底：防止房间之间看起来悬空 ----
  // 注：关卡背景 = 虚空底 + 主题雾色的距离渐变（火场暖棕 / 暗巷近黑），比天空穹顶
  // 更贴主题。白 albedo 穹顶试过 —— toon 分阶下背光半边变灰紫，把主题氛围洗掉，弃用。
  // 引擎侧已给 background 物件做雾豁免（mat.flags.w），sandbox 的穹顶渐变受益。
  const spanX = placed[placed.length - 1].x + placed[placed.length - 1].spec.w / 2 + 20;
  // A continuous street bed keeps rooms visually connected; room volumes and
  // authored collision remain independent. Total meshes stay below 64.
  nodes.push(node(`nd_f${floor.depth}_street`, '连续街道', { position: [spanX / 2 - 10, -0.23, 0], category: '环境', pickable: false,
    components: [{ ...floorGizmo(spanX, 18, 's1'), materials: binding('s1', { albedo: '#435357', roughness: 1, outlineScale: 0, halftoneScale: 0.25 }) }] }));
  for (const side of [-1, 1]) nodes.push(node(`nd_f${floor.depth}_curb_${side}`, '连续路肩', { position: [spanX / 2 - 10, -0.18, side * 9.25], category: '环境', pickable: false,
    components: [{ ...floorGizmo(spanX, 0.5, 's1'), materials: binding('s1', { albedo: '#9c9b91', roughness: 1, outlineScale: 0.3 }) }] }));
  for (let stripe = 0; stripe < 6; stripe++) nodes.push(node(`nd_f${floor.depth}_crosswalk_${stripe}`, '街口斑马线', { position: [placed[0].spec.w + 3, -0.115, -5 + stripe * 2], category: '环境', pickable: false,
    components: [{ ...floorGizmo(3.4, 0.65, 's1'), materials: binding('s1', { albedo: '#d7c998', roughness: 1, outlineScale: 0, halftoneScale: 0.15 }) }] }));
  nodes.push(
    node(`nd_f${floor.depth}_void`, '街区地基', {
      pickable: false,
      category: '环境',
      position: [spanX / 2 - 10, -0.6, 0],
      components: [meshRenderer({ type: 'builtin', shape: 'plane', params: [220, 1] }, 's1', { materials: binding('s1', { albedo: '#505263', roughness: 1, outlineScale: 0, halftoneScale: 0.15 }) })],
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
            clearTarget: room.type === 'elite' ? `${roomId}_sp0` : null,
            depth: floor.depth,
          },
          { ...floorGizmo(spec.w, spec.h, spec.floorMat), materials: binding('s1', { albedo: room.type === 'event' ? '#807252' : '#435357', roughness: 0.92, metallic: 0, outlineScale: 0.4, halftoneScale: 0.35 }) },
        ],
      }),
    );

    // Highway ground treatment: readable lanes and edge strips from the Act1 art brief.
    for (const side of [-1, 1]) {
      nodes.push(node(`${roomId}_edge_${side < 0 ? 'n' : 's'}`, '道路边线', {
        parent: roomId, pickable: false, category: '环境', position: [0, 0.13, side * (spec.h / 2 - 0.35)],
        components: [{ ...floorGizmo(spec.w - 0.5, 0.12, 's5'), materials: binding('s5', { albedo: '#b8a87b', roughness: 1, outlineScale: 0, halftoneScale: 0.15 }) }],
      }));
    }
    for (let mark = 0; mark < 5; mark++) {
      nodes.push(node(`${roomId}_lane_${mark}`, '道路导向标线', {
        parent: roomId, pickable: false, category: '环境', position: [(mark - 2) * (spec.w / 6), 0.13, 0],
        components: [{ ...floorGizmo(spec.w / 12, 0.14, 's5'), materials: binding('s5', { albedo: '#d4ae57', roughness: 1, outlineScale: 0, halftoneScale: 0.15 }) }],
      }));
    }

    // Framed roadside streets: authored buildings and sidewalks, outside the combat lanes.
    // References remain existing assets with GUIDs; no character production is touched.
    for (const side of [-1, 1]) {
      nodes.push(node(`${roomId}_walk_${side}`, '路边人行道', {
        parent: roomId, category: '环境', position: [0, 0.16, side * (spec.h / 2 + 1.2)],
        components: [{ ...floorGizmo(spec.w + 2, 2.4, 's1'), materials: binding('s1', { albedo: '#7b8295', roughness: 1, outlineScale: 0.6 }) }],
      }));
      const structure = side === 1 && room.type === 'event' ? 'S-01' : 'S-02';
      nodes.push(node(`${roomId}_building_${side}`, structure === 'S-01' ? '路边加油站' : '街区便利店', {
        parent: roomId, category: '建筑', position: [0, 0.1, side * (spec.h / 2 + 6)],
        rotation: side < 0 ? [0, 1, 0, 0] : [0, 0, 0, 1],
        components: [structure === 'S-02' ? storefrontMesh() : meshRenderer({ type: 'asset', ref: propRef(structure) }, 's1')],
      }));
    }
    if (room.type === 'event') nodes.push(node(`${roomId}_supply`, '补给站 · 按 E 开启', {
      parent: roomId, category: '道具', position: [0, 0.1, -3],
      components: [meshRenderer({ type: 'asset', ref: propRef('P-14') }, 's1')],
    }));

    // 掩体（挂在房间下，随房间移动）。
    // 🔴 P4b：掩体从「builtin box 积木」改为引用真实环境道具 GLB。
    // 语义数据（Collider）保持不变 —— gameplay 用的是 Collider，不是视觉网格；
    // 视觉替换不影响碰撞/寻路。cover 高度分类对齐 props.json 的 cover 字段。
    // 编辑器装载期先用 box 占位，随后 loadSceneAssets() 异步换成真 GLB
    //（renderer.loadScene / loadSceneAssets，ADR-018 P4b）。
    const coverPropIds = actCoverProps(floor.theme);
    coverOffsets(spec.cover, spec.w, spec.h).forEach(([dx, dz], ci) => {
      const [propId, fp] = coverPropIds[ci % coverPropIds.length];
      // props.json uses width × depth × height; the collider uses XYZ.
      const [w, d, h] = fp;
      nodes.push(
        node(`${roomId}_cv${ci}`, `掩体 ${ci + 1} · ${propId}`, {
          parent: roomId,
          pickable: false,
          category: '道具',
          // 🔴 y=0：GLB 补载后脚底贴 0（parseGlb 把 minY 归到 0），
          // 旧的 0.7 是 box 中心（高 1.4 的一半），贴地模型会浮空 —— P4b 复审修
          position: [dx, 0, dz],
          components: [
            meshRenderer(
              {
                type: 'asset',
                ref: propRef(propId),
              },
              's1',
            ),
            // Collider 按道具真实 footprint（props.json 契约 1unit=1m）——
            // 视觉与碰撞一致；盒心在 h/2（脚底贴地、盒体上移）
            { kind: 'Collider', enabled: true, shape: { type: 'box', halfExtents: [w / 2, h / 2, d / 2] }, isTrigger: false, layer: 0 },
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
              wave: spawn.wave ?? 0,
              trigger: 'room-enter',
              delaySec: 0,
              radius: isBoss ? 2.5 : 1.5,
              prefab: null,
            },
            meshRenderer(
              { type: 'builtin', shape: 'cylinder', params: isBoss ? [1.2, 2.2, 12] : [0.6, 1.6, 8] },
              's4',
              { editorOnly: true },
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

  // ---- 玩家起点（v3 起的必需字段）----
  // 放在第一间房的入口侧：玩家从这里进场，第一间房的 room-enter 立即触发。
  // 挂 capsule gizmo 是为了在编辑器里看得见（instantiate 只认 MeshRenderer）；
  // layer 5 = Character 层占位（引擎暂不消费，但语义正确，将来引擎消费即自动生效）。
  const startId = `nd_f${floor.depth}_start`;
  nodes.push(
    node(startId, '玩家起点', {
      position: [first.x - first.spec.w / 2 + 3, 0.9, first.z],
      category: '角色',
      components: [
        meshRenderer({ type: 'builtin', shape: 'capsule', params: [0.35, 1.1, 8, 4] }, 's3', { layer: 5 }),
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
    playerStart: startId,
    loseCondition: 'player-death',
    dependencies: [],
    nodes,
    meta: { createdAt: now, updatedAt: now, author: 'gen-level.mjs', notes: `GDD §4.1 层 ${floor.depth} · 主题 ${theme.label}` },
  };
}

// ---------------------------------------------------------------- 落盘

/**
 * 剥离 meta 时间戳后的规范化文本 —— 用于判定"真的改了没有"。
 *
 * 🔴 幂等（2026-10-02 审查发现）：旧实现每次都把 `meta.createdAt/updatedAt` 写成
 * 当前时间，导致 `node tools/level/gen-level.mjs` 重跑必然产生 3 个文件的 diff
 *（内容与上次完全一致，只有时间戳在动）。这种"改了但没改"的 diff 会淹没真正的
 * 数据变更，也让「生成器幂等」的约定失效。
 */
function canonical(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return text; // 解析不了就退化成原文比较（保守：判为有变化）
  }
  if (d && typeof d === 'object' && d.meta && typeof d.meta === 'object') {
    delete d.meta.createdAt;
    delete d.meta.updatedAt;
  }
  return JSON.stringify(d, null, 2);
}

function writeJson(relPath, data) {
  const abs = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs)) {
    const prevRaw = fs.readFileSync(abs, 'utf8');
    const nextRaw = JSON.stringify(data, null, 2);
    if (canonical(prevRaw) === canonical(nextRaw)) {
      return { abs, changed: false }; // 内容一致：连时间戳都不刷新
    }
    // 内容真变了：保留原 createdAt（创建时间不是"最后一次生成的时间"）
    try {
      const prev = JSON.parse(prevRaw);
      if (prev?.meta?.createdAt && data.meta) data.meta.createdAt = prev.meta.createdAt;
    } catch {
      /* 坏文件就按新建处理 */
    }
  }
  fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { abs, changed: true };
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
    const doc = applyP0Art(applyEnvironmentArtPass(buildFloor(floor), ROOT), ROOT);
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
