/**
 * 内置模型清单（模型浏览器用）。
 *
 * 2026-09-01 变更：E-04 的三档内置档（e04 / e04uv6k / e04uv1600）**已全部移除**。
 * 原因：它们是「AI 自己做了 LOD」的中间产物，与原始 GLB 的显示结果不一致（体型漂移、
 * UV 破碎），留着只会混淆真源。用户要求清干净，统一走「导入 GLB…」这条唯一路径。
 *
 * 现在载入角色：用左侧「导入 GLB…」按钮选原始模型文件即可，
 * 由 gpu/gltf.ts 解析、按本文件的 CHARACTER_HEIGHT_M 归一身高。
 *
 * 若将来要恢复内置档：用 assets/characters/_tools/export_labmesh.py 从原始模型重新导出
 * `.mesh.ts`，把文件放进 src/，在 BUILTIN_MODELS 里加一条，贴图放 src/assets/ 并 import 进来。
 */

import type { MeshData } from '@aether/scene';

/**
 * 角色身高唯一真源（米）。取自 assets/characters/roster.json 的 height 字段（E-04「盾卫」= 2.05 m）。
 *
 * 为什么要钉一份：不同批次减面/烘焙出来的产物各自带着导出时的原始身高
 * （实测 2.0500 / 2.1076 / 2.1872），直接换档角色会长高最多 6.7%。
 * 载入时用这把尺子统一归一化，不同来源的模型体型一致。
 * GLB 导入（gpu/gltf.ts）也用同一个值。
 */
export const CHARACTER_HEIGHT_M = 2.05;

/**
 * 身高归一化真源已上提引擎层 `packages/scene`（纯几何，运行时导入链路要用）。
 * 这里 re-export 只为兼容既有 `from './models'` 消费者，不再维护第二份实现。
 *
 * 注意：`CHARACTER_HEIGHT_M` 是内容常量（源自 roster.json），仍属编辑器域，
 * 未随之上提——ADR-002 要求它最终由 roster 生成层产出，见 docs/12 遗留项 L-4。
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
