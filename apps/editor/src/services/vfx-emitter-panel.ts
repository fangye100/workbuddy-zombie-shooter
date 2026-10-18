import type {SceneDocument,SceneNode,VfxAsset,VfxEmitterComponent} from '@aether/scene';
import type {EditResult} from '@aether/runtime';
import {listDir,readProjectFile} from '../asset-util';
import {readVfxAsset} from './vfx-assets';
/** Scene-owned emitter authoring; uses the existing scene history/CAS port. */
export class VfxEmitterPanel {
 private readonly root=document.createElement('details');private readonly form=document.createElement('fieldset');private readonly status=document.createElement('p');
 private readonly node=document.createElement('select');private readonly resource=document.createElement('select');private readonly effect=document.createElement('select');private readonly seed=document.createElement('input');private readonly playing=document.createElement('input');private readonly direction=document.createElement('input');
 private asset:VfxAsset|null=null;private loadedPath='';private generation=0;private scene='';
 constructor(host:HTMLElement,private readonly port:{document():SceneDocument|null;locked():boolean;edit(label:string,mutate:(nodes:SceneNode[])=>void,rebuild:boolean):EditResult;undo():void;redo():void;save():Promise<void>}){
  this.root.id='vfx-emitter-panel';this.root.open=true;const title=document.createElement('summary');title.textContent='作者 VFX · 持续发射器';this.root.append(title);const hint=document.createElement('p');hint.textContent='组件变换是发射锚点；方向为节点本地坐标。Play固定tick、seed确定性；停止发射后尾粒子自然到期。';this.form.append(hint);
  const field=(name:string,input:HTMLElement)=>{const label=document.createElement('label');label.textContent=name;input.setAttribute('aria-label',name);label.append(input);this.form.append(label);};
  field('发射节点',this.node);field('发射资源',this.resource);field('发射效果 key',this.effect);this.seed.type='number';this.seed.value='7';field('发射 seed',this.seed);this.playing.type='checkbox';this.playing.checked=true;field('进入Play时发射',this.playing);this.direction.value='0,1,0';field('本地方向 x,y,z',this.direction);
  const button=(name:string,action:()=>unknown)=>{const b=document.createElement('button');b.type='button';b.textContent=name;b.onclick=()=>void this.run(action);this.form.append(b);};
  button('读取发射资源',()=>this.load());this.resource.onchange=()=>void this.run(()=>this.load());this.node.onchange=()=>this.read();
  button('应用发射器',()=>this.apply(false));button('移除发射器',()=>this.apply(true));button('撤销发射器',()=>{this.port.undo();this.read();});button('重做发射器',()=>{this.port.redo();this.read();});button('保存发射场景',()=>this.port.save());
  this.status.setAttribute('role','status');this.root.append(this.form,this.status);host.append(this.root);void this.run(async()=>{for(const f of await listDir('assets/vfx'))if(f.kind==='file' && f.name.endsWith('.vfx.json'))this.resource.add(new Option(f.name,`assets/vfx/${f.name}`));this.scene='';});
 }
 private async run(action:()=>unknown){try{await action();}catch(e){this.status.textContent=String(e);}}
 private async load(){const generation=++this.generation,path=this.resource.value;this.asset=null;this.effect.replaceChildren();this.status.textContent='正在读取发射资源…';const meta=await readProjectFile(`${path}.meta.json`);if(!meta.ok)throw new Error('发射资源sidecar缺失');const asset=await readVfxAsset({path,guid:(meta.json as {guid:string}).guid});if(generation!==this.generation || path!==this.resource.value)return;this.asset=asset;this.loadedPath=path;this.effect.replaceChildren();for(const key of Object.keys(asset.effects))this.effect.add(new Option(key,key));const c=this.component();if(c?.resource.path===path)this.effect.value=c.effectKey;this.status.textContent=`已读取 ${asset.name}，保存场景后生效`;}
 private component(){return this.port.document()?.nodes.find(n=>n.id===this.node.value)?.components.find((c):c is VfxEmitterComponent=>c.kind==='VfxEmitter');}
 private read(){const c=this.component();if(c){this.resource.value=c.resource.path;this.seed.value=String(c.seed);this.playing.checked=c.playing;this.direction.value=c.direction.join(',');void this.run(()=>this.load());}this.status.textContent=c?'已读取节点发射器':'节点没有发射器，可添加';}
 private apply(remove:boolean){if(!remove && (!this.asset || this.loadedPath!==this.resource.value || !this.effect.value))throw new Error('请先读取发射资源');const direction=this.direction.value.split(',').map(Number),component:VfxEmitterComponent={kind:'VfxEmitter',enabled:true,playing:this.playing.checked,resource:{path:this.resource.value,guid:this.asset?.id??''},effectKey:this.effect.value,seed:Number(this.seed.value),direction:direction as [number,number,number]};
  const result=this.port.edit(remove?'移除VFX发射器':'应用VFX发射器',nodes=>{const node=nodes.find(n=>n.id===this.node.value);if(!node)throw new Error('发射节点不存在');node.components=node.components.filter(c=>c.kind!=='VfxEmitter');if(!remove)node.components.push(component);},false);if(!result.ok)throw new Error(result.error??'发射器编辑被拒绝');this.status.textContent='发射器已应用到场景，请保存';
 }
 frame(){this.form.disabled=this.port.locked();const doc=this.port.document();if(doc && doc.id!==this.scene){this.scene=doc.id;this.node.replaceChildren();for(const n of doc.nodes)this.node.add(new Option(`${n.name} · ${n.id}`,n.id));this.node.value=doc.nodes.find(n=>n.components.some(c=>c.kind==='VfxEmitter'))?.id??doc.playerStart??doc.nodes[0]!.id;this.read();}}
}
