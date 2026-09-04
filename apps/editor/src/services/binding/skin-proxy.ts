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
}

/** 键 = 骨名（joint），值 = 该 joint 的 Skin Wrapper */
export type SkinCylinderMap = Record<string, SkinCylinder>;

/**
 * 由当前关节坐标生成默认 wrapper：半径随骨长缩放并夹在合理区间，
 * 叶子骨（退化为点）给一个正的小半径，避免 NaN。
 */
export function defaultSkinCylinders(positions: JointPositions): SkinCylinderMap {
  const segs = boneSegments(positions);
  const out: SkinCylinderMap = {};
  for (const s of segs) {
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

export interface CylinderWeightOptions {
  /** 距离衰减幂次（默认 3.0，与 computeLbsWeights 一致） */
  falloff?: number;
  /** 距离平滑项（默认 0.02） */
  eps?: number;
  /** 每顶点最大影响骨数（默认 4） */
  maxInfluences?: number;
}

/**
 * 圆柱体驱动的 LBS 权重。
 *
 * 对每个顶点、每根启用中的 wrapper：
 *   - 投影到骨段轴 → 参数 t∈[0,1]，得径向距离 dr 与所属子段（top/medium/bottom）；
 *   - 有效半径 r = 该子段半径；
 *   - dr ≤ r（包裹内）→ 该骨拿到**压倒性高权重**（顶点归属此 joint）；
 *   - dr > r（包裹外）→ 退化为 1/(dr−r+eps)^falloff 的距离衰减，与 capsule 权重平滑衔接。
 * 取 top-4 再归一化，输出与 `computeLbsWeights` 同形的 `SkinWeights`（joint 索引 = 骨索引）。
 *
 * 没有 wrapper 的顶点（远离所有骨段）自然落到距离衰减分支，行为与旧胶囊权重一致。
 */
export function computeCylinderWeights(
  positions: Float32Array,
  vertexFloats: number,
  vertexCount: number,
  placed: JointPositions,
  cyls: SkinCylinderMap,
  opts: CylinderWeightOptions = {},
): SkinWeights {
  const falloff = opts.falloff ?? 3.0;
  const eps = opts.eps ?? 0.02;
  const maxInfluences = opts.maxInfluences ?? 4;
  const segs = boneSegments(placed); // 与 HUMANIK_ORDER 同序，seg 索引 = 骨索引
  const nBones = segs.length;
  const joints = new Uint16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  const w = new Float64Array(nBones);
  const idx = new Int32Array(nBones);

  const insideW = 1 / Math.pow(eps, falloff); // 包裹内统一压倒性高权

  for (let i = 0; i < vertexCount; i++) {
    const o = i * vertexFloats;
    const p: Vec3 = [positions[o]!, positions[o + 1]!, positions[o + 2]!];
    for (let b = 0; b < nBones; b++) {
      const seg = segs[b]!;
      const cyl = cyls[seg.bone];
      idx[b] = b;
      if (cyl === undefined || !cyl.enabled) { w[b] = 0; continue; }
      const a = seg.a;
      const bb = seg.b;
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
      // 包裹内 → 压倒性高权；包裹外 → 距离衰减（表面处连续）
      w[b] = dr <= r ? insideW : 1 / Math.pow(dr - r + eps, falloff);
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
      // 兜底：所有 wrapper 都禁用时，退回「最近骨权重 1」，杜绝零权重顶点
      joints[base] = idx[0]!;
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
    out[r] = { bone: r, radii: { ...src.radii }, enabled: src.enabled };
    out[l] = { bone: l, radii: { ...src.radii }, enabled: src.enabled };
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
