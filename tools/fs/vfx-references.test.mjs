import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rewriteResourcePaths,pathRewriter} from './resource-paths.mjs';
import {renameProject} from './rename-project.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
test('emitter asset rename preserves GUID/key/seed and future scenes refuse rewriting',()=>{
 const binding={kind:'VfxEmitter',enabled:true,playing:true,resource:{path:'assets/vfx/old.vfx.json',guid:'as_keep'},effectKey:'smoke',seed:7,direction:[0,1,0]},doc={schemaVersion:17,nodes:[{id:'nd_emitter',components:[binding]}]};
 assert.equal(rewriteResourcePaths(doc,'scene',pathRewriter('assets/vfx/old.vfx.json','assets/vfx/new.vfx.json',false),17),true);
 assert.deepEqual(binding.resource,{path:'assets/vfx/new.vfx.json',guid:'as_keep'});assert.equal(binding.effectKey,'smoke');assert.equal(binding.seed,7);
 assert.throws(()=>rewriteResourcePaths({...doc,schemaVersion:18},'scene',x=>x,17));
});
test('v18 motion coordinates remain unchanged when the typed emitter resource moves',()=>{const motion={points:[[0,0,0],[1,0,1]],seconds:2,loop:true},component={kind:'VfxEmitter',resource:{path:'assets/vfx/old.vfx.json',guid:'as_keep'},motion:structuredClone(motion)},doc={schemaVersion:18,nodes:[{id:'stable_node',components:[component]}]};assert.equal(rewriteResourcePaths(doc,'scene',pathRewriter('assets/vfx/old.vfx.json','assets/vfx/new.vfx.json',false),18),true);assert.deepEqual(component.motion,motion);assert.equal(component.resource.guid,'as_keep');assert.equal(doc.nodes[0].id,'stable_node');});
test('v19 projector typed resource rename preserves receiver identities and layer mask',()=>{const c={kind:'VfxDecal',resource:{path:'assets/vfx/old.vfx.json',guid:'as_keep'},receivers:['node_wall','node_step'],layerMask:5},doc={schemaVersion:19,nodes:[{id:'node_projector',components:[c]}]};assert.equal(rewriteResourcePaths(doc,'scene',pathRewriter('assets/vfx/old.vfx.json','assets/vfx/new.vfx.json',false),19),true);assert.equal(c.resource.guid,'as_keep');assert.deepEqual(c.receivers,['node_wall','node_step']);assert.equal(c.layerMask,5);});

test('graph texture rename journals source and matching digest while retaining stable node/ref identities',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vfx-graph-rename-'));
 try{
  const dir=path.join(root,'assets/vfx');await fs.mkdir(dir,{recursive:true});
  const graph={version:8,id:'as_graph',graph:{version:2,nodes:[{id:'stable_texture',type:'texture',params:{ref:{path:'assets/vfx/old.svg',guid:'as_texture'},frames:1},position:[10,20]}],edges:[]}};
  await fs.writeFile(path.join(dir,'old.svg'),'<svg/>');await fs.writeFile(path.join(dir,'old.svg.meta.json'),JSON.stringify({kind:'texture',guid:'as_texture'}));
  const asset=path.join(dir,'graph.vfx.json');await fs.writeFile(asset,JSON.stringify(graph));await fs.writeFile(asset+'.meta.json',JSON.stringify({kind:'vfx',guid:'as_graph',sourceHash:'old',userData:{keep:true}}));
  const result=await renameProject(root,path.join(dir,'old.svg'),path.join(dir,'new.svg'),false,19);assert.equal(result.ok,true);
  const text=await fs.readFile(asset,'utf8'),next=JSON.parse(text),meta=JSON.parse(await fs.readFile(asset+'.meta.json','utf8'));
  assert.deepEqual(next.graph.nodes[0],{...graph.graph.nodes[0],params:{ref:{path:'assets/vfx/new.svg',guid:'as_texture'},frames:1}});assert.equal(meta.sourceHash,'sha256:'+createHash('sha256').update(text).digest('hex'));assert.equal(meta.userData.keep,true);
  next.graph.version=99;await fs.writeFile(asset,JSON.stringify(next));await assert.rejects(renameProject(root,path.join(dir,'new.svg'),path.join(dir,'future.svg'),false,19),/未来图版本/);assert.equal(await fs.readFile(path.join(dir,'new.svg'),'utf8'),'<svg/>');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
