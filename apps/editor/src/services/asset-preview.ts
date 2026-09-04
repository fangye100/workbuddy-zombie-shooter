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
import { buildSkeletonPositions } from './skeleton-overlay';

/** 预览物体默认材质（bone 平色 + 描边），让没贴图的模型也有漫画描边质感 */
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
  outlineScale: 1,
  unlit: false,
};

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

  // 相机（预览用固定 18° 俯角；target/distance 按模型包围盒自适应）
  private readonly camera = { yaw: 0.4, distance: 4.5, target: [0, 1, 0] as [number, number, number] };
  private static readonly ELEVATION = 18;

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

  // ===================== 每帧驱动（由 main 循环调用） =====================

  tick(dt: number, time: number, params: LabParams): void {
    const o = this.obj;
    if (o === null) return;

    // 装箱灯光 / toon / 后处理（与主视图同套 UI 参数，光照一致）
    packFrameUniforms({
      lights: this.lightsData,
      toon: this.toonData,
      post: this.postData,
      params,
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
        outlineEnabled: true,
        debugMode: 0,
        cameraElevation: AssetPreview.ELEVATION,
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
