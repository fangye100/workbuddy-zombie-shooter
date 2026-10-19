import {expect,it} from 'vitest';
import {VfxDocument} from '../src/services/vfx-document';
import {sceneFingerprint} from '@aether/runtime';
import {VFX_VERSION,type VfxAsset} from '@aether/scene';
const assets=import.meta.glob('../../../assets/vfx/comic-pistol.vfx.json',{eager:true,import:'default'});
it('flow author edits survive undo/redo and persisted CAS bytes',async()=>{
 const a=structuredClone(Object.values(assets)[0]) as VfxAsset;a.effects.test={...a.effects['comic-muzzle']!,kind:'sprite'};const d=new VfxDocument('assets/vfx/a.vfx.json',a),next=structuredClone(d.value);next.effects.test!.flow={strength:.35,speed:2.3};d.apply(next);d.undo();expect(d.value.effects.test!.flow).toBeUndefined();d.redo();
 await d.save({write:async(_p,b)=>{expect(JSON.parse(b.content!).effects.test.flow).toEqual({strength:.35,speed:2.3});expect(b.baseHash).toBe(sceneFingerprint(a));return {ok:true,status:200,error:null};}});expect(d.dirty).toBe(false);
});
it('asset undo/redo and CAS preserve independent dirty state and the original baseline on conflict',async()=>{
  const a=Object.values(assets)[0] as VfxAsset,d=new VfxDocument('assets/vfx/a.vfx.json',a),next=structuredClone(a);next.effects['comic-muzzle']!.size=[1,1];d.apply(next);
  expect(d.dirty).toBe(true);d.undo();expect(d.dirty).toBe(false);d.redo();expect(d.dirty).toBe(true);
  let baseline='';await expect(d.save({write:async(_p,b)=>{baseline=b.baseHash!;return {ok:false,status:409,conflict:true,error:'conflict'};}})).rejects.toThrow('外部修改');expect(d.dirty).toBe(true);expect(baseline).toBe(sceneFingerprint(a));
  let savedVersion=0;await d.save({write:async(_p,b)=>{savedVersion=JSON.parse(b.content!).version;expect(b.baseHash).toBe(sceneFingerprint(a));return {ok:true,status:200,error:null};}});expect(d.dirty).toBe(false);expect(savedVersion).toBe(VFX_VERSION);
});
