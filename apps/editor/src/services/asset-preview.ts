/**
 * AssetPreview —— 资产库右侧「Asset Preview Pane」的 3D 预览 + 动画播放 + Timeline。
 *
 * 架构定位（ADR-001 / ADR-005）：本类与 LabRenderer 平级，都是**游戏引擎的消费者**，
 * 不内嵌任何渲染逻辑 —— 全部通过 @aether/render（RendererCore / 装箱 / 蒙皮）+ @aether/scene
 * （几何 / glTF）完成。它独占一个 RendererCore 实例（绑定预览画布），与主视图的
 * RendererCore 互不干扰（多画布由 renderer-core 的独占 context 支持）。
 *
 * 行为：
 *   - 选中带骨骼/动画的 GLB → 解析出的 MeshData 建 GPU 资源 + SkinState，自动播放首段。
 *   - 普通 GLB → 同样 3D 预览，但无 Timeline / 骨骼开关（没有可播的动画）。
 *   - 每帧（由主循环 tick 驱动）推进蒙皮、装箱 uniform、构造 RenderFrameInput 并 drawFrame。
 *   - Timeline 实时反映 当前片段 / 播放头 / 时长；支持 播放暂停 / 循环 / 速率 / 片段切换 / 拖动 seek。
 *   - 骨骼 X-ray 开关：开启时把骨骼以 line-list 透视网格画在最上层。
 */

import type { GpuContext } from '@aether/gfx';
import {
  RendererCore,
  type CoreObjectDraw,
  type CoreSubMeshDraw,
  type RenderFrameInput,
  type CoreSkeletonOverlay,
  type MaterialState,
  packFrameUniforms,
  packMaterial,
  createSkinState,
  evalJointMatrices,
  advance,
  clipNames,
  currentClip,
  clipCount,
  selectClip,
  play,
  pause,
  setLoop,
  setSpeed,
  seek,
  type SkinState,
  FRAME_FLOATS,
  LIGHTS_FLOATS,
  TOON_FLOATS,
  POST_FLOATS,
  SLOT_FLOATS,
} from '@aether/render';
import { packSkin, type SkeletonData, type GltfResult } from '@aether/scene';
import * as m4 from '@aether/core';
import type { LabParams } from '../params';
import { defaultParams } from '../params';
import { buildSkeletonPositions } from './skeleton-overlay';

/**
 * 预览物体默认材质（bone 平色）。不再带漫画描边 —— Asset Library 预览一律用
 * 「普通灯光」渲染（见 PREVIEW_PARAMS），所以 outlineScale 归 0，让没贴图的模型
 * 也只是一个平滑受光的普通 3D 材质，而不是场景里的卡通描边质感。
 */
const PREVIEW_MATERIAL: MaterialState = {
  albedo: '#FFF6E2',
  roughness: 0.85,
  metallic: 0,
  emissiveColor: '#000000',
  emissiveStrength: 0,
  shadowEnd: -1,
  specMix: -1,
  softnessScale: 1,
  halftoneScale: 1,
  outlineScale: 0,
  unlit: false,
};

/**
 * 预览用的「普通灯光」配置：继承项目默认灯光（key/fill/ambient/rim 三点光，
 * 即正常 3D 模型浏览器的受光），但**关闭场景的卡通预制**——
 * 描边 / 半调网点 / 三段 Grading 全部禁用，并把 toon 分阶阈值拉平
 * （shadowEnd=0、shadowMult=1、shadowMix=0、*Sat=1、specMix=0），
 * 让材质按平滑 NdotL 受光，而非卡通分阶 + 墨线描边的「预制效果」。
 *
 * 模块级一次性构造：不与场景 params 耦合，Asset Library 里的预览永远是
 * 一致的普通打光，不随主视图的卡通调试预设漂移。
 */
const PREVIEW_PARAMS: LabParams = (() => {
  const p = defaultParams();
  p.outlineEnabled = false;
  p.halftoneEnabled = false;
  p.gradeEnabled = false;
  p.bloomEnabled = false;
  // 拉平分阶：几乎无暗部带 + 不染色 → 平滑受光的普通材质
  p.shadowEnd = 0;
  p.shadowMult = 1;
  p.shadowMix = 0;
  p.shadowSat = 1;
  p.litSat = 1;
  p.specMix = 0;
  return p;
})();

/** 骨骼 X-ray 颜色（尸绿，与主视图高亮区分） */
const SKELETON_COLOR: [number, number, number] = [0.56, 0.82, 0.31];

interface PreviewObject {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  skinVb: GPUBuffer | null;
  skinBuffer: GPUBuffer | null;
  skinCount: number;
  skinScratch: Float32Array;
  bindGroup: GPUBindGroup | null;
  texture: GPUTexture;
  ownsTexture: boolean;
  skeleton: SkeletonData | null;
  skinState: SkinState | null;
  modelMatrix: m4.Mat4;
  center: [number, number, number];
  radius: number;
}

export class AssetPreview {
  private readonly gpu: GpuContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly core: RendererCore;
  private readonly panel: HTMLElement;

  // 帧 uniform 复用的 CPU 侧缓冲（尺寸与引擎 layout 常量一致）
  private readonly frameData = new Float32Array(FRAME_FLOATS);
  private readonly lightsData = new Float32Array(LIGHTS_FLOATS);
  private readonly toonData = new Float32Array(TOON_FLOATS);
  private readonly postData = new Float32Array(POST_FLOATS);
  private readonly materialData = new Float32Array(SLOT_FLOATS);
  private readonly transformData = new Float32Array(SLOT_FLOATS);

  private obj: PreviewObject | null = null;
  private dpr = 1;

  // 相机（预览支持 orbit/pan/zoom 导航，见 wireNavigation；target/distance 按模型包围盒自适应）
  private readonly camera = { yaw: 0.4, distance: 4.5, target: [0, 1, 0] as [number, number, number] };
  private elevation = 18; // 相机俯仰角（度），导航可改；默认 18° 略俯视

  // 骨骼 X-ray
  private skeletonVisible = false;

  // ---- Timeline DOM 引用 ----
  private btnPlay!: HTMLButtonElement;
  private chkLoop!: HTMLInputElement;
  private selClip!: HTMLSelectElement;
  private selSpeed!: HTMLSelectElement;
  private scrub!: HTMLInputElement;
  private lblTime!: HTMLElement;
  private lastClipCount = -1;
  private scrubbing = false;

  constructor(previewEl: HTMLElement, gpu: GpuContext) {
    this.gpu = gpu;

    // 预览画布（独占，与主画布无关）
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ap-canvas';
    previewEl.appendChild(this.canvas);

    // 控制面板（Timeline + 开关）
    this.panel = document.createElement('div');
    this.panel.className = 'ap-panel';
    this.panel.innerHTML = `
      <div class="ap-bar">
        <button class="ap-play" title="播放 / 暂停">▶</button>
        <label class="ap-loop"><input type="checkbox" checked> 循环</label>
        <select class="ap-clip" title="动画片段"></select>
        <select class="ap-speed" title="播放速率">
          <option value="0.25">0.25×</option>
          <option value="0.5">0.5×</option>
          <option value="1" selected>1×</option>
          <option value="2">2×</option>
        </select>
        <button class="ap-xray" title="骨骼 X-ray 叠加">骨骼</button>
      </div>
      <input type="range" class="ap-scrub" min="0" max="1" step="0.001" value="0" disabled>
      <div class="ap-time"><span class="ap-t">0.00</span> / <span class="ap-d">0.00</span> s</div>`;
    previewEl.appendChild(this.panel);

    this.btnPlay = this.panel.querySelector('.ap-play')!;
    this.chkLoop = this.panel.querySelector('.ap-loop input')!;
    this.selClip = this.panel.querySelector('.ap-clip')!;
    this.selSpeed = this.panel.querySelector('.ap-speed')!;
    this.scrub = this.panel.querySelector('.ap-scrub')!;
    this.lblTime = this.panel.querySelector('.ap-time')!;

    this.core = new RendererCore(gpu, this.canvas);

    this.wireControls();
    this.wireNavigation();
    this.showEmpty();

    // 预览画布尺寸跟随容器
    const ro = new ResizeObserver(() => this.syncSize());
    ro.observe(previewEl);
    this.syncSize();

    // 自动化钩子
    (window as unknown as { __editor: Record<string, unknown> }).__editor.preview = this;
  }

  /** 容器尺寸变化 → 物理像素同步到 core（dpr 夹到 2） */
  private syncSize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.core.resize(Math.round(w * this.dpr), Math.round(h * this.dpr));
  }

  /** 未载入模型时的占位态 */
  private showEmpty(): void {
    this.canvas.style.display = 'none';
    this.panel.style.display = 'none';
  }

  /** 隐藏预览（选中非 GLB 资产或清空选择时调用） */
  clear(): void {
    this.releaseObject();
    this.showEmpty();
  }

  /** 载入一个已解析的 GLB 模型（由 main.ts 负责 fetch + parseGlb） */
  async load(model: GltfResult, albedo: ImageBitmap | null): Promise<void> {
    this.releaseObject();

    const mesh = model.mesh;
    const device = this.gpu.device;
    const vcount = mesh.vertices.length / 15;

    const vb = device.createBuffer({
      label: 'pv-vtx',
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const ib = device.createBuffer({
      label: 'pv-idx',
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vb, 0, mesh.vertices);
    device.queue.writeBuffer(ib, 0, mesh.indices);

    const skeleton = model.skeleton;
    const animations = model.animations;
    const skinned = mesh.joints !== null && mesh.weights !== null;
    const nJoints = skeleton !== null ? skeleton.joints.length : 0;
    const skinCount = skinned ? nJoints + 1 : 1;

    const skinBuffer = device.createBuffer({
      label: 'pv-skin',
      size: skinCount * 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const idInit = new Float32Array(skinCount * 16);
    for (let k = 0; k < skinCount; k++) {
      idInit[k * 16] = 1;
      idInit[k * 16 + 5] = 1;
      idInit[k * 16 + 10] = 1;
      idInit[k * 16 + 15] = 1;
    }
    device.queue.writeBuffer(skinBuffer, 0, idInit);

    const skinVb = device.createBuffer({
      label: 'pv-skin-vb',
      size: Math.max(24, vcount * 24),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(skinVb, 0, packSkin(mesh.joints ?? null, mesh.weights ?? null, vcount));

    const skinState = skeleton !== null ? createSkinState(skeleton, animations) : null;

    // 包围盒（顶点级，廉价）用于相机取景
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < mesh.vertices.length; i += 15) {
      const x = mesh.vertices[i]!, y = mesh.vertices[i + 1]!, z = mesh.vertices[i + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const center: [number, number, number] = [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
    ];
    const radius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;

    const obj: PreviewObject = {
      vertexBuffer: vb,
      indexBuffer: ib,
      indexCount: mesh.indices.length,
      skinVb,
      skinBuffer,
      skinCount,
      skinScratch: new Float32Array(skinCount * 16),
      bindGroup: null,
      texture: this.gpuWhite(),
      ownsTexture: false,
      skeleton,
      skinState,
      modelMatrix: m4.mat4(),
      center,
      radius,
    };

    this.obj = obj;
    this.rebuildBindGroup();
    if (albedo !== null) this.setAlbedo(albedo);

    // 相机取景：适配包围球，留 1.6 倍余量
    const fov = (45 * Math.PI) / 180;
    this.camera.target = [center[0], center[1], center[2]];
    this.camera.distance = Math.min(40, Math.max(1.5, (radius / Math.tan(fov / 2)) * 1.6));

    // 复位 Timeline 状态
    this.lastClipCount = -1;
    this.scrubbing = false;
    if (skinState !== null) {
      // 自动播放首段
      play(skinState);
    }

    this.canvas.style.display = 'block';
    this.panel.style.display = 'block';
    this.syncSize();
  }

  /** 1×1 白图（无贴图时平色预览用） */
  private whiteTex: GPUTexture | null = null;
  private gpuWhite(): GPUTexture {
    if (this.whiteTex !== null) return this.whiteTex;
    const t = this.gpu.device.createTexture({
      label: 'pv-white',
      size: [1, 1],
      format: 'rgba8unorm',
      // ⚠️ 必须用 GPUTextureUsage.COPY_DST（0x2）；GPUBufferUsage.COPY_DST 是 0x8，
      // 套到纹理 usage 上会变成 STORAGE_BINDING，writeTexture 会因缺 COPY_DST 报错。
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.gpu.device.queue.writeTexture({ texture: t }, new Uint8Array([245, 231, 200, 255]), {}, [1, 1]);
    this.whiteTex = t;
    return t;
  }

  /** 用解码后的 albedo 替换预览贴图（带贴图时更有辨识度） */
  private setAlbedo(bitmap: ImageBitmap): void {
    if (this.obj === null) {
      bitmap.close();
      return;
    }
    const tex = this.gpu.device.createTexture({
      label: 'pv-albedo',
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.gpu.device.queue.copyExternalImageToTexture(
      { source: bitmap, flipY: false },
      { texture: tex },
      { width: bitmap.width, height: bitmap.height },
    );
    bitmap.close();
    if (this.obj.ownsTexture) this.obj.texture.destroy();
    this.obj.texture = tex;
    this.obj.ownsTexture = true;
    this.rebuildBindGroup();
  }

  private rebuildBindGroup(): void {
    const o = this.obj;
    if (o === null) return;
    o.bindGroup = this.gpu.device.createBindGroup({
      label: 'pv-obj',
      layout: this.core.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.core.frameBuf } },
        { binding: 1, resource: { buffer: this.core.lightsBuf } },
        { binding: 2, resource: { buffer: this.core.toonBuf } },
        { binding: 3, resource: { buffer: this.core.materialBuf, offset: 0, size: 80 } },
        { binding: 4, resource: { buffer: this.core.transformBuf, offset: 0, size: 64 } },
        { binding: 5, resource: o.texture.createView() },
        { binding: 6, resource: this.core.sampler },
        {
          binding: 7,
          resource: { buffer: o.skinBuffer!, offset: 0, size: o.skinCount * 64 },
        },
      ],
    });
  }

  private releaseObject(): void {
    const o = this.obj;
    if (o === null) return;
    o.vertexBuffer.destroy();
    o.indexBuffer.destroy();
    o.skinVb?.destroy();
    o.skinBuffer?.destroy();
    if (o.ownsTexture) o.texture.destroy();
    this.obj = null;
  }

  // ===================== Timeline 控制 =====================

  private wireControls(): void {
    this.btnPlay.addEventListener('click', () => {
      const s = this.obj?.skinState;
      if (s === null || s === undefined) return;
      if (s.playing) pause(s);
      else play(s);
    });
    this.chkLoop.addEventListener('change', () => {
      const s = this.obj?.skinState;
      if (s !== null && s !== undefined) setLoop(s, this.chkLoop.checked);
    });
    this.selClip.addEventListener('change', () => {
      const s = this.obj?.skinState;
      if (s === null || s === undefined) return;
      const idx = parseInt(this.selClip.value, 10);
      if (!Number.isNaN(idx)) {
        selectClip(s, idx);
        play(s);
      }
    });
    this.selSpeed.addEventListener('change', () => {
      const s = this.obj?.skinState;
      if (s !== null && s !== undefined) setSpeed(s, parseFloat(this.selSpeed.value));
    });
    this.scrub.addEventListener('pointerdown', () => {
      this.scrubbing = true;
    });
    const endScrub = (): void => {
      this.scrubbing = false;
    };
    this.scrub.addEventListener('pointerup', endScrub);
    this.scrub.addEventListener('change', endScrub);
    this.scrub.addEventListener('input', () => {
      const s = this.obj?.skinState;
      if (s === null || s === undefined) return;
      seek(s, parseFloat(this.scrub.value));
    });
    const xray = this.panel.querySelector<HTMLButtonElement>('.ap-xray')!;
    xray.addEventListener('click', () => {
      this.skeletonVisible = !this.skeletonVisible;
      xray.classList.toggle('active', this.skeletonVisible);
    });
  }

  setSkeletonVisible(v: boolean): void {
    this.skeletonVisible = v;
    this.panel.querySelector('.ap-xray')?.classList.toggle('active', v);
  }

  // ===================== 预览画布导航（与主视图同手感） =====================
  // 左键拖=环绕(orbit yaw+俯仰)，右键/中键/Shift+左键拖=平移(pan target)，
  // 滚轮/双指=缩放(distance)。与主视图 main.ts 的相机交互一一对应，只是省略拾取/gizmo。

  private wireNavigation(): void {
    const canvas = this.canvas;
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

    const FOVY = (45 * Math.PI) / 180; // 与 renderer 的 perspective 一致
    const ORBIT_RAD_PER_PX = 0.006; // 环绕灵敏度：每像素弧度
    const PITCH_DEG_PER_PX = 0.25; // 俯仰灵敏度：每像素度
    const PITCH_LIMIT_DEG = 89; // 俯仰上限（留 1° 防 lookAt 退化）
    const ZOOM_MIN = 1;
    const ZOOM_MAX = 80;
    const PAN_MIN_Y = -5;
    const PAN_MAX_Y = 20;

    const pointers = new Map<number, { x: number; y: number }>();
    let gesture: 'orbit' | 'pan' | 'pinch' = 'orbit';
    let lastX = 0;
    let lastY = 0;
    let pinchDist = 0;

    // 屏幕位移 → target 世界位移：一像素对应的世界尺寸随距离/视高变化，
    // 平移手感是「内容跟着手指走」。相机基与主视图同约定。
    const panBy = (dx: number, dy: number): void => {
      const el = (this.elevation * Math.PI) / 180;
      const se = Math.sin(el);
      const ce = Math.cos(el);
      const sy = Math.sin(this.camera.yaw);
      const cy = Math.cos(this.camera.yaw);
      const worldPerPx =
        (2 * this.camera.distance * Math.tan(FOVY / 2)) / Math.max(1, canvas.clientHeight);
      const lim = (this.obj?.radius ?? 2) * 6;
      this.camera.target[0] = clamp(
        this.camera.target[0] + (-cy * dx - sy * se * dy) * worldPerPx,
        -lim,
        lim,
      );
      this.camera.target[1] = clamp(this.camera.target[1] + ce * dy * worldPerPx, PAN_MIN_Y, PAN_MAX_Y);
      this.camera.target[2] = clamp(
        this.camera.target[2] + (sy * dx - cy * se * dy) * worldPerPx,
        -lim,
        lim,
      );
    };
    const zoomBy = (factor: number): void => {
      this.camera.distance = clamp(this.camera.distance * factor, ZOOM_MIN, ZOOM_MAX);
    };

    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        gesture = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
        lastX = e.clientX;
        lastY = e.clientY;
      } else if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const a = pts[0]!;
        const b = pts[1]!;
        pinchDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        lastX = (a.x + b.x) / 2;
        lastY = (a.y + b.y) / 2;
        gesture = 'pinch';
      }
    });

    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      const pt = pointers.get(e.pointerId);
      if (pt === undefined) return;
      pt.x = e.clientX;
      pt.y = e.clientY;
      if (pointers.size === 1) {
        if (gesture === 'orbit') {
          this.camera.yaw -= (e.clientX - lastX) * ORBIT_RAD_PER_PX;
          // 自由俯仰：上下拖可越过地平线（负=仰视，eye 在 target 之下）
          this.elevation = clamp(
            this.elevation + (e.clientY - lastY) * PITCH_DEG_PER_PX,
            -PITCH_LIMIT_DEG,
            PITCH_LIMIT_DEG,
          );
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
      pointers.delete(e.pointerId);
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (pointers.size === 1) {
        // 双指抬起一根：用剩下那根重新锚定，视角不跳变
        const rest = [...pointers.values()][0]!;
        lastX = rest.x;
        lastY = rest.y;
        gesture = 'orbit';
      }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // 右键留给平移
    canvas.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        zoomBy(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
  }

  // ===================== 每帧驱动（由 main 循环调用） =====================

  // 预览用「普通灯光」：不接场景卡通预设，固定用 PREVIEW_PARAMS（见文件顶部）。
  // 保留 _sceneParams 形参以兼容主循环调用，但预览的打光与它解耦。
  tick(dt: number, time: number, _sceneParams: LabParams): void {
    const o = this.obj;
    if (o === null) return;

    // 装箱灯光 / toon / 后处理：用 PREVIEW_PARAMS（普通灯光，关闭卡通分阶/描边/半调/grading）
    packFrameUniforms({
      lights: this.lightsData,
      toon: this.toonData,
      post: this.postData,
      params: PREVIEW_PARAMS,
      time,
      width: this.core.width,
      height: this.core.height,
    });

    // 材质（平色 bone + 描边）
    packMaterial(this.materialData, 0, PREVIEW_MATERIAL);
    // 变换（预览物体置于原点、单位缩放）
    this.transformData.set(o.modelMatrix, 0);

    // 蒙皮推进 + 求值（即使暂停也求值，保证拖动 seek 实时更新姿态）
    if (o.skinState !== null && o.skinBuffer !== null) {
      advance(o.skinState, dt);
      evalJointMatrices(o.skinState, o.skinScratch);
      this.gpu.device.queue.writeBuffer(o.skinBuffer, 0, o.skinScratch);
    }

    // 上传材质 / 变换
    this.gpu.device.queue.writeBuffer(this.core.materialBuf, 0, this.materialData);
    this.gpu.device.queue.writeBuffer(this.core.transformBuf, 0, this.transformData);

    const isAnim = o.skinState !== null;
    const sub: CoreSubMeshDraw = {
      indexStart: 0,
      indexCount: o.indexCount,
      visible: true,
      bindGroup: o.bindGroup ?? undefined,
      outline: PREVIEW_MATERIAL.outlineScale > 0.001,
    };
    const objects: CoreObjectDraw[] = [
      {
        vertexBuffer: o.vertexBuffer,
        skinVb: o.skinVb,
        indexBuffer: o.indexBuffer,
        visible: true,
        subMeshes: [sub],
      },
    ];

    // 骨骼 X-ray 叠加
    let skeleton: CoreSkeletonOverlay | null = null;
    if (this.skeletonVisible && o.skeleton !== null) {
      skeleton = {
        positions: buildSkeletonPositions(o.skinScratch, o.skeleton, o.modelMatrix),
        color: SKELETON_COLOR,
      };
    }

    const input: RenderFrameInput = {
      p: {
        outlineEnabled: false,
        debugMode: 0,
        cameraElevation: this.elevation,
        // 资产预览恒为透视（正交只给绑定面板的正/侧视用）
        orthoHalfHeight: null,
      },
      camera: { target: this.camera.target, distance: this.camera.distance, yaw: this.camera.yaw },
      time,
      dpr: this.dpr,
      uniforms: {
        frame: this.frameData,
        lights: this.lightsData,
        toon: this.toonData,
        post: this.postData,
        material: this.materialData,
        transform: this.transformData,
        primaryToon: this.toonData,
        primaryMat: this.materialData,
        secondaryToon: this.toonData,
        secondaryMat: this.materialData,
      },
      objects,
      highlight: { primary: null, secondary: null },
      gizmo: null,
      skeleton,
      // 资产预览不画蒙皮包裹器（那是主视图绑定工作流的事）
      cylinders: null,
      stats: { drawCalls: 0 },
    };
    this.core.drawFrame(input);

    this.updateTimelineDom(isAnim);
  }

  private updateTimelineDom(isAnim: boolean): void {
    const s = this.obj?.skinState ?? null;
    if (s === null) {
      // 无动画：隐藏 Timeline 控件，仅留 3D 预览
      this.panel.style.display = 'block';
      this.btnPlay.style.visibility = 'hidden';
      this.chkLoop.style.visibility = 'hidden';
      this.selClip.style.visibility = 'hidden';
      this.selSpeed.style.visibility = 'hidden';
      this.scrub.style.visibility = 'hidden';
      this.lblTime.style.visibility = 'hidden';
      return;
    }
    this.btnPlay.style.visibility = 'visible';
    this.chkLoop.style.visibility = 'visible';
    this.selClip.style.visibility = 'visible';
    this.selSpeed.style.visibility = 'visible';
    this.scrub.style.visibility = 'visible';
    this.lblTime.style.visibility = 'visible';

    // 片段下拉：仅在数量变化时重建
    const n = clipCount(s);
    if (n !== this.lastClipCount) {
      this.selClip.innerHTML = '';
      const names = clipNames(s);
      for (let i = 0; i < names.length; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = names[i]!;
        this.selClip.appendChild(opt);
      }
      this.lastClipCount = n;
    }
    this.selClip.value = String(Math.max(0, currentClip(s)));

    const dur = s.clip >= 0 ? s.clips[s.clip]!.duration : 0;
    this.btnPlay.textContent = s.playing ? '⏸' : '▶';
    this.chkLoop.checked = s.loop;
    this.scrub.disabled = false;
    this.scrub.max = String(dur > 0 ? dur : 1);
    if (!this.scrubbing) this.scrub.value = String(s.time);
    this.lblTime.innerHTML = `<span class="ap-t">${s.time.toFixed(2)}</span> / <span class="ap-d">${dur.toFixed(2)}</span> s`;
  }

  /** 自动化/调试用：当前预览状态快照 */
  getState(): Record<string, unknown> {
    const s = this.obj?.skinState ?? null;
    return {
      hasObject: this.obj !== null,
      isAnim: s !== null,
      playing: s?.playing ?? false,
      time: s?.time ?? 0,
      duration: s !== null && s.clip >= 0 ? s.clips[s.clip]!.duration : 0,
      clip: s !== null ? currentClip(s) : -1,
      skeletonVisible: this.skeletonVisible,
    };
  }

  destroy(): void {
    this.releaseObject();
    this.whiteTex?.destroy();
    this.whiteTex = null;
    this.core.destroy();
  }
}
