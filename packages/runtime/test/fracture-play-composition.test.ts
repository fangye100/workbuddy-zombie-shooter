/**
 * WU-04 宿主窄组合测试（R3）：真实 PlaySession registerResource 账目、初始场景镜像、
 * 场景变化再 sync、Stop 释放、重开新 session、时钟一致性校验。实际加载 Rapier WASM。
 */
import { describe, it, expect } from 'vitest';
import { SceneGraph } from '@aether/scene';
import { bindFractureToPlay, type FracturePlayHost } from '../src/fracture-play-composition';

const STEP = 1 / 60;

/** 模拟宿主 Play 生命周期：登记资源 + 固定步长 + Stop 释放（与 PlaySession 契约一致）。 */
function makeHost(fixedStepSec = STEP): FracturePlayHost & { disposeAll(): void; ledger(): number } {
  const resources: { label: string; dispose: () => void }[] = [];
  return {
    fixedStepSec,
    registerResource(label, dispose) { resources.push({ label, dispose }); },
    disposeAll() { for (const r of [...resources].reverse()) r.dispose(); resources.length = 0; },
    ledger: () => resources.length,
  };
}

function makeScene(withGround = true): SceneGraph {
  const g = new SceneGraph();
  if (withGround) {
    const ground = g.addNode({ id: 'nd_ground', name: 'ground', components: [
      { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [20, 0.5, 20] } } as never,
    ] });
    g.setLocalTransform(ground, { position: [0, 0, 0] });
  }
  g.updateWorldTransforms();
  return g;
}

describe('WU-04 宿主窄组合（R3）', () => {
  it('启动装配：后端就绪后做首次场景镜像 sync，登记资源进账目', async () => {
    const host = makeHost();
    const b = bindFractureToPlay(host, { initialScene: makeScene() });
    expect(host.ledger()).toBe(1); // 已登记 fracture-runtime
    // 等待异步后端就绪（WASM 加载 + start）
    expect(await b.ready).toBe(true);
    // 后端就绪：runtime 可访问，场景已镜像
    const backend = b.backend();
    expect(backend).not.toBeNull();
    expect(b.runtime).toBeDefined();
    expect(backend!.ledger.staticColliders).toBe(1); // ground 已镜像
    host.disposeAll();
  });

  it('场景 collider 变化后再次正式 sync：新增/删除镜像反映到后端', async () => {
    const host = makeHost();
    const scene = makeScene();
    const b = bindFractureToPlay(host, { initialScene: scene });
    expect(await b.ready).toBe(true);
    expect(b.backend()!.ledger.staticColliders).toBe(1);
    // 场景变化：加一堵墙
    const wall = scene.addNode({ id: 'nd_wall', name: 'wall', components: [
      { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [0.25, 1.5, 3] } } as never,
    ] });
    scene.setLocalTransform(wall, { position: [3, 1.5, 0] });
    scene.updateWorldTransforms();
    b.syncScene(scene);
    expect(b.backend()!.ledger.staticColliders).toBe(2);
    // 删除地面节点：sync 差分移除其镜像
    scene.removeNode('nd_ground');
    scene.updateWorldTransforms();
    b.syncScene(scene);
    expect(b.backend()!.ledger.staticColliders).toBe(1);
    host.disposeAll();
  });

  it('Stop 经登记资源释放后端 World；重开创建新 session（旧 disposed 不再 start）', async () => {
    const host = makeHost();
    const b1 = bindFractureToPlay(host, { initialScene: makeScene() });
    expect(await b1.ready).toBe(true);
    const backend1 = b1.backend();
    expect(backend1).not.toBeNull();
    host.disposeAll(); // Stop
    expect(backend1!.ledger.destroyed).toBe(true);
    expect(b1.session.disposed).toBe(true);
    expect(b1.backend()).toBeNull();
    // 重开 = 新 binding + 新 session（旧 session 已 disposed，不能再 start）
    const host2 = makeHost();
    const b2 = bindFractureToPlay(host2, { initialScene: makeScene() });
    expect(await b2.ready).toBe(true);
    expect(b2.backend()).not.toBeNull();
    expect(b2.backend()!.ledger.destroyed).toBe(false);
    expect(b2.session).not.toBe(b1.session);
    host2.disposeAll();
  });

  it('时钟一致性：宿主步长与后端 timestep 不一致时拒绝（不静默分离时钟）', async () => {
    const host = makeHost(1 / 30); // 宿主 1/30，但 session start 也用 1/30（一致）
    const b = bindFractureToPlay(host, { initialScene: makeScene() });
    expect(await b.ready).toBe(true);
    expect(b.backend()).not.toBeNull();
    // runtime 用 host.fixedStepSec(1/30) 与后端 timestep(1/30) 一致 → 正常
    expect(b.runtime).toBeDefined();
    host.disposeAll();
    // 不一致场景：createFractureRuntime 内部校验（直接验证）
    const { createFracturePhysicsSession } = await import('../src/fracture-physics-session');
    const { createFractureRuntime } = await import('../src/fracture-runtime');
    const s = createFracturePhysicsSession();
    const r = await s.start({ fixedStepSec: 1 / 60 });
    expect(r.status).toBe('started');
    if (r.status === 'started' && r.backend) {
      expect(() => createFractureRuntime(r.backend!, { fixedStepSec: 1 / 30 })).toThrow(/不一致/);
    }
    s.dispose();
  });
});
