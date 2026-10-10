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
    expect(migrated.to).toBe(16); expect(migrated.applied).toEqual(['scene-audio-cue-mapping','integrated-weapons-audio-body-ik','optional-skeletal-pose-layers']); expect(migrated.doc.nodes).toEqual(before);
  });
});

describe('optional generic pose layer persistence', () => {
  const poseLayer={roots:['Spine'],exclude:['LeftHand'],weight:.6,transitionSec:.15};
  it('roundtrips through sidecar and v15 to v16 scene migration without inventing a configuration for old scenes',()=>{
    const meta=createDefaultAssetMeta('as_layer','gltf');meta.sharedMotion={...binding,poseLayer};
    const copy=JSON.parse(JSON.stringify(meta));expect(copy.sharedMotion.poseLayer).toEqual(poseLayer);
    expect(validateAssetMeta(copy).filter(d=>d.severity==='error')).toEqual([]);
    const doc=createEmptySceneDocument('layer');const mesh={kind:'MeshRenderer',sharedMotion:{...binding,poseLayer}};
    const serialized={...doc,schemaVersion:15,nodes:[{id:'node',components:[mesh]}]};expect(migrateToLatest(JSON.parse(JSON.stringify(serialized))).doc.nodes).toEqual(serialized.nodes);
    const legacy={...doc,schemaVersion:15};const migrated=migrateToLatest(legacy);expect(migrated.to).toBe(16);expect(migrated.applied).toEqual(['optional-skeletal-pose-layers']);expect(migrated.doc).toEqual({...legacy,schemaVersion:16});expect(validateSharedMotionBinding(binding)).toEqual([]);
  });
  it('rejects unsafe or incomplete masks, weights and durations',()=>{
    for(const invalid of [{...poseLayer,roots:[]},{...poseLayer,roots:['Spine','Spine']},{...poseLayer,exclude:null},{...poseLayer,weight:NaN},{...poseLayer,weight:1.1},{...poseLayer,transitionSec:-1}])
      expect(validateSharedMotionBinding({...binding,poseLayer:invalid}).length).toBeGreaterThan(0);
  });
});
