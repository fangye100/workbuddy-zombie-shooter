/**
 * Skin Wrapper 圆柱体的 **3D 叠加几何**（binding 模块内，渲染层零绑定语义）。
 *
 * 为什么单独一个文件
 * ------------------
 * 圆柱体的「数据」在 `skin-proxy.ts`（`SkinCylinder` / `SkinCylinderMap`），
 * 「2D 示意」在 `binding-panel.ts` 的正视/侧视 2D 画布里（粗描边）。
 * 但**主 3D 视口一直没有圆柱体**——这正是「在视图里看不到包裹器」的根因。
 * 本文件补上 3D 侧：把每个 joint 的代理圆柱体算成真正的三角形网格。
 *
 * 两条输入路径，共用同一套几何生成
 * --------------------------------
 *   1. `buildCylinderOverlay()` —— 输入**本帧已求值**的关节矩阵
 *      （`@aether/render` 的 `evalJointMatrices` 输出），用于主 3D 视口：
 *      圆柱体随骨骼动画实时更新。
 *   2. `buildCylinderOverlayFromSegments()` —— 输入**骨段端点数组**
 *      （`binding-math.ts` 的 `boneSegments(positions)`），用于绑定面板的正/侧视：
 *      面板编辑的是关节坐标 `Record<name, Vec3>`，没有 SkeletonData / 关节矩阵。
 *      ⚠️ 这条路径与 `computeLbsWeights` 用同一个 `boneSegments`，所以面板里
 *      看到的体积**就是**算权重用的那个体积，不会有第二套真源。
 *
 * 每根骨怎么摆
 * ------------
 * 与 `skin-proxy.ts` 的权重语义严格对齐（`SkinCylinder` 注释：
 * 「沿 parent→child 方向，bottom 近 parent，top 近 child」）：
 *   - 每根骨画一根圆柱 A→B；
 *   - 沿轴切成 bottom / medium / top 三段，各段半径取 `cyls[bone].radii.*`；
 *   - 段间**刻意保留台阶**（权重函数每段半径本就是常量），台阶才是权重的真实形状。
 *
 * 输出：交错 pos(3) + normal(3) + color(3)，triangle-list，交给
 * `@aether/render` 的 `CoreCylinderOverlay` 半透明 X-ray 绘制（不写深度 → 不会被模型挡住）。
 */

import type { SkeletonData } from '@aether/scene';
import type { CoreCylinderOverlay } from '@aether/render';
import { isTipBone, type Vec3 } from './humanik-template';
import { offsetSegmentEndpoints, type SkinCylinderMap } from './skin-proxy';

/** 顶点浮点步长：pos(3) + normal(3) + color(3) */
export const CYL_VERT_FLOATS = 9;

/**
 * 三段颜色（0..1 RGB）—— 与 binding-panel 的 `cylColor` 一一对应，
 * 保证 2D 面板、面板 3D 视图与主视图里同一段是同一个颜色，不会两套视觉语言。
 *   bottom #6FB7FF 蓝 / medium #9BE7A8 绿 / top #FF8FA3 红
 */
const SEG_RGB: Record<'bottom' | 'medium' | 'top', readonly [number, number, number]> = {
  bottom: [0.435, 0.718, 1.0],
  medium: [0.608, 0.906, 0.659],
  top: [1.0, 0.561, 0.639],
};

const SEG_ORDER = ['bottom', 'medium', 'top'] as const;

/** 待生成几何的一根骨（世界空间端点） */
interface CylBone {
  /** 骨名（查半径表用） */
  name: string;
  /** bottom 端（近父 / 骨 head） */
  a: readonly [number, number, number];
  /** top 端（近子 / 骨 tail） */
  b: readonly [number, number, number];
}

/** 列主序 mat4 变换一个点（仿射，w=1），与 services/skeleton-overlay.ts 同算法 */
function tx(
  M: Float32Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    M[0]! * x + M[4]! * y + M[8]! * z + M[12]!,
    M[1]! * x + M[5]! * y + M[9]! * z + M[13]!,
    M[2]! * x + M[6]! * y + M[10]! * z + M[14]!,
  ];
}

// 复用缓冲：每帧重建几何但不能每帧分配（60fps 下会持续制造 GC 压力）。
// 返回的是它的 subarray，调用方必须在本帧内消费（drawFrame 里同步 writeBuffer），
// 下一帧覆盖写是安全的。
//
// ⚠️ **两条路径各用一块**：主视图与绑定面板可能在同一帧各调一次，
// 共用一块会让后一次覆盖掉前一次尚未上传的顶点。
let scratch = new Float32Array(1 << 16);
let scratchSeg = new Float32Array(1 << 16);

function ensureScratch(slot: 'main' | 'seg', n: number): Float32Array {
  let buf = slot === 'main' ? scratch : scratchSeg;
  if (buf.length < n) {
    let cap = buf.length;
    while (cap < n) cap *= 2;
    buf = new Float32Array(cap);
    if (slot === 'main') scratch = buf;
    else scratchSeg = buf;
  }
  return buf;
}

export interface CylinderOverlayOptions {
  /** 圆柱侧面分段数（默认 10） */
  sides?: number;
  /** 整体不透明度（默认 0.3；面板正/侧视建议 0.5，实体感更强） */
  alpha?: number;
  /** 半径整体倍率（默认 1；想让包裹器更"胖"便于观察可设 1.2） */
  radiusScale?: number;
}

/**
 * 把一批骨段写成三角形顶点（两条输入路径的公共核心）。
 *
 * @returns 写入的 float 数；0 表示全部被禁用 / 无骨段
 */
function emitBones(
  out: Float32Array,
  bones: readonly CylBone[],
  cyls: SkinCylinderMap | null,
  sides: number,
  rScale: number,
): number {
  // 圆周采样预计算：所有骨共用一套 sin/cos
  const cosT = new Float64Array(sides);
  const sinT = new Float64Array(sides);
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * Math.PI * 2;
    cosT[s] = Math.cos(a);
    sinT[s] = Math.sin(a);
  }

  let w = 0; // 写入游标（float 单位）
  const push = (
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    r: number, g: number, b: number,
  ): void => {
    out[w++] = px; out[w++] = py; out[w++] = pz;
    out[w++] = nx; out[w++] = ny; out[w++] = nz;
    out[w++] = r; out[w++] = g; out[w++] = b;
  };

  for (const bone of bones) {
    // tip 骨不画圆柱体（见 TIP_BONES：末端控制节点，没有包裹体积）
    if (isTipBone(bone.name)) continue;
    // 空骨名（SkeletonData 缺 jointNames）不查表，走默认半径
    const cyl = bone.name !== '' && cyls !== null ? cyls[bone.name] : undefined;
    if (cyl !== undefined && !cyl.enabled) continue; // 关掉的包裹器不画

    const [ax, ay, az] = bone.a;
    let bx = bone.b[0];
    let by = bone.b[1];
    let bz = bone.b[2];

    let dx = bx - ax;
    let dy = by - ay;
    let dz = bz - az;
    let len = Math.hypot(dx, dy, dz);

    // 默认半径：与 skin-proxy.defaultSkinCylinders 同一公式（骨长 ×0.35，夹 [0.04, 0.22]）
    const def = Math.min(0.22, Math.max(0.04, len * 0.35));
    const rb = (cyl?.radii.bottom ?? def) * rScale;
    const rm = (cyl?.radii.medium ?? def) * rScale;
    const rt = (cyl?.radii.top ?? def) * rScale;

    // 退化骨段（父子重合 / 叶子骨在绑定面板里 a==b）：给一个最小长度，
    // 否则圆柱长度为 0 → 完全不可见，正是"看不到包裹器"的典型成因之一。
    if (len < 1e-5) {
      dx = 0; dy = 1; dz = 0;
      len = Math.max(0.02, rb * 2);
      bx = ax; by = ay + len; bz = az;
    }

    const ux = dx / len, uy = dy / len, uz = dz / len;

    // 与轴正交的基 (v1, v2)：取一个不与轴平行的参考向量做叉积
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

    // 环上一点：轴心 A + d·t，径向偏移 (v1·cos + v2·sin)·r
    const ring = (
      t: number, s: number, r: number,
    ): [number, number, number] => {
      const co = cosT[s]! * r;
      const si = sinT[s]! * r;
      return [
        ax + dx * t + v1x * co + v2x * si,
        ay + dy * t + v1y * co + v2y * si,
        az + dz * t + v1z * co + v2z * si,
      ];
    };
    const ringNormal = (s: number): [number, number, number] => [
      v1x * cosT[s]! + v2x * sinT[s]!,
      v1y * cosT[s]! + v2y * sinT[s]!,
      v1z * cosT[s]! + v2z * sinT[s]!,
    ];

    // ---- 侧壁：bottom / medium / top 三段，各段独立半径与颜色 ----
    const radii = [rb, rm, rt];
    for (let seg = 0; seg < 3; seg++) {
      const r = radii[seg]!;
      const col = SEG_RGB[SEG_ORDER[seg]!];
      const t0 = seg / 3;
      const t1 = (seg + 1) / 3;
      for (let s = 0; s < sides; s++) {
        const s1 = (s + 1) % sides;
        const p00 = ring(t0, s, r);
        const p01 = ring(t0, s1, r);
        const p11 = ring(t1, s1, r);
        const p10 = ring(t1, s, r);
        const n0 = ringNormal(s);
        const n1 = ringNormal(s1);
        // 闭合模式用 cullMode:none，绕序不影响可见性
        push(p00[0], p00[1], p00[2], n0[0], n0[1], n0[2], col[0], col[1], col[2]);
        push(p01[0], p01[1], p01[2], n1[0], n1[1], n1[2], col[0], col[1], col[2]);
        push(p11[0], p11[1], p11[2], n1[0], n1[1], n1[2], col[0], col[1], col[2]);

        push(p00[0], p00[1], p00[2], n0[0], n0[1], n0[2], col[0], col[1], col[2]);
        push(p11[0], p11[1], p11[2], n1[0], n1[1], n1[2], col[0], col[1], col[2]);
        push(p10[0], p10[1], p10[2], n0[0], n0[1], n0[2], col[0], col[1], col[2]);
      }
    }

    // ---- 两端盖：让圆柱体看起来是实心体积而不是套筒 ----
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      const c0 = ring(0, s, rb);
      const c1 = ring(0, s1, rb);
      const cb = SEG_RGB.bottom;
      push(ax, ay, az, -ux, -uy, -uz, cb[0], cb[1], cb[2]);
      push(c0[0], c0[1], c0[2], -ux, -uy, -uz, cb[0], cb[1], cb[2]);
      push(c1[0], c1[1], c1[2], -ux, -uy, -uz, cb[0], cb[1], cb[2]);

      const e0 = ring(1, s, rt);
      const e1 = ring(1, s1, rt);
      const ct = SEG_RGB.top;
      push(bx, by, bz, ux, uy, uz, ct[0], ct[1], ct[2]);
      push(e0[0], e0[1], e0[2], ux, uy, uz, ct[0], ct[1], ct[2]);
      push(e1[0], e1[1], e1[2], ux, uy, uz, ct[0], ct[1], ct[2]);
    }
  }

  return w;
}

/**
 * 由实时关节矩阵构建每 joint 的包裹圆柱体（**主 3D 视口**路径）。
 *
 * @param jointMatrices 本帧关节矩阵（`SceneObject.skinScratch`，列主序，每关节 16 float）
 * @param skeleton      该物体的骨骼（用 `parent` / `jointNames`）
 * @param modelMatrix   物体世界矩阵（把关节位置从模型空间送到世界空间）
 * @param cyls          每骨的包裹器半径；null = 全部用默认半径（骨长 ×0.35，夹 [0.04, 0.22]）
 * @returns 叠加层；无骨骼或全被禁用时为 null
 */
export function buildCylinderOverlay(
  jointMatrices: Float32Array,
  skeleton: SkeletonData,
  modelMatrix: Float32Array,
  cyls: SkinCylinderMap | null,
  opts: CylinderOverlayOptions = {},
): CoreCylinderOverlay | null {
  const parent = skeleton.parent;
  const names = skeleton.jointNames;
  // 关节数：取 parent 表与矩阵实际可容纳数的较小者，防越界
  const n = Math.min(parent.length, Math.floor(jointMatrices.length / 16));
  if (n <= 0) return null;

  // 关节世界坐标（一次算好，父子复用）
  const pos = new Float64Array(n * 3);
  for (let k = 0; k < n; k++) {
    const o = k * 16;
    const w = tx(
      modelMatrix,
      jointMatrices[o + 12]!,
      jointMatrices[o + 13]!,
      jointMatrices[o + 14]!,
    );
    pos[k * 3] = w[0];
    pos[k * 3 + 1] = w[1];
    pos[k * 3 + 2] = w[2];
  }

  const bones: CylBone[] = [];
  for (let k = 0; k < n; k++) {
    const p = parent[k]!;
    if (p < 0 || p >= n) continue; // 根关节无父 → 没有骨段
    const name = names[p] ?? '';
    const a: Vec3 = [pos[p * 3]!, pos[p * 3 + 1]!, pos[p * 3 + 2]!];
    const b: Vec3 = [pos[k * 3]!, pos[k * 3 + 1]!, pos[k * 3 + 2]!];
    // 包裹器位移：整体平移骨段（沿骨局部轴），与算权重的体积一致
    const off = cyls !== null && name !== '' ? cyls[name]?.offset : undefined;
    const ends = offsetSegmentEndpoints(a, b, off);
    bones.push({ name, a: ends.a, b: ends.b });
  }
  if (bones.length === 0) return null;

  const sides = Math.max(6, Math.round(opts.sides ?? 10));
  const alpha = opts.alpha ?? 0.3;
  const rScale = opts.radiusScale ?? 1;

  // 每根骨顶点数：3 段侧壁(3 × sides × 6) + 两端盖(2 × sides × 3) = 24 × sides
  const perBoneVerts = 24 * sides;
  const out = ensureScratch('main', bones.length * perBoneVerts * CYL_VERT_FLOATS);
  const w = emitBones(out, bones, cyls, sides, rScale);
  if (w === 0) return null;
  return { vertices: out.subarray(0, w), alpha };
}

/**
 * 由骨段端点直接构建包裹圆柱体（**绑定面板正/侧视**路径）。
 *
 * 与 `buildCylinderOverlay` 的差别只在输入：面板没有 SkeletonData / 关节矩阵，
 * 只有用户手拖出来的 `positions`。几何、分段、配色、半径公式**完全相同** ——
 * 所以面板里看到的就是主视图里那一批圆柱体，不会有两套形状。
 *
 * @param segs `boneSegments(positions)` 的输出（`{ bone, a, b }`）；
 *             传 null / 空数组表示「不画包裹器」
 * @param cyls 每骨的包裹器半径；null = 全部用默认半径
 */
export function buildCylinderOverlayFromSegments(
  segs: readonly { bone: string; a: readonly [number, number, number]; b: readonly [number, number, number] }[] | null,
  cyls: SkinCylinderMap | null,
  opts: CylinderOverlayOptions = {},
): CoreCylinderOverlay | null {
  if (segs === null || segs.length === 0) return null;

  const bones: CylBone[] = [];
  for (const s of segs) {
    // tip 骨不画圆柱体（见 TIP_BONES）
    if (isTipBone(s.bone)) continue;
    // 包裹器位移：整体平移骨段，与算权重的体积一致
    const off = cyls !== null ? cyls[s.bone]?.offset : undefined;
    const ends = offsetSegmentEndpoints(s.a, s.b, off);
    bones.push({ name: s.bone, a: ends.a, b: ends.b });
  }
  if (bones.length === 0) return null;

  const sides = Math.max(6, Math.round(opts.sides ?? 10));
  const alpha = opts.alpha ?? 0.5;
  const rScale = opts.radiusScale ?? 1;

  const perBoneVerts = 24 * sides;
  const out = ensureScratch('seg', bones.length * perBoneVerts * CYL_VERT_FLOATS);
  const w = emitBones(out, bones, cyls, sides, rScale);
  if (w === 0) return null;
  return { vertices: out.subarray(0, w), alpha };
}
