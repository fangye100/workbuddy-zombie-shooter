import { describe, it, expect } from 'vitest';
import { validGameplayAudio, validAudioAssetInfo, migrateToLatest, validateSceneDocument, type GameplayAudioConfig, type SceneDocument, type RunRulesComponent } from '../src';
const files=import.meta.glob('../../../assets/audio/calibration/gameplay-audio.json',{eager:true,import:'default'});
const scenes=import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json',{eager:true,import:'default'});
const audio=()=>structuredClone(Object.values(files)[0] as GameplayAudioConfig);
describe('scene audio contract',()=>{
  it('rejects unresolved, unsafe, mismatched loop bindings and excess voice counts',()=>{
    expect(validGameplayAudio(audio())).toBe(true);
    const missing=audio();missing.ambience!.cue='SFX-ABSENT';expect(validGameplayAudio(missing)).toBe(false);
    const loop=audio();loop.weapons.pistol!.fire=loop.ambience;expect(validGameplayAudio(loop)).toBe(false);
    const unsafe=audio();unsafe.cues[0]!.variants[0]!.path='assets/audio/../secret.wav';expect(validGameplayAudio(unsafe)).toBe(false);
    const bounded=audio();bounded.maxVoices=65;expect(validGameplayAudio(bounded)).toBe(false);
  });
  it('rejects invalid asset measurement and incomplete loop sample ranges',()=>{
    const a={sampleRate:48000,frames:96000,channels:2,bitDepth:24,loopStartSample:0,loopEndSample:96000};
    expect(validAudioAssetInfo(a)).toBe(true);
    expect(validAudioAssetInfo({...a,loopEndSample:96001})).toBe(false);
    expect(validAudioAssetInfo({...a,loopStartSample:null})).toBe(false);
    expect(validAudioAssetInfo({...a,channels:3})).toBe(false);
  });
  it('migrates v13 explicitly, preserves authored audio, and leaves old silent scenes silent',()=>{
    const doc=structuredClone(Object.values(scenes)[0] as SceneDocument);doc.schemaVersion=13;
    const rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules') as RunRulesComponent;
    const original=structuredClone(rules.audio);
    const result=migrateToLatest(doc);expect(result.applied).toEqual(['scene-audio-cue-mapping','integrated-weapons-audio-body-ik','predictive-crowd-navigation']);
    expect((result.doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules') as RunRulesComponent).audio).toEqual(original);
    delete rules.audio;const silent=migrateToLatest(doc);expect((silent.doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules') as RunRulesComponent).audio).toBeUndefined();
    expect(validateSceneDocument(silent.doc).filter(d=>d.severity==='error')).toEqual([]);
    rules.audio=audio();rules.audio.masterGain=9;expect(migrateToLatest(doc).diagnostics.some(d=>d.severity==='error')).toBe(true);
  });
});
