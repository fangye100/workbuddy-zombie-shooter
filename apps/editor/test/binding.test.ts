import { describe, expect, it } from 'vitest';
import {
  HUMANIK_BONES,
  HUMANIK_ORDER,
  TIP_BONES,
  isTipBone,
  mirrorOf,
  skinBones,
  tposeDirections,
  tposeWorldPositions,
} from '../src/services/binding/humanik-template';
import {
  boneSegments,
  computeLbsWeights,
  distToSegment,
  fitSkeleton,
  matInvertRigid,
  matMul,
  matPoint,
  quatFromUnitVectors,
  unposeMesh,
  unposeNormals,
  type JointPositions,
} from '../src/services/binding/binding-math';
import { rigToTPose } from '../src/services/binding/binding-export';
import {
  defaultSkinCylinders,
  computeCylinderWeights,
  mirrorCylinders,
  mirrorSkinWeights,
  boneLocalBasis,
  offsetSegmentEndpoints,
} from '../src/services/binding/skin-proxy';

/**
 * 绑定面板数学的回归测试（纯 CPU，不需要 WebGPU）。
 *
 * 这里守的是用户反复强调的那一条铁律：
 *
 *   初始 T-pose 的数值**只能采纳 joint 的长度**；
 *   joint 之间的**旋转差值**全都是 currentPose 与 T-pose 之间的 pose 差值。
 *
 * 一旦有人把 ΔR 写进骨架（比如给 node 加 rotation、或让 tposeWorld 带上旋转），
 * bind pose 就不再是干净 T-pose，接入 BVH / 动捕会整条带 offset ——
 * 下面的「T-pose 骨架必须无旋转」「A-pose 手臂在 T-pose 里仍是水平的」两组断言
 * 就是专门拦这个回归的。
 */

const T = tposeWorldPositions();
const DIRS = tposeDirections();

/** 绕 Z 轴旋转（Y-up 空间里，+X 朝左；负角 = 手臂下垂 → A-pose） */
function rotZ(p: readonly [number, number, number], about: readonly [number, number, number], deg: number): [number, number, number] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const x = p[0] - about[0];
  const y = p[1] - about[1];
  return [about[0] + x * c - y * s, about[1] + x * s + y * c, p[2]];
}

/** 把整条左臂链（Arm / ForeArm / Hand）绕 LeftArm 根刚性下垂 deg 度 → A-pose 骨架 */
function poseLeftArm(placed: JointPositions, deg: number): JointPositions {
  const out: JointPositions = JSON.parse(JSON.stringify(placed)) as JointPositions;
  const pivot = out.LeftArm!;
  // tip 必须一起转：它是 LeftHand 的子骨，不转的话手尖会留在 T-pose 位置
  // （等价于「手腕转了、指尖没转」的脱节姿态）
  for (const n of ['LeftForeArm', 'LeftHand', 'LeftHandTip'] as const) {
    out[n] = rotZ(placed[n]!, pivot, deg);
  }
  return out;
}

describe('HumanIK 模板', () => {
  it('27 根骨（22 骨干 + 5 tip），顺序与父子关系自洽（父骨一定排在子骨之前）', () => {
    expect(HUMANIK_ORDER).toHaveLength(27);
    expect(skinBones()).toHaveLength(22);
    expect(TIP_BONES.size).toBe(5);
    const seen = new Set<string>();
    for (const n of HUMANIK_ORDER) {
      const b = HUMANIK_BONES[n];
      expect(b, `缺骨定义: ${n}`).toBeDefined();
      const p = b!.parent;
      if (p !== null) expect(seen.has(p), `父骨 ${p} 必须排在 ${n} 之前`).toBe(true);
      seen.add(n);
    }
  });

  it('T-pose 里手臂沿 ±X 水平外伸（LeftHand.x > 0 且与 LeftArm 同高）', () => {
    // 这是「模板确实是 T-pose」的判据，也是后面 A-pose 反解的参照系
    expect(T.LeftHand![0]).toBeGreaterThan(0.5);
    expect(T.LeftHand![1]).toBeCloseTo(T.LeftArm![1], 6);
    expect(T.RightHand![0]).toBeLessThan(-0.5);
    expect(T.RightHand![1]).toBeCloseTo(T.RightArm![1], 6);
  });

  it('mirrorOf 左右互指，中轴骨返回 null', () => {
    expect(mirrorOf('LeftArm')).toBe('RightArm');
    expect(mirrorOf('RightFoot')).toBe('LeftFoot');
    expect(mirrorOf('Hips')).toBeNull();
    expect(mirrorOf('Spine1')).toBeNull();
  });

  it('tposeDirections 与模板 offset 同向（标准朝向就是 T-pose 里的骨朝向）', () => {
    for (const n of HUMANIK_ORDER) {
      const p = HUMANIK_BONES[n]!.parent;
      if (p === null) continue;
      const a = T[p]!;
      const b = T[n]!;
      const d: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      const u = DIRS[n]!;
      expect(Math.hypot(u[0], u[1], u[2])).toBeCloseTo(1, 9);
      for (let k = 0; k < 3; k++) expect(u[k]).toBeCloseTo(d[k]! / len, 9);
    }
  });
});

describe('fitSkeleton：骨长采纳 / 姿态旋转不入骨架', () => {
  it('骨长 = 实际摆放的两点距离（采纳的是长度，不是模板长度）', () => {
    const placed: JointPositions = JSON.parse(JSON.stringify(T)) as JointPositions;
    // 把左前臂摆长 1.5 倍 —— 这是"模型真实肢体长度"，必须被采纳
    const arm = placed.LeftForeArm!;
    const hand = placed.LeftHand!;
    placed.LeftHand = [hand[0] + (hand[0] - arm[0]) * 0.5, hand[1], hand[2]];
    const fit = fitSkeleton(placed);
    const expectLen = Math.hypot(
      placed.LeftHand[0] - arm[0],
      placed.LeftHand[1] - arm[1],
      placed.LeftHand[2] - arm[2],
    );
    expect(fit.lengths.LeftHand).toBeCloseTo(expectLen, 9);
    expect(fit.lengths.LeftHand).toBeGreaterThan(fit.lengths.LeftForeArm! * 1.2);
  });

  it('A-pose（左臂下垂 45°）：刚体旋转不改变采纳的骨长', () => {
    const posed = poseLeftArm(T, -45);
    const fit = fitSkeleton(posed);
    const tfit = fitSkeleton(T);
    for (const n of HUMANIK_ORDER) {
      // 长度是刚体不变量：垂下手 ≠ 手变长
      expect(fit.lengths[n]).toBeCloseTo(tfit.lengths[n]!, 9);
    }
  });

  it('A-pose：姿态旋转确实被记录下来了（约 45°）', () => {
    const posed = poseLeftArm(T, -45);
    const fit = fitSkeleton(posed);
    const deg = (q: readonly [number, number, number, number]): number =>
      (2 * Math.acos(Math.min(1, Math.abs(q[3])))) * 180 / Math.PI;
    // 前臂与手一起转 → 两者都是 45°；上臂本身没动 → 0°
    expect(deg(fit.poseRotations.LeftForeArm!)).toBeCloseTo(45, 4);
    expect(deg(fit.poseRotations.LeftHand!)).toBeCloseTo(45, 4);
    expect(deg(fit.poseRotations.LeftArm!)).toBeCloseTo(0, 4);
    expect(deg(fit.poseRotations.RightForeArm!)).toBeCloseTo(0, 4);
  });

  it('★ 重建的 T-pose 里，左臂仍然水平（ΔR 没被写进骨架）', () => {
    const posed = poseLeftArm(T, -45);
    const fit = fitSkeleton(posed);
    // 这是这条铁律最直观的判据：模型是垂着手的，但产物骨架必须把手摊平
    expect(fit.tposePositions.LeftForeArm![1]).toBeCloseTo(fit.tposePositions.LeftArm![1], 9);
    expect(fit.tposePositions.LeftHand![1]).toBeCloseTo(fit.tposePositions.LeftForeArm![1], 9);
    // 且摊平后的骨长 = 采纳的骨长
    const seg = Math.hypot(
      fit.tposePositions.LeftHand![0] - fit.tposePositions.LeftForeArm![0],
      fit.tposePositions.LeftHand![1] - fit.tposePositions.LeftForeArm![1],
      fit.tposePositions.LeftHand![2] - fit.tposePositions.LeftForeArm![2],
    );
    expect(seg).toBeCloseTo(fit.lengths.LeftHand!, 9);
  });

  it('★ T-pose 世界矩阵的旋转部分恒为单位矩阵（ΔR 不进骨架）', () => {
    const posed = poseLeftArm(T, -45);
    const fit = fitSkeleton(posed);
    for (const n of HUMANIK_ORDER) {
      const m = fit.tposeWorld[n]!;
      // ⚠️ 列主序：3×3 旋转部分在 m[0,1,2 / 4,5,6 / 8,9,10]，不是连续的 m[0..8]
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 3; row++) {
          expect(m[col * 4 + row]!).toBeCloseTo(col === row ? 1 : 0, 12);
        }
      }
      // 平移列 = 该骨的 T-pose 世界坐标
      const p = fit.tposePositions[n]!;
      expect(m[12]).toBeCloseTo(p[0], 12);
      expect(m[13]).toBeCloseTo(p[1], 12);
      expect(m[14]).toBeCloseTo(p[2], 12);
    }
  });

  it('当前姿态世界矩阵确实带上了旋转（M_P 与 M_T 必须不同，否则反解无从谈起）', () => {
    const posed = poseLeftArm(T, -45);
    const fit = fitSkeleton(posed);
    const mp = fit.posedWorld.LeftForeArm!;
    const mt = fit.tposeWorld.LeftForeArm!;
    let diff = 0;
    for (let k = 0; k < 9; k++) diff += Math.abs(mp[k]! - mt[k]!);
    expect(diff).toBeGreaterThan(0.5);
  });

  it('根骨的 T-pose 位置沿用用户摆放的 Hips（不强行拉回模板高度）', () => {
    const placed: JointPositions = JSON.parse(JSON.stringify(T)) as JointPositions;
    placed.Hips = [0.02, 1.11, -0.03];
    const fit = fitSkeleton(placed);
    expect(fit.tposePositions.Hips![0]).toBeCloseTo(0.02, 12);
    expect(fit.tposePositions.Hips![1]).toBeCloseTo(1.11, 12);
    expect(fit.tposePositions.Hips![2]).toBeCloseTo(-0.03, 12);
  });
});

describe('unposeMesh：网格反解回 T-pose', () => {
  it('★ 单骨权重下反解是精确刚体逆变换（A-pose 顶点被打回 T-pose）', () => {
    const posed = poseLeftArm(T, -45);
    const fit = fitSkeleton(posed);

    // T-pose 下取前臂中点附近的顶点，按"跟着前臂一起下垂"算出它的当前姿态位置
    const vT: [number, number, number] = [
      (T.LeftForeArm![0] + T.LeftHand![0]) / 2,
      T.LeftForeArm![1] - 0.03,
      T.LeftForeArm![2] + 0.02,
    ];
    const vP = rotZ(vT, T.LeftArm!, -45);

    // 手工给 100% 权重到 LeftForeArm（LBS 混合本身不刚体，单骨才能做精确断言）
    const ji = HUMANIK_ORDER.indexOf('LeftForeArm');
    const joints = new Uint16Array([ji, 0, 0, 0]);
    const weights = new Float32Array([1, 0, 0, 0]);

    const verts = new Float32Array(15);
    verts[0] = vP[0]; verts[1] = vP[1]; verts[2] = vP[2];
    const out = unposeMesh(verts, 15, 1, { joints, weights }, fit);
    // 精度取 6 位：顶点存 Float32Array，0.555 附近的 ulp 就有 6e-8，
    // 卡到 1e-9 是在跟 float32 的表示误差较劲，不是在实现较劲。
    expect(out[0]).toBeCloseTo(vT[0], 6);
    expect(out[1]).toBeCloseTo(vT[1], 6);
    expect(out[2]).toBeCloseTo(vT[2], 6);
  });

  it('未被摆动的骨：顶点原地不动（没有姿态差就不该有位移）', () => {
    const posed = poseLeftArm(T, -45);
    const fit = fitSkeleton(posed);
    const v: [number, number, number] = [...T.Hips!] as [number, number, number];
    const ji = HUMANIK_ORDER.indexOf('Hips');
    const verts = new Float32Array(15);
    verts[0] = v[0]; verts[1] = v[1]; verts[2] = v[2];
    const out = unposeMesh(
      verts, 15, 1,
      { joints: new Uint16Array([ji, 0, 0, 0]), weights: new Float32Array([1, 0, 0, 0]) },
      fit,
    );
    expect(out[0]).toBeCloseTo(v[0], 9);
    expect(out[1]).toBeCloseTo(v[1], 9);
    expect(out[2]).toBeCloseTo(v[2], 9);
  });

  it('法线跟着一起转回去，且保持单位长度', () => {
    const posed = poseLeftArm(T, -45);
    const fit = fitSkeleton(posed);
    const ji = HUMANIK_ORDER.indexOf('LeftForeArm');
    // T-pose 法线朝 +Z（手臂侧面朝外），当前姿态下它没被转（绕 Z 转不影响 Z 轴）
    // 改用朝 +Y 的法线，绕 Z 转 -45° 后应指向斜下方，反解后必须回到 +Y
    const nP = ((): [number, number, number] => {
      const r = (-45 * Math.PI) / 180;
      return [0 * Math.cos(r) - 1 * Math.sin(r), 0 * Math.sin(r) + 1 * Math.cos(r), 0];
    })();
    const verts = new Float32Array(15);
    verts[0] = 0; verts[1] = 0; verts[2] = 0;
    verts[3] = nP[0]; verts[4] = nP[1]; verts[5] = nP[2];
    const out = unposeNormals(
      verts, 15, 1,
      { joints: new Uint16Array([ji, 0, 0, 0]), weights: new Float32Array([1, 0, 0, 0]) },
      fit,
    );
    expect(out[3]).toBeCloseTo(0, 9);
    expect(out[4]).toBeCloseTo(1, 9);
    expect(out[5]).toBeCloseTo(0, 9);
    expect(Math.hypot(out[3]!, out[4]!, out[5]!)).toBeCloseTo(1, 9);
  });
});

describe('矩阵与四元数工具', () => {
  it('matMul · matInvertRigid → 单位矩阵（刚体求逆自洽）', () => {
    const posed = poseLeftArm(T, -35);
    const fit = fitSkeleton(posed);
    for (const n of ['LeftForeArm', 'Hips', 'Head'] as const) {
      const mp = fit.posedWorld[n]!;
      const inv = matInvertRigid(mp);
      const id = matMul(mp, inv);
      for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
          expect(id[c * 4 + r]!).toBeCloseTo(c === r ? 1 : 0, 9);
        }
      }
    }
  });

  it('matPoint 与手工旋转一致', () => {
    const posed = poseLeftArm(T, -45);
    const v = rotZ(T.LeftHand!, T.LeftArm!, -45);
    expect(v[0]).toBeCloseTo(posed.LeftHand![0], 9);
    expect(v[1]).toBeCloseTo(posed.LeftHand![1], 9);
  });

  it('matPoint：平移列生效，且与 T-pose 世界矩阵一致（T-pose 无旋转 → 变换即平移）', () => {
    const fit = fitSkeleton(T);
    for (const n of ['Hips', 'LeftHand', 'LeftFoot'] as const) {
      const moved = matPoint(fit.tposeWorld[n]!, [0.1, -0.2, 0.3]);
      const p = fit.tposePositions[n]!;
      expect(moved[0]).toBeCloseTo(p[0] + 0.1, 12);
      expect(moved[1]).toBeCloseTo(p[1] - 0.2, 12);
      expect(moved[2]).toBeCloseTo(p[2] + 0.3, 12);
    }
  });

  it('quatFromUnitVectors：同向 = 单位四元数，反向 = 180°', () => {
    const a: [number, number, number] = [1, 0, 0];
    const same = quatFromUnitVectors(a, [1, 0, 0]);
    expect(same[3]).toBeCloseTo(1, 9);
    const opp = quatFromUnitVectors(a, [-1, 0, 0]);
    expect(Math.abs(opp[3])).toBeCloseTo(0, 9);
    expect(Math.hypot(...opp)).toBeCloseTo(1, 9);
  });

  it('distToSegment：端点外夹到端点，不是无限长直线', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [1, 0, 0];
    expect(distToSegment([0.5, 3, 0], a, b)).toBeCloseTo(3, 9);
    expect(distToSegment([-2, 0, 0], a, b)).toBeCloseTo(2, 9); // 夹到 a，不是 3
    expect(distToSegment([4, 0, 0], a, b)).toBeCloseTo(3, 9); // 夹到 b
  });
});

describe('boneSegments / computeLbsWeights', () => {
  it('骨段 = 骨 head → 第一个子骨 head；叶子骨退化为点', () => {
    const segs = boneSegments(T);
    expect(segs).toHaveLength(27); // 22 骨干 + 5 tip
    const arm = segs.find((s) => s.bone === 'LeftArm')!;
    // LeftArm 的第一个子骨是 LeftForeArm
    expect(arm.b).toEqual(T.LeftForeArm!);
    // Head 的第一个子骨是 HeadTip（tip 也加在头顶）→ 胶囊不再退化为点
    const head = segs.find((s) => s.bone === 'Head')!;
    expect(head.b).toEqual(T.HeadTip!);
    // 真正的叶子只剩 tip 本身（它下面没有子骨）
    const tip = segs.find((s) => s.bone === 'HeadTip')!;
    expect(tip.a).toEqual(tip.b);
  });

  /**
   * tip 存在的全部意义就在这一条：加 tip 之前 LeftHand / LeftToeBase 是叶子，
   * 影响胶囊退化成点 → 手掌 / 脚尖没有可被顶点依附的骨段，末端外形与旋转失控。
   */
  it('★ tip 让末端骨段拿到长度（Head→HeadTip、Hand→HandTip、ToeBase→ToeTip）', () => {
    const segs = boneSegments(T);
    const len = (name: string): number => {
      const s = segs.find((x) => x.bone === name)!;
      return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
    };
    expect(len('Head')).toBeGreaterThan(0);
    expect(len('LeftHand')).toBeGreaterThan(0);
    expect(len('RightHand')).toBeGreaterThan(0);
    expect(len('LeftToeBase')).toBeGreaterThan(0);
    expect(len('RightToeBase')).toBeGreaterThan(0);
    // tip 自己是叶子（b == a），它的胶囊没有长度 —— 所以它不该参与 skin
    expect(len('HeadTip')).toBeCloseTo(0, 9);
    expect(len('LeftHandTip')).toBeCloseTo(0, 9);
    expect(len('RightToeTip')).toBeCloseTo(0, 9);
  });

  it('★ tip 权重恒为 0（不参与 skin 计算），且索引仍与骨序对齐', () => {
    const pts: number[] = [];
    // 刻意把手部周围堆满采样点，逼出「tip 被分到权重」这类回归
    for (let i = 0; i < 64; i++) {
      const t = i / 63;
      pts.push(-0.3 + t * 0.6, 0.2 + t * 1.5, Math.sin(t * 6) * 0.2);
    }
    pts.push(99, 99, 99);
    const N = 65;
    const verts = new Float32Array(N * 15);
    for (let i = 0; i < N; i++) {
      verts[i * 15] = pts[i * 3]!;
      verts[i * 15 + 1] = pts[i * 3 + 1]!;
      verts[i * 15 + 2] = pts[i * 3 + 2]!;
    }
    const segs = boneSegments(T);
    const skin = computeLbsWeights(verts, 15, N, segs);

    const tipIdx = new Set<number>();
    HUMANIK_ORDER.forEach((n, i) => { if (isTipBone(n)) tipIdx.add(i); });
    expect(tipIdx.size).toBe(TIP_BONES.size);

    for (let i = 0; i < N; i++) {
      for (let k = 0; k < 4; k++) {
        const j = skin.joints[i * 4 + k]!;
        // 索引仍是 segs 下标 = HUMANIK_ORDER 下标（没被过滤错位）
        expect(j).toBeLessThan(HUMANIK_ORDER.length);
        if (tipIdx.has(j)) expect(skin.weights[i * 4 + k]!).toBe(0);
      }
    }
  });

  it('权重归一化、无零权重顶点、top-4 上限', () => {
    // 造一批散点（含一个远在天边的离群点，检验兜底逻辑）
    const pts: number[] = [];
    for (let i = 0; i < 64; i++) {
      const t = i / 63;
      pts.push(-0.3 + t * 0.6, 0.2 + t * 1.5, Math.sin(t * 6) * 0.2);
    }
    pts.push(99, 99, 99);
    const verts = new Float32Array(65 * 15);
    for (let i = 0; i < 65; i++) {
      verts[i * 15] = pts[i * 3]!;
      verts[i * 15 + 1] = pts[i * 3 + 1]!;
      verts[i * 15 + 2] = pts[i * 3 + 2]!;
    }
    const skin = computeLbsWeights(verts, 15, 65, boneSegments(T));
    for (let i = 0; i < 65; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += skin.weights[i * 4 + k]!;
      expect(sum).toBeCloseTo(1, 5);
      // 关节索引必须落在有效范围内
      for (let k = 0; k < 4; k++) expect(skin.joints[i * 4 + k]!).toBeLessThan(HUMANIK_ORDER.length);
    }
  });

  it('贴在骨段上的顶点，该骨拿到最大权重', () => {
    const segs = boneSegments(T);
    const upperLeg = segs.find((s) => s.bone === 'LeftUpLeg')!;
    const mid: [number, number, number] = [
      (upperLeg.a[0] + upperLeg.b[0]) / 2,
      (upperLeg.a[1] + upperLeg.b[1]) / 2,
      (upperLeg.a[2] + upperLeg.b[2]) / 2,
    ];
    const verts = new Float32Array(15);
    verts[0] = mid[0]; verts[1] = mid[1]; verts[2] = mid[2];
    const skin = computeLbsWeights(verts, 15, 1, segs);
    const top = skin.joints[0]!;
    expect(HUMANIK_ORDER[top]).toBe('LeftUpLeg');
  });
});

// ─────────────────────────── GLB 产物契约 ───────────────────────────

interface GlbJson {
  nodes: Array<Record<string, unknown>>;
  skins: Array<{ joints: number[]; inverseBindMatrices: number; skeleton: number }>;
  accessors: Array<{ count: number; type: string; componentType: number }>;
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; indices: number }> }>;
  scenes: Array<{ nodes: number[] }>;
}

function parseGlb(buf: ArrayBuffer): { json: GlbJson; bin: Uint8Array } {
  const dv = new DataView(buf);
  expect(dv.getUint32(0, true)).toBe(0x46546c67); // 'glTF'
  expect(dv.getUint32(4, true)).toBe(2);
  expect(dv.getUint32(8, true)).toBe(buf.byteLength);
  const jsonLen = dv.getUint32(12, true);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a); // 'JSON'
  const jsonBytes = new Uint8Array(buf, 20, jsonLen);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes)) as GlbJson;
  const binAt = 20 + jsonLen;
  const binLen = dv.getUint32(binAt, true);
  expect(dv.getUint32(binAt + 4, true)).toBe(0x004e4942); // 'BIN\0'
  return { json, bin: new Uint8Array(buf, binAt + 8, binLen) };
}

function makeMesh(n: number): { verts: Float32Array; idx: Uint32Array } {
  // 沿身体中轴撒点，够 computeLbsWeights 用即可（这里验的是 GLB 结构，不是权重质量）
  const verts = new Float32Array(n * 15);
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    verts[i * 15] = Math.sin(t * 12) * 0.15;
    verts[i * 15 + 1] = 0.05 + t * 1.9;
    verts[i * 15 + 2] = Math.cos(t * 12) * 0.15;
    verts[i * 15 + 3] = 1; // normal.x
    verts[i * 15 + 9] = t; // uv.x
    verts[i * 15 + 10] = 0.5;
  }
  const tri = Math.max(1, Math.floor(n / 3));
  const idx = new Uint32Array(tri * 3);
  for (let t = 0; t < tri * 3; t++) idx[t] = t % n;
  return { verts, idx };
}

describe('rigToTPose：导出的 GLB 契约', () => {
  it('★ 27 根骨骼节点全部无 rotation 字段（ΔR 绝不进骨架）', () => {
    const { verts, idx } = makeMesh(120);
    const res = rigToTPose({
      name: 'probe',
      vertices: verts,
      indices: idx,
      image: null,
      placed: poseLeftArm(T, -45), // A-pose 输入
    });
    const { json } = parseGlb(res.glb);

    const skin = json.skins[0]!;
    expect(skin.joints).toHaveLength(HUMANIK_ORDER.length);
    for (const nodeIdx of skin.joints) {
      const node = json.nodes[nodeIdx]!;
      expect(node.rotation, `骨骼 ${String(node.name)} 不该带 rotation`).toBeUndefined();
      expect(node.scale, `骨骼 ${String(node.name)} 不该带 scale`).toBeUndefined();
      expect(node.translation, `骨骼 ${String(node.name)} 缺 translation`).toBeDefined();
    }
  });

  it('★ 骨骼 translation 的长度 = 采纳的骨长（T-pose 标准朝向 × 骨长）', () => {
    const { verts, idx } = makeMesh(120);
    const placed = poseLeftArm(T, -45);
    const res = rigToTPose({
      name: 'probe', vertices: verts, indices: idx, image: null, placed,
    });
    const { json } = parseGlb(res.glb);
    const skin = json.skins[0]!;

    for (const boneName of HUMANIK_ORDER) {
      const node = json.nodes[skin.joints[HUMANIK_ORDER.indexOf(boneName)]!]!;
      const tr = node.translation as number[];
      const len = Math.hypot(tr[0]!, tr[1]!, tr[2]!);
      const parent = HUMANIK_BONES[boneName]!.parent;
      if (parent === null) {
        // 根骨 = 用户摆放的 Hips 位置
        expect(len).toBeCloseTo(Math.hypot(...placed.Hips!), 9);
      } else {
        expect(len, `${boneName} 的 translation 长度应 = 采纳骨长`).toBeCloseTo(
          res.fit.lengths[boneName]!, 9,
        );
        // 方向 = T-pose 标准朝向（手臂水平，不会跟着 A-pose 垂下去）
        const u = DIRS[boneName]!;
        if (len > 1e-9) {
          for (let k = 0; k < 3; k++) expect(tr[k]! / len).toBeCloseTo(u[k]!, 9);
        }
      }
    }
  });

  it('inverseBindMatrices = 27 个 mat4，且是纯平移的逆', () => {
    const { verts, idx } = makeMesh(120);
    const res = rigToTPose({
      name: 'probe', vertices: verts, indices: idx, image: null, placed: T,
    });
    const { json } = parseGlb(res.glb);
    const ibmAcc = json.accessors[json.skins[0]!.inverseBindMatrices]!;
    expect(ibmAcc.count).toBe(HUMANIK_ORDER.length);
    expect(ibmAcc.type).toBe('MAT4');

    // 直接从 BIN 里读回来验证每一条
    const { bin } = parseGlb(res.glb);
    const view = (json as unknown as { bufferViews: Array<{ byteOffset: number }> })
      .bufferViews[(json.accessors[json.skins[0]!.inverseBindMatrices] as unknown as { bufferView: number }).bufferView]!;
    const f = new Float32Array(bin.buffer, bin.byteOffset + view.byteOffset, 22 * 16);
    for (let i = 0; i < 22; i++) {
      const name = HUMANIK_ORDER[i]!;
      const p = res.fit.tposePositions[name]!;
      // 列主序 mat4：前 3 列是旋转（单位阵），第 4 列才是平移（= −p），别把平移也算进来
      for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 3; row++) {
          expect(f[i * 16 + col * 4 + row]!).toBeCloseTo(col === row ? 1 : 0, 6);
        }
      }
      expect(f[i * 16 + 12]!).toBeCloseTo(-p[0], 6);
      expect(f[i * 16 + 13]!).toBeCloseTo(-p[1], 6);
      expect(f[i * 16 + 14]!).toBeCloseTo(-p[2], 6);
      expect(f[i * 16 + 15]!).toBeCloseTo(1, 6);
    }
  });

  it('网格属性齐全：POSITION / NORMAL / TEXCOORD_0 / JOINTS_0 / WEIGHTS_0', () => {
    const { verts, idx } = makeMesh(120);
    const res = rigToTPose({
      name: 'probe', vertices: verts, indices: idx, image: null, placed: T,
    });
    const { json } = parseGlb(res.glb);
    const attrs = json.meshes[0]!.primitives[0]!.attributes;
    for (const k of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0']) {
      expect(attrs[k], `缺属性 ${k}`).toBeTypeOf('number');
    }
    expect(json.accessors[attrs.POSITION!]!.count).toBe(120);
    expect(json.accessors[attrs.JOINTS_0!]!.type).toBe('VEC4');
    expect(json.accessors[attrs.JOINTS_0!]!.componentType).toBe(5123); // UNSIGNED_SHORT
    expect(json.accessors[attrs.WEIGHTS_0!]!.componentType).toBe(5126); // FLOAT
    expect(json.scenes[0]!.nodes).toEqual([0]);
  });

  it('统计口径：身高刚性不变、零权重顶点为 0', () => {
    const { verts, idx } = makeMesh(120);
    const res = rigToTPose({
      name: 'probe', vertices: verts, indices: idx, image: null, placed: poseLeftArm(T, -45),
    });
    // 反解是刚体变换的加权混合，整体包围盒高度不该跳变
    expect(res.stats.heightAfter).toBeGreaterThan(0);
    expect(Math.abs(res.stats.heightAfter - res.stats.heightBefore)).toBeLessThan(0.35);
    expect(res.stats.zeroWeightVerts).toBe(0);
    expect(res.stats.bones).toBe(HUMANIK_ORDER.length);
    expect(res.stats.maxPoseAngleDeg).toBeCloseTo(45, 3);
    // 臂链整体下垂 45° 时，链上每根骨的**世界朝向**都偏 45°，tip 也一样
    // （tip 虽不参与 skin，但它是真骨架节点，朝向随父骨走，报出来是对的）
    expect(res.stats.offAxisBones.sort()).toEqual(['LeftForeArm', 'LeftHand', 'LeftHandTip']);
  });

  it('顶点数超过 65535 时索引自动升级为 UNSIGNED_INT', () => {
    const { verts, idx } = makeMesh(70000);
    const res = rigToTPose({
      name: 'big', vertices: verts, indices: idx, image: null, placed: T,
    });
    const { json } = parseGlb(res.glb);
    const idxAcc = json.accessors[json.meshes[0]!.primitives[0]!.indices]!;
    expect(idxAcc.componentType).toBe(5125); // UNSIGNED_INT
  });

  it('顶点数组长度不是 stride 整数倍 → 明确抛错（绝不静默填 0）', () => {
    const bad = new Float32Array(100);
    expect(() => rigToTPose({
      name: 'bad', vertices: bad, indices: new Uint32Array([0, 1, 2]), image: null, placed: T,
    })).toThrow(/不是 stride 15 的正整数倍/);
  });
});

describe('skin-proxy：代理圆柱体 Skin Wrapper', () => {
  it('defaultSkinCylinders 覆盖 22 骨干（tip 不产生 wrapper），半径正且有限', () => {
    const cyls = defaultSkinCylinders(T);
    // ⚠️ 这里是 22 不是 26：tip 是末端控制节点，没有自己的包裹体积
    expect(Object.keys(cyls)).toHaveLength(22);
    for (const n of HUMANIK_ORDER) {
      if (isTipBone(n)) {
        expect(cyls[n], `tip 不该有 wrapper: ${n}`).toBeUndefined();
        continue;
      }
      const c = cyls[n]!;
      expect(c.enabled).toBe(true);
      for (const k of ['top', 'medium', 'bottom'] as const) {
        expect(c.radii[k]).toBeGreaterThan(0);
        expect(Number.isFinite(c.radii[k])).toBe(true);
      }
    }
  });

  it('★ 包裹在圆柱体内部的顶点，权重归属该 joint（top 段归属骨 B）', () => {
    const cyls = defaultSkinCylinders(T);
    const seg = boneSegments(T).find((s) => s.bone === 'LeftUpLeg')!;
    const mid: [number, number, number] = [
      (seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2, (seg.a[2] + seg.b[2]) / 2,
    ];
    const verts = new Float32Array(15);
    verts[0] = mid[0]; verts[1] = mid[1]; verts[2] = mid[2];
    const skin = computeCylinderWeights(verts, 15, 1, T, cyls);
    const top = skin.joints[0]!;
    expect(HUMANIK_ORDER[top]).toBe('LeftUpLeg');
    // 归一化、单骨权重占主导
    expect(skin.weights[0]!).toBeGreaterThan(0.9);
  });

  it('★ 被多根 wrapper 包住的顶点按穿透深度做百分比分配（共享，而非某根独占）', () => {
    const cyls = defaultSkinCylinders(T);
    const j = T.LeftLeg!; // 左大腿(LeftUpLeg)与左小腿(LeftLeg)的交界关节
    const verts = new Float32Array(15);
    verts[0] = j[0] + 0.01; verts[1] = j[1]; verts[2] = j[2]; // 关节处微偏，落入相邻两根 wrapper 重叠区
    const skin = computeCylinderWeights(verts, 15, 1, T, cyls);
    const names = [...skin.joints].map((bi) => HUMANIK_ORDER[bi]!);
    const wUp = skin.weights[names.indexOf('LeftUpLeg') as number] ?? 0;
    const wLeg = skin.weights[names.indexOf('LeftLeg') as number] ?? 0;
    // 两根相邻 limb wrapper 都包住该点 → 二者都拿显著权重（共享），不是某一根独占
    expect(wUp).toBeGreaterThan(0.05);
    expect(wLeg).toBeGreaterThan(0.05);
    expect(wUp + wLeg).toBeGreaterThan(0.8);
  });

  it('远离所有 wrapper 的顶点仍得到有效归一化权重（退回最近 wrapper 兜底，无 NaN/零权重）', () => {
    const cyls = defaultSkinCylinders(T);
    const verts = new Float32Array(15);
    verts[0] = 5; verts[1] = 5; verts[2] = 5; // 天外飞点
    const skin = computeCylinderWeights(verts, 15, 1, T, cyls);
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += skin.weights[k]!;
    expect(sum).toBeCloseTo(1, 5);
    for (let k = 0; k < 4; k++) expect(Number.isFinite(skin.weights[k]!)).toBe(true);
  });

  it('mirrorCylinders：左侧半径抄到对侧同名骨', () => {
    const cyls = defaultSkinCylinders(T);
    cyls.LeftArm!.radii.top = 0.31;
    const out = mirrorCylinders(cyls);
    expect(out.RightArm!.radii.top).toBeCloseTo(0.31, 9);
    // 中轴骨保持原样
    expect(out.Hips!.radii.top).toBeCloseTo(cyls.Hips!.radii.top, 9);
  });

  it('★ mirrorSkinWeights：左半顶点（LeftArm 权重）镜像到右半同名对称点（RightArm）', () => {
    // 对称网格：左 (-0.3,1,0) 权重给 LeftArm；右 (0.3,1,0) 故意给 LeftHand（不对称）
    const positions = new Float32Array(2 * 15);
    positions[0] = -0.3; positions[1] = 1; positions[2] = 0;
    positions[15] = 0.3; positions[16] = 1; positions[17] = 0;
    const li = HUMANIK_ORDER.indexOf('LeftArm');
    const hi = HUMANIK_ORDER.indexOf('LeftHand');
    const ri = HUMANIK_ORDER.indexOf('RightArm');
    const joints = new Uint16Array([li, 0, 0, 0, hi, 0, 0, 0]);
    const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]);
    const mirrored = mirrorSkinWeights({ joints, weights }, 15, 2, positions);
    // 右半顶点（index 1）现在应拿到 RightArm 权重（来自左半 LeftArm 的镜像）
    expect(mirrored.joints[4]!).toBe(ri);
    expect(mirrored.weights[4]!).toBeCloseTo(1, 9);
  });

  it('★ offsetSegmentEndpoints：局部轴分量按 axial/v1/v2 正交基平移骨段', () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 2, 0];
    const basis = boneLocalBasis(a, b);
    // axial = +Y，v1 = +X，v2 = -Z（骨骼局部基退化叉乘的确定结果）
    expect(basis.axial).toEqual([0, 1, 0]);
    expect(basis.v1).toEqual([1, 0, 0]);
    expect(basis.v2).toEqual([0, 0, -1]);

    const e = (off: [number, number, number] | undefined) => offsetSegmentEndpoints(a, b, off);
    expect(e(undefined)).toEqual({ a, b });
    // 轴向分量（x）沿 +Y 平移整根骨段
    expect(e([0.3, 0, 0])).toEqual({ a: [0, 0.3, 0], b: [0, 2.3, 0] });
    // 侧向分量（y）沿 +X 平移
    expect(e([0, 0.3, 0])).toEqual({ a: [0.3, 0, 0], b: [0.3, 2, 0] });
    // 前后分量（z）沿 -Z 平移
    expect(e([0, 0, 0.3])).toEqual({ a: [0, 0, -0.3], b: [0, 2, -0.3] });
  });

  it('★ 偏移后的 wrapper 在空域里捕获顶点（offset 沿骨局部前-后轴平移，且方向敏感）', () => {
    const cyls0 = defaultSkinCylinders(T);
    const seg = boneSegments(T).find((s) => s.bone === 'LeftUpLeg')!;
    const basis = boneLocalBasis(seg.a, seg.b);
    const r = cyls0.LeftUpLeg!.radii.medium;
    const D = r + 0.22; // 落到身体外约 0.36m 的空域
    // 点 P 落在「若 wrapper 沿局部前-后(v2)轴平移 +D」后的轴线上（段中点处）
    const mid: [number, number, number] = [
      (seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2, (seg.a[2] + seg.b[2]) / 2,
    ];
    const P: [number, number, number] = [
      mid[0] + basis.v2[0]! * D, mid[1] + basis.v2[1]! * D, mid[2] + basis.v2[2]! * D,
    ];
    const verts = new Float32Array(15);
    verts[0] = P[0]; verts[1] = P[1]; verts[2] = P[2];

    // A：wrapper 朝 P 方向平移 → 捕获 P（绝对体，权重≈1，其余≈0）
    const cylsA = JSON.parse(JSON.stringify(cyls0)) as typeof cyls0;
    cylsA.LeftUpLeg!.offset = [0, 0, D];
    const skinA = computeCylinderWeights(verts, 15, 1, T, cylsA);
    expect(HUMANIK_ORDER[skinA.joints[0]!]).toBe('LeftUpLeg');
    expect(skinA.weights[0]!).toBeGreaterThan(0.9);
    let rest = 0;
    for (let k = 1; k < 4; k++) rest += skinA.weights[k]!;
    expect(rest).toBeLessThan(0.05); // P 在空域，无其他 wrapper 触及

    // B：wrapper 朝相反方向平移 → P 不再被该 wrapper 包住（方向敏感，证明偏移真的生效）
    const cylsB = JSON.parse(JSON.stringify(cyls0)) as typeof cyls0;
    cylsB.LeftUpLeg!.offset = [0, 0, -D];
    const skinB = computeCylinderWeights(verts, 15, 1, T, cylsB);
    const namesB = [...skinB.joints].map((bi) => HUMANIK_ORDER[bi]!);
    const wUpB = skinB.weights[namesB.indexOf('LeftUpLeg') as number] ?? 0;
    expect(wUpB).toBeLessThan(0.5);
  });
});
