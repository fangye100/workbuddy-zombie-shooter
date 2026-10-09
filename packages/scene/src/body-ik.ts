/** Persistent HumanIK procedural controls. Positions are normalized actor-local metres.
 * Node/mouse targets are resolved by the host each frame, never stored as sampled poses. */
export type IkVec3 = [number, number, number];
export const BODY_IK_PARTS = ['upperBody', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const;
export type BodyIkPart = typeof BODY_IK_PARTS[number];
export type BodyIkTarget =
  | { kind: 'position'; position: IkVec3 }
  | { kind: 'mouse'; height: number }
  | { kind: 'enemy'; height: number }
  | { kind: 'node'; nodeId: string; offset: IkVec3 };
export interface BodyIkControl {
  id: string;
  part: BodyIkPart;
  enabled: boolean;
  weight: number;
  target: BodyIkTarget;
  /** Actor-local bend direction for hands/feet; ignored by aim controls. */
  pole: IkVec3;
  /** Bone-local aim axis; ignored by two-bone controls. */
  forward: IkVec3;
  maxAngleDeg: number;
}
export interface BodyIkBinding {
  enabled: boolean;
  weight: number;
  /** Retain locomotion while firing, instead of replacing the whole pose with shoot. */
  locomotionWhileAiming: boolean;
  controls: BodyIkControl[];
}
export function newBodyIkControl(part: BodyIkPart): BodyIkControl {
  const hand = part.endsWith('Hand'), left = part.startsWith('left');
  return { id: part, part, enabled: true, weight: 1,
    target: part === 'upperBody' || part === 'head' ? { kind: 'mouse', height: 1.5 } :
      { kind: 'position', position: [left ? .3 : -.3, hand ? 1.3 : .1, hand ? .4 : .1] },
    pole: [0, 0, hand ? -1 : 1], forward: [0, 0, 1], maxAngleDeg: 75 };
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec = (v: unknown): v is IkVec3 => Array.isArray(v) && v.length === 3 && v.every(finite);
const weight = (v: unknown): boolean => finite(v) && v >= 0 && v <= 1;
export function validateBodyIkBinding(v: unknown, allowNodeTargets = true): string[] {
  if (!record(v)) return ['Body IK binding must be an object'];
  const errors: string[] = [];
  if (typeof v.enabled !== 'boolean' || !weight(v.weight) || typeof v.locomotionWhileAiming !== 'boolean') errors.push('Body IK requires enabled, weight in [0,1], and locomotionWhileAiming');
  if (!Array.isArray(v.controls) || v.controls.length > BODY_IK_PARTS.length) return [...errors, 'Body IK controls must be an array of at most six parts'];
  const ids = new Set<string>(), parts = new Set<string>();
  for (const [i, c] of v.controls.entries()) {
    const at = `controls[${i}]`;
    if (!record(c)) { errors.push(`${at} must be an object`); continue; }
    if (typeof c.id !== 'string' || !c.id || ids.has(c.id)) errors.push(`${at} requires a unique id`);
    else ids.add(c.id);
    if (!BODY_IK_PARTS.includes(c.part as BodyIkPart) || parts.has(String(c.part))) errors.push(`${at} requires a unique HumanIK part`);
    else parts.add(String(c.part));
    if (typeof c.enabled !== 'boolean' || !weight(c.weight)) errors.push(`${at} requires enabled and weight in [0,1]`);
    if (!vec(c.pole) || !vec(c.forward) || Math.hypot(...c.forward) < 1e-8) errors.push(`${at} requires finite pole and nonzero forward vectors`);
    if (!finite(c.maxAngleDeg) || c.maxAngleDeg <= 0 || c.maxAngleDeg > 180) errors.push(`${at} aim limit must be in (0,180] degrees`);
    const t = c.target;
    if (!record(t)) { errors.push(`${at} requires a target`); continue; }
    if (t.kind === 'position' ? !vec(t.position) : t.kind === 'mouse' || t.kind === 'enemy' ? !finite(t.height) :
      t.kind === 'node' ? !allowNodeTargets || typeof t.nodeId !== 'string' || !t.nodeId || !vec(t.offset) : true) errors.push(`${at} has an invalid target (asset defaults cannot reference scene nodes)`);
  }
  return errors;
}
