/**
 * 绑定面板的数学核心：姿态拟合 → T-pose 反解 → LBS 权重。
 *
 * ── 这套数学要解决的那件事 ────────────────────────────────────────────────
 * 模型可能是 T-pose、A-pose、乃至攻击姿态。用户把 22 个 joint 拖到模型**实际解剖位置**
 * 上时，得到的是「当前姿态下」的关节坐标。这里必须把它拆成两类性质完全不同的数据：
 *
 *   ① 骨长  L_i = ‖p_i − p_parent(i)‖        → 模型真实肢体长度，**采纳**进 T-pose 骨架
 *   ② 姿态旋转 ΔR_i = rot(u_i^T → u_i^P)      → currentPose 与 T-pose 的**差值**
 *                                                 **绝不**进 T-pose 骨架
 *
 * 若把 ② 也写进骨架，bind/rest 就不是 T-pose 了：动画的初始值会被 A-pose 污染，
 * 播放时「当前值」相对「初始值」的增量全错。所以 ② 只能在 re-gen 时被**消耗掉**：
 *
 *   1. 用「当前姿态骨架」（含 ΔR）算 LBS 权重 w —— 此时骨架与模型真实肢体重合，权重才对；
 *   2. 用 ΔR 把网格**反解回 T-pose**：
 *        v_T = Σ_k w_k · M_T_k · M_P_k⁻¹ · v_P
 *      （M_P = 当前姿态骨世界矩阵，M_T = 同骨长的 T-pose 骨世界矩阵）
 *   3. 产物：网格 = T-pose，骨架 = T-pose（只有采纳的骨长，旋转全清），
 *      inverseBind = M_T⁻¹，权重 = w。
 *
 * 结果 bind pose 是干净 T-pose；ΔR 全部落在网格反解里，不污染骨架初始值与动画当前值。
 *
 * 矩阵一律 **列主序 length-16**（glTF 约定）：m[col * 4 + row]。
 * 骨矩阵形如 T·R（刚体、无缩放），故求逆用转置法，比通用 4x4 求逆更稳。
 */

import {
  ARM_BONES,
  HUMANIK_BONES,
  HUMANIK_ORDER,
  tposeDirections,
  type Vec3,
} from './humanik-template';

/** 列主序 4x4 矩阵（length 16，glTF 约定） */
export type Mat4 = Float64Array;

// ─────────────────────────── 基础线性代数 ───────────────────────────

export function matIdentity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function matTranslation(x: number, y: number, z: number): Mat4 {
  const m = matIdentity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** 列主序乘法：result = a · b */
export function matMul(a: Mat4, b: Mat4): Mat4 {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row]! * b[c * 4 + k]!;
      r[c * 4 + row] = s;
    }
  }
  return r;
}

/**
 * 刚体矩阵求逆（T·R 形式，R 正交）。
 * M⁻¹ = Rᵀ·T(−t) —— 比通用伴随矩阵求逆数值更稳，也快得多。
 */
export function matInvertRigid(m: Mat4): Mat4 {
  const r = new Float64Array(16);
  // Rᵀ[r][c] = R[c][r] = m[r*4 + c]
  for (let c = 0; c < 3; c++) {
    for (let row = 0; row < 3; row++) {
      r[c * 4 + row] = m[row * 4 + c]!;
    }
  }
  const t = [m[12]!, m[13]!, m[14]!];
  for (let row = 0; row < 3; row++) {
    r[12 + row] = -(m[row * 4 + 0]! * t[0]! + m[row * 4 + 1]! * t[1]! + m[row * 4 + 2]! * t[2]!);
  }
  r[15] = 1;
  return r;
}

/** 点变换：p' = M · p（w=1） */
export function matPoint(m: Mat4, p: Vec3): [number, number, number] {
  const x = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
  const y = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
  const z = m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!;
  return [x, y, z];
}

/** 四元数 xyzw（与 glTF / BVH 烘焙输出同序） */
export type Quat = [number, number, number, number];

/** 把单位向量 a 旋到单位向量 b 的最小旋转（四元数） */
export function quatFromUnitVectors(a: Vec3, b: Vec3): Quat {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  const dot = ax * bx + ay * by + az * bz;
  if (dot > 1 - 1e-8) return [0, 0, 0, 1];
  if (dot < -1 + 1e-8) {
    // 反向：任取一条垂直于 a 的轴，转 180°
    let px = 1, py = 0, pz = 0;
    if (Math.abs(ax) > 0.9) { px = 0; py = 1; pz = 0; }
    const cx = ay * pz - az * py;
    const cy = az * px - ax * pz;
    const cz = ax * py - ay * px;
    const n = Math.hypot(cx, cy, cz) || 1;
    return [cx / n, cy / n, cz / n, 0];
  }
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const w = 1 + dot;
  const n = Math.hypot(cx, cy, cz, w) || 1;
  return [cx / n, cy / n, cz / n, w / n];
}

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** 四元数 → 列主序旋转矩阵 */
export function quatToMat(q: Quat): Mat4 {
  const [x, y, z, w] = q;
  const m = matIdentity();
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + z * w);
  m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w);
  m[9] = 2 * (y * z - x * w);
  m[10] = 1 - 2 * (x * x + y * y);
  return m;
}

export function normalize3(v: Vec3): [number, number, number] {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
}

// ─────────────────────────── 骨架几何 ───────────────────────────

export type JointPositions = Record<string, [number, number, number]>;

/**
 * 每根骨的「影响胶囊」= 骨 head → 其**第一个子骨**的 head；叶子骨退化为点。
 * 「第一个子骨」按 HUMANIK_ORDER 里出现的顺序取，与 Python 侧
 * `rig_humanik.bone_segments` 的 `child_of.setdefault` 规则一致 —— 两边必须同规则，
 * 否则离线 rig 与编辑器面板会算出两套权重。
 */
export function boneSegments(
  positions: JointPositions,
): Array<{ bone: string; a: [number, number, number]; b: [number, number, number] }> {
  const childOf: Record<string, string> = {};
  for (const name of HUMANIK_ORDER) {
    const p = HUMANIK_BONES[name]!.parent;
    if (p !== null && childOf[p] === undefined) childOf[p] = name;
  }
  return HUMANIK_ORDER.map((bone) => {
    const a = positions[bone]!;
    const c = childOf[bone];
    return { bone, a, b: c !== undefined ? positions[c]! : a };
  });
}

/** 顶点到线段 AB 的最短距离（t 夹在 [0,1]，即到线段而非直线） */
export function distToSegment(
  p: Vec3,
  a: Vec3,
  b: Vec3,
): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > 1e-12) {
    t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = p[0] - (a[0] + t * abx);
  const dy = p[1] - (a[1] + t * aby);
  const dz = p[2] - (a[2] + t * abz);
  return Math.hypot(dx, dy, dz);
}

/**
 * A-pose 的**世界矩阵**（含 45° 旋转），供 `reposeMesh` 把网格重姿态成 A-pose。
 *
 * 与 `humanik-template.aposeWorldPositions` 同源：手臂链每个骨相对父骨的偏移绕 Z
 * 旋转 ±45°（Left -45° / Right +45°）。区别是这里返回**带旋转的世界矩阵**，
 * 这样 `reposeMesh` 的 Δ_k = M_A_k · M_P_k⁻¹ 才能把 limb 真正旋转下去，而不只是平移。
 */
export function aposeWorld(placed: JointPositions): Record<string, Mat4> {
  const out: Record<string, Mat4> = {};
  for (const name of HUMANIK_ORDER) {
    const parent = HUMANIK_BONES[name]!.parent;
    if (parent === null) {
      const p = placed[name]!;
      out[name] = matTranslation(p[0], p[1], p[2]);
      continue;
    }
    const pp = out[parent]!;
    const p = placed[name]!;
    let ox = p[0] - pp[12]!;
    let oy = p[1] - pp[13]!;
    const oz = p[2] - pp[14]!;
    if (ARM_BONES.has(name)) {
      const a = (name.startsWith('Left') ? -45 : 45) * Math.PI / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const nx = c * ox - s * oy;
      const ny = s * ox + c * oy;
      ox = nx;
      oy = ny;
    }
    out[name] = matMul(pp, matTranslation(ox, oy, oz));
  }
  return out;
}

export interface SkinWeights {
  /** 每顶点 4 个关节索引（Uint16Array，长度 4N） */
  joints: Uint16Array;
  /** 每顶点 4 个权重（Float32Array，长度 4N，已归一化 Σ=1） */
  weights: Float32Array;
}

/**
 * LBS 权重：**顶点到骨段最近距离 + 反距离衰减**，取 top-4 再归一化。
 * 这是 Python `rig_humanik.compute_lbs_weights` 的 TS 移植，参数默认值保持一致
 * （falloff=3.0 / eps=0.02 / maxInfluences=4）。
 *
 * 注意调用时机：应在**当前姿态**的骨架 + **当前姿态**的网格上调用 ——
 * 此时骨架与模型真实肢体重合，权重才分配到正确的骨上。
 */
export function computeLbsWeights(
  positions: Float32Array,
  vertexFloats: number,
  vertexCount: number,
  segs: Array<{ a: Vec3; b: Vec3 }>,
  falloff = 3.0,
  eps = 0.02,
  maxInfluences = 4,
): SkinWeights {
  const joints = new Uint16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  const nBones = segs.length;
  const w = new Float64Array(nBones);
  const idx = new Int32Array(nBones);

  for (let i = 0; i < vertexCount; i++) {
    const o = i * vertexFloats;
    const p: Vec3 = [positions[o]!, positions[o + 1]!, positions[o + 2]!];
    for (let b = 0; b < nBones; b++) {
      const d = distToSegment(p, segs[b]!.a, segs[b]!.b);
      w[b] = 1 / Math.pow(d + eps, falloff);
      idx[b] = b;
    }
    // 取权重最大的 maxInfluences 个（nBones=22 很小，直接插入排序足够）
    for (let k = 0; k < maxInfluences; k++) {
      let best = k;
      for (let j = k + 1; j < nBones; j++) if (w[idx[j]!]! > w[idx[best]!]!) best = j;
      const t = idx[k]!; idx[k] = idx[best]!; idx[best] = t;
    }
    let sum = 0;
    for (let k = 0; k < maxInfluences; k++) sum += w[idx[k]!]!;
    const base = i * 4;
    if (sum <= 1e-12) {
      // 兜底：全近零 → 最近骨权重 1.0，杜绝零权重顶点
      let bd = Infinity, bj = 0;
      for (let b = 0; b < nBones; b++) {
        const d = distToSegment(p, segs[b]!.a, segs[b]!.b);
        if (d < bd) { bd = d; bj = b; }
      }
      joints[base] = bj;
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
 * 皮肤权重平滑（**空间热力 / Laplacian 松弛**）。
 *
 * 胶囊算法（`computeLbsWeights`）按「顶点到骨段最近距离」分配影响，骨交界处的权重是
 * 硬切换的，蒙皮会出现棱角状撕裂。这里在网格邻接图上做几次 Jacobi 松弛：
 *
 *   w_i ← (1−λ)·w_i + λ·mean(w_邻居)
 *
 * 等价于对权重场做一次**热扩散**，把硬边"晕"开成平滑过渡，且不改变每顶点的 4 个
 * 影响骨（只平滑权重数值），所以不会引入错骨。迭代 2 次、λ=0.5 已是肉眼可见的改善。
 *
 * 邻接由三角面索引构建（每个顶点连它的三角面邻居），复杂度 O(迭代·顶点·平均度数)，
 * 对 ≤ 几千顶点的角色网格是毫秒级，只在 apply 时跑一次，不影响拖拽帧率。
 *
 * @param iterations 松弛迭代次数（默认 2）
 * @param lambda     扩散强度 0..1（默认 0.5；越大越糊）
 */
export function smoothSkinWeights(
  skin: SkinWeights,
  indices: Uint32Array,
  vertexCount: number,
  iterations = 2,
  lambda = 0.5,
): SkinWeights {
  const adj: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!;
    const b = indices[t + 1]!;
    const c = indices[t + 2]!;
    adj[a]!.push(b, c);
    adj[b]!.push(a, c);
    adj[c]!.push(a, b);
  }
  for (let i = 0; i < vertexCount; i++) {
    adj[i] = [...new Set(adj[i]!)];
  }

  const joints = new Uint16Array(skin.joints); // 影响骨不动，只平滑权重
  const cur = Float32Array.from(skin.weights);
  const next = new Float32Array(cur.length);

  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < vertexCount; i++) {
      const nb = adj[i]!;
      for (let k = 0; k < 4; k++) {
        const self = cur[i * 4 + k]!;
        if (nb.length === 0) {
          next[i * 4 + k] = self;
          continue;
        }
        let sum = 0;
        for (const j of nb) sum += cur[j * 4 + k]!;
        const avg = sum / nb.length;
        next[i * 4 + k] = (1 - lambda) * self + lambda * avg;
      }
    }
    cur.set(next);
  }

  // 归一化（Σ=1），保持 LBS 正确
  for (let i = 0; i < vertexCount; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += cur[i * 4 + k]!;
    if (s > 1e-9) {
      for (let k = 0; k < 4; k++) cur[i * 4 + k] = cur[i * 4 + k]! / s;
    }
  }
  return { joints, weights: cur };
}

// ─────────────────────────── 姿态拟合与反解 ───────────────────────────

/**
 * 法线反解：与顶点同步回到 T-pose，否则网格虽然摆正了、明暗却还留在旧姿态。
 *
 * 法线的变换矩阵是顶点变换矩阵的**逆转置**。Δ_k 是纯刚体旋转（Rᵀ），
 * 逆转置 = 它自身，所以：
 *
 *   n_T = normalize( Σ_k w_k · R_world_kᵀ · n_P )
 *
 * `matInvertRigid(M_P)` 的线性部分正好就是 R_worldᵀ，直接取来用。
 * @returns 顶点数组的副本，仅法线分量（offset 3..5）被替换
 */
export function unposeNormals(
  vertices: Float32Array,
  vertexFloats: number,
  vertexCount: number,
  skin: SkinWeights,
  fit: FitResult,
  normalOffset = 3,
): Float32Array {
  // Δ_k 的线性部分 = R_world_kᵀ（T-pose 世界旋转是 identity，故不含 R_T）
  const lin: Mat4[] = HUMANIK_ORDER.map(
    (name) => matInvertRigid(fit.posedWorld[name]!),
  );
  const out = new Float32Array(vertices);
  for (let i = 0; i < vertexCount; i++) {
    const o = i * vertexFloats;
    const nx = vertices[o + normalOffset]!;
    const ny = vertices[o + normalOffset + 1]!;
    const nz = vertices[o + normalOffset + 2]!;
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = skin.weights[i * 4 + k]!;
      if (w <= 0) continue;
      const m = lin[skin.joints[i * 4 + k]!]!;
      x += w * (m[0]! * nx + m[4]! * ny + m[8]! * nz);
      y += w * (m[1]! * nx + m[5]! * ny + m[9]! * nz);
      z += w * (m[2]! * nx + m[6]! * ny + m[10]! * nz);
    }
    const len = Math.hypot(x, y, z);
    if (len > 1e-12) {
      out[o + normalOffset] = x / len;
      out[o + normalOffset + 1] = y / len;
      out[o + normalOffset + 2] = z / len;
    }
  }
  return out;
}

export interface FitResult {
  /** 采纳的骨长（米），键 = 骨名 */
  lengths: Record<string, number>;
  /** 每骨的姿态旋转 ΔR（四元数 xyzw）= currentPose 与 T-pose 的差值，**不进 T-pose 骨架 */
  poseRotations: Record<string, Quat>;
  /** 当前姿态的骨世界矩阵 M_P（含 ΔR） */
  posedWorld: Record<string, Mat4>;
  /** 重建的 T-pose 骨世界矩阵 M_T（只有采纳骨长，旋转为 identity） */
  tposeWorld: Record<string, Mat4>;
  /** T-pose 关节坐标（重建后） */
  tposePositions: JointPositions;
}

/**
 * 由用户摆放的关节坐标，拆出「骨长」与「姿态旋转」，并同时重建 T-pose。
 *
 * @param placed 用户在正/侧视图拖出来的关节坐标（模型 local 空间，Y-up）
 */
export function fitSkeleton(placed: JointPositions): FitResult {
  const dirs = tposeDirections();
  const lengths: Record<string, number> = {};
  const poseRotations: Record<string, Quat> = {};
  const localDelta: Record<string, [number, number, number]> = {};

  // ① 骨长 = 实际摆放的两点距离；② ΔR = T-pose 朝向 → 实际朝向
  for (const name of HUMANIK_ORDER) {
    const parent = HUMANIK_BONES[name]!.parent;
    if (parent === null) {
      lengths[name] = 0;
      poseRotations[name] = [0, 0, 0, 1];
      localDelta[name] = [0, 0, 0];
      continue;
    }
    const a = placed[parent]!, b = placed[name]!;
    const d: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    localDelta[name] = d;
    lengths[name] = Math.hypot(d[0], d[1], d[2]);
    const actual = normalize3(d);
    const canonical = dirs[name]!;
    poseRotations[name] = quatFromUnitVectors(canonical, actual);
  }

  // 当前姿态世界矩阵：R_world 逐级累乘，M_P_i = T(pos_i)·R_world_i
  const rotWorld: Record<string, Quat> = {};
  const posedWorld: Record<string, Mat4> = {};
  for (const name of HUMANIK_ORDER) {
    const parent = HUMANIK_BONES[name]!.parent;
    rotWorld[name] = parent === null
      ? [0, 0, 0, 1]
      : quatMul(rotWorld[parent]!, poseRotations[name]!);
    const p = placed[name]!;
    posedWorld[name] = matMul(matTranslation(p[0], p[1], p[2]), quatToMat(rotWorld[name]!));
  }

  // T-pose 世界矩阵：根沿用用户摆放的 Hips 位置，其余 = 父 + 标准朝向 × 采纳骨长
  // 旋转恒为 identity —— 这就是「ΔR 不进 T-pose 骨架」的落点
  const tposePositions: JointPositions = {};
  const tposeWorld: Record<string, Mat4> = {};
  for (const name of HUMANIK_ORDER) {
    const parent = HUMANIK_BONES[name]!.parent;
    if (parent === null) {
      tposePositions[name] = [placed[name]![0], placed[name]![1], placed[name]![2]];
    } else {
      const pp = tposePositions[parent]!;
      const u = dirs[name]!;
      const L = lengths[name]!;
      tposePositions[name] = [pp[0] + u[0] * L, pp[1] + u[1] * L, pp[2] + u[2] * L];
    }
    const p = tposePositions[name]!;
    tposeWorld[name] = matTranslation(p[0], p[1], p[2]);
  }

  return { lengths, poseRotations, posedWorld, tposeWorld, tposePositions };
}

/**
 * 把网格从「当前姿态」反解回「T-pose」。
 *
 *   v_T = Σ_k w_k · M_T_k · M_P_k⁻¹ · v_P
 *
 * 权重为 1 时精确；多骨影响时是标准做法（逐骨刚体变换再按权重混合），
 * 业界 pose-space 反解即此。反解后网格呈 T 字形，可与 T-pose 骨架直接绑定，
 * bind pose 保持干净。
 */
/**
 * 把网格从一个姿态重姿态到另一个姿态（刚性骨变换按权重混合，业界 pose-space 标准做法）。
 *
 *   v' = Σ_k w_k · M_to_k · M_from_k⁻¹ · v
 *
 * @param fromWorld 源姿态每骨世界矩阵（如当前姿态 posedWorld）
 * @param toWorld   目标姿态每骨世界矩阵（如 T-pose / A-pose 世界矩阵）
 *
 * 反解回 T-pose 只是本函数的特例（from=当前姿态，to=T-pose），见 `unposeMesh`。
 */
export function reposeMesh(
  positions: Float32Array,
  vertexFloats: number,
  vertexCount: number,
  skin: SkinWeights,
  fromWorld: Record<string, Mat4>,
  toWorld: Record<string, Mat4>,
): Float32Array {
  const order = HUMANIK_ORDER;
  // 预算每骨的 Δ_k = M_to_k · M_from_k⁻¹，避免逐顶点重复求逆
  const delta: Mat4[] = order.map(
    (name) => matMul(toWorld[name]!, matInvertRigid(fromWorld[name]!)),
  );
  const out = new Float32Array(positions.length);
  out.set(positions);

  for (let i = 0; i < vertexCount; i++) {
    const o = i * vertexFloats;
    const px = positions[o]!, py = positions[o + 1]!, pz = positions[o + 2]!;
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = skin.weights[i * 4 + k]!;
      if (w <= 0) continue;
      const m = delta[skin.joints[i * 4 + k]!]!;
      x += w * (m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!);
      y += w * (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!);
      z += w * (m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!);
    }
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
  }
  return out;
}

/** 反解回 T-pose（reposeMesh 的特例：from=当前姿态，to=T-pose） */
export function unposeMesh(
  positions: Float32Array,
  vertexFloats: number,
  vertexCount: number,
  skin: SkinWeights,
  fit: FitResult,
): Float32Array {
  return reposeMesh(positions, vertexFloats, vertexCount, skin, fit.posedWorld, fit.tposeWorld);
}
