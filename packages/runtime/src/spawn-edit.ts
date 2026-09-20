/**
 * 刷怪点字段 + 节点变换的**领域编辑命令**（WU-5 起，复审 B1 加入节点变换）。
 *
 * ## 为什么是"领域命令"而不是"改 JSON 的通用 setPath"
 *
 * docs/17 WU-5 要的是「领域编辑命令与最小控件」：命令知道自己改的是
 * `SpawnPoint.radius`（**生成散布半径，米**）而不是角色碰撞半径，所以它能
 *   - 给出有语义的校验（负数 / 非整数 count / 50 米以上的散布都是作者的笔误），
 *   - 自己算出 `from` → `to`，于是**撤销**不需要另存一份快照，
 *   - 让"改完之后到底动了几个字段"变成一个可断言的集合（见 `doc-diff.ts`）。
 * 通用 setPath 做不到第三条 —— 它不知道自己动的是不是该动的那个。
 *
 * ## 为什么放在 runtime 包
 *
 * 与 `loader.ts` 同理（docs/17 §4）：Node CLI、vitest、浏览器共用同一套规则。
 * 编辑器侧只允许做三件事：拿文档、调命令、把结果画成控件。
 *
 * ## 两条命令族共用一条撤销栈（复审 B1）
 *
 * 视口里的 gizmo 拖拽过去只写渲染器内存（场景文档一个字节都不动）→ 拖完点保存
 * 不落盘、点 Play 也看不见，是「编辑器拥有场景状态」的活标本（AGENTS.md §2.1）。
 * 现在变换编辑走**同一条**命令链：文档是唯一真源，撤销栈只有一条，保存范围
 * （`changedPaths`）自动把它算进去。`field` 的取值域在两条命令族之间不相交，
 * 因此 `AuthorEdit` 靠 `field` 就能判别，不需要额外的 kind 标签。
 *
 * 文件/类名保留 `spawn-edit` / `SpawnEditStore`（WU-5 的历史命名）：`docs/18`、
 * `docs/19`、`docs/review/*` 都按这个名字与行号引用它，改名会让那些记录失准。
 */

import { ComponentKind } from '@aether/scene';
import type { NodeId, SceneDocument, SceneNode, SpawnPointComponent } from '@aether/scene';
import { changedJsonPaths, type JsonDiffEntry } from './doc-diff';

/** 本轮可编辑的字段 */
export type SpawnEditField = 'radius' | 'count';

export const SPAWN_RADIUS_MIN = 0;
export const SPAWN_RADIUS_MAX = 50;
export const SPAWN_COUNT_MIN = 0;
export const SPAWN_COUNT_MAX = 200;

/** 控件上必须写成"生成散布半径（米）"—— 否则会被当成角色碰撞半径 */
export const FIELD_LABEL: Readonly<Record<SpawnEditField, string>> = {
  radius: '生成散布半径（米）',
  count: '生成数量',
};

/** 一条已应用的刷怪点编辑。`from` / `to` 让撤销成为纯函数，不需要存快照 */
export interface SpawnEdit {
  kind: 'spawn';
  /** 单调递增的编辑身份。确认保存范围靠它，不能靠栈长（复审 P2） */
  id: number;
  field: SpawnEditField;
  nodeId: NodeId;
  from: number;
  to: number;
}

// ---------------------------------------------------------------- 节点变换（复审 B1）

/**
 * 可编辑的节点变换分量。
 *
 * 只开 gizmo 真能拖的四个量：位置三分量 + **统一**缩放（缩放手柄是等比的）。
 * 欧拉角**不作为分量**——旋转真源是四元数，拆成三个欧拉角会引入万向锁与
 * 「三个分量各自独立」的假象，所以旋转编辑整条四元数一次写入（见 `poseField`）。
 */
export type TransformField = 'posX' | 'posY' | 'posZ' | 'scale';

export const TRANSFORM_LABEL: Readonly<Record<TransformField, string>> = {
  posX: '位置 X（米）',
  posY: '位置 Y（米）',
  posZ: '位置 Z（米）',
  scale: '统一缩放',
};

/** 位置量程（米）：关卡是几十米级，±500 米之外必是笔误或单位错误 */
export const TRANSFORM_POS_MIN = -500;
export const TRANSFORM_POS_MAX = 500;
export const TRANSFORM_SCALE_MIN = 0.01;
export const TRANSFORM_SCALE_MAX = 100;

/** 逐分量的目标值。键集合 = 本次实际改动的分量（键不在 = 不动那个分量） */
export type TransformValues = Partial<Record<TransformField, number>> & {
  /**
   * 旋转**真源是四元数**（不拆欧拉角：拆成三个分量会引入万向锁与「三分量各自独立」的假象）。
   * 分量级命令只覆盖位置/缩放；旋转整条一起写。
   */
  rotation?: readonly [number, number, number, number];
};

/** 旋转四元数的"归一"容差（视口写回的是组合出来的单位四元数，这里只拦垃圾值） */
const QUAT_NORM_TOL = 1e-3;

/** 校验待写入的四元数：4 个有限数且已归一 */
export function validateQuat(q: readonly number[]): string | null {
  if (q.length !== 4 || !q.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return '旋转四元数必须是 4 个有限数字';
  }
  const n = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
  return Math.abs(n - 1) <= QUAT_NORM_TOL ? null : `旋转四元数未归一（模长 ${n.toFixed(6)}）`;
}

/** 只取数值分量：rotation 不是标量，校验与写入都要单独走 */
function numericOf(v: TransformValues): [TransformField, number][] {
  const out: [TransformField, number][] = [];
  for (const [k, x] of Object.entries(v)) {
    if (k === 'rotation' || typeof x !== 'number') continue;
    out.push([k as TransformField, x]);
  }
  return out;
}

/** 同一旋转的判据：q 与 −q 表示同一姿态，所以比 |点积| 而不是逐分量相等 */
function sameRotation(a: readonly number[], b: readonly number[]): boolean {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
  return Math.abs(Math.abs(d) - 1) <= 1e-9;
}

/**
 * 一条已应用的**局部**变换编辑。一次 gizmo 拖拽 = 一条编辑（可能同时改 x/y/z），
 * 这样撤销一步就是撤销一次拖拽，而不是撤销一个分量。
 */
export interface TransformEdit {
  kind: 'transform';
  id: number;
  nodeId: NodeId;
  from: TransformValues;
  to: TransformValues;
}

/**
 * 撤销栈与保存范围的单位：作者文档的一条编辑。
 * 两条命令族用显式 `kind` 判别（`field` 的取值域本来也不相交，但显式标签让
 * 「以后再加第三条命令族」这件事不需要重新论证判别方式）。
 */
export type AuthorEdit = SpawnEdit | TransformEdit;

export interface EditResult {
  ok: boolean;
  /** 失败原因（中文，直接给 UI 显示）；成功时为 null */
  error: string | null;
  /** 成功时是被应用的命令，失败时为 null */
  edit: AuthorEdit | null;
}

/** 面板列表用的一行摘要 */
export interface SpawnPointSummary {
  nodeId: NodeId;
  name: string;
  characterId: string;
  count: number;
  radius: number;
  wave: number;
  trigger: string;
  enabled: boolean;
}

/**
 * 深拷贝。
 *
 * 场景文档按契约（ADR-013）就是 JSON，所以 JSON 往返是无损的，比 `structuredClone`
 * 更可控：后者会保留 `undefined` 之类 JSON 里不该有的东西，反而让 `changedJsonPaths`
 * 的比对结果变得难解释。
 */
export function cloneDocument(doc: SceneDocument): SceneDocument {
  return JSON.parse(JSON.stringify(doc)) as SceneDocument;
}

/** 找节点上的 SpawnPoint 组件；节点不存在或没有该组件都返回 null（不抛） */
export function findSpawnComponent(doc: SceneDocument, nodeId: NodeId): SpawnPointComponent | null {
  for (const n of doc.nodes) {
    if (n.id !== nodeId) continue;
    for (const c of n.components) {
      if (c.kind === ComponentKind.SpawnPoint) return c as SpawnPointComponent;
    }
    return null;
  }
  return null;
}

/** 场景里全部刷怪点（按节点顺序）。面板下拉与 A/B 列表都从这里取 */
export function listSpawnPoints(doc: SceneDocument): SpawnPointSummary[] {
  const out: SpawnPointSummary[] = [];
  for (const n of doc.nodes) {
    for (const c of n.components) {
      if (c.kind !== ComponentKind.SpawnPoint) continue;
      const s = c as SpawnPointComponent;
      out.push({
        nodeId: n.id,
        name: n.name,
        characterId: s.characterId,
        count: s.count,
        radius: s.radius,
        wave: s.wave,
        trigger: s.trigger,
        enabled: s.enabled,
      });
    }
  }
  return out;
}

/** 读某个字段的当前值；节点/组件不存在返回 null */
export function readSpawnField(
  doc: SceneDocument,
  nodeId: NodeId,
  field: SpawnEditField,
): number | null {
  const c = findSpawnComponent(doc, nodeId);
  if (c === null) return null;
  return field === 'radius' ? c.radius : c.count;
}

/**
 * 校验一个待写入的值。
 *
 * 三条硬规则：
 *  - 必须是有限数（NaN / Infinity 一旦写进文件，运行时会静默变成"刷不出怪"）；
 *  - `count` 必须是整数（半个僵尸没有意义，且 loader 的 `E_SPAWN_COUNT` 也要求整数）；
 *  - 必须落在上下界内 —— 上界不是"物理不可能"，而是"作者多半是手滑多敲了一个 0"。
 */
export function validateSpawnValue(field: SpawnEditField, value: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${FIELD_LABEL[field]} 必须是有限数字`;
  }
  if (field === 'count') {
    if (!Number.isInteger(value)) return `${FIELD_LABEL[field]} 必须是整数`;
    if (value < SPAWN_COUNT_MIN || value > SPAWN_COUNT_MAX) {
      return `${FIELD_LABEL[field]} 必须在 ${SPAWN_COUNT_MIN} – ${SPAWN_COUNT_MAX} 之间`;
    }
    return null;
  }
  if (value < SPAWN_RADIUS_MIN || value > SPAWN_RADIUS_MAX) {
    return `${FIELD_LABEL[field]} 必须在 ${SPAWN_RADIUS_MIN} – ${SPAWN_RADIUS_MAX} 米之间`;
  }
  return null;
}

/**
 * 把一条命令**就地**应用到文档。
 *
 * 只写目标组件的那个字段：同节点上的其它组件、组件里的 `prefab` / `userData`、
 * 文档顶层的未知键，一个字节都不动 —— 这就是"保存保留未消费组件"的实现方式
 * （不是靠"记得把它们带上"，而是压根没碰）。
 */
export function applySpawnEdit(doc: SceneDocument, edit: SpawnEdit): EditResult {
  const c = findSpawnComponent(doc, edit.nodeId);
  if (c === null) {
    return { ok: false, error: `场景里找不到刷怪点节点 ${edit.nodeId}`, edit: null };
  }
  const err = validateSpawnValue(edit.field, edit.to);
  if (err !== null) return { ok: false, error: err, edit: null };
  if (edit.field === 'radius') c.radius = edit.to;
  else c.count = edit.to;
  return { ok: true, error: null, edit };
}

/** 逆命令。`from` / `to` 互换即可，不需要任何额外状态。id 保留 —— 撤销的是**同一条**编辑 */
export function invertSpawnEdit(edit: SpawnEdit): SpawnEdit {
  return { kind: 'spawn', id: edit.id, field: edit.field, nodeId: edit.nodeId, from: edit.to, to: edit.from };
}

// ---------------------------------------------------------------- 节点变换命令

/** 找节点（不存在返回 null，不抛） */
export function findNode(doc: SceneDocument, nodeId: NodeId): SceneNode | null {
  for (const n of doc.nodes) if (n.id === nodeId) return n;
  return null;
}

/** 读节点某变换分量的当前**局部**值；节点不存在返回 null */
export function readTransformField(
  doc: SceneDocument,
  nodeId: NodeId,
  field: TransformField,
): number | null {
  const n = findNode(doc, nodeId);
  if (n === null) return null;
  if (field === 'scale') return n.transform.scale[0];
  const axis = field === 'posX' ? 0 : field === 'posY' ? 1 : 2;
  return n.transform.position[axis];
}

/** 读节点一整组变换分量的当前局部值（键集合由调用方给定） */
export function readTransformValues(
  doc: SceneDocument,
  nodeId: NodeId,
  fields: readonly TransformField[],
): TransformValues | null {
  const out: TransformValues = {};
  for (const f of fields) {
    const v = readTransformField(doc, nodeId, f);
    if (v === null) return null;
    out[f] = v;
  }
  return out;
}

/**
 * 校验一个待写入的变换分量。
 * 与 `validateSpawnValue` 同规矩：有限数 + 有界（上界是"作者多半敲错了"，
 * 不是"物理不可能"；缩放上界 100 也防住了 INF 之外的实际爆表）。
 */
export function validateTransformValue(field: TransformField, value: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${TRANSFORM_LABEL[field]} 必须是有限数字`;
  }
  if (field === 'scale') {
    if (value < TRANSFORM_SCALE_MIN || value > TRANSFORM_SCALE_MAX) {
      return `${TRANSFORM_LABEL[field]} 必须在 ${TRANSFORM_SCALE_MIN} – ${TRANSFORM_SCALE_MAX} 之间`;
    }
    return null;
  }
  if (value < TRANSFORM_POS_MIN || value > TRANSFORM_POS_MAX) {
    return `${TRANSFORM_LABEL[field]} 必须在 ${TRANSFORM_POS_MIN} – ${TRANSFORM_POS_MAX} 米之间`;
  }
  return null;
}

/**
 * 把一条变换命令**就地**应用到文档。
 *
 * 只写 `to` 里出现过的分量：同节点的其它分量、其它组件、`userData`、文档顶层的
 * 未知键一个字节都不动（与 `applySpawnEdit` 同一条"保存保留未消费内容"的实现方式）。
 * `scale` 写三分量——gizmo 的缩放手柄是等比的，写单一分量只会造出隐藏的非等比。
 */
export function applyTransformEdit(doc: SceneDocument, edit: TransformEdit): EditResult {
  const n = findNode(doc, edit.nodeId);
  if (n === null) return { ok: false, error: `场景里找不到节点 ${edit.nodeId}`, edit: null };
  const nums = numericOf(edit.to);
  for (const [f, v] of nums) {
    const err = validateTransformValue(f, v);
    if (err !== null) return { ok: false, error: err, edit: null };
  }
  if (edit.to.rotation !== undefined) {
    const err = validateQuat(edit.to.rotation);
    if (err !== null) return { ok: false, error: err, edit: null };
  }
  for (const [f, v] of nums) {
    if (f === 'scale') {
      n.transform.scale = [v, v, v];
    } else {
      const axis = f === 'posX' ? 0 : f === 'posY' ? 1 : 2;
      n.transform.position[axis] = v;
    }
  }
  if (edit.to.rotation !== undefined) {
    const r = edit.to.rotation;
    n.transform.rotation = [r[0], r[1], r[2], r[3]];
  }
  return { ok: true, error: null, edit };
}

/** 逆命令：逐分量互换（旋转一起互换）。id 保留 */
export function invertTransformEdit(edit: TransformEdit): TransformEdit {
  return {
    kind: 'transform',
    id: edit.id,
    nodeId: edit.nodeId,
    from: edit.to,
    to: edit.from,
  };
}

/** 按 `kind` 分发应用（撤销栈里两条命令族共用一条 LIFO） */
export function applyAuthorEdit(doc: SceneDocument, edit: AuthorEdit): EditResult {
  return edit.kind === 'transform' ? applyTransformEdit(doc, edit) : applySpawnEdit(doc, edit);
}

/** 按 `kind` 分发取逆 */
export function invertAuthorEdit(edit: AuthorEdit): AuthorEdit {
  return edit.kind === 'transform' ? invertTransformEdit(edit) : invertSpawnEdit(edit);
}

/** 面板/状态行用的一句话描述（"刚改了什么"）。UI 不该自己拼字段名 */
export function formatAuthorEdit(edit: AuthorEdit): string {
  if (edit.kind === 'spawn') {
    return `${FIELD_LABEL[edit.field]}：${edit.from} → ${edit.to}`;
  }
  const parts = numericOf(edit.to).map(([f, v]) => `${TRANSFORM_LABEL[f]} ${v.toFixed(3)}`);
  if (edit.to.rotation !== undefined) {
    parts.push(`旋转 (${edit.to.rotation.map((x) => x.toFixed(3)).join(', ')})`);
  }
  return `节点 ${edit.nodeId} 变换：${parts.join('、')}`;
}

/**
 * 作者文档的**唯一所有者**（编辑态）。
 *
 * 三条边界：
 *  - 构造时把传入文档拷成两份：`committed`（磁盘/上次保存的版本）与 `document`
 *    （工作副本）。外界拿到的永远是 `document`，Play 也读它 —— 于是「编辑后要不要
 *    重开才生效」这个问题根本不存在：重开就是重新装载同一个对象。
 *  - 不做 IO。保存由编辑器调 `writeProjectFile` 之后再 `commit()` 回调这里 ——
 *    IO 失败不该让内存里的未保存状态被清空。
 *  - 撤销栈只存 `SpawnEdit`（几十字节），不存整份文档快照。
 */
export class SpawnEditStore {
  private committed: SceneDocument;
  private working: SceneDocument;
  private readonly undoStack: AuthorEdit[] = [];
  /** 编辑身份计数器。确认保存范围用它（复审 P2：栈长在"撤销+再编辑"下会骗人） */
  private nextEditId = 1;

  constructor(doc: SceneDocument) {
    this.committed = cloneDocument(doc);
    this.working = cloneDocument(doc);
  }

  /** 工作副本。**唯一真源**：渲染 / Play / 保存都读它 */
  get document(): SceneDocument {
    return this.working;
  }

  /** 已提交版本（磁盘版本）。只用于算"这次改了什么"和"全部撤回" */
  get committedDocument(): SceneDocument {
    return this.committed;
  }

  /**
   * 有未提交的编辑。
   *
   * 判据是「撤销栈非空 **或** 工作副本与已提交版本有差异」，不能只数栈 ——
   * 保存竞态下（发送快照后、确认前撤销了一条编辑），栈是空的但工作副本和
   * 磁盘并不一致，这时必须把 dirty 如实亮出来。
   */
  get dirty(): boolean {
    return this.undoStack.length > 0 || this.changedPaths().length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** 最近一次编辑（面板上显示"刚改了什么"） */
  get lastEdit(): AuthorEdit | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1]! : null;
  }

  /**
   * 写刷怪点字段。
   *
   * 值没变时不记为一次编辑（`dirty` 不该因为"点了一下输入框"就亮起来），
   * 但也不算失败 —— 调用方按 `edit === null && ok === false` 区分"拒绝了"和"没变化"。
   */
  set(nodeId: NodeId, field: SpawnEditField, value: number): EditResult {
    const c = findSpawnComponent(this.working, nodeId);
    if (c === null) {
      return { ok: false, error: `场景里找不到刷怪点节点 ${nodeId}`, edit: null };
    }
    const err = validateSpawnValue(field, value);
    if (err !== null) return { ok: false, error: err, edit: null };
    const from = field === 'radius' ? c.radius : c.count;
    if (Object.is(from, value)) return { ok: false, error: '值没有变化', edit: null };

    const edit: SpawnEdit = { kind: 'spawn', id: this.nextEditId++, field, nodeId, from, to: value };
    const r = applySpawnEdit(this.working, edit);
    if (!r.ok) return r;
    this.undoStack.push(edit);
    return { ok: true, error: null, edit };
  }

  /**
   * 写节点**局部**变换（一次 gizmo 拖拽 = 一条编辑）。
   *
   * 入参是局部值：世界→局部的换算在调用方（编辑器）用
   * `worldToLocalTransform` 完成 —— 文档只认局部量，命令层不猜坐标系。
   * 全部目标值都与当前值相同 → 不算一次编辑（拖了但没动的拖拽不该进撤销栈）。
   */
  setTransform(nodeId: NodeId, to: TransformValues): EditResult {
    const n = findNode(this.working, nodeId);
    if (n === null) return { ok: false, error: `场景里找不到节点 ${nodeId}`, edit: null };
    const nums = numericOf(to);
    if (nums.length === 0 && to.rotation === undefined) {
      return { ok: false, error: '没有任何分量要写入', edit: null };
    }
    for (const [f, v] of nums) {
      const err = validateTransformValue(f, v);
      if (err !== null) return { ok: false, error: err, edit: null };
    }
    if (to.rotation !== undefined) {
      const err = validateQuat(to.rotation);
      if (err !== null) return { ok: false, error: err, edit: null };
    }
    const from: TransformValues = {};
    for (const [f] of nums) {
      const cur = readTransformField(this.working, nodeId, f);
      if (cur === null) return { ok: false, error: `场景里找不到节点 ${nodeId}`, edit: null };
      from[f] = cur;
    }
    if (to.rotation !== undefined) {
      const r = n.transform.rotation;
      from.rotation = [r[0], r[1], r[2], r[3]];
    }
    // 无变化：标量逐位比较；旋转按 |点积|≈1（q 与 −q 是同一姿态）
    const sameNums = nums.every(([f, v]) => Object.is(from[f], v));
    const sameRot = to.rotation === undefined || sameRotation(from.rotation!, to.rotation);
    if (sameNums && sameRot) return { ok: false, error: '值没有变化', edit: null };
    const edit: TransformEdit = { kind: 'transform', id: this.nextEditId++, nodeId, from, to: { ...to } };
    const r = applyTransformEdit(this.working, edit);
    if (!r.ok) return r;
    this.undoStack.push(edit);
    return { ok: true, error: null, edit };
  }

  /** 撤销一步，返回被撤销的命令（栈空则 null） */
  undo(): AuthorEdit | null {
    const e = this.undoStack.pop();
    if (e === undefined) return null;
    applyAuthorEdit(this.working, invertAuthorEdit(e));
    return e;
  }

  /** 全部撤回（不提交）。返回撤了几步 */
  revertAll(): number {
    let n = 0;
    while (this.undo() !== null) n++;
    return n;
  }

  /** 相对已提交版本的全部差异路径。保存前自检用 */
  changedPaths(): JsonDiffEntry[] {
    return changedJsonPaths(this.committed, this.working);
  }

  /**
   * 开始一次保存：**快照**要发送的版本，并记下它包含到哪一条编辑身份。
   *
   * 🔴 竞态边界：保存是异步 IO。从"序列化"到"写盘返回"之间，作者可能继续编辑。
   * 如果把"保存返回 = 提交当前工作副本"，那两步之间新做的编辑会被一并标记为
   * 已保存、撤销栈被清空 —— 未落盘的数据被说成落了盘。
   * 🔴 记**编辑身份**而不是栈长（复审 P2）：等待期间作者可能"撤销 + 再编辑"，
   * 栈长不变但栈里已经换了一条 —— 按长度出队会把新编辑误删，把旧编辑误留。
   */
  beginSave(): { doc: SceneDocument; lastEditId: number } {
    const top = this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1]! : null;
    return { doc: cloneDocument(this.working), lastEditId: top?.id ?? 0 };
  }

  /**
   * 保存成功后调用：**只提交那次发送的快照**，出队 `id <= lastEditId` 的编辑，
   * 快照之后（或"撤销后重做"）的编辑原样保留（仍为未保存修改，可继续撤销）。
   */
  confirmSave(saved: SceneDocument, lastEditId: number): void {
    this.committed = cloneDocument(saved);
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      if (this.undoStack[i]!.id <= lastEditId) this.undoStack.splice(i, 1);
    }
  }

  /** 换了场景（或放弃编辑重新装载） */
  reload(doc: SceneDocument): void {
    this.committed = cloneDocument(doc);
    this.working = cloneDocument(doc);
    this.undoStack.length = 0;
  }
}
