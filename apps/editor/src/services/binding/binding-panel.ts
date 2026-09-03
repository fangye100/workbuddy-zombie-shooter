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
 */

import {
  HUMANIK_BONES,
  HUMANIK_ORDER,
  MIRROR_PAIRS,
  mirrorOf,
  tposeWorldPositions,
  type Vec3,
} from './humanik-template';
import { boneSegments, distToSegment, fitSkeleton, type FitResult } from './binding-math';

/** 正视图：投影 (x, y)，深度 = z；侧视图：投影 (z, y)，深度 = x */
type ViewAxis = 'front' | 'side';

const JOINT_HIT_PX = 9;
const JOINT_R_PX = 4.5;

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
   * 点「应用 T-pose」：外部在这里做 re-gen —— 算权重 → 反解网格 → 导出 GLB。
   * 面板只负责把拟合结果交出去，不关心导出细节（导出在 binding-export.ts）。
   */
  onApply?(fit: FitResult): void;
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

  /**
   * 模型顶点（stride 15：pos3 / normal3 / smoothNormal3 / uv2 / color4）
   *
   * ⚠️ 两套指针，别合并：
   *  - `srcVerts` = 载入时的**当前姿态**网格，**永不被反解覆盖**。导出永远基于它 ——
   *    LBS 权重必须在当前姿态上算，若拿反解后的 T-pose 网格去算，A-pose 手臂权重全错。
   *  - `meshVerts` = 当前**显示**用的网格，可能是 srcVerts，也可能是反解后的 T-pose 网格。
   */
  private srcVerts: Float32Array | null = null;
  private meshVerts: Float32Array | null = null;
  private meshIndices: Uint32Array | null = null;
  private vertexFloats = 15;
  private modelName: string | null = null;
  /** 当前显示的网格是否已是反解后的 T-pose 网格 */
  private unposed = false;

  /** 关节坐标：local 空间，可拖拽修改 */
  private positions: Record<string, [number, number, number]> = tposeWorldPositions();
  private selected: string | null = null;

  /** 视图缩放：米 → 像素，由模型包围盒自动定 */
  private scale = 200;
  private originX = 0;
  private originY = 0;

  private fitCache: FitResult | null = null;

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
        <button class="bd-btn" data-bd="reset" title="回到模板 T-pose 的初始摆放">重置</button>
        <button class="bd-btn accent" data-bd="apply" title="用拟合出的骨长重建 T-pose 并导出">应用 T-pose</button>
        <button class="bd-btn" data-bd="bvh" title="载入一份 BVH 动捕，重定向到当前 T-pose 骨架">载入 BVH…</button>
        <button class="bd-btn" data-bd="export-anim" title="把 T-pose 网格 + 骨骼 + 已重定向的动画一起导出 GLB" disabled>导出动画 GLB</button>
        <button class="bd-btn" data-bd="close" title="关闭绑定面板">✕</button>
      </div>
      <div class="bd-body">
        <div class="bd-view">
          <div class="bd-vlabel">正视 Front · (x, y)</div>
          <canvas class="bd-canvas" data-bd="front"></canvas>
        </div>
        <div class="bd-view">
          <div class="bd-vlabel">侧视 Side · (z, y)</div>
          <canvas class="bd-canvas" data-bd="side"></canvas>
        </div>
        <div class="bd-side">
          <div class="bd-info" data-bd="info">选中一个 joint 查看骨长与姿态偏移</div>
          <div class="bd-anim" data-bd="anim">未载入动画</div>
          <div class="bd-legend">
            <div class="bd-legend-row"><i class="bd-dot bd-dot-mid"></i>中轴骨</div>
            <div class="bd-legend-row"><i class="bd-dot bd-dot-left"></i>左侧 L</div>
            <div class="bd-legend-row"><i class="bd-dot bd-dot-right"></i>右侧 R</div>
          </div>
          <div class="bd-tip">
            拖拽 joint 对齐模型解剖位置。<br>
            正视改 <b>x/y</b>，侧视改 <b>z/y</b>。<br>
            <b>骨长</b>会被采纳进 T-pose；<br>
            <b>方向偏移</b>只是当前姿态与 T-pose 的差，<br>
            不会进骨架。
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

    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="close"]')!
      .addEventListener('click', () => this.hooks.onClose());
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="reset"]')!
      .addEventListener('click', () => {
        this.positions = tposeWorldPositions();
        this.refresh();
      });
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mirror-lr"]')!
      .addEventListener('click', () => { this.mirror('L2R'); });
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="mirror-rl"]')!
      .addEventListener('click', () => { this.mirror('R2L'); });
    this.rootEl.querySelector<HTMLButtonElement>('[data-bd="apply"]')!
      .addEventListener('click', () => this.applyTPose());
    this.bvhBtn.addEventListener('click', () => this.hooks.onLoadBvh?.());
    this.exportAnimBtn.addEventListener('click', () => this.hooks.onExportAnim?.());

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
    this.setAnimationInfo(null);
    this.computeViewFit();
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
    this.positions = tposeWorldPositions();
    this.selected = null;
    this.setAnimationInfo(null);
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

  // ─────────────────────────── 交互 ───────────────────────────

  private bindCanvas(canvas: HTMLCanvasElement, axis: ViewAxis): void {
    let dragging: string | null = null;

    const pick = (e: PointerEvent): string | null => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      let best: string | null = null;
      let bestD = JOINT_HIT_PX;
      for (const name of HUMANIK_ORDER) {
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
      if (axis === 'front') {
        const x = (mx - this.originX) / this.scale;
        this.positions[dragging] = [x, y, p[2]];
      } else {
        const z = (mx - this.originX) / this.scale;
        this.positions[dragging] = [p[0], y, z];
      }
      this.refresh();
    });

    const end = (e: PointerEvent): void => {
      if (dragging === null) return;
      dragging = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
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

  /**
   * 应用 T-pose：**先**把当前姿态的 fit 交出去做 re-gen，**后**复位关节显示。
   *
   * 顺序不能反 —— 外部要在「当前姿态骨架 + 当前姿态网格」上算 LBS 权重，
   * 一旦先复位成 T-pose 再导出，权重就按 T 字形算了，A-pose 模型的手臂权重全错。
   */
  private applyTPose(): void {
    const fit = this.currentFit();
    this.hooks.onApply?.(fit);
    // 复位：把关节坐标同步成 T-pose（ΔR 清零），用户立刻看到结果
    for (const name of HUMANIK_ORDER) {
      this.positions[name] = [
        fit.tposePositions[name]![0],
        fit.tposePositions[name]![1],
        fit.tposePositions[name]![2],
      ];
    }
    this.refresh();
  }

  /**
   * 反解结果回灌：把 re-gen 出来的 T-pose 网格换进来显示。
   * 网格摆正了 + 骨架也摆正了，两者重合即证明反解成立（一眼可验证）。
   */
  showTPoseResult(fit: FitResult, verts: Float32Array): void {
    this.meshVerts = verts;
    this.unposed = true;
    for (const name of HUMANIK_ORDER) {
      this.positions[name] = [
        fit.tposePositions[name]![0],
        fit.tposePositions[name]![1],
        fit.tposePositions[name]![2],
      ];
    }
    this.refresh();
  }

  currentFit(): FitResult {
    // 22 骨规模极小，每次重算无性能压力，不做缓存失效判断
    this.fitCache = fitSkeleton(this.positions);
    return this.fitCache;
  }

  // ─────────────────────────── 绘制 ───────────────────────────

  private refresh(): void {
    const fit = this.currentFit();
    this.drawView(this.frontCtx, this.frontCanvas, 'front');
    this.drawView(this.sideCtx, this.sideCanvas, 'side');
    this.updateInfo(fit);
    this.hooks.onChange?.(fit);
  }

  private updateInfo(fit: FitResult): void {
    const v = this.meshVerts;
    const tris = this.meshIndices !== null ? this.meshIndices.length / 3 : 0;
    const verts = v !== null ? v.length / this.vertexFloats : 0;
    this.statsEl.innerHTML = this.modelName !== null
      ? `${this.modelName} · ${verts} 顶点 / ${tris} 面` +
        (this.unposed ? ' · <b class="bd-ok">已摆正 T-pose</b>' : '')
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

    if (this.meshVerts !== null && this.meshIndices !== null) {
      this.drawMesh(ctx, canvas, axis);
    }
    this.drawSkeleton(ctx, canvas, axis);
  }

  private centerX(canvas: HTMLCanvasElement): number {
    const w = canvas.clientWidth || 320;
    return w / 2 + (this.originX - (this.frontCanvas.clientWidth || 320) / 2);
  }

  /** 正交投影 + 画家算法（按深度远→近排序）填充三角面，法线做简单朗伯明暗 */
  private drawMesh(
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

  /** 骨架：先画骨连线，再画 joint 图标（选中/左右用不同色） */
  private drawSkeleton(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    axis: ViewAxis,
  ): void {
    const s = this.scale;
    const ox = this.centerX(canvas);
    const h = canvas.clientHeight || 320;
    const oy = h * 0.92;
    const to2d = (p: Vec3): [number, number] => {
      const horiz = axis === 'front' ? p[0] : p[2];
      return [ox + horiz * s, oy - p[1] * s];
    };
    const depth = (p: Vec3): number => (axis === 'front' ? p[2] : p[0]);

    // 骨连线
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.75)';
    ctx.beginPath();
    for (const name of HUMANIK_ORDER) {
      const parent = HUMANIK_BONES[name]!.parent;
      if (parent === null) continue;
      const a = to2d(this.positions[parent]!);
      const b = to2d(this.positions[name]!);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();

    // joint 图标（按深度排序，近的画在上面）
    const order = [...HUMANIK_ORDER].sort(
      (p, q) => depth(this.positions[q]!) - depth(this.positions[p]!),
    );
    for (const name of order) {
      const [x, y] = to2d(this.positions[name]!);
      const isSel = name === this.selected;
      const side = name.startsWith('Left') ? 'L' : name.startsWith('Right') ? 'R' : 'M';
      const fill = isSel
        ? '#FFD166'
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
    this.refresh();
  }
}
