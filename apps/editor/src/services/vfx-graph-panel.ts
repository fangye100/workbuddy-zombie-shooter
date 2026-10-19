import {VFX_GRAPH_NODES,VFX_GRAPH_BUDGET,type SceneDocument,type VfxGraphNode,type VfxGraphNodeType,type VfxGraphEdge} from '@aether/scene';
import type {RendererCore} from '@aether/render';
import {listDir,readProjectFile} from '../asset-util';
import {VfxGraphDocument} from './vfx-graph-document';
import {VfxGraphCanvas} from './vfx-graph-canvas';
import {VfxGraphPreview} from './vfx-graph-preview';

/** Graph UX/host only. Source schema and runtime compiler own all graph semantics. */
export class VfxGraphPanel {
 private readonly root=document.createElement('details');private readonly form=document.createElement('fieldset');
 private readonly workspace=document.createElement('div');private readonly dialog=document.createElement('dialog');
 private readonly resource=document.createElement('select');private readonly path=document.createElement('input');
 private readonly nodeType=document.createElement('select');private readonly nodeSelect=document.createElement('select');private readonly edgeSelect=document.createElement('select');
 private readonly properties=document.createElement('div');private readonly status=document.createElement('pre');private readonly stats=document.createElement('pre');
 private readonly output=document.createElement('select');private readonly author=document.createElement('select');private readonly paused=document.createElement('input');
 private readonly canvas:VfxGraphCanvas;private readonly preview:VfxGraphPreview;
 private parameterDraft=false;private model:VfxGraphDocument|null=null;private selected='';private selectedEdge='';private serial=0;private scene='';private clock=0;private generation=0;
 constructor(host:HTMLElement,core:RendererCore,private readonly port:{document():SceneDocument|null;locked():boolean}){
  this.preview=new VfxGraphPreview(core);this.root.id='vfx-graph-panel';this.root.open=true;const title=document.createElement('summary');title.textContent='VFX · 可视节点图';this.root.append(title);
  this.field('节点图资源',this.resource,this.root);this.field('图资源文件路径',this.path,this.root);this.path.placeholder='assets/vfx/*.vfx.json';
  this.button('打开节点图',()=>this.open(this.path.value),this.root);this.resource.onchange=()=>{this.path.value=this.resource.value;void this.run(()=>this.open(this.path.value));};
  this.button('展开图画布',()=>{this.dialog.append(this.form);this.dialog.showModal();},this.root);
  this.dialog.id='vfx-graph-dialog';this.dialog.style.cssText='width:min(1300px,96vw);max-height:94vh;background:#202a36;color:#e2eaf0;border:1px solid #7d90a8;';
  this.button('关闭图画布',()=>this.dialog.close(),this.dialog);this.dialog.onclose=()=>this.root.append(this.form);document.body.append(this.dialog);
  const hint=document.createElement('p');hint.textContent='图是唯一保存源。点击输出端口，再点击输入端口创建可见连线；错误草稿会保留并显示诊断。运行复用现有有界粒子播放，修改图需重新预览或重新Play。';this.form.append(hint);
  for(const [type,def] of Object.entries(VFX_GRAPH_NODES))this.nodeType.add(new Option(def.label,type));this.field('创建节点类型',this.nodeType,this.form);this.button('创建图节点',()=>this.createNode());
  this.field('图选中节点',this.nodeSelect,this.form);this.nodeSelect.onchange=()=>{if(this.parameterDraft){this.status.textContent='请先应用节点参数';this.nodeSelect.value=this.selected;return;}this.selected=this.nodeSelect.value;this.selectedEdge='';this.render();};this.button('删除图节点',()=>this.removeNode());
  this.field('图选中连线',this.edgeSelect,this.form);this.edgeSelect.onchange=()=>{this.selectedEdge=this.edgeSelect.value;this.render();};this.button('删除图连线',()=>this.removeEdge());
  this.canvas=new VfxGraphCanvas({selectNode:id=>{if(this.parameterDraft){this.status.textContent='请先应用节点参数';return;}this.selected=id;this.selectedEdge='';this.render();},selectEdge:id=>{if(this.parameterDraft){this.status.textContent='请先应用节点参数';return;}this.selectedEdge=id;this.render();},connect:(from,to)=>void this.run(()=>this.connect(from,to)),message:text=>{this.status.textContent=text;}});
  this.workspace.style.cssText='display:flex;gap:12px;flex-wrap:wrap';this.canvas.root.style.flex='1 1 500px';this.properties.style.cssText='flex:0 1 260px;min-width:210px';this.workspace.append(this.canvas.root,this.properties);this.form.append(this.workspace);
  this.button('应用节点参数',()=>this.applyParameters());this.button('撤销图编辑',()=>{this.preview.stop();this.model?.undo();this.render();});this.button('重做图编辑',()=>{this.preview.stop();this.model?.redo();this.render();});
  this.button('保存节点图',async()=>{if(!this.model)throw new Error('先打开图');if(this.parameterDraft)throw new Error('请先应用节点参数');this.status.textContent=await this.model.save();});
  this.button('重载节点图',async()=>{if(!this.model)throw new Error('先打开图');this.preview.stop();await this.model.reload();this.render();this.status.textContent+=`\n已从磁盘重载；源图v${this.model.sourceVersion}→编辑图v${this.model.value.graph.version}，仅保存才升级`;});
  this.field('图预览输出',this.output,this.form);this.output.onchange=()=>this.authors();this.field('图预览作者节点',this.author,this.form);this.paused.type='checkbox';this.paused.checked=true;this.field('图预览启动暂停',this.paused,this.form);
  this.button('预览编译图',()=>this.startPreview());this.button('图预览暂停/继续',()=>{this.preview.paused=!this.preview.paused;});this.button('图预览单步',()=>this.preview.step());this.button('重播编译图',()=>this.startPreview());this.button('停止图预览',()=>this.preview.stop());
  this.status.setAttribute('role','status');this.status.style.cssText='white-space:pre-wrap;color:#f3cd97;font-size:12px';this.stats.style.cssText='white-space:pre-wrap;font-size:11px';this.form.append(this.status,this.stats);this.root.append(this.form);host.append(this.root);
  this.form.addEventListener('keydown',e=>{if((e.ctrlKey || e.metaKey) && ['z','y','s'].includes(e.key.toLowerCase())){e.preventDefault();e.stopPropagation();void this.run(async()=>{if(e.key.toLowerCase()==='s'){if(this.parameterDraft)throw new Error('请先应用节点参数');if(this.model)this.status.textContent=await this.model.save();}else{this.preview.stop();if(e.key.toLowerCase()==='y' || e.shiftKey)this.model?.redo();else this.model?.undo();this.render();}});}});
  void this.run(async()=>{for(const f of await listDir('assets/vfx'))if(f.kind==='file' && f.name.endsWith('.vfx.json')){const path='assets/vfx/'+f.name,r=await readProjectFile(path);if(r.ok && r.json && typeof r.json==='object' && Object.hasOwn(r.json,'graph'))this.resource.add(new Option(f.name,path));}this.path.value=this.resource.value;});
 }
 private field(label:string,input:HTMLElement,host:HTMLElement){const row=document.createElement('label');row.textContent=label;row.style.cssText='display:inline-flex;gap:6px;margin:4px;align-items:center';input.setAttribute('aria-label',label);if(host===this.properties)for(const event of ['input','change'])input.addEventListener(event,()=>{this.parameterDraft=true;});row.append(input);host.append(row);}
 private button(label:string,fn:()=>unknown,host:HTMLElement=this.form){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>void this.run(fn);host.append(b);}
 private async run(fn:()=>unknown){try{if(this.port.locked())throw new Error('Play/场景写入期间图编辑锁定');await fn();}catch(error){this.status.textContent=String(error);}}
 private async open(path:string){
  if(this.model?.dirty || this.parameterDraft)throw new Error('图有未保存草稿，请先保存或重载');const generation=++this.generation;
  const [r,m]=await Promise.all([readProjectFile(path),readProjectFile(path+'.meta.json')]);if(generation!==this.generation)return;
  if(!r.ok || !m.ok)throw new Error('图资源/sidecar读取失败');const next=new VfxGraphDocument(path,r.json),meta=m.json as {guid:string;kind:string};if(next.value.id!==meta.guid || meta.kind!=='vfx')throw new Error('图sidecar GUID/kind不匹配');
  this.preview.stop();this.model=next;this.path.value=path;this.selected=next.value.graph.nodes[0]?.id??'';this.selectedEdge='';this.render();this.status.textContent+=`\n已加载图：源图v${next.sourceVersion}→编辑图v${next.value.graph.version}；磁盘仅在Save时升级`;
 }
 private id(prefix:string){let value:string;do{value=prefix+(++this.serial);}while(this.model?.value.graph.nodes.some(n=>n.id===value) || this.model?.value.graph.edges.some(e=>e.id===value));return value;}
 private change(mutate:(source:NonNullable<VfxGraphPanel['model']>['value'])=>void){if(this.parameterDraft)throw new Error('请先应用节点参数');if(!this.model)throw new Error('先打开节点图');this.preview.stop();this.model.edit(mutate);this.render();}
 private createNode(){
  if((this.model?.value.graph.nodes.length??0)>=VFX_GRAPH_BUDGET.nodes)throw new Error('图节点预算64已满，保留当前草稿');
  const type=this.nodeType.value as VfxGraphNodeType,ref=this.model?.value.graph.nodes.find(n=>n.type==='texture')?.params.ref??{path:'',guid:''};
  const defaults:Record<VfxGraphNodeType,Record<string,unknown>>={number:{value:1},size:{value:[.4,.8]},color:{value:'#ffffff'},texture:{ref:structuredClone(ref),frames:1},multiply:{},appearance:{},emission:{maxParticles:32,spreadDeg:20},sprite:{backend:'cpu',blend:'alpha'},output:{key:'output-'+this.serial}};
  const id=this.id('node_');this.selected=id;this.change(a=>a.graph.nodes.push({id,type,position:[40+(a.graph.nodes.length%4)*230,40+Math.floor(a.graph.nodes.length/4)*180],params:defaults[type]}));
 }
 private removeNode(){const id=this.selected;if(!id)throw new Error('请选择节点');this.change(a=>{a.graph.nodes=a.graph.nodes.filter(n=>n.id!==id);a.graph.edges=a.graph.edges.filter(e=>e.from.node!==id && e.to.node!==id);});}
 private removeEdge(){const id=this.selectedEdge;if(!id)throw new Error('请选择连线');this.change(a=>{a.graph.edges=a.graph.edges.filter(e=>e.id!==id);});}
 private connect(from:VfxGraphEdge['from'],to:VfxGraphEdge['to']){if((this.model?.value.graph.edges.length??0)>=VFX_GRAPH_BUDGET.edges)throw new Error('图连线预算128已满，保留当前草稿');this.change(a=>a.graph.edges.push({id:this.id('edge_'),from,to}));}
 private render(){
  const model=this.model;if(!model)return;const graph=model.value.graph;
  if(!graph.nodes.some(n=>n.id===this.selected))this.selected=graph.nodes[0]?.id??'';if(!graph.edges.some(e=>e.id===this.selectedEdge))this.selectedEdge='';
  this.nodeSelect.replaceChildren(...graph.nodes.map(n=>new Option(n.id+' · '+VFX_GRAPH_NODES[n.type].label,n.id)));this.nodeSelect.value=this.selected;
  this.edgeSelect.replaceChildren(new Option('选择可见连线',''),...graph.edges.map(e=>new Option(e.id+' '+e.from.node+'/'+e.from.port+' → '+e.to.node+'/'+e.to.port,e.id)));this.edgeSelect.value=this.selectedEdge;
  this.canvas.render(graph,this.selected,this.selectedEdge);this.parameters(graph.nodes.find(n=>n.id===this.selected));
  const result=model.compilation,old=this.output.value;this.output.replaceChildren(...Object.keys(result.asset?.effects??{}).map(k=>new Option(k,k)));if([...this.output.options].some(o=>o.value===old))this.output.value=old;this.authors();
  this.status.textContent=result.asset?`图编译通过（纹理/设备在预览时校验）：${graph.nodes.length}节点/${graph.edges.length}连线；${model.dirty?'有未保存草稿':'已与磁盘一致'}`:result.diagnostics.join('\n');
 }
 private parameters(node?:VfxGraphNode){
  this.parameterDraft=false;this.properties.replaceChildren();if(!node)return;const id=document.createElement('code');id.textContent=node.id;this.properties.append(id);
  const number=(label:string,value:unknown)=>{const i=document.createElement('input');i.type='number';i.step='any';i.value=String(value);this.field(label,i,this.properties);};
  const text=(label:string,value:unknown,type='text')=>{const i=document.createElement('input');i.type=type;i.value=String(value);this.field(label,i,this.properties);};
  number('节点画布X',node.position[0]);number('节点画布Y',node.position[1]);const p=node.params;
  switch(node.type){case 'number':number('节点数值',p.value);break;case 'size':number('节点宽度 m',(p.value as number[])[0]);number('节点高度 m',(p.value as number[])[1]);break;case 'color':text('节点颜色',p.value,'color');break;case 'texture':text('节点纹理路径',(p.ref as {path:string}).path);text('节点纹理GUID',(p.ref as {guid:string}).guid);number('节点纹理帧数',p.frames);break;case 'emission':number('节点粒子容量',p.maxParticles);number('节点散角 °',p.spreadDeg);break;case 'output':text('节点输出 key',p.key);break;case 'sprite':for(const [label,key,values] of [['节点模拟后端','backend',['cpu','gpu']],['节点混合方式','blend',['alpha','additive']]] as const){const i=document.createElement('select');for(const value of values)i.add(new Option(value,value));i.value=p[key] as string;this.field(label,i,this.properties);}break;}
 }
 private applyParameters(){
  const value=(name:string)=>(this.properties.querySelector(`[aria-label="${name}"]`) as HTMLInputElement).value,num=(name:string)=>value(name).trim()?Number(value(name)):NaN;this.parameterDraft=false;
  this.change(a=>{const n=a.graph.nodes.find(n=>n.id===this.selected);if(!n)throw new Error('节点不存在');n.position=[num('节点画布X'),num('节点画布Y')];const p=n.params;
   switch(n.type){case 'number':p.value=num('节点数值');break;case 'size':p.value=[num('节点宽度 m'),num('节点高度 m')];break;case 'color':p.value=value('节点颜色');break;case 'texture':p.ref={path:value('节点纹理路径'),guid:value('节点纹理GUID')};p.frames=num('节点纹理帧数');break;case 'emission':p.maxParticles=num('节点粒子容量');p.spreadDeg=num('节点散角 °');break;case 'sprite':p.backend=value('节点模拟后端');p.blend=value('节点混合方式');break;case 'output':p.key=value('节点输出 key');break;}
  });
 }
 private authors(){const previous=this.author.value;this.author.replaceChildren();if(this.model)for(const n of this.port.document()?.nodes??[])if(n.components.some(c=>c.kind==='VfxEmitter' && c.resource.guid===this.model!.value.id && c.effectKey===this.output.value))this.author.add(new Option(n.name+' · '+n.id,n.id));if([...this.author.options].some(o=>o.value===previous))this.author.value=previous;}
 private async startPreview(){if(this.parameterDraft)throw new Error('请先应用节点参数');if(!this.model)throw new Error('先打开图');this.preview.stop();const result=this.model.compilation;if(!result.asset)throw new Error('图不可播放，保留草稿：'+result.diagnostics.join('；'));const doc=this.port.document();if(!doc)throw new Error('场景未加载');await this.preview.start(result.asset,doc,this.author.value,this.output.value,this.paused.checked);}
 frame(dt:number){this.form.disabled=this.port.locked();this.preview.update(dt,this.port.locked());const doc=this.port.document();if(doc?.id!==this.scene){this.scene=doc?.id??'';this.preview.stop();this.authors();}this.clock+=dt;if(this.clock>.2){this.clock=0;const p=this.preview.snapshot();this.stats.textContent=JSON.stringify({dirty:this.model?.dirty??false,preview:p.gpu,pool:p.pool,emitters:p.emitters,tick:p.tick,ready:p.ready,diagnostic:p.diagnostic},null,1);}}
 get hasDraft(){return this.parameterDraft || (this.model?.dirty??false);}
 stop(){this.generation++;this.preview.stop();}
 snapshot(){return {path:this.model?.path??null,sourceVersion:this.model?.sourceVersion??null,source:this.model?structuredClone(this.model.value):null,dirty:this.hasDraft,compilation:this.model?.compilation??null,preview:this.preview.snapshot()};}
}
