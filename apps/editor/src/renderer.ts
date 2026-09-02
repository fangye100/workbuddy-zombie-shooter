import type { GpuContext } from '@aether/gfx';
import {
  type GizmoMode,
  type GizmoSpace,
  RendererCore,
  type CoreObjectDraw,
  type CoreSubMeshDraw,
  type CoreHighlight,
  type CoreGizmo,
  type RenderFrameInput,
  SLOT_BYTES,
  SLOT_FLOATS,
  MAX_MATERIAL_SLOTS,
  MAX_OBJECTS,
  FRAME_FLOATS,
  LIGHTS_FLOATS,
  TOON_FLOATS,
  POST_FLOATS,
} from '@aether/render';
import {
  packSkin,
  createBox,
  createCapsule,
  createCylinder,
  createPlane,
  createSphere,
  meshStats,
  weldMesh,
  type MeshData,
} from '@aether/scene';
import * as m4 from '@aether/core';
import { EditorState } from './services/editor-state';
import { SelectionService } from './services/selection';
import { HierarchyService } from './services/hierarchy';
import { MaterialPanelService } from './services/material-panel';
import { type LabParams, type MaterialState } from './params';
import {
  cloneMaterial,
  planSubMeshCount,
  sharedId,
  slotSource,
  slotState,
  type MaterialInstance,
  type MaterialRef,
  type MaterialSlot,
  type MaterialSource,
} from './materials';
import {
  matchBindings,
  type MatchReportEntry,
  type MeshNodeBinding,
  type MeshNodeStub,
  type PrimitiveBinding,
} from './binding';
import type { GltfNodeTree, SubMeshRange, SkeletonData, AnimClip } from '@aether/scene';
import {
  createSkinState,
  evalJointMatrices,
  advance as skinAdvance,
  clipNames,
  currentClip,
  selectClip,
  play as skinPlay,
  pause as skinPause,
  setLoop as skinSetLoop,
  setSpeed as skinSetSpeed,
  seek as skinSeek,
  type SkinState,
} from '@aether/render';

/** 选中高亮色（白线轮廓），纯色不经过 tonemap，要够亮才压得住暗背景 */
const SEL_COLOR = '#FFFFFF';
/** 层级面板悬停高亮色（尸绿）：必须与选中的白色明显区分，且同样压得住暗背景 */
const HOVER_COLOR = '#8FD14F';

/**
 * Game Editor 渲染器（原 Shader Lab）。
 *
 * Pass 顺序（与 docs/07 §4.4 一致）：
 *   1. scene   MRT → hdr(rgba16float) + aux(rgba16float, a = 描边 mask)
 *   2. outline inverted hull，cullMode front，只画轮廓外圈
 *   3. post    全屏：bloom → exposure → tonemap → sRGB → 半调 → grading → 暗角
 *
 * 每个物体的 Material 与 Transform 各占一条 256 B 对齐的槽位，分两个 buffer。
 * 注意：minUniformBufferOffsetAlignment(256) 对**静态 offset 同样生效**，
 * 不是只有 dynamic offset 才要对齐 —— 所以不能把 Transform 塞在 Material 后面的 128 B 处。
 *
 * 颜色空间约定（很容易搞错，务必遵守）：
 *   - 灯光色 / 雾色  → 送 linear，因为它们直接进 HDR 线性求和
 *   - 材质 albedo / emissive / shadowTint / specTint / inkColor → 送 raw sRGB，
 *     着色器内部自己调 srgbToLinear
 *   - Post 的 nightDeep / bone / ink → 送 raw sRGB，因为 grading 工作在 display-referred 空间
 */


export interface SceneObject {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  materialIndex: number;
  pos: [number, number, number];
  /** 欧拉旋转（弧度，Rz·Ry·Rx），编辑器「旋转」工具写入这里 */
  rot: [number, number, number];
  /** 旋转真源（四元数）；rot 仅作面板显示，gizmo 旋转直接改这里 */
  quat: m4.Quat;
  scale: number;
  bob: number;
  /** CPU 侧网格副本，拾取（射线）和焊点（重传 buffer）都要它 */
  mesh: MeshData;
  /** 每帧更新的世界矩阵，拾取时直接拿它把顶点变换到世界空间 */
  modelMatrix: m4.Mat4;
  /** 网格局部包围盒（网格替换时重算一次）。拾取预剔除与聚焦取景都靠它，避免每次遍历全部顶点 */
  localMin: [number, number, number];
  localMax: [number, number, number];
  /** 该物体的 albedo 贴图（非角色物体为 1×1 白图），选中高亮 bind group 要用 */
  texture: GPUTexture;
  /**
   * texture 是否由本物体独占（addObject 拖入的带贴图模型）。
   * 独占贴图在 removeObject / destroy 时必须连带销毁；共享的 whiteTex 与
   * 角色槽的 charTexture（由 setCharacter 单独管理）都不能走这条路。
   */
  ownsTexture: boolean;
  /** 渲染时把 mat.flags.z 置 1：albedo 走贴图采样而非 uniform 平色 */
  useTex: boolean;
  /** 显示名（选中面板 + HUD 用） */
  name: string;
  /** 层级面板分类（环境 / 角色 / 道具 / 敌人…） */
  category: string;
  /**
   * 子网格（Unity sub-mesh 同语义）：索引缓冲里的一段区间，可独立显隐、独立挂材质槽。
   * 程序化物体只有一段覆盖全部；导入的 GLB 按 primitive 拆分（身体/武器/盾牌各自一段）。
   * 每个子网格 = 层级树里的一条 mesh 节点 = 一个可独立编辑的材质槽。
   */
  subMeshes: SubMesh[];
  /** 本物体第一个子网格在全局材质槽位数组中的起始下标（材质 uniform 按子网格分配槽位） */
  slotBase: number;
  /** 是否可被鼠标拾取（地面不可选，避免点到空白就选中地板） */
  pickable: boolean;
  /** 可见性（层级面板的眼睛开关）：隐藏后既不在画面上画，也不参与拾取 */
  visible: boolean;
  /** 已从场景删除。用墓碑标记而不是真删数组元素 —— 索引一旦变动会打乱其他物体的 uniform 槽位 */
  removed: boolean;
  selected: boolean;
  /**
   * GLB 原始父子层级（导入模型才有；程序化网格为空数组 → 层级面板走旧的平铺展示）。
   * 叶子 mesh 节点引用 subMeshes 下标区间，组节点只有 name + children。
   */
  nodeTree: GltfNodeTree[];
  /**
   * 绑定孤儿池：换模型时没人认领的旧材质绑定留在这里，参与后续替换的匹配
   * （artist 删掉又补回的 mesh 仍能接回原材质）。匹配规则见 binding.ts。
   */
  bindingOrphans: MeshNodeBinding[];
  /** 骨骼（skinned mesh 才有）；非蒙皮物体为 null */
  skeleton: SkeletonData | null;
  /** 动画片段（skinned+animated 才有） */
  animations: AnimClip[];
  /** 蒙皮关节矩阵 storage buffer（binding 7），长度 = skinCount * 64 字节 */
  skinBuffer: GPUBuffer | null;
  /** 蒙皮关节数 + 1（恒等关节）；非蒙皮为 1 */
  skinCount: number;
  /** 蒙皮顶点缓冲（slot 1）：joints(u16×4) + weights(f32×4) */
  skinVb: GPUBuffer | null;
  /** 逐帧求值的关节矩阵暂存（CPU 侧，写进 skinBuffer 前的中转） */
  skinScratch: Float32Array;
  /** 动画播放状态；有骨骼时创建，否则 null */
  skinState: SkinState | null;
}

export interface CameraState {
  yaw: number;
  distance: number;
  target: [number, number, number];
}

/** 层级树的一个 mesh 节点（子网格） */
export interface HierarchySubNode {
  name: string;
  triangles: number;
  visible: boolean;
  /** 当前材质名（含共享/实例前缀） */
  materialName: string;
  source: MaterialSource;
}

/** GLB 原始层级里的一个节点：组节点只有名字与后代；mesh 节点带它名下的子网格下标 */
export interface HierarchyTreeNode {
  name: string;
  /** mesh 节点名下的子网格（含 subMeshes 下标，供选中/显隐/材质面板寻址）；组节点为空数组 */
  subs: { subIndex: number; node: HierarchySubNode }[];
  children: HierarchyTreeNode[];
}

/** 层级树的一个对象节点，subMeshes 就是它下面能展开的 mesh 子节点 */
export interface HierarchyNode {
  index: number;
  name: string;
  category: string;
  visible: boolean;
  pickable: boolean;
  triangles: number;
  subMeshes: HierarchySubNode[];
  /**
   * GLB 原始父子层级（导入的模型才有）。非空时层级面板按它渲染树形，
   * 忽略上面的平铺 subMeshes 列表；空数组 = 程序化网格，平铺展示。
   */
  tree: HierarchyTreeNode[];
}

/** 单个材质槽的完整信息（Mesh 材质面板的数据源） */
export interface MaterialSlotInfo {
  objIndex: number;
  subIndex: number;
  objectName: string;
  meshName: string;
  triangles: number;
  /** 库条目 id（override 存在时它是「被覆盖的那一条」） */
  materialId: string;
  materialName: string;
  source: MaterialSource;
  hasOverride: boolean;
  /** 可编辑本体：override ?? 库条目 state。直接改它就是改生效材质 */
  state: MaterialState;
}

export interface RenderStats {
  width: number;
  height: number;
  drawCalls: number;
  triangles: number;
}

/** 网格局部包围盒：只在网格替换时算一次，之后每次拾取/聚焦复用 */
function localBounds(m: MeshData): { localMin: [number, number, number]; localMax: [number, number, number] } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < m.vertices.length; i += 15) {
    const x = m.vertices[i]!;
    const y = m.vertices[i + 1]!;
    const z = m.vertices[i + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { localMin: [minX, minY, minZ], localMax: [maxX, maxY, maxZ] };
}

/** 深拷贝一份网格，避免多个物体共享同一 MeshData 时焊点互相污染 */
function cloneMesh(m: MeshData): MeshData {
  const copy: MeshData = {
    vertices: new Float32Array(m.vertices),
    indices: new Uint32Array(m.indices),
  };
  if (m.joints !== null && m.joints !== undefined) copy.joints = new Uint16Array(m.joints);
  if (m.weights !== null && m.weights !== undefined) copy.weights = new Float32Array(m.weights);
  return copy;
}

/** 非蒙皮物体的默认皮肤字段：1 个恒等关节 + 全 1 权重缓冲，蒙皮结果 = 顶点原样 */
function defaultSkinFields(device: GPUDevice, vertexCount: number): {
  skeleton: SkeletonData | null;
  animations: AnimClip[];
  skinBuffer: GPUBuffer;
  skinCount: number;
  skinVb: GPUBuffer;
  skinScratch: Float32Array;
  skinState: SkinState | null;
} {
  const skinBuffer = device.createBuffer({
    label: 'skin-id',
    size: 64, // 1 mat4
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // 恒等关节矩阵
  const id = new Float32Array(16);
  id[0] = 1; id[5] = 1; id[10] = 1; id[15] = 1;
  device.queue.writeBuffer(skinBuffer, 0, id);
  const skinVb = device.createBuffer({
    label: 'skin-vb-id',
    size: Math.max(24, vertexCount * 24),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(skinVb, 0, packSkin(null, null, vertexCount));
  return {
    skeleton: null,
    animations: [],
    skinBuffer,
    skinCount: 1,
    skinVb,
    skinScratch: new Float32Array(16),
    skinState: null,
  };
}

/** 点是否在 AABB 内（射线原点落在盒内时 rayAabb 会退化，需要这条兜底） */
function pointInAabb(
  x: number,
  y: number,
  z: number,
  min: [number, number, number],
  max: [number, number, number],
): boolean {
  return x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2];
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToLinear(hex: string): [number, number, number] {
  const [r, g, b] = m4.hexToRgb(hex);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/** 按局部 Y 烘一层接地 AO，写进顶点色 G 通道 */
function applyAo(mesh: MeshData, minY: number, maxY: number, floor = 0.55): void {
  const span = Math.max(1e-5, maxY - minY);
  const count = mesh.vertices.length / 15;
  for (let i = 0; i < count; i++) {
    const y = mesh.vertices[i * 15 + 1]!;
    const t = (y - minY) / span;
    mesh.vertices[i * 15 + 12] = floor + (1 - floor) * Math.min(1, Math.max(0, t));
  }
}

/**
 * 子网格：索引区间 + 独立显隐 + 独立材质槽。
 *
 * 材质解析顺序（Unity 同语义）：
 *   override（本槽局部副本） > materialId 指向的库条目（instance 或 shared）
 * 默认 override 为 null、materialId 是共享材质 —— 即「默认用 shared material」。
 *
 * 后 5 个身份字段来自 GLB（见 gltf.ts SubMeshRange）：换模型时 binding.ts 靠它们
 * 把旧绑定继承过来。程序化网格没有身份（nodeId=''），不参与继承。
 */
export interface SubMesh extends MaterialSlot {
  name: string;
  indexStart: number;
  indexCount: number;
  visible: boolean;
  nodeId: string;
  nodePath: string[];
  nodeName: string;
  primitiveKey: string;
  primitiveIndex: number;
}

interface ObjectSpec {
  mesh: MeshData;
  material: number;
  pos: [number, number, number];
  bob: number;
  name: string;
  pickable: boolean;
  category: string;
}

export class LabRenderer {
  private readonly device: GPUDevice;

  /** 公开统计（HUD / 面板读）；底层存于 EditorState */
  get stats(): RenderStats {
    return this.state.stats;
  }

  /** 引擎帧绘制核心：拥有全部 GPU 资源（管线 / buffer / 纹理 / gizmo）并执行 4-pass 编码 */
  /** 引擎帧绘制核心（services 通过它读 gizmo/相机矩阵与高亮 buffer） */
  public readonly core: RendererCore;
  private readonly materialData: Float32Array;
  private readonly transformData: Float32Array;

  /** 选中高亮用的独立 toon / material buffer（白色细描边），bind group 复用 outline 管线 */
  private readonly selToonData: Float32Array;
  private readonly selMatData: Float32Array;
  /** 层级面板悬停高亮（尸绿）用的独立 toon / material buffer，复用 outline 管线 */
  private readonly hoverToonData: Float32Array;
  private readonly hoverMatData: Float32Array;

  /** 模型浏览器：角色槽位（替换中心胶囊）。切换模型只动这一个 */
  public readonly characterIndex = 1;

  private sceneCapsule!: MeshData;
  public whiteTex!: GPUTexture;
  private charTexture: GPUTexture | null = null;

  private readonly frameData = new Float32Array(FRAME_FLOATS);
  private readonly lightsData = new Float32Array(LIGHTS_FLOATS);
  private readonly toonData = new Float32Array(TOON_FLOATS);
  private readonly postData = new Float32Array(POST_FLOATS);
  /** 逐物体变换矩阵（每帧复用，避免短命对象） */
  private readonly model = m4.mat4();

  /**
   * 本帧每个材质槽解析出的生效材质（按槽位下标索引）。
   * 装箱阶段写、绘制阶段读 —— 避免同一子网格每帧解析两次（装箱一次 + 描边分支一次），
   * 也保证「画出来的」和「判描边用的」必然是同一份数据。
   */
  private readonly resolvedBySlot: (MaterialState | undefined)[] = new Array(MAX_MATERIAL_SLOTS);

  /** destroy() 幂等：HMR 与手动调用可能重复触发，重复 destroy 同一 GPU 对象会抛错 */
  private destroyed = false;

  /**
   * 编辑器拥有的全部可变状态（场景物体 / 选中悬停 / gizmo 交互 / 材质库 / 帧计数等）。
   * 下沉到 EditorState：services 通过 host.state 读写；render / GPU 装箱仍在 LabRenderer。
   */
  /** 编辑器全部可变状态（services 通过 host.state 读写；render / GPU 装箱也在 LabRenderer 内读它） */
  public readonly state = new EditorState();

  /** 选中 / 悬停状态机（委托 SelectionService） */
  private readonly selection = new SelectionService(this);
  /** 场景层级数据源 / 显隐 / 删除（委托 HierarchyService） */
  private readonly hierarchy = new HierarchyService(this);
  /** 材质槽三层语义（委托 MaterialPanelService） */
  private readonly materialPanel = new MaterialPanelService(this);

  constructor(
    gpu: GpuContext,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.device = gpu.device;

    // ---- 几何 ----
    const ground = createPlane(80, 24);
    const capsule = createCapsule(0.34, 1.0, 28, 10);
    applyAo(capsule, -0.84, 0.84);
    const clothCapsule = createCapsule(0.3, 0.6, 24, 8);
    applyAo(clothCapsule, -0.6, 0.6);
    this.sceneCapsule = capsule;

    // 1x1 白色 fallback 贴图（rgba8unorm，raw sRGB 字节，与材质 albedo 同约定）
    // 必须在建物体之前就位，因为物体的 texture 字段要引用它
    this.whiteTex = this.device.createTexture({
      label: 'white',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.whiteTex },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );

    const specs: ObjectSpec[] = [
      // 地面不可选：避免点到空白处就选中地板
      { mesh: ground, material: 1, pos: [0, 0, 0], bob: 0, name: '地面 Ground', pickable: false, category: '环境' },
      // 角色槽位：模型浏览器会整体替换它（场景角色 = 胶囊，E-04/导入模型 = 真实网格）
      { mesh: capsule, material: 0, pos: [0, 0.84, 0], bob: 0, name: '角色 Character', pickable: true, category: '角色' },
      { mesh: createSphere(0.55, 40, 24), material: 2, pos: [-2.4, 0.55, 0.6], bob: 0, name: '球体 Sphere', pickable: true, category: '道具' },
      { mesh: createBox(1, 1, 1), material: 3, pos: [2.4, 0.5, 0.6], bob: 0, name: '立方体 Box', pickable: true, category: '道具' },
      { mesh: createCylinder(0.32, 1.3, 32), material: 4, pos: [-1.6, 0.65, -2.6], bob: 0, name: '圆柱 Cylinder', pickable: true, category: '道具' },
      { mesh: clothCapsule, material: 5, pos: [1.6, 0.6, -2.6], bob: 0, name: '布料胶囊 Cloth', pickable: true, category: '道具' },
    ];

    // 一排退向远处的敌人剪影：直接检验描边的屏幕空间恒定补偿有没有生效
    for (let i = 0; i < 6; i++) {
      specs.push({
        mesh: capsule,
        material: 0,
        pos: [i % 2 === 0 ? -0.9 - i * 0.35 : 1.4 + i * 0.3, 0.84, -5.5 - i * 3.2],
        bob: i * 0.7,
        name: `敌人 Enemy ${i + 1}`,
        pickable: true,
        category: '敌人',
      });
    }

    let triangles = 0;
    for (const s of specs) {
      const mesh = cloneMesh(s.mesh);
      const vb = this.device.createBuffer({
        label: 'vertex',
        size: mesh.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      const ib = this.device.createBuffer({
        label: 'index',
        size: mesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(vb, 0, mesh.vertices);
      this.device.queue.writeBuffer(ib, 0, mesh.indices);

      this.state.objects.push({
        vertexBuffer: vb,
        indexBuffer: ib,
        indexCount: mesh.indices.length,
        materialIndex: s.material,
        pos: [s.pos[0], s.pos[1], s.pos[2]],
        rot: [0, 0, 0],
        quat: [0, 0, 0, 1],
        scale: 1,
        bob: s.bob,
        mesh,
        modelMatrix: m4.mat4(),
        ...localBounds(mesh),
        texture: this.whiteTex,
        ownsTexture: false,
        useTex: false,
        name: s.name,
        category: s.category,
        subMeshes: [
          {
            name: s.name,
            indexStart: 0,
            indexCount: mesh.indices.length,
            visible: true,
            materialId: sharedId(s.material),
            override: null,
            // 程序化网格没有 GLB 身份：nodeId 为空 = 不参与绑定继承
            nodeId: '',
            nodePath: [],
            nodeName: s.name,
            primitiveKey: '',
            primitiveIndex: 0,
          },
        ],
        slotBase: 0, // 稍后 assignSlotBases() 统一分配
        pickable: s.pickable,
        visible: true,
        removed: false,
        selected: false,
        nodeTree: [],
        bindingOrphans: [],
        ...defaultSkinFields(this.device, mesh.vertices.length / 15),
      });
      triangles += mesh.indices.length / 3;
    }
    this.state.stats.triangles = triangles;
    // 材质槽位按「子网格」分配（一个子网格一个槽），变换槽位按「物体」分配。
    // 两者都按固定上限开，换模型导致子网格数变化时只需重排 slotBase + 重建 bind group，不用动 buffer。
    this.materialData = new Float32Array(MAX_MATERIAL_SLOTS * SLOT_FLOATS);
    this.transformData = new Float32Array(MAX_OBJECTS * SLOT_FLOATS);

    // ---- GPU 资源（管线 / 布局 / buffer / 纹理 / gizmo）已在 RendererCore 构造期建好 ----
    // 编辑器只持有 CPU 端 uniform 数据数组 + 引擎核心引用。
    this.selToonData = new Float32Array(TOON_FLOATS);
    this.selMatData = new Float32Array(SLOT_FLOATS);
    this.hoverToonData = new Float32Array(TOON_FLOATS);
    this.hoverMatData = new Float32Array(SLOT_FLOATS);

    // ★ 引擎帧绘制核心：拥有 sceneLayout / 4 条 pipeline / 全部 uniform buffer /
    // 采样器 / gizmo 资源，并执行 4-pass 编码（ADR-001：编辑器是消费者）。
    this.core = new RendererCore(gpu, canvas);

    // 绑定组按「子网格」建（依赖 core 的 sceneLayout / frameBuf / sampler 等）
    this.rebuildAllBindGroups();
  }

  /**
   * 每个「子网格」一个 bind group：材质槽位按子网格取，变换槽位按物体取
   * （同一物体的所有子网格共享同一个 model 矩阵）。角色槽位的 binding 5 在 setCharacter 后换成真贴图。
   */
  private makeSubBindGroup(objIndex: number, subIndex: number): GPUBindGroup {
    const o = this.state.objects[objIndex];
    if (o === undefined) throw new Error(`makeSubBindGroup: 物体越界 ${objIndex}`);
    if (subIndex >= o.subMeshes.length) throw new Error(`makeSubBindGroup: 子网格越界 ${subIndex}`);
    const matBase = (o.slotBase + subIndex) * SLOT_BYTES;
    const xformBase = objIndex * SLOT_BYTES;
    const tex = o.texture ?? this.whiteTex;
    return this.device.createBindGroup({
      label: `obj-${objIndex}-sub-${subIndex}`,
      layout: this.core.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.core.frameBuf } },
        { binding: 1, resource: { buffer: this.core.lightsBuf } },
        { binding: 2, resource: { buffer: this.core.toonBuf } },
        { binding: 3, resource: { buffer: this.core.materialBuf, offset: matBase, size: 80 } },
        { binding: 4, resource: { buffer: this.core.transformBuf, offset: xformBase, size: 64 } },
        { binding: 5, resource: tex.createView() },
        { binding: 6, resource: this.core.sampler },
        { binding: 7, resource: { buffer: o.skinBuffer!, offset: 0, size: o.skinCount * 64 } },
      ],
    });
  }

  /** 场景当前占用的材质槽位总数 */
  private totalSlots(): number {
    let n = 0;
    for (const o of this.state.objects) n += o.subMeshes.length;
    return n;
  }

  /** 除 index 这个物体外，其余物体已占用的槽位数 —— 给 index 算剩余预算 */
  private slotsUsedExcluding(index: number): number {
    let n = 0;
    for (let i = 0; i < this.state.objects.length; i++) {
      if (i !== index) n += this.state.objects[i]!.subMeshes.length;
    }
    return n;
  }

  /**
   * 重新分配每个物体的材质槽位起始下标（子网格数量变化后必须调用，随后要重建全部 bind group）。
   *
   * 容量是固定上限，超出就会写出 uniform buffer 边界（WebGPU 校验错误 → 整页黑屏），
   * 所以这里做最后一道夹取：越界的子网格由装箱/绘制阶段跳过（宁可少画，不能崩）。
   * 真正该拦住越界的是 applySubMeshes 的预算裁剪，这道只是防御。
   */
  private assignSlotBases(): void {
    let slot = 0;
    for (const o of this.state.objects) {
      o.slotBase = slot;
      slot += Math.min(o.subMeshes.length, MAX_MATERIAL_SLOTS - slot);
    }
    if (this.totalSlots() > MAX_MATERIAL_SLOTS) {
      console.warn(
        `[renderer] 子网格总数 ${this.totalSlots()} 超过材质槽位上限 ${MAX_MATERIAL_SLOTS}，多余部分不会被绘制`,
      );
    }
  }

  /** 重建全部 bind group。换模型导致子网格数变化、slotBase 重排后必须调一次 */
  private rebuildAllBindGroups(): void {
    this.assignSlotBases();
    this.state.bindGroups = this.state.objects.map((o, i) =>
      o.removed ? [] : o.subMeshes.map((_, s) => this.makeSubBindGroup(i, s)),
    );
  }

  /**
   * 子网格的生效材质（只读视图）。
   * 与 Unity 一致：默认用 shared material；有 override / 实例时它们优先，
   * 改 override 或实例绝不影响共享材质。
   */
  public resolveMaterial(sm: SubMesh): MaterialState {
    return slotState(sm, this.state.library, this.state.params);
  }

  /** 该槽位当前材质的来源层级 */
  public sourceOf(sm: SubMesh): MaterialSource {
    return slotSource(sm);
  }

  /**
   * 高亮用的独立 bind group：toon / material 换成指定高亮色 + 加粗描边，
   * 但 transform / texture 仍指向被高亮物体本身。复用 outline 管线即可（选中白线 / 悬停绿线共用）。
   */
  public buildHighlightBindGroup(
    index: number | null,
    toonBuf: GPUBuffer,
    matBuf: GPUBuffer,
    label: string,
  ): GPUBindGroup | null {
    const o = index === null ? undefined : this.state.objects[index];
    if (index === null || o === undefined) return null;
    const base = index * SLOT_BYTES;
    return this.device.createBindGroup({
      label,
      layout: this.core.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.core.frameBuf } },
        { binding: 1, resource: { buffer: this.core.lightsBuf } },
        { binding: 2, resource: { buffer: toonBuf } },
        { binding: 3, resource: { buffer: matBuf } },
        { binding: 4, resource: { buffer: this.core.transformBuf, offset: base, size: 64 } },
        { binding: 5, resource: (o.texture ?? this.whiteTex).createView() },
        { binding: 6, resource: this.core.sampler },
        { binding: 7, resource: { buffer: o.skinBuffer!, offset: 0, size: o.skinCount * 64 } },
      ],
    });
  }

  /**
   * 物体贴图/槽位变动后，重建指向它的高亮 bind group。
   * 这些 bind group 缓存了 texture view，一旦物体换了贴图（setCharacter）而没重建，
   * 就会继续引用一个已被 destroy() 的纹理 —— 属于「引用已销毁资源」的硬错误。
   */
  private refreshHighlightBindGroups(index: number): void {
    if (this.state.selectedIndex === index) this.buildSelectionBindGroup(index);
    if (this.state.hoveredIndex === index) {
      this.state.hoverBindGroup = this.buildHighlightBindGroup(
        index,
        this.core.hoverToonBuf,
        this.core.hoverMatBuf,
        'hover',
      );
    }
  }

  public buildSelectionBindGroup(index: number): void {
    this.state.selBindGroup = this.buildHighlightBindGroup(index, this.core.selToonBuf, this.core.selMatBuf, 'sel');
  }

  /**
   * 模型浏览器入口：替换中心角色。
   *   mesh 为 null → 恢复程序化胶囊（场景角色）；否则换成给定网格，脚底贴 y=0。
   *   bitmap 为 null → 用材质平色；否则上传贴图，着色器切到纹理采样。
   *   ranges 为 null/空 → 单条子网格覆盖全部；否则按 GLB primitive 拆成多条
   *   （层级树里展开就是 身体/武器/盾牌 各自一个 mesh 节点 + 各自一个材质槽）。
   *   tree 为 GLB 原始父子层级：层级面板按它还原树形；绑定继承见 applySubMeshes。
   */
  setCharacter(
    mesh: MeshData | null,
    bitmap: ImageBitmap | null,
    ranges: SubMeshRange[] | null = null,
    tree: GltfNodeTree[] | null = null,
    skeleton: SkeletonData | null = null,
    animations: AnimClip[] = [],
  ): void {
    const o = this.state.objects[this.characterIndex];
    if (o === undefined || o.removed) return;

    let m: MeshData;
    if (mesh === null) {
      m = this.sceneCapsule;
      o.pos = [0, 0.84, 0];
      o.useTex = false;
    } else {
      m = mesh;
      o.pos = [0, 0, 0];
      o.useTex = bitmap !== null;
    }

    // 蒙皮字段：先挂上骨架/动画，再上传网格（uploadMesh 按 skeleton 定关节缓冲大小）
    o.skeleton = mesh === null ? null : skeleton;
    o.animations = mesh === null ? [] : animations;
    o.skinState = o.skeleton !== null ? createSkinState(o.skeleton, o.animations) : null;
    this.uploadMesh(o, m, o.skeleton);

    this.charTexture?.destroy();
    this.charTexture = bitmap === null ? null : this.createTextureFromBitmap(bitmap);
    o.texture = this.charTexture ?? this.whiteTex;

    // 子网格重排 → slotBase 全部后移 → 所有 bind group 都得重建（不只是角色自己）
    this.applySubMeshes(this.characterIndex, ranges, tree);
    // 选中 + 悬停的高亮 bind group 都缓存了 texture view，必须一起重建
    this.refreshHighlightBindGroups(this.characterIndex);
    // 选中/悬停的子网格下标在换模型后可能越界
    if (this.state.selectedIndex === this.characterIndex) {
      this.state.selectedSub = this.clampSub(this.characterIndex, this.state.selectedSub);
    }
    if (this.state.hoveredIndex === this.characterIndex) {
      this.state.hoveredSub = this.clampSub(this.characterIndex, this.state.hoveredSub);
    }

    // 统一走 recountTriangles：跳过 removed，否则删过物体后再换模型，HUD 面数会把墓碑算回去
    this.recountTriangles();
  }

  /** 把子网格下标夹到合法范围；null（整个物体）原样返回 */
  public clampSub(objIndex: number, sub: number | null): number | null {
    const o = this.state.objects[objIndex];
    if (o === undefined || sub === null) return null;
    return sub >= 0 && sub < o.subMeshes.length ? sub : null;
  }

  /**
   * 抓当前子网格的材质绑定快照（按 mesh 节点聚合，只收有 GLB 身份的）。
   * 换模型的前一刹那调用 —— 此刻的 subMeshes 就是用户最新的编辑成果。
   */
  private snapshotBindings(o: SceneObject): MeshNodeBinding[] {
    const byNode = new Map<string, MeshNodeBinding>();
    for (const sm of o.subMeshes) {
      if (sm.nodeId === '') continue;
      let b = byNode.get(sm.nodeId);
      if (b === undefined) {
        b = { nodeId: sm.nodeId, nodePath: sm.nodePath, prims: [] };
        byNode.set(sm.nodeId, b);
      }
      b.prims.push({
        primitiveKey: sm.primitiveKey,
        primitiveIndex: sm.primitiveIndex,
        materialId: sm.materialId,
        override: sm.override === null ? null : cloneMaterial(sm.override),
        visible: sm.visible,
      });
    }
    return [...byNode.values()];
  }

  getLastMatchReport(): MatchReportEntry[] | null {
    return this.state.lastMatchReport;
  }

  /**
   * 重建某物体的子网格表并连带重建全部 bind group。
   * ranges 为空 → 退化为单条覆盖全部（程序化网格与「没拆 primitive 的 glb」都走这条）。
   *
   * 绑定继承（ranges 带 GLB 身份时）：先抓旧快照，与新节点跑两层匹配
   * （nodeId → 反向路径），继承 materialId / override / 显隐到 primitive 粒度；
   * 没人认领的旧绑定进孤儿池，留给再下一次替换。匹配报告存 lastMatchReport。
   */
  private applySubMeshes(index: number, ranges: SubMeshRange[] | null, tree: GltfNodeTree[] | null = null): void {
    const o = this.state.objects[index];
    if (o === undefined) return;
    const total = o.mesh.indices.length;
    const single = (): SubMesh[] => [
      {
        name: o.name,
        indexStart: 0,
        indexCount: total,
        visible: true,
        materialId: sharedId(o.materialIndex),
        override: null,
        nodeId: '',
        nodePath: [],
        nodeName: o.name,
        primitiveKey: '',
        primitiveIndex: 0,
      },
    ];

    // 预算 = 全局上限 − 别的物体已占的槽位（planSubMeshCount 是纯函数，可直接单测）
    const planned = planSubMeshCount(
      ranges === null ? 0 : ranges.length,
      this.slotsUsedExcluding(index),
      MAX_MATERIAL_SLOTS,
    );

    if (planned === 1 || ranges === null) {
      // 退化路径：旧绑定不丢，并进孤儿池 —— 切走再切回来还能接
      const snap = this.snapshotBindings(o);
      if (snap.length > 0) o.bindingOrphans = [...snap, ...o.bindingOrphans];
      o.nodeTree = [];
      o.subMeshes = single();
      this.state.lastMatchReport = null;
      this.rebuildAllBindGroups();
      return;
    }

    // ---- 绑定继承：快照 + 孤儿 → 与新节点两层匹配 ----
    const snapshot = this.snapshotBindings(o);

    // 新节点按 nodeId 聚合成 stubs（保持 ranges 的首现顺序与内部顺序）
    const stubs: MeshNodeStub[] = [];
    const stubOf = new Map<string, number>();
    const rangeSlot: { stub: number; pos: number }[] = [];
    for (const r of ranges) {
      let si = stubOf.get(r.nodeId);
      if (si === undefined) {
        si = stubs.length;
        stubOf.set(r.nodeId, si);
        stubs.push({ nodeId: r.nodeId, nodePath: r.nodePath, prims: [] });
      }
      rangeSlot.push({ stub: si, pos: stubs[si]!.prims.length });
      stubs[si]!.prims.push({ primitiveKey: r.primitiveKey, primitiveIndex: r.primitiveIndex });
    }

    const matched = matchBindings(snapshot, o.bindingOrphans, stubs);
    o.bindingOrphans = matched.orphans;
    this.state.lastMatchReport = matched.report;

    const next: SubMesh[] = ranges.map((r, ri) => {
      const start = Math.min(Math.max(0, r.indexStart), total);
      const slot = rangeSlot[ri]!;
      const inh: PrimitiveBinding | null = matched.inherited[slot.stub]?.[slot.pos] ?? null;
      return {
        name: r.name.trim() === '' ? `${o.name} part` : r.name,
        indexStart: start,
        indexCount: Math.min(r.indexCount, total - start),
        // 继承成功 → 旧绑定（含显隐）；否则回到物体默认共享材质
        visible: inh?.visible ?? true,
        materialId: inh?.materialId ?? sharedId(o.materialIndex),
        override: inh?.override ?? null,
        nodeId: r.nodeId,
        nodePath: r.nodePath,
        nodeName: r.nodeName,
        primitiveKey: r.primitiveKey,
        primitiveIndex: r.primitiveIndex,
      };
    });

    o.nodeTree = tree ?? [];
    o.subMeshes = next;
    this.rebuildAllBindGroups();
  }

  /**
   * 把网格上传成该物体的 GPU 缓冲，并同步 CPU 副本 / 索引数 / 局部包围盒。
   *
   * 两个调用方（setCharacter 换模型、weldObject 焊点）走同一条路径，
   * 避免「旧 buffer 忘了 destroy」这类只在长时间编辑后才显形的显存泄漏。
   * 深拷贝是必须的：多个物体共享同一 MeshData 时，焊点会互相污染。
   * bind group 不需要重建 —— 它只引用 uniform，不引用 vb/ib。
   */
  private uploadMesh(o: SceneObject, mesh: MeshData, skeleton: SkeletonData | null): void {
    o.vertexBuffer.destroy();
    o.indexBuffer.destroy();
    const cloned = cloneMesh(mesh);
    const vb = this.device.createBuffer({
      label: 'vtx',
      size: cloned.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const ib = this.device.createBuffer({
      label: 'idx',
      size: cloned.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vb, 0, cloned.vertices);
    this.device.queue.writeBuffer(ib, 0, cloned.indices);
    o.vertexBuffer = vb;
    o.indexBuffer = ib;
    o.indexCount = cloned.indices.length;
    o.mesh = cloned;
    Object.assign(o, localBounds(cloned));

    // ---- 蒙皮缓冲：关节数随骨架变化，必须重建；未蒙皮退化为 1 个恒等关节 ----
    const vcount = cloned.vertices.length / 15;
    const skinned = cloned.joints !== null && cloned.weights !== null;
    const nJoints = skeleton !== null ? skeleton.joints.length : 0;
    const skinCount = skinned ? nJoints + 1 : 1;

    o.skinBuffer?.destroy();
    o.skinBuffer = this.device.createBuffer({
      label: 'skin',
      size: skinCount * 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // 初始填恒等矩阵（首帧 render 前可能就被 draw 用到，避免读到未初始化 storage）
    const init = new Float32Array(skinCount * 16);
    for (let k = 0; k < skinCount; k++) {
      init[k * 16] = 1;
      init[k * 16 + 5] = 1;
      init[k * 16 + 10] = 1;
      init[k * 16 + 15] = 1;
    }
    this.device.queue.writeBuffer(o.skinBuffer, 0, init);

    o.skinVb?.destroy();
    o.skinVb = this.device.createBuffer({
      label: 'skin-vb',
      size: Math.max(24, vcount * 24),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(o.skinVb, 0, packSkin(cloned.joints ?? null, cloned.weights ?? null, vcount));

    o.skinCount = skinCount;
    o.skinScratch = new Float32Array(skinCount * 16);
  }

  /** 替换某物体的网格。bind group 不用动，但删/换后墓碑物体的缓冲已经释放，这里要挡住 */
  private setMesh(index: number, mesh: MeshData): void {
    const o = this.state.objects[index];
    if (o === undefined || o.removed) return;
    this.uploadMesh(o, mesh, o.skeleton);
    this.recountTriangles();
  }

  private createTextureFromBitmap(bitmap: ImageBitmap): GPUTexture {
    const tex = this.device.createTexture({
      label: 'model-albedo',
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      // copyExternalImageToTexture 要求 COPY_DST + RENDER_ATTACHMENT 双 usage（Dawn 实测）
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap, flipY: false },
      { texture: tex },
      { width: bitmap.width, height: bitmap.height },
    );
    // ImageBitmap 占的是 native 内存（4096² ≈ 67MB），GC 不保证及时回收。
    // 上传完 GPU 就再没人需要它，显式 close —— 反复导入模型时不 close 会稳定吃掉几个 G。
    bitmap.close();
    return tex;
  }

  // ===================== 选中 / 拾取 / 编辑 API =====================

  /**
   * 选中某物体（null = 取消选中）。会建好黄色高亮 bind group。
   * sub 为 null = 选中整个物体（层级树点到父节点）；否则只描那一条子网格的轮廓。
   */
  selectObject(index: number | null, sub: number | null = null): void {
    this.selection.selectObject(index, sub);
  }

  getSelected(): number | null {
    return this.selection.getSelected();
  }

  /** 当前选中的子网格下标（null = 整个物体 / 无选中） */
  getSelectedSub(): number | null {
    return this.selection.getSelectedSub();
  }

  /**
   * 层级面板悬停高亮。只改索引 + 按需重建一个 bind group：
   * 不重建 UI、不遍历场景、不触发任何面板刷新，鼠标扫过零压力。
   * sub 非 null 时只高亮那一条子网格。
   */
  setHovered(index: number | null, sub: number | null = null): void {
    this.selection.setHovered(index, sub);
  }

  getHovered(): number | null {
    return this.selection.getHovered();
  }

  // ===================== 场景层级（Hierarchy）API =====================

  /** 层级面板数据源；removed 的墓碑行不出现在列表里。每个对象带上可展开的子网格列表 */
  getObjectList(): HierarchyNode[] {
    return this.hierarchy.getObjectList();
  }

  /** 子网格显隐（层级树里 mesh 节点的眼睛）。只影响那一段索引区间 */
  setSubMeshVisible(index: number, sub: number, visible: boolean): void {
    this.hierarchy.setSubMeshVisible(index, sub, visible);
  }

  /** 显隐（层级面板的眼睛）。隐藏 = 不画 + 不拾取；已隐藏的物体被取消选中以免残留 gizmo */
  setObjectVisible(index: number, visible: boolean): void {
    this.hierarchy.setObjectVisible(index, visible);
  }

  removeObject(index: number): void {
    this.hierarchy.removeObject(index);
  }

  public recountTriangles(): void {
    let tris = 0;
    for (const ob of this.state.objects) if (!ob.removed) tris += ob.indexCount;
    this.state.stats.triangles = tris / 3;
  }

  /**
   * 资产库拖入：把网格作为**新物体**加进场景（与 setCharacter 替换角色槽位是两条路）。
   *
   * 槽位策略与墓碑设计配套：优先复用 removeObject 留下的墓碑（下标不变，
   * 变换 uniform 的 256 B 槽位布局不受打扰）；没有墓碑才往尾部 push。
   * MAX_OBJECTS 是变换 buffer 的硬上限，满了返回 null（调用方负责给用户提示）。
   *
   * bitmap 非 null 时贴图归新物体独占（ownsTexture），removeObject 会连带销毁。
   * 返回新物体下标；失败返回 null。
   */
  addObject(
    mesh: MeshData,
    bitmap: ImageBitmap | null,
    ranges: SubMeshRange[] | null,
    name: string,
    pos: [number, number, number],
    tree: GltfNodeTree[] | null = null,
    skeleton: SkeletonData | null = null,
    animations: AnimClip[] = [],
  ): number | null {
    const reused = this.state.objects.findIndex((o) => o.removed);
    if (reused < 0 && this.state.objects.length >= MAX_OBJECTS) {
      console.warn(`[renderer] 场景物体已达上限 ${MAX_OBJECTS}，无法再添加`);
      return null;
    }

    const cloned = cloneMesh(mesh);
    const vb = this.device.createBuffer({
      label: 'vtx',
      size: cloned.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const ib = this.device.createBuffer({
      label: 'idx',
      size: cloned.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vb, 0, cloned.vertices);
    this.device.queue.writeBuffer(ib, 0, cloned.indices);

    const obj: SceneObject = {
      vertexBuffer: vb,
      indexBuffer: ib,
      indexCount: cloned.indices.length,
      materialIndex: 0,
      pos: [pos[0], pos[1], pos[2]],
      rot: [0, 0, 0],
      quat: [0, 0, 0, 1],
      scale: 1,
      bob: 0,
      mesh: cloned,
      modelMatrix: m4.mat4(),
      ...localBounds(cloned),
      texture: bitmap === null ? this.whiteTex : this.createTextureFromBitmap(bitmap),
      ownsTexture: bitmap !== null,
      useTex: bitmap !== null,
      name,
      category: '资产',
      subMeshes: [
        {
          name,
          indexStart: 0,
          indexCount: cloned.indices.length,
          visible: true,
          materialId: sharedId(0),
          override: null,
          nodeId: '',
          nodePath: [],
          nodeName: name,
          primitiveKey: '',
          primitiveIndex: 0,
        },
      ],
        nodeTree: [],
        bindingOrphans: [],
        ...defaultSkinFields(this.device, cloned.vertices.length / 15),
        slotBase: 0, // applySubMeshes → rebuildAllBindGroups 会统一重排
      pickable: true,
      visible: true,
      removed: false,
      selected: false,
    };

    let index: number;
    if (reused >= 0) {
      // 墓碑的缓冲/贴图在 removeObject 时已释放，整对象替换即可
      this.state.objects[reused] = obj;
      index = reused;
    } else {
      index = this.state.objects.push(obj) - 1;
    }
    // 蒙皮字段 + 用真实骨架重建蒙皮缓冲（defaultSkinFields 只给了恒等退化版）
    const added = this.state.objects[index]!;
    added.skeleton = skeleton;
    added.animations = animations;
    added.skinState = skeleton !== null ? createSkinState(skeleton, animations) : null;
    this.uploadMesh(added, mesh, skeleton);
    // 按 GLB primitive 拆子网格（含槽位预算裁剪 + 绑定继承），内部重建全部 bind group
    this.applySubMeshes(index, ranges, tree);
    this.recountTriangles();
    return index;
  }

  /** 读选中物体的旋转四元数（gizmo 旋转需要） */
  getObjectQuat(index: number): m4.Quat | null {
    const o = this.state.objects[index];
    return o === undefined ? null : o.quat;
  }

  // ---- 蒙皮动画播放控制 ----
  // 当前可播动画的物体：优先「选中且带骨骼」的物体，否则退回角色槽位。

  private activeSkinObject(): SceneObject | null {
    if (this.state.selectedIndex !== null) {
      const o = this.state.objects[this.state.selectedIndex];
      if (o !== undefined && o.skinState !== null) return o;
    }
    const c = this.state.objects[this.characterIndex];
    return c !== undefined && c.skinState !== null ? c : null;
  }

  hasAnimation(): boolean {
    return this.activeSkinObject() !== null;
  }

  getClipNames(): string[] {
    const o = this.activeSkinObject();
    return o !== null ? clipNames(o.skinState!) : [];
  }

  getCurrentClip(): number {
    const o = this.activeSkinObject();
    return o !== null ? currentClip(o.skinState!) : -1;
  }

  getAnimationDuration(): number {
    const o = this.activeSkinObject();
    if (o === null) return 0;
    const cs = o.skinState!;
    return cs.clip >= 0 ? cs.clips[cs.clip]!.duration : 0;
  }

  getAnimationTime(): number {
    const o = this.activeSkinObject();
    return o !== null ? o.skinState!.time : 0;
  }

  /** clip：片段下标或名字；省略则继续/从头播放当前片段 */
  playAnimation(clip?: number | string): void {
    const o = this.activeSkinObject();
    if (o === null) return;
    const st = o.skinState!;
    if (typeof clip === 'string') {
      const idx = clipNames(st).indexOf(clip);
      if (idx >= 0) selectClip(st, idx);
    } else if (typeof clip === 'number') {
      selectClip(st, clip);
    } else {
      skinPlay(st);
    }
  }

  pauseAnimation(): void {
    const o = this.activeSkinObject();
    if (o !== null) skinPause(o.skinState!);
  }

  stopAnimation(): void {
    const o = this.activeSkinObject();
    if (o !== null) selectClip(o.skinState!, -1);
  }

  setAnimationLoop(loop: boolean): void {
    const o = this.activeSkinObject();
    if (o !== null) skinSetLoop(o.skinState!, loop);
  }

  setAnimationSpeed(speed: number): void {
    const o = this.activeSkinObject();
    if (o !== null) skinSetSpeed(o.skinState!, speed);
  }

  seekAnimation(time: number): void {
    const o = this.activeSkinObject();
    if (o !== null) skinSeek(o.skinState!, time);
  }

  /** 当前是否正在播放（供 UI 同步播放/暂停按钮） */
  isAnimationPlaying(): boolean {
    const o = this.activeSkinObject();
    return o !== null && o.skinState!.playing;
  }

  /** 当前片段是否循环（供 UI 同步复选框） */
  getAnimationLoop(): boolean {
    const o = this.activeSkinObject();
    return o !== null && o.skinState!.loop;
  }

  /** 当前播放速率倍率（供 UI 同步滑块） */
  getAnimationSpeed(): number {
    const o = this.activeSkinObject();
    return o !== null ? o.skinState!.speed : 1;
  }

  selectedName(): string | null {
    return this.state.selectedIndex === null ? null : this.state.objects[this.state.selectedIndex]?.name ?? null;
  }

  /** 选中子网格的名字（HUD 用）；选中的是整物体或无选中则 null */
  selectedSubName(): string | null {
    if (this.state.selectedIndex === null || this.state.selectedSub === null) return null;
    return this.state.objects[this.state.selectedIndex]?.subMeshes[this.state.selectedSub]?.name ?? null;
  }

  /** 读选中物体的可编辑状态（面板用） */
  getObjectState(index: number): {
    name: string;
    pos: [number, number, number];
    rot: [number, number, number];
    scale: number;
    materialIndex: number;
    stats: { vertices: number; triangles: number; boundaryEdges: number; components: number };
  } | null {
    const o = this.state.objects[index];
    if (o === undefined) return null;
    return {
      name: o.name,
      pos: [o.pos[0], o.pos[1], o.pos[2]],
      rot: [o.rot[0], o.rot[1], o.rot[2]],
      scale: o.scale,
      materialIndex: o.materialIndex,
      stats: meshStats(o.mesh),
    };
  }

  /** 子网格数量（层级面板据此决定能不能展开、材质面板据此自动落到唯一的 mesh 上） */
  getSubMeshCount(index: number): number {
    return this.state.objects[index]?.subMeshes.length ?? 0;
  }

  setObjectPos(index: number, axis: 0 | 1 | 2, v: number): void {
    const o = this.state.objects[index];
    if (o !== undefined) o.pos[axis] = v;
  }

  /**
   * 设置欧拉角分量。**注意入参单位是度**（面板滑块用度），内部 rot 始终存弧度 ——
   * 单位边界容易出错，所以函数名直接把 Deg 写出来；旋转真源是 quat，改完会同步重建。
   */
  setObjectRotDeg(index: number, axis: 0 | 1 | 2, deg: number): void {
    const o = this.state.objects[index];
    if (o !== undefined) {
      o.rot[axis] = (deg * Math.PI) / 180;
      o.quat = m4.eulerToQuat(o.rot[0], o.rot[1], o.rot[2]);
    }
  }

  /** gizmo 旋转：直接写入四元数，并把 rot 同步成欧拉角供面板显示 */
  setObjectQuat(index: number, q: m4.Quat): void {
    const o = this.state.objects[index];
    if (o !== undefined) {
      o.quat = q;
      o.rot = m4.quatToEuler(q);
    }
  }

  // ===================== Gizmo 控制 API =====================

  setGizmoMode(mode: GizmoMode): void {
    this.state.gizmoMode = mode;
  }

  setGizmoSpace(space: GizmoSpace): void {
    this.state.gizmoSpace = space;
  }

  setGizmoActiveAxis(axis: number | null): void {
    this.state.gizmoActiveAxis = axis;
  }

  /**
   * 返回当前帧算好的 gizmo 变换信息，供 main.ts 做命中测试与拖拽。
   * 无选中时返回 null。
   */
  getGizmoInfo():
    | {
        model: m4.Mat4;
        k: number;
        origin: [number, number, number];
        axes: [number, number, number][];
        mode: GizmoMode;
        space: GizmoSpace;
      }
    | null {
    if (this.state.selectedIndex === null) return null;
    return {
      model: this.core.gizmoModel,
      k: this.core.gizmoK,
      origin: this.core.gizmoOrigin,
      axes: this.core.gizmoAxes,
      mode: this.state.gizmoMode,
      space: this.state.gizmoSpace,
    };
  }

  setObjectScale(index: number, v: number): void {
    const o = this.state.objects[index];
    if (o !== undefined) o.scale = Math.max(0.01, v);
  }

  /** 当前帧相机世界坐标（用于 gizmo 拖拽平面定向） */
  getEye(): [number, number, number] {
    return [this.core.eyeVec[0], this.core.eyeVec[1], this.core.eyeVec[2]];
  }

  /**
   * canvas 在视口里的矩形。每帧只量一次并缓存 ——
   * gizmo 命中测试一次要投影上百个点（圆环采样），每次都读 getBoundingClientRect
   * 会在鼠标移动时反复触发布局计算，是悬停卡顿的主因。
   */
  private canvasRect(): DOMRect {
    if (this.state.cachedRect === null || this.state.cacheFrame !== this.state.frameCounter) {
      this.state.cachedRect = this.canvas.getBoundingClientRect();
      this.state.cacheFrame = this.state.frameCounter;
    }
    return this.state.cachedRect;
  }

  /** 指针屏幕坐标 → 世界射线（near=o，远点用于求方向）。client 取 canvas 实时矩形换算 NDC */
  pointerRay(clientX: number, clientY: number): { o: [number, number, number]; d: [number, number, number] } | null {
    const rect = this.canvasRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const near = this.unproject(this.core.invViewProj, ndcX, ndcY, 0);
    const far = this.unproject(this.core.invViewProj, ndcX, ndcY, 1);
    let dx = far[0] - near[0];
    let dy = far[1] - near[1];
    let dz = far[2] - near[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    return { o: near, d: [dx, dy, dz] };
  }

  /** 世界坐标 → 屏幕像素（clientX/clientY 同一坐标系）。behind=true 表示在相机背后（投影翻转，不可用于命中） */
  worldToScreen(p: readonly [number, number, number]): { x: number; y: number; behind: boolean } {
    const m = this.core.viewProj;
    const cx = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
    const cy = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
    const cw = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
    const rect = this.canvasRect();
    if (Math.abs(cw) < 1e-9) return { x: rect.left, y: rect.top, behind: true };
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    return {
      x: rect.left + ((ndcX + 1) / 2) * rect.width,
      y: rect.top + ((1 - (ndcY + 1) / 2)) * rect.height,
      behind: cw <= 0,
    };
  }

  /**
   * 给整个物体换共享材质（Unity：给所有 slot 换 sharedMaterial）。
   * 会清掉所有子网格的 override —— 换材质是一次显式重绑，局部覆盖再留着只会让人困惑。
   */
  setObjectMaterial(index: number, materialIndex: number): void {
    this.materialPanel.setObjectMaterial(index, materialIndex);
  }

  // ===================== 材质槽 API（Mesh 材质面板）=====================

  /** 挂上参数引用：材质 API 要按 id 回查共享材质。params 对象引用全程恒定（重置也是 Object.assign 就地改） */
  attachParams(p: LabParams): void {
    this.materialPanel.attachParams(p);
  }

  /** 材质库下拉项：6 个共享材质 + 用户实例 */
  getMaterialLibrary(): MaterialRef[] {
    return this.materialPanel.getMaterialLibrary();
  }

  /** 当前材质槽信息；越界或无该槽返回 null */
  getSlotMaterial(objIndex: number, subIndex: number): MaterialSlotInfo | null {
    return this.materialPanel.getSlotMaterial(objIndex, subIndex);
  }

  /** 把槽位换成材质库里已有的一条（共享或实例），并清掉本地覆盖 */
  assignSlotMaterial(objIndex: number, subIndex: number, id: string): void {
    this.materialPanel.assignSlotMaterial(objIndex, subIndex, id);
  }

  createSlotInstance(objIndex: number, subIndex: number): void {
    this.materialPanel.createSlotInstance(objIndex, subIndex);
  }

  ensureOverride(objIndex: number, subIndex: number): void {
    this.materialPanel.ensureOverride(objIndex, subIndex);
  }

  promoteOverride(objIndex: number, subIndex: number): void {
    this.materialPanel.promoteOverride(objIndex, subIndex);
  }

  discardOverride(objIndex: number, subIndex: number): void {
    this.materialPanel.discardOverride(objIndex, subIndex);
  }

  renameMaterial(id: string, name: string): void {
    this.materialPanel.renameMaterial(id, name);
  }

  removeMaterial(id: string): void {
    this.materialPanel.removeMaterial(id);
  }

  exportInstances(): MaterialInstance[] {
    return this.materialPanel.exportInstances();
  }

  /** 全场景材质槽绑定（JSON 导出用）：谁用了哪条材质、有没有局部覆盖；身份信息供重导对齐 */
  exportSlots(): {
    object: string;
    mesh: string;
    materialId: string;
    materialName: string;
    source: MaterialSource;
    override: MaterialState | null;
    nodeId: string;
    nodePath: string[];
    primitiveKey: string;
  }[] {
    return this.materialPanel.exportSlots();
  }

  /** 焊点（Merge Points）：按位置量化合并重合顶点，重映射索引 */
  weldObject(index: number): void {
    const o = this.state.objects[index];
    if (o !== undefined) this.setMesh(index, weldMesh(o.mesh));
  }

  getMeshStats(index: number): { vertices: number; triangles: number; boundaryEdges: number; components: number } | null {
    const o = this.state.objects[index];
    return o === undefined ? null : meshStats(o.mesh);
  }

  /** 世界空间 AABB：用缓存的局部包围盒变 8 个角点，无需遍历顶点 */
  private worldAabb(o: {
    modelMatrix: m4.Mat4;
    localMin: [number, number, number];
    localMax: [number, number, number];
  }): { min: [number, number, number]; max: [number, number, number] } {
    const M = o.modelMatrix;
    const [ax, ay, az] = o.localMin;
    const [bx, by, bz] = o.localMax;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? bx : ax;
      const y = c & 2 ? by : ay;
      const z = c & 4 ? bz : az;
      const wx = M[0]! * x + M[4]! * y + M[8]! * z + M[12]!;
      const wy = M[1]! * x + M[5]! * y + M[9]! * z + M[13]!;
      const wz = M[2]! * x + M[6]! * y + M[10]! * z + M[14]!;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  }

  /** 物体世界空间包围盒与包围球。双击/F 聚焦取景用（复用缓存，不遍历顶点） */
  getObjectBounds(index: number): { center: [number, number, number]; radius: number } | null {
    const o = this.state.objects[index];
    if (o === undefined) return null;
    const bb = this.worldAabb(o);
    const center: [number, number, number] = [
      (bb.min[0] + bb.max[0]) / 2,
      (bb.min[1] + bb.max[1]) / 2,
      (bb.min[2] + bb.max[2]) / 2,
    ];
    const radius =
      0.5 * Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    return { center, radius };
  }


  /**
   * 鼠标 NDC（x,y ∈ [-1,1]，y 已翻转）反投影成世界射线，与所有可拾取物体逐三角形求交，
   * 返回命中列表（每物体取最小 t），按距离近→远排序。穿透拾取（Alt+点击循环）用。
   */
  pickAtAll(ndcX: number, ndcY: number): { index: number; t: number }[] {
    const near = this.unproject(this.core.invViewProj, ndcX, ndcY, 0);
    const far = this.unproject(this.core.invViewProj, ndcX, ndcY, 1);
    const ox = this.core.eyeVec[0];
    const oy = this.core.eyeVec[1];
    const oz = this.core.eyeVec[2];
    let dx = far[0] - near[0];
    let dy = far[1] - near[1];
    let dz = far[2] - near[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;

    const best = new Map<number, number>(); // 物体索引 → 该物体最小命中 t
    for (let i = 0; i < this.state.objects.length; i++) {
      const o = this.state.objects[i]!;
      if (!o.pickable || o.removed || !o.visible) continue;
      const M = o.modelMatrix;
      // 预剔除：先把局部 AABB 变到世界空间（8 个角点），射线打不中这个盒子就跳过逐三角形求交。
      // 场景里物体一多、或导入 80k 面高模后，这一步能省掉绝大多数三角形测试。
      {
        const bb = this.worldAabb(o);
        if (
          m4.rayAabb(ox, oy, oz, dx, dy, dz, bb.min, bb.max) < 0 &&
          !pointInAabb(ox, oy, oz, bb.min, bb.max)
        ) {
          continue;
        }
      }
      const idx = o.mesh.indices;
      const v = o.mesh.vertices;
      // 逐子网格求交，跳过隐藏的那几条 —— 与渲染一致：
      // 画面上看不见的 mesh 绝不该被点中（否则 Alt 穿透循环会「选中空气」）
      for (const sm of o.subMeshes) {
        if (!sm.visible) continue;
        const end = Math.min(sm.indexStart + sm.indexCount, idx.length);
        for (let t = sm.indexStart; t < end; t += 3) {
          const a = idx[t]!;
          const b = idx[t + 1]!;
          const c = idx[t + 2]!;
          // 局部顶点 → 世界（w=1，无需透视除法）
          const ax = v[a * 15]!;
          const ay = v[a * 15 + 1]!;
          const az = v[a * 15 + 2]!;
          const bx = v[b * 15]!;
          const by = v[b * 15 + 1]!;
          const bz = v[b * 15 + 2]!;
          const cx = v[c * 15]!;
          const cy = v[c * 15 + 1]!;
          const cz = v[c * 15 + 2]!;
          const awx = M[0]! * ax + M[4]! * ay + M[8]! * az + M[12]!;
          const awy = M[1]! * ax + M[5]! * ay + M[9]! * az + M[13]!;
          const awz = M[2]! * ax + M[6]! * ay + M[10]! * az + M[14]!;
          const bwx = M[0]! * bx + M[4]! * by + M[8]! * bz + M[12]!;
          const bwy = M[1]! * bx + M[5]! * by + M[9]! * bz + M[13]!;
          const bwz = M[2]! * bx + M[6]! * by + M[10]! * bz + M[14]!;
          const cwx = M[0]! * cx + M[4]! * cy + M[8]! * cz + M[12]!;
          const cwy = M[1]! * cx + M[5]! * cy + M[9]! * cz + M[13]!;
          const cwz = M[2]! * cx + M[6]! * cy + M[10]! * cz + M[14]!;
          const tHit = m4.rayTri(ox, oy, oz, dx, dy, dz, awx, awy, awz, bwx, bwy, bwz, cwx, cwy, cwz);
          if (tHit > 1e-4 && tHit < (best.get(i) ?? Infinity)) {
            best.set(i, tHit);
          }
        }
      }
    }
    return [...best.entries()].map(([index, t]) => ({ index, t })).sort((a, b) => a.t - b.t);
  }

  /** 最近命中物体索引（普通点击拾取） */
  pickAt(ndcX: number, ndcY: number): number | null {
    return this.pickAtAll(ndcX, ndcY)[0]?.index ?? null;
  }

  /** 反投影：NDC(x,y,z) → 世界坐标（列主序矩阵） */
  private unproject(m: m4.Mat4, x: number, y: number, z: number): [number, number, number] {
    const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    const iw = Math.abs(w) < 1e-9 ? 1 : 1 / w;
    return [wx * iw, wy * iw, wz * iw];
  }

  /** 画布尺寸变更：委托引擎核心重建 HDR/AUX/Depth 纹理与后处理 bind group（ADR-001） */
  resize(width: number, height: number): void {
    this.core.resize(width, height);
    this.state.stats.width = this.core.width;
    this.state.stats.height = this.core.height;
  }

  private packLights(p: LabParams, time: number): void {
    const d = this.lightsData;

    const dir = m4.sphericalToDir(p.keyAzimuth, p.keyElevation);
    d[0] = dir[0];
    d[1] = dir[1];
    d[2] = dir[2];
    d[3] = p.keyIntensity;

    const key = hexToLinear(p.keyColor);
    d[4] = key[0];
    d[5] = key[1];
    d[6] = key[2];
    d[7] = 1;

    const sky = hexToLinear(p.fillSkyColor);
    d[8] = sky[0];
    d[9] = sky[1];
    d[10] = sky[2];
    d[11] = p.fillSkyIntensity;

    const ground = hexToLinear(p.fillGroundColor);
    d[12] = ground[0];
    d[13] = ground[1];
    d[14] = ground[2];
    d[15] = p.fillGroundIntensity;

    const rim = hexToLinear(p.rimColor);
    d[16] = rim[0];
    d[17] = rim[1];
    d[18] = rim[2];
    d[19] = p.rimIntensity;

    const amb = hexToLinear(p.ambientColor);
    d[20] = amb[0];
    d[21] = amb[1];
    d[22] = amb[2];
    d[23] = p.ambientIntensity;

    d[24] = p.rimPower;
    d[25] = p.rimTopBias;
    d[26] = 0;
    d[27] = 0;

    const fog = hexToLinear(p.fogColor);
    d[28] = fog[0];
    d[29] = fog[1];
    d[30] = fog[2];
    d[31] = p.fogDensity;

    const t = p.pointOrbit ? time * 0.8 : 0;
    d[32] = Math.cos(t) * 2.6;
    d[33] = 1.4;
    d[34] = Math.sin(t) * 2.6;
    d[35] = p.pointRange;

    const pl = hexToLinear(p.pointColor);
    d[36] = pl[0];
    d[37] = pl[1];
    d[38] = pl[2];
    d[39] = p.pointEnabled ? p.pointIntensity : 0;
  }

  private packToon(p: LabParams): void {
    const d = this.toonData;

    d[0] = p.shadowEnd;
    d[1] = p.specStart;
    d[2] = p.edgeSoftness;
    d[3] = p.shadowMult;

    d[4] = p.shadowMix;
    d[5] = p.shadowSat;
    d[6] = p.litSat;
    d[7] = p.specMix;

    const st = m4.hexToRgb(p.shadowTint);
    d[8] = st[0];
    d[9] = st[1];
    d[10] = st[2];
    d[11] = 0;

    const sp = m4.hexToRgb(p.specTint);
    d[12] = sp[0];
    d[13] = sp[1];
    d[14] = sp[2];
    d[15] = 0;

    // 线宽按 1080p 定义，canvas.height 已是物理像素，直接按比例换算
    d[16] = (p.outlineWidth * this.core.height) / 1080;
    d[17] = p.outlineDistanceComp ? 1 : 0;
    d[18] = 0;
    d[19] = 0;

    const ink = m4.hexToRgb(p.inkColor);
    d[20] = ink[0];
    d[21] = ink[1];
    d[22] = ink[2];
    d[23] = 0;

    d[24] = p.debugMode;
    d[25] = 0;
    d[26] = 0;
    d[27] = 0;
  }

  private packPost(p: LabParams): void {
    const d = this.postData;

    d[0] = p.gradeShadowRange;
    d[1] = p.gradeMidRange;
    d[2] = p.gradeEdge;
    d[3] = p.gradeEnabled ? 1 : 0;

    d[4] = p.gradeShadowMult;
    d[5] = p.gradeShadowMix;
    d[6] = p.gradeShadowSat;
    d[7] = 0;

    d[8] = 0.98; // tokens.json：中间调倍率固定 0.98，没有做成可调参数
    d[9] = 0;
    d[10] = p.gradeMidSat;
    d[11] = 0;

    d[12] = p.gradeLightMult;
    d[13] = p.gradeLightMix;
    d[14] = p.gradeLightSat;
    d[15] = 0;

    // grading 工作在 sRGB display-referred 空间，这里送 raw sRGB，不转 linear
    const nd = m4.hexToRgb('#0E0C16');
    d[16] = nd[0];
    d[17] = nd[1];
    d[18] = nd[2];
    d[19] = 0;

    const bone = m4.hexToRgb('#FFF6E2');
    d[20] = bone[0];
    d[21] = bone[1];
    d[22] = bone[2];
    d[23] = 0;

    const ink = m4.hexToRgb(p.inkColor);
    d[24] = ink[0];
    d[25] = ink[1];
    d[26] = ink[2];
    d[27] = 0;

    d[28] = p.halftoneEnabled ? 1 : 0;
    d[29] = p.halftoneSize;
    d[30] = p.halftoneStrength;
    d[31] = p.halftoneThreshold;

    d[32] = p.tonemapMode;
    d[33] = p.exposure;
    d[34] = p.bloomThreshold;
    d[35] = p.bloomEnabled ? p.bloomIntensity : 0;

    d[36] = p.vignette;
    d[37] = p.outlinePostExempt ? 1 : 0;
    d[38] = this.core.width;
    d[39] = this.core.height;

    d[40] = p.debugMode;
    d[41] = 0;
    d[42] = 0;
    d[43] = 0;
  }

  /** 高亮描边用的材质：指定了子网格就取那一条的生效材质，否则取第 0 条 */
  private highlightMaterial(objIndex: number, sub: number | null): MaterialState {
    const o = this.state.objects[objIndex];
    const sm = o?.subMeshes[sub ?? 0] ?? o?.subMeshes[0];
    return sm === undefined ? this.state.params.materials[0]! : this.resolveMaterial(sm);
  }

  private packMaterial(dst: Float32Array, base: number, m: MaterialState): void {
    const a = m4.hexToRgb(m.albedo);
    dst[base] = a[0];
    dst[base + 1] = a[1];
    dst[base + 2] = a[2];
    dst[base + 3] = 1;

    dst[base + 4] = m.roughness;
    dst[base + 5] = m.metallic;
    dst[base + 6] = m.emissiveStrength;
    dst[base + 7] = 0;

    const e = m4.hexToRgb(m.emissiveColor);
    dst[base + 8] = e[0];
    dst[base + 9] = e[1];
    dst[base + 10] = e[2];
    dst[base + 11] = 0;

    dst[base + 12] = m.shadowEnd;
    dst[base + 13] = m.specMix;
    dst[base + 14] = m.softnessScale;
    dst[base + 15] = m.halftoneScale;

    dst[base + 16] = m.unlit ? 1 : 0;
    dst[base + 17] = m.outlineScale;
    dst[base + 18] = 0;
    dst[base + 19] = 0;
  }

  /**
   * 帧绘制入口（公开 API 不变）。
   *
   * 编辑器负责「CPU 端语义」：材质解析 / 变换装箱 / 蒙皮推进 / 高亮描边数据上传，
   * 并把一份已完全解析的帧（RenderFrameInput）交给 RendererCore 编码 4 个 pass
   * （ADR-001：编辑器是消费者，不内嵌渲染器）。相机矩阵与 4-pass 命令编码都在 core 内完成。
   */
  render(p: LabParams, camera: CameraState, time: number, dpr: number): void {
    this.state.params = p; // 引用恒定，材质 API 靠它回查共享材质
    this.state.frameCounter++; // canvas 矩形缓存按帧刷新
    // 动画推进用的 dt（首帧为 0，避免大跳变）；夹取到 [0,0.1] 防卡顿后暴冲
    const dt = this.state.lastFrameTime < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.state.lastFrameTime));
    this.state.lastFrameTime = time;

    // ---- CPU 端装箱：材质 / 变换 / 蒙皮（编辑器语义）----
    this.packLights(p, time);
    this.packToon(p);
    this.packPost(p);

    for (let i = 0; i < this.state.objects.length; i++) {
      const o = this.state.objects[i]!;
      if (o.removed) continue; // 墓碑：不画不拾取，不占槽位
      // 材质按「子网格」装箱：每条子网格一个槽，各自解析 override > instance > shared。
      // 解析结果存进 resolvedBySlot，绘制阶段直接读 —— 同一子网格每帧只解析一次。
      for (let s = 0; s < o.subMeshes.length; s++) {
        const slot = o.slotBase + s;
        if (slot >= MAX_MATERIAL_SLOTS) break; // 槽位预算见 applySubMeshes，这里是最后防线
        const m = this.resolveMaterial(o.subMeshes[s]!);
        this.resolvedBySlot[slot] = m;
        const base = slot * SLOT_FLOATS;
        this.packMaterial(this.materialData, base, m);
        // flags.z：有贴图的角色槽位切到纹理采样（见 scene.wgsl fs_main）
        if (o.useTex) this.materialData[base + 18] = 1;
      }

      const bobY = o.bob !== 0 ? Math.sin(time * 1.6 + o.bob) * 0.05 : 0;
      m4.composeQuat(this.model, o.pos[0], o.pos[1] + bobY, o.pos[2], o.quat, o.scale);
      // 变换按「物体」装箱：同一物体的所有子网格共享同一个 model 矩阵
      const xBase = i * SLOT_FLOATS;
      this.transformData.set(this.model, xBase);
      o.modelMatrix.set(this.model);

      // 蒙皮：推进动画 → 求关节矩阵 → 写进 storage buffer（binding 7）。
      // 每帧重算，姿势随片段变化；未播或 bind pose 时 jointMatrix 退化为 I，顶点原样。
      if (o.skinState !== null && o.skinBuffer !== null) {
        skinAdvance(o.skinState, dt);
        evalJointMatrices(o.skinState, o.skinScratch);
        this.device.queue.writeBuffer(o.skinBuffer, 0, o.skinScratch);
      }
    }

    // 材质 / 变换 buffer 由 core 持有，编辑器通过 this.core.* 上传
    this.device.queue.writeBuffer(this.core.materialBuf, 0, this.materialData);
    this.device.queue.writeBuffer(this.core.transformBuf, 0, this.transformData);

    // 悬停高亮的 toon / material：绿色细描边（与选中同规格，只是换个颜色）
    if (
      this.state.hoveredIndex !== null &&
      this.state.hoveredIndex !== this.state.selectedIndex &&
      this.state.hoverBindGroup !== null
    ) {
      const o = this.state.objects[this.state.hoveredIndex];
      if (o !== undefined) {
        this.hoverToonData.set(this.toonData);
        this.hoverToonData[16] = Math.max((this.toonData[16] ?? 0) * 1.15, (2.5 * this.core.height) / 1080);
        const c = m4.hexToRgb(HOVER_COLOR);
        this.hoverToonData[20] = c[0];
        this.hoverToonData[21] = c[1];
        this.hoverToonData[22] = c[2];
        this.device.queue.writeBuffer(this.core.hoverToonBuf, 0, this.hoverToonData);

        const m = this.highlightMaterial(this.state.hoveredIndex, this.state.hoveredSub);
        this.packMaterial(this.hoverMatData, 0, m);
        this.hoverMatData[17] = Math.max((this.hoverMatData[17] ?? 0) * 1.1, 0.8);
        this.device.queue.writeBuffer(this.core.hoverMatBuf, 0, this.hoverMatData);
      }
    }

    // 选中高亮的 toon / material：白色细描边，仅比原生墨线轻微加强（细腻优先，不糊轮廓）
    if (this.state.selectedIndex !== null && this.state.selBindGroup !== null) {
      const o = this.state.objects[this.state.selectedIndex];
      if (o !== undefined) {
        this.selToonData.set(this.toonData);
        const boosted = Math.max((this.toonData[16] ?? 0) * 1.15, (2.5 * this.core.height) / 1080);
        this.selToonData[16] = boosted;
        const c = m4.hexToRgb(SEL_COLOR);
        this.selToonData[20] = c[0];
        this.selToonData[21] = c[1];
        this.selToonData[22] = c[2];
        this.device.queue.writeBuffer(this.core.selToonBuf, 0, this.selToonData);

        const m = this.highlightMaterial(this.state.selectedIndex, this.state.selectedSub);
        this.packMaterial(this.selMatData, 0, m);
        this.selMatData[17] = Math.max((this.selMatData[17] ?? 0) * 1.1, 0.8);
        this.device.queue.writeBuffer(this.core.selMatBuf, 0, this.selMatData);
      }
    }

    // ---- 构造 RenderFrameInput：一份已完全解析的帧 ----
    const objects: CoreObjectDraw[] = this.state.objects.map((o, i) => ({
      vertexBuffer: o.vertexBuffer,
      skinVb: o.skinVb,
      indexBuffer: o.indexBuffer,
      visible: o.visible && !o.removed,
      subMeshes: o.subMeshes.map((sm, s) => {
        const slot = o.slotBase + s;
        const mat = this.resolvedBySlot[slot] ?? this.state.params.materials[0]!;
        return {
          indexStart: sm.indexStart,
          indexCount: sm.indexCount,
          visible: sm.visible,
          bindGroup: this.state.bindGroups[i]?.[s],
          outline: mat.outlineScale > 0.001,
        } satisfies CoreSubMeshDraw;
      }),
    }));

    // 先快照高亮 / 选中状态，避免在三元表达式内反复读取 this.x（exactOptionalPropertyTypes 下更稳）
    const selIdx = this.state.selectedIndex;
    const selSub = this.state.selectedSub;
    const hovIdx = this.state.hoveredIndex;
    const hovSub = this.state.hoveredSub;
    const selBg = this.state.selBindGroup;
    const hovBg = this.state.hoverBindGroup;
    const highlight: CoreHighlight = {
      selected:
        selIdx !== null && selBg !== null
          ? { objIndex: selIdx, sub: selSub, bindGroup: selBg }
          : null,
      hovered:
        hovIdx !== null && hovIdx !== selIdx && hovBg !== null
          ? { objIndex: hovIdx, sub: hovSub, bindGroup: hovBg }
          : null,
    };

    let gizmo: CoreGizmo | null = null;
    if (selIdx !== null) {
      const o = this.state.objects[selIdx];
      if (o !== undefined && !o.removed && o.visible) {
        const origin: [number, number, number] = [o.pos[0], o.pos[1], o.pos[2]];
        const q: m4.Quat = this.state.gizmoSpace === 'local' ? o.quat : [0, 0, 0, 1];
        gizmo = { origin, quat: q, mode: this.state.gizmoMode, activeAxis: this.state.gizmoActiveAxis };
      }
    }

    const input: RenderFrameInput = {
      p: { outlineEnabled: p.outlineEnabled, debugMode: p.debugMode, cameraElevation: p.cameraElevation },
      camera: { target: camera.target, distance: camera.distance, yaw: camera.yaw },
      time,
      dpr,
      uniforms: {
        frame: this.frameData,
        lights: this.lightsData,
        toon: this.toonData,
        post: this.postData,
        material: this.materialData,
        transform: this.transformData,
        selToon: this.selToonData,
        selMat: this.selMatData,
        hoverToon: this.hoverToonData,
        hoverMat: this.hoverMatData,
      },
      objects,
      highlight,
      gizmo,
      stats: { drawCalls: 0 },
    };

    this.core.drawFrame(input);
    this.state.stats.drawCalls = input.stats.drawCalls;
  }

  /**
   * 释放本渲染器持有的**全部** GPU 资源。
   *
   * 之前这里只放了 5 个对象，其余十几块 buffer 全漏掉 —— 编辑器是 HMR 驱动的，
   * 每次热更新重建一个 LabRenderer 就等于永久泄漏一套 uniform / 顶点 / gizmo 缓冲，
   * 编辑十几分钟就能吃掉上 G 显存。所以这里逐个显式释放，且做成幂等。
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // 引擎核心持有的全部 GPU 资源（HDR/AUX/Depth 纹理、uniform buffer、gizmo 几何）由 core 释放
    this.core.destroy();

    // 编辑器侧独占资源：白图、角色贴图、物体网格与独占贴图
    this.whiteTex.destroy();
    this.charTexture?.destroy();
    for (const o of this.state.objects) {
      if (o.removed) continue; // 墓碑在 removeObject 时已释放，跳过避免二次 destroy
      o.vertexBuffer.destroy();
      o.indexBuffer.destroy();
      if (o.ownsTexture) o.texture.destroy();
    }
    this.state.objects.length = 0;
    this.state.bindGroups = [];

    this.state.selBindGroup = null;
    this.state.hoverBindGroup = null;
  }
}
