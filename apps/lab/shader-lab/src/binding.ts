import type { MaterialState } from './params';

/**
 * 换模型时的材质绑定继承（纯逻辑，不碰 GPU / DOM，可单独测试）。
 *
 * 问题：GLB 替换后，原来挂在新网格上的材质槽绑定（materialId / override / 显隐）
 * 会全部丢失。本模块按两层防护把旧绑定继承到新节点上：
 *
 *   第一层 nodeId 精确匹配 —— 导入时读 node.extras 的稳定 ID（缺省 auto-<index>，
 *   同一文件重导恒定）。artist 重命名节点不影响它。
 *
 *   第二层 反向路径匹配 —— ID 丢了（mesh 被删掉重建、extras 被抹）时，
 *   从 leaf 向 root 逐段比较节点名链，连续匹配段数 = 可信度。
 *   这正是消歧的关键：两个不同父节点下同名的「Mesh_1」，
 *   谁的父链匹配得越长越完整，绑定就归谁。平局 = 不可信，拒绝继承。
 *
 *   节点内部再到 primitive 粒度：先按 primitiveKey（材质名）配，
 *   再按 primitiveIndex（glTF 序号）兜底，最后按剩余顺序对齐 ——
 *   保证「材质 → 实例 → override → primitive」这条链尽量逐粒对上。
 *
 * 孤儿绑定：上次匹配没人认领的旧绑定会留在记忆里，参与后续替换的匹配
 * （artist 删掉又补回的 mesh 仍有机会接回原来的材质）。孤儿只走
 * nodeId / 全路径精确两级，防止跨模型误接。
 */

/** 一条 primitive（材质槽粒度）的绑定 */
export interface PrimitiveBinding {
  primitiveKey: string;
  primitiveIndex: number;
  materialId: string;
  override: MaterialState | null;
  visible: boolean;
}

/** 一个 mesh 节点的绑定快照（换模型前从旧场景抓下来 / 换模型后回填） */
export interface MeshNodeBinding {
  nodeId: string;
  /** 场景根 → 该节点的名字链，leaf 在最后 */
  nodePath: string[];
  prims: PrimitiveBinding[];
}

/** 新模型里待继承的一个 mesh 节点 */
export interface MeshNodeStub {
  nodeId: string;
  nodePath: string[];
  prims: { primitiveKey: string; primitiveIndex: number }[];
}

export type MatchHow = 'id' | 'path' | 'none';

export interface MatchReportEntry {
  /** 新节点显示名（leaf 名） */
  nodeName: string;
  how: MatchHow;
  /** path 模式下连续匹配段数（id 模式为节点路径全长，none 为 0） */
  score: number;
  /** 继承到旧绑定的 primitive 条数 / 该节点 primitive 总数 */
  inheritedPrims: number;
  totalPrims: number;
  /** 拒绝继承的原因（平局歧义等） */
  note?: string;
}

export interface MatchResult {
  /** 与新 stubs 同序：每个节点继承到的 primitive 绑定（条目 null = 没继承到，调用方给默认）；null = 节点没匹配上 */
  inherited: ((PrimitiveBinding | null)[] | null)[];
  report: MatchReportEntry[];
  /** 没被任何新节点认领的旧绑定（作为孤儿留给下一次替换） */
  orphans: MeshNodeBinding[];
}

/** 反向路径得分：从 leaf 往 root 连续相同的段数。leaf 都不同 = 0 */
export function reversePathScore(a: string[], b: string[]): number {
  let s = 0;
  while (s < a.length && s < b.length && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return s;
}

/** 全路径完全一致（含长度） */
function fullPathEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && reversePathScore(a, b) === a.length;
}

function cloneOverride(o: MaterialState | null): MaterialState | null {
  return o === null ? null : { ...o };
}

/**
 * 节点内的 primitive 级继承：key 精确 → 序号兜底 → 剩余顺序对齐。
 * 返回与新 prims 同序的绑定数组（null = 旧绑定不够用，调用方给默认值），
 * 并统计真正接到旧绑定的条数。
 */
export function inheritPrimitives(
  oldPrims: PrimitiveBinding[],
  newPrims: { primitiveKey: string; primitiveIndex: number }[],
): { prims: (PrimitiveBinding | null)[]; inheritedCount: number } {
  const used = new Set<number>();
  let inheritedCount = 0;
  const prims = newPrims.map((np): PrimitiveBinding | null => {
    // 1. primitiveKey 精确（同名材质可能多条，先到先得、不重复认领）
    let j = oldPrims.findIndex((p, k) => !used.has(k) && p.primitiveKey === np.primitiveKey);
    // 2. glTF 序号兜底（材质名被改/被删时，顺序通常还稳定）
    if (j < 0) j = oldPrims.findIndex((p, k) => !used.has(k) && p.primitiveIndex === np.primitiveIndex);
    // 3. 顺序对齐：两种身份都丢了，按剩余未认领的第一条对齐
    if (j < 0) j = oldPrims.findIndex((_, k) => !used.has(k));
    if (j < 0) return null;
    used.add(j);
    inheritedCount++;
    const old = oldPrims[j]!;
    return {
      primitiveKey: np.primitiveKey,
      primitiveIndex: np.primitiveIndex,
      materialId: old.materialId,
      override: cloneOverride(old.override),
      visible: old.visible,
    };
  });
  return { prims, inheritedCount };
}

interface Candidate {
  binding: MeshNodeBinding;
  orphan: boolean;
}

/**
 * 两层匹配主流程。oldBindings = 当前场景快照 + 历史孤儿（orphan 标记区分）。
 * 快照优先级高于孤儿：同分时永远先消费快照。
 */
export function matchBindings(
  snapshot: MeshNodeBinding[],
  orphans: MeshNodeBinding[],
  stubs: MeshNodeStub[],
): MatchResult {
  const candidates: Candidate[] = [
    ...snapshot.map((binding) => ({ binding, orphan: false })),
    ...orphans.map((binding) => ({ binding, orphan: true })),
  ];
  const used = new Set<number>();
  const inherited: ((PrimitiveBinding | null)[] | null)[] = stubs.map(() => null);
  const report: MatchReportEntry[] = stubs.map((st) => ({
    nodeName: st.nodePath[st.nodePath.length - 1] ?? st.nodeId,
    how: 'none',
    score: 0,
    inheritedPrims: 0,
    totalPrims: st.prims.length,
  }));

  const consume = (ci: number, si: number, how: MatchHow, score: number): void => {
    used.add(ci);
    const { prims, inheritedCount } = inheritPrimitives(candidates[ci]!.binding.prims, stubs[si]!.prims);
    inherited[si] = prims;
    report[si] = {
      nodeName: report[si]!.nodeName,
      how,
      score,
      inheritedPrims: inheritedCount,
      totalPrims: stubs[si]!.prims.length,
    };
  };

  // ---- 第一层：nodeId 精确（快照与孤儿同权；extras ID 跨文件稳定）----
  // 例外：两侧都是自动生成的 auto-<index> ID 时，它只在「同一文件重导」场景下才有意义 ——
  // 换了一个完全不同的模型，auto-3 会随机撞车。所以 auto-ID 相配还要求 leaf 名一致，
  // 否则让给第二层的路径打分去判。
  const isAuto = (id: string): boolean => id.startsWith('auto-');
  for (let si = 0; si < stubs.length; si++) {
    const st = stubs[si]!;
    const tryFind = (orphan: boolean): number =>
      candidates.findIndex((c, k) => {
        if (used.has(k) || c.orphan !== orphan || c.binding.nodeId !== st.nodeId) return false;
        if (isAuto(st.nodeId) && isAuto(c.binding.nodeId)) {
          return reversePathScore(st.nodePath, c.binding.nodePath) >= 1;
        }
        return true;
      });
    let ci = tryFind(false);
    if (ci < 0) ci = tryFind(true);
    if (ci >= 0) consume(ci, si, 'id', st.nodePath.length);
  }

  // ---- 第二层：反向路径打分 ----
  for (let si = 0; si < stubs.length; si++) {
    if (inherited[si] !== null) continue;
    const st = stubs[si]!;

    let bestCi = -1;
    let bestScore = 0;
    let bestFull = false;
    let tied = false;
    for (let k = 0; k < candidates.length; k++) {
      if (used.has(k)) continue;
      const c = candidates[k]!;
      const score = reversePathScore(st.nodePath, c.binding.nodePath);
      if (score < 1) continue; // leaf 名都不同，零可信度
      const full = fullPathEqual(st.nodePath, c.binding.nodePath);
      // 孤儿降权：不是全路径一致就按 0.5 段处理（仍要求 leaf 匹配）
      const effScore = c.orphan && !full ? score - 0.5 : score;
      if (
        bestCi < 0 ||
        effScore > bestScore ||
        // 同分决胜：全路径一致的赢；快照赢孤儿
        (effScore === bestScore && full && !bestFull) ||
        (effScore === bestScore && full === bestFull && !c.orphan && candidates[bestCi]!.orphan)
      ) {
        // 严格更好才替换；完全并列（同分、同 full、同 orphan 性）记为平局
        tied = false;
        bestCi = k;
        bestScore = effScore;
        bestFull = full;
      } else if (effScore === bestScore && full === bestFull && c.orphan === candidates[bestCi]!.orphan) {
        tied = true;
      }
    }

    if (bestCi < 0) continue; // 没有任何候选，保持 none
    if (tied) {
      // 两个不同分支下同名的 mesh 路径得分完全一样 —— 猜就是赌，拒绝并留痕
      report[si] = { ...report[si]!, note: `路径得分 ${bestScore} 出现平局，无法确定继承对象` };
      continue;
    }
    consume(bestCi, si, 'path', reversePathScore(st.nodePath, candidates[bestCi]!.binding.nodePath));
  }

  return {
    inherited,
    report,
    orphans: candidates.filter((_, k) => !used.has(k)).map((c) => c.binding),
  };
}

/** 匹配报告的一行摘要（导入后显示在模型信息里） */
export function summarizeMatch(report: MatchReportEntry[]): string | null {
  if (report.length === 0) return null;
  const byId = report.filter((r) => r.how === 'id').length;
  const byPath = report.filter((r) => r.how === 'path').length;
  const failed = report.filter((r) => r.how === 'none');
  if (byId === 0 && byPath === 0 && failed.length === 0) return null;
  const parts: string[] = [];
  if (byId > 0) parts.push(`${byId} 节点按 ID 继承`);
  if (byPath > 0) parts.push(`${byPath} 节点按路径继承`);
  if (failed.length > 0) parts.push(`${failed.length} 节点未匹配（用默认材质）`);
  return `材质绑定继承：${parts.join('，')}`;
}
