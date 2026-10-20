/**
 * WU-05 碎片动态渲染装配：把 WU-04 的 ActiveChunk 打包成原 CoreDynamicBatch 实例。
 *
 * 责任边界：
 * - 只做「运行状态 → 实例行/刚体基向量」的打包与网格/贴图缓存，不复制渲染器、材质或动画系统；
 * - 复用原动态 shader 的 20-float 行与 binding 6 刚体基向量；旧角色分支（无 bit1）不受影响；
 * - 不占静态 64 槽；Play 期新增的 GPU 资源由 renderer-core 持有，Stop 由 core 统一 destroy。
 *
 * 坐标合同（与 WU-04 一致）：chunk 网格原始 POSITION 先减 profile.pivot，再由实例
 * 基向量（rotation × worldScale）与实例位置组合一次；法线走同一基。
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
  albedo: ImageBitmap | null;
  pivot: [number, number, number];
  parts: SubPart[];
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
  /** 已加载网格数 / 最近一次同步的实例数与三角形数（供验收观察）。 */
  readonly stats = { meshes: 0, instances: 0, triangles: 0, uploadBytes: 0 };

  constructor(io: FractureAssetIO) {
    this.io = io;
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
    const groups = new Map<string, { batch: CoreDynamicBatch; instRows: Float32Array[]; rigidRows: Float32Array[] }>();

    for (const chunk of active) {
      if (chunk.expired) continue;
      if (!this.meshes.has(chunk.mesh.path) && !this.pending.has(chunk.mesh.path)) {
        // 首次出现（或上次失败）：异步加载；失败后 2s 内不重复轰炸，之后可重试。
        const waitUntil = this.retryAt.get(chunk.mesh.path) ?? 0;
        if (Date.now() >= waitUntil) this.loadMesh(chunk.mesh.path, chunk.pivot);
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

      // 逐子网格分组：同一 (meshId, 索引区间, 材质) 的实例合并进同一批，
      // 重复几何不会按实例数放大 draw。
      for (const part of entry.parts) {
        const inst = new Float32Array(DYNAMIC_INSTANCE_FLOATS);
        inst[0] = px; inst[1] = py; inst[2] = pz; inst[3] = 0;
        inst[4] = 1; inst[5] = 1; inst[6] = 1; inst[7] = 0;   // 基向量已含尺度，行内 scale 保持 1
        const tint = part.tint ?? [1, 1, 1];
        inst[8] = tint[0]; inst[9] = tint[1]; inst[10] = tint[2]; inst[11] = 0;
        inst[12] = 0; inst[13] = 0; inst[14] = 2; inst[15] = 0; // flags bit1 = 刚体模式
        inst[16] = 1; inst[17] = 0; inst[18] = 0; inst[19] = 0;

        const key = chunk.mesh.path + '|' + part.indexStart + '|' + part.indexCount + '|' + (part.textured ? 't' : 's');
        const hit = groups.get(key);
        if (hit === undefined) {
          groups.set(key, {
            batch: {
              meshId: 'fracture:' + chunk.mesh.path,
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
            },
            instRows: [inst],
            rigidRows: [rigid],
          });
        } else {
          hit.instRows.push(inst);
          hit.rigidRows.push(rigid);
        }
        this.stats.instances++;
        this.stats.triangles += part.indexCount / 3;
      }
    }
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

  /** 释放本组件的 CPU 缓存与 ImageBitmap（GPU buffer 由 renderer-core 统一释放）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    for (const e of this.meshes.values()) e?.albedo?.close();
    this.meshes.clear();
    this.pending.clear();
    this.retryAt.clear();
    this.lastError = null;
    this.batches = [];
    this.stats.meshes = 0;
    this.stats.instances = 0;
    this.stats.triangles = 0;
    this.stats.uploadBytes = 0;
  }

  private loadMesh(path: string, pivot: readonly [number, number, number] | null): void {
    const pivotKey: [number, number, number] = pivot === null ? [0, 0, 0] : [pivot[0], pivot[1], pivot[2]];
    const gen = this.generation;
    this.pending.add(path);
    void (async (): Promise<void> => {
      let albedo: ImageBitmap | null = null;
      try {
        const bytes = await this.io.readBinary(path);
        const parsed = parseGlb(bytes, null, 'auto', { normalize: false });
        const raw = parsed.mesh.vertices;
        // 网格局部系以 pivot 为原点：raw 坐标逐顶点减去 pivot（保留法线/UV/颜色分量）
        const stride = 15;
        const count = Math.floor(raw.length / stride);
        const verts = new Float32Array(raw.length);
        verts.set(raw);
        for (let i = 0; i < count; i++) {
          const o = i * stride;
          verts[o] = raw[o]! - pivotKey[0];
          verts[o + 1] = raw[o + 1]! - pivotKey[1];
          verts[o + 2] = raw[o + 2]! - pivotKey[2];
        }
        if (parsed.image !== null && typeof createImageBitmap === 'function') {
          albedo = await createImageBitmap(parsed.image).catch(() => null);
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
        // Stop/换代之后才完成的读取：丢弃结果、关闭 bitmap，不写回缓存/统计。
        if (this.disposed || gen !== this.generation) {
          albedo?.close();
          return;
        }
        const entry: MeshEntry = { vertices: verts, indices: parsed.mesh.indices, albedo, pivot: pivotKey, parts };
        this.meshes.set(path, entry);
        this.lastError = null;
        this.retryAt.delete(path);
        this.stats.meshes++;
        // 本次播放新增到 GPU 的几何字节（顶点 + 索引 + 全零 skin slot 24B/顶点）
        this.stats.uploadBytes += verts.byteLength + parsed.mesh.indices.byteLength + Math.floor(verts.length / 15) * 24;
      } catch (e) {
        albedo?.close();
        if (this.disposed || gen !== this.generation) return;
        // 失败要可诊断且可重试：记录原因并从缓存移除，下一次 sync 会重新尝试。
        this.lastError = path + '：' + (e instanceof Error ? e.message : String(e));
        this.meshes.delete(path);
        this.retryAt.set(path, Date.now() + 2000);
      } finally {
        this.pending.delete(path);
      }
    })();
  }
}
