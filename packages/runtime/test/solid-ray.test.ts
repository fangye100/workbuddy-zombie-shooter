import { describe, expect, it } from 'vitest';
import { SceneGraph, createEmptySceneDocument, identityTransform } from '@aether/scene';
import type { ColliderComponent, SceneDocument, SceneNode } from '@aether/scene';
import { PLAYER_STATS } from '@aether/content';
import { solidCollider, raySolid } from '../src/solid-ray';
import { loadLevelRuntime } from '../src/loader';
import { RuntimeSession } from '../src/session';
const modules = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });
const fixture = () => JSON.parse(JSON.stringify((Object.values(modules)[0] as { default: SceneDocument }).default)) as SceneDocument;
const node = (id: string): SceneNode => ({ id, name: id, parent: null, transform: identityTransform(), visible: true, pickable: true, components: [], prefab: null, userData: {} });
const box: ColliderComponent['shape'] = { type: 'box', halfExtents: [0.2, 1, 1] };
function geometry(shape: ColliderComponent['shape'], position: [number, number, number], scale: [number, number, number] = [1, 1, 1]) {
  const doc = createEmptySceneDocument('ray'); const n = node('nd_solid'); n.transform.position = position; n.transform.scale = scale; doc.nodes.push(n);
  return solidCollider(n.id, shape, SceneGraph.fromDocument(doc).worldMatrix(n.id));
}
describe('finite solid ray geometry in world distance', () => {
  it('swept projectile radius hits a grazing box while an ordinary bullet ray remains unobstructed',()=>{
    const s=geometry(box,[3,0,0]);
    expect(raySolid([0,.8,1.1],[1,0,0],s)).toBeNull();
    expect(raySolid([0,.8,1.1],[1,0,0],s,.15)).toBeCloseTo(2.65,5);
  });
  it('box has finite height and returns zero if the muzzle starts inside the solid', () => {
    const s = geometry(box, [3, 0, 0]);
    expect(raySolid([0, 0.8, 0], [1, 0, 0], s)).toBeCloseTo(2.8, 5);
    expect(raySolid([0, 2, 0], [1, 0, 0], s)).toBeNull();
    expect(raySolid([3, 0, 0], [1, 0, 0], s)).toBe(0);
  });
  it('nonuniform sphere is an ellipsoid, not its conservative navigation AABB', () => {
    const s = geometry({ type: 'sphere', radius: 1 }, [5, 0, 0], [2, 1, 1]);
    expect(raySolid([0, 0, 0], [1, 0, 0], s)).toBeCloseTo(3, 5);
    expect(raySolid([0, 0.8, 0.8], [1, 0, 0], s)).toBeNull();
  });
  it('centered capsule total height and end caps remain finite under rotation/parent nonuniform transform', () => {
    const doc = createEmptySceneDocument('parent'); const parent = node('nd_parent'); parent.transform.position = [5, 0, 0]; parent.transform.scale = [2, 1, 3];
    const child = node('nd_child'); child.parent = parent.id; child.transform.rotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    doc.nodes.push(parent, child); const graph = SceneGraph.fromDocument(doc);
    const s = solidCollider(child.id, { type: 'capsule', radius: 0.5, height: 4 }, graph.worldMatrix(child.id));
    // SceneGraph's established TRS composition keeps the child's Y scale=1:
    // after its Z rotation the centered capsule spans world x=3..7, y=-1..1.
    expect(raySolid([0, 0, 0], [1, 0, 0], s)).toBeCloseTo(3, 4);
    expect(raySolid([0, 1.2, 0], [1, 0, 0], s)).toBeNull();
    expect(raySolid([5, 0, 0], [1, 0, 0], s)).toBe(0);
  });
  it('rejects singular transforms and invalid sizes instead of pretending there is no wall', () => {
    expect(() => geometry(box, [0, 0, 0], [0, 1, 1])).toThrow('不可逆');
    expect(() => geometry(box, [0, 0, 0], [0.00001, 0.00001, 0.00001])).toThrow('不可逆');
    expect(() => geometry({ type: 'sphere', radius: -1 }, [0, 0, 0])).toThrow('正数');
  });
});

function scenario(offset: number | null, options: { low?: boolean; trigger?: boolean; disabled?: boolean; parent?: boolean } = {}) {
  const doc = fixture();
  for (const n of doc.nodes) {
    n.components = n.components.filter((c) => c.kind !== 'Collider' && c.kind !== 'Script');
    for (const c of n.components) if (c.kind === 'SpawnPoint') c.count = 0;
  }
  const first = doc.nodes.flatMap((n) => n.components).find((c) => c.kind === 'SpawnPoint'); if (!first || first.kind !== 'SpawnPoint') throw new Error('fixture spawn missing'); first.count = 2;
  const base = loadLevelRuntime(doc).desc!;
  if (offset !== null) {
    const wall = node('nd_shot_wall'); wall.transform.position = [base.playerStart.x + offset, options.low ? 0 : PLAYER_STATS.capsuleHeight / 2, base.playerStart.z];
    wall.components.push({ kind: 'Collider', enabled: !options.disabled, isTrigger: !!options.trigger, layer: 0,
      shape: options.low ? { type: 'box', halfExtents: [0.2, 0.1, 1] } : box });
    if (options.parent) {
      const parent = node('nd_shot_parent'); parent.transform.position = [...wall.transform.position]; parent.transform.scale = [2, 1, 2]; parent.transform.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
      wall.parent = parent.id; wall.transform.position = [0, 0, 0]; doc.nodes.push(parent);
    }
    doc.nodes.push(wall);
  }
  const loaded = loadLevelRuntime(doc); expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const session = new RuntimeSession({ desc: loaded.desc!, seed: 7 });
  const targets = session.view().filter((e) => e.kind === 'npc'); expect(targets).toHaveLength(2);
  const ids = targets.map((e) => e.id);
  ids.forEach((id, i) => { session.table.posX[id] = base.playerStart.x + 3 + i * 3; session.table.posZ[id] = base.playerStart.z; });
  return { doc, session, ids };
}
describe('ordinary bullets compare actual NPC and solid distance', () => {
  it.each([
    ['no wall', null, {}, true], ['front wall', 1.5, {}, false], ['wall behind targets', 9, {}, true],
    ['wall between targets', 4.5, {}, true], ['low obstacle', 1.5, { low: true }, true],
    ['trigger', 1.5, { trigger: true }, true], ['disabled', 1.5, { disabled: true }, true],
    ['transformed parent wall', 1.5, { parent: true }, false],
  ] as const)('%s', (_name, offset, options, hits) => {
    const { session: s, ids } = scenario(offset, options); const near = ids[0]!; const far = ids[1]!;
    const hp = s.table.health[near]!; const farHp = s.table.health[far]!;
    s.setInput(0, 0); s.setFire(true); s.step();
    expect(s.table.health[near]).toBe(hits ? hp - 12 : hp); expect(s.table.health[far]).toBe(farHp);
    expect(s.combatEvents.filter((e) => e.type === 'damage')).toHaveLength(hits ? 1 : 0);
  });
  it('loader excludes hidden ancestry and rejects noninvertible enabled solids', () => {
    const { doc } = scenario(1.5, { parent: true }); const parent = doc.nodes.find((n) => n.id === 'nd_shot_parent')!;
    parent.visible = false; expect(loadLevelRuntime(doc).desc!.shotColliders).toHaveLength(0);
    parent.visible = true; parent.transform.scale = [0, 1, 1]; const bad = loadLevelRuntime(doc);
    expect(bad.desc).toBeNull(); expect(bad.diagnostics.some((d) => d.code === 'E_SHOT_COLLIDER')).toBe(true);
  });
  it('fixed seed/input/step replay has identical HP and damage events with an actual wall', () => {
    const a = scenario(4.5); const b = scenario(4.5); a.session.setFire(true); b.session.setFire(true);
    for (let tick = 0; tick < 50; tick++) {
      a.session.step(); b.session.step();
      expect(a.session.view().map(({ runId: _run, ...entity }) => entity)).toEqual(b.session.view().map(({ runId: _run, ...entity }) => entity));
      expect(a.session.combatEvents.map(({ runId: _run, ...event }) => event)).toEqual(b.session.combatEvents.map(({ runId: _run, ...event }) => event));
    }
    expect(a.session.combatEvents.some((e) => e.type === 'damage')).toBe(true);
  });
});
