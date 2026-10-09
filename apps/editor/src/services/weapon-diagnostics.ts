import type { RuntimeSession } from '@aether/zombie-game';

/** Copy public facts only. Inspection must not advance actions, invoke hooks or retain live references. */
export function weaponDiagnostics(runtime: Pick<RuntimeSession, 'weapons' | 'weaponCombat'> | null) {
  if (!runtime) return null;
  const w = runtime.weapons;
  return {
    ...w.snapshot(), activeId: w.active.id, behavior: w.active.behavior,
    capacity: w.capacity, reloadRemaining: w.reloadRemaining, switching: w.switching,
    upgradeCost: w.upgradeCost, animation: { ...w.animation }, poseIntent: w.poseIntent,
    recentEvents: w.events.slice(-16).map(e => ({ ...e })), hookErrors: [...w.hookErrors],
    effectCount: runtime.weaponCombat.effects.length,
  };
}
