/**
 * 绑定面板 Binding Panel —— 正/侧视图里把 22 个 HumanIK joint 拖到模型实际解剖位置上。
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

import {
  HUMANIK_BONES,
  HUMANIK_ORDER,
  MIRROR_PAIRS,
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

/** 正视图：投影 (x, y)，深度 = z；侧视图：投影 (z, y)，深度 = x */
type ViewAxis = 'front' | 'side';
/** 姿态预览模式：当前编辑 / 标准 T / 标准 A / 冻结的 Bind Pose（用于绑定的带 offset 姿态） */
type PreviewMode = 'current' | 'T' | 'A' | 'bind';
/** 骨骼显示过滤 */
type SideFilter = 'all' | 'mid' | 'hideL' | 'hideR';

const JOINT_HIT_PX = 9;
const JOINT_R_PX = 4.5;
/** 方向键微调步长（米）：普通 2cm，Shift 精调 5mm */
const NUDGE_STEP = 0.02;
const NUDGE_STEP_FINE = 0.005;

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

  private frontCanvas!: HTMLCanvasElement;
  private sideCanvas!: HTMLCanvasElement;
  private frontCtx!: CanvasRenderingContext2D;
  private sideCtx!: CanvasRenderingContext2D;
  private infoEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private animEl!: HTMLElement;
  private bvhBtn!: HTMLButtonElement;
  private exportAnimBtn!: HTMLButtonElement;
  private bindPoseBtn!: HTMLButtonElement;

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

  constructor(rootEl: HTMLElement, hooks: BindingPanelHooks) {
    this.rootEl = rootEl;
    this.hooks = hooks;
    this.buildDom();
  }

  // ─────────────────────────── DOM 构建 ───────────────────────────

  private buildDom(): void {
    this.rootEl.innerHTML = `
      <div class="bd-grip" data-bd="grip" title="拖拽下压面板，露出上方 3D 视图对照"></div>
      <div class="bd-head">
        <span class="bd-title">绑定<em>Binding</em></span>
        <span class="bd-model" data-bd="stats">未加载模型</span>
        <span class="bd-spacer"></span>
        <button class="bd-btn" data-bd="mirror-lr" title="把左侧关节镜像到右侧（x 取反）">镜像 L→R</button>
        <button class="bd-btn" data-bd="mirror-rl" title="把右侧关节镜像到左侧（x 取反）">镜像 R→L</button>
        <button class="bd-btn" data-bd="reset" title="回到模板 T-pose 的初始摆放（会清空编辑，有确认）">重置</button>
        <button class="bd-btn accent" data-bd="apply" title="用当前编辑姿态（带 offset）做绑定并导出；同时把此姿态冻结记录为 Bind Pose">Bind Skin</button>
        <button class="bd-btn" data-bd="detach" title="移除已应用的皮肤结果，但保留 Bind Pose 与关节编辑">Detach Skin</button>
        <button class="bd-btn" data-bd="bvh" title="载入一份 BVH 动捕，重定向到当前 T-pose 骨架">载入 BVH…</button>
        <button class="bd-btn" data-bd="export-anim" title="把 T-pose 网格 + 骨骼 + 已重定向的动画一起导出 GLB" disabled>导出动画 GLB</button>
        <button class="bd-btn" data-bd="close" title="关闭绑定面板">✕</button>
      </div>
      <div class="bd-body">
        <div class="bd-view">
          <div class="bd-vlabel">正视 Front · (x, y)</div>
          <canvas class="bd-canvas" data-bd="front" tabindex="0"></canvas>
        </div>
        <div class="bd-view">
          <div class="bd-vlabel">侧视 Side · (z, y)</div>
          <canvas class="bd-canvas" data-bd="side" tabindex="0"></canvas>
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
          <div class="bd-field">
            <label>骨骼显示</label>
            <select class="bd-select" data-bd="sidefilter">
              <option value="all">全部</option>
              <option value="mid">仅中轴</option>
              <option value="hideL">隐藏左侧</option>
              <option value="hideR">隐藏右侧</option>
            </select>
          </div>
          <label class="bd-check"><input type="checkbox" data-bd="smooth" checked> 优化皮肤权重（apply 时平滑）</label>
          <div class="bd-legend">
            <div class="bd-legend-row"><i class="bd-dot bd-dot-mid"></i>中轴骨</div>
            <div class="bd-legend-row"><i class="bd-dot bd-dot-left"></i>左侧 L</div>
            <div class="bd-legend-row"><i class="bd-dot bd-dot-right"></i>右侧 R</div>
          </div>
          <div class="bd-tip">
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
        </div>
      </div>`;

    this.frontCanvas = this.rootEl.querySelector<HTMLCanvasElement>('[data-bd="front"]')!;
    this.sideCanvas = this.rootEl.querySelector<HTMLCanvasElement>('[data-bd="side"]')!;
    this.frontCtx = this.frontCanvas.getContext('2d')!;
    this.sideCtx = this.sideCanvas.getContext('2d')!;
    this.infoEl = this.rootEl.querySelector<HTMLElement>('[data-bd="info"]')!;
    this.statsEl = this.rootEl.querySelector<HTMLElement>('[data-bd="stats"]')!;
    this.animEl = this.rootEl.querySelector<HTMLElement>('[data-bd="anim"]')!;
    this.bvhBtn = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="bvh"]')!;
    this.exportAnimBtn = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="export-anim"]')!;
    this.bindPoseBtn = this.rootEl.querySelector<HTMLButtonElement>('[data-bd="pov-bind"]')!;

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

    // 权重平滑开关
    const smooth = this.rootEl.querySelector<HTMLInputElement>('[data-bd="smooth"]')!;
    smooth.addEventListener('change', () => { this.smoothWeights = smooth.checked; });

    this.bindCanvas(this.frontCanvas, 'front');
    this.bindCanvas(this.sideCanvas, 'side');
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
    this.bindPoseBtn.disabled = true;
    this.setAnimationInfo(null);
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
    this.bindPoseBtn.disabled = true;
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

  // ─────────────────────────── 交互 ───────────────────────────

  private bindCanvas(canvas: HTMLCanvasElement, axis: ViewAxis): void {
    let dragging: string | null = null;

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
      if (dragging === null) return;
      dragging = null;
      this.dragStart = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // 方向键微调（Shift 精调 5mm）；仅当前姿态可编辑
    canvas.addEventListener('keydown', (e) => {
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
  }

  /** 三维 → 二维。正视 (x, -y)；侧视 (z, -y)。画布 y 轴朝下，故 y 取反。 */
  private project(
    p: Vec3,
    axis: ViewAxis,
    canvas: HTMLCanvasElement,
  ): [number, number] {
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 320;
    const ox = w / 2 + (this.originX - (this.frontCanvas.clientWidth || 320) / 2);
    const oy = h * 0.92;
    const horiz = axis === 'front' ? p[0] : p[2];
    return [ox + horiz * this.scale, oy - p[1] * this.scale];
  }

  /** 镜像：左右对称面 x=0，故 x 取反且互换左右骨名 */
  private mirror(dir: 'L2R' | 'R2L'): void {
    for (const [l, r] of MIRROR_PAIRS) {
      const src = dir === 'L2R' ? l : r;
      const dst = dir === 'L2R' ? r : l;
      const s = this.positions[src]!;
      this.positions[dst] = [-s[0], s[1], s[2]];
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
    this.unposed = false;
    this.tposeMesh = null;
    this.previewMode = 'current';
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

  // ─────────────────────────── 绘制 ───────────────────────────

  private refresh(): void {
    const fit = this.currentFit();
    this.updateInfo(fit);
    this.hooks.onChange?.(fit);
    this.scheduleDraw();
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

    // 背景 + 中轴线（x=0 对称面 / z=0）
    ctx.fillStyle = '#0A0812';
    ctx.fillRect(0, 0, w, h);
    const axisX = this.centerX(canvas);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(axisX, 0);
    ctx.lineTo(axisX, h);
    ctx.stroke();

    // 网格：blit 离屏缓存（仅模型/姿态/缩放变化时重建），避免每帧重画全三角面
    if (this.meshVerts !== null && this.meshIndices !== null) {
      const off = this.ensureMeshCache(axis);
      ctx.drawImage(off, 0, 0, w, h);
    }
    this.drawSkeleton(ctx, canvas, axis);
  }

  private centerX(canvas: HTMLCanvasElement): number {
    const w = canvas.clientWidth || 320;
    return w / 2 + (this.originX - (this.frontCanvas.clientWidth || 320) / 2);
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

  /** 骨架：先画骨连线，再画 joint 图标（选中/左右用不同色）；非当前姿态用参考色 */
  private drawSkeleton(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    axis: ViewAxis,
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

    // 骨连线（任一端点被隐藏则跳过该段）
    ctx.lineWidth = 2;
    ctx.strokeStyle = isRef ? 'rgba(155,93,229,0.85)' : 'rgba(120,200,255,0.75)';
    ctx.beginPath();
    for (const name of HUMANIK_ORDER) {
      const parent = HUMANIK_BONES[name]!.parent;
      if (parent === null || !visible.has(name) || !visible.has(parent)) continue;
      const a = to2d(pos[parent]!);
      const b = to2d(pos[name]!);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();

    // joint 图标（按深度排序，近的画在上面）
    const order = [...this.visibleJoints()].sort(
      (p, q) => depth(pos[q]!) - depth(pos[p]!),
    );
    for (const name of order) {
      const [x, y] = to2d(pos[name]!);
      const isSel = name === this.selected && !isRef;
      const side = name.startsWith('Left') ? 'L' : name.startsWith('Right') ? 'R' : 'M';
      const fill = isRef
        ? '#C9A6F0'
        : isSel ? '#FFD166'
        : side === 'L' ? '#6FB7FF' : side === 'R' ? '#FF8FA3' : '#9BE7A8';
      ctx.beginPath();
      ctx.arc(x, y, isSel ? JOINT_R_PX + 2 : JOINT_R_PX, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isSel ? '#1a1206' : 'rgba(0,0,0,0.55)';
      ctx.stroke();
      if (isSel) {
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = '#FFD166';
        ctx.fillText(name, x + 8, y - 6);
      }
    }
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
