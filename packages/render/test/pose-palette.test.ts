/**
 * 烘焙姿态调色板测试（docs/20 M1 验收项，纯 CPU）。
 *
 * docs/20 §6 给 M1 定的验收：
 *   ① bind pose 帧 = 单位阵
 *   ② 走跑两帧不同
 *   ③ 表面积保持（网格蒙皮后不塌缩）
 * ①② 在本文件断言；③ 需要 GPU 采样，归 M2 浏览器验收（诚实边界）。
 *
 * 夹具用手搓骨架 + 关键帧动画（不依赖 80k 面真实 GLB——单测要快且确定）。
 */

import { describe, expect, it } from 'vitest';
import { bakePosePalette, poseIndexAt, bindPoseIndex, PALETTE_SAMPLE_FPS } from '../src/pose-palette';
import { createSkinState, evalJointMatrices } from '../src/skin';
import type { SkeletonData, AnimClip } from '@aether/scene';

// ---------------------------------------------------------------- 夹具

/**
 * 两关节手搓骨架，结构与 gltf.ts 的 SkeletonData 严格对齐：
 * joints = 节点索引表、locals = bind TRS、inverseBind = bind 世界矩阵的逆。
 * 节点 0（Hips，root）、节点 1（Head，父=0）。Y-up。
 */
function makeSkeleton(): SkeletonData {
  return {
    joints: [0, 1],
    jointNames: ['Hips', 'Head'],
    // bind 世界矩阵：Hips = T(0,1,0)、Head = T(0,1.5,0)。逆 = T(0,-y,0)
    inverseBind: new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1.5, 0, 1,
    ]),
    parent: [-1, 0],
    locals: [
      { t: [0, 1, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
      { t: [0, 0.5, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
    ],
    roots: [0],
    normalization: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  } as unknown as SkeletonData;
}

function trTrack(node: number, times: number[], pos: number[][], rots: number[][]): AnimClip['tracks'] {
  return [
    {
      node,
      path: 'translation' as const,
      times: new Float32Array(times),
      values: new Float32Array(pos.flat()),
      stride: 3,
      interpolation: 'LINEAR' as const,
    },
    {
      node,
      path: 'rotation' as const,
      times: new Float32Array(times),
      values: new Float32Array(rots.flat()),
      stride: 4,
      interpolation: 'LINEAR' as const,
    },
  ];
}

/** 1 秒 walk：Hips 沿 X 平移 0→1 */
function makeWalkClip(): AnimClip {
  return {
    name: 'walk',
    duration: 1,
    tracks: trTrack(0, [0, 1], [[0, 1, 0], [1, 1, 0]], [
      [0, 0, 0, 1],
      [0, 0, 0, 1],
    ]),
  };
}

/** 1 秒 run：Hips 原地绕 Y 转 90° */
function makeRunClip(): AnimClip {
  return {
    name: 'run',
    duration: 1,
    tracks: trTrack(0, [0, 1], [[0, 1, 0], [0, 1, 0]], [
      [0, 0, 0, 1],
      [0, 0.3826834, 0, 0.9238795],
    ]),
  };
}

// ---------------------------------------------------------------- 断言工具

function matAt(pal: ReturnType<typeof bakePosePalette>, pose: number, joint: number): Float32Array {
  const o = (pose * pal.jointCount + joint) * 16;
  return pal.data.subarray(o, o + 16);
}

function isIdentity(m: Float32Array, eps = 1e-5): boolean {
  const expect = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) {
    if (Math.abs(m[i]! - expect[i]!) > eps) return false;
  }
  return true;
}

// ---------------------------------------------------------------- 测试

describe('bakePosePalette · 结构', () => {
  it('帧数 = ceil(duration × fps)，clip 拼接后 clipBasePose 首尾相接', () => {
    const sk = makeSkeleton();
    const pal = bakePosePalette(sk, [makeWalkClip(), makeRunClip()], { fps: 24 });
    expect(pal.clips).toHaveLength(2);
    expect(pal.clips[0]!.frameCount).toBe(24); // 1s × 24fps
    expect(pal.clips[1]!.frameCount).toBe(24);
    expect(pal.clipBasePose).toEqual([0, 24]);
    expect(pal.jointCount).toBe(3); // 2 关节 + 末尾恒等
    // 48 动画帧 + 1 bind pose 帧
    expect(pal.data.length).toBe(49 * 3 * 16);
  });

  it('时长 0 的退化 clip 也有一帧（bind 邻近态），不产出空 palette', () => {
    const degenerate = { name: 'idle0', duration: 0, tracks: [] } as unknown as AnimClip;
    const pal = bakePosePalette(makeSkeleton(), [degenerate]);
    expect(pal.clips[0]!.frameCount).toBe(1);
  });

  it('clipNames 过滤生效；过滤后为空则报错（不静默产出空数据）', () => {
    const sk = makeSkeleton();
    const pal = bakePosePalette(sk, [makeWalkClip(), makeRunClip()], { clipNames: ['run'] });
    expect(pal.clips.map((c) => c.name)).toEqual(['run']);
    expect(() => bakePosePalette(sk, [makeWalkClip()], { clipNames: ['nope'] })).toThrow();
  });

  it('mobile 档降采样（fps=16）帧数随之减少', () => {
    const pal = bakePosePalette(makeSkeleton(), [makeWalkClip()], { fps: 16 });
    expect(pal.clips[0]!.frameCount).toBe(16);
  });
});

describe('bakePosePalette · docs/20 M1 验收 ①：bind pose 帧 = 单位阵', () => {
  it('第 0 帧的关节矩阵是恒等（顶点原样不动）', () => {
    const pal = bakePosePalette(makeSkeleton(), [makeWalkClip()]);
    // walk 第 0 帧 time=0，动画在 t=0 处位置 = bind 位置 → 关节矩阵 = I
    expect(isIdentity(matAt(pal, 0, 0))).toBe(true);
    expect(isIdentity(matAt(pal, 0, 1))).toBe(true);
    // 末尾恒等关节（未蒙皮 primitive 的绑定目标）恒为 I
    expect(isIdentity(matAt(pal, 0, 2))).toBe(true);
  });
});

describe('bakePosePalette · docs/20 M1 验收 ②：走跑两帧不同', () => {
  it('同一 clip 相邻两帧的矩阵不同（动画真的被采样了）', () => {
    const pal = bakePosePalette(makeSkeleton(), [makeWalkClip()], { fps: 24 });
    const f0 = matAt(pal, 0, 0);
    const f12 = matAt(pal, 12, 0); // 0.5s：root 已移动
    let diff = 0;
    for (let i = 0; i < 16; i++) diff += Math.abs(f0[i]! - f12[i]!);
    expect(diff).toBeGreaterThan(0.1); // 位置差 0.5m 级别
  });

  it('walk 与 run 同相位帧不同（clip 之间可区分）', () => {
    const pal = bakePosePalette(makeSkeleton(), [makeWalkClip(), makeRunClip()]);
    const walk = matAt(pal, poseIndexAt(pal, 0, 0.5), 0);
    const run = matAt(pal, poseIndexAt(pal, 1, 0.5), 0);
    let diff = 0;
    for (let i = 0; i < 16; i++) diff += Math.abs(walk[i]! - run[i]!);
    expect(diff).toBeGreaterThan(0.05);
  });

  it('🔴 与静态通道一致性：同一 SkinState 逐帧求值，palette 与直接 eval 相同', () => {
    // 这是 docs/20 否决 VAT 的理由落地：调色板 = 现有求值的搬运，不另写采样
    const sk = makeSkeleton();
    const pal = bakePosePalette(sk, [makeWalkClip()]);
    const st = createSkinState(sk, [makeWalkClip()]);
    const scratch = new Float32Array(pal.jointCount * 16);
    st.time = 10 / 24;
    evalJointMatrices(st, scratch);
    const baked = matAt(pal, 10, 0);
    for (let i = 0; i < 16; i++) {
      expect(baked[i]).toBeCloseTo(scratch[i]!, 5);
    }
  });
});

describe('poseIndexAt · 相位查表', () => {
  it('phase 0 → 首帧；phase 1 → 末帧；越界被钳制', () => {
    const pal = bakePosePalette(makeSkeleton(), [makeWalkClip(), makeRunClip()]);
    expect(poseIndexAt(pal, 0, 0)).toBe(0);
    expect(poseIndexAt(pal, 0, 1)).toBe(23);
    expect(poseIndexAt(pal, 0, -0.5)).toBe(0);
    expect(poseIndexAt(pal, 0, 1.7)).toBe(23);
  });

  it('clip 1 的 pose 从其 base 起（拼接不串位）', () => {
    const pal = bakePosePalette(makeSkeleton(), [makeWalkClip(), makeRunClip()]);
    expect(poseIndexAt(pal, 1, 0)).toBe(24);
    expect(poseIndexAt(pal, 1, 0.5)).toBe(24 + 12);
  });

  it('clip 下标越界报错（不静默给错姿态）', () => {
    const pal = bakePosePalette(makeSkeleton(), [makeWalkClip()]);
    expect(() => poseIndexAt(pal, 5, 0)).toThrow(/越界/);
  });
});

describe('bindPoseIndex · 静止姿态约定', () => {
  it('指向 palette 末尾追加的 bind pose 帧', () => {
    const pal = bakePosePalette(makeSkeleton(), [makeWalkClip()]);
    // 24 帧 + 1 帧 bind = 25 pose；bind 是最后一个
    expect(bindPoseIndex(pal)).toBe(24);
  });
});

describe('默认采样率', () => {
  it('PALETTE_SAMPLE_FPS = 24（docs/20 定稿值，改它要过 reviewer）', () => {
    expect(PALETTE_SAMPLE_FPS).toBe(24);
  });
});

describe('bind pose 追加帧 · 静止姿态', () => {
  it('末尾帧的关节矩阵是恒等（新生成实体的静止姿态）', () => {
    const pal = bakePosePalette(makeSkeleton(), [makeWalkClip()]);
    const bind = bindPoseIndex(pal);
    expect(isIdentity(matAt(pal, bind, 0))).toBe(true);
    expect(isIdentity(matAt(pal, bind, 1))).toBe(true);
  });
});
