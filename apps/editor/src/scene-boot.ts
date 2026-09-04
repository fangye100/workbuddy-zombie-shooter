/**
 * 启动期场景解析：把「项目容器 → 起始场景 → 场景文件路径」这一步从 main.ts 里抽出来。
 *
 * 为什么单独成文件：
 *   1. `main.ts` 有 DOM 副作用，import 它就没法单测；
 *   2. ADR-015 规定 `aether.project.json` 是所有路径的锚点 —— 起始场景**必须**从它读，
 *      不能在编辑器代码里再写死一份路径。抽出来才能对这条规则写断言。
 *
 * 为什么还要 FALLBACK：项目文件本身也可能坏/缺失。编辑器宁可用兜底路径起起来
 * 再在界面上报，也不能白屏 —— 但兜底只此一处，且会带上 fromProject=false 让调用方知道。
 */
import { validateProject, PROJECT_FILE_NAME } from '@aether/scene';
import { readProjectFile } from './asset-util';

/**
 * 兜底场景路径。只在「项目文件读不到 / 不合法 / 没登记场景」时用。
 * 正常路径一律走 aether.project.json 的 scenes[startIndex]。
 */
export const FALLBACK_SCENE_PATH = '/assets/scenes/sandbox/default.scene.json';

export interface StartSceneResolution {
  path: string;
  /** true = 来自项目容器（正常）；false = 兜底（说明项目文件有问题） */
  fromProject: boolean;
  /** 非致命说明：为什么走了兜底 / 为什么跳过了某些登记项 */
  warning: string | null;
}

/** fetch 的最小契约 —— 只为能在测试里注入假实现，不引入 node 类型 */
export interface JsonFetch {
  (url: string): Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
}

/**
 * 解析启动场景路径。
 *
 * 判定顺序：项目文件能取到 → 合法（零 error）→ scenes[startIndex] 存在且 path 是字符串。
 * 任一步不满足就带 warning 回落 `FALLBACK_SCENE_PATH`，**不抛异常**。
 */
export async function resolveStartScenePath(
  fetchFn: JsonFetch = fetch as unknown as JsonFetch,
): Promise<StartSceneResolution> {
  const fallback = (warning: string): StartSceneResolution => ({
    path: FALLBACK_SCENE_PATH,
    fromProject: false,
    warning,
  });

  // 走 /__fs/file：直接 fetch `/aether.project.json` 会被 vite 的 SPA fallback
  // 挡成 200 + index.html（详见 readProjectFile 的注释）
  const got = await readProjectFile(PROJECT_FILE_NAME, fetchFn);
  if (!got.ok) return fallback(`项目文件读取失败：${got.error ?? `HTTP ${got.status}`}`);
  const raw = got.json;

  const errors = validateProject(raw).filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    return fallback(`项目文件校验失败：${errors[0]?.path ?? ''} ${errors[0]?.code ?? ''}`);
  }

  const proj = raw as { scenes?: unknown; startIndex?: unknown };
  const scenes = Array.isArray(proj.scenes) ? proj.scenes : [];
  // 空清单是校验器**允许**的（scenes 只要是数组就行），所以这一条只有这里能兜住
  if (scenes.length === 0) return fallback('项目里没有登记任何场景');

  // startIndex 允许为 null（校验器只在非 null 时才查范围）→ 此时取第一个。
  // 越界与 path 缺失**不在这里重复判断**：validateProject 已经用 error 拦过了
  // （E_PROJ_START_RANGE / E_PROJ_SCENE_PATH），再查一遍就是两份规则。
  const rawIndex = proj.startIndex;
  const index = typeof rawIndex === 'number' ? rawIndex : 0;
  const entry = scenes[index] as { path?: string } | undefined;
  if (entry === undefined || typeof entry.path !== 'string') {
    return fallback(`scenes[${index}] 不可用（校验器未拦住的边界）`);
  }

  const warning = rawIndex === null || rawIndex === undefined ? 'startIndex 为空，取 scenes[0]' : null;
  // 项目里存相对路径，fetch 要 / 开头
  const path = entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
  return { path, fromProject: true, warning };
}
