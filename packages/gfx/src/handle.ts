/**
 * 资源句柄：业务层永不直接持有 GPUBuffer / GPUTexture。
 * generation 机制把 use-after-free 从"随机黑屏"变成"可定位的报错"。
 */

export const INDEX_BITS = 24;
export const INDEX_MASK = (1 << INDEX_BITS) - 1;
export const MAX_RESOURCES = 1 << 20;

export type BufferHandle = number;
export type TextureHandle = number;
export type SamplerHandle = number;
export type BindGroupHandle = number;
export type PipelineHandle = number;
export type ShaderHandle = number;

export const INVALID_BUFFER: BufferHandle = 0;
export const INVALID_TEXTURE: TextureHandle = 0;

export const makeHandle = (index: number, generation: number): number =>
  ((index & INDEX_MASK) | (generation << INDEX_BITS)) >>> 0;

export const handleIndex = (h: number): number => h & INDEX_MASK;
export const handleGeneration = (h: number): number => (h >>> INDEX_BITS) & 0xff;

/** 所有资源的公共元信息，供 Profiler 与设备丢失恢复使用 */
export interface ResourceMeta {
  readonly name: string;
  readonly sizeBytes: number;
  /** 设备丢失后重建此资源的闭包；无则视为不可恢复（报错） */
  readonly recreate?: () => void;
}

export class ResourceRegistry {
  private readonly generations = new Uint8Array(MAX_RESOURCES);
  private readonly metas: Array<ResourceMeta | undefined> = [];
  private readonly free: number[] = [];
  private next = 1;   // 0 保留为 INVALID

  allocate(meta: ResourceMeta): number {
    const index = this.free.pop() ?? this.next++;
    this.metas[index] = meta;
    return makeHandle(index, this.generations[index]!);
  }

  release(h: number): void {
    const index = handleIndex(h);
    if (!this.valid(h)) return;
    this.generations[index] = (this.generations[index]! + 1) & 0xff;
    this.metas[index] = undefined;
    this.free.push(index);
  }

  valid(h: number): boolean {
    return h !== 0 && this.generations[handleIndex(h)] === handleGeneration(h);
  }

  /** 句柄对应的槽位下标，供设备层维护"句柄 → GPU 对象"表 */
  slotOf(h: number): number { return handleIndex(h); }

  meta(h: number): ResourceMeta {
    const m = this.metas[handleIndex(h)];
    if (!m) throw new Error(`无效句柄 (resource #${handleIndex(h)}) — 可能已释放或句柄过期`);
    return m;
  }

  /** device.lost 后按注册顺序重放重建 */
  recreateAll(): void {
    for (let i = 1; i < this.next; i++) {
      const m = this.metas[i];
      if (m?.recreate) m.recreate();
    }
  }
}
