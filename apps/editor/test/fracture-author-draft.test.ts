import {expect,it} from 'vitest';
import type {FractureAsset} from '@aether/scene';
import {fractureAuthorDraft} from '../src/services/fracture-author-draft';
const files=import.meta.glob('../../../assets/fracture/p01-barrel/*.fracture.json',{eager:true,import:'default'});
const source=()=>structuredClone(Object.values(files)[0]) as FractureAsset;
it('作者可改真实消费的分类/物理/播放参数，不改变离线制作配方和输入对象',()=>{
 const original=source(),draft=source();draft.playback.lifetimeSec=8;draft.playback.fadeSec=2;draft.playback.priority=3;
 draft.chunks[0]!.class='small';draft.chunks[0]!.proxy.mass=8;draft.chunks[0]!.proxy.maxLinearSpeed=3;
 const accepted=fractureAuthorDraft(draft,original);expect(accepted.playback.lifetimeSec).toBe(8);expect(accepted.chunks[0]!.class).toBe('small');expect(accepted.chunks[0]!.proxy.mass).toBe(8);expect(accepted).not.toBe(draft);expect(original).toEqual(source());
});
it.each(['source','assemblyScale','shape','chunkId','guid','runtime'] as const)('高级JSON不能悄悄重写只读离线配方：%s',field=>{
 const original=source(),draft=source();
 if(field==='source')draft.source.model.guid='as_other';
 if(field==='assemblyScale')draft.assemblyScale=2;
 if(field==='shape')draft.chunks[0]!.proxy.shape={type:'sphere',radius:1};
 if(field==='chunkId')draft.chunks[0]!.chunkId='renamed';
 if(field==='guid')draft.id='as_other';
 if(field==='runtime')(draft as unknown as Record<string,unknown>).runtime={gpu:'not author data'};
 expect(()=>fractureAuthorDraft(draft,original)).toThrow('只读');expect(original).toEqual(source());
});
