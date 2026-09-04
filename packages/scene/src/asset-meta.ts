/**
 * AssetMeta —— 资产的附加数据（sidecar 元数据）。
 *
 * ## 为什么需要这一层
 *
 * 编辑器对资产做的操作会产生大量**不属于场景、也不属于源资产**的附加数据：
 *   - 换模型时的材质绑定继承快照（`MeshNodeBinding` + 孤儿池）
 *   - 身高归一化系数（E-04 = 2.05 m）、焊接容差、AO 烘焙、朝上轴修正
 *   - 骨骼绑定会话（骨长采纳、T/A-pose 反解、镜像权重）
 *   - 动画配置（clip 选择、循环、速度）
 *   - 子网格显隐与默认材质
 *
 * 这些数据**现在全部只活在内存里，刷新即丢**。`assets/` 下一个 `.meta.json` 都没有。
 * 它们显然不该进场景文件（一个 GLB 被 50 个场景引用，写 50 遍显然荒谬），
 * 也不该写回源 GLB（源文件进 LFS，是只读的交付物）。
 *
 * ## sidecar 而非集中索引
 *
 * - **Unity / Godot 的做法**：每个资产一个同名 sidecar（`.meta` / `.import`）。
 * - **Unreal 的做法**：数据自包含进 `.uasset`。
 * - **选 sidecar**：集中索引文件（如 `assetdb.json`）会让每次加资产都改同一个文件，
 *   多人协作时是**合并冲突制造机**。sidecar 跟着文件走，天然无冲突。
 * - 索引（`guid → path`）是**派生产物**，启动时扫描重建，落 `.workbuddy/cache/`，**不进 git**。
 *
 * ## 归属判定规则（本文件的设计地基）
 *
 * > **问一句：「换一个全新的空场景，这个数据还在不在？」**
 * >   在 → 资产数据（`.meta.json`）
 * >   不在 / 是这个场景特有的 → 场景数据（`.scene.json`）
 *
 * | 数据 | 归属 | 理由 |
 * |---|---|---|
 * | 身高归一化 2.05 m | `.meta` | 换场景，E-04 还是 2.05 m |
 * | GLB 子网格 3 默认用"铁锈"材质 | `.meta` | 任何场景导入它都该这样（**可**被场景覆盖） |
 * | 骨骼绑定 / T-pose 反解结果 | `.meta` | 模型固有属性，与场景无关 |
 * | 这个房间里的僵尸皮肤偏红 | 场景 override | 场景特有 |
 * | 这盏灯只照亮这个房间 | 场景 | 有位置，场景特有 |
 *
 * ## 四级覆盖链
 *
 * ```
 *   .meta.json（资产默认） ──▶ prefab（可覆盖） ──▶ scene（可覆盖） ──▶ runtime（Play 期，不落盘）
 * ```
 *
 * 每一级只存**与上级的差异**，不是全量拷贝。这样改一次 .meta，几十个引用它的场景同步生效；
 * 而某个场景要特化，只写自己那一条覆盖。
 *
 * 依赖方向：本文件零 import（纯数据契约），不认识 GPU，也不认识 binding 的具体实现。
 */

import type { AssetPath, Vec3 } from './document';
import type { MaterialBindingRef } from './document';

export const META_FILE_SUFFIX = '.meta.json';
export const META_SCHEMA_VERSION = 1;

/**
 * 资产稳定 id。**重命名 / 移动文件不丢引用** ——
 * 场景里若存死路径 `assets/characters/E-04/rigged.glb`，改个目录名所有引用全断。
 * 有了 guid，文件移动后 sidecar 跟着走、guid 不变，引用自动保持。
 */
export type AssetGuid = string;

/** 生成新的资产 guid（项目内唯一即可，不需要全局 UUID 的强保证） */
export function newAssetGuid(): AssetGuid {
  const rand = Math.random().toString(36).slice(2, 10);
  return `as_${rand}`;
}

// ---------------------------------------------------------------- 导入设置

/**
 * GLB 导入器设置：决定 `GLB bytes → MeshData` 的全部变换。
 *
 * 这些参数目前散落在命令行参数与 Python 脚本里（`--ao-bake` / `--up-flip` / 减面容差），
 * 落到 .meta 之后，**导入结果可复现** —— 换台机器重新导入，出来的网格一模一样。
 */
export interface GlbImporterSettings {
  /**
   * 身高归一化目标（米）。null = 不归一化。
   * 值由生成工具从 `roster.json` 的 `heightMeters` 填入（对应 `MODEL_RULER_HEIGHT_M`），
   * 本文件只存数值 —— 避免 assets 层反向依赖 content 层。
   */
  normalizeHeightM: number | null;
  /** 焊接容差（米）。null = 不焊接。默认 1e-4 ≈ 0.1 mm */
  weldTolerance: number | null;
  /** 朝上轴翻转（混元产物脚在 z-max，export_labmesh 用 (x,-z,y)） */
  upAxisFlip: boolean;
  /**
   * AO 烘焙到顶点色 g 通道的下限（0..1）。null = 不烘焙。
   * 对应 `applyAo(mesh, minY, maxY, floor)` 的 floor。
   */
  aoBakeFloor: number | null;
  /** 按 primitive 拆子网格。false = 整个模型当一条（省材质槽，见 MAX_MATERIAL_SLOTS） */
  splitSubMeshes: boolean;
  /**
   * 子网格条数上限（材质槽预算）。超出时**整体退化为 1 条**而非截断 ——
   * 截断会静默丢掉模型后半部分的几何（见 packages/render 的 planSubMeshCount）。
   */
  maxSubMeshes: number;
}

export function defaultGlbImporter(): GlbImporterSettings {
  return {
    normalizeHeightM: null,
    weldTolerance: 1e-4,
    upAxisFlip: false,
    aoBakeFloor: null,
    splitSubMeshes: true,
    maxSubMeshes: 8,
  };
}

// ---------------------------------------------------------------- 绑定与骨骼

/**
 * 一条 primitive 的默认绑定。
 *
 * 字段与 `packages/render/src/binding.ts` 的 `PrimitiveBinding` 对应，
 * 区别只在材质表示：那边是「材质库 id + override 对象」，这里是统一的三层语义引用
 * `MaterialBindingRef`（shared / instance / override 一种结构表达全三种）。
 *
 * 转换（编辑器/资产层职责，不放 schema 里）：
 *   PrimitiveBinding{ id:'s3', override:null }  ⇄  { type:'shared',  id:'s3' }
 *   PrimitiveBinding{ id:'i7', override:null }  ⇄  { type:'instance', id:'i7', base:'s3' }
 *   PrimitiveBinding{ id:'s3', override:{...} } ⇄  { type:'override', base:{type:'shared',id:'s3'}, patch:{...} }
 */
export interface PrimitiveBindingEntry {
  primitiveKey: string;
  primitiveIndex: number;
  /** 默认材质引用；null = 回落引擎默认材质 */
  material: MaterialBindingRef | null;
  visible: boolean;
}

/**
 * 一个 mesh 节点的默认绑定。对应 `MeshNodeBinding`。
 *
 * `nodeId` 优先取 GLB 的 `node.extras` 稳定 ID（缺省 `auto-<index>`）——
 * artist 重命名节点不影响它，这是绑定能跨模型继承的前提。
 */
export interface MeshNodeBindingEntry {
  nodeId: string;
  /** 场景根 → 该节点的名字链，leaf 在最后（反向路径匹配的可信度来源） */
  nodePath: string[];
  prims: PrimitiveBindingEntry[];
}

/**
 * 骨骼绑定会话的产物。**当前全部丢失的重灾区** ——
 * 用户花数小时摆骨骼、采纳骨长、反解 T-pose，刷新页面全部归零。
 */
export interface RigSettings {
  /** 使用的骨架模板（如 `humanik`）。null = 未绑骨 */
  template: string | null;
  /**
   * 骨骼名 → 世界坐标（当前姿态采纳的骨长/位置）。
   * 采纳发生在 bind pose 那一瞬，绑完骨架不再改动（见 2026-09-04 bind pose 语义修正）。
   */
  boneWorldPositions: Record<string, Vec3>;
  /** 镜像配对（左臂 ↔ 右臂），用于镜像权重刷取 */
  mirrorPairs: Record<string, string>;
  /**
   * 反解结果：bind pose → T-pose 的关节局部旋转（四元数 xyzw，按骨骼名索引）。
   * 存它是为了换动画资产时不必重做反解。
   */
  tposeLocalRotations: Record<string, [number, number, number, number]> | null;
  /** 蒙皮权重是否已烘焙进 GLB */
  weightsBaked: boolean;
}

/**
 * 动画配置。**只存元数据，不存轨道数据** ——
 * 轨道数据在 GLB/BVH 里，.meta 只记"这些轨道该怎么播"。
 */
export interface AnimationSettings {
  /** clip 名 → 播放配置。键对应 `AnimClip.name` */
  clips: Record<string, AnimationClipMeta>;
  /** 默认播放的 clip 名；null = 不自动播放 */
  defaultClip: string | null;
}

export interface AnimationClipMeta {
  loop: boolean;
  /** 播放速度倍率 */
  speed: number;
  /** 根骨位移是否烘焙进动画（false = 原地动画，位移由代码驱动） */
  bakeRootMotion: boolean;
  /** 该 clip 播放时是否禁用寻路位移 */
  lockMovement: boolean;
}

// ---------------------------------------------------------------- 主结构

export type AssetKind = 'gltf' | 'texture' | 'prefab' | 'scene' | 'material-library' | 'behavior';

/**
 * 资产 sidecar 元数据。文件名 = `<源资产文件名>.meta.json`，与源资产同目录。
 *
 * 例：`assets/characters/models/E-04/rigged/E04_rigged.glb.meta.json`
 */
export interface AssetMeta {
  schemaVersion: number;
  /** 稳定资产 id，跨重命名/移动保持不变 */
  guid: AssetGuid;
  kind: AssetKind;
  /** 导入设置。按 kind 分化——目前只有 gltf 有实质内容 */
  importer: GlbImporterSettings;
  /** 逐 mesh 节点的默认材质绑定（换模型继承的真源） */
  bindings: MeshNodeBindingEntry[];
  /** 骨骼与蒙皮配置；非蒙皮资产为 null */
  rig: RigSettings | null;
  /** 动画配置；无动画为 null */
  animations: AnimationSettings | null;
  /**
   * 用户自定义标注（Inspector 不解释，原样透传）。
   * 用于"这个模型是 P2 批次" / "artist 备注：盾牌可拆"这类项目自有的元数据。
   */
  userData: Record<string, number | string | boolean>;
  /**
   * 源文件的内容哈希（可选）。用于**派生数据失效检测**：
   * 重导 GLB 后 hash 变了 → 标记的烘焙产物（AO 贴图 / 流场 / 减面结果）自动作废重算。
   * 这个项目已经踩过"减面产物与源不同步"的坑（docs/08）。
   */
  sourceHash: string | null;
  /** 该元数据的最后修改时间 */
  updatedAt?: string;
}

export function createDefaultAssetMeta(guid: AssetGuid, kind: AssetKind): AssetMeta {
  return {
    schemaVersion: META_SCHEMA_VERSION,
    guid,
    kind,
    importer: defaultGlbImporter(),
    bindings: [],
    rig: null,
    animations: null,
    userData: {},
    sourceHash: null,
    updatedAt: new Date().toISOString(),
  };
}

/** sidecar 文件名：`<name>.meta.json`（不去掉源扩展名，避免 a.glb 与 a.obj 撞车） */
export function metaPathFor(assetPath: AssetPath): AssetPath {
  return `${assetPath}${META_FILE_SUFFIX}`;
}

// ---------------------------------------------------------------- 校验

export interface MetaDiagnostic {
  severity: 'error' | 'warning';
  path: string;
  code: string;
  message: string;
}

const GUID_RE = /^as_[0-9a-z]{4,16}$/;

/**
 * 资产元数据校验。**不抛异常**，返回诊断列表（与 validateSceneDocument 同策略 ——
 * 静默修数据是犯罪）。
 */
export function validateAssetMeta(meta: unknown): MetaDiagnostic[] {
  const out: MetaDiagnostic[] = [];
  const err = (path: string, code: string, message: string): void => {
    out.push({ severity: 'error', path, code, message });
  };
  const warn = (path: string, code: string, message: string): void => {
    out.push({ severity: 'warning', path, code, message });
  };

  if (typeof meta !== 'object' || meta === null) {
    err('', 'E_META_NOT_OBJECT', '资产元数据根节点必须是对象');
    return out;
  }
  const m = meta as Partial<AssetMeta>;

  if (typeof m.schemaVersion !== 'number') err('/schemaVersion', 'E_META_VERSION', 'schemaVersion 缺失');
  else if (m.schemaVersion > META_SCHEMA_VERSION) {
    err('/schemaVersion', 'E_META_VERSION_FUTURE', `元数据版本 ${m.schemaVersion} 高于支持的 ${META_SCHEMA_VERSION}`);
  }

  if (typeof m.guid !== 'string' || m.guid.length === 0) err('/guid', 'E_META_GUID', 'guid 必须是非空字符串');
  else if (!GUID_RE.test(m.guid)) warn('/guid', 'W_META_GUID_FORM', `guid 格式异常：${m.guid}（建议 as_xxxxxxxx）`);

  const kinds: AssetKind[] = ['gltf', 'texture', 'prefab', 'scene', 'material-library', 'behavior'];
  if (typeof m.kind !== 'string' || !kinds.includes(m.kind as AssetKind)) {
    err('/kind', 'E_META_KIND', `kind 必须是 ${kinds.join(' / ')} 之一`);
  }

  // ---- 绑定 ----
  if (!Array.isArray(m.bindings)) {
    err('/bindings', 'E_META_BINDINGS', 'bindings 必须是数组');
  } else {
    const seen = new Set<string>();
    m.bindings.forEach((b, i) => {
      if (typeof b?.nodeId !== 'string' || b.nodeId.length === 0) {
        err(`/bindings/${i}/nodeId`, 'E_META_NODE_ID', 'nodeId 必须是非空字符串');
        return;
      }
      if (seen.has(b.nodeId)) {
        err(`/bindings/${i}/nodeId`, 'E_META_NODE_DUP', `nodeId 重复：${b.nodeId}`);
      } else {
        seen.add(b.nodeId);
      }
      if (!Array.isArray(b.nodePath)) {
        err(`/bindings/${i}/nodePath`, 'E_META_NODE_PATH', 'nodePath 必须是字符串数组');
      } else if (b.nodePath.length === 0) {
        warn(`/bindings/${i}/nodePath`, 'W_META_NODE_PATH_EMPTY', 'nodePath 为空，换模型时无法做路径匹配继承');
      }
      if (!Array.isArray(b.prims)) {
        err(`/bindings/${i}/prims`, 'E_META_PRIMS', 'prims 必须是数组');
      } else if (b.prims.length === 0) {
        warn(`/bindings/${i}/prims`, 'W_META_PRIMS_EMPTY', '该节点没有任何 primitive 绑定');
      }
    });
  }

  // ---- 导入设置 ----
  const imp = m.importer;
  if (typeof imp !== 'object' || imp === null) {
    err('/importer', 'E_META_IMPORTER', 'importer 缺失');
  } else {
    if (imp.normalizeHeightM !== null && !(imp.normalizeHeightM > 0)) {
      err('/importer/normalizeHeightM', 'E_META_HEIGHT', 'normalizeHeightM 必须 > 0 或为 null');
    }
    if (imp.weldTolerance !== null && !(imp.weldTolerance > 0)) {
      err('/importer/weldTolerance', 'E_META_WELD', 'weldTolerance 必须 > 0 或为 null');
    }
    if (imp.aoBakeFloor !== null && (imp.aoBakeFloor < 0 || imp.aoBakeFloor > 1)) {
      err('/importer/aoBakeFloor', 'E_META_AO', 'aoBakeFloor 必须在 0..1 或为 null');
    }
    if (!Number.isInteger(imp.maxSubMeshes) || imp.maxSubMeshes < 1) {
      err('/importer/maxSubMeshes', 'E_META_MAXSUB', 'maxSubMeshes 必须是 >= 1 的整数');
    }
  }

  // ---- 骨骼 ----
  if (m.rig !== null && m.rig !== undefined) {
    const r = m.rig;
    if (r.template === null && Object.keys(r.boneWorldPositions ?? {}).length > 0) {
      warn('/rig', 'W_META_RIG_NO_TEMPLATE', '有骨骼坐标但没有模板名，换模型时无法映射');
    }
    if (r.weightsBaked === false && Object.keys(r.mirrorPairs ?? {}).length > 0) {
      warn('/rig', 'W_META_RIG_UNBAKED', '配置了镜像对但权重未烘焙，换模型后需重刷');
    }
    // 镜像配对必须是双向对称的，否则刷权重时只有一半生效
    for (const [a, b] of Object.entries(r.mirrorPairs ?? {})) {
      if (r.mirrorPairs?.[b] !== a) {
        warn(`/rig/mirrorPairs/${a}`, 'W_META_MIRROR_ASYM', `镜像配对非对称：${a} → ${b}，但 ${b} → ${r.mirrorPairs?.[b] ?? '无'}`);
      }
    }
  }

  return out;
}

export function isAssetMetaValid(meta: unknown): boolean {
  return validateAssetMeta(meta).every((d) => d.severity !== 'error');
}
