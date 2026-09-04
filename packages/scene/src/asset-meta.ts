/**
 * AssetMeta —— 资产的附加数据（sidecar 元数据）。
 *
 * ## 为什么需要这一层
 *
 * 编辑器对资产做的操作会产生大量**不属于场景、也不属于源资产**的附加数据：
 *   - 换模型时的材质绑定继承快照（`MeshNodeBinding` + 孤儿池）
 *   - 身高归一化系数（E-04 = 2.05 m）、焊接容差、AO 烘焙、朝上轴修正
 *   - 骨骼绑定**会话**（骨架摆位、Skin Wrapper 半径、导出配方、T-pose 反解量）
 *   - 动画配置（clip 选择、循环、速度）
 *   - 子网格显隐与默认材质
 *
 * 这些数据**现在全部只活在内存里，刷新即丢**。`assets/` 下一个 `.meta.json` 都没有。
 * 它们显然不该进场景文件（一个 GLB 被 50 个场景引用，写 50 遍显然荒谬），
 * 也不该写回源 GLB（源文件进 LFS，是只读的交付物）。
 *
 * ## ⚠️ 一条容易搞错的边界：已落进源资产的数据不在这里
 *
 * 判据：**这段数据丢了，能不能从源资产（GLB）反推出来？能 → 不存。**
 *
 * 典型反例是骨骼绑定的**结果**（骨架层级 / `inverseBindMatrices` / `JOINTS_0` /
 * `WEIGHTS_0` / 动画 clip）—— 它们已经随导出的 GLB 落盘了，再往 `.meta` 抄一份就是双真源。
 * `.meta.rig` 只装**造出这个结果的配方**（见 `RigSettings` 的文档注释）。
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
 * | 骨骼**会话**（摆位 / Wrapper 半径 / 导出配方） | `.meta` | 模型固有属性，与场景无关 |
 * | 骨骼**结果**（骨架 / IBM / 权重 / clip） | **源 GLB，不进 .meta** | 已在资产里，抄一份 = 双真源 |
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
 * 骨骼绑定的**可复现参数与未导出草稿**。
 *
 * ## ⚠️ 先划清边界：绑定「结果」不在这里
 *
 * 骨架层级、`inverseBindMatrices`、`JOINTS_0`/`WEIGHTS_0`、动画 clip
 * —— **这些已经在导出的 GLB 里，不要往 `.meta` 抄第二份**。
 *
 * 实测证据（2026-09-04）：
 * `assets/characters/models/E-04/rigged/E04_Bulwark_1600_rigged_animated.glb`
 * 300 KB，含 skins=1 / 关节 22 / inverseBindMatrices ✓ / animations=6 /
 * `JOINTS_0`+`WEIGHTS_0` ✓。GLB 是 LFS 资产，跨项目跨场景都在。
 * 抄一份进 `.meta` = 双真源：改一边另一边不同步，**比丢失更糟**。
 *
 * ## 那么这里装什么
 *
 * 装的是**导出流程的输入（配方）**——产物里只有成品，没有配方。
 * 判据：这段数据丢了，能不能从导出的 GLB 反推出来？能 → 不存；不能 → 存。
 *
 * | 字段 | 会话来源 | 为什么产物里没有 |
 * |---|---|---|
 * | `session.positions` | 用户拖出来的骨骼世界坐标 | 导出时已反解到 T-pose，产物骨架是另一套姿态 |
 * | `session.bindPose` | 「采纳为 bind pose」的快照 | 采纳是一次性会话动作 |
 * | `session.skinCylinders` | Skin Wrapper 三段半径 | 只用于算权重，算完即弃 |
 * | `export.*` | 平滑 / 镜像 / falloff 等开关 | 同上，是配方不是成品 |
 * | `tposeLocalRotations` | bind → T-pose 反解出的关节局部旋转 | 产物骨架**直接就是** T-pose，反解量被吸收掉了 |
 *
 * **不存 `mirrorPairs`**：镜像配对是模板常量（`humanik-template.ts` 的
 * `MIRROR_PAIRS`），由 `template` 派生，存了就是冗余真源。
 *
 * ## `exported` 的语义
 *
 * `exported=true` 之后，上面这些**降为历史记录**——
 * 它们描述「这个 GLB 是怎么被造出来的」，用于复现与微调，
 * **不是运行时要读的数据**。运行时永远读 GLB。
 */
export interface RigSettings {
  /** 使用的骨架模板（如 `humanik`）。null = 未绑骨 */
  template: string | null;
  /**
   * 未导出草稿 / 上次会话现场。null = 没做过绑定会话。
   * `exported=true` 后这里保留为历史，供「接着上次调」用。
   */
  session: RigSession | null;
  /**
   * 反解结果：bind pose → T-pose 的关节局部旋转（四元数 xyzw，按骨骼名索引）。
   * 存它是为了换动画资产时不必重做反解。
   */
  tposeLocalRotations: Record<string, [number, number, number, number]> | null;
  /** 源模型本身是否已是无姿态模型（拟合路径不同） */
  unposed: boolean;
  /**
   * 导出期权重生成配方。**产物里只有权重，没有这些参数**。
   * 字段名与 `binding-export.ts` 的 `BindExportInput` 默认值对齐。
   */
  export: RigExportSettings;
  /**
   * 是否已导出进 GLB。
   * - `false` → 绑定结果只活在内存，刷新即丢（这才是真正的重灾区）
   * - `true`  → 绑定结果已在资产里，本块降级为历史记录
   */
  exported: boolean;
}

/** 绑定会话的现场快照 —— 全部是**导出输入**，导出后产物里都找不到 */
export interface RigSession {
  /**
   * 骨骼名 → 世界坐标（用户摆出的**当前姿态**）。
   * 采纳发生在 bind pose 那一瞬，绑完骨架不再改动。
   */
  positions: Record<string, Vec3>;
  /** 「采纳为 bind pose」的快照；null = 尚未采纳 */
  bindPose: Record<string, Vec3> | null;
  /**
   * Skin Wrapper 三段半径（米）—— 导出的**直接输入**。
   * 对应 `skin-proxy.ts` 的 `SkinCylinderMap`，产物 GLB 里完全不存在。
   */
  skinCylinders: Record<string, SkinCylinderEntry> | null;
}

/** 一根骨的权重包裹体。字段与 `SkinCylinder` 对齐（复制一份以免 L4 反向依赖 L5） */
export interface SkinCylinderEntry {
  /** 该 wrapper 对应的 joint（= 其骨段起点骨） */
  bone: string;
  /** 三段半径（米），决定包裹范围与锥度 */
  radii: { top: number; medium: number; bottom: number };
  enabled: boolean;
}

/** 导出期权重生成配方。默认值取自 `binding-export.ts` 的 `runExport` 解构默认值 */
export interface RigExportSettings {
  /** 胶囊距离权重的衰减指数 */
  falloff: number;
  /** 权重截断下限（低于此值的影响骨丢弃） */
  eps: number;
  /** 每顶点保留的最大影响骨数 */
  maxInfluences: number;
  /** 权重平滑（拉普拉斯松弛）开关 */
  smoothWeights: boolean;
  smoothIters: number;
  smoothLambda: number;
  /** 导出时把左侧权重镜像到右侧（x 取反）。仅 Skin Wrapper 模式生效 */
  mirrorWeights: boolean;
}

export function defaultRigExportSettings(): RigExportSettings {
  return {
    falloff: 3.0,
    eps: 0.02,
    maxInfluences: 4,
    smoothWeights: true,
    smoothIters: 2,
    smoothLambda: 0.5,
    mirrorWeights: false,
  };
}

export function defaultRigSettings(): RigSettings {
  return {
    template: null,
    session: null,
    tposeLocalRotations: null,
    unposed: false,
    export: defaultRigExportSettings(),
    exported: false,
  };
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
    const s = r.session ?? null;

    if (r.template === null && Object.keys(s?.positions ?? {}).length > 0) {
      warn('/rig', 'W_META_RIG_NO_TEMPLATE', '有骨骼坐标但没有模板名，换模型时无法映射');
    }
    // 真正的数据丢失风险：摆过骨架 / 调过权重，但没导出 —— 刷新页面全没
    if (r.exported === false && s !== null) {
      const hasCyl = Object.keys(s.skinCylinders ?? {}).length > 0;
      warn(
        '/rig',
        'W_META_RIG_NOT_EXPORTED',
        hasCyl
          ? '绑定会话未导出：摆位与 Skin Wrapper 半径只活在内存，刷新即丢'
          : '绑定会话未导出：骨架摆位只活在内存，刷新即丢',
      );
    }
    // 模板名有了却没摆位 —— 多半是写了模板但会话没做（提示而非错误）
    if (r.template !== null && s === null && r.exported === false) {
      warn('/rig', 'W_META_RIG_EMPTY_SESSION', '指定了骨架模板但没有任何会话数据，导出时骨架会回落到模板默认 T-pose');
    }

    // 导出配方数值合理性
    const e = r.export;
    if (e !== null && e !== undefined) {
      if (!(e.falloff > 0)) {
        err('/rig/export/falloff', 'E_META_RIG_FALLOFF', 'falloff 必须 > 0');
      }
      if (!(e.eps >= 0 && e.eps < 1)) {
        err('/rig/export/eps', 'E_META_RIG_EPS', 'eps 必须在 [0, 1)');
      }
      if (!Number.isInteger(e.maxInfluences) || e.maxInfluences < 1 || e.maxInfluences > 8) {
        err('/rig/export/maxInfluences', 'E_META_RIG_MAXINF', 'maxInfluences 必须是 1..8 的整数（引擎侧 4 骨/顶点）');
      }
      if (!(e.smoothLambda >= 0 && e.smoothLambda <= 1)) {
        err('/rig/export/smoothLambda', 'E_META_RIG_LAMBDA', 'smoothLambda 必须在 0..1');
      }
      if (!Number.isInteger(e.smoothIters) || e.smoothIters < 0 || e.smoothIters > 16) {
        err('/rig/export/smoothIters', 'E_META_RIG_ITERS', 'smoothIters 必须是 0..16 的整数');
      }
      if (e.mirrorWeights === true && Object.keys(s?.skinCylinders ?? {}).length === 0) {
        warn('/rig/export/mirrorWeights', 'W_META_RIG_MIRROR_NOOP', '开了镜像权重但没有 Skin Wrapper 数据，镜像不生效（镜像仅作用于 Wrapper 模式）');
      }
    }

    // Skin Wrapper 半径必须是正数，否则算权重时出 NaN
    for (const [bone, cyl] of Object.entries(s?.skinCylinders ?? {})) {
      for (const seg of ['top', 'medium', 'bottom'] as const) {
        const v = cyl?.radii?.[seg];
        if (typeof v !== 'number' || !(v > 0)) {
          err(`/rig/session/skinCylinders/${bone}/radii/${seg}`, 'E_META_RIG_RADIUS', `半径必须 > 0，收到 ${String(v)}`);
        }
      }
    }
  }

  return out;
}

export function isAssetMetaValid(meta: unknown): boolean {
  return validateAssetMeta(meta).every((d) => d.severity !== 'error');
}
