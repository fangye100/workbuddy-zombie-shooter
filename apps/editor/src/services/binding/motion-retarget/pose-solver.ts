/**
 * pose-solver.ts —— 共享根 + 接触约束的姿态求解（MR-04，docs/16 §4.2）。
 *
 * 足部 MVP 形态：躯干保持基准（阶段能力限制，非永久 FK 分区），变量 =
 * 共享根平移（3 自由度，yaw 保留不受污染）+ 双腿两骨解析 IK。
 * 双支撑不可达时按最小二乘妥协根位置，逐约束残差显式上报（A10），
 * 绝不静默拉骨。摆动脚走自由基准；净空破坏时抬脚（A17）。
 *
 * Gauss–Newton adjusts only root translation, enforcing inner and outer reach
 * radii with signed radial residuals and the corresponding direction Jacobian.
 * 3×3 法方程 + 阻尼项，收敛/迭代次数记录。
 */

import { quatMul, type Quat } from '../binding-math';
import type {
  ContactSegment,
  RetargetRig,
  SourceMotion,
  V3,
  WorldPoseFrame,
  RetargetDiagnostic,
} from './contracts';
import { solveTwoBone, rotateVec3, swingBetweenDirections } from './two-bone-solver';
import { signedPlaneDistance } from './space-targets';
import type { RetargetRecipeTolerances } from '@aether/scene';

export interface PoseSolveInput {
  targetRig: RetargetRig;
  sourceMotion: SourceMotion;
  /** 每帧每骨的基准局部旋转（direction/world-rest 基准已应用） */
  baselineLocals: readonly Record<string, Quat>[];
  /** 根候选（rootCandidate 输出） */
  rootPositions: Float64Array;
  rootQuats: Float64Array;
  /** 已带锚点的接触段 */
  segments: readonly ContactSegment[];
  tolerances: RetargetRecipeTolerances;
  /**
   * 姿态基准（第三轮复审 P1）：脚的世界朝向任务必须用**映射后**的目标朝向
   * W'_foot = Q_src_foot · D_foot（D = baseline.post）——直接用源世界旋转会把
   * 目标脚的参考坐标系覆盖成源系（Z90 基准被写成 identity，踝位漂移、蒙皮扭转）。
   * 不传时退回源旋转（仅限模板等 D≡I 的场景）。
   */
  baselinePost?: Readonly<Record<string, Quat>>;
  /** GN 迭代上限（默认 8） */
  maxIterations?: number;
}

export interface PoseSolveResult {
  frames: WorldPoseFrame[];
  diagnostics: RetargetDiagnostic[];
  /** 逐段最大锚点偏差（米） */
  anchorDeviations: ReadonlyArray<{ segmentId: string; marker: string; maxM: number }>;
  reachResidualsM: { inner: number; outer: number };
  /** 每帧根修正量（米，Δ 相对候选） */
  rootCorrections: Float64Array;
  iterations: number;
  /** GN 是否全部收敛（无奇异、未在残差未清时打满迭代） */
  converged: boolean;
}

interface RigFK {
  pos: Record<string, [number, number, number]>;
  quat: Record<string, Quat>;
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
function len3(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** 全身基准 FK。根帧语义 = **根骨（Hips）的世界原点 + 完整世界朝向**：
 *  pos[Hips] = rootPos、quat[Hips] = rootQuat —— 根骨的局部旋转**已折进 rootQuat**
 *  （R01：rootQuat 再乘基准局部会把手臂/躯干的源旋转算两遍），基准局部表里根骨项被忽略；
 *  根骨 restLocalT 同样折进 rootPos；子骨按父世界旋转累加偏移。 */
function fkBaseline(rig: RetargetRig, locals: Readonly<Record<string, Quat>>, rootPos: V3, rootQuat: Quat): RigFK {
  const pos: Record<string, [number, number, number]> = {};
  const quat: Record<string, Quat> = {};
  for (const n of rig.order) {
    const b = rig.bones[n]!;
    if (b.parent === null || rig.bones[b.parent] === undefined) {
      quat[n] = rootQuat;
      pos[n] = [rootPos[0], rootPos[1], rootPos[2]];
    } else {
      const local = locals[n] ?? b.restLocalR;
      const pw = quat[b.parent]!;
      quat[n] = quatMul(pw, local);
      const t = b.restLocalT;
      pos[n] = add3(pos[b.parent]!, rotateVec3(pw, [t[0], t[1], t[2]]));
    }
  }
  return { pos, quat };
}

interface LegChainInfo {
  chainId: string;
  hip: string;      // 链根骨（UpLeg）
  knee: string;     // 中间骨（Leg）
  ankle: string;    // 末端骨（Foot）
  l1: number; l2: number;
  markerLocal: V3 | null;
  markerId: string | null;
}

function legChainInfos(rig: RetargetRig): LegChainInfo[] {
  const out: LegChainInfo[] = [];
  for (const ch of rig.chains) {
    if (ch.joints.length !== 3) continue;
    const [hip, knee, ankle] = ch.joints as [string, string, string];
    const l1 = len3(rig.bones[knee]!.restLocalT);
    const l2 = len3(rig.bones[ankle]!.restLocalT);
    // 关联标记：踝骨上的 ball/heel 都可作锚；取 ball 优先
    let markerId: string | null = null;
    for (const [id, mk] of Object.entries(rig.markers)) {
      if (mk.bone === ankle && id.endsWith('.ball')) markerId = id;
    }
    if (markerId === null) {
      for (const [id, mk] of Object.entries(rig.markers)) {
        if (mk.bone === ankle) markerId = id;
      }
    }
    out.push({
      chainId: ch.id,
      hip, knee, ankle,
      l1, l2,
      markerLocal: markerId === null ? null : rig.markers[markerId]!.offset,
      markerId,
    });
  }
  return out;
}

interface ActiveContact {
  seg: ContactSegment;
  leg: LegChainInfo;
  /** 本段引用的确切标记的骨局部偏移（R04：不用腿的"首选标记"替代） */
  markerOffset: V3;
  ankleTarget: V3;
  /** 源脚世界朝向（映射透传） */
  footWorld: Quat;
}

export function solvePose(input: PoseSolveInput): PoseSolveResult {
  const { targetRig: rig, sourceMotion: sm, baselineLocals, rootPositions, rootQuats, segments, tolerances } = input;
  const maxIter = input.maxIterations ?? 8;
  const diagnostics: RetargetDiagnostic[] = [];
  const frames = sm.times.length;
  const legs = legChainInfos(rig);
  const plane = rig.supportPlane;

  // 接触段 → 踝目标（锚点 − R_foot·b；R_foot 用源脚世界朝向，不依赖求解结果）。
  // 只有 support 段硬锁；slide/roll 是 MVP 未覆盖的能力（法向约束/枢轴滚动），
  // 显式报诊断而不是误当支撑锁死（docs/16 失败矩阵「有意滑动被误锁」）。
  const softModes = new Set<string>();
  for (const seg of segments) {
    if (seg.mode !== 'support' && seg.anchor !== null) {
      if (!softModes.has(seg.mode)) {
        softModes.add(seg.mode);
        diagnostics.push({
          severity: 'warning',
          code: 'MRP_MODE_SOFT_MVP',
          message: `接触模式 ${seg.mode} 在足部 MVP 中不硬锁（按自由基准处理），完整支撑留 MR-07/08`,
          constraint: seg.id,
        });
      }
    }
  }
  const warnedConcurrent = new Set<string>();
  const activeAt = (f: number): { active: ActiveContact[]; deferred: ActiveContact[] } => {
    const t = sm.times[f]!;
    const active: ActiveContact[] = [];
    const deferred: ActiveContact[] = [];
    const seenLeg = new Map<string, number>();
    for (const seg of segments) {
      if (seg.mode !== 'support') continue;
      if (seg.anchor === null || t < seg.startS - 1e-9 || t > seg.endS + 1e-9) continue;
      // R04：解析段引用的确切标记（heel 段用 heel 偏移），按标记所在踝骨找链
      const mk = rig.markers[seg.marker];
      if (mk === undefined) continue;
      const leg = legs.find((l) => l.ankle === mk.bone);
      if (leg === undefined) continue;
      const footWorld = mappedFootWorld(sm, leg.ankle, f, input.baselinePost);
      const offset = rotateVec3(footWorld, mk.offset);
      const contact: ActiveContact = {
        seg,
        leg,
        markerOffset: mk.offset,
        ankleTarget: sub3(seg.anchor, offset),
        footWorld,
      };
      const seen = seenLeg.get(leg.chainId) ?? 0;
      seenLeg.set(leg.chainId, seen + 1);
      if (seen > 0) {
        // 同脚多标记同时硬锁 = 各自独立的链求解互相覆盖，MVP 只保留先到段并显式报告；
        // 复审 P1：被跳过的段**必须按最终姿态计残差**（进 anchorDeviations → 质量门禁），
        // 不能静默消失后还报 complete
        deferred.push(contact);
        if (!warnedConcurrent.has(leg.chainId)) {
          warnedConcurrent.add(leg.chainId);
          diagnostics.push({
            severity: 'warning',
            code: 'MRP_CONCURRENT_MARKERS',
            message: `${leg.chainId} 同帧有多个标记接触段（如 ball+heel 同时锁）：MVP 保留首个，其余按最终姿态计残差，联合求解留 MR-07`,
            frame: f,
            constraint: seg.id,
          });
        }
        continue;
      }
      active.push(contact);
    }
    return { active, deferred };
  };

  const outFrames: WorldPoseFrame[] = [];
  const rootCorrections = new Float64Array(frames * 3);
  const anchorDev = new Map<string, { marker: string; maxM: number }>();
  let maxInner = 0;
  let maxOuter = 0;
  let totalIter = 0;
  let converged = true;
  let prevBonePos: Record<string, [number, number, number]> | null = null;

  for (let f = 0; f < frames; f++) {
    const t = sm.times[f]!;
    const candRoot: V3 = [rootPositions[f * 3]!, rootPositions[f * 3 + 1]!, rootPositions[f * 3 + 2]!];
    const rootQ: Quat = [rootQuats[f * 4]!, rootQuats[f * 4 + 1]!, rootQuats[f * 4 + 2]!, rootQuats[f * 4 + 3]!];
    const locals = baselineLocals[f] ?? {};
    const { active: contacts, deferred } = activeAt(f);

    // ── 共享根 GN：残差 = 各活动腿的可达性缺口 ──
    let rootPos: [number, number, number] = [candRoot[0], candRoot[1], candRoot[2]];
    let iter = 0;
    let residualRemains = false;
    for (; iter < maxIter; iter++) {
      const fk = fkBaseline(rig, locals, rootPos, rootQ);
      // 残差向量与雅可比（3 变量）
      const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      const g = [0, 0, 0];
      let any = false;
      for (const c of contacts) {
        const hipPos = fk.pos[c.leg.hip]!;
        const delta = sub3(c.ankleTarget, hipPos);
        const dist = len3(delta);
        const reach = c.leg.l1 + c.leg.l2;
        const inner = Math.abs(c.leg.l1 - c.leg.l2);
        const r = dist > reach ? dist - reach : dist < inner ? dist - inner : 0;
        if (Math.abs(r) <= 1e-10 * Math.max(1, reach)) continue;
        any = true;
        // Signed radial error: positive pulls the pelvis toward a far target;
        // negative pushes it away from an unreachable inner-sphere target.
        const u = dist > 1e-12 ? scale3(delta, 1 / dist) : scale3(plane.normal, -1);
        const w = 1 / Math.max(1e-6, reach);
        for (let i = 0; i < 3; i++) {
          g[i]! += w * r * u[i]!;
          for (let j = 0; j < 3; j++) {
            // dr/du 数值上由 u 主导；阻尼 GN 里 J≈w·u·uᵀ 已够（信赖域小步）
            A[i * 3 + j]! += w * u[i]! * u[j]!;
          }
        }
      }
      if (!any) break;
      // 阻尼解 3×3
      const lambda = 1e-6;
      for (let i = 0; i < 3; i++) A[i * 3 + i]! += lambda;
      const step = solve3(A, g);
      if (step === null) {
        diagnostics.push({ severity: 'warning', code: 'MRP_GN_SINGULAR', message: `第 ${f} 帧根修正线性系统奇异，保留当前根`, frame: f });
        residualRemains = true;
        break;
      }
      rootPos = [rootPos[0] + step[0]!, rootPos[1] + step[1]!, rootPos[2] + step[2]!];
    }
    if (iter >= maxIter && contacts.length > 0) {
      const finalFK = fkBaseline(rig, locals, rootPos, rootQ);
      residualRemains = contacts.some(c => {
        const d = len3(sub3(c.ankleTarget, finalFK.pos[c.leg.hip]!));
        const outer = c.leg.l1 + c.leg.l2;
        const inner = Math.abs(c.leg.l1 - c.leg.l2);
        return Math.max(d - outer, inner - d) > 1e-10 * Math.max(1, outer);
      });
    }
    converged = converged && !residualRemains;
    totalIter += iter;
    rootCorrections[f * 3] = rootPos[0] - candRoot[0];
    rootCorrections[f * 3 + 1] = rootPos[1] - candRoot[1];
    rootCorrections[f * 3 + 2] = rootPos[2] - candRoot[2];

    // ── 最终姿态：躯干基准 + 腿 IK ──
    const fk = fkBaseline(rig, locals, rootPos, rootQ);
    const bonePos: Record<string, [number, number, number]> = { ...fk.pos };
    const boneQuat: Record<string, Quat> = { ...fk.quat };
    const contactLegs = new Set<string>();
    const controlledBones = new Set<string>();

    for (const c of contacts) {
      const leg = c.leg;
      contactLegs.add(leg.chainId);
      for (const bone of [leg.hip, leg.knee, leg.ankle]) controlledBones.add(bone);
      const hipPos = fk.pos[leg.hip]!;
      const sol = solveTwoBone({
        root: hipPos,
        tip: c.ankleTarget,
        l1: leg.l1,
        l2: leg.l2,
        poleHint: sub3(fk.pos[leg.knee]!, hipPos), // 基准膝方向作 pole
        prevKnee: prevBonePos === null ? null : (prevBonePos[leg.knee] ?? null),
      });
      if (sol.status === 'clamped-out') {
        maxOuter = Math.max(maxOuter, sol.residualM);
        diagnostics.push({
          severity: 'warning',
          code: 'MRP_REACH_OUTER',
          message: `第 ${f} 帧 ${leg.chainId} 不可达（超出 ${(leg.l1 + leg.l2).toFixed(3)}m 达 ${sol.residualM.toFixed(4)}m），已夹取并报残差`,
          frame: f,
          constraint: c.seg.id,
        });
      } else if (sol.status === 'clamped-in') {
        maxInner = Math.max(maxInner, sol.residualM);
        diagnostics.push({
          severity: 'warning',
          code: 'MRP_REACH_INNER',
          message: `第 ${f} 帧 ${leg.chainId} 过近（距最小可达 ${sol.residualM.toFixed(4)}m）`,
          frame: f,
          constraint: c.seg.id,
        });
      }
      bonePos[leg.knee] = sol.knee;
      bonePos[leg.ankle] = sol.reachedTip;
      // 旋转（R02：WorldPoseFrame.boneQuat 一律存**世界**旋转；局部轨道只由 bake 派生）：
      // 大腿/小腿对齐当前方向；脚保持源世界朝向（A06/A18）
      // Rotate the mapped animation frame, retaining its axial twist. Rest-only
      // reconstruction discards source twist even when the endpoint is unchanged.
      const worldHip = quatMul(swingFromTo(sub3(fk.pos[leg.knee]!, hipPos), sub3(sol.knee, hipPos)), fk.quat[leg.hip]!);
      boneQuat[leg.hip] = worldHip;
      const worldKnee = quatMul(swingFromTo(sub3(fk.pos[leg.ankle]!, fk.pos[leg.knee]!), sub3(sol.reachedTip, sol.knee)), fk.quat[leg.knee]!);
      boneQuat[leg.knee] = worldKnee;
      boneQuat[leg.ankle] = c.footWorld;
      // 锚点偏差验收：最终脚变换下重算标记世界点
      const markerWorld = add3(sol.reachedTip, rotateVec3(c.footWorld, c.markerOffset));
      const dev = len3(sub3(markerWorld, c.seg.anchor!));
      const rec = anchorDev.get(c.seg.id);
      if (rec === undefined) anchorDev.set(c.seg.id, { marker: c.seg.marker, maxM: dev });
      else rec.maxM = Math.max(rec.maxM, dev);
    }

    // 被跳过的并发约束：按最终姿态计锚点残差（进入 anchorDeviations → 质量门禁）
    for (const c of deferred) {
      const ankle = bonePos[c.leg.ankle]!;
      const q = boneQuat[c.leg.ankle]!;
      const markerWorld = add3(ankle, rotateVec3(q, c.markerOffset));
      const dev = len3(sub3(markerWorld, c.seg.anchor!));
      const rec = anchorDev.get(c.seg.id);
      if (rec === undefined) anchorDev.set(c.seg.id, { marker: c.seg.marker, maxM: dev });
      else rec.maxM = Math.max(rec.maxM, dev);
    }

    // ── 摆动脚：基准保持 + 净空保护（A17）──
    for (const leg of legs) {
      if (contactLegs.has(leg.chainId) || leg.markerLocal === null) continue;
      const anklePos = bonePos[leg.ankle]!;
      const footQ = boneQuat[leg.ankle]!;
      const markerWorld = add3(anklePos, rotateVec3(footQ, leg.markerLocal));
      const clearance = signedPlaneDistance(markerWorld, plane);
      if (clearance < -tolerances.penetrationH * rig.pelvisHeightM) {
        for (const bone of [leg.hip, leg.knee, leg.ankle]) controlledBones.add(bone);
        // 沿法向抬踝，让标记回到支撑面（软修正；残差进诊断）
        const lift = scale3(plane.normal, -clearance);
        const hipPos = bonePos[leg.hip]!;
        const sol = solveTwoBone({
          root: hipPos,
          tip: add3(anklePos, lift),
          l1: leg.l1,
          l2: leg.l2,
          poleHint: sub3(bonePos[leg.knee]!, hipPos),
          prevKnee: null,
        });
        bonePos[leg.knee] = sol.knee;
        bonePos[leg.ankle] = sol.reachedTip;
        const worldHip = quatMul(swingFromTo(sub3(fk.pos[leg.knee]!, hipPos), sub3(sol.knee, hipPos)), fk.quat[leg.hip]!);
        boneQuat[leg.hip] = worldHip;
        const worldKnee = quatMul(swingFromTo(sub3(fk.pos[leg.ankle]!, fk.pos[leg.knee]!), sub3(sol.reachedTip, sol.knee)), fk.quat[leg.knee]!);
        boneQuat[leg.knee] = worldKnee;
        boneQuat[leg.ankle] = footQ;
        diagnostics.push({
          severity: 'info',
          code: 'MRP_SWING_CLEARANCE_LIFT',
          message: `第 ${f} 帧摆动脚 ${leg.chainId} 净空破坏，抬脚 ${(-clearance * 1000).toFixed(1)}mm`,
          frame: f,
          constraint: leg.chainId,
        });
      }
    }

    // IK also moves side branches attached to thighs and shins. Rebuild every
    // non-controlled descendant, retaining the solved chain's world transforms.
    refreshDerivedBones(rig, bonePos, boneQuat, controlledBones, locals);
    outFrames.push({ t, rootPos, rootQuat: rootQ, bonePos, boneQuat });
    prevBonePos = bonePos;
  }

  return {
    frames: outFrames,
    diagnostics,
    anchorDeviations: [...anchorDev.entries()].map(([segmentId, v]) => ({ segmentId, marker: v.marker, maxM: v.maxM })),
    reachResidualsM: { inner: maxInner, outer: maxOuter },
    rootCorrections,
    iterations: totalIter,
    converged,
  };
}

/**
 * Reattach descendants to the corrected world frame while preserving mapped local
 * animation. Bones without a source track retain their target reference rotation.
 */
function refreshDerivedBones(
  rig: RetargetRig,
  bonePos: Record<string, [number, number, number]>,
  boneQuat: Record<string, Quat>,
  controlled: ReadonlySet<string>,
  locals: Readonly<Record<string, Quat>>,
): void {
  for (const n of rig.order) {
    const b = rig.bones[n]!;
    if (b.parent === null || controlled.has(n)) continue;
    const pq = boneQuat[b.parent]!;
    const t = rig.bones[n]!.restLocalT;
    boneQuat[n] = quatMul(pq, locals[n] ?? rig.bones[n]!.restLocalR as Quat);
    const off = rotateVec3(pq, [t[0], t[1], t[2]]);
    const pp = bonePos[b.parent]!;
    bonePos[n] = [pp[0] + off[0], pp[1] + off[1], pp[2] + off[2]];
  }
}

/** 源脚世界旋转映射到目标参考系：Q_src · D（缺基准/缺骨时退回源旋转） */
function mappedFootWorld(
  sm: SourceMotion,
  ankle: string,
  f: number,
  post?: Readonly<Record<string, Quat>>,
): Quat {
  const rot = sm.worldRotations[ankle];
  if (rot === undefined) return [0, 0, 0, 1];
  const q: Quat = [rot[f * 4]!, rot[f * 4 + 1]!, rot[f * 4 + 2]!, rot[f * 4 + 3]!];
  const d = post?.[ankle];
  return d === undefined ? q : quatMul(q, d);
}

/** swing(restWorldDir → currentDir)·参考系；两向量自动归一化（退化给 identity） */
function swingFromTo(restDir: V3, curDir: V3): Quat {
  return swingBetweenDirections(restDir, curDir);
}

/** 3×3 线性解（高斯消元；奇异返回 null） */
function solve3(A: number[], b: number[]): [number, number, number] | null {
  const m = [
    [A[0]!, A[1]!, A[2]!, b[0]!],
    [A[3]!, A[4]!, A[5]!, b[1]!],
    [A[6]!, A[7]!, A[8]!, b[2]!],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    }
    if (Math.abs(m[piv]![col]!) < 1e-12) return null;
    const tmp = m[col]!;
    m[col] = m[piv]!;
    m[piv] = tmp;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = m[r]![col]! / m[col]![col]!;
      for (let c = col; c < 4; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  return [
    m[0]![3]! / m[0]![0]!,
    m[1]![3]! / m[1]![1]!,
    m[2]![3]! / m[2]![2]!,
  ];
}
