/**
 * RendererCore —— Game Editor 的引擎帧绘制核心（packages/render）。
 *
 * 与 ADR-001 一致：编辑器是消费者，本类只负责「持有 GPU 资源 + 把一份
 * 已经完全解析好的帧描述（RenderFrameInput）编码成 4 个 WebGPU pass」。
 * 它不认识任何编辑器概念（选中 / 层级 / 材质槽 / gizmo 模式），
 * 这些语义都由调用方（LabRenderer）在构造 RenderFrameInput 时已经物化。
 *
 * Pass 顺序（与 docs/07 §4.4 一致）：
 *   1. scene   MRT → hdr(rgba16float) + aux(rgba16float, a = 描边 mask)
 *   2. outline inverted hull，cullMode front，只画轮廓外圈
 *   3. post    全屏：bloom → exposure → tonemap → sRGB → 半调 → grading → 暗角
 *   4. gizmo   Transform Gizmo（无深度，绘于 swapchain 之上）
 */

import type { GpuContext } from '@aether/gfx';
import * as m4 from '@aether/core';
import { VERTEX_LAYOUT, SKIN_LAYOUT } from '@aether/scene';
import { SCENE_WGSL } from './shaders/scene.wgsl';
import { POST_WGSL } from './shaders/post.wgsl';
import { GIZMO_WGSL } from './shaders/gizmo.wgsl';
import { buildGizmoHandles, type GizmoMode } from './gizmo';

export type RenderGizmoMode = GizmoMode;

/** 帧绘制所需的相机子集（引擎只关心这三项） */
export interface RenderCamera {
  target: readonly [number, number, number];
  distance: number;
  yaw: number;
}

/** 帧绘制所需的参数子集（引擎只关心这几项） */
export interface RenderFrameParams {
  outlineEnabled: boolean;
  debugMode: number;
  cameraElevation: number;
}

/** 单个子网格的绘制描述（bind group 已由调用方解析好） */
export interface CoreSubMeshDraw {
  indexStart: number;
  indexCount: number;
  visible: boolean;
  /** 该子网格的 scene bind group（材质槽 + 变换槽均已装箱） */
  bindGroup: GPUBindGroup | undefined;
  /** 是否画 inverted-hull 描边（= 生效材质的 outlineScale > 0.001） */
  outline: boolean;
}

/** 单个物体的绘制描述 */
export interface CoreObjectDraw {
  vertexBuffer: GPUBuffer;
  /** 蒙皮顶点缓冲；非蒙皮物体为 null（调用方已与原始语义一致传 !） */
  skinVb: GPUBuffer | null;
  indexBuffer: GPUBuffer;
  visible: boolean;
  subMeshes: CoreSubMeshDraw[];
}

/**
 * 两层高亮描边（复用 outline 管线，各带独立的 toon/material buffer）。
 *
 * 2026-09-03 L-2：字段名从 `selected` / `hovered` 中性化为 `primary` / `secondary`。
 * "hovered" 是鼠标交互语义，引擎里不该出现 —— 引擎只知道「有两层高亮要画，
 * 第一层压过第二层」。调用方（编辑器）负责把自己的 selected/hovered 状态映射过来，
 * 映射点集中在 `apps/editor/src/features/selection-outline.feature.ts` 一处。
 *
 * 优先级语义不变：同一子网格上 primary 命中时不再画 secondary。
 */
export interface CoreHighlight {
  primary: { objIndex: number; sub: number | null; bindGroup: GPUBindGroup } | null;
  secondary: { objIndex: number; sub: number | null; bindGroup: GPUBindGroup } | null;
}

/** gizmo 绘制描述（origin / quat 由调用方按 local/world 算好） */
export interface CoreGizmo {
  origin: readonly [number, number, number];
  quat: m4.Quat;
  mode: RenderGizmoMode;
  activeAxis: number | null;
}

/** 一帧的全部 CPU 端 uniform 数据（调用方填好，本类只负责上传） */
export interface CoreFrameUniforms {
  frame: Float32Array;
  lights: Float32Array;
  toon: Float32Array;
  post: Float32Array;
  material: Float32Array;
  transform: Float32Array;
  /** 第一层高亮的 toon / material（编辑器映射为「选中」） */
  primaryToon: Float32Array;
  primaryMat: Float32Array;
  /** 第二层高亮的 toon / material（编辑器映射为「悬停」，被第一层压过） */
  secondaryToon: Float32Array;
  secondaryMat: Float32Array;
}

/** drawFrame 的完整输入：一份已完全解析的帧 */
export interface RenderFrameInput {
  p: RenderFrameParams;
  camera: RenderCamera;
  time: number;
  dpr: number;
  uniforms: CoreFrameUniforms;
  objects: CoreObjectDraw[];
  highlight: CoreHighlight;
  gizmo: CoreGizmo | null;
  stats: { drawCalls: number };
}

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

// uniform 布局常量与装箱函数已归入 ./frame-uniforms（2026-09-03 L-3）：
// buffer 尺寸和写进 buffer 的字段顺序是同一件事的两半，必须放一起。
import {
  FRAME_FLOATS,
  LIGHTS_FLOATS,
  MAX_MATERIAL_SLOTS,
  MAX_OBJECTS,
  POST_FLOATS,
  SLOT_BYTES,
  TOON_FLOATS,
} from './frame-uniforms';

/** gizmo 期望在屏幕上占据的像素长度（按相机距离自动缩放，保持恒定大小） */
const GIZMO_SCREEN_PX = 90;

interface CoreGizmoHandle {
  id: string;
  mode: GizmoMode;
  axis: number;
  baseColor: [number, number, number];
  vbuf: GPUBuffer;
  ibuf: GPUBuffer;
  colorBuf: GPUBuffer;
  bindGroup: GPUBindGroup;
  indexCount: number;
}

export class RendererCore {
  readonly device: GPUDevice;
  private readonly gpu: GpuContext;
  private readonly canvas: HTMLCanvasElement;
  readonly format: GPUTextureFormat;
  readonly sampler: GPUSampler;

  // ---- 管线 / 布局 ----
  readonly sceneLayout: GPUBindGroupLayout;
  readonly postLayout: GPUBindGroupLayout;
  readonly gizmoLayout: GPUBindGroupLayout;
  readonly mainPipeline: GPURenderPipeline;
  readonly outlinePipeline: GPURenderPipeline;
  readonly postPipeline: GPURenderPipeline;
  readonly gizmoPipeline: GPURenderPipeline | null = null;

  // ---- uniform buffer（引擎拥有，调用方通过 RenderFrameInput 上传内容）----
  readonly frameBuf: GPUBuffer;
  readonly lightsBuf: GPUBuffer;
  readonly toonBuf: GPUBuffer;
  readonly postBuf: GPUBuffer;
  readonly materialBuf: GPUBuffer;
  readonly transformBuf: GPUBuffer;
  /** 两层高亮各自的 toon / material buffer（命名中性化见 CoreHighlight 注释） */
  readonly primaryToonBuf: GPUBuffer;
  readonly primaryMatBuf: GPUBuffer;
  readonly secondaryToonBuf: GPUBuffer;
  readonly secondaryMatBuf: GPUBuffer;

  // ---- gizmo 资源 ----
  private readonly gizmoModelBuf: GPUBuffer;
  private readonly gizmoHandles: CoreGizmoHandle[] = [];

  // ---- 渲染目标 ----
  private hdrTex: GPUTexture | null = null;
  private auxTex: GPUTexture | null = null;
  private depthTex: GPUTexture | null = null;
  private postBindGroup: GPUBindGroup | null = null;

  // 画布尺寸由 core 持有；编辑器通过 core.width / core.height 读取（resize 时更新）
  width = 1;
  height = 1;
  private destroyed = false;

  // ---- 逐帧复用的矩阵 / 向量（viewProj / invViewProj / eyeVec 供编辑器 gizmo 命中测试读取，故公开）----
  private readonly proj = m4.mat4();
  private readonly view = m4.mat4();
  readonly viewProj = m4.mat4();
  readonly invViewProj = m4.mat4();
  readonly eyeVec: [number, number, number] = [0, 0, 0];

  // gizmo 绘制期复用的中间量（getGizmoInfo 要读，故公开）
  readonly gizmoModel = m4.mat4();
  gizmoK = 1;
  gizmoOrigin: [number, number, number] = [0, 0, 0];
  gizmoAxes: [number, number, number][] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  private readonly gizmoColorScratch = new Float32Array([1, 1, 1, 1]);

  constructor(gpu: GpuContext, canvas: HTMLCanvasElement) {
    this.gpu = gpu;
    this.canvas = canvas;
    this.device = gpu.device;
    this.format = gpu.format;

    // ---- 场景 bind group layout ----
    const sceneModule = this.device.createShaderModule({ label: 'scene', code: SCENE_WGSL });
    this.checkModule(sceneModule);
    this.sceneLayout = this.device.createBindGroupLayout({
      label: 'scene',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        // binding 3 在 vs_outline 里也要读（mat.flags.y = 描边倍率），必须同时可见
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        // 5/6：albedo 贴图
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        // 7：关节矩阵调色板（storage 只读，仅顶点阶段用）
        { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    const targets: GPUColorTargetState[] = [{ format: HDR_FORMAT }, { format: HDR_FORMAT }];

    this.mainPipeline = this.device.createRenderPipeline({
      label: 'scene-main',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] }),
      vertex: { module: sceneModule, entryPoint: 'vs_main', buffers: [VERTEX_LAYOUT, SKIN_LAYOUT] },
      fragment: { module: sceneModule, entryPoint: 'fs_main', targets },
      primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });

    this.outlinePipeline = this.device.createRenderPipeline({
      label: 'scene-outline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] }),
      vertex: { module: sceneModule, entryPoint: 'vs_outline', buffers: [VERTEX_LAYOUT, SKIN_LAYOUT] },
      fragment: { module: sceneModule, entryPoint: 'fs_outline', targets },
      // inverted hull：只画背面，让外扩的壳只在轮廓外圈露出一条边
      primitive: { topology: 'triangle-list', cullMode: 'front', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
    });

    // 后处理与 albedo 贴图共用一个线性采样器。必须在 bind group 创建之前就位
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // ---- uniform buffer ----
    this.frameBuf = this.uniform(FRAME_FLOATS * 4, 'frame');
    this.lightsBuf = this.uniform(LIGHTS_FLOATS * 4, 'lights');
    this.toonBuf = this.uniform(TOON_FLOATS * 4, 'toon');
    this.postBuf = this.uniform(POST_FLOATS * 4, 'post');
    this.materialBuf = this.uniform(MAX_MATERIAL_SLOTS * SLOT_BYTES, 'materials');
    this.transformBuf = this.uniform(MAX_OBJECTS * SLOT_BYTES, 'transforms');
    this.primaryToonBuf = this.uniform(TOON_FLOATS * 4, 'primaryToon');
    this.primaryMatBuf = this.uniform(SLOT_BYTES, 'primaryMat');
    this.secondaryToonBuf = this.uniform(TOON_FLOATS * 4, 'secondaryToon');
    this.secondaryMatBuf = this.uniform(SLOT_BYTES, 'secondaryMat');

    // ---- 后处理 ----
    const postModule = this.device.createShaderModule({ label: 'post', code: POST_WGSL });
    this.checkModule(postModule);
    const postLayout = this.device.createBindGroupLayout({
      label: 'post',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.postLayout = postLayout;

    this.postPipeline = this.device.createRenderPipeline({
      label: 'post',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [postLayout] }),
      vertex: { module: postModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: postModule, entryPoint: 'fs_post', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });

    // ---- Transform Gizmo 管线（position-only，unlit 纯色，绘于后处理之上）----
    const gizmoModule = this.device.createShaderModule({ label: 'gizmo', code: GIZMO_WGSL });
    this.checkModule(gizmoModule);
    this.gizmoLayout = this.device.createBindGroupLayout({
      label: 'gizmo',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    // 注意：字段声明里 gizmoPipeline 初值 null，这里立即赋值（类型 GPURenderPipeline）
    this.gizmoPipeline = this.device.createRenderPipeline({
      label: 'gizmo',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.gizmoLayout] }),
      vertex: {
        module: gizmoModule,
        entryPoint: 'vs_main',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: { module: gizmoModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    this.gizmoModelBuf = this.uniform(64, 'gizmoModel');
    for (const h of buildGizmoHandles()) {
      const vbuf = this.device.createBuffer({
        label: `gizmo-${h.id}-v`,
        size: h.positions.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      const ibuf = this.device.createBuffer({
        label: `gizmo-${h.id}-i`,
        size: h.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(vbuf, 0, h.positions);
      this.device.queue.writeBuffer(ibuf, 0, h.indices);
      const colorBuf = this.uniform(16, `gizmo-${h.id}-col`);
      this.device.queue.writeBuffer(colorBuf, 0, new Float32Array([...h.color, 1]));
      const bindGroup = this.device.createBindGroup({
        label: `gizmo-${h.id}`,
        layout: this.gizmoLayout,
        entries: [
          { binding: 0, resource: { buffer: this.frameBuf } },
          { binding: 1, resource: { buffer: this.gizmoModelBuf } },
          { binding: 2, resource: { buffer: colorBuf } },
        ],
      });
      this.gizmoHandles.push({
        id: h.id,
        mode: h.mode,
        axis: h.axis,
        baseColor: h.color,
        vbuf,
        ibuf,
        colorBuf,
        bindGroup,
        indexCount: h.indices.length,
      });
    }
  }

  /** WGSL 编译错误默认只在控制台里一闪而过，这里把行号一起打出来 */
  private checkModule(module: GPUShaderModule): void {
    void module.getCompilationInfo().then((info) => {
      for (const msg of info.messages) {
        const where = `[${module.label}] ${msg.lineNum}:${msg.linePos}`;
        if (msg.type === 'error') console.error(`${where} ${msg.message}`);
        else if (msg.type === 'warning') console.warn(`${where} ${msg.message}`);
      }
    });
  }

  private uniform(size: number, label: string): GPUBuffer {
    return this.device.createBuffer({
      label,
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  resize(width: number, height: number): void {
    if (this.destroyed) return;
    if (width === this.width && height === this.height) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    this.hdrTex?.destroy();
    this.auxTex?.destroy();
    this.depthTex?.destroy();

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.hdrTex = this.device.createTexture({
      label: 'hdr',
      size: [this.width, this.height],
      format: HDR_FORMAT,
      usage,
    });
    this.auxTex = this.device.createTexture({
      label: 'aux',
      size: [this.width, this.height],
      format: HDR_FORMAT,
      usage,
    });
    this.depthTex = this.device.createTexture({
      label: 'depth',
      size: [this.width, this.height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.postBindGroup = this.device.createBindGroup({
      label: 'post',
      layout: this.postLayout,
      entries: [
        { binding: 0, resource: { buffer: this.postBuf } },
        { binding: 1, resource: this.hdrTex.createView() },
        { binding: 2, resource: this.auxTex.createView() },
        { binding: 3, resource: this.sampler },
      ],
    });
  }

  /** 把一份已解析好的帧编码成 4 个 WebGPU pass。调用方负责填充全部 uniform 数组。 */
  drawFrame(input: RenderFrameInput): void {
    if (this.destroyed) return;
    if (
      this.hdrTex === null ||
      this.auxTex === null ||
      this.depthTex === null ||
      this.postBindGroup === null
    ) {
      return;
    }

    const device = this.device;
    const p = input.p;
    const camera = input.camera;

    // 编辑器负责动画推进（dt 由 LabRenderer 算好），core 只做相机矩阵与 4-pass 编码
    const eye = m4.orbitEye(camera.target, camera.distance, camera.yaw, p.cameraElevation);

    const aspect = this.width / Math.max(1, this.height);
    const projScaleY = m4.perspective(this.proj, (45 * Math.PI) / 180, aspect, 0.1, 200);
    m4.lookAt(this.view, eye, camera.target, [0, 1, 0]);
    m4.multiply(this.viewProj, this.proj, this.view);
    m4.invert(this.invViewProj, this.viewProj);
    this.eyeVec[0] = eye[0];
    this.eyeVec[1] = eye[1];
    this.eyeVec[2] = eye[2];

    const f = input.uniforms.frame;
    f.set(this.viewProj, 0);
    f[16] = eye[0];
    f[17] = eye[1];
    f[18] = eye[2];
    f[19] = input.time;
    f[20] = this.width;
    f[21] = projScaleY;
    f[22] = this.height;
    f[23] = input.dpr;

    const u = input.uniforms;
    device.queue.writeBuffer(this.frameBuf, 0, u.frame);
    device.queue.writeBuffer(this.lightsBuf, 0, u.lights);
    device.queue.writeBuffer(this.toonBuf, 0, u.toon);
    device.queue.writeBuffer(this.postBuf, 0, u.post);
    device.queue.writeBuffer(this.materialBuf, 0, u.material);
    device.queue.writeBuffer(this.transformBuf, 0, u.transform);
    device.queue.writeBuffer(this.primaryToonBuf, 0, u.primaryToon);
    device.queue.writeBuffer(this.primaryMatBuf, 0, u.primaryMat);
    device.queue.writeBuffer(this.secondaryToonBuf, 0, u.secondaryToon);
    device.queue.writeBuffer(this.secondaryMatBuf, 0, u.secondaryMat);

    // ---- Pass 1 + 2：场景 MRT + inverted hull 描边 ----
    const encoder = device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass({
      label: 'scene',
      colorAttachments: [
        {
          view: this.hdrTex.createView(),
          clearValue: { r: 0.09, g: 0.1, b: 0.13, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: this.auxTex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // debugMode 0 = 最终画面，1..5 = 各种 debug 视图，6 = 描边 mask
    const wantOutline = p.outlineEnabled && (p.debugMode === 0 || p.debugMode === 6);
    let draws = 0;

    for (let i = 0; i < input.objects.length; i++) {
      const o = input.objects[i]!;
      if (!o.visible) continue; // 隐藏 / 已删除：整条跳过
      pass.setVertexBuffer(0, o.vertexBuffer);
      pass.setVertexBuffer(1, o.skinVb!);
      pass.setIndexBuffer(o.indexBuffer, 'uint32');

      for (let s = 0; s < o.subMeshes.length; s++) {
        const sm = o.subMeshes[s]!;
        if (!sm.visible) continue; // 子网格级显隐
        const bg = sm.bindGroup;
        if (bg === undefined) continue;
        pass.setBindGroup(0, bg);
        pass.setPipeline(this.mainPipeline);
        pass.drawIndexed(sm.indexCount, 1, sm.indexStart);
        draws++;

        const isPrimary =
          input.highlight.primary !== null &&
          input.highlight.primary.objIndex === i &&
          (input.highlight.primary.sub === null || input.highlight.primary.sub === s);
        const isSecondary =
          !isPrimary &&
          input.highlight.secondary !== null &&
          input.highlight.secondary.objIndex === i &&
          (input.highlight.secondary.sub === null || input.highlight.secondary.sub === s);

        if (isPrimary && input.highlight.primary!.bindGroup !== null) {
          pass.setBindGroup(0, input.highlight.primary!.bindGroup);
          pass.setPipeline(this.outlinePipeline);
          pass.drawIndexed(sm.indexCount, 1, sm.indexStart);
          draws++;
        } else if (isSecondary && input.highlight.secondary!.bindGroup !== null) {
          pass.setBindGroup(0, input.highlight.secondary!.bindGroup);
          pass.setPipeline(this.outlinePipeline);
          pass.drawIndexed(sm.indexCount, 1, sm.indexStart);
          draws++;
        } else if (wantOutline && sm.outline) {
          pass.setBindGroup(0, bg);
          pass.setPipeline(this.outlinePipeline);
          pass.drawIndexed(sm.indexCount, 1, sm.indexStart);
          draws++;
        }
      }
    }
    pass.end();

    // ---- Pass 3：后处理 ----
    const swapView = this.gpu.context.getCurrentTexture().createView();
    const postPass = encoder.beginRenderPass({
      label: 'post',
      colorAttachments: [
        { view: swapView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    postPass.setPipeline(this.postPipeline);
    postPass.setBindGroup(0, this.postBindGroup);
    postPass.draw(3);
    postPass.end();

    // ---- Pass 4：Transform Gizmo（无深度，绘于 swapchain 之上）----
    const giz = input.gizmo;
    if (giz !== null && this.gizmoPipeline !== null) {
      const d = Math.hypot(eye[0] - giz.origin[0], eye[1] - giz.origin[1], eye[2] - giz.origin[2]) || 1;
      // 世界长度 k 投影像素 ≈ k * projScaleY * (height/2) / d，反解使 gizmo 恒定 ~GIZMO_SCREEN_PX
      const k = (2 * GIZMO_SCREEN_PX * d) / (projScaleY * this.height);
      m4.composeQuat(this.gizmoModel, giz.origin[0], giz.origin[1], giz.origin[2], giz.quat, k);
      this.gizmoK = k;
      this.gizmoOrigin = [giz.origin[0], giz.origin[1], giz.origin[2]];
      for (let ax = 0; ax < 3; ax++) {
        const vx = this.gizmoModel[ax * 4]!;
        const vy = this.gizmoModel[ax * 4 + 1]!;
        const vz = this.gizmoModel[ax * 4 + 2]!;
        const len = Math.hypot(vx, vy, vz) || 1;
        this.gizmoAxes[ax] = [vx / len, vy / len, vz / len];
      }
      device.queue.writeBuffer(this.gizmoModelBuf, 0, this.gizmoModel);
      const gp = encoder.beginRenderPass({
        label: 'gizmo',
        colorAttachments: [{ view: swapView, loadOp: 'load', storeOp: 'store' }],
      });
      gp.setPipeline(this.gizmoPipeline);
      for (const h of this.gizmoHandles) {
        if (h.mode !== giz.mode) continue;
        const active = giz.activeAxis !== null && h.axis === giz.activeAxis;
        this.gizmoColorScratch[0] = active ? 1 : h.baseColor[0];
        this.gizmoColorScratch[1] = active ? 1 : h.baseColor[1];
        this.gizmoColorScratch[2] = active ? 1 : h.baseColor[2];
        this.gizmoColorScratch[3] = 1;
        device.queue.writeBuffer(h.colorBuf, 0, this.gizmoColorScratch);
        gp.setBindGroup(0, h.bindGroup);
        gp.setVertexBuffer(0, h.vbuf);
        gp.setIndexBuffer(h.ibuf, 'uint32');
        gp.drawIndexed(h.indexCount);
      }
      gp.end();
    }

    device.queue.submit([encoder.finish()]);
    input.stats.drawCalls = draws;
  }

  /** 释放本核心持有的全部 GPU 资源（幂等） */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hdrTex?.destroy();
    this.auxTex?.destroy();
    this.depthTex?.destroy();
    this.frameBuf.destroy();
    this.lightsBuf.destroy();
    this.toonBuf.destroy();
    this.postBuf.destroy();
    this.materialBuf.destroy();
    this.transformBuf.destroy();
    this.primaryToonBuf.destroy();
    this.primaryMatBuf.destroy();
    this.secondaryToonBuf.destroy();
    this.secondaryMatBuf.destroy();
    this.gizmoModelBuf.destroy();
    for (const h of this.gizmoHandles) {
      h.vbuf.destroy();
      h.ibuf.destroy();
      h.colorBuf.destroy();
    }
  }
}

// 布局常量不再从这里导出 —— 真源是 ./frame-uniforms，由包入口 index.ts 统一对外。
// 留在这里会与 `export * from './frame-uniforms'` 撞名（ESM 的星号导出歧义）。
export { HDR_FORMAT, DEPTH_FORMAT, GIZMO_SCREEN_PX };
