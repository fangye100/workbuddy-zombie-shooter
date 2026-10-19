import {describe,expect,it} from 'vitest';
import {quatMul} from '@aether/core';
import {WeaponSystem} from '@aether/runtime';
import {identitySocket,legacyWeaponArsenal} from '@aether/scene';
import {composeSocket,rotateVec3} from '@aether/render';
import {weaponActionFrameDiagnostics,weaponModelProjection,weaponMountForHoldSlot} from '../../src/presentation/weapon-model';
describe('真实模型表现仅消费已有武器相位',()=>{
 it('中性根位移/旋转同时转换markers；runtime应用不重置弹药、事件、相位',()=>{
  const a=arsenal(),base=a.definitions[0]!;base.presentation.assembly!.holdSlot={bone:'Hips',position:[0,.2,.3]};
  const slot={...base.presentation.assembly!.holdSlot,rotation:[...base.presentation.assembly!.holdPose.rotation] as [number,number,number,number]};
  const identity=weaponMountForHoldSlot(base,slot);for(const key of Object.keys(identity.markers)){
   const k=key as keyof typeof identity.markers;identity.markers[k].position.forEach((n,i)=>expect(n).toBeCloseTo(base.presentation.markers[k].position[i]!,12));
  }
  const moved=weaponMountForHoldSlot(base,{...slot,position:[.1,.25,.32]});
  moved.markers.muzzle.position.forEach((v,i)=>expect(v-base.presentation.markers.muzzle.position[i]!).toBeCloseTo([.02,.05,-.1][i]!,10));
  const quarter=weaponMountForHoldSlot(base,{...slot,rotation:[...quatMul([0,0,Math.SQRT1_2,Math.SQRT1_2],slot.rotation)]});
  // yaw-local muzzle [.3,0,0] - old pivot [.3,.2,0] = actor [0,-.2,0]。
  quarter.markers.muzzle.position.forEach((v,i)=>expect(v).toBeCloseTo([.3,.2,-.2][i]!,10));
  const rotatedForward=rotateVec3(quarter.markers.muzzle.rotation,[1,0,0]);expect(Math.hypot(...rotatedForward)).toBeCloseTo(1);
  const system=new WeaponSystem(a);system.beginFire();system.advance(.05);const state=system.snapshot(),pose=system.poseIntent,events=structuredClone(system.events);
  system.configureMount(base.id,moved);expect(system.snapshot()).toEqual(state);expect(system.events).toEqual(events);expect(system.poseIntent.phase).toBe(pose.phase);expect(system.poseIntent.action).toBe(pose.action);
  expect(system.active.presentation.markers).toEqual(moved.markers);expect(()=>system.configureMount('missing',moved)).toThrow('WEAPON_MOUNT_ID');
  expect(()=>system.configureMount(base.id,{...moved,markers:{...moved.markers,muzzle:{...moved.markers.muzzle,position:[NaN,0,0]}}})).toThrow('WEAPON_MOUNT_INVALID');expect(system.active.presentation.markers).toEqual(moved.markers);
 });
 const arsenal=()=>{const a=legacyWeaponArsenal({magazineSize:3,reserveRounds:8,reloadSec:1});const w=a.definitions[0]!;
  w.presentation.assembly={holdPose:{position:[0,1.2,.3],rotation:[0,Math.SQRT1_2,0,Math.SQRT1_2]},attachments:[],reloadAttachmentId:null};return a;};
 const socket=identitySocket(),hand={id:'rightHand',socket:{bone:'RightHand',contact:socket}},left={id:'leftHand',socket:{bone:'LeftHand',contact:socket}};
 const sockets={primaryGrip:socket,supportGrip:socket,magazine:socket,chamber:socket,muzzle:{...socket,rotation:[0,-Math.SQRT1_2,0,Math.SQRT1_2] as [number,number,number,number]}};
 it.each([0,Math.PI/2,Math.PI,Math.PI*.75])('slot替代旧绝对位置并消费现switch/recoil；actor yaw=%s',yaw=>{
  const a=arsenal(),def=a.definitions[0]!;def.presentation.assembly!.holdSlot={bone:'Hips',position:[-.1,.3,.2]};const w=new WeaponSystem(a);
  const actor=quatMul([0,-Math.sin(yaw/2),0,Math.cos(yaw/2)],[0,Math.SQRT1_2,0,Math.SQRT1_2]);
  const pose={...w.poseIntent,action:'equip' as const,phase:.5,recoil:{translation:[-.02,0,0] as [number,number,number],pitchDeg:3}};
  const before=structuredClone(def),p=weaponModelProjection(def,pose,yaw,actor,sockets,hand,left,undefined,undefined,7)!;
  expect(p.request.positionAnchor).toEqual({node:7});expect(p.request.target.position[1]).toBeCloseTo(.26);expect(p.request.target.position[2]).toBeCloseTo(.18);expect(p.request.target.position[0]).toBeCloseTo(-.1);
  expect(weaponModelProjection(def,pose,yaw,actor,sockets,hand,left,undefined,undefined,7)).toEqual(p);expect(def).toEqual(before);
  const messages:string[]=[];expect(weaponModelProjection(def,pose,yaw,actor,sockets,hand,left,undefined,d=>messages.push(d))).toBeNull();expect(messages.join()).toContain('WEAPON_HOLD_SLOT');
 });
 it.each([0,Math.PI/2,Math.PI,-Math.PI/2,Math.PI*.75])('actor朝向抵消后枪口随yaw=%s，无重复yaw',yaw=>{
  const w=new WeaponSystem(arsenal()),qAim:[number,number,number,number]=[0,-Math.sin(yaw/2),0,Math.cos(yaw/2)],actor=quatMul(qAim,[0,Math.SQRT1_2,0,Math.SQRT1_2]);
  const result=weaponModelProjection(w.active,w.poseIntent,yaw,actor,sockets,hand,left)!;
  const modelWorld={position:[0,0,0] as [number,number,number],rotation:[...quatMul(actor,result.request.target.rotation)] as [number,number,number,number]};
  const muzzle=composeSocket(modelWorld,sockets.muzzle),forward=rotateVec3(muzzle.rotation,[1,0,0]);
  expect(forward[0]).toBeCloseTo(Math.cos(yaw),6);expect(forward[2]).toBeCloseTo(Math.sin(yaw),6);
 });
 it.each(['pistol','launcher'])('recoil先在瞄准轴pitch，再适配%s模型轴',kind=>{
  const w=new WeaponSystem(arsenal());if(kind==='launcher')w.active.presentation.assembly!.holdPose.rotation=[0,0,0,1];
  const muzzle=kind==='pistol'?sockets.muzzle:socket;
  const pose={...w.poseIntent,recoil:{...w.poseIntent.recoil,pitchDeg:20}};
  const p=weaponModelProjection(w.active,pose,0,[0,0,0,1],{...sockets,muzzle},hand,left)!;
  const forward=rotateVec3(composeSocket(p.request.target,muzzle).rotation,[1,0,0]);
  expect(forward[0]).toBeCloseTo(Math.cos(Math.PI/9),6);expect(forward[1]).toBeCloseTo(Math.sin(Math.PI/9),6);expect(forward[2]).toBeCloseTo(0,6);
 });
 it('换弹卸装跟随WeaponSystem阈值，不改弹药/pose，不累计clock',()=>{
  const a=arsenal();a.definitions[0]!.presentation.assembly!.reloadAttachmentId='magazine';
  const w=new WeaponSystem(a);w.beginFire();w.advance(.4);w.reload();w.advance(.3);
  const before=w.snapshot(),pose=w.poseIntent;
  const projected=weaponModelProjection(w.active,pose,0,[0,0,0,1],sockets,hand,left)!;
  expect(projected.magazineRemoved).toBe(true);expect(projected.request.dependent!.modelSocket.position[1]).toBeLessThan(0);
  for(let i=0;i<3;i++)expect(weaponModelProjection(w.active,pose,0,[0,0,0,1],sockets,hand,left)).toEqual(projected);
  expect(w.snapshot()).toEqual(before);expect(w.poseIntent).toEqual(pose);
  w.advance(.4);expect(weaponModelProjection(w.active,w.poseIntent,0,[0,0,0,1],sockets,hand,left)!.magazineRemoved).toBe(false);
 });
 it('缺socket或legacy不臆造精确装配',()=>{
  const w=new WeaponSystem(arsenal());expect(weaponModelProjection(w.active,w.poseIntent,0,[0,0,0,1],{},hand,left)).toBeNull();
  w.active.presentation.assembly=null;expect(weaponModelProjection(w.active,w.poseIntent,0,[0,0,0,1],sockets,hand,left)).toBeNull();
 });
 it('前孔动作frame是相对模型hold的Game策略，先轴向退出再侧移，回位不产生新clock',()=>{
  const a=arsenal(),def=a.definitions[0]!,assembly=def.presentation.assembly!;
  assembly.holdPose={position:[-.31,1.15,.30],rotation:[0,0,0,1]};assembly.reloadAttachmentId='round';
  const w=new WeaponSystem(a),actor:[number,number,number,number]=[0,Math.SQRT1_2,0,Math.SQRT1_2];
  const action={...sockets,primaryGrip:{...socket,position:[-.222,.074,0] as [number,number,number]},supportGrip:{...socket,position:[-.08,.213,-.05] as [number,number,number]},
    magazine:{...socket,position:[.197,.28,0] as [number,number,number]},chamber:{...socket,position:[.197,.28,0] as [number,number,number]},
    reloadPose:{position:[.135,-.024,-.382] as [number,number,number],rotation:actor},reloadExtract:{...socket,position:[.179,-.04,0] as [number,number,number]},
    reloadClearance:{...socket,position:[0,.14,0] as [number,number,number]},reloadReturnClearance:{...socket,position:[0,.14,.20] as [number,number,number]}};
  const grip={...socket,position:[.232,.28,0] as [number,number,number]},before=w.snapshot();
  const project=(phase:number)=>weaponModelProjection(def,{...w.poseIntent,action:'reload',phase,reload:{phase,leftHandTarget:phase<.2?'supportGrip':phase>=.85?'chamber':'magazine'}},0,actor,action,hand,left,grip)!;
  const mounted=project(.2);[.072,1.126,.435].forEach((v,k)=>expect(mounted.request.target.position[k]).toBeCloseTo(v,10));
  const early=project(.2+(.65-.2)*.1),mid=project(.425),returned=project(.65);
  expect(early.request.dependent!.modelSocket.position[0]).toBeGreaterThan(grip.position[0]);
  expect(early.request.dependent!.modelSocket.position[1]).toBe(grip.position[1]);
  expect(mid.request.dependent!.modelSocket.position[0]).toBeCloseTo(grip.position[0]+.179);
  expect(mid.request.dependent!.modelSocket.position[1]).toBeCloseTo(grip.position[1]-.04);
  expect(returned.magazineRemoved).toBe(false);expect(returned.request.dependent!.modelSocket.position).toEqual(action.magazine.position);
  assembly.holdPose.position.forEach((v,k)=>expect(project(1).request.target.position[k]).toBeCloseTo(v,10));action.supportGrip.position.forEach((v,k)=>expect(project(1).request.dependent!.modelSocket.position[k]).toBeCloseTo(v,10));
  expect(project(.1).request.target.position[1]).toBeGreaterThan(assembly.holdPose.position[1]);
  for(const phase of [0,.05,.1,.15,.2,.35,.5,.65,.85,.9,.95,1])expect(Math.hypot(...project(phase).request.target.rotation)).toBeCloseTo(1,8);
  expect(w.snapshot()).toEqual(before);
 });
 it('可选动作frame全部缺失保留旧路径，配置不齐/非法必须显式诊断',()=>{
  expect(weaponActionFrameDiagnostics(sockets)).toEqual([]);
  expect(weaponActionFrameDiagnostics({...sockets,reloadPose:socket})).toContain('WEAPON_ACTION_FRAME: reloadExtract 缺失或不是有效模型局部刚体frame');
  const a=arsenal(),w=new WeaponSystem(a),bad={...sockets,reloadPose:socket,reloadExtract:{...socket,position:[-.1,0,0] as [number,number,number]}},messages:string[]=[];
  expect(weaponModelProjection(w.active,w.poseIntent,0,[0,0,0,1],bad,hand,left,undefined,d=>messages.push(d))).toBeNull();
  expect(messages.some(d=>d.includes('沿模型局部+X'))).toBe(true);
  const valid={...sockets,reloadPose:socket,reloadExtract:{...socket,position:[.1,0,0] as [number,number,number]}};
  const reload={...w.poseIntent,action:'reload' as const,phase:.3};
  expect(weaponModelProjection(w.active,reload,0,[0,0,0,1],valid,hand,left,undefined,d=>messages.push(d))).toBeNull();
  expect(messages.some(d=>d.includes('真实reload附件'))).toBe(true);
 });
});
