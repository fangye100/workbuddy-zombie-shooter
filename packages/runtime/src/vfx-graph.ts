import {migrateVfxGraphAsset,validateVfxAsset,VFX_VERSION,VFX_GRAPH_BUDGET,type VfxAsset,type VfxEffectDefinition,type VfxGraphAsset} from '@aether/scene';

/** Pure bounded DAG evaluation. Only transient effects are emitted; no persistent cache or script. */
export function compileVfxGraph(source:unknown):{asset:VfxAsset|null;diagnostics:string[]} {
 let input:VfxGraphAsset;try{input=migrateVfxGraphAsset(source);}catch(error){return {asset:null,diagnostics:[String(error)]};}
 const nodes=new Map(input.graph.nodes.map(n=>[n.id,n])),values=new Map<string,unknown>(),visiting=new Set<string>();
 const read=(id:string,port:string)=>{const edge=input.graph.edges.find(e=>e.to.node===id && e.to.port===port)!;return evaluate(edge.from.node);};
 const evaluate=(id:string):unknown=>{
  if(values.has(id))return values.get(id);if(visiting.has(id))throw new Error('VFX图循环');visiting.add(id);
  const n=nodes.get(id)!,p=n.params;let v:unknown;
  switch(n.type){
   case 'number':case 'size':case 'color':v=structuredClone(p.value);break;
   case 'texture':v={texture:structuredClone(p.ref),frames:p.frames};break;
   case 'multiply':{const a=read(id,'a') as number,b=read(id,'b') as number;v=a*b;if(!Number.isFinite(v) || Math.abs(v as number)>2400)throw new Error(`节点 ${id}: 乘积超出数值预算±2400`);break;}
   case 'appearance':v={...read(id,'texture') as object,size:read(id,'size'),color:read(id,'color'),duration:read(id,'duration')};break;
   case 'emission':v={rate:read(id,'rate'),speed:read(id,'speed'),maxParticles:p.maxParticles,spreadDeg:p.spreadDeg};break;
   case 'sprite':v={...read(id,'appearance') as object,kind:'sprite',orientation:'camera',loop:true,backend:p.backend,blend:p.blend,emission:read(id,'emission')};break;
   case 'output':v=read(id,'effect');break;
  }
  visiting.delete(id);values.set(id,v);return v;
 };
 try{
  // Evaluate disconnected nodes too: invalid arithmetic cannot hide outside the rendered output.
  for(const n of input.graph.nodes)evaluate(n.id);
  const effects:Record<string,VfxEffectDefinition>={};let total=0;
  for(const n of input.graph.nodes)if(n.type==='output'){const effect=evaluate(n.id) as VfxEffectDefinition;effects[n.params.key as string]=structuredClone(effect);total+=effect.emission?.maxParticles??0;}
  const asset:VfxAsset={version:VFX_VERSION,id:input.id,name:input.name,status:input.status,effects},diagnostics=validateVfxAsset(asset);
  if(total>VFX_GRAPH_BUDGET.totalParticles)diagnostics.push('VFX图输出粒子总预算超过4096');
  return {asset:diagnostics.length?null:asset,diagnostics};
 }catch(error){return {asset:null,diagnostics:[String(error)]};}
}
