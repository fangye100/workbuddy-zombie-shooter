/** 角色持握资产创作会话。与场景作者历史、Play快照和动作时钟独立。 */
import { sceneFingerprint } from '@aether/runtime';
import { validActorHoldSlot, validateAssetMeta, type ActorHoldProfiles, type ActorHoldSlot, type AssetMeta, type SocketTransform } from '@aether/scene';
import { quatMul } from '@aether/core';
import { inverseRotation, rotateVec3 } from '@aether/render';
import type { HoldContext } from './runtime-weapons';
import type { ProjectFileResult, WriteResult } from '../asset-util';

export interface HoldSlotPorts {
  context():HoldContext|null; editable():boolean;
  read(path:string):Promise<ProjectFileResult>;
  write(path:string,patch:{holdProfiles:ActorHoldProfiles},baseHash:string):Promise<WriteResult>;
  preview(actorGuid:string,profiles:ActorHoldProfiles):void;
  invalidate(path:string):void;
}
/** 从同一冻结姿态的世界手柄变换反求actor-offset；不读取GPU或更改骨长。 */
export function slotFromWorld(slot:ActorHoldSlot,before:SocketTransform,after:SocketTransform,frame:NonNullable<HoldContext['frame']>):ActorHoldSlot {
  const d=rotateVec3(inverseRotation(frame.actorRotation),after.position.map((v,i)=>v-before.position[i]!) as [number,number,number]);
  return {...slot,position:slot.position.map((v,i)=>v+d[i]!/frame.scale) as ActorHoldSlot['position'],
    rotation:[...quatMul(quatMul(slot.rotation,inverseRotation(before.rotation)),after.rotation)]};
}
export class ActorHoldSlotSession {
  private meta:AssetMeta|null=null;
  private path='';private hash='';private loadedGuid='';private generation=0;private runtimeGeneration=-1;
  private profiles:ActorHoldProfiles={};private accepted:ActorHoldProfiles={};
  private past:ActorHoldProfiles[]=[];private future:ActorHoldProfiles[]=[];
  selected='';shown=false;selectedInView=false;busy=false;error='';notice='';
  private dragStart:ActorHoldProfiles|null=null;
  constructor(private readonly ports:HoldSlotPorts){}
  get dirty():boolean{return JSON.stringify(this.profiles)!==JSON.stringify(this.accepted);}
  get ready():boolean{return !!this.meta&&this.ports.context()?.actor.guid===this.loadedGuid;}
  get editable():boolean{return this.ready&&this.ports.editable()&&!this.busy;}
  get identity():string{return this.ready?`${this.loadedGuid}/${this.selected}`:'';}
  get slot():ActorHoldSlot|null {
    const w=this.ports.context()?.weapons.find(w=>w.id===this.selected);if(!w||!this.ready)return null;
    return structuredClone(this.profiles[w.model.guid!]?.slot??w.slot);
  }
  get frame():HoldContext['frame'] {const f=this.ports.context()?.frame;return this.editable&&f?.weaponId===this.selected?f:null;}
  summary(){const c=this.ports.context();return {actorGuid:this.loadedGuid,path:this.path,selected:this.selected,shown:this.shown,selectedInView:this.selectedInView,ready:this.ready,editable:this.editable,dirty:this.dirty,busy:this.busy,error:this.error,notice:this.notice,canUndo:this.past.length>0,canRedo:this.future.length>0,slot:this.slot,profiles:structuredClone(this.profiles),diagnostics:c?.diagnostics??[],weapons:c?.weapons.map(w=>({id:w.id,name:w.name,guid:w.model.guid}))??[],frame:this.frame};}
  /** 新runtime只重新投影当前资产草稿，Stop不回滚已经保存的meta。 */
  async hydrate():Promise<void> {
    const c=this.ports.context();if(!c||c.pending||!c.weapons.length||this.busy)return;
    if(c.actor.guid===this.loadedGuid&&this.meta){
      if(c.generation!==this.runtimeGeneration&&!this.dirty){await this.load(false);return;}
      this.runtimeGeneration=c.generation;if(JSON.stringify(c.profiles??{})!==JSON.stringify(this.profiles))this.preview();return;
    }
    if(this.dirty){this.error='请先保存或放弃当前角色草稿，再切换角色';return;}
    await this.load(false);
  }
  async reload(discard=false):Promise<void> {if(this.dirty&&!discard){this.error='草稿未保存；使用“放弃草稿并重载”';return;}await this.load(true);}
  private async load(resetHistory:boolean):Promise<void> {
    const c=this.ports.context();if(!c?.actor.guid||this.busy)return;
    this.busy=true;const generation=++this.generation,path=`${c.actor.path}.meta.json`;
    try {
      const r=await this.ports.read(path);if(!r.ok)throw new Error(r.error??`HTTP ${r.status}`);
      if(generation!==this.generation||this.ports.context()?.actor.guid!==c.actor.guid)return;
      const m=r.json as AssetMeta,errors=validateAssetMeta(m).filter(d=>d.severity==='error');
      if(errors.length||m.guid!==c.actor.guid)throw new Error(`角色元数据无效：${errors.map(d=>d.code).join(',')||'GUID不匹配'}`);
      const changed=this.loadedGuid!==m.guid;
      this.meta=structuredClone(m);this.loadedGuid=m.guid;this.path=path;this.hash=sceneFingerprint(m);
      this.runtimeGeneration=c.generation;
      this.profiles=structuredClone(m.holdProfiles??{});this.accepted=structuredClone(this.profiles);
      if(changed||resetHistory){this.past=[];this.future=[];this.dragStart=null;}
      if(!c.weapons.some(w=>w.id===this.selected))this.selected=c.weapons.find(w=>w.id===c.activeWeaponId)?.id??c.weapons[0]!.id;
      this.error='';this.notice='已从角色资产读取';this.preview();
    }catch(e){this.error=String(e);}finally{if(generation===this.generation)this.busy=false;}
  }
  select(id:string):void {if(this.ports.context()?.weapons.some(w=>w.id===id)){this.selected=id;this.selectedInView=false;}}
  private preview():void {if(this.ports.context()?.actor.guid===this.loadedGuid)this.ports.preview(this.loadedGuid,structuredClone(this.profiles));}
  edit(slot:ActorHoldSlot,history=true):boolean {
    const w=this.ports.context()?.weapons.find(w=>w.id===this.selected);
    if(!this.editable||!w||!validActorHoldSlot(slot)){this.error='暂停观察下才能编辑；骨名/位置/单位四元数必须有效';return false;}
    if(JSON.stringify(slot)===JSON.stringify(this.slot))return true;
    const previous=structuredClone(this.profiles);this.profiles[w.model.guid!]={model:structuredClone(w.model),slot:structuredClone(slot)};
    try {this.preview();}catch(e){this.profiles=previous;this.error=String(e);return false;}
    if(history){this.past.push(previous);this.future=[];}this.error='';this.notice='草稿已预览，尚未保存';return true;
  }
  beginDrag():void {if(this.editable)this.dragStart=structuredClone(this.profiles);}
  endDrag(cancel=false):void {
    if(!this.dragStart)return;
    if(cancel){this.profiles=this.dragStart;this.preview();}
    else if(JSON.stringify(this.profiles)!==JSON.stringify(this.dragStart)){this.past.push(this.dragStart);this.future=[];}
    this.dragStart=null;
  }
  history(redo=false):void {
    if(!this.editable||this.dragStart)return;const from=redo?this.future:this.past,to=redo?this.past:this.future,p=from.pop();if(!p)return;
    const previous=this.profiles;this.profiles=p;
    try {this.preview();to.push(previous);this.error='';}catch(e){this.profiles=previous;from.push(p);this.error=String(e);}
  }
  async save():Promise<void> {
    if(!this.ready||!this.meta||this.busy||this.dragStart)return;
    this.busy=true;const patch={holdProfiles:structuredClone(this.profiles)};
    try {
      const errors=validateAssetMeta({...this.meta,...patch}).filter(d=>d.severity==='error');if(errors.length)throw new Error(errors.map(d=>d.code).join(','));
      const r=await this.ports.write(this.path,patch,this.hash);if(!r.ok)throw new Error(r.conflict?'磁盘版本冲突；草稿已保留，请重载后重新校准':r.error??`HTTP ${r.status}`);
      this.meta={...this.meta,...patch};this.hash=r.hash??sceneFingerprint(this.meta);this.accepted=structuredClone(patch.holdProfiles);
      this.ports.invalidate(this.ports.context()!.actor.path);this.error='';this.notice='已保存到角色资产；跨场景和下次Play生效';
    }catch(e){this.error=String(e);}finally{this.busy=false;}
  }
}
