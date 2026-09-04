/**
 * SceneGraph —— 场景的**运行时**结构（ADR-011 / ADR-012 / ADR-014）。S1。
 *
 * ## 它和 SceneDocument 的关系
 *
 * ```
 *   SceneDocument（*.scene.json，可序列化）  ⇄  SceneGraph（内存，含派生量）
 * ```
 *
 * Document 是**存储格式**，Graph 是**运行时结构**。区别在派生量：
 * `world` 变换、`depth`、`children` 索引都由 local 变换推导，
 * **不落盘**（落了就是冗余真源，改一边另一边不同步）。
 * `fromDocument()` 建图、`toNodes()` 回写，是这两个表示之间**唯一**的转化口。
 *
 * ## 为什么是扁平表 + parent（ADR-012）
 *
 * 嵌套 children 树写起来直观，但：
 *   - diff 会随嵌套深度指数级变丑（改一个叶子，整条祖先链都算改动）
 *   - 遍历要递归，深层场景有爆栈风险
 *   - 与 prefab override 的 `propertyPath` 寻址方式不一致（那边是扁平 id 路径）
 * 扁平表 + `parent` 引用三者全解。`children` 作为派生索引保留，便于遍历。
 *
 * ## 为什么不用 packages/core 的 ECS World
 *
 * `core/src/ecs/world.ts` 是半成品（`remove()` 空实现、`strideOf()` 硬编码 4、
 * `isChanged()` 恒真）。用它当场景骨架 = 把能跑的编辑器拆成不能跑的架构正确品。
 * 静态物件走这里；**大量热实体（500 僵尸）走 ai + gameplay 的 SoA**，
 * 通过 `NodeId ↔ EntityId` 映射桥接（ADR-011，Phase 2）。
 */

import { quatMul, type Mat4 } from '@aether/core';
import {
  identityTransform,
  type ComponentData,
  type NodeId,
  type PrefabInstance,
  type Quat,
  type SceneDocument,
  type SceneNode,
  type TransformData,
  type Vec3,
} from './document';

export type { ComponentData, NodeId, PrefabInstance, SceneNode, TransformData };

/**
 * 运行时节点 = Document 节点 + 派生量。
 * 派生量（`world` / `depth`）在 `updateWorldTransforms()` 与结构变更后重算。
 */
export interface SceneNodeRuntime extends SceneNode {
  /** 世界变换。由父级 world × 本节点 local 推出，**不落盘** */
  world: TransformData;
  /** 根为 0。变换传播按它升序，保证父先于子 */
  depth: number;
}

export interface AddNodeInit {
  name?: string;
  parent?: NodeId | null;
  transform?: Partial<TransformData>;
  visible?: boolean;
  pickable?: boolean;
  components?: ComponentData[];
  prefab?: PrefabInstance | null;
  /** 显式指定 id（用于从 document 还原）；不指定则自动生成 */
  id?: NodeId;
}

/** Play 期快照。ADR-014：Play 前存、Stop 回滚 */
export interface SceneGraphSnapshot {
  nodes: SceneNode[];
  /** 快照时刻，便于日志与调试 */
  at: string;
}

/**
 * 引擎侧静态物件上限（`packages/render/src/frame-uniforms.ts` 的 `MAX_OBJECTS`）。
 * **超了必须报错，不能静默丢弃** —— 静默丢弃的表现是"第 65 个物件神秘消失"，
 * 排查成本极高。大量同类实体走 instancing，不走这里。
 */
export const MAX_NODES = 64;

export class SceneGraph {
  private readonly nodes = new Map<NodeId, SceneNodeRuntime>();
  private readonly order: NodeId[] = [];
  private dirty = true;
  private seq = 0;

  // ------------------------------------------------------------ 结构

  /** 节点数。容量是 `MAX_NODES`，超了 `addNode` 会抛 */
  get size(): number {
    return this.nodes.size;
  }

  /** 还能加几个 */
  get capacity(): number {
    return MAX_NODES - this.nodes.size;
  }

  addNode(init: AddNodeInit = {}): NodeId {
    if (this.nodes.size >= MAX_NODES) {
      throw new Error(
        `场景节点已达引擎上限 ${MAX_NODES}（MAX_OBJECTS）。` +
          `静态物件就这么多；大量同类实体（僵尸群）请走 instancing，不要建节点。`,
      );
    }

    const id = init.id ?? this.nextId(init.name ?? 'node');
    if (this.nodes.has(id)) {
      throw new Error(`节点 id 已存在：${id}`);
    }
    const parent = init.parent ?? null;
    if (parent !== null && !this.nodes.has(parent)) {
      throw new Error(`父节点不存在：${parent}`);
    }

    const node: SceneNodeRuntime = {
      id,
      name: init.name ?? id,
      parent,
      transform: { ...identityTransform(), ...init.transform },
      world: identityTransform(),
      visible: init.visible ?? true,
      pickable: init.pickable ?? true,
      components: init.components ?? [],
      prefab: init.prefab ?? null,
      depth: parent === null ? 0 : (this.nodes.get(parent)?.depth ?? 0) + 1,
    };

    this.nodes.set(id, node);
    this.order.push(id);
    this.dirty = true;
    return id;
  }

  /** 删节点。**连带删除所有子孙**（孤儿节点没有父级、变换无法求解，留着是 bug 源） */
  removeNode(id: NodeId): boolean {
    const node = this.nodes.get(id);
    if (node === undefined) return false;

    for (const descendant of this.descendantsOf(id)) {
      this.nodes.delete(descendant);
      const i = this.order.indexOf(descendant);
      if (i >= 0) this.order.splice(i, 1);
    }
    this.nodes.delete(id);
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);

    this.dirty = true;
    return true;
  }

  /**
   * 改父级。`null` = 提到根。
   * **拒绝成环** —— 把自己挂到自己的子孙下会让变换传播死循环，
   * 且没有任何合法用途，所以直接抛而不是静默修正。
   */
  reparent(id: NodeId, newParent: NodeId | null): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`节点不存在：${id}`);
    if (newParent === id) throw new Error(`不能把自己当父级：${id}`);
    if (newParent !== null) {
      if (!this.nodes.has(newParent)) throw new Error(`父节点不存在：${newParent}`);
      if (this.descendantsOf(id).includes(newParent)) {
        throw new Error(`成环：${newParent} 是 ${id} 的子孙，不能反过来当它的父级`);
      }
    }

    node.parent = newParent;
    this.recomputeDepths();
    this.dirty = true;
  }

  getNode(id: NodeId): SceneNodeRuntime | null {
    return this.nodes.get(id) ?? null;
  }

  has(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  // ------------------------------------------------------------ 变换

  /** 改 local 变换。自动标脏，下次 `updateWorldTransforms()` 生效 */
  setLocalTransform(id: NodeId, t: Partial<TransformData>): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`节点不存在：${id}`);
    node.transform = { ...node.transform, ...t };
    this.dirty = true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * 传播世界变换。**按 depth 升序**，保证父一定先于子被算。
   *
   * 节点数上限 64，所以直接全量重算 —— 增量脏传播在这个规模下
   * 省不到什么，却要额外维护脏集合与失效顺序，不划算。
   * `dirty` 标志保留给调用方判断"要不要重传 uniform"。
   */
  updateWorldTransforms(): void {
    for (const id of this.stableOrder()) {
      const node = this.nodes.get(id);
      if (node === undefined) continue;
      const parent = node.parent !== null ? this.nodes.get(node.parent) : null;
      if (parent === undefined || parent === null) {
        copyInto(node.world, node.transform);
      } else {
        composeTransform(parent.world, node.transform, node.world);
      }
    }
    this.dirty = false;
  }

  /** 世界矩阵（列主序 16 float，可直接喂 uniform） */
  worldMatrix(id: NodeId, out?: Mat4): Mat4 {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`节点不存在：${id}`);
    return trsToMat4(node.world, out ?? new Float32Array(16));
  }

  // ------------------------------------------------------------ 查询

  roots(): NodeId[] {
    return this.stableOrder().filter((id) => this.nodes.get(id)?.parent === null);
  }

  /** 直接子节点（按插入序） */
  childrenOf(id: NodeId): NodeId[] {
    return this.stableOrder().filter((nid) => this.nodes.get(nid)?.parent === id);
  }

  /** 所有子孙（深度优先，不含自己） */
  descendantsOf(id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    const walk = (parent: NodeId): void => {
      for (const child of this.childrenOf(parent)) {
        out.push(child);
        walk(child);
      }
    };
    walk(id);
    return out;
  }

  /** 深度优先遍历。`from` 为 null 时从所有根开始 */
  traverse(visit: (node: SceneNodeRuntime) => void, from: NodeId | null = null): void {
    const walk = (id: NodeId): void => {
      const node = this.nodes.get(id);
      if (node === undefined) return;
      visit(node);
      for (const child of this.childrenOf(id)) walk(child);
    };
    if (from === null) {
      for (const r of this.roots()) walk(r);
    } else {
      walk(from);
    }
  }

  findByName(name: string): NodeId[] {
    return this.stableOrder().filter((id) => this.nodes.get(id)?.name === name);
  }

  /** 从根到该节点的名字路径（层级面板与 propertyPath 用） */
  pathOf(id: NodeId): string[] {
    const out: string[] = [];
    let cur: NodeId | null = id;
    while (cur !== null) {
      const node: SceneNodeRuntime | undefined = this.nodes.get(cur);
      if (node === undefined) break;
      out.unshift(node.name);
      cur = node.parent;
    }
    return out;
  }

  /** 该节点及其子孙是否可见（父级隐藏则整棵子树不画） */
  isEffectivelyVisible(id: NodeId): boolean {
    let cur: NodeId | null = id;
    while (cur !== null) {
      const node = this.nodes.get(cur);
      if (node === undefined) return false;
      if (!node.visible) return false;
      cur = node.parent;
    }
    return true;
  }

  // ------------------------------------------------------------ 与 Document 互转

  /** 从场景文件建图。**唯一**的 Document → Graph 入口 */
  static fromDocument(doc: SceneDocument): SceneGraph {
    const graph = new SceneGraph();
    // 先全部建好（parent 可能指向后面的节点，不能边建边接父级）
    for (const n of doc.nodes) {
      graph.nodes.set(n.id, {
        ...n,
        transform: { ...n.transform },
        components: n.components.map((c) => ({ ...c })),
        prefab: n.prefab === null ? null : { ...n.prefab },
        world: identityTransform(),
        depth: 0,
      });
      graph.order.push(n.id);
    }
    // 校验父级引用 + 算 depth
    for (const n of doc.nodes) {
      const node = graph.nodes.get(n.id);
      if (node === undefined) continue;
      if (n.parent !== null && !graph.nodes.has(n.parent)) {
        throw new Error(`场景 ${doc.id} 的节点 ${n.id} 引用了不存在的父级 ${n.parent}`);
      }
    }
    graph.recomputeDepths();
    graph.updateWorldTransforms();
    return graph;
  }

  /**
   * 回写为 Document 节点数组。**只吐存储字段，派生量（world / depth）不落盘。**
   * 顺序按插入序 —— 与 `fromDocument` 的输入序一致，保证 diff 稳定。
   */
  toNodes(): SceneNode[] {
    return this.stableOrder().map((id) => {
      const n = this.nodes.get(id);
      if (n === undefined) throw new Error(`节点不存在：${id}`);
      return {
        id: n.id,
        name: n.name,
        parent: n.parent,
        transform: { ...n.transform },
        visible: n.visible,
        pickable: n.pickable,
        components: n.components.map((c) => ({ ...c })),
        prefab: n.prefab === null ? null : { ...n.prefab },
      };
    });
  }

  // ------------------------------------------------------------ ADR-014 快照

  /** Play 前存快照（深拷贝，Play 期的改动不会污染它） */
  snapshot(): SceneGraphSnapshot {
    return { nodes: this.toNodes(), at: new Date().toISOString() };
  }

  /** Stop 后回滚。整图重建 —— 不增量回滚，避免"回滚不干净"这类最难查的 bug */
  restore(snap: SceneGraphSnapshot): void {
    this.nodes.clear();
    this.order.length = 0;
    for (const n of snap.nodes) {
      this.nodes.set(n.id, {
        ...n,
        transform: { ...n.transform },
        components: n.components.map((c) => ({ ...c })),
        prefab: n.prefab === null ? null : { ...n.prefab },
        world: identityTransform(),
        depth: 0,
      });
      this.order.push(n.id);
    }
    this.recomputeDepths();
    this.updateWorldTransforms();
  }

  // ------------------------------------------------------------ 内部

  /** 插入序（结构变更时重排 depth，但插入序本身稳定 → diff 稳定） */
  private stableOrder(): NodeId[] {
    return this.order;
  }

  private recomputeDepths(): void {
    // 按插入序推进：父在子前时一次遍历即可；否则用迭代收敛（有环时不会死循环）
    for (let pass = 0; pass < this.order.length + 1; pass += 1) {
      let changed = false;
      for (const id of this.order) {
        const node = this.nodes.get(id);
        if (node === undefined) continue;
        const want =
          node.parent === null ? 0 : (this.nodes.get(node.parent)?.depth ?? 0) + 1;
        if (want !== node.depth) {
          node.depth = want;
          changed = true;
        }
      }
      if (!changed) break;
    }
    // 排序：depth 升序，同层按插入序 —— 保证变换传播时父先于子
    this.order.sort((a, b) => {
      const da = this.nodes.get(a)?.depth ?? 0;
      const db = this.nodes.get(b)?.depth ?? 0;
      return da === db ? 0 : da < db ? -1 : 1;
    });
  }

  private nextId(base: string): NodeId {
    this.seq += 1;
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `${slug || 'node'}-${this.seq.toString(36)}`;
  }
}

// ---------------------------------------------------------------- 变换数学

/** 四元数乘法。复用 `@aether/core` 的实现 —— scene 依赖 core 是向下依赖，合法 */
export { quatMul };

/** `v` 绕四元数 `q` 旋转。core/math 没有这个，本地实现（就 3 行，不值得上提） */
export function quatRotateVec3(v: Vec3, q: Quat): Vec3 {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  // t = 2 * (q.xyz × v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  // v + q.w * t + (q.xyz × t)
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * 世界变换 = 父 world ∘ 本节点 local（TRS 组合）。
 *
 * 非等比缩放下这是**近似**：父级带旋转的非等比缩放会产生 skew，
 * 严格表示需要仿射矩阵而非 TRS。这里取工程近似（Unity/Unreal 同样如此），
 * 且我们的用法里非等比缩放基本只出现在叶子节点上。
 */
export function composeTransform(
  parentWorld: TransformData,
  local: TransformData,
  out: TransformData,
): TransformData {
  // scale：逐分量相乘
  const s: Vec3 = [
    parentWorld.scale[0] * local.scale[0],
    parentWorld.scale[1] * local.scale[1],
    parentWorld.scale[2] * local.scale[2],
  ];
  // rotation：四元数相乘。core 返回 readonly 元组，这里展开成可变元组再赋值
  const rq = quatMul(parentWorld.rotation, local.rotation);
  const r: Quat = [rq[0], rq[1], rq[2], rq[3]];
  // position：父位移 + 父旋转作用于（父缩放 × 子位移）
  const scaled: Vec3 = [
    parentWorld.scale[0] * local.position[0],
    parentWorld.scale[1] * local.position[1],
    parentWorld.scale[2] * local.position[2],
  ];
  const rotated = quatRotateVec3(scaled, parentWorld.rotation);
  out.position = [
    parentWorld.position[0] + rotated[0],
    parentWorld.position[1] + rotated[1],
    parentWorld.position[2] + rotated[2],
  ];
  out.rotation = r;
  out.scale = s;
  return out;
}

/** TRS → 列主序 Mat4（可直接喂 uniform） */
export function trsToMat4(t: TransformData, out: Mat4): Mat4 {
  const [x, y, z, w] = t.rotation;
  const [sx, sy, sz] = t.scale;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  // 第 0/1/2 列 = 旋转矩阵的对应列 × 该轴缩放
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = t.position[0];
  out[13] = t.position[1];
  out[14] = t.position[2];
  out[15] = 1;
  return out;
}

function copyInto(out: TransformData, src: TransformData): void {
  out.position = [...src.position] as unknown as TransformData['position'];
  out.rotation = [...src.rotation] as unknown as TransformData['rotation'];
  out.scale = [...src.scale] as unknown as TransformData['scale'];
}
