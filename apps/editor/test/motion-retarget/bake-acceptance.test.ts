/**
 * Final delivery owner (docs/16 A01/A08/A15): calibrated BVH -> solve -> local tracks ->
 * independent matrix playback. The oracle imports no production quaternion/FK/readback helpers.
 * Synthetic motion proves numerical contracts; it does not claim real mocap or GPU acceptance.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultRecipe, retargetFingerprint, RETARGET_META_SCHEMA_VERSION, type RetargetCalibration } from '@aether/scene';
import { parseBvh } from '../../src/services/binding/bvh-parser';
import { buildSourceMotion, sourceRestDirections } from '../../src/services/binding/motion-retarget/source-motion';
import { buildTargetRig, computeDirectionBaseline } from '../../src/services/binding/motion-retarget/rig-calibration';
import { retargetMotion } from '../../src/services/binding/motion-retarget/pipeline';
import { bakeWorldSolveToLocal, type BakeOutputRig, type LocalTrack } from '../../src/services/binding/motion-retarget/bake-adapter';
import type { Quat, RetargetEnvironment, RetargetRig, V3, WorldSolveClip } from '../../src/services/binding/motion-retarget/contracts';
import { buildBvhText, type BvhSpec } from './fixture';

type Matrix = number[]; // row-major, column vectors
const I: Quat = [0, 0, 0, 1];
function trs(p: V3, q: Quat, scale = 1): Matrix {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * scale, 2 * (x * y - z * w) * scale, 2 * (x * z + y * w) * scale, p[0],
    2 * (x * y + z * w) * scale, (1 - 2 * (x * x + z * z)) * scale, 2 * (y * z - x * w) * scale, p[1],
    2 * (x * z - y * w) * scale, 2 * (y * z + x * w) * scale, (1 - 2 * (x * x + y * y)) * scale, p[2],
    0, 0, 0, 1,
  ];
}
function mul(a: Matrix, b: Matrix): Matrix {
  return Array.from({ length: 16 }, (_, i) => {
    const r = Math.floor(i / 4), c = i % 4;
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[r * 4 + k]! * b[k * 4 + c]!;
    return v;
  });
}
function point(m: Matrix, v: V3): V3 {
  return [0, 1, 2].map((r) => m[r * 4]! * v[0] + m[r * 4 + 1]! * v[1] + m[r * 4 + 2]! * v[2] + m[r * 4 + 3]!) as V3;
}
function inverseSimilarity(m: Matrix): Matrix {
  const scaleSquared = m[0]! ** 2 + m[4]! ** 2 + m[8]! ** 2;
  const result = trs([0, 0, 0], I);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) result[r * 4 + c] = m[c * 4 + r]! / scaleSquared;
    result[r * 4 + 3] = -(result[r * 4]! * m[3]! + result[r * 4 + 1]! * m[7]! + result[r * 4 + 2]! * m[11]!);
  }
  return result;
}
function closeVec(actual: V3, expected: V3, eps = 1e-6): void {
  expect(Math.hypot(...actual.map((v, i) => v - expected[i]!))).toBeLessThan(eps);
}
function playback(output: BakeOutputRig, tracks: LocalTrack[], f: number): Record<string, Matrix> {
  const byNode = new Map(tracks.map((track) => [track.nodeIndex, track]));
  const root = output.rootParentWorld;
  const container = root ? trs(root.pos, root.quat, root.uniformScale) : trs([0, 0, 0], I);
  const world: Record<string, Matrix> = {};
  for (const name of output.order) {
    const bone = output.bones[name]!;
    const track = byNode.get(bone.nodeIndex);
    const p = track?.translations ? Array.from(track.translations.slice(f * 3, f * 3 + 3)) as V3 : bone.restLocalT;
    const q = track ? Array.from(track.rotations.slice(f * 4, f * 4 + 4)) as Quat : bone.restLocalR;
    world[name] = mul(bone.parent === null ? container : world[bone.parent]!, trs(p, q, bone.restUniformScale ?? 1));
  }
  return world;
}

const environment: RetargetEnvironment = {
  sourcePlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
  targetPlane: { origin: [0, 0, 0], normal: [0, 1, 0] }, origin: 'recipe-default', sceneNodeId: null,
};
const sourceCalibration: RetargetCalibration = {
  schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source', pelvisHeightM: 1,
  supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
  unitScale: 0.01, upAxis: 'y', rotationBaseline: 'direction',
  markers: {
    'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' },
    'RightFoot.ball': { bone: 'RightFoot', offset: [0, -0.03, 0.09], origin: 'manual' },
  },
};
function target(scale: number, disproportionate = false): RetargetRig {
  const base = structuredClone(buildTargetRig({}).rig);
  for (const bone of Object.values(base.bones)) bone.restLocalT = bone.restLocalT.map((v) => v * scale) as V3;
  for (const marker of Object.values(base.markers)) marker.offset = marker.offset.map((v) => v * scale) as V3;
  base.pelvisHeightM *= scale;
  for (const chain of base.chains) chain.lengthM *= scale;
  if (disproportionate) {
    for (const side of ['Left', 'Right']) {
      base.bones[`${side}Leg`]!.restLocalT = [0, -0.30 * scale, 0];
      base.bones[`${side}Foot`]!.restLocalT = [0, -0.57 * scale, 0];
      base.bones[`${side}ForeArm`]!.restLocalT[0] *= 0.7;
      base.bones[`${side}Hand`]!.restLocalT[0] *= 1.3;
    }
  }
  for (const chain of base.chains) {
    chain.lengthM = chain.joints.slice(1).reduce((length, name) => length + Math.hypot(...base.bones[name]!.restLocalT), 0);
  }
  base.fingerprint = retargetFingerprint({ bones: base.bones, markers: base.markers, height: base.pelvisHeightM });
  return base;
}
function outputRig(rig: RetargetRig, containerScale = 1): BakeOutputRig {
  return {
    order: [...rig.order], fingerprint: rig.fingerprint,
    bones: Object.fromEntries(rig.order.map((name, nodeIndex) => [name, {
      ...rig.bones[name]!, nodeIndex, restLocalT: rig.bones[name]!.restLocalT.map((v) => v / containerScale) as V3,
    }])),
    rootParentWorld: containerScale === 1 ? null : {
      pos: [3, 0.2, -2], quat: [0, Math.sin(0.31), 0, Math.cos(0.31)], uniformScale: containerScale,
    },
  };
}
function run(spec: BvhSpec, rig: RetargetRig, annotations: Parameters<typeof createDefaultRecipe>[2] = {}) {
  const bvh = parseBvh(buildBvhText({ frames: 31, ...spec }));
  const source = buildSourceMotion(bvh, { rootMotion: 'world-trajectory' });
  const recipe = createDefaultRecipe(
    { guid: 'as_src00001', path: 'assets/x/motion.bvh', contentHash: 'sha256:a' },
    { guid: 'as_tgt00001', path: 'assets/x/target.glb', contentHash: 'sha256:b' }, annotations,
  );
  const outcome = retargetMotion({ source, targetRig: rig, sourceCalibration, recipe, environment,
    baseline: computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, rig) });
  expect(outcome.status, JSON.stringify(outcome.diagnostics)).not.toBe('failed');
  expect(outcome.clip).not.toBeNull();
  return { outcome, source };
}
function delivered(clip: WorldSolveClip, output: BakeOutputRig): Record<string, Matrix>[] {
  const baked = bakeWorldSolveToLocal(clip, output);
  expect(baked.tracks, JSON.stringify(baked.diagnostics)).not.toBeNull();
  const bindWorld = playback(output, [], 0);
  const frames = clip.frames.map((frame, f) => {
    const world = playback(output, baked.tracks!, f);
    for (const name of Object.keys(frame.bonePos)) {
      const actual = world[name]!;
      closeVec(point(actual, [0, 0, 0]), frame.bonePos[name]!);
      const expected = trs(frame.bonePos[name]!, frame.boneQuat[name]!);
      // Compare the complete orientation basis, including roll; do not compare only a long axis.
      const scale = Math.hypot(actual[0]!, actual[4]!, actual[8]!);
      for (const c of [0, 1, 2]) for (const r of [0, 1, 2]) {
        expect(actual[r * 4 + c]! / scale).toBeCloseTo(expected[r * 4 + c]!, 8);
      }
      // Actual inverse-bind skin contract: M_pose * inverse(M_bind) * vertex_bind.
      const local: V3 = [0.013, -0.017, 0.021];
      const bindVertex = point(bindWorld[name]!, local);
      const skin = mul(actual, inverseSimilarity(bindWorld[name]!));
      closeVec(point(skin, bindVertex), point(expected, local.map((v) => v * scale) as V3));
    }
    return world;
  });
  return frames;
}

describe('calibrated motion delivery through independent matrix playback', () => {
  it.each([2 / 1.94, 0.5 / 1.94])('standing support at body scale %s preserves strict similarity and is bakeable', (scale) => {
    const rig = target(scale);
    const { outcome, source } = run({}, rig);
    expect(outcome.coverage).toContain('world-lock');
    const frames = delivered(outcome.clip!, outputRig(rig));
    for (let f = 0; f < frames.length; f++) {
      for (const name of source.boneNames) {
        const expected = Array.from(source.worldPositions[name]!.slice(f * 3, f * 3 + 3)).map((v) => v * scale) as V3;
        closeVec(point(frames[f]![name]!, [0, 0, 0]), expected, 1e-5);
        const rotation = outcome.clip!.frames[f]!.boneQuat[name]!;
        expect(2 * Math.acos(Math.min(1, Math.abs(rotation[3])))).toBeLessThan(1e-5);
      }
    }
  });

  it('nonproportional legs deliver a fixed stance through a rotated and scaled nonjoint root parent', () => {
    const rig = target(0.5, true);
    const { outcome } = run({}, rig);
    const frames = delivered(outcome.clip!, outputRig(rig, 2));
    for (const frame of frames) for (const side of ['Left', 'Right']) {
      const marker = rig.markers[`${side}Foot.ball`]!;
      // Output local offsets are in a container with 2x scale.
      closeVec(point(frame[marker.bone]!, marker.offset.map((v) => v / 2) as V3), [side === 'Left' ? 0.05 : -0.05, 0, 0.045], 1e-4);
    }
  });

  it('jump support -> flight -> support preserves the source height arc and final local-track delivery', () => {
    const scale = 0.25;
    const rig = target(scale);
    const { outcome, source } = run({ rootPos: (f) => [0, f >= 8 && f <= 22 ? 100 + 30 * Math.sin((f - 8) * Math.PI / 14) : 100, 0] }, rig);
    expect(outcome.coverage).toContain('world-lock');
    const frames = delivered(outcome.clip!, outputRig(rig));
    const apex = 15;
    closeVec(point(frames[apex]!.Hips!, [0, 0, 0]), [0, source.worldPositions.Hips![apex * 3 + 1]! * scale, 0], 1e-5);
    expect(point(frames[apex]!.LeftFoot!, [0, 0, 0])[1]).toBeGreaterThan(0.07);
  });

  it('turning free motion preserves source yaw through a nonidentity reference foot frame', () => {
    const rig = target(1);
    const foot = rig.bones.LeftFoot!;
    foot.restLocalR = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const marker = rig.markers['LeftFoot.ball']!;
    marker.offset = [-0.03, 0, 0.09];
    const heel = rig.markers['LeftFoot.heel']!;
    heel.offset = [-0.03, 0, -0.05];
    const { outcome } = run({ rootPos: () => [0, 130, 0], rot: (f, name) => name === 'Hips' ? [0, f * 3, 0] : [0, 0, 0] }, rig);
    const frames = delivered(outcome.clip!, outputRig(rig, 2));
    for (let f = 0; f < frames.length; f++) {
      const forward = point(frames[f]!.Hips!, [0, 0, 0.5]);
      const origin = point(frames[f]!.Hips!, [0, 0, 0]);
      closeVec(forward.map((v, i) => v - origin[i]!) as V3, [Math.sin(f * Math.PI / 60), 0, Math.cos(f * Math.PI / 60)]);
      const expectedFoot = mul(trs([0, 0, 0], [0, Math.sin(f * Math.PI / 120), 0, Math.cos(f * Math.PI / 120)]),
        trs([0, 0, 0], foot.restLocalR));
      for (const r of [0, 1, 2]) for (const c of [0, 1, 2]) {
        expect(frames[f]!.LeftFoot![r * 4 + c]! / 2).toBeCloseTo(expectedFoot[r * 4 + c]!, 8);
      }
    }
  });

  it('rest-only nonjoint nodes between animated joints retain their actual scale and reference rotation', () => {
    const rig = target(1);
    const { outcome } = run({ rot: (f, name) => name === 'LeftArm' ? [0, 0, f] : [0, 0, 0] }, rig);
    const basic = outputRig(rig, 2);
    const bones = { ...basic.bones };
    const order = [...basic.order];
    const index = order.indexOf('LeftForeArm');
    order.splice(index, 0, 'ArmHelper');
    bones.ArmHelper = { name: 'ArmHelper', parent: 'LeftArm', nodeIndex: 100,
      restLocalT: [0, 0, 0], restLocalR: [Math.sin(0.2), 0, 0, Math.cos(0.2)], restUniformScale: 1.5 };
    bones.LeftForeArm = { ...bones.LeftForeArm!, parent: 'ArmHelper', restLocalR: [-Math.sin(0.2), 0, 0, Math.cos(0.2)] };
    for (const name of ['LeftForeArm', 'LeftHand', 'LeftHandTip']) {
      bones[name] = { ...bones[name]!, restLocalT: bones[name]!.restLocalT.map((v) => v / 1.5) as V3 };
    }
    delivered(outcome.clip!, { ...basic, order, bones });
  });

  it('IK updates thigh and calf side branches before delivering their local tracks', () => {
    const initial = target(1);
    const rig: RetargetRig = {
      ...initial,
      order: [...initial.order, 'LeftThighTwist', 'LeftCalfTwist'],
      bones: {
        ...initial.bones,
        LeftThighTwist: { name: 'LeftThighTwist', parent: 'LeftUpLeg', restLocalT: [0, -0.2, 0], restLocalR: I },
        LeftCalfTwist: { name: 'LeftCalfTwist', parent: 'LeftLeg', restLocalT: [0, -0.2, 0], restLocalR: I },
      },
    };
    const { outcome } = run({ frames: 9, rootPos: (f) => [f * 0.3, 100, 0] }, rig,
      { annotations: [{ marker: 'LeftFoot.ball', startS: 0, endS: 0.2, mode: 'support' }] });
    delivered(outcome.clip!, outputRig(rig));
  });

  it('walk-like alternating leg motion delivers every frame with explicit left support then free swing', () => {
    const rig = target(2 / 1.94, true);
    const { outcome } = run({
      rootPos: (f) => [0, 100, f * 0.35],
      rot: (f, name) => {
        if (name === 'LeftUpLeg') return [8 * Math.sin(f * Math.PI / 15), 0, 0];
        if (name === 'RightUpLeg') return [-8 * Math.sin(f * Math.PI / 15), 0, 0];
        if (name === 'LeftLeg' || name === 'RightLeg') return [8 * Math.max(0, Math.sin(f * Math.PI / 15)), 0, 0];
        return [0, 0, 0];
      },
    }, rig, { annotations: [{ marker: 'LeftFoot.ball', startS: 0, endS: 0.2, mode: 'support' }] });
    expect(outcome.coverage).toContain('world-lock');
    delivered(outcome.clip!, outputRig(rig));
  });
});
