import { describe, it, expect } from 'vitest';
import { WeaponSystem, WeaponCombat } from '@aether/runtime';
import type { WeaponArsenal } from '@aether/scene';
import arsenal from '../../../assets/weapons/prototype.weapons.json';
import { weaponDiagnostics } from '../src/services/weapon-diagnostics';

describe('MCP weapon inspection', () => {
  it('reports stopped state and copies accepted facts without firing hooks or advancing actions', () => {
    expect(weaponDiagnostics(null)).toBeNull();
    const weapons = new WeaponSystem(arsenal as WeaponArsenal), weaponCombat = new WeaponCombat(7);
    let hooks = 0; weapons.setAnimationHooks({ onFire: () => hooks++ });
    weapons.beginFire();
    const before = weapons.snapshot(), events = structuredClone(weapons.events), animation = weapons.animation;
    const snapshot = weaponDiagnostics({ weapons, weaponCombat })!;
    expect(snapshot.recentEvents.at(-1)?.action).toBe('fire');
    snapshot.states[0]!.magazine = -1;
    snapshot.recentEvents[0]!.action = 'equipped';
    snapshot.poseIntent.markers.primaryGrip.position[0] = 999;
    snapshot.hookErrors.push('foreign');
    expect(weapons.snapshot()).toEqual(before);
    expect(weapons.events).toEqual(events);
    expect(weapons.animation).toEqual(animation);
    expect(weapons.active.presentation.markers.primaryGrip.position[0]).not.toBe(999);
    expect(weapons.hookErrors).toEqual([]); expect(hooks).toBe(1);
    for (let i = 0; i < 100; i++) { weapons.advance(1, i); weapons.beginFire(); }
    expect(weaponDiagnostics({ weapons, weaponCombat })!.recentEvents.length).toBeLessThanOrEqual(16);
  });
});
