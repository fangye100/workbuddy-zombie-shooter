import { describe, it, expect } from 'vitest';
import { RuntimeBridge, type ActorSource, clipIndexForBehavior, animPhase } from '../src/services/runtime-bridge';
import type { ActorMesh, ActorClipMeta } from '../src/services/runtime-actors';
import { DYNAMIC_INSTANCE_FLOATS, poseIndexAt, type BakedPalette } from '@aether/render';
import { lookupCharacterStats } from '@aether/content';
import { PlaySession } from '@aether/runtime';
import type { SceneDocument } from '@aether/scene';

/**
 * WU-3 的渲染桥接测试。
 *
 * WU-4 之后 Bridge 只做「世界 → 批次」的翻译，**不再拥有运行状态** ——
 * 播放/暂停/单步/停止归 `PlaySession`（见 play-session.test.ts）。
 * 所以这里的夹具是「跑一个 PlaySession 再把会话挂给 Bridge」。
 *
 * 门禁测试用 import.meta.glob 而非 node:fs —— 本仓库没装 @types/node，
 * 且 tsconfig 的 types 是白名单（改 scene-files 会连带污染整个类型环境）。
 */
// 从 apps/editor/test/ 回到仓库根要三级：editor/test → editor → apps → 根
const MODULES = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });
const GALLERY = import.meta.glob('../../../assets/scenes/sandbox/character-rig-validation.scene.json', { eager: true });

function floor1(): SceneDocument {
  const key = Object.keys(MODULES)[0]!;
  return JSON.parse(JSON.stringify((MODULES[key] as { default: unknown }).default)) as SceneDocument;
}

/** 跑一个 PlaySession 并把它的世界挂给 Bridge */
function started(doc: SceneDocument = floor1()): { bridge: RuntimeBridge; play: PlaySession } {
  const play = new PlaySession();
  const r = play.play(doc);
  if (!r.ok) throw new Error('夹具装载失败：' + r.errors.join('；'));
  const bridge = new RuntimeBridge();
  bridge.attach(play.runtime);
  return { bridge, play };
}

describe('RuntimeBridge —— 挂接与摘下', () => {
  it('挂上真实关卡 floor-1 的会话：玩家 + 第一间房的僵尸', () => {
    const { bridge } = started();
    expect(bridge.active).toBe(true);
    const v = bridge.entities;
    expect(v.filter((e) => e.kind === 'player')).toHaveLength(1);
    expect(v.filter((e) => e.kind === 'npc').length).toBeGreaterThan(0);
  });

  it('摘下（attach null）后不再产出批次 —— 渲染侧据此跳过整段 pass 1b', () => {
    const { bridge } = started();
    expect(bridge.batches()).not.toBeNull();
    bridge.attach(null);
    expect(bridge.active).toBe(false);
    expect(bridge.batches()).toBeNull();
    expect(bridge.entities).toEqual([]);
  });

  it('世界推进后 refresh 才更新实例位置（读批次不能有推进副作用）', () => {
    const { bridge, play } = started();
    const before = bridge.batches()!.flatMap((b) => [...b.instances.slice(0, DYNAMIC_INSTANCE_FLOATS)].slice(0, 3));
    play.setInput(1,0); // Observe an explicit move independently of randomized NPC wakeup.
    play.advance(1);
    // 没 refresh：位置还是旧的
    const stale = bridge.batches()!.flatMap((b) => [...b.instances.slice(0, DYNAMIC_INSTANCE_FLOATS)].slice(0, 3));
    expect(stale).toEqual(before);
    bridge.refresh();
    const after = bridge.batches()!.flatMap((b) => [...b.instances.slice(0, DYNAMIC_INSTANCE_FLOATS)].slice(0, 3));
    expect(after).not.toEqual(before);
  });
});

describe('RuntimeBridge —— 实例打包（与 shader 的 DInst 布局一一对应）', () => {
  it('批次实例数之和 = 存活实体数', () => {
    const { bridge: b } = started();
    const batches = b.batches()!;
    const total = batches.reduce((n, x) => n + x.count, 0);
    expect(total).toBe(b.entities.length);
  });

  it('每个实例：y = 身高一半（胶囊中心在原点），缩放恒为 1', () => {
    const { bridge: b } = started();
    const F = DYNAMIC_INSTANCE_FLOATS;
    for (const batch of b.batches()!) {
      const h = Number(batch.meshId.split(':h')[1]);
      for (let i = 0; i < batch.count; i++) {
        const o = i * F;
        expect(batch.instances[o + 1]).toBeCloseTo(h / 2, 3);
        expect(batch.instances[o + 4]).toBe(1);
        expect(batch.instances[o + 5]).toBe(1);
        expect(batch.instances[o + 6]).toBe(1);
        // 颜色恒在合法区间（选中会 ×1.9，故上界放宽到 2）
        expect(batch.instances[o + 8]).toBeGreaterThan(0);
        expect(batch.instances[o + 8]).toBeLessThanOrEqual(2);
      }
    }
  });

  it('批次按 characterId 分槽：同一角色的多只僵尸不会被拆成两批', () => {
    const { bridge: b } = started();
    const batches = b.batches()!;
    // 每个 characterId 恰好一个批次，且各批实例数 = 该角色在视图里的实体数
    //（旧断言是"meshId 互不相同"——那严于实现的不变量：批次按 characterId 分槽、
    //  meshId 由胶囊尺寸派生，两个角色尺寸相同时本就该共用同一份网格。当前 9 个角色
    //  尺寸互异纯属数据巧合，美术改档把两人调成同尺寸就会让旧断言假红。
    //  复审 P3：断言必须钉住实现真的保证的性质，否则红灯只会教人改测试。）
    const byCharacter = new Map<string, number>();
    for (const e of b.entities) {
      byCharacter.set(e.characterId, (byCharacter.get(e.characterId) ?? 0) + 1);
    }
    expect(byCharacter.size).toBeGreaterThan(1);
    expect(batches).toHaveLength(byCharacter.size);
    const sorted = (xs: number[]) => xs.slice().sort((a, c) => a - c);
    expect(sorted(batches.map((x) => x.count))).toEqual(sorted([...byCharacter.values()]));
    for (const batch of batches) expect(batch.meshId).toMatch(/^capsule:r[\d.]+:h[\d.]+$/);
  });

  it('实例数组长度足够，不会读到未初始化的尾区', () => {
    const { bridge: b } = started();
    for (const batch of b.batches()!) {
      expect(batch.instances.length).toBeGreaterThanOrEqual(batch.count * DYNAMIC_INSTANCE_FLOATS);
    }
  });

  /**
   * docs/17 §8 第 8 条：动态实体**没有消耗静态场景槽位**。
   *
   * 证据形态：120 个实体只产出「种类数」个网格（每个 meshId 一份顶点/索引），
   * 每帧变的只有实例数组。如果是静态物件路径，120 个物件就要 120 份几何 +
   * 120 个 transformBuf 槽位，而 transformBuf 只有 64 槽 —— 直接越界。
   * 此项只验证渲染分离，不等于 500 僵尸的性能验收。
   */
  it('超过静态上限(64)时：只上传「种类数」份网格，其余全是实例行', () => {
    const doc = floor1();
    for (const n of doc.nodes) {
      for (const c of n.components) {
        if (c.kind === 'SpawnPoint') (c as { count: number }).count = 40;
      }
    }
    const { bridge: b } = started(doc);

    const batches = b.batches()!;
    const total = batches.reduce((n, x) => n + x.count, 0);
    expect(total).toBeGreaterThan(64);
    // 🔴 网格份数必须等于**体型种类数**，不能只写"小于 total/10" ——
    // 那种近似断言在「每 10 个实体退化成一份网格」时照样通过，等于放行退化。
    const kinds = new Set<string>();
    for (const e of b.entities) {
      const s = lookupCharacterStats(e.characterId);
      kinds.add(`${(s?.capsuleRadius ?? 0.35).toFixed(3)}:${(s?.capsuleHeight ?? 1.8).toFixed(3)}`);
    }
    expect(batches.length).toBe(kinds.size);
    expect(batches.length).toBeLessThan(total / 10);
    for (const batch of batches) {
      expect(batch.vertices.length).toBeGreaterThan(0);
      expect(batch.indices.length).toBeGreaterThan(0);
      expect(batch.count).toBeGreaterThan(0);
    }
  });
});

describe('RuntimeBridge —— 选中与射线拾取（最小选择入口）', () => {
  it('从实体正上方往下打能命中它自己', () => {
    const { bridge: b } = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    const hit = b.pickRay([e.x, 30, e.z], [0, -1, 0]);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(e.id);
  });

  it('从实体头顶之上继续往上打不命中（射线起点在实体内部则必中，不能那样测）', () => {
    const { bridge: b } = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    expect(b.pickRay([e.x, 30, e.z], [0, 1, 0])).toBeNull();
  });

  it('选中后 selectedEntity 能取到；generation 对不上时拒绝选中', () => {
    const { bridge: b } = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    expect(b.select(e.id, e.generation, e.runId)).toBe(true);
    expect(b.selectedEntity?.id).toBe(e.id);
    expect(b.select(e.id, e.generation + 7, e.runId)).toBe(false);
    b.clearSelection();
    expect(b.selectedEntity).toBeNull();
  });

  /**
   * 复审 #6：`id + generation` 是**逻辑身份**（跨会话会重复，用于确定性比较），
   * 不能当**操作引用**用。旧会话/旧 reset 的引用必须三代同检后明确失效，
   * 不能被新世界里同槽位的实体冒名顶替。
   */
  it('跨会话实体身份：旧 runId 的引用被拒绝（复审 #6）', () => {
    const { bridge: b } = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    // 伪造一个"上一代会话"的引用（runId 对不上）
    expect(b.select(e.id, e.generation, e.runId + 1)).toBe(false);
    expect(b.selectedEntity).toBeNull();
  });

  it('reset 换运行代次：旧引用明确失效，即使槽位与 generation 相同', () => {
    const { bridge: b, play } = started();
    const e = b.entities.find((x) => x.kind === 'npc')!;
    expect(b.select(e.id, e.generation, e.runId)).toBe(true);
    expect(b.selectedEntity?.id).toBe(e.id);

    play.reset();
    b.refresh();
    // reset 后新世界里有同槽位同 generation 的实体（同种子重放）——
    // 但这条引用属于上一代，selectedEntity 必须失效
    expect(b.selectedEntity).toBeNull();
    // 同 id+generation 但旧 runId 的 select 也必须被拒
    expect(b.select(e.id, e.generation, e.runId)).toBe(false);
  });
});
describe('RuntimeBridge —— 换世界', () => {
  it('reset 后挂同一个会话：batch 数量不变、实例数不变（Reset 是整表重建）', () => {
    const { bridge: b, play } = started();
    const before = b.batches()!.reduce((n, x) => n + x.count, 0);
    play.reset();
    b.refresh();
    expect(b.currentTick).toBe(0);
    expect(b.batches()!.reduce((n, x) => n + x.count, 0)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 真模型批次（docs/20 M2）：装配了 ActorMesh 的角色走 GPU 蒙皮路径
// （meshId actor:*、skin 顶点数据、实例 flags bit0=1、paletteBase / restPose
// 打包进 [7]/[11]），未装配的仍走胶囊。floor-1 第一间房有 E-01 + E-02，
// 桩只给 E-01 发真模型 —— 同一帧覆盖两条路径。
// ---------------------------------------------------------------------------

/** 手搓真模型（不依赖 GLB / fetch；字段语义见 ActorMesh） */
function stubActorMesh(characterId: string): ActorMesh {
  return {
    characterId,
    meshId: `actor:${characterId}`,
    vertices: new Float32Array(new ArrayBuffer(15 * 4 * 3)), // 3 个顶点占位
    indices: new Uint32Array(new ArrayBuffer(3 * 4)),
    joints: new Uint16Array(12),
    weights: new Float32Array(12),
    paletteBase: 7,
    restPose: 42,
    feetOffset: 0.031,
    // 无片段元数据：M3 的「选不到片 → 回 bind pose」路径（inst[11] = restPose）
    palette: STUB_PALETTE,
    clips: [],
  };
}

/** 桩调色板：M2 静止路径不查表（poseIndexAt 不会被调到），形状合法即可 */
const STUB_PALETTE: BakedPalette = {
  jointCount: 3,
  clips: [],
  data: new Float32Array(new ArrayBuffer(3 * 16 * 4)),
  clipBasePose: [],
};

function actorBridge(): RuntimeBridge {
  const e01 = stubActorMesh('E-01');
  const source: ActorSource = { get: (id) => (id === 'E-01' ? e01 : null) };
  const play = new PlaySession();
  const r = play.play(floor1());
  if (!r.ok) throw new Error('夹具装载失败：' + r.errors.join('；'));
  const bridge = new RuntimeBridge(source);
  bridge.attach(play.runtime);
  return bridge;
}

describe('RuntimeBridge —— 真模型批次（docs/20 M2，flags bit0 双路径）', () => {
  it('夹具前提：floor-1 第一间房同时有 E-01（装配）与 E-02（未装配）', () => {
    const { bridge: b } = started();
    const ids = new Set(b.entities.filter((e) => e.kind === 'npc').map((e) => e.characterId));
    expect(ids.has('E-01')).toBe(true);
    expect(ids.has('E-02')).toBe(true);
  });

  it('装配角色：meshId actor:*、skin 非空、flags=1、paletteBase/restPose 进实例 [7]/[11]', () => {
    const b = actorBridge();
    const batch = b.batches()!.find((x) => x.meshId === 'actor:E-01');
    expect(batch).toBeDefined();
    const F = DYNAMIC_INSTANCE_FLOATS;
    for (let i = 0; i < batch!.count; i++) {
      const o = i * F;
      expect(batch!.instances[o + 7]).toBe(7); // paletteBase
      expect(batch!.instances[o + 11]).toBe(42); // restPose（相对 paletteBase）
      expect(batch!.instances[o + 14]).toBe(1); // flags bit0 = 蒙皮
      expect(batch!.instances[o + 1]).toBeCloseTo(0.031, 5); // y = feetOffset（贴脚底）
    }
    expect(batch!.skin).not.toBeNull();
    expect(batch!.skin!.joints.length).toBeGreaterThan(0);
    expect(batch!.skin!.weights.length).toBeGreaterThan(0);
  });

  it('未装配角色（同帧）：仍走胶囊 —— meshId capsule:*、skin=null、flags=0', () => {
    const b = actorBridge();
    const batch = b.batches()!.find((x) => x.meshId.startsWith('capsule:'));
    expect(batch).toBeDefined();
    const F = DYNAMIC_INSTANCE_FLOATS;
    for (let i = 0; i < batch!.count; i++) {
      const o = i * F;
      expect(batch!.instances[o + 14]).toBe(0); // flags bit0 = 0 → shader 跳过蒙皮
      expect(batch!.instances[o + 7]).toBe(0);
      expect(batch!.instances[o + 11]).toBe(0);
    }
    expect(batch!.skin).toBeNull();
  });

  it('notifyActorsChanged：胶囊原地换真模型（Play 期异步加载完成的切换路径）', () => {
    // 先以「没有装配」启动 → E-01 画胶囊；然后模拟装配完成 → 通知 → 变 actor 批次
    let actor: ActorMesh | null = null;
    const source: ActorSource = { get: (id) => (id === 'E-01' ? actor : null) };
    const play = new PlaySession();
    const r = play.play(floor1());
    if (!r.ok) throw new Error('夹具装载失败：' + r.errors.join('；'));
    const bridge = new RuntimeBridge(source);
    bridge.attach(play.runtime);
    expect(bridge.batches()!.some((x) => x.meshId === 'actor:E-01')).toBe(false);

    actor = stubActorMesh('E-01');
    bridge.notifyActorsChanged();
    const after = bridge.batches()!;
    expect(after.some((x) => x.meshId === 'actor:E-01')).toBe(true);
    // E-02 的胶囊批不受牵连
    expect(after.some((x) => x.meshId.startsWith('capsule:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 动画相位（docs/20 M3）：tick → phase → poseIndexAt，确定性红线。
// 夹具 = 手搓片段元数据（idle 1s/10 帧、walk 2s/20 帧），poseIndexAt 本体
// 在 packages/render 已有独立测试 —— 这里只钉 Bridge 的打包契约。
// ---------------------------------------------------------------------------

/** 带片段元数据的 actor：idle(1s,10帧) + walk(2s,20帧)，与真实 GLB 的命名一致 */
function animatedActorMesh(paletteBase: number): ActorMesh {
  const palette: BakedPalette = {
    jointCount: 3,
    clips: [
      { name: 'idle', frameCount: 10, durationSec: 1 },
      { name: 'walk', frameCount: 20, durationSec: 2 },
    ],
    // poseIndexAt 只做下标算术不读矩阵值，数据全零即可；31 pose = 10+20+bind
    data: new Float32Array(new ArrayBuffer(31 * 3 * 16 * 4)),
    clipBasePose: [0, 10],
  };
  const m = stubActorMesh('E-01');
  m.palette = palette;
  m.clips = palette.clips.map(
    (c, i): ActorClipMeta => ({
      name: c.name,
      basePose: palette.clipBasePose[i]!,
      frameCount: c.frameCount,
      durationSec: c.durationSec,
    }),
  );
  m.restPose = 30; // 局部 bind = 10+20
  m.paletteBase = paletteBase;
  return m;
}

/** 装配了动画 actor 的会话桥（E-01 真模型，其余胶囊） */
function animatedBridge(): { bridge: RuntimeBridge; play: PlaySession; actor: ActorMesh } {
  const actor = animatedActorMesh(0);
  const source: ActorSource = { get: (id) => (id === 'E-01' ? actor : null) };
  const play = new PlaySession();
  const r = play.play(floor1());
  if (!r.ok) throw new Error('夹具装载失败：' + r.errors.join('；'));
  const bridge = new RuntimeBridge(source);
  bridge.attach(play.runtime);
  return { bridge, play, actor };
}

describe('clipIndexForBehavior · 行为选片（M3）', () => {
  const clips = [
    { name: 'idle', basePose: 0, frameCount: 10, durationSec: 1 },
    { name: 'walk', basePose: 10, frameCount: 20, durationSec: 2 },
    { name: 'attack', basePose: 30, frameCount: 24, durationSec: 1 },
  ] as ActorClipMeta[];

  it('idle(0) → idle 片；chase(1) → walk 片', () => {
    expect(clipIndexForBehavior(clips, 0)).toBe(0);
    expect(clipIndexForBehavior(clips, 1)).toBe(1);
    expect(clipIndexForBehavior(clips, 2)).toBe(2);
    expect(clipIndexForBehavior(clips, 4)).toBe(0);
  });
  it('未知行为值回 idle；名字缺失回 clip 0；空片段表回 -1（→ bind）', () => {
    expect(clipIndexForBehavior(clips, 7)).toBe(0);
    expect(clipIndexForBehavior([{ name: 'run', basePose: 0, frameCount: 5, durationSec: 1 }] as ActorClipMeta[], 1)).toBe(0);
    expect(clipIndexForBehavior([], 1)).toBe(-1);
  });
});

describe('animPhase · 相位纯函数（确定性红线）', () => {
  it('同输入同值；世界时间 = tick × 固定步长，与渲染帧率无关', () => {
    expect(animPhase(15, 1 / 30, 0, 1)).toBeCloseTo(0.5, 12);
    expect(animPhase(15, 1 / 30, 0, 1)).toBe(animPhase(15, 1 / 30, 0, 1));
  });
  it('整周期回绕到 0（相位始终在 [0,1)）', () => {
    expect(animPhase(30, 1 / 30, 0, 1)).toBeCloseTo(0, 12);
    expect(animPhase(90, 1 / 30, 0, 1)).toBeCloseTo(0, 12);
    for (let tick = 0; tick < 100; tick++) {
      const p = animPhase(tick, 1 / 30, 5, 2);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
  it('实体相位偏移 = id × φ⁻¹ mod 1（不同实体错开，避免机械同步）', () => {
    expect(animPhase(0, 1 / 30, 1, 1)).toBeCloseTo(0.6180339887498949, 12);
    expect(animPhase(0, 1 / 30, 2, 1)).toBeCloseTo(0.2360679774997897, 12);
    expect(animPhase(0, 1 / 30, 1, 1)).not.toBeCloseTo(animPhase(0, 1 / 30, 2, 1), 3);
  });
  it('时长 0 的退化片：相位恒 0（不除零、不 NaN）', () => {
    expect(animPhase(5, 1 / 30, 3, 0)).toBe(0);
  });
});

describe('RuntimeBridge —— 动画相位打包（docs/20 M3，inst[11]/[12]/[13]）', () => {
  it('anchored Broodmother in chase advances idle animation while its position stays fixed', () => {
    const doc = structuredClone((Object.values(GALLERY)[0] as { default: SceneDocument }).default);
    const actor = animatedActorMesh(0); actor.characterId = 'B-02'; actor.meshId = 'actor:B-02';
    actor.motion = { key: 'broodmother', clips: [], states: { walk: { loop: true, nominalSpeedMps: .4 } }, reports: [] };
    const play = new PlaySession(); expect(play.play(doc).ok).toBe(true);
    const bridge = new RuntimeBridge({ get: id => id === 'B-02' ? actor : null }); bridge.attach(play.runtime);
    const before = { ...bridge.entities.find(e => e.characterId === 'B-02')! };
    const batchBefore = bridge.batches()!.find(b => b.meshId === actor.meshId)!.instances.slice();
    for (let tick = 0; tick < 5; tick++) play.advance(1 / 30);
    bridge.refresh();
    const after = bridge.entities.find(e => e.characterId === 'B-02')!;
    const inst = bridge.batches()!.find(b => b.meshId === actor.meshId)!.instances;
    expect(after.behavior).toBe(1); expect(after.x).toBe(before.x); expect(after.z).toBe(before.z);
    expect(inst[12]).toBe(10); // idle rather than displacement-driven walk
    expect(inst[11]).not.toBe(batchBefore[11]); expect(inst[13]).not.toBe(batchBefore[13]);
    bridge.refresh(); expect(bridge.batches()!.find(b => b.meshId === actor.meshId)!.instances).toEqual(inst);
  });
  it('moving NPC +Z fronts align with actual velocity headings through the shader Y rotation', () => {
    const { bridge, play } = animatedBridge();
    const before = new Map(bridge.entities.map(e => [e.id, { x: e.x, z: e.z }]));
    play.advance(1 / 30); bridge.refresh();
    for (const batch of bridge.batches()!) for (let i = 0; i < batch.count; i++) {
      const o = i * DYNAMIC_INSTANCE_FLOATS;
      const e = bridge.entities.find(e => Math.abs(e.x - batch.instances[o]!) < 1e-4 && Math.abs(e.z - batch.instances[o + 2]!) < 1e-4)!;
      const old = before.get(e.id)!; const dx = e.x - old.x, dz = e.z - old.z, len = Math.hypot(dx, dz);
      if (len < 1e-5) continue;
      expect(Math.sin(batch.instances[o + 3]!)).toBeCloseTo(dx / len, 4);
      expect(Math.cos(batch.instances[o + 3]!)).toBeCloseTo(dz / len, 4);
    }
  });
  it('advances shared gait by actual displacement and packs the actor joint stride', () => {
    const { bridge, play, actor } = animatedBridge();
    actor.motion = { key: 'shared', clips: [], states: { walk: { loop: true, nominalSpeedMps: .8 } }, reports: [] };
    bridge.refresh();
    const beforeEntities = bridge.entities.filter(e => e.characterId === 'E-01').map(e => ({ ...e }));
    const before = bridge.batches()!.find(b => b.meshId === 'actor:E-01')!.instances.slice();
    play.advance(.1); bridge.refresh();
    const after = bridge.batches()!.find(b => b.meshId === 'actor:E-01')!.instances.slice();
    const entities = bridge.entities.filter(e => e.characterId === 'E-01');
    for (let i = 0; i < entities.length; i++) {
      const a = beforeEntities[i]!, b = entities[i]!;
      if (a.behavior !== 1 || b.behavior !== 1) continue;
      const expected = (before[i * DYNAMIC_INSTANCE_FLOATS + 13]! + Math.hypot(b.x - a.x, b.z - a.z) / (.8 * 2)) % 1;
      expect(after[i * DYNAMIC_INSTANCE_FLOATS + 13]).toBeCloseTo(expected, 6);
      expect(after[i * DYNAMIC_INSTANCE_FLOATS + 15]).toBe(3);
    }
    bridge.refresh(); expect(bridge.batches()!.find(b => b.meshId === 'actor:E-01')!.instances).toEqual(after);
  });
  it('inst[12] 与实体 behavior 一致：chase → walk 帧数、idle → idle 帧数', () => {
    const { bridge } = animatedBridge();
    const F = DYNAMIC_INSTANCE_FLOATS;
    const batch = bridge.batches()!.find((x) => x.meshId === 'actor:E-01')!;
    const e01 = bridge.entities.filter((e) => e.characterId === 'E-01');
    expect(batch.count).toBe(e01.length);
    expect(batch.count).toBeGreaterThan(0);
    for (let i = 0; i < e01.length; i++) {
      const want = e01[i]!.behavior === 1 ? 20 : 10;
      expect(batch.instances[i * F + 12]).toBe(want);
    }
  });

  it('inst[13] = 闭式相位、inst[11] = poseIndexAt(palette, clipIdx, phase)（局部下标）', () => {
    const { bridge, actor } = animatedBridge();
    const F = DYNAMIC_INSTANCE_FLOATS;
    const batch = bridge.batches()!.find((x) => x.meshId === 'actor:E-01')!;
    const e01 = bridge.entities.filter((e) => e.characterId === 'E-01');
    const tick = bridge.currentTick;
    expect(tick).toBe(0);
    for (let i = 0; i < e01.length; i++) {
      const e = e01[i]!;
      const clipIdx = e.behavior === 1 ? 1 : 0;
      const dur = clipIdx === 1 ? 2 : 1;
      // 闭式公式写死在测试里（不复用实现函数，防自证）：
      // phase = (tick × 1/30 / dur + id × φ⁻¹ mod 1) mod 1。
      // inst[13] 是 float32（精度 ~1e-7），比对精度放宽到 6 位十进制
      const phase = (((tick / 30) / dur) + (e.id * 0.6180339887498949) % 1) % 1;
      expect(batch.instances[i * F + 13]).toBeCloseTo(phase, 6);
      expect(batch.instances[i * F + 11]).toBe(poseIndexAt(actor.palette, clipIdx, phase));
    }
  });

  it('世界推进后同实体的 poseIndex 改变（动画在走，不依赖重挂会话）', () => {
    const { bridge, play } = animatedBridge();
    const F = DYNAMIC_INSTANCE_FLOATS;
    const e01 = bridge.entities.filter((e) => e.characterId === 'E-01');
    // 🔴 实例数组是槽位内的活缓冲（rebuild 原地重写）——必须拷贝快照再比
    const before = bridge.batches()!.find((x) => x.meshId === 'actor:E-01')!
      .instances.slice() as Float32Array;
    // advance(0.5) 受 maxCatchUpSteps=5 封顶实际走 5 tick：walk 片相位 +1/12
    // 周期 → 帧号 +1~2（mod 20），所有实体的 poseIndex 必然改变
    play.advance(0.5);
    bridge.refresh();
    const after = bridge.batches()!.find((x) => x.meshId === 'actor:E-01')!;
    expect(after.count).toBe(e01.length);
    for (let i = 0; i < e01.length; i++) {
      expect(after.instances[i * F + 11]).not.toBe(before[i * F + 11]);
    }
  });

  it('同种子两个会话推到同一 tick：[11]/[13] 逐位一致（Node 侧确定性证据）', () => {
    const mk = () => {
      const s = animatedBridge();
      s.play.advance(0.5);
      s.bridge.refresh();
      return s;
    };
    const a = mk();
    const b = mk();
    expect(a.bridge.currentTick).toBe(b.bridge.currentTick);
    const F = DYNAMIC_INSTANCE_FLOATS;
    const ba = a.bridge.batches()!.find((x) => x.meshId === 'actor:E-01')!;
    const bb = b.bridge.batches()!.find((x) => x.meshId === 'actor:E-01')!;
    expect(ba.count).toBe(bb.count);
    for (let i = 0; i < ba.count; i++) {
      expect(ba.instances[i * F + 11]).toBe(bb.instances[i * F + 11]);
      expect(ba.instances[i * F + 13]).toBe(bb.instances[i * F + 13]);
    }
  });

  it('无片段元数据的 actor：回 bind pose（restPose 局部下标进 [11]）', () => {
    // stubActorMesh 的 clips 为空 → 选片 -1 → inst[11] = restPose（M2 路径保持）
    const b = actorBridge();
    const F = DYNAMIC_INSTANCE_FLOATS;
    const batch = b.batches()!.find((x) => x.meshId === 'actor:E-01')!;
    for (let i = 0; i < batch.count; i++) {
      expect(batch.instances[i * F + 11]).toBe(42);
      expect(batch.instances[i * F + 12]).toBe(0);
      expect(batch.instances[i * F + 13]).toBe(0);
    }
  });
});
