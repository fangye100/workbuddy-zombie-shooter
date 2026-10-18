import {it,expect} from 'vitest';
import {loadLevelRuntime,PlaySession} from '../src/index';
import type {SceneDocument} from '@aether/scene';
const modules=import.meta.glob('../../../assets/scenes/sandbox/vfx-m1.scene.json',{eager:true,import:'default'});
it('M1 authored acceptance scene can actually enter Play and ray-hit its finite wall',()=>{
 const doc=Object.values(modules)[0] as SceneDocument,loaded=loadLevelRuntime(doc);expect(loaded.diagnostics.filter(d=>d.severity==='error')).toEqual([]);
 const p=new PlaySession();expect(p.play(doc).ok).toBe(true);const s=p.runtime!;s.setAim(10,0);s.setFire(true);s.step();const contact=s.weaponCombat.drainVfxEvents().find(e=>e.kind==='trace');expect(contact?.contact).toBe('scene');expect(contact?.nodeId).toBe('nd_vfx_wall');expect(contact?.normal).toEqual([-1,0,0]);p.stop();expect(p.ledger.pending).toBe(0);
});
