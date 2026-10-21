import { afterEach, expect, it, vi } from 'vitest';
import type { FractureAsset, SceneDocument } from '@aether/scene';
import type { RendererCore } from '@aether/render';
import type { FractureAssetIO } from '@aether/runtime';
import * as runtimeOwner from '@aether/runtime';
import { FracturePreview } from '../src/services/fracture-preview';

const json=import.meta.glob('../../../assets/fracture/p01-barrel/*.json',{eager:true,query:'?raw',import:'default'}) as Record<string,string>;
const metadata=import.meta.glob('../../../assets/environment/models/P-01/tex2/*.meta.json',{eager:true,query:'?raw',import:'default'}) as Record<string,string>;
const binary=import.meta.glob(['../../../assets/fracture/p01-barrel/*.glb','../../../assets/environment/models/P-01/tex2/*.glb'],{query:'?bytes',import:'default'}) as Record<string,()=>Promise<Uint8Array>>;
const scenes=import.meta.glob('../../../assets/scenes/sandbox/fracture-wu06.scene.json',{eager:true,import:'default'});
const P='assets/fracture/p01-barrel/p01-barrel.fracture.json';
function fixture(){
 const text=new Map(Object.entries({...json,...metadata}).map(([k,v])=>[k.replace(/^.*?(?=assets\/)/,''),v]));
 const bin=new Map(Object.entries(binary).map(([k,v])=>[k.replace(/^.*?(?=assets\/)/,''),v]));
 const io:FractureAssetIO={readText:async p=>{if(!text.has(p))throw new Error(p);return text.get(p)!;},readBinary:async p=>{const read=bin.get(p);if(!read)throw new Error(p);const a=await read();return a.buffer.slice(a.byteOffset,a.byteOffset+a.byteLength) as ArrayBuffer;}};
 const doc=structuredClone(Object.values(scenes)[0]) as SceneDocument,asset=JSON.parse(text.get(P)!) as FractureAsset;
 const core={dynamicBatchState:vi.fn(()=> 'ready'),releaseDynamicMeshesWithPrefix:vi.fn(),releaseDynamicOwner:vi.fn(),dynamicError:null} as unknown as RendererCore;
 const restore=vi.fn(),hide=vi.fn(()=>restore);
 vi.stubGlobal('createImageBitmap',async()=>({width:4,height:4,close:vi.fn()}));
 const preview=new FracturePreview(core,io,{hide});return {preview,io,doc,asset,core,text,hide,restore};
}
afterEach(()=>vi.unstubAllGlobals());
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,30));};
it('真实P01准备/3D大刚体/固定步/Pause/Stop，作者与游戏事实未变，旧World/lease实际退役',async()=>{
 const f=fixture(),before=JSON.stringify(f.doc);await f.preview.start(f.doc,'nd_fr_barrel',{path:P,guid:f.asset.id},f.asset,7);
 expect(f.preview.ready).toBe(true);expect(f.preview.snapshot().event?.position).toEqual([0,.9,0]);
 const binding=f.preview.resources!,runtime=binding.runtime,backend=binding.backend()!;
 await f.preview.trigger();const count=f.asset.chunks.length;expect(runtime.active).toHaveLength(count);expect(backend.ledger.dynamicBodies).toBe(f.asset.chunks.filter(c=>c.class==='large').length);
 for(let i=0;i<8;i++){await settle();f.preview.update(.1);}const tick=f.preview.tick;
 f.preview.update(.2);expect(f.preview.tick).toBe(tick);f.preview.step();expect(f.preview.tick).toBe(tick+1);
 expect(backend.ledger.ticks).toBe(1);expect(JSON.stringify(f.doc)).toBe(before);
 const handle=runtime.active[0]!.handle;f.preview.stop();expect(runtime.active).toHaveLength(0);expect(runtime.stats.poolActive).toBe(0);expect(backend.ledger.destroyed).toBe(true);expect(backend.snapshot(handle)).toBeNull();expect(f.core.releaseDynamicOwner).toHaveBeenCalled();
 f.preview.stop();expect(f.preview.ready).toBe(false);expect(JSON.stringify(f.doc)).toBe(before);
},30000);
it('外改隔离在World/GPU前拒绝并保留传入草稿；恢复后可正常开启',async()=>{
 const f=fixture(),draft=structuredClone(f.asset);draft.playback.lifetimeSec=9;
 const meta=JSON.parse(f.text.get(P+'.meta.json')!);f.text.set(P+'.meta.json',JSON.stringify({...meta,userData:{...meta.userData,status:'quarantined'}}));
 await expect(f.preview.start(f.doc,'nd_fr_barrel',{path:P,guid:draft.id},draft,7)).rejects.toThrow('隔离');expect(f.preview.resources).toBeNull();expect(f.preview.batches).toHaveLength(0);expect(draft.playback.lifetimeSec).toBe(9);
 f.text.set(P+'.meta.json',JSON.stringify(meta));await f.preview.start(f.doc,'nd_fr_barrel',{path:P,guid:draft.id},draft,7);expect(f.preview.ready).toBe(true);await f.preview.trigger();expect(f.preview.resources!.runtime.active.every(c=>c.lifetimeSec===9)).toBe(true);f.preview.stop();
},30000);
it('模型读取迟到跨Stop不装配World/批次，也不覆盖新预览诊断',async()=>{
 const f=fixture(),original=f.io.readBinary;let release!:(v:ArrayBuffer)=>void,entered!:(v:void)=>void;
 const waiting=new Promise<void>(resolve=>entered=resolve);f.io.readBinary=async path=>{const bytes=await original(path);if(path===f.asset.source.model.path){entered();return new Promise(resolve=>release=resolve).then(()=>bytes) as Promise<ArrayBuffer>;}return bytes;};
 const start=f.preview.start(f.doc,'nd_fr_barrel',{path:P,guid:f.asset.id},f.asset,7);await waiting;f.preview.stop();f.preview.diagnostic='new preview diagnostic';release(new ArrayBuffer(0));await start;
 expect(f.preview.ready).toBe(false);expect(f.preview.resources).toBeNull();expect(f.preview.batches).toHaveLength(0);expect(f.preview.diagnostic).toBe('new preview diagnostic');
},30000);

it.each(['profile','meta','source','chunk'] as const)('当前%s读取的迟到失败不污染重播的新World和诊断',async stage=>{
 const f=fixture(),readText=f.io.readText,readBinary=f.io.readBinary;
 let armed=false,intercepted=false,entered!:(v:void)=>void,reject!:(e:Error)=>void;
 const gate=new Promise<void>(resolve=>entered=resolve);
 const held=<T>(value:T):Promise<T>=>{intercepted=true;entered();return new Promise<T>((_resolve,r)=>reject=r);};
 const match=(path:string)=>stage==='profile'?path===P:stage==='meta'?path===P+'.meta.json':stage==='source'?path===f.asset.source.model.path:path===f.asset.chunks[0]!.mesh.path;
 f.io.readText=async path=>{const value=await readText(path);return armed&&!intercepted&&match(path)?held(value):value;};
 f.io.readBinary=async path=>{const value=await readBinary(path);return armed&&!intercepted&&match(path)?held(value):value;};
 // 所有迟到分支从完整真实预览触发准备，保留旧runtime/World引用；不是仅看页面清空。
 await f.preview.start(f.doc,'nd_fr_barrel',{path:P,guid:f.asset.id},f.asset,7);
 const old=f.preview.resources!,oldRuntime=old.runtime,oldBackend=old.backend()!;
 armed=true;const late=f.preview.trigger();await gate;f.preview.stop();
 await f.preview.start(f.doc,'nd_fr_barrel',{path:P,guid:f.asset.id},f.asset,9);
 const current=f.preview.resources!,currentBackend=current.backend()!;f.preview.diagnostic='new identity diagnostic';
 reject(new Error('old request rejected'));await late;
 expect(oldRuntime.disposed).toBe(true);expect(oldRuntime.stats.poolActive).toBe(0);expect(oldBackend.ledger.destroyed).toBe(true);
 expect(f.preview.resources).toBe(current);expect(currentBackend.ledger.destroyed).toBe(false);expect(f.preview.ready).toBe(true);expect(f.preview.diagnostic).toBe('new identity diagnostic');
 await f.preview.trigger();expect(current.runtime.active.length).toBe(f.asset.chunks.length);f.preview.stop();
},30000);

it.each([false,true])('真实World初始化后的ready通知迟到（失败=%s），跨Stop/重播不污染新代',async failed=>{
 const f=fixture(),bind=runtimeOwner.bindFractureToPlay;let entered!:(v:void)=>void,release!:(v:boolean)=>void,reject!:(e:Error)=>void;
 const reached=new Promise<void>(resolve=>entered=resolve);let old:ReturnType<typeof bind>|null=null;
 const spy=vi.spyOn(runtimeOwner,'bindFractureToPlay').mockImplementation((host,opts)=>{
   const b=bind(host,opts);old=b;
   const ready=b.ready.then(result=>{entered();return new Promise<boolean>((resolve,r)=>{release=resolve;reject=r;});});
   Object.defineProperty(b,'ready',{value:ready});return b;
 });
 try{
  const pending=f.preview.start(f.doc,'nd_fr_barrel',{path:P,guid:f.asset.id},f.asset,7);await reached;
  const oldBinding=old as unknown as ReturnType<typeof bind>,backend=oldBinding.backend()!,runtime=oldBinding.runtime;
  f.preview.stop();expect(backend.ledger.destroyed).toBe(true);expect(runtime.disposed).toBe(true);
  spy.mockRestore();await f.preview.start(f.doc,'nd_fr_barrel',{path:P,guid:f.asset.id},f.asset,8);
  const current=f.preview.resources;f.preview.diagnostic='new ready diagnostic';if(failed)reject(new Error('late ready failure'));else release(true);await pending;
  expect(f.preview.ready).toBe(true);expect(f.preview.resources).toBe(current);expect(f.preview.diagnostic).toBe('new ready diagnostic');
  await f.preview.trigger();expect(current!.runtime.active).toHaveLength(f.asset.chunks.length);f.preview.stop();
 }finally{spy.mockRestore();f.preview.stop();}
},30000);
