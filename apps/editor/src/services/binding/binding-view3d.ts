/**
 * BindingView3D —— 绑定面板正/侧视的 **3D 正交视图**（每个视图独占一个 RendererCore）。
 *
 * 为什么要有它
 * ------------
 * 面板原来的正/侧视是 Canvas 2D：网格用画家算法填三角面，包裹器用 `lineCap:'round'`
 * 的粗描边「示意」。那套画法**看不出体积**——圆柱体在屏幕上是根等宽的粗线，
 * 穿没穿出模型、两根圆柱有没有互相穿插，全凭猜。
 *
 * 本类把正/侧视换成真正的 3D：
 *   - 网格走 GPU，带深度缓冲 → 有前后遮挡，穿插关系一眼可见；
 *   - 相机用**正交投影**（`RenderFrameParams.orthoHalfHeight`），没有近大远小，
 *     屏幕 1px 恒等于固定世界长度 → 半径 / 骨长的比例可以直读；
 *   - 圆柱体复用主视口那套几何（`buildCylinderOverlayFromSegments`），
 *     以半透明 X-ray 叠在网格上 → 透过模型看得见包裹器体积。
 *
 * 与 2D 层的分工（重要）
 * ----------------------
 * 本类**只画实体**（网格 + 圆柱体）。joint 圆点、骨连线、选中高亮、文字标签仍然
 * 由 `binding-panel.ts` 的 2D 画布画，那层 canvas 叠在本 canvas **之上**且透明。
 * 这样既拿到 3D 体积，又保留原有的拖拽/拾取/键盘微调（2D 命中判定不改动）。
 *
 * 两套投影必须严格一致，否则 3D 网格会和 2D 骨架错位。一致性靠 `setFit()` 保证：
 * 面板把自己算好的 `scale`（米→CSS 像素）和 `targetY` 交给本类，本类据此反解
 * 正交半高，使 `screen = center + world * scale` 与 2D 的 `project()` 完全等价
 * （推导见 `setFit()` 注释）。
 *
 * 分层：本类与 `AssetPreview` 平级，都是**引擎的消费者**，不内嵌渲染逻辑——
 * 几何 / 管线 / 装箱全部来自 `@aether/render` 与 `@aether/scene`。
 */

import type { GpuContext } from '@aether/gfx';
import {
  RendererCore,
  type CoreObjectDraw,
  type CoreSubMeshDraw,
  type RenderFrameInput,
  type MaterialState,
  packFrameUniforms,
  packMaterial,
  FRAME_FLOATS,
  LIGHTS_FLOATS,
  TOON_FLOATS,
  POST_FLOATS,
  SLOT_FLOATS,
} from '@aether/render';
import { packSkin, VERTEX_FLOATS } from '@aether/scene';
import * as m4 from '@aether/core';
import { defaultParams, type LabParams } from '../../params';
import { buildCylinderOverlayFromSegments } from './cylinder-overlay';
import type { SkinCylinderMap } from './skin-proxy';

/** 待绘制的一根骨段（= `boneSegments()` 的输出形状） */
export interface View3DBoneSegment {
  bone: string;
  a: readonly [number, number, number];
  b: readonly [number, number, number];
}

/**
 * 正交相机与 target 的距离。正交下它**不影响画面大小**（只决定裁剪范围），
 * 给一个远大于角色包围盒的固定值即可。
 */
const ORTHO_CAM_DISTANCE = 10;

/**
 * 面板视图用的「普通灯光」：关掉场景的卡通预制（描边 / 半调 / grading / bloom），
 * 把 toon 分阶拉平 → 网格是平滑受光的普通材质，彩色包裹器才不会被墨线干扰。
 *
 * ⚠️ `exposure` 必须显式压下来：`defaultParams()` 给的是 1.5，那是给主视口那套
 * 卡通渲染调的，照搬到面板会把模型**过曝成一片纯白** —— 半透明包裹器叠在纯白上
 * 混成淡色，形状全糊掉（「看不到包裹器」的真因之一，不是没画）。这里定 0.75，
 * 配合 VIEW_MATERIAL 的暗 albedo，让模型落在中灰档，彩色圆柱才有对比。
 */
const VIEW_PARAMS: LabParams = (() => {
  const p = defaultParams();
  p.outlineEnabled = false;
  p.halftoneEnabled = false;
  p.gradeEnabled = false;
  p.bloomEnabled = false;
  p.shadowEnd = 0;
  p.shadowMult = 1;
  p.shadowMix = 0;
  p.shadowSat = 1;
  p.litSat = 1;
  p.specMix = 0;
  p.exposure = 1.05;
  return p;
})();

/**
 * 网格材质：暗冷灰 + 无描边。
 *
 * 刻意压低 albedo（linear ≈ 0.06）：面板视图的主角是**彩色包裹器**，网格只是
 * 参照物。网格亮到中灰以上就会跟半透明圆柱混成一片，看不出谁包着谁。
 */
const VIEW_MATERIAL: MaterialState = {
  albedo: '#79818F',
  roughness: 0.95,
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

export class BindingView3D {
  private readonly gpu: GpuContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly core: RendererCore;
  private readonly axis: 'front' | 'side';

  // 帧 uniform 的 CPU 侧缓冲（尺寸与引擎 layout 常量一致）
  private readonly frameData = new Float32Array(FRAME_FLOATS);
  private readonly lightsData = new Float32Array(LIGHTS_FLOATS);
  private readonly toonData = new Float32Array(TOON_FLOATS);
  private readonly postData = new Float32Array(POST_FLOATS);
  private readonly materialData = new Float32Array(SLOT_FLOATS);
  private readonly transformData = new Float32Array(SLOT_FLOATS);

  // ---- 网格 ----
  private verts: Float32Array | null = null;
  private indices: Uint32Array | null = null;
  /** setMesh 每次自增；render 里与 builtVersion 比对决定是否重建 GPU 缓冲 */
  private meshVersion = 0;
  private builtVersion = -1;
  private vb: GPUBuffer | null = null;
  private ib: GPUBuffer | null = null;
  private skinVb: GPUBuffer | null = null;
  /** 恒等关节矩阵（storage）：面板网格是静止姿态，不需要蒙皮 */
  private skinBuf: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private whiteTex: GPUTexture | null = null;

  // ---- 包裹器 ----
  private segs: readonly View3DBoneSegment[] | null = null;
  private cyls: SkinCylinderMap | null = null;
  /**
   * 圆柱体不透明度。蒙皮模式要高一点（主角），关节模式压低（不干扰拖 joint）。
   * 半透明是必须的——X-ray 的意义就是「透过它仍看得见里面的网格」，但太高会
   * 把模型整个糊住，太低又会被模型冲淡看不见。这两个值是拿像素采样试出来的：
   * 0.42 时中亮档（模型轮廓）仍在，彩色圆柱也还饱和。
   */
  private cylAlpha = 0.42;
  private lastCylVerts = 0;
  /** 本帧圆柱体的几何指纹（坐标绝对值之和）—— 顶点数看不出半径变化，得靠它 */
  private lastCylSum = 0;

  // ---- 相机 ----
  private scale = 200;
  private targetY = 0.9;
  /** 水平 pan 偏移（世界单位）：前视→相机 target.x，侧视→target.z。
   *  由面板把 2D 的 originX 偏移换算进来，使 3D 包裹器体积跟着 pan 平移。 */
  private panX = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, gpu: GpuContext, axis: 'front' | 'side') {
    this.canvas = canvas;
    this.gpu = gpu;
    this.axis = axis;
    this.core = new RendererCore(gpu, canvas);
    // 模型矩阵：面板工作在模型 local 空间，恒为单位阵
    this.transformData.set(m4.mat4(), 0);
  }

  /** 更新要显示的网格（stride = VERTEX_FLOATS）。传 null 清空。 */
  setMesh(vertices: Float32Array | null, indices: Uint32Array | null): void {
    this.verts = vertices;
    this.indices = indices;
    this.meshVersion++;
  }

  /** 更新包裹器骨段；传 null = 不画圆柱体（关节编辑模式） */
  setSegments(segs: readonly View3DBoneSegment[] | null): void {
    this.segs = segs;
  }

  /** 更新每骨半径表（null = 全用默认半径） */
  setCylinders(cyls: SkinCylinderMap | null): void {
    this.cyls = cyls;
  }

  /** 圆柱体不透明度（0..1）：蒙皮模式 0.55，关节模式 0.3 */
  setAlpha(a: number): void {
    this.cylAlpha = Math.min(1, Math.max(0.05, a));
  }

  /**
   * 同步 2D 层的投影参数 —— **3D 与 2D 不错位的关键**。
   *
   * 2D 的映射是（binding-panel 的 `project()`）：
   *   screenX = originX + horiz·scale   （pan 时 originX 会变）
   *   screenY = originY − y·scale       （pan 时 originY 会变，不再恒为 0.92h）
   *
   * 正交投影的映射是（halfHeight = 视口半高，世界单位）：
   *   screenX = W/2 + (x − tx)·k
   *   screenY = H/2 − (y − ty)·k，其中 k = scale
   *
   * 令 k = scale：横轴要求 W/2 − tx·scale = originX → tx = (W/2 − originX)/scale = panX；
   * 纵轴要求 H/2 + ty·scale = originY → ty = (originY − H/2)/scale = targetY。
   * 于是半高 = (h/2)/scale，target = [panX, ty, 0]（前视）/ [0, ty, panX]（侧视）。
   * `panX` 由面板把 2D 的 originX 偏移换算成世界单位传入，使 3D 体积随 pan 平移。
   *
   * @param scale   米→CSS 像素（前/侧视图共用）
   * @param targetY 相机 target 的纵轴（世界单位）
   * @param panX    水平 pan 偏移（世界单位）：前视→x，侧视→z
   */
  setFit(scale: number, targetY: number, panX = 0): void {
    this.scale = scale > 1e-6 ? scale : 200;
    this.targetY = targetY;
    this.panX = panX;
  }

  /** 画一帧。面板的 rAF（`scheduleDraw`）里调用；尺寸为 0（面板未展开）时直接跳过。 */
  render(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w < 2 || h < 2) return; // 面板未展开 → 量不到尺寸，别 resize 成 1×1

    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.core.resize(Math.round(w * this.dpr), Math.round(h * this.dpr));

    const device = this.gpu.device;
    this.rebuildMeshIfNeeded();

    packFrameUniforms({
      lights: this.lightsData,
      toon: this.toonData,
      post: this.postData,
      params: VIEW_PARAMS,
      time: performance.now() / 1000,
      width: this.core.width,
      height: this.core.height,
    });
    packMaterial(this.materialData, 0, VIEW_MATERIAL);
    device.queue.writeBuffer(this.core.materialBuf, 0, this.materialData);
    device.queue.writeBuffer(this.core.transformBuf, 0, this.transformData);

    const objects: CoreObjectDraw[] = [];
    if (this.vb !== null && this.ib !== null && this.indices !== null) {
      const sub: CoreSubMeshDraw = {
        indexStart: 0,
        indexCount: this.indices.length,
        visible: true,
        bindGroup: this.bindGroup ?? undefined,
        outline: false,
      };
      objects.push({
        vertexBuffer: this.vb,
        skinVb: this.skinVb,
        indexBuffer: this.ib,
        visible: true,
        subMeshes: [sub],
      });
    }

    // 包裹器：与 2D 层同一批骨段（boneSegments），看到的就是算权重用的体积
    const cyl = buildCylinderOverlayFromSegments(this.segs, this.cyls, {
      alpha: this.cylAlpha,
    });
    this.lastCylVerts = cyl === null ? 0 : cyl.vertices.length / 9;
    this.lastCylSum = cyl === null ? 0 : BindingView3D.geomSum(cyl.vertices);

    const input: RenderFrameInput = {
      p: {
        outlineEnabled: false,
        debugMode: 0,
        cameraElevation: 0, // 正/侧视不俯仰，水平轴必须在屏幕上保持水平
        orthoHalfHeight: h / 2 / this.scale,
      },
      // yaw=0 → eye 在 +Z（正视，屏幕右 = +X）；yaw=−π/2 → eye 在 −X（侧视，屏幕右 = +Z）
      // panX：前视平移进 x、侧视平移进 z（depth 轴），令 3D 体积与 2D 骨架同 pan。
      camera: {
        target: this.axis === 'front' ? [this.panX, this.targetY, 0] : [0, this.targetY, this.panX],
        distance: ORTHO_CAM_DISTANCE,
        yaw: this.axis === 'front' ? 0 : -Math.PI / 2,
      },
      time: performance.now() / 1000,
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
      skeleton: null, // 骨连线 / joint 圆点由 2D 层画（带深度排序与标签）
      cylinders: cyl,
      stats: { drawCalls: 0 },
    };
    this.core.drawFrame(input);
  }

  /** 供无头冒烟断言：本帧圆柱体顶点数（0 = 没画包裹器） */
  get cylinderVertexCount(): number {
    return this.lastCylVerts;
  }

  /** 供无头冒烟断言：本帧圆柱体的几何指纹（半径一变它就得变） */
  get cylinderSum(): number {
    return this.lastCylSum;
  }

  /** 顶点坐标绝对值之和：半径 / 长度 / 位置任一变化都会改变它 */
  private static geomSum(v: Float32Array): number {
    let s = 0;
    for (let i = 0; i < v.length; i += 3) {
      s += Math.abs(v[i]!) + Math.abs(v[i + 1]!) + Math.abs(v[i + 2]!);
    }
    return s;
  }

  /** 供无头冒烟断言：3D 视图是否已建好网格缓冲 */
  get hasMesh(): boolean {
    return this.vb !== null && this.ib !== null;
  }

  private rebuildMeshIfNeeded(): void {
    if (this.meshVersion === this.builtVersion) return;
    this.builtVersion = this.meshVersion;
    this.releaseMesh();

    const v = this.verts;
    const idx = this.indices;
    if (v === null || idx === null || v.length === 0 || idx.length === 0) return;

    const device = this.gpu.device;
    const vcount = Math.floor(v.length / VERTEX_FLOATS);
    if (vcount <= 0) return;

    this.vb = device.createBuffer({
      label: 'bd-vtx',
      size: v.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.ib = device.createBuffer({
      label: 'bd-idx',
      size: idx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vb, 0, v);
    device.queue.writeBuffer(this.ib, 0, idx);

    // 蒙皮槽：面板网格是静止姿态 → 恒等关节 + 权重 1（引擎要求槽位必须绑上）
    this.skinVb = device.createBuffer({
      label: 'bd-skin-vb',
      size: Math.max(24, vcount * 24),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.skinVb, 0, packSkin(null, null, vcount));

    const idm = new Float32Array(16);
    idm[0] = 1; idm[5] = 1; idm[10] = 1; idm[15] = 1;
    this.skinBuf = device.createBuffer({
      label: 'bd-skin',
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.skinBuf, 0, idm);

    this.bindGroup = device.createBindGroup({
      label: 'bd-obj',
      layout: this.core.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.core.frameBuf } },
        { binding: 1, resource: { buffer: this.core.lightsBuf } },
        { binding: 2, resource: { buffer: this.core.toonBuf } },
        { binding: 3, resource: { buffer: this.core.materialBuf, offset: 0, size: 80 } },
        { binding: 4, resource: { buffer: this.core.transformBuf, offset: 0, size: 64 } },
        { binding: 5, resource: this.white().createView() },
        { binding: 6, resource: this.core.sampler },
        { binding: 7, resource: { buffer: this.skinBuf, offset: 0, size: 64 } },
      ],
    });
  }

  /** 1×1 中灰图（面板视图不需要贴图，平色即可） */
  private white(): GPUTexture {
    if (this.whiteTex !== null) return this.whiteTex;
    const t = this.gpu.device.createTexture({
      label: 'bd-white',
      size: [1, 1],
      format: 'rgba8unorm',
      // ⚠️ 必须是 GPUTextureUsage.COPY_DST（0x2）；GPUBufferUsage.COPY_DST 是 0x8，
      // 套到纹理 usage 上会变成 STORAGE_BINDING，writeTexture 会因缺 COPY_DST 报错。
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.gpu.device.queue.writeTexture({ texture: t }, new Uint8Array([235, 235, 240, 255]), {}, [1, 1]);
    this.whiteTex = t;
    return t;
  }

  private releaseMesh(): void {
    this.vb?.destroy();
    this.ib?.destroy();
    this.skinVb?.destroy();
    this.skinBuf?.destroy();
    this.vb = null;
    this.ib = null;
    this.skinVb = null;
    this.skinBuf = null;
    this.bindGroup = null;
  }

  destroy(): void {
    this.releaseMesh();
    this.whiteTex?.destroy();
    this.whiteTex = null;
    this.core.destroy();
  }
}
