import {describe,it,expect} from 'vitest';
import {identitySocket,resolveSocketDefaults,validModelSockets,validBoneSockets,validateModelAssetIdentity,
  createDefaultAssetMeta,validateAssetMeta} from '@aether/scene';
describe('正式模型与骨 socket 持久化',()=>{
 it('正式引用拒绝缺资产/缺sidecar/错误GUID及错误kind',()=>{
  const ref={path:'assets/weapon.glb',guid:'as_real'},meta={guid:'as_real',kind:'gltf'};
  expect(validateModelAssetIdentity(ref,meta)).toEqual([]);
  expect(validateModelAssetIdentity(ref,meta,false)[0]).toContain('E_MODEL_ASSET_MISSING');
  expect(validateModelAssetIdentity(ref,null)[0]).toContain('E_MODEL_META_MISSING');
  expect(validateModelAssetIdentity(ref,{...meta,guid:'as_other'})[0]).toContain('E_MODEL_GUID');
  expect(validateModelAssetIdentity(ref,{...meta,kind:'audio'})[0]).toContain('E_MODEL_ASSET_KIND');
 });
 it('按key继承资产默认、场景显式覆盖或禁用，不修改默认',()=>{
  const defaults={primaryHand:{bone:'RightHand',contact:identitySocket()},dependentHand:{bone:'LeftHand',contact:identitySocket()}};
  const override={primaryHand:{bone:'mixamorig:RightHand',contact:{position:[.01,0,0] as [number,number,number],rotation:[0,0,0,1] as [number,number,number,number]}}};
  const resolved=resolveSocketDefaults(defaults,override)!;expect(resolved.primaryHand).toEqual(override.primaryHand);expect(resolved.dependentHand).toEqual(defaults.dependentHand);
  resolved.dependentHand!.contact.position[0]=2;expect(defaults.dependentHand.contact.position[0]).toBe(0);
  expect(resolveSocketDefaults(defaults,null)).toBeNull();expect(resolveSocketDefaults(defaults,undefined)).toEqual(defaults);
  expect(resolveSocketDefaults(null,undefined)).toBeNull();expect(resolveSocketDefaults(null,override)).toEqual(override);
 });
 it('sidecar正式块round-trip，拒绝非有限位置/非单位方向与错误名称',()=>{
  const meta=createDefaultAssetMeta('as_socket','gltf');meta.modelSockets={primaryGrip:identitySocket()};meta.boneSockets={primaryHand:{bone:'RightHand',contact:identitySocket()}};
  expect(validateAssetMeta(JSON.parse(JSON.stringify(meta))).filter(d=>d.severity==='error')).toEqual([]);
  expect(validModelSockets({grip:{position:[0,NaN,0],rotation:[0,0,0,1]}})).toBe(false);
  expect(validModelSockets({grip:{position:[0,0,0],rotation:[0,0,0,2]}})).toBe(false);
  expect(validBoneSockets({hand:{bone:3,contact:identitySocket()}})).toBe(false);
 });
});
