import { expect, it } from 'vitest';
import { RuntimeSession, loadLevelRuntime } from '@aether/zombie-game';
import type { SceneDocument } from '@aether/scene';
import { visibleImpacts, damageBurstVisible } from "../../src/presentation/combat-ink";

const files = import.meta.glob("../../../../assets/scenes/act1/floor-1.scene.json", { eager: true, import: 'default' });
const runtime = () => new RuntimeSession({ desc: loadLevelRuntime(structuredClone(Object.values(files)[0]) as SceneDocument).desc!, seed: 7 });
it('burn damage/kill labels remain while only decorative bursts are suppressed, even with missing GPU particles',()=>{
 const s=runtime(),npc=s.view().find(e=>e.kind==='npc')!;s.applyDamage(npc.id,1,s.playerEntityId,{weaponId:'flame',damageKind:'burn'});s.applyDamage(npc.id,npc.maxHp,s.playerEntityId,{weaponId:'flame',damageKind:'burn'});
 const labels=visibleImpacts(s.combatEvents,s.runId,s.tick,s.fixedStep);expect(labels.map(e=>e.type)).toEqual(['damage','kill']);expect(labels.every(e=>!damageBurstVisible(e,false) && !damageBurstVisible(e,true))).toBe(true);
 const {damageKind:_burn,...direct}=labels[0]!;expect(damageBurstVisible(direct,false)).toBe(true);expect(damageBurstVisible(direct,true)).toBe(false);
});

it('keeps the actual hit position and damage after an enemy is despawned', () => {
  const s = runtime(); s.step();
  const target = s.view().find(e => e.id !== s.playerEntityId)!;
  s.applyDamage(target.id,target.maxHp,s.playerEntityId);
  expect(s.table.isAlive(target.id)).toBe(false);
  const before = structuredClone(s.combatEvents);
  const cues = visibleImpacts(s.combatEvents,s.runId,s.tick,s.fixedStep);
  expect(cues).toHaveLength(1);
  expect(cues[0]).toMatchObject({type:'kill',x:target.x,z:target.z,amount:target.maxHp,generation:target.generation});
  expect(s.combatEvents).toEqual(before);
  // Pausing keeps the exact frame; elapsed simulation time removes the cue.
  expect(visibleImpacts(s.combatEvents,s.runId,s.tick,s.fixedStep)).toEqual(cues);
  expect(visibleImpacts(s.combatEvents,s.runId,s.tick + 60,s.fixedStep)).toEqual([]);
});

it('does not show old-run, future, positionless or zero-damage events', () => {
  const s = runtime(); s.applyDamage(s.playerEntityId,1);
  const e = s.combatEvents[0]!;
  const { x: _x, ...positionless } = e;
  const invalid = [{...e,runId:e.runId+1},{...e,tick:s.tick+1},positionless,{...e,z:NaN},{...e,amount:0}];
  expect(visibleImpacts(invalid,s.runId,s.tick,s.fixedStep)).toEqual([]);
  s.reset();
  expect(visibleImpacts([e],s.runId,s.tick,s.fixedStep)).toEqual([]);
});
