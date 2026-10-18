import type {SceneDocument,SceneNode,VfxAsset,VfxBindingsComponent} from '@aether/scene';
import {resolveVfxBindings} from '@aether/scene';
import type {EditResult} from '@aether/runtime';
import {CONTINUOUS_VFX_SLOTS} from '@aether/zombie-game/presentation/continuous-vfx-planner';
import {ENEMY_VFX_SLOTS} from '@aether/zombie-game/presentation/enemy-vfx-planner';
import {listDir,readProjectFile} from '../asset-util';
import {readVfxAsset} from './vfx-assets';

/** Generic scene component editing; labels are host game metadata, storage tags remain opaque. */
export class VfxBindingPanel {
 private readonly root=document.createElement('details');private readonly form=document.createElement('fieldset');private readonly status=document.createElement('p');
 private readonly tag=document.createElement('input');private readonly resource=document.createElement('select');private readonly effect=document.createElement('select');private readonly current=document.createElement('pre');
 private asset:VfxAsset|null=null;private assetPath='';private loadId=0;private key='';
 constructor(host:HTMLElement,private readonly port:{document():SceneDocument|null;locked():boolean;edit(label:string,mutate:(nodes:SceneNode[])=>void,rebuild:boolean):EditResult;undo():void;redo():void;save():Promise<void>}){
  this.root.id='vfx-binding-panel';this.root.open=true;const summary=document.createElement('summary');summary.textContent='场景 VFX · 通用标签绑定';this.root.append(summary);
  const hint=document.createElement('p');hint.textContent='半径与危险结束跟随模拟。资源时长只控制动画周期或装饰尾部；绑定不改变伤害。';this.form.append(hint);
  const field=(text:string,input:HTMLElement)=>{const label=document.createElement('label');label.textContent=text;input.setAttribute('aria-label',text);label.append(input);this.form.append(label);};
  const list=document.createElement('datalist');list.id='vfx-binding-tags';for(const [tag,label] of [...ENEMY_VFX_SLOTS,...CONTINUOUS_VFX_SLOTS]){const o=document.createElement('option');o.value=tag;o.label=label;list.append(o);}this.root.append(list);this.tag.setAttribute('list',list.id);this.tag.value=ENEMY_VFX_SLOTS[0][0];
  field('VFX 标签',this.tag);field('绑定资源',this.resource);field('效果 key',this.effect);
  const button=(text:string,action:()=>unknown)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>void this.run(action);this.form.append(b);};
  button('读取绑定资源',()=>this.load());this.resource.onchange=()=>void this.run(()=>this.load());
  button('应用标签绑定',()=>this.edit(false));button('移除标签绑定',()=>this.edit(true));button('撤销标签绑定',()=>this.port.undo());button('重做标签绑定',()=>this.port.redo());button('保存标签场景',()=>this.port.save());
  this.status.setAttribute('role','status');this.current.style.cssText='white-space:pre-wrap;font-size:11px';this.root.append(this.form,this.status,this.current);host.append(this.root);
  void this.run(async()=>{for(const e of await listDir('assets/vfx'))if(e.kind==='file' && e.name.endsWith('.vfx.json'))this.resource.add(new Option(e.name,`assets/vfx/${e.name}`));});
 }
 private async run(action:()=>unknown){try{await action();}catch(e){this.status.textContent=String(e);}}
 private async load(){const loadId=++this.loadId,path=this.resource.value;this.asset=null;const meta=await readProjectFile(`${path}.meta.json`);if(!meta.ok)throw new Error('资源 sidecar 缺失');const asset=await readVfxAsset({path,guid:(meta.json as {guid:string}).guid});if(loadId!==this.loadId || path!==this.resource.value)return;this.asset=asset;this.assetPath=path;this.effect.replaceChildren();for(const key of Object.keys(this.asset.effects))this.effect.add(new Option(key,key));this.status.textContent=`已读取资源 v${this.asset.version}；选择 effect key 后应用`;
 }
 private edit(remove:boolean){if(!remove && (!this.asset || this.assetPath!==this.resource.value || !this.effect.value))throw new Error('请先读取绑定资源');const tag=this.tag.value.trim(),asset=this.asset,path=this.resource.value,key=this.effect.value;if(!/^[a-z][a-z0-9.-]{0,63}$/.test(tag))throw new Error('标签格式非法');const doc=this.port.document();if(!remove && doc && resolveVfxBindings(doc).diagnostics.some(d=>d.startsWith(`VFX 标签冲突 ${tag}（`)))throw new Error('标签冲突，请先移除该标签后重新绑定');
  const result=this.port.edit(remove?'移除 VFX 标签':'绑定 VFX 标签',nodes=>{let component=nodes.flatMap(n=>n.components).find(c=>c.kind==='VfxBindings' && c.enabled) as VfxBindingsComponent|undefined;
   if(!component){if(remove)return;component={kind:'VfxBindings',enabled:true,bindings:{}};if(!nodes[0])throw new Error('场景缺少节点');nodes[0].components.push(component);}
   if(remove){for(const n of nodes)for(const c of n.components)if(c.kind==='VfxBindings' && c.enabled)delete c.bindings[tag];}else component.bindings[tag]={resource:{path,guid:asset!.id},effectKey:key};
  },false);if(!result.ok)throw new Error(result.error??'绑定被拒绝');this.status.textContent='标签绑定已应用到场景，可撤销；请保存场景';
 }
 frame(){this.form.disabled=this.port.locked();const doc=this.port.document(),resolved=doc?resolveVfxBindings(doc):{bindings:{},diagnostics:[]};const key=JSON.stringify(resolved);if(key!==this.key){this.key=key;this.current.textContent=[...Object.entries(resolved.bindings).map(([tag,b])=>`${tag} → ${b.effectKey}\n${b.resource.path}`),...resolved.diagnostics].join('\n')||'尚未配置标签绑定（沿用原表现）';}}
}
