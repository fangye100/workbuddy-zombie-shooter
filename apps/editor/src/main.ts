import { GpuUnavailableError, initGpu, type GpuContext } from '@aether/gfx';
import { LabRenderer, type CameraState, type SceneObject } from './renderer';
import { Panel } from './ui';
import * as m4 from '@aether/core';
import { axisPlaneNormal, rotatePlaneBasis, angleInPlane, wrapAngle } from './gizmo';
import { DEBUG_OPTIONS, type LabParams } from './params';
import { BUILTIN_MODELS, MODEL_RULER_HEIGHT_M } from './models';
import { parseGlb } from '@aether/scene';
import type { GltfResult } from '@aether/scene';
import { AssetBrowser } from './asset-browser';
import { AssetInspector } from './asset-inspector';
import { AssetPreview } from './services/asset-preview';
import { BindingPanel } from './services/binding/binding-panel';
import { rigToTPoseWithImage, downloadBlob } from './services/binding/binding-export';
import type { BindAnimationInput, BindExportStats } from './services/binding/binding-export';
import type { FitResult, JointPositions } from './services/binding/binding-math';
import { ASSET_MIME, stemName, type AssetSelection } from './asset-util';
import { makeSplitter, restoreCssVar } from './splitter';
import { summarizeMatch, createSkinState, selectClip, play } from '@aether/render';
import { parseBvh } from './services/binding/bvh-parser';
import {
  retargetBvh,
  retargetSummary,
  clipToAnimClip,
  skeletonRestWorldPositions,
  type RetargetClip,
  type RetargetOptions,
  type RetargetReport,
} from './services/binding/retarget';

/**
 * Game Editor 入口（原 Shader Lab）。
 *
 * 相机默认 55° 俯角 —— 项目里 god view 就是 55°，所有灯光参数都该在这个角度下调。
 * 相机操作（鼠标与触屏同一套 Pointer Events，canvas 已 touch-action:none）：
 *   环绕 rotate：左键拖 / 单指拖
 *   平移 pan：  右键或中键拖、Shift+左键拖 / 双指拖（质心）
 *   缩放 zoom：滚轮 / 双指捏合
 *   拾取：      左键或单指轻点（位移 < 6px 判定为点击）
 */

const canvas = document.getElementById('gpu') as HTMLCanvasElement | null;
const groups = document.getElementById('groups');
const hud = document.getElementById('hud');
const fatal = document.getElementById('fatal');
const fatalTitle = document.getElementById('fatal-title');
const fatalBody = document.getElementById('fatal-body');

function showFatal(title: string, bodyHtml: string): void {
  if (fatal === null || fatalTitle === null || fatalBody === null) return;
  fatalTitle.textContent = title;
  fatalBody.innerHTML = bodyHtml;
  fatal.style.display = 'flex';
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function dpr(): number {
  return Math.min(2, window.devicePixelRatio || 1);
}

async function tryInitGpu(target: HTMLCanvasElement): Promise<GpuContext | null> {
  try {
    return await initGpu(target);
  } catch (err) {
    if (err instanceof GpuUnavailableError) {
      showFatal(err.message, `<p>${err.detail}</p>`);
    } else {
      showFatal('WebGPU 初始化失败', `<p>${String(err)}</p>`);
    }
    return null;
  }
}

/** 面向相机的竖直面上的 NdotL —— god view 下这是角色最常露给玩家的那一面 */
function frontNdotL(p: LabParams, camera: CameraState): number {
  const az = (p.keyAzimuth * Math.PI) / 180;
  const el = (p.keyElevation * Math.PI) / 180;
  const lx = Math.sin(az) * Math.cos(el);
  const lz = Math.cos(az) * Math.cos(el);
  // 相机位于 target + (sin yaw, ·, cos yaw) * r，所以朝相机的面法线就是这个方向
  return Math.max(0, Math.sin(camera.yaw) * lx + Math.cos(camera.yaw) * lz);
}

async function boot(): Promise<void> {
  if (canvas === null || groups === null || hud === null) {
    showFatal('页面结构异常', '缺少 #gpu / #groups / #hud 节点。');
    return;
  }

  const gpu = await tryInitGpu(canvas);
  if (gpu === null) return;

  // 只展示第一个错误：后续每一帧都会因同一个原因报错，级联信息会把真正的源头冲掉
  let fatalShown = false;
  gpu.device.onuncapturederror = (event) => {
    console.error(`[WebGPU] ${event.error.message}`);
    if (fatalShown) return;
    fatalShown = true;
    showFatal(
      '渲染管线错误',
      `<p>${event.error.message}</p><p>通常是 WGSL 编译失败或 bind group 布局不匹配，完整日志见控制台。</p>`,
    );
  };

  let renderer: LabRenderer;
  try {
    renderer = new LabRenderer(gpu, canvas);
  } catch (err) {
    showFatal('渲染器创建失败', `<p>${String(err)}</p>`);
    return;
  }

  const inspPanes = {
    inspector: document.querySelector<HTMLElement>('#inspector .insp-pane[data-pane="inspector"]')!,
    scene: document.querySelector<HTMLElement>('#inspector .insp-pane[data-pane="scene"]')!,
    render: document.querySelector<HTMLElement>('#inspector .insp-pane[data-pane="render"]')!,
  };
  const panel = new Panel(groups, inspPanes, renderer);
  // 材质 API 要按 id 回查共享材质（params.materials），先把引用挂上
  renderer.attachParams(panel.params);

  /** 右侧 Inspector Tab 切换：选中场景物体→检视，选中资产→资产 */
  const switchInspectorTab = (tab: 'inspector' | 'scene' | 'render' | 'asset'): void => {
    for (const t of document.querySelectorAll<HTMLElement>('#inspector .insp-tab')) {
      t.classList.toggle('active', t.dataset.tab === tab);
    }
    for (const p of document.querySelectorAll<HTMLElement>('#inspector .insp-pane')) {
      p.classList.toggle('active', p.dataset.pane === tab);
    }
  };
  // 标签页本身可点击切换：让「场景/光照」「渲染」页可达（默认只随选中物体/资产自动切）。
  for (const t of document.querySelectorAll<HTMLButtonElement>('#inspector .insp-tab')) {
    t.addEventListener('click', () => {
      const tab = t.dataset.tab;
      if (tab === 'inspector' || tab === 'scene' || tab === 'render' || tab === 'asset') {
        switchInspectorTab(tab);
      }
    });
  }
  let hudDirty = true;
  panel.onChange = () => {
    hudDirty = true;
  };

  // ---- 模型浏览器 ----
  /**
   * 贴图解码。两个要点：
   *   - colorSpaceConversion:'none'：着色器把 albedo 当 raw sRGB 自己转 linear（见 renderer 注释），
   *     让浏览器再做一次色彩管理会把混元偏暗的 baseColor 压得更暗。
   *   - 超大贴图降采样：4096² 原图解码后 67MB，编辑器预览没必要吃满显存，按长边缩到 2048。
   */
  const MAX_TEX_SIZE = 2048;
  async function decodeTexture(blob: Blob, label: string): Promise<ImageBitmap | null> {
    try {
      const raw = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      const long = Math.max(raw.width, raw.height);
      if (long <= MAX_TEX_SIZE) return raw;
      const k = MAX_TEX_SIZE / long;
      const w = Math.max(1, Math.round(raw.width * k));
      const h = Math.max(1, Math.round(raw.height * k));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (ctx === null) return raw; // 没有 2D 上下文就原样用，不为了省显存牺牲可用性
      ctx.drawImage(raw, 0, 0, w, h);
      raw.close();
      return canvas.transferToImageBitmap();
    } catch (err) {
      console.warn(`[模型] 贴图解码失败: ${label}`, err);
      return null;
    }
  }

  async function loadBitmap(url: string): Promise<ImageBitmap | null> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      return await decodeTexture(await resp.blob(), url);
    } catch (err) {
      console.warn(`[模型] 贴图加载失败: ${url}`, err);
      return null;
    }
  }

  function applyBuiltin(id: string): void {
    const bm = BUILTIN_MODELS.find((b) => b.id === id);
    if (bm === undefined) return;
    void loadBitmap(bm.texUrl).then((bmp) => {
      renderer.setCharacter(bm.mesh, bmp, null);
      panel.setModelInfo(
        `${bm.label} · ${bm.meta.vertices} 顶点 / ${bm.meta.triangles} 面 / ` +
          `${bm.meta.heightMeters} m / 贴图${bmp !== null ? '已载入' : '缺失（平色预览）'}`,
      );
      panel.refreshHierarchy(); // 角色槽位的面数变了
      panel.setSelection(renderer.getSelected(), renderer.getSelectedSub());
      hudDirty = true;
    });
  }

  panel.onModelSelect = (id) => {
    if (id === null) {
      renderer.setCharacter(null, null);
      panel.setModelInfo('程序化胶囊 · 材质在「材质」面板调');
      hudDirty = true;
      return;
    }
    applyBuiltin(id);
  };

  // ---- 场景层级 Hierarchy ----
  // 点到 mesh 子节点时连子网格一起选中：材质面板的作用对象就是它，描边也只描那一段
  panel.onHierarchySelect = (index, subIndex) => {
    renderer.selectObject(index, subIndex);
    panel.setSelection(index, subIndex);
    switchInspectorTab('inspector');
    hudDirty = true;
  };
  panel.onHierarchyToggle = (index, visible) => {
    renderer.setObjectVisible(index, visible);
    panel.setSelection(renderer.getSelected(), renderer.getSelectedSub()); // 隐藏被选中的物体时同步清掉选中面板
    hudDirty = true;
  };
  panel.onSubMeshToggle = (index, subIndex, visible) => {
    renderer.setSubMeshVisible(index, subIndex, visible);
    // 隐藏的正好是当前材质面板的目标时，渲染器已把选中退回物体层，这里同步面板
    panel.setSelection(renderer.getSelected(), renderer.getSelectedSub());
    hudDirty = true;
  };
  panel.onHierarchyDelete = (index) => {
    renderer.removeObject(index);
    panel.setSelection(renderer.getSelected(), renderer.getSelectedSub());
    panel.refreshHierarchy();
    hudDirty = true;
  };
  // 悬停只改渲染器的索引（复用已有 outline 管线多 1 个 draw call），不重建 UI、不遍历场景
  panel.onHierarchyHover = (index, subIndex) => {
    renderer.setHovered(index, subIndex);
    hudDirty = true;
  };
  // 双击层级行 = 选中 + 相机聚焦过去
  panel.onHierarchyFocus = (index) => {
    renderer.selectObject(index, null);
    panel.setSelection(index, null);
    focusOn(index);
    hudDirty = true;
  };

  panel.onModelFile = (buffer, name) => {
    try {
      // 身高用与内置 LOD 同一把尺子（roster 真源），保证导入档与内置档体型一致
      const model = parseGlb(buffer, MODEL_RULER_HEIGHT_M);
      void (async () => {
        const bmp = model.image === null ? null : await decodeTexture(model.image, name);
        // subMeshes：GLB 的每个 primitive 拆成一条子网格 → 层级树里可展开、各自一个材质槽；
        // nodeTree：GLB 原始父子层级，层级面板按它还原树形（不再平铺）
        renderer.setCharacter(model.mesh, bmp, model.subMeshes, model.nodeTree, model.skeleton, model.animations);
        const texState =
          model.image === null
            ? '无贴图（平色预览）'
            : bmp !== null
              ? '贴图已载入'
              : '⚠ 贴图解码失败（见控制台）';
        // 换模型时旧材质绑定按「nodeId → 反向路径」两层匹配继承，结果一并告知
        const inheritNote = summarizeMatch(renderer.getLastMatchReport() ?? []);
        panel.setModelInfo(
          `${name} · ${model.vertices} 顶点 / ${model.triangles} 面 / ` +
            `${model.heightMeters.toFixed(2)} m / ${texState}` +
            (inheritNote === null ? '' : ` · ${inheritNote}`),
        );
        panel.refreshHierarchy(); // 导入模型替换了角色槽位，面数与子网格都变了
        // 选中可能落在旧的（现已不存在的）子网格上，重挂一次
        panel.setSelection(renderer.getSelected(), renderer.getSelectedSub());
        hudDirty = true;
      })();
    } catch (err) {
      panel.setModelInfo(`导入失败：${String(err)}`);
      console.error('[模型] GLB 导入失败', err);
    }
  };

  // 不再默认加载任何内置模型：E-04 内置档（LOD 中间产物）已全部移除，
  // 启动即为程序化胶囊，角色一律通过「导入 GLB…」载入原始模型（唯一真源）。
  panel.setModelInfo('未载入模型 · 用「导入 GLB…」载入原始 .glb');

  // 默认取景：target 落在角色身上才能居中构图，而不是看向角色前方的空地
  const DEFAULT_VIEW = { yaw: 0.35, distance: 9, target: [0, 0.95, 0] as [number, number, number] };
  const camera: CameraState = {
    yaw: DEFAULT_VIEW.yaw,
    distance: DEFAULT_VIEW.distance,
    target: [...DEFAULT_VIEW.target],
  };

  // 调试/自动化钩子：控制台与无头 CDP 验证直接读写相机/材质状态（都是引用，读到即实时值）
  (window as unknown as { __editor: unknown }).__editor = {
    camera,
    elevation: () => panel.params.cameraElevation,
    params: panel.params,
    renderer,
  };

  // ---- 相机交互：环绕 / 平移 / 缩放 + 拾取 ----
  // 鼠标与触屏统一走 Pointer Events：单指=环绕，双指=捏合缩放+质心平移，
  // 右键/中键/Shift+左键=平移，滚轮=缩放，轻点（位移<阈值）=拾取。
  const CLICK_THRESHOLD = 6; // 像素：低于此位移视为「点击」而非「拖拽」
  const ORBIT_RAD_PER_PX = 0.006; // 环绕灵敏度：每像素多少弧度
  const PITCH_DEG_PER_PX = 0.25; // 俯仰灵敏度：每像素多少度
  const PITCH_LIMIT_DEG = 89; // 俯仰上限（留 1° 避免 lookAt 的 up 与视线平行退化）
  const PAN_LIMIT_XZ = 20; // 平移边界：target 的 X/Z 活动范围（米）
  const PAN_MIN_Y = 0.05; // 平移边界：target 最低高度，避免钻到地面下
  const PAN_MAX_Y = 8;
  const ZOOM_MIN = 1.2;
  const ZOOM_MAX = 40;
  const FOVY = (45 * Math.PI) / 180; // 与 renderer.render 的 perspective 保持一致

  interface Ptr {
    x: number;
    y: number;
  }
  const pointers = new Map<number, Ptr>();
  let gesture: 'orbit' | 'pan' | 'pinch' | 'gizmo' = 'orbit';
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let downMoved = 0;
  let pinchDist = 0;

  // 把屏幕位移换算成 target 的世界位移：视角里一像素对应的世界尺寸随距离/视高变化，
  // 平移手感是「内容跟着手指走」。相机基与 orbitEye/lookAt 同约定：
  // right = (cos yaw, 0, -sin yaw)，up = (-sin yaw·sin el, cos el, -cos yaw·sin el)
  function panBy(dx: number, dy: number): void {
    const el = (panel.params.cameraElevation * Math.PI) / 180;
    const se = Math.sin(el);
    const ce = Math.cos(el);
    const sy = Math.sin(camera.yaw);
    const cy = Math.cos(camera.yaw);
    const worldPerPx =
      (2 * camera.distance * Math.tan(FOVY / 2)) / Math.max(1, canvas!.clientHeight);
    camera.target[0] = clamp(camera.target[0] + (-cy * dx - sy * se * dy) * worldPerPx, -PAN_LIMIT_XZ, PAN_LIMIT_XZ);
    camera.target[1] = clamp(camera.target[1] + ce * dy * worldPerPx, PAN_MIN_Y, PAN_MAX_Y);
    camera.target[2] = clamp(camera.target[2] + (sy * dx - cy * se * dy) * worldPerPx, -PAN_LIMIT_XZ, PAN_LIMIT_XZ);
    hudDirty = true;
  }

  function zoomBy(factor: number): void {
    camera.distance = clamp(camera.distance * factor, ZOOM_MIN, ZOOM_MAX);
  }

  // 把屏幕坐标转 NDC 并交给渲染器做射线拾取
  // penetrate（Alt+点击）：穿透拾取——同一射线上的命中物体按深度循环切换，
  // 解决「小物体包在大凹面外壳里选不中」：外壳 → 内部 → 再回外壳
  function pickAtClient(clientX: number, clientY: number, penetrate = false): void {
    const rect = canvas!.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    let idx: number | null;
    if (penetrate) {
      const hits = renderer.pickAtAll(ndcX, ndcY);
      if (hits.length === 0) {
        idx = null;
      } else {
        const cur = renderer.getSelected();
        const pos = cur === null ? -1 : hits.findIndex((h) => h.index === cur);
        idx = pos >= 0 ? hits[(pos + 1) % hits.length]!.index : hits[0]!.index;
      }
    } else {
      idx = renderer.pickAt(ndcX, ndcY);
    }
    renderer.selectObject(idx);
    panel.setSelection(idx);
    switchInspectorTab('inspector');
    hudDirty = true;
  }

  // =====================================================================
  // Transform Gizmo 交互：命中测试 + 拖拽（移动/旋转/缩放，local/world）
  // 纯 CPU 数学，不触碰 GPU；验证靠 typecheck + vite build。
  // =====================================================================
  type V3 = m4.Vec3; // 与 gizmo / 相机共用的向量类型（实现统一在 gpu/math.ts）
  /** 射线(o,d) 与平面(法线 n，过 p) 交点；平行返回 null */
  const rayPlane = (o: V3, d: V3, n: V3, p: V3): V3 | null => {
    const denom = m4.v3dot(d, n);
    if (Math.abs(denom) < 1e-7) return null;
    const t = m4.v3dot(m4.v3sub(p, o), n) / denom;
    return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  };
  /** 2D 点到线段距离（像素） */
  const distPointSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  };

  interface GizmoHit {
    /** 0/1/2 = 轴；-1 = 中心（整体移动 / 整体缩放） */
    axis: number;
  }

  const GIZMO_HIT_PX = 12; // 命中阈值：手柄投影到屏幕后 12px 内算抓取

  /**
   * 屏幕空间 gizmo 命中测试：把手柄几何投影到像素坐标量距离。
   * 与 3D 距离法的本质区别：轴向朝着相机被透视压短时，命中带跟着缩，
   * 看似点在空白处绝不会误抓手柄 —— 手柄之外的所有拖拽都归视角导航。
   */
  function hitTestGizmo(clientX: number, clientY: number): GizmoHit | null {
    const info = renderer.getGizmoInfo();
    if (info === null) return null;
    const origin = info.origin as V3;
    const o2 = renderer.worldToScreen(origin);
    if (o2.behind) return null;
    let bestAxis: number | null = null;
    let bestScore = Infinity;
    const consider = (axis: number, x: number, y: number): void => {
      const d = Math.hypot(clientX - x, clientY - y);
      if (d < GIZMO_HIT_PX && d < bestScore) {
        bestScore = d;
        bestAxis = axis;
      }
    };
    if (info.mode === 'rotate') {
      // 圆环：沿轴向采样 40 点投影成屏幕折线，取最小像素距离
      for (let a = 0; a < 3; a++) {
        const dir = info.axes[a] as V3;
        const ref: V3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const u = m4.v3norm(m4.v3cross(dir, ref));
        const w = m4.v3cross(dir, u);
        const SEG = 40;
        for (let s = 0; s < SEG; s++) {
          const ang = (s / SEG) * Math.PI * 2;
          const pt = m4.v3add(origin, m4.v3add(m4.v3scale(u, Math.cos(ang) * info.k), m4.v3scale(w, Math.sin(ang) * info.k)));
          const sp = renderer.worldToScreen(pt);
          if (!sp.behind) consider(a, sp.x, sp.y);
        }
      }
    } else {
      // 箭头（移动）/ 轴方块（缩放）：投影轴线段，点到线段像素距离
      for (let a = 0; a < 3; a++) {
        const dir = info.axes[a] as V3;
        const tip = renderer.worldToScreen(m4.v3add(origin, m4.v3scale(dir, info.k)));
        if (!tip.behind) {
          const d = distPointSeg(clientX, clientY, o2.x, o2.y, tip.x, tip.y);
          if (d < GIZMO_HIT_PX && d < bestScore) {
            bestScore = d;
            bestAxis = a;
          }
        }
      }
      // 中心方块（移动/缩放整体）
      if (info.mode === 'translate' || info.mode === 'scale') {
        consider(-1, o2.x, o2.y);
      }
    }
    return bestAxis === null ? null : { axis: bestAxis };
  }

  interface DragStart {
    axis: number;
    mode: 'translate' | 'rotate' | 'scale';
    objIndex: number;
    startPos: V3;
    startQuat: m4.Quat;
    startScale: number;
    dir: V3; // 拖拽开始时的世界轴方向（移动/旋转/缩放轴用）
    planeN: V3; // 拖拽平面法线（移动/缩放轴、中心用）
    startGrab: V3; // 拖拽开始的抓取点（在平面上）
    startParam: number; // 沿轴参数（移动/缩放轴）
    startAngle: number; // 旋转起始角
    lastAngle: number; // 上一帧极角（逐帧差值用，避免 atan2 分支跳变）
    totalAngle: number; // 本次拖拽累计角（可连续旋转任意圈）
    startDist: number; // 中心缩放起始距离
  }
  let drag: DragStart | null = null;

  function beginGizmoDrag(hit: GizmoHit, clientX: number, clientY: number): void {
    const info = renderer.getGizmoInfo();
    if (info === null) return;
    const idx = renderer.getSelected();
    if (idx === null) return;
    const q = renderer.getObjectQuat(idx);
    const st = renderer.getObjectState(idx);
    if (q === null || st === null) return;
    const origin = info.origin as V3;
    const ray = renderer.pointerRay(clientX, clientY);
    if (ray === null) return;
    const eye = renderer.getEye();
    const viewDir = m4.v3norm(m4.v3sub([eye[0], eye[1], eye[2]], origin));
    const axis = hit.axis;
    const dir: V3 = axis === -1 ? [0, 0, 0] : (info.axes[axis] as V3);

    const ds: DragStart = {
      axis,
      mode: info.mode,
      objIndex: idx,
      startPos: [st.pos[0], st.pos[1], st.pos[2]],
      startQuat: q,
      startScale: st.scale,
      dir,
      planeN: [0, 0, 0],
      startGrab: [0, 0, 0],
      startParam: 1,
      startAngle: 0,
      lastAngle: 0,
      totalAngle: 0,
      startDist: 1,
    };

    if (info.mode === 'rotate') {
      const n = dir;
      const { u, w } = rotatePlaneBasis(n, viewDir);
      const gp = rayPlane(ray.o, ray.d, n, origin);
      if (gp !== null) {
        ds.startAngle = angleInPlane(gp, origin, u, w);
        ds.lastAngle = ds.startAngle;
        ds.totalAngle = 0;
      }
    } else if (axis === -1) {
      // 中心：沿视线平面自由移动，或整体缩放
      const gp = rayPlane(ray.o, ray.d, viewDir, origin);
      if (gp !== null) {
        ds.planeN = viewDir;
        ds.startGrab = gp;
        if (info.mode === 'scale') {
          ds.startDist = Math.hypot(gp[0] - origin[0], gp[1] - origin[1], gp[2] - origin[2]) || 1e-3;
        }
      }
    } else {
      // 轴约束：平面含该轴且尽量朝相机
      const n = axisPlaneNormal(viewDir, dir);
      const gp = rayPlane(ray.o, ray.d, n, origin);
      if (gp !== null) {
        ds.planeN = n;
        ds.startGrab = gp;
        ds.startParam = m4.v3dot(m4.v3sub(gp, ds.startPos), dir) || 1e-3;
      }
    }
    drag = ds;
    renderer.setGizmoActiveAxis(axis);
    canvas!.style.cursor = 'grabbing';
  }

  function updateGizmoDrag(clientX: number, clientY: number): void {
    if (drag === null) return;
    const idx = drag.objIndex;
    const info = renderer.getGizmoInfo();
    if (info === null) return;
    const ray = renderer.pointerRay(clientX, clientY);
    if (ray === null) return;
    const origin = info.origin as V3;
    const eye = renderer.getEye();
    const viewDir = m4.v3norm(m4.v3sub([eye[0], eye[1], eye[2]], origin));

    if (drag.mode === 'rotate') {
      const n = drag.dir;
      const { u, w } = rotatePlaneBasis(n, viewDir);
      const gp = rayPlane(ray.o, ray.d, n, origin);
      if (gp !== null) {
        const ang = angleInPlane(gp, origin, u, w);
        // 逐帧差值过 wrapAngle 再累计：跨 ±180° 分支不跳变，可连续转任意圈
        drag.totalAngle += wrapAngle(ang - drag.lastAngle);
        drag.lastAngle = ang;
        const dq = m4.quatAxisAngle(n, drag.totalAngle);
        renderer.setObjectQuat(idx, m4.quatMul(dq, drag.startQuat));
      }
    } else if (drag.axis === -1) {
      const gp = rayPlane(ray.o, ray.d, drag.planeN, origin);
      if (gp !== null) {
        if (drag.mode === 'translate') {
          const delta = m4.v3sub(gp, drag.startGrab);
          renderer.setObjectPos(idx, 0, drag.startPos[0] + delta[0]);
          renderer.setObjectPos(idx, 1, drag.startPos[1] + delta[1]);
          renderer.setObjectPos(idx, 2, drag.startPos[2] + delta[2]);
        } else {
          const dist = Math.hypot(gp[0] - origin[0], gp[1] - origin[1], gp[2] - origin[2]) || 1e-3;
          renderer.setObjectScale(idx, drag.startScale * (dist / drag.startDist));
        }
      }
    } else {
      const gp = rayPlane(ray.o, ray.d, drag.planeN, origin);
      if (gp !== null) {
        const param = m4.v3dot(m4.v3sub(gp, drag.startPos), drag.dir);
        const d = param - drag.startParam;
        if (drag.mode === 'translate') {
          const np = m4.v3add(drag.startPos, m4.v3scale(drag.dir, d));
          renderer.setObjectPos(idx, 0, np[0]);
          renderer.setObjectPos(idx, 1, np[1]);
          renderer.setObjectPos(idx, 2, np[2]);
        } else {
          renderer.setObjectScale(idx, drag.startScale * (param / drag.startParam));
        }
      }
    }
    panel.syncSelectionFromRenderer();
    hudDirty = true;
  }

  function endGizmoDrag(): void {
    if (drag !== null) {
      renderer.setGizmoActiveAxis(null);
      drag = null;
      canvas!.style.cursor = '';
      suppressDblclickUntil = performance.now() + 350;
    }
  }

  /** 工具栏模式 / 坐标空间切换（同步渲染器 + 按钮高亮） */
  function setGizmoModeUI(mode: 'translate' | 'rotate' | 'scale'): void {
    renderer.setGizmoMode(mode);
    for (const btn of document.querySelectorAll<HTMLButtonElement>('#gizmo-bar .gz-mode')) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }
    hudDirty = true;
  }
  function setGizmoSpaceUI(space: 'local' | 'world'): void {
    renderer.setGizmoSpace(space);
    for (const btn of document.querySelectorAll<HTMLButtonElement>('#gizmo-bar .gz-space')) {
      btn.classList.toggle('active', btn.dataset.space === space);
    }
    hudDirty = true;
  }

  // ---- 聚焦：双击 / F 键把相机平滑拉到选中物体 ----
  interface FocusAnim {
    t: number;
    dur: number;
    fromT: [number, number, number];
    toT: [number, number, number];
    fromD: number;
    toD: number;
  }
  let focusAnim: FocusAnim | null = null;
  let suppressDblclickUntil = 0; // gizmo 拖拽结束后的短暂窗口内忽略 dblclick，防连点手柄误触聚焦

  const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

  /** 聚焦到某物体（null = 无选中，回默认取景）。距离按包围球适配视锥，留 1.5 倍余量 */
  function focusOn(index: number | null): void {
    let toT: [number, number, number];
    let toD: number;
    if (index === null) {
      toT = [...DEFAULT_VIEW.target];
      toD = DEFAULT_VIEW.distance;
    } else {
      const b = renderer.getObjectBounds(index);
      if (b === null) return;
      toT = b.center;
      toD = clamp((b.radius / Math.tan(FOVY / 2)) * 1.5, ZOOM_MIN, ZOOM_MAX);
    }
    focusAnim = {
      t: 0,
      dur: 0.35,
      fromT: [camera.target[0], camera.target[1], camera.target[2]],
      toT,
      fromD: camera.distance,
      toD,
    };
  }

  for (const btn of document.querySelectorAll<HTMLButtonElement>('#gizmo-bar .gz-mode')) {
    btn.addEventListener('click', () =>
      setGizmoModeUI(btn.dataset.mode as 'translate' | 'rotate' | 'scale'),
    );
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#gizmo-bar .gz-space')) {
    btn.addEventListener('click', () =>
      setGizmoSpaceUI(btn.dataset.space as 'local' | 'world'),
    );
  }
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if (k === 'w') setGizmoModeUI('translate');
    else if (k === 'e') setGizmoModeUI('rotate');
    else if (k === 'r') setGizmoModeUI('scale');
    else if (k === 'f') focusOn(renderer.getSelected());
    else if (k === 'delete') {
      // Delete 删除选中物体（Unity 惯例）
      const idx = renderer.getSelected();
      if (idx !== null) {
        e.preventDefault();
        renderer.removeObject(idx);
        panel.setSelection(renderer.getSelected());
        panel.refreshHierarchy();
        hudDirty = true;
      }
    }
  });
  // 双击：第一下轻点已把光标下的物体选上，双击事件紧接着聚焦过去；双击空白 = 回默认取景
  canvas.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (performance.now() < suppressDblclickUntil) return;
    focusOn(renderer.getSelected());
  });
  // 初始高亮：translate + world（与渲染器默认值一致）
  setGizmoModeUI('translate');
  setGizmoSpaceUI('world');

  canvas.addEventListener('pointerdown', (e) => {
    focusAnim = null; // 用户接管相机，聚焦动画立即让位
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      // gizmo 手柄抓取：仅普通左键（右键/中键/Shift+左键永远归视角导航，绝不抢）
      if (e.button === 0 && !e.shiftKey && renderer.getSelected() !== null) {
        const hit = hitTestGizmo(e.clientX, e.clientY);
        if (hit !== null) {
          beginGizmoDrag(hit, e.clientX, e.clientY);
          gesture = 'gizmo';
          lastX = e.clientX;
          lastY = e.clientY;
          downX = e.clientX;
          downY = e.clientY;
          downMoved = 0;
          return;
        }
      }
      gesture = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
      lastX = e.clientX;
      lastY = e.clientY;
      downX = e.clientX;
      downY = e.clientY;
      downMoved = 0;
    } else if (pointers.size === 2) {
      downMoved = CLICK_THRESHOLD + 1; // 双指手势绝不触发拾取
      const pts = [...pointers.values()];
      const a = pts[0]!;
      const b = pts[1]!;
      pinchDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      lastX = (a.x + b.x) / 2;
      lastY = (a.y + b.y) / 2;
      gesture = 'pinch';
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const pt = pointers.get(e.pointerId);
    if (pt === undefined) {
      // 悬停（无按键按下）：gizmo 手柄上显示抓手，提示此处点击是拖手柄而非转视角。
      // 先算好再比对旧值：无条件写 style.cursor 会让每次鼠标移动都触发一次样式失效，
      // 而绝大多数移动光标形态根本没变。
      const next =
        renderer.getSelected() !== null && hitTestGizmo(e.clientX, e.clientY) !== null ? 'grab' : '';
      if (canvas.style.cursor !== next) canvas.style.cursor = next;
      return;
    }
    pt.x = e.clientX;
    pt.y = e.clientY;
    if (pointers.size === 1) {
      downMoved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (gesture === 'gizmo') {
        updateGizmoDrag(e.clientX, e.clientY);
      } else if (gesture === 'orbit') {
        camera.yaw -= (e.clientX - lastX) * ORBIT_RAD_PER_PX;
        // 自由俯仰：上下拖可越过地平线（负 = 仰视，eye 在 target 之下）。
        // 仅在接近 ±90° 时 lookAt 的 up 与视线平行才退化，故留 1° 余量。
        panel.params.cameraElevation = clamp(
          panel.params.cameraElevation + (e.clientY - lastY) * PITCH_DEG_PER_PX,
          -PITCH_LIMIT_DEG,
          PITCH_LIMIT_DEG,
        );
        panel.syncValues();
        hudDirty = true;
      } else if (gesture === 'pan') {
        panBy(e.clientX - lastX, e.clientY - lastY);
      }
      lastX = e.clientX;
      lastY = e.clientY;
    } else if (pointers.size >= 2 && gesture === 'pinch') {
      const pts = [...pointers.values()];
      const a = pts[0]!;
      const b = pts[1]!;
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      zoomBy(pinchDist / d); // 双指张开 → 拉近
      pinchDist = d;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      panBy(cx - lastX, cy - lastY);
      lastX = cx;
      lastY = cy;
    }
  });

  const endPointer = (e: PointerEvent): void => {
    const had = pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!had) return;
    if (pointers.size === 0) {
      const wasDrag = downMoved > CLICK_THRESHOLD;
      // gizmo 拖拽结束：清手柄高亮，不触发拾取
      if (drag !== null) {
        endGizmoDrag();
      } else if (!wasDrag && e.button === 0) {
        // 轻点 = 拾取选中（触摸的 button 也是 0）；Alt+点击 = 穿透循环；任何拖拽/双指/右键操作不拾取
        pickAtClient(e.clientX, e.clientY, e.altKey);
      }
    } else if (pointers.size === 1) {
      // 双指抬起一根：用剩下那根重新锚定，视角不跳变；拾取基点一并重置
      const rest = [...pointers.values()][0]!;
      lastX = rest.x;
      lastY = rest.y;
      downX = rest.x;
      downY = rest.y;
      downMoved = CLICK_THRESHOLD + 1;
      gesture = 'orbit';
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // 右键留给平移
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // 挡掉中键自动滚动
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      focusAnim = null;
      zoomBy(Math.exp(e.deltaY * 0.0012));
    },
    { passive: false },
  );

  // =====================================================================
  // 资产库 Asset Library + 属性 Inspector
  // 底部 dock 浏览项目文件；GLB 双击/拖入画布生成为新场景物体（renderer.addObject，
  // 与「导入 GLB…」替换角色槽位是两条路）；选中资产在右侧 Inspector 显示静态属性。
  // =====================================================================

  // 三栏宽度恢复 + 分界线拖拽（左侧栏 / 右侧 Inspector；dock 与目录树的把手在组件内部）
  restoreCssVar('--panel-w', 'zh.ui.panelW', 330);
  restoreCssVar('--insp-w', 'zh.ui.inspW', 300);
  const splitLeft = document.getElementById('split-left');
  if (splitLeft !== null) {
    makeSplitter(splitLeft, {
      cssVar: '--panel-w',
      valueFromPointer: (e) => e.clientX,
      min: 220,
      max: 560,
      persistKey: 'zh.ui.panelW',
    });
  }
  const splitRight = document.getElementById('split-right');
  if (splitRight !== null) {
    makeSplitter(splitRight, {
      cssVar: '--insp-w',
      valueFromPointer: (e) => window.innerWidth - e.clientX,
      min: 220,
      max: 560,
      persistKey: 'zh.ui.inspW',
    });
  }

  /** Unity 式去重命名：同名物体追加 2 / 3 / 4… */
  function uniqueObjectName(base: string): string {
    const names = new Set(renderer.getObjectList().map((n) => n.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) {
      const cand = `${base} ${i}`;
      if (!names.has(cand)) return cand;
    }
  }

  /**
   * 把项目里的 .glb 资产生成到场景（双击 / Inspector 按钮 / 画布拖放共用）。
   * pos 为 null 时放原点；拖放路径会把落点（视线与地面交点）传进来。
   */
  async function spawnAssetAt(relPath: string, pos: [number, number, number] | null): Promise<void> {
    try {
      const resp = await fetch(`/__fs/file?path=${encodeURIComponent(relPath)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      // 与「导入 GLB…」同一把身高尺，保证资产库生成的与导入的体型一致
      const model = parseGlb(buffer, MODEL_RULER_HEIGHT_M);
      const bmp = model.image === null ? null : await decodeTexture(model.image, relPath);
      const name = uniqueObjectName(stemName(relPath));
      // nodeTree 一并传入：拖入的资产在层级面板同样按 GLB 父子结构成树
      const idx = renderer.addObject(model.mesh, bmp, model.subMeshes, name, pos ?? [0, 0, 0], model.nodeTree, model.skeleton, model.animations);
      if (idx === null) {
        panel.setModelInfo('场景物体已达上限（64），先在层级里删掉一些再拖入');
        return;
      }
      renderer.selectObject(idx);
      panel.setSelection(idx);
      switchInspectorTab('inspector');
      panel.refreshHierarchy();
      panel.setModelInfo(
        `${name} · ${model.vertices} 顶点 / ${model.triangles} 面 · 来自资产库 ${relPath}`,
      );
      focusOn(idx);
      hudDirty = true;
    } catch (err) {
      panel.setModelInfo(`资产载入失败：${stemName(relPath)} · ${String(err)}`);
      console.error('[资产库] 载入失败', relPath, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 绑定面板 Binding —— 资产库 / 层级面板右键「进入绑定」共用一套实现
  //
  // 核心契约（改这块之前先读 services/binding/ 三个文件的头注释）：
  //   · 面板全程只在**模型 local 空间**里操作，不读任何节点世界矩阵；
  //   · 正视改 (x,y)、侧视改 (z,y)，两次拖拽定一个三维坐标；
  //   · mirror 是 x 取反，属于正视图（侧视图里 x 是深度轴，看不出镜像）；
  //   · 拟合产出两类数据：**骨长采纳进 T-pose**，**姿态旋转 ΔR 只在反解时被消耗，
  //     绝不进骨架** —— 否则 bind pose 不是干净 T-pose，接入 BVH/动捕会带 offset。
  //
  // 必须定义在资产库之前：资产库的右键回调直接调 openCtxMenu / bindAssetAt。
  // ═══════════════════════════════════════════════════════════════════════════
  const bindingDockEl = document.getElementById('binding-dock');
  const ctxMenuEl = document.getElementById('ctx-menu');

  /** 一次绑定会话的素材：源网格（**当前姿态**）+ 索引 + 原始 baseColor 贴图 */
  interface BindingSession {
    name: string;
    vertices: Float32Array;
    indices: Uint32Array;
    image: Blob | null;
  }
  let bindingSession: BindingSession | null = null;
  let binding: BindingPanel | null = null;

  /**
   * 已重定向的动画（**骨名**为键，还没绑到任何具体骨架上）。
   *
   * 这正是「通用」的关键：重定向的产物与骨架解耦，因此同一份 BVH 既能导进
   * 绑定面板正在做的 T-pose GLB，也能直接挂到场景里任意一个已绑定模型上。
   */
  let animClip: RetargetClip | null = null;
  let animReport: RetargetReport | null = null;

  // ── 右键菜单：资产库与层级面板共用一套 DOM 与关闭逻辑 ──
  interface CtxItem {
    label: string;
    disabled?: boolean;
    run(): void;
  }

  function openCtxMenu(x: number, y: number, items: CtxItem[]): void {
    if (ctxMenuEl === null) return;
    ctxMenuEl.replaceChildren();
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'ctx-item';
      b.type = 'button';
      b.textContent = it.label;
      if (it.disabled === true) b.disabled = true;
      b.addEventListener('click', () => {
        closeCtxMenu();
        it.run();
      });
      ctxMenuEl.appendChild(b);
    }
    ctxMenuEl.classList.add('open');
    // 先可见才量得到尺寸，故 add('open') 之后再定位；贴边翻转避免被窗口裁掉
    const r = ctxMenuEl.getBoundingClientRect();
    ctxMenuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
    ctxMenuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
  }

  function closeCtxMenu(): void {
    ctxMenuEl?.classList.remove('open');
  }
  // 捕获阶段监听：菜单里的按钮在冒泡到 window 前就可能被移除，捕获更稳
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (ctxMenuEl === null || !ctxMenuEl.classList.contains('open')) return;
      if (!ctxMenuEl.contains(e.target as Node)) closeCtxMenu();
    },
    true,
  );
  window.addEventListener('blur', () => closeCtxMenu());

  // ── 面板开关 ──
  function openBinding(session: BindingSession): void {
    if (bindingDockEl === null) return;
    bindingSession = session;
    if (binding === null) {
      binding = new BindingPanel(bindingDockEl, {
        onClose: () => closeBinding(),
        onApply: (fit) => void applyBinding(fit),
        onLoadBvh: () => pickBvhFile((t, n) => loadBvhForBinding(t, n)),
        onExportAnim: () => void exportAnimGlb(),
      });
      wireBindingGrip();
    }
    bindingDockEl.classList.add('open');
    binding.setModel(session.name, session.vertices, session.indices);
    // canvas 必须等 open 之后才量得到 clientWidth，晚一帧再重算视图缩放
    requestAnimationFrame(() => binding?.resize());
    panel.setModelInfo(
      `已进入绑定：${session.name} · 正视改 x/y、侧视改 z/y · ` +
        `骨长采纳进 T-pose，姿态偏移不入骨架`,
    );
  }

  function closeBinding(): void {
    bindingDockEl?.classList.remove('open');
    binding?.clear();
    bindingSession = null;
  }

  /** 顶边把手：下压面板露出上方 3D 视图对照（只改 style.top） */
  function wireBindingGrip(): void {
    const grip = bindingDockEl?.querySelector<HTMLElement>('.bd-grip');
    if (grip === null || grip === undefined || bindingDockEl === null) return;
    let startY = 0;
    let startTop = 0;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startTop = parseFloat(getComputedStyle(bindingDockEl).top) || 0;
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('dragging');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!grip.classList.contains('dragging')) return;
      const host = bindingDockEl.parentElement;
      const max = host === null ? 0 : Math.max(0, host.clientHeight - 140);
      bindingDockEl.style.top = `${clamp(startTop + (e.clientY - startY), 0, max)}px`;
    });
    const end = (e: PointerEvent): void => {
      if (!grip.classList.contains('dragging')) return;
      grip.classList.remove('dragging');
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      binding?.resize();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  /**
   * 应用 T-pose：算权重 → 反解网格 → 导出 GLB → 回灌显示。
   *
   * @param fit     当前姿态的拟合结果（面板刻意先交 fit、后复位关节：
   *                LBS 权重必须在当前姿态骨架 + 当前姿态网格上算，顺序反了
   *                A-pose 手臂权重全错）
   * @param anim    可选的重定向动画，一并烘焙进 `animations[]`
   * @param suffix  文件名后缀（`_tpose` / `_anim`）；download=false 时不落盘
   */
  async function exportBound(
    fit: FitResult,
    anim: BindAnimationInput | null,
    download: boolean,
    suffix: string,
  ): Promise<BindExportStats | null> {
    const s = bindingSession;
    if (s === null || binding === null) return null;
    const mesh = binding.getMesh();
    if (mesh === null) return null;
    try {
      const base = {
        name: s.name,
        vertices: mesh.vertices,
        indices: mesh.indices,
        image: s.image,
        placed: binding.getState().positions,
      };
      // exactOptionalPropertyTypes：`animation?: T` 不接受显式 undefined，只能整包展开
      const res = await rigToTPoseWithImage(
        anim === null ? base : { ...base, animation: anim },
      );
      const file = `${s.name}${suffix}.glb`;
      if (download) {
        downloadBlob(file, new Blob([res.glb], { type: 'model/gltf-binary' }));
      }
      // 回灌 T-pose 网格：网格摆正 + 骨架摆正，两者重合即证明反解成立（一眼可验证）
      binding.showTPoseResult(res.fit, res.tposeVertices);
      const st = res.stats;
      const animPart =
        anim === null
          ? ''
          : ` · 动画 ${st.animClips.join('/')} (${st.animChannels} 轨道)`;
      panel.setModelInfo(
        (download ? `已导出 ${file}` : '已试算') +
          ` · ${st.vertices} 顶点 / ${st.triangles} 面 / ` +
          `${(st.bytes / 1024).toFixed(0)} KB · 最大姿态偏移 ${st.maxPoseAngleDeg.toFixed(1)}° · ` +
          `身高 ${st.heightBefore.toFixed(3)} → ${st.heightAfter.toFixed(3)} m` +
          animPart +
          (st.zeroWeightVerts > 0 ? ` · ⚠ ${st.zeroWeightVerts} 个零权重顶点` : ''),
      );
      console.log('[绑定] 导出完成', {
        name: s.name,
        file: download ? file : null,
        vertices: st.vertices,
        triangles: st.triangles,
        bytes: st.bytes,
        maxPoseAngleDeg: st.maxPoseAngleDeg,
        offAxisBones: st.offAxisBones,
        heightBefore: st.heightBefore,
        heightAfter: st.heightAfter,
        zeroWeightVerts: st.zeroWeightVerts,
        animChannels: st.animChannels,
        animClips: st.animClips,
      });
      return st;
    } catch (err) {
      panel.setModelInfo(`绑定导出失败：${String(err)}`);
      console.error('[绑定] 导出失败', err);
      return null;
    }
  }

  async function applyBinding(fit: FitResult, download = true): Promise<BindExportStats | null> {
    return await exportBound(fit, null, download, '_tpose');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 动画应用：任意 BVH → 重定向 → ① 导出带动画的 GLB  ② 直接挂到场景里已绑定的模型
  //
  // 为什么必须重定向而不能直接拷轨道值，见 services/binding/retarget.ts 的头注释。
  // 一句话：glTF 轨道是**绝对本地旋转**，源 A-pose / 目标 T-pose 直接拷会整体偏 45°，
  // 这就是用户说的「所有导入的动画都会有 offset」。
  // ═══════════════════════════════════════════════════════════════════════════

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
    );
  }

  /** 绑定面板侧栏的诊断 HTML：一句话看清这次重定向发生了什么 */
  function animInfoHtml(r: RetargetReport): string {
    const row = (k: string, v: string): string =>
      `<div class="bd-row"><span class="bd-dim">${k}</span> ${v}</div>`;
    const out: string[] = [`<div><b>${escapeHtml(r.clipName)}</b></div>`];
    out.push(row('帧', `${r.frameCount} @ ${r.fps.toFixed(1)}fps · ${r.duration.toFixed(2)}s`));
    out.push(
      row(
        '骨',
        `${r.mapped.length} 已映射` +
          (r.missingBones.length > 0
            ? ` · <span class="bd-warn">缺 ${escapeHtml(r.missingBones.join(' '))}</span>`
            : ''),
      ),
    );
    out.push(row('对齐', `最大 ${r.maxAlignAngleDeg.toFixed(2)}°`));
    out.push(row('缩放', `${r.skeletonScale.toFixed(4)} · 源 ${r.srcUpAxis}-up`));
    if (r.unmatchedBvh.length > 0) {
      const list = r.unmatchedBvh.slice(0, 6).join(' ');
      out.push(row('未用', escapeHtml(list) + (r.unmatchedBvh.length > 6 ? ' …' : '')));
    }
    for (const w of r.warnings) out.push(row('提示', `<span class="bd-warn">${escapeHtml(w)}</span>`));
    return out.join('');
  }

  /**
   * 重定向一份 BVH 文本并缓存为 `animClip`（**骨名**为键，与具体骨架解耦）。
   *
   * @param targetPositions 目标骨架的 T-pose 关节世界位置，用于算根位移缩放。
   *                        null = 退回 HumanIK 模板（姿势仍对，缩放按 1.7 m 模板算）。
   */
  function retargetInto(
    text: string,
    clipName: string,
    targetPositions: JointPositions | null,
  ): RetargetReport {
    const opts: RetargetOptions = { clipName };
    if (targetPositions !== null) opts.targetPositions = targetPositions;
    const res = retargetBvh(parseBvh(text), opts);
    animClip = res.clip;
    animReport = res.report;
    return res.report;
  }

  function clearAnim(): void {
    animClip = null;
    animReport = null;
  }

  /** 入口 A：绑定面板「载入 BVH…」—— 目标骨架就是面板里那个 T-pose */
  function loadBvhForBinding(text: string, clipName: string): RetargetReport | null {
    if (binding === null) return null;
    try {
      const r = retargetInto(text, clipName, binding.currentFit().tposePositions);
      binding.setAnimationInfo(animInfoHtml(r));
      panel.setModelInfo(`动画已重定向：${retargetSummary(r)}`);
      console.log('[动画] 重定向完成', r);
      return r;
    } catch (err) {
      clearAnim();
      binding.setAnimationInfo(null);
      panel.setModelInfo(`BVH 载入失败：${String(err)}`);
      console.error('[动画] 重定向失败', err);
      return null;
    }
  }

  /**
   * 入口 B：层级面板「应用动画 (BVH)…」—— 目标骨架是**场景里这个模型自己的**。
   *
   * 缩放按它自己的 rest 腿长算（不是模板身高），所以 2.05 m 的 E-04 接到
   * 1.7 m 模板录的动捕上根位移不会被压扁。
   */
  function loadBvhForObject(text: string, clipName: string, obj: SceneObject): RetargetReport | null {
    if (obj.skeleton === null) return null;
    try {
      const r = retargetInto(text, clipName, skeletonRestWorldPositions(obj.skeleton));
      const applied = applyAnimToObject(obj);
      if (applied === null) return null;
      panel.setModelInfo(
        `${obj.name} 已应用 ${clipName} · ${applied.tracks} 条轨道 · ` +
          `片段 #${applied.clip} · ${retargetSummary(r)}`,
      );
      console.log('[动画] 已挂到场景物体', { obj: obj.name, ...applied, report: r });
      return r;
    } catch (err) {
      clearAnim();
      panel.setModelInfo(`BVH 载入失败：${String(err)}`);
      console.error('[动画] 重定向失败', err);
      return null;
    }
  }

  /** 隐藏 file input：BVH 没有别的入口，只能从磁盘挑 */
  function pickBvhFile(onText: (text: string, name: string) => void): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bvh';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.remove();
      if (f === undefined) return;
      void f
        .text()
        .then((t) => onText(t, stemName(f.name)))
        .catch((err: unknown) => {
          panel.setModelInfo(`BVH 读取失败：${String(err)}`);
          console.error('[动画] 读取失败', err);
        });
    });
    input.click();
  }

  /** 导出「T-pose 网格 + 骨架 + 已重定向动画」的 GLB */
  async function exportAnimGlb(): Promise<BindExportStats | null> {
    const c = animClip;
    if (c === null || binding === null) return null;
    const anim: BindAnimationInput = {
      name: c.name,
      times: c.times,
      rotations: c.rotations,
      translation: c.translation,
    };
    return await exportBound(binding.currentFit(), anim, true, '_anim');
  }

  /**
   * 把已重定向的动画挂到一个**场景里已绑定的模型**上。
   *
   * 这是「通用」的另一半：不要求模型来自绑定面板，只要骨架命名能对上 HumanIK
   * （rig_character.py 产物、Mixamo 导出、绑定面板导出的 GLB 都满足）。
   */
  function applyAnimToObject(obj: SceneObject): { tracks: number; clip: number } | null {
    const c = animClip;
    if (c === null || obj.skeleton === null) return null;
    const clip = clipToAnimClip(c, obj.skeleton);
    if (clip === null) {
      panel.setModelInfo(
        `动画应用失败：${obj.name} 的骨架没有一根骨对上 HumanIK 22 骨（无法按名重定向）`,
      );
      return null;
    }
    obj.animations = [...obj.animations, clip];
    obj.skinState = createSkinState(obj.skeleton, obj.animations);
    selectClip(obj.skinState, obj.animations.length - 1);
    play(obj.skinState);
    hudDirty = true;
    return { tracks: clip.tracks.length, clip: obj.animations.length - 1 };
  }

  /** 入口一：资产库里右键 .glb → 「进入绑定」 */
  async function bindAssetAt(relPath: string): Promise<void> {
    try {
      const resp = await fetch(`/__fs/file?path=${encodeURIComponent(relPath)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      // 与「导入 GLB…」同一把身高尺，保证绑定面板里的体型与场景里一致
      const model = parseGlb(buffer, MODEL_RULER_HEIGHT_M);
      openBinding({
        name: stemName(relPath),
        vertices: model.mesh.vertices,
        indices: model.mesh.indices,
        image: model.image,
      });
    } catch (err) {
      panel.setModelInfo(`进入绑定失败：${stemName(relPath)} · ${String(err)}`);
      console.error('[绑定] 载入失败', relPath, err);
    }
  }

  /** 入口二：层级面板右键场景物体 → 「进入绑定」 */
  panel.onHierarchyContextMenu = (index, x, y) => {
    const obj = renderer.state.objects[index];
    openCtxMenu(x, y, [
      {
        label: obj === undefined ? '进入绑定 Binding…（物体不存在）' : '进入绑定 Binding…',
        disabled: obj === undefined,
        run: () => {
          if (obj === undefined) return;
          openBinding({
            name: obj.name,
            // 拷贝一份：场景网格是渲染器的活引用，applyAo 之类会就地改它
            vertices: new Float32Array(obj.mesh.vertices),
            indices: new Uint32Array(obj.mesh.indices),
            // 场景物体的贴图已上传成 GPUTexture，原始字节取不回来 → 导出不带贴图
            image: null,
          });
        },
      },
      {
        label:
          obj === undefined
            ? '应用动画 (BVH)…（物体不存在）'
            : obj.skeleton === null
              ? '应用动画 (BVH)…（该物体无骨骼）'
              : '应用动画 (BVH)…',
        disabled: obj === undefined || obj.skeleton === null,
        run: () => {
          if (obj === undefined) return;
          pickBvhFile((t, n) => loadBvhForObject(t, n, obj));
        },
      },
      { label: '聚焦 Focus', disabled: obj === undefined, run: () => focusOn(index) },
    ]);
  };

  window.addEventListener('resize', () => binding?.resize());

  // 自动化钩子：无头 CDP 验证驱动绑定面板（全部走函数，避免持有过期引用）
  {
    const hook = (window as unknown as { __editor: Record<string, unknown> }).__editor;
    hook.binding = {
      isOpen: () => bindingDockEl?.classList.contains('open') ?? false,
      open: (p: string) => void bindAssetAt(p),
      close: () => closeBinding(),
      state: () => binding?.getState() ?? null,
      fit: () => binding?.currentFit() ?? null,
      pose: (n: string, p: [number, number, number]) => binding?.poseJoint(n, p),
      select: (n: string | null) => binding?.select(n),
      distance: (n: string) => binding?.distanceToMesh(n) ?? NaN,
      /** 只跑导出算一遍（不触发下载），返回统计结果供断言 */
      dryRun: async () => {
        if (binding === null) return null;
        return await applyBinding(binding.currentFit(), false);
      },
    };

    /**
     * 动画钩子：无头冒烟直接喂 BVH 文本，绕过 file input（headless 里没法点）。
     *
     * 两条路都要能验证：
     *   · `load(text, name)`           → 绑到面板当前的 T-pose（对应面板「载入 BVH…」）
     *   · `applyTo(index, text, name)` → 直接挂到场景物体（对应层级右键「应用动画」）
     */
    hook.anim = {
      /** 当前缓存的重定向报告；没载入过为 null */
      report: () => animReport,
      /** 当前缓存的片段名 / 帧数；没载入过为 null */
      info: () =>
        animClip === null
          ? null
          : { name: animClip.name, frames: animClip.times.length, bones: Object.keys(animClip.rotations).length, hasRoot: animClip.translation !== null },
      load: (text: string, name = 'clip') => loadBvhForBinding(text, name),
      applyTo: (index: number, text: string, name = 'clip') => {
        const obj = renderer.state.objects[index];
        if (obj === undefined) return null;
        return loadBvhForObject(text, name, obj);
      },
      /** 导出带动画的 GLB 走一遍全流程（不落盘），返回统计供断言 */
      exportDryRun: async () => {
        const c = animClip;
        if (c === null || binding === null) return null;
        const anim: BindAnimationInput = {
          name: c.name,
          times: c.times,
          rotations: c.rotations,
          translation: c.translation,
        };
        return await exportBound(binding.currentFit(), anim, false, '_anim');
      },
      /** 场景物体当前的片段数与正在播的片段下标 */
      objectClips: (index: number) => {
        const obj = renderer.state.objects[index];
        if (obj === undefined || obj.skinState === null) return null;
        return {
          clips: obj.skinState.clips.length,
          clip: obj.skinState.clip,
          playing: obj.skinState.playing,
          tracks: obj.skinState.clips[obj.skinState.clip]?.tracks.length ?? 0,
        };
      },
      clear: () => {
        clearAnim();
        binding?.setAnimationInfo(null);
      },
    };
  }

  let assetPreview: AssetPreview | null = null;
  // 预览缓存提到块外：动画应用要往缓存里的 model.animations 追加片段
  const previewCache = new Map<string, GltfResult>();
  const inspectorEl = document.querySelector<HTMLElement>('#inspector .insp-pane[data-pane="asset"] .ai-host');
  const previewHostEl = document.getElementById('asset-preview-host');
  const dockEl = document.getElementById('asset-dock');
  if (inspectorEl !== null && dockEl !== null) {
    const inspector = new AssetInspector(inspectorEl, {
      onSpawn: (p) => void spawnAssetAt(p, null),
    });
    assetPreview = previewHostEl !== null ? new AssetPreview(previewHostEl, gpu) : null;

    // 资产库预览缓存：避免反复 fetch + 解析 GLB（贴图仍每次重新解码，因 ImageBitmap 已被 close）
    async function previewAsset(sel: AssetSelection): Promise<void> {
      if (sel.entry.kind !== 'file' || !sel.entry.ext.toLowerCase().endsWith('.glb')) {
        assetPreview?.clear();
        return;
      }
      try {
        let model = previewCache.get(sel.path);
        if (model === undefined) {
          const resp = await fetch(`/__fs/file?path=${encodeURIComponent(sel.path)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buffer = await resp.arrayBuffer();
          model = parseGlb(buffer, MODEL_RULER_HEIGHT_M);
          previewCache.set(sel.path, model);
        }
        const bmp = model.image === null ? null : await decodeTexture(model.image, sel.path);
        await assetPreview?.load(model, bmp);
      } catch (err) {
        console.error('[资产库] 预览解析失败', sel.path, err);
      }
    }

    const assets = new AssetBrowser(dockEl, {
      onSelect: (sel) => {
        if (sel === null) {
          inspector.clear();
          assetPreview?.clear();
        } else {
          inspector.showAsset(sel);
          switchInspectorTab('asset');
          void previewAsset(sel);
        }
      },
      onSpawn: (p) => void spawnAssetAt(p, null),
      // 右键条目 → 统一菜单（与层级面板共用一套 DOM）。只有 .glb 才给「进入绑定」
      onContextMenu: (path, entry, x, y) => {
        const isGlb = entry.kind === 'file' && entry.ext.toLowerCase() === '.glb';
        openCtxMenu(x, y, [
          {
            label: isGlb ? '进入绑定 Binding…' : '进入绑定 Binding…（仅 .glb）',
            disabled: !isGlb,
            run: () => void bindAssetAt(path),
          },
          {
            label: isGlb ? '载入场景 Spawn' : '载入场景 Spawn（仅 .glb）',
            disabled: !isGlb,
            run: () => void spawnAssetAt(path, null),
          },
        ]);
      },
    });

    // 画布接收资产拖放：落点 = 视线与地面 y=0 的交点（落不出地面就退回原点）
    canvas.addEventListener('dragover', (e) => {
      if (e.dataTransfer !== null && e.dataTransfer.types.includes(ASSET_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    canvas.addEventListener('drop', (e) => {
      const rel = e.dataTransfer?.getData(ASSET_MIME);
      if (rel === undefined || rel === '') return;
      e.preventDefault();
      if (!rel.toLowerCase().endsWith('.glb')) {
        panel.setModelInfo('只有 .glb 模型能拖入场景（其他资产在右侧 Inspector 里预览）');
        hudDirty = true;
        return;
      }
      let pos: [number, number, number] = [0, 0, 0];
      const ray = renderer.pointerRay(e.clientX, e.clientY);
      if (ray !== null && ray.d[1] < -1e-4) {
        const t = -ray.o[1] / ray.d[1];
        pos = [
          clamp(ray.o[0] + ray.d[0] * t, -PAN_LIMIT_XZ, PAN_LIMIT_XZ),
          0,
          clamp(ray.o[2] + ray.d[2] * t, -PAN_LIMIT_XZ, PAN_LIMIT_XZ),
        ];
      }
      void spawnAssetAt(rel, pos);
    });

    // 自动化钩子扩展：无头 CDP 验证直接驱动资产库
    const hook = (window as unknown as { __editor: Record<string, unknown> }).__editor;
    hook.assets = assets;
    hook.inspector = inspector;
    hook.preview = assetPreview;
    hook.previewShow = (p: string) => {
      const base = p.split('/').pop() ?? p;
      const dot = base.lastIndexOf('.');
      const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
      void previewAsset({
        entry: { name: base, kind: 'file', size: 0, mtime: 0, ext },
        path: p,
      });
    };
    hook.spawnAsset = (p: string, pos?: [number, number, number]) => void spawnAssetAt(p, pos ?? null);
    // 无头冒烟 / 自动化钩子需要直接摸到渲染器（对象列表、字符槽），否则
    // 只能绕 UI 后门。renderer 是模块级单例，这里挂一次即可。
    hook.renderer = renderer;

    // 主视图骨骼 X-ray 开关（gizmo-bar 上的「骨骼 X」按钮）
    const xrayBtn = document.querySelector<HTMLButtonElement>('#gizmo-bar .gz-xray');
    if (xrayBtn !== null) {
      xrayBtn.addEventListener('click', () => {
        const on = !xrayBtn.classList.contains('active');
        xrayBtn.classList.toggle('active', on);
        assetPreview?.setSkeletonVisible(on);
        renderer.setSkeletonVisible(on);
      });
    }
  }

  // ---- 尺寸 ----
  const resize = (): void => {
    renderer.resize(
      Math.max(1, Math.round(canvas.clientWidth * dpr())),
      Math.max(1, Math.round(canvas.clientHeight * dpr())),
    );
    hudDirty = true;
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---- HUD ----
  const updateHud = (fps: number): void => {
    const p = panel.params;
    const s = renderer.stats;
    const gap = Math.abs(p.keyElevation - p.cameraElevation);
    const name = DEBUG_OPTIONS.find((o) => o.value === p.debugMode)?.label ?? '';

    const rows: string[] = [
      `<b>FPS</b> ${fps.toFixed(0)}`,
      `<b>画布</b> ${s.width}×${s.height}`,
      `<b>Draw</b> ${s.drawCalls}　<b>Tri</b> ${(s.triangles / 1000).toFixed(1)}k`,
      `<b>顶面 NdotL</b> ${Math.sin((p.keyElevation * Math.PI) / 180).toFixed(2)}　` +
        `<b>立面</b> ${frontNdotL(p, camera).toFixed(2)}`,
      `<b>视图</b> ${name}`,
      `<b>GPU</b> ${gpu.info.vendor || '?'} ${gpu.info.architecture || ''}`,
    ];

    const selName = renderer.selectedName();
    const subName = renderer.selectedSubName();
    if (selName !== null) {
      rows.push(
        `<b>选中</b> <span style="color:#FFC531;font-weight:700">${selName}` +
          `${subName !== null ? ` › ${subName}` : ''}</span>` +
          `　<span class="hint">拖 gizmo 手柄变换 · 双击/F 聚焦 · Delete 删除 · 顶部工具栏或 W/E/R 切换</span>`,
      );
    } else {
      rows.push('<b>选中</b> 无（轻点选中 · Alt+点击穿透嵌套 · 双击/F 聚焦 · 拖拽/单指环绕 · 右键/双指平移 · 滚轮/捏合缩放）');
    }

    if (gap < 15) {
      rows.push(
        `<span class="warn">⚠ 主光与视线夹角仅 ${gap.toFixed(0)}°，角色会平成一整块色</span>`,
      );
    }
    if (p.rimIntensity < 0.2 && p.keyIntensity < 0.8) {
      rows.push('<span class="warn">⚠ 暗场 + rim 不足：深色敌人会消失在背景里</span>');
    }
    if (p.halftoneStrength > 0.25) {
      rows.push('<span class="warn">⚠ 半调强度 &gt; 0.25，会从印刷质感变成波普艺术</span>');
    }

    hud.innerHTML = rows.join('<br>');
  };

  // ---- 主循环 ----
  // HMR 会整页替换这个模块。旧模块的 requestAnimationFrame 链不会自动停，
  // 不主动断掉就会在已 destroy 的渲染器上继续 render → 每帧抛错刷屏。
  let disposed = false;
  if (import.meta.hot !== undefined) {
    import.meta.hot.dispose(() => {
      disposed = true;
      renderer.destroy();
    });
  }

  let fps = 60;
  let frames = 0;
  let hudTimer = 0;
  let elapsed = 0;
  let last = performance.now();

  const frame = (now: number): void => {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    elapsed += dt;
    frames++;
    hudTimer += dt;

    if (hudTimer > 0.4 || hudDirty) {
      if (hudTimer > 0.001) fps = frames / hudTimer;
      frames = 0;
      hudTimer = 0;
      hudDirty = false;
      updateHud(fps);
    }

    if (panel.params.autoOrbit) {
      camera.yaw += dt * 0.25;
      hudDirty = true;
    }

    // 聚焦动画：easeOutCubic 平滑过渡 target 与 distance
    if (focusAnim !== null) {
      focusAnim.t += dt;
      const k = Math.min(1, focusAnim.t / focusAnim.dur);
      const e = 1 - Math.pow(1 - k, 3);
      camera.target[0] = lerp(focusAnim.fromT[0], focusAnim.toT[0], e);
      camera.target[1] = lerp(focusAnim.fromT[1], focusAnim.toT[1], e);
      camera.target[2] = lerp(focusAnim.fromT[2], focusAnim.toT[2], e);
      camera.distance = lerp(focusAnim.fromD, focusAnim.toD, e);
      hudDirty = true;
      if (k >= 1) focusAnim = null;
    }

    renderer.render(panel.params, camera, elapsed, dpr());
    panel.tickAnimation();
    assetPreview?.tick(dt, elapsed, panel.params);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}

void boot().catch((err: unknown) => {
  showFatal('启动异常', `<p>${String(err)}</p>`);
});
