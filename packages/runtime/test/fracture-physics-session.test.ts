/**
 * WU-03 物理 session 组合测试：generation 守卫 + Stop 释放账目 + 重复/并发 start 语义。
 * 实际加载 Rapier WASM。
 */
import { describe, it, expect } from 'vitest';
import { createFracturePhysicsSession } from '../src/fracture-physics-session';
import type { FractureBodyHandle } from '../src/fracture';

const STEP = 1 / 60;
const h = (key: string): FractureBodyHandle => ({ key, chunkId: key, layer: 'rigid' });
const spec = (x: number) => ({ position: [x, 2, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], shape: { type: 'sphere', radius: 0.3 } as const, mass: 1, friction: 0.5, restitution: 0 });

describe('物理 session 组合（宿主窄组合入口）', () => {
  it('start 创建独立后端；dispose 真实释放且账目归零', async () => {
    const s = createFracturePhysicsSession();
    const r = await s.start({ fixedStepSec: STEP });
    expect(r.status).toBe('started');
    const backend = r.backend!;
    expect(s.backend).toBe(backend);
    backend.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    backend.addBody(h('a'), spec(0));
    expect(backend.ledger.dynamicBodies).toBe(1);
    s.dispose();
    expect(s.disposed).toBe(true);
    expect(s.backend).toBeNull();
    expect(backend.ledger.destroyed).toBe(true);
    expect(backend.ledger.dynamicBodies).toBe(0);
  });

  it('R1-顺序重复 start 被拒绝：不覆盖唯一 backend，dispose 后第一份也被真实释放', async () => {
    const s = createFracturePhysicsSession();
    const r1 = await s.start({ fixedStepSec: STEP });
    expect(r1.status).toBe('started');
    const first = r1.backend!;
    first.addBody(h('a'), spec(0));
    // 已有活动后端时再次 start → 拒绝，不新建第二份 World
    const r2 = await s.start({ fixedStepSec: STEP });
    expect(r2.status).toBe('rejected');
    expect(r2.backend).toBeNull();
    expect(s.backend).toBe(first); // 唯一引用未被覆盖
    s.dispose();
    // dispose 释放唯一拥有的第一份：它被真实 destroy，不留活动 World
    expect(first.ledger.destroyed).toBe(true);
    expect(first.snapshot(h('a'))).toBeNull();
    expect(s.backend).toBeNull();
  });

  it('R1-并发重复 start：第二个在初始化进行中被拒绝，不留下第二份 World', async () => {
    const s = createFracturePhysicsSession();
    const p1 = s.start({ fixedStepSec: STEP });
    const p2 = s.start({ fixedStepSec: STEP }); // 并发：initializing 期间
    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(['rejected', 'started']);
    const started = (r1.status === 'started' ? r1 : r2).backend!;
    expect(s.backend).toBe(started);
    s.dispose();
    expect(started.ledger.destroyed).toBe(true);
  });

  it('R1-并发初始化中 Stop：迟到的 start 返回 cancelled，不复活 backend', async () => {
    const s = createFracturePhysicsSession();
    const pending = s.start({ fixedStepSec: STEP });
    s.dispose(); // 初始化 resolve 前 Stop
    const r = await pending;
    expect(r.status).toBe('cancelled');
    expect(r.backend).toBeNull();
    expect(s.backend).toBeNull();
  });

  it('R1-dispose 后再 start 返回 cancelled，不新建 World', async () => {
    const s = createFracturePhysicsSession();
    await s.start({ fixedStepSec: STEP });
    s.dispose();
    const r = await s.start({ fixedStepSec: STEP });
    expect(r.status).toBe('cancelled');
    expect(r.backend).toBeNull();
    expect(s.backend).toBeNull();
  });

  it('R1-非法选项的 start 失败抛错后 session 仍可安全重试与 dispose', async () => {
    // 校验在 World 分配之前抛错：失败的 start 不产生半初始化后端，
    // session 保持可用（busy=false、backend=null），可用合法参数重试并成功 Stop。
    const s = createFracturePhysicsSession();
    await expect(s.start({ fixedStepSec: STEP, maxLinearSpeed: NaN })).rejects.toThrow(/有限正数/);
    expect(s.busy).toBe(false);
    expect(s.backend).toBeNull();
    expect(s.disposed).toBe(false);
    // 重试合法参数：正常启动
    const r = await s.start({ fixedStepSec: STEP });
    expect(r.status).toBe('started');
    expect(s.backend).toBe(r.backend);
    // Stop：真实释放，账目归零
    s.dispose();
    expect(r.backend!.ledger.destroyed).toBe(true);
    expect(s.backend).toBeNull();
  });

  it('两个 session 的 World 隔离：一个 dispose 不影响另一个', async () => {
    const s1 = createFracturePhysicsSession();
    const s2 = createFracturePhysicsSession();
    const b1 = (await s1.start({ fixedStepSec: STEP })).backend!;
    const b2 = (await s2.start({ fixedStepSec: STEP })).backend!;
    b1.addBody(h('x'), spec(0));
    b2.addBody(h('y'), spec(5));
    s1.dispose();
    expect(s1.backend).toBeNull();
    // s2 仍独立可用
    b2.step(0);
    expect(b2.snapshot(h('y'))).not.toBeNull();
    expect(b2.ledger.destroyed).toBe(false);
    s2.dispose();
  });

  it('重复 dispose 安全', async () => {
    const s = createFracturePhysicsSession();
    await s.start({ fixedStepSec: STEP });
    s.dispose();
    expect(() => s.dispose()).not.toThrow();
    expect(s.backend).toBeNull();
  });
});
