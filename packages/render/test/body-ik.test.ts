import { describe, expect, it } from 'vitest';
import { mat4, invert, eulerToQuat } from '@aether/core';
import { advancePoseTransition, createBodyIkState, createSkinState, evalJointMatrices, sampleAnimationPose, selectClip, attachedModelFrame, composeSocket, rigidFromMatrix, socketMatrix, type PoseFrameOutput } from '@aether/render';
import { identitySocket,newBodyIkControl, type BodyIkPart, type BodyIkBinding } from '@aether/scene';
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
  it.each([1,.35])('primary实际姿态驱动模型再驱动dependent；weight=%s',weight=>{
    const f=fixture('rightHand'),left=newBodyIkControl('leftHand');f.binding.controls.push(left);f.binding.weight=weight;
    f.skin.bodyIk=createBodyIkState(f.sk,f.binding);const state=f.skin.bodyIk;
    state.attachment={target:{position:weight===1?[-.2,1.3,.35]:[10,1.3,.35],rotation:[...eulerToQuat(0,.7,0)]},
      primary:{controlId:f.control.id,contact:{position:[0,.02,0],rotation:[0,0,0,1]},modelSocket:{position:[.03,0,0],rotation:[...eulerToQuat(.1,0,0)]}},
      dependent:{controlId:left.id,contact:identitySocket(),modelSocket:{position:[.15,0,0],rotation:[0,0,0,1]}}};
    const r=f.sk.joints[f.sk.jointNames.indexOf('RightHand')]!,l=f.sk.joints[f.sk.jointNames.indexOf('LeftHand')]!;
    const frame:PoseFrameOutput={frameStamp:42,stamp:-1,nodes:[r,l],matrices:new Map()};
    const matrices=new Float32Array((f.sk.joints.length+1)*16);evalJointMatrices(f.skin,matrices,frame);
    expect(frame.stamp).toBe(42);const hand=rigidFromMatrix(frame.matrices.get(r)!)!;
    const actual=attachedModelFrame(hand,state.attachment.primary.contact,state.attachment.primary.modelSocket);
    state.attachment.result!.position.forEach((n,i)=>expect(n).toBeCloseTo(actual.position[i]!,6));
    state.attachment.result!.rotation.forEach((n,i)=>expect(Math.abs(n)).toBeCloseTo(Math.abs(actual.rotation[i]!),5));
    if(weight===1){
      const dependent=composeSocket(actual,state.attachment.dependent!.modelSocket),tip=rigidFromMatrix(frame.matrices.get(l)!)!;
      tip.position.forEach((n,i)=>expect(n).toBeCloseTo(dependent.position[i]!,5));
      expect(state.diagnostics.filter(d=>d.code==='IK_SOCKET_RESIDUAL')).toEqual([]);
    }else{
      expect(Math.hypot(...actual.position.map((n,i)=>n-state.attachment!.target.position[i]!))).toBeGreaterThan(5);
      expect(state.diagnostics.some(d=>d.code==='IK_SOCKET_RESIDUAL'&&d.residualM!>0&&d.residualRad!>0)).toBe(true);
    }
    expect(f.out()).toEqual(matrices);
  });
  it('同帧 FK 支持父节点在数组后方，更新后不复用前帧父矩阵',()=>{
    const f=fixture();delete f.skin.bodyIk;
    const a=f.sk.locals[0]!,b=f.sk.locals[1]!;
    f.sk.locals=[{...a,t:[1,0,0]},{...b,t:[2,0,0]}];
    f.sk.parent=[1,-1];f.sk.joints=[0,1];f.sk.normalization=socketMatrix({position:[0,0,0],rotation:[0,0,0,1]});
    f.sk.inverseBind=new Float32Array(32);for(let i=0;i<32;i++)f.sk.inverseBind[i]=i%16%5===0?1:0;
    const frame={frameStamp:1,nodes:[0],matrices:new Map<number,Float32Array<ArrayBuffer>>(),stamp:0};
    evalJointMatrices(f.skin,new Float32Array(48),frame);expect(frame.matrices.get(0)![12]).toBe(3);
    f.sk.locals[1]!.t=[4,0,0];frame.frameStamp=2;evalJointMatrices(f.skin,new Float32Array(48),frame);
    expect(frame.matrices.get(0)![12]).toBe(5);expect(frame.stamp).toBe(2);
  });
  it('刚性变换拒绝负/非均匀/shear，并正确恢复规整化旋转',()=>{
    const q=eulerToQuat(.2,.6,-.3),frame={position:[1,2,3] as [number,number,number],rotation:[...q] as [number,number,number,number]};
    const m=socketMatrix(frame,.01);const parsed=rigidFromMatrix(m)!;parsed.rotation.forEach((n,i)=>expect(n).toBeCloseTo(q[i]!,5));
    const mirrored=socketMatrix(frame,-1);expect(rigidFromMatrix(mirrored)).toBeNull();m[0]!*=2;expect(rigidFromMatrix(m)).toBeNull();
  });
  it('applies IK after pose transition and never captures IK into the next animation snapshot', () => {
    const f = fixture(); f.skin.clips = [{ name:'A', duration:1, tracks:[] },{ name:'B', duration:1, tracks:[] }];
    f.skin.clip=0; const solved=f.out(); selectClip(f.skin,1,.2); advancePoseTransition(f.skin,.1);
    expect(sampleAnimationPose(f.skin)).toEqual(f.sk.locals);
    expect(f.out()).toEqual(solved);
    selectClip(f.skin,0,.2); expect(sampleAnimationPose(f.skin)).toEqual(f.sk.locals); expect(f.out()).toEqual(solved);
  });
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
