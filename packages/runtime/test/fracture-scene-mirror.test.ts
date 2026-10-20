/**
 * WU-03 宿主组合测试：从 SceneGraph 真实 collider 生成静态镜像，
 * 验证「同一 collider 真源」——碎片与镜像出的环境真实碰撞；
 * 触发器/禁用/隐藏跳过；删除节点移除镜像后通路打开；坏变换 diagnostic。
 * 实际加载 Rapier WASM。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SceneGraph } from '@aether/scene';
import { ensureRapier, RapierFractureBackend, CHUNK_GROUPS, type RapierModule } from '../src/fracture-rapier';
import { syncStaticMirrorsFromScene } from '../src/fracture-scene-mirror';
import type { FractureBodyHandle } from '../src/fracture';

const STEP = 1 / 60;
let rapier: RapierModule;
beforeAll(async () => { rapier = await ensureRapier(); }, 30000);
const h = (key: string): FractureBodyHandle => ({ key, chunkId: key, layer: 'rigid' });

function makeScene(): SceneGraph {
  const g = new SceneGraph();
  const ground = g.addNode({ id: 'nd_ground', name: 'ground', components: [
    { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [20, 0.5, 20] } } as never,
  ] });
  g.setLocalTransform(ground, { position: [0, 0, 0] });
  const wall = g.addNode({ id: 'nd_wall', name: 'wall', components: [
    { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [0.25, 1.5, 3] } } as never,
  ] });
  g.setLocalTransform(wall, { position: [3, 1.5, 0] });
  // 触发器（拾取范围）：不镜像
  g.addNode({ id: 'nd_pickup', name: 'pickup', components: [
    { kind: 'Collider', enabled: true, isTrigger: true, layer: 1, shape: { type: 'sphere', radius: 1 } } as never,
  ] });
  // 禁用 collider：不镜像
  g.addNode({ id: 'nd_disabled', name: 'disabled', components: [
    { kind: 'Collider', enabled: false, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [1, 1, 1] } } as never,
  ] });
  // 隐藏节点：不镜像
  g.addNode({ id: 'nd_hidden', name: 'hidden', visible: false, components: [
    { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [1, 1, 1] } } as never,
  ] });
  g.updateWorldTransforms();
  return g;
}

describe('宿主组合：SceneGraph collider → 静态镜像（同一真源）', () => {
  it('镜像非触发有效 collider；触发器/禁用/隐藏跳过', async () => {
    const g = makeScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.mirrored).toBe(2); // ground + wall
    expect(r.rejected).toHaveLength(0);
    expect(b.ledger.staticColliders).toBe(2);
    b.destroy();
  });

  it('镜像出的墙真实阻挡碎片（物理读的是场景 collider 真源）', async () => {
    const g = makeScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    syncStaticMirrorsFromScene(g, b);
    b.addBody(h('c'), { position: [0, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.4, 0.4, 0.4] }, mass: 1, friction: 0, restitution: 0, linearVelocity: [8, 0, 0], groups: CHUNK_GROUPS });
    for (let i = 0; i < 40; i++) b.step(i);
    // 墙在 x=3 半厚 0.25 → 左面 2.75，块半宽 0.4 → 停在 x<2.4
    expect(b.snapshot(h('c'))!.position[0]).toBeLessThan(2.4);
    b.destroy();
  });

  it('删除节点后移除镜像，通路打开（无幽灵 collider）', async () => {
    const g = makeScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    syncStaticMirrorsFromScene(g, b);
    b.addBody(h('m'), { position: [0, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.4, 0.4, 0.4] }, mass: 1, friction: 0, restitution: 0, linearVelocity: [8, 0, 0], groups: CHUNK_GROUPS });
    for (let i = 0; i < 40; i++) b.step(i);
    const blocked = b.snapshot(h('m'))!.position[0];
    expect(blocked).toBeLessThan(2.4);
    // 删除墙节点 + 再次 sync 差分移除其镜像（本组合负责失效移除）
    g.removeNode('nd_wall');
    g.updateWorldTransforms();
    syncStaticMirrorsFromScene(g, b);
    expect(b.ledger.staticColliders).toBe(1);
    b.applyImpulse(h('m'), [8, 0, 0], null);
    for (let i = 0; i < 60; i++) b.step(i);
    expect(b.snapshot(h('m'))!.position[0]).toBeGreaterThan(blocked + 1.5);
    b.destroy();
  });

  it('嵌套 TRS：父级缩放折进镜像 box', async () => {
    const g = new SceneGraph();
    const parent = g.addNode({ id: 'nd_parent', name: 'parent' });
    g.setLocalTransform(parent, { scale: [2, 2, 2], position: [10, 0, 0] });
    g.addNode({ id: 'nd_child', name: 'child', parent, components: [
      { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [1, 1, 1] } } as never,
    ] });
    g.updateWorldTransforms();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.mirrored).toBe(1);
    // 世界位置 = parent(10,0,0) + child(0,0,0)*scale(2) = (10,0,0)；halfExtents 1*2=2
    // 用一块从上方落下的碎片验证镜像中心在 (10, 2, 0)（半高2 → 顶 y=2，碎片半高0.3 停 y≈2.3）
    b.addBody(h('d'), { position: [10, 6, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.3, 0.3, 0.3] }, mass: 1, friction: 0.5, restitution: 0, groups: CHUNK_GROUPS });
    for (let i = 0; i < 180; i++) b.step(i);
    const y = b.snapshot(h('d'))!.position[1];
    expect(y).toBeGreaterThan(2.0);
    expect(y).toBeLessThan(2.6);
    b.destroy();
  });

  it('坏变换产出 diagnostic（非均匀缩放 sphere 拒绝），不静默近似', async () => {
    const g = new SceneGraph();
    const parent = g.addNode({ id: 'nd_p', name: 'p' });
    g.setLocalTransform(parent, { scale: [2, 1, 1] });
    g.addNode({ id: 'nd_s', name: 's', parent, components: [
      { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'sphere', radius: 1 } } as never,
    ] });
    g.updateWorldTransforms();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.mirrored).toBe(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.diagnostic).toMatch(/非均匀/);
    expect(b.ledger.staticColliders).toBe(0);
    b.destroy();
  });
});

describe('R2：场景同步组合负责失效移除（差分）', () => {
  const wallScene = (): SceneGraph => {
    const g = new SceneGraph();
    const ground = g.addNode({ id: 'nd_ground', name: 'ground', components: [
      { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [30, 0.5, 30] } } as never,
    ] });
    g.setLocalTransform(ground, { position: [0, 0, 0] });
    const wall = g.addNode({ id: 'nd_wall', name: 'wall', components: [
      { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [0.25, 1.5, 3] } } as never,
    ] });
    g.setLocalTransform(wall, { position: [3, 1.5, 0] });
    g.updateWorldTransforms();
    return g;
  };
  const dropAndRun = (b: RapierFractureBackend, key: string): void => {
    b.addBody(h(key), { position: [0, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.4, 0.4, 0.4] }, mass: 1, friction: 0, restitution: 0, linearVelocity: [8, 0, 0], groups: CHUNK_GROUPS });
    for (let i = 0; i < 60; i++) b.step(i);
  };

  it('有效→禁用 collider 后再次 sync：旧镜像移除，通路打开', async () => {
    const g = wallScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    syncStaticMirrorsFromScene(g, b);
    expect(b.ledger.staticColliders).toBe(2);
    // 禁用墙 collider（真实编辑操作）
    const node = g.getNode('nd_wall')!;
    (node.components![0] as { enabled: boolean }).enabled = false;
    g.updateWorldTransforms();
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.mirrored).toBe(1); // 仅 ground
    expect(r.removed).toBe(1); // 墙镜像被差分移除
    expect(b.ledger.staticColliders).toBe(1);
    dropAndRun(b, 'm');
    expect(b.snapshot(h('m'))!.position[0]).toBeGreaterThan(3.0); // 不再被旧墙挡
    b.destroy();
  });

  it('有效→trigger 后再次 sync：旧镜像移除', async () => {
    const g = wallScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    syncStaticMirrorsFromScene(g, b);
    (g.getNode('nd_wall')!.components![0] as { isTrigger: boolean }).isTrigger = true;
    g.updateWorldTransforms();
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.removed).toBe(1);
    expect(b.ledger.staticColliders).toBe(1);
    dropAndRun(b, 'm');
    expect(b.snapshot(h('m'))!.position[0]).toBeGreaterThan(3.0);
    b.destroy();
  });

  it('有效→隐藏节点后再次 sync：旧镜像移除', async () => {
    const g = wallScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    syncStaticMirrorsFromScene(g, b);
    (g.getNode('nd_wall') as { visible: boolean }).visible = false;
    g.updateWorldTransforms();
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.removed).toBe(1);
    expect(b.ledger.staticColliders).toBe(1);
    dropAndRun(b, 'm');
    expect(b.snapshot(h('m'))!.position[0]).toBeGreaterThan(3.0);
    b.destroy();
  });

  it('删除 Collider 组件后再次 sync：旧镜像移除', async () => {
    const g = wallScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    syncStaticMirrorsFromScene(g, b);
    g.getNode('nd_wall')!.components = [];
    g.updateWorldTransforms();
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.removed).toBe(1);
    expect(b.ledger.staticColliders).toBe(1);
    dropAndRun(b, 'm');
    expect(b.snapshot(h('m'))!.position[0]).toBeGreaterThan(3.0);
    b.destroy();
  });

  it('删除节点后再次 sync：旧镜像移除（无需调用方手动 removeStatic）', async () => {
    const g = wallScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    syncStaticMirrorsFromScene(g, b);
    g.removeNode('nd_wall');
    g.updateWorldTransforms();
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.removed).toBe(1);
    expect(b.ledger.staticColliders).toBe(1);
    dropAndRun(b, 'm');
    expect(b.snapshot(h('m'))!.position[0]).toBeGreaterThan(3.0);
    b.destroy();
  });

  it('变换转为非法（非均匀 sphere）后再次 sync：diagnostic 保留且旧镜像移除，不挡路', async () => {
    const g = new SceneGraph();
    const parent = g.addNode({ id: 'nd_p', name: 'p' });
    g.setLocalTransform(parent, { scale: [1, 1, 1] });
    const s = g.addNode({ id: 'nd_s', name: 's', parent, components: [
      { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'sphere', radius: 1 } } as never,
    ] });
    g.setLocalTransform(s, { position: [3, 1.5, 0] });
    g.updateWorldTransforms();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    const r1 = syncStaticMirrorsFromScene(g, b);
    expect(r1.mirrored).toBe(1);
    // 变为非均匀缩放 → 变换拒绝
    g.setLocalTransform(parent, { scale: [2, 1, 1] });
    g.updateWorldTransforms();
    const r2 = syncStaticMirrorsFromScene(g, b);
    expect(r2.mirrored).toBe(0);
    expect(r2.rejected).toHaveLength(1);
    expect(r2.rejected[0]!.diagnostic).toMatch(/非均匀/);
    expect(r2.removed).toBe(1); // 旧镜像已移除
    expect(b.ledger.staticColliders).toBe(0);
    dropAndRun(b, 'm');
    expect(b.snapshot(h('m'))!.position[0]).toBeGreaterThan(3.0);
    b.destroy();
  });

  it('差分只移除本组合拥有的镜像，其他 owner 登记的静态项保留', async () => {
    const g = wallScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    // 其他 owner 登记的独立静态项（无前缀）
    b.upsertStatic('other-owner-floor', { position: [0, -2, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [5, 0.5, 5] } });
    syncStaticMirrorsFromScene(g, b);
    expect(b.ledger.staticColliders).toBe(3);
    g.removeNode('nd_wall');
    g.updateWorldTransforms();
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.removed).toBe(1);
    expect(b.ledger.staticColliders).toBe(2); // ground 镜像 + 其他 owner 的 floor 均保留
    expect(b.staticKeys()).toContain('other-owner-floor');
    b.destroy();
  });
});
