/** Post-sampling HumanIK layer. Only authored chain rotations change; hips, translations,
 * scales and unrelated local tracks retain the sampled animation. No frame accumulation. */
import { quatMul, mat4, invert, type Quat, type Vec3 } from '@aether/core';
import { validateBodyIkBinding, type BodyIkBinding, type BodyIkPart, type NodeLocal, type SkeletonData } from '@aether/scene';
import { rotateVec3, solveTwoBone, swingBetweenDirections } from './two-bone-ik';

const chains: Record<BodyIkPart, string[]> = {
  upperBody: ['Spine', 'Spine1', 'Spine2'], head: ['Neck', 'Head'],
  leftHand: ['LeftArm', 'LeftForeArm', 'LeftHand'], rightHand: ['RightArm', 'RightForeArm', 'RightHand'],
  leftFoot: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'], rightFoot: ['RightUpLeg', 'RightLeg', 'RightFoot'],
};
export interface BodyIkDiagnostic { controlId: string; code: string; message: string; residualM?: number }
export interface BodyIkState {
  binding: BodyIkBinding;
  nodes: Record<string, number[]>;
  /** Host-resolved targets in normalized actor-local metres. Missing target skips its control. */
  targets: Record<string, Vec3 | null>;
  /** Runtime action multipliers; persisted binding remains unchanged. */
  controlWeights?: Record<string, number>;
  setupDiagnostics: BodyIkDiagnostic[];
  diagnostics: BodyIkDiagnostic[];
}
export function createBodyIkState(sk: SkeletonData, binding: BodyIkBinding): BodyIkState {
  const state: BodyIkState = { binding: structuredClone(binding), nodes: {}, targets: {}, setupDiagnostics: [], diagnostics: [] };
  const error = (id: string, code: string, message: string): void => { state.setupDiagnostics.push({ controlId: id, code, message }); };
  const invalid = validateBodyIkBinding(binding);
  if (invalid.length) { error('', 'IK_CONFIG', invalid.join('; ')); return state; }
  const names = new Map<string, number[]>();
  sk.jointNames.forEach((name, i) => {
    const key = name?.replace(/^mixamorig[:_]?/i, ''); if (!key) return;
    names.set(key, [...(names.get(key) ?? []), sk.joints[i]!]);
  });
  for (const control of binding.controls) {
    const mapped = chains[control.part].map(name => names.get(name));
    if (mapped.some(nodes => nodes?.length !== 1)) { error(control.id, 'IK_BONES', `Missing or ambiguous ${chains[control.part].join('/')}`); continue; }
    const nodes = mapped.map(a => a![0]!);
    const ancestor = (a: number, b: number): boolean => {
      const seen = new Set<number>();
      for (let p = sk.parent[b]!; p >= 0 && !seen.has(p); p = sk.parent[p]!) { if (p === a) return true; seen.add(p); }
      return false;
    };
    if (!nodes.slice(1).every((node, i) => ancestor(nodes[i]!, node))) { error(control.id, 'IK_CHAIN', 'HumanIK chain has incompatible hierarchy'); continue; }
    state.nodes[control.id] = nodes;
  }
  state.diagnostics = [...state.setupDiagnostics];
  return state;
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const transformPoint = (m: Float32Array, v: Vec3): Vec3 => [
  m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]!,
  m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]!,
  m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!,
];
const len = (a: Vec3): number => Math.hypot(...a);
const conjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
/** Shortest-arc quaternion interpolation, including the q / -q identity. */
function blend(a: Quat, b: Quat, weight: number): [number, number, number, number] {
  let dot = a.reduce((sum, x, i) => sum + x * b[i]!, 0);
  const sign = dot < 0 ? -1 : 1; dot = Math.abs(dot);
  const angle = Math.acos(Math.min(1, dot)), sin = Math.sin(angle);
  const f = sin > 1e-6 ? Math.sin((1 - weight) * angle) / sin : 1 - weight;
  const g = (sin > 1e-6 ? Math.sin(weight * angle) / sin : weight) * sign;
  const q = a.map((x, i) => x * f + b[i]! * g), n = Math.hypot(...q) || 1;
  return [q[0]! / n, q[1]! / n, q[2]! / n, q[3]! / n];
}
interface Frame { p: Vec3[]; q: Quat[]; scale: number[] }
/** FK in the raw skeleton space; normalization is applied to targets on input. */
function fk(sk: SkeletonData, locals: NodeLocal[]): Frame | null {
  const p: Vec3[] = [], q: Quat[] = [], scale: number[] = [];
  const visiting = new Set<number>();
  function visit(i: number): boolean {
    if (q[i]) return true;
    if (visiting.has(i) || !locals[i]) return false;
    visiting.add(i);
    const l = locals[i]!, parent = sk.parent[i]!, s = l.s;
    if (s.some(x => !Number.isFinite(x) || x <= 0) || Math.abs(s[0] - s[1]) > 1e-6 || Math.abs(s[0] - s[2]) > 1e-6) return false;
    if (parent >= 0) {
      if (!visit(parent)) return false;
      q[i] = quatMul(q[parent]!, l.r); scale[i] = scale[parent]! * s[0];
      const t = rotateVec3(q[parent]!, l.t.map(x => x * scale[parent]!) as [number, number, number]);
      p[i] = [p[parent]![0] + t[0], p[parent]![1] + t[1], p[parent]![2] + t[2]];
    } else { q[i] = l.r; p[i] = l.t; scale[i] = s[0]; }
    visiting.delete(i); return true;
  }
  return locals.every((_, i) => visit(i)) ? { p, q, scale } : null;
}
function setSwing(sk: SkeletonData, locals: NodeLocal[], frame: Frame, node: number, delta: Quat): void {
  const parent = sk.parent[node]!;
  locals[node]!.r = [...quatMul(conjugate(parent < 0 ? [0, 0, 0, 1] : frame.q[parent]!), quatMul(delta, frame.q[node]!))];
}
export function applyBodyIk(sk: SkeletonData, locals: NodeLocal[], state: BodyIkState): void {
  state.diagnostics = [...state.setupDiagnostics];
  const binding = state.binding;
  if (!binding.enabled || binding.weight <= 0 || state.setupDiagnostics.some(d => d.code === 'IK_CONFIG')) return;
  const inv = mat4(); invert(inv, sk.normalization);
  const normScale = Math.hypot(sk.normalization[0]!, sk.normalization[1]!, sk.normalization[2]!);
  const scales = [0, 4, 8].map(i => Math.hypot(sk.normalization[i]!, sk.normalization[i + 1]!, sk.normalization[i + 2]!));
  if (normScale <= 0 || scales.some(x => Math.abs(x - normScale) > normScale * 1e-5)) {
    state.diagnostics.push({ controlId: '', code: 'IK_SCALE', message: 'IK requires uniform normalization scale' }); return;
  }
  // Stable solve order: torso/head first, then limbs, irrespective of UI insertion order.
  for (const part of Object.keys(chains) as BodyIkPart[]) {
    const c = binding.controls.find(c => c.part === part), nodes = c && state.nodes[c.id];
    if (!c || !nodes || !c.enabled || c.weight <= 0) continue;
    const target = Object.hasOwn(state.targets, c.id) ? state.targets[c.id] : c.target.kind === 'position' ? c.target.position : null;
    const actionWeight = Math.max(0, Math.min(1, state.controlWeights?.[c.id] ?? 1));
    if (actionWeight <= 0) continue;
    if (!target || !target.every(Number.isFinite)) { state.diagnostics.push({ controlId: c.id, code: 'IK_TARGET', message: 'Target is unavailable; animation retained' }); continue; }
    const frame = fk(sk, locals);
    if (!frame) { state.diagnostics.push({ controlId: c.id, code: 'IK_SCALE', message: 'IK requires a valid hierarchy with positive uniform scales' }); continue; }
    const goal = transformPoint(inv, target), before = nodes.map(i => [...locals[i]!.r] as [number, number, number, number]);
    if (part === 'upperBody' || part === 'head') {
      const end = nodes.at(-1)!;
      const direction = sub(goal, frame.p[end]!);
      if (len(direction) < 1e-8) { state.diagnostics.push({ controlId: c.id, code: 'IK_TARGET', message: 'Aim target coincides with the bone' }); continue; }
      const swing = swingBetweenDirections(rotateVec3(frame.q[end]!, c.forward), direction);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(swing[3]))), limit = c.maxAngleDeg * Math.PI / 180;
      const delta = blend([0, 0, 0, 1], swing, Math.min(1, limit / Math.max(angle, 1e-8)) / nodes.length);
      for (const node of nodes) setSwing(sk, locals, fk(sk, locals)!, node, delta);
      if (angle > limit) state.diagnostics.push({ controlId: c.id, code: 'IK_AIM_LIMIT', message: 'Aim angle clamped to authored limit' });
    } else {
      const [a, b, e] = nodes as [number, number, number], root = frame.p[a]!;
      const l1 = len(sub(frame.p[b]!, root)), l2 = len(sub(frame.p[e]!, frame.p[b]!));
      if (l1 < 1e-8 || l2 < 1e-8) { state.diagnostics.push({ controlId: c.id, code: 'IK_LENGTH', message: 'IK chain contains a zero-length segment' }); continue; }
      const pole = transformPoint(inv, c.pole), origin = transformPoint(inv, [0, 0, 0]);
      const solution = solveTwoBone({ root, tip: goal, l1, l2, poleHint: sub(pole, origin), prevKnee: frame.p[b]! });
      setSwing(sk, locals, frame, a, swingBetweenDirections(sub(frame.p[b]!, root), sub(solution.knee, root)));
      const next = fk(sk, locals)!;
      setSwing(sk, locals, next, b, swingBetweenDirections(sub(next.p[e]!, next.p[b]!), sub(solution.reachedTip, next.p[b]!)));
      if (solution.status !== 'exact') state.diagnostics.push({ controlId: c.id, code: 'IK_UNREACHABLE', message: 'Target clamped to limb reach; bone lengths retained', residualM: solution.residualM * normScale });
    }
    nodes.forEach((node, i) => { locals[node]!.r = blend(before[i]!, locals[node]!.r, binding.weight * c.weight * actionWeight); });
  }
}
