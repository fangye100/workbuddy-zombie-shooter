/**
 * bake-adapter.test.ts —— 烘焙转换测试（MR-06 数学核心；A15 口径归此）。
 *
 * Adapter unit contracts. Independent matrix playback and skin acceptance live in bake-acceptance.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  bakeWorldSolveToLocal,
  readBackWorld,
  type BakeOutputRig,
  type BakeBone,
} from '../../src/services/binding/motion-retarget/bake-adapter';
import type { WorldSolveClip, WorldPoseFrame, Quat, V3 } from '../../src/services/binding/motion-retarget/contracts';

const h = Math.SQRT1_2;

function bone(name: string, parent: string | null, t: V3, nodeIndex: number, s?: number): BakeBone {
  const b: BakeBone = { name, parent, restLocalT: t, restLocalR: [0, 0, 0, 1], nodeIndex };
  if (s !== undefined) b.restUniformScale = s;
  return b;
}

function rigOf(bones: BakeBone[], fingerprint: string, rootParent?: BakeOutputRig['rootParentWorld']): BakeOutputRig {
  const map: Record<string, BakeBone> = {};
  for (const b of bones) map[b.name] = b;
  return { order: bones.map((b) => b.name), bones: map, fingerprint, rootParentWorld: rootParent ?? null };
}

function clipOf(frames: WorldPoseFrame[], fingerprint: string): WorldSolveClip {
  const times = new Float64Array(frames.length);
  for (let f = 0; f < frames.length; f++) times[f] = f / 30;
  return { times, frames, skeletonFingerprint: fingerprint };
}

/**
 * 两帧世界解。旋转任意，但**父子位置层级一致**（非根骨无平移自由度——
 * 这正是烘焙契约：固定骨长下 child_world = parent_world + R_parent·restT）。
 */
function sampleFrames(restChild: V3 = [0.3, 0.4, 0], restLeaf: V3 = [0.2, -0.2, 0]): WorldPoseFrame[] {
  const rotY = (a: number): Quat => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
  const mk = (f: number): WorldPoseFrame => {
    const rootQ = rotY(0.1 * f);
    const rootP: V3 = [0.1 * f, 1 + 0.02 * f, 0];
    const childQ: Quat = [0.2 / Math.sqrt(1.04), 0, 0, 1 / Math.sqrt(1.04)];
    const childP = addRot(rootQ, rootP, restChild);
    const leafQ: Quat = [0, h, 0, h];
    const leafP = addRot(childQ, childP, restLeaf);
    return {
      t: f / 30,
      rootPos: rootP,
      rootQuat: rootQ,
      bonePos: { Root: rootP, Child: childP, Leaf: leafP },
      boneQuat: { Root: rootQ, Child: childQ, Leaf: leafQ },
    };
  };
  return [mk(0), mk(1), mk(2)];
}

function addRot(q: Quat, p: V3, offset: V3): V3 {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const v = offset;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    p[0] + v[0] + w * tx + (y * tz - z * ty),
    p[1] + v[1] + w * ty + (z * tx - x * tz),
    p[2] + v[2] + w * tz + (x * ty - y * tx),
  ];
}

const RIG_FP = 'fp1_output1';

describe('bakeWorldSolveToLocal · 读回等价（A15）', () => {
  it('★ 恒等父空间：局部轨道 FK 读回 = 原世界解（≤1e-9），根平移 = 世界位置（不二次变换）', () => {
    const rig = rigOf([bone('Root', null, [0, 1, 0], 0), bone('Child', 'Root', [0.3, 0.4, 0], 1), bone('Leaf', 'Child', [0.2, -0.2, 0], 2)], RIG_FP);
    const clip = clipOf(sampleFrames(), RIG_FP);
    const { tracks, diagnostics } = bakeWorldSolveToLocal(clip, rig);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(tracks!.length).toBe(3);
    const back = readBackWorld(tracks!, rig, 3);
    for (let f = 0; f < 3; f++) {
      for (const n of ['Root', 'Child', 'Leaf']) {
        const got = back[f]![n]!;
        const wp = clip.frames[f]!.bonePos[n]!;
        expect(Math.hypot(got.pos[0] - wp[0], got.pos[1] - wp[1], got.pos[2] - wp[2])).toBeLessThan(1e-9);
      }
    }
    // 根轨道平移 = 世界位置原样
    const rootTrack = tracks!.find((t) => t.bone === 'Root')!;
    expect(rootTrack.translations![0]!).toBeCloseTo(clip.frames[0]!.bonePos.Root![0], 12);
  });

  it('★ 父容器（平移+旋转+统一缩放）：读回仍 = 原世界解', () => {
    const rootParent = { pos: [5, 0, 2] as V3, quat: [0, h, 0, h] as Quat, uniformScale: 1 };
    const rig = rigOf(
      [bone('Root', null, [0, 1, 0], 0), bone('Child', 'Root', [0.3, 0.4, 0], 1)],
      RIG_FP,
      rootParent,
    );
    const clip = clipOf(sampleFrames(), RIG_FP);
    const { tracks, diagnostics } = bakeWorldSolveToLocal(clip, rig);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const back = readBackWorld(tracks!, rig, 3);
    for (let f = 0; f < 3; f++) {
      for (const n of ['Root', 'Child']) {
        const got = back[f]![n]!;
        const wp = clip.frames[f]!.bonePos[n]!;
        expect(Math.hypot(got.pos[0] - wp[0], got.pos[1] - wp[1], got.pos[2] - wp[2])).toBeLessThan(1e-9);
      }
    }
  });

  it('★ 中间骨统一缩放 1.3：局部平移吸收缩放，读回 ≤1e-9', () => {
    // Leaf 的世界位置须按「rest 偏移 × Child 缩放」构造（读回用 rest×scale）
    const clip = clipOf(sampleFrames([0.3, 0.4, 0], [0.2 * 1.3, -0.2 * 1.3, 0]), RIG_FP);
    const rig = rigOf([bone('Root', null, [0, 1, 0], 0), bone('Child', 'Root', [0.3, 0.4, 0], 1, 1.3), bone('Leaf', 'Child', [0.2, -0.2, 0], 2)], RIG_FP);
    const { tracks } = bakeWorldSolveToLocal(clip, rig);
    const back = readBackWorld(tracks!, rig, 3);
    for (let f = 0; f < 3; f++) {
      for (const n of ['Root', 'Child', 'Leaf']) {
        const got = back[f]![n]!;
        const wp = clip.frames[f]!.bonePos[n]!;
        expect(Math.hypot(got.pos[0] - wp[0], got.pos[1] - wp[1], got.pos[2] - wp[2])).toBeLessThan(1e-9);
      }
    }
  });

  it('★ 不同输出父空间：同一世界解各自适配后读回等价（都 = 原世界解）', () => {
    // rigB 声明容器缩放 2：其骨架真实几何 = rest 偏移×2，世界解须按同一几何构造
    // （R08 可表达性校验会拒绝「容器缩放 2 + 未缩放偏移」的不自洽输入）
    const clipA = clipOf(sampleFrames(), RIG_FP);
    const clipB = clipOf(sampleFrames([0.6, 0.8, 0]), RIG_FP);
    const rigA = rigOf([bone('Root', null, [0, 1, 0], 0), bone('Child', 'Root', [0.3, 0.4, 0], 1)], RIG_FP);
    const rigB = rigOf(
      [bone('Root', null, [0, 1, 0], 0), bone('Child', 'Root', [0.3, 0.4, 0], 1)],
      RIG_FP,
      { pos: [-1, 7, 3], quat: [h, 0, 0, h], uniformScale: 2 },
    );
    const a = bakeWorldSolveToLocal(clipA, rigA).tracks!;
    const b = bakeWorldSolveToLocal(clipB, rigB).tracks!;
    const backA = readBackWorld(a, rigA, 3);
    const backB = readBackWorld(b, rigB, 3);
    for (let f = 0; f < 3; f++) {
      for (const n of ['Root', 'Child']) {
        const wa = clipA.frames[f]!.bonePos[n]!;
        const wb = clipB.frames[f]!.bonePos[n]!;
        for (const [back, w] of [[backA, wa] as const, [backB, wb] as const]) {
          const got = back[f]![n]!;
          expect(Math.hypot(got.pos[0] - w[0], got.pos[1] - w[1], got.pos[2] - w[2])).toBeLessThan(1e-9);
        }
      }
    }
  });
});

describe('bakeWorldSolveToLocal · 拒绝与缺失', () => {
  it.each([0, -1, Infinity, NaN])('rejects invalid root container scale %s before writing nonfinite tracks', (scale) => {
    const rig = rigOf([bone('Root', null, [0, 1, 0], 0)], RIG_FP,
      { pos: [0, 0, 0], quat: [0, 0, 0, 1], uniformScale: scale });
    const result = bakeWorldSolveToLocal(clipOf(sampleFrames(), RIG_FP), rig);
    expect(result.tracks).toBeNull();
    expect(result.diagnostics.some((d) => d.code === 'MRB_SCALE')).toBe(true);
  });

  it('rejects a partially missing track with a diagnostic instead of throwing', () => {
    const frames = sampleFrames();
    delete (frames[1]!.boneQuat as Record<string, Quat>).Root;
    const result = bakeWorldSolveToLocal(clipOf(frames, RIG_FP), rigOf([bone('Root', null, [0, 1, 0], 0)], RIG_FP));
    expect(result.tracks).toBeNull();
    expect(result.diagnostics.some((d) => d.code === 'MRB_POSE_SAMPLE')).toBe(true);
  });

  it('rejects a missing actual parent instead of silently treating the bone as a scene root', () => {
    const result = bakeWorldSolveToLocal(clipOf(sampleFrames(), RIG_FP),
      rigOf([bone('Root', 'MissingArmature', [0, 1, 0], 0)], RIG_FP));
    expect(result.tracks).toBeNull();
    expect(result.diagnostics.some((d) => d.code === 'MRB_GRAPH')).toBe(true);
  });

  it('rejects an out-of-order output graph before computing cumulative scales', () => {
    const result = bakeWorldSolveToLocal(clipOf(sampleFrames(), RIG_FP),
      rigOf([bone('Child', 'Root', [0.3, 0.4, 0], 1), bone('Root', null, [0, 1, 0], 0, 2)], RIG_FP));
    expect(result.tracks).toBeNull();
    expect(result.diagnostics.some((d) => d.code === 'MRB_GRAPH')).toBe(true);
  });
  it('骨架指纹不一致 → 拒绝烘焙（不静默混骨架）', () => {
    const rig = rigOf([bone('Root', null, [0, 1, 0], 0)], 'fp1_other');
    const clip = clipOf(sampleFrames(), RIG_FP);
    const { tracks, diagnostics } = bakeWorldSolveToLocal(clip, rig);
    expect(tracks).toBeNull();
    expect(diagnostics.some((d) => d.code === 'MRB_SKELETON_MISMATCH')).toBe(true);
  });

  it('非正缩放 → 显式拒绝', () => {
    const rig = rigOf([bone('Root', null, [0, 1, 0], 0), bone('Child', 'Root', [0.3, 0.4, 0], 1, -1.2)], RIG_FP);
    const clip = clipOf(sampleFrames(), RIG_FP);
    const { diagnostics } = bakeWorldSolveToLocal(clip, rig);
    expect(diagnostics.some((d) => d.code === 'MRB_SCALE' && d.severity === 'error')).toBe(true);
  });

  it('世界解里缺的骨 → info + 不出轨道，读回保持 rest（不丢轨道不伪造）', () => {
    const frames = sampleFrames();
    delete (frames[0] as { boneQuat: Record<string, Quat> }).boneQuat.Leaf;
    // 只要有一帧缺，整根骨都不出轨道（按当前契约：any 帧有才烘）
    const rig = rigOf([bone('Root', null, [0, 1, 0], 0), bone('Ghost', 'Root', [9, 9, 9], 5)], RIG_FP);
    const clip = clipOf(frames.map((fr) => ({ ...fr, boneQuat: { Root: fr.boneQuat.Root!, Child: fr.boneQuat.Child! }, bonePos: { Root: fr.bonePos.Root!, Child: fr.bonePos.Child! } })), RIG_FP);
    const { tracks, diagnostics } = bakeWorldSolveToLocal(clip, rig);
    expect(diagnostics.some((d) => d.code === 'MRB_BONE_NOT_SOLVED')).toBe(true);
    expect(tracks!.find((t) => t.bone === 'Ghost')).toBeUndefined();
    const back = readBackWorld(tracks!, rig, 3);
    // 缺解骨按「已解父世界 × rest 局部」重建（P2-7：不再把 rest 当世界值凭空放置）
    expect(back[0]!.Ghost!.pos[0]).toBeCloseTo(9, 9);
    expect(back[0]!.Ghost!.pos[1]).toBeCloseTo(10, 9);
    // 第 2 帧根有 yaw(0.2rad)：rest 偏移随之旋转（手算 rotY(0.2)·[9,9,9]）
    const c = Math.cos(0.2);
    const sn = Math.sin(0.2);
    expect(back[2]!.Ghost!.pos[0]).toBeCloseTo(0.2 + 9 * c + 9 * sn, 6);
    expect(back[2]!.Ghost!.pos[2]).toBeCloseTo(-9 * sn + 9 * c, 6);
  });
});
