/**
 * WU-03!�����Ј������� SceneGraph!ܟ� collider!ԟȒݙ��՝Ï��
 *"����Ќ�� collider ܟ���������ɇ��՜Ïǻڄί�ܟ��Ҟ��
 * �ϑ٨/�Ԩ/ڒ׏������Ƞ٦ʃ¹�٦՜ÏЎ����ɓ����ݏϘ͢ diagnostic��
 *!�مʢ�� Rapier WASM��
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
  //"�ϑ٫��˿ϖ̃۷������՝Ï
  g.addNode({ id: 'nd_pickup', name: 'pickup', components: [
    { kind: 'Collider', enabled: true, isTrigger: true, layer: 1, shape: { type: 'sphere', radius: 1 } } as never,
  ] });
  //!�Ԩ collides����՝Ï
  g.addNode({ id: 'nd_disabled', name: 'disabled', components: [
    { kind: 'Collider', enabled: false, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [1, 1, 1] } } as never,
  ] });
  // ڒ׏ʂ»����՝Ï
  g.addNode({ id: 'nd_hidden', name: 'hidden', visible: false, components: [
    { kind: 'Collider', enabled: true, isTrigger: false, layer: 1, shape: { type: 'box', halfExtents: [1, 1, 1] } } as never,
  ] });
  g.updateWorldTransforms();
  return g;
}

describe('�����Ћ��SceneGraph collider ƒ ݙ��՜Ï��Ќ��ܟ����', () => {
  it('՜Ïݞ�ϑ܉Ո collider���ϑ٨/�Ԩ/ڒ׏����', async () => {
    const g = makeScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    const r = syncStaticMirrorsFromScene(g, b);
    expect(r.mirrored).toBe(2); // ground + wall
    expect(r.rejected).toHaveLength(0);
    expect(b.ledger.staticColliders).toBe(2);
    b.destroy();
  });

  it('՜Ïǻڄ�ܟ�ػ̡�ɇ��ɩІ�ڄدܻٯ collider!ܟ����', async () => {
    const g = makeScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    syncStaticMirrorsFromScene(g, b);
    b.addBody(h('c'), { position: [0, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.4, 0.4, 0.4] }, mass: 1, friction: 0, restitution: 0, linearVelocity: [8, 0, 0], groups: CHUNK_GROUPS });
    for (let i = 0; i < 40; i++) b.step(i);
    //!�ܨ x=3!͋Κ 0.25 ƒ ��ݢ 2.75��ݗ͊� 0.4 ƒ!��ܨ x<2.4
    expect(b.snapshot(h('c'))!.position[0]).toBeLessThan(2.4);
    b.destroy();
  });

  it('Ȣ٦ʂ¹Џ�٦՝Ï������ɓ����ס���� collider��', async () => {
    const g = makeScene();
    const b = new RapierFractureBackend(rapier, { fixedStepSec: STEP });
    syncStaticMirrorsFromScene(g, b);
    b.addBody(h('m'), { position: [0, 1.5, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.4, 0.4, 0.4] }, mass: 1, friction: 0, restitution: 0, linearVelocity: [8, 0, 0], groups: CHUNK_GROUPS });
    for (let i = 0; i < 40; i++) b.step(i);
    const blocked = b.snapshot(h('m'))!.position[0];
    expect(blocked).toBeLessThan(2.4);
    //!Ȣ٤�ʃ¹ + �٥Ŷ՝Ï
    g.removeNode('nd_wall');
    b.removeStatic('nd_wall');
    expect(b.ledger.staticColliders).toBe(1);
    b.applyImpulse(h('m'), [8, 0, 0], null);
    for (let i = 0; i < 60; i++) b.step(i);
    expect(b.snapshot(h('m'))!.position[0]).toBeGreaterThan(blocked + 1.5);
    b.destroy();
  });

  it('��� TRS��ȶ����Ծʚ��՜Ï box', async () => {
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
    //!��Ռ���� = parent(10,0,0) + child(0,0,0)*scale(2) = (10,0,0+��halfExtents 1*2=2
    //!ԩ��ݗ����ֻн��څ�ɇ��՜Ï����ܨ (10, 2, 0+��͊�2 ƒ � y=2���ɇ͊�0.3!�� yɈ2.3��
    b.addBody(h('d'), { position: [10, 6, 0], rotation: [0, 0, 0, 1], shape: { type: 'box', halfExtents: [0.3, 0.3, 0.3] }, mass: 1, friction: 0.5, restitution: 0, groups: CHUNK_GROUPS });
    for (let i = 0; i < 180; i++) b.step(i);
    const y = b.snapshot(h('d'))!.position[1];
    expect(y).toBeGreaterThan(2.0);
    expect(y).toBeLessThan(2.6);
    b.destroy();
  });

  it('ݏϙͣ��Ǻ diagnostic��ݟ݇̀��Ծ sphere ˓��������ݙ������', async () => {
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
