import {describe,it,expect} from 'vitest';
import type {WeaponArsenal} from '@aether/scene';
import shoulders from '../fixtures/weapon-hold-shoulders.json';
import {quatMul} from '@aether/core';
import {identitySocket} from '@aether/scene';
import {WeaponSystem} from '@aether/runtime';
import {weaponModelProjection} from '../../src/presentation/weapon-model';
const arsenal=Object.values(import.meta.glob('../../../../assets/weapons/prototype.weapons.json',{eager:true,import:'default'}))[0] as WeaponArsenal;
const calibration=Object.values(import.meta.glob('../../../../assets/art/calibration/weapon-assembly-trial.json',{eager:true,import:'default'}))[0] as {holdSlotReference:{position:number[]}};
describe('实机正常持枪/切换肩球位置回归',()=>{
 for(const [id,data] of Object.entries(shoulders.weapons))it(`${id} 作者slot保留前移且观测双手目标留出可达余量`,()=>{
  const assembly=arsenal.definitions.find(w=>w.id===id)!.presentation.assembly!,current=assembly.holdSlot!;
  expect(current.bone).toBe(data.originalSlot.bone);
  const delta=current.position.map((v,i)=>v-data.originalSlot.position[i]!);
  expect(current.position[2]+calibration.holdSlotReference.position[2]!-assembly.holdPose.position[2]).toBeGreaterThan(.03);
  const weapon=arsenal.definitions.find(w=>w.id===id)!,system=new WeaponSystem({...arsenal,equipped:id}),socket=identitySocket(),sockets={primaryGrip:socket,supportGrip:socket,muzzle:socket,magazine:socket,chamber:socket};
  const hand={id:'rightHand',socket:{bone:'RightHand',contact:socket}},left={id:'leftHand',socket:{bone:'LeftHand',contact:socket}};
  const project=(yaw:number)=>weaponModelProjection(weapon,system.poseIntent,yaw,quatMul([0,-Math.sin(yaw/2),0,Math.cos(yaw/2)],[0,Math.SQRT1_2,0,Math.SQRT1_2]),sockets,hand,left,undefined,undefined,0)!.request;
  const zero=project(0),side=project(Math.PI*.75);expect(side.target.position).toEqual(zero.target.position);side.target.rotation.forEach((v,i)=>expect(v).toBeCloseTo(zero.target.rotation[i]!,10));
  for(const frame of data.frames){
   const target=frame.originalTarget.map((v,i)=>v+delta[i]!);
   const demand=Math.hypot(...target.map((v,i)=>v-frame.shoulder[i]!));
   expect(frame.reach-demand).toBeGreaterThan(.005);
  }
 });
});
