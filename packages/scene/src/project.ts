/**
 * AetherProject —— 项目 / 工作区容器。
 *
 * ## 为什么必须有这一层
 *
 * 前面几层（`.meta` 资产元数据、prefab、scene）都需要一个**锚点**才有意义：
 *   - `.meta.json` 里的 `guid` —— 在什么范围内唯一？
 *   - 资产路径 `assets/characters/E-04/rigged.glb` —— 相对谁？
 *   - "通关后去 xx 场景" —— 场景清单在哪？
 *   - 子网格的 `layer: 3` —— 3 是什么层？
 *
 * 没有项目文件，这些问题全部靠**约定俗成的字符串**回答，而约定不会写进任何地方，
 * 半年后没人知道 `layer: 3` 是"可拾取物"还是"敌人"。
 *
 * 对标：Unity 的 `ProjectSettings/`、Unreal 的 `.uproject`、Godot 的 `project.godot`。
 *
 * ## 形态决策：单文件，不是目录
 *
 * - 选 `aether.project.json` 单文件（Godot / Unreal 风格），不学 Unity 的 `ProjectSettings/` 目录。
 * - 理由：本项目所有真源都是单文件 JSON（`roster.json` / `tokens.json`），保持一致；
 *   目录形态会把设置散成十几个小文件，改一个设置要 diff 一堆文件。
 *
 * ## 一个仓库 = 一个项目
 *
 * 现在仓库根就是项目根。**不做多项目**（YAGNI）——真有第二个游戏时，
 * 再引入 `projects[]` 数组，单文件形态天然支持向后扩展。
 *
 * ## 什么**不**在这里
 *
 * - ❌ **资产索引（guid → path）**：派生产物。集中索引文件是合并冲突制造机，
 *   应当启动时扫描各 `.meta.json` 重建，落 `.workbuddy/cache/assetdb.json`（gitignore）。
 * - ❌ **编辑器 UI 状态**：面板折叠、最近打开的文件 → `localStorage`（项目已有先例 `zh.assets.collapsed`）。
 * - ❌ **派生/烘焙产物**：减面结果、AO 贴图、流场 → `.workbuddy/cache/`，按 `.meta.sourceHash` 失效。
 */

import type { AssetPath } from './document';
import type { AssetGuid } from './asset-meta';

export const PROJECT_FILE_NAME = 'aether.project.json';
export const PROJECT_SCHEMA_VERSION = 1;

/** 层表上限。Unity 也是 32（位掩码友好）；索引即 MeshRenderer.layer 的值 */
export const MAX_LAYERS = 32;
/** 索引 0..7 是引擎内置层，不允许用户改名或删除 */
export const BUILTIN_LAYERS: readonly string[] = [
  'Default',
  'TransparentFX',
  'IgnoreRaycast',
  'Background',
  'Environment',
  'Character',
  'Pickup',
  'Trigger',
];

// ---------------------------------------------------------------- 渲染档位

/**
 * 目标渲染档位。与 `packages/gfx/src/device.ts` 的 `CapabilityTier` 对应：
 *   t0 = 最低（无扩展特性）· t1 / t2 / t3 = 逐级开启（见该文件 TIER_FEATURES）。
 *
 * 项目声明**目标档位**，运行时按设备实际能力取 min(目标, 实际) ——
 * 手机跑不到 t3 时自动降级，而不是直接黑屏。
 */
export type TargetTier = 't0' | 't1' | 't2' | 't3';

export interface RenderSettings {
  /** 目标能力档位（打包时被 clamp 到设备实际能力） */
  targetTier: TargetTier;
  /** 阴影是否启用（当前引擎未实现，占位以免后期改 schema） */
  shadows: boolean;
  /** 描边（inverted hull）是否启用 */
  outline: boolean;
  /** 后处理：bloom / 半调 / grading。关掉可显著省移动端带宽 */
  postFx: boolean;
  /** 渲染分辨率倍率（0.5 = 半分辨率渲染再放大，移动端常用） */
  renderScale: number;
  /** 目标帧率上限；0 = 不限 */
  targetFps: number;
}

export function defaultRenderSettings(): RenderSettings {
  return {
    targetTier: 't1',
    shadows: false,
    outline: true,
    postFx: true,
    renderScale: 1,
    targetFps: 60,
  };
}

// ---------------------------------------------------------------- 场景清单

/**
 * 场景清单条目（对应 Unity 的 Build Settings → Scenes In Build）。
 *
 * 有它才能回答"通关后加载哪个场景"、"打包时包含哪些场景"——
 * 现在这些信息散落在 GDD 文档里（Act1 城郊公路 / Act4 生化医院），代码无从消费。
 */
export interface SceneEntry {
  /** 场景文件路径（相对项目根） */
  path: AssetPath;
  /**
   * 场景 id。**从场景文件里读出来的 `SceneDocument.id`，这里是冗余副本** ——
   * 有了它，重命名场景文件后引用仍然成立（靠 id 找回，路径只作定位提示）。
   */
  id: string;
  /** 是否打进包体。false = 仅编辑器调试用（如 combat-test 沙盒） */
  enabled: boolean;
}

// ---------------------------------------------------------------- 输入

/**
 * 输入映射配置路径。
 *
 * GDD 已定：mobile 横屏、左侧虚拟摇杆 + 右侧动作键。
 * **具体的键位/摇杆参数不在这里** —— 那是独立的输入资产，项目只存指向它的路径，
 * 避免这个文件随着输入方案调整而频繁变动。
 */
export type InputMapRef = AssetPath | null;

// ---------------------------------------------------------------- 主结构

export interface AetherProject {
  schemaVersion: number;
  /** 项目稳定 id（跨机器协作时区分不同项目） */
  id: AssetGuid;
  /** 项目代号（英文，用于目录/包名） */
  name: string;
  /** 展示名（中文） */
  displayName: string;
  /** 游戏体裁/一句话定位，纯注释性 */
  description: string;

  /** 资产根目录。默认 `['assets']`，扫描 guid 索引时遍历这些目录 */
  assetRoots: AssetPath[];

  /** 场景清单。顺序即加载顺序，startIndex 指向启动场景 */
  scenes: SceneEntry[];
  /** 启动场景在 scenes 里的下标；null = 用第一个 enabled 的 */
  startIndex: number | null;

  /**
   * 层表。索引 = `MeshRenderer.layer` / `Collider.layer` 的值。
   * 前 8 个是引擎内置层（BUILTIN_LAYERS），不可删改。
   */
  layers: string[];
  /** 标签表（比层更自由的语义标注，如 'Boss' / 'Loot' / 'Destructible'） */
  tags: string[];

  render: RenderSettings;
  /** 默认风格：指向由 tokens.json 生成的风格文件（EnvironmentData.postOverride 的缺省值） */
  defaultStyle: AssetPath | null;
  /** 输入映射资产路径 */
  inputMap: InputMapRef;
  /** 玩法配置：角色定义/难度曲线/掉落表，指向独立的 gameplay 资产（Phase 3） */
  gameplayConfig: AssetPath | null;

  /**
   * 材质库路径。**一个项目一套共享材质库** ——
   * 跨场景复用美术调校；场景文件只存 `MaterialBindingRef` 引用与覆盖。
   */
  materialLibrary: AssetPath | null;

  /**
   * 行为（脚本）目录。Inspector 的 Script 组件下拉项从这里扫描 `BehaviorDef`。
   * 代码资产不入 JSON，这里只是定位路径。
   */
  behaviorRoots: AssetPath[];

  meta: ProjectMeta;
}

export interface ProjectMeta {
  createdAt?: string;
  updatedAt?: string;
  /** 引擎版本要求（当前引擎无版本号，预留） */
  engineVersion?: string;
  notes?: string;
}

/** 新项目的最小合法形态 */
export function createEmptyProject(name: string, displayName = name): AetherProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: `pr_${Math.random().toString(36).slice(2, 10)}`,
    name,
    displayName,
    description: '',
    assetRoots: ['assets'],
    scenes: [],
    startIndex: null,
    layers: [...BUILTIN_LAYERS],
    tags: [],
    render: defaultRenderSettings(),
    defaultStyle: null,
    inputMap: null,
    gameplayConfig: null,
    materialLibrary: 'assets/materials/library.mat.json',
    behaviorRoots: ['assets/behaviors'],
    meta: { createdAt: now, updatedAt: now },
  };
}

// ---------------------------------------------------------------- 校验

export interface ProjectDiagnostic {
  severity: 'error' | 'warning';
  path: string;
  code: string;
  message: string;
}

export function validateProject(p: unknown): ProjectDiagnostic[] {
  const out: ProjectDiagnostic[] = [];
  const err = (path: string, code: string, message: string): void => {
    out.push({ severity: 'error', path, code, message });
  };
  const warn = (path: string, code: string, message: string): void => {
    out.push({ severity: 'warning', path, code, message });
  };

  if (typeof p !== 'object' || p === null) {
    err('', 'E_PROJ_NOT_OBJECT', '项目文件根节点必须是对象');
    return out;
  }
  const d = p as Partial<AetherProject>;

  if (typeof d.schemaVersion !== 'number') err('/schemaVersion', 'E_PROJ_VERSION', 'schemaVersion 缺失');
  else if (d.schemaVersion > PROJECT_SCHEMA_VERSION) {
    err('/schemaVersion', 'E_PROJ_VERSION_FUTURE', `项目版本 ${d.schemaVersion} 高于支持的 ${PROJECT_SCHEMA_VERSION}`);
  }
  if (typeof d.name !== 'string' || d.name.length === 0) err('/name', 'E_PROJ_NAME', 'name 必须是非空字符串');
  if (typeof d.id !== 'string' || d.id.length === 0) err('/id', 'E_PROJ_ID', 'id 必须是非空字符串');

  // ---- 资产根 ----
  if (!Array.isArray(d.assetRoots) || d.assetRoots.length === 0) {
    err('/assetRoots', 'E_PROJ_ROOTS', 'assetRoots 必须是非空数组');
  } else if (d.assetRoots.some((r) => typeof r !== 'string' || r.length === 0)) {
    err('/assetRoots', 'E_PROJ_ROOTS_ITEM', 'assetRoots 里不能有空字符串');
  }

  // ---- 场景清单 ----
  if (!Array.isArray(d.scenes)) {
    err('/scenes', 'E_PROJ_SCENES', 'scenes 必须是数组');
  } else {
    const seen = new Set<string>();
    d.scenes.forEach((s, i) => {
      if (typeof s?.path !== 'string' || s.path.length === 0) {
        err(`/scenes/${i}/path`, 'E_PROJ_SCENE_PATH', '场景 path 必须是非空字符串');
        return;
      }
      if (seen.has(s.path)) {
        err(`/scenes/${i}/path`, 'E_PROJ_SCENE_DUP', `场景重复登记：${s.path}`);
      } else {
        seen.add(s.path);
      }
      if (typeof s.id !== 'string' || s.id.length === 0) {
        warn(`/scenes/${i}/id`, 'W_PROJ_SCENE_ID', '场景 id 为空，重命名文件后引用将无法找回');
      }
    });

    // 启动场景下标必须落在合法范围且指向 enabled 的场景
    const si = d.startIndex;
    if (si !== null && si !== undefined) {
      if (!Number.isInteger(si) || si < 0 || si >= d.scenes.length) {
        err('/startIndex', 'E_PROJ_START_RANGE', `startIndex 越界：${si}`);
      } else if (d.scenes[si]?.enabled === false) {
        err('/startIndex', 'E_PROJ_START_DISABLED', `启动场景 ${si} 在清单里被禁用`);
      }
    } else if (d.scenes.length > 0 && !d.scenes.some((s) => s.enabled)) {
      warn('/scenes', 'W_PROJ_NO_ENABLED', '没有任何场景被启用，打包后无内容可加载');
    }
  }

  // ---- 层表 ----
  if (!Array.isArray(d.layers)) {
    err('/layers', 'E_PROJ_LAYERS', 'layers 必须是数组');
  } else {
    if (d.layers.length > MAX_LAYERS) err('/layers', 'E_PROJ_LAYERS_MAX', `层表最多 ${MAX_LAYERS} 项`);
    // 内置层不可改名：SceneObject.layer 的语义靠索引稳定，改了名字老场景就对不上
    BUILTIN_LAYERS.forEach((want, i) => {
      if (d.layers![i] !== want) {
        err(`/layers/${i}`, 'E_PROJ_LAYER_BUILTIN', `内置层 ${i} 必须是 "${want}"，实际为 "${String(d.layers![i])}"`);
      }
    });
    const names = d.layers.filter((x): x is string => typeof x === 'string');
    const dup = names.find((x, i) => names.indexOf(x) !== i);
    if (dup !== undefined) err('/layers', 'E_PROJ_LAYER_DUP', `层名重复：${dup}`);
  }

  // ---- 标签 ----
  if (!Array.isArray(d.tags)) {
    err('/tags', 'E_PROJ_TAGS', 'tags 必须是数组');
  } else {
    const dupTag = d.tags.find((x, i) => d.tags!.indexOf(x) !== i);
    if (dupTag !== undefined) err('/tags', 'E_PROJ_TAG_DUP', `标签重复：${dupTag}`);
  }

  // ---- 渲染 ----
  const r = d.render;
  if (typeof r !== 'object' || r === null) {
    err('/render', 'E_PROJ_RENDER', 'render 缺失');
  } else {
    const tiers: TargetTier[] = ['t0', 't1', 't2', 't3'];
    if (!tiers.includes(r.targetTier as TargetTier)) {
      err('/render/targetTier', 'E_PROJ_TIER', `targetTier 必须是 ${tiers.join(' / ')}`);
    }
    if (!(r.renderScale > 0) || r.renderScale > 2) {
      err('/render/renderScale', 'E_PROJ_SCALE', 'renderScale 必须在 (0, 2]');
    }
    if (!Number.isInteger(r.targetFps) || r.targetFps < 0) {
      err('/render/targetFps', 'E_PROJ_FPS', 'targetFps 必须是非负整数（0 = 不限）');
    }
  }

  // ---- 路径后缀的合理性提示（不强制，只提醒） ----
  const extHint: Array<[AssetPath | null | undefined, string]> = [
    [d.defaultStyle, '风格文件'],
    [d.materialLibrary, '材质库'],
    [d.inputMap, '输入映射'],
    [d.gameplayConfig, '玩法配置'],
  ];
  for (const [p2, label] of extHint) {
    if (typeof p2 === 'string' && p2.length > 0 && !p2.endsWith('.json')) {
      warn('/paths', 'W_PROJ_EXT', `${label} 路径建议以 .json 结尾：${p2}`);
    }
  }

  return out;
}

export function isProjectValid(p: unknown): boolean {
  return validateProject(p).every((d) => d.severity !== 'error');
}
