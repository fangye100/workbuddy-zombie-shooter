import { SceneGraph,validateVfxAsset,cpuVfxCompatibility,type SceneDocument,type SceneNode,type VfxAsset } from '@aether/scene';
import { VfxPool,VfxEmitters,solidCollider,nearestSolidContact,type EditResult } from '@aether/runtime';
import { VfxPass,type RendererCore } from '@aether/render';
import { listDir,readProjectFile } from '../asset-util';
import { readVfxAsset,readVfxTexture } from './vfx-assets';
import { VfxDocument } from './vfx-document';

/** Focused asset authoring. Scene bindings are delegated to the shared author store. */
export class VfxPanel {
  private readonly root=document.createElement('details');
  private readonly status=document.createElement('p');
  private readonly stats=document.createElement('pre');
  private readonly resource=document.createElement('select');
  private readonly path=document.createElement('input');
  private readonly weapon=document.createElement('select');
  private readonly kind=document.createElement('select');
  private readonly width=document.createElement('input');
  private readonly height=document.createElement('input');
  private readonly duration=document.createElement('input');
  private readonly color=document.createElement('input');
  private readonly orientation=document.createElement('select');private readonly loop=document.createElement('input');
  private readonly scope=document.createElement('select');
  private readonly backend=document.createElement('select');private readonly blend=document.createElement('select');private readonly acceleration=document.createElement('input');
  private readonly rate=document.createElement('input');private readonly speed=document.createElement('input');private readonly spread=document.createElement('input');private readonly maxParticles=document.createElement('input');
  private readonly sizeCurve=document.createElement('textarea');private readonly colorCurve=document.createElement('textarea');private readonly alphaCurve=document.createElement('textarea');
  private readonly seed=document.createElement('input');private readonly startPaused=document.createElement('input');

  private previewReady=false;private previewTick=0;private previewAccumulator=0;private previewPaused=false;
  private readonly form=document.createElement('fieldset');
  private document:VfxDocument|null=null;
  private generation=0;
  private pass:VfxPass|null=null;
  private readonly pool=new VfxPool();private readonly emitters=new VfxEmitters(this.pool);

  private tick=0;

  private sceneKey='';
  private formDirty=false;
  constructor(host:HTMLElement,private readonly core:RendererCore,private readonly port:{document():SceneDocument|null;locked():boolean;edit(label:string,mutate:(nodes:SceneNode[])=>void,rebuild:boolean):EditResult;undo():void;redo():void;save():Promise<void>;playStats():unknown}){
    this.root.id='vfx-panel';this.root.open=true;const title=document.createElement('summary');title.textContent='手枪 VFX · 资源与绑定';this.root.append(title);
    const field=(label:string,input:HTMLElement)=>{const row=document.createElement('label');row.textContent=label;row.append(input);this.form.append(row);input.setAttribute('aria-label',label);};
    field('VFX 资源',this.resource);field('资源文件路径',this.path);
    this.path.placeholder='assets/vfx/*.vfx.json';
    this.button('打开 VFX 资源',()=>this.open(this.path.value));
    this.resource.onchange=()=>{this.path.value=this.resource.value;void this.run(()=>this.open(this.resource.value));};
    field('绑定武器',this.weapon);this.button('应用 VFX 绑定',()=>this.bind());
    this.button('清除 VFX 绑定',()=>{const r=this.port.edit('清除武器 VFX 绑定',nodes=>{for(const n of nodes)for(const c of n.components)if(c.kind==='RunRules'){const w=c.arsenal.definitions.find(w=>w.id===this.weapon.value);if(w)w.presentation.vfx.resource=null;}},false);if(!r.ok)throw new Error(r.error??'清除失败');this.status.textContent='已清除绑定，请保存场景';});
    this.button('撤销场景绑定',()=>this.port.undo());this.button('重做场景绑定',()=>this.port.redo());this.button('保存场景绑定',()=>this.port.save());
    field('编辑效果',this.kind);this.kind.onchange=()=>this.fields();
    for(const [name,input] of [['宽度 m',this.width],['高度 m',this.height],['持续时间 s',this.duration]] as const){input.type='number';input.step='.01';input.min='.01';field(name,input);input.oninput=()=>{this.formDirty=true;};}
    this.color.type='color';field('VFX 颜色',this.color);this.color.oninput=()=>{this.formDirty=true;};
    this.orientation.add(new Option('面向相机','camera'));this.orientation.add(new Option('对齐接收平面','surface'));field('VFX 朝向',this.orientation);this.orientation.onchange=()=>{this.formDirty=true;};this.loop.type='checkbox';field('循环帧动画',this.loop);this.loop.onchange=()=>{this.formDirty=true;};
    this.backend.add(new Option('CPU 有界发射','cpu'));this.backend.add(new Option('GPU compute 模拟','gpu'));field('模拟后端',this.backend);this.backend.onchange=()=>{this.formDirty=true;};this.blend.add(new Option('Alpha 排序','alpha'));this.blend.add(new Option('Additive 叠加','additive'));field('混合方式',this.blend);this.blend.onchange=()=>{this.formDirty=true;};field('加速度 xyz JSON',this.acceleration);this.acceleration.oninput=()=>{this.formDirty=true;};
    const hint=document.createElement('p');hint.textContent='持续时间：动画周期或装饰尾部。危险半径/结束始终跟随模拟，不由本表改变。GPU compute：camera/additive sprite；其他模式显式CPU兼容并限120/s、128粒子（保留加速度）。';this.form.append(hint);
    for(const [name,input] of [['发射率 /s',this.rate],['粒子速度 m/s',this.speed],['发射散角 °',this.spread],['单发射器粒子上限',this.maxParticles]] as const){input.type='number';input.step='.1';field(name,input);input.oninput=()=>{this.formDirty=true;};}
    for(const [name,input] of [['尺寸曲线 JSON',this.sizeCurve],['颜色曲线 JSON',this.colorCurve],['透明度曲线 JSON',this.alphaCurve]] as const){input.rows=2;field(name,input);input.oninput=()=>{this.formDirty=true;};}
    this.seed.type='number';this.seed.value='7';this.seed.min='0';this.seed.max='4294967295';field('预览 seed',this.seed);this.startPaused.type='checkbox';field('预览启动暂停',this.startPaused);
    this.button('预览暂停/继续',()=>{this.previewPaused=!this.previewPaused;});this.button('预览单步',()=>{if(this.pass && this.document && this.previewReady){this.previewPaused=true;this.advancePreview();}});this.button('固定种子重播',()=>this.preview());
    this.button('应用资源参数',()=>this.apply());this.button('撤销资源参数',()=>{this.document?.undo();this.fields();});this.button('重做资源参数',()=>{this.document?.redo();this.fields();});
    this.button('保存 VFX 资产',async()=>{if(this.formDirty)throw new Error('请先应用资源参数');if(!this.document)throw new Error('请先打开资源');this.status.textContent=await this.document.save();});
    this.button('重载 VFX 资产',async()=>{if(!this.document)throw new Error('请先打开资源');await this.document.reload();this.fields();this.status.textContent='VFX 已从磁盘重载';});
    this.button('循环 GPU 预览',()=>this.preview());this.button('停止 VFX 预览',()=>this.stop());
    this.scope.add(new Option('当前效果','selection'));this.scope.add(new Option('完整资源','all'));field('预览范围',this.scope);
    this.status.setAttribute('role','status');this.stats.id='vfx-stats';this.stats.style.cssText='white-space:pre-wrap;font-size:11px';
    this.root.append(this.form,this.status,this.stats);host.append(this.root);
    void this.run(async()=>{for(const f of await listDir('assets/vfx'))if(f.kind==='file' && f.name.endsWith('.vfx.json'))this.resource.add(new Option(f.name,`assets/vfx/${f.name}`));this.path.value=this.resource.value;});
  }
  private button(label:string,fn:()=>unknown){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>void this.run(fn);this.form.append(b);}
  private async run(fn:()=>unknown){try{await fn();}catch(e){this.status.textContent=String(e);} }
  private async open(path:string){
    if(this.document?.dirty || this.formDirty)throw new Error('资源有未保存修改，请先保存或重载');
    let asset:VfxAsset;
    if(!path.startsWith('assets/') && /^[a-zA-Z0-9_./-]+\.vfx\.json$/.test(path) && !path.startsWith('/') && path.split('/').every(s=>s && s!=='.' && s!=='..')){
      const r=await readProjectFile(path),meta=await readProjectFile(`${path}.meta.json`);if(!r.ok || !meta.ok)throw new Error('资源读取失败');
      const errors=validateVfxAsset(r.json);if(errors.length)throw new Error(errors.join('；'));asset=r.json as VfxAsset;
      if((meta.json as {guid?:string;kind?:string}).guid!==asset.id || (meta.json as {kind?:string}).kind!=='vfx')throw new Error('资源 sidecar 不匹配');
    }else{const meta=await readProjectFile(`${path}.meta.json`);if(!meta.ok)throw new Error('找不到 VFX sidecar');asset=await readVfxAsset({path,guid:(meta.json as {guid:string}).guid});}
    this.stop();this.document=new VfxDocument(path,asset);this.path.value=path;this.kind.replaceChildren();for(const [key,e] of Object.entries(asset.effects))this.kind.add(new Option(`${e.kind} · ${key}`,key));this.fields();this.status.textContent=`已加载 VFX 源版本 ${asset.version} → 编辑版本 ${this.document.value.version}；仅保存时升级磁盘。参数保存与场景绑定分别管理`;
  }
  private fields(){const e=this.document?.value.effects[this.kind.value];if(!e)return;this.width.value=String(e.size[0]);this.height.value=String(e.size[1]);this.duration.value=String(e.duration);this.color.value=e.color;this.orientation.value=e.orientation??'camera';this.loop.checked=e.loop??false;this.backend.value=e.backend??'cpu';this.blend.value=e.blend;this.acceleration.value=JSON.stringify(e.emission?.acceleration??[0,0,0]);this.rate.value=String(e.emission?.rate??0);this.speed.value=String(e.emission?.speed??0);this.spread.value=String(e.emission?.spreadDeg??0);this.maxParticles.value=String(e.emission?.maxParticles??32);this.sizeCurve.value=e.sizeCurve?JSON.stringify(e.sizeCurve):'';this.colorCurve.value=e.colorCurve?JSON.stringify(e.colorCurve):'';this.alphaCurve.value=e.alphaCurve?JSON.stringify(e.alphaCurve):'';this.formDirty=false;}
  private apply(){if(!this.document)throw new Error('请先打开资源');const next=structuredClone(this.document.value),e=next.effects[this.kind.value]!;e.size=[Number(this.width.value),Number(this.height.value)];e.duration=Number(this.duration.value);e.color=this.color.value;e.orientation=this.orientation.value as 'camera'|'surface';e.loop=this.loop.checked;e.backend=this.backend.value as 'cpu'|'gpu';e.blend=this.blend.value as 'alpha'|'additive';if(Number(this.rate.value)>0)e.emission={rate:Number(this.rate.value),speed:Number(this.speed.value),spreadDeg:Number(this.spread.value),maxParticles:Number(this.maxParticles.value),acceleration:JSON.parse(this.acceleration.value)};else delete e.emission;for(const [key,input] of [['sizeCurve',this.sizeCurve],['colorCurve',this.colorCurve],['alphaCurve',this.alphaCurve]] as const){if(input.value.trim())e[key]=JSON.parse(input.value);else delete e[key];}this.document.apply(next);this.formDirty=false;this.status.textContent='已应用资源参数（资产尚未保存）';this.stop();}
  private bind(){
    if(!this.document || !this.document.path.startsWith('assets/'))throw new Error('请选择 assets/ 下的正式资源绑定');
    const asset=this.document.value,keys=Object.fromEntries((['muzzle','trail','impact'] as const).map(k=>[k,Object.keys(asset.effects).find(key=>asset.effects[key]!.kind===k)]));
    if(asset.status!=='accepted' || !keys.muzzle || !keys.trail || !keys.impact)throw new Error('绑定需要已验收的 muzzle/trail/impact 三件套');
    const result=this.port.edit('绑定手枪 VFX',nodes=>{for(const n of nodes)for(const c of n.components)if(c.kind==='RunRules'){const w=c.arsenal.definitions.find(w=>w.id===this.weapon.value);if(w)w.presentation.vfx={muzzle:keys.muzzle!,trail:keys.trail!,impact:keys.impact!,resource:{path:this.document!.path,guid:asset.id}};}},false);
    if(!result.ok)throw new Error(result.error??'绑定失败');this.status.textContent='VFX 绑定已应用到场景，可撤销；请保存场景';
  }
  private async preview(){
    if(!this.document)throw new Error('请先打开资源');if(this.formDirty)throw new Error('请先应用参数');this.stop();const generation=++this.generation;
    const asset=structuredClone(this.document.value),pass=new VfxPass(this.core.device);this.pass=pass;this.core.vfx=pass;
    try{for(const texture of new Map(Object.values(asset.effects).map(e=>[e.texture.guid,e.texture])).values()){
      const bitmap=await readVfxTexture(texture);try{if(generation!==this.generation)return;pass.addTexture(texture.guid,bitmap);}finally{bitmap.close();}}
      if(generation!==this.generation)return;this.previewTick=0;this.previewAccumulator=0;this.previewPaused=this.startPaused.checked;this.previewReady=true;this.status.textContent='GPU 循环预览中（场景深度遮挡；只读场景）';
    }catch(e){this.stop();throw e;}
  }
  stop(){this.previewReady=false;this.generation++;this.pass?.destroy();if(this.core.vfx===this.pass)this.core.vfx=null;this.pass=null;this.pool.clear();this.emitters.clear();}
  frame(dt:number){
    const doc=this.port.document(),locked=this.port.locked();this.form.disabled=locked;
    if(locked && this.pass)this.stop();
    const weapons=doc?.nodes.flatMap(n=>n.components).find(c=>c.kind==='RunRules');
    const key=JSON.stringify([doc?.id,weapons?.kind==='RunRules'?weapons.arsenal.definitions.map(w=>[w.id,w.presentation.vfx]):[]]);
    if(key!==this.sceneKey){this.sceneKey=key;this.weapon.replaceChildren();if(weapons?.kind==='RunRules')for(const w of weapons.arsenal.definitions)this.weapon.add(new Option(w.name,w.id));}
    if(this.pass && this.document && this.previewReady && !this.previewPaused){this.previewAccumulator+=dt;while(this.previewAccumulator>=1/30){this.previewAccumulator-=1/30;this.advancePreview();}}
    this.tick+=dt;if(this.tick>.2){this.tick=0;this.stats.textContent=JSON.stringify({assetDirty:this.document?.dirty??false,preview:this.pass?.stats??null,compute:this.pass?.gpu?.snapshot()??null,play:this.port.playStats()},null,1);}
  }
  private advancePreview(){
    const doc=this.port.document();if(!doc || !this.document || !this.pass)return;this.pool.advance(1/30);const tick=this.previewTick++,graph=SceneGraph.fromDocument(doc),node=doc.playerStart??doc.nodes[0]?.id;if(!node)return;const base=graph.getNode(node)?.world.position??[0,0,0],from:[number,number,number]=[base[0]+.5,base[1]+1,base[2]],end:[number,number,number]=[from[0]+3,from[1],from[2]];
    const solids=doc.nodes.flatMap(n=>n.components.flatMap(c=>c.kind==='Collider' && c.enabled && !c.isTrigger?[solidCollider(n.id,c.shape,graph.worldMatrix(n.id))]:[])),surface=nearestSolidContact([base[0],base[1]+1,base[2]],[0,-1,0],solids,4),seed=Number(this.seed.value);
    if(!Number.isInteger(seed) || seed<0 || seed>4294967295){this.status.textContent='预览seed必须为uint32';return;}
    this.pass.instances=this.pool.active;for(const [key,source] of Object.entries(this.document.value.effects)){let effect=source;if(this.scope.value==='selection' && key!==this.kind.value)continue;if(effect.orientation==='surface' && !surface){this.status.textContent='平面预览需要玩家起点下方的真实 Collider 接收面';continue;}const position=effect.orientation==='surface'?surface!.point:effect.kind==='impact'?end:from;
      if(effect.backend==='gpu'){const reason=this.pass.updateGpuEmitter(`preview:${key}`,effect,{position,direction:[1,0,0]},tick,1/30,seed);if(!reason)continue;this.status.textContent=reason+'（CPU限120/s、128粒子，保留加速度）';effect=cpuVfxCompatibility(effect);}
      if(effect.emission)this.emitters.update(`preview:${key}`,effect,{position,direction:[1,0,0],...(effect.orientation==='surface'?{normal:surface!.normal}:{})},tick,1/30,seed);
      else if(tick%20===0)this.pool.spawn({key:`preview:${tick}:${key}`,effect,position,...(effect.orientation==='surface'?{normal:surface!.normal}:{}),...(effect.kind==='trail'?{end}:{}),seed,priority:1});
    }this.pass.instances=this.pool.active;
  }
  get hasDraft(){return this.formDirty || !!this.document?.dirty;}
  snapshot(){return {previewClock:{ready:this.previewReady,tick:this.previewTick,seed:Number(this.seed.value),paused:this.previewPaused},particles:this.pool.active.map(p=>({...p})),path:this.document?.path??null,sourceVersion:this.document?.sourceVersion??null,asset:this.document?.value??null,dirty:this.hasDraft,preview:this.pass?.stats??null,compute:this.pass?.gpu?.snapshot()??null};}
}
