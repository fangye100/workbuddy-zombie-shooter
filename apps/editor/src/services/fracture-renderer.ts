/**
 * WU-05 碎片动态渲染装配：把 WU-04 的 ActiveChunk 打包成原 CoreDynamicBatch 实例。
 *
 * 责任边界：
 * - 只做「运行状态 → 实例行/刚体基向量」的打包与网格/贴图缓存，不复制渲染器、材质或动画系统；
 * - 复用原动态 shader 的 20-float 行与 binding 6 刚体基向量；旧角色分支（无 bit1）不受影响；
 * - 不占静态 64 槽；Play 期新增的 GPU 资源由 renderer-core 持有，Stop 由 core 统一 destroy。
 *
 * 坐标合同（与 WU-04 一致）：网格 POSITION 保持资产原始坐标（不在缓存里减 pivot），
 * 每个实例用 position - R·(worldScale·pivot) 作为平移，再由刚体基向量
 * （rotation × worldScale）组合一次；法线走同一基。这样同一 GLB 的不同合法
 * pivot 共享一份几何/一个 GPU mesh，同时不互相串用已重基准的顶点。
 */
import type { CoreDynamicBatch } from '@aether/render';
import { RIGID_INSTANCE_FLOATS, DYNAMIC_INSTANCE_FLOATS } from '@aether/render';
import { parseGlb } from '@aether/scene';
import type { FractureAssetIO, FractureRuntime, RapierFractureBackend } from '@aether/runtime';

interface SubPart {
  indexStart: number;
  indexCount: number;
  /** 纯色材质（切口）的颜色；有贴图时为 null。 */
  tint: [number, number, number] | null;
  textured: boolean;
}

interface MeshEntry {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  /** 几何内容身份（顶点+索引 SHA-256 前缀）：core 的 GPU mesh 缓存按它区分版本。 */
  geometryKey: string;
  albedo: ImageBitmap | null;
  /** 贴图内容身份（同图共享 GPUTexture）；无贴图为 null。 */
  textureKey: string | null;
  /** 源文件编码字节（文件 IO 口径，不是 GPU 上传/驻留量）。 */
  textureFileBytes: number;
  /** 解码后基础级 RGBA8 的提交字节（w×h×4）。 */
  textureUploadBytes: number;
  /** 含 mip 链的 GPU 驻留字节。 */
  textureResidentBytes: number;
  parts: SubPart[];
}

/** RGBA8 基础级 + mip 链的驻留字节；与 createAlbedoTexture 的 mipLevelCount 一致。 */
function mipChainBytes(width: number, height: number): number {
  let total = 0, w = width, h = height;
  for (;;) {
    total += w * h * 4;
    if (w === 1 && h === 1) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return total;
}

/** 刚体实例的 3×3 基向量（列主序，含旋转与世界尺度）。 */
function basisFromQuat(q: readonly [number, number, number, number], scale: number, out: Float32Array, offset: number): void {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  // 列 0（本地 +X）、列 1（本地 +Y）、列 2（本地 +Z）
  out[offset] = (1 - 2 * (yy + zz)) * scale;
  out[offset + 1] = (2 * (xy + wz)) * scale;
  out[offset + 2] = (2 * (xz - wy)) * scale;
  out[offset + 3] = 0;
  out[offset + 4] = (2 * (xy - wz)) * scale;
  out[offset + 5] = (1 - 2 * (xx + zz)) * scale;
  out[offset + 6] = (2 * (yz + wx)) * scale;
  out[offset + 7] = 0;
  out[offset + 8] = (2 * (xz + wy)) * scale;
  out[offset + 9] = (2 * (yz - wx)) * scale;
  out[offset + 10] = (1 - 2 * (xx + yy)) * scale;
  out[offset + 11] = 0;
}

export class PlayFractureRenderer {
  private readonly io: FractureAssetIO;
  private readonly meshes = new Map<string, MeshEntry | null>();
  private readonly pending = new Set<string>();
  private batches: CoreDynamicBatch[] = [];
  private disposed = false;
  /** 装配代次：dispose 后递增，迟到异步完成按代次丢弃（不复活旧装配）。 */
  private generation = 0;
  /** 最近一次网格准备失败的原因（供宿主诊断；成功后清空）。 */
  private lastError: string | null = null;
  /** 失败重试时间戳（避免每帧重复读同一个坏文件）。 */
  private readonly retryAt = new Map<string, number>();
  /** 已计入上传字节的贴图内容身份（同图只算一次）。 */
  private readonly sharedTextures = new Set<string>();
  /** 每次读取的归属 token（防止旧代完成时删掉新代同路径的 pending）。 */
  private pendingSeq = 0;
  private readonly pendingToken = new Map<string, number>();
  /** 已加载网格数 / 最近一次同步的实例数与三角形数（供验收观察）。 */
  readonly stats = {
    meshes: 0, instances: 0, triangles: 0, textures: 0,
    /** GPU 顶点+索引+全零 skin slot 的提交字节。 */
    geometryBytes: 0,
    /** 贴图源文件编码字节（仅文件 IO，不是 GPU 量）。 */
    textureFileBytes: 0,
    /** 贴图解码基础级 RGBA8 提交字节。 */
    textureUploadBytes: 0,
    /** 贴图基础级 + mip 链的 GPU 驻留字节。 */
    textureResidentBytes: 0,
    /** 实际 GPU 提交量 = geometryBytes + textureUploadBytes。 */
    uploadBytes: 0,
    /** 实际 GPU 驻留量 = geometryBytes + textureResidentBytes。 */
    residentBytes: 0,
    /** 本帧实例行 + 刚体基向量的写入字节。 */
    instanceBytes: 0,
  };

  /** 失败后的重试间隔（毫秒）；测试可注入较小值验证"可重试"。 */
  private readonly retryDelayMs: number;

  constructor(io: FractureAssetIO, opts: { retryDelayMs?: number } = {}) {
    this.io = io;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
  }

  /** 最近一次网格准备失败的原因（null = 无失败）。 */
  get error(): string | null {
    return this.lastError;
  }

  /** 当前帧要交给 renderer 的批次（没有活动碎片时为空数组）。 */
  get dynamicBatches(): CoreDynamicBatch[] {
    return this.batches;
  }

  /**
   * 每帧同步：从运行时的活动块与后端快照打包实例。
   * large 读真实后端当前 snapshot，small 读正式简化状态——同帧画面与物理一致。
   */
  sync(runtime: FractureRuntime | null, backend: RapierFractureBackend | null): void {
    if (this.disposed) return;
    this.batches = [];
    this.stats.instances = 0;
    this.stats.triangles = 0;
    if (runtime === null) return;
    const active = runtime.active;
    if (active.length === 0) return;
    const groups = new Map<string, {
      batch: CoreDynamicBatch;
      instRows: Float32Array[];
      rigidRows: Float32Array[];
      textureFileBytes: number;
      textureUploadBytes: number;
      textureResidentBytes: number;
    }>();

    for (const chunk of active) {
      if (chunk.expired) continue;
      if (!this.meshes.has(chunk.mesh.path) && !this.pending.has(chunk.mesh.path)) {
        // 首次出现（或上次失败）：异步加载；失败后 2s 内不重复轰炸，之后可重试。
        const waitUntil = this.retryAt.get(chunk.mesh.path) ?? 0;
        if (Date.now() >= waitUntil) this.loadMesh(chunk.mesh.path);
        continue;
      }
      const entry = this.meshes.get(chunk.mesh.path) ?? null;
      if (entry === null) continue;

      // 位置/姿态：rigid 用真实后端快照，simplified 用正式 sim
      let px: number, py: number, pz: number;
      let q: readonly [number, number, number, number];
      if (chunk.layer === 'rigid') {
        const snap = backend?.snapshot(chunk.handle) ?? null;
        if (snap === null) continue;
        px = snap.position[0]; py = snap.position[1]; pz = snap.position[2];
        q = snap.rotation;
      } else if (chunk.sim !== null) {
        px = chunk.sim.position[0]; py = chunk.sim.position[1]; pz = chunk.sim.position[2];
        q = chunk.sim.rotation;
      } else {
        continue;
      }

      const rigid = new Float32Array(RIGID_INSTANCE_FLOATS);
      basisFromQuat(q, chunk.worldScale, rigid, 0);
      // 逐实例淡出：运行时在寿命末尾给出 fade(0..1)，写到基向量 m0.w（shader 读它做 alpha）。
      const alpha = Math.max(0, Math.min(1, 1 - chunk.fade));
      rigid[3] = alpha;
      // 几何保持资产原始坐标；用实例平移补偿本块的合法 pivot：
      // world = R·(raw - pivot) + position = R·raw + (position - R·pivot)。
      const pivot = chunk.pivot ?? [0, 0, 0] as const;
      const ox = rigid[0]! * pivot[0] + rigid[4]! * pivot[1] + rigid[8]! * pivot[2];
      const oy = rigid[1]! * pivot[0] + rigid[5]! * pivot[1] + rigid[9]! * pivot[2];
      const oz = rigid[2]! * pivot[0] + rigid[6]! * pivot[1] + rigid[10]! * pivot[2];

      // 逐子网格分组：同一 (meshId, 索引区间, 材质) 的实例合并进同一批，
      // 重复几何不会按实例数放大 draw。
      for (const part of entry.parts) {
        const inst = new Float32Array(DYNAMIC_INSTANCE_FLOATS);
        inst[0] = px - ox; inst[1] = py - oy; inst[2] = pz - oz; inst[3] = 0;
        inst[4] = 1; inst[5] = 1; inst[6] = 1; inst[7] = 0;   // 基向量已含尺度，行内 scale 保持 1
        const tint = part.tint ?? [1, 1, 1];
        inst[8] = tint[0]; inst[9] = tint[1]; inst[10] = tint[2]; inst[11] = 0;
        inst[12] = 0; inst[13] = 0; inst[14] = 2; inst[15] = 0; // flags bit1 = 刚体模式
        inst[16] = 1; inst[17] = 0; inst[18] = 0; inst[19] = 0;

        const texKey = part.textured ? entry.textureKey : null;
        const key = chunk.mesh.path + '|' + part.indexStart + '|' + part.indexCount + '|' + (part.textured ? 't' : 's');
        const hit = groups.get(key);
        if (hit === undefined) {
          groups.set(key, {
            batch: {
              meshId: 'fracture:' + chunk.mesh.path + '#' + entry.geometryKey,
              vertices: entry.vertices,
              indices: entry.indices,
              skin: null,
              albedo: part.textured ? entry.albedo : null,
              instances: inst,
              count: 1,
              outline: true,
              indexStart: part.indexStart,
              indexCount: part.indexCount,
              rigid,
              ...(texKey !== null ? { textureKey: texKey } : {}),
            },
            instRows: [inst],
            rigidRows: [rigid],
            textureFileBytes: part.textured ? entry.textureFileBytes : 0,
            textureUploadBytes: part.textured ? entry.textureUploadBytes : 0,
            textureResidentBytes: part.textured ? entry.textureResidentBytes : 0,
          });
        } else {
          hit.instRows.push(inst);
          hit.rigidRows.push(rigid);
        }
        this.stats.instances++;
        this.stats.triangles += part.indexCount / 3;
      }
    }
    // 唯一纹理计数：同一内容身份只算一次上传（core 按 textureKey 共享 GPUTexture）。
    // 三种口径分开记录：源文件字节、解码基础级提交字节、含 mip 的驻留字节。
    for (const g of groups.values()) {
      const tk = g.batch.textureKey;
      if (tk === undefined) continue;
      if (!this.sharedTextures.has(tk)) {
        this.sharedTextures.add(tk);
        this.stats.textures++;
        this.stats.textureFileBytes += g.textureFileBytes;
        this.stats.textureUploadBytes += g.textureUploadBytes;
        this.stats.textureResidentBytes += g.textureResidentBytes;
      }
    }
    this.stats.uploadBytes = this.stats.geometryBytes + this.stats.textureUploadBytes;
    this.stats.residentBytes = this.stats.geometryBytes + this.stats.textureResidentBytes;
    this.stats.instanceBytes = this.stats.instances * (DYNAMIC_INSTANCE_FLOATS + RIGID_INSTANCE_FLOATS) * 4;
    // 合并各组实例行（每行 20 float）与刚体基向量（每行 12 float）
    for (const g of groups.values()) {
      const n = g.instRows.length;
      if (n === 1) { this.batches.push(g.batch); continue; }
      const inst = new Float32Array(n * DYNAMIC_INSTANCE_FLOATS);
      const rigid = new Float32Array(n * RIGID_INSTANCE_FLOATS);
      for (let i = 0; i < n; i++) {
        inst.set(g.instRows[i]!, i * DYNAMIC_INSTANCE_FLOATS);
        rigid.set(g.rigidRows[i]!, i * RIGID_INSTANCE_FLOATS);
      }
      this.batches.push({ ...g.batch, instances: inst, rigid, count: n });
    }
  }

  /**
   * 换绑（Reset/换场景）时开始新装配代次：让之前挂起的读取失效，
   * 并清空 CPU 缓存/统计（GPU 资源仍由 renderer-core 在 Stop 统一释放）。
   */
  beginGeneration(): void {
    if (this.disposed) return;
    this.generation++;
    for (const e of this.meshes.values()) e?.albedo?.close();
    this.meshes.clear();
    this.pending.clear();
    this.pendingToken.clear();
    this.retryAt.clear();
    this.sharedTextures.clear();
    this.batches = [];
    this.lastError = null;
    this.stats.meshes = 0;
    this.stats.instances = 0;
    this.stats.triangles = 0;
    this.stats.textures = 0;
    this.stats.geometryBytes = 0;
    this.stats.textureFileBytes = 0;
    this.stats.textureUploadBytes = 0;
    this.stats.textureResidentBytes = 0;
    this.stats.uploadBytes = 0;
    this.stats.residentBytes = 0;
    this.stats.instanceBytes = 0;
  }

  /** 释放本组件的 CPU 缓存与 ImageBitmap（GPU buffer 由 renderer-core 统一释放）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    for (const e of this.meshes.values()) e?.albedo?.close();
    this.meshes.clear();
    this.pending.clear();
    this.pendingToken.clear();
    this.retryAt.clear();
    this.sharedTextures.clear();
    this.lastError = null;
    this.batches = [];
    this.stats.meshes = 0;
    this.stats.instances = 0;
    this.stats.triangles = 0;
    this.stats.textures = 0;
    this.stats.geometryBytes = 0;
    this.stats.textureFileBytes = 0;
    this.stats.textureUploadBytes = 0;
    this.stats.textureResidentBytes = 0;
    this.stats.uploadBytes = 0;
    this.stats.residentBytes = 0;
    this.stats.instanceBytes = 0;
  }

  private loadMesh(path: string): void {
    const gen = this.generation;
    const token = ++this.pendingSeq;
    this.pending.add(path);
    this.pendingToken.set(path, token);
    void (async (): Promise<void> => {
      let albedo: ImageBitmap | null = null;
      try {
        const bytes = await this.io.readBinary(path);
        const parsed = parseGlb(bytes, null, 'auto', { normalize: false });
        // 顶点保持资产原始坐标：pivot 由每个实例的平移补偿（见 sync），
        // 同一 GLB 的多个合法 pivot 因此共享同一份几何与同一个 GPU mesh。
        const verts = new Float32Array(parsed.mesh.vertices.length);
        verts.set(parsed.mesh.vertices);
        const count = Math.floor(verts.length / 15);
        // 几何身份：同一路径在 Reset/换代后可能读到新字节，GPU 缓存不能按 path 复用旧顶点。
        const geoBytes = new Uint8Array(verts.byteLength + parsed.mesh.indices.byteLength);
        geoBytes.set(new Uint8Array(verts.buffer, verts.byteOffset, verts.byteLength), 0);
        geoBytes.set(new Uint8Array(parsed.mesh.indices.buffer, parsed.mesh.indices.byteOffset,
          parsed.mesh.indices.byteLength), verts.byteLength);
        const geoDigest = await crypto.subtle.digest('SHA-256', geoBytes);
        const geometryKey = Array.from(new Uint8Array(geoDigest).slice(0, 8),
          (b) => b.toString(16).padStart(2, '0')).join('');
        let textureKey: string | null = null;
        let textureFileBytes = 0, textureUploadBytes = 0, textureResidentBytes = 0;
        if (parsed.image !== null && typeof createImageBitmap === 'function') {
          const imgBuf = await parsed.image.arrayBuffer();
          textureFileBytes = imgBuf.byteLength;
          const digest = await crypto.subtle.digest('SHA-256', imgBuf);
          textureKey = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
          // 解码失败必须走统一失败路径（诊断 + 可重试），不能静默退化成白材质。
          albedo = await createImageBitmap(parsed.image);
          // 上传只提交基础级；mip 链由 GPU 生成并常驻。两者都按 RGBA8 计。
          textureUploadBytes = albedo.width * albedo.height * 4;
          textureResidentBytes = mipChainBytes(albedo.width, albedo.height);
        }
        const parts: SubPart[] = parsed.subMeshes.map((sm) => {
          const f = sm.baseColorFactor;
          return {
            indexStart: sm.indexStart,
            indexCount: sm.indexCount,
            textured: sm.hasBaseColorTexture,
            tint: sm.hasBaseColorTexture
              ? null
              : [f === null ? 1 : f[0], f === null ? 1 : f[1], f === null ? 1 : f[2]],
          };
        });
        // 声明了 baseColorTexture 却没有可用内嵌图像（或当前环境不能解码）：
        // 必须走统一失败/重试路径，不能静默退化成白色材质。
        if (parts.some((p) => p.textured) && albedo === null) {
          throw new Error('baseColorTexture 缺少可用内嵌图像或当前环境无法解码贴图');
        }
        // Stop/换代之后才完成的读取：丢弃结果、关闭 bitmap，不写回缓存/统计。
        if (this.disposed || gen !== this.generation) {
          albedo?.close();
          return;
        }
        const entry: MeshEntry = {
          vertices: verts, indices: parsed.mesh.indices, geometryKey, albedo, textureKey,
          textureFileBytes, textureUploadBytes, textureResidentBytes, parts,
        };
        this.meshes.set(path, entry);
        this.lastError = null;
        this.retryAt.delete(path);
        this.stats.meshes++;
        // 本次播放新增到 GPU 的几何字节（顶点 + 索引 + 全零 skin slot 24B/顶点）。
        // 贴图字节在 sync 里按内容身份去重后计入，避免同图重复统计。
        this.stats.geometryBytes += verts.byteLength + parsed.mesh.indices.byteLength + count * 24;
        this.stats.uploadBytes = this.stats.geometryBytes + this.stats.textureUploadBytes;
        this.stats.residentBytes = this.stats.geometryBytes + this.stats.textureResidentBytes;
      } catch (e) {
        albedo?.close();
        if (this.disposed || gen !== this.generation) return;
        // 失败要可诊断且可重试：记录原因并从缓存移除，下一次 sync 会重新尝试。
        this.lastError = path + '：' + (e instanceof Error ? e.message : String(e));
        this.meshes.delete(path);
        this.retryAt.set(path, Date.now() + this.retryDelayMs);
      } finally {
        // 只有仍由本次读取持有该 path 的 pending 时才删除；旧代完成不能删掉
        // 新代同路径的 pending（否则会触发第三次读取并污染统计）。
        if (this.pendingToken.get(path) === token) {
          this.pendingToken.delete(path);
          this.pending.delete(path);
        }
      }
    })();
  }
}
