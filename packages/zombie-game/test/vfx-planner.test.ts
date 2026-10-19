import { expect,it } from 'vitest';
import { RuntimeSession,loadLevelRuntime } from '../src/index';
import { WeaponVfxPlanner,weaponMarkerWorld } from '../src/presentation/vfx-planner';
import type { SceneDocument,VfxAsset } from '@aether/scene';
const modules=import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json',{eager:true,import:'default'});
const assets=import.meta.glob('../../../assets/vfx/comic-pistol.vfx.json',{eager:true,import:'default'});
it('burn damage keeps authoritative damage/numbers without repeated bursts, while direct and unmarked hits retain drawable fallback',()=>{
 const r=new RuntimeSession({desc:loadLevelRuntime(structuredClone(Object.values(modules)[0]) as SceneDocument).desc!,seed:1}),p=new WeaponVfxPlanner(),target=r.view().find(e=>e.kind==='npc')!;
 p.damageEffect=(Object.values(assets)[0] as VfxAsset).effects['npc-hit']!;
 for(let i=0;i<6;i++)r.applyDamage(target.id,.2,r.playerEntityId,{weaponId:'flame',damageKind:'burn'});p.update(r);
 expect(r.combatEvents).toHaveLength(6);expect(r.combatEvents.every(e=>e.damageKind==='burn' && e.amount===.2)).toBe(true);expect(p.pool.active).toHaveLength(0);expect(p.damageStats.spawned).toBe(0);expect(p.impactReady(r.combatEvents[0]!,()=>true)).toBe(false);
 r.applyDamage(target.id,1,r.playerEntityId,{weaponId:'pistol'});p.update(r);const direct=r.combatEvents.at(-1)!;expect(p.impactReady(direct,()=>true)).toBe(true);expect(p.impactReady(direct,()=>false)).toBe(false);
 p.clear();p.damageEffect=(Object.values(assets)[0] as VfxAsset).effects['npc-hit']!;p.update(r,()=>false);expect(p.damageStats.fallback).toBeGreaterThan(0);expect(p.impactReady(direct,()=>true)).toBe(false);
});
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
  expect(hit.weaponId).toBe(w.id);expect(hit.weaponEvent).toBeTypeOf('number');
  expect(planner.impactReady(hit,()=>true)).toBe(true);
  const {weaponEvent:_primary,...withoutPrimary}=hit;expect(planner.impactReady({...withoutPrimary,damageKind:'burn'},()=>true)).toBe(false);
  expect(planner.impactReady(hit,()=>false)).toBe(false);
  expect(planner.impactReady({...hit,generation:hit.generation+1},()=>true)).toBe(false);
  expect(planner.impactReady({...hit,runId:hit.runId+1},()=>true)).toBe(false);
  expect(planner.impactReady({...hit,weaponId:'other'},()=>true)).toBe(false);
  expect(planner.impactReady({...hit,weaponEvent:hit.weaponEvent!+1000},()=>true)).toBe(false);
  planner.clear();expect(planner.impactReady(hit,()=>true)).toBe(false);
});

it('非射线和环境伤害消费原事件，密集DoT合并可画脉冲但不吞伤害事实；旧代次/坏纹理仍保底',()=>{
 const doc=structuredClone(Object.values(modules)[0]) as SceneDocument,r=new RuntimeSession({desc:loadLevelRuntime(doc).desc!,seed:1}),p=new WeaponVfxPlanner();
 p.damageEffect=(Object.values(assets)[0] as VfxAsset).effects['npc-hit']!;
 const target=r.view().find(e=>e.kind==='npc')!;r.applyDamage(target.id,1);r.applyDamage(target.id,2);r.applyDamage(target.id,3);p.update(r);
 const events=r.combatEvents.filter(e=>e.slot===target.id);expect(events).toHaveLength(3);expect(events.every(e=>p.impactReady(e,()=>true))).toBe(true);expect(p.damageStats.coalesced).toBe(2);
 expect(events.every(e=>p.impactReady(e,()=>false))).toBe(false);expect(p.impactReady({...events[0]!,generation:target.generation+1},()=>true)).toBe(false);
 const count=p.pool.stats.spawned;p.update(r);expect(p.pool.stats.spawned).toBe(count);
 r.reset();p.update(r);expect(p.impactReady(events[0]!,()=>true)).toBe(false);expect(p.pool.active.length).toBe(0);
 const other=r.view().find(e=>e.kind==='npc')!;r.applyDamage(other.id,1);p.update(r,()=>false);expect(p.damageStats.fallback).toBeGreaterThan(0);expect(p.impactReady(r.combatEvents.at(-1)!,()=>true)).toBe(false);
});
