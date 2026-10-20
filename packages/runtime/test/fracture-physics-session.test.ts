/**
 * WU-03 物理 session 组合测试：generation 守卫 + Stop 释放账目。
 * 实际加载 Rapier WASM。
 */
import { describe, it, expect } from 'vitest';
import { createFracturePhysicsSession } from '../src/fracture-physics-session';
import type { FractureBodyHandle } from '../src/fracture';

const STEP = 1 / 60;
const h = (key: string): FractureBodyHandle => ({ key, chunkId: key, layer: 'rigid' });

describe('物理 session 组合（宿主窄组合入口）', () => {
  it('start 创建独立后端；dispose 真实释放且账目归零', async () => {
    const s = createFracturePhysicsSession();
    const backend = await s.start({ fixedStepSec: STEP });
    expect(backend).not.toBeNull();
    expect(s.backend).toBe(backend);
    backend!.upsertStatic('ground', { position: [0, 0, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [10, 0.5, 10] } });
    backend!.addBody(h('a'), { position: [0, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    expect(backend!.ledger.dynamicBodies).toBe(1);
    s.dispose();
    expect(s.disposed).toBe(true);
    expect(s.backend).toBeNull();
    expect(backend!.ledger.destroyed).toBe(true);
    expect(backend!.ledger.dynamicBodies).toBe(0);
  });

  it('dispose 后迟到的 start 不复活 backend（异步初始化迟到取消）', async () => {
    const s = createFracturePhysicsSession();
    const pending = s.start({ fixedStepSec: STEP });
    s.dispose(); // 初始化 resolve 前 Stop
    const result = await pending;
    expect(result).toBeNull();
    expect(s.backend).toBeNull();
  });

  it('两个 session 的 World 隔离：一个 dispose 不影响另一个', async () => {
    const s1 = createFracturePhysicsSession();
    const s2 = createFracturePhysicsSession();
    const b1 = await s1.start({ fixedStepSec: STEP });
    const b2 = await s2.start({ fixedStepSec: STEP });
    b1!.addBody(h('x'), { position: [0, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    b2!.addBody(h('y'), { position: [5, 2, 0], rotation: [0, 0, 0, 1], shape: { type: 'sphere', radius: 0.3 }, mass: 1, friction: 0.5, restitution: 0 });
    s1.dispose();
    expect(s1.backend).toBeNull();
    // s2 仍独立可用
    b2!.step(0);
    expect(b2!.snapshot(h('y'))).not.toBeNull();
    expect(b2!.ledger.destroyed).toBe(false);
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
