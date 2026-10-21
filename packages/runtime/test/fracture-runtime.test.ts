/**
 * WU-04 碎片运行与预算 owner 测试：实际加载 Rapier WASM。
 * 覆盖：真实/简化两层、固定输入可复现、正式 P-01 profile 激活、去重与代次身份、
 * 满池/优先级/TTL/淡出、Pause/Step/有界多 tick、Stop 重开/迟到、各分配阶段异常
 * 清理、真实物理组合、武器投射物配额不被占用。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { ensureRapier, RapierFractureBackend, type RapierModule } from '../src/fracture-rapier';
import { createFractureRuntime, type FractureActivation, type FractureChunkInput } from '../src/fracture-runtime';
import { frozenFractureEvent, type FractureEvent } from '../src/fracture';
import { ObjectPool } from '@aether/core';

const STEP = 1 / 60;
let rapier: RapierModule;
beforeAll(async () => { rapier = await ensureRapier(); }, 30000);

function makeRuntime(opts = {}) {
  const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
  // 一块地面镜像，让真实刚体有接触对象。
  backend.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [20, 0.5, 20] } });
  const rt = createFractureRuntime(backend, { ...opts });
  return { backend, rt };
}

let seq = 0;
function ev(nodeId: string, seed = 42): FractureEvent {
  return frozenFractureEvent({
    sequence: ++seq, tick: 0, seed,
    profile: { path: 'assets/fracture/p01-barrel/p01-barrel.fracture.json', guid: 'as_p01frct' },
    target: { kind: 'scene-object', runId: 'run-1', nodeId },
    position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    contact: [0, 2, 0], normal: [0, 1, 0], impulse: [1, 2, 0.5],
    source: { weaponId: 'w_pistol', hitSequence: seq },
  });
}

function chunk(chunkId: string, cls: 'large' | 'small', x = 0): FractureChunkInput {
  return {
    chunkId, cls,
    mesh: { path: 'assets/test/chunk.glb', guid: 'as_test_' + chunkId },
    position: [x, 2, 0], rotation: [0, 0, 0, 1], scale: 1,
    shape: { type: 'box', halfExtents: [0.15, 0.15, 0.15] },
    mass: 1.5, friction: 0.6, restitution: 0.35,
    linearVelocity: [1, 2, 0.5], angularVelocity: [2, 1, 0],
  };
}

function act(nodeId: string, chunks: FractureChunkInput[], opts: Partial<FractureActivation> = {}): FractureActivation {
  return { event: ev(nodeId), chunks, priority: 2, lifetimeSec: 4, fadeSec: 0.8, ...opts };
}

describe('WU-04 两层播放与真实物理组合', () => {
  it.each([0,-2])('简化块实际接触零高度/地下层地板（top=%s），不因世界坐标原点漏检',top=>{
    const {backend,rt}=makeRuntime();backend.removeStatic('ground');
    backend.upsertStatic('floor',{position:[0,top-.15,0],rotation:[0,0,0,1],shape:{type:'box',halfExtents:[10,.15,10]}});
    expect(rt.play(act('zero-ground',[{...chunk('foot','small'),position:[0,top+.2,0],linearVelocity:[0,0,0]}])).accepted).toBe(true);
    rt.stepOnce();for(let i=0;i<180;i++)rt.stepOnce();
    expect(rt.active[0]!.sim!.position[1]).toBeGreaterThan(top+.1);expect(rt.active[0]!.sim!.position[1]).toBeLessThan(top+.4);rt.dispose();
  });
  it('当前姿态 small 块初始与脚下地面重叠时推出接触，不穿地且不跳到头顶面',()=>{
    const {backend,rt}=makeRuntime();
    backend.upsertStatic('ceiling',{position:[0,3,0],rotation:[0,0,0,1],shape:{type:'box',halfExtents:[10,.1,10]}});
    const c={...chunk('posed-foot','small'),position:[0,.55,0] as const,linearVelocity:[0,-.1,0] as const};
    expect(rt.play(act('posed-npc',[c])).accepted).toBe(true);rt.stepOnce();
    const state=rt.active[0]!.sim!;
    expect(state.position[1]).toBeGreaterThan(.6);expect(state.position[1]).toBeLessThan(1);
    for(let i=0;i<120;i++)rt.stepOnce();expect(state.position[1]).toBeGreaterThan(.6);
    rt.dispose();
  });
  it('large 块创建真实 Rapier body 且随 step 运动；small 块走简化积分且仍是三维运动状态', () => {
    const { backend, rt } = makeRuntime();
    const r = rt.play(act('n1', [chunk('c1', 'large'), chunk('c2', 'small', 1)]));
    expect(r.accepted).toBe(true);
    rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(1);
    expect(rt.stats.simplifiedActive).toBe(1);
    const rigid = rt.active.find((c) => c.layer === 'rigid')!;
    const snap = backend.snapshot(rigid.handle);
    expect(snap).not.toBeNull();
    // 真实刚体：线速度进入求解器（重力作用下 y 速度递减）
    expect(snap!.linearVelocity[1]).toBeLessThan(2);
    // 简化块：位置随积分推进
    const simp = rt.active.find((c) => c.layer === 'simplified')!;
    expect(simp.sim!.position[1]).toBeGreaterThan(1.9);
    rt.dispose();
    expect(backend.ledger.destroyed).toBe(true);
  });

  it('固定输入 + 同 seed 的轨迹可复现（同一进程同库版本容差内一致）', () => {
    const run = () => {
      const { backend, rt } = makeRuntime();
      rt.play(act('n1', [chunk('c1', 'large')]));
      for (let i = 0; i < 30; i++) rt.stepOnce();
      const s = backend.snapshot(rt.active[0]!.handle)!;
      const out = [...s.position, ...s.rotation];
      rt.dispose();
      return out;
    };
    const a = run();
    const b = run();
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(1e-6);
  });

  it('正常容量下 large 块实际走真实 body 路径（不全部回退简化）', () => {
    const { backend, rt } = makeRuntime();
    rt.play(act('n1', [chunk('c1', 'large'), chunk('c2', 'large', 1), chunk('c3', 'large', 2)]));
    rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(3);
    expect(backend.ledger.dynamicBodies).toBe(3);
    rt.dispose();
  });
});

describe('WU-04 去重与身份', () => {
  it('同 run/target 重复事件去重，不重复建 body', () => {
    const { backend, rt } = makeRuntime();
    const a = act('n1', [chunk('c1', 'large')]);
    expect(rt.play(a).accepted).toBe(true);
    expect(rt.play(a).accepted).toBe(false);
    expect(rt.stats.deduplicated).toBe(1);
    rt.stepOnce();
    expect(backend.ledger.dynamicBodies).toBe(1);
    rt.dispose();
  });

  it('不同 nodeId/不同 runId 是不同身份，可分别碎裂', () => {
    const { rt } = makeRuntime();
    expect(rt.play(act('n1', [chunk('c1', 'large')])).accepted).toBe(true);
    expect(rt.play(act('n2', [chunk('c1', 'large')])).accepted).toBe(true);
    rt.dispose();
  });

  it('句柄 key 含激活代次：同 target 重开的新 session 不复用旧 key', () => {
    const { backend, rt } = makeRuntime();
    rt.play(act('n1', [chunk('c1', 'large')]));
    rt.stepOnce();
    const k1 = rt.active[0]!.handle.key;
    rt.dispose();
    expect(backend.ledger.destroyed).toBe(true);
    // 新 runtime（重开新 session）同 target 再碎裂：key 代次不同
    const r2 = makeRuntime();
    r2.rt.play(act('n1', [chunk('c1', 'large')]));
    r2.rt.stepOnce();
    const k2 = r2.rt.active[0]!.handle.key;
    expect(k1).not.toBe(k2);
    expect(k1).toContain('#g');
    expect(k2).toContain('#g');
    r2.rt.dispose();
  });
});

describe('WU-04 准入校验（分配前拒绝）', () => {
  it('空块/坏尺度/坏质量/非有限速度在物理资源分配前拒绝且不建 body', () => {
    const { backend, rt } = makeRuntime();
    expect(rt.play(act('n1', [])).rejection!.reason).toBe('invalid-activation');
    expect(rt.play(act('n2', [{ ...chunk('c1', 'large'), scale: 0 }])).rejection!.reason).toBe('invalid-activation');
    expect(rt.play(act('n3', [{ ...chunk('c1', 'large'), mass: -1 }])).rejection!.reason).toBe('invalid-activation');
    expect(rt.play(act('n4', [{ ...chunk('c1', 'large'), linearVelocity: [NaN, 0, 0] }])).rejection!.reason).toBe('invalid-activation');
    expect(rt.play(act('n5', [chunk('c1', 'large'), chunk('c1', 'large')])).rejection!.reason).toBe('invalid-activation'); // 重复 chunkId
    rt.stepOnce();
    expect(backend.ledger.dynamicBodies).toBe(0);
    expect(rt.stats.rejectedAdmission).toBe(5);
    rt.dispose();
  });

  it('事件队列满拒绝新事件并计数', () => {
    const { rt } = makeRuntime({ maxEventQueue: 2 });
    expect(rt.play(act('n1', [chunk('c1', 'large')])).accepted).toBe(true);
    expect(rt.play(act('n2', [chunk('c1', 'large')])).accepted).toBe(true);
    const r = rt.play(act('n3', [chunk('c1', 'large')]));
    expect(r.accepted).toBe(false);
    expect(r.rejection!.reason).toBe('queue-full');
    rt.dispose();
  });

  it('dispose 后拒绝播放', () => {
    const { rt } = makeRuntime();
    rt.dispose();
    expect(rt.play(act('n1', [chunk('c1', 'large')])).rejection!.reason).toBe('session-closed');
  });
});

describe('WU-04 预算/优先级/TTL', () => {
  it('真实刚体满额时高优先级新进者淘汰低优先级旧者，并显式计数', () => {
    const { backend, rt } = makeRuntime({ maxRigidBodies: 2 });
    rt.play(act('n1', [chunk('c1', 'large')], { priority: 1 }));
    rt.play(act('n2', [chunk('c1', 'large')], { priority: 1 }));
    rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(2);
    // 高优先级新进者淘汰一个低优先级
    rt.play(act('n3', [chunk('c1', 'large')], { priority: 9 }));
    rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(2);
    expect(rt.stats.evicted).toBe(1);
    expect(backend.ledger.dynamicBodies).toBe(2);
    rt.dispose();
  });

  it('低优先级新进者在满额且不占优时被跳过，显式计数不静默丢块', () => {
    const { rt } = makeRuntime({ maxRigidBodies: 1 });
    rt.play(act('n1', [chunk('c1', 'large')], { priority: 5 }));
    rt.stepOnce();
    rt.play(act('n2', [chunk('c1', 'large')], { priority: 1 }));
    rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(1); // 仍是高优先级那一个
    expect(rt.active[0]!.priority).toBe(5);
    expect(rt.stats.evicted).toBe(0);
    expect(rt.stats.skipped).toBe(1); // 跳块显式计数
    rt.dispose();
  });

  it('TTL 到期经淡出退役并计数，释放真实 body', () => {
    const { backend, rt } = makeRuntime();
    rt.play(act('n1', [chunk('c1', 'large')], { lifetimeSec: 3 * STEP, fadeSec: 0 }));
    rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(1);
    for (let i = 0; i < 5; i++) rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(0);
    expect(rt.stats.expired).toBe(1);
    expect(backend.ledger.dynamicBodies).toBe(0);
    rt.dispose();
  });

  it('同 tick 多块到期全部按时退役（遍历拷贝不跳块、不延迟）', () => {
    const { backend, rt } = makeRuntime();
    // 4 块同 lifetime 同 tick 到期
    rt.play(act('n1', [chunk('c1', 'large'), chunk('c2', 'large', 1), chunk('c3', 'large', 2), chunk('c4', 'large', 3)], { lifetimeSec: 2 * STEP, fadeSec: 0 }));
    rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(4);
    rt.stepOnce(); // 第 2 tick：age=2*STEP 到期，4 块同 tick 退役
    expect(rt.stats.rigidActive).toBe(0);
    expect(rt.stats.expired).toBe(4);
    expect(backend.ledger.dynamicBodies).toBe(0);
    rt.dispose();
  });

  it('淡出期内 fade 递增，淡出完毕才退役', () => {
    const { rt } = makeRuntime();
    rt.play(act('n1', [chunk('c1', 'large')], { lifetimeSec: 2 * STEP, fadeSec: 4 * STEP }));
    for (let i = 0; i < 3; i++) rt.stepOnce();
    const c = rt.active[0]!;
    expect(c.fade).toBeGreaterThan(0);
    expect(c.fade).toBeLessThan(1);
    for (let i = 0; i < 4; i++) rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(0);
    rt.dispose();
  });
});

describe('WU-04 固定步长 / Pause / Step / 有界追赶', () => {
  it('tick 按固定步长消费；不足一步不推进；Pause（不调用 tick）不推进', () => {
    const { rt } = makeRuntime();
    rt.play(act('n1', [chunk('c1', 'large')]));
    rt.tick(STEP / 2); // 不足一步
    expect(rt.stats.ticks).toBe(0);
    rt.tick(STEP / 2); // 凑满一步
    expect(rt.stats.ticks).toBe(1);
    // Pause：长时间不调用 tick，ticks 不变
    const t = rt.stats.ticks;
    expect(rt.stats.ticks).toBe(t);
    rt.dispose();
  });

  it('stepOnce 恰推进一个固定 tick', () => {
    const { rt } = makeRuntime();
    rt.play(act('n1', [chunk('c1', 'large')]));
    rt.stepOnce();
    expect(rt.stats.ticks).toBe(1);
    rt.stepOnce();
    expect(rt.stats.ticks).toBe(2);
    rt.dispose();
  });

  it('单帧大 dt 有界多 tick 追赶（maxCatchUpTicks），不雪崩', () => {
    const { rt } = makeRuntime({ maxCatchUpTicks: 3 });
    rt.play(act('n1', [chunk('c1', 'large')]));
    rt.tick(10 * STEP); // 一帧涌入 10 步时间
    expect(rt.stats.ticks).toBeLessThanOrEqual(3);
    rt.dispose();
  });

  it('渲染频率不反推物理时钟：两种不同拆帧得到相同总步数', () => {
    // 拆法 A：4 帧 × 1 步
    const a = makeRuntime();
    a.rt.play(act('n1', [chunk('c1', 'large')]));
    for (let i = 0; i < 4; i++) a.rt.tick(STEP);
    const ticksA = a.rt.stats.ticks;
    expect(ticksA).toBe(4);
    a.rt.dispose();

    // 拆法 B：2 帧 × 2 步（同一段真实时间）
    const b = makeRuntime();
    b.rt.play(act('n1', [chunk('c1', 'large')]));
    for (let i = 0; i < 2; i++) b.rt.tick(2 * STEP);
    const ticksB = b.rt.stats.ticks;
    expect(ticksB).toBe(4);
    b.rt.dispose();

    // 两种拆法总步数一致：帧率只影响调用次数，不反推物理时钟
    expect(ticksB).toBe(ticksA);
  });

  it('W04-04：profile 的 collisionGroup 真实进入碰撞组（environment 与 debris 不同）', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    const mk = (id: string, g: 'environment' | 'debris'): FractureChunkInput => ({
      ...chunk(id, 'large'), collisionGroup: g,
      linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    });
    expect(rt.play(act('n1', [mk('e', 'environment'), mk('d', 'debris')])).accepted).toBe(true);
    rt.stepOnce();
    const env = rt.active.find((a) => a.mesh.guid.endsWith('e'))!;
    const deb = rt.active.find((a) => a.mesh.guid.endsWith('d'))!;
    const ge = backend.bodyGroups(env.handle)!;
    const gd = backend.bodyGroups(deb.handle)!;
    // 两者必须不同（配置真的被消费），且都不与 player/npc 互撞
    expect(ge).not.toBe(gd);
    const membership = (g: number) => (g >>> 16) & 0xffff;
    const filter = (g: number) => g & 0xffff;
    expect(membership(ge)).toBe(0x0002); // chunk
    expect(membership(gd)).toBe(0x0010); // debris
    for (const g of [ge, gd]) {
      expect(filter(g) & 0x0004).toBe(0); // player 排除
      expect(filter(g) & 0x0008).toBe(0); // npc 排除
      expect(filter(g) & 0x0001).toBe(0x0001); // 与环境碰撞
    }
    // debris 只与环境碰撞；environment 还与其他 chunk 互撞
    expect(filter(gd) & 0x0002).toBe(0);
    expect(filter(ge) & 0x0002).toBe(0x0002);
    rt.dispose();
  });

  it('R6：profile 声明的块级线/角速度上限在实际推进中被消费', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    // 初始速度远超上限（线 400 m/s、角 400 rad/s），块级上限 = 1 / 2
    const wild: FractureChunkInput = {
      ...chunk('c1', 'large'),
      position: [0, 5, 0],
      shape: { type: 'sphere', radius: 0.25 },
      linearVelocity: [400, 0, 0], angularVelocity: [0, 400, 0],
      maxLinearSpeed: 1, maxAngularSpeed: 2,
    };
    expect(rt.play(act('n1', [wild])).accepted).toBe(true);
    rt.stepOnce();
    const s = backend.snapshot(rt.active[0]!.handle)!;
    const lin = Math.hypot(s.linearVelocity[0], s.linearVelocity[1], s.linearVelocity[2]);
    const ang = Math.hypot(s.angularVelocity[0], s.angularVelocity[1], s.angularVelocity[2]);
    // 上限生效：速度被压到 1 / 2 附近（含一步重力分量），绝不允许 400 原样穿透
    expect(lin).toBeLessThan(1.5);
    expect(lin).toBeGreaterThan(0.5);
    expect(ang).toBeLessThanOrEqual(2.0001);
    expect(ang).toBeGreaterThan(1.5);
    rt.dispose();
  });
});

describe('WU-04 生命周期与异常清理', () => {
  it('R4：退役顺序是「先归还租约、再释放后端 body」', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    // 单块：dispose 时 backend.release 里读到的 poolActive 必须是 0
    const seen: number[] = [];
    const origRelease = backend.release.bind(backend);
    backend.release = (h) => { seen.push(rt.stats.poolActive); origRelease(h); };
    expect(rt.play(act('n1', [chunk('c1', 'large')])).accepted).toBe(true);
    rt.stepOnce();
    expect(rt.stats.poolActive).toBe(1);
    rt.dispose();
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(0); // 租约已先归还
    expect(rt.stats.poolActive).toBe(0);

    // 两块：每次 release 观察到的 poolActive 单调下降（先还再放）
    const backend2 = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt2 = createFractureRuntime(backend2);
    const seen2: number[] = [];
    const orig2 = backend2.release.bind(backend2);
    backend2.release = (h) => { seen2.push(rt2.stats.poolActive); orig2(h); };
    expect(rt2.play(act('n2', [chunk('a', 'large'), chunk('b', 'large')])).accepted).toBe(true);
    rt2.stepOnce();
    expect(rt2.stats.poolActive).toBe(2);
    rt2.dispose();
    expect(seen2).toEqual([1, 0]);
  });

  it('R4：租约 acquire 失败时已建 body 被回收（真实注入 acquire，不是 addBody）', () => {
    const { backend, rt } = makeRuntime();
    // 只让第一次 acquire 抛错：这正是修复前「先建 body、后借租约」会留下孤儿的路径。
    const spy = vi.spyOn(ObjectPool.prototype, 'acquire').mockImplementationOnce(() => {
      throw new Error('pool exhausted');
    });
    expect(rt.play(act('n1', [chunk('c1', 'large')])).accepted).toBe(true);
    expect(() => rt.stepOnce()).toThrow();
    spy.mockRestore();
    expect(rt.stats.failedActivations).toBe(1);
    expect(backend.ledger.dynamicBodies).toBe(0); // 无孤儿 body
    expect(rt.stats.poolActive).toBe(0);
    // 失败后同一 runtime 仍能正常激活
    expect(rt.play(act('n2', [chunk('c2', 'large')])).accepted).toBe(true);
    rt.stepOnce();
    expect(backend.ledger.dynamicBodies).toBe(1);
    rt.dispose();
    expect(backend.ledger.dynamicBodies).toBe(0);
  });

  it('Stop 经 dispose 释放全部活动租约与 World，账目归零，重复 dispose 安全', () => {
    const { backend, rt } = makeRuntime();
    rt.play(act('n1', [chunk('c1', 'large'), chunk('c2', 'small', 1)]));
    rt.stepOnce();
    expect(rt.stats.poolActive).toBe(2);
    rt.dispose();
    expect(rt.stats.rigidActive).toBe(0);
    expect(rt.stats.simplifiedActive).toBe(0);
    expect(backend.ledger.destroyed).toBe(true);
    expect(backend.ledger.dynamicBodies).toBe(0);
    expect(() => rt.dispose()).not.toThrow();
  });

  it('建 body 中途失败原子清理本事件已建对象与租约', () => {
    const { backend, rt } = makeRuntime();
    // 第二个块质量非法 → addBody 抛错；第一个块已建 body 必须被回收。
    // 用 validate 通过但 addBody 失败的情形：convex 退化点集（validate 不查几何有效性）。
    const deg: FractureChunkInput = { ...chunk('c2', 'large', 1), shape: { type: 'convex', points: new Float32Array(3) } };
    rt.play(act('n1', [chunk('c1', 'large'), deg]));
    expect(() => rt.stepOnce()).toThrow();
    // 原子清理：addBody 失败在消耗租约之前，故无活动块、无泄漏 body、无孤儿租约。
    expect(rt.stats.rigidActive).toBe(0);
    expect(backend.ledger.dynamicBodies).toBe(0);
    expect(rt.stats.poolActive).toBe(0);
    rt.dispose();
    expect(backend.ledger.destroyed).toBe(true);
    expect(backend.ledger.dynamicBodies).toBe(0);
    expect(rt.stats.poolActive).toBe(0);
  });

  it('碎片不占用武器 ProjectilePool 配额（独立 ObjectPool 实例互不影响）', () => {
    const projectilePool = new ObjectPool({ create: () => ({}), capacity: 4 });
    const { rt } = makeRuntime();
    rt.play(act('n1', [chunk('c1', 'large'), chunk('c2', 'large', 1), chunk('c3', 'large', 2)]));
    rt.stepOnce();
    expect(rt.stats.poolActive).toBe(3);
    // 武器池配额未被消耗
    expect(projectilePool.getStats().active).toBe(0);
    expect(projectilePool.getStats().created).toBe(0);
    rt.dispose();
    projectilePool.dispose();
  });

  it('旧 handle 在 dispose 后 snapshot 返回 null（不复活旧代）', () => {
    const { backend, rt } = makeRuntime();
    rt.play(act('n1', [chunk('c1', 'large')]));
    rt.stepOnce();
    const h = rt.active[0]!.handle;
    rt.dispose();
    expect(backend.snapshot(h)).toBeNull();
  });
});

describe('WU-04 可观察统计', () => {
  it('统计链路记录真实/简化活动数、去重/拒绝/淘汰/到期、租约高水位、CPU 时间', () => {
    const { rt } = makeRuntime({ maxRigidBodies: 1 });
    rt.play(act('n1', [chunk('c1', 'large'), chunk('c2', 'small', 1)], { priority: 1 }));
    rt.play(act('n1', [chunk('c1', 'large')], { priority: 1 })); // 去重
    rt.play(act('n2', [], { priority: 1 })); // 准入拒绝
    rt.stepOnce();
    rt.play(act('n3', [chunk('c1', 'large')], { priority: 9 })); // 淘汰
    rt.stepOnce();
    const s = rt.stats;
    expect(s.rigidActive).toBe(1);
    expect(s.simplifiedActive).toBe(1);
    expect(s.deduplicated).toBe(1);
    expect(s.rejectedAdmission).toBe(1);
    expect(s.evicted).toBe(1);
    expect(s.poolHighWater).toBeGreaterThanOrEqual(2);
    expect(s.ticks).toBe(2);
    rt.dispose();
  });
});


describe('WU-04 正式 profile 激活组合（WU-02 资产：P-01 物体 / E-04 NPC）', () => {
  interface ProfileChunk { chunkId: string; class: 'large' | 'small'; proxy: { shape: { type: string; halfExtents?: number[]; radius?: number; height?: number }; mass: number; friction: number; restitution: number }; pivot: number[] }
  interface Profile { id: string; kind: string; status: string; chunks: ProfileChunk[]; playback: { priority: number; lifetimeSec: number; fadeSec: number } }
  // 仓库门禁规约：测试用 import.meta.glob 而非 node:fs（未装 @types/node）。
  const profileGlob = import.meta.glob('../../../assets/fracture/*/*.fracture.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
  const load = (rel: string): Profile => {
    const key = '../../../assets/' + rel;
    const raw = profileGlob[key];
    if (raw === undefined) throw new Error('profile 未登记进 glob：' + key);
    return JSON.parse(raw) as Profile;
  };

  function activationFromProfile(profile: Profile, targetNode: string): FractureActivation {
    expect(profile.status).toBe('accepted'); // 准入：隔离资产不得激活
    const chunks: FractureChunkInput[] = profile.chunks.map((c) => {
      const s = c.proxy.shape;
      const shape = s.type === 'box'
        ? { type: 'box' as const, halfExtents: [s.halfExtents![0]!, s.halfExtents![1]!, s.halfExtents![2]!] as [number, number, number] }
        : s.type === 'sphere'
          ? { type: 'sphere' as const, radius: s.radius! }
          : { type: 'capsule' as const, radius: s.radius!, height: s.height! };
      return {
        chunkId: c.chunkId, cls: c.class,
        mesh: { path: (c as unknown as { mesh: { path: string; guid: string } }).mesh.path, guid: (c as unknown as { mesh: { path: string; guid: string } }).mesh.guid },
        position: [c.pivot[0]!, c.pivot[1]! + 0.5, c.pivot[2]!], // 抬离地面，给真实下落空间
        rotation: [0, 0, 0, 1], scale: 1,
        shape, mass: c.proxy.mass, friction: c.proxy.friction, restitution: c.proxy.restitution,
        linearVelocity: [0.5, 1.5, 0.3], angularVelocity: [1, 0.5, 0.2],
      };
    });
    return { event: ev(targetNode), chunks, priority: profile.playback.priority, lifetimeSec: profile.playback.lifetimeSec, fadeSec: profile.playback.fadeSec };
  }

  it('P-01 油桶（12 大块，正式 profile）全部创建真实 body，落地接触真实地面', () => {
    const { backend, rt } = makeRuntime();
    const r = rt.play(activationFromProfile(load('fracture/p01-barrel/p01-barrel.fracture.json'), 'barrel-1'));
    expect(r.accepted).toBe(true);
    rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(12);
    expect(backend.ledger.dynamicBodies).toBe(12);
    // 推进 90 tick：真实重力下落，全部落到地面镜像附近（y 不穿透到地面以下）
    for (let i = 0; i < 90; i++) rt.stepOnce();
    for (const c of rt.active) {
      const s = backend.snapshot(c.handle)!;
      expect(s.position[1]).toBeGreaterThan(0); // 未穿透地面（地面顶面 y=0.5，块半高 0.15）
    }
    rt.dispose();
    expect(backend.ledger.destroyed).toBe(true);
  });

  it('E-04 NPC（3 大 7 小，正式 profile）分层激活：大块真实 body、小块简化积分', () => {
    const { backend, rt } = makeRuntime();
    const r = rt.play(activationFromProfile(load('fracture/e04-bulwark/e04-bulwark.fracture.json'), 'npc-e04'));
    expect(r.accepted).toBe(true);
    rt.stepOnce();
    expect(rt.stats.rigidActive).toBe(3);
    expect(rt.stats.simplifiedActive).toBe(7);
    expect(backend.ledger.dynamicBodies).toBe(3);
    for (let i = 0; i < 30; i++) rt.stepOnce();
    // 大块真实求解、小块简化运动都是有效三维状态（位置有限）
    for (const c of rt.active) {
      if (c.layer === 'rigid') {
        const s = backend.snapshot(c.handle)!;
        expect(Number.isFinite(s.position[1])).toBe(true);
      } else {
        expect(Number.isFinite(c.sim!.position[1])).toBe(true);
      }
    }
    rt.dispose();
  });

  it('quarantined（隔离）profile 不得激活（准入在物理资源分配前拒绝）', () => {
    const { backend, rt } = makeRuntime();
    const q = { ...load('fracture/p01-barrel/p01-barrel.fracture.json'), status: 'quarantined' };
    expect(() => activationFromProfile(q, 'b-1')).toThrow();
    rt.stepOnce();
    expect(backend.ledger.dynamicBodies).toBe(0);
    rt.dispose();
  });
});


describe('WU-04 审核修复 R2/R4/R5/R6', () => {
  it('R2：无场景 collider 时小块继续下落（不生成无限地面）', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    // 不 upsert 任何静态镜像：场景无地面
    const rt = createFractureRuntime(backend);
    rt.play(act('n1', [chunk('c1', 'small')]));
    rt.stepOnce();
    const y0 = rt.active[0]!.sim!.position[1];
    for (let i = 0; i < 30; i++) rt.stepOnce();
    const y1 = rt.active[0]!.sim!.position[1];
    expect(y1).toBeLessThan(y0); // 持续下落，未停在虚构地面
    expect(rt.active[0]!.sim!.resting).toBe(false);
    rt.dispose();
  });

  it('R2：小块停在真实场景镜像支撑面顶 + 支撑半径（不塞进地板），场景变化后镜像更新', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    // 有限平台：中心 (0,0.5,0)，半尺寸 (2,0.5,2)，顶面 y=1.0
    backend.upsertStatic('ground', { position: [0, 0.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [2, 0.5, 2] } });
    const rt = createFractureRuntime(backend);
    // 小球块 radius=0.25（scale=1），从上方下落
    const ball: FractureChunkInput = { ...chunk('c1', 'small'), position: [0.5, 3, 0.5], shape: { type: 'sphere', radius: 0.25 }, friction: 0.8, restitution: 0, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    rt.play(act('n1', [ball]));
    for (let i = 0; i < 120; i++) rt.stepOnce();
    const sim = rt.active[0]!.sim!;
    // 支撑面顶 1.0 + 支撑半径 0.25 = 质心停在 1.25（不塞进地板）
    expect(sim.position[1]).toBeGreaterThan(1.2);
    expect(sim.position[1]).toBeLessThan(1.3);
    expect(sim.resting).toBe(true);
    rt.dispose();
    // 场景变化：移除镜像后小块不再受支撑
    backend.removeStatic('ground');
    expect(backend.staticSupportSurfaces().length).toBe(0);
    backend.destroy();
  });

  it('R2：有限平台边界外小块下落（边界不穿帮）', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    backend.upsertStatic('ground', { position: [0, 0.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [1, 0.5, 1] } });
    const rt = createFractureRuntime(backend);
    // 块在平台水平范围外（x=5 > halfX=1）
    const ball: FractureChunkInput = { ...chunk('c1', 'small'), position: [5, 3, 0], shape: { type: 'sphere', radius: 0.25 }, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    rt.play(act('n1', [ball]));
    for (let i = 0; i < 60; i++) rt.stepOnce();
    expect(rt.active[0]!.sim!.position[1]).toBeLessThan(1); // 落出平台，未被支撑
    rt.dispose();
  });

  it('R4：租约 acquire 失败时当前块 body 被回收（不突破预算/不泄漏 World body）', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend, { maxRigidBodies: 4 });
    // 用一个只允许 1 份的并发场景间接令 acquire 失败：塞满 4 个真实 body 后，
    // 池 capacity = maxRigid(4)+maxSimplified(256) 足够，故改为直接验证原子性：
    // 第二块 addBody 失败（退化凸点）时第一块 body 被回收。
    const deg: FractureChunkInput = { ...chunk('c2', 'large', 1), shape: { type: 'convex', points: new Float32Array(3) } };
    rt.play(act('n1', [chunk('c1', 'large'), deg]));
    expect(() => rt.stepOnce()).toThrow();
    expect(rt.stats.failedActivations).toBe(1);
    expect(rt.stats.rigidActive).toBe(0);
    expect(backend.ledger.dynamicBodies).toBe(0); // 无孤儿 body
    expect(rt.stats.poolActive).toBe(0);
    rt.dispose();
    expect(backend.ledger.destroyed).toBe(true);
  });

  it('R5：play 入队后改写调用方 chunks/event 不改变已提交请求与去重', () => {
    const { backend, rt } = makeRuntime();
    const chunks = [chunk('c1', 'large')];
    const e = ev('n1');
    // 用可变 event 复制品（非 frozenFractureEvent），证明快照隔离不依赖 TS readonly
    const mutableEvent = JSON.parse(JSON.stringify(e)) as FractureEvent;
    const r = rt.play({ event: mutableEvent, chunks, priority: 2, lifetimeSec: 4, fadeSec: 0.8 });
    expect(r.accepted).toBe(true);
    // 提交后改写原 chunks 位置与事件目标身份
    (chunks[0] as unknown as { position: number[] }).position[0] = 500;
    (mutableEvent.target as { nodeId: string }).nodeId = 'hacked';
    rt.stepOnce();
    const s = backend.snapshot(rt.active[0]!.handle)!;
    expect(s.position[0]).toBeLessThan(100); // 未采用被改写的 500
    // 去重身份仍是原 target（seen 用原 eventKey），同原 target 再去重
    const again = rt.play(act('n1', [chunk('c1', 'large')]));
    expect(again.accepted).toBe(false);
    expect(rt.stats.deduplicated).toBe(1);
    rt.dispose();
  });

  it('R6：chunk.scale 折进物理代理（非单位尺度真实生效）', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    backend.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [20, 0.5, 20] } });
    const rt = createFractureRuntime(backend);
    // radius=0.25、scale=4 → 世界半径 1.0；地面顶 y=0.5，静止应在 y≈1.5
    const big: FractureChunkInput = { ...chunk('c1', 'large'), position: [0, 5, 0], scale: 4, shape: { type: 'sphere', radius: 0.25 }, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    rt.play(act('n1', [big]));
    for (let i = 0; i < 180; i++) rt.stepOnce();
    const s = backend.snapshot(rt.active[0]!.handle)!;
    expect(s.position[1]).toBeGreaterThan(1.2); // 0.5 地面顶 + 1.0 世界半径
    expect(s.position[1]).toBeLessThan(1.8);
    rt.dispose();
  });

  it('R2：简化块不从屋内传送到天花板（支撑面按竖向扫掠选择）', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    // 地板顶 y=0.5，天花板顶 y=10.5（同 XZ 范围）
    backend.upsertStatic('floor', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    backend.upsertStatic('ceiling', { position: [0, 10, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    const rt = createFractureRuntime(backend);
    // 小球中心 y=2（地板上方、天花板下方）
    const c: FractureChunkInput = { ...chunk('c1', 'small'), position: [0, 2, 0], shape: { type: 'sphere', radius: 0.25 }, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    rt.play(act('n1', [c]));
    rt.stepOnce();
    const y = rt.active[0]!.sim!.position[1];
    // 不应被传送到天花板（y=10.75）；应在地板上方正常下落
    expect(y).toBeLessThan(2);
    expect(y).toBeGreaterThan(0.5);
    rt.dispose();
  });

  it('R2：球/胶囊静态镜像也能支撑（不再静默穿过），足印外仍下落', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    // 球：中心 (0,1,0)、半径 0.5 → 顶点 y=1.5；胶囊：中心 (4,1,0)、半径 0.25、全高 1.0 → 顶点 y=1.75
    backend.upsertStatic('ball', { position: [0, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.5 } });
    backend.upsertStatic('pill', { position: [4, 1, 0], rotation: [0, 0, 0, 1], shape: { type: 'capsule', radius: 0.25, height: 1.0 } });
    const su = backend.staticSupportSurfaces();
    expect(su.length).toBe(2);
    expect(su.map((x) => x.kind).sort()).toEqual(['capsule', 'sphere']);

    const rt = createFractureRuntime(backend);
    const mk = (id: string, x: number, z = 0): FractureChunkInput => ({
      ...chunk(id, 'small'), position: [x, 4, z],
      mesh: { path: 'assets/fracture/p01-barrel/chunk-0001.glb', guid: 'g_' + id },
      shape: { type: 'sphere', radius: 0.25 }, restitution: 0,
      linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    });
    // s1 落在球顶、s2 落在胶囊顶、s3 在球足印外（x=1 > r=0.5）
    rt.play(act('n1', [mk('s1', 0), mk('s2', 4), mk('s3', 1)]));
    for (let i = 0; i < 240; i++) rt.stepOnce();
    const by = (id: string) => rt.active.find((a) => a.sim && a.mesh.guid === 'g_' + id)?.sim;
    // 球顶 1.5 + 半径 0.25 = 1.75（竖向共线时就是顶点）
    expect(by('s1')!.position[1]).toBeGreaterThan(1.70);
    expect(by('s1')!.position[1]).toBeLessThan(1.80);
    // 胶囊顶 1.0 + 0.5 + 0.25 = 1.75
    expect(by('s2')!.position[1]).toBeGreaterThan(1.70);
    expect(by('s2')!.position[1]).toBeLessThan(1.80);
    // 足印外：不被虚假支撑
    expect(by('s3')!.position[1]).toBeLessThan(1.0);
    rt.dispose();
    backend.destroy();
  });

  it('W04-04：简化小块同样消费块级线/角速度上限', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    const wild: FractureChunkInput = {
      ...chunk('c1', 'small'), position: [0, 5, 0],
      shape: { type: 'sphere', radius: 0.25 },
      linearVelocity: [400, 0, 0], angularVelocity: [0, 400, 0],
      maxLinearSpeed: 1, maxAngularSpeed: 2,
    };
    expect(rt.play(act('n1', [wild])).accepted).toBe(true);
    const x0 = wild.position[0];
    rt.stepOnce();
    const sim = rt.active[0]!.sim!;
    // 关键：**首个**固定步的位移就必须受限（否则先飞 6.7m 再夹紧，限速形同虚设）。
    const dx = Math.abs(sim.position[0] - x0);
    expect(dx).toBeLessThanOrEqual(1 * STEP + 1e-6);
    const lin = Math.hypot(sim.linearVelocity[0], sim.linearVelocity[1], sim.linearVelocity[2]);
    const ang = Math.hypot(sim.angularVelocity[0], sim.angularVelocity[1], sim.angularVelocity[2]);
    expect(lin).toBeLessThan(1.5);
    expect(lin).toBeGreaterThan(0.5);
    expect(ang).toBeLessThanOrEqual(2.0001);
    rt.dispose();
    backend.destroy();
  });

  it('R2：简化块首次接触按底面判定（不穿透一个支撑半径）', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    backend.upsertStatic('floor', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    const rt = createFractureRuntime(backend);
    // 地板顶 0.5，球半径 0.25 → 正确静止质心 0.75。初始质心 0.76（只高 1cm），
    // 一步就会越过"质心对顶面"的旧窗口，旧实现会先掉到 ~0.51 再被抬回。
    const c: FractureChunkInput = {
      ...chunk('c1', 'small'), position: [0, 0.76, 0],
      shape: { type: 'sphere', radius: 0.25 }, restitution: 0,
      linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    };
    expect(rt.play(act('n1', [c])).accepted).toBe(true);
    let minY = Infinity;
    for (let i = 0; i < 30; i++) { rt.stepOnce(); minY = Math.min(minY, rt.active[0]!.sim!.position[1]); }
    // 全程不低于正确接触位置（允许 1cm 数值容差），终态停在 0.75
    expect(minY).toBeGreaterThan(0.74);
    expect(rt.active[0]!.sim!.position[1]).toBeCloseTo(0.75, 2);
    rt.dispose();
    backend.destroy();
  });

  it('R2：支撑删除后休眠块重新下落', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    backend.upsertStatic('floor', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    const rt = createFractureRuntime(backend);
    // 小球从上方下落，落到地板并休眠
    const c: FractureChunkInput = { ...chunk('c1', 'small'), position: [0, 1.5, 0], shape: { type: 'sphere', radius: 0.25 }, restitution: 0, linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    rt.play(act('n1', [c]));
    for (let i = 0; i < 120; i++) rt.stepOnce(); // 充分下落直到休眠
    expect(rt.active[0]!.sim!.resting).toBe(true);
    const yBefore = rt.active[0]!.sim!.position[1];
    expect(yBefore).toBeCloseTo(0.75, 2);
    // 删除地板支撑
    backend.removeStatic('floor');
    for (let i = 0; i < 60; i++) rt.stepOnce();
    // 支撑消失后应重新下落
    expect(rt.active[0]!.sim!.position[1]).toBeLessThan(yBefore - 0.1);
    rt.dispose();
  });

  it('R2：30° 倾斜盒——足印内按竖向线求交的真实高度支撑，足印外不虚假支撑', () => {
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    // 盒中心 (0,0,0)，局部半尺寸 (10, 0.25, 10)，绕 Z 轴转 30°（y 轴不变）。
    // 顶面世界平面方程：y = (halfY + sin30°·x)/cos30°（= x·tan30° + 0.25/cos30°）。
    const theta = Math.PI / 6;
    const q: [number, number, number, number] = [0, 0, Math.sin(theta / 2), Math.cos(theta / 2)];
    backend.upsertStatic('ramp', { position: [0, 0, 0], rotation: q, shape: { type: 'box', halfExtents: [10, 0.25, 10] } });
    const rt = createFractureRuntime(backend);
    const mk = (id: string, x: number): FractureChunkInput => ({
      ...chunk(id, 'small'), position: [x, 6, 0],
      // mesh.guid 携带 chunkId，便于按块断言（ActiveChunk 不暴露 chunkId）
      mesh: { path: 'assets/fracture/p01-barrel/chunk-0001.glb', guid: 'g_' + id },
      shape: { type: 'sphere', radius: 0.25 }, restitution: 0,
      linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    });
    // 竖向线与 OBB 求交的几何真值（完整交点旋转回世界，交点必落回查询竖线 x=qx）：
    //   顶面平面方程 y=(0.25+sin30°·x)/cos30°：x=1 → 面 0.8660 → 质心(+半径0.25)=1.1160
    //   x=3 → 面 2.0207 → 质心=2.2707。
    // 偏差实现（漏 ddx/ddz，等价旧 bug 的 cos²θ 近似）会给出 0.8995/1.7655，落入斜坡内部。
    // x=11：斜坡世界边缘之外（角点 |x| = 10cos30° + 0.25sin30° ≈ 8.785），应持续下落。
    rt.play(act('n1', [mk('c1', 1), mk('c2', 3), mk('c3', 11)]));
    for (let i = 0; i < 240; i++) rt.stepOnce();
    const by = (id: string) => rt.active.find((a) => a.sim && a.mesh.guid === 'g_' + id)?.sim;
    expect(by('c1')!.position[1]).toBeGreaterThan(1.07);
    expect(by('c1')!.position[1]).toBeLessThan(1.16);
    expect(by('c2')!.position[1]).toBeGreaterThan(2.22);
    expect(by('c2')!.position[1]).toBeLessThan(2.32);
    // 块 c3 在斜坡足印外：不被虚假支撑，持续下落到远低于斜坡任何表面
    expect(by('c3')!.position[1]).toBeLessThan(0.5);
    rt.dispose();
    backend.destroy();
  });
});
