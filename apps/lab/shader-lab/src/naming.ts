/**
 * 命名工具（纯函数，跨层共用）。
 *
 * 单独成文件而不是塞进 materials.ts：gpu/ 层（gltf 解析器）也要用，
 * 让它去 import 编辑器层的 materials 会把依赖方向搞反。
 */

/**
 * 在名字已被占用的集合里挑一个不冲突的名字：<name> / <name> 2 / <name> 3 …
 *
 * 编辑器里到处都需要这个语义：材质实例、glTF primitive 切出来的子网格。
 * 重名在下拉框和层级树里的后果是一样的 —— 用户分不清自己在选哪一个。
 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** 构造器：一边取名一边把取到的名字登记进集合，避免调用方每次手动 add */
export function nameAllocator(initial: Iterable<string> = []): {
  take: (base: string) => string;
  taken: ReadonlySet<string>;
} {
  const taken = new Set(initial);
  return {
    take: (base: string): string => {
      const n = uniqueName(base, taken);
      taken.add(n);
      return n;
    },
    taken,
  };
}
