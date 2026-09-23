import { describe, expect, it } from 'vitest';
import type { SkeletonData } from '@aether/scene';
import { HUMANIK_ORDER, tposeWorldPositions } from '../src/services/binding/humanik-template';
import { skeletonPositionsFromGltf } from '../src/services/binding/import-skeleton';

/**
 * 导入文件骨架（rigged GLB 桥）纯逻辑的回归测试。
 *
 * 守的不变量：
 *   - 静止世界位置 = locals 父子链 TRS 累乘（R/S 必须真的参与，不能只加平移）；
 *   - 面板空间位置 = normalization · 文件空间位置（与 parseGlb 的顶点同一把尺）；
 *   - 名称映射：精确白名单 + mixamorig 前缀剥除；缺骨保持模板位；
 *     未知/重复/无名/非有限一律进诊断列表，绝不静默丢。
 */

type Local = SkeletonData['locals'][number];
const IDENTITY_Q: [number, number, number, number] = [0, 0, 0, 1];
const ONE: [number, number, number] = [1, 1, 1];

function local(
  t: [number, number, number],
  r: [number, number, number, number] = IDENTITY_Q,
  s: [number, number, number] = ONE,
): Local {
  return { t, r, s };
}

const IDENTITY_NORM = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function makeSkeleton(partial: {
  joints: number[];
  jointNames: (string | null)[];
  parent: number[];
  locals: Local[];
  normalization?: Float32Array<ArrayBuffer>;
}): SkeletonData {
  return {
    joints: partial.joints,
    jointNames: partial.jointNames,
    inverseBind: new Float32Array(partial.joints.length * 16),
    parent: partial.parent,
    locals: partial.locals,
    roots: partial.parent.map((p, i) => (p < 0 ? i : -1)).filter((i) => i >= 0),
    normalization: partial.normalization ?? IDENTITY_NORM,
  };
}

describe('skeletonPositionsFromGltf：TRS 父子链累乘', () => {
  it('纯平移链：位置逐段累加', () => {
    const sk = makeSkeleton({
      joints: [0, 1, 2],
      jointNames: ['Hips', 'Spine', 'Spine1'],
      parent: [-1, 0, 1],
      locals: [local([0, 1, 0]), local([0, 0.2, 0]), local([0, 0.15, 0])],
    });
    const r = skeletonPositionsFromGltf(sk);
    expect(r.positions['Hips']).toEqual([0, 1, 0]);
    expect(r.positions['Spine']).toEqual([0, 1.2, 0]);
    expect(r.positions['Spine1']![1]).toBeCloseTo(1.35, 10);
    expect(r.imported).toEqual(['Hips', 'Spine', 'Spine1']);
  });

  it('旋转与缩放必须参与：父的 R/S 作用在子的平移上', () => {
    // 父：t=[0,1,0]，Rz90°（x'=-y, y'=x），s=2；子：t=[0,0.1,0]
    // 子的世界位置 = [0,1,0] + Rz90·(2·[0,0.1,0]) = [0,1,0] + [-0.2,0,0] = [-0.2,1,0]
    const q90z: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const sk = makeSkeleton({
      joints: [0, 1],
      jointNames: ['Hips', 'Spine'],
      parent: [-1, 0],
      locals: [local([0, 1, 0], q90z, [2, 2, 2]), local([0, 0.1, 0])],
    });
    const r = skeletonPositionsFromGltf(sk);
    expect(r.positions['Hips']).toEqual([0, 1, 0]);
    expect(r.positions['Spine']![0]).toBeCloseTo(-0.2, 10);
    expect(r.positions['Spine']![1]).toBeCloseTo(1, 10);
  });

  it('normalization 矩阵把文件空间映到面板空间（均匀缩放 ×2）', () => {
    const norm = new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    const sk = makeSkeleton({
      joints: [0],
      jointNames: ['Hips'],
      parent: [-1],
      locals: [local([0, 1, 0])],
      normalization: norm,
    });
    expect(skeletonPositionsFromGltf(sk).positions['Hips']).toEqual([0, 2, 0]);
  });

  it('父下标乱序（子先父后）也不许算错：递归累乘不假设节点序', () => {
    // 节点 0 是子（Spine），节点 1 才是父（Hips）——glTF 规范不保证父先子后
    const sk = makeSkeleton({
      joints: [0, 1],
      jointNames: ['Spine', 'Hips'],
      parent: [1, -1],
      locals: [local([0, 0.2, 0]), local([0, 1, 0])],
    });
    const r = skeletonPositionsFromGltf(sk);
    expect(r.positions['Hips']).toEqual([0, 1, 0]);
    expect(r.positions['Spine']).toEqual([0, 1.2, 0]);
  });

  it('父子环 / 自指：断链当根兜底，不递归爆栈', () => {
    const sk = makeSkeleton({
      joints: [0, 1, 2],
      jointNames: ['Hips', 'Spine', 'Spine1'],
      parent: [2, 0, 0], // Hips←Spine1、Spine←Hips、Spine1←Hips：0→2→0 成环
      locals: [local([0, 1, 0]), local([0, 0.2, 0]), local([0, 0.1, 0])],
    });
    // 不抛异常即为第一要义；位置只要求是有限数
    const r = skeletonPositionsFromGltf(sk);
    for (const n of ['Hips', 'Spine', 'Spine1']) {
      expect(r.positions[n]!.every((v) => Number.isFinite(v))).toBe(true);
    }
    // 自指单独一例
    const self = makeSkeleton({
      joints: [0],
      jointNames: ['Hips'],
      parent: [0],
      locals: [local([0, 1, 0])],
    });
    expect(skeletonPositionsFromGltf(self).positions['Hips']).toEqual([0, 1, 0]);
  });
});

describe('skeletonPositionsFromGltf：名称映射与诊断', () => {
  it('27 骨全命名精确命中：imported=27，keptTemplate=0，unknown=0', () => {
    const n = HUMANIK_ORDER.length;
    const sk = makeSkeleton({
      joints: HUMANIK_ORDER.map((_, i) => i),
      jointNames: [...HUMANIK_ORDER],
      parent: new Array<number>(n).fill(-1),
      locals: HUMANIK_ORDER.map((_, i) => local([i * 0.01, 1, 0])),
    });
    const r = skeletonPositionsFromGltf(sk);
    expect(n).toBe(27);
    expect(r.imported).toEqual([...HUMANIK_ORDER]);
    expect(r.keptTemplate).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.duplicates).toEqual([]);
    // 导入骨覆盖模板位
    expect(r.positions['Hips']).toEqual([0, 1, 0]);
    expect(r.positions['LeftArm']![0]).toBeCloseTo(HUMANIK_ORDER.indexOf('LeftArm') * 0.01, 10);
  });

  it('缺 5 根 tip 骨（旧 22 骨 rig）：保持模板位并进 keptTemplate', () => {
    const tips = ['HeadTip', 'LeftHandTip', 'RightHandTip', 'LeftToeTip', 'RightToeTip'];
    const names = HUMANIK_ORDER.filter((n) => !tips.includes(n));
    expect(names.length).toBe(22);
    const sk = makeSkeleton({
      joints: names.map((_, i) => i),
      jointNames: names,
      parent: new Array<number>(names.length).fill(-1),
      locals: names.map((_, i) => local([i * 0.01, 0.5, 0])),
    });
    const r = skeletonPositionsFromGltf(sk);
    expect(r.imported.length).toBe(22);
    expect(r.keptTemplate).toEqual(tips);
    // 保持模板位 = tposeWorldPositions 原值
    const tpl = tposeWorldPositions();
    for (const t of tips) expect(r.positions[t]).toEqual(tpl[t]);
    // 导入骨不用模板值
    expect(r.positions['Hips']).toEqual([0, 0.5, 0]);
  });

  it('mixamorig 前缀剥除后命中白名单', () => {
    const sk = makeSkeleton({
      joints: [0],
      jointNames: ['mixamorig:Hips'],
      parent: [-1],
      locals: [local([0, 1, 0])],
    });
    const r = skeletonPositionsFromGltf(sk);
    expect(r.imported).toEqual(['Hips']);
    expect(r.unknown).toEqual([]);
  });

  it('未知骨名 / 无名关节 / 重复骨名 / 非有限坐标：全部进诊断，不静默', () => {
    const sk = makeSkeleton({
      joints: [0, 1, 2, 3, 4],
      jointNames: ['WeaponBone', null, 'Hips', 'Hips', 'Spine'],
      parent: [-1, -1, -1, -1, -1],
      locals: [
        local([9, 9, 9]),
        local([8, 8, 8]),
        local([0, 1, 0]), // 第一个 Hips 胜出
        local([0, 7, 0]), // 重复，进 duplicates
        local([Number.NaN, 0, 0]),
      ],
    });
    const r = skeletonPositionsFromGltf(sk);
    expect(r.positions['Hips']).toEqual([0, 1, 0]);
    expect(r.imported).toEqual(['Hips']);
    expect(r.duplicates).toEqual(['Hips']);
    expect(r.unknown).toContain('WeaponBone');
    expect(r.unknown.some((n) => n.startsWith('#1'))).toBe(true);
    expect(r.unknown.some((n) => n.includes('Spine') && n.includes('非有限'))).toBe(true);
    // 非有限的 Spine 不映射 → 保持模板位
    expect(r.positions['Spine']).toEqual(tposeWorldPositions()['Spine']);
  });
});
