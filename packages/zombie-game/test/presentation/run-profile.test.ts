import { describe, it, expect } from 'vitest';
import { RunProfile } from "../../src/presentation/run-profile";
import type { RunRulesComponent, SceneDocument } from '@aether/scene';
import floor from "../../../../assets/scenes/act1/floor-1.scene.json";
const rules = (floor as unknown as SceneDocument).nodes.flatMap(n => n.components).find(c => c.kind === 'RunRules') as RunRulesComponent;
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  return { storage, values, profile: new RunProfile(storage) };
}
describe('persistent run settlement', () => {
  it('credits only the uncredited part of a run across floor navigation and reload', () => {
    const { profile, storage } = setup();
    expect(profile.credit('act1', 'run-1', 5).essence).toBe(5);
    expect(profile.credit('act1', 'run-1', 5).essence).toBe(5);
    const reloaded = new RunProfile(storage);
    expect(reloaded.credit('act1', 'run-1', 15).essence).toBe(15);
    expect(reloaded.credit('act1', 'run-1', 5).essence).toBe(15);
    expect(reloaded.credit('act1', 'run-2', 5).essence).toBe(20);
    expect(reloaded.read('act2').essence).toBe(0);
  });
  it('buys a pool option once and never applies a numeric upgrade', () => {
    const { profile } = setup(); const t = rules.talents.find(t => t.unlockCost)!;
    expect(profile.unlock(rules, t.id)).toBe(false);
    profile.credit(rules.campaign, 'run-1', t.unlockCost!);
    expect(profile.unlock(rules, 'unknown')).toBe(false);
    expect(profile.unlock(rules, t.id)).toBe(true);
    expect(profile.unlock(rules, t.id)).toBe(false);
    expect(profile.read(rules.campaign).essence).toBe(0);
    expect(profile.read(rules.campaign).unlocked).toEqual([t.id]);
  });
  it('does not silently overwrite malformed storage or report a failed write as saved', () => {
    const { profile, values } = setup(); values.set('aether.profile.v1.act1', '{broken');
    expect(() => profile.credit('act1', 'run-1', 5)).toThrow();
    expect(values.get('aether.profile.v1.act1')).toBe('{broken');
    const broken = new RunProfile({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
    expect(() => broken.credit('act1', 'run-1', 5)).toThrow('quota');
  });
});
