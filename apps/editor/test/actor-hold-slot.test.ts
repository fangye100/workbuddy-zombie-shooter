import {describe,it,expect,vi} from 'vitest';
import {createDefaultAssetMeta,identitySocket,type ActorHoldProfiles,type ActorHoldSlot} from '@aether/scene';
import {sceneFingerprint} from '@aether/runtime';
import {quatMul,quatAxisAngle} from '@aether/core';
import {rotateVec3} from '@aether/render';
import {ActorHoldSlotSession,slotFromWorld} from '../src/services/actor-hold-slot';
import {GizmoTargetDrag} from '../src/services/gizmo-target-drag';
import type {HoldContext} from '../src/services/runtime-weapons';
const slot=(x=0):ActorHoldSlot=>({bone:'Hips',position:[x,.2,.3],rotation:[0,0,0,1]});
function fixture(){
  let disk=createDefaultAssetMeta('actorA','gltf');disk.holdProfiles={modelA:{model:{guid:'modelA',path:'assets/a.glb'},slot:slot()}};
  let context:HoldContext|null={actor:{guid:'actorA',path:'assets/actorA.glb'},nodeId:'player',generation:1,pending:0,activeWeaponId:'a',profiles:structuredClone(disk.holdProfiles),diagnostics:[],
    weapons:['A','B'].map(k=>({id:k.toLowerCase(),name:k,model:{guid:`model${k}`,path:`assets/${k.toLowerCase()}.glb`},slot:slot()})),frame:null};
  let editable=true,fail=false;const invalidate=vi.fn();const preview=vi.fn((guid:string,profiles:ActorHoldProfiles)=>{if(guid!==context?.actor.guid)throw Error('wrong actor');context.profiles=profiles;});
  const write=vi.fn(async(_path,patch:{holdProfiles:ActorHoldProfiles},hash:string)=>{
    if(fail)return {ok:false,status:0,error:'IO'};
    if(hash!==sceneFingerprint(disk))return {ok:false,status:409,error:'conflict',conflict:true};
    disk={...disk,...structuredClone(patch)};return {ok:true,status:200,error:null,hash:sceneFingerprint(disk)};
  });
  const session=new ActorHoldSlotSession({context:()=>context,editable:()=>editable,read:async()=>({ok:true,status:200,json:structuredClone(disk),error:null}),write,preview,invalidate});
  return {session,write,preview,invalidate,get disk(){return disk;},set disk(v){disk=v;},get context(){return context;},set context(v){context=v;},set editable(v:boolean){editable=v;},set fail(v:boolean){fail=v;}};
}
describe('角色持握资产草稿与保存边界',()=>{
 it('一次drag一个历史；两个武器隔离，Undo/Redo、Stop/newPlay保留草稿，Save仅patch角色块',async()=>{
  const f=fixture();await f.session.hydrate();f.session.beginDrag();f.session.edit(slot(.01),false);f.session.edit(slot(.02),false);f.session.endDrag();
  expect(f.session.dirty).toBe(true);f.session.history();expect(f.session.slot).toEqual(slot());f.session.history(true);expect(f.session.slot).toEqual(slot(.02));
  f.session.select('b');f.session.edit(slot(-.03));expect(f.session.summary().profiles.modelA!.slot).toEqual(slot(.02));
  const context=f.context;f.context=null;await f.session.hydrate();f.context={...context!,generation:2,profiles:structuredClone(f.disk.holdProfiles)};await f.session.hydrate();expect(f.context.profiles!.modelB!.slot).toEqual(slot(-.03));
  const original=structuredClone(f.disk);await f.session.save();expect(f.session.dirty).toBe(false);expect(f.write.mock.calls[0]![1]).toEqual({holdProfiles:f.disk.holdProfiles});expect(f.disk.rig).toEqual(original.rig);expect(f.invalidate).toHaveBeenCalledWith('assets/actorA.glb');
  f.session.history();expect(f.session.dirty).toBe(true);await f.session.reload();expect(f.session.error).toContain('草稿未保存');await f.session.reload(true);expect(f.session.dirty).toBe(false);expect(f.session.summary().profiles).toEqual(f.disk.holdProfiles);
 });
 it('IO/409不丢dirty/history；新runtime clean重新读meta，不覆写外部新版',async()=>{
  const f=fixture();await f.session.hydrate();f.session.edit(slot(.04));f.fail=true;await f.session.save();expect(f.session.dirty).toBe(true);expect(f.session.summary().canUndo).toBe(true);f.fail=false;
  f.disk={...f.disk,userData:{foreign:1}};await f.session.save();expect(f.session.error).toContain('冲突');expect(f.disk.holdProfiles!.modelA!.slot).toEqual(slot());expect(f.session.dirty).toBe(true);
  await f.session.reload(true);f.disk={...f.disk,holdProfiles:{modelA:{model:{guid:'modelA',path:'assets/a.glb'},slot:slot(.08)}}};f.context={...f.context!,generation:3,profiles:structuredClone(f.disk.holdProfiles)};await f.session.hydrate();expect(f.session.slot).toEqual(slot(.08));expect(f.disk.userData).toEqual({foreign:1});
 });
 it('不同角色GUID拒绝误预览/保存；非法quat/运行态不编辑',async()=>{
  const f=fixture();await f.session.hydrate();f.editable=false;expect(f.session.edit(slot(.02))).toBe(false);f.editable=true;expect(f.session.edit({...slot(),rotation:[0,0,0,2]})).toBe(false);
  f.session.edit(slot(.02));const previous=f.preview.mock.calls.length;f.context={...f.context!,actor:{guid:'actorB',path:'assets/actorB.glb'}};await f.session.hydrate();expect(f.session.error).toContain('先保存或放弃');expect(f.session.ready).toBe(false);await f.session.save();expect(f.write).not.toHaveBeenCalled();expect(f.preview.mock.calls).toHaveLength(previous);
 });
 it('拖动取消回滚本次草稿；未改变的操作不制造历史',async()=>{
  const f=fixture();await f.session.hydrate();f.session.edit(slot());expect(f.session.summary().canUndo).toBe(false);f.session.beginDrag();f.session.edit(slot(.1),false);f.session.endDrag(true);expect(f.session.slot).toEqual(slot());expect(f.session.dirty).toBe(false);
 });
});
describe('非场景gizmo坐标与拖拽',()=>{
 it('世界变化反求角色局部米制/中性旋转，任意actor yaw和scale往返',()=>{
  const actor=quatAxisAngle([0,1,0],1.2),before={position:[3,2,4] as [number,number,number],rotation:[...quatMul(actor,slot().rotation)] as [number,number,number,number]},delta=rotateVec3(actor,[.02,0,.04]);
  const after={position:before.position.map((v,i)=>v+delta[i]!*2) as [number,number,number],rotation:[...quatMul(before.rotation,quatAxisAngle([0,0,1],.1))] as [number,number,number,number]};
  const result=slotFromWorld(slot(),before,after,{weaponId:'a',world:before,actorRotation:actor,scale:2});result.position.forEach((v,i)=>expect(v).toBeCloseTo([.02,.2,.34][i]!));expect(result.rotation[2]).toBeCloseTo(Math.sin(.05));
 });
 it('轴移动与旋转只回调target；结束一次command、退化ray拒绝开始',()=>{
  let value=identitySocket(),mode:'translate'|'rotate'='translate';const begin=vi.fn(),end=vi.fn(),write=vi.fn(v=>{value=v;});
  const drag=new GizmoTargetDrag({eye:()=>[0,0,10],ray:(x,y)=>({o:[x,y,10],d:[0,0,-1]}),info:()=>({origin:[0,0,0],axes:[[1,0,0],[0,1,0],[0,0,1]],mode}),read:()=>value,write,begin,end});
  expect(drag.begin(0,.2,0)).toBe(true);drag.update(.3,.4);expect(value.position[0]).toBeCloseTo(.1);expect(value.position[1]).toBe(0);drag.end();expect(end).toHaveBeenCalledOnce();expect(end).toHaveBeenCalledWith(false);
  value=identitySocket();mode='rotate';expect(drag.begin(2,1,0)).toBe(true);drag.update(0,1);expect(value.rotation[2]).toBeCloseTo(Math.SQRT1_2);drag.end(true);expect(end).toHaveBeenLastCalledWith(true);expect(begin).toHaveBeenCalledTimes(2);
  expect(drag.begin(0,1,0)).toBe(false);
 });
});
