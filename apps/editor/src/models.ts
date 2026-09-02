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

/** 顶点 stride（与 gpu/geometry.ts 一致） */
const VF = 15;

/**
 * 把网格按 Y 向高度归一化到 targetMeters，脚底保持贴 y=0（纯函数，不改入参）。
 * 等比缩放：X/Z 与 Y 同比例，体型不失真；法线不需要改（等比 + 正交，方向不变）。
 */
export function normalizeMeshHeight(mesh: MeshData, targetMeters: number): MeshData {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < mesh.vertices.length; i += VF) {
    const y = mesh.vertices[i + 1]!;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const height = maxY - minY;
  if (!(height > 1e-6) || Math.abs(height - targetMeters) < 1e-6) {
    return { vertices: new Float32Array(mesh.vertices), indices: new Uint32Array(mesh.indices) };
  }
  const s = targetMeters / height;
  const out = new Float32Array(mesh.vertices.length);
  for (let i = 0; i < mesh.vertices.length; i += VF) {
    out[i] = mesh.vertices[i]! * s;
    out[i + 1] = (mesh.vertices[i + 1]! - minY) * s; // 先移到脚底 y=0 再缩放
    out[i + 2] = mesh.vertices[i + 2]! * s;
    for (let c = 3; c < VF; c++) out[i + c] = mesh.vertices[i + c]!;
  }
  return { vertices: out, indices: new Uint32Array(mesh.indices) };
}

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
