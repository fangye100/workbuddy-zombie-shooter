/**
 * Skin Wrapper —— 代理圆柱体（简陋版 Skin Editor Proxy Object）。
 *
 * 与骨骼编辑同处 binding 模块、不碰任何渲染层 / 其他 Game Editor 模块。
 *
 * 设计
 * ----
 *  - 每个 joint 的 segment（= `boneSegments`：骨 head → 第一个子骨 head）上挂一个
 *    圆柱体，作为**该 joint 的 Skin Wrapper**。圆柱体完全由当前 joint 坐标派生 →
 *    自动跟随 child joint 移动 / 旋转，朝向 = parent→child（与骨段同线，天然一致）。
 *  - 每个圆柱体划分为 **top / medium / bottom** 三段，每段有独立半径（大小与形状），
 *    可单独选中调节。
 *  - 被圆柱包裹（dr ≤ 该段半径）的网格顶点，其 LBS 权重归属该 joint；圆柱外的顶点
 *    退化为「到骨段距离」的衰减，与 `computeLbsWeights` 行为平滑衔接。
 *  - 圆柱体与权重都支持左右镜像（L↔R，靠 `MIRROR_PAIRS` / `mirrorOf`）。
 */

import {
  HUMANIK_ORDER,
  MIRROR_PAIRS,
  isTipBone,
  mirrorOf,
  type Vec3,
} from './humanik-template';
import {
  boneSegments,
  type JointPositions,
  type SkinWeights,
} from './binding-math';

/** 圆柱体三段：沿 parent→child 方向，bottom 近 parent，top 近 child */
export type CylSegment = 'top' | 'medium' | 'bottom';

export interface SkinCylinder {
  /** 该 wrapper 对应的 joint（= 其骨段起点骨） */
  bone: string;
  /** 三段半径（米），决定包裹范围与锥度形状 */
  radii: { top: number; medium: number; bottom: number };
  enabled: boolean;
  /**
   * 是否已被**手动**改过半径（滑块 / 视图里拖 / 镜像）。
   *
   * 默认半径是骨长的函数（骨长 ×0.35），所以「拖 joint 改骨长」天然会让包裹器
   * 变大变小 —— 一旦把它当成自动行为，用户手动调的半径就会被悄悄覆盖。
   * 于是：手动改过 = `true`，`autoFitCylinders()` 只碰 `!manual` 的骨。
   */
  manual?: boolean;
  /**
   * 包裹器相对骨段的**位移**（米，骨局部坐标系：x=沿骨轴 / y=侧向 / z=前后）。
   * 由「在视图里沿 joint 局部轴拖动」或右侧 transform 属性框写入；默认不写 = [0,0,0]。
   * 画几何体与算权重时都按此偏移平移后的骨段，保证「看到的体积 == 算权重用的体积」。
   */
  offset?: Vec3 | undefined;
}

/** 键 = 骨名（joint），值 = 该 joint 的 Skin Wrapper */
export type SkinCylinderMap = Record<string, SkinCylinder>;

/**
 * 骨段的局部正交基（与 `cylinder-overlay.ts` 的 emitBones 用同一套参考向量算法，
 * 保证偏移方向在两处完全一致）。
 *   - axial = 归一化 (b−a)，即 joint 的局部 x 轴（沿骨）；
 *   - v1 / v2 = 与 axial 正交的侧向 / 前后轴。
 */
export interface LocalBasis {
  axial: Vec3;
  v1: Vec3;
  v2: Vec3;
}

export function boneLocalBasis(a: Vec3, b: Vec3): LocalBasis {
  let ax = b[0] - a[0];
  let ay = b[1] - a[1];
  let az = b[2] - a[2];
  let len = Math.hypot(ax, ay, az);
  if (len < 1e-9) { ax = 0; ay = 1; az = 0; len = 1; }
  const ux = ax / len, uy = ay / len, uz = az / len;
  let rx = 0, ry = 1, rz = 0;
  if (Math.abs(uy) > 0.9) { rx = 0; ry = 0; rz = 1; }
  let v1x = uy * rz - uz * ry;
  let v1y = uz * rx - ux * rz;
  let v1z = ux * ry - uy * rx;
  const v1l = Math.hypot(v1x, v1y, v1z) || 1;
  v1x /= v1l; v1y /= v1l; v1z /= v1l;
  const v2x = uy * v1z - uz * v1y;
  const v2y = uz * v1x - ux * v1z;
  const v2z = ux * v1y - uy * v1x;
  return { axial: [ux, uy, uz], v1: [v1x, v1y, v1z], v2: [v2x, v2y, v2z] };
}

/**
 * 把包裹器位移（骨局部坐标）换算成世界偏移，整体平移骨段 a→b。
 * `offset` 为 undefined 时原样返回（零位移）。
 * 画几何体（cylinder-overlay）与算权重（computeCylinderWeights）共用此函数，
 * 保证「视图里看到的包裹器」与「算权重用的包裹器」是同一个平移后的体积。
 */
export function offsetSegmentEndpoints(
  a: Vec3, b: Vec3, offset: Vec3 | undefined,
): { a: Vec3; b: Vec3 } {
  if (offset === undefined) return { a, b };
  const { axial, v1, v2 } = boneLocalBasis(a, b);
  const ox = axial[0]! * offset[0]! + v1[0]! * offset[1]! + v2[0]! * offset[2]!;
  const oy = axial[1]! * offset[0]! + v1[1]! * offset[1]! + v2[1]! * offset[2]!;
  const oz = axial[2]! * offset[0]! + v1[2]! * offset[1]! + v2[2]! * offset[2]!;
  return {
    a: [a[0] + ox, a[1] + oy, a[2] + oz],
    b: [b[0] + ox, b[1] + oy, b[2] + oz],
  };
}

/**
 * 由当前关节坐标生成默认 wrapper：半径随骨长缩放并夹在合理区间，
 * 叶子骨（退化为点）给一个正的小半径，避免 NaN。
 */
export function defaultSkinCylinders(positions: JointPositions): SkinCylinderMap {
  const segs = boneSegments(positions);
  const out: SkinCylinderMap = {};
  for (const s of segs) {
    // tip 不产生 skin wrapper：它是纯末端控制节点，没有自己的包裹体积
    if (isTipBone(s.bone)) continue;
    const len = Math.hypot(
      s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2],
    );
    const r = Math.min(0.22, Math.max(0.04, len * 0.35));
    out[s.bone] = {
      bone: s.bone,
      radii: { top: r, medium: r, bottom: r },
      enabled: true,
    };
  }
  return out;
}

/**
 * 自动适配：把**未手动改过**的骨半径重算为「骨长 ×0.35」（与 `defaultSkinCylinders`
 * 同一公式）。手动改过的骨（`manual === true`）一个都不碰 —— 自动算法绝不覆盖手动值。
 *
 * 这是**显式动作**（面板上的「自动适配半径」按钮），不是每帧跑的隐式行为：
 * 隐式自动适配的表现就是「拖 joint 包裹器跟着变大变小，手动调的总是不见」。
 *
 * 原地修改 `cyls`，返回真正被改动的骨名（供 UI 提示）。
 */
export function autoFitCylinders(
  positions: JointPositions,
  cyls: SkinCylinderMap,
): string[] {
  const segs = boneSegments(positions);
  const changed: string[] = [];
  for (const s of segs) {
    if (isTipBone(s.bone)) continue;
    const cyl = cyls[s.bone];
    if (cyl === undefined || cyl.manual === true) continue;
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
    const r = Math.min(0.22, Math.max(0.04, len * 0.35));
    if (
      cyl.radii.top !== r || cyl.radii.medium !== r || cyl.radii.bottom !== r
    ) changed.push(s.bone);
    cyl.radii.top = r;
    cyl.radii.medium = r;
    cyl.radii.bottom = r;
  }
  return changed;
}

export interface CylinderWeightOptions {
  /** 每顶点最大影响骨数（默认 4） */
  maxInfluences?: number;
}

/**
 * 圆柱体驱动的 LBS 权重（包裹即所属）。
 *
 * 对每个顶点、每根启用中的 wrapper，算它到该 wrapper 表面的**有符号距离**
 * `gap = dr − r`（dr = 顶点到骨段轴的径向距离，r = 该子段半径）：
 *   - `gap ≤ 0`（被包住）→ 顶点属于该 joint 的包裹体积；
 *   - `gap >  0`（包裹外）→ 该 wrapper 不拥有此顶点。
 *
 * 归属规则（用户指定）：
 *   - **被单独包住**（只有一根 wrapper 的 gap≤0）→ 该 joint 的「绝对体」，权重 ≈ 100%。
 *   - **被多根不同 joint 的 wrapper 包住** → 按「点到各 wrapper 表面的最近距离」做
 *     百分比分配：越深（穿透深度 `r−dr` 越大、离表面越远）的 wrapper 拿到越多权重，
 *     多根归一化后即各 joint 的百分比占比。
 *
 * 没有任何 wrapper 包住的顶点（天外飞点 / 全禁用）→ 兜底给「几何最近的 wrapper」
 * 权重 1，杜绝零权重顶点（旧实现用距离衰减，此处等价「最近骨」默认）。
 *
 * 所有权重都来自「是否被包 + 包得多深」，与「包住即所属」的语义一致；
 * 下游 `binding-export` 的 `smoothSkinWeights` 会再做热扩散松弛，晕开骨交界硬切换。
 */
export function computeCylinderWeights(
  positions: Float32Array,
  vertexFloats: number,
  vertexCount: number,
  placed: JointPositions,
  cyls: SkinCylinderMap,
  opts: CylinderWeightOptions = {},
): SkinWeights {
  const maxInfluences = opts.maxInfluences ?? 4;
  const segs = boneSegments(placed); // 与 HUMANIK_ORDER 同序，seg 索引 = 骨索引
  const nBones = segs.length;
  const joints = new Uint16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  const w = new Float64Array(nBones);
  const idx = new Int32Array(nBones);

  // 被包顶点的基础权重：只需 > 0 即可压过「未包（=0）」，同时留出 penetration
  // 差异空间做百分比分配。BASE 不必大（未包恒为 0，不存在旧方案里「内/外权重
  // 同量级」的冲突）；penetration（米级 ~0..0.22）经 PEN_SCALE 放大后主导分配。
  const BASE = 1.0;
  const PEN_SCALE = 8.0;

  for (let i = 0; i < vertexCount; i++) {
    const o = i * vertexFloats;
    const p: Vec3 = [positions[o]!, positions[o + 1]!, positions[o + 2]!];
    let nearestGap = Infinity;   // 未包顶点：到最近 wrapper 表面的间隙（取最小者作兜底 owner）
    let nearestBone = 0;
    for (let b = 0; b < nBones; b++) {
      const seg = segs[b]!;
      const cyl = cyls[seg.bone];
      idx[b] = b;
      if (cyl === undefined || !cyl.enabled) { w[b] = 0; continue; }
      // 包裹器位移：把骨段整体平移到偏移后的位置，权重按平移后的体积算
      const ends = offsetSegmentEndpoints(seg.a, seg.b, cyl.offset);
      const a = ends.a;
      const bb = ends.b;
      const abx = bb[0] - a[0];
      const aby = bb[1] - a[1];
      const abz = bb[2] - a[2];
      const len2 = abx * abx + aby * aby + abz * abz;
      let t = 0;
      if (len2 > 1e-12) {
        t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const fx = a[0] + t * abx;
      const fy = a[1] + t * aby;
      const fz = a[2] + t * abz;
      const dr = Math.hypot(p[0] - fx, p[1] - fy, p[2] - fz);
      const sub = t < 1 / 3 ? cyl.radii.bottom : t < 2 / 3 ? cyl.radii.medium : cyl.radii.top;
      const r = sub > 1e-6 ? sub : 1e-6;
      const gap = dr - r; // >0 包裹外；≤0 包裹内
      if (gap <= 0) {
        // 被包住：到表面距离 = −gap = r − dr（穿透深度）。越深 → 离表面越远 → 权重越大。
        w[b] = BASE + (-gap) * PEN_SCALE;
      } else {
        w[b] = 0; // 未包：该 wrapper 不拥有此顶点
        if (gap < nearestGap) { nearestGap = gap; nearestBone = b; }
      }
    }
    // top-4（nBones=22 极小，插入排序足够）
    for (let k = 0; k < maxInfluences; k++) {
      let best = k;
      for (let j = k + 1; j < nBones; j++) if (w[idx[j]!]! > w[idx[best]!]!) best = j;
      const tt = idx[k]!; idx[k] = idx[best]!; idx[best] = tt;
    }
    const base = i * 4;
    let sum = 0;
    for (let k = 0; k < maxInfluences; k++) sum += w[idx[k]!]!;
    if (sum <= 1e-12) {
      // 无任何 wrapper 包住 → 兜底给最近 wrapper 权重 1，杜绝零权重顶点
      joints[base] = nearestBone;
      weights[base] = 1;
    } else {
      for (let k = 0; k < maxInfluences; k++) {
        joints[base + k] = idx[k]!;
        weights[base + k] = w[idx[k]!]! / sum;
      }
    }
  }
  return { joints, weights };
}

/**
 * 左右镜像 wrapper 几何：把左（或右）侧的半径抄到对侧同名骨。
 * 中轴骨（Hips/Spine 等）无镜像对，保持原样。
 */
export function mirrorCylinders(map: SkinCylinderMap): SkinCylinderMap {
  const out: SkinCylinderMap = JSON.parse(JSON.stringify(map));
  for (const [l, r] of MIRROR_PAIRS) {
    const src = map[l] ?? map[r];
    if (src === undefined) continue;
    // 镜像 = 把一侧的半径抄到对侧，也是手动动作 → manual 标记跟着走
    // offset 一并抄（近似：局部轴向分量直接复制；侧向/前后分量在镜像下不反向，
    // 因两侧骨局部基的左右翻转在此简化忽略，足够视觉对称）
    out[r] = { bone: r, radii: { ...src.radii }, enabled: src.enabled, manual: src.manual === true, offset: src.offset !== undefined ? [...src.offset] : undefined };
    out[l] = { bone: l, radii: { ...src.radii }, enabled: src.enabled, manual: src.manual === true, offset: src.offset !== undefined ? [...src.offset] : undefined };
  }
  return out;
}

/**
 * 镜像皮肤权重 L→R：把左半（x<0）顶点的权重，以骨名镜像后写到其右半对称点，
 * 使左右蒙皮对称。中轴骨的权重本就对称，跳过不写。
 *
 * 对称配对靠「坐标取负」建立：对顶点坐标 (x,y,z) 在量化后查 (−x,y,z) 的伙伴顶点。
 * 量化精度 1mm，对 ≤ 几万顶点的角色网格是 O(N) 一次扫描。
 */
export function mirrorSkinWeights(
  skin: SkinWeights,
  vertexFloats: number,
  vertexCount: number,
  positions: Float32Array,
): SkinWeights {
  const q = (v: number): number => Math.round(v * 1000);
  const keyOf = (x: number, y: number, z: number): string => `${q(x)}_${q(y)}_${q(z)}`;
  const map = new Map<string, number>();
  for (let i = 0; i < vertexCount; i++) {
    const o = i * vertexFloats;
    map.set(keyOf(positions[o]!, positions[o + 1]!, positions[o + 2]!), i);
  }
  const outJoints = Uint16Array.from(skin.joints);
  const outWeights = Float32Array.from(skin.weights);

  for (let i = 0; i < vertexCount; i++) {
    const o = i * vertexFloats;
    const x = positions[o]!;
    const y = positions[o + 1]!;
    const z = positions[o + 2]!;
    if (x >= -1e-6) continue; // 只处理左半，镜像到右半
    const j = map.get(keyOf(-x, y, z));
    if (j === undefined) continue;
    for (let k = 0; k < 4; k++) {
      const bi = skin.joints[i * 4 + k]!;
      const w = skin.weights[i * 4 + k]!;
      const mb = mirrorOf(HUMANIK_ORDER[bi]!);
      if (mb === null) continue; // 中轴骨：本就对称，保留原样
      outJoints[j * 4 + k] = HUMANIK_ORDER.indexOf(mb);
      outWeights[j * 4 + k] = w;
    }
    let s = 0;
    for (let k = 0; k < 4; k++) s += outWeights[j * 4 + k]!;
    if (s > 1e-9) {
      for (let k = 0; k < 4; k++) outWeights[j * 4 + k] = outWeights[j * 4 + k]! / s;
    }
  }
  return { joints: outJoints, weights: outWeights };
}
