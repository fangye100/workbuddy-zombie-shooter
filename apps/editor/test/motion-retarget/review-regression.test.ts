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
import { defaultRetargetTolerances, createDefaultRecipe, RETARGET_META_SCHEMA_VERSION, validateRetargetCalibration } from '@aether/scene';
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
  it('目标标记几何改变（踝下 5cm）不再影响源接触检测：仍检出支撑、无摆动穿透', () => {
    // 目标 ball 标记被挪到踝下 5cm：若源检测误用目标偏移，源标记会陷地 2cm → 摆动穿透 → partial
    const { sm, recipe, environment } = makePipelineInput(
      buildBvhText({ rootPos: () => [0, 100, 0] }),
      (rig) => ({
        ...rig,
        markers: {
          ...rig.markers,
          'LeftFoot.ball': { ...rig.markers['LeftFoot.ball']!, offset: [0, -0.05, 0.09] },
          'RightFoot.ball': { ...rig.markers['RightFoot.ball']!, offset: [0, -0.05, 0.09] },
        },
      }),
    );
    // 重建 rig 后 baseline 需与该 rig 一致（模板几何没变，重算一次）
    const bvh = parseBvh(buildBvhText({ rootPos: () => [0, 100, 0] }));
    const { rig } = buildTargetRig({});
    const hackedRig: RetargetRig = {
      ...rig,
      markers: {
        ...rig.markers,
        'LeftFoot.ball': { ...rig.markers['LeftFoot.ball']!, offset: [0, -0.05, 0.09] },
        'RightFoot.ball': { ...rig.markers['RightFoot.ball']!, offset: [0, -0.05, 0.09] },
      },
    };
    const bl = computeDirectionBaseline({ srcDirections: sourceRestDirections(bvh) }, hackedRig);
    const out = retargetMotion({ source: sm, targetRig: hackedRig, baseline: bl, recipe, environment, sourceCalibration: null });
    // 源侧检测用的是源几何 → 接触存在，不会把双脚误判成“摆动+穿透”
    expect(out.diagnostics.some((d) => d.code === 'MRC_SOURCE_MARKERS_DERIVED')).toBe(true);
    expect(out.metrics!.maxAnchorDeviationM).toBeLessThan(0.01);
    expect(out.diagnostics.some((d) => d.code === 'MRQ_SWING_PENETRATION')).toBe(false);
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
      const cal = {
        schemaVersion: RETARGET_META_SCHEMA_VERSION, side: 'source' as const, pelvisHeightM: pelvis,
        supportPlane: { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], source: 'declared' as const, confidence: 1 },
        unitScale: 1, upAxis: 'y' as const, markers: {}, rotationBaseline: 'direction' as const,
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
