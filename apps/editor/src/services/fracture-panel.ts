import { migrateFractureAsset, validateFractureAsset, validDestructible, type FractureAsset, type SceneDocument, type SceneNode, type DestructibleComponent } from '@aether/scene';
import { admitFractureProfile, type EditResult } from '@aether/runtime';
import { createEditorFractureIO } from './fracture-io';
import { listDir, readProjectFile } from '../asset-util';
import { AuthorResourceDocument } from './author-resource-document';
import { FracturePreview } from './fracture-preview';
import { fractureAuthorDraft } from './fracture-author-draft';
import { renamedResourcePath } from './resource-rename';

interface NodeDraft { baseline:string; initial:string; value:DestructibleComponent; dirty:boolean; }
interface AssetDraft { document:AuthorResourceDocument<FractureAsset>; text:string; }
/** 原Inspector的聚焦组件/资产表单。Document、历史和文件事务均委派原owner。 */
export class FracturePanel {
  private readonly root=document.createElement('details');
  private readonly form=document.createElement('fieldset');
  private readonly node=document.createElement('select');
  private readonly resource=document.createElement('select');
  private readonly path=document.createElement('input');
  private readonly guid=document.createElement('input');
  private readonly enabled=document.createElement('input');
  private readonly durability=document.createElement('input');
  private readonly direct=document.createElement('input');private readonly explosion=document.createElement('input');private readonly burn=document.createElement('input');
  private readonly collider=document.createElement('select');private readonly navigation=document.createElement('select');
  private readonly json=document.createElement('textarea');
  private readonly status=document.createElement('p');private readonly stats=document.createElement('pre');
  private readonly drafts=new Map<string,NodeDraft>();private readonly assets=new Map<string,AssetDraft>();
  private selected='';private lastExternal:string|null=null;private sceneKey='';private nodesKey='';private asset:AssetDraft|null=null;private openId=0;private resourceLoading=false;private applyingNode=0;private applySequence=0;private actionSequence=0;private contextRevision=0;private lastLocked=false;
  private readonly chunk=document.createElement('select');private readonly chunkClass=document.createElement('select');
  private readonly numeric=new Map<string,HTMLInputElement>();
  constructor(host:HTMLElement,readonly preview:FracturePreview,private readonly port:{
    document():SceneDocument|null;scenePath():string;selected():string|null;locked():boolean;
    edit(label:string,mutate:(nodes:SceneNode[])=>void,rebuild:boolean):EditResult;
    undo():void;redo():void;save():Promise<void>;focus(bounds:{center:[number,number,number];radius:number}):void;
  }){
    this.root.id='fracture-panel';this.root.open=true;this.form.style.minWidth='0';this.root.style.minWidth='0';
    this.json.style.cssText='box-sizing:border-box;width:100%;max-width:100%;font:11px monospace';
    this.stats.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font-size:11px';
    const title=document.createElement('summary');title.textContent='碎裂 · 组件、资产与真实预览';this.root.append(title);
    const field=(name:string,input:HTMLElement)=>{const row=document.createElement('label');row.textContent=name;input.setAttribute('aria-label',name);row.append(input);this.form.append(row);};
    field('碎裂作者节点',this.node);this.node.onchange=()=>this.select(this.node.value);
    field('碎裂 Profile',this.resource);field('碎裂资源路径',this.path);field('碎裂资源 GUID',this.guid);this.guid.readOnly=true;
    this.resource.onchange=()=>{this.path.value=this.resource.value;void this.run(()=>this.open(this.resource.value));};
    this.path.oninput=()=>this.capture();
    this.button('打开碎裂资源',()=>this.open(this.path.value));
    this.enabled.type='checkbox';field('启用碎裂配置',this.enabled);
    this.durability.type='number';this.durability.step='any';field('初始耐久',this.durability);
    for(const [label,input]of [['允许直接命中',this.direct],['允许爆炸',this.explosion],['允许燃烧',this.burn]]as const){input.type='checkbox';field(label,input);}
    for(const value of ['remove','keep'])this.collider.add(new Option(value,value));field('破坏后碰撞',this.collider);
    for(const value of ['clear-blocking','keep'])this.navigation.add(new Option(value,value));field('破坏后导航',this.navigation);
    for(const input of [this.enabled,this.durability,this.direct,this.explosion,this.burn,this.collider,this.navigation])input.oninput=()=>this.capture();
    this.button('应用碎裂配置',()=>this.applyNode());this.button('移除碎裂配置',()=>this.removeNode());
    this.button('放弃碎裂配置草稿',()=>{this.drafts.delete(this.key());this.fields();});
    this.button('撤销碎裂场景修改',()=>{this.preview.stop();this.port.undo();this.fields();});
    this.button('重做碎裂场景修改',()=>{this.preview.stop();this.port.redo();this.fields();});this.button('保存碎裂场景',()=>this.port.save());
    const hint=document.createElement('p');hint.textContent='组件由场景历史管理；共享配方由资产历史管理。切换节点保留各自草稿。预览可读未保存的合法配方，仍重新检查磁盘身份与隔离。';this.form.append(hint);
    for(const [key,label]of [['priority','碎裂优先级'],['lifetimeSec','碎裂寿命 s'],['fadeSec','碎裂淡出 s']]){
      const input=document.createElement('input');input.type='number';input.step='any';this.numeric.set(key!,input);field(label!,input);
      input.oninput=()=>this.changeAsset(a=>{(a.playback as unknown as Record<string,unknown>)[key!]=input.value.trim()?Number(input.value):NaN;});
    }
    field('稳定碎块 ID',this.chunk);this.chunk.onchange=()=>this.assetFields();
    for(const value of ['large','small'])this.chunkClass.add(new Option(value,value));field('碎块物理分类',this.chunkClass);
    this.chunkClass.onchange=()=>this.changeAsset(a=>{a.chunks.find(c=>c.chunkId===this.chunk.value)!.class=this.chunkClass.value as 'large'|'small';});
    for(const [key,label]of [['mass','碎块质量 kg'],['friction','碎块摩擦'],['restitution','碎块恢复系数'],['maxLinearSpeed','线速度上限'],['maxAngularSpeed','角速度上限']]){
      const input=document.createElement('input');input.type='number';input.step='any';this.numeric.set(key!,input);field(label!,input);
      input.oninput=()=>this.changeAsset(a=>{const p=a.chunks.find(c=>c.chunkId===this.chunk.value)!.proxy as unknown as Record<string,unknown>;if(input.value.trim())p[key!]=Number(input.value);else delete p[key!];});
    }
    const recipeHint=document.createElement('p');recipeHint.textContent='可编辑名称、优先级、寿命/淡出、碎块分类和质量/摩擦/恢复/速度限制；离线来源、坐标、形状及资产身份只读。';this.form.append(recipeHint);
    this.json.rows=12;field('碎裂资产参数 JSON',this.json);this.json.oninput=()=>{if(this.asset)this.asset.text=this.json.value;};
    this.button('应用碎裂资产参数',()=>{const a=this.requireAsset();a.document.apply(this.readDraft());this.stop();a.text=JSON.stringify(a.document.value,null,2);this.assetFields();this.status.textContent='配方已应用，可撤销；磁盘尚未保存';});
    this.button('撤销碎裂资产参数',()=>{const a=this.requireAsset();a.document.undo();this.stop();a.text=JSON.stringify(a.document.value,null,2);this.assetFields();});
    this.button('重做碎裂资产参数',()=>{const a=this.requireAsset();a.document.redo();this.stop();a.text=JSON.stringify(a.document.value,null,2);this.assetFields();});
    this.button('保存碎裂资产',async()=>{const a=this.requireAsset();if(a.text!==JSON.stringify(a.document.value,null,2))throw new Error('请先应用资产草稿，保存不会丢弃输入');const revision=this.contextRevision,request=this.actionSequence,message=await a.document.save();if(revision===this.contextRevision&&request===this.actionSequence&&this.asset===a)this.status.textContent=message;});
    this.button('从磁盘重载碎裂资产',async()=>{const a=this.requireAsset(),revision=this.contextRevision,request=this.actionSequence,before=a.text;await a.document.reload();const changed=a.text!==before;if(!changed)a.text=JSON.stringify(a.document.value,null,2);if(revision===this.contextRevision&&request===this.actionSequence&&this.asset===a){this.assetFields();this.preview.stop();this.status.textContent=changed?'已重载磁盘；读取期间的新表单草稿仍保留':'已明确放弃本资产草稿并重载当前磁盘';}});
    this.button('开始/重播碎裂预览',()=>this.startPreview());this.button('触发碎裂预览',()=>this.preview.trigger());
    this.button('聚焦碎裂预览',()=>{const bounds=this.preview.bounds();if(bounds)this.port.focus(bounds);});
    this.button('碎裂预览暂停/继续',()=>{this.preview.paused=!this.preview.paused;});this.button('碎裂预览单步',()=>this.preview.step());this.button('停止碎裂预览',()=>this.preview.stop());
    this.status.setAttribute('role','status');this.root.append(this.form,this.status,this.stats);host.append(this.root);
    this.root.ontoggle=()=>{if(!this.root.open)this.stop();};
    void this.run(async()=>{const queue=['assets/fracture'];while(queue.length){const dir=queue.shift()!;for(const e of await listDir(dir)){const path=dir+'/'+e.name;if(e.kind==='dir')queue.push(path);else if(e.name.endsWith('.fracture.json'))this.resource.add(new Option(path,path));}}});
  }
  private button(label:string,action:()=>unknown){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>void this.run(action);this.form.append(b);}
  private async run(action:()=>unknown){const revision=this.contextRevision,request=++this.actionSequence;try{await action();}catch(error){if(revision===this.contextRevision&&request===this.actionSequence)this.status.textContent=String(error);}}
  private key(){return this.sceneKey+'#'+this.selected;}
  private select(id:string){if(id===this.selected)return;this.stop();this.selected=id;this.node.value=id;this.fields();}
  private getDraft():NodeDraft|null{
    const node=this.port.document()?.nodes.find(n=>n.id===this.selected);if(!node)return null;
    let draft=this.drafts.get(this.key());
    if(!draft || !draft.dirty && draft.baseline!==JSON.stringify(node)){
      const c=node.components.find(c=>c.kind==='Destructible');const spawn=node.components.find(c=>c.kind==='SpawnPoint');
      const ref=c?.kind==='Destructible'?c.profile:spawn?.kind==='SpawnPoint'?spawn.deathFracture?.profile:null;
      draft={baseline:JSON.stringify(node),initial:'',dirty:false,value:c?.kind==='Destructible'?structuredClone(c):{kind:'Destructible',enabled:!!ref,profile:ref?{...ref}:{path:'',guid:''},maxDurability:100,trigger:{direct:true,explosion:true,burn:false},onBroken:{collider:'remove',navigation:'clear-blocking'}}};draft.initial=JSON.stringify(draft.value);this.drafts.set(this.key(),draft);
    }return draft;
  }
  private capture(){const d=this.getDraft();if(!d)return;d.value={kind:'Destructible',enabled:this.enabled.checked,profile:{path:this.path.value,guid:this.guid.value},maxDurability:this.durability.value.trim()?Number(this.durability.value):NaN,trigger:{direct:this.direct.checked,explosion:this.explosion.checked,burn:this.burn.checked},onBroken:{collider:this.collider.value as 'remove'|'keep',navigation:this.navigation.value as 'clear-blocking'|'keep'}};d.dirty=JSON.stringify(d.value)!==d.initial;}
  private fields(){const d=this.getDraft();if(!d)return;const v=d.value;this.node.value=this.selected;this.enabled.checked=v.enabled;this.durability.value=String(v.maxDurability);this.direct.checked=v.trigger.direct;this.explosion.checked=v.trigger.explosion;this.burn.checked=v.trigger.burn;this.collider.value=v.onBroken.collider;this.navigation.value=v.onBroken.navigation;
    if(v.profile.path){this.path.value=v.profile.path;this.guid.value=v.profile.guid;}else{this.path.value='';this.guid.value='';}
    const spawn=this.port.document()?.nodes.find(n=>n.id===this.selected)?.components.some(c=>c.kind==='SpawnPoint');for(const input of [this.durability,this.direct,this.explosion,this.burn,this.collider,this.navigation])input.disabled=!!spawn;
  }
  private async open(path:string,refreshClean=false):Promise<boolean>{
    const id=++this.openId;this.preview.stop();this.resourceLoading=true;this.status.textContent='正在读取碎裂配方，已有草稿保留';try{
    const r=await readProjectFile(path);if(id!==this.openId)return false;if(!r.ok)throw new Error(r.error??'资源读取失败');
    const value=migrateFractureAsset(r.json),meta=await readProjectFile(path+'.meta.json');if(id!==this.openId)return false;
    if(!meta.ok || (meta.json as {guid:string;kind:string}).guid!==value.id || (meta.json as {kind:string}).kind!=='fracture')throw new Error('碎裂 sidecar GUID/kind不匹配');
    if(refreshClean){if(this.hasDraft){this.status.textContent='改名重读期间产生了新草稿，已保留；请处理冲突后明确重载';return false;}this.assets.clear();}
    let a=this.assets.get(path);if(!a){const document=new AuthorResourceDocument(path,value,{label:'碎裂',validate:validateFractureAsset,migrate:migrateFractureAsset});a={document,text:JSON.stringify(document.value,null,2)};this.assets.set(path,a);}
    this.asset=a;this.path.value=path;this.guid.value=value.id;this.resource.value=path;this.capture();this.assetFields();this.status.textContent='已打开正式碎裂资产；引用和参数仍需分别 Apply';
    return true;
    }finally{if(id===this.openId)this.resourceLoading=false;}
  }
  private requireAsset(){if(!this.asset)throw new Error('请先打开碎裂资源');return this.asset;}
  private readDraft():FractureAsset{const a=this.requireAsset();return fractureAuthorDraft(JSON.parse(a.text),a.document.value);}
  private changeAsset(mutate:(a:FractureAsset)=>void){try{const a=this.requireAsset(),next=JSON.parse(a.text) as FractureAsset;mutate(next);a.text=JSON.stringify(next,null,2);this.json.value=a.text;}catch(e){this.status.textContent=String(e);}}
  private assetFields(){if(!this.asset)return;this.json.value=this.asset.text;const value=JSON.parse(this.asset.text) as FractureAsset;const keep=this.chunk.value;this.chunk.replaceChildren(...value.chunks.map(c=>new Option(c.chunkId,c.chunkId)));if(value.chunks.some(c=>c.chunkId===keep))this.chunk.value=keep;
    const chunk=value.chunks.find(c=>c.chunkId===this.chunk.value);this.chunkClass.value=chunk?.class??'small';for(const [key,input]of this.numeric){const v=(['priority','lifetimeSec','fadeSec'].includes(key)?value.playback:chunk?.proxy) as unknown as Record<string,unknown>|undefined;input.value=v?.[key]===undefined?'':String(v[key]);}}
  private async applyNode(){
    if(this.applyingNode)throw new Error('配置校验进行中');
    this.capture();const d=this.getDraft();if(!d)return;
    const asset=this.readDraft(),doc=this.port.document()!,node=doc.nodes.find(n=>n.id===this.selected)!;
    const key=this.key(),openId=this.openId,revision=this.contextRevision,raw=this.requireAsset().text;
    const value=structuredClone(d.value),version=JSON.stringify(d.value),nodeVersion=JSON.stringify(node);
    if(nodeVersion!==d.baseline)throw new Error('节点已被其他编辑修改；草稿已保留，请明确放弃后重载');
    const spawn=node.components.find(c=>c.kind==='SpawnPoint');
    if(asset.kind==='npc'?(spawn?.kind!=='SpawnPoint'||spawn.characterId!==asset.npc?.actorId):!!spawn)throw new Error('profile类型或actorId与选中节点不匹配');
    if(asset.kind==='object'){const mesh=node.components.find(c=>c.kind==='MeshRenderer');if(mesh?.kind!=='MeshRenderer'||mesh.source.type!=='asset'||mesh.source.ref.guid!==asset.source.model.guid)throw new Error('选中物体的源模型GUID与碎裂配方不匹配；草稿已保留');}
    if(value.profile.guid!==asset.id||value.profile.path!==this.requireAsset().document.path)throw new Error('引用与打开资产不一致');
    const request=++this.applySequence;this.applyingNode=request;
    try{
      const admission=await admitFractureProfile(value.profile,createEditorFractureIO(),asset);
      if(revision!==this.contextRevision||key!==this.key()||openId!==this.openId)return;
      if(!admission.ok)throw new Error(admission.failure.stage+'：'+admission.failure.detail);
      if(admission.profile.kind!==asset.kind)throw new Error('当前资源类型已变化，草稿保留');
      const current=this.port.document()?.nodes.find(n=>n.id===node.id);
      if(JSON.stringify(current)!==nodeVersion||JSON.stringify(d.value)!==version||this.requireAsset().text!==raw)throw new Error('校验期间出现新的节点/草稿修改，请重新Apply；输入已保留');
      const result=this.port.edit('应用碎裂配置',nodes=>{const n=nodes.find(n=>n.id===node.id)!;if(spawn){const c=n.components.find(c=>c.kind==='SpawnPoint')!;if(c.kind==='SpawnPoint')c.deathFracture=value.enabled?{profile:value.profile}:null;}else{n.components=n.components.filter(c=>c.kind!=='Destructible');n.components.push(value);}},false);
      if(!result.ok)throw new Error(result.error??'配置被拒绝');
      this.preview.stop();this.drafts.delete(key);this.fields();this.status.textContent='碎裂配置已应用到场景，可Undo/Redo，请保存';
    }finally{if(this.applyingNode===request)this.applyingNode=0;}
  }
  private removeNode(){const id=this.selected;const r=this.port.edit('移除碎裂配置',nodes=>{const n=nodes.find(n=>n.id===id)!;n.components=n.components.filter(c=>c.kind!=='Destructible');for(const c of n.components)if(c.kind==='SpawnPoint')c.deathFracture=null;},false);if(!r.ok)throw new Error(r.error??'移除被拒绝');this.drafts.delete(this.key());this.preview.stop();this.fields();}
  private async startPreview(){if(this.port.locked())throw new Error('请先停止Play');const doc=this.port.document();if(!doc)throw new Error('没有作者场景');const nodeDraft=this.getDraft();if(nodeDraft?.dirty&&!validDestructible(nodeDraft.value))throw new Error('选中节点的碎裂草稿非法，请检查引用与初始耐久；输入已保留');const draft=this.readDraft(),ref={path:this.requireAsset().document.path,guid:draft.id};if(this.path.value!==ref.path||this.guid.value!==ref.guid)throw new Error('请先打开当前选择的资源，再预览');this.openId++;this.resourceLoading=false;this.applyingNode=0;await this.preview.start(structuredClone(doc),this.selected,ref,draft,7);const bounds=this.preview.bounds();if(bounds)this.port.focus(bounds);}
  get hasDraft(){return [...this.drafts.values()].some(d=>d.dirty)||[...this.assets.values()].some(a=>a.document.dirty||a.text!==JSON.stringify(a.document.value,null,2));}
  get hasSceneDraft(){return [...this.drafts.values()].some(d=>d.dirty);}
  frame(dt:number){const doc=this.port.document(),key=this.port.scenePath();if(key!==this.sceneKey){this.stop();this.sceneKey=key;this.selected='';this.nodesKey='';}
    const nodesKey=JSON.stringify(doc?.nodes.map(n=>[n.id,n.name]));if(nodesKey!==this.nodesKey){this.nodesKey=nodesKey;this.node.replaceChildren(...(doc?.nodes??[]).map(n=>new Option(n.name+' · '+n.id,n.id)));if(!doc?.nodes.some(n=>n.id===this.selected)){this.selected=doc?.nodes[0]?.id??'';this.fields();}}
    const selected=this.port.selected();if(selected && selected!==this.lastExternal && selected!==this.selected)this.select(selected);this.lastExternal=selected;
    const locked=this.port.locked();if(locked&&!this.lastLocked)this.stop();this.lastLocked=locked;this.form.disabled=locked;this.preview.update(dt);
    const p=this.preview.snapshot();this.stats.textContent=`${p.ready?'预览已就绪':'预览已停止'} · ${p.paused?'暂停':'播放'} · tick ${p.tick}\n活动碎块 ${p.active}${p.diagnostic?'\n'+p.diagnostic:''}`;
  }
  stop(){this.openId++;this.resourceLoading=false;this.applyingNode=0;this.contextRevision++;this.preview.stop();}
  openAsset(path:string){this.root.open=true;void this.run(()=>this.open(path));this.root.scrollIntoView({block:'nearest'});}
  async renamed(rename:import('../asset-util').RenameProjectResult){
    this.stop();if(this.hasDraft){this.status.textContent='改名期间产生了本地修改，草稿已保留；请处理冲突后明确重载';return;}
    const active=this.asset?.document.path;
    if(active&&!await this.open(renamedResourcePath(active,rename),true))return;
    this.drafts.clear();this.fields();
  }
  snapshot(){return {locked:this.port.locked(),resourceLoading:this.resourceLoading,applyingNode:this.applyingNode!==0,openId:this.openId,nodeId:this.selected,path:this.asset?.document.path??null,hasDraft:this.hasDraft,sceneDirty:this.hasSceneDraft,assetDirty:this.asset?.document.dirty??false,preview:this.preview.snapshot(),diagnostic:this.status.textContent};}
}
