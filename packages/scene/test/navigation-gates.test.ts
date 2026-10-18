import {describe,it,expect} from 'vitest';
import raw from '../../../assets/scenes/sandbox/dynamic-navigation-whitebox.scene.json';
import {validateSceneDocument,type SceneDocument} from '../src/document';
const fixture=()=>structuredClone(raw) as unknown as SceneDocument;
describe('NavigationGate 场景契约',()=>{
  it('合法门可序列化重载；拒绝不支持的形状、偏移、引用关系与旧平面模式',()=>{
    const doc=fixture();expect(validateSceneDocument(JSON.parse(JSON.stringify(doc))).filter(d=>d.severity==='error')).toEqual([]);
    const n=doc.nodes.find(n=>n.id==='nd_gate_ramp')!,gate=n.components.find(c=>c.kind==='NavigationGate')!,collider=n.components.find(c=>c.kind==='Collider')!;
    if(gate.kind!=='NavigationGate'||collider.kind!=='Collider')throw Error('fixture');
    gate.openOffset=[0,0,0];gate.travelSec=NaN;expect(validateSceneDocument(doc).some(d=>d.code==='E_NAV_GATE_SETTINGS')).toBe(true);
    gate.openOffset=[0,4,0];gate.travelSec=1.5;collider.shape={type:'sphere',radius:1};expect(validateSceneDocument(doc).some(d=>d.code==='E_NAV_GATE_COLLIDER')).toBe(true);
    n.parent='nd_nav3d_room';expect(validateSceneDocument(doc).some(d=>d.code==='E_NAV_GATE_HIERARCHY')).toBe(true);
    for(const n of doc.nodes)for(const c of n.components)if(c.kind==='NavZone')delete c.surface;expect(validateSceneDocument(doc).some(d=>d.code==='E_NAV_GATE_MODE')).toBe(true);
  });
});
