/**
 * SceneDocument —— 场景文件格式的唯一真源（引擎层，packages/scene）。
 *
 * 设计前提（详见 docs/14）：
 * 1. **场景是游戏开发的唯一数据载体**。一切内容（网格 / 灯光 / 相机 / 刷怪点 / 房间语义）
 *    都必须是场景文件里的节点与组件，任何"在代码里 new 一个地面"的做法都是违规。
 * 2. **本文件只描述数据，不描述运行时**。文件里没有 GPUBuffer、没有 Float32Array 顶点、
 *    没有对象引用——只有路径引用、标量和可静态校验的结构。运行时表示见 graph.ts（S1）。
 * 3. **扁平节点表 + parent 引用，不用嵌套树**。理由：
 *    - diff 友好：嵌套树改一个节点会整块位移，git diff 无法阅读（项目吃过 1700 行整文件 diff 的亏）；
 *    - 无递归：JSON.parse / 序列化 / 遍历都不用担心深嵌套栈；
 *    - 与 prefab override 的 propertyPath 寻址（'/nd_x8fk/transform.position'）天然一致。
 * 4. **稳定 NodeId，禁用数组下标做引用**。编辑器现有 `SceneObject[]` 用下标寻址，
 *    注释里已写明"索引一变就打乱 uniform 槽位"——序列化格式必须在数据层根除这个隐患。
 *
 * 依赖方向：本文件是 L4 契约，只能向下依赖（无 import 即是最强保证）。
 * 它不认识 WebGPU、不认识 roster、不认识编辑器——保持"纯数据 schema"。
 */

// ---------------------------------------------------------------- 基础标量

/** 场景文件格式版本。每次结构性变更 +1，并必须在 MIGRATIONS 里补一条升级函数 */
export const SCHEMA_VERSION = 1;

export const SCENE_FILE_EXT = '.scene.json';
/** 预制体：可复用的节点子树（僵尸 / 房间 / 门 / 掉落物） */
export const PREFAB_FILE_EXT = '.prefab.json';

/** 节点稳定 id。人类可读短串，如 `'nd_x8fk2a'`。全场景唯一，跨文件引用也靠它 */
export type NodeId = string;
/** 仓库根相对 POSIX 路径，如 `'assets/characters/E-04/rigged.glb'` */
export type AssetPath = string;
/** `#rrggbb`，与 assets/style/tokens.json 的色值约定一致 */
export type ColorHex = string;

export type Vec3 = [number, number, number];
/** 四元数 xyzw（与 m4.Quat 一致），不用欧拉角存盘：欧拉角有万向锁且插值不唯一 */
export type Quat = [number, number, number, number];

// ---------------------------------------------------------------- 资源与材质引用

/**
 * 资产引用：路径 + 资产内部子资源定位。
 *
 * 只存引用、绝不内联资产——一个 40MB 的 GLB 内联进 JSON 会同时毁掉 git diff 与 LFS。
 */
export interface AssetRef {
  path: AssetPath;
  /**
   * 资产内部定位。GLB 约定（与 packages/scene/gltf.ts 的 SubMeshRange 对齐）：
   *   `'prim:Body#0'`  primitiveKey（最稳，首选）
   *   `'node:/Armature/Body'`  nodePath
   *   `'name:Body'`  nodeName
   *   `'index:3'`  兜底
   */
  sub?: string;
}

/**
 * 材质三层语义（与编辑器 materials.ts 的 shared / instance / override 一一对应）。
 * 场景文件不存材质全量定义，只存"引用 + 覆盖"，共享材质活在材质库文件里。
 */
export type MaterialRef =
  /** 直接引用材质库里的共享材质（改库即全场景生效） */
  | { type: 'shared'; id: string }
  /** 由共享材质实例化出的场景内材质（独立可调，仍记录来源） */
  | { type: 'instance'; id: string; base: string }
  /** 在任意 base 之上打补丁（override 层，可丢弃回滚） */
  | { type: 'override'; base: MaterialRef; patch: MaterialPatch };

/** 材质可覆盖字段（与 material-panel 的三层编辑面一一对应，字段名对齐 MaterialState） */
export interface MaterialPatch {
  albedo?: ColorHex;
  roughness?: number;
  metallic?: number;
  emissive?: ColorHex;
  emissiveStrength?: number;
  /** 描边宽度倍率；<= 0 表示本子网格不描边 */
  outlineScale?: number;
  /** 是否走 albedo 贴图采样（GLB 带贴图的子网格） */
  useTexture?: boolean;
  texture?: AssetRef;
}

/** 子网格 → 材质的绑定。匹配优先级：primitiveKey > nodePath > nodeName > index */
export type MaterialMatch =
  | { by: 'primitiveKey'; value: string }
  | { by: 'nodePath'; value: string }
  | { by: 'nodeName'; value: string }
  | { by: 'index'; value: number };

export interface MaterialBinding {
  match: MaterialMatch;
  material: MaterialRef;
}

// ---------------------------------------------------------------- 变换

/**
 * 变换存 TRS 而非矩阵：
 * - 可编辑（Inspector 显示 position/rotation/scale 三行）；
 * - 可插值、可局部修改；
 * - 矩阵会在反复编辑后累积剪切，不可逆。
 */
export interface TransformData {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

export function identityTransform(): TransformData {
  return { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
}

// ---------------------------------------------------------------- 组件

export const ComponentKind = {
  MeshRenderer: 'MeshRenderer',
  Light: 'Light',
  Camera: 'Camera',
  Collider: 'Collider',
  SpawnPoint: 'SpawnPoint',
  RoomVolume: 'RoomVolume',
  NavZone: 'NavZone',
  Script: 'Script',
} as const;
export type ComponentKind = (typeof ComponentKind)[keyof typeof ComponentKind];

export interface ComponentBase {
  kind: ComponentKind;
  enabled: boolean;
}

/**
 * 网格渲染。
 *
 * 粒度决策：**一个节点 = 一个可变换对象 = 一个 SceneObject**，GLB 内部的骨骼/组节点
 * **不提升为场景节点**（一个 80k 面角色有 30+ 骨骼节点，全提升会淹没 Hierarchy 并撑爆文件）。
 * 模型内部层级保留在资产的 nodeTree 里，只用于材质匹配与层级面板展示（现有行为不变）。
 */
export interface MeshRendererComponent extends ComponentBase {
  kind: typeof ComponentKind.MeshRenderer;
  source: MeshSource;
  /** 逐子网格材质绑定；未列出者回落资产自带默认材质 */
  materials: MaterialBinding[];
  visible: boolean;
  /** 渲染层（引擎保留字段，当前 shader 未消费，先占位以免后期改 schema） */
  layer: number;
  /**
   * 导入期烘焙系数：GLB 归一化到 MODEL_RULER_HEIGHT_M 的缩放。
   * 存盘是为了换模型时保持身高一致，也便于审计"这个物体被缩放过"。
   */
  importScale: number;
}

export type MeshSource =
  /** 程序化几何（地面 / 碰撞盒 / 占位体），参数按 shape 约定 */
  | { type: 'builtin'; shape: 'box' | 'sphere' | 'cylinder' | 'capsule' | 'plane'; params: number[] }
  /** 外部资产 */
  | { type: 'asset'; ref: AssetRef };

/**
 * 灯光。
 *
 * 能力约束（必须写在类型旁边，否则会被当成 bug）：
 * 当前 packages/render 的 Lights uniform 只有 40 floats（10×vec4），
 * 硬件上只支持 **1 盏 directional（key）+ 1 盏 point**。
 * 场景文件**允许声明任意多盏**（数据层不设上限），运行时按 `priority` 降序取 top-N，
 * 落选者降级并在编辑器里标黄提示。等 Phase 2 clustered 落地后自动支持多灯。
 */
export interface LightComponent extends ComponentBase {
  kind: typeof ComponentKind.Light;
  type: 'directional' | 'point' | 'spot';
  color: ColorHex;
  intensity: number;
  /** point / spot 的有效半径（米）；directional 忽略 */
  range: number;
  /** spot 张角（度）；其他类型忽略 */
  spotAngle: number;
  /** 是否投影（当前引擎未实现阴影，占位字段） */
  castShadow: boolean;
  /** 降级排序权重，越大越优先占用 shader 槽位。默认 0 */
  priority: number;
}

/**
 * 相机（Play mode 的游戏相机）。
 *
 * Edit mode 用编辑器轨道相机（存在 SceneDocument.editorCamera），**两者互不相干**——
 * 编辑时怎么转视角都不该影响玩家看到的画面。
 */
export interface CameraComponent extends ComponentBase {
  kind: typeof ComponentKind.Camera;
  fovDeg: number;
  near: number;
  far: number;
  /** GDD：第三人称俯视、mobile 横屏 */
  mode: 'orbit-follow' | 'fixed';
  /** orbit-follow 跟随的目标节点 */
  followTarget: NodeId | null;
  /** 俯角（度，正值向下看） */
  pitchDeg: number;
  /** 跟随距离（米） */
  distance: number;
  /** 相对目标朝向的偏航偏移（度） */
  yawOffsetDeg: number;
}

export interface ColliderComponent extends ComponentBase {
  kind: typeof ComponentKind.Collider;
  shape:
    | { type: 'box'; halfExtents: Vec3 }
    | { type: 'sphere'; radius: number }
    | { type: 'capsule'; radius: number; height: number };
  /** 触发器：不产生物理响应，只发事件（门 / 拾取范围 / 房间入口） */
  isTrigger: boolean;
  layer: number;
}

/**
 * 刷怪点。characterId 直接引用 assets/characters/roster.json 的角色 id。
 *
 * 注意：roster.json 是**资料库**（美术/设计数据），不能派生出运行时 CharacterDef
 * （缺胶囊半径/质量/转向速率等 11 项，见 roster.generated.ts 头部）。
 * 因此角色 prefab 是必需的一环：roster 管"长什么样/数值多少"，prefab 管"怎么摆进场景"。
 */
export interface SpawnPointComponent extends ComponentBase {
  kind: typeof ComponentKind.SpawnPoint;
  /** roster.json 的角色 id：E-01..E-05 / B-01..B-03 */
  characterId: string;
  count: number;
  /** 波次索引，0 = 初始波 */
  wave: number;
  trigger: 'room-enter' | 'wave-clear' | 'timer' | 'manual';
  /** trigger 触发后的延迟（秒） */
  delaySec: number;
  /** 生成散布半径（米），避免重叠穿模 */
  radius: number;
  /** 显式指定 prefab；null = 按 characterId 查默认角色 prefab */
  prefab: AssetRef | null;
}

/** 房间语义体（对应 GDD §4.2 房间池 / §4.3 楼层主题） */
export interface RoomVolumeComponent extends ComponentBase {
  kind: typeof ComponentKind.RoomVolume;
  roomType: 'combat' | 'event' | 'elite' | 'shop' | 'rest' | 'boss';
  theme: 'fire' | 'swarm' | 'corrosion' | 'dark' | 'none';
  bounds: AabbData;
  /** 清场条件（GDD §4.2 表格） */
  clearRule: 'kill-all' | 'elite-dead' | 'interact' | 'none';
  /** 楼层深度 1..3（GDD §4.1 固定 3 层） */
  depth: number;
}

/** 导航区：packages/ai 流场寻路的网格作用域 */
export interface NavZoneComponent extends ComponentBase {
  kind: typeof ComponentKind.NavZone;
  bounds: AabbData;
  /** 流场网格分辨率（米）。越小越精确、内存越炸 */
  cellSize: number;
  /** 离线烘焙产物（可选）；null = 运行时按碰撞体实时烘焙 */
  baked: AssetRef | null;
}

/**
 * 脚本行为。**只存行为 id + 参数，不存代码字符串**——
 * 一旦允许场景文件携带可执行文本，JSON 就变成了远程代码执行的入口，
 * 且无法静态校验、无法 diff。行为由注册表 key 解析。
 */
export interface ScriptComponent extends ComponentBase {
  kind: typeof ComponentKind.Script;
  behavior: string;
  params: Record<string, number | string | boolean>;
}

export type ComponentData =
  | MeshRendererComponent
  | LightComponent
  | CameraComponent
  | ColliderComponent
  | SpawnPointComponent
  | RoomVolumeComponent
  | NavZoneComponent
  | ScriptComponent;

/**
 * 同一节点上允许重复的组件类型。
 * 其余类型每种最多一个——一盏节点挂两盏灯是设计错误，不是特性。
 */
export const REPEATABLE_COMPONENTS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  ComponentKind.Script,
]);

// ---------------------------------------------------------------- 节点与预制体

export interface AabbData {
  center: Vec3;
  size: Vec3;
}

/**
 * 预制体实例。
 *
 * override 寻址用 propertyPath：`'/nd_x8fk/transform.position'`、`'/nd_x8fk/Light.intensity'`
 * （节点 id + 组件类型 + 字段名）。用 id 而非下标，prefab 内部增删节点不会打乱路径。
 */
export interface PrefabInstance {
  ref: AssetRef;
  overrides: Record<string, unknown>;
  /** 断链：true 后不再跟随源 prefab 的更新（一次性特化） */
  disconnected: boolean;
}

export interface SceneNode {
  id: NodeId;
  name: string;
  /** 父节点；null = 根节点。扁平表 + parent 引用，不用 children 嵌套 */
  parent: NodeId | null;
  transform: TransformData;
  /** 层级面板显隐（编辑语义：隐藏 = 不画 + 不拾取，与组件 enabled 正交） */
  visible: boolean;
  /** 是否可被鼠标拾取。地面/天空设 false，避免点空白就选中地板 */
  pickable: boolean;
  components: ComponentData[];
  /** 非 null 时本节点是预制体实例：components 只存 override 子集 */
  prefab: PrefabInstance | null;
}

// ---------------------------------------------------------------- 环境

/**
 * 场景级环境（不是组件——它是全局单例，不属于任何节点）。
 *
 * 这些字段原本散落在编辑器的 LabParams 里当"渲染调试参数"。
 * 引入场景后它们成为**场景内容**：每个场景（火场 / 暗巷）可以有自己的环境，
 * 见 GDD §4.3 楼层主题。
 */
export interface EnvironmentData {
  ambient: { color: ColorHex; intensity: number };
  /** 半球补光：天空色 + 地面反弹色 */
  hemisphere: {
    sky: ColorHex;
    skyIntensity: number;
    ground: ColorHex;
    groundIntensity: number;
  };
  fog: { color: ColorHex; density: number };
  rim: { color: ColorHex; intensity: number; power: number; topBias: number };
  /**
   * 风格 / 后处理覆写：引用 assets/style/*.post.json。
   * null = 用引擎默认（由 tokens.json 生成，经 UI 层注入，见 ADR-007）。
   */
  postOverride: AssetPath | null;
}

export function defaultEnvironment(): EnvironmentData {
  return {
    ambient: { color: '#2a2f3a', intensity: 0.35 },
    hemisphere: {
      sky: '#8fb4d9',
      skyIntensity: 0.45,
      ground: '#3a2f28',
      groundIntensity: 0.18,
    },
    fog: { color: '#0e1013', density: 0.012 },
    rim: { color: '#ffffff', intensity: 0.5, power: 2.5, topBias: 0.35 },
    postOverride: null,
  };
}

// ---------------------------------------------------------------- 文档

/** 编辑器相机（Edit mode 专用）。Play mode 完全不读它 */
export interface EditorCameraData {
  target: Vec3;
  distance: number;
  /** 弧度 */
  yaw: number;
  /** 弧度 */
  elevation: number;
}

export interface SceneDocument {
  schemaVersion: number;
  /** 场景唯一标识，跨场景引用（如"通关后去 xx 场景"）用 */
  id: string;
  name: string;
  /** 所属幕（GDD 4 幕：Act1 城郊公路 / Act2 / Act3 / Act4 生化医院） */
  act: string | null;
  environment: EnvironmentData;
  editorCamera: EditorCameraData;
  /** Play mode 启动相机；null = 取场景里第一个启用的 Camera 组件，再没有就回落 EditorCamera */
  entryCamera: NodeId | null;
  /** 资源依赖清单。保存时由引用收集自动重算——预加载与打包都靠它 */
  dependencies: AssetPath[];
  nodes: SceneNode[];
  meta: SceneMeta;
}

export interface SceneMeta {
  createdAt?: string;
  updatedAt?: string;
  author?: string;
  notes?: string;
}

/** 预制体文档：一棵可复用的节点子树（内部结构复用 SceneNode，prefab 字段可嵌套） */
export interface PrefabDocument {
  schemaVersion: number;
  id: string;
  name: string;
  /** 根节点 id */
  root: NodeId;
  nodes: SceneNode[];
  dependencies: AssetPath[];
  meta: SceneMeta;
}

// ---------------------------------------------------------------- 工厂

/** 新场景的最小合法形态：一个默认环境 + 一盏主光 + 一台游戏相机，零网格 */
export function createEmptySceneDocument(name: string): SceneDocument {
  const keyLightId = 'nd_key0000';
  const cameraId = 'nd_cam0000';
  const now = new Date().toISOString();

  return {
    schemaVersion: SCHEMA_VERSION,
    id: `sc_${Math.random().toString(36).slice(2, 10)}`,
    name,
    act: null,
    environment: defaultEnvironment(),
    editorCamera: { target: [0, 1, 0], distance: 8, yaw: 0.6, elevation: 0.45 },
    entryCamera: cameraId,
    dependencies: [],
    nodes: [
      {
        id: keyLightId,
        name: 'Key Light',
        parent: null,
        transform: identityTransform(),
        visible: true,
        pickable: false,
        prefab: null,
        components: [
          {
            kind: ComponentKind.Light,
            enabled: true,
            type: 'directional',
            color: '#fff3e0',
            intensity: 1.2,
            range: 0,
            spotAngle: 0,
            castShadow: false,
            priority: 100,
          },
        ],
      },
      {
        id: cameraId,
        name: 'Main Camera',
        parent: null,
        transform: identityTransform(),
        visible: true,
        pickable: false,
        prefab: null,
        components: [
          {
            kind: ComponentKind.Camera,
            enabled: true,
            fovDeg: 45,
            near: 0.1,
            far: 200,
            mode: 'orbit-follow',
            followTarget: null,
            pitchDeg: 55,
            distance: 9,
            yawOffsetDeg: 0,
          },
        ],
      },
    ],
    meta: { createdAt: now, updatedAt: now },
  };
}

// ---------------------------------------------------------------- 校验

export interface SceneDiagnostic {
  severity: 'error' | 'warning';
  /** JSON Pointer 风格定位，如 `/nodes/3/transform/rotation` */
  path: string;
  code: string;
  message: string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function isQuat(v: unknown): v is Quat {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * 结构校验。**不抛异常**，返回诊断列表——加载时应当把 warning 也展示给用户
 * （静默修数据是最坏的做法：用户以为保存成功，实际被偷偷改了）。
 */
export function validateSceneDocument(doc: unknown): SceneDiagnostic[] {
  const out: SceneDiagnostic[] = [];
  const err = (path: string, code: string, message: string): void => {
    out.push({ severity: 'error', path, code, message });
  };
  const warn = (path: string, code: string, message: string): void => {
    out.push({ severity: 'warning', path, code, message });
  };

  if (typeof doc !== 'object' || doc === null) {
    err('', 'E_NOT_OBJECT', '场景文件根节点必须是对象');
    return out;
  }
  const d = doc as Partial<SceneDocument>;

  if (typeof d.schemaVersion !== 'number' || !Number.isInteger(d.schemaVersion)) {
    err('/schemaVersion', 'E_VERSION', 'schemaVersion 缺失或不是整数');
  } else if (d.schemaVersion > SCHEMA_VERSION) {
    err(
      '/schemaVersion',
      'E_VERSION_FUTURE',
      `场景版本 ${d.schemaVersion} 高于当前支持的 ${SCHEMA_VERSION}，请升级编辑器或补迁移链`,
    );
  } else if (d.schemaVersion < SCHEMA_VERSION) {
    warn('/schemaVersion', 'W_VERSION_OLD', `场景版本 ${d.schemaVersion}，加载时将自动迁移到 ${SCHEMA_VERSION}`);
  }

  if (typeof d.id !== 'string' || d.id.length === 0) err('/id', 'E_ID', 'id 必须是非空字符串');
  if (typeof d.name !== 'string' || d.name.length === 0) err('/name', 'E_NAME', 'name 必须是非空字符串');

  if (!Array.isArray(d.nodes)) {
    err('/nodes', 'E_NODES', 'nodes 必须是数组（扁平节点表）');
    return out;
  }

  // ---- id 唯一性 ----
  const byId = new Map<NodeId, number>();
  d.nodes.forEach((n, i) => {
    if (typeof n?.id !== 'string' || n.id.length === 0) {
      err(`/nodes/${i}/id`, 'E_NODE_ID', '节点 id 必须是非空字符串');
      return;
    }
    if (byId.has(n.id)) {
      err(`/nodes/${i}/id`, 'E_NODE_ID_DUP', `节点 id 重复：${n.id}（首次出现在 /nodes/${byId.get(n.id)}）`);
    } else {
      byId.set(n.id, i);
    }
  });

  // ---- TRS ----
  d.nodes.forEach((n, i) => {
    const t = n?.transform;
    if (t === undefined) {
      err(`/nodes/${i}/transform`, 'E_TRS', 'transform 缺失');
      return;
    }
    if (!isVec3(t.position)) err(`/nodes/${i}/transform/position`, 'E_TRS_POS', 'position 必须是 3 个有限数');
    if (!isQuat(t.rotation)) {
      err(`/nodes/${i}/transform/rotation`, 'E_TRS_ROT', 'rotation 必须是 4 个有限数（四元数 xyzw）');
    } else {
      const [x, y, z, w] = t.rotation;
      if (Math.hypot(x, y, z, w) < 1e-6) {
        err(`/nodes/${i}/transform/rotation`, 'E_TRS_ROT_ZERO', '四元数为零向量，无法表示旋转');
      }
    }
    if (!isVec3(t.scale)) {
      err(`/nodes/${i}/transform/scale`, 'E_TRS_SCALE', 'scale 必须是 3 个有限数');
    } else if (t.scale.some((s) => Math.abs(s) < 1e-6)) {
      warn(`/nodes/${i}/transform/scale`, 'W_TRS_SCALE_ZERO', 'scale 含 0 分量，矩阵不可逆（拾取与法线都会退化）');
    }
  });

  // ---- parent 存在性 + 环检测 ----
  d.nodes.forEach((n, i) => {
    const p = n?.parent;
    if (p === null || p === undefined) return;
    if (!byId.has(p)) {
      err(`/nodes/${i}/parent`, 'E_PARENT_MISSING', `parent 指向不存在的节点：${p}`);
      return;
    }
    // 沿 parent 链上溯，回到自己 = 成环
    let cur: NodeId | null = p;
    let guard = 0;
    while (cur !== null && guard++ <= d.nodes!.length) {
      if (cur === n!.id) {
        err(`/nodes/${i}/parent`, 'E_PARENT_CYCLE', `parent 链成环，节点 ${n!.id} 是自己的祖先`);
        break;
      }
      cur = d.nodes!.find((x) => x?.id === cur)?.parent ?? null;
    }
  });

  // ---- 组件 ----
  d.nodes.forEach((n, i) => {
    const comps = n?.components;
    if (!Array.isArray(comps)) {
      err(`/nodes/${i}/components`, 'E_COMPONENTS', 'components 必须是数组');
      return;
    }
    const seen = new Map<string, number>();
    comps.forEach((c, ci) => {
      const at = `/nodes/${i}/components/${ci}`;
      if (typeof c?.kind !== 'string') {
        err(at, 'E_COMPONENT_KIND', '组件缺少 kind');
        return;
      }
      if (!(Object.values(ComponentKind) as string[]).includes(c.kind)) {
        err(at, 'E_COMPONENT_UNKNOWN', `未知组件类型：${c.kind}`);
        return;
      }
      const prev = seen.get(c.kind);
      if (prev !== undefined && !REPEATABLE_COMPONENTS.has(c.kind as ComponentKind)) {
        err(at, 'E_COMPONENT_DUP', `组件 ${c.kind} 在同一节点上重复（首次出现在 ${prev}）`);
      } else {
        seen.set(c.kind, ci);
      }

      if (c.kind === ComponentKind.Light) {
        const l = c as LightComponent;
        if (!HEX_RE.test(l.color)) err(`${at}/color`, 'E_COLOR', `灯光颜色格式非法：${String(l.color)}`);
        if (l.intensity < 0) err(`${at}/intensity`, 'E_LIGHT_INTENSITY', '灯光强度不能为负');
        if ((l.type === 'point' || l.type === 'spot') && !(l.range > 0)) {
          err(`${at}/range`, 'E_LIGHT_RANGE', `${l.type} 光的 range 必须 > 0`);
        }
      }
      if (c.kind === ComponentKind.SpawnPoint) {
        const s = c as SpawnPointComponent;
        if (typeof s.characterId !== 'string' || s.characterId.length === 0) {
          err(`${at}/characterId`, 'E_SPAWN_CHAR', 'characterId 必须引用 roster.json 的角色 id');
        }
        if (!Number.isInteger(s.count) || s.count < 0) {
          err(`${at}/count`, 'E_SPAWN_COUNT', 'count 必须是非负整数');
        }
      }
    });
  });

  // ---- entryCamera 指向 ----
  if (d.entryCamera !== null && d.entryCamera !== undefined && !byId.has(d.entryCamera)) {
    err('/entryCamera', 'E_ENTRY_CAMERA', `entryCamera 指向不存在的节点：${d.entryCamera}`);
  }

  return out;
}

/** 只关心"能不能加载"时的快捷判定 */
export function isSceneDocumentValid(doc: unknown): boolean {
  return validateSceneDocument(doc).every((x) => x.severity !== 'error');
}
