/**
 * rig-calibration.ts —— 目标骨架 + 标定 → 运行期 RetargetRig（MR-02）。
 *
 * 两个构造入口（对应编辑器两个 BVH 入口，docs/16 §6）：
 *  1. HumanIK 模板（绑定面板 fit 路径的缺省目标）；
 *  2. 外部 GLB 骨架（SkeletonData，名字/父链/rest 局部 TRS 全来自资产）。
 * 标定（sidecar 的 RetargetCalibration）覆盖：足/掌标记、h_t、支撑平面、
 * 单位/轴向、姿态基准模式。**缺标定时派生代理标记并出警告**——不静默当作精确值。
 *
 * 姿态基准（docs/16 §1 分层）在本文件落成 pre/post 共轭对：
 *   baseline_local(b) = pre[b] · R_src_local(b) · post[b]
 *  - direction（BVH）：pre=A_parent，post=A_b⁻¹（L0 同式）；
 *  - world-rest（glTF→glTF）：R̄ = (W_p^t,0)⁻¹·W_p^s,0·R_s·(W_s,0)⁻¹·W_t,0。
 */

import {
  HUMANIK_BONES,
  HUMANIK_ORDER,
  tposeWorldPositions,
} from '../humanik-template';
import { quatFromUnitVectors, quatMul, type Quat } from '../binding-math';
import { retargetFingerprint, type RetargetCalibration } from '@aether/scene';
import type { NodeLocal, SkeletonData } from '@aether/scene';
import type { RetargetRig, RetargetDiagnostic, RigBone, RigChain, RigMarker, V3 } from './contracts';

// ---------------------------------------------------------------- 数学小件

function conj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function rotateVec(q: Quat, v: V3): [number, number, number] {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function norm3(v: V3): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

function sub3(a: V3, b: V3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add3(a: V3, b: V3): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(a: V3, s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

// ---------------------------------------------------------------- 构造

export interface BuildTargetRigInput {
  /** 外部 GLB 骨架；与 template 二选一，都给时以 skeleton 为准 */
  skeleton?: SkeletonData | null;
  /** sidecar 标定（目标侧）；null = 全部派生 */
  calibration?: RetargetCalibration | null;
  name?: string;
}

export interface BuildTargetRigResult {
  rig: RetargetRig;
  diagnostics: RetargetDiagnostic[];
}

/** 派生足底标记的几何常量（米，相对踝关节；docs/16 失败矩阵「代理标记须报告」） */
const DERIVED_HEEL_BACK_M = 0.05;
const DERIVED_BALL_FWD_M = 0.09;
const DERIVED_ANKLE_HEIGHT_M = 0.03;

const FOOT_BONES = ['LeftFoot', 'RightFoot'] as const;

/**
 * 构造目标 RetargetRig。派生标记落支撑平面（脚底不悬空不穿地），
 * h_t 用「Hips 世界 y − 标记平面 y」，有标定则全部走标定。
 */
export function buildTargetRig(input: BuildTargetRigInput): BuildTargetRigResult {
  const diagnostics: RetargetDiagnostic[] = [];
  const warn = (code: string, message: string): void => {
    diagnostics.push({ severity: 'warning', code: `MRR_${code}`, message });
  };

  const cal = input.calibration ?? null;
  const useTemplate = input.skeleton == null;

  // 目标侧单位/轴向归一（A03）：rest 局部 TRS 在构造期就转成米 + 规范 Y-up。
  // 刚体换基：t' = C·(t·unitScale)，r' = C·r·C⁻¹（C 为 up 轴→Y-up 的固定旋转），
  // 整具骨架被同一刚转携带，父子几何关系不变。
  const unitScale = cal?.unitScale ?? 1;
  const upAxis = cal?.upAxis ?? 'y';
  const qAxis = axisToYQuat(upAxis);
  if (!(unitScale > 0)) {
    diagnostics.push({ severity: 'error', code: 'MRR_UNIT_SCALE_BAD', message: `unitScale ${unitScale} 必须 > 0` });
  }

  // ── 骨表（父先于子）──
  const order: string[] = [];
  const bones: Record<string, RigBone> = {};
  if (useTemplate) {
    if (unitScale !== 1 || upAxis !== 'y') {
      diagnostics.push({
        severity: 'error',
        code: 'MRR_TEMPLATE_NOT_CANONICAL',
        message: '模板目标已是 米/Y-up 规范形态，不接受 unitScale/upAxis 覆盖',
      });
    }
    for (const n of HUMANIK_ORDER) {
      const b = HUMANIK_BONES[n]!;
      order.push(n);
      bones[n] = {
        name: n,
        parent: b.parent,
        restLocalT: [b.tposeOffset[0], b.tposeOffset[1], b.tposeOffset[2]],
        restLocalR: [0, 0, 0, 1],
      };
    }
  } else {
    const sk = input.skeleton!;
    for (let k = 0; k < sk.joints.length; k++) {
      const node = sk.joints[k]!;
      const nm = sk.jointNames[k];
      if (nm === null || nm === undefined) continue;
      order.push(nm);
      const loc = sk.locals[node]!;
      const pIdx = sk.parent[node];
      // 父用 glTF 节点下标反查名字；不在 joints 表里的父（中间节点）按 null 处理
      let parent: string | null = null;
      if (pIdx !== undefined && pIdx >= 0) {
        const pj = sk.joints.indexOf(pIdx);
        parent = pj >= 0 ? (sk.jointNames[pj] ?? null) : null;
      }
      const tScaled: [number, number, number] = [loc.t[0] * unitScale, loc.t[1] * unitScale, loc.t[2] * unitScale];
      bones[nm] = {
        name: nm,
        parent,
        restLocalT: rotateVec(qAxis, tScaled),
        restLocalR: quatMul(qAxis, quatMul([loc.r[0], loc.r[1], loc.r[2], loc.r[3]], conj(qAxis))),
      };
    }
  }

  // ── rest 世界变换（位置 + 旋转，沿父链累乘）──
  const restWorldPos: Record<string, [number, number, number]> = {};
  const restWorldRot: Record<string, Quat> = {};
  for (const n of order) {
    const b = bones[n]!;
    if (b.parent === null || bones[b.parent] === undefined) {
      restWorldPos[n] = [b.restLocalT[0], b.restLocalT[1], b.restLocalT[2]];
      restWorldRot[n] = b.restLocalR as Quat;
    } else {
      const pw = restWorldRot[b.parent]!;
      restWorldRot[n] = quatMul(pw, b.restLocalR as Quat);
      const off = rotateVec(pw, b.restLocalT);
      const pp = restWorldPos[b.parent]!;
      restWorldPos[n] = [pp[0] + off[0], pp[1] + off[1], pp[2] + off[2]];
    }
  }

  // ── 链 ──
  const chainSpecs: Array<{ id: string; joints: string[] }> = [
    { id: 'LeftLeg', joints: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'] },
    { id: 'RightLeg', joints: ['RightUpLeg', 'RightLeg', 'RightFoot'] },
    { id: 'LeftArm', joints: ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'] },
    { id: 'RightArm', joints: ['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'] },
  ];
  const chains: RigChain[] = [];
  for (const cs of chainSpecs) {
    if (cs.joints.every((j) => bones[j] !== undefined)) {
      let len = 0;
      for (let i = 1; i < cs.joints.length; i++) {
        const t = bones[cs.joints[i]!]!.restLocalT;
        len += Math.hypot(t[0], t[1], t[2]);
      }
      chains.push({ id: cs.id, joints: cs.joints, lengthM: len });
    }
  }

  // ── 支撑平面 ──
  let planeOrigin: [number, number, number];
  let planeNormal: [number, number, number];
  if (cal !== null && cal.supportPlane !== undefined) {
    planeNormal = norm3(cal.supportPlane.normal);
    planeOrigin = [cal.supportPlane.origin[0], cal.supportPlane.origin[1], cal.supportPlane.origin[2]];
  } else {
    // 缺省：平面在**脚底**（最低关节再往下一个踝高代理），不是踝关节处——
    // 后者会把 h_t 短 3%（正是 docs/16 §1 批评 L0 computeSkeletonScale 的那类量）
    let minY = Infinity;
    for (const n of order) minY = Math.min(minY, restWorldPos[n]![1]);
    if (!Number.isFinite(minY)) minY = DERIVED_ANKLE_HEIGHT_M;
    planeOrigin = [0, minY - DERIVED_ANKLE_HEIGHT_M, 0];
    planeNormal = [0, 1, 0];
  }

  // ── 标记 ──
  const markers: Record<string, RigMarker> = {};
  if (cal !== null && Object.keys(cal.markers ?? {}).length > 0) {
    for (const [id, mk] of Object.entries(cal.markers)) {
      markers[id] = {
        id,
        bone: mk.bone,
        offset: [mk.offset[0], mk.offset[1], mk.offset[2]],
        origin: mk.origin,
      };
    }
  } else {
    // 派生代理：脚跟/前掌，世界系里落在支撑平面上，再转骨局部
    for (const foot of FOOT_BONES) {
      if (bones[foot] === undefined) continue;
      const ankle = restWorldPos[foot]!;
      const footRot = restWorldRot[foot]!;
      // 前向：Foot → ToeBase 的 rest 世界方向；退化用 +Z
      let fwd: [number, number, number] = [0, 0, 1];
      for (const n of order) {
        if (bones[n]!.parent === foot) {
          const d = sub3(restWorldPos[n]!, ankle);
          if (Math.hypot(d[0], d[1], d[2]) > 1e-9) fwd = norm3(d);
          break;
        }
      }
      // 把 fwd 投影到平面切向（去掉法向分量），避免斜脚时把标记顶出平面
      const tangential = norm3(sub3(fwd, scale3(planeNormal, dot3(fwd, planeNormal))));
      const heelWorld = add3(
        add3(ankle, scale3(tangential, -DERIVED_HEEL_BACK_M)),
        scale3(planeNormal, -DERIVED_ANKLE_HEIGHT_M),
      );
      const ballWorld = add3(
        add3(ankle, scale3(tangential, DERIVED_BALL_FWD_M)),
        scale3(planeNormal, -DERIVED_ANKLE_HEIGHT_M),
      );
      const inv = conj(footRot);
      markers[`${foot}.heel`] = {
        id: `${foot}.heel`,
        bone: foot,
        offset: rotateVec(inv, sub3(heelWorld, ankle)),
        origin: 'derived',
      };
      markers[`${foot}.ball`] = {
        id: `${foot}.ball`,
        bone: foot,
        offset: rotateVec(inv, sub3(ballWorld, ankle)),
        origin: 'derived',
      };
    }
    warn(
      'DERIVED_MARKERS',
      '未提供目标足底标定，使用派生代理标记（脚跟 −5cm / 前掌 +9cm / 踝高 3cm）；精确接触验收前须从网格标定',
    );
  }

  // ── h_t ──
  let pelvisHeightM: number;
  if (cal !== null && typeof cal.pelvisHeightM === 'number' && cal.pelvisHeightM > 0) {
    pelvisHeightM = cal.pelvisHeightM;
  } else {
    const hips = restWorldPos['Hips'];
    if (hips === undefined) {
      pelvisHeightM = 0;
      diagnostics.push({
        severity: 'error',
        code: 'MRR_NO_HIPS',
        message: '目标骨架没有 Hips 骨，无法标定骨盆高度',
      });
    } else {
      pelvisHeightM = hips[1] - planeOrigin[1];
      if (!(pelvisHeightM > 0)) {
        diagnostics.push({
          severity: 'error',
          code: 'MRR_PELVIS_BELOW_PLANE',
          message: `骨盆在支撑平面之下（h_t=${pelvisHeightM}），标定错误`,
        });
      }
    }
  }

  const rotationBaseline = cal?.rotationBaseline ?? 'direction';

  const rig: RetargetRig = {
    name: input.name ?? (useTemplate ? 'humanik-template' : 'external-skeleton'),
    order,
    bones,
    chains,
    markers,
    pelvisHeightM,
    supportPlane: { origin: planeOrigin, normal: planeNormal },
    unitScale,
    upAxis,
    rotationBaseline,
    fingerprint: '',
  };
  rig.fingerprint = retargetFingerprint({
    order,
    bones,
    chains: chains.map((c) => [c.id, c.joints, Math.round(c.lengthM * 1e6)]),
    markers,
    pelvisHeightM: Math.round(pelvisHeightM * 1e6),
    plane: { origin: planeOrigin, normal: planeNormal },
    unitScale,
    upAxis,
    rotationBaseline,
  });
  return { rig, diagnostics };
}

function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** up 轴 → Y-up 的固定刚转（与 source-motion 同约定：Z-up 绕 X −90°） */
function axisToYQuat(axis: 'x' | 'y' | 'z'): Quat {
  if (axis === 'y') return [0, 0, 0, 1];
  if (axis === 'z') {
    const h = (-90 * Math.PI / 180) / 2;
    return [Math.sin(h), 0, 0, Math.cos(h)];
  }
  // X-up：极罕见，与源侧同策略——不重映射（诊断层提示）
  return [0, 0, 0, 1];
}

// ---------------------------------------------------------------- 姿态基准

export interface RotationBaseline {
  mode: 'direction' | 'world-rest';
  /** baseline_local(b) = pre[b] · R_src_local(b) · post[b] */
  pre: Readonly<Record<string, Quat>>;
  post: Readonly<Record<string, Quat>>;
  diagnostics: RetargetDiagnostic[];
}

export interface DirectionBaselineInput {
  /** 源 rest 骨向（HumanIK 名；BVH 用 sourceRestDirections） */
  srcDirections: Record<string, V3>;
}

export interface WorldRestBaselineInput {
  /** 源每骨 rest 世界旋转（glTF→glTF 路径；BVH 恒为 identity，禁用本模式） */
  srcRestWorldRotations: Record<string, Quat>;
}

/**
 * 方向最小弧换基（BVH 姿态基准）。与 L0 同式：
 * A_b = fromTo(d_src_b, d_tgt_b)，pre=A_parent，post=A_b⁻¹；
 * 缺骨向的骨继承父骨（叶子骨常规路径）。
 */
export function computeDirectionBaseline(
  input: DirectionBaselineInput,
  targetRig: RetargetRig,
): RotationBaseline {
  const tgtDirs = targetRestDirections(targetRig);
  const ID: Quat = [0, 0, 0, 1];
  // A_b = fromTo(d_src_b, d_tgt_b)；缺骨向的骨继承父骨的 A（叶子骨常规路径）
  const A: Record<string, Quat> = {};
  for (const b of targetRig.order) {
    const parent = targetRig.bones[b]!.parent;
    const s = input.srcDirections[b];
    const t = tgtDirs[b];
    const sOk = s !== undefined && Math.hypot(s[0], s[1], s[2]) > 1e-9;
    const tOk = t !== undefined && Math.hypot(t[0], t[1], t[2]) > 1e-9;
    if (sOk && tOk) {
      A[b] = quatFromUnitVectors([s![0], s![1], s![2]], [t![0], t![1], t![2]]);
    } else {
      A[b] = parent === null ? ID : (A[parent] ?? ID);
    }
  }
  // baseline_local(b) = A_parent(b) · R_src · A_b⁻¹（L0 同式）
  const pre: Record<string, Quat> = {};
  const post: Record<string, Quat> = {};
  for (const b of targetRig.order) {
    const parent = targetRig.bones[b]!.parent;
    pre[b] = parent === null ? ID : (A[parent] ?? ID);
    post[b] = conj(A[b]!);
  }
  return { mode: 'direction', pre, post, diagnostics: [] };
}

/** 目标骨架每骨的 rest 骨向（第一个子骨方向；叶子骨零向量） */
export function targetRestDirections(rig: RetargetRig): Record<string, V3> {
  const childDir: Record<string, V3> = {};
  for (const n of rig.order) {
    const p = rig.bones[n]!.parent;
    if (p === null) continue;
    const off = rig.bones[n]!.restLocalT;
    const len = Math.hypot(off[0], off[1], off[2]);
    if (len > 1e-9 && childDir[p] === undefined) {
      // 世界方向 = 父 rest 世界旋转 · 局部偏移方向
      // （这里只需要方向对齐的 A；用局部方向再转父世界旋转）
      childDir[p] = [off[0] / len, off[1] / len, off[2] / len];
    }
  }
  // 转世界：父世界旋转作用于局部方向
  const worldRot: Record<string, Quat> = {};
  for (const n of rig.order) {
    const b = rig.bones[n]!;
    worldRot[n] =
      b.parent === null ? (b.restLocalR as Quat) : quatMul(worldRot[b.parent]!, b.restLocalR as Quat);
  }
  const out: Record<string, V3> = {};
  for (const n of rig.order) {
    const d = childDir[n];
    out[n] = d === undefined ? [0, 0, 0] : rotateVec(worldRot[n]!, d);
  }
  return out;
}

/**
 * 世界 rest 换基（glTF→glTF；docs/16 §1：BVH 源禁用——其 rest 世界旋转恒为
 * identity，公式退化为直接拷贝，A-pose 偏移会带进目标）。
 * R̄_b = (W_p^t,0)⁻¹ · W_p^s,0 · R_s · (W_s,0)⁻¹ · W_t,0 ⟹ pre=(W_p^t,0)⁻¹W_p^s,0，post=(W_s,0)⁻¹W_t,0。
 */
export function computeWorldRestBaseline(
  input: WorldRestBaselineInput,
  targetRig: RetargetRig,
): RotationBaseline {
  const diagnostics: RetargetDiagnostic[] = [];
  const allIdentity = Object.values(input.srcRestWorldRotations).every(
    (q) => Math.abs(q[0]) < 1e-12 && Math.abs(q[1]) < 1e-12 && Math.abs(q[2]) < 1e-12,
  );
  if (allIdentity) {
    diagnostics.push({
      severity: 'error',
      code: 'MRR_WORLDREST_ON_IDENTITY_SOURCE',
      message: '源 rest 世界旋转全为 identity（BVH 型源）：world-rest 换基退化为直接拷贝，改用 direction 模式',
    });
  }
  const tgtWorld: Record<string, Quat> = {};
  for (const n of targetRig.order) {
    const b = targetRig.bones[n]!;
    tgtWorld[n] =
      b.parent === null ? (b.restLocalR as Quat) : quatMul(tgtWorld[b.parent]!, b.restLocalR as Quat);
  }
  const pre: Record<string, Quat> = {};
  const post: Record<string, Quat> = {};
  for (const b of targetRig.order) {
    const parent = targetRig.bones[b]!.parent;
    const wsParent = parent === null ? [0, 0, 0, 1] as Quat : (input.srcRestWorldRotations[parent] ?? [0, 0, 0, 1] as Quat);
    const wtParent = parent === null ? [0, 0, 0, 1] as Quat : (tgtWorld[parent] ?? [0, 0, 0, 1] as Quat);
    const wsSelf = input.srcRestWorldRotations[b] ?? ([0, 0, 0, 1] as Quat);
    const wtSelf = tgtWorld[b] ?? ([0, 0, 0, 1] as Quat);
    pre[b] = quatMul(conj(wtParent), wsParent);
    post[b] = quatMul(conj(wsSelf), wtSelf);
  }
  return { mode: 'world-rest', pre, post, diagnostics };
}

// ---------------------------------------------------------------- rest 快照

/** 模板 T-pose 世界坐标（h_t 快照/测试用） */
export function templateRestWorld(): Record<string, [number, number, number]> {
  return tposeWorldPositions();
}

/** SkeletonData 局部 TRS 归一化检查（外部骨架入口的可信度） */
export function skeletonLocalsFinite(sk: SkeletonData): boolean {
  for (const node of sk.joints) {
    const loc: NodeLocal | undefined = sk.locals[node];
    if (loc === undefined) return false;
    const vals = [...loc.t, ...loc.r, ...(loc.s ?? [])];
    if (vals.some((v) => !Number.isFinite(v))) return false;
  }
  return true;
}
