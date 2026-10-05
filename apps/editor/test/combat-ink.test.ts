import { expect, it } from 'vitest';
import { RuntimeSession, loadLevelRuntime } from '@aether/runtime';
import type { SceneDocument } from '@aether/scene';
import { visibleImpacts } from '../src/services/combat-ink';

const files = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true, import: 'default' });
const runtime = () => new RuntimeSession({ desc: loadLevelRuntime(structuredClone(Object.values(files)[0]) as SceneDocument).desc!, seed: 7 });

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
