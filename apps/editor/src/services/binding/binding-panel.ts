/**
 * 绑定面板 Binding Panel —— 正/侧视图里把 27 个 HumanIK joint（22 骨干 + 5 tip）拖到模型实际解剖位置上。
 *
 * 设计要点
 * --------
 * 1. **纯 local 空间**：所有 joint 坐标存在模型归一化后的局部空间（Y-up、脚底 y=0、
 *    身高 MODEL_RULER_HEIGHT_M）。正视图投影 (x,y)、侧视图投影 (z,y)，与世界变换无关。
 *    面板不读任何节点的世界矩阵 —— 换场景、换摆放位置都不影响已拟合的骨架。
 * 2. **两视图分工**：正视改 (x,y)，侧视改 (z,y)，第三个分量保持不动。这是标准的
 *    双视图关节定位法，两次拖拽即可确定一个三维坐标。
 * 3. **Mirror 属于正视图**：镜像是 x 取反（左右对称面 x=0），而 x 正是正视图的横轴，
 *    侧视图里 x 是深度轴、看不出镜像，所以 mirror 只挂在正视图上。
 * 4. **拟合产出两类数据**：骨长（采纳进 T-pose）与姿态旋转 ΔR（只是 currentPose 与
 *    T-pose 的差值，re-gen 时被消耗于网格反解，绝不进骨架）。详见 binding-math.ts。
 *
 * ── 本轮（骨骼编辑 5 项反馈）新增 ───────────────────────────────────────────
 *  - 性能：网格渲染缓存到离屏 canvas，拖拽时只 blit 缓存 + 重画骨架；
 *          refresh 用 requestAnimationFrame 合帧，避免每帧重画全三角面。
 *  - 精确移动：Shift 拖拽锁定横/纵主轴；方向键微调（Shift 精调 5mm）。
 *  - 半显：下拉「全部 / 仅中轴 / 隐藏左 / 隐藏右」过滤绘制与拾取。
 *  - Detach：移除已应用的皮肤结果但保留 joint 编辑；reset 加确认防误丢数据。
 *  - 姿态预览：四态「当前 / T / A / Bind」。Bind = 冻结保存的绑定姿态（带 offset），
 *    点 Bind Skin 时拍下、Detach 不清空、再 Bind Skin 才刷新；随时切回即可重绑。
 */

import type { GpuContext } from '@aether/gfx';
import {
  HUMANIK_BONES,
  HUMANIK_ORDER,
  MIRROR_PAIRS,
  isTipBone,
  mirrorOf,
  tposeWorldPositions,
  aposeWorldPositions,
  type Vec3,
} from './humanik-template';
import {
  boneSegments,
  distToSegment,
  fitSkeleton,
  computeLbsWeights,
  reposeMesh,
  aposeWorld,
  type FitResult,
  type JointPositions,
} from './binding-math';
import {
  autoFitCylinders,
  defaultSkinCylinders,
  mirrorCylinders,
  offsetSegmentEndpoints,
  type SkinCylinderMap,
  type CylSegment,
} from './skin-proxy';
import { BindingView3D } from './binding-view3d';

/** 正视图：投影 (x, y)，深度 = z；侧视图：投影 (z, y)，深度 = x */
type ViewAxis = 'front' | 'side';
/** 姿态预览模式：当前编辑 / 标准 T / 标准 A / 冻结的 Bind Pose（用于绑定的带 offset 姿态） */
type PreviewMode = 'current' | 'T' | 'A' | 'bind';
/** 骨骼显示过滤 */
type SideFilter = 'all' | 'mid' | 'hideL' | 'hideR';
/**
 * 权重算法（导出时真正生效的分支，见 `binding-export.runExport`）：
 *  - `wrapper`  Skin Wrapper 包裹体：被圆柱体包住的顶点归属该 joint（二值，过渡窄）
 *  - `distance` 胶囊距离衰减：`1/(d+eps)^falloff` 取 top-4（过渡自然，但会跨侧抢权重）
 *
 * ⚠️ 之前这个选择是**隐式的**：`runExport` 靠 `cylinders !== undefined` 判断，而
 * `ensureCylinders()` 在 setModel 时载入即建 → 永远走 wrapper，distance 成了死代码，
 * 面板上也完全没有提示。现在显式化成一个下拉，用户看得到、选得动、存得下。
 */
export type WeightMode = 'wrapper' | 'distance';

const JOINT_HIT_PX = 9;
const JOINT_R_PX = 4.5;
/** 方向键微调步长（米）：普通 2cm，Shift 精调 5mm */
const NUDGE_STEP = 0.02;
const NUDGE_STEP_FINE = 0.005;
/** 正交缩放量程（米→CSS 像素）：24 = 极远（320px 看 ~13m），2400 = 极近。
 *  前/侧视图共用 this.scale，故一次滚轮两个视图一起缩放。 */
const BIND_ZOOM_MIN = 24;
const BIND_ZOOM_MAX = 2400;

export interface ApplyOptions {
  /** apply 时是否对皮肤权重做热扩散平滑（默认 true） */
  smoothWeights: boolean;
}

interface Tri {
  i0: number; i1: number; i2: number;
  depth: number;
  shade: number;
}

export interface BindingPanelHooks {
  onClose(): void;
  /** 拟合结果变化（拖拽/镜像/重置）时回调，供外部同步显示 */
  onChange?(fit: FitResult): void;
  /**
   * 点「Bind Skin」：外部在这里做 re-gen —— 算权重 → 反解网格 → 导出 GLB。
   * 面板只负责把拟合结果交出去，不关心导出细节（导出在 binding-export.ts）。
   * @param opts 额外选项（如平滑开关），外部据此决定是否平滑权重。
   */
  onApply?(fit: FitResult, opts?: ApplyOptions): void;
  /**
   * 点「载入 BVH…」：外部在这里选文件 → 解析 → 重定向到当前骨架。
   * 面板不碰文件 IO，只负责把入口暴露出来（与 onApply 同样的分层）。
   */
  onLoadBvh?(): void;
  /**
   * 点「导出动画 GLB」：外部把「T-pose 网格 + 骨骼 + 已重定向的动画」一起导出。
   * 没有载入 BVH 时按钮是禁用的。
   */
  onExportAnim?(): void;
  /**
   * 勾选「在 3D 视图显示包裹器」：外部据此在主 3D 视口开关 Skin Wrapper 圆柱体叠加层。
   * 面板不认识渲染器，只把开关状态交出去（与 onApply / onLoadBvh 同样的分层）。
   */
  onToggleViewportCylinders?(on: boolean): void;
  /**
   * 点「自动适配半径」后回调：告诉外部哪些骨被重算了（手动改过的不在此列）。
   * 面板不认识 HUD，只把结果交出去。
   */
  onAutoFit?(changed: string[]): void;
  /**
   * 点「保存绑定」：外部把当前编辑态（骨架摆位 + Skin Wrapper 半径）写回
   * `.meta.json`。面板只负责把入口暴露出来（与 onApply / onLoadBvh 同样的分层）。
   * 仅资产库入口（持有 GLB 路径）能落盘；层级面板入口无路径，由外部决定能否存。
   */
  onSave?(): void;
}

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
  /** 写入时间戳（ISO），仅供排障 */
  savedAt?: string | undefined;
}

export interface BindingPanelState {
  loaded: boolean;
  modelName: string | null;
  selected: string | null;
  /** 当前摆放的关节坐标（local 空间） */
  positions: Record<string, [number, number, number]>;
  triangles: number;
  vertices: number;
}

export class BindingPanel {
  private readonly rootEl: HTMLElement;
  private readonly hooks: BindingPanelHooks;
  /** 3D 正交视图用的 GPU 上下文；null = 无 WebGPU，正/侧视降级为纯 2D */
  private readonly gpu: GpuContext | null;

  private frontCanvas!: HTMLCanvasElement;
  private sideCanvas!: HTMLCanvasElement;
  private frontCtx!: CanvasRenderingContext2D;
  private sideCtx!: CanvasRenderingContext2D;
  /** 正视 / 侧视的 3D 正交层（垫在 2D 画布下方，画网格实体 + 包裹器体积） */
  private frontGl: BindingView3D | null = null;
  private sideGl: BindingView3D | null = null;
  private infoEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private animEl!: HTMLElement;
  private bvhBtn!: HTMLButtonElement;
  private exportAnimBtn!: HTMLButtonElement;
  private bindPoseBtn!: HTMLButtonElement;
  /** 「保存绑定」按钮与状态回显（写入成功/失败短暂提示） */
  private saveBtn!: HTMLButtonElement;
  private saveStatusEl!: HTMLElement;
  private saveStatusTimer = 0;
  /** 头部「?」按钮与它折叠的操作说明块 */
  private helpBtn!: HTMLButtonElement;
  private helpTipEl!: HTMLElement;
  /** 「● 未导出 / ✓ 已绑定」常驻徽标 */
  private exportBadgeEl!: HTMLElement;
  /**
   * 上次 Bind Skin 成功瞬间的「编辑指纹」（关节坐标 + 包裹器半径）。
   * `null` = 从未 Bind 过。与当前指纹不等即说明结果已过期 —— 比在十几个
   * 改动点里逐个插 markDirty 更不容易漏，因为 refresh() 是所有改动的唯一出口。
   */
  private boundSig: string | null = null;

  /**
   * 模型顶点（stride 15：pos3 / normal3 / smoothNormal3 / uv2 / color4）
   *
   * ⚠️ 两套指针，别合并：
   *  - `srcVerts` = 载入时的**当前姿态**网格，**永不被反解覆盖**。导出永远基于它 ——
   *    LBS 权重必须在当前姿态上算，若拿反解后的 T-pose 网格去算，A-pose 手臂权重全错。
   *  - `meshVerts` = 当前**显示**用的网格（缓存到离屏 canvas；可能是 srcVerts、
   *    反解后的 T-pose 网格、或重姿态成 T/A 的网格）。
   */
  private srcVerts: Float32Array | null = null;
  private meshVerts: Float32Array | null = null;
  private meshIndices: Uint32Array | null = null;
  private vertexFloats = 15;
  private modelName: string | null = null;
  /** 当前显示的网格是否已是反解后的 T-pose 网格 */
  private unposed = false;
  /** 已应用的 T-pose 网格（apply 后回灌，供「当前」模式展示） */
  private tposeMesh: Float32Array | null = null;

  /** 关节坐标：local 空间，可拖拽修改 */
  private positions: Record<string, [number, number, number]> = tposeWorldPositions();
  /**
   * 冻结保存的 Bind Pose —— 点「Bind Skin」时拍下的、带 initial offset 的编辑姿态。
   * 它「必须和模型对应起来」，所以一经绑定就持久存在：即便 Detach Skin 也不清空，
   * 只有再次 Bind Skin 才会刷新。随时切到 Bind 预览即可回到它，免去每次重拖骨骼。
   */
  private bindPose: JointPositions | null = null;
  private selected: string | null = null;

  // ── Skin Wrapper（代理圆柱体蒙皮）状态 ──
  /** 编辑模式：关节骨架 / 蒙皮包裹。两者共用同一套正视/侧视 2D 视图 */
  private editMode: 'skeleton' | 'skin' = 'skeleton';
  /** 每个 joint 的 Skin Wrapper（圆柱体）。null = 尚未进入 skin 模式 / 未载模型 */
  private cylinders: SkinCylinderMap | null = null;
  /** 当前选中的 Skin Wrapper（= 一整根骨，joint 名）。
   *  top/medium/bottom 只是同一根骨的三个半径显示，**整段一并选中**，绝不分别选中子段。 */
  private selectedCyl: string | null = null;
  /** 视图里拖半径时抓的是哪一段（top/medium/bottom）—— 仅拖拽手感用，**不是选中状态** */
  private dragSeg: CylSegment = 'medium';
  /** 导出时是否镜像皮肤权重 L→R */
  private mirrorWeightsExport = false;
  /**
   * 导出时使用的权重算法（默认 wrapper，与历史行为一致，避免静默改变既有产物）。
   * 切到 distance 时导出不传 cylinders，`runExport` 才会走 `computeLbsWeights`。
   */
  private weightMode: WeightMode = 'wrapper';
  /**
   * 是否在主 3D 视口画包裹器圆柱体（默认开）。
   * 面板只持有这个状态；真正的几何在 `cylinder-overlay.ts`，绘制由主循环驱动。
   */
  private viewportCylinders = true;

  /** 视图缩放：米 → 像素，由模型包围盒自动定 */
  private scale = 200;
  private originX = 0;
  private originY = 0;

  private fitCache: FitResult | null = null;

  // ── 本轮新增状态 ──
  private previewMode: PreviewMode = 'current';
  private sideFilter: SideFilter = 'all';
  private smoothWeights = true;
  /** 离屏网格缓存（按视图），仅在模型/姿态/缩放变化时重绘 */
  private cacheFront: HTMLCanvasElement | null = null;
  private cacheSide: HTMLCanvasElement | null = null;
  /** rAF 合帧锁 */
  private rafPending = false;
  /** 拖拽起点（屏幕像素 + 起始关节坐标），用于 Shift 约束 */
  private dragStart: { mx: number; my: number; x: number; y: number; z: number } | null = null;

  constructor(rootEl: HTMLElement, hooks: BindingPanelHooks, gpu: GpuContext | null = null) {
    this.rootEl = rootEl;
    this.hooks = hooks;
    this.gpu = gpu;
    this.buildDom();
  }

  // ─────────────────────────── DOM 构建 ───────────────────────────

  private buildDom(): void {
    this.rootEl.innerHTML = `
      <div class="bd-grip" data-bd="grip" title="拖拽下压面板，露出上方 3D 视图对照"></div>
      <div class="bd-head">
        <span class="bd-title">绑定<em>Binding</em></span>
        <span class="bd-model" data-bd="stats">未加载模型</span>
        <div class="bd-head-group" data-group="编辑">
          <span class="bd-glabel">编辑</span>
          <button class="bd-btn mode active" data-bd="mode-skel" title="选择并编辑 27 关节（22 骨干 + 5 tip）：拖拽对齐模型解剖位置">选择 Skeleton</button>
          <button class="bd-btn mode" data-bd="mode-skin" title="选择并编辑蒙皮包裹圆柱体 Skin Wrapper（整段 wrapper = 一根骨，top/medium/bottom 只调三个半径）">选择 Skin Wrapper</button>
          <span class="bd-toplabel">显示</span>
          <select class="bd-select" data-bd="sidefilter" title="隐藏 / 仅显某侧关节与 Skin Wrapper（左右都含包裹器）">
            <option value="all">全部</option>
            <option value="mid">仅中轴</option>
            <option value="hideL">隐藏左</option>
            <option value="hideR">隐藏右</option>
          </select>
          <label class="bd-check bd-check-head" title="在主 3D 视口里把每个 joint 的包裹圆柱体画到模型上（半透明 X-ray，不会被模型挡住），并随骨骼动画实时更新"><input type="checkbox" data-bd="skin-view3d">包裹器</label>
        </div>
        <div class="bd-head-group" data-group="镜像">
          <span class="bd-glabel">镜像</span>
          <button class="bd-btn" data-bd="mirror-lr" title="把左侧关节与 Skin Wrapper 半径一并镜像到右侧（x 取反）">镜像 L→R</button>
          <button class="bd-btn" data-bd="mirror-rl" title="把右侧关节与 Skin Wrapper 半径一并镜像到左侧（x 取反）">镜像 R→L</button>
        </div>
        <div class="bd-head-group" data-group="姿态">
          <span class="bd-glabel">姿态</span>
          <button class="bd-btn danger" data-bd="reset" title="回到模板 T-pose 的初始摆放（会清空全部关节编辑，有二次确认）">重置</button>
          <button class="bd-btn" data-bd="bvh" title="载入一份 BVH 动捕，重定向到当前 T-pose 骨架">载入 BVH…</button>
        </div>
        <div class="bd-head-group" data-group="产出">
          <span class="bd-glabel">产出</span>
          <span class="bd-toplabel">权重算法</span>
          <select class="bd-select" data-bd="weightmode" title="Bind Skin 时真正生效的权重算法。包裹体：被 Skin Wrapper 圆柱体包住才归属该骨，边界较硬但可控，配合半径精细调整；距离衰减：按顶点到骨段距离衰减取 top-4，过渡自然、不用调半径，但对侧骨可能抢到少量权重">
            <option value="wrapper">包裹体 Wrapper</option>
            <option value="distance">距离衰减</option>
          </select>
          <button class="bd-btn accent" data-bd="apply" title="用当前编辑姿态（带 offset）做绑定并导出；同时把此姿态冻结记录为 Bind Pose">Bind Skin</button>
          <button class="bd-btn" data-bd="export-anim" title="把 T-pose 网格 + 骨骼 + 已重定向的动画一起导出 GLB（需要先载入 BVH）" disabled>导出动画 GLB</button>
          <button class="bd-btn danger" data-bd="detach" title="移除已应用的皮肤结果，但保留 Bind Pose 与关节编辑（有二次确认）">Detach Skin</button>
        </div>
        <div class="bd-head-group bd-head-actions" data-group="保存">
          <span class="bd-glabel">保存</span>
          <button class="bd-btn save" data-bd="save" title="把当前骨架摆位与 Skin Wrapper 半径存回 <mesh>.meta.json（仅资产库入口有路径时可用）">保存绑定</button>
          <span class="bd-savestatus" data-bd="save-status"></span>
          <span class="bd-badge" data-bd="export-badge" hidden></span>
          <button class="bd-btn bd-icon" data-bd="help" title="展开 / 收起操作说明" aria-expanded="false">?</button>
          <button class="bd-btn bd-icon" data-bd="close" title="关闭绑定面板">✕</button>
        </div>
      </div>
      <div class="bd-body">
        <div class="bd-view">
          <div class="bd-vlabel">正视 Front · (x, y)</div>
          <div class="bd-stage" data-bd="stage-front">
            <canvas class="bd-gl" data-bd="front-gl"></canvas>
            <canvas class="bd-canvas" data-bd="front" tabindex="0"></canvas>
          </div>
        </div>
        <div class="bd-view">
          <div class="bd-vlabel">侧视 Side · (z, y)</div>
          <div class="bd-stage" data-bd="stage-side">
            <canvas class="bd-gl" data-bd="side-gl"></canvas>
            <canvas class="bd-canvas" data-bd="side" tabindex="0"></canvas>
          </div>
        </div>
        <div class="bd-side">
          <div class="bd-info" data-bd="info">选中一个 joint 查看骨长与姿态偏移</div>
          <div class="bd-anim" data-bd="anim">未载入动画</div>
          <div class="bd-field">
            <label>姿态预览</label>
            <div class="bd-pov" data-bd="pov">
              <button data-bd="pov-current" class="active" title="当前编辑姿态（可拖拽）">当前</button>
              <button data-bd="pov-t" title="把网格重姿态为标准 T-pose 并叠加参考骨架">T</button>
              <button data-bd="pov-a" title="把网格重姿态为标准 A-pose 并叠加参考骨架">A</button>
              <button data-bd="pov-bind" title="回到冻结的 Bind Pose（带 offset 的绑定姿态，可随时重绑）" disabled>Bind</button>
            </div>
          </div>
          <label class="bd-check"><input type="checkbox" data-bd="smooth" checked> 优化皮肤权重（apply 时平滑）</label>
          <div class="bd-legend">
            <div class="bd-legend-row"><i class="bd-dot bd-dot-mid"></i>中轴骨</div>
            <div class="bd-legend-row"><i class="bd-dot bd-dot-left"></i>左侧 L</div>
            <div class="bd-legend-row"><i class="bd-dot bd-dot-right"></i>右侧 R</div>
          </div>
          <div class="bd-tip" data-bd="tip" hidden>
            拖拽 joint 对齐模型解剖位置。<br>
            正视改 <b>x/y</b>，侧视改 <b>z/y</b>。<br>
            <b>Shift 拖拽</b>锁定横/纵主轴；<b>方向键</b>微调（Shift 5mm）。<br>
            <b>骨长</b>会被采纳进 T-pose；<br>
            <b>方向偏移</b>只是当前姿态与 T-pose 的差，<br>
            不会进骨架。<br>
            <b>Bind Skin</b> 绑定并冻结此姿态为 <b>Bind Pose</b>；<br>
            <b>Detach Skin</b> 移除结果但保留 Bind Pose；<br>
            切到 <b>Bind</b> 预览随时回到它重绑。
          </div>
            <div class="bd-js" data-bd="js-section">
              <div class="bd-js-title">Joint Skeleton</div>
              <div class="bd-skin" data-bd="skin-panel" hidden>
                <div class="bd-sel" data-bd="skin-sel">未选中圆柱体 · 在视图中点选一段</div>
                <div class="bd-field" data-bd="skin-sliders" hidden>
                  <label>Top 半径 <span data-bd="r-top-v"></span> m</label>
                  <div class="bd-rctl">
                    <input type="range" min="0.005" max="0.6" step="0.005" data-bd="r-top">
                    <input type="number" class="bd-num" min="0.005" max="0.6" step="0.005" data-bd="r-top-n">
                  </div>
                  <label>Medium 半径 <span data-bd="r-medium-v"></span> m</label>
                  <div class="bd-rctl">
                    <input type="range" min="0.005" max="0.6" step="0.005" data-bd="r-medium">
                    <input type="number" class="bd-num" min="0.005" max="0.6" step="0.005" data-bd="r-medium-n">
                  </div>
                  <label>Bottom 半径 <span data-bd="r-bottom-v"></span> m</label>
                  <div class="bd-rctl">
                    <input type="range" min="0.005" max="0.6" step="0.005" data-bd="r-bottom">
                    <input type="number" class="bd-num" min="0.005" max="0.6" step="0.005" data-bd="r-bottom-n">
                  </div>
                  <div class="bd-tip bd-tip-inline">滑块与数字框双向同步；方向键微调，<b>Shift + 方向键</b> 10× 步进。</div>
                </div>
                <div class="bd-field bd-offset" data-bd="skin-offset" hidden>
                  <label>偏移 Offset（沿骨局部轴，米）</label>
                  <label>轴向 X <span data-bd="o-x-v"></span></label>
                  <input type="number" step="0.005" data-bd="o-x">
                  <label>侧向 Y <span data-bd="o-y-v"></span></label>
                  <input type="number" step="0.005" data-bd="o-y">
                  <label>前后 Z <span data-bd="o-z-v"></span></label>
                  <input type="number" step="0.005" data-bd="o-z">
                  <div class="bd-skin-actions">
                    <button class="bd-btn" data-bd="offset-reset" title="偏移归零：包裹器回到骨段原位">偏移归零</button>
                  </div>
                  <div class="bd-tip">在视图里点中包裹器后：拖<b>核心</b>或按住 <b>Shift</b> 沿骨轴拖动 = 移动；拖<b>边缘</b> = 改半径。</div>
                </div>
                <div class="bd-skin-actions">
                  <button class="bd-btn" data-bd="cyl-mirror" disabled>镜像此圆柱 → 对侧</button>
                  <button class="bd-btn" data-bd="skin-mirror-all">镜像全部 L→R</button>
                </div>
                <div class="bd-skin-actions">
                  <button class="bd-btn" data-bd="cyl-autofit"
                    title="把未手动改过的骨半径重算为「骨长 ×0.35」；手动调过的骨不碰">自动适配半径</button>
                  <button class="bd-btn" data-bd="cyl-unpin"
                    title="取消当前骨的手动标记，交还给自动适配">重置此骨为自动</button>
                </div>
                <label class="bd-check"><input type="checkbox" data-bd="skin-mirror-w"> 导出时镜像皮肤权重 L→R</label>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    this.frontCanvas = this.rootEl.querySelector<HTMLCanvasElement>('[data-bd="front"]')!;
    this.sideCanvas = this.rootEl.querySelector<HTMLCanvasElement>('[data-bd="side"]')!;
    this.frontCtx = this.frontCanvas.getContext('2d')!;
    this.sideCtx = this.sideCanvas.getContext('2d')!;
    // 3D 正交层（WebGPU）：垫在 2D 画布下面，画网格实体 + 包裹器体积。
    // gpu 为 null（无 WebGPU）时降级回纯 2D 画家算法，功能不缺、只是没有体积感。
    if (this.gpu !== null) {
      const fgl = this.rootEl.querySelector<HTMLCanvasElement>('[data-bd="front-gl"]');
      const sgl = this.rootEl.querySelector<HTMLCanvasElement>('[data-bd="side-gl"]');
      if (fgl !== null) this.frontGl = new BindingView3D(fgl, this.gpu, 'front');
      if (sgl !== null) this.sideGl = new BindingView3D(sgl, this.gpu, 'side');
    }
    this.infoEl = this.rootEl.querySelector<HTMLElement>('[data-bd="info"]')!;
    this.statsEl = this.rootEl.querySelector<HTMLElement>('[data-bd="stats"]')!;
    this.animEl = this.rootEl.querySelector<HTMLElement>('[data-bd="anim"]')!;
    this.bvhBtn = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="bvh"]')!;
    this.exportAnimBtn = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="export-anim"]')!;
    this.bindPoseBtn = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="pov-bind"]')!;
    this.saveBtn = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="save"]')!;
    this.saveStatusEl = this.rootEl.querySelector<HTMLElement>('[data-bd="save-status"]')!;
    this.exportBadgeEl = this.rootEl.querySelector<HTMLElement>('[data-bd="export-badge"]')!;
    this.saveBtn.addEventListener('click', () => this.hooks.onSave?.());

    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="close"]')!
      .addEventListener('click', () => this.hooks.onClose());
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="reset"]')!
      .addEventListener('click', () => this.resetPose());
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="detach"]')!
      .addEventListener('click', () => this.detach());
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mirror-lr"]')!
      .addEventListener('click', () => { this.mirror('L2R'); });
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mirror-rl"]')!
      .addEventListener('click', () => { this.mirror('R2L'); });
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="apply"]')!
      .addEventListener('click', () => this.applyTPose());
    this.bvhBtn.addEventListener('click', () => this.hooks.onLoadBvh?.());
    this.exportAnimBtn.addEventListener('click', () => this.hooks.onExportAnim?.());

    // 姿态预览三态
    const pov = this.rootEl.querySelector<HTMLElement>('[data-bd="pov"]')!;
    pov.querySelector<HTMLButtonElement>('[data-bd="pov-current"]')!
      .addEventListener('click', () => this.setMode('current'));
    pov.querySelector<HTMLButtonElement>('[data-bd="pov-t"]')!
      .addEventListener('click', () => this.setMode('T'));
    pov.querySelector<HTMLButtonElement>('[data-bd="pov-a"]')!
      .addEventListener('click', () => this.setMode('A'));
    pov.querySelector<HTMLButtonElement>('[data-bd="pov-bind"]')!
      .addEventListener('click', () => this.setMode('bind'));

    // 半显下拉
    const sel = this.rootEl.querySelector<HTMLSelectElement>('[data-bd="sidefilter"]')!;
    sel.addEventListener('change', () => {
      this.sideFilter = sel.value as SideFilter;
      this.refresh();
    });

    // 权重算法：决定 Bind Skin 走包裹体还是距离衰减（见 WeightMode 注释）
    const wm = this.rootEl.querySelector<HTMLSelectElement>('[data-bd="weightmode"]')!;
    wm.value = this.weightMode;
    wm.addEventListener('change', () => {
      this.weightMode = wm.value as WeightMode;
      this.refresh();
    });

    // 权重平滑开关
    const smooth = this.rootEl.querySelector<HTMLInputElement>('[data-bd="smooth"]')!;
    smooth.addEventListener('change', () => { this.smoothWeights = smooth.checked; });

    // 模式切换：关节 Skeleton / 蒙皮包裹 Skin
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mode-skel"]')!
      .addEventListener('click', () => this.setEditMode('skeleton'));
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mode-skin"]')!
      .addEventListener('click', () => this.setEditMode('skin'));

    // Skin Wrapper 属性面板
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="cyl-mirror"]')!
      .addEventListener('click', () => this.mirrorSelectedCylinder());
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="skin-mirror-all"]')!
      .addEventListener('click', () => this.mirrorAllCylinders());
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="cyl-autofit"]')!
      .addEventListener('click', () => this.autoFitCylinders());
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="cyl-unpin"]')!
      .addEventListener('click', () => this.unpinSelectedCylinder());
    const mw = this.rootEl.querySelector<HTMLInputElement>('[data-bd="skin-mirror-w"]')!;
    mw.addEventListener('change', () => { this.mirrorWeightsExport = mw.checked; });

    // 「在 3D 视图显示包裹器」：默认开 —— 切到蒙皮模式就是要看圆柱体，
    // 不该让用户再去猜一个开关。状态同步给外部（主循环据此画/不画叠加层）。
    const v3d = this.rootEl.querySelector<HTMLInputElement>('[data-bd="skin-view3d"]')!;
    v3d.checked = this.viewportCylinders;
    v3d.addEventListener('change', () => {
      this.viewportCylinders = v3d.checked;
      this.hooks.onToggleViewportCylinders?.(v3d.checked);
    });

    // 半径：滑块 + 数字框双向同步，两条路径都走 setCylinderRadius 这一个入口。
    // 方向键微调：原生 range 已支持，这里补 Shift = 10× 步进。
    for (const seg of ['top', 'medium', 'bottom'] as const) {
      const sl = this.rootEl.querySelector<HTMLInputElement>(`[data-bd="r-${seg}"]`)!;
      sl.addEventListener('input', () => this.onRadiusSlider(seg, sl.value, sl));
      sl.addEventListener('keydown', (e) => this.onRadiusKey(seg, sl, e));
      const num = this.rootEl.querySelector<HTMLInputElement>(`[data-bd="r-${seg}-n"]`)!;
      num.addEventListener('input', () => this.onRadiusSlider(seg, num.value, num));
      num.addEventListener('keydown', (e) => this.onRadiusKey(seg, num, e));
    }

    // 操作说明折叠（默认收起，头部「?」切换）
    this.helpBtn = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="help"]')!;
    this.helpTipEl = this.rootEl.querySelector<HTMLElement>('[data-bd="tip"]')!;
    this.helpBtn.addEventListener('click', () => this.toggleHelp());

    // 包裹器偏移（沿骨局部轴）：X/Y/Z 三个输入框 + 归零按钮
    for (const ax of ['x', 'y', 'z'] as const) {
      const inp = this.rootEl.querySelector<HTMLInputElement>(`[data-bd="o-${ax}"]`)!;
      inp.addEventListener('input', () => this.onOffsetInput(ax, inp.value));
    }
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="offset-reset"]')!
      .addEventListener('click', () => this.resetOffset());

    this.bindCanvas(this.frontCanvas, 'front');
    this.bindCanvas(this.sideCanvas, 'side');
    this.injectStyle();
  }

  /** 注入本模块专属样式（避免修改 index.html / 其他模块） */
  private static styleInjected = false;
  private injectStyle(): void {
    if (BindingPanel.styleInjected) return;
    BindingPanel.styleInjected = true;
    const css = `
      .bd-btn.mode.active { background: var(--zombie); color: var(--ink); border-color: var(--zombie); }
      .bd-js-title { font-weight: 700; font-size: 12px; color: var(--toxic); margin: 8px 0 4px; letter-spacing: .5px; }
      .bd-skin { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px;
        background: rgba(155,93,229,0.08); border: 1px solid rgba(155,93,229,0.3); border-radius: 6px; }
      .bd-skin-actions { display: flex; gap: 4px; }
      .bd-skin-actions .bd-btn { flex: 1 1 0; }
      /* 宽度交给 .bd-rctl 的 flex 布局（滑块与数字框同排），这里只管配色 */
      .bd-skin input[type=range] { accent-color: var(--zombie); min-width: 0; }
      .bd-sel { font-size: 11px; color: var(--text-dim); }
      .bd-head .bd-select { flex: 0 0 auto; }
      .bd-btn.save { border-color: var(--toxic); color: var(--toxic); }
      .bd-btn.save:hover { background: rgba(124,252,0,0.16); }
      .bd-savestatus { font-size: 11px; color: var(--text-dim); white-space: nowrap; min-width: 0; }
      .bd-savestatus.ok { color: var(--toxic); }
      .bd-savestatus.err { color: #ff9d6e; }
    `;
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ─────────────────────────── 模型载入 ───────────────────────────

  /**
   * 载入模型。vertices 用引擎的 15-float 布局（pos 在 offset 0..2）。
   * 只取几何做正交投影，不碰材质/贴图 —— 对齐 joint 看剪影与明暗足够。
   */
  setModel(name: string, vertices: Float32Array, indices: Uint32Array, vertexFloats = 15): void {
    this.modelName = name;
    this.srcVerts = vertices;
    this.meshVerts = vertices;
    this.meshIndices = indices;
    this.vertexFloats = vertexFloats;
    this.selected = null;
    this.unposed = false;
    this.tposeMesh = null;
    this.previewMode = 'current';
    this.sideFilter = 'all';
    this.bindPose = null;
    this.boundSig = null;
    this.bindPoseBtn.disabled = true;
    this.editMode = 'skeleton';
    this.cylinders = null;
    this.selectedCyl = null;
    this.dragSeg = 'medium';
    this.mirrorWeightsExport = false;
    this.weightMode = 'wrapper';
    this.syncWeightModeSelect();
    this.resetModeButtons();
    const sp = this.rootEl.querySelector<HTMLElement>('[data-bd="skin-panel"]');
    if (sp !== null) sp.hidden = true;
    const mw = this.rootEl.querySelector<HTMLInputElement>('[data-bd="skin-mirror-w"]');
    if (mw !== null) mw.checked = false;
    this.setAnimationInfo(null);
    // 半径表**载入即建**：关节模式也要用它。
    // 之前只在切到蒙皮模式时才建，关节模式的 3D 层拿到 null → 回退成
    // 「骨长 ×0.35」的自动半径，于是「拖 joint 包裹器自己变大变小、手动调的
    // 却看不到」—— 自动算法把手动值盖掉了。
    this.ensureCylinders();
    this.computeViewFit();
    this.syncDisplay();
    this.refresh();
  }

  /**
   * 显示一段已重定向动画的诊断信息，并联动「导出动画 GLB」按钮的可用性。
   *
   * @param html null = 清空（换模型 / 关面板时用），此时导出按钮禁用
   */
  setAnimationInfo(html: string | null): void {
    if (html === null) {
      this.animEl.innerHTML = '<span class="bd-dim">未载入动画</span>';
      this.exportAnimBtn.disabled = true;
      return;
    }
    this.animEl.innerHTML = html;
    this.exportAnimBtn.disabled = false;
  }

  clear(): void {
    this.srcVerts = null;
    this.meshVerts = null;
    this.meshIndices = null;
    this.modelName = null;
    this.unposed = false;
    this.tposeMesh = null;
    this.previewMode = 'current';
    this.sideFilter = 'all';
    this.bindPose = null;
    this.boundSig = null;
    this.bindPoseBtn.disabled = true;
    this.editMode = 'skeleton';
    this.cylinders = null;
    this.selectedCyl = null;
    this.dragSeg = 'medium';
    this.mirrorWeightsExport = false;
    this.weightMode = 'wrapper';
    this.syncWeightModeSelect();
    this.resetModeButtons();
    const sp = this.rootEl.querySelector<HTMLElement>('[data-bd="skin-panel"]');
    if (sp !== null) sp.hidden = true;
    this.positions = tposeWorldPositions();
    this.selected = null;
    this.setAnimationInfo(null);
    this.syncDisplay();
    this.refresh();
  }

  /** 按模型包围盒自动定缩放，让模型刚好铺满视图 */
  private computeViewFit(): void {
    const v = this.meshVerts;
    if (v === null) { this.scale = 200; this.originX = 0; this.originY = 0; return; }
    const n = v.length / this.vertexFloats;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * this.vertexFloats;
      const x = v[o]!, y = v[o + 1]!, z = v[o + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    // 正/侧视图共用一套缩放，取两轴里更"宽"的那个，避免一侧被裁
    const spanY = Math.max(maxY - minY, 0.1);
    const spanH = Math.max(maxX - minX, maxZ - minZ, 0.1);
    const canvas = this.frontCanvas;
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 320;
    this.scale = Math.min((w * 0.86) / spanH, (h * 0.86) / spanY);
    // 视图原点：水平居中，垂直对齐模型底部（脚在 y=0）
    this.originX = w / 2;
    this.originY = h * 0.92;
  }

  // ─────────────────────────── 显示同步 ───────────────────────────

  /**
   * 根据 previewMode 计算当前应显示的网格与（drawSkeleton 用的）参考骨架。
   * 仅在模型/姿态/模式变化时被调用，不在每帧重复算重姿态。
   */
  private syncDisplay(): void {
    if (this.srcVerts === null || this.meshIndices === null) {
      this.meshVerts = this.srcVerts;
    } else if (this.previewMode === 'current') {
      this.meshVerts = (this.unposed && this.tposeMesh !== null) ? this.tposeMesh : this.srcVerts;
    } else if (this.previewMode === 'bind') {
      // Bind Pose 预览：原始网格即处于 bind pose（模型原生姿态），直接显示 + 冻结骨架叠加
      this.meshVerts = this.srcVerts;
    } else {
      // T / A：把当前姿态网格重姿态为目标姿态（胶囊权重 + 刚体骨变换按权重混合）
      const fit = this.currentFit();
      const segs = boneSegments(this.positions);
      const skin = computeLbsWeights(
        this.srcVerts, this.vertexFloats, this.srcVerts.length / this.vertexFloats, segs,
      );
      const toWorld = this.previewMode === 'T' ? fit.tposeWorld : aposeWorld(this.positions);
      this.meshVerts = reposeMesh(
        this.srcVerts, this.vertexFloats, this.srcVerts.length / this.vertexFloats,
        skin, fit.posedWorld, toWorld,
      );
    }
    // 网格变了 → 离屏缓存失效（下一帧重建）
    this.cacheFront = null;
    this.cacheSide = null;
  }

  /** 当前应叠加绘制的骨架（参考姿态）：当前=编辑骨架，T=重建 T-pose，A=A-pose，bind=冻结的 Bind Pose */
  private overlayPositions(): JointPositions {
    if (this.previewMode === 'T') return this.currentFit().tposePositions;
    if (this.previewMode === 'A') return aposeWorldPositions(this.positions);
    if (this.previewMode === 'bind' && this.bindPose !== null) return this.bindPose;
    return this.positions;
  }

  /** 过滤后的可见关节（按 sideFilter） */
  private visibleJoints(): string[] {
    switch (this.sideFilter) {
      case 'mid': return HUMANIK_ORDER.filter((n) => !n.startsWith('Left') && !n.startsWith('Right'));
      case 'hideL': return HUMANIK_ORDER.filter((n) => !n.startsWith('Left'));
      case 'hideR': return HUMANIK_ORDER.filter((n) => !n.startsWith('Right'));
      default: return [...HUMANIK_ORDER];
    }
  }

  /**
   * 给 3D 层用的包裹器表：把被「隐藏左/右/仅中轴」过滤掉的骨标成 disabled
   * （半径保留，只让圆柱几何跳过绘制）。sideFilter=all 时直接返回原表，零分配。
   */
  private filteredCylinders(vis: Set<string>): SkinCylinderMap | null {
    if (this.cylinders === null) return null;
    if (this.sideFilter === 'all') return this.cylinders;
    const out: SkinCylinderMap = {};
    for (const [k, c] of Object.entries(this.cylinders)) {
      out[k] = vis.has(k) ? c : { ...c, enabled: false };
    }
    return out;
  }

  // ─────────────────────────── 交互 ───────────────────────────

  private bindCanvas(canvas: HTMLCanvasElement, axis: ViewAxis): void {
    let dragging: string | null = null;
    /**
     * 蒙皮模式下「拖圆柱体改半径」的拖拽状态。
     *
     * 语义：半径 = 指针到**骨轴**的垂距（米）。这是最直观的操作 ——
     * 把圆柱体拖粗/拖细，粗细就是手指离骨头的距离。
     * 只改点中的那一段（top / medium / bottom），与半径滑块一一对应。
     */
    let radDrag: {
      bone: string;
      seg: CylSegment;
      a: [number, number];
      b: [number, number];
    } | null = null;
    /**
     * 蒙皮模式下「沿 joint 局部轴拖动包裹器」的拖拽状态。
     * 语义：位移 = 指针沿**骨轴屏幕投影方向**的位移（像素 → 米），写进包裹器偏移的
     * 轴向分量（offset[0]）。抓住圆柱体**核心**或按住 **Shift** 触发，抓住**边缘**则是改半径。
     */
    let axisDrag: {
      bone: string;
      p0: [number, number];
      p1: [number, number];
      startMx: number;
      startMy: number;
      startOff: number;
    } | null = null;
    /** 平移视图（中键拖拽）。pan 改 originX/originY，前/侧视图共用 → 一起平移。 */
    let panning = false;
    let panStartMx = 0, panStartMy = 0, panOX = 0, panOY = 0;

    const pick = (e: PointerEvent): string | null => {
      // 非当前姿态预览下不编辑（参考骨架只读）
      if (this.previewMode !== 'current') return null;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      let best: string | null = null;
      let bestD = JOINT_HIT_PX;
      for (const name of this.visibleJoints()) {
        const [sx, sy] = this.project(this.positions[name]!, axis, canvas);
        const d = Math.hypot(sx - mx, sy - my);
        if (d < bestD) { bestD = d; best = name; }
      }
      return best;
    };

    canvas.addEventListener('pointerdown', (e) => {
      // 中键 → 平移视图（与左键拖 joint / 半径互不冲突）
      if (e.button === 1) {
        panning = true;
        panStartMx = e.clientX;
        panStartMy = e.clientY;
        panOX = this.originX;
        panOY = this.originY;
        e.preventDefault();
        try { canvas.setPointerCapture(e.pointerId); } catch { /* 无真实指针 */ }
        return;
      }
      // 蒙皮模式：点选整根圆柱体（一个 wrapper = 一根骨），不直接拖骨架
      if (this.editMode === 'skin') {
        const hit = this.pickCylinder(e, canvas, axis);
        // 选中 = 整根骨；top/medium/bottom 只是同一段的 3 个半径，不分别选中
        this.selectedCyl = hit?.bone ?? null;
        this.dragSeg = hit?.seg ?? 'medium';
        this.updateSkinPanel();
        this.refresh();
        if (hit === null) return;
        // 骨轴两端点用**整根骨**（不是子段），垂距才不会因为落在子段端点外而跳变；
        // 同时吃包裹器偏移，拖的是「看到的那根」（可能已被平移过）
        const sg = boneSegments(this.positions).find((x) => x.bone === hit.bone);
        if (sg === undefined) return;
        const cyl = this.cylinders?.[hit.bone];
        const ends = offsetSegmentEndpoints(sg.a, sg.b, cyl?.offset);
        const A = this.project(ends.a, axis, canvas);
        const B = this.project(ends.b, axis, canvas);
        // 距骨轴垂距（像素）与子段半径（像素）：据此判断「抓核心=移动」还是「抓边缘=改半径」
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const drPx = BindingPanel.distPointToLine2d(mx, my, A, B);
        const rPx = Math.max(4, (cyl?.radii?.[hit.seg] ?? 0.1) * this.scale);
        const axial = e.shiftKey || drPx < rPx * 0.45;
        if (axial) {
          const off = this.getOffset(hit.bone);
          axisDrag = { bone: hit.bone, p0: A, p1: B, startMx: mx, startMy: my, startOff: off[0] };
        } else {
          // 点中即开始拖半径
          radDrag = { bone: hit.bone, seg: this.dragSeg, a: A, b: B };
        }
        canvas.focus();
        // 合成事件（自动化钩子）没有真实 pointer，setPointerCapture 会抛 —— 忽略即可
        try { canvas.setPointerCapture(e.pointerId); } catch { /* 无真实指针 */ }
        return;
      }
      const hit = pick(e);
      if (hit === null) return;
      dragging = hit;
      this.selected = hit;
      canvas.focus();
      const rect = canvas.getBoundingClientRect();
      const p = this.positions[hit]!;
      this.dragStart = {
        mx: e.clientX - rect.left,
        my: e.clientY - rect.top,
        x: p[0], y: p[1], z: p[2],
      };
      canvas.setPointerCapture(e.pointerId);
      this.refresh();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (panning) {
        this.originX = panOX + (e.clientX - panStartMx);
        this.originY = panOY + (e.clientY - panStartMy);
        this.refresh();
        return;
      }
      if (axisDrag !== null) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        // 指针位移投影到骨轴的 2D 屏幕方向 → 沿轴像素位移 → 米 → 写进偏移的轴向分量
        const dx = axisDrag.p1[0] - axisDrag.p0[0];
        const dy = axisDrag.p1[1] - axisDrag.p0[1];
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const dm = (mx - axisDrag.startMx) * ux + (my - axisDrag.startMy) * uy;
        const meters = dm / this.scale;
        const off = this.getOffset(axisDrag.bone);
        off[0] = axisDrag.startOff + meters;
        if (this.setCylinderOffset(axisDrag.bone, off)) {
          this.updateSkinPanel();
          this.refresh();
        }
        return;
      }
      if (radDrag !== null) {
        const rect = canvas.getBoundingClientRect();
        const d = BindingPanel.distPointToLine2d(
          e.clientX - rect.left, e.clientY - rect.top, radDrag.a, radDrag.b,
        );
        // 与半径滑块同一量程 [0.01, 0.6]
        const r = Math.min(0.6, Math.max(0.01, d / this.scale));
        if (this.setCylinderRadius(radDrag.bone, radDrag.seg, r)) {
          this.updateSkinPanel(); // 滑块与数值跟着走，两个入口永远一致
          this.refresh();
        }
        return;
      }
      if (dragging === null) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const p = this.positions[dragging]!;
      const y = (this.originY - my) / this.scale;
      // Shift 约束：锁定离起点位移较小的主轴，实现纯横向 / 纯纵向精确移动
      let lockY = false;
      let lockX = false;
      if (e.shiftKey && this.dragStart !== null) {
        const dx = mx - this.dragStart.mx;
        const dy = my - this.dragStart.my;
        if (Math.abs(dx) >= Math.abs(dy)) lockY = true; else lockX = true;
      }
      if (axis === 'front') {
        const x = lockX ? this.dragStart!.x : (mx - this.originX) / this.scale;
        this.positions[dragging] = [x, lockY ? this.dragStart!.y : y, p[2]];
      } else {
        const z = lockX ? this.dragStart!.z : (mx - this.originX) / this.scale;
        this.positions[dragging] = [p[0], lockY ? this.dragStart!.y : y, z];
      }
      this.refresh();
    });

    const end = (e: PointerEvent): void => {
      if (axisDrag !== null) {
        axisDrag = null;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
      if (radDrag !== null) {
        radDrag = null;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
      if (dragging === null) return;
      dragging = null;
      this.dragStart = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // 方向键微调（Shift 精调 5mm）；仅当前姿态可编辑
    canvas.addEventListener('keydown', (e) => {
      if (this.editMode !== 'skeleton') return;
      if (this.selected === null || this.previewMode !== 'current') return;
      const step = e.shiftKey ? NUDGE_STEP_FINE : NUDGE_STEP;
      const p = this.positions[this.selected]!;
      let { x, y, z } = { x: p[0], y: p[1], z: p[2] };
      switch (e.key) {
        case 'ArrowUp': y += step; break;
        case 'ArrowDown': y -= step; break;
        case 'ArrowLeft': if (axis === 'front') x -= step; else z -= step; break;
        case 'ArrowRight': if (axis === 'front') x += step; else z += step; break;
        default: return;
      }
      e.preventDefault();
      this.positions[this.selected] = [x, y, z];
      this.refresh();
    });

    // 滚轮缩放（zoom）：乘性系数，前/侧视图共用 this.scale → 一起缩放。
    // 锚定在指针处：指针下的世界点保持不动，缩放才自然（不会「往一边飘」）。
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.001);
      const s2 = Math.min(BIND_ZOOM_MAX, Math.max(BIND_ZOOM_MIN, this.scale * factor));
      if (s2 === this.scale) return;
      // 指针下的世界坐标（前视 horiz=x / 侧视 horiz=z，纵轴都是 y）
      const worldH = (mx - this.originX) / this.scale;
      const worldY = (this.originY - my) / this.scale;
      this.scale = s2;
      this.originX = mx - worldH * s2;
      this.originY = my + worldY * s2;
      this.refresh();
    }, { passive: false });
  }

  /** 三维 → 二维。正视 (x, -y)；侧视 (z, -y)。画布 y 轴朝下，故 y 取反。
   *  直接吃 `originX/originY/scale` —— 与 `pointermove` 的反投影严格对称，
   *  所以 pan/zoom 时 2D 骨架与 3D 包裹器体积始终对齐。 */
  private project(
    p: Vec3,
    axis: ViewAxis,
    canvas: HTMLCanvasElement,
  ): [number, number] {
    const horiz = axis === 'front' ? p[0] : p[2];
    return [this.originX + horiz * this.scale, this.originY - p[1] * this.scale];
  }

  /** 镜像：左右对称面 x=0，故 x 取反且互换左右骨名。骨架与 Skin Wrapper 半径一并镜像。 */
  private mirror(dir: 'L2R' | 'R2L'): void {
    for (const [l, r] of MIRROR_PAIRS) {
      const src = dir === 'L2R' ? l : r;
      const dst = dir === 'L2R' ? r : l;
      const s = this.positions[src]!;
      this.positions[dst] = [-s[0], s[1], s[2]];
      // 包裹器半径一并镜像：否则骨架翻过去了，wrapper 半径还留在原侧（之前「skin wrapper 没法镜像」的真因）
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
    this.refresh();
  }

  /** 三态姿态预览切换 */
  private setMode(mode: PreviewMode): void {
    if (mode === this.previewMode) return;
    // 回到冻结的 Bind Pose：把编辑姿态恢复成拍下的 bind pose（只读预览，可随时重绑）
    if (mode === 'bind') {
      if (this.bindPose === null) return;
      this.positions = this.clonePositions(this.bindPose);
    }
    this.previewMode = mode;
    const pov = this.rootEl.querySelector<HTMLElement>('[data-bd="pov"]')!;
    pov.querySelector<HTMLButtonElement>('[data-bd="pov-current"]')!
      .classList.toggle('active', mode === 'current');
    pov.querySelector<HTMLButtonElement>('[data-bd="pov-t"]')!
      .classList.toggle('active', mode === 'T');
    pov.querySelector<HTMLButtonElement>('[data-bd="pov-a"]')!
      .classList.toggle('active', mode === 'A');
    pov.querySelector<HTMLButtonElement>('[data-bd="pov-bind"]')!
      .classList.toggle('active', mode === 'bind');
    this.syncDisplay();
    this.refresh();
  }

  /** 安全重置：清空所有关节编辑（带确认，避免误丢数据） */
  private resetPose(): void {
    if (!window.confirm('重置会清空当前所有关节编辑，回到模板 T-pose。确定？')) return;
    this.positions = tposeWorldPositions();
    this.previewMode = 'current';
    this.unposed = false;
    this.tposeMesh = null;
    this.syncDisplay();
    this.refresh();
  }

  /**
   * Detach 皮肤：移除已应用的 T-pose 结果，但**保留 Bind Pose 与关节编辑**。
   * bindPose 是独立字段，这里不动它 —— 所以切到 Bind 预览仍能回到冻结的绑定姿态。
   */
  private detach(): void {
    if (!window.confirm('Detach 会移除已应用的绑定结果（Bind Pose 与关节编辑保留）。确定？')) return;
    this.unposed = false;
    this.tposeMesh = null;
    this.previewMode = 'current';
    // 结果没了 → 回到「未导出」
    this.boundSig = null;
    this.syncDisplay();
    this.refresh();
  }

  /**
   * Bind Skin：把「当前编辑姿态 + 当前网格」交出去做 re-gen（带平滑开关），并冻结 Bind Pose。
   *
   * ⚠️ **绑完骨架绝不动**：bind pose 是动词 —— 在「当前姿势 + 当前模型」把骨骼与皮肤绑定的
   * 那一瞬间，骨架的姿势就叫 bind pose。所以这里**绝不**把 `positions` 复位成 T-pose，
   * 绑定后你仍停留在 bind pose（与 T pose 天然不同），可随时切 T / A 预览对比。
   */
  private applyTPose(): void {
    const fit = this.currentFit();
    // 冻结保存 Bind Pose（绑定瞬间的带 offset 姿态），永久存在；Detach 不清空，再 Bind 才刷新。
    this.bindPose = this.clonePositions(this.positions);
    this.bindPoseBtn.disabled = false;
    this.hooks.onApply?.(fit, { smoothWeights: this.smoothWeights });
    // 注意：不复位 positions —— 骨骼保持 bind pose 不动（用户铁律）。
    // 记下这一刻的编辑指纹：徽标据此判断「之后动过没有」。
    this.boundSig = this.editSig();
    this.refresh();
  }

  /**
   * 反解结果回灌：把 re-gen 出的 T-pose 网格存着（供「T」预览复用），
   * 但**骨骼保持 bind pose 不动** —— 绑定是动词，绑完骨架姿势即定，绝不跳回 T-pose。
   */
  showTPoseResult(fit: FitResult, verts: Float32Array): void {
    this.tposeMesh = verts;
    this.unposed = false;
    this.fitCache = fit;
    this.syncDisplay();
    this.refresh();
  }

  currentFit(): FitResult {
    // 22 骨规模极小，每次重算无性能压力，不做缓存失效判断
    this.fitCache = fitSkeleton(this.positions);
    return this.fitCache;
  }

  /** 深拷贝一份关节坐标（冻结 Bind Pose 用，避免与实时编辑互相污染） */
  private clonePositions(p: JointPositions): JointPositions {
    const out: Record<string, [number, number, number]> = {};
    for (const name of HUMANIK_ORDER) out[name] = [...p[name]!];
    return out;
  }

  // ─────────────────────────── Skin Wrapper（代理圆柱体） ───────────────────────────

  /** 切换编辑模式（关节骨架 / 蒙皮包裹）。进入 skin 模式时惰性初始化默认 wrapper */
  private setEditMode(mode: 'skeleton' | 'skin'): void {
    if (mode === this.editMode) return;
    this.editMode = mode;
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mode-skel"]')!
      .classList.toggle('active', mode === 'skeleton');
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mode-skin"]')!
      .classList.toggle('active', mode === 'skin');
    const skinPanel = this.rootEl.querySelector<HTMLElement>('[data-bd="skin-panel"]')!;
    skinPanel.hidden = mode !== 'skin';
    if (mode === 'skin') this.ensureCylinders();
    this.refresh();
  }

  /** 把 this.weightMode 同步回下拉（换模型 / 清空 / 载入编辑态后调用） */
  private syncWeightModeSelect(): void {
    const wm = this.rootEl.querySelector<HTMLSelectElement>('[data-bd="weightmode"]');
    if (wm !== null) wm.value = this.weightMode;
  }

  private resetModeButtons(): void {
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mode-skel"]')!
      .classList.toggle('active', true);
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mode-skin"]')!
      .classList.toggle('active', false);
  }

  private ensureCylinders(): void {
    if (this.cylinders === null) {
      this.cylinders = defaultSkinCylinders(this.positions);
    }
  }

  /** 把选中圆柱体（若有对侧同名骨）的半径镜像到对侧 */
  private mirrorSelectedCylinder(): void {
    if (this.selectedCyl === null || this.cylinders === null) return;
    const m = mirrorOf(this.selectedCyl);
    if (m === null) return;
    const src = this.cylinders[this.selectedCyl]!;
    this.cylinders[m] = {
      bone: m, radii: { ...src.radii }, enabled: src.enabled, manual: true,
    };
    this.refresh();
  }

  /** 全部 L↔R 镜像 wrapper 几何 */
  private mirrorAllCylinders(): void {
    if (this.cylinders === null) return;
    this.cylinders = mirrorCylinders(this.cylinders);
    this.updateSkinPanel();
    this.refresh();
  }

  /**
   * 半径变化（滑块或数字框）→ 收口到 setCylinderRadius 这一个入口，并把值回灌给
   * **另一个**控件。`src` 是事件源，避免把用户正在敲的输入框自己覆盖掉。
   */
  private onRadiusSlider(seg: CylSegment, value: string, src: HTMLInputElement): void {
    if (this.selectedCyl === null) return;
    const v = parseFloat(value);
    if (!Number.isFinite(v)) return;
    if (!this.setCylinderRadius(this.selectedCyl, seg, v)) return;
    const span = this.rootEl.querySelector<HTMLElement>(`[data-bd="r-${seg}-v"]`);
    if (span !== null) span.textContent = v.toFixed(3);
    for (const key of [`r-${seg}`, `r-${seg}-n`]) {
      const el = this.rootEl.querySelector<HTMLInputElement>(`[data-bd="${key}"]`);
      if (el !== null && el !== src) el.value = String(v);
    }
  }

  /**
   * 半径控件的键盘微调。方向键交给浏览器原生（step=0.005），
   * 这里只补 Shift + 方向键 = 10× 步进，避免细调 0.6m 这种大行程时按到手酸。
   */
  private onRadiusKey(seg: CylSegment, el: HTMLInputElement, e: KeyboardEvent): void {
    if (!e.shiftKey) return;
    const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1
      : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const step = (parseFloat(el.step) || 0.005) * 10;
    const cur = parseFloat(el.value);
    if (!Number.isFinite(cur)) return;
    const numMin = parseFloat(el.min);
    const numMax = parseFloat(el.max);
    const lo = Number.isFinite(numMin) ? numMin : BindingPanel.R_MIN;
    const hi = Number.isFinite(numMax) ? numMax : BindingPanel.R_MAX;
    const next = Math.min(hi, Math.max(lo, cur + dir * step));
    el.value = String(next);
    this.onRadiusSlider(seg, el.value, el);
  }

  /**
   * 半径量程（滑块用）。
   *
   * ⚠️ **刻意不做「随骨长自适应」** —— 试过 `骨长 × 0.8`，两个问题：
   *   ① range 的 `max` 会**静默钳制**写入值：用户/脚本写 0.3，骨短时被悄悄
   *      改成 0.155，既违反本项目「禁止静默修数据」，也让外部无法写超量程值；
   *   ② 量程随选中骨变化 = 同一个滑块位置在不同骨上代表不同半径，肌肉记忆失效。
   * 精确输入交给数字框（它不会被钳制），滑块只负责粗调，量程固定、step 更细。
   */
  private static readonly R_MIN = 0.005;
  private static readonly R_MAX = 0.6;

  /**
   * 设置某根骨某段的包裹器半径（滑块与自动化钩子共用同一条路径 —— 只有一条
   * 路径才不会出现「钩子能改、UI 改不动」这种对不上的假绿）。
   *
   * @returns 是否真的写进去了（半径表未初始化 / 骨名不存在 / 值非法 = false）
   */
  setCylinderRadius(bone: string, seg: CylSegment, v: number): boolean {
    const cyl = this.cylinders?.[bone];
    if (cyl === undefined || !Number.isFinite(v)) return false;
    cyl.radii[seg] = v;
    // 手动改过 → 打标记，自动适配从此不再碰这根骨
    cyl.manual = true;
    this.refresh();
    return true;
  }

  /** 读某骨包裹器的当前偏移（未设置时返回 [0,0,0]，可变元祖便于就地改写单轴） */
  private getOffset(bone: string): [number, number, number] {
    const c = this.cylinders?.[bone];
    return c?.offset !== undefined ? [c.offset[0], c.offset[1], c.offset[2]] : [0, 0, 0];
  }

  /**
   * 设置整根包裹器的偏移（沿骨局部轴：x=轴向 / y=侧向 / z=前后）。
   * 偏移全部为 0 时存 undefined（干净），否则存数组；手动标记一并打上。
   * 画几何体与算权重都按此偏移，保证「看到的体积 == 算权重用的体积」。
   */
  setCylinderOffset(bone: string, offset: Vec3): boolean {
    const cyl = this.cylinders?.[bone];
    if (
      cyl === undefined ||
      !Number.isFinite(offset[0]) || !Number.isFinite(offset[1]) || !Number.isFinite(offset[2])
    ) return false;
    const zero = offset[0] === 0 && offset[1] === 0 && offset[2] === 0;
    cyl.offset = zero ? undefined : [offset[0], offset[1], offset[2]];
    cyl.manual = true;
    this.refresh();
    return true;
  }

  /** 偏移某个轴向输入框变化 → 写回包裹器偏移并重绘 */
  private onOffsetInput(ax: 'x' | 'y' | 'z', value: string): void {
    if (this.selectedCyl === null) return;
    const v = parseFloat(value);
    if (!Number.isFinite(v)) return;
    const off = this.getOffset(this.selectedCyl);
    const i = ax === 'x' ? 0 : ax === 'y' ? 1 : 2;
    off[i] = v;
    this.setCylinderOffset(this.selectedCyl, off);
    const span = this.rootEl.querySelector<HTMLElement>(`[data-bd="o-${ax}-v"]`)!;
    span.textContent = v.toFixed(3);
  }

  /** 偏移归零：包裹器回到骨段原位 */
  private resetOffset(): void {
    if (this.selectedCyl === null) return;
    this.setCylinderOffset(this.selectedCyl, [0, 0, 0]);
    this.updateSkinPanel();
  }

  /**
   * 自动适配：**未手动改过**的骨按骨长重算半径，手动改过的一个不碰。
   * 显式按钮才调，绝不每帧隐式跑（隐式跑 = 覆盖手动值）。
   */
  private autoFitCylinders(): void {
    if (this.cylinders === null) return;
    const changed = autoFitCylinders(this.positions, this.cylinders);
    this.updateSkinPanel();
    this.refresh();
    this.hooks.onAutoFit?.(changed);
  }

  /** 取消当前骨的手动标记，交还给自动适配 */
  private unpinSelectedCylinder(): void {
    if (this.selectedCyl === null || this.cylinders === null) return;
    const cyl = this.cylinders[this.selectedCyl];
    if (cyl === undefined) return;
    cyl.manual = false;
    autoFitCylinders(this.positions, this.cylinders);
    this.updateSkinPanel();
    this.refresh();
  }

  /** 刷新 skin 属性面板（选中信息 + 三段半径滑块 + 偏移 + 镜像按钮可用性） */
  private updateSkinPanel(): void {
    const sel = this.rootEl.querySelector<HTMLElement>('[data-bd="skin-sel"]')!;
    const sliders = this.rootEl.querySelector<HTMLElement>('[data-bd="skin-sliders"]')!;
    const offBox = this.rootEl.querySelector<HTMLElement>('[data-bd="skin-offset"]')!;
    const mirBtn = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="cyl-mirror"]')!;
    if (this.selectedCyl === null || this.cylinders === null) {
      sel.textContent = '未选中圆柱体 · 在视图中点选一段';
      sliders.hidden = true;
      offBox.hidden = true;
      mirBtn.disabled = true;
      mirBtn.title = '先在正/侧视图里点选一段包裹器，才能镜像到对侧';
      return;
    }
    const cyl = this.cylinders[this.selectedCyl]!;
    const m = mirrorOf(this.selectedCyl);
    sel.innerHTML = `<b>${this.selectedCyl}</b>${m !== null ? ` <span class="bd-mir">↔ ${m}</span>` : ''}` +
      ` · 整段 wrapper` +
      (cyl.manual === true ? ' · <b class="bd-ok">手动</b>' : ' · <span class="bd-dim">自动</span>');
    sliders.hidden = false;
    offBox.hidden = false;
    mirBtn.disabled = m === null;
    // 禁用时必须说清为什么灰 —— 否则用户只会以为面板坏了
    mirBtn.title = m === null
      ? `${this.selectedCyl} 是中轴骨，没有对侧可镜像`
      : `把 ${this.selectedCyl} 的半径镜像给 ${m}（对侧骨会被标记为手动）`;
    const unpin = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="cyl-unpin"]');
    if (unpin !== null) unpin.disabled = cyl.manual !== true;
    for (const seg of ['top', 'medium', 'bottom'] as const) {
      const v = cyl.radii[seg];
      const span = this.rootEl.querySelector<HTMLElement>(`[data-bd="r-${seg}-v"]`);
      if (span !== null) span.textContent = v.toFixed(3);
      for (const key of [`r-${seg}`, `r-${seg}-n`]) {
        const el = this.rootEl.querySelector<HTMLInputElement>(`[data-bd="${key}"]`);
        if (el === null) continue;
        // 别打断正在输入 / 正在拖的那个控件
        if (document.activeElement !== el) el.value = String(v);
      }
    }
    const off = this.getOffset(this.selectedCyl);
    const axs = ['x', 'y', 'z'] as const;
    for (const ax of axs) {
      const i = ax === 'x' ? 0 : ax === 'y' ? 1 : 2;
      const inp = this.rootEl.querySelector<HTMLInputElement>(`[data-bd="o-${ax}"]`)!;
      const span = this.rootEl.querySelector<HTMLElement>(`[data-bd="o-${ax}-v"]`)!;
      // 只在没有键盘焦点时回写输入框，避免打断正在输入的用户
      if (document.activeElement !== inp) inp.value = off[i]!.toFixed(3);
      span.textContent = off[i]!.toFixed(3);
    }
  }

  /** 点选：返回离指针最近、且落在某段线宽容差内的圆柱体子段 */
  private pickCylinder(
    e: PointerEvent, canvas: HTMLCanvasElement, axis: ViewAxis,
  ): { bone: string; seg: CylSegment } | null {
    const rect = canvas.getBoundingClientRect();
    return this.pickCylinderAt(e.clientX - rect.left, e.clientY - rect.top, axis, canvas);
  }

  /**
   * 点选（画布局部坐标版）：`pickCylinder` 与自动化钩子共用同一套判定，
   * 免得「脚本点得到、鼠标点不到」这种对不上的假绿。
   */
  /**
   * 供无头冒烟：某根骨的骨段在指定视图里的**屏幕**两端点。
   *
   * 存在的理由：断言「拖离骨轴 = 改半径」时，必须沿**垂直于骨轴**的方向拖 ——
   * 半径取的是到骨轴的垂距，沿轴方向拖动垂距不变，半径**本来就不该动**。
   * Head 的骨轴在正视里恰好是垂直的，于是「向下拖 60px」是个退化方向，
   * 拿不到任何变化 —— 看起来像「拖动没反应」，其实是断言取错了方向。
   */
  segmentScreen(
    bone: string, axis: ViewAxis, canvas: HTMLCanvasElement,
  ): { a: [number, number]; b: [number, number] } | null {
    const sg = boneSegments(this.positions).find((x) => x.bone === bone);
    if (sg === undefined) return null;
    const cyl = this.cylinders?.[bone];
    const ends = offsetSegmentEndpoints(sg.a, sg.b, cyl?.offset);
    return { a: this.project(ends.a, axis, canvas), b: this.project(ends.b, axis, canvas) };
  }

  pickCylinderAt(
    mx: number, my: number, axis: ViewAxis, canvas: HTMLCanvasElement,
  ): { bone: string; seg: CylSegment } | null {
    if (this.cylinders === null) return null;
    const segs = boneSegments(this.positions);
    const s = this.scale;
    const ox = this.centerX(canvas);
    const h = canvas.clientHeight || 320;
    const oy = h * 0.92;
    const to2d = (p: Vec3): [number, number] => {
      const horiz = axis === 'front' ? p[0] : p[2];
      return [ox + horiz * s, oy - p[1] * s];
    };
    let best: { bone: string; seg: CylSegment } | null = null;
    let bestD = Infinity;
    for (const seg of segs) {
      const cyl = this.cylinders[seg.bone];
      if (cyl === undefined || !cyl.enabled) continue;
      const A = to2d(seg.a);
      const B = to2d(seg.b);
      for (const ss of BindingPanel.subSeg2d(A, B)) {
        const halfW = Math.max(4, cyl.radii[ss.seg] * s) + 4; // 线半宽 + 容差
        const d = BindingPanel.distPointToSeg2d(mx, my, ss.a, ss.b);
        if (d <= halfW && d < bestD) { bestD = d; best = { bone: seg.bone, seg: ss.seg }; }
      }
    }
    return best;
  }

  /**
   * 点到**直线**（不是线段）的距离。
   *
   * 拖半径用的是它：半径 = 指针到骨轴的垂距，靠近骨两端时不该因为「超出线段
   * 范围」而被端点距离撑大（`distPointToSeg2d` 会那样）。
   */
  private static distPointToLine2d(
    px: number, py: number, a: [number, number], b: [number, number],
  ): number {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-9) return Math.hypot(px - a[0], py - a[1]);
    return Math.abs((px - a[0]) * aby - (py - a[1]) * abx) / Math.sqrt(len2);
  }

  private static distPointToSeg2d(
    px: number, py: number, a: [number, number], b: [number, number],
  ): number {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = 0;
    if (len2 > 1e-9) {
      t = ((px - a[0]) * abx + (py - a[1]) * aby) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    return Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby));
  }

  // ─────────────────────────── 绘制 ───────────────────────────

  private refresh(): void {
    const fit = this.currentFit();
    this.updateInfo(fit);
    this.updateExportBadge();
    this.hooks.onChange?.(fit);
    this.scheduleDraw();
  }

  // ─────────────────────────── 产出状态徽标 ───────────────────────────

  /**
   * 当前编辑态指纹：27 关节坐标 + 全部包裹器半径。
   * 只用于「自上次 Bind 后动过没有」的比对，不参与任何算法。
   */
  private editSig(): string | null {
    if (this.modelName === null) return null;
    const parts: string[] = [];
    for (const n of HUMANIK_ORDER) {
      const p = this.positions[n];
      parts.push(p === undefined ? '-' : `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2].toFixed(5)}`);
    }
    if (this.cylinders !== null) {
      for (const n of Object.keys(this.cylinders).sort()) {
        const c = this.cylinders[n]!;
        parts.push(`${n}:${c.radii.top.toFixed(5)}/${c.radii.medium.toFixed(5)}/${c.radii.bottom.toFixed(5)}`);
      }
    }
    return parts.join('|');
  }

  /**
   * 「● 未导出 / ✓ 已绑定」常驻徽标。
   *
   * 为什么要常驻：保存提示只活 2.6 秒就消失，用户切个面板回来就不知道
   * 「我这次编辑到底 Bind 过没有」。徽标把这件事变成一直可见的状态。
   */
  private updateExportBadge(): void {
    const el = this.exportBadgeEl;
    if (el === undefined) return;
    const sig = this.editSig();
    if (sig === null) {
      el.hidden = true;
      el.className = 'bd-badge';
      el.textContent = '';
      el.removeAttribute('title');
      return;
    }
    el.hidden = false;
    const stale = this.boundSig === null || this.boundSig !== sig;
    el.className = stale ? 'bd-badge bd-badge-warn' : 'bd-badge bd-badge-ok';
    el.textContent = stale ? '● 未导出' : '✓ 已绑定';
    el.title = this.boundSig === null
      ? '这个模型还没 Bind 过：骨架摆位与包裹器半径只存在于面板里，Bind Skin 后才会产出绑定结果'
      : stale
        ? '自上次 Bind Skin 起又改过关节或半径，已产出的绑定结果已过期，需要重新 Bind Skin'
        : '当前编辑态与上次 Bind Skin 一致';
  }

  /** 头部「?」：展开 / 收起操作说明（默认收起，别让 10 行帮助常驻占版面） */
  private toggleHelp(): void {
    const open = this.helpTipEl.hidden;
    this.helpTipEl.hidden = !open;
    this.helpBtn.classList.toggle('active', open);
    this.helpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /** rAF 合帧：多次 refresh 合并为一次绘制 */
  private scheduleDraw(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.drawView(this.frontCtx, this.frontCanvas, 'front');
      this.drawView(this.sideCtx, this.sideCanvas, 'side');
    });
  }

  private updateInfo(fit: FitResult): void {
    const v = this.meshVerts;
    const tris = this.meshIndices !== null ? this.meshIndices.length / 3 : 0;
    const verts = v !== null ? v.length / this.vertexFloats : 0;
    const modeTag = this.previewMode === 'T'
      ? ' · <b class="bd-warn">预览 T-pose</b>'
      : this.previewMode === 'A' ? ' · <b class="bd-warn">预览 A-pose</b>'
      : this.previewMode === 'bind' ? ' · <b class="bd-warn">Bind Pose</b>' : '';
    this.statsEl.innerHTML = this.modelName !== null
      ? `${this.modelName} · ${verts} 顶点 / ${tris} 面` +
        (this.unposed ? ' · <b class="bd-ok">已摆正 T-pose</b>' : '') + modeTag
      : '未加载模型';

    if (this.selected === null) {
      this.infoEl.innerHTML = `<div class="bd-dim">选中一个 joint 查看骨长与姿态偏移</div>`;
      return;
    }
    const name = this.selected;
    const parent = HUMANIK_BONES[name]!.parent;
    const L = fit.lengths[name]!;
    const q = fit.poseRotations[name]!;
    const ang = (2 * Math.acos(Math.min(1, Math.abs(q[3])))) * 180 / Math.PI;
    const p = this.positions[name]!;
    const mir = mirrorOf(name);
    this.infoEl.innerHTML = `
      <div class="bd-sel">${name}${mir !== null ? ` <span class="bd-mir">↔ ${mir}</span>` : ''}</div>
      <div class="bd-row"><span>父骨</span><b>${parent ?? '（根）'}</b></div>
      <div class="bd-row"><span>位置 local</span><b>${p[0].toFixed(3)}, ${p[1].toFixed(3)}, ${p[2].toFixed(3)}</b></div>
      <div class="bd-row"><span>骨长 <i>采纳</i></span><b class="bd-ok">${L.toFixed(3)} m</b></div>
      <div class="bd-row"><span>姿态偏移 <i>不入骨架</i></span><b class="bd-warn">${ang.toFixed(1)}°</b></div>`;
  }

  private drawView(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    axis: ViewAxis,
  ): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 320;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const gl = axis === 'front' ? this.frontGl : this.sideGl;
    if (gl !== null) {
      // ── 3D 正交层（在 2D 画布之下）：网格实体 + 包裹器体积 ──
      // ⚠️ 包裹器**两个模式都画**：关节模式也用默认半径画（淡一点），蒙皮模式用
      // 半径表（浓一点）。只在 skin 模式画的话，用户一打开面板（默认 skeleton）
      // 什么都看不到，会以为包裹器没做出来。
      gl.setMesh(this.meshVerts, this.meshIndices);
      // 「隐藏左/右/仅中轴」要**同时**过滤骨架与 Skin Wrapper：3D 层只画可见骨段，
      // 被过滤的 wrapper 把 enabled 置 false（半径保留）让圆柱几何跳过绘制。
      const vis = new Set(this.visibleJoints());
      gl.setSegments(boneSegments(this.positions).filter((x) => vis.has(x.bone)));
      // ⚠️ **两个模式都吃半径表**（不再传 null）。传 null 会让 3D 层回退成
      // 「骨长 ×0.35」的自动半径 —— 手动调的半径在关节模式下就全被盖掉了，
      // 表现正是「拖 joint 包裹器自己变大变小，侧边栏调的却不动」。
      gl.setCylinders(this.filteredCylinders(vis));
      gl.setAlpha(this.editMode === 'skin' ? 0.42 : 0.22);
      // 与 2D 的 project() 对齐：pan 后 originY 不再恒等于 0.92h，故用实时值；
      // panX = (w/2 - originX)/scale —— 前视进相机 target 的 x，侧视进 z，让 3D
      // 包裹器体积跟着 2D 骨架一起平移（否则 3D 层会停在 fit 时的位置）。
      const panX = (w / 2 - this.originX) / this.scale;
      gl.setFit(this.scale, (this.originY - h / 2) / this.scale, panX);
      gl.render();
    } else {
      // 无 WebGPU 时降级：2D 画家算法（无体积感，但功能完整）
      ctx.fillStyle = '#0A0812';
      ctx.fillRect(0, 0, w, h);
      if (this.meshVerts !== null && this.meshIndices !== null) {
        const off = this.ensureMeshCache(axis);
        ctx.drawImage(off, 0, 0, w, h);
      }
    }

    // 中轴线（x=0 对称面 / z=0）
    const axisX = this.centerX(canvas);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(axisX, 0);
    ctx.lineTo(axisX, h);
    ctx.stroke();

    // 骨架 / 包裹器手柄：2D 层永远画在最上面（X-ray 效果，与 3D 实体叠加）
    if (this.editMode === 'skin') this.drawSkin(ctx, canvas, axis);
    else this.drawSkeleton(ctx, canvas, axis);
  }

  private centerX(canvas: HTMLCanvasElement): number {
    // 中轴 = 世界 x=0（正视）/ z=0（侧视）在屏幕上的水平位置 = originX，随 pan 移动
    void canvas;
    return this.originX;
  }

  /** 取（必要则重建）该视图的离屏网格缓存 */
  private ensureMeshCache(axis: ViewAxis): HTMLCanvasElement {
    const canvas = axis === 'front' ? this.frontCanvas : this.sideCanvas;
    const w = canvas.width;
    const h = canvas.height;
    let off = axis === 'front' ? this.cacheFront : this.cacheSide;
    if (off !== null && off.width === w && off.height === h) return off;
    const nOff = document.createElement('canvas');
    nOff.width = w;
    nOff.height = h;
    const octx = nOff.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, canvas.clientWidth || 320, canvas.clientHeight || 320);
    this.drawMeshInto(octx, canvas, axis);
    if (axis === 'front') this.cacheFront = nOff; else this.cacheSide = nOff;
    return nOff;
  }

  /** 正交投影 + 画家算法（按深度远→近排序）填充三角面，法线做简单朗伯明暗 */
  private drawMeshInto(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    axis: ViewAxis,
  ): void {
    const v = this.meshVerts!;
    const idx = this.meshIndices!;
    const VF = this.vertexFloats;
    const s = this.scale;
    const ox = this.centerX(canvas);
    const h = canvas.clientHeight || 320;
    const oy = h * 0.92;

    const px = (i: number): number => (axis === 'front' ? v[i * VF]! : v[i * VF + 2]!) * s + ox;
    const py = (i: number): number => oy - v[i * VF + 1]! * s;
    const pz = (i: number): number => (axis === 'front' ? v[i * VF + 2]! : v[i * VF]!);

    const tris: Tri[] = [];
    const light: Vec3 = [0.45, 0.78, 0.44];
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t]!, i1 = idx[t + 1]!, i2 = idx[t + 2]!;
      const a0 = v[i0 * VF]!, a1 = v[i0 * VF + 1]!, a2 = v[i0 * VF + 2]!;
      const b0 = v[i1 * VF]!, b1 = v[i1 * VF + 1]!, b2 = v[i1 * VF + 2]!;
      const c0 = v[i2 * VF]!, c1 = v[i2 * VF + 1]!, c2 = v[i2 * VF + 2]!;
      const e1x = b0 - a0, e1y = b1 - a1, e1z = b2 - a2;
      const e2x = c0 - a0, e2y = c1 - a1, e2z = c2 - a2;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const lam = Math.abs(nx * light[0] + ny * light[1] + nz * light[2]);
      tris.push({
        i0, i1, i2,
        depth: (pz(i0) + pz(i1) + pz(i2)) / 3,
        shade: 0.18 + 0.62 * lam,
      });
    }
    // 画家算法：深度大的先画
    tris.sort((p, q) => q.depth - p.depth);

    for (const tr of tris) {
      const g = Math.round(tr.shade * 255);
      ctx.fillStyle = `rgb(${Math.round(g * 0.82)},${Math.round(g * 0.86)},${g})`;
      ctx.beginPath();
      ctx.moveTo(px(tr.i0), py(tr.i0));
      ctx.lineTo(px(tr.i1), py(tr.i1));
      ctx.lineTo(px(tr.i2), py(tr.i2));
      ctx.closePath();
      ctx.fill();
    }
  }

  /** 骨架：先画骨连线，再画 joint 图标（选中/左右用不同色）；非当前姿态用参考色。
   *  faint=true 时整体淡显（蒙皮模式下作对照底图用） */
  private drawSkeleton(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    axis: ViewAxis,
    faint = false,
  ): void {
    const pos = this.overlayPositions();
    const visible = new Set(this.visibleJoints());
    const s = this.scale;
    const ox = this.centerX(canvas);
    const h = canvas.clientHeight || 320;
    const oy = h * 0.92;
    const to2d = (p: Vec3): [number, number] => {
      const horiz = axis === 'front' ? p[0] : p[2];
      return [ox + horiz * s, oy - p[1] * s];
    };
    const depth = (p: Vec3): number => (axis === 'front' ? p[2] : p[0]);
    const isRef = this.previewMode !== 'current';
    ctx.globalAlpha = faint ? 0.28 : 1;

    // 骨连线（任一端点被隐藏则跳过该段）
    // tip 单独一批：虚线 + 更淡 —— 它是末端控制节点，视觉上要与真正的骨干区分开
    ctx.lineWidth = 2;
    ctx.strokeStyle = isRef ? 'rgba(155,93,229,0.85)' : 'rgba(120,200,255,0.75)';
    ctx.setLineDash([]);
    ctx.beginPath();
    for (const name of HUMANIK_ORDER) {
      const parent = HUMANIK_BONES[name]!.parent;
      if (parent === null || !visible.has(name) || !visible.has(parent)) continue;
      if (isTipBone(name)) continue;
      const a = to2d(pos[parent]!);
      const b = to2d(pos[name]!);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isRef ? 'rgba(155,93,229,0.5)' : 'rgba(120,200,255,0.40)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const name of HUMANIK_ORDER) {
      const parent = HUMANIK_BONES[name]!.parent;
      if (parent === null || !visible.has(name) || !visible.has(parent)) continue;
      if (!isTipBone(name)) continue;
      const a = to2d(pos[parent]!);
      const b = to2d(pos[name]!);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // joint 图标（按深度排序，近的画在上面）
    const order = [...this.visibleJoints()].sort(
      (p, q) => depth(pos[q]!) - depth(pos[p]!),
    );
    for (const name of order) {
      const [x, y] = to2d(pos[name]!);
      const isSel = !faint && name === this.selected && !isRef;
      const tip = isTipBone(name);
      const side = name.startsWith('Left') ? 'L' : name.startsWith('Right') ? 'R' : 'M';
      const fill = isRef
        ? '#C9A6F0'
        : isSel ? '#FFD166'
        : side === 'L' ? '#6FB7FF' : side === 'R' ? '#FF8FA3' : '#9BE7A8';
      const r = tip ? JOINT_R_PX * 0.62 : isSel ? JOINT_R_PX + 2 : JOINT_R_PX;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (tip && !isSel) {
        // tip 画成空心：一眼看出「这只是个末端控制点，没有包裹体积」
        ctx.fillStyle = 'rgba(10,8,18,0.85)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = fill;
        ctx.stroke();
      } else {
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = isSel ? '#1a1206' : 'rgba(0,0,0,0.55)';
        ctx.stroke();
      }
      if (isSel) {
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = '#FFD166';
        ctx.fillText(name, x + 8, y - 6);
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 蒙皮模式的 2D 层：**只画手柄**（选中高亮 + 骨名标签），圆柱体本体不在这里画。
   *
   * 圆柱体已由 3D 正交层（`BindingView3D`）画成半透明实体——那才是能看出体积与
   * 穿插的形态；这里再叠一层粗描边只会把 3D 实体糊住。拾取判定不变（2D 点到线段
   * 距离，见 `pickCylinder`），所以拖半径、点选分段的手感完全没变。
   *
   * 无 WebGPU 时（`frontGl === null`）退回原来的 2D 粗描边填充，功能不缺。
   */
  private drawSkin(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    axis: ViewAxis,
  ): void {
    const cyls = this.cylinders;
    if (cyls === null) { this.drawSkeleton(ctx, canvas, axis); return; }
    // 骨骼淡显作对照
    this.drawSkeleton(ctx, canvas, axis, true);
    const segs = boneSegments(this.positions);
    const s = this.scale;
    const ox = this.centerX(canvas);
    const h = canvas.clientHeight || 320;
    const oy = h * 0.92;
    const to2d = (p: Vec3): [number, number] => {
      const horiz = axis === 'front' ? p[0] : p[2];
      return [ox + horiz * s, oy - p[1] * s];
    };
    const solid = this.frontGl === null; // true = 没有 3D 层，2D 自己把圆柱体填满
    const vis = new Set(this.visibleJoints()); // 「隐藏左/右/仅中轴」一并过滤 wrapper
    for (const seg of segs) {
      if (!vis.has(seg.bone)) continue; // 被过滤的骨：wrapper 不画（与骨架一致）
      const cyl = cyls[seg.bone];
      if (cyl === undefined || !cyl.enabled) continue;
      const A = to2d(seg.a);
      const B = to2d(seg.b);
      const parts = BindingPanel.subSeg2d(A, B);
      // 选中 = 整根骨（一个 wrapper），top/medium/bottom 不分别选中
      const sel = this.selectedCyl === seg.bone;
      // ⚠️ 有 3D 层时：未选中的整段交给 3D 画，2D 只画「选中整段」的细亮线。
      // 以前这里给选中**子段**画 lineWidth=pxR*2+3（pxR=max(4,r*s)），半径一大
      // 就成视口巨块 → 用户看到的就是「调自己这段半径，整个 object 放大缩小」。
      // 现改为：2D 选中指示是固定 2.5px 的细亮中心线，**绝不随半径放大**。
      if (!solid && !sel) continue;
      if (solid) {
        // 无 GPU：2D 自己把每根圆柱体填满（真实半径，与 3D 同形）
        for (const ss of parts) {
          const r = cyl.radii[ss.seg];
          const pxR = Math.max(4, r * s);
          ctx.lineCap = 'round';
          ctx.strokeStyle = BindingPanel.cylColor(ss.seg);
          ctx.globalAlpha = 0.85;
          ctx.lineWidth = pxR * 2;
          ctx.beginPath();
          ctx.moveTo(ss.a[0], ss.a[1]);
          ctx.lineTo(ss.b[0], ss.b[1]);
          ctx.stroke();
        }
      }
      if (sel) {
        // 选中指示：细亮中心线（固定宽度，不随半径放大，永远不会糊成一片）
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(143,209,79,0.95)';
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(A[0], A[1]);
        ctx.lineTo(B[0], B[1]);
        ctx.stroke();
        // 骨名标签
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = '#FFD166';
        ctx.fillText(seg.bone, A[0] + 8, A[1] - 6);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** 把骨段 A→B 在 2D 上切成 bottom / medium / top 三段 */
  private static subSeg2d(
    A: [number, number], B: [number, number],
  ): Array<{ a: [number, number]; b: [number, number]; seg: CylSegment }> {
    const m1: [number, number] = [A[0] + (B[0] - A[0]) / 3, A[1] + (B[1] - A[1]) / 3];
    const m2: [number, number] = [A[0] + 2 * (B[0] - A[0]) / 3, A[1] + 2 * (B[1] - A[1]) / 3];
    return [
      { a: A, b: m1, seg: 'bottom' },
      { a: m1, b: m2, seg: 'medium' },
      { a: m2, b: B, seg: 'top' },
    ];
  }

  /** 三段颜色：bottom=蓝 / medium=绿 / top=红（与左右着色区分） */
  private static cylColor(seg: CylSegment): string {
    return seg === 'top' ? '#FF8FA3' : seg === 'medium' ? '#9BE7A8' : '#6FB7FF';
  }

  // ─────────────────────────── 对外查询 ───────────────────────────

  getState(): BindingPanelState {
    return {
      loaded: this.meshVerts !== null,
      modelName: this.modelName,
      selected: this.selected,
      positions: JSON.parse(JSON.stringify(this.positions)) as Record<string, [number, number, number]>,
      triangles: this.meshIndices !== null ? this.meshIndices.length / 3 : 0,
      vertices: this.meshVerts !== null ? this.meshVerts.length / this.vertexFloats : 0,
    };
  }

  /**
   * 供导出取用：**当前姿态**的源网格（不是反解后的显示网格）。
   *
   * 导出流程要用它做两件事，都必须在当前姿态上完成：
   *   ① 在当前姿态骨架上算 LBS 权重；② 由它反解出 T-pose 网格。
   * 若误传反解后的网格，① 会按 T 字形算权重 —— A-pose 的手臂权重全错。
   */
  getMesh(): { vertices: Float32Array; indices: Uint32Array; vertexFloats: number } | null {
    if (this.srcVerts === null || this.meshIndices === null) return null;
    return {
      vertices: this.srcVerts,
      indices: this.meshIndices,
      vertexFloats: this.vertexFloats,
    };
  }

  /** 供导出取用：当前 Skin Wrapper（null = 未进入蒙皮模式，导出退回胶囊权重） */
  getCylinders(): SkinCylinderMap | null {
    return this.cylinders;
  }

  /**
   * 导出当前编辑态（骨架摆位 + Skin Wrapper），供「保存绑定」写盘。
   * 深拷贝避免与面板内部引用共享，落盘后 JSON 改动不反向污染编辑态。
   */
  getEditorData(): BindingEditorData {
    return {
      positions: JSON.parse(JSON.stringify(this.positions)) as Record<string, [number, number, number]>,
      cylinders: this.cylinders === null
        ? null
        : (JSON.parse(JSON.stringify(this.cylinders)) as SkinCylinderMap),
      weightMode: this.weightMode,
      savedAt: new Date().toISOString(),
    };
  }

  /**
   * 回填：打开资产时从 `.meta.json` 的 `bindingEditor` 槽位把上次的编辑态灌回来。
   *
   * 只在 key 形状对得上时才接纳，避免和未来模型骨骼集不一致导致错乱：
   *  - positions：逐骨校验是有限数三元组，且本模型确有这跟骨才覆盖；
   *  - cylinders：逐骨校验有 `radii.{top,medium,bottom}` 三个有限数才整体接纳。
   *
   * @param saved 来自磁盘 JSON 的 `bindingEditor` 节点（untrusted → 全程形状校验）
   */
  hydrate(saved: unknown): void {
    if (saved === null || typeof saved !== 'object') return;
    const s = saved as { positions?: unknown; cylinders?: unknown; weightMode?: unknown };

    // 权重算法：只接受两个字面量，其余（老文件缺字段 / 脏数据）保持默认 wrapper
    if (s.weightMode === 'distance' || s.weightMode === 'wrapper') {
      this.weightMode = s.weightMode;
      this.syncWeightModeSelect();
    }

    if (s.positions !== null && typeof s.positions === 'object') {
      const map = s.positions as Record<string, unknown>;
      for (const [bone, p] of Object.entries(map)) {
        if (this.positions[bone] === undefined) continue;
        if (!Array.isArray(p) || p.length !== 3) continue;
        const ok = (p as unknown[]).every((n) => typeof n === 'number' && Number.isFinite(n));
        if (!ok) continue;
        const t = p as [number, number, number];
        this.positions[bone] = [t[0], t[1], t[2]];
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

    this.syncDisplay();
    this.refresh();
  }

  /** 写入结果的短暂回显（成功绿 / 失败橙，2.6s 后清空） */
  setSaveStatus(ok: boolean, msg: string): void {
    if (this.saveStatusEl === undefined) return;
    this.saveStatusEl.textContent = msg;
    this.saveStatusEl.classList.toggle('ok', ok);
    this.saveStatusEl.classList.toggle('err', !ok);
    window.clearTimeout(this.saveStatusTimer);
    this.saveStatusTimer = window.setTimeout(() => {
      this.saveStatusEl.textContent = '';
      this.saveStatusEl.classList.remove('ok', 'err');
    }, 2600);
  }

  /** 供主循环取用：是否要在主 3D 视口绘制包裹器圆柱体 */
  getViewportCylinders(): boolean {
    return this.viewportCylinders;
  }

  /**
   * 供无头冒烟断言：面板正/侧视的 3D 正交层状态。
   * `null` = 无 WebGPU，已降级为纯 2D（不算失败，只是没有体积视图）。
   */
  getView3dStats(): {
    frontMesh: boolean;
    sideMesh: boolean;
    frontCylVerts: number;
    sideCylVerts: number;
    frontCylSum: number;
    sideCylSum: number;
  } | null {
    if (this.frontGl === null || this.sideGl === null) return null;
    return {
      frontMesh: this.frontGl.hasMesh,
      sideMesh: this.sideGl.hasMesh,
      frontCylVerts: this.frontGl.cylinderVertexCount,
      sideCylVerts: this.sideGl.cylinderVertexCount,
      frontCylSum: this.frontGl.cylinderSum,
      sideCylSum: this.sideGl.cylinderSum,
    };
  }

  /** 供调试/冒烟：直接开关 3D 视口包裹器（同步勾选框） */
  setViewportCylinders(v: boolean): void {
    this.viewportCylinders = v;
    const box = this.rootEl.querySelector<HTMLInputElement>('[data-bd="skin-view3d"]');
    if (box !== null) box.checked = v;
    this.hooks.onToggleViewportCylinders?.(v);
  }

  /** 供主循环取用：当前是否处于蒙皮包裹（skin）编辑模式 */
  isSkinMode(): boolean {
    return this.editMode === 'skin';
  }

  /** 供无头冒烟：直接切编辑模式（等价于点顶部「关节 / 蒙皮」按钮） */
  setEditModeForAutomation(mode: 'skeleton' | 'skin'): void {
    this.setEditMode(mode);
  }

  /** 供导出取用：是否镜像皮肤权重 L→R */
  getMirrorWeights(): boolean {
    return this.mirrorWeightsExport;
  }

  /**
   * 供导出取用：本次 Bind Skin 用哪套权重算法。
   * `distance` 时外部**不要**传 cylinders，`runExport` 才会走 `computeLbsWeights`。
   */
  getWeightMode(): WeightMode {
    return this.weightMode;
  }

  /** 载入 `.meta.json` 里存过的权重算法（老文件没有这个键时保持默认 wrapper） */
  setWeightMode(mode: WeightMode): void {
    this.weightMode = mode === 'distance' ? 'distance' : 'wrapper';
    this.syncWeightModeSelect();
    this.refresh();
  }

  /** 供顶部菜单「导出 T-pose GLB」沿用面板里的平滑权重开关 */
  getSmoothWeights(): boolean {
    return this.smoothWeights;
  }

  /** 供 headless 冒烟：模拟把某个 joint 拖到指定 local 坐标 */
  poseJoint(name: string, p: [number, number, number]): void {
    if (HUMANIK_BONES[name] === undefined) return;
    this.positions[name] = p;
    this.refresh();
  }

  select(name: string | null): void {
    this.selected = name !== null && HUMANIK_BONES[name] !== undefined ? name : null;
    this.refresh();
  }

  /** 诊断：某个 joint 到最近网格表面的距离，用来判断"这个骨放对了吗" */
  distanceToMesh(name: string): number {
    const v = this.meshVerts;
    if (v === null) return NaN;
    const p = this.positions[name]!;
    let best = Infinity;
    const n = v.length / this.vertexFloats;
    for (let i = 0; i < n; i++) {
      const o = i * this.vertexFloats;
      const d = Math.hypot(v[o]! - p[0], v[o + 1]! - p[1], v[o + 2]! - p[2]);
      if (d < best) best = d;
    }
    return best;
  }

  /** 诊断：某骨的影响胶囊到网格表面的最小距离 */
  boneSegmentClearance(name: string): number {
    const v = this.meshVerts;
    if (v === null) return NaN;
    const segs = boneSegments(this.positions);
    const seg = segs.find((x) => x.bone === name);
    if (seg === undefined) return NaN;
    const n = v.length / this.vertexFloats;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * this.vertexFloats;
      const d = distToSegment(
        [v[o]!, v[o + 1]!, v[o + 2]!],
        seg.a,
        seg.b,
      );
      if (d < best) best = d;
    }
    return best;
  }

  resize(): void {
    this.computeViewFit();
    this.syncDisplay();
    this.refresh();
  }
}
