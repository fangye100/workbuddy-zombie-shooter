import { describe, it, expect } from 'vitest';
import { loadLevelRuntime } from '../src/loader';
import type { SceneDocument } from '@aether/scene';

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
