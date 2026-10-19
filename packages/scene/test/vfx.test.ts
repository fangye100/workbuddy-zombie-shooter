import { expect, it } from 'vitest';
import { VFX_VERSION,validateVfxAsset,migrateVfxAsset,resolveVfxBindings,validVfxEmitter,validVfxMotion,gpuVfxReason,cpuVfxCompatibility } from '../src/vfx';
const asset={version:1,id:'as_vfx',name:'测试',status:'accepted',effects:{flash:{kind:'muzzle',texture:{path:'assets/vfx/flash.svg',guid:'as_flash'},frames:3,duration:.1,size:[.3,.3],color:'#ffcc33',blend:'alpha'}}};
it('v9 flow is optional on v8 migration, sprite-only, bounded and explicitly CPU-compatible',()=>{
 const old={...structuredClone(asset),version:8};expect(migrateVfxAsset(old).effects.flash!.flow).toBeUndefined();expect(old.version).toBe(8);
 const a=migrateVfxAsset(old),e=a.effects.flash!;e.kind='sprite';e.flow={strength:.35,speed:2};expect(validateVfxAsset(a)).toEqual([]);expect(migrateVfxAsset(a).effects.flash!.flow).toEqual(e.flow);
 expect(validateVfxAsset({...a,version:8}).length).toBeGreaterThan(0);expect(gpuVfxReason(e)).toContain('flow');expect(cpuVfxCompatibility(e).flow).toEqual(e.flow);
 for(const flow of [null,{}, {strength:.7,speed:1},{strength:.3,speed:0},{strength:NaN,speed:1}])expect(validateVfxAsset({...a,effects:{flash:{...e,flow}}}).length).toBeGreaterThan(0);
 expect(validateVfxAsset({...a,effects:{flash:{...e,kind:'impact'}}}).length).toBeGreaterThan(0);
});
it('rejects future versions, missing identity, frame overflow and nonfinite parameters',()=>{
  expect(validateVfxAsset(asset)).toEqual([]);
  for(const mutate of [(a:any)=>a.version=99,(a:any)=>a.effects.flash.texture.guid='',(a:any)=>a.effects.flash.frames=17,(a:any)=>a.effects.flash.size[0]=NaN]){const a=structuredClone(asset);mutate(a);expect(validateVfxAsset(a).length).toBeGreaterThan(0);}
});

it('v5 ribbon and authored scene motion reject unsupported backend, budgets and malformed paths',()=>{const a=migrateVfxAsset(asset),e=a.effects.flash!;Object.assign(e,{kind:'ribbon',frames:1,size:[.3,1],backend:'cpu',orientation:'camera',ribbon:{maxPoints:64,minDistance:.02,breakDistance:2,uvMetersPerTile:1}});expect(validateVfxAsset(a)).toEqual([]);for(const change of [(e:any)=>e.backend='gpu',(e:any)=>e.ribbon.maxPoints=129,(e:any)=>e.ribbon.breakDistance=.001,(e:any)=>e.frames=2]){const b=structuredClone(a);change(b.effects.flash);expect(validateVfxAsset(b).length).toBeGreaterThan(0);}const motion={points:[[0,0,0],[1,0,0]],seconds:2,loop:true};expect(validVfxMotion(motion)).toBe(true);for(const value of [{...motion,seconds:0},{...motion,points:[[0,0,0]]},{...motion,points:[[0,0,0],[null,0,0]]}])expect(validVfxMotion(value)).toBe(false);});

it('v1 migration retains legacy impact surface alignment without changing raw disk data',()=>{
 const raw=structuredClone(asset);raw.effects.flash.kind='impact';const next=migrateVfxAsset(raw);
 expect(raw.version).toBe(1);expect(next.version).toBe(VFX_VERSION);expect(next.effects.flash!.orientation).toBe('surface');expect(next.effects.flash!.loop).toBe(false);
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

it('v4 backend budgets, legacy migration and unsupported GPU alpha are explicit',()=>{
 const a=migrateVfxAsset(asset);expect(a.effects.flash!.backend).toBe('cpu');
 Object.assign(a.effects.flash!,{backend:'gpu',kind:'sprite',emission:{rate:600,maxParticles:1024,speed:2,spreadDeg:45,acceleration:[0,-3,0]}});expect(validateVfxAsset(a)).toEqual([]);
 for(const mutate of [(e:any)=>e.backend='compute',(e:any)=>e.emission.maxParticles=1025,(e:any)=>e.emission.acceleration=[0,Infinity,0],(e:any)=>e.backend='cpu']){const b=structuredClone(a);mutate(b.effects.flash);expect(validateVfxAsset(b).length).toBeGreaterThan(0);}
 for(const version of [1,2,3]){const raw=structuredClone(asset);raw.version=version;expect(migrateVfxAsset(raw).version).toBe(VFX_VERSION);expect(raw.version).toBe(version);}
});

it('v6 soft-particle data is explicit, bounded, versioned and retained by CPU compatibility',()=>{
 const a=migrateVfxAsset(asset),e=a.effects.flash!;e.softParticle={fadeDistance:.5,bias:.01};expect(validateVfxAsset(a)).toEqual([]);
 for(const softParticle of [null,{}, {fadeDistance:0,bias:0},{fadeDistance:6,bias:0},{fadeDistance:.5,bias:NaN},{fadeDistance:.5,bias:-1}]){const b=structuredClone(a);b.effects.flash!.softParticle=softParticle as any;expect(validateVfxAsset(b).length).toBeGreaterThan(0);}
 expect(validateVfxAsset({...a,version:5}).length).toBeGreaterThan(0);e.backend='gpu';expect(gpuVfxReason(e)).toContain('softParticle');expect(cpuVfxCompatibility(e).softParticle).toEqual(e.softParticle);
 Object.assign(e,{kind:'ribbon',frames:1,size:[.3,1],backend:'cpu',ribbon:{maxPoints:64,minDistance:.02,breakDistance:2,uvMetersPerTile:1}});expect(validateVfxAsset(a).some(s=>s.includes('Ribbon 暂不支持'))).toBe(true);
 for(const version of [1,2,3,4,5]){const raw=structuredClone(asset);raw.version=version;const next=migrateVfxAsset(raw);expect(next.version).toBe(VFX_VERSION);expect(next.effects.flash!.softParticle).toBeUndefined();expect(raw.version).toBe(version);}
});
