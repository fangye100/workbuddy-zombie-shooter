/**
 * 骨骼蒙皮 + 动画求值（Linear Blend Skinning）。
 *
 * 数据全部来自 gltf.ts 解析出的 SkeletonData / AnimClip，渲染器逐帧调用
 * `evalJointMatrices` 把关节矩阵写进 GPU 的 storage buffer（scene.wgsl binding 7）。
 *
 * 空间约定（与 gltf.ts 严格对齐，否则蒙皮会整体错位）：
 *   - 顶点在 gpu/geometry 里已经是「规整化矩阵 T 烘过」的场景空间坐标：
 *       v' = T · (meshNodeWorld · meshLocal) ，T = 平移+缩放+Z-up→Y-up 旋转。
 *   - 关节矩阵在「未规整化的场景根空间」是 world_i · inverseBind_i。
 *     但顶点已经被 T 烘过，所以渲染器需要的是 **T 共轭** 后的关节矩阵：
 *       jointMatrix_i' = T · (world_i · inverseBind_i) · T⁻¹
 *     这样 skinnedPos = Σ wᵢ · jointMatrix_i' · v' = T · (Σ wᵢ · world_i · inverseBind_i · meshLocal)
 *     与顶点走的是同一把尺子，bind pose 时 jointMatrix'=I ⇒ 顶点原样不动。
 *   - 末尾恒等关节永远是 I（未蒙皮 primitive 绑到它，静止不随骨骼动）。
 */

import * as m4 from './gpu/math';
import type { AnimClip, AnimTrack, NodeLocal, SkeletonData } from './gpu/gltf';

/** 一个物体的蒙皮动画播放状态 */
export interface SkinState {
  skeleton: SkeletonData;
  clips: AnimClip[];
  /** 当前片段下标；-1 = 停在 bind pose（不播） */
  clip: number;
  /** 当前片段内的时间（秒） */
  time: number;
  playing: boolean;
  loop: boolean;
  /** 播放速率倍率（1 = 原速，2 = 两倍速，负 = 倒放） */
  speed: number;
}

const IDENT: m4.Mat4 = m4.mat4();

export function createSkinState(skeleton: SkeletonData, clips: AnimClip[]): SkinState {
  return {
    skeleton,
    clips,
    clip: clips.length > 0 ? 0 : -1,
    time: 0,
    playing: clips.length > 0,
    loop: true,
    speed: 1,
  };
}

export function clipCount(s: SkinState): number {
  return s.clips.length;
}

export function clipNames(s: SkinState): string[] {
  return s.clips.map((c) => c.name);
}

export function currentClip(s: SkinState): number {
  return s.clip;
}

export function selectClip(s: SkinState, index: number): void {
  if (index < -1 || index >= s.clips.length) return;
  s.clip = index;
  s.time = 0;
  s.playing = index >= 0;
}

export function play(s: SkinState): void {
  if (s.clip < 0 && s.clips.length > 0) s.clip = 0;
  s.playing = true;
}

export function pause(s: SkinState): void {
  s.playing = false;
}

export function setLoop(s: SkinState, loop: boolean): void {
  s.loop = loop;
}

export function setSpeed(s: SkinState, speed: number): void {
  s.speed = speed;
}

/** 跳到片段内绝对时间（秒），自动夹取/循环 */
export function seek(s: SkinState, time: number): void {
  const dur = s.clip >= 0 ? s.clips[s.clip]!.duration : 0;
  if (dur <= 0) {
    s.time = 0;
    return;
  }
  let t = time;
  if (t < 0) t = 0;
  if (t > dur) t = s.loop ? t % dur : dur;
  s.time = t;
}

/** 推进时间（dt 秒，真实增量；speed 在内部再乘） */
export function advance(s: SkinState, dt: number): void {
  if (!s.playing || s.clip < 0) return;
  const clip = s.clips[s.clip]!;
  const dur = clip.duration;
  if (dur <= 0) return;
  let t = s.time + dt * s.speed;
  if (s.loop) {
    t = ((t % dur) + dur) % dur;
  } else if (t >= dur) {
    t = dur;
    s.playing = false; // 播完停尾帧
  } else if (t < 0) {
    t = 0;
  }
  s.time = t;
}

/** 四元数球面线性插值（glTF 规范：rotation 轨道按 xyzw 存储，与 math.ts Quat 同序） */
function slerp(
  a: Float32Array,
  b: Float32Array,
  f: number,
  ao: number,
  bo: number,
): [number, number, number, number] {
  let ax = a[ao]!, ay = a[ao + 1]!, az = a[ao + 2]!, aw = a[ao + 3]!;
  let bx = b[bo]!, by = b[bo + 1]!, bz = b[bo + 2]!, bw = b[bo + 3]!;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    const r0 = ax + (bx - ax) * f;
    const r1 = ay + (by - ay) * f;
    const r2 = az + (bz - az) * f;
    const r3 = aw + (bw - aw) * f;
    const len = Math.hypot(r0, r1, r2, r3) || 1;
    return [r0 / len, r1 / len, r2 / len, r3 / len];
  }
  const theta0 = Math.acos(Math.min(1, Math.max(-1, dot)));
  const theta = theta0 * f;
  const sin0 = Math.sin(theta0);
  const s0 = Math.sin(theta0 - theta) / sin0;
  const s1 = Math.sin(theta) / sin0;
  return [ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1];
}

/** 采样一段轨道在 time 处的值；返回平铺数组（rotation=stride4，其余=stride3）与是否成功 */
function sampleTrack(tr: AnimTrack, time: number): { value: number[]; ok: boolean } {
  const t = tr.times;
  const n = t.length;
  if (n === 0) return { value: [], ok: false };
  if (time <= t[0]!) return { value: Array.from(tr.values.subarray(0, tr.stride)), ok: true };
  if (time >= t[n - 1]!) {
    const e = (n - 1) * tr.stride;
    return { value: Array.from(tr.values.subarray(e, e + tr.stride)), ok: true };
  }
  let i = 0;
  while (i < n - 1 && t[i + 1]! <= time) i++;
  const t0 = t[i]!, t1 = t[i + 1]!;
  const f = t1 > t0 ? (time - t0) / (t1 - t0) : 0;
  const a = i * tr.stride;
  const b = (i + 1) * tr.stride;
  if (tr.interpolation === 'STEP') {
    return { value: Array.from(tr.values.subarray(a, a + tr.stride)), ok: true };
  }
  if (tr.path === 'rotation') {
    return { value: slerp(tr.values, tr.values, f, a, b), ok: true };
  }
  const out = new Array<number>(tr.stride);
  for (let k = 0; k < tr.stride; k++) {
    out[k] = tr.values[a + k]! * (1 - f) + tr.values[b + k]! * f;
  }
  return { value: out, ok: true };
}

/** 在 bind locals 之上叠加当前片段的动画覆盖，得到逐节点本地 TRS */
function sampleLocals(sk: SkeletonData, clip: AnimClip | null, time: number): NodeLocal[] {
  const locals: NodeLocal[] = sk.locals.map((l) => ({
    t: [l.t[0], l.t[1], l.t[2]],
    r: [l.r[0], l.r[1], l.r[2], l.r[3]],
    s: [l.s[0], l.s[1], l.s[2]],
  }));
  if (clip === null) return locals;
  for (const tr of clip.tracks) {
    const node = tr.node;
    if (node < 0 || node >= locals.length) continue;
    const { value, ok } = sampleTrack(tr, time);
    if (!ok) continue;
    if (tr.path === 'translation') locals[node]!.t = [value[0]!, value[1]!, value[2]!];
    else if (tr.path === 'rotation') locals[node]!.r = [value[0]!, value[1]!, value[2]!, value[3]!];
    else if (tr.path === 'scale') locals[node]!.s = [value[0]!, value[1]!, value[2]!];
  }
  return locals;
}

/** 本地 TRS → 列主序 mat4（per-axis 缩放 + 四元数旋转 + 平移） */
function trsToMat4(out: m4.Mat4, t: readonly number[], r: readonly number[], s: readonly number[]): void {
  const x = r[0]!, y = r[1]!, z = r[2]!, w = r[3]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0]!, sy = s[1]!, sz = s[2]!;
  out[0] = sx * (1 - (yy + zz));
  out[1] = sx * (xy + wz);
  out[2] = sx * (xz - wy);
  out[3] = 0;
  out[4] = sy * (xy - wz);
  out[5] = sy * (1 - (xx + zz));
  out[6] = sy * (yz + wx);
  out[7] = 0;
  out[8] = sz * (xz + wy);
  out[9] = sz * (yz - wx);
  out[10] = sz * (1 - (xx + yy));
  out[11] = 0;
  out[12] = t[0]!;
  out[13] = t[1]!;
  out[14] = t[2]!;
  out[15] = 1;
}

/** 判断 4x4 是否为（足够接近）单位阵 */
function isIdentity(m: Float32Array): boolean {
  for (let i = 0; i < 16; i++) {
    const want = i % 5 === 0 ? 1 : 0; // 对角线为 1，其余为 0
    if (Math.abs(m[i]! - want) > 1e-6) return false;
  }
  return true;
}

// 复用的临时矩阵，避免逐帧分配
const SCRATCH_WORLD: m4.Mat4[] = [];
const SCRATCH_LOCAL = m4.mat4();
const SCRATCH_RAW = m4.mat4();
const SCRATCH_A = m4.mat4();
const SCRATCH_TINV = m4.mat4();
const SCRATCH_JM = m4.mat4();

/**
 * 求当前帧的全部关节矩阵，写入 out（列主序 mat4，长度 = (joints.length+1)*16）。
 * 末尾恒等关节 = I（未蒙皮 primitive 用）。T 来自 skeleton.normalization（可能为 I）。
 *
 * @param out 预分配 Float32Array，长度必须 ≥ (joints.length+1)*16
 */
export function evalJointMatrices(state: SkinState, out: Float32Array): void {
  const sk = state.skeleton;
  const n = sk.joints.length;
  const clip = state.clip >= 0 ? state.clips[state.clip]! : null;
  const locals = sampleLocals(sk, clip, state.time);

  // 逐节点世界矩阵（父子链累乘，与 gltf.ts 解析 inverseBind 同空间）
  while (SCRATCH_WORLD.length < sk.parent.length) SCRATCH_WORLD.push(m4.mat4());
  for (let i = 0; i < sk.parent.length; i++) {
    const L = locals[i]!;
    trsToMat4(SCRATCH_LOCAL, L.t, L.r, L.s);
    const p = sk.parent[i]!;
    const wi = SCRATCH_WORLD[i]!;
    if (p < 0 || SCRATCH_WORLD[p] === undefined) {
      wi.set(SCRATCH_LOCAL);
    } else {
      m4.multiply(wi, SCRATCH_WORLD[p]!, SCRATCH_LOCAL);
    }
  }

  const T = sk.normalization;
  const useT = T !== null && !isIdentity(T);
  if (useT) m4.invert(SCRATCH_TINV, T!);

  for (let k = 0; k < n; k++) {
    const node = sk.joints[k]!;
    const wm = SCRATCH_WORLD[node] ?? IDENT;
    const ib = sk.inverseBind.subarray(k * 16, k * 16 + 16);
    // raw = world · inverseBind
    m4.multiply(SCRATCH_RAW, wm, ib);
    if (useT) {
      // jointMatrix' = T · raw · T⁻¹
      m4.multiply(SCRATCH_A, T!, SCRATCH_RAW);
      m4.multiply(SCRATCH_JM, SCRATCH_A, SCRATCH_TINV);
    } else {
      SCRATCH_JM.set(SCRATCH_RAW);
    }
    out.set(SCRATCH_JM, k * 16);
  }

  // 恒等关节
  const oId = n * 16;
  for (let j = 0; j < 16; j++) out[oId + j] = IDENT[j]!;
}
