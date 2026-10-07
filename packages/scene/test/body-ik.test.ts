import { describe, expect, it } from 'vitest';
import { newBodyIkControl, validateBodyIkBinding, createEmptySceneDocument, createDefaultAssetMeta, validateAssetMeta, migrateToLatest, validateSceneDocument, type SceneNode } from '@aether/scene';
describe('persistent body IK contract', () => {
  it('round-trips reusable asset assembly and rejects scene node targets in sidecars', () => {
    const meta = createDefaultAssetMeta('as_ik', 'gltf');
    meta.bodyIk = { enabled: true, weight: .7, locomotionWhileAiming: true, controls: [newBodyIkControl('leftHand')] };
    const loaded = JSON.parse(JSON.stringify(meta)); expect(loaded.bodyIk).toEqual(meta.bodyIk);
    expect(validateAssetMeta(loaded).filter(d => d.severity === 'error')).toEqual([]);
    meta.bodyIk.controls[0]!.target = { kind: 'node', nodeId: 'scene-target', offset: [0,0,0] };
    expect(validateAssetMeta(meta).some(d => d.code === 'E_META_BODY_IK')).toBe(true);
  });
  it('rejects malformed weights, duplicate parts, nonfinite vectors, and scene references in asset defaults', () => {
    const control = newBodyIkControl('head'), binding = { enabled: true, weight: 1, locomotionWhileAiming: true, controls: [control] };
    expect(validateBodyIkBinding(binding)).toEqual([]);
    expect(validateBodyIkBinding({ ...binding, weight: 2 }).length).toBeGreaterThan(0);
    expect(validateBodyIkBinding({ ...binding, controls: [control, control] }).length).toBeGreaterThan(0);
    control.forward = [0, 0, NaN]; expect(validateBodyIkBinding(binding).length).toBeGreaterThan(0);
    control.forward = [0, 0, 1]; control.target = { kind: 'node', nodeId: 'target', offset: [0, 0, 0] };
    expect(validateBodyIkBinding(binding, false).length).toBeGreaterThan(0);
    expect(validateBodyIkBinding(binding)).toEqual([]);
  });
  it('migrates v12 without adding controls and detects broken stable NodeId references', () => {
    const doc = createEmptySceneDocument('ik'); doc.schemaVersion = 12;
    const migrated = migrateToLatest(doc); expect(migrated.to).toBe(14); expect(migrated.applied).toContain('humanik-procedural-body-controls');
    expect(migrated.doc.nodes).toEqual(doc.nodes);
    const c = newBodyIkControl('head'); c.target = { kind: 'node', nodeId: 'missing', offset: [0, 0, 0] };
    migrated.doc.nodes.push({ id: 'actor', name: 'actor', visible: true, components: [{ kind: 'MeshRenderer', enabled: true, visible: true, source: { type: 'asset', ref: { path: 'assets/rig.glb', guid: 'as_rig' } }, bodyIk: { enabled: true, weight: 1, locomotionWhileAiming: false, controls: [c] } }] } as SceneNode);
    expect(validateSceneDocument(migrated.doc).some(d => d.code === 'E_BODY_IK_TARGET')).toBe(true);
  });
});
