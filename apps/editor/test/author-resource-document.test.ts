import { expect, it } from 'vitest';
import { migrateFractureAsset, validateFractureAsset, type FractureAsset } from '@aether/scene';
import { sceneFingerprint } from '@aether/runtime';
import { AuthorResourceDocument } from '../src/services/author-resource-document';
const assets=import.meta.glob('../../../assets/fracture/p01-barrel/*.fracture.json',{eager:true,import:'default'});
const initial=()=>structuredClone(Object.values(assets)[0]) as FractureAsset;
const create=()=>new AuthorResourceDocument('assets/fracture/p01-barrel/p01-barrel.fracture.json',initial(),{label:'碎裂',validate:validateFractureAsset,migrate:migrateFractureAsset});
it('资产Apply/Undo/Redo持有不可变快照，坏数据与改GUID不改变已应用值或历史',()=>{
 const d=create(),next=initial();next.playback.lifetimeSec=7;d.apply(next);next.playback.lifetimeSec=99;
 expect(d.value.playback.lifetimeSec).toBe(7);d.undo();expect(d.value.playback.lifetimeSec).toBe(initial().playback.lifetimeSec);expect(d.dirty).toBe(false);d.redo();expect(d.value.playback.lifetimeSec).toBe(7);
 const history=d.undoDepth,before=JSON.stringify(d.value);const invalid=structuredClone(d.value);invalid.chunks[0]!.proxy.mass=-3;
 expect(()=>d.apply(invalid)).toThrow('代理');invalid.chunks[0]!.proxy.mass=2;invalid.id='other';expect(()=>d.apply(invalid)).toThrow('GUID');expect(d.undoDepth).toBe(history);expect(JSON.stringify(d.value)).toBe(before);
});
it('CAS冲突保留草稿与原baseline；保存中的新Apply仍为dirty，后续CAS使用真正已写snapshot',async()=>{
 const d=create(),first=initial();first.playback.lifetimeSec=7;d.apply(first);
 await expect(d.save({write:async()=>({ok:false,status:409,error:'external',conflict:true})})).rejects.toThrow('保留');expect(d.dirty).toBe(true);
 let release!:(r:{ok:boolean;status:number;error:null})=>void;
 const saving=d.save({write:async(_path,body)=>{expect(body.baseHash).toBe(sceneFingerprint(initial()));expect(JSON.parse(body.content!).playback.lifetimeSec).toBe(7);return new Promise(resolve=>release=resolve);}});
 const second=structuredClone(d.value);second.playback.lifetimeSec=8;d.apply(second);release({ok:true,status:200,error:null});await saving;expect(d.dirty).toBe(true);
 await d.save({write:async(_path,body)=>{expect(body.baseHash).toBe(sceneFingerprint(first));expect(JSON.parse(body.content!).playback.lifetimeSec).toBe(8);return {ok:true,status:200,error:null};}});expect(d.dirty).toBe(false);
});
it('reload先验证源身份/版本，拒绝时保持当前历史；明确有效重载才清历史',async()=>{
 const d=create(),next=initial();next.playback.priority=3;d.apply(next);const before=JSON.stringify(d.value);
 await expect(d.reload({read:async()=>({ok:true,status:200,json:{...initial(),version:999},error:null})})).rejects.toThrow('版本');expect(JSON.stringify(d.value)).toBe(before);expect(d.undoDepth).toBe(1);
 await expect(d.reload({read:async()=>({ok:true,status:200,json:{...initial(),id:'wrong'},error:null})})).rejects.toThrow('GUID');expect(d.dirty).toBe(true);
 await d.reload({read:async()=>({ok:true,status:200,json:initial(),error:null})});expect(d.dirty).toBe(false);expect(d.undoDepth).toBe(0);expect(d.redoDepth).toBe(0);
});
it('重载请求期间新的Apply不会被迟到磁盘响应覆盖，原历史与草稿保持可继续保存',async()=>{
 const d=create();let release!:(v:{ok:boolean;status:number;json:FractureAsset;error:null})=>void;
 const reload=d.reload({read:async()=>new Promise(resolve=>release=resolve)});
 const next=initial();next.playback.lifetimeSec=11;d.apply(next);release({ok:true,status:200,json:initial(),error:null});
 await expect(reload).rejects.toThrow('新');expect(d.value.playback.lifetimeSec).toBe(11);expect(d.undoDepth).toBe(1);expect(d.dirty).toBe(true);
});
