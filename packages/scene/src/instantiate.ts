/**
 * 实例化：SceneGraph（数据）→ 可提交给渲染器的对象清单（CPU 侧，零 GPU 依赖）。
 *
 * 位置：`packages/scene`（数据层），不是 `packages/render`。
 * 它只做"把场景描述翻译成几何 + 变换 + 材质 id"，**不碰 GPU、不认材质索引** ——
 * 材质 id → 材质槽位下标的映射是编辑器材质库的职责（scene 包看不到材质库）。
 *
 * 为什么需要这一层：
 *   SceneDocument 存的是"作者意图"（父子层级 + local TRS + 组件），
 *   渲染器要的是"每帧可直接上传的东西"（世界矩阵 + 已展开的网格 + 材质槽）。
 *   两者之间必须有且只有一个翻译点，否则每个消费者各翻译一遍，规则就会分叉。
 */
import {
  BUILTIN_SHAPE_PARAMS,
  ComponentKind,
  type BuiltinShape,
  type MaterialBinding,
  type MaterialBindingRef,
  type MeshRendererComponent,
  type MeshSource,
  type NodeId,
  type Quat,
  type Vec3,
} from './document';
import type { SceneGraph } from './graph';
import { createBox, createCapsule, createCylinder, createPlane, createSphere, type MeshData } from './geometry';

/**
 * 一个已解算的可渲染对象。
 *
 * `mesh` 为 null 只可能是 `source.type === 'asset'` —— 外部资产要异步加载，
 * 本层是纯同步的（也不该在这里引入 IO）。调用方拿到 null 自己去取。
 */
export interface InstantiatedObject {
  nodeId: NodeId;
  name: string;
  /** 世界空间变换（SceneGraph 已按层级解算） */
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  /** 自身与全部祖先都可见才算可见 */
  visible: boolean;
  pickable: boolean;
  source: MeshSource;
  /** builtin 已就地造好；asset 为 null（待调用方异步加载） */
  mesh: MeshData | null;
  /**
   * 材质 id（`shared` / `instance` 的 id；`override` 取其最内层 base）。
   * 无绑定或绑定非法时为 null —— 由调用方决定回落哪个材质。
   */
  materialId: string | null;
  /** 层级面板分类标签（来自 SceneNode.category，S2a 起为正式字段） */
  category: string;
  /** 上下浮动动画相位（来自 MeshRendererComponent.bob），0 = 不浮动 */
  bob: number;
  /** 顶点 AO 烘焙范围（来自 MeshRendererComponent.aoMin/aoMax），null = 不烘 */
  ao: { min: number; max: number } | null;
  /** 背景物体标记（来自 MeshRendererComponent.background） */
  background: boolean;
  /**
   * 原样透传的自由标注。S2a 起 bob / ao* / background / category 已转正为正式字段，
   * 这里只保留无法归类的自由标注，读取方一律走正式字段、userData 仅作兜底。
   */
  userData: Record<string, number | string | boolean>;
}

/** 跳过的节点。跳过**不是**错误（没有 MeshRenderer 的节点本来就不该渲染） */
export interface SkippedNode {
  nodeId: NodeId;
  name: string;
  reason: string;
}

export interface InstantiateResult {
  objects: InstantiatedObject[];
  skipped: SkippedNode[];
}

/**
 * 用 builtin 参数造 CPU 网格。
 * 参数名与个数由 `BUILTIN_SHAPE_PARAMS` 唯一定义，这里只按位置展开。
 */
export function buildBuiltinMesh(shape: BuiltinShape, params: readonly number[]): MeshData | null {
  const want = BUILTIN_SHAPE_PARAMS[shape];
  if (!want || params.length !== want.length) return null;
  const p = params as readonly number[];
  switch (shape) {
    case 'box':
      return createBox(p[0]!, p[1]!, p[2]!);
    case 'sphere':
      return createSphere(p[0]!, p[1]!, p[2]!);
    case 'cylinder':
      return createCylinder(p[0]!, p[1]!, p[2]!);
    case 'capsule':
      return createCapsule(p[0]!, p[1]!, p[2]!, p[3]!);
    case 'plane':
      return createPlane(p[0]!, p[1]!);
    default:
      return null;
  }
}

/**
 * 取材质 id：`override` 一路剥到最内层的 `shared` / `instance`。
 *
 * 只取第一个能解析出 id 的绑定 —— 当前渲染器每个物体只有一个材质槽
 * （`ObjectSpec.material` 是单个数字），多子网格分材质是 S2 的事。
 */
export function resolveMaterialId(bindings: readonly MaterialBinding[]): string | null {
  for (const b of bindings) {
    let r: MaterialBindingRef | undefined = b?.material;
    // 深度上限防坏数据死循环（校验器已有 8 层上限，这里再兜一道）
    for (let guard = 0; r !== undefined && guard < 16; guard++) {
      if (r.type === 'shared' || r.type === 'instance') return r.id;
      if (r.type === 'override') r = r.base;
      else break;
    }
  }
  return null;
}

/**
 * 把场景图实例化成渲染对象清单。
 *
 * 调用前**必须**先 `graph.updateWorldTransforms()`：本函数只读 `world`，不算变换
 * （算变换是 SceneGraph 的职责，这里再算一遍就是双份真源）。
 */
export function instantiateScene(graph: SceneGraph): InstantiateResult {
  const objects: InstantiatedObject[] = [];
  const skipped: SkippedNode[] = [];

  graph.traverse((node) => {
    const comp = node.components.find((c) => c.kind === ComponentKind.MeshRenderer) as
      | MeshRendererComponent
      | undefined;

    if (comp === undefined) {
      skipped.push({ nodeId: node.id, name: node.name, reason: '没有 MeshRenderer 组件' });
      return;
    }
    if (!comp.enabled || !graph.isEffectivelyVisible(node.id)) {
      skipped.push({ nodeId: node.id, name: node.name, reason: '组件或层级被隐藏' });
      return;
    }

    let mesh: MeshData | null = null;
    if (comp.source.type === 'builtin') {
      mesh = buildBuiltinMesh(comp.source.shape, comp.source.params);
      if (mesh === null) {
        skipped.push({
          nodeId: node.id,
          name: node.name,
          reason: `builtin 参数个数与 ${comp.source.shape} 约定不符`,
        });
        return;
      }
    }

    const w = node.world;
    // S2a 起 bob/ao*/background 是 MeshRendererComponent 的正式字段；
    // category 是 SceneNode 的正式字段。userData 仅作兜底（兼容未迁移的存量）。
    const ao =
      comp.aoMin !== undefined && comp.aoMax !== undefined
        ? { min: comp.aoMin, max: comp.aoMax }
        : null;
    objects.push({
      nodeId: node.id,
      name: node.name,
      position: [w.position[0], w.position[1], w.position[2]],
      quaternion: [w.rotation[0], w.rotation[1], w.rotation[2], w.rotation[3]],
      scale: [w.scale[0], w.scale[1], w.scale[2]],
      visible: true,
      pickable: node.pickable,
      source: comp.source,
      mesh,
      materialId: resolveMaterialId(comp.materials),
      category: typeof node.category === 'string' ? node.category : '道具',
      bob: typeof comp.bob === 'number' ? comp.bob : 0,
      ao,
      background: comp.background === true,
      userData: node.userData ?? {},
    });
  });

  return { objects, skipped };
}
