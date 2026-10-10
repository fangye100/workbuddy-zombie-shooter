import { describe, expect, it } from 'vitest';
import { createEmptySceneDocument, migrateToLatest, validateSharedMotionBinding, createDefaultAssetMeta, validateAssetMeta } from '@aether/scene';
const binding = { library: { path:'assets/motion.json',guid:'as_motion' },profile:'npc',defaultState:'idle',speed:1 };
describe('authored motion transition contract', () => {
  it('accepts defaults/zero duration and rejects invalid durations in bindings and asset metadata', () => {
    expect(validateSharedMotionBinding(binding)).toEqual([]);
    for (const transitionSec of [0,.2,5]) expect(validateSharedMotionBinding({...binding,transitionSec})).toEqual([]);
    for (const transitionSec of [-1,6,NaN,Infinity,'slow']) expect(validateSharedMotionBinding({...binding,transitionSec}).length).toBeGreaterThan(0);
    const meta=createDefaultAssetMeta('as_target','gltf'); meta.sharedMotion={...binding,transitionSec:.4};
    expect(validateAssetMeta(JSON.parse(JSON.stringify(meta))).filter(d=>d.severity==='error')).toEqual([]);
    meta.sharedMotion.transitionSec=-1; expect(validateAssetMeta(meta).some(d=>d.code==='E_META_SHARED_MOTION')).toBe(true);
  });
  it('migrates v13 without overwriting existing binding choices', () => {
    const doc=createEmptySceneDocument('transition'); doc.schemaVersion=13;
    const before=structuredClone(doc.nodes); const migrated=migrateToLatest(doc);
    expect(migrated.to).toBe(17); expect(migrated.applied).toEqual(['scene-audio-cue-mapping','integrated-weapons-audio-body-ik','predictive-crowd-navigation','authored-3d-navigation-surfaces']); expect(migrated.doc.nodes).toEqual(before);
  });
});
