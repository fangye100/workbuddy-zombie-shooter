/**
 * pose-solver.test.ts —— 共享根求解测试（MR-04；A05 / A10 / A17 归此）。
 *
 * 用模板 rig + 手工帧数据（不走 BVH），锚点/预期全部手算。
 */
import { describe, it, expect } from 'vitest';
import { buildTargetRig } from '../../src/services/binding/motion-retarget/rig-calibration';
import { solvePose } from '../../src/services/binding/motion-retarget/pose-solver';
import { rotateVec3 } from '../../src/services/binding/motion-retarget/two-bone-solver';
import { defaultRetargetTolerances } from '@aether/scene';
import type { ContactSegment, SourceMotion, RetargetRig } from '../../src/services/binding/motion-retarget/contracts';

function fakeMotion(frames: number, fps = 30): SourceMotion {
  const times = new Float64Array(frames);
  for (let f = 0; f < frames; f++) times[f] = f / fps;
  const ident = (n: number): Float64Array => {
    const a = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) a[i * 4 + 3] = 1;
    return a;
  };
  return {
    fingerprint: 'fp1_test',
    boneNames: ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'],
    times,
    localRotations: {},
    worldRotations: { LeftFoot: ident(frames), RightFoot: ident(frames) },
    worldPositions: {},
    rootBone: 'Hips',
    rootMode: 'world-trajectory',
    canWorldLock: true,
    unitScaleSource: 1,
    upAxisSource: 'y',
  };
}

function seg(marker: string, chainId: string, anchor: [number, number, number], startS: number, endS: number): ContactSegment {
  return {
    id: `${marker}@${startS}s`,
    marker,
    chainId,
    startS,
    endS,
    mode: 'support',
    space: 'world',
    origin: 'annotated',
    confidence: 1,
    anchor,
    pivot: null,
  };
}

/** 模板 rest 位置（手算）：踝 (±0.1, 0.03, 0)，ball 标记偏移 (0,−0.03,+0.09) */
const LEFT_ANCHOR: [number, number, number] = [0.1, 0, 0.09];
const RIGHT_ANCHOR: [number, number, number] = [-0.1, 0, 0.09];

function runSolve(rig: RetargetRig, sm: SourceMotion, segments: ContactSegment[], rootY: number | ((f: number) => number)) {
  const frames = sm.times.length;
  const rootPos = new Float64Array(frames * 3);
  const rootQ = new Float64Array(frames * 4);
  const locals: Record<string, [number, number, number, number]>[] = [];
  for (let f = 0; f < frames; f++) {
    rootPos[f * 3] = 0;
    rootPos[f * 3 + 1] = typeof rootY === 'function' ? rootY(f) : rootY;
    rootPos[f * 3 + 2] = 0;
    rootQ[f * 4 + 3] = 1;
    locals.push({});
  }
  return solvePose({
    targetRig: rig,
    sourceMotion: sm,
    baselineLocals: locals,
    rootPositions: rootPos,
    rootQuats: rootQ,
    segments,
    tolerances: defaultRetargetTolerances(),
  });
}

// ───────────────────────── A05：双支撑精确 ─────────────────────────

describe('solvePose · A05 双支撑', () => {
  const { rig } = buildTargetRig({});

  it.each([0.25, 1, 2])('straight and proportion-adjusted legs preserve independent FK at scale %s', (scale) => {
    for (const fractions of [[0.42, 0.45], [0.2, 0.67]]) {
      const target = structuredClone(rig);
      for (const bone of Object.values(target.bones)) bone.restLocalT = bone.restLocalT.map(v => v * scale) as [number, number, number];
      for (const marker of Object.values(target.markers)) marker.offset = marker.offset.map(v => v * scale) as [number, number, number];
      for (const side of ['Left', 'Right']) {
        target.bones[`${side}Leg`]!.restLocalT = [0, -fractions[0]! * scale, 0];
        target.bones[`${side}Foot`]!.restLocalT = [0, -fractions[1]! * scale, 0];
      }
      target.pelvisHeightM *= scale;
      for (const height of [1, 1 - 1e-9]) {
        const result = runSolve(target, fakeMotion(9), [
          seg('LeftFoot.ball', 'LeftLeg', [0.1 * scale, 0, 0.09 * scale], 0, 1),
          seg('RightFoot.ball', 'RightLeg', [-0.1 * scale, 0, 0.09 * scale], 0, 1),
        ], height * scale);
        for (const frame of result.frames) for (const side of ['Left', 'Right']) {
          for (const [parent, child] of [[`${side}UpLeg`, `${side}Leg`], [`${side}Leg`, `${side}Foot`]]) {
            const expectedOffset = rotateVec3(frame.boneQuat[parent!]!, target.bones[child!]!.restLocalT);
            const actualOffset = frame.bonePos[child!]!.map((v, i) => v - frame.bonePos[parent!]![i]!);
            expect(Math.hypot(...actualOffset.map((v, i) => v - expectedOffset[i]!))).toBeLessThan(1e-10);
          }
        }
        for (const dev of result.anchorDeviations) expect(dev.maxM).toBeLessThan(1e-9);
      }
    }
  });

  it('contact correction retains source axial twist when endpoint geometry is unchanged', () => {
    const half = Math.PI / 12;
    const twist: [number, number, number, number] = [0, Math.sin(half), 0, Math.cos(half)];
    const result = solvePose({
      targetRig: rig, sourceMotion: fakeMotion(1),
      baselineLocals: [{ LeftUpLeg: twist, LeftLeg: [0, -twist[1], 0, twist[3]] }],
      rootPositions: new Float64Array([0, 1, 0]), rootQuats: new Float64Array([0, 0, 0, 1]),
      segments: [seg('LeftFoot.ball', 'LeftLeg', LEFT_ANCHOR, 0, 1)], tolerances: defaultRetargetTolerances(),
    });
    expect(result.anchorDeviations[0]!.maxM).toBeLessThan(1e-9);
    result.frames[0]!.boneQuat.LeftUpLeg!.forEach((v, i) => expect(v).toBeCloseTo(twist[i]!, 12));
  });

  it.each([false, true])('retains unmapped reference frames and animated toe locals with support=%s', (contact) => {
    const target = structuredClone(rig);
    const half = Math.PI / 12;
    const authoredToe: [number, number, number, number] = [Math.sin(half), 0, 0, Math.cos(half)];
    const leafRest: [number, number, number, number] = [0, 0, Math.sin(half), Math.cos(half)];
    target.bones.LeftHandTip!.restLocalR = leafRest;
    const result = solvePose({
      targetRig: target, sourceMotion: fakeMotion(1), baselineLocals: [{ LeftToeBase: authoredToe }],
      rootPositions: new Float64Array([0, 1, 0]), rootQuats: new Float64Array([0, 0, 0, 1]),
      segments: contact ? [seg('LeftFoot.ball', 'LeftLeg', LEFT_ANCHOR, 0, 1)] : [],
      tolerances: defaultRetargetTolerances(),
    });
    const frame = result.frames[0]!;
    frame.boneQuat.LeftHandTip!.forEach((v, i) => expect(v).toBeCloseTo(leafRest[i]!, 12));
    frame.boneQuat.LeftToeBase!.forEach((v, i) => expect(v).toBeCloseTo(authoredToe[i]!, 12));
    const offset = rotateVec3(authoredToe, target.bones.LeftToeTip!.restLocalT);
    const tipOffset = frame.bonePos.LeftToeTip!.map((v, i) => v - frame.bonePos.LeftToeBase![i]!);
    expect(Math.hypot(...tipOffset.map((v, i) => v - offset[i]!))).toBeLessThan(1e-12);
  });

  it('rebuilds thigh and shin side branches from corrected parents without overwriting IK joints', () => {
    const target = { ...rig, bones: { ...rig.bones }, order: [...rig.order] };
    for (const [name, parent] of [['ThighSide', 'LeftUpLeg'], ['ShinSide', 'LeftLeg'], ['SideLeaf', 'ThighSide']]) {
      target.bones[name!] = { name: name!, parent: parent!, restLocalT: [0, -0.2, 0], restLocalR: [0, 0, 0, 1] };
      const index = target.order.indexOf(parent!);
      target.order.splice(index + 1, 0, name!);
    }
    const res = runSolve(target, fakeMotion(3), [seg('LeftFoot.ball', 'LeftLeg', LEFT_ANCHOR, 0, 1)], 0.95);
    for (const frame of res.frames) {
      for (const name of ['ThighSide', 'ShinSide', 'SideLeaf']) {
        const bone = target.bones[name]!;
        const parent = bone.parent!;
        const offset = rotateVec3(frame.boneQuat[parent]!, bone.restLocalT);
        const actual = frame.bonePos[name]!.map((v, i) => v - frame.bonePos[parent]![i]!);
        expect(Math.hypot(...actual.map((v, i) => v - offset[i]!))).toBeLessThan(1e-12);
        frame.boneQuat[name]!.forEach((v, i) => expect(v).toBeCloseTo(frame.boneQuat[parent]![i]!, 12));
      }
    }
    expect(res.anchorDeviations[0]!.maxM).toBeLessThan(1e-9);
  });

  it('可达双支撑：标记误差 ≤1e-4、骨长误差 ≤1e-6、根修正 ≈0', () => {
    const sm = fakeMotion(3);
    const res = runSolve(rig, sm, [
      seg('LeftFoot.ball', 'LeftLeg', LEFT_ANCHOR, 0, 0.1),
      seg('RightFoot.ball', 'RightLeg', RIGHT_ANCHOR, 0, 0.1),
    ], 0.95); // 微屈膝，避开直腿边界
    expect(res.anchorDeviations.length).toBe(2);
    for (const d of res.anchorDeviations) expect(d.maxM).toBeLessThan(1e-4);
    for (const f of res.frames) {
      for (const [hip, knee] of [['LeftUpLeg', 'LeftLeg'], ['RightUpLeg', 'RightLeg']] as const) {
        const p = f.bonePos[hip]!;
        const k = f.bonePos[knee]!;
        const l = Math.hypot(k[0] - p[0], k[1] - p[1], k[2] - p[2]);
        expect(Math.abs(l - 0.42)).toBeLessThan(1e-6);
      }
    }
    const corr = res.rootCorrections;
    expect(Math.hypot(corr[0]!, corr[1]!, corr[2]!)).toBeLessThan(1e-6);
  });

  it('★ A18 后半：求解后根朝向与输入逐分量一致（锚点求解不污染 yaw），链下子树随新脚变换重挂', () => {
    const sm = fakeMotion(3);
    // 根朝向给一个非平凡 yaw（第 1 帧起 30°）
    const frames = sm.times.length;
    const rootQ = new Float64Array(frames * 4);
    for (let f = 0; f < frames; f++) {
      const a = (f === 0 ? 0 : 30) * Math.PI / 180;
      rootQ[f * 4 + 1] = Math.sin(a / 2);
      rootQ[f * 4 + 3] = Math.cos(a / 2);
    }
    const res = solvePose({
      targetRig: rig,
      sourceMotion: sm,
      baselineLocals: Array.from({ length: frames }, () => ({})),
      rootPositions: new Float64Array(frames * 3).fill(0).map((_, i) => (i % 3 === 1 ? 0.95 : 0)),
      rootQuats: rootQ,
      segments: [
        seg('LeftFoot.ball', 'LeftLeg', LEFT_ANCHOR, 0, 0.1),
        seg('RightFoot.ball', 'RightLeg', RIGHT_ANCHOR, 0, 0.1),
      ],
      tolerances: defaultRetargetTolerances(),
    });
    for (let f = 0; f < frames; f++) {
      for (let k = 0; k < 4; k++) {
        expect(res.frames[f]!.rootQuat[k]).toBeCloseTo(rootQ[f * 4 + k]!, 12);
      }
      // 子树重挂：ToeBase 世界 = 踝世界 + R_foot_world · rest 偏移
      const toe = res.frames[f]!.bonePos.LeftToeBase!;
      const ankle = res.frames[f]!.bonePos.LeftFoot!;
      const fq = res.frames[f]!.boneQuat.LeftFoot!;
      const restOff = rig.bones.LeftToeBase!.restLocalT;
      const rot = rotateVec3(fq, restOff);
      expect(Math.hypot(toe[0] - ankle[0] - rot[0], toe[1] - ankle[1] - rot[1], toe[2] - ankle[2] - rot[2])).toBeLessThan(1e-9);
    }
  });

  it('非等比腿（左 0.30/0.35）：根被拉低补可达，接触仍保持 ≤1e-4', () => {
    const short = JSON.parse(JSON.stringify(rig)) as RetargetRig;
    short.bones.LeftLeg!.restLocalT = [0, -0.3, 0];
    short.bones.LeftFoot!.restLocalT = [0, -0.35, 0];
    const sm = fakeMotion(3);
    const res = runSolve(short, sm, [
      seg('LeftFoot.ball', 'LeftLeg', LEFT_ANCHOR, 0, 0.1),
      seg('RightFoot.ball', 'RightLeg', RIGHT_ANCHOR, 0, 0.1),
    ], 0.95);
    const left = res.anchorDeviations.find((d) => d.segmentId.includes('Left'))!;
    expect(left.maxM).toBeLessThan(1e-4);
    // 根向下修正（0.95 → ~0.78），右腿弯膝吸收
    const dy = res.rootCorrections[1]!;
    expect(dy).toBeLessThan(-0.1);
    expect(dy).toBeGreaterThan(-0.3);
    // 右腿骨长仍然保持
    for (const f of res.frames) {
      const l = Math.hypot(
        f.bonePos.RightLeg![0] - f.bonePos.RightUpLeg![0],
        f.bonePos.RightLeg![1] - f.bonePos.RightUpLeg![1],
        f.bonePos.RightLeg![2] - f.bonePos.RightUpLeg![2],
      );
      expect(Math.abs(l - 0.42)).toBeLessThan(1e-6);
    }
  });

  it('等比 2m/0.5m 缩放 rig：同一锚点（各自坐标）误差同 ≤1e-4', () => {
    const sm = fakeMotion(3);
    for (const k of [2, 0.5]) {
      const scaled = JSON.parse(JSON.stringify(rig)) as RetargetRig;
      for (const b of Object.values(scaled.bones)) {
        b.restLocalT = [b.restLocalT[0] * k, b.restLocalT[1] * k, b.restLocalT[2] * k];
      }
      for (const m of Object.values(scaled.markers)) {
        m.offset = [m.offset[0] * k, m.offset[1] * k, m.offset[2] * k];
      }
      scaled.pelvisHeightM *= k;
      const res = runSolve(scaled, sm, [
        seg('LeftFoot.ball', 'LeftLeg', [0.1 * k, 0, 0.09 * k], 0, 0.1),
        seg('RightFoot.ball', 'RightLeg', [-0.1 * k, 0, 0.09 * k], 0, 0.1),
      ], 0.95 * k);
      for (const d of res.anchorDeviations) expect(d.maxM).toBeLessThan(1e-4);
    }
  });
});

// ───────────────────────── A10：冲突定位 ─────────────────────────

describe('solvePose · A10 不可达冲突', () => {
  const { rig } = buildTargetRig({});

  it('shared pelvis moves away from an inner reach violation on unequal legs', () => {
    const target = structuredClone(rig);
    for (const side of ['Left', 'Right']) {
      target.bones[`${side}Leg`]!.restLocalT = [0, -0.8, 0];
      target.bones[`${side}Foot`]!.restLocalT = [0, -0.2, 0];
    }
    const result = runSolve(target, fakeMotion(2), [
      seg('LeftFoot.ball', 'LeftLeg', LEFT_ANCHOR, 0, 1),
      seg('RightFoot.ball', 'RightLeg', RIGHT_ANCHOR, 0, 1),
    ], 0.33);
    expect(result.rootCorrections[1]).toBeCloseTo(0.4, 8);
    expect(result.converged).toBe(true);
    expect(result.reachResidualsM.inner).toBeLessThan(1e-9);
    for (const dev of result.anchorDeviations) expect(dev.maxM).toBeLessThan(1e-9);
  });

  it('锚点相距 3m（互不可达）：逐约束残差定位到帧、无 NaN、不静默拉骨', () => {
    const sm = fakeMotion(2);
    const res = runSolve(rig, sm, [
      seg('LeftFoot.ball', 'LeftLeg', [1.5, 0, 0.09], 0, 0.1),
      seg('RightFoot.ball', 'RightLeg', [-1.5, 0, 0.09], 0, 0.1),
    ], 0.95);
    expect(res.reachResidualsM.outer).toBeGreaterThan(0.5);
    const reachDiags = res.diagnostics.filter((d) => d.code === 'MRP_REACH_OUTER');
    expect(reachDiags.length).toBeGreaterThanOrEqual(2);
    for (const d of reachDiags) {
      expect(d.frame).toBeDefined();
      expect(d.constraint).toBeDefined();
    }
    for (const f of res.frames) {
      for (const p of Object.values(f.bonePos)) {
        expect(Number.isFinite(p[0] + p[1] + p[2])).toBe(true);
      }
      // 骨长仍然保持（夹取不拉骨）
      const l = Math.hypot(
        f.bonePos.LeftLeg![0] - f.bonePos.LeftUpLeg![0],
        f.bonePos.LeftLeg![1] - f.bonePos.LeftUpLeg![1],
        f.bonePos.LeftLeg![2] - f.bonePos.LeftUpLeg![2],
      );
      expect(Math.abs(l - 0.42)).toBeLessThan(1e-6);
    }
  });
});

// ───────────────────────── A17：摆动净空 ─────────────────────────

describe('solvePose · A17 摆动净空', () => {
  const { rig } = buildTargetRig({});

  it('无接触帧根下坠 → 摆动脚被抬起，标记不低于支撑面（容差内）并有诊断', () => {
    const sm = fakeMotion(3);
    const res = runSolve(
      rig,
      sm,
      [seg('LeftFoot.ball', 'LeftLeg', LEFT_ANCHOR, 0, 0.0333)],
      (f) => (f === 2 ? 0.7 : 0.95), // 第 2 帧脱离接触且根下坠
    );
    expect(res.diagnostics.some((d) => d.code === 'MRP_SWING_CLEARANCE_LIFT')).toBe(true);
    const f2 = res.frames[2]!;
    for (const foot of ['LeftFoot', 'RightFoot'] as const) {
      const mk = rig.markers[`${foot}.ball`]!;
      const ankle = f2.bonePos[foot]!;
      const q = f2.boneQuat[foot]!;
      const world = [
        ankle[0] + rotateVec3(q, mk.offset)[0],
        ankle[1] + rotateVec3(q, mk.offset)[1],
        ankle[2] + rotateVec3(q, mk.offset)[2],
      ];
      expect(world[1]).toBeGreaterThanOrEqual(-0.001 * rig.pelvisHeightM);
    }
  });

  it('有接触的脚不受抬脚逻辑影响（contact 段内无 lift 诊断）', () => {
    const sm = fakeMotion(2);
    const res = runSolve(
      rig,
      sm,
      [seg('LeftFoot.ball', 'LeftLeg', LEFT_ANCHOR, 0, 0.05)],
      0.95,
    );
    const lift = res.diagnostics.filter((d) => d.code === 'MRP_SWING_CLEARANCE_LIFT' && d.constraint === 'LeftLeg');
    expect(lift.length).toBe(0);
  });
});
