/**
 * 刷怪散布的 A/B 探针（WU-5）。
 *
 * ## 它解决什么
 *
 * docs/17 WU-5：「同种子重新运行，比较初始散布变化，其他未修改作者字段保持一致。
 * **保留 A/B 指标或关键帧，不能只展示修改后结果**。」
 *
 * 只展示"改完之后"的话，作者看到的是一堆位置变了，根本判断不出
 *   - 改动**真的生效**了，还是被某个触发条件吞了（房间还没进 → 一个都没刷）；
 *   - 改动是**局部**的，还是连带把别处也动了。
 *
 * 所以这里的做法是：**每次编辑前后各跑一次同种子装载**（不碰正在播放的世界），
 * 抓"初始散布指纹"，再逐刷怪点做差。改的那一处 mean/max 必须变，其余必须逐位不变。
 *
 * ## 为什么是"初始散布"而不是"跑 N 帧之后"
 *
 * 跑起来之后的位置由寻路、分离、障碍共同决定，同一份改动在 200 tick 后可能因为
 * 一只僵尸绕了另一侧掩体而产生全然不同的分布 —— 那是**下游噪声**，不是这次编辑的
 * 直接结果。tick 0 的散布才是"半径参数"这一个变量的干净函数：
 * `r = sqrt(u) * radius`（见 session.ts 的圆内均匀取点），mean 与 max 都随 radius 单调。
 *
 * ## 成本
 *
 * 一次指纹 = 装载 + 建一次 RuntimeSession（含流场烘焙），与点一次 Play 同量级。
 * 编辑是低频操作，这个代价换"改动确实生效"的证据是划算的；它**不影响**正在播放的会话。
 */

import { loadLevelRuntime } from './loader';
import { createSession } from './session';
import type { EntityView } from './session';
import type { SceneDocument } from '@aether/scene';
import type { NodeId } from '@aether/scene';

/** 单个刷怪点的初始散布指标 */
export interface SpawnScatter {
  nodeId: NodeId;
  characterId: string;
  /** 作者参数（改的就是它） */
  radius: number;
  count: number;
  /** 实际已生成的实体数。房间未进入时为 0 —— 这个数是"改动有没有被触发"的关键 */
  spawned: number;
  /** 到刷怪点中心的平均距离 */
  meanDist: number;
  maxDist: number;
  /** 最近的两两间距（重叠穿模的代理指标）。实体不足 2 个时为 -1 */
  minPairDist: number;
}

/** 一次"同种子从初始态装载"的指纹 */
export interface ScatterFingerprint {
  seed: number;
  tick: number;
  npcCount: number;
  spawns: SpawnScatter[];
  /** 装载失败时非空；此时 spawns 为空数组，调用方应显示原因而不是假装"没变化" */
  error: string | null;
}

export interface CaptureOptions {
  seed?: number;
  capacity?: number;
}

/**
 * 抓一次初始散布指纹。
 *
 * **不抛异常**：装载失败、场景缺少 NavZone、角色 id 未登记……全部收敛到 `error`。
 */
export function captureInitialScatter(doc: SceneDocument, opts: CaptureOptions = {}): ScatterFingerprint {
  const seed = opts.seed ?? 1;
  const empty = (error: string): ScatterFingerprint => ({
    seed,
    tick: 0,
    npcCount: 0,
    spawns: [],
    error,
  });

  const loaded = loadLevelRuntime(doc);
  const errs = loaded.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
  if (loaded.desc === null || errs.length > 0) {
    return empty(errs.length > 0 ? errs.join('；') : '场景装载失败');
  }

  let view: EntityView[];
  try {
    // tick 0：构造时玩家出生房间已触发，此时实体站的就是"初始散布"的位置
    const s = createSession(loaded.desc, { seed, ...(opts.capacity ? { capacity: opts.capacity } : {}) });
    view = s.view();
  } catch (e) {
    return empty(`建会话失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const bySource = new Map<NodeId, EntityView[]>();
  let npcCount = 0;
  for (const v of view) {
    if (v.kind !== 'npc') continue;
    npcCount++;
    if (v.sourceNodeId === null) continue;
    const arr = bySource.get(v.sourceNodeId);
    if (arr === undefined) bySource.set(v.sourceNodeId, [v]);
    else arr.push(v);
  }

  const spawns: SpawnScatter[] = loaded.desc.spawns.map((s) => {
    const list = bySource.get(s.nodeId) ?? [];
    let sum = 0;
    let max = 0;
    for (const e of list) {
      const d = Math.hypot(e.x - s.x, e.z - s.z);
      sum += d;
      if (d > max) max = d;
    }
    let minPair = -1;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.hypot(list[i]!.x - list[j]!.x, list[i]!.z - list[j]!.z);
        if (minPair < 0 || d < minPair) minPair = d;
      }
    }
    return {
      nodeId: s.nodeId,
      characterId: s.characterId,
      radius: s.radius,
      count: s.count,
      spawned: list.length,
      meanDist: list.length > 0 ? sum / list.length : 0,
      maxDist: max,
      minPairDist: minPair,
    };
  });

  return { seed, tick: 0, npcCount, spawns, error: null };
}

/** 单个刷怪点的 before → after */
export interface SpawnScatterDelta {
  nodeId: NodeId;
  characterId: string;
  radiusBefore: number;
  radiusAfter: number;
  countBefore: number;
  countAfter: number;
  spawnedBefore: number;
  spawnedAfter: number;
  meanBefore: number;
  meanAfter: number;
  maxBefore: number;
  maxAfter: number;
  minPairBefore: number;
  minPairAfter: number;
  /** 作者参数或散布指标任一不同即为 true */
  changed: boolean;
}

export interface ScatterComparison {
  sameSeed: boolean;
  deltas: SpawnScatterDelta[];
  /** 发生变化的刷怪点 */
  changedNodeIds: NodeId[];
  /** 作者字段与散布**都**没变的刷怪点 —— "改动是局部的"这条断言就靠它 */
  unchangedNodeIds: NodeId[];
  npcBefore: number;
  npcAfter: number;
  usable: boolean;
}

const EPS = 1e-6;

function same(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

/**
 * 比较两次指纹。
 *
 * 两侧 `error` 非空时 `usable = false`：宁可明说"比不了"，也不要拿一份空指纹
 * 去跟一份正常的比，得出"全都变了"或"全都没变"的假结论。
 */
export function compareScatter(a: ScatterFingerprint, b: ScatterFingerprint): ScatterComparison {
  const deltas: SpawnScatterDelta[] = [];
  const changedNodeIds: NodeId[] = [];
  const unchangedNodeIds: NodeId[] = [];

  if (a.error !== null || b.error !== null) {
    return {
      sameSeed: a.seed === b.seed,
      deltas: [],
      changedNodeIds: [],
      unchangedNodeIds: [],
      npcBefore: a.npcCount,
      npcAfter: b.npcCount,
      usable: false,
    };
  }

  const byId = new Map(b.spawns.map((s) => [s.nodeId, s]));
  for (const before of a.spawns) {
    const after = byId.get(before.nodeId);
    if (after === undefined) continue; // 刷怪点被删：不属于"局部编辑"范畴，忽略
    const changed =
      !same(before.radius, after.radius) ||
      !same(before.count, after.count) ||
      !same(before.meanDist, after.meanDist) ||
      !same(before.maxDist, after.maxDist) ||
      !same(before.minPairDist, after.minPairDist) ||
      before.spawned !== after.spawned;
    deltas.push({
      nodeId: before.nodeId,
      characterId: before.characterId,
      radiusBefore: before.radius,
      radiusAfter: after.radius,
      countBefore: before.count,
      countAfter: after.count,
      spawnedBefore: before.spawned,
      spawnedAfter: after.spawned,
      meanBefore: before.meanDist,
      meanAfter: after.meanDist,
      maxBefore: before.maxDist,
      maxAfter: after.maxDist,
      minPairBefore: before.minPairDist,
      minPairAfter: after.minPairDist,
      changed,
    });
    (changed ? changedNodeIds : unchangedNodeIds).push(before.nodeId);
  }

  return {
    sameSeed: a.seed === b.seed,
    deltas,
    changedNodeIds,
    unchangedNodeIds,
    npcBefore: a.npcCount,
    npcAfter: b.npcCount,
    usable: true,
  };
}

/** 面板上的一行摘要（放在这里是让它可测：UI 与 CLI 报告用词一致） */
export function describeDelta(d: SpawnScatterDelta): string {
  const tag = d.changed ? '已改' : '未变';
  const r =
    d.radiusBefore === d.radiusAfter
      ? `${d.radiusAfter.toFixed(2)}`
      : `${d.radiusBefore.toFixed(2)}→${d.radiusAfter.toFixed(2)}`;
  return (
    `${d.nodeId} ${d.characterId} [${tag}] 半径 ${r}m　` +
    `散布 均 ${d.meanBefore.toFixed(2)}→${d.meanAfter.toFixed(2)}　` +
    `最远 ${d.maxBefore.toFixed(2)}→${d.maxAfter.toFixed(2)}　` +
    `实体 ${d.spawnedBefore}→${d.spawnedAfter}`
  );
}
