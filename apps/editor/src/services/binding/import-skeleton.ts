/**
 * 导入文件骨架（rigged GLB 桥）的纯逻辑：把 `parseGlb` 产出的 `SkeletonData`
 * 映射成 HUMANIK 27 骨摆位表 + 诊断，供「进入绑定 Binding…（导入文件骨架）」
 * 灌进绑定会话（`session.hydrate`）。
 *
 * 空间约定（必须与绑定面板同一把尺，否则骨架与网格对不上）：
 *   - `parseGlb(buf, targetHeight)` 输出的**顶点**已被规整化（默认 2.05m 身高尺）；
 *   - `SkeletonData.locals / parent` 是**原始文件空间**的；`SkeletonData.normalization`
 *     是顶点规整化矩阵 T（v' = T·v，见 gltf.ts 头注释）；
 *   - 因此关节在面板空间里的位置 = T ·（locals 父子链累乘得到的文件空间静止世界位置）。
 *   对我们自己的 MCP 导出（全单位旋转、纯平移链），这退化为「平移累加 + T 点变换」；
 *   对带旋转/缩放的第三方 rig（如 Mixamo 下载件），TRS 合成一项不能少。
 *
 * 名称映射纪律（铁律：断链/异常显式告知，不静默）：
 *   - 先剥 `mixamorig:` / `mixamorig_` 前缀，再精确匹配 HUMANIK_ORDER 白名单；
 *   - 文件里缺的白名单骨 → 保持模板位（列进 `keptTemplate`）；
 *   - 文件里有但映射不上的 → 列进 `unknown`（无名节点给 `#节点下标` 标记）；
 *   - 同名骨重复出现 → 第一个胜出，其余列进 `duplicates`；
 *   - 静止世界坐标含非有限数 → 该骨不映射，列进 `unknown`（带原因）。
 *
 * 本文件是纯 TS：不 import 任何 DOM / node 模块，单测直接跑（vitest，node 环境）。
 */

import type { SkeletonData } from '@aether/scene';
import { HUMANIK_ORDER, tposeWorldPositions, type Vec3 } from './humanik-template';
import {
  matMul,
  matPoint,
  matTranslation,
  quatToMat,
  type JointPositions,
  type Mat4,
} from './binding-math';

/** 导入结果：positions 是全量 27 骨表（导入骨覆盖模板位），可直接进 hydrate */
export interface SkeletonImportResult {
  positions: JointPositions;
  /** 从文件骨架映射成功的 HUMANIK 骨（按 HUMANIK_ORDER 序） */
  imported: string[];
  /** 文件里缺失、保持模板位的 HUMANIK 骨 */
  keptTemplate: string[];
  /** 文件里有但映射不上的骨名（含无名/非有限坐标的标记） */
  unknown: string[];
  /** 重复出现的骨名（第一个胜出，这里列的是被丢弃的后续者） */
  duplicates: string[];
}

/** 缩放矩阵（列主序；binding-math 只有平移/旋转合成，这里补上 S） */
function matScale(sx: number, sy: number, sz: number): Mat4 {
  const m = new Float64Array(16);
  m[0] = sx;
  m[5] = sy;
  m[10] = sz;
  m[15] = 1;
  return m;
}

/** 剥 Mixamo 命名前缀（mixamorig:Hips / mixamorig_Hips → Hips），无前缀原样返回 */
function stripMixamoPrefix(name: string): string {
  return name.replace(/^mixamorig[:_]/i, '');
}

/**
 * 把文件骨架的静止姿态映射成 HUMANIK 摆位表。
 *
 * 世界矩阵用**带备忘录的递归**累乘，不假设节点序（glTF 规范不保证父先子后；
 * 越界父下标与父子环按「断链当根」兜底——损坏文件给最优努力结果，
 * 位置对不对由诊断数字条与渲染兜底暴露，绝不静默崩栈）。
 */
export function skeletonPositionsFromGltf(skel: SkeletonData): SkeletonImportResult {
  // 1. 逐节点静止世界矩阵（文件空间）：world_i = world_parent · TRS(local_i)
  const nodeCount = skel.parent.length;
  const world: (Mat4 | undefined)[] = new Array<Mat4 | undefined>(nodeCount);
  const visiting = new Set<number>();
  const computeWorld = (i: number): Mat4 => {
    const cached = world[i];
    if (cached !== undefined) return cached;
    const L = skel.locals[i]!;
    const local = matMul(
      matMul(matTranslation(L.t[0], L.t[1], L.t[2]), quatToMat(L.r)),
      matScale(L.s[0], L.s[1], L.s[2]),
    );
    const p = skel.parent[i]!;
    // 父下标非法（越界 / 自指 / 环）一律当根处理
    if (p < 0 || p >= nodeCount || p === i || visiting.has(i)) {
      world[i] = local;
      return local;
    }
    visiting.add(i);
    const w = matMul(computeWorld(p), local);
    visiting.delete(i);
    world[i] = w;
    return w;
  };

  // 2. 顶点规整化矩阵（列主序 Float32 → Mat4）；恒等阵时 matPoint 是无害恒等变换
  const norm: Mat4 = new Float64Array(skel.normalization);

  // 3. 逐关节映射（第一个胜出；非有限坐标拒收）
  const humanik = new Set<string>(HUMANIK_ORDER);
  const seen = new Set<string>();
  const mapped = new Map<string, [number, number, number]>();
  const unknown: string[] = [];
  const duplicates: string[] = [];
  for (let k = 0; k < skel.joints.length; k++) {
    const node = skel.joints[k]!;
    const rawName = skel.jointNames[k];
    if (rawName === null || rawName === undefined || rawName === '') {
      unknown.push(`#${node}（无名关节）`);
      continue;
    }
    const name = stripMixamoPrefix(rawName);
    if (!humanik.has(name)) {
      unknown.push(rawName);
      continue;
    }
    if (seen.has(name)) {
      duplicates.push(rawName);
      continue;
    }
    if (node < 0 || node >= nodeCount) {
      unknown.push(`${rawName}（节点下标越界）`);
      continue;
    }
    const w = computeWorld(node);
    const p = matPoint(norm, [w[12]!, w[13]!, w[14]!] as Vec3);
    if (!p.every((v) => Number.isFinite(v))) {
      unknown.push(`${rawName}（静止坐标非有限）`);
      continue;
    }
    seen.add(name);
    mapped.set(name, p);
  }

  // 4. 全量 27 骨表：模板位兜底，导入骨覆盖（保证与上一次会话状态无关的确定性）
  const positions = tposeWorldPositions() as JointPositions;
  for (const [n, p] of mapped) positions[n] = p;

  return {
    positions,
    imported: HUMANIK_ORDER.filter((n) => seen.has(n)),
    keptTemplate: HUMANIK_ORDER.filter((n) => !seen.has(n)),
    unknown,
    duplicates,
  };
}
