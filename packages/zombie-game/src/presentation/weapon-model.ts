/** 武器表现投影：只消费 WeaponSystem 已有相位，不拥有时钟、弹药或玩法。 */
import { quatMul, type Quat, type Vec3 } from '@aether/core';
import type { WeaponSystem } from '@aether/runtime';
import type { ActorHoldSlot, BoneSocket, ModelSockets, SocketTransform, WeaponDefinition } from '@aether/scene';
import { validActorHoldSlot, validSocketTransform } from '@aether/scene';
import { composeSocket, inverseRotation, rotateVec3, type AttachmentIkRequest } from '@aether/render';

export interface WeaponModelProjection {
  request: AttachmentIkRequest;
  magazineRemoved: boolean;
}
const smooth=(x:number)=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
/** 玩家 mesh 的 +Z 前方对应模拟 yaw-local +X；作者平移不从 GPU 姿态反向计算。 */
export function weaponMarkerTranslationForActorOffset(delta:Vec3):[number,number,number] { return [delta[2],delta[1],-delta[0]]; }
/** 中性根刚体变化同时应用于装配和模拟 markers；不改变瞄准规则/动作时钟。 */
export function weaponMountForHoldSlot(def:WeaponDefinition,slot:ActorHoldSlot):Pick<WeaponDefinition['presentation'],'assembly'|'markers'> {
  const assembly=def.presentation.assembly;if(!assembly||!validActorHoldSlot(slot))throw new Error('WEAPON_HOLD_PROFILE: 无效中性持握配置');
  const oldPosition=assembly.holdSlot?.position??assembly.holdPose.position;
  const delta=quatMul(slot.rotation,inverseRotation(assembly.holdPose.rotation));
  const toActor=(p:Vec3):Vec3=>[-p[2],p[1],p[0]];
  const pivot=weaponMarkerTranslationForActorOffset(oldPosition);
  const markers=structuredClone(def.presentation.markers);
  // actor 与模拟 yaw-local 的固定基变换；绝不把武器模型自身+X当作actor右侧。
  const basis:Quat=[0,Math.SQRT1_2,0,Math.SQRT1_2];
  const markerRotation=quatMul(quatMul(basis,delta),inverseRotation(basis));
  for(const marker of Object.values(markers)){
    const relative=toActor(marker.position.map((v,i)=>v-pivot[i]!) as [number,number,number]),rotated=rotateVec3(delta,relative);
    marker.position=weaponMarkerTranslationForActorOffset(rotated.map((v,i)=>v+slot.position[i]!) as [number,number,number]);
    marker.rotation=[...quatMul(markerRotation,marker.rotation)];
  }
  return {assembly:{...structuredClone(assembly),holdSlot:{bone:slot.bone,position:[...slot.position]},holdPose:{...structuredClone(assembly.holdPose),rotation:[...slot.rotation]}},markers};
}
function blendRotation(a:Quat,b:Quat,t:number):SocketTransform['rotation'] {
  let dot=a.reduce((n,v,i)=>n+v*b[i]!,0),sign=dot<0?-1:1;dot=Math.min(1,Math.abs(dot));
  const angle=Math.acos(dot),s=Math.sin(angle),wa=s<1e-6?1-t:Math.sin((1-t)*angle)/s,wb=s<1e-6?t:Math.sin(t*angle)/s;
  const q=a.map((v,i)=>v*wa+b[i]!*sign*wb),n=Math.hypot(...q);return [q[0]!/n,q[1]!/n,q[2]!/n,q[3]!/n];
}
/** Game约定的可选动作参考frame；不是物理握点/槽，也不保存actor坐标或时钟。 */
export function weaponActionFrameDiagnostics(sockets:ModelSockets):string[] {
  const keys=['reloadPose','reloadExtract','reloadClearance','reloadReturnClearance'];
  if(!keys.some(k=>sockets[k]!==undefined))return [];
  const errors=keys.filter(k=>(k==='reloadPose'||k==='reloadExtract'||sockets[k]!==undefined)&&!validSocketTransform(sockets[k]))
    .map(k=>`WEAPON_ACTION_FRAME: ${k} 缺失或不是有效模型局部刚体frame`);
  if(sockets.reloadExtract&&validSocketTransform(sockets.reloadExtract)&&sockets.reloadExtract.position[0]<=0)
    errors.push('WEAPON_ACTION_FRAME: reloadExtract 必须先沿模型局部+X脱开');
  for(const key of ['reloadClearance','reloadReturnClearance'])if(sockets[key]&&validSocketTransform(sockets[key])&&Math.abs(sockets[key].rotation[3])<1-1e-6)
    errors.push(`WEAPON_ACTION_FRAME: ${key} 是平移waypoint，rotation必须为单位旋转`);
  return errors;
}
export function weaponModelProjection(def:WeaponDefinition,pose:WeaponSystem['poseIntent'],yaw:number,actorRotation:Quat,
  sockets:ModelSockets,right:{id:string;socket:BoneSocket},left:{id:string;socket:BoneSocket},reloadGrip?:SocketTransform,diagnostic?:(message:string)=>void,holdAnchorNode?:number):WeaponModelProjection|null {
  const assembly=def.presentation.assembly;
  if(!assembly||!sockets.primaryGrip||!sockets.supportGrip||!sockets.muzzle)return null;
  if(assembly.holdSlot&&holdAnchorNode===undefined){diagnostic?.('WEAPON_HOLD_SLOT: 位置基准骨未唯一解析，保留 legacy');return null;}
  const invalid=weaponActionFrameDiagnostics(sockets);if(invalid.length){invalid.forEach(d=>diagnostic?.(d));return null;}
  const inverseActor=inverseRotation(actorRotation),aim:Quat=[0,-Math.sin(yaw/2),0,Math.cos(yaw/2)];
  const recoil:Quat=[0,0,Math.sin(pose.recoil.pitchDeg*Math.PI/360),Math.cos(pose.recoil.pitchDeg*Math.PI/360)];
  const worldRotation=quatMul(quatMul(aim,recoil),assembly.holdPose.rotation);
  const recoilPosition=rotateVec3(quatMul(inverseActor,aim),pose.recoil.translation);
  // The whole assembly follows the primary hand. A 0.18m drop puts long-gun
  // support sockets beyond H01's left chain during ready/locomotion blending.
  // Keep a visible phase-driven drop within the measured two-hand reach.
  const lowering=pose.action==='unequip'?pose.phase*.08:pose.action==='equip'?(1-pose.phase)*.08:0;
  const target:SocketTransform={position:(assembly.holdSlot?.position??assembly.holdPose.position).map((n,i)=>n+recoilPosition[i]!-(i===1?lowering:0)) as [number,number,number],rotation:[...quatMul(inverseActor,worldRotation)]};
  const p=def.presentation.procedural;
  const magazineRemoved=pose.action==='reload'&&pose.phase>=p.magazineOutPhase&&pose.phase<p.magazineInPhase&&assembly.reloadAttachmentId!==null;
  let dependent=sockets[pose.reload.leftHandTarget];
  if(!dependent)return null;
  dependent=structuredClone(magazineRemoved&&reloadGrip?reloadGrip:dependent);
  if(pose.action==='reload'&&sockets.reloadPose&&sockets.reloadExtract){
    if(!reloadGrip){diagnostic?.('WEAPON_ACTION_FRAME: 动作frame需要真实reload附件primaryGrip');return null;}
    const recovering=pose.phase>=p.chamberPhase;
    const weight=recovering?smooth((1-pose.phase)/Math.max(1e-8,1-p.chamberPhase)):smooth(pose.phase/Math.max(1e-8,p.magazineOutPhase));
    const base=structuredClone(target),reload=composeSocket(base,sockets.reloadPose);
    const clearance=recovering?(sockets.reloadReturnClearance??sockets.reloadClearance):sockets.reloadClearance;
    const arc=clearance?rotateVec3(base.rotation,clearance.position):[0,0,0];
    target.position=base.position.map((v,k)=>v+(reload.position[k]!-v)*weight+arc[k]!*Math.sin(Math.PI*weight)) as [number,number,number];
    target.rotation=blendRotation(base.rotation,reload.rotation,weight);
    if(recovering){
      dependent.position=dependent.position.map((v,k)=>v+(sockets.supportGrip!.position[k]!-v)*(1-weight)) as [number,number,number];
      dependent.rotation=blendRotation(dependent.rotation,sockets.supportGrip.rotation,1-weight);
    }
    if(magazineRemoved){
      const t=(pose.phase-p.magazineOutPhase)/Math.max(1e-8,p.magazineInPhase-p.magazineOutPhase),extract=sockets.reloadExtract;
      const axial=t<.2?smooth(t/.2):t>.8?smooth((1-t)/.2):1;
      const lateral=t>=.2&&t<=.8?Math.sin(Math.PI*(t-.2)/.6):0;
      dependent.position=reloadGrip.position.map((v,k)=>v+extract.position[k]!*(k===0?axial:lateral)) as [number,number,number];
      dependent.rotation=blendRotation(reloadGrip.rotation,composeSocket(reloadGrip,extract).rotation,lateral);
    }
  }else if(magazineRemoved){
    const phase=(pose.phase-p.magazineOutPhase)/Math.max(1e-8,p.magazineInPhase-p.magazineOutPhase);
    dependent.position[1]-=.12*Math.sin(Math.PI*phase);
  }
  return {magazineRemoved,request:{target,...(assembly.holdSlot?{positionAnchor:{node:holdAnchorNode!}}:{}),primary:{controlId:right.id,contact:right.socket.contact,modelSocket:sockets.primaryGrip},
    dependent:{controlId:left.id,contact:left.socket.contact,modelSocket:dependent}}};
}

/** 有效同帧模型才门控 Canvas；失败和未配置保留旧表现。 */
export interface WeaponModelView { visible:boolean; weaponId:string|null; frameStamp:number; muzzle:SocketTransform|null; diagnostics:readonly string[] }
