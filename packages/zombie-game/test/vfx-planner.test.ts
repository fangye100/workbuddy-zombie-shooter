import { expect,it } from 'vitest';
import { RuntimeSession,loadLevelRuntime } from '../src/index';
import { WeaponVfxPlanner,weaponMarkerWorld } from '../src/presentation/vfx-planner';
import type { SceneDocument,VfxAsset } from '@aether/scene';
const modules=import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json',{eager:true,import:'default'});
const assets=import.meta.glob('../../../assets/vfx/comic-pistol.vfx.json',{eager:true,import:'default'});
it('consumes all catchup ticks once, freezes paused TTL, restarts identity and shares visible marker coordinates',()=>{
  const doc=structuredClone(Object.values(modules)[0]) as SceneDocument;
  const session=new RuntimeSession({desc:loadLevelRuntime(doc).desc!,seed:1});
  const w=session.weapons.active,asset=Object.values(assets)[0] as VfxAsset;
  w.presentation.vfx={resource:{path:'assets/vfx/comic-pistol.vfx.json',guid:asset.id},muzzle:'comic-muzzle',trail:'comic-trail',impact:'comic-impact'};
  const p=new WeaponVfxPlanner();p.ready.set(w.id,asset);
  session.setFire(true);session.step();session.step();p.update(session);
  expect(p.pool.active.filter(v=>v.effect.kind==='muzzle')).toHaveLength(1);
  expect(p.pool.active.find(v=>v.effect.kind==='muzzle')!.position).toEqual(weaponMarkerWorld(session,'muzzle'));
  const age=p.pool.active[0]!.age;p.update(session);expect(p.pool.active[0]!.age).toBe(age);expect(p.pool.stats.spawned).toBeGreaterThanOrEqual(2);
  const count=p.pool.stats.spawned;p.update(session);expect(p.pool.stats.spawned).toBe(count);
  session.setFire(false);for(let i=0;i<8;i++)session.step();p.update(session);expect(p.pool.active).toHaveLength(0);
  session.reset();p.update(session);expect(p.pool.stats.spawned).toBe(0);
});

it('仅同局同tick同身份的GPU命中接管Canvas爆花，缺图或槽复用保留保底',()=>{
  const hitScenes=import.meta.glob('../../../assets/scenes/sandbox/vfx-m2-pounce.scene.json',{eager:true,import:'default'});
  const session=new RuntimeSession({desc:loadLevelRuntime(structuredClone(Object.values(hitScenes)[0]) as SceneDocument).desc!,seed:1});
  session.step();const target=session.view().find(e=>e.id!==session.playerEntityId)!;
  const w=session.weapons.active,asset=Object.values(assets)[0] as VfxAsset;
  w.presentation.vfx={resource:{path:'assets/vfx/comic-pistol.vfx.json',guid:asset.id},muzzle:'comic-muzzle',trail:'comic-trail',impact:'comic-impact'};
  const planner=new WeaponVfxPlanner();planner.ready.set(w.id,asset);
  session.setAim(target.x,target.z);session.setFire(true);
  for(let i=0;i<10 && !session.combatEvents.some(e=>e.slot===target.id);i++){session.step();planner.update(session);}
  const hit=session.combatEvents.find(e=>e.slot===target.id)!;expect(hit).toBeDefined();
  expect(planner.impactReady(hit,()=>true)).toBe(true);
  expect(planner.impactReady(hit,()=>false)).toBe(false);
  expect(planner.impactReady({...hit,generation:hit.generation+1},()=>true)).toBe(false);
  expect(planner.impactReady({...hit,runId:hit.runId+1},()=>true)).toBe(false);
  planner.clear();expect(planner.impactReady(hit,()=>true)).toBe(false);
});
