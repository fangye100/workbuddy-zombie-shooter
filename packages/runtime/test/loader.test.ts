import { describe, it, expect } from 'vitest';
import { loadLevelRuntime } from '../src/loader';
import type { ColliderComponent, SceneDocument } from '@aether/scene';

/**
 * 门禁测试用 import.meta.glob 而非 node:fs —— 本仓库没装 @types/node，
 * 且 tsconfig 的 types 是白名单，引入 node:fs 会污染类型环境。
 */
// 从 packages/runtime/test/ 回到仓库根要三级：runtime/test → runtime → packages → 根
const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function floor1(): SceneDocument {
  const key = Object.keys(MODULES)[0]!;
  return (MODULES[key] as { default: unknown }).default as SceneDocument;
}

/** 深拷贝，避免用例之间互相污染模块缓存里的对象 */
function clone(d: SceneDocument): SceneDocument {
  return JSON.parse(JSON.stringify(d)) as SceneDocument;
}

function findNode(doc: SceneDocument, id: string): (typeof doc.nodes)[number] {
  const n = doc.nodes.find((x) => x.id === id);
  if (n === undefined) throw new Error(`测试夹具缺少节点 ${id}`);
  return n;
}

describe('loadLevelRuntime —— 真实关卡 floor-1', () => {
  it('装载成功：产出运行描述，且没有 error', () => {
    const r = loadLevelRuntime(floor1());
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.desc).not.toBeNull();
  });

  it('玩家起点取自 playerStart 契约，不是推导出来的', () => {
    const d = loadLevelRuntime(floor1()).desc!;
    expect(d.playerStart.nodeId).toBe('nd_f1_start');
    // 第一间房中心 x=10、宽 20 → 入口侧起点 x = 10 - 10 + 3 = 3
    expect(d.playerStart.x).toBeCloseTo(3, 5);
    expect(d.playerStart.z).toBeCloseTo(0, 5);
  });

  it('房间 / 刷怪点 / 障碍 / 导航全部解析出来', () => {
    const d = loadLevelRuntime(floor1()).desc!;
    expect(d.rooms).toHaveLength(3);
    expect(d.spawns).toHaveLength(6);
    expect(d.obstacles).toHaveLength(6);
    expect(d.nav).not.toBeNull();
  });

  it('刷怪点沿 parent 链归属到正确的房间', () => {
    const d = loadLevelRuntime(floor1()).desc!;
    const inRoom1 = d.spawns.filter((s) => s.roomNodeId === 'nd_f1r0');
    const inRoom3 = d.spawns.filter((s) => s.roomNodeId === 'nd_f1r2');
    expect(inRoom1).toHaveLength(3);
    expect(inRoom3).toHaveLength(3);
    expect(d.spawns.every((s) => s.roomNodeId !== null)).toBe(true);
  });

  it('触发器不作为障碍（门框不该变成墙）', () => {
    const d = loadLevelRuntime(floor1()).desc!;
    expect(d.obstacles.every((o) => o.nodeId.startsWith('nd_f1r'))).toBe(true);
  });
});

/**
 * 复审 #4：碰撞体必须按**世界矩阵**（旋转、缩放、父级链）算障碍范围。
 * 曾经直接拿 `halfExtents` / `radius` 当世界半宽，只对了未经变换的默认场景。
 * 这里的每个用例都刻意带变换，不允许只测恒等场景。
 */
describe('loadLevelRuntime —— 碰撞体世界变换（复审 #4）', () => {
  type N = SceneDocument['nodes'][number];
  const findColliderNode = (d: SceneDocument): N =>
    d.nodes.find((x) => x.components.some((c) => c.kind === 'Collider' && !(c as { isTrigger: boolean }).isTrigger))!;
  const colOf = (n: N) => n.components.find((c) => c.kind === 'Collider' && !(c as { isTrigger: boolean }).isTrigger)! as ColliderComponent;
  const obOf = (desc: import('../src/loader').LevelRuntimeDesc, nodeId: string) => desc.obstacles.find((o) => o.nodeId === nodeId)!;

  it('非均匀缩放：box 半宽必须乘上节点缩放（scale [3,1,1] → halfX ×3，halfZ 不变）', () => {
    const n = clone(floor1());
    const node = findColliderNode(n);
    const col = colOf(node);
    if (col.shape.type !== 'box') throw new Error('夹具需要 box');
    const hx = col.shape.halfExtents[0];
    const hz = col.shape.halfExtents[2];
    node.transform.scale = [3, 1, 1];
    const o = obOf(loadLevelRuntime(n).desc!, node.id);
    expect(o.halfX).toBeCloseTo(hx * 3, 5);
    expect(o.halfZ).toBeCloseTo(hz, 5);
  });

  it('绕 Y 旋转 90°：长条盒的半宽在世界系里必须换轴（忽略旋转会得 (2, 0.5)）', () => {
    const n = clone(floor1());
    const node = findColliderNode(n);
    const col = colOf(node);
    if (col.shape.type !== 'box') throw new Error('夹具需要 box');
    col.shape.halfExtents = [2, 1, 0.5];
    const q = Math.SQRT1_2;
    node.transform.rotation = [0, q, 0, q];
    const o = obOf(loadLevelRuntime(n).desc!, node.id);
    expect(o.halfX).toBeCloseTo(0.5, 5);
    expect(o.halfZ).toBeCloseTo(2, 5);
  });

  it('绕 Y 旋转 45°：精确世界 AABB = |cos|·hx + |sin|·hz', () => {
    const n = clone(floor1());
    const node = findColliderNode(n);
    const col = colOf(node);
    if (col.shape.type !== 'box') throw new Error('夹具需要 box');
    col.shape.halfExtents = [1, 1, 1];
    const s = Math.sin(Math.PI / 8);
    const c = Math.cos(Math.PI / 8);
    node.transform.rotation = [0, s, 0, c];
    const o = obOf(loadLevelRuntime(n).desc!, node.id);
    const expected = Math.SQRT1_2 * 2;
    expect(o.halfX).toBeCloseTo(expected, 5);
    expect(o.halfZ).toBeCloseTo(expected, 5);
  });

  it('父节点变换（平移 + 旋转）要传到子级碰撞体', () => {
    const n = clone(floor1());
    const node = findColliderNode(n);
    const col = colOf(node);
    if (col.shape.type !== 'box') throw new Error('夹具需要 box');
    col.shape.halfExtents = [1, 1, 1];
    const parent = n.nodes.find((x) => x.id === node.parent)!;
    parent.transform.position = [10, 0, -4];
    const q = Math.SQRT1_2;
    parent.transform.rotation = [0, q, 0, q];
    const o = obOf(loadLevelRuntime(n).desc!, node.id);
    expect(o.x).not.toBeCloseTo(node.transform.position[0], 4);
    expect(o.halfX).toBeCloseTo(o.halfZ, 5);
  });

  it('球体非均匀缩放 → 椭球的精确 AABB（r × 各行模长）', () => {
    const n = clone(floor1());
    const node = findColliderNode(n);
    const col = colOf(node);
    col.shape = { type: 'sphere', radius: 1 };
    node.transform.scale = [3, 1, 1];
    const o = obOf(loadLevelRuntime(n).desc!, node.id);
    expect(o.halfX).toBeCloseTo(3, 5);
    expect(o.halfZ).toBeCloseTo(1, 5);
  });

  it('胶囊倾斜（绕 Z 转 90°）：轴向线段计入范围，height 不能被丢（复审 P2）', () => {
    const n = clone(floor1());
    const node = findColliderNode(n);
    const col = colOf(node);
    col.shape = { type: 'capsule', radius: 0.5, height: 4 };
    // 绕 Z 转 90°：局部 Y 轴 → 世界 -X。按球体算的话 X 半宽只有 0.5 —— 明显低估
    const q = Math.SQRT1_2;
    node.transform.rotation = [0, 0, q, q];
    const o = obOf(loadLevelRuntime(n).desc!, node.id);
    // X 半宽 = 轴向投影(height/2 - r) + 半径 = (2 - 0.5) + 0.5 = 2
    expect(o.halfX).toBeCloseTo(2, 5);
    expect(o.halfZ).toBeCloseTo(0.5, 5); // 胶囊在该轴没有投影，只剩半径
  });

  it('直立胶囊：轴向沿 Y 没有 XZ 投影，半宽只剩半径（不能误放大）', () => {
    const n = clone(floor1());
    const node = findColliderNode(n);
    const col = colOf(node);
    col.shape = { type: 'capsule', radius: 0.5, height: 4 };
    node.transform.rotation = [0, 0, 0, 1];
    const o = obOf(loadLevelRuntime(n).desc!, node.id);
    expect(o.halfX).toBeCloseTo(0.5, 5);
    expect(o.halfZ).toBeCloseTo(0.5, 5);
  });
});

describe('loadLevelRuntime —— 未支持字段必须显式诊断（复审 #5）', () => {
  it('delaySec > 0 → 明确告知将立即投放（不能"读了字段却没执行语义"）', () => {
    const doc = clone(floor1());
    const n = doc.nodes.find((x) => x.components.some((c) => c.kind === 'SpawnPoint'))!;
    const sp = n.components.find((c) => c.kind === 'SpawnPoint')!;
    (sp as { delaySec: number }).delaySec = 10;
    const r = loadLevelRuntime(doc);
    const w = r.diagnostics.find((d) => d.code === 'W_SPAWN_DELAY_UNSUPPORTED');
    expect(w).toBeDefined();
    expect(w!.message).toContain('立即');
    expect(w!.nodeId).toBe(n.id);
  });

  it('delaySec = 0 → 不出这条诊断（默认值不该吵）', () => {
    const r = loadLevelRuntime(floor1());
    expect(r.diagnostics.some((d) => d.code === 'W_SPAWN_DELAY_UNSUPPORTED')).toBe(false);
  });

  it('禁用的 NavZone → 视为不存在并出 W_NAV_DISABLED；唯一导航被禁 → E_NAV_MISSING', () => {
    const doc = clone(floor1());
    const n = doc.nodes.find((x) => x.components.some((c) => c.kind === 'NavZone'))!;
    const nav = n.components.find((c) => c.kind === 'NavZone')!;
    (nav as { enabled: boolean }).enabled = false;
    const r = loadLevelRuntime(doc);
    expect(r.diagnostics.some((d) => d.code === 'W_NAV_DISABLED' && d.nodeId === n.id)).toBe(true);
    expect(r.desc).toBeNull();
    expect(r.diagnostics.some((d) => d.code === 'E_NAV_MISSING')).toBe(true);
  });

  it('wave 非零 → warning（读了字段却没有波次语义，触发时仍一次性全量投放）', () => {
    const doc = clone(floor1());
    const sp = findNode(doc, 'nd_f1r0_sp0').components.find((c) => c.kind === 'SpawnPoint');
    (sp as { wave: number }).wave = 2;
    const r = loadLevelRuntime(doc);
    expect(r.desc).not.toBeNull();
    const d = r.diagnostics.find((x) => x.code === 'W_SPAWN_WAVE_UNSUPPORTED');
    expect(d?.severity).toBe('warning');
    expect(d?.nodeId).toBe('nd_f1r0_sp0');
    // 真实关卡 wave 全为 0 → 不打扰作者
    expect(
      loadLevelRuntime(floor1()).diagnostics.some((x) => x.code === 'W_SPAWN_WAVE_UNSUPPORTED'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- bounds 空间一致性（复审 B4）

describe('loadLevelRuntime —— RoomVolume / NavZone 的 bounds 空间（复审 B4）', () => {
  it('带网格代理的房间节点被挪走（bounds 不动）→ 显式告警，不静默分家', () => {
    const doc = clone(floor1());
    // 把房间 1 的节点拖到 30m 外（bounds 不动）——正是「视口里拖走房间、触发区留在原地」的形态
    findNode(doc, 'nd_f1r0').transform.position = [40, -0.1, 0];
    const r = loadLevelRuntime(doc);
    const d = r.diagnostics.find((x) => x.code === 'W_BOUNDS_NODE_MISMATCH' && x.nodeId === 'nd_f1r0');
    expect(d?.severity).toBe('warning');
    // 告警要说清"以 bounds 为准、节点变换不参与"，否则作者不知道该改哪边
    expect(d?.message).toContain('世界');
    expect(d?.message).toContain('bounds');
  });

  it('带代理的 NavZone 同样受检', () => {
    const doc = clone(floor1());
    const navNode = doc.nodes.find((n) => n.components.some((c) => c.kind === 'NavZone'))!;
    // 生成器给导航区不挂代理（视口里选不中）→ 先补一个，模拟"作者给它加了可视化"
    navNode.components.push({
      kind: 'MeshRenderer',
      enabled: true,
      source: { type: 'builtin', shape: 'box', params: [1, 0.1, 1] },
      materials: [],
      visible: true,
      layer: 0,
      importScale: 1,
    } as (typeof navNode.components)[number]);
    navNode.transform.position = [
      navNode.transform.position[0] + 12,
      navNode.transform.position[1],
      navNode.transform.position[2],
    ];
    const r = loadLevelRuntime(doc);
    expect(
      r.diagnostics.some((x) => x.code === 'W_BOUNDS_NODE_MISMATCH' && x.nodeId === navNode.id),
    ).toBe(true);
  });

  it('真实关卡的房间（节点位置 == bounds 中心）→ 零告警', () => {
    expect(
      loadLevelRuntime(floor1()).diagnostics.some((x) => x.code === 'W_BOUNDS_NODE_MISMATCH'),
    ).toBe(false);
  });

  it('无网格代理的语义节点不告警（视口里选不中、拖不动，transform 无人读）', () => {
    const doc = clone(floor1());
    const navNode = doc.nodes.find((n) => n.components.some((c) => c.kind === 'NavZone'))!;
    // 生成器的形态：导航区节点在原点、bounds 覆盖整层（差 33m）—— 不是可拖的 footgun
    expect(navNode.transform.position[0]).toBe(0);
    expect(navNode.components.some((c) => c.kind === 'MeshRenderer')).toBe(false);
    expect(
      loadLevelRuntime(doc).diagnostics.some((x) => x.code === 'W_BOUNDS_NODE_MISMATCH'),
    ).toBe(false);
  });
});

describe('loadLevelRuntime —— 失败必须明确，不静默兜底', () => {
  it('未指定 playerStart → error 且不产出运行描述', () => {
    const doc = clone(floor1());
    doc.playerStart = null;
    const r = loadLevelRuntime(doc);
    expect(r.desc).toBeNull();
    expect(r.diagnostics.some((d) => d.code === 'E_PLAYER_START_UNSET')).toBe(true);
  });

  it('playerStart 指向不存在的节点 → error 带定位', () => {
    const doc = clone(floor1());
    doc.playerStart = 'nd_不存在';
    const r = loadLevelRuntime(doc);
    expect(r.desc).toBeNull();
    const d = r.diagnostics.find((x) => x.code === 'E_PLAYER_START_MISSING');
    expect(d?.nodeId).toBe('nd_不存在');
  });

  it('没有 NavZone → error（不许退化成无视障碍的直线追击）', () => {
    const doc = clone(floor1());
    doc.nodes = doc.nodes.filter((n) => !n.components.some((c) => c.kind === 'NavZone'));
    const r = loadLevelRuntime(doc);
    expect(r.desc).toBeNull();
    expect(r.diagnostics.some((d) => d.code === 'E_NAV_MISSING')).toBe(true);
  });

  it('未登记的 characterId → error（不许运行时塞默认角色）', () => {
    const doc = clone(floor1());
    const sp = findNode(doc, 'nd_f1r0_sp0').components.find((c) => c.kind === 'SpawnPoint');
    (sp as { characterId: string }).characterId = 'E-99';
    const r = loadLevelRuntime(doc);
    expect(r.desc).toBeNull();
    const d = r.diagnostics.find((x) => x.code === 'E_SPAWN_UNKNOWN_CHAR');
    expect(d?.nodeId).toBe('nd_f1r0_sp0');
  });

  it('未支持的触发类型 → warning，且绝不静默当作 room-enter', () => {
    const doc = clone(floor1());
    const sp = findNode(doc, 'nd_f1r0_sp0').components.find((c) => c.kind === 'SpawnPoint');
    (sp as { trigger: string }).trigger = 'timer';
    const r = loadLevelRuntime(doc);
    // warning 不阻断装载 —— 但消费方必须自己按 trigger 分流，不能当成已触发
    expect(r.desc).not.toBeNull();
    const d = r.diagnostics.find((x) => x.code === 'W_SPAWN_TRIGGER_UNSUPPORTED');
    expect(d?.severity).toBe('warning');
    expect(d?.nodeId).toBe('nd_f1r0_sp0');
  });
});
