/**
 * space-targets.test.ts —— 空间补偿规则测试（MR-02，验收 A02/A18 归此）。
 *
 * 守：S 映射标定自洽、A02 反例（根/末端不同比例 → 2cm 漂移）、
 * 2m/0.5m 等比等价、preserve-world 语义、锚点中值稳健、根朝向轨迹保留。
 * 全部数值手算（研究报告 §3.2 的推导就是这里的 oracle）。
 */
import { describe, it, expect } from 'vitest';
import {
  buildSpaceMapping,
  rootCandidate,
  freeLimbTarget,
  radialDriftM,
  contactAnchor,
  projectToPlane,
  signedPlaneDistance,
  ankleTargetFromMarker,
} from '../../src/services/binding/motion-retarget/space-targets';
import { buildSourceMotion } from '../../src/services/binding/motion-retarget/source-motion';
import { parseBvh } from '../../src/services/binding/bvh-parser';
import { buildBvhText } from './fixture';
import type { SourceMotion } from '../../src/services/binding/motion-retarget/contracts';

const PLANE = { origin: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number] };

// ───────────────────────── S 映射 ─────────────────────────

describe('buildSpaceMapping', () => {
  it('S(H_src_ref) = H_tgt_ref（标定自洽；误差为 0）', () => {
    const { mapping, calibrationErrorM } = buildSpaceMapping(0.98, 2.05);
    expect(mapping.sRoot).toBeCloseTo(2.05 / 0.98, 9);
    expect(calibrationErrorM).toBeCloseTo(0, 9);
    const mapped = mapping.mapBodyRelative([0, 0.98, 0]);
    expect(mapped[1]).toBeCloseTo(2.05, 9);
  });

  it('2m / 0.5m 角色：h_t/h_s 比例正确，等比缩放轨迹保持形状', () => {
    const big = buildSpaceMapping(1.0, 2.0).mapping;
    const small = buildSpaceMapping(1.0, 0.5).mapping;
    // 源走 0.4 m：大角色走 0.8 m，小角色走 0.2 m（同一归一化步态）
    expect(big.mapBodyRelative([0.4, 1, 0])[0]).toBeCloseTo(0.8, 9);
    expect(small.mapBodyRelative([0.4, 1, 0])[0]).toBeCloseTo(0.2, 9);
  });

  it('★ 等比等价：等比 2m/0.5m 的两个目标，映射结果按各自 h_t 归一后相同', () => {
    // 同一源（h_s=1），目标 A h_t=2、目标 B h_t=0.5：步幅/h_t 相同 = 0.4
    const a = buildSpaceMapping(1.0, 2.0).mapping;
    const b = buildSpaceMapping(1.0, 0.5).mapping;
    const pa = a.mapBodyRelative([0.4, 1, 0]);
    const pb = b.mapBodyRelative([0.4, 1, 0]);
    expect(pa[0] / 2.0).toBeCloseTo(pb[0] / 0.5, 9);
  });

  it('normalize-gait：世界锚点也走 S；preserve-world：锚点保米制', () => {
    const gait = buildSpaceMapping(1.0, 0.25, { mode: 'normalize-gait' }).mapping;
    expect(gait.mapWorldAnchor([1.0, 0, 0])[0]).toBeCloseTo(0.25, 9);
    const pw = buildSpaceMapping(1.0, 0.25, { mode: 'preserve-world' }).mapping;
    expect(pw.mapWorldAnchor([1.0, 0, 0])[0]).toBeCloseTo(1.0, 9);
    // preserve-world 的身体相对点（根候选等）仍走 S
    expect(pw.mapBodyRelative([1.0, 0, 0])[0]).toBeCloseTo(0.25, 9);
  });
});

// ───────────────────────── A02 反例 ─────────────────────────

describe('A02：根/末端不同比例破坏静止接触（docs/16 §8 A02）', () => {
  it('r_root=0.25、r_tip=0.20、源骨盆移动 0.4m → 自由映射目标漂移 0.02m', () => {
    expect(radialDriftM(0.25, 0.2, 0.4)).toBeCloseTo(0.02, 12);
  });

  it('直接构造：P̂ = r_root·H + r_tip·(P−H)，源脚静止时目标点随骨盆漂移', () => {
    const rRoot = 0.25;
    const rTip = 0.2;
    // 源：H 从 (0,1,0) 移到 (0.4,1,0)，脚 P 固定在 (0.35,0,0)
    const foot0 = [rRoot * 0 + rTip * (0.35 - 0), 0, 0];
    const foot1 = [rRoot * 0.4 + rTip * (0.35 - 0.4), 0, 0];
    expect(foot1[0]! - foot0[0]!).toBeCloseTo(0.02, 12);
  });

  it('自由末端目标公式：同轴情形 = A_t + (L_t/L_s)(P_s − A_s)', () => {
    const got = freeLimbTarget([0.5, 1.2, 0], [0.1, 1.0, 0], 0.6, [0.2, 2.0, 0], 1.2);
    // (0.5−0.1)/0.6 = 2/3；0.2 + 1.2×2/3 = 1.0
    expect(got[0]).toBeCloseTo(1.0, 12);
    expect(got[1]).toBeCloseTo(2.0 + 1.2 * (0.2 / 0.6), 12);
  });

  it('零链长退化：返回链根，不产生 NaN', () => {
    const got = freeLimbTarget([1, 2, 3], [0, 0, 0], 0, [4, 5, 6], 0);
    expect(got).toEqual([4, 5, 6]);
  });
});

// ───────────────────────── 根候选 ─────────────────────────

describe('rootCandidate', () => {
  const sm: SourceMotion = buildSourceMotion(
    parseBvh(buildBvhText({ rootPos: (f) => [f * 10, 100, 0] })),
  );

  it('根候选 = S(源根轨迹)：吃原始采样，0.25 尺度下水平 0.1m/帧 → 0.025m/帧', () => {
    const { mapping } = buildSpaceMapping(1.0, 0.25);
    const rc = rootCandidate(sm, mapping);
    expect(rc.positions[0]!).toBeCloseTo(0, 9);
    expect(rc.positions[3]!).toBeCloseTo(0.025, 9); // f=1 的 x
    expect(rc.positions[1]!).toBeCloseTo(0.25, 9); // y：1.0×0.25
  });

  it('★ 根不二次缩放：把已缩放结果再当源喂 S 会翻倍（守住「只吃原始采样」的 API 约定）', () => {
    const { mapping } = buildSpaceMapping(1.0, 0.25);
    const rc = rootCandidate(sm, mapping);
    const twice = mapping.mapBodyRelative([rc.positions[3]!, rc.positions[1]!, 0]);
    expect(twice[0]).toBeCloseTo(0.00625, 9); // 0.025×0.25 —— 若有人二次缩放就会得到这个
    expect(rc.positions[3]!).not.toBeCloseTo(twice[0]!, 9);
  });

  it('preserve-world：竖直按比例、水平保持米制', () => {
    const { mapping } = buildSpaceMapping(1.0, 0.25, { mode: 'preserve-world' });
    const rc = rootCandidate(sm, mapping);
    expect(rc.positions[3]!).toBeCloseTo(0.1, 9); // 源水平 0.1 m 原样保留
    expect(rc.positions[1]!).toBeCloseTo(0.25, 9); // 竖直归一
  });

  it('★ A18：根朝向轨迹随源保留（yaw 原样透传）', () => {
    const { mapping } = buildSpaceMapping(1.0, 0.25);
    const rc = rootCandidate(sm, mapping);
    for (let f = 0; f < sm.times.length; f++) {
      for (let k = 0; k < 4; k++) {
        expect(rc.quats[f * 4 + k]!).toBeCloseTo(sm.worldRotations.Hips![f * 4 + k]!, 12);
      }
    }
  });
});

// ───────────────────────── 接触锚点 ─────────────────────────

describe('contactAnchor / ankleTarget', () => {
  it('锚点 = 时段中值映射后投影到平面；个别离群帧不拉动（中值稳健）', () => {
    // 9 帧：x 全是 1.0，第 4 帧被噪声推到 5.0（米）；h 比 0.25
    const traj = new Float64Array(9 * 3);
    for (let f = 0; f < 9; f++) {
      traj[f * 3] = f === 4 ? 5.0 : 1.0;
      traj[f * 3 + 1] = 0.001;
      traj[f * 3 + 2] = 0;
    }
    const { mapping } = buildSpaceMapping(1.0, 0.25);
    const a = contactAnchor(traj, 0, 8, mapping, PLANE);
    // 中值 x = 1.0 → S 后 0.25；投影把 y 拉回 0
    expect(a[0]).toBeCloseTo(0.25, 9);
    expect(a[1]).toBeCloseTo(0, 12);
  });

  it('preserve-world 锚点保米制（世界落点不随角色缩放）', () => {
    const traj = new Float64Array(3 * 3);
    for (let f = 0; f < 3; f++) {
      traj[f * 3] = 1.0;
      traj[f * 3 + 1] = 0;
      traj[f * 3 + 2] = f * 0.01;
    }
    const { mapping } = buildSpaceMapping(1.0, 0.25, { mode: 'preserve-world' });
    const a = contactAnchor(traj, 0, 2, mapping, PLANE);
    expect(a[0]).toBeCloseTo(1.0, 9);
  });

  it('投影与带符号距离：地面上的点距离 0，下方为负', () => {
    expect(signedPlaneDistance([0, 0.01, 0], PLANE)).toBeCloseTo(0.01, 12);
    expect(signedPlaneDistance([0, -0.02, 0], PLANE)).toBeCloseTo(-0.02, 12);
    const p = projectToPlane([0.3, 0.05, 0.1], PLANE);
    expect(p[1]).toBeCloseTo(0, 12);
    expect(p[0]).toBeCloseTo(0.3, 12);
  });

  it('踝目标 = 锚点 − R_foot·b（脚旋转时踝目标跟着动，不能锁踝代替锁脚）', () => {
    const anchor: [number, number, number] = [0.25, 0, 0.1];
    // 脚绕 Y 转 90°：局部 b=(0,−0.03,0.09) → 世界 (0.09,−0.03,0)
    const h = Math.SQRT1_2;
    const q: [number, number, number, number] = [0, h, 0, h];
    const ankle = ankleTargetFromMarker(anchor, q, [0, -0.03, 0.09]);
    expect(ankle[0]).toBeCloseTo(0.25 - 0.09, 9);
    expect(ankle[1]).toBeCloseTo(0.03, 9);
    expect(ankle[2]).toBeCloseTo(0.1, 9);
  });
});
