import { expect, it } from 'vitest';
import { validateVfxAsset } from '../src/vfx';
const asset={version:1,id:'as_vfx',name:'测试',status:'accepted',effects:{flash:{kind:'muzzle',texture:{path:'assets/vfx/flash.svg',guid:'as_flash'},frames:3,duration:.1,size:[.3,.3],color:'#ffcc33',blend:'alpha'}}};
it('rejects future versions, missing identity, frame overflow and nonfinite parameters',()=>{
  expect(validateVfxAsset(asset)).toEqual([]);
  for(const mutate of [(a:any)=>a.version=3,(a:any)=>a.effects.flash.texture.guid='',(a:any)=>a.effects.flash.frames=17,(a:any)=>a.effects.flash.size[0]=NaN]){const a=structuredClone(asset);mutate(a);expect(validateVfxAsset(a).length).toBeGreaterThan(0);}
});
