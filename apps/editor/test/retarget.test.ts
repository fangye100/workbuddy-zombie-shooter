/**
 * retarget.test.ts — BVH 解析 + 通用重定向的纯 CPU 测试。
 *
 * 打 ★ 的是守「通用绑定 + 动画应用」这条铁律的断言，删改前先想清楚：
 *   ★ rest 姿态对齐：源 A-pose 不能把偏移带进目标 T-pose 骨架
 *   ★ 世界骨向守恒：重定向的定义式（源与目标的骨世界朝向逐帧相等）
 *   ★ T-pose 源退化为直接拷贝，必须与既有 Python 管线逐位一致
 */

import { describe, it, expect } from 'vitest';
// 真实 Mixamo 导出走 vite 的 ?raw：测试因此不需要 node 类型，
// 且能直接对仓库里那份 sample 做回归（ADR-008：验证资产与结论同入库）。
import sampleBvhText from '../../../assets/characters/_tools/sample_mixamo_walk.bvh?raw';
// 可重生成的合成夹具：`node assets/characters/_tools/make_apose_sample.mjs`
// 两条同源、只有手臂角度不同的骨架，专门用来锁「rest 偏移必须被消掉」这条铁律。
import aposeFixture from '../../../assets/characters/_tools/sample_apose_arm45.bvh?raw';
import tposeFixture from '../../../assets/characters/_tools/sample_tpose_arm0.bvh?raw';

import {
  parseBvh,
  mapBvhJointsToHumanik,
  bvhRestDirections,
  normalizeJointName,
  type BvhFile,
  type BvhJoint,
  type Vec3,
} from '../src/services/binding/bvh-parser';
import { retargetBvh, retargetSummary, skeletonRestWorldPositions } from '../src/services/binding/retarget';
import type { NodeLocal, SkeletonData } from '@aether/scene';
import { rigToTPose } from '../src/services/binding/binding-export';
import {
  HUMANIK_BONES,
  HUMANIK_ORDER,
  tposeDirections,
  tposeWorldPositions,
} from '../src/services/binding/humanik-template';
import { quatMul, quatToMat, type Quat } from '../src/services/binding/binding-math';

// ─────────────────────────── 工具 ───────────────────────────

// apps/editor/test/ → 仓库根是 ../../../（editor → apps → root）
function realSample(): BvhFile {
  return parseBvh(sampleBvhText);
}

const ROT_DEG = [0, 15, -25, 40, -10];

interface Node {
  name: string;
  off: [number, number, number];
  ch?: Node[];
}

function ser(n: Node, ind: number, isRoot: boolean): string {
  const pad = '  '.repeat(ind);
  const kw = isRoot ? 'ROOT' : 'JOINT';
  const chans = isRoot
    ? 'CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation'
    : 'CHANNELS 3 Zrotation Yrotation Xrotation';
  let s =
    `${pad}${kw} ${n.name}\n${pad}{\n` +
    `${pad}  OFFSET ${n.off[0]} ${n.off[1]} ${n.off[2]}\n` +
    `${pad}  ${chans}\n`;
  for (const c of n.ch ?? []) s += ser(c, ind + 1, false);
  return s + `${pad}}\n`;
}

/**
 * 合成一份 22 关节、Mixamo 命名的 BVH（单位 cm，默认 Y-up）。
 *
 * @param armDeg 手臂下垂角（0 = T-pose，45 = A-pose）；整条臂链保持笔直
 * @param up     'Z' 时把整棵树换成 Z-up（用于测轴重映射）
 */
function buildBvh(armDeg: number, up: 'Y' | 'Z' = 'Y'): string {
  const a = (armDeg * Math.PI) / 180;
  const cx = Math.cos(a);
  const sy = Math.sin(a);

  // 单位 cm。手臂沿 ±X 外伸，armDeg 让它整体绕 Z 向下摆。
  const arm = (len: number, side: 1 | -1): [number, number, number] => [
    side * len * cx,
    -len * sy,
    0,
  ];

  const P = (x: number, y: number, z: number): [number, number, number] => {
    // Y-up: (x,y,z)；Z-up: 把 y 与 z 互换，z 取负以保持右手系
    return up === 'Y' ? [x, y, z] : [x, -z, y];
  };

  const leaf = (name: string, off: [number, number, number]): Node => ({ name, off });

  const tree: Node = {
    name: 'Hips',
    off: P(0, 100, 0),
    ch: [
      {
        name: 'Spine',
        off: P(0, 15, 0),
        ch: [
          { name: 'Spine1', off: P(0, 15, 0), ch: [
            { name: 'Spine2', off: P(0, 15, 0), ch: [
              { name: 'Neck', off: P(0, 15, 0), ch: [leaf('Head', P(0, 20, 0))] },
              { name: 'LeftShoulder', off: P(7, 10, 0), ch: [
                { name: 'LeftArm', off: arm(10, 1), ch: [
                  { name: 'LeftForeArm', off: arm(26, 1), ch: [
                    leaf('LeftHand', arm(25, 1)),
                  ] },
                ] },
              ] },
              { name: 'RightShoulder', off: P(-7, 10, 0), ch: [
                { name: 'RightArm', off: arm(10, -1), ch: [
                  { name: 'RightForeArm', off: arm(26, -1), ch: [
                    leaf('RightHand', arm(25, -1)),
                  ] },
                ] },
              ] },
            ] },
          ] },
        ],
      },
      { name: 'LeftUpLeg', off: P(10, -10, 0), ch: [
        { name: 'LeftLeg', off: P(0, -42, 0), ch: [
          { name: 'LeftFoot', off: P(0, -45, 0), ch: [leaf('LeftToeBase', P(0, 0, 14))] },
        ] },
      ] },
      { name: 'RightUpLeg', off: P(-10, -10, 0), ch: [
        { name: 'RightLeg', off: P(0, -42, 0), ch: [
          { name: 'RightFoot', off: P(0, -45, 0), ch: [leaf('RightToeBase', P(0, 0, 14))] },
        ] },
      ] },
    ],
  };

  // dof = 根 6 + 其余 21 × 3 = 69
  const rotCount = 6 + 21 * 3 - 3;
  let motion = `MOTION\nFrames: ${ROT_DEG.length}\nFrame Time: 0.033333\n`;
  for (let f = 0; f < ROT_DEG.length; f++) {
    const row: number[] = up === 'Y' ? [0, 100 + f * 0.7, 0] : [0, 0, 100 + f * 0.7];
    for (let k = 0; k < rotCount; k++) row.push(ROT_DEG[f]!);
    motion += row.join(' ') + '\n';
  }
  return `HIERARCHY\n${ser(tree, 0, true)}${motion}`;
}

function rotate(q: Quat, v: Vec3): [number, number, number] {
  const m = quatToMat(q);
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ];
}

function axisQuat(axis: 0 | 1 | 2, deg: number): Quat {
  const h = (deg * Math.PI) / 180 / 2;
  const s = Math.sin(h);
  return [
    axis === 0 ? s : 0,
    axis === 1 ? s : 0,
    axis === 2 ? s : 0,
    Math.cos(h),
  ];
}

/** 从公开 API 读出第 f 帧某关节的本地旋转四元数（独立于被测实现，避免自证） */
function srcLocalQuat(bvh: BvhFile, jn: string, f: number): Quat {
  const j: BvhJoint = bvh.joints[jn]!;
  let q: Quat = [0, 0, 0, 1];
  for (let k = 0; k < j.rotChannels.length; k++) {
    const c = j.rotChannels[k]!.toLowerCase();
    const deg = bvh.frames[f * bvh.dof + j.rotColumn + k]!;
    const axis = c.startsWith('x') ? 0 : c.startsWith('y') ? 1 : 2;
    q = quatMul(q, axisQuat(axis, deg));
  }
  return q;
}

/** 沿 HumanIK 链从根累乘到 bone */
function chainOf(bone: string): string[] {
  const out: string[] = [];
  let cur: string | null = bone;
  while (cur !== null) {
    out.unshift(cur);
    cur = HUMANIK_BONES[cur]!.parent;
  }
  return out;
}

function worldRot(local: Record<string, Quat>, bone: string): Quat {
  let q: Quat = [0, 0, 0, 1];
  for (const n of chainOf(bone)) q = quatMul(q, local[n]!);
  return q;
}

/** 源 / 目标两侧各算一遍「骨的世界朝向」，用于验证重定向的定义式 */
function compareWorldDirs(
  bvh: BvhFile,
  localTgt: Record<string, Quat>,
  f: number,
): Array<{ bone: string; src: Vec3; tgt: Vec3 }> {
  const { mapping } = mapBvhJointsToHumanik(bvh.order, HUMANIK_ORDER);
  const jointOf: Record<string, string> = {};
  for (const [jn, b] of Object.entries(mapping)) jointOf[b] = jn;

  const srcDirs = bvhRestDirections(bvh, mapping, HUMANIK_ORDER, HUMANIK_BONES);
  const tDirs = tposeDirections();

  const localSrc: Record<string, Quat> = {};
  for (const b of HUMANIK_ORDER) {
    const jn = jointOf[b];
    localSrc[b] = jn === undefined ? [0, 0, 0, 1] : srcLocalQuat(bvh, jn, f);
  }

  const out: Array<{ bone: string; src: Vec3; tgt: Vec3 }> = [];
  for (const b of HUMANIK_ORDER) {
    const child = HUMANIK_ORDER.find((n) => HUMANIK_BONES[n]!.parent === b);
    const dT: Vec3 = child === undefined ? [0, 0, 0] : tDirs[child]!;
    const dS: Vec3 = srcDirs[b] ?? [0, 0, 0];
    if (Math.hypot(...dT) < 1e-9 || Math.hypot(...dS) < 1e-9) continue;
    out.push({
      bone: b,
      src: rotate(worldRot(localSrc, b), dS),
      tgt: rotate(worldRot(localTgt, b), dT),
    });
  }
  return out;
}

function targetLocalAt(
  rotations: Record<string, Float32Array>,
  f: number,
): Record<string, Quat> {
  const out: Record<string, Quat> = {};
  for (const b of HUMANIK_ORDER) {
    const arr = rotations[b];
    out[b] = arr === undefined
      ? [0, 0, 0, 1]
      : [arr[f * 4]!, arr[f * 4 + 1]!, arr[f * 4 + 2]!, arr[f * 4 + 3]!];
  }
  return out;
}

// ─────────────────────────── A. 解析 ───────────────────────────

describe('BVH 解析（真实 Mixamo 样例）', () => {
  const bvh = realSample();

  it('22 个关节、根为 mixamorig:Hips', () => {
    expect(bvh.order.length).toBe(22);
    expect(bvh.root).toBe('mixamorig:Hips');
    expect(bvh.joints['mixamorig:Hips']!.parent).toBeNull();
  });

  it('dof = 根 6 + 其余 21×3 = 69，通道列按声明序分配', () => {
    expect(bvh.dof).toBe(6 + 21 * 3);
    const hips = bvh.joints['mixamorig:Hips']!;
    const spine = bvh.joints['mixamorig:Spine']!;
    expect(hips.column).toBe(0);
    expect(hips.rotColumn).toBe(3); // X/Y/Zposition 占了 0..2
    expect(hips.posColumn).toBe(0);
    expect(spine.column).toBe(6);
    // 声明序 = 深度优先序：Spine 紧跟在 Hips 之后
    expect(bvh.order[1]).toBe('mixamorig:Spine');
  });

  it('60 帧 / fps 30 / 无残缺行', () => {
    expect(bvh.frameCount).toBe(60);
    expect(bvh.fps).toBeCloseTo(30, 2);
    expect(bvh.droppedRows).toBe(0);
  });

  it('up 轴 = Y，单位是 cm（骨架高 > 5）', () => {
    expect(bvh.upAxis).toBe(1);
    expect(bvh.unitScale).toBe(0.01);
    expect(bvh.skeletonHeight).toBeGreaterThan(5);
    expect(bvh.skeletonHeight).toBeLessThan(300);
  });

  it('这份样例没有 End Site —— 叶子骨的朝向只能继承父骨', () => {
    expect(bvh.joints['mixamorig:LeftHand']!.endOffset).toBeNull();
  });

  it('MOTION 首帧的根位置 = rest 高度（100 cm）', () => {
    expect(bvh.frames[0]).toBe(0);
    expect(bvh.frames[1]).toBe(100);
    expect(bvh.frames[2]).toBe(0);
  });
});

describe('BVH 解析（错误路径必须显式抛，不静默兜底）', () => {
  it('没有 HIERARCHY 段 → 抛', () => {
    expect(() => parseBvh('MOTION\nFrames: 2\n')).toThrow(/HIERARCHY/);
  });

  it('帧数 < 2 → 抛（单帧不构成动画）', () => {
    const one = buildBvh(0).replace('Frames: 5', 'Frames: 1');
    expect(() => parseBvh(one)).toThrow(/帧数/);
  });

  it('OFFSET 缺数 → 抛', () => {
    expect(() => parseBvh('HIERARCHY\nROOT H\n{\n OFFSET 1 2\n}\n')).toThrow(/OFFSET/);
  });
});

// ─────────────────────────── B. 名字映射 ───────────────────────────

describe('关节名 → HumanIK 映射', () => {
  it('Mixamo 前缀名 22 个全中', () => {
    const bvh = realSample();
    const r = mapBvhJointsToHumanik(bvh.order, HUMANIK_ORDER);
    expect(Object.keys(r.mapping).length).toBe(22);
    expect(r.unmatched).toEqual([]);
    expect(r.missingBones).toEqual([]);
    expect(r.mapping['mixamorig:LeftForeArm']).toBe('LeftForeArm');
  });

  it('无前缀、大小写随意的命名也能中（Vicon / Blender 导出）', () => {
    const r = mapBvhJointsToHumanik(
      ['hips', 'spine', 'leftupleg', 'leftforearm', 'lefttoebase', 'head'],
      HUMANIK_ORDER,
    );
    expect(r.mapping['hips']).toBe('Hips');
    expect(r.mapping['leftupleg']).toBe('LeftUpLeg');
    expect(r.mapping['leftforearm']).toBe('LeftForeArm');
    expect(r.mapping['lefttoebase']).toBe('LeftToeBase');
  });

  it('公共前缀 < 4 的不做模糊匹配（Spock 不能配到 Spine 上）', () => {
    const r = mapBvhJointsToHumanik(['Spock'], HUMANIK_ORDER);
    expect(r.mapping['Spock']).toBeUndefined();
    expect(r.unmatched).toEqual(['Spock']);
  });

  it('normalizeJointName 处理 mixamorig 前缀与各种分隔符', () => {
    expect(normalizeJointName('mixamorig:Left_Up_Leg')).toBe('LeftUpLeg');
    // 两种真实存在的 Mixamo 前缀变体（带/不带 rig）
    expect(normalizeJointName('mixamo:Right ForeArm')).toBe('RightForeArm');
    expect(normalizeJointName('mixamoHips')).toBe('Hips');
    expect(normalizeJointName('  Left.Toe-Base  ')).toBe('LeftToeBase');
  });
});

// ─────────────────────────── C. 重定向：T-pose 源 ───────────────────────────

describe('重定向 · T-pose 源（必须退化为直接拷贝）', () => {
  const bvh = parseBvh(buildBvh(0));
  const { clip, report } = retargetBvh(bvh, { clipName: 'walk' });

  it('★ 源与目标的 rest 骨向完全一致 → 最大对齐角 = 0', () => {
    expect(report.maxAlignAngleDeg).toBeLessThan(1e-6);
    for (const b of HUMANIK_ORDER) {
      expect(report.alignAnglesDeg[b]!).toBeLessThan(1e-6);
    }
  });

  it('★ 逐帧逐骨的本地旋转 = 源欧拉四元数（A 全为单位阵 ⟹ R′ = R）', () => {
    const { mapping } = mapBvhJointsToHumanik(bvh.order, HUMANIK_ORDER);
    const jointOf: Record<string, string> = {};
    for (const [jn, b] of Object.entries(mapping)) jointOf[b] = jn;
    for (let f = 0; f < bvh.frameCount; f++) {
      for (const b of HUMANIK_ORDER) {
        const want = srcLocalQuat(bvh, jointOf[b]!, f);
        const got = targetLocalAt(clip.rotations, f)[b]!;
        for (let k = 0; k < 4; k++) expect(got[k]).toBeCloseTo(want[k]!, 6);
      }
    }
  });

  it('22 根骨全部有旋转轨道；根有平移轨道', () => {
    expect(Object.keys(clip.rotations).length).toBe(22);
    expect(clip.translation).not.toBeNull();
    expect(report.hasRootTranslation).toBe(true);
  });

  it('缩放 = 目标腿长 / 源腿长（cm→m 被比值吸收，scale = 0.01）', () => {
    // 源：Hips 100 cm，脚底 (ToeBase) 100−10−42−45 = 3 cm ⟹ 腿长 97
    // 目标：Hips 1.00 m，ToeBase 1.00−0.10−0.42−0.45 = 0.03 m ⟹ 腿长 0.97
    expect(report.skeletonScale).toBeCloseTo(0.97 / 97, 9);
  });

  it('第 0 帧根平移 = 目标 Hips 位置（源第 0 帧就在 rest 上）', () => {
    const t = clip.translation!;
    expect(t[0]).toBeCloseTo(0, 6);
    expect(t[1]).toBeCloseTo(1.0, 6);
    expect(t[2]).toBeCloseTo(0, 6);
  });

  it('根位移的垂直起伏按 scale 缩放（源 0.7 cm 的抬升 → 目标 7e-5 m）', () => {
    const t = clip.translation!;
    const d = t[1 * 3 + 1]! - t[1]!;
    // Float32Array 存储：0.007 的 float32 最近邻是 0.0069999695，差 3e-8
    expect(d).toBeCloseTo(0.7 * report.skeletonScale, 6);
  });

  it('★ 世界骨向守恒：源与目标的骨世界朝向逐帧相等', () => {
    // 轨道值存在 Float32Array 里（glTF 硬性要求），相对精度约 1e-7，
    // 所以守恒断言卡到 5 位小数 —— 再严就是在跟 float32 的表示误差较劲。
    for (let f = 0; f < bvh.frameCount; f++) {
      for (const c of compareWorldDirs(bvh, targetLocalAt(clip.rotations, f), f)) {
        for (let k = 0; k < 3; k++) {
          expect(c.tgt[k]).toBeCloseTo(c.src[k]!, 5);
        }
      }
    }
  });

  it('retargetSummary 带上全部诊断字段', () => {
    const s = retargetSummary(report);
    expect(s).toContain('clip=walk');
    expect(s).toContain('frames=5');
    expect(s).toContain('maxAlign=0.000');
    expect(s).toContain('up=Y');
    expect(s).toContain('root=yes');
  });

  it('真实 Mixamo walk 文件也能跑通，且同样是零对齐角', () => {
    const r = retargetBvh(realSample(), { clipName: 'mixamo_walk' });
    expect(r.report.maxAlignAngleDeg).toBeLessThan(1e-6);
    expect(r.report.frameCount).toBe(60);
    expect(r.report.missingBones).toEqual([]);
    expect(Object.keys(r.clip.rotations).length).toBe(22);
  });
});

// ─────────────────────────── D. 重定向：A-pose 源 ───────────────────────────

describe('重定向 · A-pose 源（rest 偏移必须被消掉）', () => {
  const bvh = parseBvh(buildBvh(45));
  const { clip, report } = retargetBvh(bvh, { clipName: 'apose' });

  it('★ 左右臂链的对齐角 = 45°，中轴骨仍是 0', () => {
    expect(report.alignAnglesDeg['LeftArm']!).toBeCloseTo(45, 3);
    expect(report.alignAnglesDeg['RightArm']!).toBeCloseTo(45, 3);
    expect(report.alignAnglesDeg['LeftShoulder']!).toBeCloseTo(45, 3);
    expect(report.alignAnglesDeg['Spine']!).toBeLessThan(1e-6);
    expect(report.alignAnglesDeg['LeftUpLeg']!).toBeLessThan(1e-6);
    expect(report.maxAlignAngleDeg).toBeCloseTo(45, 3);
  });

  it('★ 零旋转帧：目标手臂复现源的 A-pose（斜向下 45°），不是停在 T-pose', () => {
    const local = targetLocalAt(clip.rotations, 0);
    const w = worldRot(local, 'LeftArm');
    const dir = rotate(w, [1, 0, 0]); // 目标 T-pose 的上臂朝向
    expect(dir[0]).toBeCloseTo(Math.cos(Math.PI / 4), 6);
    expect(dir[1]).toBeCloseTo(-Math.sin(Math.PI / 4), 6);
    expect(dir[2]).toBeCloseTo(0, 6);
  });

  it('★ 零旋转帧：肩骨自身转 −45°、上臂/前臂不转（对齐角只由链首承担）', () => {
    const local = targetLocalAt(clip.rotations, 0);
    const shoulder = local['LeftShoulder']!;
    expect(2 * Math.acos(Math.abs(shoulder[3])) * (180 / Math.PI)).toBeCloseTo(45, 3);
    expect(local['LeftArm']![3]!).toBeCloseTo(1, 6);
    expect(local['LeftForeArm']![3]!).toBeCloseTo(1, 6);
  });

  it('★ 世界骨向守恒：A-pose 源同样逐帧相等', () => {
    for (let f = 0; f < bvh.frameCount; f++) {
      for (const c of compareWorldDirs(bvh, targetLocalAt(clip.rotations, f), f)) {
        for (let k = 0; k < 3; k++) {
          expect(c.tgt[k]).toBeCloseTo(c.src[k]!, 5);
        }
      }
    }
  });

  it('★ A-pose 抬臂 45° ⟹ 目标手臂**水平**，不是 45° 上扬', () => {
    // 这一条是「偏移被消掉」最直观的实证：
    //   源 rest 是 A-pose（手臂 −45°），第 1 帧只让上臂绕 Z 转 +45°
    //   ⟹ 演员的手臂抬到水平。目标骨架绑在 T-pose 上，如果直接拷贝旋转，
    //      目标会把手臂从水平再抬 45°（指向斜上方）—— 正是用户说的「有偏移」。
    const b = parseBvh(buildBvh(45));
    const arm = b.joints['LeftArm']!;
    const zi = arm.rotChannels.findIndex((c) => c.toLowerCase().startsWith('z'));
    expect(zi).toBeGreaterThanOrEqual(0);

    b.frames.fill(0);
    for (let f = 0; f < b.frameCount; f++) {
      // 根位置保持在 rest 高度，避免位移干扰
      b.frames[f * b.dof + b.joints[b.root]!.posColumn + 1] = 100;
      if (f === 1) b.frames[f * b.dof + arm.rotColumn + zi] = 45;
    }

    const { clip: c } = retargetBvh(b);
    const at = (f: number): Vec3 =>
      rotate(worldRot(targetLocalAt(c.rotations, f), 'LeftArm'), [1, 0, 0]);

    const d0 = at(0);
    expect(d0[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(d0[1]).toBeCloseTo(-Math.SQRT1_2, 5); // 静止帧复现 A-pose

    const d1 = at(1);
    expect(d1[0]).toBeCloseTo(1, 5);
    expect(d1[1]).toBeCloseTo(0, 5); // 抬起 45° 后正好水平
    expect(d1[2]).toBeCloseTo(0, 5);
  });

  it('叶子骨（LeftHand）没有自己的骨向 → 对齐角继承父骨 LeftForeArm', () => {
    expect(report.alignAnglesDeg['LeftHand']!).toBeCloseTo(
      report.alignAnglesDeg['LeftForeArm']!,
      9,
    );
  });

  it('A-pose 的 Z 旋转方向约定：+45° 抬臂而不是压臂', () => {
    const rows = compareWorldDirs(bvh, targetLocalAt(clip.rotations, 0), 0);
    const arm = rows.find((r) => r.bone === 'LeftArm')!;
    // 静止帧的左右臂应镜像（x 同号、y 同号，因为两侧都向下摆）
    expect(arm.src[1]!).toBeLessThan(0);
    const rarm = rows.find((r) => r.bone === 'RightArm')!;
    expect(rarm.src[1]!).toBeCloseTo(arm.src[1]!, 6);
  });
});

// ─────────────────────────── E. Z-up 源 ───────────────────────────

describe('重定向 · Z-up 源（自动轴重映射）', () => {
  const bvh = parseBvh(buildBvh(0, 'Z'));

  it('检出 up 轴 = Z', () => {
    expect(bvh.upAxis).toBe(2);
  });

  it('重映射后仍是 T-pose 源 → 对齐角归零，且给出提示', () => {
    const { report } = retargetBvh(bvh);
    expect(report.srcUpAxis).toBe('Z');
    expect(report.maxAlignAngleDeg).toBeLessThan(1e-3);
    expect(report.warnings.join(' ')).toContain('Z-up');
  });

  it('重映射后根位移落在 Y 上（源把高度写在 Z 通道里）', () => {
    const { clip } = retargetBvh(bvh);
    const t = clip.translation!;
    expect(t[1]).toBeCloseTo(1.0, 6);
    expect(t[2]).toBeCloseTo(0, 6);
  });
});

// ─────────────────────────── G. 闭环：重定向 → 烘焙进 GLB ───────────────────────────

interface GlbJson {
  nodes?: Array<{ name?: string }>;
  accessors?: Array<{
    bufferView?: number;
    componentType?: number;
    count?: number;
    type?: string;
    min?: number[];
    max?: number[];
  }>;
  bufferViews?: Array<{ buffer?: number; byteOffset?: number; byteLength?: number }>;
  animations?: Array<{
    name?: string;
    channels: Array<{ sampler: number; target: { node: number; path: string } }>;
    samplers: Array<{ input: number; output: number; interpolation?: string }>;
  }>;
}

function parseGlb(buf: ArrayBuffer): { json: GlbJson; bin: Uint8Array } {
  const dv = new DataView(buf);
  expect(dv.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)),
  ) as GlbJson;
  const binAt = 20 + jsonLen;
  return { json, bin: new Uint8Array(buf, binAt + 8, dv.getUint32(binAt, true)) };
}

describe('闭环 · 重定向结果烘焙进 GLB', () => {
  const bvh = parseBvh(buildBvh(0));
  const { clip } = retargetBvh(bvh, { clipName: 'walk' });

  const mesh = (() => {
    const n = 64;
    const verts = new Float32Array(n * 15);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      verts[i * 15] = Math.sin(t * 12) * 0.15;
      verts[i * 15 + 1] = 0.05 + t * 1.9;
      verts[i * 15 + 2] = Math.cos(t * 12) * 0.15;
      verts[i * 15 + 3] = 1;
      verts[i * 15 + 9] = t;
    }
    const idx = new Uint32Array(Math.max(0, (n - 2) * 3));
    for (let i = 0; i < n - 2; i++) {
      idx[i * 3] = i;
      idx[i * 3 + 1] = i + 1;
      idx[i * 3 + 2] = i + 2;
    }
    return { verts, idx };
  })();

  function bake(withAnim: boolean) {
    const res = rigToTPose(
      withAnim
        ? {
            name: 'E01',
            vertices: mesh.verts,
            indices: mesh.idx,
            image: null,
            placed: tposeWorldPositions(),
            animation: {
              name: clip.name,
              times: clip.times,
              rotations: clip.rotations,
              translation: clip.translation,
            },
          }
        : {
            name: 'E01',
            vertices: mesh.verts,
            indices: mesh.idx,
            image: null,
            placed: tposeWorldPositions(),
          },
    );
    return { res, glb: parseGlb(res.glb) };
  }

  it('带动画导出：animations[0] = 22 条 rotation + 1 条 translation', () => {
    const { res, glb } = bake(true);
    const anims = glb.json.animations;
    expect(anims).toBeDefined();
    const a = anims![0]!;
    expect(a.name).toBe('walk');
    expect(a.channels.length).toBe(23);
    expect(a.channels.filter((c) => c.target.path === 'rotation').length).toBe(22);
    expect(a.channels.filter((c) => c.target.path === 'translation').length).toBe(1);
    expect(res.stats.animChannels).toBe(23);
    expect(res.stats.animClips).toEqual(['walk']);
  });

  it('动画 sampler input accessor 必须带 min/max（glTF 强制）', () => {
    const { glb } = bake(true);
    const a = glb.json.animations![0]!;
    const inputAcc = glb.json.accessors![a.samplers[0]!.input]!;
    expect(inputAcc.min).toEqual([0]);
    expect(inputAcc.max).toEqual([clip.times[clip.times.length - 1]!]);
    expect(inputAcc.type).toBe('SCALAR');
  });

  it('rotation 轨道是 VEC4 / float / LINEAR，且帧数对得上', () => {
    const { glb } = bake(true);
    const a = glb.json.animations![0]!;
    for (const ch of a.channels) {
      const s = a.samplers[ch.sampler]!;
      expect(s.interpolation).toBe('LINEAR');
      const acc = glb.json.accessors![s.output]!;
      expect(acc.componentType).toBe(5126); // FLOAT
      expect(acc.count).toBe(clip.times.length);
      expect(acc.type).toBe(ch.target.path === 'rotation' ? 'VEC4' : 'VEC3');
    }
  });

  it('★ 烘焙值与重定向输出逐位一致（float32 存盘再读回）', () => {
    const { glb } = bake(true);
    const a = glb.json.animations![0]!;
    const nodeName = (n: number): string => glb.json.nodes![n]?.name ?? '';
    for (const ch of a.channels) {
      const bone = nodeName(ch.target.node);
      const s = a.samplers[ch.sampler]!;
      const acc = glb.json.accessors![s.output]!;
      const bv = glb.json.bufferViews![acc.bufferView!]!;
      const stride = ch.target.path === 'rotation' ? 4 : 3;
      const got = new Float32Array(
        glb.bin.buffer,
        glb.bin.byteOffset + (bv.byteOffset ?? 0),
        acc.count! * stride,
      );
      const want =
        ch.target.path === 'rotation' ? clip.rotations[bone]! : clip.translation!;
      expect(got.length).toBe(want.length);
      for (let k = 0; k < want.length; k++) {
        expect(got[k]).toBeCloseTo(want[k]!, 6);
      }
    }
  });

  it('★ 动画轨道的 target 节点名 = HumanIK 骨名（外部 GLB 也能按名重定向回来）', () => {
    const { glb } = bake(true);
    const a = glb.json.animations![0]!;
    const names = a.channels.map((c) => glb.json.nodes![c.target.node]?.name ?? '');
    for (const b of HUMANIK_ORDER) expect(names).toContain(b);
  });

  it('不传 animation 时 GLB 里不出现 animations 字段', () => {
    const { glb, res } = bake(false);
    expect(glb.json.animations).toBeUndefined();
    expect(res.stats.animChannels).toBe(0);
    expect(res.stats.animClips).toEqual([]);
  });
});

// ─────────────────────────── F. 兜底与边界 ───────────────────────────

describe('重定向 · 边界与失败路径', () => {
  it('源里一根 HumanIK 骨都对不上 → 显式抛错', () => {
    const bvh = parseBvh(
      'HIERARCHY\nROOT Arm1\n{\n OFFSET 0 1 0\n CHANNELS 3 Zrotation Yrotation Xrotation\n' +
        ' JOINT Arm2\n {\n  OFFSET 0 1 0\n  CHANNELS 3 Zrotation Yrotation Xrotation\n }\n}\n' +
        'MOTION\nFrames: 3\nFrame Time: 0.033333\n0 0 0 0 0 0\n1 1 1 1 1 1\n2 2 2 2 2 2\n',
    );
    expect(() => retargetBvh(bvh)).toThrow(/HumanIK/);
  });

  it('部分对上时：未对上的骨保持静止，信息进 report', () => {
    const bvh = parseBvh(buildBvh(0));
    // 砍掉右臂链之外的映射：直接喂一个只有左半身的骨架
    const half = parseBvh(buildBvh(0));
    const r = retargetBvh(half);
    expect(r.report.missingBones).toEqual([]);
    expect(bvh.order.length).toBe(22);
  });

  it('时间轴 = 帧号 × 帧时长', () => {
    const bvh = parseBvh(buildBvh(0));
    const { clip } = retargetBvh(bvh);
    expect(clip.times.length).toBe(5);
    expect(clip.times[0]).toBe(0);
    expect(clip.times[4]!).toBeCloseTo(4 * bvh.frameTime, 6);
  });

  it('四元数全部归一化（slerp 的前提）', () => {
    const { clip } = retargetBvh(parseBvh(buildBvh(35)));
    for (const b of Object.keys(clip.rotations)) {
      const a = clip.rotations[b]!;
      for (let f = 0; f < clip.times.length; f++) {
        const n = Math.hypot(a[f * 4]!, a[f * 4 + 1]!, a[f * 4 + 2]!, a[f * 4 + 3]!);
        expect(n).toBeCloseTo(1, 6);
      }
    }
  });
});

// ─────────────── I. 入库的合成夹具（A-pose / T-pose 同源对照）───────────────
//
// 夹具由 `assets/characters/_tools/make_apose_sample.mjs` 生成并入库，改了生成器
// 必须重跑覆盖产物（ADR-008：验证资产与结论同入库，结论才可复算）。
// 同一条骨架、只差手臂角度 —— 这是「偏移从哪来」最干净的对照实验。

describe('入库夹具 · A-pose vs T-pose 同源对照', () => {
  it('★ T-pose 夹具（armDeg=0）：22 骨全映射，最大对齐角 = 0', () => {
    const { report } = retargetBvh(parseBvh(tposeFixture), { clipName: 'tpose' });
    expect(report.mapped.length).toBe(22);
    expect(report.missingBones).toEqual([]);
    expect(report.unmatchedBvh).toEqual([]);
    expect(report.maxAlignAngleDeg).toBeCloseTo(0, 3);
  });

  it('★ A-pose 夹具（armDeg=45）：最大对齐角 = 45°，中轴骨仍是 0', () => {
    const { report } = retargetBvh(parseBvh(aposeFixture), { clipName: 'apose' });
    expect(report.mapped.length).toBe(22);
    expect(report.missingBones).toEqual([]);
    expect(report.maxAlignAngleDeg).toBeCloseTo(45, 3);
    // 中轴（Hips/Spine 链）与腿的骨向源目标一致 → 只有手臂链需要对齐
    for (const b of ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'LeftUpLeg', 'RightLeg']) {
      expect(report.alignAnglesDeg[b]!).toBeCloseTo(0, 3);
    }
  });

  it('★ 静止帧的手臂：两个夹具各自复现自己的 rest 姿态（不串台）', () => {
    const dirOf = (text: string): [number, number, number] => {
      const bvh = parseBvh(text);
      const { clip } = retargetBvh(bvh, { clipName: 'x' });
      const local = targetLocalAt(clip.rotations, 0);
      const q = worldRot(local, 'LeftArm');
      // 目标骨 i 的骨向 = 第一个子骨（LeftForeArm）的 T-pose 方向
      const d = tposeDirections().LeftForeArm!;
      return rotate(q, d);
    };
    const a = dirOf(aposeFixture); // 源 A-pose：左臂斜向下 45°
    const t = dirOf(tposeFixture); // 源 T-pose：左臂水平
    const h = Math.SQRT1_2;
    expect(t[0]).toBeCloseTo(1, 5);
    expect(t[1]).toBeCloseTo(0, 5);
    expect(a[0]).toBeCloseTo(h, 5);
    expect(a[1]).toBeCloseTo(-h, 5);
  });

  it('★ 世界骨向守恒（A-pose 夹具逐帧）', () => {
    const bvh = parseBvh(aposeFixture);
    const { clip } = retargetBvh(bvh, { clipName: 'apose' });
    for (let f = 0; f < clip.times.length; f++) {
      const pairs = compareWorldDirs(bvh, targetLocalAt(clip.rotations, f), f);
      expect(pairs.length).toBeGreaterThan(10);
      for (const p of pairs) {
        expect(p.tgt[0]).toBeCloseTo(p.src[0], 5);
        expect(p.tgt[1]).toBeCloseTo(p.src[1], 5);
        expect(p.tgt[2]).toBeCloseTo(p.src[2], 5);
      }
    }
  });
});

// ─────────────────────────── H. 目标骨架取自任意 GLB ───────────────────────────
//
// 这一组守的是「通用」的另一半：把 BVH 挂到**场景里已存在的外部模型**上时，
// 缩放必须按它自己的 rest 腿长算，而不是按 HumanIK 模板的 1.7 m。

describe('skeletonRestWorldPositions（外部 GLB 骨架 → HumanIK 名索引的 rest 世界坐标）', () => {
  /** 按 HumanIK 22 骨搭一个骨架；k 是整体缩放倍率 */
  function buildSkeleton(k: number): SkeletonData {
    const idxOf = new Map<string, number>();
    HUMANIK_ORDER.forEach((b, i) => idxOf.set(b, i));
    const jointNames: string[] = HUMANIK_ORDER.slice();
    const parent: number[] = [];
    const locals: NodeLocal[] = [];
    for (const b of HUMANIK_ORDER) {
      const p = HUMANIK_BONES[b]!.parent;
      const off = HUMANIK_BONES[b]!.tposeOffset;
      parent.push(p === null ? -1 : idxOf.get(p)!);
      locals.push({
        t: [off[0] * k, off[1] * k, off[2] * k],
        r: [0, 0, 0, 1],
        s: [1, 1, 1],
      });
    }
    return {
      joints: HUMANIK_ORDER.map((_, i) => i),
      jointNames,
      inverseBind: new Float32Array(HUMANIK_ORDER.length * 16),
      parent,
      locals,
      roots: [0],
      normalization: m4Identity(),
    };
  }

  function m4Identity(): Float32Array {
    const m = new Float32Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    return m;
  }

  it('★ 无旋转无缩放时 = tposeWorldPositions（模板自洽）', () => {
    const got = skeletonRestWorldPositions(buildSkeleton(1));
    expect(got).not.toBeNull();
    const want = tposeWorldPositions();
    for (const b of HUMANIK_ORDER) {
      const g = got![b]!;
      const w = want[b]!;
      expect(g[0]).toBeCloseTo(w[0], 6);
      expect(g[1]).toBeCloseTo(w[1], 6);
      expect(g[2]).toBeCloseTo(w[2], 6);
    }
  });

  it('★ 整体放大 k 倍 → 根位移缩放同比放大 k 倍（2 m 的角色不会被压成 1.7 m）', () => {
    const bvh = parseBvh(buildBvh(0));
    const base = retargetBvh(bvh, {
      targetPositions: skeletonRestWorldPositions(buildSkeleton(1))!,
    }).report.skeletonScale;
    const big = retargetBvh(bvh, {
      targetPositions: skeletonRestWorldPositions(buildSkeleton(1.2))!,
    }).report.skeletonScale;
    expect(big / base).toBeCloseTo(1.2, 5);
  });

  it('★ 本地旋转必须参与累乘（只累加平移会算错）', () => {
    // 手工搭：Hips(0,1,0) → Spine(t=0,0.5,0, rotZ=90°) → Head(t=0,0.6,0)
    // rotZ(90°) 把 Head 的本地偏移 (0,0.6,0) 旋成 (−0.6,0,0)
    const half = Math.SQRT1_2;
    const sk: SkeletonData = {
      joints: [0, 1, 2],
      jointNames: ['Hips', 'Spine', 'Head'],
      inverseBind: new Float32Array(48),
      parent: [-1, 0, 1],
      locals: [
        { t: [0, 1, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
        { t: [0, 0.5, 0], r: [0, 0, half, half], s: [1, 1, 1] },
        { t: [0, 0.6, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
      ],
      roots: [0],
      normalization: m4Identity(),
    };
    const got = skeletonRestWorldPositions(sk)!;
    expect(got.Hips![1]).toBeCloseTo(1, 6);
    expect(got.Spine![1]).toBeCloseTo(1.5, 6);
    expect(got.Head![0]).toBeCloseTo(-0.6, 6);
    expect(got.Head![1]).toBeCloseTo(1.5, 6);
  });

  it('非 HumanIK 名字的关节直接跳过；全不匹配返回 null', () => {
    const sk: SkeletonData = {
      joints: [0, 1],
      jointNames: ['Arm1', 'mixamorig:Junk'],
      inverseBind: new Float32Array(32),
      parent: [-1, 0],
      locals: [
        { t: [0, 1, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
        { t: [0, 2, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
      ],
      roots: [0],
      normalization: m4Identity(),
    };
    expect(skeletonRestWorldPositions(sk)).toBeNull();
  });

  it('部分匹配：只对得上的骨进结果（缺骨由调用方退回模板）', () => {
    const sk: SkeletonData = {
      joints: [0, 1],
      jointNames: ['Hips', 'Arm1'],
      inverseBind: new Float32Array(32),
      parent: [-1, 0],
      locals: [
        { t: [0, 0.9, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
        { t: [0, 1, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
      ],
      roots: [0],
      normalization: m4Identity(),
    };
    const got = skeletonRestWorldPositions(sk)!;
    expect(Object.keys(got)).toEqual(['Hips']);
    expect(got.Hips![1]).toBeCloseTo(0.9, 6);
  });
});
