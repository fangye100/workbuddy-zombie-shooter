import {describe,expect,it} from 'vitest';
import {quatMul} from '@aether/core';
import {WeaponSystem} from '@aether/runtime';
import {identitySocket,legacyWeaponArsenal} from '@aether/scene';
import {composeSocket,rotateVec3} from '@aether/render';
import {weaponModelProjection} from '../../src/presentation/weapon-model';
describe('真实模型表现仅消费已有武器相位',()=>{
 const arsenal=()=>{const a=legacyWeaponArsenal({magazineSize:3,reserveRounds:8,reloadSec:1});const w=a.definitions[0]!;
  w.presentation.assembly={holdPose:{position:[0,1.2,.3],rotation:[0,Math.SQRT1_2,0,Math.SQRT1_2]},attachments:[],reloadAttachmentId:null};return a;};
 const socket=identitySocket(),hand={id:'rightHand',socket:{bone:'RightHand',contact:socket}},left={id:'leftHand',socket:{bone:'LeftHand',contact:socket}};
 const sockets={primaryGrip:socket,supportGrip:socket,magazine:socket,chamber:socket,muzzle:{...socket,rotation:[0,-Math.SQRT1_2,0,Math.SQRT1_2] as [number,number,number,number]}};
 it.each([0,Math.PI/2,Math.PI,-Math.PI/2])('actor朝向抵消后枪口随yaw=%s，无重复yaw',yaw=>{
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
});
