/**
 * WU-03 宿主组合：从场景 collider 真源（SceneGraph 节点 + 真实世界矩阵）
 * 批量生成 Rapier 静态镜像。这是「同一 collider 真源」的落点——物理后端
 * 不另造地面/墙体，只镜像既有非触发 collider；触发器、禁用、隐藏节点跳过，
 * 与 loader 的实心体口径一致。不支持的变换经 sceneColliderToStaticMirror
 * 产出 diagnostic（非均匀球/胶囊、shear、退化），绝不静默近似。
 */

import type { SceneGraph, ColliderComponent, NodeId } from '@aether/scene';
import { sceneColliderToStaticMirror } from './fracture-static-mirror';
import type { RapierFractureBackend } from './fracture-rapier';

export interface StaticMirrorSyncResult {
  /** 成功镜像的 nodeId 数。 */
  mirrored: number;
  /** 拒绝的 collider（nodeId + 原因）。 */
  rejected: readonly { nodeId: NodeId; diagnostic: string }[];
}

/**
 * 把 SceneGraph 当前全部有效 collider 镜像进后端。重复调用对同 nodeId 即更新
 * （upsert 语义），不会叠加幽灵 collider；调用方负责在节点删除时调用
 * backend.removeStatic(nodeId)。
 */
export function syncStaticMirrorsFromScene(graph: SceneGraph, backend: RapierFractureBackend): StaticMirrorSyncResult {
  let mirrored = 0;
  const rejected: { nodeId: NodeId; diagnostic: string }[] = [];
  for (const node of graph.toNodes()) {
    for (const c of node.components) {
      if (c.kind !== 'Collider') continue;
      const col = c as ColliderComponent;
      if (col.isTrigger || !col.enabled || !graph.isEffectivelyVisible(node.id)) continue;
      const result = sceneColliderToStaticMirror(node.id, col.shape, col.isTrigger, graph.worldMatrix(node.id));
      if (!result.ok || !result.spec) {
        rejected.push({ nodeId: node.id, diagnostic: result.diagnostic ?? '未知原因' });
        continue;
      }
      backend.upsertStatic(node.id, {
        position: result.spec.position,
        rotation: result.spec.rotation,
        shape: result.spec.shape,
      });
      mirrored++;
    }
  }
  return { mirrored, rejected };
}
