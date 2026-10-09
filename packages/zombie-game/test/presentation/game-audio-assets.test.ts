import {expect, it} from 'vitest';
import type {SceneDocument} from '@aether/scene';
import {audioResource} from '../../src/presentation/game-audio-assets';
const scenes=import.meta.glob('../../../../assets/scenes/act1/floor-1.scene.json',{eager:true,import:'default'});
const doc=Object.values(scenes)[0] as SceneDocument;
const rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules');
if(rules?.kind!=='RunRules' || !rules.audio)throw new Error('Calibration audio scene missing');
const refs=rules.audio.cues.flatMap(c=>c.variants);
it('resolves every authored calibration take through actual Vite globs and GUID metadata',()=>{
  expect(refs).toHaveLength(22);
  for(const ref of refs){const resource=audioResource(ref);expect(resource.url).toContain('.wav');expect(resource.info.sampleRate).toBe(48000);expect(resource.info.frames).toBeGreaterThan(0);}
});
it('rejects unavailable paths and mismatched GUIDs instead of falling back silently',()=>{
  expect(()=>audioResource({...refs[0]!,guid:'wrong-guid'})).toThrow(/mismatched/);
  expect(()=>audioResource({...refs[0]!,path:'assets/audio/missing.wav'})).toThrow(/unavailable/);
});
