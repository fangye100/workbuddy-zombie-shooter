import { describe, it, expect } from 'vitest';
import {
  assemblePalettes,
  palettePoseCount,
  rankOrderEntries,
  ActorLibrary,
} from '../src/services/runtime-actors';
import { bakePosePalette, bindPoseIndex, type BakedPalette } from '@aether/render';
import type { SkeletonData, AnimClip } from '@aether/scene';

it('resource rename cache invalidation prevents late old fetch from repopulating entries or failure list', async () => {
  const manifest = { characters: [{ id: 'E-test', lods: [{ label: '+动画', file: 'old.glb' }] }] };
  let rejectOld!: (e: Error) => void; let calls = 0;
  const library = new ActorLibrary(manifest, async () => {
    calls++;
    if (calls === 1) return new Promise<ArrayBuffer>((_resolve, reject) => { rejectOld = reject; });
    throw new Error('new path fetch reached');
  });
  const old = library.preload('E-test'); library.clear();
  library.setManifest({ characters: [{ id: 'E-test', lods: [{ label: '+动画', file: 'new.glb' }] }] });
  rejectOld(new Error('old path disappeared')); expect(await old).toBe(false); expect(library.size).toBe(0);
  await library.preload('E-test'); expect(calls).toBe(2);
});

/** 指定 pose 数的可控 palette（duration=(n-1)/24 → 帧=n-1，+bind=n） */
function makePalette(name: string, poseCount: number): BakedPalette {
  const dur = (poseCount - 1) / 24;
  const clip: AnimClip = {
    name,
    duration: dur,
    tracks: [{
      node: 0,
      path: 'translation',
      times: new Float32Array([0, dur]),
      values: new Float32Array([0, 1, 0, 1, 1, 0]),
      stride: 3,
      interpolation: 'LINEAR',
    }],
  };
  return bakePosePalette(makeSkeleton(), [clip], { fps: 24 });
}

/**
 * 装配数学的第三道防线（M3 WU-1，复审 C5）。
 *
 * ActorLibrary.preload/buildPalette 的 base 分配与拼接已纯函数化
 *（assemblePalettes），本文件用**手搓骨架**（不依赖真 GLB）断言双角色装配的
 * 三条不变量：
 *   ① base 按注册序以 **pose 单位** 累加（不是 float 单位，不同 jointCount 也能对上）
 *   ② 拼接顺序 = 注册序，块内逐 float 与各自 palette 一致
 *   ③ restPose 是角色 palette 的**局部**下标，base + rest 才是全局 —— 全局指向
 *      该角色块的末帧 bind（PR #18 抓的 P1：局部当全局用 → 负数 → u32 巨数 →
 *      shader 越界读全零矩阵，模型闪塌）
 *
 * 夹具模式抄 packages/render/test/pose-palette.test.ts（同源、不重复造轮子）。
 */

// ---------------------------------------------------------------- 夹具

/** 两关节手搓骨架（jointCount = 3，含末尾恒等关节）——与 gltf.ts 的 SkeletonData 对齐 */
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

/** 1 秒 walk：Hips 沿 X 平移 0→1（24 fps 下 24 帧） */
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

/**
 * 双角色夹具：A = 单 clip（25 pose）；B = 双 clip（49 pose）。同一骨架
 *（jointCount 一致是生产不变量：ActorLibrary.preload 强制全部角色
 * == PALETTE_JOINT_COUNT，shader 用单一编译期常量索引全局 pose —— 异构
 * jointCount 下全局下标无定义，装配期就被拒）。「按 float 累加」的错实现
 * 会把 B 的 base 算成 1200 而不是 25，在下面的不变量上炸。
 */
function dualCharacters() {
  const sk = makeSkeleton();
  const palA = bakePosePalette(sk, [makeWalkClip()]);
  const palB = bakePosePalette(sk, [makeWalkClip(), makeRunClip()]);
  return { palA, palB };
}

// ---------------------------------------------------------------- 断言工具

/** 拼接后总调色板里 pose p 关节 j 的矩阵（列主 16 float） */
function matAt(data: Float32Array, jointCount: number, pose: number, joint: number): Float32Array {
  const o = (pose * jointCount + joint) * 16;
  return data.subarray(o, o + 16);
}

function isIdentity(m: Float32Array, eps = 1e-5): boolean {
  const expect = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let i = 0; i < 16; i++) {
    if (Math.abs(m[i]! - expect[i]!) > eps) return false;
  }
  return true;
}

/** 逐 float 精确相等（拼接是 data.set 搬运，不允许任何重排/舍入） */
function expectSameFloats(got: Float32Array, want: Float32Array): void {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(got[i]).toBe(want[i]);
  }
}

// ---------------------------------------------------------------- 测试

describe('assemblePalettes · ① base 按注册序以 pose 单位累加', () => {
  it('第二个角色的 base = 第一个角色的 pose 总数（含 bind 帧）', () => {
    const { palA, palB } = dualCharacters();
    // 夹具自检：A = 24 walk 帧 + 1 bind = 25 pose；B = 24 + 24 + 1 = 49 pose
    expect(palettePoseCount(palA)).toBe(25);
    expect(palettePoseCount(palB)).toBe(49);
    expect(palA.jointCount).toBe(3);
    expect(palB.jointCount).toBe(3); // 同骨架：jointCount 一致是全局索引的前提（preload 强制）

    const asm = assemblePalettes([palA, palB]);
    expect(asm.bases).toEqual([0, 25]);
  });

  it('pose 计数 = data.length / 16 / jointCount（末尾 bind 帧计入）', () => {
    const { palA, palB } = dualCharacters();
    expect(palA.data.length).toBe(25 * 3 * 16);
    expect(palB.data.length).toBe(49 * 3 * 16);
    // 若按 float 累加，base 会是 1200 —— 断言锁死 pose 语义
    expect(assemblePalettes([palA, palB]).bases[1]).not.toBe(palA.data.length);
  });
});

describe('assemblePalettes · ② 拼接顺序 = 注册序', () => {
  it('总长 = 各块之和；前段逐 float = A，后段逐 float = B', () => {
    const { palA, palB } = dualCharacters();
    const asm = assemblePalettes([palA, palB]);
    const data = asm.data!;
    expect(data).not.toBeNull();
    expect(data.length).toBe(palA.data.length + palB.data.length);
    expectSameFloats(data.subarray(0, palA.data.length), palA.data);
    expectSameFloats(data.subarray(palA.data.length), palB.data);
  });
});

describe('assemblePalettes · ③ restPose 局部性 + 全局 bind 指向本角色块末帧', () => {
  it('bindPoseIndex 是角色 palette 局部下标 = 本角色 pose 总数 - 1', () => {
    const { palA, palB } = dualCharacters();
    expect(bindPoseIndex(palA)).toBe(24); // 25 - 1
    expect(bindPoseIndex(palB)).toBe(48); // 49 - 1
  });

  it('base + rest 的全局下标指向该角色块的最后一 pose，矩阵为单位阵（真 bind）', () => {
    const { palA, palB } = dualCharacters();
    const asm = assemblePalettes([palA, palB]);
    const data = asm.data!;
    const [baseA, baseB] = [asm.bases[0]!, asm.bases[1]!];

    // A 的全局 bind：0 + 24 = 24（A 块末帧）
    const bindA = baseA + bindPoseIndex(palA);
    expect(bindA).toBe(24);
    // B 的全局 bind：25 + 48 = 73 = 总 pose 数 - 1（总块的最末 pose 恰是 B 的 bind）
    const bindB = baseB + bindPoseIndex(palB);
    expect(bindB).toBe(palettePoseCount(palA) + palettePoseCount(palB) - 1);
    // 两处都是单位阵，且逐 float 等于各自 palette 的末帧
    expect(isIdentity(matAt(data, palA.jointCount, bindA, 0))).toBe(true);
    expect(isIdentity(matAt(data, palB.jointCount, bindB, 0))).toBe(true);
    expectSameFloats(
      matAt(data, palB.jointCount, bindB, 0),
      matAt(palB.data, palB.jointCount, bindPoseIndex(palB), 0),
    );
  });

  it('🔴 负向防线（PR #18 P1）：把局部 rest 当全局用会落到别的角色的动画帧上', () => {
    const { palA, palB } = dualCharacters();
    const asm = assemblePalettes([palA, palB]);
    const data = asm.data!;
    const restB = bindPoseIndex(palB); // 48 —— 若被误当全局下标用
    // 全局 48 = B 块内局部 23 = B 的 walk 第 23 帧（root 已沿 X 移动 ≈0.958m），
    // 不是单位阵 —— 一旦「局部当全局」，B 的静止姿态会变成走路中间帧
    expect(isIdentity(matAt(data, palB.jointCount, restB, 0))).toBe(false);
    // 而 base_B + rest_B 才是真正的静止姿态
    expect(isIdentity(matAt(data, palB.jointCount, asm.bases[1]! + restB, 0))).toBe(true);
  });
});

describe('assemblePalettes · 边界', () => {
  it('空列表 → bases 空、data null（与 buildPalette 的空语义一致）', () => {
    const asm = assemblePalettes([]);
    expect(asm.bases).toEqual([]);
    expect(asm.data).toBeNull();
  });

  it('单角色 → base 0，data 与该角色 palette 逐 float 一致', () => {
    const { palA } = dualCharacters();
    const asm = assemblePalettes([palA]);
    expect(asm.bases).toEqual([0]);
    expectSameFloats(asm.data!, palA.data);
  });
});

// ---------------------------------------------------------------------------
// rankOrderEntries · manifest 规范序（PR #19 review FR-B 的数学防线）
//
// 场景：E-02 瞬时失败 → E-03 先注册（注册序 [E-01, E-03]）→ resetFailures 后
// E-02 重试成功（注册序 [E-01, E-03, E-02]）。paletteBase 布局必须仍按 manifest
// rank（E-01 < E-02 < E-03），与注册历史无关 —— assemblePalettes 吃排序后的
// 输入，base 与拼接同序，布局稳定。
// ---------------------------------------------------------------------------

describe('rankOrderEntries · 注册历史不污染 manifest 规范序', () => {
  const rank = new Map([
    ['E-01', 0],
    ['E-02', 1],
    ['E-03', 2],
  ]);
  const ids = (xs: string[]) => xs.map((characterId) => ({ characterId }));

  it('乱序注册（重试场景）→ 输出按 rank 升序', () => {
    // E-02 迟到注册在末尾 —— 规范序仍把它放回中间
    const out = rankOrderEntries(ids(['E-01', 'E-03', 'E-02']), rank);
    expect(out.map((e) => e.characterId)).toEqual(['E-01', 'E-02', 'E-03']);
  });

  it('rank 缺失的条目排末尾且按 id 字典序稳定（manifest 改名防御）', () => {
    const out = rankOrderEntries(ids(['Z-09', 'E-03', 'A-00', 'E-01']), rank);
    expect(out.map((e) => e.characterId)).toEqual(['E-01', 'E-03', 'A-00', 'Z-09']);
  });

  it('端到端：乱序注册的装配布局 == 规范序注册的装配布局（base 逐位一致）', () => {
    const p1 = makePalette('a', 3); // 3 pose + bind
    const p2 = makePalette('b', 5);
    const p3 = makePalette('c', 4);
    // 注册序 [b, c, a]（重试历史）vs 规范序 [a, b, c]：bases 必须一致
    const messy = rankOrderEntries(
      [
        { characterId: 'E-02', palette: p2 },
        { characterId: 'E-03', palette: p3 },
        { characterId: 'E-01', palette: p1 },
      ],
      rank,
    );
    const clean = rankOrderEntries(
      [
        { characterId: 'E-01', palette: p1 },
        { characterId: 'E-02', palette: p2 },
        { characterId: 'E-03', palette: p3 },
      ],
      rank,
    );
    const messyAsm = assemblePalettes(messy.map((e) => e.palette));
    const cleanAsm = assemblePalettes(clean.map((e) => e.palette));
    expect([...messyAsm.bases]).toEqual([...cleanAsm.bases]);
    expect(messyAsm.data).toEqual(cleanAsm.data);
    // 规范序里 E-02 的 base 落在 E-03 之前 —— 按注册序拼接会得到相反布局
    expect(messy.map((e) => e.characterId)).toEqual(['E-01', 'E-02', 'E-03']);
    expect(messyAsm.bases[1]!).toBeLessThan(messyAsm.bases[2]!);
  });
});
