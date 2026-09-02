/**
 * Transform Gizmo 几何与交互数学（Game Editor）。
 *
 * 几何：在 gizmo 局部空间里生成，长度固定 1.0；真正的大小由渲染器按「距离相机 → 屏幕恒定像素」
 * 算出的缩放系数 k 决定（model = T(origin) · R(space) · S(k)）。
 *   - 移动：X/Y/Z 三色箭头（圆柱杆 + 圆锥头）+ 中心白方块（整体平移）
 *   - 旋转：X/Y/Z 三色圆环（torus）
 *   - 缩放：X/Y/Z 三色方块 + 中心白方块（整体缩放）
 *
 * 颜色用项目 token（红=血红 / 绿=尸绿 / 蓝=电光青），直接写 sRGB（swapchain 非 srgb，post 已自带编码）。
 *
 * 交互数学（hitTest / drag）是纯函数，放在 main.ts，因为它要读相机 ray / viewProj。
 */

import * as m4 from './gpu/math';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type GizmoSpace = 'local' | 'world';

export interface GizmoHandleGPU {
  id: string;
  mode: GizmoMode;
  /** 0/1/2 = 对应轴；-1 = 中心（整体移动 / 整体缩放） */
  axis: 0 | 1 | 2 | -1;
  positions: Float32Array;
  indices: Uint32Array;
  /** 0..1 sRGB */
  color: [number, number, number];
}

const COL = {
  x: hex('#E8402A'),
  y: hex('#8FD14F'),
  z: hex('#2BC4D6'),
  center: hex('#FFFFFF'),
};

function hex(h: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (m === null) return [1, 1, 1];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

type Raw = { p: number[]; idx: number[] };

/** 把沿 +Y 的顶点旋转到目标轴（+X / +Y / +Z） */
function orient(p: number[], axis: 0 | 1 | 2): void {
  if (axis === 1) return;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    if (axis === 0) {
      // (x,y,z) -> (y,-x,z)
      p[i] = y; p[i + 1] = -x; p[i + 2] = z;
    } else {
      // axis 2: (x,y,z) -> (x,-z,y)
      p[i] = x; p[i + 1] = -z; p[i + 2] = y;
    }
  }
}

function pushCylinder(out: Raw, y0: number, y1: number, r: number, seg: number): void {
  const base = out.p.length / 3;
  for (let s = 0; s <= seg; s++) {
    const t = s / seg;
    const a = t * Math.PI * 2;
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    out.p.push(cx, y0, cz);
    out.p.push(cx, y1, cz);
  }
  for (let s = 0; s < seg; s++) {
    const a = base + s * 2;
    out.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

function pushCone(out: Raw, y0: number, y1: number, r: number, seg: number): void {
  const base = out.p.length / 3;
  const apex = out.p.length / 3 + seg + 1;
  for (let s = 0; s <= seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    out.p.push(Math.cos(a) * r, y0, Math.sin(a) * r);
  }
  out.p.push(0, y1, 0); // apex
  for (let s = 0; s < seg; s++) {
    out.idx.push(base + s, base + s + 1, apex);
  }
}

function pushBox(out: Raw, cx: number, cy: number, cz: number, hs: number): void {
  const corners: [number, number, number][] = [
    [-hs, -hs, -hs], [hs, -hs, -hs], [hs, hs, -hs], [-hs, hs, -hs],
    [-hs, -hs, hs], [hs, -hs, hs], [hs, hs, hs], [-hs, hs, hs],
  ].map((c) => [c[0]! + cx, c[1]! + cy, c[2]! + cz] as [number, number, number]);
  const faces = [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
  ];
  const base = out.p.length / 3;
  for (const c of corners) out.p.push(c[0], c[1], c[2]);
  for (const f of faces) out.idx.push(base + f[0]!, base + f[1]!, base + f[2]!, base + f[0]!, base + f[2]!, base + f[3]!);
}

/** 圆环（torus），中心轴 = axis。R=1.0 主半径，r 管半径 */
function pushRing(out: Raw, axis: 0 | 1 | 2, r: number, uSeg: number, vSeg: number): void {
  const base = out.p.length / 3;
  const R = 1.0;
  for (let u = 0; u <= uSeg; u++) {
    const au = (u / uSeg) * Math.PI * 2;
    const cu = Math.cos(au);
    const su = Math.sin(au);
    for (let v = 0; v <= vSeg; v++) {
      const av = (v / vSeg) * Math.PI * 2;
      const cv = Math.cos(av) * r;
      const sv = Math.sin(av) * r;
      // 在「垂直于 axis 的平面」里放主圆，管截面绕主圆
      let x = 0, y = 0, z = 0;
      if (axis === 1) { // 绕 Y：环在 XZ 平面
        x = (R + cv) * cu; z = (R + cv) * su; y = sv;
      } else if (axis === 2) { // 绕 Z：环在 XY 平面
        x = (R + cv) * cu; y = (R + cv) * su; z = sv;
      } else { // 绕 X：环在 YZ 平面
        y = (R + cv) * cu; z = (R + cv) * su; x = sv;
      }
      out.p.push(x, y, z);
    }
  }
  const stride = vSeg + 1;
  for (let u = 0; u < uSeg; u++) {
    for (let v = 0; v < vSeg; v++) {
      const a = base + u * stride + v;
      const b = a + stride;
      out.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

function arrow(axis: 0 | 1 | 2): Raw {
  const r: Raw = { p: [], idx: [] };
  pushCylinder(r, 0, 0.78, 0.035, 14);
  pushCone(r, 0.78, 1.0, 0.11, 16);
  orient(r.p, axis);
  return r;
}

function ring(axis: 0 | 1 | 2): Raw {
  const r: Raw = { p: [], idx: [] };
  pushRing(r, axis, 0.035, 56, 10);
  return r;
}

function boxAt(axis: 0 | 1 | 2, atEnd: boolean): Raw {
  const r: Raw = { p: [], idx: [] };
  const along: [number, number, number] = axis === 0 ? [1, 0, 0] : axis === 1 ? [0, 1, 0] : [0, 0, 1];
  const c = atEnd ? along : [0, 0, 0];
  // 中心方块放在原点；轴方块放在轴末端（1.0 处）
  const p: [number, number, number] = atEnd ? [along[0], along[1], along[2]] : [0, 0, 0];
  pushBox(r, p[0], p[1], p[2], 0.09);
  if (atEnd) orient(r.p, axis);
  void c;
  return r;
}

function toGPU(raw: Raw): { positions: Float32Array; indices: Uint32Array } {
  return { positions: new Float32Array(raw.p), indices: new Uint32Array(raw.idx) };
}

/** 生成全部 gizmo handle 几何（一次性） */
export function buildGizmoHandles(): GizmoHandleGPU[] {
  const axes: (0 | 1 | 2)[] = [0, 1, 2];
  const out: GizmoHandleGPU[] = [];
  for (const ax of axes) {
    out.push({ id: `t${ax}`, mode: 'translate', axis: ax, ...toGPU(arrow(ax)), color: ax === 0 ? COL.x : ax === 1 ? COL.y : COL.z });
    out.push({ id: `r${ax}`, mode: 'rotate', axis: ax, ...toGPU(ring(ax)), color: ax === 0 ? COL.x : ax === 1 ? COL.y : COL.z });
    out.push({ id: `s${ax}`, mode: 'scale', axis: ax, ...toGPU(boxAt(ax, true)), color: ax === 0 ? COL.x : ax === 1 ? COL.y : COL.z });
  }
  out.push({ id: 'tC', mode: 'translate', axis: -1, ...toGPU(boxAt(-1 as 0 | 1 | 2, false)), color: COL.center });
  out.push({ id: 'sC', mode: 'scale', axis: -1, ...toGPU(boxAt(-1 as 0 | 1 | 2, false)), color: COL.center });
  return out;
}

// ===================== 交互数学（纯函数，可单测） =====================

/** 与全项目共用的向量类型（main.ts / 相机 / 拖拽都用它） */
export type V3 = m4.Vec3;

/**
 * 轴约束拖拽平面的法线：平面必须包含该轴，且尽量朝向相机
 * （取视线在垂直于轴方向上的分量）。拖拽期间相机不动，法线恒定。
 */
export function axisPlaneNormal(viewDir: V3, axisDir: V3): V3 {
  const d = m4.v3dot(viewDir, axisDir);
  return m4.v3norm([
    viewDir[0] - axisDir[0] * d,
    viewDir[1] - axisDir[1] * d,
    viewDir[2] - axisDir[2] * d,
  ]);
}

/** 旋转拖拽的平面内正交基（u、w 都 ⊥ 轴；u 由视线决定，拖拽期间稳定） */
export function rotatePlaneBasis(axisDir: V3, viewDir: V3): { u: V3; w: V3 } {
  const u = m4.v3norm(m4.v3cross(axisDir, viewDir));
  const w = m4.v3cross(axisDir, u);
  return { u, w };
}

/** 点 q 在平面基 (u, w) 下相对 origin 的极角 */
export function angleInPlane(q: V3, origin: V3, u: V3, w: V3): number {
  const d: V3 = [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]];
  return Math.atan2(m4.v3dot(d, w), m4.v3dot(d, u));
}

/** 归一化到 (-π, π]：atan2 在 ±180° 处分支跳变，逐帧差值必须过这里，否则连续旋转会 ±2π 瞬转 */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
