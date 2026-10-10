import { describe, it, expect } from 'vitest';
import { migrateToLatest, newBodyIkControl, validateSceneDocument, type SceneDocument, type RunRulesComponent } from '../src';
const scenes=import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json',{eager:true,import:'default'});

describe('integration of independently published v14 scene contracts',()=>{
  it('preserves weapon/audio v14 and IK/transition v14; upgrades missing legacy arsenal without altering the source',()=>{
    const doc=structuredClone(Object.values(scenes)[0] as SceneDocument);doc.schemaVersion=14;
    const authored=structuredClone(doc);
    expect(migrateToLatest(doc).doc.nodes).toEqual(authored.nodes);
    const rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules') as RunRulesComponent;
    delete (rules as unknown as Record<string,unknown>).arsenal;
    delete rules.audio;
    const mesh=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='MeshRenderer');
    if(mesh?.kind!=='MeshRenderer')throw new Error('Missing test actor');
    mesh.bodyIk={enabled:true,weight:.7,locomotionWhileAiming:true,controls:[newBodyIkControl('head')]};
    if(mesh.sharedMotion)mesh.sharedMotion.transitionSec=.6;
    const before=structuredClone(doc),result=migrateToLatest(doc);
    expect(result.applied).toEqual(['integrated-weapons-audio-body-ik','predictive-crowd-navigation','authored-3d-navigation-surfaces']);expect(result.to).toBe(17);
    expect(doc).toEqual(before);
    const migratedRules=result.doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules') as RunRulesComponent;
    expect(migratedRules.arsenal.definitions).toHaveLength(1);
    expect(migratedRules.arsenal.definitions[0]!.ammo.magazineSize).toBe(rules.weapon.magazineSize);
    expect(migratedRules.audio).toBeUndefined();
    expect(result.doc.nodes.flatMap(n=>n.components).find(c=>c===mesh)).toBeUndefined();
    const migratedMesh=result.doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='MeshRenderer');
    expect(migratedMesh).toEqual(mesh);
    expect(validateSceneDocument(result.doc).filter(d=>d.severity==='error')).toEqual([]);
  });
});
