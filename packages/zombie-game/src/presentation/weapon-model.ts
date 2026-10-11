/** 武器表现投影：只消费 WeaponSystem 已有相位，不拥有时钟、弹药或玩法。 */
import { quatMul, type Quat } from '@aether/core';
import type { WeaponSystem } from '@aether/runtime';
import type { BoneSocket, ModelSockets, SocketTransform, WeaponDefinition } from '@aether/scene';
import { inverseRotation, rotateVec3, type AttachmentIkRequest } from '@aether/render';

export interface WeaponModelProjection {
  request: AttachmentIkRequest;
  magazineRemoved: boolean;
}
export function weaponModelProjection(def:WeaponDefinition,pose:WeaponSystem['poseIntent'],yaw:number,actorRotation:Quat,
  sockets:ModelSockets,right:{id:string;socket:BoneSocket},left:{id:string;socket:BoneSocket},reloadGrip?:SocketTransform):WeaponModelProjection|null {
  const assembly=def.presentation.assembly;
  if(!assembly||!sockets.primaryGrip||!sockets.supportGrip||!sockets.muzzle)return null;
  const inverseActor=inverseRotation(actorRotation),aim:Quat=[0,-Math.sin(yaw/2),0,Math.cos(yaw/2)];
  const recoil:Quat=[0,0,Math.sin(pose.recoil.pitchDeg*Math.PI/360),Math.cos(pose.recoil.pitchDeg*Math.PI/360)];
  const worldRotation=quatMul(quatMul(aim,recoil),assembly.holdPose.rotation);
  const recoilPosition=rotateVec3(quatMul(inverseActor,aim),pose.recoil.translation);
  const lowering=pose.action==='unequip'?pose.phase*.18:pose.action==='equip'?(1-pose.phase)*.18:0;
  const target:SocketTransform={position:assembly.holdPose.position.map((n,i)=>n+recoilPosition[i]!-(i===1?lowering:0)) as [number,number,number],rotation:[...quatMul(inverseActor,worldRotation)]};
  const p=def.presentation.procedural;
  const magazineRemoved=pose.action==='reload'&&pose.phase>=p.magazineOutPhase&&pose.phase<p.magazineInPhase&&assembly.reloadAttachmentId!==null;
  let dependent=sockets[pose.reload.leftHandTarget];
  if(!dependent)return null;
  dependent=structuredClone(magazineRemoved&&reloadGrip?reloadGrip:dependent);
  if(magazineRemoved){
    const phase=(pose.phase-p.magazineOutPhase)/Math.max(1e-8,p.magazineInPhase-p.magazineOutPhase);
    dependent.position[1]-=.12*Math.sin(Math.PI*phase);
  }
  return {magazineRemoved,request:{target,primary:{controlId:right.id,contact:right.socket.contact,modelSocket:sockets.primaryGrip},
    dependent:{controlId:left.id,contact:left.socket.contact,modelSocket:dependent}}};
}

/** 有效同帧模型才门控 Canvas；失败和未配置保留旧表现。 */
export interface WeaponModelView { visible:boolean; weaponId:string|null; frameStamp:number; muzzle:SocketTransform|null; diagnostics:readonly string[] }
