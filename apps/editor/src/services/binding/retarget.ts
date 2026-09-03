/**
 * retarget.ts — 通用动画重定向（任意 BVH 骨架 → HumanIK 22 骨干净 T-pose 骨架）。
 *
 * # 这个文件存在的理由
 *
 * 用户原话：
 * > 「因为只有干净的 T pose 才能正确接入其他所有 mo capture 动画，否则，
 * >   如果你在当前的 pose 上面直接去做 joint bind，那么所有导入的动画都会有
 * >   offset，就会有偏移」
 *
 * 「有 offset」的机理是这样的：glTF 动画轨道存的是**绝对本地旋转**（见
 * `packages/render/src/skin.ts` 的 `sampleLocals`：轨道值直接覆盖 bind locals），
 * 而 mocap 的每一个旋转都是**相对它自己骨架的 rest pose** 而言的。源骨架的 rest
 * 是 A-pose、目标骨架的 rest 是 T-pose 时，直接拷贝旋转等于把「从 A-pose 起算的
 * 45°」当成「从 T-pose 起算的 45°」，整条手臂系统性偏 45°。
 *
 * 绑定面板（`binding-panel.ts`）保证了目标骨架 rest 旋转恒为 identity —— 这一节
 * 把它兑现成数值：rest 骨向可以直接从 `tposeDirections()` 读出，不需要再乘任何
 * rest 旋转。
 *
 * # 核心公式
 *
 * 记：
 *  - `d_src_i` = 源骨架里骨 i 的 rest **骨向**（i → 第一个子骨 的单位向量）
 *  - `d_tgt_i` = 目标（HumanIK T-pose）里骨 i 的 rest 骨向
 *  - `A_i`     = `quatFromUnitVectors(d_src_i, d_tgt_i)`，即把源骨向旋到目标骨向的
 *                最小旋转（roll 自由，取最小弧 —— 业界标准取法）
 *  - `R_i(f)`  = 第 f 帧源骨 i 的本地旋转
 *
 * 则重定向后的目标本地旋转：
 *
 * ```
 *     R'_i(f) = A_parent(i) · R_i(f) · A_i⁻¹
 * ```
 *
 * ## 推导
 *
 * 目标：**骨 i 的世界朝向在源和目标里一致**。由于 BVH 的 rest 是纯平移链
 * （rest 无旋转），骨 i 的世界朝向 = 累积旋转 `Q_world_i(f)`，而骨 i 的**世界骨向**
 * = `Q_world_i(f) · d_i`。于是要求：
 *
 * ```
 *     Q_tgt_i(f) · d_tgt_i  =  Q_src_i(f) · d_src_i
 * ```
 *
 * 满足它的最小旋转解是 `Q_tgt_i(f) = Q_src_i(f) · A_i⁻¹`（因为 `A_i⁻¹ d_tgt_i = d_src_i`）。
 * 转成本地旋转（BVH 里 `Q_src_i = Q_src_parent · R_i`）：
 *
 * ```
 *     R'_i = Q_tgt_p⁻¹ · Q_tgt_i
 *          = (Q_src_p · A_p⁻¹)⁻¹ · (Q_src_i · A_i⁻¹)
 *          = A_p · Q_src_p⁻¹ · Q_src_i · A_i⁻¹
 *          = A_p · R_i · A_i⁻¹                ∎
 * ```
 *
 * ## 两个必须成立的退化情形（测试里都锁死了）
 *
 *  1. **源 = T-pose**：所有 `A_i = I` ⟹ `R'_i = R_i`，退化为直接拷贝。
 *     这与 Python 侧 `retarget_bvh.py` 的现有行为**逐位一致** —— 那条路径被
 *     Mixamo 素材验证过，新实现不能把它改坏。
 *  2. **源 = A-pose（手臂下垂 45°）**：`A_shoulder = A_arm = A_forearm = rotZ(45°)`。
 *     零旋转帧 ⟹ `R'_shoulder = A_spine2 · I · A_shoulder⁻¹ = rotZ(−45°)`，
 *     `R'_arm = A_shoulder · I · A_arm⁻¹ = I`。合起来目标手臂斜向下 45° ——
 *     **正好复现源的 A-pose**，而不是停在 T-pose。
 *
 * ## 叶子骨（Head / Hand / ToeBase）
 *
 * 没有子骨 ⟹ 没有自己的骨向 ⟹ `A_i` 继承父骨的 `A`。直觉：手腕该跟着前臂一起
 * 被摆正；且「绕小臂轴的扭转」在共轭后自动变成绕目标小臂轴的扭转。
 *
 * # 缩放
 *
 * 根骨位移按「腿长比」缩放，不做单位猜测：
 * `scale = 目标腿长 / 源腿长`，两个腿长用同一套测法，cm→m 的换算天然被比值吸收。
 */

import {
  HUMANIK_BONES,
  HUMANIK_ORDER,
  tposeDirections,
  tposeWorldPositions,
  type Vec3,
} from './humanik-template';
import {
  quatFromUnitVectors,
  quatMul,
  quatToMat,
  type JointPositions,
  type Quat,
} from './binding-math';
import {
  bvhRestDirections,
  firstHumanikChild,
  mapBvhJointsToHumanik,
  restWorldPositions,
  type BvhFile,
  type BvhJoint,
} from './bvh-parser';
import type { AnimClip, AnimTrack, NodeLocal, SkeletonData } from '@aether/scene';
import * as m4 from '@aether/core';

const DEG = Math.PI / 180;

// ─────────────────────────── 输出契约 ───────────────────────────

/** 一段重定向后的动画：以 **骨名** 为键，与 glTF 节点索引解耦 */
export interface RetargetClip {
  name: string;
  /** 关键帧时间（秒），升序 */
  times: Float32Array;
  /** 骨名 → (frames × 4) 四元数（xyzw） */
  rotations: Record<string, Float32Array>;
  /** Hips 的 (frames × 3) 平移；源没有根位置通道时为 null */
  translation: Float32Array | null;
}

export interface RetargetOptions {
  /** 片段名，默认取源文件名或 'retargeted' */
  clipName?: string;
  /**
   * 目标骨架的 T-pose 关节世界位置。来自绑定面板 `fit.tposePositions`；
   * 不传则回落到 HumanIK 模板（身高 2.05 m 的等比骨架）。
   */
  targetPositions?: JointPositions;
  /** 强制当作某 up 轴处理；默认用解析器检测结果 */
  forceUpAxis?: 0 | 1 | 2;
}

export interface RetargetReport {
  clipName: string;
  frameCount: number;
  fps: number;
  duration: number;
  /** 源 up 轴 */
  srcUpAxis: 'X' | 'Y' | 'Z';
  /** 源 rest 骨架高度（源单位） */
  srcHeight: number;
  /** 源 rest 骨架高度（换算成米后），用于一眼看出单位是不是 cm */
  srcHeightMeters: number;
  /** 目标腿长 / 源腿长；根位移与步幅都按它缩放 */
  skeletonScale: number;
  /** 成功配对的 [BVH 关节名, HumanIK 骨名] */
  mapped: Array<[string, string]>;
  /** 没对上号的 BVH 关节 */
  unmatchedBvh: string[];
  /** 没有任何源数据喂到的 HumanIK 骨（保持静止） */
  missingBones: string[];
  /** 每根骨的对齐角 |A_i|（度）。0 = 源与目标的 rest 朝向一致 */
  alignAnglesDeg: Record<string, number>;
  /** 最大对齐角；T-pose 源应为 0（浮点误差内） */
  maxAlignAngleDeg: number;
  /** 源是否带根位置通道（决定有没有 translation 轨道） */
  hasRootTranslation: boolean;
  /** 非 Y-up 源会在此留下提示（已自动做轴重映射，但前向轴可能差 180°） */
  warnings: string[];
}

export interface RetargetResult {
  clip: RetargetClip;
  report: RetargetReport;
}

// ─────────────────────────── 主入口 ───────────────────────────

/**
 * 把任意 BVH 重定向到 HumanIK 22 骨骨架。
 *
 * 抛错场景（全部显式抛，不静默降级）：源里一根 HumanIK 骨都没对上号。
 * 其余「部分对上」的情况不抛 —— 没对上的骨保持静止，信息全在 report 里，
 * 由调用方决定是弹警告还是拒绝导入。
 */
export function retargetBvh(bvh: BvhFile, options: RetargetOptions = {}): RetargetResult {
  const { mapping, unmatched, missingBones } = mapBvhJointsToHumanik(
    bvh.order,
    HUMANIK_ORDER,
  );
  if (Object.keys(mapping).length === 0) {
    throw new Error(
      `BVH 里没有任何关节能对上 HumanIK 22 骨（共 ${bvh.order.length} 个关节：` +
        `${bvh.order.slice(0, 6).join(', ')}…）。请确认这是人形骨架的 BVH。`,
    );
  }

  const warnings: string[] = [];
  const upAxis = options.forceUpAxis ?? bvh.upAxis;
  const qUp = upAxisToQuat(upAxis, warnings);

  // ── 1. 源 rest 骨向（已重映射到 Y-up） ──
  const srcRaw = bvhRestDirections(bvh, mapping, HUMANIK_ORDER, HUMANIK_BONES);
  const srcDirs: Record<string, Vec3> = {};
  for (const b of HUMANIK_ORDER) {
    const d = srcRaw[b];
    srcDirs[b] = d === undefined ? [0, 0, 0] : rotateVec(qUp, d);
  }

  // ── 2. 目标 rest 骨向：骨 i 的朝向 = 其第一个子骨的 tposeOffset 方向 ──
  //    与绑定面板 boneSegments()「骨段 = head → 第一个子骨 head」同一套定义。
  const tDirs = tposeDirections();
  const tgtDirs: Record<string, Vec3> = {};
  for (const b of HUMANIK_ORDER) {
    const c = firstHumanikChild(b, HUMANIK_BONES, HUMANIK_ORDER);
    tgtDirs[b] = c === null ? [0, 0, 0] : tDirs[c]!;
  }

  // ── 3. 逐骨对齐四元数 A_i（HUMANIK_ORDER 保证父先于子） ──
  const align: Record<string, Quat> = {};
  const alignAnglesDeg: Record<string, number> = {};
  let maxAlignAngleDeg = 0;
  for (const b of HUMANIK_ORDER) {
    const s = srcDirs[b]!;
    const t = tgtDirs[b]!;
    const sOk = Math.hypot(s[0], s[1], s[2]) > 1e-9;
    const tOk = Math.hypot(t[0], t[1], t[2]) > 1e-9;
    let q: Quat;
    if (sOk && tOk) {
      q = quatFromUnitVectors(s, t);
    } else {
      // 缺任一侧的骨向 → 继承父骨（叶子骨的常规路径；根骨退化成单位四元数）
      const p = HUMANIK_BONES[b]!.parent;
      q = p === null ? [0, 0, 0, 1] : (align[p] ?? [0, 0, 0, 1]);
    }
    align[b] = q;
    const deg = 2 * Math.acos(Math.min(1, Math.abs(q[3]))) * (180 / Math.PI);
    alignAnglesDeg[b] = deg;
    if (deg > maxAlignAngleDeg) maxAlignAngleDeg = deg;
  }

  // ── 4. 缩放：腿长比（同时把 cm→m 吸收掉） ──
  const tgtPos = options.targetPositions ?? tposeWorldPositions();
  const srcRest = restWorldPositions(bvh.joints, bvh.order);
  const hipsJoint = jointForBone(mapping, 'Hips');
  const skeletonScale = computeSkeletonScale(bvh, srcRest, hipsJoint, tgtPos, qUp, warnings);

  // ── 5. 逐帧重定向 ──
  const n = bvh.frameCount;
  const times = new Float32Array(n);
  const rotations: Record<string, Float32Array> = {};
  const animBones: string[] = [];
  // 只对「BVH 里带旋转通道」的骨建轨道
  for (const b of HUMANIK_ORDER) {
    const jn = jointForBone(mapping, b);
    if (jn === null) continue;
    const j = bvh.joints[jn]!;
    if (j.rotColumn < 0 || j.rotChannels.length === 0) continue;
    rotations[b] = new Float32Array(n * 4);
    animBones.push(b);
  }

  const euler: [number, number, number] = [0, 0, 0];
  for (let f = 0; f < n; f++) {
    times[f] = f * bvh.frameTime;
    for (const b of animBones) {
      const jn = jointForBone(mapping, b)!;
      const j = bvh.joints[jn]!;
      readEuler(bvh, j, f, euler);
      const qSrc = conjugate(qUp, eulerToQuatZYX(j, euler));
      const parent = HUMANIK_BONES[b]!.parent;
      const aP = parent === null ? ([0, 0, 0, 1] as Quat) : align[parent]!;
      const aI = conj(align[b]!);
      const q = quatMul(quatMul(aP, qSrc), aI);
      const out = rotations[b]!;
      out[f * 4] = q[0];
      out[f * 4 + 1] = q[1];
      out[f * 4 + 2] = q[2];
      out[f * 4 + 3] = q[3];
    }
  }

  // ── 6. 根位移 ──
  let translation: Float32Array | null = null;
  let hasRootTranslation = false;
  if (hipsJoint !== null && bvh.joints[hipsJoint]!.posColumn >= 0) {
    const j = bvh.joints[hipsJoint]!;
    const rest = rotateVec(qUp, j.offset);
    const tgtHips = tgtPos.Hips ?? [0, 1, 0];
    translation = new Float32Array(n * 3);
    const p: [number, number, number] = [0, 0, 0];
    for (let f = 0; f < n; f++) {
      readPosition(bvh, j, f, p);
      const w = rotateVec(qUp, p);
      translation[f * 3] = tgtHips[0] + (w[0] - rest[0]) * skeletonScale;
      translation[f * 3 + 1] = tgtHips[1] + (w[1] - rest[1]) * skeletonScale;
      translation[f * 3 + 2] = tgtHips[2] + (w[2] - rest[2]) * skeletonScale;
    }
    hasRootTranslation = true;
  }

  const clipName = options.clipName ?? 'retargeted';
  return {
    clip: { name: clipName, times, rotations, translation },
    report: {
      clipName,
      frameCount: n,
      fps: bvh.fps,
      duration: (n - 1) * bvh.frameTime,
      srcUpAxis: (['X', 'Y', 'Z'] as const)[upAxis],
      srcHeight: bvh.skeletonHeight,
      srcHeightMeters: bvh.skeletonHeight * (bvh.unitScale || 1),
      skeletonScale,
      mapped: Object.entries(mapping) as Array<[string, string]>,
      unmatchedBvh: unmatched,
      missingBones,
      alignAnglesDeg,
      maxAlignAngleDeg,
      hasRootTranslation,
      warnings,
    },
  };
}

// ─────────────────────── 接到引擎骨架 ───────────────────────

/**
 * 把 RetargetClip（**骨名**为键）翻译成引擎吃的 AnimClip（**节点索引**为键）。
 *
 * 关键陷阱：`AnimTrack.node` 是 **glTF nodes 数组下标**，不是 `skin.joints` 的下标。
 * `SkeletonData.joints[k]` 才是节点下标、`jointNames[k]` 是它的名字。这里按名字建
 * 映射，因此对「骨骼节点顺序不同」的外部 GLB（rig_character.py 产物、Mixamo 导出）
 * 同样成立 —— 这正是「通用」二字的落点。
 *
 * @returns null = 一根骨都没对上（骨架命名完全不匹配），调用方应提示而不是静默播放
 */
export function clipToAnimClip(clip: RetargetClip, sk: SkeletonData): AnimClip | null {
  const nodeOf: Record<string, number> = {};
  for (let k = 0; k < sk.joints.length; k++) {
    const nm = sk.jointNames[k];
    if (nm !== null && nm !== undefined) nodeOf[nm] = sk.joints[k]!;
  }

  const tracks: AnimTrack[] = [];
  for (const bone of Object.keys(clip.rotations)) {
    const node = nodeOf[bone];
    const q = clip.rotations[bone]!;
    if (node === undefined || q.length !== clip.times.length * 4) continue;
    tracks.push({
      node,
      path: 'rotation',
      times: clip.times,
      values: q,
      stride: 4,
      interpolation: 'LINEAR',
    });
  }
  const hips = clip.translation;
  if (hips !== null && hips.length === clip.times.length * 3) {
    const node = nodeOf.Hips;
    if (node !== undefined) {
      tracks.push({
        node,
        path: 'translation',
        times: clip.times,
        values: hips,
        stride: 3,
        interpolation: 'LINEAR',
      });
    }
  }

  if (tracks.length === 0) return null;
  const duration = clip.times.length > 0 ? clip.times[clip.times.length - 1]! : 0;
  return { name: clip.name, duration, tracks };
}

/**
 * 从任意 glTF 骨架读出 rest 世界坐标（按 HumanIK 骨名索引）。
 *
 * 用途：把 BVH 重定向到一个**已经存在的外部 GLB 骨架**时，用它当 `targetPositions`，
 * 让根位移的缩放按目标骨架的真实腿长算 —— 模板身高 1.7 m 套到 E-04（2.05 m）上
 * 会让根位移整体偏小 17%，走路会「滑步」。
 *
 * 名字不在 HumanIK 22 骨里的关节直接跳过；一根都没对上返回 null，调用方退回模板
 * （对齐角 A_i 只依赖**方向**，不依赖这份坐标，所以退回模板不会让姿势错，
 * 只会让根位移缩放不精确）。
 */
export function skeletonRestWorldPositions(sk: SkeletonData): JointPositions | null {
  const out: JointPositions = {};
  let hit = 0;
  for (let k = 0; k < sk.joints.length; k++) {
    const nm = sk.jointNames[k];
    if (nm === null || nm === undefined) continue;
    if (!(nm in HUMANIK_BONES)) continue;
    const p = restWorldOfNode(sk, sk.joints[k]!);
    if (p === null) continue;
    out[nm] = p;
    hit++;
  }
  return hit === 0 ? null : out;
}

/**
 * 节点 origin 的 rest 世界坐标 = 沿父链累乘本地 TRS 后取第 4 列。
 *
 * 索引陷阱：`parent` / `locals` 都是**按 glTF 节点下标**索引，不是 `joints` 的下标
 * （见 gltf.ts 的注释）。传进来的 node 必须来自 `sk.joints[k]`。
 */
function restWorldOfNode(sk: SkeletonData, node: number): [number, number, number] | null {
  if (node < 0 || node >= sk.parent.length) return null;

  // 自底向上收链（结果根在前），再自顶向下累乘。带环检测，坏数据不静默死循环。
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur = node;
  while (cur >= 0) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    chain.push(cur);
    const p = sk.parent[cur];
    if (p === undefined || p < 0) break;
    cur = p;
  }

  let acc = m4.mat4();
  let next = m4.mat4();
  const tmp = m4.mat4();
  for (let i = chain.length - 1; i >= 0; i--) {
    const loc = sk.locals[chain[i]!];
    if (loc === undefined) return null;
    localTrs(tmp, loc);
    m4.multiply(next, acc, tmp);
    const swap = acc;
    acc = next;
    next = swap;
  }
  return [acc[12]!, acc[13]!, acc[14]!];
}

/** 本地 TRS → 列主序 mat4（就地写，复用调用方的缓冲） */
function localTrs(out: m4.Mat4, loc: NodeLocal): void {
  const r = quatToMat(loc.r);
  for (let c = 0; c < 3; c++) {
    const s = loc.s[c] ?? 1;
    out[c * 4] = (r[c * 4] ?? 0) * s;
    out[c * 4 + 1] = (r[c * 4 + 1] ?? 0) * s;
    out[c * 4 + 2] = (r[c * 4 + 2] ?? 0) * s;
    out[c * 4 + 3] = 0;
  }
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[12] = loc.t[0];
  out[13] = loc.t[1];
  out[14] = loc.t[2];
  out[15] = 1;
}

/** 一行日志摘要（编辑器 console / 冒烟断言都用它） */
export function retargetSummary(r: RetargetReport): string {
  const parts = [
    `clip=${r.clipName}`,
    `frames=${r.frameCount}`,
    `fps=${r.fps.toFixed(2)}`,
    `dur=${r.duration.toFixed(2)}s`,
    `mapped=${r.mapped.length}/${r.mapped.length + r.unmatchedBvh.length}`,
    `scale=${r.skeletonScale.toFixed(4)}`,
    `maxAlign=${r.maxAlignAngleDeg.toFixed(3)}°`,
    `up=${r.srcUpAxis}`,
    `root=${r.hasRootTranslation ? 'yes' : 'no'}`,
  ];
  if (r.missingBones.length > 0) parts.push(`missing=${r.missingBones.join('|')}`);
  if (r.warnings.length > 0) parts.push(`warn=${r.warnings.join('; ')}`);
  return parts.join('  ');
}

// ─────────────────────────── 内部工具 ───────────────────────────

function jointForBone(mapping: Record<string, string>, bone: string): string | null {
  for (const [jn, b] of Object.entries(mapping)) {
    if (b === bone) return jn;
  }
  return null;
}

/**
 * up 轴 → Y-up 的重映射四元数。
 *
 * Z-up 源：绕 X 轴 −90°（det = +1，不镜像）。副作用是源的前向 +Y 会落到 −Z，
 * 角色可能背对镜头 —— 这只是整体朝向，用一个 180° 的根节点偏航即可，
 * 不影响任何骨骼相对关系，所以放在 warnings 里提示而不是硬掰。
 * X-up 源：极罕见，这里不做重映射，只提示。
 */
function upAxisToQuat(axis: 0 | 1 | 2, warnings: string[]): Quat {
  if (axis === 1) return [0, 0, 0, 1];
  if (axis === 2) {
    warnings.push('源是 Z-up，已自动重映射到 Y-up；前向轴可能差 180°');
    const h = -45 * DEG;
    return [Math.sin(h), 0, 0, Math.cos(h)];
  }
  warnings.push('源是 X-up，未做轴重映射（极罕见，结果可能不可用）');
  return [0, 0, 0, 1];
}

/** 四元数共轭（= 单位四元数的逆） */
function conj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** a · b · a⁻¹：把旋转 b 换到 a 描述的坐标系里 */
function conjugate(a: Quat, b: Quat): Quat {
  return quatMul(quatMul(a, b), conj(a));
}

/** 用四元数旋转一个向量（v' = q v q⁻¹） */
function rotateVec(q: Quat, v: Vec3): [number, number, number] {
  const m = quatToMat(q);
  const x = v[0];
  const y = v[1];
  const z = v[2];
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}

/**
 * 按 BVH 声明的通道顺序合成欧拉旋转。
 *
 * `Zrotation Yrotation Xrotation` ⟹ `q = qz ⊗ qy ⊗ qx`，即矩阵 `Rz·Ry·Rx`
 * （作用在子空间向量上时 Rx 先生效）。与 Python 侧 `quat_from_euler_zyx` 同义。
 * 不假定固定的通道名/数量 —— CMU 与 Mixamo 的欧拉序不同，硬编码会整体扭错。
 */
function eulerToQuatZYX(j: BvhJoint, e: readonly [number, number, number]): Quat {
  let q: Quat = [0, 0, 0, 1];
  for (const ch of j.rotChannels) {
    const c = ch.toLowerCase();
    let ang = 0;
    let ax = 0;
    let ay = 0;
    let az = 0;
    if (c.startsWith('x')) {
      ang = e[0];
      ax = 1;
    } else if (c.startsWith('y')) {
      ang = e[1];
      ay = 1;
    } else if (c.startsWith('z')) {
      ang = e[2];
      az = 1;
    } else {
      continue;
    }
    const h = ang * 0.5;
    const s = Math.sin(h);
    q = quatMul(q, [ax * s, ay * s, az * s, Math.cos(h)]);
  }
  return q;
}

/** 读第 f 帧某关节的欧拉角（弧度，按 X/Y/Z 归位，不看通道顺序） */
function readEuler(
  bvh: BvhFile,
  j: BvhJoint,
  f: number,
  out: [number, number, number],
): void {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  const base = f * bvh.dof + j.rotColumn;
  for (let k = 0; k < j.rotChannels.length; k++) {
    const c = j.rotChannels[k]!.toLowerCase();
    const v = bvh.frames[base + k]! * DEG;
    if (c.startsWith('x')) out[0] = v;
    else if (c.startsWith('y')) out[1] = v;
    else if (c.startsWith('z')) out[2] = v;
  }
}

/** 读第 f 帧根关节的位置（按通道名取值，不假定 X/Y/Z 的排列） */
function readPosition(
  bvh: BvhFile,
  j: BvhJoint,
  f: number,
  out: [number, number, number],
): void {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  const base = f * bvh.dof;
  for (let k = 0; k < j.channels.length; k++) {
    const c = j.channels[k]!.toLowerCase();
    if (!c.endsWith('position')) continue;
    const v = bvh.frames[base + j.column + k]!;
    if (c.startsWith('x')) out[0] = v;
    else if (c.startsWith('y')) out[1] = v;
    else if (c.startsWith('z')) out[2] = v;
  }
}

/**
 * 目标腿长 / 源腿长。
 *
 * 「腿长」= Hips 的 up 分量 − 所有关节 up 分量的最小值（脚底）。用同一套测法
 * 测两边，所以单位换算（cm / m / 英寸）自动约掉 —— 不需要猜源的单位。
 */
function computeSkeletonScale(
  bvh: BvhFile,
  srcRest: Record<string, [number, number, number]>,
  hipsJoint: string | null,
  tgtPos: JointPositions,
  qUp: Quat,
  warnings: string[],
): number {
  const srcHipsY = hipsJoint !== null ? rotateVec(qUp, srcRest[hipsJoint]!)[1] : NaN;
  let srcMinY = Infinity;
  for (const n of bvh.order) {
    const y = rotateVec(qUp, srcRest[n]!)[1];
    if (y < srcMinY) srcMinY = y;
  }
  let tgtMinY = Infinity;
  for (const n of HUMANIK_ORDER) {
    const p = tgtPos[n];
    if (p !== undefined && p[1] < tgtMinY) tgtMinY = p[1];
  }
  const tgtHipsY = tgtPos.Hips?.[1] ?? NaN;
  const srcLeg = srcHipsY - srcMinY;
  const tgtLeg = tgtHipsY - tgtMinY;
  if (!(srcLeg > 1e-6) || !(tgtLeg > 1e-6)) {
    warnings.push('无法从骨架量出腿长，根位移按 1:1 处理');
    return 1;
  }
  return tgtLeg / srcLeg;
}
