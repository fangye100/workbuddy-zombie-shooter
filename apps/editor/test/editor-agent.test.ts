import { describe, it, expect, vi } from 'vitest';
import { createEmptySceneDocument } from '@aether/scene';
import { SpawnEditStore, newAuthorNode, sceneFingerprint } from '@aether/runtime';
import { EditorAgent, type EditorAgentPort } from '../src/services/editor-agent';

function setup() {
  const doc=createEmptySceneDocument('Agent test');doc.nodes=[];doc.entryCamera=null;
  const store=new SpawnEditStore(doc);
  const port:EditorAgentPort={store:()=>store,path:()=> 'assets/scenes/test.scene.json',busy:()=>false,draft:()=>false,playing:()=>false,pendingAssets:()=>0,
    open:vi.fn(),rebuild:vi.fn(async()=>{}),environmentChanged:vi.fn(),capture:async()=> 'png',
    history:async redo=>{const edit=redo?store.redo():store.undo();return {ok:!!edit,edit,error:edit?null:'empty'};},
    save:async()=>({ok:false,status:'conflict',message:'disk changed',diffCount:1}),play:vi.fn(),runtime:()=>({state:'stopped'})};
  const agent=new EditorAgent(port);
  const edit=(name:string,args:Record<string,unknown>={})=>agent.call(name,{expectedRevision:sceneFingerprint(store.document),...args});
  return {agent,port,store,edit};
}
describe('Game Editor agent commands',()=>{
  it('rejects stale revisions, human drafts and Play mutations without touching history',async()=>{
    const s=setup(),node=newAuthorNode('nd_agent','Agent');
    expect((await s.edit('scene_edit_nodes',{expectedRevision:'stale',operations:[{op:'add',nodeId:node.id,node}]})).code).toBe('REVISION_CONFLICT');
    s.port.draft=()=>true;
    expect((await s.edit('scene_edit_nodes',{operations:[{op:'add',nodeId:node.id,node}]})).code).toBe('UI_DRAFT');
    s.port.draft=()=>false;s.port.playing=()=>true;
    expect((await s.edit('scene_edit_nodes',{operations:[{op:'add',nodeId:node.id,node}]})).code).toBe('PLAY_LOCKED');
    expect(s.store.undoDepth).toBe(0);
  });
  it('batches by stable NodeId atomically and shares undo/redo',async()=>{
    const s=setup(),a=newAuthorNode('nd_a','A'),b={...newAuthorNode('nd_b','B'),parent:'nd_a'};
    expect((await s.edit('scene_edit_nodes',{operations:[{op:'add',nodeId:a.id,node:a},{op:'add',nodeId:b.id,node:b}]})).ok).toBe(true);
    expect(s.store.undoDepth).toBe(1);expect(s.store.document.nodes.map(n=>n.id)).toEqual(['nd_a','nd_b']);
    const before=structuredClone(s.store.document);
    expect((await s.edit('scene_edit_nodes',{operations:[{op:'remove',nodeId:'nd_a'}]})).ok).toBe(false);
    expect(s.store.document).toEqual(before);
    expect((await s.edit('scene_history',{action:'undo'})).ok).toBe(true);expect(s.store.document.nodes).toEqual([]);
    expect((await s.edit('scene_history',{action:'redo'})).ok).toBe(true);expect(s.store.document).toEqual(before);
    expect((await s.edit('scene_edit_nodes',{operations:[{op:'remove',nodeId:'nd_a',cascade:true}]})).ok).toBe(true);
    expect(s.store.document.nodes).toEqual([]);
  });
  it('does not partially apply a batch when a later operation is invalid',async()=>{
    const s=setup(),node=newAuthorNode('nd_a','A');
    const r=await s.edit('scene_edit_nodes',{operations:[{op:'add',nodeId:node.id,node},{op:'remove',nodeId:'missing'}]});
    expect(r.ok).toBe(false);expect(s.store.document.nodes).toEqual([]);expect(s.store.undoDepth).toBe(0);
  });
  it('validates environment and exposes disk-save conflicts as structured results',async()=>{
    const s=setup(),environment=structuredClone(s.store.document.environment);environment.exposure=0.8;
    expect((await s.edit('scene_set_environment',{environment})).ok).toBe(true);
    expect(s.port.environmentChanged).toHaveBeenCalledOnce();
    expect((await s.edit('scene_set_environment',{environment:{...environment,sky:{cloudCoverage:4}}})).ok).toBe(false);
    expect((await s.edit('scene_save')).code).toBe('CONFLICT');expect(s.store.dirty).toBe(true);
  });
  it('reports post-edit projection failure without pretending the document was rolled back',async()=>{
    const s=setup(),node=newAuthorNode('nd_a','A');s.port.rebuild=async()=>{throw new Error('asset unavailable');};
    const r=await s.edit('scene_edit_nodes',{operations:[{op:'add',nodeId:node.id,node}]});
    expect(r.ok).toBe(false);expect(r.message).toContain('asset unavailable');expect(s.store.dirty).toBe(true);
    expect((r.state as {revision:string}).revision).toBe(sceneFingerprint(s.store.document));
  });
  it('keeps capture and diagnostics read-only and rejects unsupported commands',async()=>{
    const s=setup();expect((await s.agent.call('editor_capture',{})).image).toEqual({data:'png'});
    expect((await s.agent.call('scene_validate',{})).valid).toBe(true);
    expect((await s.edit('eval',{code:'anything'})).code).toBe('UNKNOWN_TOOL');
    expect((await s.edit('editor_play',{action:'step',steps:601})).code).toBe('INVALID_ARGUMENTS');
    expect(s.store.undoDepth).toBe(0);
  });
});
