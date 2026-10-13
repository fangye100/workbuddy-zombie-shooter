/** 武器相对位置草稿表单；Apply/history/save 仍由 SceneAuthorPanel 负责。 */
import type { WeaponDefinition } from '@aether/scene';
import { weaponMarkerTranslationForActorOffset } from '@aether/zombie-game/presentation/weapon-model';

/** 原子地移动同一武器slot及独立模拟/legacy markers，不修改尺寸或实际模型socket。 */
export function setWeaponHoldSlotAxis(weapon:WeaponDefinition,axis:0|1|2,value:number):void {
  const slot=weapon.presentation.assembly?.holdSlot;if(!slot)throw new Error('未配置持握位置slot');
  if(!Number.isFinite(value)){slot.position[axis]=value;return;}
  const delta:[number,number,number]=[0,0,0];delta[axis]=value-slot.position[axis];
  const markerDelta=weaponMarkerTranslationForActorOffset(delta);
  slot.position[axis]=value;
  for(const marker of Object.values(weapon.presentation.markers))marker.position=marker.position.map((v,i)=>v+markerDelta[i]!) as [number,number,number];
}

export function appendWeaponHoldSlotFields(parent:HTMLElement,weapons:WeaponDefinition[],dirty:()=>void):void {
  const section=document.createElement('details');section.open=true;
  const summary=document.createElement('summary');summary.textContent='每件武器 · Hip 持握位置';section.append(summary);
  const hint=document.createElement('p');hint.textContent='角色局部米：X 左右，Y 上下，+Z 向前。基准只跟本帧 Hip 平移；武器与两手一起移动。应用后可撤销并保存。';section.append(hint);
  for(const weapon of weapons){
    const slot=weapon.presentation.assembly?.holdSlot;
    const group=document.createElement('fieldset'),title=document.createElement('legend');title.textContent=`${weapon.name} · ${weapon.id}`;group.append(title);
    const bone=document.createElement('p');bone.textContent=slot?`位置基准骨：${slot.bone}`:'未配置相对位置slot，继续使用旧 holdPose.position';group.append(bone);
    if(slot)for(const axis of [0,1,2] as const){
      const label=document.createElement('label');label.textContent=`${['X 左右','Y 上下','Z 向前'][axis]} (m)`;
      const input=document.createElement('input');input.type='number';input.step='.01';input.min='-100';input.max='100';input.value=String(slot.position[axis]);
      const path=`RunRules.arsenal.${weapon.id}.holdSlot.position.${axis}`;input.setAttribute('aria-label',path);input.dataset.authorField=path;
      let lastFinite=slot.position[axis];
      input.oninput=()=>{const value=input.value.trim()?Number(input.value):NaN;if(!Number.isFinite(slot.position[axis]))slot.position[axis]=lastFinite;setWeaponHoldSlotAxis(weapon,axis,value);if(Number.isFinite(value))lastFinite=value;dirty();};label.append(input);group.append(label);
    }
    section.append(group);
  }
  parent.append(section);
}
