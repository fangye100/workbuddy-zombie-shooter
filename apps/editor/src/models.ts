/**
 * 内置模型清单（模型浏览器用）。
 *
 * 2026-09-01 变更：E-04 的三档内置档（e04 / e04uv6k / e04uv1600）**已全部移除**。
 * 原因：它们是「AI 自己做了 LOD」的中间产物，与原始 GLB 的显示结果不一致（体型漂移、
 * UV 破碎），留着只会混淆真源。用户要求清干净，统一走「导入 GLB…」这条唯一路径。
 *
 * 现在载入角色：用左侧「导入 GLB…」按钮选原始模型文件即可，
 * 由 gpu/gltf.ts 解析、按本文件的 MODEL_RULER_HEIGHT_M 归一身高。
 *
 * 若将来要恢复内置档：用 assets/characters/_tools/export_labmesh.py 从原始模型重新导出
 * `.mesh.ts`，把文件放进 src/，在 BUILTIN_MODELS 里加一条，贴图放 src/assets/ 并 import 进来。
 */

import type { MeshData } from '@aether/scene';
import { AssetServer } from '@aether/scene';
import { requireCharacter } from '@aether/content';

/**
 * 模型归一化标尺（米）—— **不是**"角色身高"。
 *
 * 为什么改名：roster.json 里 8 个角色身高从 1.25 m（E-02 四足）到 4.0 m（B-02 母体）
 * 各不相同，原名 `CHARACTER_HEIGHT_M` 会被读成"角色都是这个高度"，是错的。
 * 它实际是**一把尺子**：任意来源的模型载入后都按它归一，保证体型可比。
 *
 * 为什么钉一份：不同批次减面/烘焙出来的产物各自带着导出时的原始身高
 * （实测 2.0500 / 2.1076 / 2.1872），直接换档角色会长高最多 6.7%。
 * 载入时用这把尺子统一归一化，不同来源的模型体型一致。
 * GLB 导入（gpu/gltf.ts）也用同一个值。
 *
 * 选值规则：**E-04「盾卫」** —— 编辑器全部验收截图与回归测试都用它，
 * 换标尺等于让所有历史结论失准，所以标尺锚定在它身上。
 * 值由 content 生成层从 roster.json 派生（ADR-002），不再手抄。
 */
export const MODEL_RULER_HEIGHT_M = requireCharacter('E-04').heightMeters;

/**
 * 编辑器全局的资产 sidecar 加载器（ADR-016 / S1）。
 *
 * 单例理由：meta 带缓存，多个面板各自 `new` 会各存一份，
 * 编辑过 `.meta` 之后得挨个清。共用一份，`assetServer.clearCache()` 一处搞定。
 *
 * **降级即默认**：sidecar 缺失 / 损坏一律返回默认 meta + 诊断，**不抛异常**。
 * 所以它永远不会让资产加载失败 —— 它是便利层，不是链路上的单点故障。
 */
export const assetServer = new AssetServer();

/**
 * 归一化身高：**优先问资产自己的 sidecar，没有才回落全局标尺**。
 *
 * 这个函数是 `.meta.json` 在运行时被消费的**第一处**。在此之前的状况是：
 * 28 个 sidecar 躺在盘上，没有任何一行代码读它们（2026-09-04 实测）。
 *
 * 它修掉一个真实 bug：此前所有 GLB 一律按 `MODEL_RULER_HEIGHT_M`（E-04 的 2.05 m）
 * 归一化，于是 B-02 母体（4.0 m）载入后会被压成 2.05 m。现在各资产用自己的身高。
 *
 * @returns `fromMeta` 用于 UI 标注来源 —— 新架构生没生效，界面上看得见才算数
 */
export async function resolveModelHeightM(
  assetPath: string,
): Promise<{ meters: number; fromMeta: boolean }> {
  const load = await assetServer.loadMeta(assetPath);
  const configured = load.meta.importer?.normalizeHeightM ?? null;
  if (typeof configured === 'number' && configured > 0) {
    return { meters: configured, fromMeta: true };
  }
  return { meters: MODEL_RULER_HEIGHT_M, fromMeta: false };
}

/**
 * 身高归一化真源已上提引擎层 `packages/scene`（纯几何，运行时导入链路要用）。
 * 这里 re-export 只为兼容既有 `from './models'` 消费者，不再维护第二份实现。
 *
 * 注意：`MODEL_RULER_HEIGHT_M` 是内容常量（源自 roster.json），仍属编辑器域，
 * 未随之上提——属 ADR-002 所说"资料库进生成层"的范畴，现已由 @aether/content 产出
 * （docs/12 遗留项 L-4 已收口）。
 */
export { normalizeMeshHeight } from '@aether/scene';

export interface BuiltinModel {
  id: string;
  label: string;
  mesh: MeshData;
  texUrl: string;
  meta: { vertices: number; triangles: number; heightMeters: number };
}

/**
 * 内置模型列表。**当前为空** —— 角色一律通过「导入 GLB…」载入原始模型，见文件头说明。
 * 加内置档的方式见文件头注释；加进来时记得用 normalizeMeshHeight 归一化身高。
 */
export const BUILTIN_MODELS: BuiltinModel[] = [];
