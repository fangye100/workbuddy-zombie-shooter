import {describe,it,expect} from 'vitest';import raw from '../../../assets/scenes/sandbox/procedural-decal-whitebox.scene.json';
import {validateSceneDocument,type SceneDocument} from '../src/document';import {migrateToLatest} from '../src/migrate';
const fixture=()=>structuredClone(raw) as unknown as SceneDocument;
describe('持久化程序贴花契约',()=>{
  it('v18 迁移不造内容、不改输入，JSON重载保留稳定接收节点和种子',()=>{
    const d=fixture();d.schemaVersion=18;const before=structuredClone(d),r=migrateToLatest(d);expect(r.applied).toEqual(['procedural-surface-decals']);expect(d).toEqual(before);expect(r.doc.schemaVersion).toBe(19);
    expect(validateSceneDocument(JSON.parse(JSON.stringify(r.doc))).filter(d=>d.severity==='error')).toEqual([]);
  });
  it('错误图案、变换、透明度、重复 id、非静态接收者及超容量显式拒绝',()=>{
    const d=fixture(),n=d.nodes.find(n=>n.id==='nd_nav3d_low')!,c=n.components.find(c=>c.kind==='Decal')!;if(c.kind!=='Decal')throw Error('fixture');
    c.marks[0]!.size=[0,1];c.marks[0]!.rotation=[0,0,0,0];c.marks[0]!.opacity=NaN;expect(validateSceneDocument(d).some(d=>d.code==='E_DECAL_MARK')).toBe(true);
    c.marks=[...c.marks,...c.marks];expect(validateSceneDocument(d).some(d=>d.code==='E_DECAL_ID')).toBe(true);
    n.components=n.components.filter(c=>c.kind!=='MeshRenderer');expect(validateSceneDocument(d).some(d=>d.code==='E_DECAL_RECEIVER')).toBe(true);
    c.marks=Array.from({length:513},(_,i)=>({...c.marks[0]!,id:`m${i}`}));expect(validateSceneDocument(d).some(d=>d.code==='E_DECAL_CAPACITY')).toBe(true);
  });
});
