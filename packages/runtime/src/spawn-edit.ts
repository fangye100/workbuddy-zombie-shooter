/**
 * 刷怪点的**领域编辑命令**（WU-5）。
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
 * ## 本轮只开两个字段
 *
 * docs/17 明确「默认选择已有 SpawnPoint.radius ... 使用已有 count 作为补充可选项」。
 * 其余字段（wave / trigger / delaySec / prefab）本轮**不改**：它们各自牵扯运行语义
 * （触发时机、波次推进），加进来等于把 WU-5 变成半个 Inspector。
 */

import { ComponentKind } from '@aether/scene';
import type { NodeId, SceneDocument, SpawnPointComponent } from '@aether/scene';
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

/** 一条已应用的编辑。`from` / `to` 让撤销成为纯函数，不需要存快照 */
export interface SpawnEdit {
  field: SpawnEditField;
  nodeId: NodeId;
  from: number;
  to: number;
}

export interface EditResult {
  ok: boolean;
  /** 失败原因（中文，直接给 UI 显示）；成功时为 null */
  error: string | null;
  /** 成功时是被应用的命令，失败时为 null */
  edit: SpawnEdit | null;
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

/** 逆命令。`from` / `to` 互换即可，不需要任何额外状态 */
export function invertSpawnEdit(edit: SpawnEdit): SpawnEdit {
  return { field: edit.field, nodeId: edit.nodeId, from: edit.to, to: edit.from };
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
  private readonly undoStack: SpawnEdit[] = [];

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
  get lastEdit(): SpawnEdit | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1]! : null;
  }

  /**
   * 写字段。
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

    const edit: SpawnEdit = { field, nodeId, from, to: value };
    const r = applySpawnEdit(this.working, edit);
    if (!r.ok) return r;
    this.undoStack.push(edit);
    return { ok: true, error: null, edit };
  }

  /** 撤销一步，返回被撤销的命令（栈空则 null） */
  undo(): SpawnEdit | null {
    const e = this.undoStack.pop();
    if (e === undefined) return null;
    applySpawnEdit(this.working, invertSpawnEdit(e));
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
   * 开始一次保存：**快照**要发送的版本，并记下它包含了撤销栈里的前几步。
   *
   * 🔴 竞态边界：保存是异步 IO。从"序列化"到"写盘返回"之间，作者可能继续编辑。
   * 如果把"保存返回 = 提交当前工作副本"（曾经就是这么写的），那两步之间新做的
   * 编辑会被**一并标记为已保存**、撤销栈被清空 —— 未落盘的数据被说成落了盘。
   * 所以：发送的是**快照**，确认时只提交快照，快照之后的编辑原样保留为未保存。
   */
  beginSave(): { doc: SceneDocument; editsIncluded: number } {
    return { doc: cloneDocument(this.working), editsIncluded: this.undoStack.length };
  }

  /**
   * 保存成功后调用：**只提交那次发送的快照**，把已包含的编辑从撤销栈里出队，
   * 快照之后的编辑原样保留（仍为未保存修改，可继续撤销）。
   */
  confirmSave(saved: SceneDocument, editsIncluded: number): void {
    this.committed = cloneDocument(saved);
    this.undoStack.splice(0, editsIncluded);
  }

  /** 换了场景（或放弃编辑重新装载） */
  reload(doc: SceneDocument): void {
    this.committed = cloneDocument(doc);
    this.working = cloneDocument(doc);
    this.undoStack.length = 0;
  }
}
