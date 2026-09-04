/**
 * AssetServer —— 资产 sidecar（`.meta.json`）的加载器。ADR-016 / S1。
 *
 * ## 为什么先做这个
 *
 * S0c 已经落了 28 个 `.glb.meta.json`，但**没有任何代码读它们** ——
 * 1590 行 schema 全部是纸面的。这个文件的唯一目的是**把零消费者变成一**：
 * 编辑器导入 GLB 前先问一句「这个资产自己的导入设置是什么」。
 *
 * ## 不抛异常原则
 *
 * sidecar 是**可选的**。它缺失 / 损坏 / 格式不对，都不该让资产加载失败 ——
 * 那会把一个「元数据便利层」变成「加载链路的单点故障」。
 * 所有问题都降级成 `diagnostics`，调用方自己决定要不要理。
 *
 * 与 `validateSceneDocument`（`document.ts`）同策略：**产出诊断，不抛异常**。
 *
 * ## fetch 可注入
 *
 * 不 import `node:fs`（本仓未装 `@types/node`，`tsconfig.check.json` 的
 * `types` 是白名单），也不假设有 `globalThis.fetch`（测试环境可能没有）。
 * 调用方注入实现，本文件只认一个最小的鸭子类型 `AssetFetch`。
 *
 * ## 不属于这里的东西
 *
 * - **guid → path 索引**：派生产物，启动扫描重建，落 `.workbuddy/cache/`。S1 不做。
 * - **资产字节流本身**（GLB / 贴图）：那是资源加载器的事，这里只管 sidecar。
 * - **写入**：save 路径在 S2（Inspector 编辑后回写），这里只读。
 */

import {
  META_FILE_SUFFIX,
  createDefaultAssetMeta,
  metaPathFor,
  validateAssetMeta,
  type AssetMeta,
  type MetaDiagnostic,
} from './asset-meta';

/**
 * 资产路径。**真源在 `document.ts`**，这里只转出 ——
 * 同包内星号导出，重复定义会触发 TS2308（本项目已踩过一次：`MaterialRef` 撞名）。
 */
import type { AssetPath } from './document';

export type { AssetPath };

/**
 * 最小 fetch 契约。只需要 `ok` / `status` / `text()` ——
 * 不要求真的 Response，便于测试直接塞一个假实现。
 */
export interface AssetFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type AssetFetch = (url: string) => Promise<AssetFetchResponse>;

/** sidecar 加载结果。**永远返回，不抛异常** */
export interface AssetMetaLoad {
  /** 解析并校验过的 meta。sidecar 缺失/损坏时是**默认 meta**，调用方可直接用 */
  meta: AssetMeta;
  /** 校验 + 加载诊断。空数组 = 干净 */
  diagnostics: MetaDiagnostic[];
  /** sidecar 不存在。true = 上面那份 meta 是默认值，不是文件里的 */
  missing: boolean;
  /** 加载或校验过程中出的 error 级诊断（含损坏、schema 不合法） */
  errors: MetaDiagnostic[];
}

export interface AssetServerOptions {
  /**
   * fetch 实现。默认取 `globalThis.fetch`。
   * **测试必须注入** —— 否则测试会真的去打 dev server。
   */
  fetchImpl?: AssetFetch;
  /** 是否缓存已加载的 meta（默认 true）。编辑 .meta 后需 `clearCache()` */
  cache?: boolean;
}

/** 诊断码前缀统一为 `L_`（load），与 schema 里的 `E_META_*` / `W_META_*` 区分开 */
export const DIAG_MISSING = 'W_ASSET_META_MISSING';
export const DIAG_UNREADABLE = 'E_ASSET_META_UNREADABLE';
export const DIAG_BAD_JSON = 'E_ASSET_META_BAD_JSON';
export const DIAG_NOT_OBJECT = 'E_ASSET_META_NOT_OBJECT';

/**
 * 规范资产路径：补前导 `/`，去掉尾随 `/`。
 * `assets/x/a.glb` 与 `/assets/x/a.glb` 必须解析到同一个 sidecar，
 * 否则缓存会出现两条键指向同一文件。
 */
export function normalizeAssetPath(assetPath: AssetPath): AssetPath {
  const trimmed = assetPath.trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export class AssetServer {
  private readonly fetchImpl: AssetFetch | null;
  private readonly useCache: boolean;
  private readonly cache = new Map<string, AssetMetaLoad>();

  constructor(options: AssetServerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? null;
    this.useCache = options.cache ?? true;
  }

  /**
   * 读资产的 sidecar。**不抛异常**。
   *
   * 失败降级链：fetch 抛错 / 非 2xx → 默认 meta + `E_ASSET_META_UNREADABLE`
   * （404 特判为 `W_ASSET_META_MISSING`，因为缺 sidecar 是**正常状态**）；
   * JSON 解析失败 → 默认 meta + `E_ASSET_META_BAD_JSON`。
   *
   * 解析成功还要过一遍 `validateAssetMeta` —— 文件存在不等于内容合法。
   */
  async loadMeta(assetPath: AssetPath): Promise<AssetMetaLoad> {
    const key = normalizeAssetPath(assetPath);

    if (this.useCache) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit;
    }

    const result = await this.fetchMeta(key);

    if (this.useCache) this.cache.set(key, result);
    return result;
  }

  /**
   * 归一化身高：sidecar 里配了就用，没配就用调用方给的 fallback。
   *
   * **分层约束**：scene 包（L4）不能 import `apps/editor/src/models.ts`（L5）
   * 的 `MODEL_RULER_HEIGHT_M`，所以 fallback 必须由调用方传入。
   * 本函数只负责「有就用、没有就回落」这个决策。
   */
  async resolveHeightM(assetPath: AssetPath, fallbackMeters: number): Promise<number> {
    const load = await this.loadMeta(assetPath);
    const configured = load.meta.importer?.normalizeHeightM;
    // 生成器铁律：解析失败是 null 不是 0，所以这里用 > 0 而不是 != null
    return typeof configured === 'number' && configured > 0 ? configured : fallbackMeters;
  }

  /** 丢缓存。编辑过 .meta 之后必须调，否则读到旧值 */
  clearCache(): void {
    this.cache.clear();
  }

  /** 已缓存的路径（调试用） */
  cachedPaths(): string[] {
    return [...this.cache.keys()];
  }

  // ------------------------------------------------------------ 内部

  private async fetchMeta(key: AssetPath): Promise<AssetMetaLoad> {
    const sidecarPath = metaPathFor(key);
    const fallback = (): AssetMeta => createDefaultAssetMeta(`as_missing_${hashPath(key)}`, 'gltf');

    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      return missing(key, fallback(), '没有可用的 fetch 实现（既没注入也没有 globalThis.fetch）');
    }

    let resp: AssetFetchResponse;
    try {
      resp = await fetchImpl(sidecarPath);
    } catch (cause) {
      return unreadable(key, fallback(), `fetch 抛错：${String(cause)}`);
    }

    // 404 是**正常状态**（sidecar 可选），降级不报错
    if (resp.status === 404 || resp.status === 0) {
      return missing(key, fallback(), `无 sidecar（HTTP ${resp.status}）`);
    }
    if (!resp.ok) {
      return unreadable(key, fallback(), `HTTP ${resp.status} ${sidecarPath}`);
    }

    let text: string;
    try {
      text = await resp.text();
    } catch (cause) {
      return unreadable(key, fallback(), `读取响应体失败：${String(cause)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      return badJson(key, fallback(), `JSON 解析失败：${String(cause)}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return notObject(key, fallback(), `顶层不是对象，收到 ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }

    // 文件存在且是合法 JSON，还要过 schema 校验 —— 合法 JSON ≠ 合法 AssetMeta
    const diagnostics = validateAssetMeta(parsed);
    const meta = parsed as AssetMeta;
    const errors = diagnostics.filter((d) => d.severity === 'error');

    return {
      meta,
      diagnostics: diagnostics.map((d) => ({ ...d, path: `${sidecarPath}${d.path}` })),
      missing: false,
      errors,
    };
  }
}

// ---------------------------------------------------------------- 诊断构造

function withDiag(
  meta: AssetMeta,
  diagnostics: MetaDiagnostic[],
  missing: boolean,
): AssetMetaLoad {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  return { meta, diagnostics, missing, errors };
}

function missing(key: AssetPath, meta: AssetMeta, detail: string): AssetMetaLoad {
  return withDiag(meta, [{
    severity: 'warning',
    code: DIAG_MISSING,
    path: metaPathFor(key),
    message: `没有 sidecar，回落默认导入设置（${detail}）。跑 npm run scene:gen 可生成`,
  }], true);
}

function unreadable(key: AssetPath, meta: AssetMeta, detail: string): AssetMetaLoad {
  return withDiag(meta, [{
    severity: 'error',
    code: DIAG_UNREADABLE,
    path: metaPathFor(key),
    message: `sidecar 读不到，回落默认导入设置（${detail}）`,
  }], false);
}

function badJson(key: AssetPath, meta: AssetMeta, detail: string): AssetMetaLoad {
  return withDiag(meta, [{
    severity: 'error',
    code: DIAG_BAD_JSON,
    path: metaPathFor(key),
    message: `sidecar 不是合法 JSON，回落默认导入设置（${detail}）`,
  }], false);
}

function notObject(key: AssetPath, meta: AssetMeta, detail: string): AssetMetaLoad {
  return withDiag(meta, [{
    severity: 'error',
    code: DIAG_NOT_OBJECT,
    path: metaPathFor(key),
    message: `sidecar 结构不合法，回落默认导入设置（${detail}）`,
  }], false);
}

/** 给缺 sidecar 的默认 meta 造一个稳定的伪 guid（同一个路径每次都一样，便于日志比对） */
function hashPath(path: string): string {
  let h = 2166136261;
  for (let i = 0; i < path.length; i += 1) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export { META_FILE_SUFFIX };
