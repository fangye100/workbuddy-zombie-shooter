/**
 * L1 — WebGPU 设备与资源层。
 * 业务代码只能通过本文件暴露的 API 触碰 GPU，禁止直接持有 GPUDevice。
 */

import { ResourceRegistry } from './handle';
import type { BufferHandle, ShaderHandle, ResourceMeta } from './handle';

// ---------------------------------------------------------------- 能力分级

export type CapabilityTier = 't0' | 't1' | 't2' | 't3';

const TIER_FEATURES: Record<CapabilityTier, readonly GPUFeatureName[]> = {
  t0: [],
  t1: ['depth-clip-control', 'indirect-first-instance', 'timestamp-query',
       'texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc'],
  t2: ['shader-f16', 'float32-filterable', 'clip-distances'],
  t3: [],   // 实验特性（如 texture binding array）按需单独开启
};

export interface Capabilities {
  readonly tier: CapabilityTier;
  readonly features: ReadonlySet<GPUFeatureName>;
  readonly limits: Record<string, number>;
  /** maxBindGroups 的 baseline 下限是 4 — 决定绑定模型能否用满 5 组 */
  readonly maxBindGroups: number;
  readonly uniformsUseDynamicOffset: boolean;
  readonly preferredFormat: GPUTextureFormat;
  readonly supportsTimestamp: boolean;
  readonly supportsSubgroups: boolean;
}

export function pickFeatures(available: ReadonlySet<GPUFeatureName>, upTo: CapabilityTier): GPUFeatureName[] {
  const order: CapabilityTier[] = ['t1', 't2', 't3'];
  const out: GPUFeatureName[] = [];
  for (const t of order) {
    for (const f of TIER_FEATURES[t]) if (available.has(f)) out.push(f);
    if (t === upTo) break;
  }
  if (available.has('subgroups' as GPUFeatureName)) out.push('subgroups' as GPUFeatureName);
  return out;
}

// ---------------------------------------------------------------- 分配器

/** 每帧 reset 的 uniform ring，用 256B 对齐的动态偏移避免 bindgroup 切换 */
export class UniformRing {
  private buffer!: GPUBuffer;
  private offset = 0;
  private readonly alignment: number;

  constructor(private readonly device: GPUDevice, readonly capacityBytes: number) {
    this.alignment = device.limits.minUniformBufferOffsetAlignment;
    this.buffer = device.createBuffer({
      size: capacityBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'uniform-ring',
    });
  }

  /** 返回动态偏移；容量不足时返回 -1（调用方应扩容或分批） */
  push(data: ArrayBufferView): number {
    const aligned = Math.ceil(data.byteLength / this.alignment) * this.alignment;
    if (this.offset + aligned > this.capacityBytes) return -1;
    const off = this.offset;
    this.device.queue.writeBuffer(this.buffer, off, data);
    this.offset += aligned;
    return off;
  }

  beginFrame(): void { this.offset = 0; }
  get gpuBuffer(): GPUBuffer { return this.buffer; }
}

/** 3 帧 in-flight 轮转的上传缓冲：只在 GPU 确认用完后复用，杜绝 mapAsync 停顿 */
export class StagingRing {
  private readonly buffers: GPUBuffer[] = [];
  private readonly mapped: Array<ArrayBuffer | null> = [];
  private frame = 0;

  constructor(device: GPUDevice, readonly slotBytes: number, slots = 3) {
    for (let i = 0; i < slots; i++) {
      const b = device.createBuffer({
        size: slotBytes,
        usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
        label: `staging-${i}`,
      });
      this.buffers.push(b);
      this.mapped.push(null);
    }
  }

  beginFrame(): void {
    this.frame = (this.frame + 1) % this.buffers.length;
    const buf = this.buffers[this.frame]!;
    if (this.mapped[this.frame] === null) {
      void buf.mapAsync(GPUMapMode.WRITE).then(() => {
        this.mapped[this.frame] = buf.getMappedRange();
      });
    }
  }

  /** 向当前帧的上传区写入，返回 { buffer, offset } 供 copyBufferToBuffer 使用 */
  write(bytes: Uint8Array): { buffer: GPUBuffer; offset: number } | null {
    const view = this.mapped[this.frame];
    if (!view) return null;
    const dst = new Uint8Array(view);
    const off = 0;   // 真实实现维护 bump cursor，写满时溢出到新 buffer
    dst.set(bytes, off);
    return { buffer: this.buffers[this.frame]!, offset: off };
  }

  endFrame(): void {
    const buf = this.buffers[this.frame]!;
    if (this.mapped[this.frame] !== null) { buf.unmap(); this.mapped[this.frame] = null; }
  }
}

// ---------------------------------------------------------------- 缓存

export interface CacheStats { hits: number; misses: number; size: number }

class LruCache<K extends string | number, V> {
  private readonly map = new Map<K, V>();
  stats: CacheStats = { hits: 0, misses: 0, size: 0 };

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) { this.stats.misses++; return undefined; }
    // LRU：命中后移到末尾
    this.map.delete(key); this.map.set(key, v);
    this.stats.hits++;
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.size >= this.maxSize && !this.map.has(key)) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
    this.stats.size = this.map.size;
  }

  clear(): void { this.map.clear(); this.stats.size = 0; }
}

// ---------------------------------------------------------------- Device

export interface GfxDeviceOptions {
  readonly canvas: HTMLCanvasElement;
  readonly tier: CapabilityTier;
  readonly enableValidation: boolean;
  readonly statsBufferBytes: number;
}

/** 绑定组槽位（对应文档 §3 的频率分层） */
export const BindGroupSlot = {
  PerFrame: 0,
  PerView: 1,
  PerPass: 2,
  PerMaterial: 3,
  PerDraw: 4,
} as const;
export type BindGroupSlot = (typeof BindGroupSlot)[keyof typeof BindGroupSlot];

/** FNV-1a：shader / pipeline 变体 key，够快且碰撞率可接受 */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class GfxDevice {
  readonly registry = new ResourceRegistry();
  readonly capabilities: Capabilities;
  readonly context: GPUCanvasContext;

  private readonly bindGroupCache = new LruCache<string, GPUBindGroup>(4096);
  private readonly pipelineCache = new LruCache<string, GPURenderPipeline>(2048);
  private readonly samplerCache = new LruCache<string, GPUSampler>(256);
  private readonly shaderModules = new LruCache<string, GPUShaderModule>(512);
  private readonly shaderHandles = new Map<string, ShaderHandle>();

  /** 句柄 → 真实 GPU 对象的槽位表，业务层只能通过 resolve* 访问 */
  private readonly bufferSlots: Array<GPUBuffer | undefined> = [];

  readonly uniformRing: UniformRing;
  readonly stagingRing: StagingRing;

  private frameIndex = 0;

  private constructor(
    readonly device: GPUDevice,
    context: GPUCanvasContext,
    capabilities: Capabilities,
    private readonly options: GfxDeviceOptions,
  ) {
    this.context = context;
    this.capabilities = capabilities;
    this.uniformRing = new UniformRing(device, options.statsBufferBytes);
    this.stagingRing = new StagingRing(device, 8 << 20);
  }

  /** 唯一入口：能力探测 → 请求设备 → 配置 canvas → 挂载丢失处理 */
  static async create(options: GfxDeviceOptions): Promise<GfxDevice> {
    if (!navigator.gpu) throw new Error('当前环境不支持 WebGPU');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('没有可用的 GPUAdapter');

    const available = new Set(adapter.features as Set<GPUFeatureName>);
    const features = pickFeatures(available, options.tier);

    const device = await adapter.requestDevice({
      requiredFeatures: features,
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxTextureArrayLayers: Math.min(256, adapter.limits.maxTextureArrayLayers),
        maxBindGroups: Math.min(5, adapter.limits.maxBindGroups),
      },
      label: 'aether-device',
    });

    void device.lost.then(info => {
      if (info.reason !== 'destroyed') {
        console.error('[gfx] device lost:', info.message);
        // 恢复路径：ResourceRegistry 重放所有 recreate 闭包
      }
    });
    device.addEventListener('uncapturederror', e => {
      console.error('[gfx] uncaptured error:', (e as GPUUncapturedErrorEvent).error.message);
    });

    const context = options.canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('无法获取 webgpu 上下文');

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      alphaMode: 'opaque',
    });

    const supportsSubgroups = available.has('subgroups' as GPUFeatureName);
    const capabilities: Capabilities = {
      tier: options.tier,
      features: available,
      limits: { ...adapter.limits } as unknown as Record<string, number>,
      maxBindGroups: Math.min(5, adapter.limits.maxBindGroups),
      uniformsUseDynamicOffset: true,
      preferredFormat: format,
      supportsTimestamp: available.has('timestamp-query'),
      supportsSubgroups,
    };

    return new GfxDevice(device, context, capabilities, options);
  }

  // ---- 每帧 ----

  beginFrame(): void {
    this.frameIndex++;
    this.uniformRing.beginFrame();
    this.stagingRing.beginFrame();
    if (this.options.enableValidation) this.device.pushErrorScope('validation');
  }

  endFrame(): void {
    if (this.options.enableValidation) {
      void this.device.popErrorScope().then(err => {
        if (err) console.error('[gfx] validation:', err.message);
      });
    }
    this.stagingRing.endFrame();
  }

  get frame(): number { return this.frameIndex; }
  get swapchainTexture(): GPUTexture { return this.context.getCurrentTexture(); }

  // ---- 资源创建（全部带缓存 + 句柄）----

  createBuffer(desc: GPUBufferDescriptor, meta: Omit<ResourceMeta, 'sizeBytes'>): BufferHandle {
    const buffer = this.device.createBuffer(desc);
    const handle = this.registry.allocate({
      ...meta,
      sizeBytes: desc.size,
      recreate: () => {
        this.bufferSlots[this.registry.slotOf(handle)] = this.device.createBuffer(desc);
      },
    }) as BufferHandle;
    this.bufferSlots[this.registry.slotOf(handle)] = buffer;
    return handle;
  }

  resolveBuffer(handle: BufferHandle): GPUBuffer {
    this.registry.meta(handle);                       // 先做 generation 校验
    const b = this.bufferSlots[this.registry.slotOf(handle)];
    if (!b) throw new Error(`Buffer 句柄 #${handle} 未绑定 GPUBuffer`);
    return b;
  }

  /** WGSL 源码按内容 hash 缓存；热重载时同 label 换源码会自然生成新 module */
  createShader(code: string, label: string): ShaderHandle {
    const key = `${label}:${hashString(code)}`;
    const existing = this.shaderHandles.get(key);
    if (existing !== undefined && this.registry.valid(existing)) return existing;

    this.shaderModules.set(key, this.device.createShaderModule({ code, label }));
    const handle = this.registry.allocate({
      name: label,
      sizeBytes: 0,
      recreate: () => { this.shaderModules.set(key, this.device.createShaderModule({ code, label })); },
    }) as ShaderHandle;
    this.shaderHandles.set(key, handle);
    return handle;
  }

  getShaderModule(label: string, code: string): GPUShaderModule | undefined {
    return this.shaderModules.get(`${label}:${hashString(code)}`);
  }

  /** 永远走 async 创建，未就绪时返回 null（调用方用默认材质顶上，绝不阻塞主线程） */
  getOrCreatePipelineAsync(key: string, desc: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
    const hit = this.pipelineCache.get(key);
    if (hit) return Promise.resolve(hit);
    return this.device.createRenderPipelineAsync(desc).then(p => {
      this.pipelineCache.set(key, p);
      return p;
    });
  }

  getSampler(desc: GPUSamplerDescriptor): GPUSampler {
    const key = `${desc.magFilter}|${desc.minFilter}|${desc.mipmapFilter}|${desc.addressModeU}|${desc.maxAnisotropy}`;
    const hit = this.samplerCache.get(key);
    if (hit) return hit;
    const s = this.device.createSampler(desc);
    this.samplerCache.set(key, s);
    return s;
  }

  getBindGroup(key: string, factory: () => GPUBindGroup): GPUBindGroup {
    const hit = this.bindGroupCache.get(key);
    if (hit) return hit;
    const bg = factory();
    this.bindGroupCache.set(key, bg);
    return bg;
  }

  // ---- 诊断 ----

  stats() {
    return {
      frame: this.frameIndex,
      bindGroups: this.bindGroupCache.stats,
      pipelines: this.pipelineCache.stats,
      samplers: this.samplerCache.stats,
      shaders: this.shaderModules.stats,
    };
  }

  destroy(): void {
    this.bindGroupCache.clear();
    this.pipelineCache.clear();
    this.device.destroy();
  }
}
