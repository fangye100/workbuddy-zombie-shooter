import {it,expect} from 'vitest';
import {VfxGraphDocument} from '../src/services/vfx-graph-document';
import {sceneFingerprint} from '@aether/runtime';
import {graphFixture} from '../../../packages/scene/test/vfx-graph-fixture';

it('invalid link drafts stay undoable and cannot save derived/empty success; repair restores compilation',async()=>{
 const source=graphFixture(),d=new VfxGraphDocument('assets/vfx/graph.vfx.json',source),edge=structuredClone(source.graph.edges[0]!);
 d.edit(next=>{next.graph.edges.shift();});expect(d.dirty).toBe(true);expect(d.compilation.asset).toBeNull();let writes=0;
 await expect(d.save({write:async()=>{writes++;return {ok:true,status:200,error:null};}})).rejects.toThrow('保留草稿');expect(writes).toBe(0);expect(d.value.graph.edges).toHaveLength(8);
 d.undo();expect(d.dirty).toBe(false);expect(d.compilation.asset).not.toBeNull();d.redo();expect(d.compilation.asset).toBeNull();d.edit(next=>next.graph.edges.unshift(edge));expect(d.compilation.asset).not.toBeNull();
});
it('v1 graph migration keeps raw CAS and failed saves preserve drafts; successful saves only serialize source',async()=>{
 const raw=graphFixture();raw.graph.version=1;for(const node of raw.graph.nodes)delete (node as any).position;
 const original=structuredClone(raw),d=new VfxGraphDocument('assets/vfx/graph.vfx.json',raw);expect(d.sourceVersion).toBe(1);expect(d.value.graph.version).toBe(2);expect(raw).toEqual(original);
 d.edit(next=>{next.graph.nodes.find(n=>n.id==='rate')!.params.value=30;});
 await expect(d.save({write:async(_path,b)=>{expect(b.baseHash).toBe(sceneFingerprint(raw));return {ok:false,status:409,conflict:true,error:'conflict'};}})).rejects.toThrow('保留图草稿');expect(d.dirty).toBe(true);
 await d.save({write:async(_path,b)=>{expect(b.baseHash).toBe(sceneFingerprint(raw));const saved=JSON.parse(b.content!);expect(saved).not.toHaveProperty('effects');expect(saved.graph.version).toBe(2);return {ok:true,status:200,error:null};}});expect(d.dirty).toBe(false);
});
it('bad/future reload preserves existing draft and a validated reload restores the disk graph',async()=>{
 const raw=graphFixture(),d=new VfxGraphDocument('assets/vfx/graph.vfx.json',raw);d.edit(next=>{next.graph.nodes[0]!.params.frames=2;});const before=structuredClone(d.value);
 const future={...raw,version:99};await expect(d.reload({read:async()=>({ok:true,json:future,status:200,error:null})})).rejects.toThrow('版本');expect(d.value).toEqual(before);expect(d.dirty).toBe(true);
 await d.reload({read:async()=>({ok:true,json:raw,status:200,error:null})});expect(d.dirty).toBe(false);expect(d.value).toEqual(raw);
});
