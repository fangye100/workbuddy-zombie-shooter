/**
 * WU-05 碎片动态批次装配的 owner 测试（CPU 侧；真实 GPU 由 headed 验收覆盖）。
 *
 * 覆盖：网格原始 POSITION 减 pivot、实例行/刚体基向量的三轴数学、large 读真实后端
 * 快照、small 读简化 sim、缺失网格不崩、dispose 释放 CPU 缓存且不误动共享资源。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { PlayFractureRenderer } from '../src/services/fracture-renderer';
import { ensureRapier, RapierFractureBackend, type RapierModule } from '@aether/runtime';
import { createFractureRuntime } from '@aether/runtime';
import { frozenFractureEvent } from '@aether/runtime';

const STEP = 1 / 60;
let rapier: RapierModule;
beforeAll(async () => { rapier = await ensureRapier(); }, 30000);
afterEach(() => { vi.unstubAllGlobals(); });

/** 手写合法 GLB：单 mesh 单 primitive，只有 POSITION（无 node 变换）。 */
function makePointCloudGlb(positions: Float32Array): ArrayBuffer {
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    buffers: [{ byteLength: positions.byteLength }],
  };
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonSize = Math.ceil(enc.length / 4) * 4;
  const out = new Uint8Array(28 + jsonSize + positions.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonSize, true); dv.setUint32(16, 0x4e4f534a, true);
  out.fill(32, 20, 20 + jsonSize); out.set(enc, 20);
  dv.setUint32(20 + jsonSize, positions.byteLength, true); dv.setUint32(24 + jsonSize, 0x004e4942, true);
  out.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), 28 + jsonSize);
  return out.buffer;
}

/** 合法 GLB：声明 baseColorTexture，但 images 为空（无可用内嵌图）。 */
function makeTexturedGlbWithoutImage(positions: Float32Array): ArrayBuffer {
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }], images: [],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    buffers: [{ byteLength: positions.byteLength }],
  };
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonSize = Math.ceil(enc.length / 4) * 4;
  const out = new Uint8Array(28 + jsonSize + positions.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonSize, true); dv.setUint32(16, 0x4e4f534a, true);
  out.fill(32, 20, 20 + jsonSize); out.set(enc, 20);
  dv.setUint32(20 + jsonSize, positions.byteLength, true); dv.setUint32(24 + jsonSize, 0x004e4942, true);
  out.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), 28 + jsonSize);
  return out.buffer;
}

function makeIO(glbs: Record<string, ArrayBuffer>) {
  return {
    async readText(): Promise<string> { throw new Error('不需要文本'); },
    async readBinary(path: string): Promise<ArrayBuffer> {
      const b = glbs[path];
      if (b === undefined) throw new Error('未找到 ' + path);
      return b.slice(0);
    },
  };
}

const ev = frozenFractureEvent({
  sequence: 1, tick: 0, seed: 1,
  profile: { path: 'p.fracture.json', guid: 'g' },
  target: { kind: 'scene-object', runId: 'r', nodeId: 'n' },
  position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  contact: [0, 0, 0], normal: [0, 1, 0], impulse: [1, 0, 0],
  source: { weaponId: 'w', hitSequence: 1 },
});

describe('WU-05 碎片动态批次装配', () => {
  it('几何保持原始坐标，实例平移补偿 pivot；基向量含旋转与尺度', async () => {
    // 顶点在 (10,2,20) 等已知位置；pivot=(9,1,19)。几何不再预减 pivot，
    // 由实例平移 position - R·pivot 补偿，多个合法 pivot 才能共享同一份几何。
    const glb = makePointCloudGlb(new Float32Array([10, 2, 20, 12, 2, 20, 10, 6, 24]));
    const io = makeIO({ 'chunk.glb': glb });
    const renderer = new PlayFractureRenderer(io);

    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, 0, 0] });
    const rt = createFractureRuntime(backend);
    const q: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]; // 绕 Z 90°
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'large',
        mesh: { path: 'chunk.glb', guid: 'g1' },
        position: [5, 3, 1], rotation: q, scale: 2,
        shape: { type: 'sphere', radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [9, 1, 19],
        linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
      }],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();

    renderer.sync(rt, backend);
    // 首帧网格仍在异步加载 → 无批次；等待加载完成后再同步
    await new Promise((r) => setTimeout(r, 30));
    renderer.sync(rt, backend);
    expect(renderer.dynamicBatches.length).toBe(1);
    const batch = renderer.dynamicBatches[0];
    expect(batch).toBeDefined();
    if (batch === undefined) return;
    expect(batch.count).toBe(1);
    expect(batch.rigid).toBeDefined();
    // 顶点：保持资产原始坐标，保留 15 浮点步长
    const v0 = batch.vertices;
    expect(v0[0]).toBeCloseTo(10, 5);
    expect(v0[1]).toBeCloseTo(2, 5);
    expect(v0[2]).toBeCloseTo(20, 5);
    expect(v0[15]).toBeCloseTo(12, 5);
    // 基向量：绕 Z 90° + scale 2 → 列 0 = (0,2,0)，列 1 = (-2,0,0)
    const r = batch.rigid!;
    expect(r[0]).toBeCloseTo(0, 5);  expect(r[1]).toBeCloseTo(2, 5);  expect(r[2]).toBeCloseTo(0, 5);
    expect(r[4]).toBeCloseTo(-2, 5); expect(r[5]).toBeCloseTo(0, 5);  expect(r[6]).toBeCloseTo(0, 5);
    expect(r[8]).toBeCloseTo(0, 5);  expect(r[9]).toBeCloseTo(0, 5);  expect(r[10]).toBeCloseTo(2, 5);
    // 实例平移来自真实后端快照并减掉 R·pivot：
    // R·(9,1,19) = (-2,18,38)，snapshot=(5,3,1) → (7,-15,-37)
    expect(batch.instances[0]).toBeCloseTo(7, 4);
    expect(batch.instances[1]).toBeCloseTo(-15, 4);
    expect(batch.instances[2]).toBeCloseTo(-37, 4);
    // 闭式世界位置 = position + R·(raw - pivot) = (3,5,3)
    const world = [
      r[0]! * v0[0]! + r[4]! * v0[1]! + r[8]! * v0[2]! + batch.instances[0]!,
      r[1]! * v0[0]! + r[5]! * v0[1]! + r[9]! * v0[2]! + batch.instances[1]!,
      r[2]! * v0[0]! + r[6]! * v0[1]! + r[10]! * v0[2]! + batch.instances[2]!,
    ];
    expect(world[0]).toBeCloseTo(3, 4);
    expect(world[1]).toBeCloseTo(5, 4);
    expect(world[2]).toBeCloseTo(3, 4);
    expect((batch.instances[14] ?? 0) & 2).toBe(2);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('正式 chunk GLB 的材质路由：外表面带贴图、切口纯色', async () => {
    const binGlob = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
    const key = Object.keys(binGlob).find((k) => /p01-barrel\/chunk-0001\.glb$/.test(k))!;
    const bytes = await binGlob[key]!();
    // Node 没有图片解码器：用 4×4 位图替身，让带贴图的资产走成功路径。
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4, height: 4, close: () => {} } as unknown as ImageBitmap)));
    const io = {
      async readText(): Promise<string> { throw new Error('不需要文本'); },
      async readBinary(): Promise<ArrayBuffer> { return bytes.slice().buffer; },
    };
    const renderer = new PlayFractureRenderer(io);
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'large',
        mesh: { path: 'chunk-0001.glb', guid: 'g1' },
        position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: 1,
        shape: { type: 'sphere', radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [0.162673, 0.114231, 0.168472],
        linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
      }],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);              // 触发异步加载
    for (let i = 0; i < 100 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(rt, backend);
    }
    // 两个子网格：外表面（贴图，albedo 非空）+ 切口（纯色，albedo 为空且带深色 tint）
    expect(renderer.dynamicBatches.length).toBe(2);
    // 用 tint 区分两类子网格（贴图外表面为白 tint，切口为 baseColorFactor）
    const solid = renderer.dynamicBatches.find((b) => Math.abs(b.instances[8]! - 1) > 0.01)!;
    const textured = renderer.dynamicBatches.find((b) => Math.abs(b.instances[8]! - 1) <= 0.01)!;
    expect(textured).toBeDefined();
    expect(solid).toBeDefined();
    // 两个子网格的索引区间互不重叠且合计等于整网格
    expect(textured.indexStart).toBe(0);
    expect(solid.indexStart).toBe(textured.indexCount);
    // 切口纯色 tint 来自材质 baseColorFactor（0.09,0.062,0.055）
    expect(solid.instances[8]).toBeCloseTo(0.09, 3);
    expect(solid.instances[9]).toBeCloseTo(0.062, 3);
    expect(solid.instances[10]).toBeCloseTo(0.055, 3);
    // 外表面 tint 为白（颜色由贴图提供）
    expect(textured.instances[8]).toBeCloseTo(1, 5);
    // 两者共用同一 geometry key（core 只上传一次顶点/索引）
    expect(textured.meshId).toBe(solid.meshId);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('TTL 到期后实例从批次中移除（不留下残影）', async () => {
    const glb = makePointCloudGlb(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const io = makeIO({ 'chunk.glb': glb });
    const renderer = new PlayFractureRenderer(io);
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'small',
        mesh: { path: 'chunk.glb', guid: 'g1' },
        position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: 1,
        shape: { type: 'sphere', radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [0, 0, 0],
        linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
      }],
      priority: 1, lifetimeSec: 0.1, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);
    for (let i = 0; i < 60 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(rt, backend);
    }
    expect(renderer.dynamicBatches.length).toBeGreaterThan(0);
    // 推进超过 lifetime（0.1s @1/60 ≈ 6 tick）
    for (let i = 0; i < 12; i++) rt.stepOnce();
    renderer.sync(rt, backend);
    expect(rt.active.length).toBe(0);
    expect(renderer.dynamicBatches.length).toBe(0);   // 实例随到期移除
    expect(renderer.stats.instances).toBe(0);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('Stop 之后才完成的网格读取被丢弃（不复活缓存、不泄漏 ImageBitmap）', async () => {
    const glb = makePointCloudGlb(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    let release: (() => void) | null = null;
    const io = {
      async readText(): Promise<string> { throw new Error('不需要'); },
      async readBinary(): Promise<ArrayBuffer> {
        await new Promise<void>((r) => { release = r; });
        return glb.slice(0);
      },
    };
    const renderer = new PlayFractureRenderer(io as never);
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'small',
        mesh: { path: 'late.glb', guid: 'g1' },
        position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: 1,
        shape: { type: 'sphere', radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [0, 0, 0],
        linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
      }],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);           // 触发读取并挂起
    await new Promise((r) => setTimeout(r, 20));
    renderer.dispose();                    // Stop
    release!();                            // 迟到的读取完成
    await new Promise((r) => setTimeout(r, 40));
    // 迟到结果不得回填：无缓存、无统计、无批次
    expect((renderer as unknown as { meshes: Map<string, unknown> }).meshes.size).toBe(0);
    expect(renderer.stats.meshes).toBe(0);
    expect(renderer.dynamicBatches.length).toBe(0);
    rt.dispose();
  }, 30000);

  it('网格读取失败可诊断且不是永久负缓存', async () => {
    let fail = true;
    const glb = makePointCloudGlb(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const io = {
      async readText(): Promise<string> { throw new Error('不需要'); },
      async readBinary(): Promise<ArrayBuffer> {
        if (fail) throw new Error('EIO 坏资产');
        return glb.slice(0);
      },
    };
    // 5ms 重试间隔，验证"失败后能重试成功"而不是只看到错误
    const renderer = new PlayFractureRenderer(io as never, { retryDelayMs: 5 });
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'small',
        mesh: { path: 'bad.glb', guid: 'g1' },
        position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: 1,
        shape: { type: 'sphere', radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [0, 0, 0],
        linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
      }],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);
    for (let i = 0; i < 50 && renderer.error === null; i++) await new Promise((r) => setTimeout(r, 10));
    // 失败有诊断（路径 + 原因），且不画
    expect(renderer.error).toContain('bad.glb');
    expect(renderer.error).toContain('EIO');
    expect(renderer.dynamicBatches.length).toBe(0);
    // 恢复资产后应能重试成功（不是永久负缓存）
    fail = false;
    for (let i = 0; i < 100 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(rt, backend);
    }
    expect(renderer.error).toBeNull();
    expect(renderer.dynamicBatches.length).toBeGreaterThan(0);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('Reset 换绑后迟到的读取被丢弃（beginGeneration 隔离旧代）', async () => {
    const glb = makePointCloudGlb(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    let release: (() => void) | null = null;
    const io = {
      async readText(): Promise<string> { throw new Error('不需要'); },
      async readBinary(): Promise<ArrayBuffer> { await new Promise<void>((r) => { release = r; }); return glb.slice(0); },
    };
    const renderer = new PlayFractureRenderer(io as never);
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'small',
        mesh: { path: 'reset-late.glb', guid: 'g1' },
        position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: 1,
        shape: { type: 'sphere', radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [0, 0, 0],
        linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
      }],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);
    await new Promise((r) => setTimeout(r, 20));
    renderer.beginGeneration();     // Reset 换绑
    release!();
    await new Promise((r) => setTimeout(r, 40));
    expect((renderer as unknown as { meshes: Map<string, unknown> }).meshes.size).toBe(0);
    expect(renderer.stats.meshes).toBe(0);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('旧代读取完成不删除新代同路径的 pending（不会触发第三次读取）', async () => {
    const glb = makePointCloudGlb(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const releases: (() => void)[] = [];
    let calls = 0;
    const io = {
      async readText(): Promise<string> { throw new Error('不需要'); },
      async readBinary(): Promise<ArrayBuffer> {
        calls++;
        await new Promise<void>((r) => releases.push(r));
        return glb.slice(0);
      },
    };
    const renderer = new PlayFractureRenderer(io as never);
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    const mkChunk = () => ({
      chunkId: 'c1', cls: 'small' as const,
      mesh: { path: 'shared-late.glb', guid: 'g1' },
      position: [0, 2, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: 1,
      shape: { type: 'sphere' as const, radius: 0.25 },
      mass: 1, friction: 0.5, restitution: 0, pivot: [0, 0, 0] as [number, number, number],
      linearVelocity: [0, 0, 0] as [number, number, number],
      angularVelocity: [0, 0, 0] as [number, number, number],
    });
    expect(rt.play({ event: ev, chunks: [mkChunk()], priority: 1, lifetimeSec: 10, fadeSec: 0 }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);              // 第 1 次读取（挂起）
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);

    renderer.beginGeneration();              // Reset 换绑
    renderer.sync(rt, backend);              // 新代对同路径发起第 2 次读取
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(2);

    releases[0]!();                           // 旧代先完成
    await new Promise((r) => setTimeout(r, 30));
    // 旧代完成不得删掉新代的 pending → 不应有第 3 次读取
    expect(calls).toBe(2);

    releases[1]!();                           // 新代完成
    await new Promise((r) => setTimeout(r, 30));
    renderer.sync(rt, backend);
    expect(renderer.stats.meshes).toBe(1);
    expect(renderer.dynamicBatches.length).toBeGreaterThan(0);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('同几何不同实例合并进一个批次（不按实例数放大 draw）', async () => {
    const glb = makePointCloudGlb(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const io = makeIO({ 'shared.glb': glb });
    const renderer = new PlayFractureRenderer(io);
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    const mk = (id: string, x: number) => ({
      chunkId: id, cls: 'large' as const,
      mesh: { path: 'shared.glb', guid: 'g1' },
      position: [x, 2, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: 1,
      shape: { type: 'sphere' as const, radius: 0.25 },
      mass: 1, friction: 0.5, restitution: 0, pivot: [0, 0, 0] as [number, number, number],
      linearVelocity: [0, 0, 0] as [number, number, number],
      angularVelocity: [0, 0, 0] as [number, number, number],
    });
    expect(rt.play({ event: ev, chunks: [mk('a', 0), mk('b', 1), mk('c', 2)], priority: 1, lifetimeSec: 10, fadeSec: 0 }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);
    for (let i = 0; i < 60 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(rt, backend);
    }
    // 3 个同几何实例 → 1 个批次（count=3），不是 3 个批次
    expect(renderer.dynamicBatches.length).toBe(1);
    expect(renderer.dynamicBatches[0]!.count).toBe(3);
    expect(renderer.dynamicBatches[0]!.instances.length).toBe(3 * 20);
    expect(renderer.dynamicBatches[0]!.rigid!.length).toBe(3 * 12);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('同 GLB 不同合法 pivot 共享几何但各自补偿，不串位', async () => {
    const glb = makePointCloudGlb(new Float32Array([10, 2, 20, 12, 2, 20, 10, 6, 24]));
    const renderer = new PlayFractureRenderer(makeIO({ 'chunk.glb': glb }));
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, 0, 0] });
    const rt = createFractureRuntime(backend);
    const mk = (id: string, pivot: [number, number, number], x: number) => ({
      chunkId: id, cls: 'large' as const,
      mesh: { path: 'chunk.glb', guid: 'g1' },
      position: [x, 3, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: 1,
      shape: { type: 'sphere' as const, radius: 0.25 },
      mass: 1, friction: 0.5, restitution: 0, pivot,
      linearVelocity: [0, 0, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number],
    });
    expect(rt.play({
      event: ev, chunks: [mk('a', [0, 0, 0], 0), mk('b', [2, 0, 0], 10)],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);
    for (let i = 0; i < 100 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(rt, backend);
    }
    // 同几何同材质仍合批：1 批 2 实例，不是按 pivot 复制几何
    expect(renderer.dynamicBatches.length).toBe(1);
    const batch = renderer.dynamicBatches[0]!;
    expect(batch.count).toBe(2);
    const rendered: number[] = [];
    for (let n = 0; n < batch.count; n++) rendered.push(batch.instances[n * 20]! + batch.vertices[0]!);
    rendered.sort((a, b) => a - b);
    // 原始顶点 x=10；pivot 0 / 2 分别得到世界 10 / 18（错位修复前是 10 / 20）
    expect(rendered[0]).toBeCloseTo(10, 4);
    expect(rendered[1]).toBeCloseTo(18, 4);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('换代重置后同路径重新装配仍按当前 pivot 定向', async () => {
    const glb = makePointCloudGlb(new Float32Array([10, 2, 20, 12, 2, 20, 10, 6, 24]));
    const renderer = new PlayFractureRenderer(makeIO({ 'chunk.glb': glb }));
    const mkPlay = (pivot: [number, number, number], x: number) => {
      const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, 0, 0] });
      const rt = createFractureRuntime(backend);
      expect(rt.play({
        event: ev,
        chunks: [{
          chunkId: 'c1', cls: 'large' as const,
          mesh: { path: 'chunk.glb', guid: 'g1' },
          position: [x, 3, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: 1,
          shape: { type: 'sphere' as const, radius: 0.25 },
          mass: 1, friction: 0.5, restitution: 0, pivot,
          linearVelocity: [0, 0, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number],
        }],
        priority: 1, lifetimeSec: 10, fadeSec: 0,
      }).accepted).toBe(true);
      rt.stepOnce();
      return { rt, backend };
    };
    const first = mkPlay([2, 0, 0], 10);
    renderer.sync(first.rt, first.backend);
    for (let i = 0; i < 100 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(first.rt, first.backend);
    }
    expect(renderer.dynamicBatches[0]!.instances[0]).toBeCloseTo(8, 4);
    renderer.beginGeneration();
    first.rt.dispose();

    const second = mkPlay([0, 0, 0], 0);
    renderer.sync(second.rt, second.backend);
    for (let i = 0; i < 100 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(second.rt, second.backend);
    }
    // 换代后必须重新装配当前 pivot，而不是复用上一代平移
    expect(renderer.stats.meshes).toBe(1);
    expect(renderer.dynamicBatches[0]!.instances[0]).toBeCloseTo(0, 4);
    second.rt.dispose();
    renderer.dispose();
  }, 30000);

  it('统计区分编码文件字节、解码像素提交与含 mip 驻留', async () => {
    const binGlob = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
    const key = Object.keys(binGlob).find((k) => /p01-barrel\/chunk-0001\.glb$/.test(k))!;
    const bytes = await binGlob[key]!();
    const io = {
      async readText(): Promise<string> { throw new Error('不需要文本'); },
      async readBinary(): Promise<ArrayBuffer> { return bytes.slice().buffer; },
    };
    // Node 没有图片解码器：用与正式 P-01 一致的 4096² RGBA8 尺寸替身，只验证口径。
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4096, height: 4096, close: () => {} } as unknown as ImageBitmap)));
    const renderer = new PlayFractureRenderer(io);
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, 0, 0] });
    const rt = createFractureRuntime(backend);
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'large' as const,
        mesh: { path: 'chunk-0001.glb', guid: 'g1' },
        position: [0, 3, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: 1,
        shape: { type: 'sphere' as const, radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [0.162673, 0.114231, 0.168472] as [number, number, number],
        linearVelocity: [0, 0, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number],
      }],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);
    for (let i = 0; i < 100 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(rt, backend);
    }
    const s = renderer.stats;
    expect(s.textures).toBe(1);
    expect(s.textureFileBytes).toBeGreaterThan(0);
    expect(s.textureUploadBytes).toBe(4096 * 4096 * 4);
    expect(s.textureResidentBytes).toBeGreaterThan(s.textureUploadBytes);
    // 文件压缩体积不能冒充 GPU 提交量
    expect(s.textureFileBytes).not.toBe(s.textureUploadBytes);
    expect(s.uploadBytes).toBe(s.geometryBytes + s.textureUploadBytes);
    expect(s.residentBytes).toBe(s.geometryBytes + s.textureResidentBytes);
    // Reset 后 core 复用同一 GPUTexture：只重新上传几何，不再把 67MB 贴图算作新上传。
    renderer.beginGeneration();
    renderer.sync(rt, backend);
    for (let i = 0; i < 100 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(rt, backend);
    }
    const after = renderer.stats;
    expect(after.textures).toBe(1);
    expect(after.textureUploadBytes).toBe(0);
    expect(after.textureResidentBytes).toBeGreaterThan(0);
    expect(after.geometryBytes).toBeGreaterThan(0);
    expect(after.uploadBytes).toBe(after.geometryBytes);
    expect(after.residentBytes).toBe(after.geometryBytes + after.textureResidentBytes);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('Reset 换代后同路径新字节产生新 meshId 与新顶点（不沿用旧 GPU 几何身份）', async () => {
    let x = 10;
    const io = {
      async readText(): Promise<string> { throw new Error('不需要'); },
      async readBinary(): Promise<ArrayBuffer> {
        return makePointCloudGlb(new Float32Array([x, 2, 20, x + 2, 2, 20, x, 6, 24]));
      },
    };
    const renderer = new PlayFractureRenderer(io);
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, 0, 0] });
    const rt = createFractureRuntime(backend);
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'large' as const,
        mesh: { path: 'same.glb', guid: 'g1' },
        position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: 1,
        shape: { type: 'sphere' as const, radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [0, 0, 0] as [number, number, number],
        linearVelocity: [0, 0, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number],
      }],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);
    for (let i = 0; i < 100 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(rt, backend);
    }
    const first = renderer.dynamicBatches[0]!;
    expect(first.vertices[0]).toBeCloseTo(10, 5);
    const firstMeshId = first.meshId;

    renderer.beginGeneration();
    x = 20;
    renderer.sync(rt, backend);
    for (let i = 0; i < 100 && renderer.dynamicBatches.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      renderer.sync(rt, backend);
    }
    const second = renderer.dynamicBatches[0]!;
    expect(second.vertices[0]).toBeCloseTo(20, 5);
    expect(second.meshId).not.toBe(firstMeshId);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('声明 baseColorTexture 但缺图时记录诊断并允许重试，不静默白材质', async () => {
    const glb = makeTexturedGlbWithoutImage(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    let reads = 0;
    const io = {
      async readText(): Promise<string> { throw new Error('不需要'); },
      async readBinary(): Promise<ArrayBuffer> { reads++; return glb.slice(0); },
    };
    const renderer = new PlayFractureRenderer(io, { retryDelayMs: 5 });
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, 0, 0] });
    const rt = createFractureRuntime(backend);
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'large' as const,
        mesh: { path: 'broken-texture.glb', guid: 'g1' },
        position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: 1,
        shape: { type: 'sphere' as const, radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [0, 0, 0] as [number, number, number],
        linearVelocity: [0, 0, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number],
      }],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    renderer.sync(rt, backend);
    await new Promise((r) => setTimeout(r, 40));
    renderer.sync(rt, backend);
    expect(renderer.error).toMatch(/baseColorTexture|贴图/);
    expect(renderer.dynamicBatches.length).toBe(0);
    expect(renderer.stats.meshes).toBe(0);
    const before = reads;
    await new Promise((r) => setTimeout(r, 20));
    renderer.sync(rt, backend);
    expect(reads).toBeGreaterThan(before);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('small 块读简化 sim；缺失网格不会抛错', () => {
    const renderer = new PlayFractureRenderer(makeIO({}));
    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
    const rt = createFractureRuntime(backend);
    expect(rt.play({
      event: ev,
      chunks: [{
        chunkId: 'c1', cls: 'small',
        mesh: { path: 'missing.glb', guid: 'g1' },
        position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: 1,
        shape: { type: 'sphere', radius: 0.25 },
        mass: 1, friction: 0.5, restitution: 0, pivot: [0, 0, 0],
        linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0],
      }],
      priority: 1, lifetimeSec: 10, fadeSec: 0,
    }).accepted).toBe(true);
    rt.stepOnce();
    expect(() => renderer.sync(rt, backend)).not.toThrow();
    expect(renderer.dynamicBatches.length).toBe(0);
    rt.dispose();
    renderer.dispose();
  }, 30000);
});
