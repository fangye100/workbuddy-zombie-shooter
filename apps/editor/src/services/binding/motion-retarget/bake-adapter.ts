/**
 * bake-adapter.ts —— 规范世界解 → 指定输出骨架的节点局部轨道（MR-06 数学核心）。
 *
 * docs/16 §5 烘焙转换契约：先把世界解转到输出坐标系，再
 *   M_local = inv(M_parent_world) · M_joint_world → 局部 TRS。
 * 根骨有容器/骨架父节点时同规则（rootParentWorld），不只对四肢转换。
 * 支持正的统一父缩放；非均匀缩放/反射/shear 无法经刚性骨架表达 → 显式拒绝。
 * 未出现在解里的骨保持 rest（不出轨道），不丢轨道也不伪造。
 */

import type { Quat, RetargetDiagnostic, V3, WorldSolveClip } from './contracts';
import { quatMul } from '../binding-math';

export interface BakeBone {
  name: string;
  parent: string | null;
  restLocalT: V3;
  restLocalR: Quat;
  /** 输出图里的 glTF 节点下标（轨道 target 用） */
  nodeIndex: number;
  /** rest 统一缩放（默认 1；非统一在构造侧就该被拒） */
  restUniformScale?: number;
}

export interface BakeOutputRig {
  order: readonly string[];
  bones: Readonly<Record<string, BakeBone>>;
  fingerprint: string;
  /** 根骨父容器（骨架父节点/Armature）的世界变换；null = 根直接挂场景原点 */
  rootParentWorld?: { pos: V3; quat: Quat; uniformScale: number } | null;
}

export interface LocalTrack {
  bone: string;
  nodeIndex: number;
  times: Float64Array;
  /** (frames × 4) xyzw */
  rotations: Float64Array;
  /** (frames × 3)；根骨才有（非根保持 rest 局部平移） */
  translations: Float64Array | null;
}

export interface BakeResult {
  tracks: LocalTrack[] | null;
  diagnostics: RetargetDiagnostic[];
}

function conj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/**
 * R08：骨局部平移的**累计缩放** = rootParent 缩放 × 所有严格祖先（含父）的 restUniformScale。
 * glTF T·R·S 语义下，child 世界偏移 = parentQ·(t_child · cum(child))；
 * 只乘直接父缩放会漏容器/更高祖先，读回就会验证自己造出的错值。
 */
function cumulativeScales(output: BakeOutputRig): Map<string, number> {
  const rootParent = output.rootParentWorld ?? null;
  const cum = new Map<string, number>();
  for (const n of output.order) {
    const b = output.bones[n]!;
    if (b.parent === null || output.bones[b.parent] === undefined) {
      cum.set(n, rootParent?.uniformScale ?? 1);
    } else {
      cum.set(n, (cum.get(b.parent) ?? 1) * (output.bones[b.parent]!.restUniformScale ?? 1));
    }
  }
  return cum;
}

/** 某骨世界变换；解/帧里没有时沿父链 rest FK（锚在最近已解祖先） */
function worldOfBone(
  name: string,
  solved: { bonePos: Record<string, V3>; boneQuat: Record<string, Quat> },
  output: BakeOutputRig,
  cache: Map<string, { pos: V3; quat: Quat }>,
): { pos: V3; quat: Quat } {
  const cum = cumulativeScales(output);
  return worldOfBoneScaled(name, solved, output, cache, cum);
}

function worldOfBoneScaled(
  name: string,
  solved: { bonePos: Record<string, V3>; boneQuat: Record<string, Quat> },
  output: BakeOutputRig,
  cache: Map<string, { pos: V3; quat: Quat }>,
  cum: Map<string, number>,
): { pos: V3; quat: Quat } {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let result: { pos: V3; quat: Quat };
  if (solved.boneQuat[name] !== undefined) {
    result = { pos: solved.bonePos[name]!, quat: solved.boneQuat[name]! };
  } else {
    const b = output.bones[name]!;
    if (b.parent === null || output.bones[b.parent] === undefined) {
      const rp = output.rootParentWorld ?? null;
      if (rp !== null) {
        const q = quatMul(rp.quat, b.restLocalR);
        const off = rotate(rp.quat, [b.restLocalT[0] * rp.uniformScale, b.restLocalT[1] * rp.uniformScale, b.restLocalT[2] * rp.uniformScale]);
        result = { pos: [rp.pos[0] + off[0], rp.pos[1] + off[1], rp.pos[2] + off[2]], quat: q };
      } else {
        result = { pos: b.restLocalT, quat: b.restLocalR };
      }
    } else {
      const pw = worldOfBoneScaled(b.parent, solved, output, cache, cum);
      const q = quatMul(pw.quat, b.restLocalR);
      const sCum = cum.get(name) ?? 1;
      const off = rotate(pw.quat, [b.restLocalT[0] * sCum, b.restLocalT[1] * sCum, b.restLocalT[2] * sCum]);
      result = { pos: [pw.pos[0] + off[0], pw.pos[1] + off[1], pw.pos[2] + off[2]], quat: q };
    }
  }
  cache.set(name, result);
  return result;
}

function rotateInv(q: Quat, v: V3): [number, number, number] {
  return rotate(conj(q), v);
}

function rotate(q: Quat, v: V3): [number, number, number] {
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

export function bakeWorldSolveToLocal(clip: WorldSolveClip, output: BakeOutputRig): BakeResult {
  const diagnostics: RetargetDiagnostic[] = [];

  // 可表达性检查：rest 缩放必须为正的统一值（非统一/负缩放不经此路径表达）
  for (const b of Object.values(output.bones)) {
    const s = b.restUniformScale ?? 1;
    if (!(s > 0)) {
      diagnostics.push({ severity: 'error', code: 'MRB_SCALE', message: `${b.name} 的缩放 ${s} 非正，刚性骨架无法表达` });
    }
  }
  if (clip.skeletonFingerprint !== output.fingerprint) {
    diagnostics.push({
      severity: 'error',
      code: 'MRB_SKELETON_MISMATCH',
      message: `世界解的骨架指纹与输出骨架不一致（${clip.skeletonFingerprint} vs ${output.fingerprint}），拒绝烘焙`,
    });
    return { tracks: null, diagnostics };
  }

  const rootParent = output.rootParentWorld ?? null;
  const tracks: LocalTrack[] = [];
  const cachePerFrame: Map<string, { pos: V3; quat: Quat }>[] = clip.frames.map(() => new Map());
  const cum = cumulativeScales(output);
  // R08：非根骨没有平移轨道（固定骨长契约），世界解必须能被 rest 偏移×累计缩放复现；
  // 复现不了 = 解里带了刚性骨架表达不了的自由度 → 显式拒绝，不静默丢偏差
  const inexpressible = (bone: string, frame: number, devM: number): void => {
    diagnostics.push({
      severity: 'error',
      code: 'MRB_INEXPRESSIBLE',
      message: `${bone} 第 ${frame} 帧的世界位置偏离 rest 偏移可达位置 ${devM.toFixed(6)}m：非根骨无平移自由度，拒绝烘焙`,
      frame,
      constraint: bone,
    });
  };
  const frames = clip.frames.length;
  const times = clip.times;

  for (const name of output.order) {
    const b = output.bones[name]!;
    let hasAny = false;
    for (const fr of clip.frames) {
      if (fr.boneQuat[name] !== undefined) {
        hasAny = true;
        break;
      }
    }
    if (!hasAny) {
      diagnostics.push({
        severity: 'info',
        code: 'MRB_BONE_NOT_SOLVED',
        message: `${name} 不在世界解里，保持 rest（不出轨道）`,
      });
      continue;
    }

    const rotations = new Float64Array(frames * 4);
    const translations = b.parent === null || output.bones[b.parent] === undefined ? new Float64Array(frames * 3) : null;

    for (let f = 0; f < frames; f++) {
      const fr = clip.frames[f]!;
      const cache = cachePerFrame[f]!;
      const wq = fr.boneQuat[name]!;
      const wp = fr.bonePos[name]!;

      let parentWorldQ: Quat;
      let parentWorldP: V3;
      let parentScale = 1;
      if (b.parent === null || output.bones[b.parent] === undefined) {
        if (rootParent !== null) {
          parentWorldQ = rootParent.quat;
          parentWorldP = rootParent.pos;
          parentScale = rootParent.uniformScale;
        } else {
          parentWorldQ = [0, 0, 0, 1];
          parentWorldP = [0, 0, 0];
        }
      } else {
        const p = output.bones[b.parent]!;
        const pw = worldOfBone(p.name, fr, output, cache);
        parentWorldQ = pw.quat;
        parentWorldP = pw.pos;
        parentScale = p.restUniformScale ?? 1;
      }

      // 局部旋转 = inv(parentQ) · worldQ
      const localR = quatMul(conj(parentWorldQ), wq);
      rotations[f * 4] = localR[0];
      rotations[f * 4 + 1] = localR[1];
      rotations[f * 4 + 2] = localR[2];
      rotations[f * 4 + 3] = localR[3];

      // 局部平移 = inv(parentQ) · (worldP − parentP) / cum(bone)（R08：累计缩放，非仅直接父）
      if (translations !== null) {
        const d: V3 = [wp[0] - parentWorldP[0], wp[1] - parentWorldP[1], wp[2] - parentWorldP[2]];
        const lt = rotateInv(parentWorldQ, d);
        const invS = 1 / (cum.get(name) ?? parentScale);
        translations[f * 3] = lt[0] * invS;
        translations[f * 3 + 1] = lt[1] * invS;
        translations[f * 3 + 2] = lt[2] * invS;
      } else {
        // 可表达性验收：非根骨世界位置必须等于 父世界 · (rest 偏移 × 累计缩放)
        const expected = rotate(parentWorldQ, [
          b.restLocalT[0] * (cum.get(name) ?? 1),
          b.restLocalT[1] * (cum.get(name) ?? 1),
          b.restLocalT[2] * (cum.get(name) ?? 1),
        ]);
        const dev = Math.hypot(
          wp[0] - parentWorldP[0] - expected[0],
          wp[1] - parentWorldP[1] - expected[1],
          wp[2] - parentWorldP[2] - expected[2],
        );
        if (dev > 1e-5) inexpressible(name, f, dev);
      }
    }
    tracks.push({ bone: name, nodeIndex: b.nodeIndex, times: times.slice(), rotations, translations });
  }

  if (diagnostics.some((d) => d.severity === 'error')) {
    return { tracks: null, diagnostics };
  }
  return { tracks, diagnostics };
}

/** 烘焙读回验证（A15 口径）：局部轨道 FK 回世界，与原世界解比对 */
export function readBackWorld(
  tracks: readonly LocalTrack[],
  output: BakeOutputRig,
  frames: number,
): Array<Record<string, { pos: V3; quat: Quat }>> {
  const trackOf = new Map<string, LocalTrack>();
  for (const t of tracks) trackOf.set(t.bone, t);
  const rootParent = output.rootParentWorld ?? null;
  const cumRb = cumulativeScales(output); // R08：读回同样用累计缩放，否则验证自己造出的错值
  const out: Array<Record<string, { pos: V3; quat: Quat }>> = [];
  for (let f = 0; f < frames; f++) {
    const frame: Record<string, { pos: V3; quat: Quat }> = {};
    // 增量视图：随遍历（父先于子）填充，worldOfBone 对已重建祖先直接命中
    const posView: Record<string, V3> = {};
    const quatView: Record<string, Quat> = {};
    for (const name of output.order) {
      const b = output.bones[name]!;
      const t = trackOf.get(name);
      if (t === undefined) {
        const w = worldOfBone(name, { bonePos: posView, boneQuat: quatView }, output, new Map());
        frame[name] = { pos: w.pos, quat: w.quat };
        posView[name] = w.pos;
        quatView[name] = w.quat;
        continue;
      }
      const localR: Quat = [t.rotations[f * 4]!, t.rotations[f * 4 + 1]!, t.rotations[f * 4 + 2]!, t.rotations[f * 4 + 3]!];
      const parent = b.parent !== null && output.bones[b.parent] !== undefined ? (frame[b.parent] ?? null) : null;
      if (parent === null) {
        if (rootParent !== null) {
          const wq = quatMul(rootParent.quat, localR);
          const lt: V3 = t.translations === null ? b.restLocalT : [t.translations[f * 3]!, t.translations[f * 3 + 1]!, t.translations[f * 3 + 2]!];
          const wp = rotate(rootParent.quat, [lt[0] * rootParent.uniformScale, lt[1] * rootParent.uniformScale, lt[2] * rootParent.uniformScale]);
          frame[name] = { pos: [rootParent.pos[0] + wp[0], rootParent.pos[1] + wp[1], rootParent.pos[2] + wp[2]], quat: wq };
        } else {
          const lt: V3 = t.translations === null ? b.restLocalT : [t.translations[f * 3]!, t.translations[f * 3 + 1]!, t.translations[f * 3 + 2]!];
          frame[name] = { pos: [lt[0]!, lt[1]!, lt[2]!], quat: localR };
        }
        posView[name] = frame[name]!.pos;
        quatView[name] = frame[name]!.quat;
      } else {
        const wq = quatMul(parent.quat, localR);
        const sCum = cumRb.get(name) ?? 1;
        const lt: V3 = t.translations === null ? b.restLocalT : [t.translations[f * 3]!, t.translations[f * 3 + 1]!, t.translations[f * 3 + 2]!];
        const off = rotate(parent.quat, [lt[0] * sCum, lt[1] * sCum, lt[2] * sCum]);
        frame[name] = { pos: [parent.pos[0] + off[0], parent.pos[1] + off[1], parent.pos[2] + off[2]], quat: wq };
        posView[name] = frame[name]!.pos;
        quatView[name] = frame[name]!.quat;
      }
    }
    out.push(frame);
  }
  return out;
}
