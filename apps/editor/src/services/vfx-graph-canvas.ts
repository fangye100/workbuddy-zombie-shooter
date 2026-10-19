import {VFX_GRAPH_NODES,type VfxGraph,type VfxGraphEdge,type VfxPortType} from '@aether/scene';

const ns='http://www.w3.org/2000/svg';
const colors:Record<VfxPortType,string>={number:'#8bc7ff',size:'#b7a2ff',color:'#ffaa83',texture:'#88dbc4',appearance:'#dfd17d',emission:'#f19fd0',effect:'#ffffff'};
/** Actual graph surface: stable node cards, typed clickable ports, visible/selectable connections. */
export class VfxGraphCanvas {
 readonly root=document.createElement('div');
 private pending:{node:string;port:string}|null=null;
 constructor(private readonly port:{selectNode(id:string):void;selectEdge(id:string):void;connect(from:VfxGraphEdge['from'],to:VfxGraphEdge['to']):void;message(text:string):void}){this.root.setAttribute('aria-label','VFX图画布');this.root.style.cssText='height:420px;overflow:auto;background:#19222c;border:1px solid #566575;';}
 render(graph:VfxGraph,selectedNode:string,selectedEdge:string){
  this.pending=null;this.root.replaceChildren();const area=document.createElement('div');area.style.position='relative';
  const minX=Math.min(0,...graph.nodes.map(n=>(Number.isFinite(n.position[0])?n.position[0]:0)))-20,minY=Math.min(0,...graph.nodes.map(n=>(Number.isFinite(n.position[1])?n.position[1]:0)))-20;
  const points=new Map(graph.nodes.map(n=>[n.id,{x:(Number.isFinite(n.position[0])?n.position[0]:0)-minX,y:(Number.isFinite(n.position[1])?n.position[1]:0)-minY}]));
  const width=Math.max(850,...[...points.values()].map(p=>p.x+200)),height=Math.max(400,...[...points.values()].map(p=>p.y+190));area.style.width=width+'px';area.style.height=height+'px';
  const svg=document.createElementNS(ns,'svg');svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));svg.style.cssText='position:absolute;inset:0;pointer-events:none';area.append(svg);
  for(const edge of graph.edges){
   const from=graph.nodes.find(n=>n.id===edge.from.node),to=graph.nodes.find(n=>n.id===edge.to.node),a=points.get(edge.from.node),b=points.get(edge.to.node);if(!from || !to || !a || !b)continue;
   const defA=VFX_GRAPH_NODES[from.type],defB=VFX_GRAPH_NODES[to.type],out=Object.keys(defA?.outputs??{}).indexOf(edge.from.port),input=Object.keys(defB?.inputs??{}).indexOf(edge.to.port);
   const line=document.createElementNS(ns,'line');line.dataset.edgeId=edge.id;line.setAttribute('x1',String(a.x+180));line.setAttribute('y1',String(a.y+55+Math.max(0,out)*26));line.setAttribute('x2',String(b.x));line.setAttribute('y2',String(b.y+55+Math.max(0,input)*26));line.setAttribute('stroke',edge.id===selectedEdge?'#ff9766':'#8bc7ff');line.setAttribute('stroke-width',edge.id===selectedEdge?'5':'3');line.style.pointerEvents='stroke';line.style.cursor='pointer';line.onclick=()=>this.port.selectEdge(edge.id);svg.append(line);
  }
  for(const n of graph.nodes){
   const def=VFX_GRAPH_NODES[n.type],point=points.get(n.id)!,card=document.createElement('div');card.dataset.nodeId=n.id;card.style.cssText=`position:absolute;left:${point.x}px;top:${point.y}px;width:180px;min-height:${56+Math.max(Object.keys(def.inputs).length,Object.keys(def.outputs).length)*26}px;background:#293747;border:2px solid ${selectedNode===n.id?'#ffe190':'#63768b'};box-sizing:border-box;color:white;`;
   const title=document.createElement('button');title.type='button';title.textContent=def.label+' · '+n.id;title.setAttribute('aria-label','选择图节点 '+n.id);title.style.cssText='width:100%;height:39px;font-size:11px;overflow:hidden';title.onclick=()=>this.port.selectNode(n.id);card.append(title);
   for(const [side,ports] of [['in',def.inputs],['out',def.outputs]] as const)for(const [i,[name,type]] of Object.entries(ports).entries()){
    const pin=document.createElement('button');pin.type='button';pin.dataset.port=side+':'+name;pin.setAttribute('aria-label',`图${side==='in'?'输入':'输出'} ${n.id}/${name}`);pin.textContent=side==='in'?`● ${name}: ${type}`:`${name}: ${type} ●`;pin.style.cssText=`position:absolute;${side==='in'?'left':'right'}:0;top:${42+i*26}px;max-width:174px;font-size:10px;color:${colors[type]};height:24px;`;
    pin.onclick=()=>{if(side==='out'){this.pending={node:n.id,port:name};this.port.message(`已选输出 ${n.id}/${name} (${type})，点击目标输入连接`);}else if(this.pending){const from=this.pending;this.pending=null;this.port.connect(from,{node:n.id,port:name});}else this.port.message('请先点击一个输出端口，再点击输入端口');};card.append(pin);
   }
   area.append(card);
  }
  this.root.append(area);
 }
}
