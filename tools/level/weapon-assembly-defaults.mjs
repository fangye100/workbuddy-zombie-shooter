/** 显式生成时的玩家外观适配；已有 MeshRenderer 原样保留。 */
export function prepareWeaponAssemblyPlayer(doc,calibration,actorMeta,hasPreviousMesh){
 const player=doc.nodes.find(n=>n.id===doc.playerStart);
 const mesh=player?.components.find(c=>c.kind==='MeshRenderer');
 if(!mesh)throw new Error('生成数据缺少玩家 MeshRenderer');
 if(!hasPreviousMesh){
  if(actorMeta.guid!==calibration.character.asset.guid||!actorMeta.bodyIk||!actorMeta.sharedMotion)throw new Error('生成数据缺少有效角色 GUID/BodyIK/SharedMotion');
  mesh.source={type:'asset',ref:structuredClone(calibration.character.asset)};
  mesh.sharedMotion=structuredClone(actorMeta.sharedMotion);
  mesh.bodyIk=structuredClone(actorMeta.bodyIk);
  for(const c of mesh.bodyIk.controls)if(c.part==='rightHand'||c.part==='leftHand'){c.enabled=true;c.weight=1;}
  mesh.playBinding='player';
 }
 const rules=doc.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules');
 if(!rules?.arsenal)throw new Error('生成数据缺少武器库');
 const {zeroRecoilActorMuzzle,capsuleHalfM}=calibration.simulationCalibration;
 for(const w of rules.arsenal.definitions){
  const muzzle=zeroRecoilActorMuzzle[w.id];if(!muzzle||!w.presentation.assembly)continue;
  const slot=w.presentation.assembly.holdSlot,base=calibration.holdSlots?.[w.id];
  if(slot&&(!base||slot.bone!==base.bone))throw new Error('holdSlot缺少匹配的作者校准基准');
  const delta=slot?slot.position.map((v,i)=>v-base.position[i]):[0,0,0];
  w.presentation.markers.muzzle.position=[muzzle[0]+delta[2],muzzle[1]+delta[1]+player.transform.position[1]-capsuleHalfM,muzzle[2]-delta[0]];
 }
}
