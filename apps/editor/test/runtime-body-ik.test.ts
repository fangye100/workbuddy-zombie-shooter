import { describe, expect, it, vi } from 'vitest';
import { createSkinState, evalJointMatrices } from '@aether/render';
import { createEmptySceneDocument, identityTransform, newBodyIkControl, type SceneNode, type AssetMeta } from '@aether/scene';
import { RuntimeBodyIk, worldToActor } from '../src/services/runtime-body-ik';
import { skeletonFromFitPositions } from '../src/services/binding/retarget-session';
import { tposeWorldPositions } from '../src/services/binding/humanik-template';
import type { RuntimeSession } from '@aether/runtime';

function fixture() {
  const sk = skeletonFromFitPositions(tposeWorldPositions()), original = createSkinState(sk, []);
  original.time = .4;
  const object = { pos: [5, 0, 3] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number], scale: 2, skeleton: sk, skinState: original, removed: false, loadedAssetPath: 'assets/rig.glb' };
  const control = newBodyIkControl('upperBody'), binding = { enabled: true, weight: .8, locomotionWhileAiming: true, controls: [control] };
  const doc = createEmptySceneDocument('ik'); doc.nodes.push({ id: 'actor', name: 'actor', visible: true, components: [{ kind: 'MeshRenderer', enabled: true, visible: true, source: { type: 'asset', ref: { path: object.loadedAssetPath } }, bodyIk: binding }] } as SceneNode);
  const read = vi.fn(async () => ({ bodyIk: binding }) as AssetMeta), mouse = vi.fn(() => [7, 2, 5] as [number, number, number]);
  const service = new RuntimeBodyIk(() => object, read, () => [9, 0, 7], mouse);
  return { sk, object, original, binding, doc, read, mouse, service };
}
describe('Play-owned body IK assembly', () => {
  it('resolves empty target nodes through their authored parent transform', () => {
    const f = fixture();
    for (const node of f.doc.nodes) { node.parent = null; node.transform = identityTransform(); }
    f.doc.nodes.push({ id: 'parent', name: 'parent', parent: null, visible: true, pickable: true, prefab: null, transform: { ...identityTransform(), position: [8, 0, 6] }, components: [] });
    f.doc.nodes.push({ id: 'target', name: 'target', parent: 'parent', visible: true, pickable: true, prefab: null, transform: { ...identityTransform(), position: [1, 2, 1] }, components: [] });
    f.binding.controls[0]!.target = { kind: 'node', nodeId: 'target', offset: [0, 0, 0] };
    const service = new RuntimeBodyIk(() => f.object, f.read, () => null, f.mouse);
    service.start(f.doc); service.sync(null);
    expect(f.object.skinState.bodyIk!.targets.upperBody).toEqual([2, 1, 2]);
    service.stop(); expect(f.object.skinState).toBe(f.original);
  });
  it('resolves mouse and node targets through actor transform, preserves authored settings and restores Stop', () => {
    const f = fixture(); f.service.start(f.doc); f.service.sync(null);
    expect(f.object.skinState.bodyIk!.targets.upperBody).toEqual([1, 1, 1]);
    expect(f.service.locomotion('actor')).toBe(true);
    f.mouse.mockReturnValue(null!); f.service.sync(null, true); expect(f.object.skinState.bodyIk!.targets.upperBody).toEqual([1, 1, 1]);
    f.service.setWeight('actor', 'upperBody', 0); expect(f.service.locomotion('actor')).toBe(false);
    expect(f.binding.controls[0]!.weight).toBe(1);
    f.object.skinState.bodyIk!.binding.controls[0]!.target = { kind: 'node', nodeId: 'enemy', offset: [1, 2, 1] };
    f.service.sync(null); expect(f.object.skinState.bodyIk!.targets.upperBody).toEqual([2.5, 1, 2.5]);
    f.service.stop(); expect(f.object.skinState).toBe(f.original); expect(f.original.time).toBe(.4); expect(f.original.bodyIk).toBeUndefined();
  });
  it('survives late shared-motion SkinState replacement and removes its transient layer on Stop', () => {
    const f = fixture(); f.service.start(f.doc);
    const replacement = createSkinState(f.sk, []); f.object.skinState = replacement; f.service.sync(null);
    expect(replacement.bodyIk).toBeDefined(); f.service.stop(); expect(replacement.bodyIk).toBeUndefined();
  });
  it('rejects late default loading after Stop, and supports null disable', async () => {
    const f = fixture(), mesh = f.doc.nodes.at(-1)!.components[0]!;
    if (mesh.kind !== 'MeshRenderer') throw new Error('fixture'); delete mesh.bodyIk;
    let complete!: (meta: AssetMeta) => void; f.read.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    f.service.start(f.doc); f.object.skinState.time = .9; f.service.stop(); complete({ bodyIk: f.binding } as AssetMeta); await Promise.resolve();
    expect(f.original.time).toBe(.4);
    expect(f.object.skinState).toBe(f.original); expect(f.service.summary().nodes).toEqual([]);
    mesh.bodyIk = null; f.read.mockClear(); f.service.start(f.doc); expect(f.read).not.toHaveBeenCalled();
  });
  it('inherits valid asset assembly and retains base animation when there are no living enemies', async () => {
    const f = fixture(), mesh = f.doc.nodes.at(-1)!.components[0]!;
    if (mesh.kind !== 'MeshRenderer') throw new Error('fixture'); delete mesh.bodyIk;
    f.binding.controls[0]!.target = { kind: 'enemy', height: 1.5 };
    f.service.start(f.doc); await vi.waitFor(() => expect(f.service.summary().pending).toBe(0));
    f.service.sync({ view: () => [] } as unknown as RuntimeSession);
    evalJointMatrices(f.object.skinState, new Float32Array((f.sk.joints.length + 1) * 16));
    expect(f.service.summary().nodes[0]!.diagnostics.some(d => d.code === 'IK_TARGET')).toBe(true);
    f.service.sync({ view: () => [{ kind: 'npc', alive: true, hp: 0, x: 5, z: 3 }, { kind: 'npc', alive: true, hp: 5, x: 7, z: 5 }] } as unknown as RuntimeSession);
    expect(f.object.skinState.bodyIk!.targets.upperBody).toEqual([1, .75, 1]);
  });
  it('rejects invalid weights and inverse transforms rotated actors', () => {
    const f = fixture(); f.service.start(f.doc); expect(f.service.setWeight('actor', null, NaN)).toBe(false); expect(f.service.setWeight('actor', null, 2)).toBe(false);
    f.object.quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    const p = worldToActor(f.object, [7, 0, 3]); expect(p[0]).toBeCloseTo(0); expect(p[2]).toBeCloseTo(1);
  });
});
