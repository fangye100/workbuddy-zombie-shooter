/**
 * 绑定领域会话 Binding Session —— 绑定编辑的**唯一状态 owner**（docs/17 §3.5：
 * 每类运行状态只能有一个权威 owner）。
 *
 * 设计要点
 * --------
 * 1. **headless**：本文件不 import 任何 DOM / Canvas / WebGPU 能力，Node 与浏览器
 *    里都能跑（vitest 环境 = node，直接可测）。GUI（binding-panel.ts）与未来的
 *    MCP 入口都只是它的消费方（docs/17 §3.4：人通过 GUI、Agent 通过工具调用
 *    **同一套领域操作**，Agent 不绕过校验、撤销和保存语义）。
 * 2. **状态全封闭**：27 关节坐标、Skin Wrapper 半径表、权重算法 / 平滑 / 镜像
 *    导出选项、Undo/Redo 历史、Bind Pose 与导出指纹、预览权重缓存，全部只能经
 *    本类的方法读写。`positions` 等 getter 暴露的活引用**只准读**，改动必须走
 *    方法（否则历史栈与缓存指纹会失同步）。
 * 3. **历史纪律**：所有改动持久化字段的方法内部先 `beginEdit()` 打快照（与旧面板
 *    逐一核对过入栈点）；唯一的例外是**连续拖拽**这类手势流 —— 手势起点调一次
 *    `beginEdit(kind)` / `beginEdit(kind, coalesceMs)`，过程中用 `setJointPosition`
 *    纯写，手势边界（pointerup / 表单 change / 换选中）调 `sealHistory()` 封口。
 * 4. **持久化契约**：`getEditorData()` 的产物写进 `.meta.json` 的 `bindingEditor`
 *    键；`hydrate()` 做全形状校验，脏数据字段保持默认值（绝不静默修数据）。
 *    与 node 管线 `rig`（配方）/ `bindings`（数组）互不冲突 —— devfs patch
 *    浅合并不碰别的键，gen-asset-meta 的 mergeInto 不碰这个键。
 *
 * 权重管线的顺序约定（与 `binding-export.runExport` 严格同序，旧评审 P0-3）：
 *   **算法（wrapper / distance）→ 镜像 → 平滑**。
 *   `computeSkin()` 是预览 / 热力图 / 诊断条的唯一权重来源，改顺序必须两边一起改。
 */

import {
  HUMANIK_ORDER,
  MIRROR_PAIRS,
  mirrorOf,
  tposeWorldPositions,
  type Vec3,
} from './humanik-template';
import {
  boneSegments,
  computeLbsWeights,
  fitSkeleton,
  smoothSkinWeights,
  type FitResult,
  type JointPositions,
  type SkinWeights,
} from './binding-math';
import {
  autoFitCylinders,
  computeCylinderWeights,
  defaultSkinCylinders,
  mirrorCylinders,
  mirrorOffsetBetween,
  mirrorSkinWeights,
  type CylinderWeightStats,
  type SkinCylinderMap,
  type CylSegment,
} from './skin-proxy';

/**
 * 权重算法（导出时真正生效的分支，见 `binding-export.runExport`）：
 *  - `wrapper`  Skin Wrapper 包裹体：被圆柱体包住的顶点归属该 joint（二值，过渡窄）
 *  - `distance` 胶囊距离衰减：`1/(d+eps)^falloff` 取 top-4（过渡自然，但会跨侧抢权重）
 */
export type WeightMode = 'wrapper' | 'distance';

/**
 * 编辑器侧持久化的绑定编辑数据 —— 存进 `.meta.json` 的 `bindingEditor` 槽位。
 *
 * 与 node 管线 `rig`（配方：positions/bindPose/skinCylinders）/ `bindings`（数组）
 * 互不冲突：devfs 的 patch 是浅合并，gen-asset-meta 的 mergeInto 只补缺失字段，
 * 都不会碰这个键。这样浏览器编辑与离线管线各存各的、互不覆盖。
 */
export interface BindingEditorData {
  /** 27 关节的 local 空间坐标（与 this.positions 同构） */
  positions: Record<string, [number, number, number]>;
  /** Skin Wrapper 半径表（null = 未进入蒙皮模式） */
  cylinders: SkinCylinderMap | null;
  /**
   * 权重算法（可选，老文件没有此键 → 载入时按默认 wrapper 处理）。
   * 存它是为了让「这个资产是用哪套算法绑的」可复现，而不是靠改代码时的默认值。
   */
  weightMode?: WeightMode;
  /** 导出时是否做权重热扩散平滑（可选，老文件缺省 = true，与面板默认一致） */
  smoothWeights?: boolean;
  /** 平滑迭代次数（可选，老文件缺省 = 面板默认 4，旧评审 §2.4：2 次扩散半径不够） */
  smoothIters?: number;
  /** 平滑扩散强度 0..1（可选，老文件缺省 = 0.5） */
  smoothLambda?: number;
  /** 导出时是否镜像皮肤权重 L→R（可选，老文件缺省 = false） */
  mirrorWeights?: boolean;
  /** 写入时间戳（ISO），仅供排障 */
  savedAt?: string | undefined;
}

/** 会话持有的模型几何（引擎 15-float 顶点布局：pos3 / normal3 / smoothNormal3 / uv2 / color4） */
export interface BindingMesh {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  vertexFloats: number;
}

/** `computeSkin()` 的产出：权重 + wrapper 模式随算的统计（诊断条的「未包裹顶点数」） */
export interface BindingSkinResult {
  skin: SkinWeights;
  /** wrapper 模式的统计；distance 模式为 null */
  stats: CylinderWeightStats | null;
}

/** Undo/Redo 栈深（诊断条与冒烟断言用） */
export interface BindingHistoryDepth {
  undo: number;
  redo: number;
}

/** 平滑迭代次数合法域（面板数字框同款钳制：旧评审 §2.4 参数外置） */
const SMOOTH_ITERS_MIN = 1;
const SMOOTH_ITERS_MAX = 12;
/** 平滑扩散强度 λ 合法域 */
const SMOOTH_LAMBDA_MIN = 0;
const SMOOTH_LAMBDA_MAX = 1;
/** Undo 栈上限（快照是全量持久化态 JSON，单帧 <10KB） */
const HISTORY_LIMIT = 50;

export class BindingSession {
  // ── 模型几何（当前姿态源网格；导出与权重计算的唯一几何来源） ──
  private modelName: string | null = null;
  private srcVerts: Float32Array<ArrayBuffer> | null = null;
  private meshIndices: Uint32Array<ArrayBuffer> | null = null;
  private vertexFloats = 15;

  // ── 持久化编辑态（= BindingEditorData 的运行时形态） ──
  /** 关节坐标：local 空间。外部只准读；改动必须走 setJointPosition / mirror 等方法 */
  private _positions: JointPositions = tposeWorldPositions();
  /** 每个 joint 的 Skin Wrapper（圆柱体）。null = 未载模型；setModel 载入即建 */
  private cylinders: SkinCylinderMap | null = null;
  /** 权重算法（默认 wrapper，与历史行为一致，避免静默改变既有产物） */
  private weightMode: WeightMode = 'wrapper';
  private smoothWeights = true;
  /** 旧评审 §2.4：默认 2 次只能扩散 ~2 环顶点，15k 面角色关节处仍有折角；默认 4 次 */
  private smoothIters = 4;
  private smoothLambda = 0.5;
  /** 导出时是否镜像皮肤权重 L→R */
  private mirrorWeights = false;

  // ── Bind  bookkeeping ──
  /**
   * 冻结保存的 Bind Pose —— Bind Skin 瞬间拍下的带 offset 编辑姿态。
   * 一经绑定就持久存在：Detach 不清空，只有再次 Bind Skin 才刷新。
   */
  private bindPose: JointPositions | null = null;
  /**
   * 上次 Bind Skin 成功瞬间的「编辑指纹」。null = 从未 Bind 过。
   * 与当前 `editSig()` 不等即说明结果已过期（「● 未导出 / ✓ 已绑定」徽标的数据源）。
   */
  private boundSig: string | null = null;

  // ── Undo/Redo（快照 = 全量持久化编辑态，见 snapshotState） ──
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** 连续输入（拖拽流 / 滑块流 / 按键连发）的历史合并：同 kind 在窗口内只记一步 */
  private lastPush: { kind: string; time: number } | null = null;

  /**
   * 「当前权重」共享缓存（T/A/姿势预览网格 + 热力图 + 诊断条同源）。
   * 键 = `editSig()`（权重输入的完整指纹），命中即零成本复用。
   */
  private skinCache: { sig: string; result: BindingSkinResult } | null = null;

  // ─────────────────────────── 模型 ───────────────────────────

  /**
   * 载入模型（当前姿态网格）。重置全部会话级状态，**唯独保留 `positions`** ——
   * 与面板历史行为一致：关节坐标是模型 local 空间（归一化身高），换模型不丢摆位，
   * 随后 hydrate 有存档才覆盖。
   * 半径表**载入即建**：关节模式也要用它（否则 3D 层退回自动半径，盖掉手动值）。
   */
  setModel(
    name: string,
    vertices: Float32Array<ArrayBuffer>,
    indices: Uint32Array<ArrayBuffer>,
    vertexFloats = 15,
  ): void {
    this.modelName = name;
    this.srcVerts = vertices;
    this.meshIndices = indices;
    this.vertexFloats = vertexFloats;
    this.bindPose = null;
    this.boundSig = null;
    this.cylinders = null;
    this.mirrorWeights = false;
    // smoothWeights 也要重置：老 .meta.json 没有这三个键时 hydrate 不会碰它们，
    // 不重置会把**上一个模型**的开关值带进新模型的预览与导出（PR #7 复审）
    this.smoothWeights = true;
    this.smoothIters = 4;
    this.smoothLambda = 0.5;
    this.weightMode = 'wrapper';
    this.skinCache = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastPush = null;
    this.ensureCylinders();
  }

  /** 清空会话（含关节坐标回到模板 T-pose —— 与面板历史行为一致） */
  clear(): void {
    this.modelName = null;
    this.srcVerts = null;
    this.meshIndices = null;
    this.vertexFloats = 15;
    this._positions = tposeWorldPositions();
    this.bindPose = null;
    this.boundSig = null;
    this.cylinders = null;
    this.mirrorWeights = false;
    this.smoothWeights = true;
    this.smoothIters = 4;
    this.smoothLambda = 0.5;
    this.weightMode = 'wrapper';
    this.skinCache = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastPush = null;
  }

  /** 供导出取用：**当前姿态**的源网格（权重必须在当前姿态上算，绝不传反解后的网格） */
  getMesh(): BindingMesh | null {
    if (this.srcVerts === null || this.meshIndices === null) return null;
    return { vertices: this.srcVerts, indices: this.meshIndices, vertexFloats: this.vertexFloats };
  }

  getModelName(): string | null {
    return this.modelName;
  }

  /** 顶点数（未载模型 = 0） */
  vertexCount(): number {
    return this.srcVerts !== null ? this.srcVerts.length / this.vertexFloats : 0;
  }

  /** 三角面数（未载模型 = 0） */
  triangleCount(): number {
    return this.meshIndices !== null ? this.meshIndices.length / 3 : 0;
  }

  // ─────────────────────────── 编辑态读取 ───────────────────────────

  /** 27 关节坐标（活引用，**只读**；改动走 setJointPosition / mirror / restoreBindPose） */
  get positions(): JointPositions {
    return this._positions;
  }

  /**
   * 当前 Skin Wrapper 半径表。注意：setModel **载入即建**（ensureCylinders），
   * 所以载入模型后恒非 null —— 权重算法的真正开关是 `getWeightMode()`，
   * distance 模式导出时必须传 undefined（否则 runExport 永远走圆柱体分支）。
   */
  getCylinders(): SkinCylinderMap | null {
    return this.cylinders;
  }

  getWeightMode(): WeightMode {
    return this.weightMode;
  }

  getSmoothWeights(): boolean {
    return this.smoothWeights;
  }

  getSmoothIters(): number {
    return this.smoothIters;
  }

  getSmoothLambda(): number {
    return this.smoothLambda;
  }

  getMirrorWeights(): boolean {
    return this.mirrorWeights;
  }

  /** 冻结的 Bind Pose（未 Bind 过 = null）。活引用，只读。 */
  getBindPose(): JointPositions | null {
    return this.bindPose;
  }

  /** 上次 Bind 成功瞬间的编辑指纹（从未 Bind = null；与 editSig() 比对判断过期） */
  getBoundSig(): string | null {
    return this.boundSig;
  }

  // ─────────────────────────── 历史（Undo/Redo） ───────────────────────────

  /**
   * 打一步历史快照（**全量持久化编辑态**：骨架坐标 + 包裹器 + 权重算法/平滑/镜像
   * 导出选项，JSON 深拷贝 <10KB，上限 50 步）。
   *
   * 为什么是全量：快照与恢复必须严格对称 —— hydrate() 会同时改写几何与导出选项，
   * 若快照只存几何，「撤销一次回填」就把骨架变回去、设置却留在新值，状态自相矛盾
   * （PR #8 复审）。不变量因此定为：**任何持久化字段的变更之前都必须先打快照**。
   *
   * 在**改动发生前**调用（快照存的是改前状态）。连续输入流（拖拽 / 滑块 / 按键
   * 连发）按 `kind` + 时间窗合并：同 kind 且距上一步 <coalesceMs 就只刷新时间戳，
   * 不再压栈 —— 一次滑块拖动 = 一步撤销，而不是八十步。合并窗口在手势边界
   * （`sealHistory()`）封口，不跨手势并步。任何新改动都会清空 redo 栈。
   */
  beginEdit(kind: string, coalesceMs = 0): void {
    const now = performance.now();
    if (
      coalesceMs > 0 && this.lastPush !== null &&
      this.lastPush.kind === kind && now - this.lastPush.time < coalesceMs
    ) {
      this.lastPush.time = now;
      return;
    }
    this.undoStack.push(this.snapshotState());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.lastPush = { kind, time: now };
  }

  /**
   * 合并窗口封口：手势结束（pointerup / 表单 change / 换选中骨）时必须调用，
   * 否则 800ms 内的下一段手势（哪怕换了根骨）会被并进上一步，
   * 一次撤销回滚两段手势（旧评审 §2.6 复审）。
   */
  sealHistory(): void {
    this.lastPush = null;
  }

  /** 撤销一步。空栈 = 无操作（返回 false）。 */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (prev === undefined) return false;
    this.redoStack.push(this.snapshotState());
    this.restoreHistory(prev);
    return true;
  }

  /** 重做一步。空栈 = 无操作（返回 false）。 */
  redo(): boolean {
    const next = this.redoStack.pop();
    if (next === undefined) return false;
    this.undoStack.push(this.snapshotState());
    this.restoreHistory(next);
    return true;
  }

  /** 当前可撤销 / 可重做的步数 */
  historyDepth(): BindingHistoryDepth {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  private snapshotState(): string {
    return JSON.stringify({
      positions: this._positions,
      cylinders: this.cylinders,
      weightMode: this.weightMode,
      smoothWeights: this.smoothWeights,
      smoothIters: this.smoothIters,
      smoothLambda: this.smoothLambda,
      mirrorWeights: this.mirrorWeights,
    });
  }

  private restoreHistory(json: string): void {
    const s = JSON.parse(json) as {
      positions: JointPositions;
      cylinders: SkinCylinderMap | null;
      weightMode: WeightMode;
      smoothWeights: boolean;
      smoothIters: number;
      smoothLambda: number;
      mirrorWeights: boolean;
    };
    this._positions = s.positions;
    this.cylinders = s.cylinders;
    this.weightMode = s.weightMode;
    this.smoothWeights = s.smoothWeights;
    this.smoothIters = s.smoothIters;
    this.smoothLambda = s.smoothLambda;
    this.mirrorWeights = s.mirrorWeights;
    // 打断合并窗口：撤销后的下一次改动必须新起一步，不能并回旧流
    this.lastPush = null;
    this.skinCache = null;
  }

  // ─────────────────────────── 关节编辑 ───────────────────────────

  /**
   * 纯写一个关节坐标（**不含历史**）—— 连续手势专用：手势起点先 `beginEdit`，
   * 过程中反复调本方法。一次性改动请用 `poseJoint`。
   * @returns 是否真的写进去了（骨名不存在 / 坐标非法 = false）
   */
  setJointPosition(name: string, p: [number, number, number]): boolean {
    if (this._positions[name] === undefined) return false;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return false;
    this._positions[name] = [p[0], p[1], p[2]];
    return true;
  }

  /**
   * 一次性摆一个关节（自动化钩子语义）：自带历史（800ms 窗口合并按键连发）。
   * @returns 是否真的写进去了
   */
  poseJoint(name: string, p: [number, number, number]): boolean {
    if (this._positions[name] === undefined) return false;
    this.beginEdit('pose', 800);
    return this.setJointPosition(name, p);
  }

  /**
   * 镜像：左右对称面 x=0，故 x 取反且互换左右骨名。骨架与 Skin Wrapper 半径一并镜像
   * （否则骨架翻过去了 wrapper 半径还留在原侧 —— 之前「wrapper 没法镜像」的真因）。
   */
  mirror(dir: 'L2R' | 'R2L'): void {
    this.beginEdit('mirror');
    for (const [l, r] of MIRROR_PAIRS) {
      const src = dir === 'L2R' ? l : r;
      const dst = dir === 'L2R' ? r : l;
      const s = this._positions[src]!;
      this._positions[dst] = [-s[0], s[1], s[2]];
      const cyls = this.cylinders;
      if (cyls !== null) {
        const c = cyls[src];
        if (c !== undefined) {
          cyls[dst] = {
            bone: dst,
            radii: { ...c.radii },
            enabled: c.enabled,
            manual: c.manual === true,
            offset: c.offset !== undefined ? [...c.offset] : undefined,
          };
        }
      }
    }
  }

  /** 清空所有关节编辑，回到模板 T-pose 初始摆放（确认对话是调用方的事） */
  resetPositions(): void {
    this.beginEdit('reset');
    this._positions = tposeWorldPositions();
  }

  // ─────────────────────────── Skin Wrapper（代理圆柱体） ───────────────────────────

  /** 半径表惰性初始化（默认 = 骨长 ×0.35 自动半径） */
  ensureCylinders(): void {
    if (this.cylinders === null) {
      this.cylinders = defaultSkinCylinders(this._positions);
    }
  }

  /**
   * 设置某根骨某段的包裹器半径（滑块 / 视图拖拽 / 自动化共用同一条路径 ——
   * 只有一条路径才不会出现「钩子能改、UI 改不动」这种对不上的假绿）。
   * 自带历史（800ms 窗口合并连续流）。
   * @returns 是否真的写进去了（半径表未初始化 / 骨名不存在 / 值非法 = false）
   */
  setCylinderRadius(bone: string, seg: CylSegment, v: number): boolean {
    const cyl = this.cylinders?.[bone];
    if (cyl === undefined || !Number.isFinite(v)) return false;
    this.beginEdit('radius', 800);
    cyl.radii[seg] = v;
    // 手动改过 → 打标记，自动适配从此不再碰这根骨
    cyl.manual = true;
    return true;
  }

  /** 读某骨包裹器的当前偏移（未设置时返回 [0,0,0]，可变元组便于就地改写单轴） */
  getOffset(bone: string): [number, number, number] {
    const c = this.cylinders?.[bone];
    return c?.offset !== undefined ? [c.offset[0], c.offset[1], c.offset[2]] : [0, 0, 0];
  }

  /**
   * 设置整根包裹器的偏移（沿骨局部轴：x=轴向 / y=侧向 / z=前后）。
   * 偏移全部为 0 时存 undefined（干净），否则存数组；手动标记一并打上。
   * 画几何体与算权重都按此偏移，保证「看到的体积 == 算权重用的体积」。
   * 自带历史（800ms 窗口合并连续流）。
   */
  setCylinderOffset(bone: string, offset: Vec3): boolean {
    const cyl = this.cylinders?.[bone];
    if (
      cyl === undefined ||
      !Number.isFinite(offset[0]) || !Number.isFinite(offset[1]) || !Number.isFinite(offset[2])
    ) return false;
    this.beginEdit('offset', 800);
    const zero = offset[0] === 0 && offset[1] === 0 && offset[2] === 0;
    cyl.offset = zero ? undefined : [offset[0], offset[1], offset[2]];
    cyl.manual = true;
    return true;
  }

  /**
   * 把某根骨（若有对侧同名骨）的包裹器半径镜像到对侧。
   * offset 必须一并镜像，且要经**世界系 x 反射**换算（PR #7 复审）：
   * 左右同名骨的局部基不互为镜像（双腿同向 → v1 同向），局部元组直抄会把
   * 两侧 wrapper 推向世界的同一侧。
   * @returns 是否真的执行了（半径表未初始化 / 中轴骨无对侧 = false）
   */
  mirrorCylinder(bone: string): boolean {
    if (this.cylinders === null) return false;
    const m = mirrorOf(bone);
    if (m === null) return false;
    const src = this.cylinders[bone];
    if (src === undefined) return false;
    this.beginEdit('mirror');
    let offset: Vec3 | undefined;
    if (src.offset !== undefined) {
      const segs = boneSegments(this._positions);
      const ss = segs.find((x) => x.bone === bone);
      const ds = segs.find((x) => x.bone === m);
      offset = ss !== undefined && ds !== undefined
        ? mirrorOffsetBetween(ss.a, ss.b, ds.a, ds.b, src.offset)
        : [...src.offset];
    }
    this.cylinders[m] = {
      bone: m,
      radii: { ...src.radii },
      enabled: src.enabled,
      manual: true,
      offset,
    };
    return true;
  }

  /** 全部 L↔R 镜像 wrapper 几何 */
  mirrorAllCylinders(): void {
    if (this.cylinders === null) return;
    this.beginEdit('mirror');
    this.cylinders = mirrorCylinders(this.cylinders, this._positions);
  }

  /**
   * 自动适配：**未手动改过**的骨按骨长重算半径，手动改过的一个不碰。
   * 只应显式调用（用户按钮 / Agent 工具），绝不隐式跑（隐式跑 = 覆盖手动值）。
   * @returns 被重算的骨名列表
   */
  autoFitCylinders(): string[] {
    if (this.cylinders === null) return [];
    this.beginEdit('autofit');
    return autoFitCylinders(this._positions, this.cylinders);
  }

  /**
   * 取消某骨的手动标记，交还给自动适配（并按当前骨长立即重算一次）。
   * @returns 是否真的执行了
   */
  unpinCylinder(bone: string): boolean {
    if (this.cylinders === null) return false;
    const cyl = this.cylinders[bone];
    if (cyl === undefined) return false;
    this.beginEdit('unpin');
    cyl.manual = false;
    autoFitCylinders(this._positions, this.cylinders);
    return true;
  }

  // ─────────────────────────── 导出选项（权重算法 / 平滑 / 镜像） ───────────────────────────

  /**
   * 切权重算法。只接受 'wrapper' / 'distance' 字面量，其余拒绝（保持现值）。
   * 值没变化时不打历史、不动缓存。
   * @returns 是否真的改了
   */
  setWeightMode(mode: string): boolean {
    if (mode !== 'wrapper' && mode !== 'distance') return false;
    if (mode === this.weightMode) return false;
    this.beginEdit('settings');
    this.weightMode = mode;
    return true;
  }

  /** 切「导出时平滑权重」开关。@returns 是否真的改了 */
  setSmoothWeights(on: boolean): boolean {
    if (on === this.smoothWeights) return false;
    this.beginEdit('settings');
    this.smoothWeights = on;
    return true;
  }

  /**
   * 设平滑迭代次数：非有限数 → 保持现值；越界 → 钳制到 [1,12] 取整。
   * 值没变化时不打历史。
   * @returns 实际生效的值（供调用方回显输入框）
   */
  setSmoothIters(v: number): number {
    if (!Number.isFinite(v)) return this.smoothIters;
    const clamped = Math.min(SMOOTH_ITERS_MAX, Math.max(SMOOTH_ITERS_MIN, Math.round(v)));
    if (clamped !== this.smoothIters) {
      this.beginEdit('settings');
      this.smoothIters = clamped;
    }
    return this.smoothIters;
  }

  /**
   * 设平滑扩散强度 λ：非有限数 → 保持现值；越界 → 钳制到 [0,1]。
   * @returns 实际生效的值
   */
  setSmoothLambda(v: number): number {
    if (!Number.isFinite(v)) return this.smoothLambda;
    const clamped = Math.min(SMOOTH_LAMBDA_MAX, Math.max(SMOOTH_LAMBDA_MIN, v));
    if (clamped !== this.smoothLambda) {
      this.beginEdit('settings');
      this.smoothLambda = clamped;
    }
    return this.smoothLambda;
  }

  /** 切「导出时镜像皮肤权重 L→R」。@returns 是否真的改了 */
  setMirrorWeights(on: boolean): boolean {
    if (on === this.mirrorWeights) return false;
    this.beginEdit('settings');
    this.mirrorWeights = on;
    return true;
  }

  // ─────────────────────────── 派生计算 ───────────────────────────

  /** 当前编辑姿态的骨架拟合（22 骨规模极小，每次重算无性能压力，不做缓存失效判断） */
  currentFit(): FitResult {
    return fitSkeleton(this._positions);
  }

  /**
   * 当前编辑态指纹：27 关节坐标 + 全部包裹器半径/启用/偏移 + **影响产物的导出选项**
   * （权重算法 / 镜像权重 / 平滑开关 / 平滑参数 —— 它们不改几何但改变 Bind 产物，
   *  漏掉会出现「改了算法徽标还显示 ✓ 已绑定」的假绿，2026-09-22 复审收口）。
   * 只用于「自上次 Bind 后动过没有」的比对与权重缓存键，不参与任何算法。
   * 未载模型 = null。
   */
  editSig(): string | null {
    if (this.modelName === null) return null;
    const parts: string[] = [];
    for (const n of HUMANIK_ORDER) {
      const p = this._positions[n];
      parts.push(p === undefined ? '-' : `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2].toFixed(5)}`);
    }
    if (this.cylinders !== null) {
      for (const n of Object.keys(this.cylinders).sort()) {
        const c = this.cylinders[n]!;
        // offset / enabled 都进 computeCylinderWeights → 都改变 Bind 产物，
        // 漏掉会出现「改了偏移/禁用徽标还显示 ✓ 已绑定」的假绿（PR #7 复审）
        const off = c.offset === undefined
          ? '-'
          : `${c.offset[0].toFixed(5)},${c.offset[1].toFixed(5)},${c.offset[2].toFixed(5)}`;
        parts.push(
          `${n}:${c.radii.top.toFixed(5)}/${c.radii.medium.toFixed(5)}/${c.radii.bottom.toFixed(5)}` +
          `|en:${c.enabled ? 1 : 0}|off:${off}`,
        );
      }
    }
    parts.push(`wm:${this.weightMode}`);
    parts.push(`mw:${this.mirrorWeights ? 1 : 0}`);
    parts.push(`sm:${this.smoothWeights ? 1 : 0}`);
    // 平滑迭代 / λ 同样改变 Bind 产物（旧评审 §2.4 参数外置后必须进指纹，
    // 否则改了参数徽标还显示 ✓ 已绑定 —— 与当初漏 sm/mw 同类的假绿）
    parts.push(`si:${this.smoothIters}`);
    parts.push(`sl:${this.smoothLambda.toFixed(3)}`);
    return parts.join('|');
  }

  /**
   * 当前权重（预览网格 / 热力图 / 诊断条的唯一来源，与 `binding-export.runExport`
   * 严格同序：**算法 → 镜像 → 平滑**）。
   *
   * 缓存键 = `editSig()`：任何一个权重输入变了指纹就变、缓存自然失效；
   * 不动指纹的操作（pan/zoom/选中切换）零成本复用。
   * 未载模型 = null。
   */
  computeSkin(): BindingSkinResult | null {
    if (this.srcVerts === null || this.meshIndices === null) return null;
    const sig = this.editSig();
    if (sig === null) return null;
    if (this.skinCache !== null && this.skinCache.sig === sig) {
      return this.skinCache.result;
    }
    const n = this.srcVerts.length / this.vertexFloats;
    let skin: SkinWeights;
    let stats: CylinderWeightStats | null = null;
    if (this.weightMode === 'wrapper' && this.cylinders !== null) {
      const st: CylinderWeightStats = { unwrappedVerts: 0 };
      skin = computeCylinderWeights(
        this.srcVerts, this.vertexFloats, n, this._positions, this.cylinders, { stats: st },
      );
      stats = st;
    } else {
      skin = computeLbsWeights(
        this.srcVerts, this.vertexFloats, n, boneSegments(this._positions),
      );
    }
    if (this.mirrorWeights) {
      skin = mirrorSkinWeights(skin, this.vertexFloats, n, this.srcVerts);
    }
    if (this.smoothWeights) {
      skin = smoothSkinWeights(skin, this.meshIndices, n, this.smoothIters, this.smoothLambda, {
        positions: this.srcVerts,
        vertexFloats: this.vertexFloats,
      });
    }
    this.skinCache = { sig, result: { skin, stats } };
    return this.skinCache.result;
  }

  // ─────────────────────────── Bind  bookkeeping ───────────────────────────

  /**
   * 冻结保存 Bind Pose（Bind Skin 瞬间的带 offset 编辑姿态），永久存在；
   * Detach 不清空，再 Bind 才刷新。
   *
   * ⚠️ **绑完骨架绝不动**：bind pose 是动词 —— 在「当前姿势 + 当前模型」把骨骼与
   * 皮肤绑定的那一瞬间，骨架的姿势就叫 bind pose。这里绝不复位 `positions`。
   */
  freezeBindPose(): void {
    this.bindPose = this.clonePositions(this._positions);
  }

  /** 把编辑骨架恢复成冻结的 Bind Pose（未 Bind 过 = false，调用方保持原状） */
  restoreBindPose(): boolean {
    if (this.bindPose === null) return false;
    this._positions = this.clonePositions(this.bindPose);
    return true;
  }

  /** Bind Skin 导出成功之后调用：记下这一刻的编辑指纹（徽标据此判断「之后动过没有」） */
  markExported(): void {
    this.boundSig = this.editSig();
  }

  /** Detach Skin：结果移除 → 回到「未导出」（Bind Pose 与关节编辑保留） */
  clearExportStamp(): void {
    this.boundSig = null;
  }

  /** 深拷贝一份关节坐标（冻结 Bind Pose 用，避免与实时编辑互相污染） */
  private clonePositions(p: JointPositions): JointPositions {
    const out: Record<string, [number, number, number]> = {};
    for (const name of HUMANIK_ORDER) out[name] = [...p[name]!];
    return out;
  }

  // ─────────────────────────── 持久化（.meta.json 的 bindingEditor 键） ───────────────────────────

  /**
   * 导出当前编辑态（骨架摆位 + Skin Wrapper + 导出选项），供「保存绑定」写盘。
   * 深拷贝避免与面板内部引用共享，落盘后 JSON 改动不反向污染编辑态。
   */
  getEditorData(): BindingEditorData {
    return {
      positions: JSON.parse(JSON.stringify(this._positions)) as Record<string, [number, number, number]>,
      cylinders: this.cylinders === null
        ? null
        : (JSON.parse(JSON.stringify(this.cylinders)) as SkinCylinderMap),
      weightMode: this.weightMode,
      smoothWeights: this.smoothWeights,
      smoothIters: this.smoothIters,
      smoothLambda: this.smoothLambda,
      mirrorWeights: this.mirrorWeights,
      savedAt: new Date().toISOString(),
    };
  }

  /**
   * 回填：打开资产时从 `.meta.json` 的 `bindingEditor` 槽位把上次的编辑态灌回来。
   *
   * 只在 key 形状对得上时才接纳，避免和未来模型骨骼集不一致导致错乱：
   *  - positions：逐骨校验是有限数三元组，且本模型确有这跟骨才覆盖；
   *  - cylinders：逐骨校验有 `radii.{top,medium,bottom}` 三个有限数才整体接纳；
   *  - 设置类：只接受合法字面量 / 合理域内的有限数，脏数据保持默认值。
   *
   * 回填是一次性大改 → 进历史（可撤销回到回填前）。
   *
   * @param saved 来自磁盘 JSON 的 `bindingEditor` 节点（untrusted → 全程形状校验）
   */
  hydrate(saved: unknown): void {
    if (saved === null || typeof saved !== 'object') return;
    // 回填是一次性大改 → 进历史（可撤销回到回填前）
    this.beginEdit('hydrate');
    const s = saved as {
      positions?: unknown;
      cylinders?: unknown;
      weightMode?: unknown;
      smoothWeights?: unknown;
      smoothIters?: unknown;
      smoothLambda?: unknown;
      mirrorWeights?: unknown;
    };

    // 权重算法：只接受两个字面量，其余（老文件缺字段 / 脏数据）保持默认 wrapper
    if (s.weightMode === 'distance' || s.weightMode === 'wrapper') {
      this.weightMode = s.weightMode;
    }

    // 导出选项：只接受真布尔，老文件缺字段保持默认（smooth=true / mirror=false）
    if (typeof s.smoothWeights === 'boolean') this.smoothWeights = s.smoothWeights;
    if (typeof s.mirrorWeights === 'boolean') this.mirrorWeights = s.mirrorWeights;
    // 平滑参数：只接受合理域内的有限数（迭代取整 1..12，λ ∈ [0,1]），
    // 老文件缺字段 / 脏数据保持默认 —— 与 weightMode 的「只接受合法字面量」同构
    if (typeof s.smoothIters === 'number' && Number.isFinite(s.smoothIters) &&
        s.smoothIters >= SMOOTH_ITERS_MIN && s.smoothIters <= SMOOTH_ITERS_MAX) {
      this.smoothIters = Math.round(s.smoothIters);
    }
    if (typeof s.smoothLambda === 'number' && Number.isFinite(s.smoothLambda) &&
        s.smoothLambda >= SMOOTH_LAMBDA_MIN && s.smoothLambda <= SMOOTH_LAMBDA_MAX) {
      this.smoothLambda = s.smoothLambda;
    }

    if (s.positions !== null && typeof s.positions === 'object') {
      const map = s.positions as Record<string, unknown>;
      for (const [bone, p] of Object.entries(map)) {
        if (this._positions[bone] === undefined) continue;
        if (!Array.isArray(p) || p.length !== 3) continue;
        const ok = (p as unknown[]).every((n) => typeof n === 'number' && Number.isFinite(n));
        if (!ok) continue;
        const t = p as [number, number, number];
        this._positions[bone] = [t[0], t[1], t[2]];
      }
    }

    if (s.cylinders !== null && typeof s.cylinders === 'object') {
      const map = s.cylinders as Record<string, unknown>;
      let shapeOk = true;
      for (const c of Object.values(map)) {
        if (c === null || typeof c !== 'object') { shapeOk = false; break; }
        const r = (c as { radii?: unknown }).radii;
        if (r === null || typeof r !== 'object') { shapeOk = false; break; }
        const rr = r as Record<string, unknown>;
        if (typeof rr.top !== 'number' || typeof rr.medium !== 'number' || typeof rr.bottom !== 'number') {
          shapeOk = false; break;
        }
      }
      if (shapeOk) {
        this.cylinders = JSON.parse(JSON.stringify(map)) as SkinCylinderMap;
      }
    }
    this.skinCache = null;
  }
}
