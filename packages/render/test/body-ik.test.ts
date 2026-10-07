import { describe, expect, it } from 'vitest';
import { mat4, invert, eulerToQuat } from '@aether/core';
import { createBodyIkState, createSkinState, evalJointMatrices } from '@aether/render';
import { newBodyIkControl, type BodyIkPart, type BodyIkBinding } from '@aether/scene';
import { skeletonFromFitPositions } from '../../../apps/editor/src/services/binding/retarget-session';
import { tposeWorldPositions } from '../../../apps/editor/src/services/binding/humanik-template';

const point = (m: Float32Array, p: readonly number[]) => [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!];
function fixture(part: BodyIkPart = 'leftHand') {
  const sk = skeletonFromFitPositions(tposeWorldPositions()), control = newBodyIkControl(part);
  const positions = tposeWorldPositions();
  sk.jointNames.forEach((name, i) => { const m = mat4(), p = positions[name!]!; m[12] = -p[0]; m[13] = -p[1]; m[14] = -p[2]; sk.inverseBind.set(m, i * 16); });
  control.target = { kind: 'position', position: [.35, 1.5, .25] };
  const binding: BodyIkBinding = { enabled: true, weight: 1, locomotionWhileAiming: true, controls: [control] };
  const skin = createSkinState(sk, []); skin.bodyIk = createBodyIkState(sk, binding);
  const out = () => { const m = new Float32Array((sk.joints.length + 1) * 16); evalJointMatrices(skin, m); return m; };
  const position = (name: string, matrices = out()) => {
    const i = sk.jointNames.indexOf(name), rest = mat4(); invert(rest, sk.inverseBind.slice(i * 16, i * 16 + 16));
    return point(matrices.slice(i * 16, i * 16 + 16), point(sk.normalization, [rest[12]!, rest[13]!, rest[14]!]));
  };
  return { sk, skin, binding, control, out, position };
}
describe('post-animation HumanIK blending', () => {
  it('reaches a hand target at full weight, retaining hips and both legs', () => {
    const f = fixture(), old = structuredClone(f.sk.locals);
    f.skin.bodyIk!.binding.weight = 0; const base = f.out();
    f.skin.bodyIk!.binding.weight = 1; const solved = f.out();
    f.position('LeftHand', solved).forEach((v, i) => expect(v).toBeCloseTo([.35, 1.5, .25][i]!, 5));
    for (const name of ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot']) {
      const i = f.sk.jointNames.indexOf(name); expect(solved.slice(i * 16, i * 16 + 16)).toEqual(base.slice(i * 16, i * 16 + 16));
    }
    expect(f.sk.locals).toEqual(old); expect(f.out()).toEqual(solved); // no accumulation
  });
  it.each(['leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const)('solves %s without stretching', part => {
    const f = fixture(part), names = part === 'leftHand' ? ['LeftArm', 'LeftForeArm', 'LeftHand'] : part === 'rightHand' ? ['RightArm', 'RightForeArm', 'RightHand'] : part === 'leftFoot' ? ['LeftUpLeg', 'LeftLeg', 'LeftFoot'] : ['RightUpLeg', 'RightLeg', 'RightFoot'];
    f.skin.bodyIk!.binding.weight = 0; const base = names.map(n => f.position(n));
    f.skin.bodyIk!.binding.controls[0]!.target = { kind: 'position', position: [10, 10, 10] };
    f.skin.bodyIk!.binding.weight = 1; const solved = names.map(n => f.position(n));
    for (let i = 0; i < 2; i++) expect(Math.hypot(...solved[i + 1]!.map((v, k) => v - solved[i]![k]!))).toBeCloseTo(Math.hypot(...base[i + 1]!.map((v, k) => v - base[i]![k]!)), 5);
    expect(f.skin.bodyIk!.diagnostics.some(d => d.code === 'IK_UNREACHABLE' && d.residualM! > 0)).toBe(true);
  });
  it('uses master × part weight and preserves animated lower-body matrices', () => {
    const f = fixture('upperBody'), leg = f.sk.joints[f.sk.jointNames.indexOf('LeftUpLeg')]!;
    f.skin.clips = [{ name: 'fbx-run', duration: 1, tracks: [{ node: leg, path: 'rotation', stride: 4, interpolation: 'LINEAR', times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 1, ...eulerToQuat(.5, 0, 0)]) }] }]; f.skin.clip = 0; f.skin.time = .5;
    f.skin.bodyIk!.binding.weight = 0; const base = f.out();
    f.skin.bodyIk!.binding.weight = .5; const mid = f.out();
    f.skin.bodyIk!.binding.weight = 1; f.skin.bodyIk!.binding.controls[0]!.weight = .5; expect(f.out()).toEqual(mid);
    const legIndex = f.sk.jointNames.indexOf('LeftUpLeg'); expect(mid.slice(legIndex * 16, legIndex * 16 + 16)).toEqual(base.slice(legIndex * 16, legIndex * 16 + 16));
    expect(mid).not.toEqual(base);
    f.skin.bodyIk!.binding.controls[0]!.weight = 0; expect(f.out()).toEqual(base);
  });
  it('reports absent targets and missing bones without corrupting the base pose', () => {
    const f = fixture(); f.skin.bodyIk!.binding.controls[0]!.target = { kind: 'mouse', height: 1.5 };
    const result = f.out(); expect(f.skin.bodyIk!.diagnostics[0]!.code).toBe('IK_TARGET');
    delete f.skin.bodyIk; expect(f.out()).toEqual(result);
    f.sk.jointNames[f.sk.jointNames.indexOf('LeftHand')] = 'Other';
    f.skin.bodyIk = createBodyIkState(f.sk, f.binding); expect(f.skin.bodyIk.setupDiagnostics[0]!.code).toBe('IK_BONES');
    expect(f.out()).toEqual(result);
  });
  it('handles normalized centimetre skeletons and Mixamo names', () => {
    const f = fixture();
    for (const l of f.sk.locals) l.t = l.t.map(v => v * 100) as [number, number, number];
    for (let i = 0; i < f.sk.joints.length; i++) for (const j of [12, 13, 14]) f.sk.inverseBind[i * 16 + j]! *= 100;
    f.sk.normalization = new Float32Array([.01, 0, 0, 0, 0, .01, 0, 0, 0, 0, .01, 0, 0, 0, 0, 1]);
    f.sk.jointNames = f.sk.jointNames.map(n => `mixamorig:${n}`);
    f.skin.bodyIk = createBodyIkState(f.sk, f.binding);
    f.position('mixamorig:LeftHand').forEach((v, i) => expect(v).toBeCloseTo([.35, 1.5, .25][i]!, 5));
  });
  it('clamps head aim and rejects nonuniform scale', () => {
    const f = fixture('head'); f.skin.bodyIk!.binding.controls[0]!.target = { kind: 'position', position: [0, 1.6, -10] }; f.out();
    expect(f.skin.bodyIk!.diagnostics.some(d => d.code === 'IK_AIM_LIMIT')).toBe(true);
    f.sk.locals[0]!.s = [1, 2, 1]; f.out(); expect(f.skin.bodyIk!.diagnostics.some(d => d.code === 'IK_SCALE')).toBe(true);
  });
});
