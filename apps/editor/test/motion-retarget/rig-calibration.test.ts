/**
 * rig-calibration.test.ts —— 目标骨架/标定测试（MR-02，验收 A03 归此）。
 *
 * 守：派生标记落支撑平面、h_t 计算、m/cm 与父变换下的等价、
 * direction / world-rest 两种姿态基准的正确性（含 BVH 禁用 world-rest 的守门）。
 */
import { describe, it, expect } from 'vitest';
import type { NodeLocal, SkeletonData, RetargetCalibration } from '@aether/scene';
import { RETARGET_META_SCHEMA_VERSION } from '@aether/scene';
import {
  buildTargetRig,
  computeDirectionBaseline,
  computeWorldRestBaseline,
  skeletonLocalsFinite,
} from '../../src/services/binding/motion-retarget/rig-calibration';
import { sourceRestDirections } from '../../src/services/binding/motion-retarget/source-motion';
import { parseBvh } from '../../src/services/binding/bvh-parser';
import { quatMul, quatToMat } from '../../src/services/binding/binding-math';
import { buildBvhText } from './fixture';
import type { Quat } from '../../src/services/binding/binding-math';

function m4Identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/** HumanIK 27 骨 SkeletonData（k = 整体缩放；rotZ = 骨盆节点加 Z 旋转） */
function buildSkeleton(k: number, rotZ = 0): SkeletonData {
  const HUMANIK = {
    Hips: [0.0, 1.0, 0.0], Spine: [0.0, 0.15, 0.0], Spine1: [0.0, 0.15, 0.0], Spine2: [0.0, 0.15, 0.0],
    Neck: [0.0, 0.15, 0.0], Head: [0.0, 0.2, 0.0], HeadTip: [0.0, 0.14, 0.0],
    LeftShoulder: [0.07, 0.1, 0.0], LeftArm: [0.1, 0, 0], LeftForeArm: [0.26, 0, 0], LeftHand: [0.25, 0, 0], LeftHandTip: [0.1, 0, 0],
    RightShoulder: [-0.07, 0.1, 0.0], RightArm: [-0.1, 0, 0], RightForeArm: [-0.26, 0, 0], RightHand: [-0.25, 0, 0], RightHandTip: [-0.1, 0, 0],
    LeftUpLeg: [0.1, -0.1, 0.0], LeftLeg: [0.0, -0.42, 0.0], LeftFoot: [0.0, -0.45, 0.0], LeftToeBase: [0.0, 0, 0.14], LeftToeTip: [0.0, 0, 0.1],
    RightUpLeg: [-0.1, -0.1, 0.0], RightLeg: [0.0, -0.42, 0.0], RightFoot: [0.0, -0.45, 0.0], RightToeBase: [0.0, 0, 0.14], RightToeTip: [0.0, 0, 0.1],
  } as const;
  const names = Object.keys(HUMANIK);
  const idx = new Map(names.map((n, i) => [n, i] as const));
  const parent: number[] = [];
  const locals: NodeLocal[] = [];
  const PARENTS: Record<string, string | null> = {
    Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck', HeadTip: 'Head',
    LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm', LeftHandTip: 'LeftHand',
    RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm', RightHandTip: 'RightHand',
    LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot', LeftToeTip: 'LeftToeBase',
    RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot', RightToeTip: 'RightToeBase',
  };
  const half = Math.SQRT1_2;
  for (const n of names) {
    const off = HUMANIK[n as keyof typeof HUMANIK];
    const p = PARENTS[n]!;
    parent.push(p === null ? -1 : idx.get(p)!);
    locals.push({
      t: [off[0] * k, off[1] * k, off[2] * k],
      r: n === 'Hips' && rotZ !== 0 ? [0, 0, half, half] : [0, 0, 0, 1],
      s: [1, 1, 1],
    });
  }
  return {
    joints: names.map((_, i) => i),
    jointNames: names.slice(),
    inverseBind: new Float32Array(names.length * 16),
    parent,
    locals,
    roots: [0],
    normalization: m4Identity(),
  };
}

// ───────────────────────── 模板与派生 ─────────────────────────

describe('buildTargetRig · 模板目标', () => {
  it('h_t = 1.00（Hips 世界 y − 地面），链与标记齐全，零诊断 error', () => {
    const { rig, diagnostics } = buildTargetRig({});
    expect(diagnostics.every((d) => d.severity !== 'error')).toBe(true);
    expect(rig.pelvisHeightM).toBeCloseTo(1.0, 6);
    expect(rig.chains.map((c) => c.id)).toEqual(['LeftLeg', 'RightLeg', 'LeftArm', 'RightArm']);
    expect(rig.chains.find((c) => c.id === 'LeftLeg')!.lengthM).toBeCloseTo(0.87, 6);
    expect(Object.keys(rig.markers).sort()).toEqual(
      ['LeftFoot.ball', 'LeftFoot.heel', 'RightFoot.ball', 'RightFoot.heel'].sort(),
    );
  });

  it('★ 派生标记落在支撑平面上（脚底既不悬空也不穿地）', () => {
    const { rig } = buildTargetRig({});
    // rest 下脚无旋转：标记世界点 = 踝 + offset；y 应为 0
    const heel = rig.markers['LeftFoot.heel']!;
    const ball = rig.markers['LeftFoot.ball']!;
    expect(heel.offset[1] + 0.03).toBeCloseTo(0, 6);
    expect(ball.offset[1] + 0.03).toBeCloseTo(0, 6);
    expect(heel.origin).toBe('derived');
    // 前掌在踝前方（+Z），脚跟在后方
    expect(ball.offset[2]).toBeGreaterThan(0);
    expect(heel.offset[2]).toBeLessThan(0);
  });

  it('缺标定 → 代理警告（不用踝假装精确脚底）', () => {
    const { diagnostics } = buildTargetRig({});
    expect(diagnostics.some((d) => d.code === 'MRR_DERIVED_MARKERS')).toBe(true);
  });

  it('标定覆盖：markers/h_t/平面全部来自 sidecar', () => {
    const cal: RetargetCalibration = {
      schemaVersion: RETARGET_META_SCHEMA_VERSION,
      side: 'target',
      pelvisHeightM: 1.23,
      supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
      unitScale: 1,
      upAxis: 'y',
      markers: { 'LeftFoot.ball': { bone: 'LeftFoot', offset: [0, -0.031, 0.11], origin: 'manual' } },
      rotationBaseline: 'direction',
    };
    const { rig, diagnostics } = buildTargetRig({ calibration: cal });
    expect(diagnostics.some((d) => d.code === 'MRR_DERIVED_MARKERS')).toBe(false);
    expect(rig.pelvisHeightM).toBeCloseTo(1.23, 9);
    expect(rig.markers['LeftFoot.ball']!.origin).toBe('manual');
    expect(rig.markers['LeftFoot.ball']!.offset[2]).toBeCloseTo(0.11, 9);
  });
});

// ───────────────────────── A03：单位/父变换等价 ─────────────────────────

describe('buildTargetRig · 外部骨架（A03）', () => {
  it('m/cm：k=1 与 k=0.01 骨架（后者配 unitScale=100）→ rest 世界位置一致 ≤1e-5', () => {
    const a = buildTargetRig({ skeleton: buildSkeleton(1) });
    const b = buildTargetRig({
      skeleton: buildSkeleton(0.01),
      calibration: {
        schemaVersion: RETARGET_META_SCHEMA_VERSION,
        side: 'target',
        pelvisHeightM: 1.0,
        supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0], source: 'declared', confidence: 1 },
        unitScale: 100,
        upAxis: 'y',
        markers: {},
        rotationBaseline: 'direction',
      },
    });
    // 骨长按各自单位归一后一致
    const la = a.rig.chains.find((c) => c.id === 'LeftLeg')!;
    const lb = b.rig.chains.find((c) => c.id === 'LeftLeg')!;
    expect(lb.lengthM * b.rig.unitScale).toBeCloseTo(la.lengthM * a.rig.unitScale, 5);
    expect(a.rig.unitScale).toBe(1);
  });

  it('★ 有效父变换：骨盆带 Z 旋转时，rest 世界位置正确累乘旋转（不是纯平移累加）', () => {
    const { rig } = buildTargetRig({ skeleton: buildSkeleton(1, 90) });
    // rotZ(90°)：Spine 偏移 (0,0.15,0) → (−0.15,0,0)；肩偏移 (0.07,0.10,0) → (−0.10,0.07,0)
    const spine = rigOrderPos(rig, 'Spine');
    expect(spine[0]).toBeCloseTo(-0.15, 5);
    expect(spine[1]).toBeCloseTo(1.0, 5);
    const shoulder = rigOrderPos(rig, 'LeftShoulder');
    const spine2 = rigOrderPos(rig, 'Spine2');
    expect(shoulder[0] - spine2[0]).toBeCloseTo(-0.1, 5);
    expect(shoulder[1] - spine2[1]).toBeCloseTo(0.07, 5);
  });

  it('skeletonLocalsFinite：非法 NaN 局部被拒', () => {
    const sk = buildSkeleton(1);
    (sk.locals[0] as { t: number[] }).t = [NaN, 1, 0];
    expect(skeletonLocalsFinite(sk)).toBe(false);
    expect(skeletonLocalsFinite(buildSkeleton(1))).toBe(true);
  });
});

/** 用 rig 自己的 rest 累乘读回某骨世界位置（独立小 oracle，不复用被测内部） */
function rigOrderPos(rig: ReturnType<typeof buildTargetRig>['rig'], bone: string): [number, number, number] {
  const rotOf: Record<string, Quat> = {};
  const posOf: Record<string, [number, number, number]> = {};
  for (const n of rig.order) {
    const b = rig.bones[n]!;
    if (b.parent === null) {
      rotOf[n] = b.restLocalR as Quat;
      posOf[n] = [b.restLocalT[0], b.restLocalT[1], b.restLocalT[2]];
    } else {
      const pw = rotOf[b.parent]!;
      rotOf[n] = quatMul(pw, b.restLocalR as Quat);
      const m = quatToMat(pw);
      const t = b.restLocalT;
      posOf[n] = [
        posOf[b.parent]![0] + m[0]! * t[0] + m[4]! * t[1] + m[8]! * t[2],
        posOf[b.parent]![1] + m[1]! * t[0] + m[5]! * t[1] + m[9]! * t[2],
        posOf[b.parent]![2] + m[2]! * t[0] + m[6]! * t[1] + m[10]! * t[2],
      ];
    }
  }
  return posOf[bone]!;
}

// ───────────────────────── 姿态基准 ─────────────────────────

describe('computeDirectionBaseline（BVH 姿态基准）', () => {
  it('★ T-pose 源 → A 全 identity，基准 = 直接拷贝', () => {
    const { rig } = buildTargetRig({});
    const dirs = sourceRestDirections(parseBvh(buildBvhText({ armDeg: 0 })));
    const bl = computeDirectionBaseline({ srcDirections: dirs }, rig);
    for (const b of rig.order) {
      expect(Math.abs(bl.post[b]![3])).toBeCloseTo(1, 6);
      expect(Math.abs(bl.pre[b]![3])).toBeCloseTo(1, 6);
    }
  });

  it('★ A-pose 源 → 手臂链对齐 45°、中轴骨 0（与 L0 行为一致）', () => {
    const { rig } = buildTargetRig({});
    const dirs = sourceRestDirections(parseBvh(buildBvhText({ armDeg: 45 })));
    const bl = computeDirectionBaseline({ srcDirections: dirs }, rig);
    const angle = (q: Quat): number => (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI;
    // post = A⁻¹：LeftArm 的 |A| ≈ 45°
    expect(angle(bl.post.LeftArm!)).toBeCloseTo(45, 3);
    expect(angle(bl.post.LeftShoulder!)).toBeCloseTo(45, 3);
    expect(angle(bl.post.Spine!)).toBeCloseTo(0, 6);
    expect(angle(bl.post.LeftUpLeg!)).toBeCloseTo(0, 6);
  });

  it('★ 零旋转帧：目标手臂世界朝向复现源的 A-pose（斜向下 45°，不停在 T-pose）', () => {
    const { rig } = buildTargetRig({});
    const dirs = sourceRestDirections(parseBvh(buildBvhText({ armDeg: 45 })));
    const bl = computeDirectionBaseline({ srcDirections: dirs }, rig);
    // 沿 Hips→…→LeftArm 累乘基准局部旋转（源全零旋转 ⟹ local = pre·post）
    const CHAIN = ['Hips', 'Spine', 'Spine1', 'Spine2', 'LeftShoulder', 'LeftArm'];
    let world: Quat = [0, 0, 0, 1];
    for (const b of CHAIN) {
      const local = quatMul(bl.pre[b]!, quatMul([0, 0, 0, 1], bl.post[b]!));
      world = quatMul(world, local);
    }
    const m = quatToMat(world);
    // 目标 T-pose 上臂朝 +X；旋转后应指向 (cos45, −sin45, 0)
    const dir = [m[0]!, m[1]!, m[2]!];
    expect(dir[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(dir[1]).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(dir[2]).toBeCloseTo(0, 5);
  });
});

describe('computeWorldRestBaseline（glTF→glTF 姿态基准）', () => {
  it('★ 代入源 rest 局部旋转 → 精确得到目标 rest 局部旋转（公式自洽）', () => {
    // 目标：骨盆带 90° Z 旋转的骨架；源：无旋转骨架
    const { rig } = buildTargetRig({ skeleton: buildSkeleton(1, 90) });
    // 源 rest 世界旋转全 identity（BVH 型）——但 glTF 源应有自己的 rest 旋转。
    // 构造「源 = 同一目标骨架」的退化情形：R_s = R_t,0 ⟹ R̄ = R_t,0（恒等映射）
    const srcRest: Record<string, Quat> = {};
    for (const n of rig.order) {
      srcRest[n] = rig.bones[n]!.restLocalR as Quat;
    }
    const bl = computeWorldRestBaseline({ srcRestWorldRotations: worldRotOf(rig) }, rig);
    expect(bl.diagnostics.every((d) => d.severity !== 'error')).toBe(true);
    // 代入 R_s = 源 rest 局部（= 目标 rest 局部）→ 输出应等于目标 rest 局部
    for (const n of ['Hips', 'Spine', 'LeftArm']) {
      const rs = rig.bones[n]!.restLocalR as Quat;
      const out = quatMul(quatMul(bl.pre[n]!, rs), bl.post[n]!);
      const want = rig.bones[n]!.restLocalR as Quat;
      for (let k = 0; k < 4; k++) expect(out[k]).toBeCloseTo(want[k]!, 6);
    }
  });

  it('★ BVH 型源（rest 世界旋转全 identity）→ 显式 error，拒绝该模式（§1 钉板）', () => {
    const { rig } = buildTargetRig({});
    const identityRest: Record<string, Quat> = {};
    for (const n of rig.order) identityRest[n] = [0, 0, 0, 1];
    const bl = computeWorldRestBaseline({ srcRestWorldRotations: identityRest }, rig);
    expect(bl.diagnostics.some((d) => d.code === 'MRR_WORLDREST_ON_IDENTITY_SOURCE')).toBe(true);
  });
});

function worldRotOf(rig: ReturnType<typeof buildTargetRig>['rig']): Record<string, Quat> {
  const out: Record<string, Quat> = {};
  for (const n of rig.order) {
    const b = rig.bones[n]!;
    out[n] = b.parent === null ? (b.restLocalR as Quat) : quatMul(out[b.parent]!, b.restLocalR as Quat);
  }
  return out;
}
