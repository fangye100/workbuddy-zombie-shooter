import { describe, it, expect } from 'vitest';
import { SpawnEditStore, cloneDocument, loadLevelRuntime, newAuthorNode, newRunRules, removeNodeTree,RuntimeSession } from '@aether/runtime';
import type { SceneDocument } from '@aether/scene';
import { AuthorSceneSaver } from '../src/services/author-scene-save';
const modules = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });
function fixture(): SceneDocument {
  const doc = cloneDocument((Object.values(modules)[0] as { default: SceneDocument }).default);
  // Scene composition can fill all 64 slots; authoring tests need explicit headroom.
  for (const node of doc.nodes) node.components = node.components.filter(c => c.kind !== 'MeshRenderer');
  return doc;
}
function setup() {
  const store = new SpawnEditStore(fixture()); let disk = cloneDocument(store.document);
  const saver = new AuthorSceneSaver({ read: async () => ({ ok: true, status: 200, json: disk, error: null }),
    write: async (_p, body) => { disk = JSON.parse(body.content); return { ok: true, status: 200, error: null }; } });
  return { store, saver, disk: () => disk };
}
describe('scene authoring loop', () => {
  it('saves and reopens authored audio gain and stable resource identities', async () => {
    const s=setup();
    expect(s.store.editNodes('audio', nodes=>{const r=nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules')!;if(r.kind==='RunRules')r.audio!.masterGain=.4;}).ok).toBe(true);
    expect((await s.saver.save(s.store,'qa.scene.json')).status).toBe('saved');
    const runtime=loadLevelRuntime(new SpawnEditStore(s.disk()).document);
    expect(runtime.desc!.runRules!.audio!.masterGain).toBe(.4);
    expect(runtime.desc!.runRules!.audio!.cues[0]!.variants[0]!.guid).toBeTruthy();
  });
  it('mixes rules, structure, materials and transforms, saves/reopens and runs the authored rules', async () => {
    const s = setup();
    expect(s.store.editNodes('rules', nodes => {
      const r = nodes.flatMap(n => n.components).find(c => c.kind === 'RunRules')!;
      if (r.kind === 'RunRules') { r.arsenal.definitions[0]!.ammo.magazineSize = 17; r.arsenal.definitions[0]!.presentation.markers.supportGrip.position=[.15,0,0]; r.healCost = 27; }
      const node = newAuthorNode('qa', 'QA', true); nodes.push(node);
      const mesh = node.components[0]!;
      if (mesh.kind === 'MeshRenderer') mesh.materials = [{ match: { by: 'index', value: 0 }, material: { type: 'override', base: { type: 'shared', id: 's0' }, patch: { albedo: '#ffaa00', roughness: 0.8 } } }];
    }).ok).toBe(true);
    s.store.setTransform('qa', { posX: 3 });
    const wanted = cloneDocument(s.store.document);
    s.store.undo(); s.store.undo(); expect(s.store.document).toEqual(fixture());
    s.store.redo(); s.store.redo(); expect(s.store.document).toEqual(wanted);
    expect((await s.saver.save(s.store, 'qa.scene.json')).status).toBe('saved');
    const reopened = new SpawnEditStore(s.disk()); expect(reopened.document).toEqual(wanted);
    const runtime = loadLevelRuntime(reopened.document); expect(runtime.desc?.runRules?.arsenal.definitions[0]!.ammo.magazineSize).toBe(17);
    expect(runtime.desc?.runRules?.healCost).toBe(27);
    const session=new RuntimeSession({desc:runtime.desc!});expect(session.weapons.state.magazine).toBe(17);
    expect(session.weapons.poseIntent.markers.supportGrip.position).toEqual([.15,0,0]);
  });
  it('rejects invalid rules, cyclic parenting and dangling references atomically', () => {
    const s = setup(), before = cloneDocument(s.store.document);
    expect(s.store.editNodes('invalid', nodes => { const r = nodes.flatMap(n => n.components).find(c => c.kind === 'RunRules')!; if (r.kind === 'RunRules') r.arsenal.definitions[0]!.ammo.magazineSize = 0; }).ok).toBe(false);
    expect(s.store.editNodes('cycle', nodes => { nodes[0]!.parent = nodes[0]!.id; }).ok).toBe(false);
    expect(s.store.editNodes('reference', nodes => { const r = nodes.flatMap(n => n.components).find(c => c.kind === 'RunRules')!; if (r.kind === 'RunRules') r.bossAttack = { source: 'missing', radius: 1, damage: 1, cooldownSec: 1, windupSec: 1 }; }).ok).toBe(false);
    expect(s.store.document).toEqual(before); expect(s.store.undoDepth).toBe(0);
  });
  it('deletes a subtree and restores stable identities with one undo; rejects capacity overflow', () => {
    const s = setup();
    expect(s.store.editNodes('add', nodes => { const a = newAuthorNode('qa-a', 'A'); const b = newAuthorNode('qa-b', 'B'); b.parent = a.id; nodes.push(a, b); }).ok).toBe(true);
    expect(s.store.editNodes('remove', nodes => removeNodeTree(nodes, 'qa-a')).ok).toBe(true);
    expect(s.store.document.nodes.some(n => n.id === 'qa-b')).toBe(false); s.store.undo();
    expect(s.store.document.nodes.find(n => n.id === 'qa-b')?.parent).toBe('qa-a');
    expect(s.store.editNodes('overflow', nodes => { for (let i = 0; i < 65; i++) nodes.push(newAuthorNode(`overflow-${i}`, 'box', true)); }).ok).toBe(false);
  });
  it('does not authorize mutations through the public document reference', async () => {
    const s = setup(); s.store.document.nodes[0]!.name = 'bypass';
    expect((await s.saver.save(s.store, 'qa.scene.json')).status).toBe('rejected');
    expect(s.store.editNodes('launder', nodes => nodes.push(newAuthorNode('q', 'q'))).ok).toBe(false);
  });
  it('keeps edits made during a save dirty and undoable', async () => {
    const s = setup(); s.store.editNodes('first', nodes => nodes.push(newAuthorNode('first', 'first')));
    const save = s.saver.save(s.store, 'qa.scene.json');
    s.store.editNodes('second', nodes => nodes.push(newAuthorNode('second', 'second')));
    expect((await save).status).toBe('saved'); expect(s.store.dirty).toBe(true);
    expect(s.disk().nodes.some(n => n.id === 'second')).toBe(false);
    s.store.undo(); expect(s.store.document).toEqual(s.disk());
  });
  it('provides valid opt-in RunRules without changing legacy scenes', () => {
    const s = setup(); expect(s.store.editNodes('replace', nodes => { for (const n of nodes) n.components = n.components.filter(c => c.kind !== 'RunRules'); nodes[0]!.components.push(newRunRules()); }).ok).toBe(true);
  });
});
