/**
 * 骨骼 X-ray 叠加层的线段端点计算（编辑器侧工具，引擎零改动）。
 *
 * 输入是已求值的关节矩阵（jointMatrix'，scene 空间，来自 @aether/render 的
 * evalJointMatrices），输出是世界空间的 line-list 端点。每个关节向其父关节连一段，
 * 再经 modelMatrix 变换到世界空间：预览物体为 I（置于原点），主视图为物体 model 矩阵。
 * 真正的「线怎么画 / 要不要做深度测试（X-ray）」由 RendererCore 负责，这里只算坐标。
 */

import type { SkeletonData } from '@aether/scene';
import type { CoreSkeletonOverlay } from '@aether/render';

/** 列主序 mat4 变换一个点（仿射，w 取 1），与 renderer.ts 的 worldAabb 同算法 */
function tx(
  M: Float32Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    M[0]! * x + M[4]! * y + M[8]! * z + M[12]!,
    M[1]! * x + M[5]! * y + M[9]! * z + M[13]!,
    M[2]! * x + M[6]! * y + M[10]! * z + M[14]!,
  ];
}

/**
 * 由关节矩阵算骨骼线段端点。
 * @returns 长度 = 段数 × 6 的 Float32Array（每段两个端点）
 */
export function buildSkeletonPositions(
  jointMatrices: Float32Array,
  skeleton: SkeletonData,
  modelMatrix: Float32Array,
): CoreSkeletonOverlay['positions'] {
  const parent = skeleton.parent;
  const out: number[] = [];
  for (let k = 0; k < parent.length; k++) {
    const p = parent[k]!;
    if (p < 0) continue; // 根关节无父，不连线
    const a = k * 16;
    const b = p * 16;
    const pa = tx(
      modelMatrix,
      jointMatrices[a + 12]!,
      jointMatrices[a + 13]!,
      jointMatrices[a + 14]!,
    );
    const pb = tx(
      modelMatrix,
      jointMatrices[b + 12]!,
      jointMatrices[b + 13]!,
      jointMatrices[b + 14]!,
    );
    out.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
  }
  return new Float32Array(out);
}
