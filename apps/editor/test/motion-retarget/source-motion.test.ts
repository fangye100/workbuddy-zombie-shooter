/**
 * source-motion.test.ts —— 源采样测试（MR-02，验收 A09 归此）。
 *
 * 守：单位→米、轴→Y-up、逐帧 FK 正确性、根模式四分类（不伪造 world）、
 * 指纹确定性/敏感性。预期值全部手算，不用被测实现生成。
 */
import { describe, it, expect } from 'vitest';
import { parseBvh } from '../../src/services/binding/bvh-parser';
import {
  buildSourceMotion,
  markerWorldPositions,
  sourceRestDirections,
} from '../../src/services/binding/motion-retarget/source-motion';
import { buildBvhText } from './fixture';

// ───────────────────────── A09：根模式四分类 ─────────────────────────

describe('buildSourceMotion · 根模式（A09）', () => {
  it('有位置通道 + 水平位移 0.4 m → world-trajectory，可世界锁脚', () => {
    const sm = buildSourceMotion(
      parseBvh(buildBvhText({ rootPos: (f) => [f * 10, 100, 0] })),
    );
    expect(sm.rootMode).toBe('world-trajectory');
    expect(sm.canWorldLock).toBe(true);
  });

  it('有位置通道但水平位移 ≈ 0（原地表演）→ in-place-with-trajectory，不给锁脚', () => {
    const sm = buildSourceMotion(
      parseBvh(buildBvhText({ rootPos: (f) => [0, 100 + (f % 2) * 0.5, 0] })),
    );
    expect(sm.rootMode).toBe('in-place-with-trajectory');
    expect(sm.canWorldLock).toBe(false);
  });

  it('无根位置通道（CHANNELS 3）→ in-place-with-phase，能力显式降级', () => {
    const sm = buildSourceMotion(parseBvh(buildBvhText({ rootChannels: '3' })));
    expect(sm.rootMode).toBe('in-place-with-phase');
    expect(sm.canWorldLock).toBe(false);
  });

  it('三种 in-place/world 能力互不相同（A09：不因 null/非 null 判成功）', () => {
    const modes = new Set([
      buildSourceMotion(parseBvh(buildBvhText({ rootPos: (f) => [f * 10, 100, 0] }))).rootMode,
      buildSourceMotion(parseBvh(buildBvhText({ rootPos: () => [0, 100, 0] }))).rootMode,
      buildSourceMotion(parseBvh(buildBvhText({ rootChannels: '3' }))).rootMode,
    ]);
    expect(modes.size).toBe(3);
  });
});

// ───────────────────────── 单位与轴 ─────────────────────────

describe('buildSourceMotion · 单位/轴归一（A03 的源侧）', () => {
  it('cm 素材 → 世界位置是米（Hips y ≈ 1.00，脚踝 y ≈ 0.03）', () => {
    const sm = buildSourceMotion(parseBvh(buildBvhText({ unit: 'cm' })));
    expect(sm.unitScaleSource).toBe(0.01);
    expect(sm.worldPositions.Hips![1]).toBeCloseTo(1.0, 6);
    expect(sm.worldPositions.LeftFoot![1]).toBeCloseTo(0.03, 6);
  });

  it('m 素材 → 同一骨架同一结果（cm/m 等价，差 ≤1e-5）', () => {
    // fixture 的 rootPos 语义是「骨架单位」（cm 制），两种 unit 下传同一套数值
    const cm = buildSourceMotion(parseBvh(buildBvhText({ unit: 'cm', rootPos: (f) => [f * 10, 100, 0] })));
    const m = buildSourceMotion(parseBvh(buildBvhText({ unit: 'm', rootPos: (f) => [f * 10, 100, 0] })));
    for (const b of cm.boneNames) {
      const a = cm.worldPositions[b]!;
      const c = m.worldPositions[b]!;
      expect(c.length).toBe(a.length);
      for (let k = 0; k < a.length; k++) expect(c[k]!).toBeCloseTo(a[k]!, 5);
    }
  });

  it('Z-up 素材归一到 Y-up：与 Y-up 同动作结果一致（差 ≤1e-5）', () => {
    const y = buildSourceMotion(parseBvh(buildBvhText({ up: 'Y', rootPos: (f) => [f * 5, 100, 2] })));
    const z = buildSourceMotion(parseBvh(buildBvhText({ up: 'Z', rootPos: (f) => [f * 5, 100, 2] })));
    expect(z.upAxisSource).toBe('z');
    expect(y.upAxisSource).toBe('y');
    for (const b of y.boneNames) {
      const a = y.worldPositions[b]!;
      const c = z.worldPositions[b]!;
      for (let k = 0; k < a.length; k++) expect(c[k]!).toBeCloseTo(a[k]!, 5);
    }
  });
});

// ───────────────────────── FK 正确性 ─────────────────────────

describe('buildSourceMotion · 逐帧 FK', () => {
  it('零旋转帧：世界位置 = rest 偏移累加 × unitScale（独立手算 oracle）', () => {
    const sm = buildSourceMotion(parseBvh(buildBvhText({})));
    // Hips(0,1,0) → LeftUpLeg(+0.10,−0.10) → LeftLeg(−0.42) → LeftFoot(−0.45)
    expect(sm.worldPositions.Hips![1]).toBeCloseTo(1.0, 6);
    expect(sm.worldPositions.LeftUpLeg![0]).toBeCloseTo(0.1, 6);
    expect(sm.worldPositions.LeftUpLeg![1]).toBeCloseTo(0.9, 6);
    expect(sm.worldPositions.LeftLeg![1]).toBeCloseTo(0.48, 6);
    expect(sm.worldPositions.LeftFoot![1]).toBeCloseTo(0.03, 6);
    expect(sm.worldPositions.LeftToeBase![2]).toBeCloseTo(0.14, 6);
  });

  it('根 yaw 90°：子骨世界位置跟着转（+X 子骨落到 +Z... 绕 Y 90°: +X→−Z）', () => {
    const sm = buildSourceMotion(
      parseBvh(buildBvhText({ rot: (f, j) => (j === 'Hips' && f === 2 ? [0, 90, 0] : [0, 0, 0]) })),
    );
    const f = 2;
    // LeftUpLeg 相对 Hips 偏移 (0.1,−0.1,0)；绕 Y +90° → (0,−0.1,−0.1)?? 手算：
    // RotY(90°)·(0.1,0,0) = (cos90·0.1 + sin90·0, 0, −sin90·0.1 + cos90·0) = (0,0,−0.1)
    expect(sm.worldPositions.LeftUpLeg![f * 3]!).toBeCloseTo(0, 6);
    expect(sm.worldPositions.LeftUpLeg![f * 3 + 1]!).toBeCloseTo(0.9, 6);
    expect(sm.worldPositions.LeftUpLeg![f * 3 + 2]!).toBeCloseTo(-0.1, 6);
    // 无旋转的相邻帧保持原位（只有第 2 帧转）
    expect(sm.worldPositions.LeftUpLeg![1 * 3 + 2]!).toBeCloseTo(0, 6);
  });

  it('世界旋转 = 沿父链局部旋转累乘（Hips yaw 90° ⟹ UpLeg 世界 yaw 90°）', () => {
    const sm = buildSourceMotion(
      parseBvh(buildBvhText({ rot: (f, j) => (j === 'Hips' ? [0, 90, 0] : [0, 0, 0]) })),
    );
    // yaw 90° 的四元数 = [0, sin45, 0, cos45]
    const h = Math.SQRT1_2;
    const f = 0;
    expect(sm.worldRotations.LeftUpLeg![f * 4]!).toBeCloseTo(0, 6);
    expect(sm.worldRotations.LeftUpLeg![f * 4 + 1]!).toBeCloseTo(h, 6);
    expect(sm.worldRotations.LeftUpLeg![f * 4 + 3]!).toBeCloseTo(h, 6);
  });

  it('骨名输出 = HumanIK 名、父先于子、22 骨全映射', () => {
    const sm = buildSourceMotion(parseBvh(buildBvhText({})));
    expect(sm.boneNames.length).toBe(22);
    expect(sm.boneNames[0]).toBe('Hips');
    // 父先于子抽查
    expect(sm.boneNames.indexOf('Spine')).toBeLessThan(sm.boneNames.indexOf('Spine1'));
    expect(sm.boneNames.indexOf('LeftUpLeg')).toBeLessThan(sm.boneNames.indexOf('LeftFoot'));
  });

  it('时间轴 = 帧号 × 帧时长（秒制升序）', () => {
    const sm = buildSourceMotion(parseBvh(buildBvhText({ frames: 7, frameTime: 1 / 60 })));
    expect(sm.times.length).toBe(7);
    expect(sm.times[0]!).toBe(0);
    expect(sm.times[6]!).toBeCloseTo(6 / 60, 9);
  });
});

// ───────────────────────── 标记轨迹与指纹 ─────────────────────────

describe('markerWorldPositions / 指纹', () => {
  it('标记世界点 = 骨位置 ⊕ 世界旋转·offset（rest 帧不转 → 直接加）', () => {
    const sm = buildSourceMotion(parseBvh(buildBvhText({})));
    const traj = markerWorldPositions(sm, 'LeftFoot', [0, -0.03, 0.09]);
    expect(traj[0]!).toBeCloseTo(0.1, 6);
    expect(traj[1]!).toBeCloseTo(0.0, 6);
    expect(traj[2]!).toBeCloseTo(0.09, 6);
  });

  it('A-pose 源：rest 骨向把手臂指向斜下（direction 基准的输入正确）', () => {
    const dirs = sourceRestDirections(parseBvh(buildBvhText({ armDeg: 45 })));
    const arm = dirs.LeftArm!;
    expect(arm[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(arm[1]).toBeCloseTo(-Math.SQRT1_2, 5);
    const tpose = sourceRestDirections(parseBvh(buildBvhText({ armDeg: 0 })));
    expect(tpose.LeftArm![0]!).toBeCloseTo(1, 5);
    expect(tpose.LeftArm![1]!).toBeCloseTo(0, 5);
  });

  it('指纹：同素材稳定；改一帧旋转或帧率 → 变化', () => {
    const a = buildSourceMotion(parseBvh(buildBvhText({})));
    const b = buildSourceMotion(parseBvh(buildBvhText({})));
    expect(a.fingerprint).toBe(b.fingerprint);
    const moved = buildSourceMotion(
      parseBvh(buildBvhText({ rootPos: (f) => [f * 0.01, 100, 0] })),
    );
    expect(moved.fingerprint).not.toBe(a.fingerprint);
    const faster = buildSourceMotion(parseBvh(buildBvhText({ frameTime: 1 / 60 })));
    expect(faster.fingerprint).not.toBe(a.fingerprint);
  });

  it('一根骨都对不上 → 显式抛错（不静默产空采样）', () => {
    const junk = parseBvh(
      'HIERARCHY\nROOT A\n{\n OFFSET 0 1 0\n CHANNELS 3 Zrotation Yrotation Xrotation\n' +
        ' JOINT B\n {\n  OFFSET 0 1 0\n  CHANNELS 3 Zrotation Yrotation Xrotation\n }\n}\n' +
        'MOTION\nFrames: 3\nFrame Time: 0.033333\n0 0 0 0 0 0\n1 1 1 1 1 1\n2 2 2 2 2 2\n',
    );
    expect(() => buildSourceMotion(junk)).toThrow(/HumanIK/);
  });
});
