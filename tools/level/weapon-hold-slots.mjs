/** 离线作者基准投影：slot来自prototype或scene override，不读取GPU，也不覆盖作者值。 */
export function holdSlotBasePosition(assembly,reference) {
  if(!assembly.holdSlot)return [...assembly.holdPose.position];
  if(!reference||assembly.holdSlot.bone!==reference.bone)throw new Error('holdSlot 缺少匹配骨名的规整化作者参考');
  return reference.position.map((v,i)=>v+assembly.holdSlot.position[i]);
}
export function preserveSceneHoldSlots(doc,previous) {
  const rules=d=>d?.nodes?.flatMap(n=>n.components).find(c=>c.kind==='RunRules');
  const old=rules(previous)?.arsenal?.definitions??[];
  for(const weapon of rules(doc)?.arsenal?.definitions??[]){
    const prior=old.find(w=>w.id===weapon.id),slot=prior?.presentation?.assembly?.holdSlot;
    if(slot&&weapon.presentation.assembly){weapon.presentation.assembly.holdSlot=structuredClone(slot);weapon.presentation.markers=structuredClone(prior.presentation.markers);}
  }
}
