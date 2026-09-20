/**
 * contracts.test.ts —— 运行期契约测试（MR-01）。
 *
 * 守 docs/16 §6「内存合同」行的验收：形状、身份（指纹）、时刻（秒制升序）、
 * 单位（米/归一化四元数）。输入构造独立于被测实现，不用生成器自证。
 */
import { describe, it, expect } from 'vitest';
import {
  diagnoseSourceMotion,
  diagnoseRetargetRig,
  diagnoseRetargetEnvironment,
  computeDependencyFingerprint,
  hasErrors,
  type RetargetRig,
  type SourceMotion,
  type RetargetEnvironment,
} from '../../src/services/binding/motion-retarget/contracts';
import { retargetFingerprint } from '@aether/scene';

// ───────────────────── 构造合法夹具（手写，不用被测代码生成） ─────────────────────

function twoBoneRig(overrides: Partial<RetargetRig> = {}): RetargetRig {
  const rig: RetargetRig = {
    name: 'target',
    order: ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'],
    bones: {
      Hips: { name: 'Hips', parent: null, restLocalT: [0, 1, 0], restLocalR: [0, 0, 0, 1] },
      LeftUpLeg: { name: 'LeftUpLeg', parent: 'Hips', restLocalT: [0.1, -0.1, 0], restLocalR: [0, 0, 0, 1] },
      LeftLeg: { name: 'LeftLeg', parent: 'LeftUpLeg', restLocalT: [0, -0.42, 0], restLocalR: [0, 0, 0, 1] },
      LeftFoot: { name: 'LeftFoot', parent: 'LeftLeg', restLocalT: [0, -0.45, 0], restLocalR: [0, 0, 0, 1] },
    },
    chains: [{ id: 'LeftLeg', joints: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'], lengthM: 0.97 }],
    markers: {
      'LeftFoot.heel': { id: 'LeftFoot.heel', bone: 'LeftFoot', offset: [0, -0.03, -0.05], origin: 'derived' },
      'LeftFoot.ball': { id: 'LeftFoot.ball', bone: 'LeftFoot', offset: [0, -0.03, 0.1], origin: 'derived' },
    },
    pelvisHeightM: 1.0,
    supportPlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
    unitScale: 1,
    upAxis: 'y',
    rotationBaseline: 'direction',
    fingerprint: 'fp1_deadbeefdeadbeefdeadbeef',
    ...overrides,
  };
  return rig;
}

function walkMotion(overrides: Partial<SourceMotion> = {}): SourceMotion {
  const frames = 4;
  const times = new Float64Array([0, 1 / 30, 2 / 30, 3 / 30]);
  const rot = new Float64Array(frames * 4);
  const wpos = new Float64Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    rot[f * 4] = 0;
    rot[f * 4 + 1] = 0;
    rot[f * 4 + 2] = 0;
    rot[f * 4 + 3] = 1;
    // 根世界位置：米制，第 2 帧抬 0.05 m
    wpos[f * 3] = 0.1 * f;
    wpos[f * 3 + 1] = f === 2 ? 1.05 : 1.0;
    wpos[f * 3 + 2] = 0;
  }
  return {
    fingerprint: 'fp1_aaaa',
    boneNames: ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot'],
    times,
    localRotations: { Hips: rot.slice() },
    worldRotations: { Hips: rot.slice(), LeftFoot: rot.slice() },
    worldPositions: { Hips: wpos.slice() },
    rootBone: 'Hips',
    rootMode: 'world-trajectory',
    canWorldLock: true,
    unitScaleSource: 0.01,
    upAxisSource: 'y',
    ...overrides,
  };
}

// ───────────────────── SourceMotion 形状/时刻/单位 ─────────────────────

describe('diagnoseSourceMotion', () => {
  it('rejects missing root tracks instead of synthesizing zero positions or rotations', () => {
    for (const key of ['worldPositions', 'worldRotations', 'localRotations'] as const) {
      const motion = walkMotion();
      const changed = { ...motion, [key]: { ...motion[key], Hips: undefined } } as unknown as SourceMotion;
      expect(diagnoseSourceMotion(changed).map((d) => d.code)).toContain('MRC_ROOT_TRACK_MISSING');
    }
  });

  it('rejects nonfinite unit and rig dimensions before spatial mapping', () => {
    expect(hasErrors(diagnoseSourceMotion(walkMotion({ unitScaleSource: Infinity })))).toBe(true);
    expect(hasErrors(diagnoseRetargetRig(twoBoneRig({ pelvisHeightM: Infinity })))).toBe(true);
  });
  it('合法采样 → 零 error', () => {
    expect(hasErrors(diagnoseSourceMotion(walkMotion()))).toBe(false);
  });

  it('时间轴必须秒制严格升序（帧重复/回退/负值都是 error）', () => {
    const bad = walkMotion({ times: new Float64Array([0, 1 / 30, 1 / 30, 3 / 30]) });
    expect(hasErrors(diagnoseSourceMotion(bad))).toBe(true);
    const neg = walkMotion({ times: new Float64Array([-1, 0, 1, 2]) });
    expect(hasErrors(diagnoseSourceMotion(neg))).toBe(true);
  });

  it('数组长度与帧数不一致 → error（局部 4 分量 / 世界 3、4 分量分别卡）', () => {
    const short = walkMotion();
    (short as { localRotations: Record<string, Float64Array> }).localRotations = { Hips: new Float64Array(3 * 4) };
    expect(hasErrors(diagnoseSourceMotion(short))).toBe(true);
    const badWorld = walkMotion();
    (badWorld as { worldPositions: Record<string, Float64Array> }).worldPositions = {
      Hips: new Float64Array(2 * 3),
    };
    expect(hasErrors(diagnoseSourceMotion(badWorld))).toBe(true);
  });

  it('四元数未归一 / 含 NaN → error（slerp 的前提）', () => {
    const rot = new Float64Array(4 * 4);
    rot[3] = 0.5; // |q| = 0.5
    const bad = walkMotion({ localRotations: { Hips: rot } });
    expect(hasErrors(diagnoseSourceMotion(bad))).toBe(true);
  });

  it('A09 能力语义：canWorldLock 只配 world-trajectory，in-place-with-phase 不给锁脚', () => {
    const inPlace = walkMotion({ rootMode: 'in-place-with-phase', canWorldLock: false });
    expect(hasErrors(diagnoseSourceMotion(inPlace))).toBe(false);
    const cheat = walkMotion({ rootMode: 'in-place-with-phase', canWorldLock: true });
    expect(hasErrors(diagnoseSourceMotion(cheat))).toBe(true);
  });

  it('rootMode unknown → 警告但不 error（能力降级，不是数据损坏）', () => {
    const d = diagnoseSourceMotion(walkMotion({ rootMode: 'unknown', canWorldLock: false }));
    expect(hasErrors(d)).toBe(false);
    expect(d.some((x) => x.code === 'MRC_ROOT_UNKNOWN')).toBe(true);
  });
});

// ───────────────────── RetargetRig 形状 ─────────────────────

describe('diagnoseRetargetRig', () => {
  it('rejects a zero-length two-bone segment before the analytical solver', () => {
    const rig = twoBoneRig();
    const bad = { ...rig, bones: { ...rig.bones, LeftLeg: { ...rig.bones.LeftLeg!, restLocalT: [0, 0, 0] as [number, number, number] } } };
    expect(diagnoseRetargetRig(bad).map((d) => d.code)).toContain('MRC_CHAIN_LENGTH_BAD');
  });
  it('合法骨架 → 零 error', () => {
    expect(hasErrors(diagnoseRetargetRig(twoBoneRig()))).toBe(false);
  });

  it('子先于父 → ORDER_NOT_PARENT_FIRST（order 是 FK 累乘序，错序会算出垃圾）', () => {
    const rig = twoBoneRig({ order: ['LeftFoot', 'Hips', 'LeftUpLeg', 'LeftLeg'] });
    expect(hasErrors(diagnoseRetargetRig(rig))).toBe(true);
  });

  it('链不父子相连 / 引用不存在的骨 → error', () => {
    const rig = twoBoneRig({
      chains: [{ id: 'bad', joints: ['Hips', 'LeftLeg', 'LeftFoot'], lengthM: 1 }],
    });
    expect(hasErrors(diagnoseRetargetRig(rig))).toBe(true);
    const rig2 = twoBoneRig({
      chains: [{ id: 'bad2', joints: ['Ghost', 'LeftLeg', 'LeftFoot'], lengthM: 1 }],
    });
    expect(hasErrors(diagnoseRetargetRig(rig2))).toBe(true);
  });

  it('标记引用不存在的骨 → error（缺标记走代理+报告，不允许悬空标记）', () => {
    const rig = twoBoneRig({
      markers: { 'X.heel': { id: 'X.heel', bone: 'X', offset: [0, 0, 0], origin: 'derived' } },
    });
    expect(hasErrors(diagnoseRetargetRig(rig))).toBe(true);
  });

  it('h_t ≤ 0 或 unitScale ≤ 0 → error（S 映射的分母/因子）', () => {
    expect(hasErrors(diagnoseRetargetRig(twoBoneRig({ pelvisHeightM: 0 })))).toBe(true);
    expect(hasErrors(diagnoseRetargetRig(twoBoneRig({ unitScale: 0 })))).toBe(true);
  });
});

describe('canonical environment agreement', () => {
  const plane = { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number] };
  const env: RetargetEnvironment = { sourcePlane: plane, targetPlane: plane, origin: 'recipe-default', sceneNodeId: null };
  it('allows different origins on the same horizontal plane', () => {
    expect(diagnoseRetargetEnvironment({ ...env, targetPlane: { ...plane, origin: [10, 0, 20] } }, plane, plane)).toEqual([]);
  });
  it('rejects two ground elevations or an unnormalized/non-Y normal', () => {
    expect(hasErrors(diagnoseRetargetEnvironment({ ...env, targetPlane: { ...plane, origin: [0, 1, 0] } }, plane))).toBe(true);
    expect(hasErrors(diagnoseRetargetEnvironment({ ...env, sourcePlane: { ...plane, normal: [0, 2, 0] } }, plane))).toBe(true);
    expect(hasErrors(diagnoseRetargetEnvironment(env, plane, { ...plane, origin: [0, 2, 0] }))).toBe(true);
  });
});

// ───────────────────── 身份（依赖指纹） ─────────────────────

describe('computeDependencyFingerprint', () => {
  const env: RetargetEnvironment = {
    sourcePlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
    targetPlane: { origin: [0, 0, 0], normal: [0, 1, 0] },
    origin: 'recipe-default',
    sceneNodeId: null,
  };
  const args = (over: Record<string, unknown> = {}) => ({
    sourceFingerprint: 'fp1_src',
    targetRig: twoBoneRig(),
    recipeSemantic: { spaceMode: 'normalize-gait', tolerances: { anchorH: 0.002 } },
    environment: env,
    algorithmVersion: 'mr-foot-1',
    ...over,
  });

  it('确定性：同输入同指纹', () => {
    expect(computeDependencyFingerprint(args())).toBe(computeDependencyFingerprint(args()));
  });

  it('任一输入变化 → 指纹变化（源/骨架/配方/环境/算法）', () => {
    const base = computeDependencyFingerprint(args());
    expect(computeDependencyFingerprint(args({ sourceFingerprint: 'fp1_other' }))).not.toBe(base);
    expect(
      computeDependencyFingerprint(args({ targetRig: twoBoneRig({ fingerprint: 'fp1_rig2' }) })),
    ).not.toBe(base);
    expect(
      computeDependencyFingerprint(args({ recipeSemantic: { spaceMode: 'preserve-world' } })),
    ).not.toBe(base);
    expect(
      computeDependencyFingerprint(
        args({ environment: { ...env, origin: 'scene', sceneNodeId: 'node-7' } }),
      ),
    ).not.toBe(base);
    expect(computeDependencyFingerprint(args({ algorithmVersion: 'mr-foot-2' }))).not.toBe(base);
  });

  it('指纹引擎本身：键序不敏感、值敏感（与 scene 包同源实现）', () => {
    expect(retargetFingerprint({ a: 1, b: 2 })).toBe(retargetFingerprint({ b: 2, a: 1 }));
    expect(retargetFingerprint({ a: 1, b: 2 })).not.toBe(retargetFingerprint({ a: 1, b: 3 }));
  });
});
