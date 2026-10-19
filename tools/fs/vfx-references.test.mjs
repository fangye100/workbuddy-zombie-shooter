import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rewriteResourcePaths,pathRewriter} from './resource-paths.mjs';
test('emitter asset rename preserves GUID/key/seed and future scenes refuse rewriting',()=>{
 const binding={kind:'VfxEmitter',enabled:true,playing:true,resource:{path:'assets/vfx/old.vfx.json',guid:'as_keep'},effectKey:'smoke',seed:7,direction:[0,1,0]},doc={schemaVersion:17,nodes:[{id:'nd_emitter',components:[binding]}]};
 assert.equal(rewriteResourcePaths(doc,'scene',pathRewriter('assets/vfx/old.vfx.json','assets/vfx/new.vfx.json',false),17),true);
 assert.deepEqual(binding.resource,{path:'assets/vfx/new.vfx.json',guid:'as_keep'});assert.equal(binding.effectKey,'smoke');assert.equal(binding.seed,7);
 assert.throws(()=>rewriteResourcePaths({...doc,schemaVersion:18},'scene',x=>x,17));
});
test('v18 motion coordinates remain unchanged when the typed emitter resource moves',()=>{const motion={points:[[0,0,0],[1,0,1]],seconds:2,loop:true},component={kind:'VfxEmitter',resource:{path:'assets/vfx/old.vfx.json',guid:'as_keep'},motion:structuredClone(motion)},doc={schemaVersion:18,nodes:[{id:'stable_node',components:[component]}]};assert.equal(rewriteResourcePaths(doc,'scene',pathRewriter('assets/vfx/old.vfx.json','assets/vfx/new.vfx.json',false),18),true);assert.deepEqual(component.motion,motion);assert.equal(component.resource.guid,'as_keep');assert.equal(doc.nodes[0].id,'stable_node');});
test('v19 projector typed resource rename preserves receiver identities and layer mask',()=>{const c={kind:'VfxDecal',resource:{path:'assets/vfx/old.vfx.json',guid:'as_keep'},receivers:['node_wall','node_step'],layerMask:5},doc={schemaVersion:19,nodes:[{id:'node_projector',components:[c]}]};assert.equal(rewriteResourcePaths(doc,'scene',pathRewriter('assets/vfx/old.vfx.json','assets/vfx/new.vfx.json',false),19),true);assert.equal(c.resource.guid,'as_keep');assert.deepEqual(c.receivers,['node_wall','node_step']);assert.equal(c.layerMask,5);});
