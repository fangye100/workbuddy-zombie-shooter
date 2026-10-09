/** Shared source motions and per-asset runtime retarget bindings. No generated tracks here. */
import type { AssetRef } from './document';

export const MOTION_LIBRARY_VERSION = 1;
export const DEFAULT_MOTION_TRANSITION_SEC = .2;
export interface SharedMotionBinding {
  /** Pose transition duration in simulation seconds. Zero selects immediately. */
  transitionSec?: number;
  library: AssetRef;
  profile: string;
  defaultState: string;
  speed: number;
}
export interface SharedMotionClip {
  source: AssetRef;
  loop: boolean;
  rootPolicy: 'in-place' | 'trajectory';
  /** Optional authored gait speed, measured in source metres per second. */
  nominalSpeedMps?: number;
  /** A static ready pose sampled from an existing source, without duplicating that source. */
  poseAtS?: number;
}
export interface SharedMotionLibrary {
  schemaVersion: number;
  id: string;
  clips: Record<string, SharedMotionClip>;
  /** State name -> source clip id. Profiles may share the same source. */
  profiles: Record<string, Record<string, string>>;
}

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asset(v: unknown): boolean {
  return record(v) && typeof v.path === 'string' && v.path.startsWith('assets/') &&
    !v.path.split('/').includes('..') && !v.path.includes('\\') && typeof v.guid === 'string' && v.guid.length > 0;
}
export function validateSharedMotionBinding(v: unknown): string[] {
  if (!record(v)) return ['Shared motion binding must be an object'];
  const errors: string[] = [];
  if (!asset(v.library)) errors.push('Motion library requires an assets/ path and guid');
  if (typeof v.profile !== 'string' || !v.profile) errors.push('Motion profile is required');
  if (typeof v.defaultState !== 'string' || !v.defaultState) errors.push('Default motion state is required');
  if (typeof v.speed !== 'number' || !Number.isFinite(v.speed) || v.speed <= 0) errors.push('Motion speed must be positive');
  if (v.transitionSec !== undefined && (typeof v.transitionSec !== 'number' || !Number.isFinite(v.transitionSec) || v.transitionSec < 0 || v.transitionSec > 5)) errors.push('Motion transitionSec must be in [0,5] seconds');
  return errors;
}
export function validateSharedMotionLibrary(v: unknown): string[] {
  if (!record(v)) return ['Motion library must be an object'];
  const errors: string[] = [];
  if (v.schemaVersion !== MOTION_LIBRARY_VERSION) errors.push('Unsupported motion library version');
  if (typeof v.id !== 'string' || !v.id) errors.push('Motion library id is required');
  if (!record(v.clips) || !Object.keys(v.clips).length) errors.push('Motion library has no clips');
  else for (const [id, c] of Object.entries(v.clips)) {
    if (!record(c) || !asset(c.source) || typeof c.loop !== 'boolean' ||
      (c.rootPolicy !== 'in-place' && c.rootPolicy !== 'trajectory')) errors.push(`Invalid clip ${id}`);
    else if (c.nominalSpeedMps !== undefined && (typeof c.nominalSpeedMps !== 'number' ||
      !Number.isFinite(c.nominalSpeedMps) || c.nominalSpeedMps <= 0)) errors.push(`Invalid gait speed ${id}`);
    else if (c.poseAtS !== undefined && (typeof c.poseAtS !== 'number' || !Number.isFinite(c.poseAtS) || c.poseAtS < 0)) errors.push(`Invalid pose sample ${id}`);
  }
  if (!record(v.profiles) || !Object.keys(v.profiles).length) errors.push('Motion library has no profiles');
  else for (const [id, profile] of Object.entries(v.profiles)) {
    if (!record(profile) || !Object.keys(profile).length) { errors.push(`Invalid profile ${id}`); continue; }
    for (const [state, clip] of Object.entries(profile)) if (typeof clip !== 'string' || !record(v.clips) || !v.clips[clip]) errors.push(`Unknown clip ${id}.${state}`);
  }
  return errors;
}
