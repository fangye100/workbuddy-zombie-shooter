/**
 * bvh-parser.ts — 通用 BVH（Biovision Hierarchy）解析 + HumanIK 骨骼名映射。
 *
 * 与 Python 侧 `assets/characters/_tools/retarget_bvh.py` 是同一套约定，但这里做成
 * **通用解析器**：不假定 Mixamo 前缀、不假定帧率、不假定单位、不假定 up 轴。
 *
 * ## BVH 格式要点（写解析器时必须守的三条）
 *
 * 1. **通道列顺序 = 深度优先声明序**。MOTION 每行有 `dof` 个数，按关节声明
 *    （`CHANNELS` 出现）的先后排列 —— 不是括号闭合序。所以列号必须在读到
 *    `CHANNELS` 的那一刻就分配，不能等 `}` 再分配。
 * 2. **`End Site` 不是关节**，不占通道列，但它的 `OFFSET` 定义了**叶子骨的朝向**
 *    （Head / Hand / ToeBase 的骨向只有从它才能读出来）。
 * 3. **rest 姿态没有旋转**。BVH 里关节的全部朝向信息都在 `OFFSET` 里，
 *    MOTION 全 0 的那一帧 = 源的 rest pose（T-pose 或 A-pose，取决于 OFFSET）。
 *    这一点是 retarget.ts 做 rest-pose 对齐的全部依据。
 *
 * ## 不做的事
 *  - 不猜单位。`unitScale` 只用于报告；真正的缩放在 retarget 里由「腿长比」导出，
 *    比值天然把 cm→m 一起吸收掉，不需要阈值猜测。
 *  - 不静默丢关节。没对上号的 BVH 关节进 `unmatched`，对不上号的 HumanIK 骨进
 *    `missingBones`，交给调用方决定是报错还是忽略。
 */

export type Vec3 = readonly [number, number, number];

/** End Site 的内部占位名（BVH 里它没有名字，但要进解析栈） */
const END_SITE = '\u0000EndSite';

export interface BvhJoint {
  name: string;
  parent: string | null;
  /** 相对父关节的 rest 平移（源单位，可能是 cm 也可能是 m） */
  offset: Vec3;
  /** 原始通道名全量（含 position），顺序 = 声明序 */
  channels: string[];
  /** 原始旋转通道名，顺序 = BVH 欧拉序，如 ['Zrotation','Yrotation','Xrotation'] */
  rotChannels: string[];
  /** 子关节名（不含 End Site） */
  children: string[];
  /** End Site 的 OFFSET；没有则为 null。叶子骨的朝向来源 */
  endOffset: Vec3 | null;
  /** 该关节首列在 MOTION 行里的下标 */
  column: number;
  /** 第一个旋转通道的列号；无旋转通道为 -1 */
  rotColumn: number;
  /** 第一个位置通道（Xposition）的列号；无位置通道为 -1 */
  posColumn: number;
}

export interface BvhFile {
  /** 根关节名（通常是 Hips / Pelvis） */
  root: string;
  joints: Record<string, BvhJoint>;
  /** 深度优先声明序 = MOTION 通道排列序 */
  order: string[];
  /** (frameCount × dof) 行主序平铺；第 f 帧从 `f * dof` 开始 */
  frames: Float64Array;
  frameCount: number;
  /** 每帧浮点数个数 */
  dof: number;
  frameTime: number;
  fps: number;
  /**
   * up 轴下标：0=X 1=Y 2=Z。由「根骨 → 第一个子骨的 OFFSET」主轴判定
   * （Mixamo / CMU 都是 Y-up；Vicon 导出常见 Z-up）。
   */
  upAxis: 0 | 1 | 2;
  /**
   * 源骨架的**推测**单位换算（1 = 已是米，0.01 = 厘米）。仅用于报告与日志，
   * retarget 的缩放不依赖它（见文件头「不做的事」）。
   */
  unitScale: number;
  /** 源 rest 骨架沿 up 轴的高度（源单位），用于报告 */
  skeletonHeight: number;
  /** 因列数不足而整行丢弃的 MOTION 行数（0 = 干净） */
  droppedRows: number;
}

/** 解析期抛出的错误；全部带行号，不做静默兜底 */
class BvhParseError extends Error {
  constructor(msg: string, line: number) {
    super(`BVH 解析失败（第 ${line + 1} 行）：${msg}`);
    this.name = 'BvhParseError';
  }
}

interface Frame {
  name: string;
  parent: string | null;
  offset: number[];
  channels: string[];
  rotChannels: string[];
  children: string[];
  endOffset: Vec3 | null;
  column: number;
  rotColumn: number;
  posColumn: number;
  declaredAt: number;
}

/**
 * 解析 BVH 文本。任何结构错误都直接抛（绝不静默填 0 —— 静默填 0 会让
 * 骨骼朝向悄悄变成零向量，反解出来的动画看着「动了一点点」，是最难查的 bug）。
 */
export function parseBvh(text: string): BvhFile {
  const lines = text.split(/\r?\n/);

  // ── HIERARCHY ──
  let i = 0;
  while (i < lines.length && lines[i]!.trim().toUpperCase() !== 'HIERARCHY') i++;
  if (i >= lines.length) throw new BvhParseError('缺少 HIERARCHY 段', lines.length);
  i++;

  const joints: Record<string, BvhJoint> = {};
  const order: string[] = [];
  const stack: Frame[] = [];
  let column = 0;
  let root = '';

  for (; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '') continue;
    const up = raw.toUpperCase();

    if (up === 'MOTION') {
      i++;
      break;
    }

    if (up === '{') continue;

    if (up === '}') {
      const f = stack.pop();
      if (f === undefined) throw new BvhParseError('多余的 }', i);
      const parent = stack.length > 0 ? stack[stack.length - 1]! : null;
      if (f.name === END_SITE) {
        // End Site 只贡献朝向，不占通道列
        if (parent !== null) {
          parent.endOffset = [f.offset[0]!, f.offset[1]!, f.offset[2]!];
        }
        continue;
      }
      if (f.name in joints) throw new BvhParseError(`关节重名：${f.name}`, i);
      const j: BvhJoint = {
        name: f.name,
        parent: f.parent,
        offset: [f.offset[0]!, f.offset[1]!, f.offset[2]!],
        channels: f.channels,
        rotChannels: f.rotChannels,
        children: f.children,
        endOffset: f.endOffset,
        column: f.column,
        rotColumn: f.rotColumn,
        posColumn: f.posColumn,
      };
      joints[f.name] = j;
      if (parent !== null) parent.children.push(f.name);
      continue;
    }

    // 节点声明：ROOT / JOINT / End Site
    if (up === 'END SITE' || up.startsWith('END SITE')) {
      stack.push({
        name: END_SITE,
        parent: null,
        offset: [0, 0, 0],
        channels: [],
        rotChannels: [],
        children: [],
        endOffset: null,
        column: -1,
        rotColumn: -1,
        posColumn: -1,
        declaredAt: i,
      });
      continue;
    }
    const mJoint = /^(ROOT|JOINT)\s+(.+)$/i.exec(raw);
    if (mJoint !== null) {
      const name = mJoint[2]!.trim();
      const parent = stack.length > 0 ? stack[stack.length - 1]!.name : null;
      if (name === '') throw new BvhParseError('关节名为空', i);
      if (name in joints) throw new BvhParseError(`关节重名：${name}`, i);
      if (parent === null) {
        if (root !== '') throw new BvhParseError(`出现第二个根关节：${name}`, i);
        root = name;
      }
      // 顺序必须在**声明这一刻**记录：MOTION 的列序、rest 世界坐标的累加序
      // 都是前序（父先于子），而括号闭合是后序 —— 两者不能混用。
      order.push(name);
      stack.push({
        name,
        parent,
        offset: [0, 0, 0],
        channels: [],
        rotChannels: [],
        children: [],
        endOffset: null,
        column: -1,
        rotColumn: -1,
        posColumn: -1,
        declaredAt: i,
      });
      continue;
    }

    const top = stack.length > 0 ? stack[stack.length - 1]! : null;
    if (top === null) continue;

    if (up.startsWith('OFFSET')) {
      const nums = raw.slice(6).trim().split(/\s+/);
      if (nums.length < 3) throw new BvhParseError(`OFFSET 需要 3 个数，实得 ${nums.length}`, i);
      const a = Number(nums[0]);
      const b = Number(nums[1]);
      const c = Number(nums[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
        throw new BvhParseError(`OFFSET 含非数值：${raw}`, i);
      }
      top.offset = [a, b, c];
      continue;
    }

    if (up.startsWith('CHANNELS')) {
      const parts = raw.split(/\s+/);
      const n = Number(parts[1]);
      if (!Number.isInteger(n) || n < 0) throw new BvhParseError(`CHANNELS 数量非法：${raw}`, i);
      const chs = parts.slice(2, 2 + n);
      if (chs.length !== n) {
        throw new BvhParseError(`CHANNELS 声明 ${n} 个但实得 ${chs.length} 个`, i);
      }
      top.channels = chs;
      top.rotChannels = chs.filter((c) => c.toLowerCase().endsWith('rotation'));
      // 列号必须在声明这一刻分配：MOTION 的列序 = 声明序（见文件头要点 1）
      top.column = column;
      const ri = chs.findIndex((c) => c.toLowerCase().endsWith('rotation'));
      top.rotColumn = ri >= 0 ? column + ri : -1;
      const pi = chs.findIndex((c) => c.toLowerCase().endsWith('position'));
      top.posColumn = pi >= 0 ? column + pi : -1;
      column += n;
      continue;
    }
  }

  if (root === '') throw new BvhParseError('没有根关节（ROOT）', i);
  if (stack.length > 0) throw new BvhParseError(`括号未闭合，还剩 ${stack.length} 层`, i);

  const dof = column;
  if (dof === 0) throw new BvhParseError('没有任何通道（dof = 0）', i);

  // ── MOTION ──
  let frameCount = 0;
  let frameTime = 1 / 30;
  for (; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '') continue;
    const up = raw.toUpperCase();
    if (up.startsWith('FRAMES:')) {
      const v = Number(raw.slice(7).trim());
      if (!Number.isInteger(v) || v < 0) throw new BvhParseError(`Frames 数量非法：${raw}`, i);
      frameCount = v;
      continue;
    }
    if (up.startsWith('FRAME TIME:')) {
      const v = Number(raw.slice(11).trim());
      if (!Number.isFinite(v) || v <= 0) throw new BvhParseError(`Frame Time 非法：${raw}`, i);
      frameTime = v;
      continue;
    }
    if (/^[+-]?[\d.]/.test(raw)) break; // 进了数据行
  }

  const rows: number[] = [];
  let truncated = 0;
  for (; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '') continue;
    const nums = raw.split(/\s+/);
    if (nums.length < dof) {
      // 缺列的行整行丢弃：补齐会污染后续所有帧的列对齐
      truncated++;
      continue;
    }
    for (let k = 0; k < dof; k++) {
      const v = Number(nums[k]);
      rows.push(Number.isFinite(v) ? v : 0);
    }
    if (frameCount > 0 && rows.length / dof >= frameCount) {
      i++;
      break;
    }
  }

  if (rows.length === 0) throw new BvhParseError('MOTION 段没有可用的帧数据', i);

  const actualFrames = Math.floor(rows.length / dof);
  if (actualFrames < 2) {
    throw new BvhParseError(`可用帧数 ${actualFrames} < 2，无法构成动画`, i);
  }

  const frames = new Float64Array(actualFrames * dof);
  frames.set(rows.slice(0, actualFrames * dof));

  const upAxis = detectUpAxis(joints, root);
  const restWorld = restWorldPositions(joints, order);
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of order) {
    const y = restWorld[n]![upAxis];
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const skeletonHeight = hi - lo;

  return {
    root,
    joints,
    order,
    frames,
    frameCount: actualFrames,
    dof,
    frameTime,
    fps: 1 / frameTime,
    upAxis,
    unitScale: skeletonHeight > 5 ? 0.01 : 1,
    skeletonHeight,
    droppedRows: truncated,
  };
}

/** up 轴 = 根骨 → 第一个子骨的 OFFSET 里绝对值最大的分量所在轴 */
function detectUpAxis(joints: Record<string, BvhJoint>, root: string): 0 | 1 | 2 {
  const r = joints[root];
  if (r === undefined) return 1;
  const firstChild = r.children.length > 0 ? joints[r.children[0]!] : undefined;
  const v: Vec3 = firstChild !== undefined
    ? firstChild.offset
    : r.endOffset ?? r.offset;
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  if (ay >= ax && ay >= az) return 1;
  if (az >= ax && az >= ay) return 2;
  return 0;
}

/** 各关节在 rest 姿态下的世界坐标（纯平移累加：BVH 的 rest 没有旋转） */
export function restWorldPositions(
  joints: Record<string, BvhJoint>,
  order: readonly string[],
): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const n of order) {
    const j = joints[n]!;
    const o = j.offset;
    if (j.parent === null) {
      out[n] = [o[0], o[1], o[2]];
    } else {
      const p = out[j.parent]!;
      out[n] = [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
    }
  }
  return out;
}

// ─────────────────────── 名字归一化与映射 ───────────────────────

/**
 * 归一化关节名，用于跨命名约定的匹配。
 *
 * 处理：`mixamorig` 前缀、`Hips_01` 之类的数字残留不处理（靠模糊匹配兜）、
 * 分隔符 `:` `_` `-` `.`、以及 Mixamo / 3ds Max / Blender 之间大小写不一致的
 * 复合词（upleg / forearm / toebase）。
 */
export function normalizeJointName(name: string): string {
  let s = name.trim().toLowerCase();
  // 前缀必须**锚定在开头**且允许缺省 `rig` 尾（Mixamo 两种都导出过）。
  // 不做全局子串删除 —— 那会把 "MixamoRightArm" 削成 "htArm" 这种垃圾。
  s = s.replace(/^mixamo(rig)?/, '');
  s = s.replace(/[:_\-.\s]/g, '');
  s = s.replace(/left/g, 'Left');
  s = s.replace(/right/g, 'Right');
  s = s.replace(/upleg/g, 'UpLeg');
  s = s.replace(/lowerleg/g, 'Leg');
  s = s.replace(/forearm/g, 'ForeArm');
  s = s.replace(/toebase/g, 'ToeBase');
  s = s.replace(/shoulder/g, 'Shoulder');
  s = s.replace(/hips/g, 'Hips');
  s = s.replace(/spine/g, 'Spine');
  s = s.replace(/neck/g, 'Neck');
  s = s.replace(/head/g, 'Head');
  return s;
}

export interface JointMapResult {
  /** BVH 关节名 → HumanIK 骨名 */
  mapping: Record<string, string>;
  /** 没对上号的 BVH 关节名 */
  unmatched: string[];
  /** 没有任何 BVH 关节喂到的 HumanIK 骨名（重定向时保持静止） */
  missingBones: string[];
}

/**
 * 把 BVH 关节名映射到 HumanIK 22 骨。
 *
 * 先精确匹配（归一化后全等），再最长公共前缀模糊匹配（阈值 4 —— 低于 4 的
 * 前缀重合，比如 `Sp` 同时是 Spine / Shoulder 的前缀，会把肩关节错配到脊柱上）。
 */
export function mapBvhJointsToHumanik(
  bvhJointNames: readonly string[],
  boneNames: readonly string[],
): JointMapResult {
  const targets = new Map<string, string>();
  for (const b of boneNames) targets.set(normalizeJointName(b), b);

  const mapping: Record<string, string> = {};
  const unmatched: string[] = [];
  const used = new Set<string>();

  for (const jn of bvhJointNames) {
    const key = normalizeJointName(jn);
    const exact = targets.get(key);
    if (exact !== undefined && !used.has(exact)) {
      mapping[jn] = exact;
      used.add(exact);
      continue;
    }
    let best: string | null = null;
    let bestP = 0;
    for (const [tk, tb] of targets) {
      if (used.has(tb)) continue;
      let p = 0;
      const n = Math.min(key.length, tk.length);
      while (p < n && key[p] === tk[p]) p++;
      if (p > bestP && p >= 4) {
        best = tb;
        bestP = p;
      }
    }
    if (best !== null) {
      mapping[jn] = best;
      used.add(best);
    } else {
      unmatched.push(jn);
    }
  }

  const missingBones = boneNames.filter((b) => !used.has(b));
  return { mapping, unmatched, missingBones };
}

// ─────────────────────── rest 骨向 ───────────────────────

/**
 * 取 HumanIK 骨 `bone` 的第一个子骨（按 `boneNames` 的声明序）。
 * 骨 `bone` 的**朝向**就是这个子骨的 tposeOffset 方向 —— 与绑定面板
 * `boneSegments()` 里「骨段 = head → 第一个子骨 head」完全同一套定义，
 * 两处必须一致，否则重定向的对齐角会系统性偏一个骨。
 */
export function firstHumanikChild(
  bone: string,
  bones: Readonly<Record<string, { parent: string | null }>>,
  boneNames: readonly string[],
): string | null {
  for (const n of boneNames) {
    if (bones[n]?.parent === bone) return n;
  }
  return null;
}

/**
 * 算每个 BVH 关节的 rest 骨向（单位向量，源坐标系）。
 *
 * 取值优先级：
 *  1. 映射到「该骨在 HumanIK 里的第一个子骨」的那个子关节的 OFFSET —— 最准，
 *     与 `tposeDirections()[firstHumanikChild(bone)]` 严格对应；
 *  2. 退化：第一个 OFFSET 非零的子关节；
 *  3. 再退化：End Site 的 OFFSET（叶子骨唯一来源）。
 * 全部为零向量时返回 null（该骨没有可用朝向，对齐角将继承父骨）。
 */
export function bvhRestDirections(
  bvh: BvhFile,
  mapping: Record<string, string>,
  boneNames: readonly string[],
  bones: Readonly<Record<string, { parent: string | null }>>,
): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  const boneOfJoint = mapping;

  for (const jn of bvh.order) {
    const bone = boneOfJoint[jn];
    if (bone === undefined) continue;
    const j = bvh.joints[jn]!;

    // 1) 与 HumanIK 第一个子骨对应的那个子关节
    const wantChild = firstHumanikChild(bone, bones, boneNames);
    let dir: Vec3 | null = null;
    if (wantChild !== null) {
      for (const cn of j.children) {
        if (mapping[cn] === wantChild) {
          dir = unitOrNull(jointsOffset(bvh, cn));
          break;
        }
      }
    }
    // 2) 第一个非零子关节
    if (dir === null) {
      for (const cn of j.children) {
        const d = unitOrNull(jointsOffset(bvh, cn));
        if (d !== null) {
          dir = d;
          break;
        }
      }
    }
    // 3) End Site
    if (dir === null && j.endOffset !== null) dir = unitOrNull(j.endOffset);

    out[bone] = dir ?? [0, 0, 0];
  }
  return out;
}

function jointsOffset(bvh: BvhFile, name: string): Vec3 {
  const j = bvh.joints[name];
  return j === undefined ? [0, 0, 0] : j.offset;
}

function unitOrNull(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-9) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}
