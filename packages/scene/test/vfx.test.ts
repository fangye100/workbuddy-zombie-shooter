import { expect, it } from 'vitest';
import { validateVfxAsset,migrateVfxAsset,resolveVfxBindings,validVfxEmitter } from '../src/vfx';
const asset={version:1,id:'as_vfx',name:'测试',status:'accepted',effects:{flash:{kind:'muzzle',texture:{path:'assets/vfx/flash.svg',guid:'as_flash'},frames:3,duration:.1,size:[.3,.3],color:'#ffcc33',blend:'alpha'}}};
it('rejects future versions, missing identity, frame overflow and nonfinite parameters',()=>{
  expect(validateVfxAsset(asset)).toEqual([]);
  for(const mutate of [(a:any)=>a.version=4,(a:any)=>a.effects.flash.texture.guid='',(a:any)=>a.effects.flash.frames=17,(a:any)=>a.effects.flash.size[0]=NaN]){const a=structuredClone(asset);mutate(a);expect(validateVfxAsset(a).length).toBeGreaterThan(0);}
});

it('v1 migration retains legacy impact surface alignment without changing raw disk data',()=>{
 const raw=structuredClone(asset);raw.effects.flash.kind='impact';const next=migrateVfxAsset(raw);
 expect(raw.version).toBe(1);expect(next.version).toBe(3);expect(next.effects.flash!.orientation).toBe('surface');expect(next.effects.flash!.loop).toBe(false);
 raw.effects.flash.kind='muzzle';expect(migrateVfxAsset(raw).effects.flash!.orientation).toBe('camera');
});
it('scene-wide duplicate opaque tags are diagnostic and excluded independent of node order',()=>{
 const binding={resource:{path:'assets/vfx/test.vfx.json',guid:'as_test'},effectKey:'flash'};
 const nodes=['nd_a','nd_b'].map(id=>({id,components:[{kind:'VfxBindings',enabled:true,bindings:{'opaque.shared':binding}}]}));
 for(const list of [nodes,[...nodes].reverse()]){const resolved=resolveVfxBindings({nodes:list} as any);expect(resolved.bindings).toEqual({});expect(resolved.diagnostics[0]).toContain('opaque.shared');}
 nodes[1]!.components[0]!.enabled=false;expect(resolveVfxBindings({nodes} as any).bindings['opaque.shared']).toEqual(binding);
});

it('v3 curves/emission and scene emitter reject malformed ranges, duplicate curve times and missing references',()=>{
 const a=migrateVfxAsset(asset);a.effects.flash!.sizeCurve=[{t:0,value:.2},{t:1,value:2}];expect(validateVfxAsset(a)).toEqual([]);
 a.effects.flash!.sizeCurve=[{t:0,value:1},{t:0,value:2}];expect(validateVfxAsset(a).length).toBeGreaterThan(0);
 const c={kind:'VfxEmitter',enabled:true,playing:true,resource:{path:'assets/vfx/a.vfx.json',guid:'a'},effectKey:'flash',seed:7,direction:[0,1,0]};expect(validVfxEmitter(c)).toBe(true);expect(validVfxEmitter({...c,direction:[0,0,0]})).toBe(false);expect(validVfxEmitter({...c,seed:-1})).toBe(false);
});

it('emitter missing/null/non-string effect keys are scene data errors',()=>{
 const c={kind:'VfxEmitter',enabled:true,playing:true,resource:{path:'assets/vfx/a.vfx.json',guid:'a'},seed:7,direction:[0,1,0]};for(const effectKey of [undefined,null,7,{},''])expect(validVfxEmitter({...c,effectKey})).toBe(false);
});
