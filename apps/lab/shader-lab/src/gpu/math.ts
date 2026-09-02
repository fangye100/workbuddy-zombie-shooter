/**
 * 最小矩阵库。只为 Shader Lab 服务，列主序（与 WGSL mat4x4f 一致）。
 *
 * 深度范围用 WebGPU 的 [0, 1]（不是 OpenGL 的 [-1, 1]），近平面映射到 0。
 */

export type Mat4 = Float32Array;
export type Vec3 = readonly [number, number, number];

// ===================== 三维向量（纯函数，全项目共用） =====================
// 这些工具曾同时散落在 main.ts 与 gizmo.ts 各写一份，签名还不一致。
// 交互数学（gizmo 命中 / 拖拽 / 相机平移）统一从这里取，保证可单测、可复用。

export function v3(a: readonly number[]): Vec3 {
  return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
}

export function v3sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function v3add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function v3scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function v3dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function v3cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function v3norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** 返回 [1][1]，即 1/tan(fovY/2)，描边的屏幕空间换算要用它 */
export function perspective(out: Mat4, fovY: number, aspect: number, near: number, far: number): number {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return f;
}

export function lookAt(out: Mat4, eye: Vec3, center: Vec3, up: Vec3): void {
  let zx = eye[0] - center[0];
  let zy = eye[1] - center[1];
  let zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-6) {
    zz = 1;
    len = 1;
  }
  zx /= len;
  zy /= len;
  zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) {
    // 视线与 up 平行，随便挑一个正交轴
    xx = 1;
    xy = 0;
    xz = 0;
  } else {
    xx /= len;
    xy /= len;
    xz /= len;
  }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
}

/** out = a * b（列主序，先应用 b） */
export function multiply(out: Mat4, a: Mat4, b: Mat4): void {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!;
    const b1 = b[c * 4 + 1]!;
    const b2 = b[c * 4 + 2]!;
    const b3 = b[c * 4 + 3]!;
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r]! * b0 + a[4 + r]! * b1 + a[8 + r]! * b2 + a[12 + r]! * b3;
    }
  }
}

/** 平移 + 绕 Y 旋转 + 均匀缩放 */
export function compose(
  out: Mat4,
  tx: number,
  ty: number,
  tz: number,
  rotY: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  out[0] = c * sx;
  out[1] = 0;
  out[2] = -s * sx;
  out[3] = 0;
  out[4] = 0;
  out[5] = sy;
  out[6] = 0;
  out[7] = 0;
  out[8] = s * sz;
  out[9] = 0;
  out[10] = c * sz;
  out[11] = 0;
  out[12] = tx;
  out[13] = ty;
  out[14] = tz;
  out[15] = 1;
}

/** 方位角 + 仰角 → 指向光源的单位向量（光从该方向照向原点） */
export function sphericalToDir(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  return [Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce];
}

/** 相机轨道：以 target 为中心，distance 半径，yaw 水平角，pitchDeg 俯角 */
export function orbitEye(
  target: Vec3,
  distance: number,
  yawRad: number,
  pitchDeg: number,
): Vec3 {
  const pitch = (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(pitch);
  return [
    target[0] + Math.sin(yawRad) * cp * distance,
    target[1] + Math.sin(pitch) * distance,
    target[2] + Math.cos(yawRad) * cp * distance,
  ];
}

/**
 * 平移 + 全欧拉旋转（Rz·Ry·Rx）+ 均匀缩放，写入列主序矩阵。
 * 用于编辑器里的「移动 / 旋转」工具：对象 transform = T · R · S。
 */
export function composeEuler(
  out: Mat4,
  tx: number,
  ty: number,
  tz: number,
  rx: number,
  ry: number,
  rz: number,
  s: number,
): void {
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  // R = Rz · Ry · Rx（列主序，元素 r[row*? ]）
  const r00 = cz * cy;
  const r01 = cz * sy * sx - sz * cx;
  const r02 = cz * sy * cx + sz * sx;
  const r10 = sz * cy;
  const r11 = sz * sy * sx + cz * cx;
  const r12 = sz * sy * cx - cz * sx;
  const r20 = -sy;
  const r21 = cy * sx;
  const r22 = cy * cx;

  out[0] = r00 * s;
  out[1] = r10 * s;
  out[2] = r20 * s;
  out[3] = 0;
  out[4] = r01 * s;
  out[5] = r11 * s;
  out[6] = r21 * s;
  out[7] = 0;
  out[8] = r02 * s;
  out[9] = r12 * s;
  out[10] = r22 * s;
  out[11] = 0;
  out[12] = tx;
  out[13] = ty;
  out[14] = tz;
  out[15] = 1;
}

/** 4×4 求逆（列主序，gl-matrix 移植）。用于拾取时的射线反投影。 */
export function invert(out: Mat4, m: Mat4): Mat4 {
  const a00 = m[0]!;
  const a01 = m[1]!;
  const a02 = m[2]!;
  const a03 = m[3]!;
  const a10 = m[4]!;
  const a11 = m[5]!;
  const a12 = m[6]!;
  const a13 = m[7]!;
  const a20 = m[8]!;
  const a21 = m[9]!;
  const a22 = m[10]!;
  const a23 = m[11]!;
  const a30 = m[12]!;
  const a31 = m[13]!;
  const a32 = m[14]!;
  const a33 = m[15]!;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return out; // 不可逆（理论上不会发生，viewProj 永远可逆）
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/**
 * 射线与轴对齐包围盒相交（slab 法）。命中返回进入距离 t（≥0），不命中返回 -1。
 * 拾取的预剔除用：先用 AABB 挡掉绝大多数物体，再对剩下的跑逐三角形 rayTri。
 * 一个物体的 AABB 只需 8 个角点变换，代价约为逐三角形求交的 1/20。
 */
export function rayAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  min: Vec3,
  max: Vec3,
): number {
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const mn = [min[0], min[1], min[2]];
  const mx = [max[0], max[1], max[2]];
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]!) < 1e-12) {
      // 射线平行于这对面：起点在盒子外就直接排除
      if (o[i]! < mn[i]! || o[i]! > mx[i]!) return -1;
      continue;
    }
    const inv = 1 / d[i]!;
    let t1 = (mn[i]! - o[i]!) * inv;
    let t2 = (mx[i]! - o[i]!) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1; // 盒子在射线背后
  return tmin < 0 ? 0 : tmin;
}

/**
 * 射线-三角形相交（Möller–Trumbore，双面），返回沿射线方向的参数 t，不命中返回 -1。
 * 注意：q = t × edge1（曾误写成 t × edge2 导致 v 恒错、拾取全落空，有回归测试把守）。
 */
export function rayTri(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const ez = bz - az;
  const fx = cx - ax;
  const fy = cy - ay;
  const fz = cz - az;
  const px = dy * fz - dz * fy;
  const py = dz * fx - dx * fz;
  const pz = dx * fy - dy * fx;
  const det = ex * px + ey * py + ez * pz;
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det;
  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * ez - tz * ey;
  const qy = tz * ex - tx * ez;
  const qz = tx * ey - ty * ex;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (fx * qx + fy * qy + fz * qz) * inv;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return [1, 1, 1];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number): string =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

// ===================== 四元数（旋转 gizmo 用） =====================
// 约定与 composeEuler 一致：旋转 = Rz(rz) · Ry(ry) · Rx(rx)，列主序。
export type Quat = readonly [number, number, number, number]; // x, y, z, w

export function quatIdentity(): Quat {
  return [0, 0, 0, 1];
}

/** 轴角 → 四元数（axis 不必单位化） */
export function quatAxisAngle(axis: Vec3, angleRad: number): Quat {
  const h = angleRad * 0.5;
  const s = Math.sin(h);
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  return [(axis[0] / len) * s, (axis[1] / len) * s, (axis[2] / len) * s, Math.cos(h)];
}

/** 四元数乘法 q = a * b（Hamilton 积，先应用 b 再应用 a） */
export function quatMul(a: Quat, b: Quat): Quat {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, aw = a[3]!;
  const bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** 欧拉角（弧度，Rz·Ry·Rx）→ 四元数 */
export function eulerToQuat(rx: number, ry: number, rz: number): Quat {
  const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2);
  const cy = Math.cos(ry / 2), sy = Math.sin(ry / 2);
  const cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
  // q = qz * qy * qx
  const qx: Quat = [sx, 0, 0, cx];
  const qy: Quat = [0, sy, 0, cy];
  const qz: Quat = [0, 0, sz, cz];
  return quatMul(quatMul(qz, qy), qx);
}

/** 四元数 → 欧拉角（弧度，Rz·Ry·Rx 提取），仅用于面板显示 */
export function quatToEuler(q: Quat): [number, number, number] {
  const x = q[0]!, y = q[1]!, z = q[2]!, w = q[3]!;
  // 旋转矩阵元素（行,列）
  const m20 = 2 * (x * z - y * w);
  const m21 = 2 * (y * z + x * w);
  const m22 = 1 - 2 * (x * x + y * y);
  const m10 = 2 * (x * y + z * w);
  const m00 = 1 - 2 * (y * y + z * z);
  const ex = Math.atan2(m21, m22);
  const ey = Math.atan2(-m20, Math.hypot(m21, m22));
  const ez = Math.atan2(m10, m00);
  return [ex, ey, ez];
}

/** 平移 + 四元数旋转 + 均匀缩放，写入列主序矩阵（旋转 gizmo 与物体渲染共用） */
export function composeQuat(
  out: Mat4,
  tx: number,
  ty: number,
  tz: number,
  q: Quat,
  s: number,
): void {
  const x = q[0]!, y = q[1]!, z = q[2]!, w = q[3]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  out[0] = s * (1 - (yy + zz));
  out[1] = s * (xy + wz);
  out[2] = s * (xz - wy);
  out[3] = 0;
  out[4] = s * (xy - wz);
  out[5] = s * (1 - (xx + zz));
  out[6] = s * (yz + wx);
  out[7] = 0;
  out[8] = s * (xz + wy);
  out[9] = s * (yz - wx);
  out[10] = s * (1 - (xx + yy));
  out[11] = 0;
  out[12] = tx;
  out[13] = ty;
  out[14] = tz;
  out[15] = 1;
}
