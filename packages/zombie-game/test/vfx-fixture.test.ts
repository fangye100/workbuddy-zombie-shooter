import {it,expect} from 'vitest';
import {loadLevelRuntime,PlaySession} from '../src/index';
import type {SceneDocument} from '@aether/scene';
const modules=import.meta.glob('../../../assets/scenes/sandbox/vfx-m1.scene.json',{eager:true,import:'default'});
it('M1 authored acceptance scene can actually enter Play and ray-hit its finite wall',()=>{
 const doc=Object.values(modules)[0] as SceneDocument,loaded=loadLevelRuntime(doc);expect(loaded.diagnostics.filter(d=>d.severity==='error')).toEqual([]);
 const p=new PlaySession();expect(p.play(doc).ok).toBe(true);const s=p.runtime!;s.setAim(10,0);s.setFire(true);s.step();const contact=s.weaponCombat.drainVfxEvents().find(e=>e.kind==='trace');expect(contact?.contact).toBe('scene');expect(contact?.nodeId).toBe('nd_vfx_wall');expect(contact?.normal).toEqual([-1,0,0]);p.stop();expect(p.ledger.pending).toBe(0);
});
it('a wall between weapon mount and muzzle still produces one fire and immutable contact facts',()=>{
 const doc=structuredClone(Object.values(modules)[0]) as SceneDocument,wall=doc.nodes.find(n=>n.id==='nd_vfx_wall')!;wall.transform.position[0]=.2;
 const p=new PlaySession();expect(p.play(doc).ok).toBe(true);const s=p.runtime!;s.setAim(10,0);s.setFire(true);s.step();const events=s.weaponCombat.drainVfxEvents();expect(events.filter(e=>e.kind==='fire')).toHaveLength(1);expect(events.find(e=>e.kind==='trace')?.nodeId).toBe('nd_vfx_wall');p.stop();
});
