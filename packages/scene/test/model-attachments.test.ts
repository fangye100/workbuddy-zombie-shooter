import {describe,it,expect} from 'vitest';
import {identitySocket,resolveSocketDefaults,validModelSockets,validBoneSockets,validWeaponDefinition,legacyWeaponArsenal,validateModelAssetIdentity,
  actorHoldSlot,validActorHoldProfiles,createEmptySceneDocument,createDefaultAssetMeta,validateAssetMeta,migrateToLatest,validateSceneDocument,registerSceneMigrations,type SceneNode} from '@aether/scene';
describe('正式模型与骨 socket 持久化',()=>{
 it('逐角色、逐模型持握六维配置隔离；缺配置不改变legacy',()=>{
  const a=createDefaultAssetMeta('actorA','gltf'),b=createDefaultAssetMeta('actorB','gltf');
  const models=[{path:'assets/a.glb',guid:'modelA'},{path:'assets/b.glb',guid:'modelB'}];
  for(const [i,meta] of [a,b].entries())meta.holdProfiles=Object.fromEntries(models.map((model,j)=>[model.guid,{model,slot:{bone:'Hips',position:[i,j,.2],rotation:[0,0,0,1]}}]));
  expect(validateAssetMeta(JSON.parse(JSON.stringify(a))).filter(d=>d.severity==='error')).toEqual([]);
  const slot=actorHoldSlot(a.holdProfiles,models[0]!)!;slot.position[0]=99;
  expect(actorHoldSlot(a.holdProfiles,models[0]!)!.position).toEqual([0,0,.2]);
  expect(actorHoldSlot(b.holdProfiles,models[1]!)!.position).toEqual([1,1,.2]);expect(actorHoldSlot(undefined,models[0]!)).toBeUndefined();
  for(const mutate of [(p:any)=>p.model.guid='wrong',(p:any)=>p.slot.bone='',(p:any)=>p.slot.rotation=[0,0,0,2],(p:any)=>p.slot.position[0]=NaN]){
   const copy=structuredClone(a.holdProfiles!);mutate(copy.modelA);expect(validActorHoldProfiles(copy)).toBe(false);expect(()=>actorHoldSlot(copy,models[0]!)).toThrow('E_ACTOR_HOLD_PROFILE');
   expect(validateAssetMeta({...a,holdProfiles:copy}).some(d=>d.code==='E_META_HOLD_PROFILES')).toBe(true);
  }
 });
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
 it('v16机械迁移仅明确legacy，不猜握点；malformed保持并报诊断',()=>{
  registerSceneMigrations();const doc=createEmptySceneDocument('old');doc.schemaVersion=16;
  const weapon=legacyWeaponArsenal({magazineSize:12,reserveRounds:40,reloadSec:1}).definitions[0]!;
  doc.nodes.push({id:'rules',name:'rules',parent:null,prefab:null,visible:true,pickable:false,category:'',transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},components:[{kind:'RunRules',enabled:true,arsenal:{equipped:weapon.id,switchSec:.2,definitions:[weapon]}}]} as unknown as SceneNode);
  const result=migrateToLatest(doc);expect(result.to).toBe(24);expect(result.applied).toEqual(['authored-3d-navigation-surfaces','runtime-navigation-gates','procedural-surface-decals','expanded-procedural-decal-styles','authored-combat-decal-emitter','integrated-navigation-pose-sockets','integrated-navigation-and-vfx','destructible-fracture-components']);
  const rules=result.doc.nodes.at(-1)!.components[0] as unknown as {arsenal:{definitions:typeof weapon[]}};
  expect(rules.arsenal.definitions[0]!.presentation.assembly).toBeNull();expect(weapon.presentation.assembly).toBeUndefined();
  const copy=structuredClone(weapon);copy.presentation.assembly={holdPose:identitySocket(),attachments:[],reloadAttachmentId:'missing'};
  expect(validWeaponDefinition(copy)).toBe(false);
  const broken=createEmptySceneDocument('broken');broken.schemaVersion=16;broken.nodes.push({id:'actor',name:'actor',visible:true,components:[{kind:'MeshRenderer',enabled:true,boneSockets:{hand:{bone:2,contact:identitySocket()}}}]} as unknown as SceneNode);
  expect(validateSceneDocument(migrateToLatest(broken).doc).some(d=>d.code==='E_BONE_SOCKETS')).toBe(true);
 });
 it('v17保留旧绝对hold；新slot往返且非法bone/位置不静默修复',()=>{
  registerSceneMigrations();const doc=createEmptySceneDocument('old-slot');doc.schemaVersion=17;
  const result=migrateToLatest(doc);expect(result.to).toBe(24);expect(result.applied).toEqual(['runtime-navigation-gates','procedural-surface-decals','expanded-procedural-decal-styles','authored-combat-decal-emitter','integrated-navigation-pose-sockets','integrated-navigation-and-vfx','destructible-fracture-components']);expect(doc.schemaVersion).toBe(17);
  const weapon=legacyWeaponArsenal({magazineSize:12,reserveRounds:40,reloadSec:1}).definitions[0]!;
  weapon.presentation.assembly={holdPose:identitySocket(),attachments:[],reloadAttachmentId:null};
  expect(validWeaponDefinition(weapon)).toBe(true);expect(weapon.presentation.assembly.holdSlot).toBeUndefined();
  weapon.presentation.assembly.holdSlot={bone:'Hips',position:[.1,.25,.3]};
  expect(validWeaponDefinition(JSON.parse(JSON.stringify(weapon)))).toBe(true);
  for(const bad of [{bone:'',position:[0,0,0]},{bone:3,position:[0,0,0]},{bone:'Hips',position:[0,NaN,0]},{bone:'Hips',position:[0,0]},{bone:'Hips',position:[0,101,0]}]){
   const copy=structuredClone(weapon);copy.presentation.assembly!.holdSlot=bad as never;expect(validWeaponDefinition(copy)).toBe(false);
  }
 });
});
