import { expect, it } from 'vitest';
import { VfxPool } from '../src/vfx';
import { WeaponCombat, type WeaponWorld } from '../src/weapon-combat';
import { legacyWeaponArsenal } from '@aether/scene';

const effect={kind:'impact' as const,texture:{path:'assets/vfx/a.svg',guid:'a'},frames:3,duration:.1,size:[1,1] as [number,number],color:'#ffffff',blend:'alpha' as const};
it('stable handles separate simulation lifetime from animation cycle and stop immediately',()=>{
 const p=new VfxPool(1),r={key:'run:attack:phase',effect,position:[0,0,0] as const,seed:1,priority:10,lifetime:1};expect(p.upsert(r,.2)).toBe(true);p.advance(.1);expect(p.active).toHaveLength(1);expect(p.upsert({...r,position:[2,0,0]},.4)).toBe(true);expect(p.active).toHaveLength(1);expect(p.stats.spawned).toBe(1);expect(p.active[0]!.position).toEqual([2,0,0]);p.stop(r.key);expect(p.active).toHaveLength(0);
});
it('bounded pool deduplicates, drops low priority and only advances on simulation dt',()=>{
  const p=new VfxPool(1),request={key:'1:1',effect,position:[0,0,0] as const,seed:1,priority:1};
  expect(p.spawn(request)).toBe(true);expect(p.spawn(request)).toBe(false);p.advance(0);expect(p.active).toHaveLength(1);
  expect(p.spawn({...request,key:'1:2'})).toBe(false);expect(p.stats.dropped).toBe(1);
  p.advance(.1);expect(p.active).toHaveLength(0);p.clear();expect(p.spawn(request)).toBe(true);
});
it('one fire per scatter shot, contacts copied before lethal mutation, events survive multi tick consumption',()=>{
  const w=legacyWeaponArsenal({magazineSize:12,reserveRounds:48,reloadSec:1}).definitions[0]!;w.behavior='pellets';w.pellets=3;
  const actor={id:3,generation:2,x:10,z:0,radius:.4,hp:1};
  const world:WeaponWorld={actors:()=>[actor],actor:()=>null,trace:()=>({actor,point:[9.6,1,0],distance:9.6,kind:'entity'}),blocked:()=>false,damage:()=>{actor.x=99;actor.hp=0;return 1;},displace:()=>{}};
  const c=new WeaponCombat(1);c.fire(w,[0,1,0],[1,0,0],1,1,world);c.step(2,.2,world);
  const events=c.drainVfxEvents();expect(events.filter(e=>e.kind==='fire')).toHaveLength(1);expect(events.filter(e=>e.kind==='trace')).toHaveLength(3);
  expect(events[1]!.actor!.x).toBe(10);expect(events[1]!.to).toEqual([9.6,1,0]);expect(Object.isFrozen(events[1]!.actor)).toBe(true);expect(c.drainVfxEvents()).toEqual([]);
});
