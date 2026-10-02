/**
 * 烘焙姿态调色板（docs/20 §2，M1：纯 CPU，无 GPU 依赖）。
 *
 * ## 为什么存在
 *
 * 500 只僵尸每帧各跑一次 `evalJointMatrices`（每次 ~27 次矩阵乘）在 mobile 上
 * 必然掉帧。而动画是**确定性循环片段** → 姿态矩阵可以在加载时一次性烘焙，
 * 运行期零 CPU 重算：
 *
 * ```
 * 每个 clip 按 24 fps 采样 → evalJointMatrices → 拼成 palette
 * palette: Float32Array[ poseCount × jointCount × 16 ]
 * 实例只带 poseIndex（tick 推出），shader 直接索引
 * ```
 *
 * 成本（docs/20 实测口径）：8 角色 × 2~3 clip × 24 帧 ≈ 400~600 次求值，毫秒级；
 * 显存 ≈ 810 KB（mobile 降 16 帧 / 1~2 clip → ~180 KB）。
 *
 * ## M1 边界（诚实声明）
 *
 * 本文件只做「烘焙 + 查询」的纯 CPU 部分。storage buffer 上传（binding 4）、
 * 实例 16 float、shader 蒙皮是 M2 —— 那是 GPU 侧，node 测不了，靠浏览器验收。
 */

import type { SkeletonData, AnimClip } from '@aether/scene';
import { createSkinState, evalJointMatrices } from './skin';

/** 默认采样率（docs/20 定稿：24 fps，最近帧取样不插值） */
export const PALETTE_SAMPLE_FPS = 24;

export interface BakedPalette {
  /** 关节数 = skeleton.joints.length + 1（末尾恒等关节，与 skin.ts 求值输出一致） */
  jointCount: number;
  /** 每个 clip 的帧数与时长 */
  clips: { name: string; frameCount: number; durationSec: number }[];
  /**
   * 姿态矩阵序列，**列主**展开（evalJointMatrices 的输出主序，WGSL mat4x4f
   * 内存布局恰为列主，shader 可直接索引）：pose p 的关节 j 在
   * `(p * jointCount + j) * 16`。总长 = ΣframeCount × jointCount × 16。
   */
  data: Float32Array;
  /** pose p 的起始下标（按 clip 顺序拼接）：frames[i] = clip i 的第 0 帧 */
  clipBasePose: number[];
}

export interface BakeOptions {
  /** 采样率（默认 24）。mobile 档可降 16（docs/20 M4） */
  fps?: number;
  /** 只烘这些 clip（默认全部） */
  clipNames?: string[];
}

/**
 * 烘焙一个角色的全部（或指定）动画片段。
 *
 * 复用 `createSkinState` + `evalJointMatrices`——与静态通道（scene.wgsl
 * binding 7）走**同一条求值路径**，保证调色板姿态与单角色静态渲染完全一致；
 * 这也是 docs/20 否决 VAT 的理由之一：复用现成求值，不另写一套采样。
 */
export function bakePosePalette(
  skeleton: SkeletonData,
  clips: AnimClip[],
  opts: BakeOptions = {},
): BakedPalette {
  const fps = opts.fps ?? PALETTE_SAMPLE_FPS;
  const wanted =
    opts.clipNames === undefined
      ? clips
      : clips.filter((c) => opts.clipNames!.includes(c.name));
  if (wanted.length === 0) {
    throw new Error('[pose-palette] 没有可烘焙的动画片段（clipNames 过滤后为空？）');
  }

  const jointCount = skeleton.joints.length + 1; // 末尾恒等关节（skin.ts 约定）
  const scratch = new Float32Array(jointCount * 16);

  const clipFrames: number[] = [];
  const clipBasePose: number[] = [];
  const perClip: { name: string; frameCount: number; durationSec: number }[] = [];
  let totalPoses = 0;
  for (const c of wanted) {
    // 帧数 = ceil(duration × fps)，至少 1：时长 0 的退化 clip 也要有一帧（bind 邻近态）
    const frames = Math.max(1, Math.ceil(c.duration * fps));
    clipFrames.push(frames);
    clipBasePose.push(totalPoses);
    perClip.push({ name: c.name, frameCount: frames, durationSec: c.duration });
    totalPoses += frames;
  }

  const data = new Float32Array((totalPoses + 1) * jointCount * 16); // +1 = 末尾 bind pose

  for (let ci = 0; ci < wanted.length; ci++) {
    const clip = wanted[ci]!;
    const frames = clipFrames[ci]!;
    const base = clipBasePose[ci]!;
    const state = createSkinState(skeleton, [clip]);

    for (let f = 0; f < frames; f++) {
      // 最近帧语义：第 f 帧对应时间 f / fps（末帧落在 duration 附近，
      // evalJointMatrices 内部按 clip 时长处理越界）
      state.time = f / fps;
      evalJointMatrices(state, scratch);
      data.set(scratch, (base + f) * jointCount * 16);
    }
  }

  // 末尾追加一帧 bind pose（time=0、未选 clip）：新生成实体 / phase 未定时的
  // 静止姿态。createSkinState 默认 clip=0 time=0 —— 需要真正的 bind 态：
  // selectClip(-1) 是「停在 bind pose」的既有语义（skin.ts:25）。
  {
    const st = createSkinState(skeleton, wanted);
    st.clip = -1; // bind pose（不播）
    st.time = 0;
    evalJointMatrices(st, scratch);
    data.set(scratch, totalPoses * jointCount * 16);
  }

  return { jointCount, clips: perClip, data, clipBasePose };
}

/**
 * 按「动画相位」取姿态下标（运行期每实例只需这个，纯查表）。
 *
 * @param phase 0..1 循环相位（由 tick 与动画速度推出）
 * @param clipIndex palette.clips 的下标
 * @returns 全局 pose 下标（可直接给 shader 索引）
 */
export function poseIndexAt(palette: BakedPalette, clipIndex: number, phase: number): number {
  const c = palette.clips[clipIndex];
  if (c === undefined) {
    throw new Error(`[pose-palette] clip 下标 ${clipIndex} 越界（共 ${palette.clips.length}）`);
  }
  const p = phase < 0 ? 0 : phase > 1 ? 1 : phase;
  // 相位 → 帧号（最近帧取整，不插值 —— docs/20 §4 决策）
  const frame = Math.min(c.frameCount - 1, Math.floor(p * c.frameCount));
  return palette.clipBasePose[clipIndex]! + frame;
}

/**
 * bind pose 的全局 pose 下标（特殊值：新生成实体 / 未播放时的静止姿态）。
 * bake 时在 palette 末尾追加一帧 bind（skin.ts 的 clip=-1 语义），
 * flags.bit0=1 但 phase 未定的实例指向它。
 */
export function bindPoseIndex(palette: BakedPalette): number {
  return palette.data.length / 16 / palette.jointCount - 1;
}
