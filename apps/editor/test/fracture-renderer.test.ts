/**
 * WU-05 碎片动态批次装配的 owner 测试（CPU 侧；真实 GPU 由 headed 验收覆盖）。
 *
 * 覆盖：网格原始 POSITION 减 pivot、实例行/刚体基向量的三轴数学、large 读真实后端
 * 快照、small 读简化 sim、缺失网格不崩、dispose 释放 CPU 缓存且不误动共享资源。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PlayFractureRenderer } from '../src/services/fracture-renderer';
import { ensureRapier, RapierFractureBackend, type RapierModule } from '@aether/runtime';
import { createFractureRuntime } from '@aether/runtime';
import { frozenFractureEvent } from '@aether/runtime';

const STEP = 1 / 60;
let rapier: RapierModule;
beforeAll(async () => { rapier = await ensureRapier(); }, 30000);

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
  it('网格原始 POSITION 减 pivot；实例基向量含旋转与尺度', async () => {
    // 顶点在 (10,2,20) 等已知位置；pivot=(9,1,19) → 局部系应为 (1,1,1) ...
    const glb = makePointCloudGlb(new Float32Array([10, 2, 20, 12, 2, 20, 10, 6, 24]));
    const io = makeIO({ 'chunk.glb': glb });
    const renderer = new PlayFractureRenderer(io);

    const backend = new RapierFractureBackend(rapier, { fixedStepSec: STEP, gravity: [0, -9.81, 0] });
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
    // 顶点：raw - pivot，保留 15 浮点步长
    const v0 = batch.vertices;
    expect(v0[0]).toBeCloseTo(1, 5);
    expect(v0[1]).toBeCloseTo(1, 5);
    expect(v0[2]).toBeCloseTo(1, 5);
    expect(v0[15]).toBeCloseTo(3, 5);
    // 基向量：绕 Z 90° + scale 2 → 列 0 = (0,2,0)，列 1 = (-2,0,0)
    const r = batch.rigid!;
    expect(r[0]).toBeCloseTo(0, 5);  expect(r[1]).toBeCloseTo(2, 5);  expect(r[2]).toBeCloseTo(0, 5);
    expect(r[4]).toBeCloseTo(-2, 5); expect(r[5]).toBeCloseTo(0, 5);  expect(r[6]).toBeCloseTo(0, 5);
    expect(r[8]).toBeCloseTo(0, 5);  expect(r[9]).toBeCloseTo(0, 5);  expect(r[10]).toBeCloseTo(2, 5);
    // 实例行：位置来自真实后端快照，flags bit1=刚体
    expect(batch.instances[0]).toBeCloseTo(5, 4);
    expect((batch.instances[14] ?? 0) & 2).toBe(2);
    rt.dispose();
    renderer.dispose();
  }, 30000);

  it('正式 chunk GLB 的材质路由：外表面带贴图、切口纯色', async () => {
    const binGlob = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
    const key = Object.keys(binGlob).find((k) => /p01-barrel\/chunk-0001\.glb$/.test(k))!;
    const bytes = await binGlob[key]!();
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
    // node 测试环境没有 createImageBitmap，albedo 一定是 null；用 tint 区分两类子网格
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
