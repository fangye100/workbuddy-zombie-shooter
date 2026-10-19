import type {AssetRef} from './document';

/** The graph is persisted source. Compiled effects never belong in this document. */
export const VFX_GRAPH_VERSION=2;
export const VFX_GRAPH_BUDGET={nodes:64,edges:128,outputs:8,totalParticles:4096} as const;
export type VfxPortType='number'|'size'|'color'|'texture'|'appearance'|'emission'|'effect';
export type VfxGraphNodeType='number'|'size'|'color'|'texture'|'multiply'|'appearance'|'emission'|'sprite'|'output';
export interface VfxGraphNode {id:string;type:VfxGraphNodeType;position:[number,number];params:Record<string,unknown>}
export interface VfxGraphEdge {id:string;from:{node:string;port:string};to:{node:string;port:string}}
export interface VfxGraph {version:number;nodes:VfxGraphNode[];edges:VfxGraphEdge[]}
export interface VfxGraphAsset {version:8;id:string;name:string;status:'accepted'|'quarantined';graph:VfxGraph;effects?:never}
export interface VfxNodeDefinition {label:string;inputs:Record<string,VfxPortType>;outputs:Record<string,VfxPortType>}
export const VFX_GRAPH_NODES:Record<VfxGraphNodeType,VfxNodeDefinition>={
 number:{label:'数值',inputs:{},outputs:{value:'number'}},
 size:{label:'尺寸',inputs:{},outputs:{value:'size'}},
 color:{label:'颜色',inputs:{},outputs:{value:'color'}},
 texture:{label:'纹理',inputs:{},outputs:{value:'texture'}},
 multiply:{label:'数值相乘',inputs:{a:'number',b:'number'},outputs:{value:'number'}},
 appearance:{label:'外观',inputs:{texture:'texture',size:'size',color:'color',duration:'number'},outputs:{value:'appearance'}},
 emission:{label:'发射',inputs:{rate:'number',speed:'number'},outputs:{value:'emission'}},
 sprite:{label:'粒子',inputs:{appearance:'appearance',emission:'emission'},outputs:{value:'effect'}},
 output:{label:'效果输出',inputs:{effect:'effect'},outputs:{}},
};
const record=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v);
const finite=(v:unknown,min:number,max:number)=>typeof v==='number' && Number.isFinite(v) && v>=min && v<=max;
const id=(v:unknown)=>typeof v==='string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v);
const knownType=(v:unknown):v is VfxGraphNodeType=>typeof v==='string' && Object.hasOwn(VFX_GRAPH_NODES,v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
function validParams(type:VfxGraphNodeType,p:Record<string,unknown>):boolean {
 switch(type){
  case 'number':return exact(p,['value']) && finite(p.value,-2400,2400);
  case 'size':return exact(p,['value']) && Array.isArray(p.value) && p.value.length===2 && p.value.every(n=>finite(n,.001,20));
  case 'color':return exact(p,['value']) && typeof p.value==='string' && /^#[a-f\d]{6}$/i.test(p.value);
  case 'texture':{const r=p.ref as AssetRef;return exact(p,['ref','frames']) && record(r) && exact(r,['path','guid']) && typeof r.guid==='string' && !!r.guid && typeof r.path==='string' && /^assets\//.test(r.path) && !/[\\?#]/.test(r.path) && r.path.split('/').every(s=>s && s!=='.' && s!=='..') && /\.(svg|png|webp)$/.test(r.path) && Number.isInteger(p.frames) && finite(p.frames,1,16);}
  case 'emission':return exact(p,['maxParticles','spreadDeg']) && Number.isInteger(p.maxParticles) && finite(p.maxParticles,1,1024) && finite(p.spreadDeg,0,180);
  case 'sprite':return exact(p,p.flow===undefined?['backend','blend']:['backend','blend','flow']) && (p.flow===undefined || record(p.flow) && exact(p.flow,['strength','speed']) && finite(p.flow.strength,0,.6) && finite(p.flow.speed,.1,8)) && ['cpu','gpu'].includes(p.backend as string) && ['alpha','additive'].includes(p.blend as string);
  case 'output':return exact(p,['key']) && typeof p.key==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(p.key);
  default:return exact(p,[]);
 }
}
/** Structural/type checking only; runtime owns evaluation and effect semantics. */
export function validateVfxGraph(value:unknown):string[] {
 if(!record(value))return ['VFX图必须是对象'];
 const errors:string[]=[],g=value as unknown as VfxGraph;
 if(Object.keys(value).some(k=>!['version','nodes','edges'].includes(k)))errors.push('VFX图包含非白名单字段');
 if(g.version!==1 && g.version!==VFX_GRAPH_VERSION)errors.push(`不支持VFX图版本 ${typeof g.version==='number'?g.version:'（必须为数字）'}`);
 if(!Array.isArray(g.nodes) || !g.nodes.length || g.nodes.length>VFX_GRAPH_BUDGET.nodes)return [...errors,'VFX图节点预算1–64'];
 if(!Array.isArray(g.edges) || g.edges.length>VFX_GRAPH_BUDGET.edges)return [...errors,'VFX图连线预算0–128'];
 const nodes=new Map<string,VfxGraphNode>(),keys=new Set<string>();let outputs=0;
 for(const n of g.nodes){
  if(!record(n) || !id(n.id)){errors.push('VFX图节点ID非法');continue;}
  if(Object.keys(n).some(k=>!['id','type','position','params'].includes(k)))errors.push(`节点 ${n.id}: 非白名单字段`);
  if(nodes.has(n.id))errors.push(`VFX图节点ID重复 ${n.id}`);nodes.set(n.id,n);
  if(!knownType(n.type)){errors.push(`节点 ${n.id}: 未知类型（必须为白名单字符串）`);continue;}
  if(!(g.version===1 && n.position===undefined) && (!Array.isArray(n.position) || n.position.length!==2 || !n.position.every(n=>finite(n,-10000,10000))))errors.push(`节点 ${n.id}: 画布位置非法`);
  if(!record(n.params) || !validParams(n.type,n.params))errors.push(`节点 ${n.id}: 参数非法或包含非白名单字段`);
  if(n.type==='output'){outputs++;const key=n.params?.key as string;if(keys.has(key))errors.push(`输出key重复 ${key}`);keys.add(key);}
 }
 if(!outputs || outputs>VFX_GRAPH_BUDGET.outputs)errors.push('VFX图输出预算1–8');
 const edgeIds=new Set<string>(),inputs=new Set<string>(),adj=new Map<string,string[]>(),indegree=new Map([...nodes.keys()].map(k=>[k,0]));
 for(const e of g.edges){
  if(!record(e) || !id(e.id) || !record(e.from) || !record(e.to) || typeof e.from.node!=='string' || typeof e.to.node!=='string' || typeof e.from.port!=='string' || typeof e.to.port!=='string'){errors.push('VFX图连线ID/端点非法');continue;}
  if(!exact(e,['id','from','to']) || !exact(e.from,['node','port']) || !exact(e.to,['node','port']))errors.push(`连线 ${e.id}: 非白名单字段`);
  if(edgeIds.has(e.id))errors.push(`连线ID重复 ${e.id}`);edgeIds.add(e.id);
  const from=nodes.get(e.from.node),to=nodes.get(e.to.node),outputs=from && knownType(from.type)?VFX_GRAPH_NODES[from.type].outputs:null,ports=to && knownType(to.type)?VFX_GRAPH_NODES[to.type].inputs:null;
  const a=outputs && Object.hasOwn(outputs,e.from.port)?outputs[e.from.port]:undefined,b=ports && Object.hasOwn(ports,e.to.port)?ports[e.to.port]:undefined;
  if(!a || !b){errors.push(`连线 ${e.id}: 未知节点/端口`);continue;}
  if(a!==b)errors.push(`连线 ${e.id}: 类型不匹配 ${a}→${b}`);
  const input=e.to.node+':'+e.to.port;if(inputs.has(input))errors.push(`节点 ${input}: 输入重复连接`);inputs.add(input);
  adj.set(e.from.node,[...(adj.get(e.from.node)??[]),e.to.node]);indegree.set(e.to.node,indegree.get(e.to.node)!+1);
 }
 for(const n of nodes.values())if(knownType(n.type))for(const port of Object.keys(VFX_GRAPH_NODES[n.type].inputs))if(!inputs.has(n.id+':'+port))errors.push(`节点 ${n.id}/${port}: 缺少输入`);
 const queue=[...indegree].filter(([,n])=>n===0).map(([k])=>k);let visited=0;
 while(queue.length){const key=queue.shift()!;visited++;for(const next of adj.get(key)??[]){const n=indegree.get(next)!-1;indegree.set(next,n);if(!n)queue.push(next);}}
 if(visited<nodes.size)errors.push('VFX图存在循环，必须为DAG');
 return errors;
}
export function validateVfxGraphAsset(value:unknown):string[] {
 if(!record(value))return ['VFX图资产必须是对象'];const errors=validateVfxGraph(value.graph);
 if(Object.keys(value).some(k=>!['version','id','name','status','graph'].includes(k)))errors.push('VFX图资产包含非白名单字段');
 if(value.version!==8)errors.unshift(`不支持VFX图资产版本 ${typeof value.version==='number'?value.version:'（必须为数字）'}`);
 if(typeof value.id!=='string' || !value.id || typeof value.name!=='string' || !value.name.trim())errors.push('VFX图资产缺少id/name');
 if(!['accepted','quarantined'].includes(value.status as string))errors.push('VFX图验收状态非法');
 if(Object.hasOwn(value,'effects'))errors.push('VFX图是唯一真源，禁止同时保存派生effects');
 return errors;
}
export function migrateVfxGraphAsset(value:unknown):VfxGraphAsset {
 const errors=validateVfxGraphAsset(value);if(errors.length)throw new Error(errors.join('；'));
 const next=structuredClone(value) as VfxGraphAsset;
 if(next.graph.version===1){for(const [i,n] of next.graph.nodes.entries())n.position??=[(i%4)*230,Math.floor(i/4)*180];next.graph.version=VFX_GRAPH_VERSION;}
 return next;
}
export function vfxGraphTextureRefs(asset:VfxGraphAsset):Array<AssetRef & {guid:string}>{return asset.graph.nodes.filter(n=>n.type==='texture').map(n=>n.params.ref as AssetRef & {guid:string});}
