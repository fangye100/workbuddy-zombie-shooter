/**
 * 文档路径级差异（WU-5）。
 *
 * ## 为什么需要它
 *
 * 「保存保留未消费组件和无关字段」(docs/17 WU-5) 是一条**很容易假装做到**的要求：
 * 编辑器把场景 load → 改一个字段 → 整体序列化写回，看起来文件还在、JSON 也能解析，
 * 但凡中间有一层"只挑认识的字段重建对象"，未消费的组件（`Script` / `NavZone` /
 * 将来新增的任何 kind）和作者手写的 `userData` 就被悄悄吞了 —— 而且没有任何报错。
 *
 * 断言的写法只有一种可靠：**逐路径比对改前改后的纯数据**，期望差异集合恰好等于
 * 「我打算改的那一个字段」。多一条 = 顺手动了别的东西；少一条 = 编辑没生效。
 *
 * ## 为什么放在 runtime 而不是编辑器
 *
 * 它是纯数据函数，不碰 DOM / GPU / fs，Node CLI、vitest、浏览器都能用；
 * 且保存前后的自检要在**写盘之前**跑（docs/17 §3：Node 和浏览器共用同一套规则）。
 */

/** 一条差异。`before` / `after` 为 `undefined` 表示该路径在一侧不存在（新增或被删） */
export interface JsonDiffEntry {
  /** 形如 `nodes[3].components[1].radius` */
  path: string;
  before: unknown;
  after: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function walk(a: unknown, b: unknown, path: string, out: JsonDiffEntry[]): void {
  // 先过一遍全等：绝大多数子树（几百个节点里没动过的那些）在这一步就退出了
  if (Object.is(a, b)) return;

  // 一侧缺字段 / 类型从数组变成对象：没有可比的子结构，整条记为差异。
  // 这里刻意**不**把 undefined 当成"相等"——JSON 里出现 undefined 只可能是键丢了。
  if (a === undefined || b === undefined || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path, before: a, after: b });
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i], b[i], `${path}[${i}]`, out);
    return;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    // 两侧键的并集：只遍历 a 会漏掉"b 多出来的键"，只遍历 b 会漏掉"被删掉的键"
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      walk(a[k], b[k], path === '' ? k : `${path}.${k}`, out);
    }
    return;
  }

  out.push({ path, before: a, after: b });
}

/**
 * 逐路径比对两份纯数据，返回**全部**差异（不短路）。
 *
 * 输入必须是 JSON 可序列化的：函数、Map、循环引用都不在契约内。
 */
export function changedJsonPaths(a: unknown, b: unknown): JsonDiffEntry[] {
  const out: JsonDiffEntry[] = [];
  walk(a, b, '', out);
  return out;
}

/** 只要路径（断言"改动集合是否恰好等于预期"时用这个更顺手） */
export function changedPathsOnly(a: unknown, b: unknown): string[] {
  return changedJsonPaths(a, b).map((d) => d.path);
}
