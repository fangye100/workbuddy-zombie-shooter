/**
 * WU-04 生产准入与激活准备 owner 测试（R1）。
 * 用注入 IO 端口读取真实 .fracture.json / .meta.json（import.meta.glob，不用 node:fs），
 * 验证：正式 P-01/E-04 准入与分层、错误 GUID/kind、quarantined→accepted 恢复、
 * 打开后外改 sidecar、seed 确定性、不同来向差异、convex 端口契约。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createGlbConvexResolver, prepareFractureActivation, type FractureAssetIO } from '../src/fracture-activation';
import { parseGlb, VERTEX_FLOATS } from '@aether/scene';
import { ensureRapier, type RapierModule } from '../src/fracture-rapier';

let rapier: RapierModule;
import { frozenFractureEvent, type FractureEvent } from '../src/fracture';

// 仓库门禁规约：测试用 import.meta.glob 读正式资产（禁 node:fs）。
const textGlob = import.meta.glob('../../../assets/fracture/*/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
// 二进制通道：?raw 会把 GLB 按 UTF-8 解码（BIN chunk 被替换字符污染，实测 2480172 字节
// 只剩 2349234 码位），不能用来证明「真实 GLB 被解析」。?bytes 由 vitest.config.ts 的
// 加载器在配置层读原始字节，测试侧只拿到 Uint8Array（仍不 import node:fs）。
const binLoaders = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
// 额外加载源模型 sidecar（R1 引用核验需要）
const srcMetaGlob = import.meta.glob('../../../assets/environment/models/*/*/*.glb.meta.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
// NPC 源模型 sidecar（E-04 在 characters 目录）
const charMetaGlob = import.meta.glob('../../../assets/characters/models/*/*/*.glb.meta.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

beforeAll(async () => { rapier = await ensureRapier(); }, 30000);

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
  for (const [k, v] of Object.entries(srcMetaGlob)) {
    store.set(k.replace(/^.*?(?=assets\/)/, ''), v);
  }
  for (const [k, v] of Object.entries(charMetaGlob)) {
    store.set(k.replace(/^.*?(?=assets\/)/, ''), v);
  }
  for (const [k, v] of Object.entries(overrides)) store.set(k, v);
  const binStore = new Map<string, ArrayBuffer>();
  for (const [k, v] of Object.entries(binOverrides)) binStore.set(k, v);
  const binLoaderByPath = new Map<string, () => Promise<Uint8Array>>();
  for (const [k, loader] of Object.entries(binLoaders)) {
    binLoaderByPath.set(k.replace(/^.*?(?=assets\/)/, ''), loader);
  }
  return {
    async readText(path: string) {
      const v = store.get(path);
      if (v === undefined) throw new Error('未找到资产：' + path);
      return v;
    },
    async readBinary(path: string) {
      const over = binStore.get(path);
      if (over !== undefined) return over;
      const loader = binLoaderByPath.get(path);
      if (loader === undefined) throw new Error('未找到二进制资产：' + path);
      const bytes = await loader();
      // 复制到独立 ArrayBuffer，避免与模块缓存共享（与真实 IO 语义一致）
      return bytes.slice().buffer;
    },
    set(path: string, v: string) { store.set(path, v); },
    setBin(path: string, v: ArrayBuffer) { binStore.set(path, v); },
  };
}

/** 点集包围盒（仅位置分量）。 */
function bounds(pts: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pts[i + k]! < min[k]!) min[k] = pts[i + k]!;
      if (pts[i + k]! > max[k]!) max[k] = pts[i + k]!;
    }
  }
  return { min, max };
}

/** 手写合法 GLB：单 mesh 单 primitive，只有 POSITION（无 node 变换）。 */
function makePointCloudGlb(positions: Float32Array): ArrayBuffer {
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    buffers: [{ byteLength: positions.byteLength }],
  };
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonSize = Math.ceil(encoded.length / 4) * 4;
  const out = new Uint8Array(28 + jsonSize + positions.byteLength);
  const header = new DataView(out.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, out.length, true);
  header.setUint32(12, jsonSize, true);
  header.setUint32(16, 0x4e4f534a, true);
  out.fill(32, 20, 20 + jsonSize);
  out.set(encoded, 20);
  header.setUint32(20 + jsonSize, positions.byteLength, true);
  header.setUint32(24 + jsonSize, 0x004e4942, true);
  out.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), 28 + jsonSize);
  return out.buffer;
}

/** 与准入判定同口径的非退化检查：存在「离基面距离 > 1e-6」的第四点。 */
function hasNonCoplanar(pts: Float32Array): boolean {
  const n = pts.length / 3;
  let maxDist = 0, i0 = 0, i1 = 1;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const dx = pts[a*3]!-pts[b*3]!, dy = pts[a*3+1]!-pts[b*3+1]!, dz = pts[a*3+2]!-pts[b*3+2]!;
    const d = dx*dx + dy*dy + dz*dz;
    if (d > maxDist) { maxDist = d; i0 = a; i1 = b; }
  }
  const ax = pts[i0*3]!, ay = pts[i0*3+1]!, az = pts[i0*3+2]!;
  const abx = pts[i1*3]!-ax, aby = pts[i1*3+1]!-ay, abz = pts[i1*3+2]!-az;
  let maxArea = 0, i2 = -1;
  for (let a = 0; a < n; a++) {
    if (a === i0 || a === i1) continue;
    const acx = pts[a*3]!-ax, acy = pts[a*3+1]!-ay, acz = pts[a*3+2]!-az;
    const nx = aby*acz - abz*acy, ny = abz*acx - abx*acz, nz = abx*acy - aby*acx;
    const area = nx*nx + ny*ny + nz*nz;
    if (area > maxArea) { maxArea = area; i2 = a; }
  }
  if (maxArea < 1e-12 || i2 < 0) return false;
  const cx = pts[i2*3]!, cy = pts[i2*3+1]!, cz = pts[i2*3+2]!;
  const nx = aby*(cz-az) - abz*(cy-ay), ny = abz*(cx-ax) - abx*(cz-az), nz = abx*(cy-ay) - aby*(cx-ax);
  const nLen = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
  let maxVol = 0;
  for (let a = 0; a < n; a++) {
    if (a === i0 || a === i1 || a === i2) continue;
    const dx = pts[a*3]!-ax, dy = pts[a*3+1]!-ay, dz = pts[a*3+2]!-az;
    const v = Math.abs(nx*dx + ny*dy + nz*dz) / nLen;
    if (v > maxVol) maxVol = v;
  }
  return maxVol > 1e-6;
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
    // 源模型 sidecar 缺失（P-01 源模型在 environment 目录）
    const io1 = makeIO();
    io1.set('assets/environment/models/P-01/tex2/P-01_baked.glb.meta.json', undefined as unknown as string);
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

    // 端口契约：合法点集（此处是替身常量，仅证明端口被调用，不代表 GLB 解析；
    // 真实 GLB 正路径见下一条「R1：真实 chunk GLB 经生产 resolver」用例）。
    const r4 = await prepareFractureActivation(ev(P01, 'as_p01frct'), {
      io, resolveConvexPoints: () => new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,1]),
    });
    expect(r4.ok).toBe(true);

    // 零体积：四点完全重合
    const r5 = await prepareFractureActivation(ev(P01, 'as_p01frct'), {
      io, resolveConvexPoints: () => new Float32Array([0,0,0, 0,0,0, 0,0,0, 0,0,0]),
    });
    expect(r5.ok).toBe(false);
    if (!r5.ok) expect(r5.failure.stage).toBe('proxy-load');

    // 共线：三点共线
    const r6 = await prepareFractureActivation(ev(P01, 'as_p01frct'), {
      io, resolveConvexPoints: () => new Float32Array([0,0,0, 1,0,0, 2,0,0, 3,0,0]),
    });
    expect(r6.ok).toBe(false);
    if (!r6.ok) expect(r6.failure.stage).toBe('proxy-load');

    // 共面：四点在 XY 平面
    const r7 = await prepareFractureActivation(ev(P01, 'as_p01frct'), {
      io, resolveConvexPoints: () => new Float32Array([0,0,0, 1,0,0, 0,1,0, 1,1,0]),
    });
    expect(r7.ok).toBe(false);
    if (!r7.ok) expect(r7.failure.stage).toBe('proxy-load');
  });

  it('R1：真实 chunk GLB 经生产 resolver 解析出非退化凸点集并完成准入', async () => {
    // 这条用例证明的是「真实 GLB 二进制 → scene 的真解析器 → 合法凸点集 → 准入通过」，
    // 不是端口替身：resolver 用生产实现 createGlbConvexResolver()，输入是仓库里
    // 真正的 chunk-0001.glb 字节（?bytes 通道，文件头 glTF）。
    const vecGlob = import.meta.glob('../../../assets/fracture/*/*.glb', { query: '?bytes', import: 'default' }) as Record<string, () => Promise<Uint8Array>>;
    const key = Object.keys(vecGlob).find((k) => /chunk-0001\.glb$/.test(k))!;
    const bytes = await vecGlob[key]!();
    // 输入自证：GLB 魔数 + 版本 2 + 声明长度 == 实际字节数
    const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    expect(magic).toBe('glTF');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(bytes.byteLength);
    expect(bytes.byteLength).toBeGreaterThan(1_000_000);

    // 生产 resolver：同一份字节交给真解析器
    const resolver = createGlbConvexResolver();
    const pts = resolver(bytes.slice().buffer);
    expect(pts).toBeInstanceOf(Float32Array);
    expect(pts.length % 3).toBe(0);
    // 顶点缓冲是 15 浮点交错（pos3+normal3+smooth3+uv2+color4）：点数 = 顶点数，
    // 不是 15 倍。旧实现把整块当 XYZ，点数会膨胀 15 倍且 bounds 撑到 [-1,1]。
    const parsed = parseGlb(bytes.slice().buffer, null, 'auto').mesh;
    const vertexCount = parsed.vertices.length / VERTEX_FLOATS;
    expect(vertexCount).toBe(5286);
    expect(pts.length / 3).toBe(vertexCount);
    for (let i = 0; i < pts.length; i++) expect(Number.isFinite(pts[i]!)).toBe(true);
    // 坐标 = 解析后 position 分量（同一规整化空间，pivot 也在这个空间里）
    const b = bounds(pts);
    expect(b.min[0]).toBeCloseTo(-0.150041, 5);
    expect(b.max[0]).toBeCloseTo(0.150041, 5);
    expect(b.min[1]).toBeCloseTo(0, 5);
    expect(b.max[1]).toBeCloseTo(0.299990, 5);
    expect(b.min[2]).toBeCloseTo(-0.150002, 5);
    expect(b.max[2]).toBeCloseTo(0.150002, 5);
    // 旧缺陷的包围盒形状（被法线/UV/颜色撑到 ±1）必须排除
    expect(Math.max(b.max[0], b.max[2])).toBeLessThan(0.5);
    // 非退化：存在非共面四点（与准入判定同口径）
    expect(hasNonCoplanar(pts)).toBe(true);

    // 实际 Rapier 形状/接触：从上方竖直投射，命中真实碎块顶面（≈0.30m），
    // 而不是旧缺陷把碰撞体撑成 1m 高后的 ~1.0m。
    // RapierModule 只声明后端用到的窄面；测试这里补上射线查询所需的 API 视图。
    const R = rapier as unknown as {
      World: new (g: { x: number; y: number; z: number }) => {
        createRigidBody(d: unknown): unknown;
        createCollider(d: unknown, b: unknown): unknown;
        step(): void;
        castRay(ray: unknown, maxToi: number, solid: boolean): { timeOfImpact: number } | null;
        free(): void;
      };
      Ray: new (origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }) => unknown;
      RigidBodyDesc: { fixed(): unknown };
      ColliderDesc: { convexHull(p: Float32Array): unknown | null };
    };
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    const hull = R.ColliderDesc.convexHull(pts);
    expect(hull).not.toBeNull();
    world.createCollider(hull!, body);
    world.step(); // 建立查询管线（castRay 依赖其广相结构）
    // 质心必在凸包内部，保证竖线与凸多面体相交（碎块是弧形薄壁，正中心可能是空的）
    let cx = 0, cz = 0;
    for (let i = 0; i < pts.length; i += 3) { cx += pts[i]!; cz += pts[i + 2]!; }
    cx /= pts.length / 3; cz /= pts.length / 3;
    const hit = world.castRay(new R.Ray({ x: cx, y: 5, z: cz }, { x: 0, y: -1, z: 0 }), 10, true);
    expect(hit).not.toBeNull();
    const topY = 5 - hit!.timeOfImpact;
    expect(topY).toBeGreaterThan(0.1);
    expect(topY).toBeLessThan(0.45);
    world.free();

    // 走完整准入：profile 第一块改为 convex 代理，直接引用同一 chunk GLB
    const p01 = JSON.parse(textGlob['../../../assets/fracture/p01-barrel/p01-barrel.fracture.json']!);
    p01.chunks[0].proxy.shape = { type: 'convex', mesh: { path: 'assets/fracture/p01-barrel/chunk-0001.glb', guid: 'as_29a7ad90' } };
    const io = makeIO({ [P01]: JSON.stringify(p01) });
    const r = await prepareFractureActivation(ev(P01, 'as_p01frct'), { io, resolveConvexPoints: resolver });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sh = r.activation.chunks[0]!.shape;
    expect(sh.type).toBe('convex');
    if (sh.type === 'convex') expect(sh.points.length).toBe(pts.length);

    // 负例：同一 resolver 对损坏 GLB 必须抛错（证明它真的在解析，不是忽略输入）
    expect(() => resolver(new ArrayBuffer(12))).toThrow();
  });

  it('R1：带已知非零偏移的合法 GLB 按解析布局取 POSITION（独立参照）', () => {
    // 独立参照：手写一份合法 GLB，顶点在 x∈[10,14]、y∈[2,6]、z∈[20,24]。
    // parseGlb(buffer, null, 'auto') 的规整化合同 = node 变换烘焙 + 居中 XZ + 底面贴 0
    // （不缩放），因此期望坐标可闭式算出：x'∈[-2,2]、y'∈[0,4]、z'∈[-2,2]。
    // 若把交错缓冲当 XYZ，点数会是 5×15 且 bounds 会被法线撑到 ±1 附近。
    const positions = new Float32Array([
      10, 2, 20,
      14, 2, 20,
      10, 6, 24,
      10, 2, 24,
      14, 6, 24,
    ]);
    const glb = makePointCloudGlb(positions);
    const pts = createGlbConvexResolver()(glb);
    expect(pts.length / 3).toBe(5);
    const b = bounds(pts);
    expect(b.min[0]).toBeCloseTo(-2, 6);
    expect(b.max[0]).toBeCloseTo(2, 6);
    expect(b.min[1]).toBeCloseTo(0, 6);
    expect(b.max[1]).toBeCloseTo(4, 6);
    expect(b.min[2]).toBeCloseTo(-2, 6);
    expect(b.max[2]).toBeCloseTo(2, 6);
    // 逐点比对（不是只看包围盒，防居中/换轴写错后 bbox 偶然相同）
    const got = [...pts].map((v) => Math.round(v * 1e6) / 1e6);
    expect(got).toEqual([
      -2, 0, -2,
      2, 0, -2,
      -2, 4, 2,
      -2, 0, 2,
      2, 4, 2,
    ]);
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

    // P2：bindT ≠ 0 钉住变换链——bind 平移不随 bind 旋转/尺度改变（公式 T + R·S·pivot）。
    // 同 pivot/旋转/尺度，bindT 从 [0,0,0] 改为 [10,20,30]：世界位置应恰好平移 [10,20,30]。
    const p01b = JSON.parse(textGlob['../../../assets/fracture/p01-barrel/p01-barrel.fracture.json']!);
    p01b.chunks = [{
      chunkId: 'c1', class: 'large',
      mesh: { path: 'assets/fracture/p01-barrel/chunk-0001.glb', guid: 'as_29a7ad90' },
      bind: { position: [10, 20, 30], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [3, 3, 3] },
      pivot: [1, 0, 0],
      proxy: { shape: { type: 'box', halfExtents: [0.15, 0.15, 0.15] }, mass: 1.5, friction: 0.6, restitution: 0.35, collisionGroup: 'debris' },
    }];
    const io2 = makeIO({ [P01]: JSON.stringify(p01b) });
    const r3 = await prepareFractureActivation(ev(P01, 'as_p01frct', { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), { io: io2 });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    // bind 局部质心 = bindT + bindR·(bindS·pivot) = [10,20,30] + [0,3,0] = [10,23,30]
    expect(r3.activation.chunks[0]!.position[0]).toBeCloseTo(10, 5);
    expect(r3.activation.chunks[0]!.position[1]).toBeCloseTo(23, 5);
    expect(r3.activation.chunks[0]!.position[2]).toBeCloseTo(30, 5);
  });
});
