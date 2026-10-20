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

const P01 = 'assets/fracture/p01-barrel/p01-barrel.fracture.json';
const E04 = 'assets/fracture/e04-bulwark/e04-bulwark.fracture.json';

/** 内存 IO 端口：从 glob 取文本；可被测试外改以模拟 sidecar 状态变化。 */
function makeIO(overrides: Record<string, string> = {}): FractureAssetIO & { set(path: string, v: string): void } {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(textGlob)) {
    // k 形如 ../../../assets/fracture/...；规范化为 assets/ 前缀
    store.set(k.replace(/^.*?(?=assets\/)/, ''), v);
  }
  for (const [k, v] of Object.entries(overrides)) store.set(k, v);
  return {
    async readText(path: string) {
      const v = store.get(path);
      if (v === undefined) throw new Error('未找到资产：' + path);
      return v;
    },
    async readBinary() { throw new Error('本测试无二进制资产'); },
    set(path: string, v: string) { store.set(path, v); },
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
});
