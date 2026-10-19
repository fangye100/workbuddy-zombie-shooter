import {beforeEach,it,expect,vi} from 'vitest';
import {graphFixture} from '../../../packages/scene/test/vfx-graph-fixture';
import {VfxGraphDocument} from '../src/services/vfx-graph-document';
import {VfxGraphPreview} from '../src/services/vfx-graph-preview';
import {readVfxAsset} from '../src/services/vfx-assets';
import {readProjectFile} from '../src/asset-util';
const allocations=vi.hoisted(()=>({created:0,destroyed:0}));
vi.mock('../src/asset-util',()=>({readProjectFile:vi.fn(),fileUrl:(p:string)=>p}));
vi.mock('../src/services/vfx-assets',async original=>({...await original<typeof import('../src/services/vfx-assets')>(),readVfxTexture:vi.fn(async()=>({close(){}}))}));
vi.mock('../src/services/vfx-author-anchor',()=>({vfxAuthorAnchor:()=>({position:[0,0,0],direction:[0,1,0]})}));
vi.mock('@aether/render',()=>({VfxPass:class {
 stats={buffers:2,textures:0,destroyedBuffers:0,destroyedTextures:0};constructor(){allocations.created++;}
 addTexture(){this.stats.textures++;}destroy(){allocations.destroyed++;this.stats.destroyedBuffers=2;this.stats.destroyedTextures=this.stats.textures;this.stats.buffers=this.stats.textures=0;}
}}));
const ref={path:'assets/vfx/graph.vfx.json',guid:'as_graph'};
let source=graphFixture(),meta:{guid:string;kind:string;userData:{status:string}},hold:((v:any)=>void)|undefined,delay=false;
beforeEach(()=>{source=graphFixture();meta={guid:ref.guid,kind:'vfx',userData:{status:'accepted'}};delay=false;hold=undefined;allocations.created=allocations.destroyed=0;vi.mocked(readProjectFile).mockImplementation(async path=>path.endsWith('.meta.json') && delay?await new Promise(resolve=>{hold=resolve;}):({ok:true,json:structuredClone(path.endsWith('.meta.json')?meta:source),status:200,error:null}));});
const doc=()=>({nodes:[{id:'author',name:'author',parent:null,transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},components:[{kind:'VfxEmitter',resource:ref,effectKey:'smoke',direction:[0,1,0],seed:7}]}]}) as any;
it('disk playback and graph preview recheck the same current sidecar admission, retaining the editable draft',async()=>{
 const model=new VfxGraphDocument(ref.path,source);model.edit(a=>{a.graph.nodes.find(n=>n.id==='rate')!.params.value=30;});const before=structuredClone(model.value),core={vfx:null,device:{}},preview=new VfxGraphPreview(core as any);
 meta.userData.status='quarantined';await expect(readVfxAsset(ref)).rejects.toThrow('被隔离');await expect(preview.start(model.compilation.asset!,ref,doc(),'author','smoke',true)).rejects.toThrow('被隔离');
 expect(allocations.created).toBe(0);expect(core.vfx).toBeNull();expect(model.value).toEqual(before);expect(model.dirty).toBe(true);
 meta.userData.status='accepted';await preview.start(model.compilation.asset!,ref,doc(),'author','smoke',true);expect(preview.ready).toBe(true);expect(allocations.created).toBe(1);preview.stop();expect(allocations.destroyed).toBe(1);
 meta.guid='as_wrong';await expect(preview.start(model.compilation.asset!,ref,doc(),'author','smoke',true)).rejects.toThrow('GUID');expect(allocations.created).toBe(1);
});
it('Stop during source metadata await cannot allocate or replace a newer preview when the old read completes',async()=>{
 const core={vfx:null,device:{}},preview=new VfxGraphPreview(core as any),asset=new VfxGraphDocument(ref.path,source).compilation.asset!;delay=true;
 const old=preview.start(asset,ref,doc(),'author','smoke',true);await vi.waitFor(()=>expect(hold).toBeDefined());const resume=hold!;preview.stop();delay=false;
 await preview.start(asset,ref,doc(),'author','smoke',true);const current=core.vfx;resume({ok:true,json:structuredClone(meta),status:200,error:null});await old;
 expect(allocations.created).toBe(1);expect(core.vfx).toBe(current);expect(preview.ready).toBe(true);preview.stop();expect(allocations.destroyed).toBe(1);
});
it('project-file preview working copies share admission without relaxing persisted asset references or legacy playback',async()=>{
 const core={vfx:null,device:{}},preview=new VfxGraphPreview(core as any),asset=new VfxGraphDocument(ref.path,source).compilation.asset!,working={...ref,path:'.workbuddy/tmp/test/graph.vfx.json'};
 await preview.start(asset,working,doc(),'author','smoke',true);expect(preview.ready).toBe(true);preview.stop();await expect(readVfxAsset(working)).rejects.toThrow('引用');
 source={version:1,id:ref.guid,name:'legacy',status:'accepted',effects:{smoke:{kind:'impact',texture:{path:'assets/vfx/smoke.svg',guid:'as_texture'},frames:1,duration:.2,size:[.4,.4],color:'#ffffff',blend:'alpha'}}} as any;
 expect((await readVfxAsset(ref)).effects.smoke!.kind).toBe('impact');meta.userData.status='quarantined';await expect(readVfxAsset(ref)).rejects.toThrow('隔离');
});
