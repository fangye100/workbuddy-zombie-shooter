import { describe, expect, it } from 'vitest';
import { sceneChoice, paletteChoice, type SceneChoiceInput } from '../src/services/animation-debug/selection';
const input: SceneChoiceInput = { states: { idle: {}, walk: {}, run: {}, shoot: {}, reload: {} }, defaultState: 'idle',
  speed: 3, keepGait: false, firing: true, runId: 7, weapon: { action: 'fire', clip: 'pistol-fire', fallback: 'reload', phase: .4, weaponId: 'pistol', startTick: 4 } };
describe('execution selection explanations', () => {
  it('preserves weapon candidate order, gait priority, legacy firing, and missing locomotion fallback', () => {
    expect(sceneChoice(input, true).decision).toMatchObject({ requested: 'pistol-fire', actual: 'shoot', fallback: 'pistol-fire → shoot' });
    expect(sceneChoice({ ...input, keepGait: true }).state).toBe('run');
    expect(sceneChoice({ ...input, weapon: null }).state).toBe('shoot');
    expect(sceneChoice({ ...input, weapon: null, keepGait: true, speed: 1, states: { idle: {} } }, true).decision).toMatchObject({ requested: 'walk', actual: 'idle', fallback: 'walk → idle' });
    expect(sceneChoice({ ...input, weapon: { ...input.weapon!, action: 'idle' } }).state).toBe('run');
    expect(sceneChoice(input).decision).toBeNull();
  });
  it('keeps GPU fire fallback distinct from CPU weapon.fallback and exposes bind pose / clip zero', () => {
    const clips = ['idle', 'attack', 'reload'].map(name => ({ name }));
    expect(paletteChoice(clips, 1, input.weapon!, true).decision).toMatchObject({ actual: 'attack', source: 'weapon' });
    expect(paletteChoice(clips, 1, { ...input.weapon!, action: 'reload', clip: 'pistol-reload' }, true).index).toBe(2);
    expect(paletteChoice(clips, 1, null, true).decision!.fallback).toContain('clip 0');
    expect(paletteChoice([], 1, null, true).decision!.actual).toBe('bind pose');
    expect(paletteChoice(clips, 1, null).decision).toBeNull();
  });
});
