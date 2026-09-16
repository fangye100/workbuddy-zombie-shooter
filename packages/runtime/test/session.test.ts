import { describe, it, expect } from 'vitest';
import { RuntimeSession } from '../src/session';
import { loadLevelRuntime } from '../src/loader';
import type { SceneDocument } from '@aether/scene';
import type { LevelRuntimeDesc, NavDesc } from '../src/loader';

/** 最小合成运行描述：一块空导航区，可选障碍。输入链路测试用它，不碰真实关卡 */
function bareDesc(obstacles: LevelRuntimeDesc['obstacles'] = []): LevelRuntimeDesc {
  const nav: NavDesc = { nodeId: 'nd_nav', minX: -10, minZ: -10, maxX: 10, maxZ: 10, cellSize: 1 };
  return {
    sceneId: 'sc_input_test',
    sceneName: '输入测试',
    schemaVersion: 3,
    playerStart: { nodeId: 'nd_start', x: 0, z: 0 },
    rooms: [],
    spawns: [],
    obstacles,
    nav,
  };
}

const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });

function desc(): LevelRuntimeDesc {
  const key = Object.keys(MODULES)[0]!;
  const doc = (MODULES[key] as { default: unknown }).default as SceneDocument;
  const r = loadLevelRuntime(doc);
  if (r.desc === null) throw new Error('测试夹具装载失败：' + JSON.stringify(r.diagnostics));
  return r.desc;
}

function make(opts: { seed?: number; capacity?: number } = {}): RuntimeSession {
  return new RuntimeSession({ desc: desc(), seed: opts.seed ?? 1, ...(opts.capacity ? { capacity: opts.capacity } : {}) });
}

/** 把全部刷怪点的数量改写成 n，用来造「超过静态上限」的压测场景 */
function makeScaled(count: number, capacity: number): RuntimeSession {
  const key = Object.keys(MODULES)[0]!;
  const doc = JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
  for (const n of doc.nodes) {
    for (const c of n.components) {
      if (c.kind === 'SpawnPoint') (c as { count: number }).count = count;
    }
  }
  const r = loadLevelRuntime(doc);
  if (r.desc === null) throw new Error('压测夹具装载失败：' + JSON.stringify(r.diagnostics));
  return new RuntimeSession({ desc: r.desc, seed: 1, capacity });
}

/** 僵尸中心是否落在障碍内部（留 0.05 容差）。这是"没有穿墙"的最低标准 */
function insideAnyObstacle(s: RuntimeSession, x: number, z: number): boolean {
  const eps = 0.05;
  for (const o of s.desc.obstacles) {
    if (!o.enabled) continue;
    if (Math.abs(x - o.x) < o.halfX - eps && Math.abs(z - o.z) < o.halfZ - eps) return true;
  }
  return false;
}

describe('RuntimeSession —— 房间进入触发', () => {
  it('玩家出生所在的房间立即触发，未进入的房间不刷', () => {
    const s = make();
    // 房间 1 = 5+4+3 = 12 只；房间 3 = 12 只（玩家在 x≈3，房间 3 在 x≈56）
    expect(s.countNpc()).toBe(12);
    expect(s.triggeredRooms()).toEqual(['nd_f1r0']);
  });

  it('时间推进不会重复投放同一波（同一房间内跑 200 步）', () => {
    const s = make();
    s.run(200);
    expect(s.countNpc()).toBe(12);
    expect(s.triggeredRooms()).toEqual(['nd_f1r0']);
  });

  /**
   * docs/17 §8-2 要求的是「**再次跨越边界**不重复投放同一波」。
   *
   * 玩家本轮不可移动（maxSpeed = 0，没有输入驱动），所以光"跑 200 步"根本没发生跨边界 ——
   * 那条只证明了"时间推进不重复触发"。这里直接搬动玩家坐标，**真的走出房间再走回来**，
   * 才算验到"再次跨越边界"。
   */
  it('玩家走出房间再走回来 → 不重复投放同一波', () => {
    const s = make();
    const before = s.countNpc();
    const p = s.view().find((e) => e.kind === 'player')!;
    const home = { x: s.table.posX[p.id]!, z: s.table.posZ[p.id]! };

    // 走出房间（房间 1 的 bounds 远小于这个坐标）
    s.table.posX[p.id] = 500;
    s.table.posZ[p.id] = 500;
    s.run(5);
    expect(s.countNpc()).toBe(before);

    // 再走回来
    s.table.posX[p.id] = home.x;
    s.table.posZ[p.id] = home.z;
    s.run(5);
    expect(s.countNpc()).toBe(before);
    expect(s.triggeredRooms()).toEqual(['nd_f1r0']);
  });

  it('实体能追溯到来源刷怪点（一处刷怪点可生成多个实体）', () => {
    const s = make();
    const v = s.view();
    const fromSp0 = v.filter((e) => e.sourceNodeId === 'nd_f1r0_sp0');
    expect(fromSp0).toHaveLength(5); // E-01 ×5
    expect(v.filter((e) => e.kind === 'player')[0]?.sourceNodeId).toBe('nd_f1_start');
  });

  it('身份带 generation，且 id 唯一（不是裸数组下标）', () => {
    const s = make();
    const v = s.view();
    // 注：不断言 `generation 是整数` —— 它来自 Uint32Array，恒真，没有区分力。
    // 真正要锁的是「id 唯一」以及「generation 随槽位复用递增」。
    expect(new Set(v.map((e) => e.id)).size).toBe(v.length);
    expect(v.every((e) => e.generation >= 1)).toBe(true);
  });

  /**
   * 复审 #6：`id + generation` 是**逻辑身份**（跨会话会重复），
   * `runId` 是**操作引用**的有效期（跨代次必然失效）。两者分别定义，互不顶替。
   */
  it('runId 随会话与 reset 递增；view 暴露它；同种子两个会话逻辑身份相同但 runId 不同', () => {
    const a = make({ seed: 7 });
    const b = make({ seed: 7 });
    // 逻辑身份相同（同种子）—— 这是确定性比较的用途
    expect(b.view().map((e) => `${e.id}:${e.generation}`)).toEqual(a.view().map((e) => `${e.id}:${e.generation}`));
    // 但运行代次必须不同 —— 这是操作引用有效期的用途
    expect(b.runId).not.toBe(a.runId);
    expect(a.view().every((e) => e.runId === a.runId)).toBe(true);
    expect(b.view().every((e) => e.runId === b.runId)).toBe(true);

    const before = a.runId;
    a.reset();
    expect(a.runId).not.toBe(before);
    expect(a.view().every((e) => e.runId === a.runId)).toBe(true);
  });
});

/**
 * 复审 #7：玩家输入链路（固定 tick 输入消费）。
 *
 * 🔴 这里刻意**不**直接改玩家坐标 —— 那是在绕过「输入 → 每步消费 → 碰撞与
 * 导航目标更新」整条链。这些用例全部走 `setInput()`，跟虚拟摇杆进的是同一个入口。
 */
describe('RuntimeSession —— 玩家输入链路（复审 #7）', () => {
  const player = (s: RuntimeSession) => s.view().find((e) => e.kind === 'player')!;

  it('没有输入 → 玩家不动（历史行为保持不变）', () => {
    const s = new RuntimeSession({ desc: bareDesc(), seed: 1 });
    const p0 = player(s);
    s.run(60);
    const p1 = player(s);
    expect(p1.x).toBe(p0.x);
    expect(p1.z).toBe(p0.z);
  });

  it('setInput(1,0) 跑 30 步：玩家沿 +x 走出 速度×时间，方向即 yaw', () => {
    const s = new RuntimeSession({ desc: bareDesc(), seed: 1 });
    s.setInput(1, 0);
    s.run(30); // 1 秒 × 4.5 m/s
    const p = player(s);
    expect(p.x).toBeCloseTo(4.5, 3);
    expect(p.z).toBeCloseTo(0, 5);
    expect(p.yaw).toBeCloseTo(0, 5);
  });

  it('摇杆超 1 会截断（斜向摇满不超 1）：位移只有单轴满速', () => {
    const s = new RuntimeSession({ desc: bareDesc(), seed: 1 });
    s.setInput(3, 4); // 长度 5 → 截断到单位向量 (0.6, 0.8)
    s.run(30);
    const p = player(s);
    expect(p.x).toBeCloseTo(4.5 * 0.6, 3);
    expect(p.z).toBeCloseTo(4.5 * 0.8, 3);
  });

  it('玩家撞障碍会被推出，不会停进障碍内部', () => {
    const s = new RuntimeSession({
      desc: bareDesc([{ nodeId: 'nd_wall', name: '墙', x: 2, z: 0, shape: 'box', halfX: 0.5, halfZ: 4, radius: 0.5, enabled: true }]),
      seed: 1,
    });
    s.setInput(1, 0);
    s.run(60);
    const p = player(s);
    // 推回障碍外侧：x 应停在 2 - (0.5 + 0.35) = 1.15 附近，绝不进内部
    expect(p.x).toBeLessThanOrEqual(2 - (0.5 + 0.35) + 1e-6);
    expect(p.x).toBeGreaterThan(0.5);
  });

  it('玩家走出导航区会被钳制在边界内', () => {
    const s = new RuntimeSession({ desc: bareDesc(), seed: 1 });
    s.setInput(1, 0);
    s.run(300); // 4.5 m/s × 10s = 45m，远超导航区
    const p = player(s);
    expect(p.x).toBeCloseTo(10 - 0.35, 5);
  });

  it('导航目标随玩家移动重烘：navGoal 跟着玩家换格', () => {
    const s = new RuntimeSession({ desc: bareDesc(), seed: 1 });
    const g0 = s.navGoal;
    expect(g0.x).toBeCloseTo(0, 5);
    s.setInput(1, 0);
    s.run(60); // 4.5m/s × 2s = 9m，跨了 9 个格子
    const g1 = s.navGoal;
    // 重烘有"挪一个格子才动"的滞后，所以断言的是"跟上了"，不是"逐位相等"
    expect(g1.x).toBeGreaterThan(g0.x + 5);
    expect(Math.abs(g1.x - player(s).x)).toBeLessThan(1.5);
  });

  it('同一输入序列 → 逐位一致（确定性，parity 的单侧证明）', () => {
    const run = () => {
      const s = new RuntimeSession({ desc: bareDesc(), seed: 7 });
      const seq = [
        { x: 1, z: 0 },
        { x: 1, z: 0 },
        { x: 0, z: 1 },
        { x: -0.5, z: 0.5 },
      ];
      for (let t = 0; t < 60; t++) {
        const inp = seq[t % seq.length]!;
        s.setInput(inp.x, inp.z);
        s.step();
      }
      return player(s);
    };
    const a = run();
    const b = run();
    expect(a.x).toBe(b.x);
    expect(a.z).toBe(b.z);
    expect(a.yaw).toBe(b.yaw);
  });

  it('reset 清空输入并把导航目标烘回出生点', () => {
    const s = new RuntimeSession({ desc: bareDesc(), seed: 1 });
    s.setInput(1, 0);
    s.run(60);
    s.reset();
    const p = player(s);
    expect(p.x).toBeCloseTo(0, 5);
    expect(s.navGoal.x).toBeCloseTo(0, 5);
    s.run(30); // 没有输入 → 不该自己走
    expect(player(s).x).toBeCloseTo(0, 5);
  });
});

describe('RuntimeSession —— 障碍真实参与约束', () => {
  it('推进过程中没有僵尸停在障碍内部', () => {
    const s = make({ seed: 7 });
    for (const t of [0, 10, 50, 200]) {
      s.run(t === 0 ? 0 : t - s.tick);
      for (const e of s.view()) {
        if (e.kind !== 'npc') continue;
        expect(insideAnyObstacle(s, e.x, e.z)).toBe(false);
      }
    }
  });

  it('僵尸确实朝玩家收敛（不是原地不动）', () => {
    const s = make({ seed: 3 });
    const before = s.view().filter((e) => e.kind === 'npc');
    const dBefore =
      before.reduce((a, e) => a + Math.hypot(e.x - s.desc.playerStart.x, e.z - s.desc.playerStart.z), 0) /
      before.length;
    s.run(300);
    const after = s.view().filter((e) => e.kind === 'npc');
    const dAfter =
      after.reduce((a, e) => a + Math.hypot(e.x - s.desc.playerStart.x, e.z - s.desc.playerStart.z), 0) /
      after.length;
    expect(dAfter).toBeLessThan(dBefore);
  });
});

describe('RuntimeSession —— 确定性与容量', () => {
  it('同种子：reset 后重跑到同一 tick，结果逐位一致', () => {
    const s = make({ seed: 42 });
    s.run(60);
    const a = s.view().map((e) => `${e.characterId}:${e.x.toFixed(6)},${e.z.toFixed(6)}`);
    s.reset();
    s.run(60);
    const b = s.view().map((e) => `${e.characterId}:${e.x.toFixed(6)},${e.z.toFixed(6)}`);
    expect(b).toEqual(a);
  });

  it('不同种子得到不同散布（种子真的被用上了）', () => {
    const a = make({ seed: 1 }).view().map((e) => e.x.toFixed(6));
    const b = make({ seed: 999 }).view().map((e) => e.x.toFixed(6));
    expect(b).not.toEqual(a);
  });

  it('容量不足 → 整批原子拒绝，不留半批实体', () => {
    const s = make({ capacity: 6 }); // 玩家占 1，房间 1 需要 12
    expect(s.countNpc()).toBe(0);
    expect(s.triggeredRooms()).toEqual([]);
  });

  /**
   * docs/17 §7 失败矩阵：「生成量超过容量 → **明确失败**，符合约定的原子性」。
   * 原子性只是"不留半批"，**明确失败**要求调用方能读到"被拒了、为什么、哪个房间" ——
   * 否则"一只没刷"到底是房间没触发还是容量不够，从输出上无从区分。
   */
  it('容量不足 → StepReport 明确回传被拒房间（AGENTS.md §2.2 不静默）', () => {
    const s = make({ capacity: 6 }); // 玩家占 1，房间 1 需要 12
    const r = s.step();
    expect(r.spawned).toBe(0);
    expect(r.rejectedRooms).toBe(1);
    expect(r.rejections).toEqual([{ roomNodeId: 'nd_f1r0', needed: 12, free: 5 }]);
  });

  it('容量不足 → 运行期 diagnostic 可见，且同一房间只记一次', () => {
    const s = make({ capacity: 6 });
    s.run(10);
    const d = s.diagnostics();
    expect(d).toHaveLength(1);
    expect(d[0]!.code).toBe('W_SPAWN_CAPACITY');
    expect(d[0]!.nodeId).toBe('nd_f1r0');
    expect(d[0]!.message).toContain('nd_f1r0');
  });

  it('drainDiagnostics 取走后清空（宿主每帧取一次，不会越攒越多）', () => {
    const s = make({ capacity: 6 });
    s.run(5);
    expect(s.drainDiagnostics().length).toBeGreaterThan(0);
    expect(s.diagnostics()).toEqual([]);
  });

  it('容量充足 → StepReport.spawned 是真实生成数，且无拒绝', () => {
    const s = make(); // 出生房间在构造期就触发了，这里搬去另一间房看一次真实生成
    const p = s.view().find((e) => e.kind === 'player')!;
    // 挑一间**还没触发过、且真的挂了刷怪点**的房间（不是所有房间都有刷怪点）
    const triggered = s.triggeredRooms();
    const seedSpawn = s.desc.spawns.find(
      (sp) => sp.enabled && sp.trigger === 'room-enter' && sp.roomNodeId !== null && !triggered.includes(sp.roomNodeId),
    )!;
    const other = s.desc.rooms.find((r) => r.nodeId === seedSpawn.roomNodeId)!;
    const want = s.desc.spawns
      .filter((sp) => sp.roomNodeId === other.nodeId && sp.enabled && sp.trigger === 'room-enter')
      .reduce((a, sp) => a + sp.count, 0);
    expect(want).toBeGreaterThan(0);

    s.table.posX[p.id] = (other.minX + other.maxX) / 2;
    s.table.posZ[p.id] = (other.minZ + other.maxZ) / 2;
    const r = s.step();
    expect(r.spawned).toBe(want);
    expect(r.rejectedRooms).toBe(0);
    expect(r.rejections).toEqual([]);
    expect(s.diagnostics()).toEqual([]);
  });

  it('reset 回到初始状态（房间需要重新触发，实体数不累积）', () => {
    const s = make();
    s.run(30);
    s.reset();
    expect(s.tick).toBe(0);
    expect(s.countNpc()).toBe(12);
  });
});

/**
 * WU-3 验收（docs/17 §8 第 8 条）：动态实体**不消耗静态场景槽位**。
 *
 * 静态世界的上限 MAX_OBJECTS = 64 来自 transformBuf 的 buffer 大小，是渲染侧约束；
 * 运行时实体走独立路径，所以「一波超过 64 只」必须能在纯 CPU 侧成立。
 * 此项只证明路径独立，不等于 500 僵尸的性能验收。
 */
describe('WU-3 验收：动态实体数量不受 MAX_OBJECTS(64) 约束', () => {
  it('同一关能同时存在远超静态上限的实体', () => {
    const s = makeScaled(40, 512); // 3 个刷怪点 × 40 = 120 只 + 玩家
    const v = s.view();
    expect(s.countNpc()).toBe(120);
    expect(v.length).toBeGreaterThan(64);
  });

  it('超出容量时整批拒绝 —— 上限是显式声明的，不是悄悄截断', () => {
    const s = makeScaled(40, 100); // 需要 121 槽位，只有 100
    expect(s.countNpc()).toBe(0);
    expect(s.triggeredRooms()).toEqual([]);
  });

  it('超量实体跑起来仍然不穿障碍（寻路对大批量同样有效）', () => {
    const s = makeScaled(20, 256);
    s.run(60);
    const bad = s.view().filter((e) => e.kind === 'npc' && insideAnyObstacle(s, e.x, e.z));
    expect(bad).toEqual([]);
    expect(s.countNpc()).toBe(60);
  });
});

/**
 * docs/17 §8-2：玩家未进入的房间不刷怪；进入后生成一次；再次跨越边界不重复投放；
 * **禁用刷怪组件不生成**。
 *
 * 最后一条单独立一条，是因为 `enabled` 很容易被实现成"提示"而不是"硬约束" ——
 * 组件照样读、照样生成，只是不画出来。那种实现在实体计数上看不出来，只能靠
 * "来源刷怪点一个实体都没有"这种身份级断言抓。
 */
describe('docs/17 §8-2：房间触发与禁用语义', () => {
  /** 改指定节点上某类组件的字段，返回新会话 */
  function withPatch(nodeId: string, kind: string, patch: Record<string, unknown>): RuntimeSession {
    const key = Object.keys(MODULES)[0]!;
    const doc = JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
    let found = false;
    for (const n of doc.nodes) {
      if (n.id !== nodeId) continue;
      for (const c of n.components) {
        if (c.kind === kind) {
          Object.assign(c, patch);
          found = true;
        }
      }
    }
    if (!found) throw new Error(`夹具里没有 ${nodeId} 的 ${kind}`);
    const r = loadLevelRuntime(doc);
    if (r.desc === null) throw new Error('装载失败：' + JSON.stringify(r.diagnostics));
    return new RuntimeSession({ desc: r.desc, seed: 5 });
  }

  it('禁用的刷怪点一个都不生成（enabled 是硬约束，不是提示）', () => {
    const s = withPatch('nd_f1r0_sp0', 'SpawnPoint', { enabled: false });
    expect(s.countNpc()).toBe(7); // 房间 1 = 5+4+3，去掉 sp0 的 5
    expect(s.view().some((e) => e.sourceNodeId === 'nd_f1r0_sp0')).toBe(false);
  });

  it('禁用的房间不触发（里面的刷怪点一个都不投放）', () => {
    const s = withPatch('nd_f1r0', 'RoomVolume', { enabled: false });
    expect(s.countNpc()).toBe(0);
    expect(s.triggeredRooms()).toEqual([]);
  });

  it('再次跨越边界不重复投放（跑 300 步实体数不涨）', () => {
    const s = new RuntimeSession({ desc: desc(), seed: 5 });
    const n0 = s.countNpc();
    s.run(300);
    expect(s.countNpc()).toBe(n0);
    expect(s.triggeredRooms()).toEqual(['nd_f1r0']);
  });
});

/**
 * WU-5 前置属性：**刷怪随机流的局部性**。
 *
 * 每个刷怪点用 `mixSeed(会话种子, nodeId)` 派生自己的随机流（见 session.ts）。
 * 共用一条流时，改 A 的 count 会多消耗几个随机数、把 B/C 的取点整体平移 ——
 * 于是「改一处」在效果上等于「整关重排」，WU-5 的局部编辑闭环就立不住。
 */
describe('WU-5 前置：改一处刷怪点不牵动其它刷怪点', () => {
  /** 只改指定刷怪点的 count，返回一个新会话 */
  function withCount(nodeId: string, count: number): RuntimeSession {
    const key = Object.keys(MODULES)[0]!;
    const doc = JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
    let found = false;
    for (const n of doc.nodes) {
      if (n.id !== nodeId) continue;
      for (const c of n.components) {
        if (c.kind === 'SpawnPoint') {
          (c as { count: number }).count = count;
          found = true;
        }
      }
    }
    if (!found) throw new Error(`夹具里没有刷怪点 ${nodeId}`);
    const r = loadLevelRuntime(doc);
    if (r.desc === null) throw new Error('装载失败：' + JSON.stringify(r.diagnostics));
    return new RuntimeSession({ desc: r.desc, seed: 11 });
  }

  const posOf = (s: RuntimeSession, nodeId: string): string[] =>
    s
      .view()
      .filter((e) => e.kind === 'npc' && e.sourceNodeId === nodeId)
      .map((e) => `${e.x.toFixed(6)},${e.z.toFixed(6)}`)
      .sort();

  it('🔴 改 sp0 的 count，sp1 / sp2 的初始位置逐位不变', () => {
    const base = posOf(withCount('nd_f1r0_sp0', 5), 'nd_f1r0_sp1');
    const after = posOf(withCount('nd_f1r0_sp0', 13), 'nd_f1r0_sp1');
    expect(base.length).toBeGreaterThan(0);
    expect(after).toEqual(base);
  });

  it('改 count 只影响被改的那一处，总数变化正确', () => {
    const s = withCount('nd_f1r0_sp0', 13);
    expect(s.view().filter((e) => e.sourceNodeId === 'nd_f1r0_sp0')).toHaveLength(13);
    expect(s.countNpc()).toBe(20); // 13 + 4 + 3
  });

  it('派生流仍然随会话种子变化（局部性不是把种子废掉）', () => {
    const a = new RuntimeSession({ desc: desc(), seed: 1 }).view().map((e) => e.x.toFixed(6));
    const b = new RuntimeSession({ desc: desc(), seed: 2 }).view().map((e) => e.x.toFixed(6));
    expect(b).not.toEqual(a);
  });
});
