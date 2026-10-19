import {expect,it} from 'vitest';
import {SceneGraph,type SceneDocument} from '@aether/scene';
import {vfxAuthorAnchor} from '../src/services/vfx-author-anchor';
const sources=import.meta.glob('../../../assets/scenes/sandbox/vfx-m4-soft.scene.json',{eager:true,import:'default'});
it('authored Play and preview share world position/direction using the existing SceneGraph world TRS under scaled parent and rotated child',()=>{
 const doc=structuredClone(Object.values(sources)[0]) as SceneDocument,wall=doc.nodes.find(n=>n.id==='nd_vfx_wall')!,child=doc.nodes.find(n=>n.id==='nd_m4_soft_flame')!;wall.transform.scale=[2,3,4];child.parent=wall.id;child.transform.position=[1,2,3];child.transform.rotation=[0,0,Math.SQRT1_2,Math.SQRT1_2];const c=child.components.find(c=>c.kind==='VfxEmitter')!;if(c.kind!=='VfxEmitter')throw new Error('fixture');c.direction=[1,0,0];const graph=SceneGraph.fromDocument(doc),anchor=vfxAuthorAnchor(graph,child.id,c);expect(anchor.position).toEqual([6,7,16]);expect(anchor.direction[0]).toBeCloseTo(0,6);expect(anchor.direction[1]).toBeCloseTo(2,6);expect(anchor.normal[0]).toBeCloseTo(-3,6);expect(anchor.matrix).not.toBe(graph.worldMatrix(child.id));expect(c.direction).toEqual([1,0,0]);
});
