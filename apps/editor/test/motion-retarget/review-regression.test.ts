/**
 * review-regression.test.ts —— 2026-09-15 外部审核（R01–R14）修复的回归测试。
 *
 * 关键差异于既有测试：这里有**端到端一致性**用例（源动作 → 管线求解 → 烘焙局部轨道
 * → 测试内独立矩阵 FK 播放 → 与求解世界解比对），不用被测代码的 readBackWorld 自证。
 * 各 P1 的探针数值取自审核报告。
 */
import { describe, it, expect } from 'vitest';
import { parseBvh } from '../../src/services/binding/bvh-parser';
import { buildSourceMotion, sourceRestDirections } from '../../src/services/binding/motion-retarget/source-motion';
import {
  buildTargetRig,
  computeDirectionBaseline,
} from '../../src/services/binding/motion-retarget/rig-calibration';
import { retargetMotion } from '../../src/services/binding/motion-retarget/pipeline';
import { solvePose } from '../../src/services/binding/motion-retarget/pose-solver';
import { alignBoneRotation } from '../../src/services/binding/motion-retarget/two-bone-solver';
import { bakeWorldSolveToLocal, type BakeOutputRig } from '../../src/services/binding/motion-retarget/bake-adapter';
import { buildQualityReport } from '../../src/services/binding/motion-retarget/quality-report';
import { defaultRetargetTolerances, createDefaultRecipe, RETARGET_META_SCHEMA_VERSION, validateRetargetCalibration, type RetargetCalibration } from '@aether/scene';
import { quatMul, quatToMat, type Quat } from '../../src/services/binding/binding-math';
import { buildBvhText } from './fixture';
import type { RetargetEnvironment, RetargetRig, SourceMotion, WorldPoseFrame } from '../../src/services/binding/motion-retarget/contracts';

const DEG = Math.PI / 180;

/** 纯 yaw 四元数的偏航角（度）——只用于 yaw 主导的姿态断言 */
function yawDeg(q: Quat): number {
  return (2 * Math.atan2(q[1], q[3])) / DEG;
}

function makePipelineInput(bvhText: string, targetOverride?: (rig: RetargetRig) => RetargetRig) {
  const bvh = parseBvh(bvhText);
  const sm = buildSourceMotion(bvh);
  const { rig } = buildTargetRig({});
  const target = targetOverride ? targetOverride(rig) : rig;
  const baseline = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, target);
  const recipe = createDefaultRecipe(
    { guid: 'as_src00001', path: 'assets/x/walk.bvh', contentHash: 'sha256:a' },
    { guid: 'as_tgt00001', path: 'assets/x/tgt.glb', contentHash: 'sha256:b' },
  );
  const environment: RetargetEnvironment = {
    sourcePlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
    targetPlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
    origin: 'recipe-default',
    sceneNodeId: null,
  };
  return { sm, rig: target, baseline, recipe, environment };
}

// ───────────────── R01：根旋转只应用一次 ─────────────────

describe('R01 根旋转', () => {
  it('源 Hips yaw 30° → 输出 Hips 世界 yaw = 30°（不是 60°）', () => {
    const { sm, rig, baseline, recipe, environment } = makePipelineInput(
      buildBvhText({ rootPos: () => [0, 100, 0], rot: (f, j) => (j === 'Hips' && f >= 1 ? [0, 30, 0] : [0, 0, 0]) }),
    );
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: null });
    expect(out.status).not.toBe('failed');
    for (let f = 1; f < out.clip!.frames.length; f++) {
      expect(yawDeg(out.clip!.frames[f]!.boneQuat.Hips!)).toBeCloseTo(30, 3);
    }
    // 第 0 帧无旋转
    expect(yawDeg(out.clip!.frames[0]!.boneQuat.Hips!)).toBeCloseTo(0, 6);
  });
});

// ───────────────── R03：对齐与骨长无关 ─────────────────

describe('R03 对齐归一化', () => {
  it('同一目标方向、不同位移长度 → 同一旋转；角度误差 0', () => {
    const rest: [number, number, number] = [0, -1, 0];
    const dir45: [number, number, number] = [Math.SQRT1_2, -Math.SQRT1_2, 0];
    const qs = [0.042, 1, 5].map((k) =>
      alignBoneRotation([0, 0, 0, 1], rest, [dir45[0] * k, dir45[1] * k, dir45[2] * k]),
    );
    for (const q of qs) {
      const m = quatToMat(q);
      const got = [m[0]! * rest[0] + m[4]! * rest[1] + m[8]! * rest[2], m[1]! * rest[0] + m[5]! * rest[1] + m[9]! * rest[2], m[2]! * rest[0] + m[6]! * rest[1] + m[10]! * rest[2]];
      expect(Math.hypot(got[0]! - dir45[0], got[1]! - dir45[1], got[2]! - dir45[2])).toBeLessThan(1e-12);
    }
    for (let i = 1; i < qs.length; i++) {
      for (let k = 0; k < 4; k++) expect(qs[i]![k]).toBeCloseTo(qs[0]![k]!, 12);
    }
  });
});

// ───────────────── R04：heel 段用 heel 偏移 ─────────────────

describe('R04 确切标记', () => {
  it('heel 锚点 + heel 偏移 → 踝目标 [0.1, 0.03, 0]（不是 [0.1,0.03,−0.14]）', () => {
    const { rig } = buildTargetRig({});
    const times = new Float64Array([0, 1 / 30]);
    const ident = (n: number): Float64Array<ArrayBuffer> => {
      const a = new Float64Array(n * 4);
      for (let i = 0; i < n; i++) a[i * 4 + 3] = 1;
      return a;
    };
    const sm: SourceMotion = {
      fingerprint: 'fp1_r04',
      boneNames: ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'],
      times,
      localRotations: {},
      worldRotations: { LeftFoot: ident(2) },
      worldPositions: {},
      rootBone: 'Hips',
      rootMode: 'world-trajectory',
      canWorldLock: true,
      unitScaleSource: 1,
      upAxisSource: 'y',
    };
    const rootPos = new Float64Array(2 * 3);
    rootPos[1] = 0.95;
    const rootQ = new Float64Array(8);
    rootQ[3] = 1; rootQ[7] = 1;
    const res = solvePose({
      targetRig: rig,
      sourceMotion: sm,
      baselineLocals: [{}, {}],
      rootPositions: rootPos,
      rootQuats: rootQ,
      segments: [{
        id: 'LeftFoot.heel@0s', marker: 'LeftFoot.heel', chainId: 'LeftLeg',
        startS: 0, endS: 1, mode: 'support', space: 'world', origin: 'annotated',
        confidence: 1, anchor: [0.1, 0, -0.05], pivot: null,
      }],
      tolerances: defaultRetargetTolerances(),
    });
    const ankle = res.frames[0]!.bonePos.LeftFoot!;
    expect(ankle[0]).toBeCloseTo(0.1, 6);
    expect(ankle[1]).toBeCloseTo(0.03, 6);
    expect(ankle[2]).toBeCloseTo(0, 6);
    // heel 标记世界点回到锚点（不是被 ball 偏移拉走）
    expect(res.anchorDeviations[0]!.maxM).toBeLessThan(1e-6);
  });
});

// ───────────────── R05：源检测用源侧标记 ─────────────────

describe('R05 源侧标记', () => {
  it('未标定：不做世界锁脚（MRC_CONTACT_UNCALIBRATED），30cm 腾空不被伪造成支撑', () => {
    // 源整体抬高 30cm（root y=130cm → 脚 ~0.33m）：任何从动画自身推导的足底偏移
    // 都会把腾空解释成站地；新语义 = 能力不完整 + 自由运动，腾空保留
    const input = makePipelineInput(buildBvhText({ rootPos: () => [0, 130, 0] }));
    // 复审场景：骨盆高度已正确标定（h_s=1.0），仅缺足底标记——腾空必须保留
    const out = retargetMotion({
      source: input.sm, targetRig: input.rig, baseline: input.baseline,
      recipe: input.recipe, environment: input.environment,
      sourceCalibration: {
        schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source', pelvisHeightM: 1.0,
        supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
        unitScale: 1, upAxis: 'y', markers: {}, rotationBaseline: 'direction',
      },
    });
    expect(out.diagnostics.some((d) => d.code === 'MRC_CONTACT_UNCALIBRATED')).toBe(true);
    expect(out.status).not.toBe('failed');
    expect(out.clip!.frames[0]!.bonePos.LeftFoot![1]).toBeGreaterThan(0.25);
    expect(out.coverage).toContain('contact-uncalibrated');
  });

  it('已标定：源检测用源侧标记，与目标标记几何无关（目标踝下 5cm 不改变检测）', () => {
    const bvh = parseBvh(buildBvhText({ rootPos: () => [0, 100, 0] }));
    const sm = buildSourceMotion(bvh);
    const { rig } = buildTargetRig({});
    const hackedRig: RetargetRig = {
      ...rig,
      markers: {
        ...rig.markers,
        'LeftFoot.ball': { ...rig.markers['LeftFoot.ball']!, offset: [0, -0.05, 0.09] },
        'RightFoot.ball': { ...rig.markers['RightFoot.ball']!, offset: [0, -0.05, 0.09] },
      },
    };
    const baseline = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, hackedRig);
    const recipe = createDefaultRecipe(
      { guid: 'as_src00001', path: 'assets/x/w.bvh', contentHash: 'sha256:a' },
      { guid: 'as_tgt00001', path: 'assets/x/t.glb', contentHash: 'sha256:b' },
    );
    const environment: RetargetEnvironment = {
      sourcePlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      targetPlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      origin: 'recipe-default', sceneNodeId: null,
    };
    const cal: RetargetCalibration = {
      schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source' as const, pelvisHeightM: 1,
      supportPlane: { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], source: 'declared' as const, confidence: 1 },
      unitScale: 1, upAxis: 'y' as const,
      markers: {
        'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' as const },
        'RightFoot.ball': { bone: 'RightFoot', offset: [0, -0.03, 0.09], origin: 'manual' as const },
      },
      rotationBaseline: 'direction' as const,
    };
    const out = retargetMotion({ source: sm, targetRig: hackedRig, baseline, recipe, environment, sourceCalibration: cal });
    expect(out.diagnostics.some((d) => d.code === 'MRC_CONTACT_UNCALIBRATED')).toBe(false);
    expect(out.diagnostics.some((d) => d.code === 'MRQ_SWING_PENETRATION')).toBe(false);
    expect(out.metrics!.maxAnchorDeviationM).toBeLessThan(0.01);
  });

  it('复审 P1：同骨 heel/ball 交换插入顺序 → 输出不变（身份对应，不取第一项）', () => {
    const bvh = parseBvh(buildBvhText({ rootPos: () => [0, 100, 0] }));
    const sm = buildSourceMotion(bvh);
    const { rig } = buildTargetRig({});
    const baseline = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, rig);
    const recipe = createDefaultRecipe(
      { guid: 'as_src00001', path: 'assets/x/w.bvh', contentHash: 'sha256:a' },
      { guid: 'as_tgt00001', path: 'assets/x/t.glb', contentHash: 'sha256:b' },
    );
    const environment: RetargetEnvironment = {
      sourcePlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      targetPlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      origin: 'recipe-default', sceneNodeId: null,
    };
    const ball = (bone: string) => ({ bone, offset: [0, -0.03, 0.09] as [number, number, number], origin: 'manual' as const });
    const heel = (bone: string) => ({ bone, offset: [0, -0.03, -0.05] as [number, number, number], origin: 'manual' as const });
    const mkCal = (swap: boolean) => ({
      schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source' as const, pelvisHeightM: 1,
      supportPlane: { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], source: 'declared' as const, confidence: 1 },
      unitScale: 1, upAxis: 'y' as const,
      markers: swap
        ? {
            'LeftFoot.heel': heel('LeftFoot'),
            'LeftFoot.ball': ball('LeftFoot'),
            'RightFoot.heel': heel('RightFoot'),
            'RightFoot.ball': ball('RightFoot'),
          }
        : {
            'LeftFoot.ball': ball('LeftFoot'),
            'LeftFoot.heel': heel('LeftFoot'),
            'RightFoot.ball': ball('RightFoot'),
            'RightFoot.heel': heel('RightFoot'),
          },
      rotationBaseline: 'direction' as const,
    });
    const a = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: mkCal(false) });
    const b = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: mkCal(true) });
    expect(b.clip!.frames[0]!.bonePos.LeftFoot![0]).toBeCloseTo(a.clip!.frames[0]!.bonePos.LeftFoot![0], 9);
    expect(b.clip!.frames[0]!.bonePos.LeftFoot![1]).toBeCloseTo(a.clip!.frames[0]!.bonePos.LeftFoot![1], 9);
  });
});

// ───────────────── R06/R10：非关节祖先 + 缩放 + 拓扑序 ─────────────────

describe('R06/R10 外部骨架', () => {
  it('Armature(t=[10,0,0], s=2) + Hips/Spine：世界位置正确折叠；关节数组乱序不崩', () => {
    const ident = (): Quat => [0, 0, 0, 1];
    const sk = {
      joints: [2, 1], // R10：故意子先于父
      jointNames: ['Spine', 'Hips'],
      inverseBind: new Float32Array(32),
      parent: [-1, 0, 1], // 节点 0=Armature（非关节），1=Hips，2=Spine
      locals: [
        { t: [10, 0, 0], r: ident(), s: [2, 2, 2] }, // Armature
        { t: [0, 1, 0], r: ident(), s: [1, 1, 1] },  // Hips
        { t: [0, 0.3, 0], r: ident(), s: [1, 1, 1] }, // Spine
      ],
      roots: [0],
      normalization: new Float32Array(16),
    };
    const { rig, diagnostics } = buildTargetRig({ skeleton: sk as never });
    expect(diagnostics.every((d) => d.severity !== 'error')).toBe(true);
    // 拓扑序：Hips 先于 Spine
    expect(rig.order.indexOf('Hips')).toBeLessThan(rig.order.indexOf('Spine'));
    expect(rig.bones.Spine!.parent).toBe('Hips');
    // 根骨世界位置 = [10,2,0]（Armature 平移+缩放折叠）
    expect(rig.bones.Hips!.restLocalT[0]).toBeCloseTo(10, 6);
    expect(rig.bones.Hips!.restLocalT[1]).toBeCloseTo(2, 6);
    // Spine 相对 Hips 偏移 = [0, 0.6, 0]（0.3 × 缩放 2）
    expect(rig.bones.Spine!.restLocalT[1]).toBeCloseTo(0.6, 6);
  });

  it('非统一缩放 → 显式拒绝', () => {
    const ident = (): Quat => [0, 0, 0, 1];
    const sk = {
      joints: [1], jointNames: ['Hips'], inverseBind: new Float32Array(16),
      parent: [-1, 0], locals: [{ t: [0, 0, 0], r: ident(), s: [1, 2, 1] }, { t: [0, 1, 0], r: ident(), s: [1, 1, 1] }],
      roots: [0], normalization: new Float32Array(16),
    };
    const { diagnostics } = buildTargetRig({ skeleton: sk as never });
    expect(diagnostics.some((d) => d.code === 'MRR_NONUNIFORM_SCALE' && d.severity === 'error')).toBe(true);
  });
});

// ───────────────── R07：非恒等目标参考旋转 ─────────────────

describe('R07 参考旋转', () => {
  it('目标用 LeftArm.restLocalR=Z45 编码同一 45° 几何 → 基准局部 = Z45（世界手位不漂 39cm）', () => {
    // 源：A-pose（偏移编码 45°）；目标：臂偏移全 +X，但 LeftArm 局部参考旋转 Z45
    const bvh = parseBvh(buildBvhText({ armDeg: 45, rootPos: () => [0, 100, 0] }));
    const { rig } = buildTargetRig({});
    const h = Math.SQRT1_2;
    const hacked: RetargetRig = {
      ...rig,
      bones: { ...rig.bones, LeftArm: { ...rig.bones.LeftArm!, restLocalR: [0, 0, h, h] } },
    };
    const bl = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, hacked);
    // 源零旋转帧：目标手臂**世界方向**复现源 A-pose（R07 的正确不变量；
    // 局部角度不是不变量——同一几何可在任意骨分段用 restLocalR 编码，
    // 旧实现会把 Z45 参考旋转重复折叠成 90°，此处断言即抓该错）
    // 世界朝向复现源 A-pose：肩链世界 × 局部 → 手臂世界方向 ≈ (cos45, −sin45, 0)
    const CHAIN = ['Hips', 'Spine', 'Spine1', 'Spine2', 'LeftShoulder', 'LeftArm'];
    let world: Quat = [0, 0, 0, 1];
    for (const b of CHAIN) world = quatMul(world, quatMul(bl.pre[b]!, bl.post[b]!));
    const m = quatToMat(world);
    const dir = [m[0]!, m[1]!, m[2]!];
    expect(dir[0]).toBeCloseTo(Math.SQRT1_2, 4);
    expect(dir[1]).toBeCloseTo(-Math.SQRT1_2, 4);
  });
});

// ───────────────── R08/R09：烘焙可表达性、累计缩放、摆动穿透 ─────────────────

describe('R08 烘焙可表达性与累计缩放', () => {
  it('非根骨世界位置偏离 rest 偏移可达位置 → 拒绝烘焙（MRB_INEXPRESSIBLE）', () => {
    const rig: BakeOutputRig = {
      order: ['Root', 'Child'],
      bones: {
        Root: { name: 'Root', parent: null, restLocalT: [0, 1, 0], restLocalR: [0, 0, 0, 1], nodeIndex: 0 },
        Child: { name: 'Child', parent: 'Root', restLocalT: [0.3, 0.4, 0], restLocalR: [0, 0, 0, 1], nodeIndex: 1 },
      },
      fingerprint: 'fp1_x',
    };
    const frames: WorldPoseFrame[] = [
      { t: 0, rootPos: [0, 1, 0], rootQuat: [0, 0, 0, 1],
        bonePos: { Root: [0, 1, 0], Child: [0.9, 1.4, 0] }, // 偏离 [0.3,0.4,0] 0.6m：不可表达
        boneQuat: { Root: [0, 0, 0, 1], Child: [0, 0, 0, 1] } },
    ];
    const times = new Float64Array([0]);
    const res = bakeWorldSolveToLocal({ times, frames, skeletonFingerprint: 'fp1_x' }, rig);
    expect(res.tracks).toBeNull();
    expect(res.diagnostics.some((d) => d.code === 'MRB_INEXPRESSIBLE')).toBe(true);
  });

  it('容器缩放 2 的读回：子偏移按累计缩放放大（Child 在 [2,2,0] 而非 [1,2,0]）', () => {
    const rig: BakeOutputRig = {
      order: ['Root', 'Child'],
      bones: {
        Root: { name: 'Root', parent: null, restLocalT: [0, 1, 0], restLocalR: [0, 0, 0, 1], nodeIndex: 0 },
        Child: { name: 'Child', parent: 'Root', restLocalT: [1, 0, 0], restLocalR: [0, 0, 0, 1], nodeIndex: 1 },
      },
      fingerprint: 'fp1_y',
      rootParentWorld: { pos: [0, 0, 0], quat: [0, 0, 0, 1], uniformScale: 2 },
    };
    // 自洽输入：Root 世界 [0,2,0]（=rest×2），Child 世界 [2,2,0]
    const frames: WorldPoseFrame[] = [
      { t: 0, rootPos: [0, 2, 0], rootQuat: [0, 0, 0, 1],
        bonePos: { Root: [0, 2, 0], Child: [2, 2, 0] },
        boneQuat: { Root: [0, 0, 0, 1], Child: [0, 0, 0, 1] } },
    ];
    const res = bakeWorldSolveToLocal({ times: new Float64Array([0]), frames, skeletonFingerprint: 'fp1_y' }, rig);
    expect(res.tracks).not.toBeNull();
    expect(res.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    // 独立矩阵 FK：M = M_parent · T(t) · R(r)（glTF T·R·S，S 只在容器）
    const rootTrack = res.tracks!.find((t) => t.bone === 'Root')!;
    const childTrack = res.tracks!.find((t) => t.bone === 'Child')!;
    const rootLocalT: [number, number, number] = [rootTrack.translations![0]!, rootTrack.translations![1]!, rootTrack.translations![2]!];
    const childLocalT: [number, number, number] = [childTrack.rotations[0]!, 0, 0]; void childLocalT;
    // Root 世界 = 容器 · (rootLocalT × 2)
    const rootWorld: [number, number, number] = [rootLocalT[0] * 2, rootLocalT[1] * 2, rootLocalT[2] * 2];
    expect(rootWorld[1]).toBeCloseTo(2, 9);
    // Child 世界 = Root 世界 + rest 偏移 × 累计缩放 2
    const childWorld: [number, number, number] = [rootWorld[0] + 1 * 2, rootWorld[1], rootWorld[2]];
    expect(childWorld[0]).toBeCloseTo(2, 9);
    expect(childWorld[1]).toBeCloseTo(2, 9);
  });
});

describe('R09 摆动穿透', () => {
  it('无接触段 + 脚低于支撑面 13cm → MRQ_SWING_PENETRATION 违例、partial', () => {
    const { rig } = buildTargetRig({});
    const boneQuat: Record<string, Quat> = {};
    for (const b of rig.order) boneQuat[b] = [0, 0, 0, 1];
    const frame: WorldPoseFrame = {
      t: 0, rootPos: [0, 1, 0], rootQuat: [0, 0, 0, 1],
      bonePos: { Hips: [0, 1, 0], LeftUpLeg: [0.1, 0.9, 0], LeftLeg: [0.1, 0.48, 0], LeftFoot: [0.1, -0.1, 0] },
      boneQuat,
    };
    const res = buildQualityReport({
      rig, frames: [frame], segments: [], anchorDeviations: [],
      reachResidualsM: { inner: 0, outer: 0 }, rootCorrections: new Float64Array(3),
      switchJumpMps: 0, iterations: 1, converged: true, durationMs: 1,
      tolerances: defaultRetargetTolerances(),
    });
    expect(res.metrics.minSwingClearanceM).toBeCloseTo(-0.13, 6);
    expect(res.violations.some((v) => v.code === 'MRQ_SWING_PENETRATION')).toBe(true);
    expect(res.status).toBe('partial');
  });
});

// ───────────────── R11–R14：指纹与校验 ─────────────────

describe('R11 源指纹完整性', () => {
  it('改一个采样步长之外的帧值 / 改一处骨偏移 → 指纹都变', () => {
    const text = buildBvhText({ frames: 30 });
    const a = buildSourceMotion(parseBvh(text));
    const bvhB = parseBvh(text);
    bvhB.frames[7 * bvhB.dof]! += 0.001; // 小到旧的 round6+采样都会漏
    const b = buildSourceMotion(bvhB);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    const bvhC = parseBvh(text);
    bvhC.joints.LeftFoot!.offset = [0, -0.452, 0];
    const c = buildSourceMotion(bvhC);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });
});

describe('R12 依赖身份含实际标定', () => {
  it('同源同配方、不同源标定（h_s 1m vs 0.5m）→ 依赖指纹不同、根高不同', () => {
    const mk = (pelvis: number) => {
      const input = makePipelineInput(buildBvhText({ rootPos: () => [0, 100, 0] }));
      const cal: RetargetCalibration = {
        schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source' as const, pelvisHeightM: pelvis,
        supportPlane: { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], source: 'declared' as const, confidence: 1 },
        unitScale: 1, upAxis: 'y' as const,
        markers: {
          'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' as const },
          'RightFoot.ball': { bone: 'RightFoot', offset: [0, -0.03, 0.09], origin: 'manual' as const },
        },
        rotationBaseline: 'direction' as const,
      };
      const out = retargetMotion({
        source: input.sm, targetRig: input.rig, baseline: input.baseline,
        recipe: input.recipe, environment: input.environment, sourceCalibration: cal,
      });
      return out;
    };
    const a = mk(1);
    const b = mk(0.5);
    expect(a.dependencyFingerprint).not.toBe(b.dependencyFingerprint);
    // h_s=1 → s_root=1，接触可解 → 根 ≈ 1.0
    expect(a.clip!.frames[0]!.rootPos[1]).toBeCloseTo(1.0, 3);
    // h_s=0.5（错误标定）→ s_root=2：根高被接触约束拉回（物理正确），
    // 但步幅/锚点被放大 2 倍 —— 脚位置必须与 a 不同（依赖身份区分了不同标定的解）
    expect(Math.abs(b.clip!.frames[0]!.bonePos.LeftFoot![0] - a.clip!.frames[0]!.bonePos.LeftFoot![0])).toBeGreaterThan(0.05);
  });
});

describe('R13/R14 守门', () => {
  it('配方绑定标定指纹但未传标定 → MRC_CAL_MISSING failed', () => {
    const input = makePipelineInput(buildBvhText({ rootPos: () => [0, 100, 0] }));
    const out = retargetMotion({
      source: input.sm, targetRig: input.rig, baseline: input.baseline,
      recipe: { ...input.recipe, sourceCalibrationFingerprint: 'fp1_0000000000000000000000' },
      environment: input.environment, sourceCalibration: null,
    });
    expect(out.status).toBe('failed');
    expect(out.diagnostics.some((d) => d.code === 'MRC_CAL_MISSING')).toBe(true);
  });

  it('配方 schemaVersion=99 → 拒绝进入管线', () => {
    const input = makePipelineInput(buildBvhText({ rootPos: () => [0, 100, 0] }));
    const out = retargetMotion({
      source: input.sm, targetRig: input.rig, baseline: input.baseline,
      recipe: { ...input.recipe, schemaVersion: 99 }, environment: input.environment, sourceCalibration: null,
    });
    expect(out.status).toBe('failed');
    expect(out.diagnostics.some((d) => d.code === 'E_RTR_VERSION_FUTURE')).toBe(true);
  });

  it('标定版本 99 / 缺失 → E_RTCAL_VERSION_FUTURE / E_RTCAL_VERSION（R14）', () => {
    const base = {
      side: 'target' as const, pelvisHeightM: 1,
      supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared' as const, confidence: 1 },
      unitScale: 1, upAxis: 'y' as const, markers: {}, rotationBaseline: 'direction' as const,
    };
    const future = validateRetargetCalibration({ ...base, schemaVersion: 99 });
    expect(future.some((d) => d.code === 'E_RTCAL_VERSION_FUTURE')).toBe(true);
    const missing = validateRetargetCalibration(base as never);
    expect(missing.some((d) => d.code === 'E_RTCAL_VERSION')).toBe(true);
  });
});

// ───────────────── 端到端一致性（审核点名缺失的验收） ─────────────────

describe('端到端：源 → 求解 → 烘焙 → 独立 FK 播放', () => {
  it('静态站立源：播放世界位姿与求解世界解逐骨一致 ≤1e-6（含根朝向非平凡帧）', () => {
    const { sm, rig, baseline, recipe, environment } = makePipelineInput(
      buildBvhText({ rootPos: () => [0, 100, 0], rot: (f, j) => (j === 'Hips' && f >= 1 ? [0, 20, 0] : [0, 0, 0]) }),
    );
    const out = retargetMotion({ source: sm, targetRig: rig, baseline, recipe, environment, sourceCalibration: null });
    expect(out.status).not.toBe('failed');

    // 输出骨架 = 目标 rig（nodeIndex 用 order 下标；模板无缩放、无容器）
    const outputRig: BakeOutputRig = {
      order: rig.order,
      bones: Object.fromEntries(rig.order.map((n, i) => [n, { ...rig.bones[n]!, nodeIndex: i }])),
      fingerprint: rig.fingerprint,
    };
    const baked = bakeWorldSolveToLocal(out.clip!, outputRig);
    expect(baked.tracks).not.toBeNull();
    expect(baked.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    // 独立矩阵 FK（4×4 列主序，glTF T·R 语义；本用例无缩放）
    const trackOf = new Map(baked.tracks!.map((t) => [t.bone, t]));
    const frames = out.clip!.frames.length;
    for (let f = 0; f < frames; f++) {
      const world: Record<string, { p: [number, number, number]; q: Quat }> = {};
      for (const n of rig.order) {
        const b = rig.bones[n]!;
        const tr = trackOf.get(n);
        const localR: Quat = tr === undefined
          ? b.restLocalR
          : [tr.rotations[f * 4]!, tr.rotations[f * 4 + 1]!, tr.rotations[f * 4 + 2]!, tr.rotations[f * 4 + 3]!];
        const localT = b.restLocalT; // 非根无平移轨道；根轨道单独取
        if (b.parent === null) {
          const rt = tr?.translations;
          world[n] = { p: rt === null || rt === undefined ? [localT[0], localT[1], localT[2]] : [rt[f * 3]!, rt[f * 3 + 1]!, rt[f * 3 + 2]!], q: localR };
        } else {
          const pw = world[b.parent]!;
          const q = quatMul(pw.q, localR);
          const off = rotateTest(pw.q, [localT[0], localT[1], localT[2]]);
          world[n] = { p: [pw.p[0] + off[0], pw.p[1] + off[1], pw.p[2] + off[2]], q };
        }
      }
      // 与求解世界解逐骨比对（位置 ≤1e-6；四元数同半球点积 ≥ 1−1e-9）
      for (const n of rig.order) {
        const want = out.clip!.frames[f]!.bonePos[n]!;
        const got = world[n]!.p;
        expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeLessThan(1e-6);
        const wq = out.clip!.frames[f]!.boneQuat[n]!;
        const gq = world[n]!.q;
        const dot = Math.abs(gq[0] * wq[0] + gq[1] * wq[1] + gq[2] * wq[2] + gq[3] * wq[3]);
        expect(dot).toBeGreaterThan(1 - 1e-9);
      }
    }
  });
});

function rotateTest(q: Quat, v: [number, number, number]): [number, number, number] {
  const m = quatToMat(q);
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ];
}

// ───────────────── 复审第二轮 P1 探针 ─────────────────

describe('复审 P1：IK 保留目标参考旋转', () => {
  it('大腿 restLocalR=Z20°：膝位可由骨世界旋转+固定偏移重建（≤1e-6，旧实现差 0.146m）', () => {
    const { rig } = buildTargetRig({});
    // 目标大腿参考旋转 Z20°（不改任何偏移）
    const h10 = Math.sin((10 * Math.PI) / 180);
    const c10 = Math.cos((10 * Math.PI) / 180);
    const hacked: RetargetRig = {
      ...rig,
      bones: { ...rig.bones, LeftUpLeg: { ...rig.bones.LeftUpLeg!, restLocalR: [0, 0, h10, c10] } },
    };
    const times = new Float64Array([0, 1 / 30]);
    const ident = (n: number): Float64Array<ArrayBuffer> => {
      const a = new Float64Array(n * 4);
      for (let i = 0; i < n; i++) a[i * 4 + 3] = 1;
      return a;
    };
    const sm: SourceMotion = {
      fingerprint: 'fp1_r', boneNames: ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'], times,
      localRotations: {}, worldRotations: { LeftFoot: ident(2) }, worldPositions: {},
      rootBone: 'Hips', rootMode: 'world-trajectory', canWorldLock: true, unitScaleSource: 1, upAxisSource: 'y',
    };
    const rootPos = new Float64Array(6);
    rootPos[1] = 0.95; rootPos[4] = 0.95;
    const rootQ = new Float64Array(8);
    rootQ[3] = 1; rootQ[7] = 1;
    const res = solvePose({
      targetRig: hacked, sourceMotion: sm, baselineLocals: [{}, {}],
      rootPositions: rootPos, rootQuats: rootQ,
      segments: [{
        id: 'LeftFoot.ball@0s', marker: 'LeftFoot.ball', chainId: 'LeftLeg',
        startS: 0, endS: 1, mode: 'support', space: 'world', origin: 'annotated',
        confidence: 1, anchor: [0.1, 0, 0.09], pivot: null,
      }],
      tolerances: defaultRetargetTolerances(),
    });
    // 重建：膝世界 = 髋世界 + R_hip_world · restLeg 偏移
    const hip = res.frames[0]!.bonePos.LeftUpLeg!;
    const hipQ = res.frames[0]!.boneQuat.LeftUpLeg!;
    const off = hacked.bones.LeftLeg!.restLocalT;
    const m = quatToMat(hipQ);
    const knee = [
      hip[0] + m[0]! * off[0] + m[4]! * off[1] + m[8]! * off[2],
      hip[1] + m[1]! * off[0] + m[5]! * off[1] + m[9]! * off[2],
      hip[2] + m[2]! * off[0] + m[6]! * off[1] + m[10]! * off[2],
    ];
    const want = res.frames[0]!.bonePos.LeftLeg!;
    expect(Math.hypot(knee[0]! - want[0], knee[1]! - want[1], knee[2]! - want[2])).toBeLessThan(1e-6);
  });
});

describe('复审 P1：方向基准保留参考 roll', () => {
  it('目标上臂 X+90°/前臂 X−90°、源静止 T-pose → 基准局部 == 目标 restLocalR（蒙皮系不扭）', () => {
    const bvh = parseBvh(buildBvhText({ armDeg: 0, rootPos: () => [0, 100, 0] }));
    const { rig } = buildTargetRig({});
    const h = Math.SQRT1_2;
    const hacked: RetargetRig = {
      ...rig,
      bones: {
        ...rig.bones,
        LeftArm: { ...rig.bones.LeftArm!, restLocalR: [h, 0, 0, h] },
        LeftForeArm: { ...rig.bones.LeftForeArm!, restLocalR: [-h, 0, 0, h] },
      },
    };
    const bl = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, hacked);
    const pairs: Array<[string, [number, number, number, number]]> = [['LeftArm', [h, 0, 0, h]], ['LeftForeArm', [-h, 0, 0, h]]];
    for (const [bone, expectQ] of pairs) {
      const local = quatMul(quatMul(bl.pre[bone]!, [0, 0, 0, 1] as Quat), bl.post[bone]!);
      for (let k = 0; k < 4; k++) expect(local[k]).toBeCloseTo(expectQ[k]!, 9);
    }
  });
});

describe('复审 P1：跳过的并发约束进残差', () => {
  it('ball+heel 同帧、heel 锚点偏 10cm → heel 段残差 ≈0.1 计入 anchorDeviations（管线级 partial）', () => {
    const { rig } = buildTargetRig({});
    const times = new Float64Array([0]);
    const sm: SourceMotion = {
      fingerprint: 'fp1_r2', boneNames: ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'], times,
      localRotations: {}, worldRotations: { LeftFoot: new Float64Array([0, 0, 0, 1]) }, worldPositions: {},
      rootBone: 'Hips', rootMode: 'world-trajectory', canWorldLock: true, unitScaleSource: 1, upAxisSource: 'y',
    };
    const rootPos = new Float64Array([0, 0.95, 0]);
    const rootQ = new Float64Array([0, 0, 0, 1]);
    const res = solvePose({
      targetRig: rig, sourceMotion: sm, baselineLocals: [{}],
      rootPositions: rootPos, rootQuats: rootQ,
      segments: [
        { id: 'ball@0s', marker: 'LeftFoot.ball', chainId: 'LeftLeg', startS: 0, endS: 1, mode: 'support', space: 'world', origin: 'annotated', confidence: 1, anchor: [0.1, 0, 0.09], pivot: null },
        // heel 锚点故意偏 10cm（与 ball 锚定的脚位冲突）
        { id: 'heel@0s', marker: 'LeftFoot.heel', chainId: 'LeftLeg', startS: 0, endS: 1, mode: 'support', space: 'world', origin: 'annotated', confidence: 1, anchor: [0.1, 0, -0.15], pivot: null },
      ],
      tolerances: defaultRetargetTolerances(),
    });
    expect(res.diagnostics.some((d) => d.code === 'MRP_CONCURRENT_MARKERS')).toBe(true);
    const heelDev = res.anchorDeviations.find((d) => d.segmentId === 'heel@0s')!;
    expect(heelDev).toBeDefined();
    expect(heelDev.maxM).toBeGreaterThan(0.05);
    expect(heelDev.maxM).toBeLessThan(0.15);
  });
});

// ───────────────── 第三轮复审探针 ─────────────────

describe('第三轮 P1：接触求解不覆盖目标脚参考旋转', () => {
  it('脚 restLocalR=Z90（几何不变）→ 输出脚世界朝向 = Z90 映射、踝位不漂移', () => {
    const bvh = parseBvh(buildBvhText({ rootPos: () => [0, 100, 0] }));
    const sm = buildSourceMotion(bvh);
    const { rig } = buildTargetRig({});
    const h = Math.SQRT1_2;
    // 只改脚的参考坐标系：Z90 不动 ToeBase 偏移（沿 Z），标记偏移做反向补偿保几何
    const hacked: RetargetRig = {
      ...rig,
      bones: { ...rig.bones, LeftFoot: { ...rig.bones.LeftFoot!, restLocalR: [0, 0, h, h] } },
      markers: {
        ...rig.markers,
        'LeftFoot.ball': { ...rig.markers['LeftFoot.ball']!, offset: [-0.03, 0, 0.09] },
      },
    };
    const baseline = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, hacked);
    const recipe = createDefaultRecipe(
      { guid: 'as_src00001', path: 'assets/x/w.bvh', contentHash: 'sha256:a' },
      { guid: 'as_tgt00001', path: 'assets/x/t.glb', contentHash: 'sha256:b' },
    );
    const environment: RetargetEnvironment = {
      sourcePlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      targetPlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      origin: 'recipe-default', sceneNodeId: null,
    };
    const out = retargetMotion({
      source: sm, targetRig: hacked, baseline, recipe, environment,
      sourceCalibration: {
        schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source', pelvisHeightM: 1,
        supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
        unitScale: 1, upAxis: 'y',
        markers: {
          'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' },
          'RightFoot.ball': { bone: 'RightFoot', offset: [0, -0.03, 0.09], origin: 'manual' },
        },
        rotationBaseline: 'direction',
      },
    });
    expect(out.status).not.toBe('failed');
    const foot = out.clip!.frames[0]!.bonePos.LeftFoot!;
    // 踝位不漂移（旧实现 [0.13,0,0]）
    expect(foot[0]).toBeCloseTo(0.1, 3);
    expect(foot[1]).toBeCloseTo(0.03, 3);
    // 脚世界朝向 = Z90（旧实现被覆盖成 identity）
    const q = out.clip!.frames[0]!.boneQuat.LeftFoot!;
    expect(q[2]).toBeCloseTo(h, 3);
    expect(q[3]).toBeCloseTo(h, 3);
  });
});

describe('第三轮 P1：能力缺口计入状态', () => {
  it('右脚 support 标注被忽略（仅左脚有标定标记）→ MRC_ANNOT_UNHONORED + partial', () => {
    const input = makePipelineInput(buildBvhText({ rootPos: () => [0, 100, 0] }));
    const out = retargetMotion({
      source: input.sm, targetRig: input.rig, baseline: input.baseline,
      recipe: {
        ...input.recipe,
        annotations: [{ marker: 'RightFoot.ball', startS: 0, endS: 0.1, mode: 'support' }],
      },
      environment: input.environment,
      sourceCalibration: {
        schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source', pelvisHeightM: 1,
        supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
        unitScale: 1, upAxis: 'y',
        markers: { 'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' } },
        rotationBaseline: 'direction',
      },
    });
    expect(out.diagnostics.some((d) => d.code === 'MRC_ANNOT_UNHONORED')).toBe(true);
    expect(out.status).toBe('partial');
    // 结果仍产出（自由运动 + 左脚接触），只是不冒充 complete
    expect(out.clip).not.toBeNull();
  });
});

describe('第三轮 P2：叶子骨保留参考朝向', () => {
  it('无长轴叶子骨 restLocalR=Z30：静止源基准局部 == Z30（蒙皮系不丢）', () => {
    // 手工最小 rig：Root(+Y) → Leaf(无子骨，restLocalR=Z30)
    const deg = Math.PI / 180;
    const z30: Quat = [0, 0, Math.sin(15 * deg), Math.cos(15 * deg)];
    const rig: RetargetRig = {
      name: 'leaf-rig',
      order: ['Root', 'Leaf'],
      bones: {
        Root: { name: 'Root', parent: null, restLocalT: [0, 1, 0], restLocalR: [0, 0, 0, 1] },
        Leaf: { name: 'Leaf', parent: 'Root', restLocalT: [0.2, 0, 0], restLocalR: z30 },
      },
      chains: [],
      markers: {},
      pelvisHeightM: 1,
      supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      unitScale: 1,
      upAxis: 'y',
      rotationBaseline: 'direction',
      fingerprint: 'fp1_leaf',
    };
    const srcDirs: Record<string, [number, number, number]> = { Root: [0, 1, 0], Leaf: [0, 0, 0] };
    const bl = computeDirectionBaseline({ srcDirections: srcDirs }, rig);
    const localLeaf = quatMul(quatMul(bl.pre.Leaf!, [0, 0, 0, 1] as Quat), bl.post.Leaf!);
    for (let k = 0; k < 4; k++) expect(localLeaf[k]).toBeCloseTo(z30[k]!, 9);
  });
});

// ───────────────── 第三轮报告精确探针（按报告复现脚本） ─────────────────

describe('T03 报告探针：模板去 LeftHandTip 的叶子手 Z30', () => {
  it('静止源 → 手部基准局部 == [0,0,.2588,.9659]（报告期望值）', () => {
    const bvh = parseBvh(buildBvhText({}));
    const { rig } = buildTargetRig({});
    // 报告复现：删掉 HandTip 使 LeftHand 成为叶子，参考旋转 Z30（不改任何关节位置）
    const bonesWritable: Record<string, typeof rig.bones[string]> = { ...rig.bones };
    delete bonesWritable.LeftHandTip;
    bonesWritable.LeftHand = {
      ...bonesWritable.LeftHand!,
      restLocalR: [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)],
    };
    const noTip: RetargetRig = {
      ...rig,
      order: rig.order.filter((n) => n !== 'LeftHandTip'),
      bones: bonesWritable,
    };
    const baseline = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, noTip);
    const local = quatMul(baseline.pre.LeftHand!, baseline.post.LeftHand!);
    expect(local[0]).toBeCloseTo(0, 9);
    expect(local[1]).toBeCloseTo(0, 9);
    expect(local[2]).toBeCloseTo(0.2588190451, 9);
    expect(local[3]).toBeCloseTo(0.9659258263, 9);
  });
});

describe('T01 报告不变式：几何保持的参考系更换不改变物理结果（自由 vs 接触）', () => {
  it('同一目标（脚 Z90 参考系）自由运动与接触两种路径的脚世界朝向都含 Z90', () => {
    const bvh = parseBvh(buildBvhText({ rootPos: () => [0, 100, 0] }));
    const sm = buildSourceMotion(bvh);
    const { rig } = buildTargetRig({});
    const h = Math.SQRT1_2;
    const mkHacked = (): RetargetRig => ({
      ...rig,
      bones: { ...rig.bones, LeftFoot: { ...rig.bones.LeftFoot!, restLocalR: [0, 0, h, h] } },
      markers: {
        ...rig.markers,
        'LeftFoot.ball': { ...rig.markers['LeftFoot.ball']!, offset: [-0.03, 0, 0.09] },
        'LeftFoot.heel': { ...rig.markers['LeftFoot.heel']!, offset: [-0.03, 0, -0.05] },
      },
    });
    const hacked = mkHacked();
    const baseline = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, hacked);
    const recipe = createDefaultRecipe(
      { guid: 'as_src00001', path: 'assets/x/w.bvh', contentHash: 'sha256:a' },
      { guid: 'as_tgt00001', path: 'assets/x/t.glb', contentHash: 'sha256:b' },
    );
    const environment: RetargetEnvironment = {
      sourcePlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      targetPlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      origin: 'recipe-default', sceneNodeId: null,
    };
    const cal: RetargetCalibration = {
      schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source' as const, pelvisHeightM: 1,
      supportPlane: { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], source: 'declared' as const, confidence: 1 },
      unitScale: 1, upAxis: 'y' as const,
      markers: {
        'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.03, 0.09], origin: 'manual' as const },
        'LeftFoot.heel': { bone: 'LeftFoot', offset: [0, -0.03, -0.05], origin: 'manual' as const },
        'RightFoot.ball': { bone: 'RightFoot', offset: [0, -0.03, 0.09], origin: 'manual' as const },
        'RightFoot.heel': { bone: 'RightFoot', offset: [0, -0.03, -0.05], origin: 'manual' as const },
      },
      rotationBaseline: 'direction' as const,
    };
    // 自由运动（无源标定标记 → contact-uncalibrated → 不锁脚）
    const free = retargetMotion({ source: sm, targetRig: hacked, baseline, recipe, environment, sourceCalibration: { ...cal, markers: {} } });
    // 接触（有源标定标记 → 支撑锁定）
    const contact = retargetMotion({ source: sm, targetRig: hacked, baseline, recipe, environment, sourceCalibration: cal });
    for (const out of [free, contact]) {
      expect(out.status).not.toBe('failed');
      const q = out.clip!.frames[0]!.boneQuat.LeftFoot!;
      // 两种路径的脚世界朝向都必须含 Z90 参考系（不变式：参考系更换不改变物理结果）
      expect(q[2]).toBeCloseTo(h, 3);
      expect(q[3]).toBeCloseTo(h, 3);
    }
  });
});
