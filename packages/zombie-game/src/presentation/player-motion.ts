/** Player presentation policy: locomotion and accepted weapon actions have separate outputs. */
import type { WeaponAnimation, WeaponSystem } from '@aether/runtime';
import type { Vec3 } from '@aether/core';
export interface PlayerMotionInput {
  states: Record<string, unknown>;
  defaultState: string;
  speed: number;
  locomotionState?: string;
  weapon: WeaponAnimation | null | undefined;
  runId: number;
}
export function playerMotionChoice(i: PlayerMotionInput) {
  const has = (state: string): boolean => !!i.states[state];
  const moving = i.speed > .05;
  const candidates = moving ? [i.locomotionState ?? '', ...(i.speed > 2.5 ? ['run'] : []), 'walk', i.defaultState] : ['idle', i.defaultState];
  const base = candidates.find(has) ?? i.defaultState;
  const w = i.weapon, active = !!w && w.action !== 'idle';
  const requested = active ? w.clip : 'ready';
  const isLocomotion = (name: string): boolean => ['idle','walk','run','jump',i.defaultState].includes(name) || name.startsWith('walk_');
  const actionCandidates = active ? [w.clip, w.action === 'fire' ? 'shoot' : w.action, w.fallback].filter(s => !isLocomotion(s)) : ['ready'];
  const actual = actionCandidates.find(has) ?? (has('ready') ? 'ready' : null);
  const missing = active && !actionCandidates.some(has);
  return { base, upper: actual, requested, action: w?.action ?? 'idle', phase: active ? w.phase : null,
    stamp: active ? `${i.runId}:${w.weaponId}:${w.action}:${w.startTick}` : '',
    fallback: actual !== requested ? `${requested} → ${actual ?? 'base only'}` : null,
    diagnostics: missing ? [`WEAPON_CLIP_MISSING: ${requested}; base ${base} retained; procedural pose available only with configured IK`] : [] };
}
/** Maps authoritative weapon markers/recoil/switch phase into world-space hand goals.
 * Forward follows the same atan2(z,x) convention as combat and the held-weapon overlay. */
export function weaponHandGoals(pose: WeaponSystem['poseIntent'], position: Vec3, yaw: number): { right: Vec3; left: Vec3 } {
  const phase = Math.max(0, Math.min(1, pose.phase));
  const lowered = pose.action === 'unequip' ? phase : pose.action === 'equip' ? 1 - phase : 0;
  const project = (v: Vec3): Vec3 => {
    const pitch = pose.recoil.pitchDeg * Math.PI / 180;
    const x = v[0] + pose.recoil.translation[0], y = v[1] + Math.sin(pitch) * v[0] - lowered * .25;
    return [position[0] + Math.cos(yaw) * x - Math.sin(yaw) * v[2], position[1] + y, position[2] + Math.sin(yaw) * x + Math.cos(yaw) * v[2]];
  };
  const left = pose.reload.leftHandTarget as 'magazine' | 'chamber' | 'supportGrip';
  return { right: project(pose.markers.primaryGrip.position), left: project(pose.markers[left].position) };
}
