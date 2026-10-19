import {it,expect} from 'vitest';
import {graphFixture} from './vfx-graph-fixture';
import {validateVfxAsset,migrateVfxAsset} from '../src/vfx';
import {validateVfxGraphAsset,migrateVfxGraphAsset,vfxGraphTextureRefs} from '../src/vfx-graph';

it('graph v1 layout migration is explicit, immutable and never serializes derived effects',()=>{
 const raw=graphFixture();raw.graph.version=1;for(const n of raw.graph.nodes)delete (n as any).position;
 const before=structuredClone(raw),next=migrateVfxGraphAsset(raw);expect(raw).toEqual(before);expect(next.graph.version).toBe(2);expect(next.graph.nodes.every(n=>n.position.length===2)).toBe(true);expect(next).not.toHaveProperty('effects');expect(validateVfxAsset(raw)).toEqual([]);expect(()=>migrateVfxAsset(raw)).toThrow('图编译器');
 for(const update of [(g:any)=>g.version=99,(g:any)=>g.graph.version=99,(g:any)=>g.effects={}]){const a=graphFixture();update(a);expect(validateVfxGraphAsset(a).length).toBeGreaterThan(0);}
});
it('malformed IDs, unknown nodes/ports, types, missing/repeated inputs and cycles are located diagnostics',()=>{
 expect(validateVfxGraphAsset(graphFixture())).toEqual([]);
 const changes=[(a:any)=>a.graph.nodes[0].type='script',(a:any)=>a.graph.nodes[0].params.code='alert(1)',(a:any)=>a.graph.nodes[0].id=a.graph.nodes[1].id,(a:any)=>a.graph.edges[0].from.port='absent',(a:any)=>a.graph.edges[0].from.node='absent',(a:any)=>a.graph.edges[0].from.node='size',(a:any)=>a.graph.edges.pop(),(a:any)=>a.graph.edges.push({...a.graph.edges[0],id:'duplicate'})];
 for(const change of changes){const a=graphFixture();change(a);expect(validateVfxGraphAsset(a).length).toBeGreaterThan(0);}
 const a=graphFixture();a.graph.nodes.push({id:'product',type:'multiply',position:[0,0],params:{}});a.graph.edges.push({id:'cycle',from:{node:'product',port:'value'},to:{node:'product',port:'a'}},{id:'constant',from:{node:'rate',port:'value'},to:{node:'product',port:'b'}});expect(validateVfxGraphAsset(a).some(s=>s.includes('循环'))).toBe(true);
});
it('graph budgets and malformed JSON-shaped data fail without throwing or repairing references',()=>{
 for(const value of [null,{},[],{graph:null},{version:8,graph:{version:2,nodes:[null],edges:[]}}])expect(()=>validateVfxGraphAsset(value)).not.toThrow();
 for(const change of [(a:any)=>a.graph.nodes.push(...Array.from({length:65},(_,i)=>({...a.graph.nodes[0],id:'n'+i}))),(a:any)=>a.graph.edges=Array(129).fill(a.graph.edges[0]),(a:any)=>a.graph.nodes[0].params.ref.guid='',(a:any)=>a.graph.nodes[1].params.value=[0,1],(a:any)=>a.graph.nodes[3].params.value=Infinity]){const a=graphFixture();change(a);expect(validateVfxGraphAsset(a).length).toBeGreaterThan(0);}
 const a=graphFixture(),ref=vfxGraphTextureRefs(a)[0];expect(ref).toEqual({path:'assets/vfx/smoke.svg',guid:'as_texture'});expect(a.graph.nodes[0]!.id).toBe('texture');
});
it('JSON inherited-property port names are unknown edges even in a complete otherwise valid DAG',()=>{
 for(const port of ['constructor','toString','__proto__']){
  const source=graphFixture();source.graph.edges.push({id:'inherited',from:{node:'texture',port},to:{node:'out',port}});
  const json=JSON.parse(JSON.stringify(source));expect(validateVfxGraphAsset(json).some(e=>e.includes('inherited') && e.includes('未知节点/端口'))).toBe(true);
  expect(json.graph.edges.at(-1).from.port).toBe(port);
 }
});
it('JSON non-string node types cannot coerce into whitelist keys or throw during validation',()=>{
 for(const type of [null,1,['number'],{toString:1},{}]){
  const source=JSON.parse(JSON.stringify(graphFixture()));source.graph.nodes[0].type=type;
  expect(()=>validateVfxGraphAsset(source)).not.toThrow();expect(validateVfxGraphAsset(source).some(s=>s.includes('未知类型'))).toBe(true);
 }
});
