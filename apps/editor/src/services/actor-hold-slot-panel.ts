/** 持握槽创作UI；资产/草稿/保存职责归session，面板只路由用户输入。 */
import { eulerToQuat,quatToEuler } from '@aether/core';
import type { ActorHoldSlotSession } from './actor-hold-slot';
export class ActorHoldSlotPanel {
  private details=document.createElement('details');
  private info=document.createElement('p');private status=document.createElement('p');
  private select=document.createElement('select');private show=document.createElement('input');
  private positions:HTMLInputElement[]=[];private angles:HTMLInputElement[]=[];private quats:HTMLInputElement[]=[];
  private commands:HTMLButtonElement[]=[];private key='';private quatDraft=false;private selected='';
  constructor(host:HTMLElement,private session:ActorHoldSlotSession,ports:{calibrate():void;mode(mode:'translate'|'rotate'):void;equip(id:string):void}){
    host.id='actor-hold-slot-panel';host.style.cssText='position:absolute;top:48px;left:12px;z-index:35;width:292px;max-height:calc(100% - 110px);overflow:auto;background:#151b23ef;color:#eee;border:1px solid #617083;border-radius:5px;padding:8px;font-size:12px';
    const summary=document.createElement('summary');summary.textContent='角色武器持握槽';this.details.append(summary);host.append(this.details);
    this.info.style.cssText='overflow-wrap:anywhere;margin:8px 0';this.info.id='hold-slot-asset';this.details.append(this.info);
    const button=(id:string,label:string,run:()=>void,editable=false)=>{const b=document.createElement('button');b.id=id;b.textContent=label;b.onclick=run;b.dataset.editable=String(editable);b.style.margin='3px';this.details.append(b);this.commands.push(b);return b;};
    button('hold-slot-calibrate','暂停观察校准',()=>{this.details.open=true;session.shown=true;ports.calibrate();});
    this.select.id='hold-slot-weapon';this.select.setAttribute('aria-label','持握武器');this.select.onchange=()=>session.select(this.select.value);this.details.append(this.select);
    button('hold-slot-equip','切换选定武器',()=>ports.equip(session.selected));
    const showLabel=document.createElement('label');this.show.type='checkbox';this.show.id='hold-slot-show';this.show.onchange=()=>{session.shown=this.show.checked;session.selectedInView=false;};showLabel.append(this.show,' 显示槽位（点击原点选中）');showLabel.style.display='block';this.details.append(showLabel);
    button('hold-slot-select','选中槽位',()=>{session.shown=true;session.selectedInView=true;},true);
    button('hold-slot-move','移动',()=>{ports.mode('translate');session.selectedInView=true;},true);
    button('hold-slot-rotate','旋转',()=>{ports.mode('rotate');session.selectedInView=true;},true);
    const fields=(title:string,count:number,prefix:string,update:()=>void)=>{
      const group=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent=title;group.append(legend);group.style.cssText='padding:4px;margin:6px 0';this.details.append(group);
      return Array.from({length:count},(_,i)=>{const label=document.createElement('label');label.textContent=['X','Y','Z','W'][i]!;const input=document.createElement('input');input.type='number';input.step=prefix==='position'?'.005':'.1';input.id=`hold-slot-${prefix}-${i}`;input.style.cssText='width:66px;margin:2px';input.onchange=update;label.append(input);group.append(label);return input;});
    };
    this.positions=fields('Hip偏移（角色局部，米）',3,'position',()=>{const s=session.slot;if(s)session.edit({...s,position:this.positions.map(i=>Number(i.value)) as [number,number,number]});});
    this.angles=fields('中性模型根旋转（度）',3,'angle',()=>{const s=session.slot;if(s)session.edit({...s,rotation:[...eulerToQuat(...this.angles.map(i=>Number(i.value)*Math.PI/180) as [number,number,number])]});});
    this.quats=fields('四元数 xyzw',4,'quat',()=>{});
    const advanced=document.createElement('details'),advancedTitle=document.createElement('summary');advancedTitle.textContent='高级旋转';advanced.append(advancedTitle,this.quats[0]!.closest('fieldset')!);this.details.append(advanced);
    this.quats.forEach(i=>{i.oninput=()=>{this.quatDraft=true;};});
    advanced.append(button('hold-slot-apply-quat','应用四元数',()=>{const s=session.slot;if(s&&session.edit({...s,rotation:this.quats.map(i=>Number(i.value)) as [number,number,number,number]}))this.quatDraft=false;},true));
    button('hold-slot-undo','Undo',()=>session.history(),true);button('hold-slot-redo','Redo',()=>session.history(true),true);
    button('hold-slot-save','Save到角色资产',()=>{void session.save();});
    button('hold-slot-reload','Reload',()=>{void session.reload(session.dirty);});
    this.status.id='hold-slot-status';this.status.style.cssText='overflow-wrap:anywhere;white-space:pre-wrap';this.details.append(this.status);
    const hint=document.createElement('p');hint.textContent='只在Pause观察中拖动。切枪会短暂Resume完成原有切换；再点校准。配置按角色+武器保存，Stop不撤销已Save数据。';this.details.append(hint);
  }
  render():void {
    const state=this.session.summary(),key=JSON.stringify(state.weapons);
    if(state.selected!==this.selected){this.quatDraft=false;this.selected=state.selected;}
    if(key!==this.key){this.select.replaceChildren(...state.weapons.map(w=>{const o=document.createElement('option');o.value=w.id;o.textContent=w.name;return o;}));this.key=key;}
    this.select.value=state.selected;this.show.checked=state.shown;
    this.info.textContent=state.ready?`角色 ${state.actorGuid}\n${state.path}\n基准骨 ${state.slot?.bone??'—'}`:'进入Play并载入有效角色/双手socket后可校准';
    for(const b of this.commands){const id=b.id;b.disabled=state.busy||(b.dataset.editable==='true'&&!state.editable)||(id==='hold-slot-save'&&(!state.ready||!state.dirty))||(id==='hold-slot-reload'&&!state.ready)||(id==='hold-slot-undo'&&!state.canUndo)||(id==='hold-slot-redo'&&!state.canRedo);if(id==='hold-slot-reload')b.textContent=state.dirty?'放弃草稿并Reload':'Reload';}
    for(const inputs of [this.positions,this.angles,this.quats]){
      const value=inputs===this.positions?state.slot?.position:inputs===this.quats?state.slot?.rotation:state.slot?quatToEuler(state.slot.rotation).map(v=>v*180/Math.PI):null;
      const active=inputs.includes(document.activeElement as HTMLInputElement)||(inputs===this.quats&&this.quatDraft);
      inputs.forEach((input,i)=>{input.disabled=!state.editable;if(!active)input.value=value?String(value[i]):'';});
    }
    this.status.textContent=(state.error||`${state.dirty?'● 未保存':'已保存/载入'} · ${state.editable?'Pause观察可编辑':'请Pause并进入观察'}${state.frame?'':' · 选定武器须已持握'}\n${state.notice}`)+(state.diagnostics.length?'\n'+state.diagnostics.join('\n'):'');
    this.status.style.color=state.error?'#ffa07a':state.dirty?'#ffd166':'#9fcbaf';
  }
}
