import {it,expect} from 'vitest';
import {compileVfxGraph} from '../src/vfx-graph';
import {VfxEmitters} from '../src/vfx-emitter';
import {VfxPool} from '../src/vfx';
import {graphFixture} from '../../scene/test/vfx-graph-fixture';

it('typed DAG produces existing playable emitter data; parameter/link changes change actual emitted particles',()=>{
 const source=graphFixture(),before=structuredClone(source),compiled=compileVfxGraph(source);expect(compiled.diagnostics).toEqual([]);expect(source).toEqual(before);expect(compiled.asset).not.toHaveProperty('graph');
 const effect=compiled.asset!.effects.smoke!;expect(effect.color).toBe('#ffaa33');expect(effect.emission?.rate).toBe(20);
 const pool=new VfxPool(),emit=new VfxEmitters(pool);for(let tick=0;tick<15;tick++)emit.update('graph',effect,{position:[0,0,0],direction:[0,1,0]},tick,1/30,7);expect(pool.active.length).toBe(10);
 source.graph.edges.find(e=>e.to.node==='emit' && e.to.port==='rate')!.from.node='speed';expect(compileVfxGraph(source).asset!.effects.smoke!.emission!.rate).toBe(2);
 source.graph.nodes.find(n=>n.id==='color')!.params.value='#33aaff';expect(compileVfxGraph(source).asset!.effects.smoke!.color).toBe('#33aaff');
});
it('arithmetic and final effect semantics enforce finite/backend/aggregate budgets and report errors',()=>{
 const source=graphFixture();source.graph.nodes.push({id:'product',type:'multiply',params:{},position:[0,0]});source.graph.edges.push({id:'a',from:{node:'rate',port:'value'},to:{node:'product',port:'a'}},{id:'b',from:{node:'rate',port:'value'},to:{node:'product',port:'b'}});expect(compileVfxGraph(source).diagnostics).toEqual([]);
 source.graph.nodes.find(n=>n.id==='rate')!.params.value=100;expect(compileVfxGraph(source).diagnostics.join()).toContain('乘积');
 const invalid=graphFixture();invalid.graph.nodes.find(n=>n.id==='duration')!.params.value=0;expect(compileVfxGraph(invalid).asset).toBeNull();
 invalid.graph.nodes.find(n=>n.id==='duration')!.params.value=1;invalid.graph.nodes.find(n=>n.id==='emit')!.params.maxParticles=1024;expect(compileVfxGraph(invalid).asset).toBeNull();invalid.graph.nodes.find(n=>n.id==='sprite')!.params.backend='gpu';expect(compileVfxGraph(invalid).asset).not.toBeNull();
 for(let i=0;i<4;i++){invalid.graph.nodes.push({id:'out'+i,type:'output',position:[0,0],params:{key:'extra-'+i}});invalid.graph.edges.push({id:'extra'+i,from:{node:'sprite',port:'value'},to:{node:'out'+i,port:'effect'}});}expect(compileVfxGraph(invalid).diagnostics.join()).toContain('总预算');
});
