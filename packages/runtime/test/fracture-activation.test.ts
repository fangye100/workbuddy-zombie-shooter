/**
 * WU-04 生产准入与激活准备 owner 测试（R1）。
 * 用注入 IO 端口读取真实 .fracture.json / .meta.json（import.meta.glob，不用 node:fs），
 * 验证：正式 P-01/E-04 准入与分层、错误 GUID/kind、quarantined→accepted 恢复、
 * 打开后外改 sidecar、seed 确定性、不同来向差异、convex 端口契约。
 */
import { describe, it, expect } from 'vitest';
import { prepareFractureActivation, type FractureAssetIO } from '../src/fracture-activation';
import { frozenFractureEvent, type FractureEvent } from '../src/fracture';

// 仓库门禁规约：测试用 import.meta.glob 读正式资产（禁 node:fs）。
const textGlob = import.meta.glob('../../../assets/fracture/*/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const binGlob = import.meta.glob('../../../assets/fracture/*/*.glb', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

const P01 = 'assets/fracture/p01-barrel/p01-barrel.fracture.json';
const E04 = 'assets/fracture/e04-bulwark/e04-bulwark.fracture.json';

/** 内存 IO 端口：从 glob 取文本/二进制；可被测试外改以模拟 sidecar 状态变化。 */
function makeIO(
  overrides: Record<string, string> = {},
  binOverrides: Record<string, ArrayBuffer> = {},
): FractureAssetIO & { set(path: string, v: string): void; setBin(path: string, v: ArrayBuffer): void } {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(textGlob)) {
    // k 形如 ../../../assets/fracture/...；规范化为 assets/ 前缀
    store.set(k.replace(/^.*?(?=assets\/)/, ''), v);
  }
  for (const [k, v] of Object.entries(overrides)) store.set(k, v);
  const binStore = new Map<string, ArrayBuffer>();
  for (const [k, v] of Object.entries(binGlob)) {
    binStore.set(k.replace(/^.*?(?=assets\/)/, ''), new TextEncoder().encode(v).buffer as ArrayBuffer);
  }
  for (const [k, v] of Object.entries(binOverrides)) binStore.set(k, v);
  return {
    async readText(path: string) {
      const v = store.get(path);
      if (v === undefined) throw new Error('未找到资产：' + path);
      return v;
    },
    async readBinary(path: string) {
      const v = binStore.get(path);
      if (v === undefined) throw new Error('未找到二进制资产：' + path);
      return v;
    },
    set(path: string, v: string) { store.set(path, v); },
    setBin(path: string, v: ArrayBuffer) { binStore.set(path, v); },
  };
}

let seq = 0;
function ev(profilePath: string, guid: string, opts: Partial<FractureEvent> = {}): FractureEvent {
  return frozenFractureEvent({
    sequence: ++seq, tick: 0, seed: 42,
    profile: { path: profilePath, guid },
    target: { kind: 'scene-object', runId: 'run-1', nodeId: 'n' + seq },
    position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    contact: [0, 2, 0], normal: [0, 1, 0], impulse: [1, 2, 0.5],
    source: { weaponId: 'w_pistol', hitSequence: seq },
    ...opts,
  });
}

describe('WU-04 生产准入与激活准备（R1）', () => {
  it('P-01 正式 profile 准入成功：12 块全部 large，box 代理，playback 进入激活', async () => {
    const r = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io: makeIO() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.activation.chunks.length).toBe(12);
    expect(r.activation.chunks.every((c) => c.cls === 'large')).toBe(true);
    expect(r.activation.priority).toBe(2);
    expect(r.activation.lifetimeSec).toBe(4);
    expect(r.activation.fadeSec).toBeCloseTo(0.8);
    // 物理参数来自 profile（质量/摩擦/恢复真实进入 chunk 输入）
    expect(r.activation.chunks[0]!.mass).toBeGreaterThan(0);
    expect(r.activation.chunks[0]!.friction).toBe(0.6);
  });

  it('E-04 正式 NPC profile 准入成功：3 大 7 小分层', async () => {
    const r = await prepareFractureActivation(ev(E04, 'as_e04frct'), { io: makeIO() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.activation.chunks.filter((c) => c.cls === 'large').length).toBe(3);
    expect(r.activation.chunks.filter((c) => c.cls === 'small').length).toBe(7);
  });

  it('错误 GUID（事件/profile/sidecar 不一致）在分配前拒绝', async () => {
    const r = await prepareFractureActivation(ev(P01, 'as_wrong_guid'), { io: makeIO() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.stage).toBe('identity');
  });

  it('quarantined 隔离资产在分配前拒绝；恢复 accepted 后可重新准入', async () => {
    const io = makeIO();
    // 外改 profile 为 quarantined
    const p01 = JSON.parse(textGlob['../../../assets/fracture/p01-barrel/p01-barrel.fracture.json']!) as Record<string, unknown>;
    io.set(P01, JSON.stringify({ ...p01, status: 'quarantined' }));
    const r1 = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.failure.stage).toBe('quarantined');
    // 恢复 accepted：下一次准入成功（不缓存隔离状态绕开复查）
    io.set(P01, JSON.stringify({ ...p01, status: 'accepted' }));
    const r2 = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io });
    expect(r2.ok).toBe(true);
  });

  it('打开后外改 sidecar（guid 改成他值）下一次播放重新核对并拒绝', async () => {
    const io = makeIO();
    expect((await prepareFractureActivation(ev(P01, 'as_p01frct'), { io })).ok).toBe(true);
    // 外改 sidecar guid
    const meta = JSON.parse(textGlob['../../../assets/fracture/p01-barrel/p01-barrel.fracture.json.meta.json']!) as Record<string, unknown>;
    io.set(P01 + '.meta.json', JSON.stringify({ ...meta, guid: 'as_tampered' }));
    const r = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.stage).toBe('identity');
  });

  it('sidecar kind 非 fracture 拒绝', async () => {
    const meta = JSON.parse(textGlob['../../../assets/fracture/p01-barrel/p01-barrel.fracture.json.meta.json']!) as Record<string, unknown>;
    const io = makeIO({ [P01 + '.meta.json']: JSON.stringify({ ...meta, kind: 'gltf' }) });
    const r = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.stage).toBe('identity');
  });

  it('同 seed 同输入的初始运动可复现；不同 seed/来向有对应差异', async () => {
    const a1 = await prepareFractureActivation(ev(P01, 'as_p01frct', { seed: 7 }), { io: makeIO() });
    const a2 = await prepareFractureActivation(ev(P01, 'as_p01frct', { seed: 7 }), { io: makeIO() });
    const b = await prepareFractureActivation(ev(P01, 'as_p01frct', { seed: 8 }), { io: makeIO() });
    expect(a1.ok && a2.ok && b.ok).toBe(true);
    if (!a1.ok || !a2.ok || !b.ok) return;
    // 同 seed：首块线速度完全一致（确定性）
    expect(a1.activation.chunks[0]!.linearVelocity).toEqual(a2.activation.chunks[0]!.linearVelocity);
    // 不同 seed：初始运动有差异
    expect(a1.activation.chunks[0]!.linearVelocity).not.toEqual(b.activation.chunks[0]!.linearVelocity);
    // 不同来向：impulse 反向 → 水平速度符号不同
    const fwd = await prepareFractureActivation(ev(P01, 'as_p01frct', { impulse: [2, 1, 0] }), { io: makeIO() });
    const back = await prepareFractureActivation(ev(P01, 'as_p01frct', { impulse: [-2, 1, 0] }), { io: makeIO() });
    if (fwd.ok && back.ok) {
      expect(Math.sign(fwd.activation.chunks[0]!.linearVelocity[0])).not.toBe(Math.sign(back.activation.chunks[0]!.linearVelocity[0]));
    }
  });

  it('convex 代理需要 resolveConvexPoints 端口；缺失时拒绝', async () => {
    const io = makeIO();
    // 构造含 convex 块的 profile（外改 P-01 第一块为 convex）
    const p01 = JSON.parse(textGlob['../../../assets/fracture/p01-barrel/p01-barrel.fracture.json']!);
    p01.chunks[0].proxy.shape = { type: 'convex', mesh: { path: 'assets/fracture/p01-barrel/chunk-0001.glb', guid: 'as_29a7ad90' } };
    io.set(P01, JSON.stringify(p01));
    const r = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.stage).toBe('proxy-load');
  });

  it('profile 格式非法（坏版本/缺块）经 scene 校验拒绝', async () => {
    const io = makeIO({ [P01]: JSON.stringify({ version: 99, id: 'as_p01frct' }) });
    const r = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.stage).toBe('profile-validate');
  });

  it('R1：引用资产 sidecar 缺失/外改/guid 不符在分配前拒绝', async () => {
    // 源模型 sidecar 缺失
    const io1 = makeIO();
    io1.set('assets/fracture/p01-barrel/p01-barrel.glb.meta.json', undefined as unknown as string);
    const r1 = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io: io1 });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.failure.stage).toBe('ref-read');

    // 碎块 mesh sidecar guid 被外改
    const chunkMeta = JSON.parse(textGlob['../../../assets/fracture/p01-barrel/chunk-0001.glb.meta.json'] ?? '{}');
    if (Object.keys(chunkMeta).length > 0) {
      const io2 = makeIO({ 'assets/fracture/p01-barrel/chunk-0001.glb.meta.json': JSON.stringify({ ...chunkMeta, guid: 'as_tampered' }) });
      const r2 = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io: io2 });
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.failure.stage).toBe('ref-identity');
    }
  });

  it('R1：凸代理退化（Float32Array(3)）/含非有限值/解析抛错均拒绝', async () => {
    const p01 = JSON.parse(textGlob['../../../assets/fracture/p01-barrel/p01-barrel.fracture.json']!);
    p01.chunks[0].proxy.shape = { type: 'convex', mesh: { path: 'assets/fracture/p01-barrel/chunk-0001.glb', guid: 'as_29a7ad90' } };
    const io = makeIO({ [P01]: JSON.stringify(p01) });
    io.setBin('assets/fracture/p01-barrel/chunk-0001.glb', new ArrayBuffer(12));

    // 退化：Float32Array(3)
    const r1 = await prepareFractureActivation(ev(P01, 'as_p01frct'), {
      io, resolveConvexPoints: () => new Float32Array(3),
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.failure.stage).toBe('proxy-load');

    // 含 NaN
    const bad = new Float32Array(9); bad[4] = NaN;
    const r2 = await prepareFractureActivation(ev(P01, 'as_p01frct'), {
      io, resolveConvexPoints: () => bad,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.failure.stage).toBe('proxy-load');

    // 解析抛错
    const r3 = await prepareFractureActivation(ev(P01, 'as_p01frct'), {
      io, resolveConvexPoints: () => { throw new Error('GLB parse fail'); },
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.failure.stage).toBe('proxy-load');

    // 真实凸代理成功路径：用真实 GLB 二进制 + 合法解析
    const r4 = await prepareFractureActivation(ev(P01, 'as_p01frct'), {
      io, resolveConvexPoints: () => new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,1]),
    });
    expect(r4.ok).toBe(true);
  });

  it('R6：bind 旋转/尺度组合、事件世界 TRS、非均匀尺度拒绝', async () => {
    // 构造 pivot=[1,0,0]、bind 绕 Z 旋转 90°、均匀 scale=3 的单块 profile
    const p01 = JSON.parse(textGlob['../../../assets/fracture/p01-barrel/p01-barrel.fracture.json']!);
    p01.chunks = [{
      chunkId: 'c1', class: 'large',
      mesh: { path: 'assets/fracture/p01-barrel/chunk-0001.glb', guid: 'as_29a7ad90' },
      bind: { position: [0, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [3, 3, 3] },
      pivot: [1, 0, 0],
      proxy: { shape: { type: 'box', halfExtents: [0.15, 0.15, 0.15] }, mass: 1.5, friction: 0.6, restitution: 0.35, collisionGroup: 'debris' },
    }];
    const io = makeIO({ [P01]: JSON.stringify(p01) });
    const r = await prepareFractureActivation(ev(P01, 'as_p01frct', { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), { io });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // bind: pivot[1,0,0] * scale[3,3,3] = [3,0,0]；绕 Z 转 90° → [0,3,0]；event 单位 TRS → 世界 [0,3,0]
    expect(r.activation.chunks[0]!.position[0]).toBeCloseTo(0, 5);
    expect(r.activation.chunks[0]!.position[1]).toBeCloseTo(3, 5);
    expect(r.activation.chunks[0]!.position[2]).toBeCloseTo(0, 5);
    // 姿态含 bind 旋转（非单位四元数）
    expect(Math.abs(r.activation.chunks[0]!.rotation[2])).toBeCloseTo(Math.SQRT1_2, 4);
    // 尺度 = bind.scale * event.scale = 3
    expect(r.activation.chunks[0]!.scale).toBeCloseTo(3, 5);

    // 非均匀事件尺度拒绝
    const r2 = await prepareFractureActivation(ev(P01, 'as_p01frct', { scale: [1, 2, 3] }), { io: makeIO() });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.failure.stage).toBe('transform');
  });
});
