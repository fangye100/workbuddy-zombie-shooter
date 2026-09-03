import { describe, expect, it } from 'vitest';
import {
  HUMANIK_BONES,
  HUMANIK_ORDER,
  mirrorOf,
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
  for (const n of ['LeftForeArm', 'LeftHand'] as const) {
    out[n] = rotZ(placed[n]!, pivot, deg);
  }
  return out;
}

describe('HumanIK 模板', () => {
  it('22 根骨，顺序与父子关系自洽（父骨一定排在子骨之前）', () => {
    expect(HUMANIK_ORDER).toHaveLength(22);
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
    expect(segs).toHaveLength(22);
    const arm = segs.find((s) => s.bone === 'LeftArm')!;
    // LeftArm 的第一个子骨是 LeftForeArm
    expect(arm.b).toEqual(T.LeftForeArm!);
    const hand = segs.find((s) => s.bone === 'LeftHand')!;
    // LeftHand 是叶子 → 退化为点
    expect(hand.a).toEqual(hand.b);
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
      for (let k = 0; k < 4; k++) expect(skin.joints[i * 4 + k]!).toBeLessThan(22);
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
  it('★ 22 根骨骼节点全部无 rotation 字段（ΔR 绝不进骨架）', () => {
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
    expect(skin.joints).toHaveLength(22);
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

  it('inverseBindMatrices = 22 个 mat4，且是纯平移的逆', () => {
    const { verts, idx } = makeMesh(120);
    const res = rigToTPose({
      name: 'probe', vertices: verts, indices: idx, image: null, placed: T,
    });
    const { json } = parseGlb(res.glb);
    const ibmAcc = json.accessors[json.skins[0]!.inverseBindMatrices]!;
    expect(ibmAcc.count).toBe(22);
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
    expect(res.stats.bones).toBe(22);
    expect(res.stats.maxPoseAngleDeg).toBeCloseTo(45, 3);
    // 只有被摆动的那两根骨算"离轴"
    expect(res.stats.offAxisBones.sort()).toEqual(['LeftForeArm', 'LeftHand']);
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
