/**
 * HumanIK / Mixamo 27 骨模板（22 骨干 + 5 tip）（编辑器绑定面板用）。
 *
 * 与 `assets/characters/_tools/humanik_skeleton.json` **同源同值**，只是搬到 TS 侧：
 * 坐标系 Y-up、T-pose、静置 ~2.05 m。改骨架请**两边一起改**，否则离线 pipeline
 * （rig_character.py）与编辑器面板会算出两套不同的骨架。
 *
 * 关键约定（绑定面板的核心前提）：
 *  - `tposeOffset` 是**相对父骨**的平移，且它的**方向**就是该骨的 T-pose 标准朝向
 *    （例如 LeftArm = (+0.10,0,0) → 手臂在 T-pose 里沿 +X 水平外伸）。
 *  - 绑定时用户把 joint 拖到模型实际解剖位置上，得到的是**当前姿态**下的位置；
 *    其中「长度」被采纳进 T-pose 骨架，「方向偏移」只是 currentPose 与 T-pose 的
 *    姿态差（ΔR），**不进** T-pose 骨架，而是在 re-gen 时被消耗于网格反解。
 */

export type Vec3 = readonly [number, number, number];

export interface BoneDef {
  readonly name: string;
  readonly parent: string | null;
  /** 相对父骨的 T-pose 平移（米）；其单位方向即该骨的 T-pose 标准朝向 */
  readonly tposeOffset: Vec3;
}

/**
 * 骨骼顺序 = glTF skins[].joints 的顺序，也是关节索引。顺序不可变。
 *
 * ⚠️ 2026-09-07：原本是 22 骨（索引 0..21）。为修「末端外形与旋转无法控制」
 * 加了 5 个 **tip（尖端）** 骨 → 27 骨（索引 0..26）。原因见 `TIP_BONES`。
 */
export const HUMANIK_ORDER: readonly string[] = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTip',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandTip',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RightHandTip',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'LeftToeTip',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase', 'RightToeTip',
] as const;

export const HUMANIK_BONES: Readonly<Record<string, BoneDef>> = {
  Hips:          { name: 'Hips',          parent: null,        tposeOffset: [0.0, 1.00, 0.0] },
  Spine:         { name: 'Spine',         parent: 'Hips',      tposeOffset: [0.0, 0.15, 0.0] },
  Spine1:        { name: 'Spine1',        parent: 'Spine',     tposeOffset: [0.0, 0.15, 0.0] },
  Spine2:        { name: 'Spine2',        parent: 'Spine1',    tposeOffset: [0.0, 0.15, 0.0] },
  Neck:          { name: 'Neck',          parent: 'Spine2',    tposeOffset: [0.0, 0.15, 0.0] },
  Head:          { name: 'Head',          parent: 'Neck',      tposeOffset: [0.0, 0.20, 0.0] },
  // 头顶尖端：Head 原本是叶子，头顶一圈顶点（发型 / 头顶装备）没有可依附的骨段，
  // 低头抬头时头顶会被脖子抢走。0.14 m ≈ 颅顶到 Head 关节的距离。
  HeadTip:       { name: 'HeadTip',       parent: 'Head',      tposeOffset: [0.0, 0.14, 0.0] },
  LeftShoulder:  { name: 'LeftShoulder',  parent: 'Spine2',    tposeOffset: [0.07, 0.10, 0.0] },
  LeftArm:       { name: 'LeftArm',       parent: 'LeftShoulder', tposeOffset: [0.10, 0.0, 0.0] },
  LeftForeArm:   { name: 'LeftForeArm',   parent: 'LeftArm',   tposeOffset: [0.26, 0.0, 0.0] },
  LeftHand:      { name: 'LeftHand',      parent: 'LeftForeArm', tposeOffset: [0.25, 0.0, 0.0] },
  LeftHandTip:   { name: 'LeftHandTip',   parent: 'LeftHand',  tposeOffset: [0.10, 0.0, 0.0] },
  RightShoulder: { name: 'RightShoulder', parent: 'Spine2',    tposeOffset: [-0.07, 0.10, 0.0] },
  RightArm:      { name: 'RightArm',      parent: 'RightShoulder', tposeOffset: [-0.10, 0.0, 0.0] },
  RightForeArm:  { name: 'RightForeArm',  parent: 'RightArm',  tposeOffset: [-0.26, 0.0, 0.0] },
  RightHand:     { name: 'RightHand',     parent: 'RightForeArm', tposeOffset: [-0.25, 0.0, 0.0] },
  RightHandTip:  { name: 'RightHandTip',  parent: 'RightHand', tposeOffset: [-0.10, 0.0, 0.0] },
  LeftUpLeg:     { name: 'LeftUpLeg',     parent: 'Hips',      tposeOffset: [0.10, -0.10, 0.0] },
  LeftLeg:       { name: 'LeftLeg',       parent: 'LeftUpLeg', tposeOffset: [0.0, -0.42, 0.0] },
  LeftFoot:      { name: 'LeftFoot',      parent: 'LeftLeg',   tposeOffset: [0.0, -0.45, 0.0] },
  LeftToeBase:   { name: 'LeftToeBase',   parent: 'LeftFoot',  tposeOffset: [0.0, 0.0, 0.14] },
  LeftToeTip:    { name: 'LeftToeTip',    parent: 'LeftToeBase', tposeOffset: [0.0, 0.0, 0.10] },
  RightUpLeg:    { name: 'RightUpLeg',    parent: 'Hips',      tposeOffset: [-0.10, -0.10, 0.0] },
  RightLeg:      { name: 'RightLeg',      parent: 'RightUpLeg', tposeOffset: [0.0, -0.42, 0.0] },
  RightFoot:     { name: 'RightFoot',     parent: 'RightLeg',  tposeOffset: [0.0, -0.45, 0.0] },
  RightToeBase:  { name: 'RightToeBase',  parent: 'RightFoot', tposeOffset: [0.0, 0.0, 0.14] },
  RightToeTip:   { name: 'RightToeTip',   parent: 'RightToeBase', tposeOffset: [0.0, 0.0, 0.10] },
};

/**
 * **tip（尖端）骨**：手腕末端、脚趾末端与头顶尖端的末端节点。
 *
 * 为什么需要它们
 * --------------
 * `boneSegments()` 的规则是「每根骨的影响胶囊 = 骨 head → 其**第一个子骨** 的 head」。
 * 加 tip 之前，`Head` / `LeftHand` / `LeftToeBase` 都是**叶子**，胶囊退化成一个点
 * （a == b）→ 头顶、手掌、脚尖这些末端部位没有可被顶点依附的骨段，于是：
 *   - **末端外形无法控制**：这些部位的顶点权重只能被脖子 / 前臂 / 小腿抢走，蒙皮变形发散；
 *   - **末端旋转无法控制**：没有末端骨，就没法给头顶 / 指尖 / 脚尖一个独立的旋转轴。
 * 补上 tip 之后，`LeftHand` 的胶囊变成 Hand → HandTip（有长度），三个问题一起解决。
 *
 * tip 的三条硬性约束（用户明确规定）
 * ----------------------------------
 *   1. tip **不产生 wrapper mesh / skin wrapper** —— 不进半径表、不画圆柱体；
 *   2. tip **不参与 skin 计算** —— 顶点权重里 tip 恒为 0，不占影响槽位；
 *   3. 但 tip **仍然是骨架节点**：进 glTF skins[].joints、有 node / IBM，
 *      可被动画驱动（没有独立轨道时跟随父骨），这正是「末端旋转可控」的落点。
 *
 * ⚠️ 因此**不能**简单地把 tip 从权重数组里摘掉：`joints[]` 里的数字是
 * `HUMANIK_ORDER` 的下标，过滤数组会让索引整体错位。正确做法是**保留槽位、
 * 把 tip 的权重恒置 0**（见 `computeLbsWeights`）。
 */
export const TIP_BONES: ReadonlySet<string> = new Set<string>([
  'HeadTip', 'LeftHandTip', 'RightHandTip', 'LeftToeTip', 'RightToeTip',
]);

/** 是否是 tip（尖端）骨 */
export function isTipBone(name: string): boolean {
  return TIP_BONES.has(name);
}

/** 参与 skin 计算的骨（= 全部骨 − tip） */
export function skinBones(): readonly string[] {
  return HUMANIK_ORDER.filter((n) => !TIP_BONES.has(n));
}

/**
 * 手臂骨（含肩、含手腕 tip），A-pose 时整条链绕肩旋转 45° 下垂。镜像判断用前缀即可。
 *
 * ⚠️ tip 必须在内：否则 A-pose 下指尖会留在 T-pose 的位置，手尖从手腕"折"出去。
 */
export const ARM_BONES: ReadonlySet<string> = new Set<string>([
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandTip',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RightHandTip',
]);

/** 左右镜像对（正视图 mirror 用）。左右互为 x 取反，其余分量相同。 */
export const MIRROR_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['LeftShoulder', 'RightShoulder'],
  ['LeftArm', 'RightArm'],
  ['LeftForeArm', 'RightForeArm'],
  ['LeftHand', 'RightHand'],
  ['LeftHandTip', 'RightHandTip'],
  ['LeftUpLeg', 'RightUpLeg'],
  ['LeftLeg', 'RightLeg'],
  ['LeftFoot', 'RightFoot'],
  ['LeftToeBase', 'RightToeBase'],
  ['LeftToeTip', 'RightToeTip'],
];

/** 找镜像骨；中轴骨（Hips/Spine/Head）返回 null。 */
export function mirrorOf(name: string): string | null {
  for (const [l, r] of MIRROR_PAIRS) {
    if (l === name) return r;
    if (r === name) return l;
  }
  return null;
}

/**
 * 默认（模板）T-pose 下的 27 个关节世界坐标（22 骨干 + 5 tip）。
 * 用作绑定面板的初始摆放 —— 用户随后把它们拖到模型实际解剖位置上。
 */
export function tposeWorldPositions(): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const name of HUMANIK_ORDER) {
    const b = HUMANIK_BONES[name]!;
    if (b.parent === null) {
      out[name] = [b.tposeOffset[0], b.tposeOffset[1], b.tposeOffset[2]];
    } else {
      const p = out[b.parent]!;
      out[name] = [
        p[0] + b.tposeOffset[0],
        p[1] + b.tposeOffset[1],
        p[2] + b.tposeOffset[2],
      ];
    }
  }
  return out;
}

/** 每个骨的 T-pose 标准**单位朝向**（由 tposeOffset 归一化而来）。 */
export function tposeDirections(): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  for (const name of HUMANIK_ORDER) {
    const o = HUMANIK_BONES[name]!.tposeOffset;
    const len = Math.hypot(o[0], o[1], o[2]);
    out[name] = len > 1e-9
      ? [o[0] / len, o[1] / len, o[2] / len]
      : [0, 0, 0];
  }
  return out;
}

/**
 * A-pose 关节世界坐标：在标准 T-pose 基础上，把**整条手臂链绕肩旋转 45° 下垂**。
 *
 * 做法：从根逐骨累加，遇到手臂骨时把「相对父骨的偏移」绕 Z 轴旋转
 *   - Left  -45°（顺时针，手臂向 -X/-Y 倒）
 *   - Right +45°（左手系对称）
 * 因为 T-pose 里手臂是沿 X 的共线链，对每个骨偏移施加同一角度的 Z 旋转，
 * 等价于把整条手臂刚体绕肩旋转 45°，世界坐标正确。
 *
 * @param base 基准摆放（默认 = 模板 T-pose）。传 `this.positions` 即可得到
 *             用**当前编辑骨长**算出的 A-pose（预览用，保留用户拖出的肢体长度）。
 */
export function aposeWorldPositions(
  base?: Record<string, [number, number, number]>,
): Record<string, [number, number, number]> {
  const src = base ?? tposeWorldPositions();
  const out: Record<string, [number, number, number]> = {};
  for (const name of HUMANIK_ORDER) {
    const parent = HUMANIK_BONES[name]!.parent;
    if (parent === null) {
      out[name] = [src[name]![0], src[name]![1], src[name]![2]];
      continue;
    }
    const pp = out[parent]!;
    const p = src[name]!;
    let ox = p[0] - pp[0];
    let oy = p[1] - pp[1];
    const oz = p[2] - pp[2];
    if (ARM_BONES.has(name)) {
      const deg = name.startsWith('Left') ? -45 : 45;
      const a = (deg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const nx = c * ox - s * oy;
      const ny = s * ox + c * oy;
      ox = nx;
      oy = ny;
    }
    out[name] = [pp[0] + ox, pp[1] + oy, pp[2] + oz];
  }
  return out;
}
