/**
 * WU-03 真实物理后端集成测试：实际加载 Rapier WASM（非 mock）。
 * 覆盖落地/墙碰/块间接触/偏心冲量三轴旋转/休眠/暂停单步固定多 tick/
 * 碰撞分组排除玩家/镜像移除通路/Stop 释放/异步迟到取消/失败路径。
 * 浮点用有依据容差，不承诺跨平台逐 bit 相同。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureRapier,
  createRapierBackend,
  RapierFractureBackend,
  collisionGroups,
  FRACTURE_GROUP,
  CHUNK_GROUPS,
  type RapierModule,
} from '../src/fracture-rapier';
import { sceneColliderToStaticMirror } from '../src/fracture-static-mirror';
import type { FractureBodyHandle } from '../src/fracture';

const STEP = 1 / 60;
let rapier: RapierModule;

beforeAll(async () => {
  rapier = await ensureRapier();
}, 30000);

function makeBackend(): RapierFractureBackend {
  return new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
}
const h = (key: string, chunkId = key): FractureBodyHandle => ({ key, chunkId, layer: 'rigid' });

/** 世界单位阵 + 平移。 */
function translationMatrix(x: number, y: number, z: number, scale = 1): Float32Array {
  const m = new Float32Array(16);
  m[0] = scale; m[5] = scale; m[10] = scale; m[15] = 1;
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

describe('Rapier 真实后端：动态刚体', () => {
  it('自由落体 + 落地静止在地面镜像上（真实接触）', () => {
    const b = makeBackend();
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    b.addBody(h('a'), { position: [0, 3, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.5, 0.5, 0.5] }, mass: 2, friction: 0.6, restitution: 0 });
    for (let i = 0; i < 240; i++) b.step(i);
    const s = b.snapshot(h('a'))!;
    // 地面顶 y=0.5，块半高 0.5 → 质心应停在 ≈1.0（有依据容差）
    expect(s.position[1]).toBeGreaterThan(0.85);
    expect(s.position[1]).toBeLessThan(1.15);
    expect(Math.hypot(...s.linearVelocity)).toBeLessThan(0.2);
    b.destroy();
  });

  it('静态墙阻挡水平运动（真实墙接触，不穿墙）', () => {
    const b = makeBackend();
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [20, 0.5, 20] } });
    b.upsertStatic('wall', { position: [3, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.25, 1.5, 5] } });
    b.addBody(h('p'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.4 }, mass: 1, friction: 0.2, restitution: 0, linearVelocity: [8, 0, 0] });
    for (let i = 0; i < 120; i++) b.step(i);
    const s = b.snapshot(h('p'))!;
    // 墙面在 x=2.75，球半径 0.4 → 不应越过 x≈2.4
    expect(s.position[0]).toBeLessThan(2.45);
    b.destroy();
  });

  it('大块之间真实接触：上方块压下方块并共同静止', () => {
    const b = makeBackend();
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    b.addBody(h('bottom'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.5, 0.5, 0.5] }, mass: 5, friction: 0.6, restitution: 0 });
    b.addBody(h('top'), { position: [0, 2.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.4, 0.4, 0.4] }, mass: 1, friction: 0.6, restitution: 0 });
    for (let i = 0; i < 300; i++) b.step(i);
    const bottom = b.snapshot(h('bottom'))!;
    const top = b.snapshot(h('top'))!;
    // top 停在 bottom 之上：bottom 质心 ≈1.0，top 质心 ≈ 1.0+0.5+0.4=1.9
    expect(bottom.position[1]).toBeLessThan(1.15);
    expect(top.position[1]).toBeGreaterThan(1.7);
    expect(top.position[1]).toBeLessThan(2.05);
    b.destroy();
  });

  it('偏心冲量产生真实三轴角运动与姿态变化', () => {
    const b = makeBackend();
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [50, 0.5, 50] } });
    b.addBody(h('c'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.5, 0.5, 0.5] }, mass: 1, friction: 0.4, restitution: 0 });
    const before = b.snapshot(h('c'))!.rotation;
    // 命中点偏离质心（顶部边缘），水平冲量 → 产生翻滚力矩
    b.applyImpulse(h('c'), [2, 0, 0], [0, 1.5, 0]);
    for (let i = 0; i < 30; i++) b.step(i);
    const s = b.snapshot(h('c'))!;
    expect(Math.hypot(...s.angularVelocity)).toBeGreaterThan(0.1);
    const rotDelta = Math.abs(s.rotation[0] - before[0]) + Math.abs(s.rotation[1] - before[1]) + Math.abs(s.rotation[2] - before[2]) + Math.abs(s.rotation[3] - before[3]);
    expect(rotDelta).toBeGreaterThan(0.001);
    b.destroy();
  });

  it('落地后进入休眠（sleeping 可观察）', () => {
    const b = makeBackend();
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    b.addBody(h('s'), { position: [0, 1.2, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.5, 0.5, 0.5] }, mass: 1, friction: 0.8, restitution: 0 });
    let slept = false;
    for (let i = 0; i < 600; i++) { b.step(i); if (b.snapshot(h('s'))!.sleeping) { slept = true; break; } }
    expect(slept).toBe(true);
    b.destroy();
  });

  it('质量/摩擦/恢复系数真实进入求解（不同恢复系数弹跳高度不同）', () => {
    const drop = (restitution: number): number => {
      const b = makeBackend();
      b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
      b.addBody(h('b'), { position: [0, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.5 }, mass: 1, friction: 0.3, restitution });
      let apex = 0;
      for (let i = 0; i < 200; i++) { b.step(i); const y = b.snapshot(h('b'))!.position[1]; if (i > 40) apex = Math.max(apex, y); }
      b.destroy();
      return apex;
    };
    const low = drop(0);
    const high = drop(0.9);
    expect(high).toBeGreaterThan(low + 0.15);
  });
});

describe('Rapier 真实后端：固定步长与分组', () => {
  it('step 恰推进一个固定 tick（位置随步数单调推进，时间不反向）', () => {
    const b = makeBackend();
    b.addBody(h('f'), { position: [0, 5, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    const y0 = b.snapshot(h('f'))!.position[1];
    b.step(0);
    const y1 = b.snapshot(h('f'))!.position[1];
    b.step(1);
    const y2 = b.snapshot(h('f'))!.position[1];
    expect(y1).toBeLessThan(y0);
    expect(y2).toBeLessThan(y1);
    expect(b.ticks).toBe(2);
    b.destroy();
  });

  it('碰撞分组：碎片不撞玩家/NPC（分组排除真实生效）', () => {
    const b = makeBackend();
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [20, 0.5, 20] } });
    // 玩家组 collider（membership=player，filter=chunk）
    const playerGroups = collisionGroups(FRACTURE_GROUP.player, FRACTURE_GROUP.chunk);
    b.upsertStatic('player', { position: [2, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'capsule', radius: 0.4, height: 1.8 }, groups: playerGroups });
    // 碎片（CHUNK_GROUPS 排除 player/npc）水平飞过玩家位置
    b.addBody(h('chunk'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 0.5, friction: 0.3, restitution: 0, linearVelocity: [10, 0, 0], groups: CHUNK_GROUPS });
    for (let i = 0; i < 60; i++) b.step(i);
    const s = b.snapshot(h('chunk'))!;
    // 若与玩家碰撞会被挡在 x<1.3；排除后应越过玩家中心 x=2
    expect(s.position[0]).toBeGreaterThan(2.0);
    b.destroy();
  });

  it('碎片与环境及选定大块碰撞（默认分组不能绕开全部接触）', () => {
    const b = makeBackend();
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [20, 0.5, 20] } });
    b.addBody(h('big'), { position: [2.5, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.6, 0.6, 0.6] }, mass: 20, friction: 0.6, restitution: 0, groups: CHUNK_GROUPS });
    b.addBody(h('small'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 0.3, friction: 0.3, restitution: 0, linearVelocity: [10, 0, 0], groups: CHUNK_GROUPS });
    for (let i = 0; i < 60; i++) b.step(i);
    const small = b.snapshot(h('small'))!;
    // 小块撞到大块被挡：大块左面 x=1.9，小块半径 0.3 → 停在 x<1.7
    expect(small.position[0]).toBeLessThan(1.7);
    b.destroy();
  });

  it('速度/角速度上限有界（超限被夹紧）', () => {
    const b = makeBackend();
    b.addBody(h('v'), { position: [0, 50, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.2 }, mass: 1, friction: 0.3, restitution: 0, linearVelocity: [500, 0, 0], angularVelocity: [300, 0, 0] });
    b.step(0);
    const s = b.snapshot(h('v'))!;
    expect(Math.hypot(...s.linearVelocity)).toBeLessThanOrEqual(60 + 1e-3);
    expect(Math.hypot(...s.angularVelocity)).toBeLessThanOrEqual(40 + 1e-3);
    b.destroy();
  });
});

describe('Rapier 真实后端：静态镜像与生命周期', () => {
  it('移除静态镜像后通路打开（删除/开门不留幽灵 collider）', () => {
    const b = makeBackend();
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [20, 0.5, 20] } });
    b.upsertStatic('door', { position: [3, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.25, 1.5, 2] } });
    b.addBody(h('m'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.4, 0.4, 0.4] }, mass: 1, friction: 0, restitution: 0, linearVelocity: [8, 0, 0] });
    for (let i = 0; i < 30; i++) b.step(i);
    const blocked = b.snapshot(h('m'))!.position[0];
    expect(blocked).toBeLessThan(2.4); // 被门挡住
    b.removeStatic('door'); // 开门
    b.applyImpulse(h('m'), [8, 0, 0], null); // 重新推进（真实冲量）
    for (let i = 0; i < 60; i++) b.step(i);
    expect(b.snapshot(h('m'))!.position[0]).toBeGreaterThan(blocked + 1.5); // 通路打开
    b.destroy();
  });

  it('更新静态镜像（upsert 同 nodeId 即移动，不叠加）', () => {
    const b = makeBackend();
    b.upsertStatic('wall', { position: [2, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.25, 1.5, 2] } });
    b.upsertStatic('wall', { position: [6, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.25, 1.5, 2] } });
    expect(b.ledger.staticColliders).toBe(1);
    b.destroy();
  });

  it('destroy 真实释放：账目归零且重复销毁安全，旧 handle 快照为 null', () => {
    const b = makeBackend();
    b.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    b.addBody(h('x'), { position: [0, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.4 }, mass: 1, friction: 0.5, restitution: 0 });
    expect(b.ledger.dynamicBodies).toBe(1);
    b.destroy();
    const led = b.ledger;
    expect(led.destroyed).toBe(true);
    expect(led.dynamicBodies).toBe(0);
    expect(led.staticColliders).toBe(0);
    expect(b.snapshot(h('x'))).toBeNull();
    expect(() => b.destroy()).not.toThrow();
    // 销毁后 release 不抛错、step 静默
    expect(() => b.release(h('x'))).not.toThrow();
    expect(() => b.step(99)).not.toThrow();
  });

  it('release 按 key 精确移除，不误删其它 body', () => {
    const b = makeBackend();
    b.addBody(h('k1'), { position: [0, 3, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    b.addBody(h('k2'), { position: [3, 3, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    b.release(h('k1'));
    expect(b.snapshot(h('k1'))).toBeNull();
    expect(b.snapshot(h('k2'))).not.toBeNull();
    expect(b.ledger.dynamicBodies).toBe(1);
    b.destroy();
  });

  it('异步初始化迟到取消：generation 失效返回 null，不复活旧 World', async () => {
    let current = 1;
    const gen = 1;
    const promise = createRapierBackend({ fixedStepSec: STEP }, () => current === gen);
    current = 2; // 模拟 Stop/换场景
    const backend = await promise;
    expect(backend).toBeNull();
    // 同代仍创建
    const gen2 = 2;
    const ok = await createRapierBackend({ fixedStepSec: STEP }, () => current === gen2);
    expect(ok).not.toBeNull();
    ok!.destroy();
  });
});

describe('Rapier 真实后端：失败路径', () => {
  it('非法质量/重复句柄/未知句柄冲量显式报错', () => {
    const b = makeBackend();
    expect(() => b.addBody(h('bad'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 0, friction: 0.5, restitution: 0 })).toThrow(/质量/);
    b.addBody(h('dup'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    expect(() => b.addBody(h('dup'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 })).toThrow(/重复/);
    expect(() => b.applyImpulse(h('ghost'), [1, 0, 0], null)).toThrow(/未知/);
    b.destroy();
    expect(() => b.addBody(h('late'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 })).toThrow(/销毁/);
  });

  it('退化凸代理显式拒绝', () => {
    const b = makeBackend();
    expect(() => b.addBody(h('deg'), { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'convex', points: new Float32Array(3) }, mass: 1, friction: 0.5, restitution: 0 })).toThrow(/凸代理/);
    b.destroy();
  });
});

describe('静态镜像变换适配', () => {
  it('box 非均匀缩放折进 halfExtents，平移正确', () => {
    const m = new Float32Array(16);
    m[0] = 2; m[5] = 3; m[10] = 4; m[15] = 1;
    m[12] = 5; m[13] = 6; m[14] = 7;
    const r = sceneColliderToStaticMirror('n1', { type: 'box', halfExtents: [1, 1, 1] }, false, m);
    expect(r.ok).toBe(true);
    expect(r.spec!.position).toEqual([5, 6, 7]);
    expect(r.spec!.shape).toEqual({ type: 'box', halfExtents: [2, 3, 4] });
  });

  it('sphere 均匀缩放接受，非均匀明确拒绝（不静默当均匀）', () => {
    const ok = sceneColliderToStaticMirror('s1', { type: 'sphere', radius: 1 }, false, translationMatrix(0, 0, 0, 2));
    expect(ok.ok).toBe(true);
    expect(ok.spec!.shape).toEqual({ type: 'sphere', radius: 2 });
    const m = new Float32Array(16);
    m[0] = 2; m[5] = 1; m[10] = 1; m[15] = 1;
    const bad = sceneColliderToStaticMirror('s2', { type: 'sphere', radius: 1 }, false, m);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostic).toMatch(/非均匀缩放/);
  });

  it('capsule 非均匀缩放拒绝', () => {
    const m = new Float32Array(16);
    m[0] = 1; m[5] = 2; m[10] = 1; m[15] = 1;
    const r = sceneColliderToStaticMirror('c1', { type: 'capsule', radius: 0.5, height: 2 }, false, m);
    expect(r.ok).toBe(false);
    expect(r.diagnostic).toMatch(/非均匀/);
  });

  it('shear 变换所有形状拒绝', () => {
    const m = new Float32Array(16);
    m[0] = 1; m[4] = 0.5; m[5] = 1; m[10] = 1; m[15] = 1; // x 列含 y 分量 → shear
    const r = sceneColliderToStaticMirror('sh1', { type: 'box', halfExtents: [1, 1, 1] }, false, m);
    expect(r.ok).toBe(false);
    expect(r.diagnostic).toMatch(/shear/);
  });

  it('退化缩放/非有限矩阵显式 diagnostic', () => {
    const zero = new Float32Array(16);
    zero[0] = 0; zero[5] = 1; zero[10] = 1; zero[15] = 1;
    expect(sceneColliderToStaticMirror('z1', { type: 'box', halfExtents: [1, 1, 1] }, false, zero).ok).toBe(false);
    const nan = new Float32Array(16).fill(NaN);
    const r = sceneColliderToStaticMirror('z2', { type: 'box', halfExtents: [1, 1, 1] }, false, nan);
    expect(r.ok).toBe(false);
    expect(r.diagnostic).toMatch(/非有限/);
  });
});
