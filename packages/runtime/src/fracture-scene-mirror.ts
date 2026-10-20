/**
 * WU-03 宿主组合：从场景 collider 真源（SceneGraph 节点 + 真实世界矩阵）
 * 批量生成 Rapier 静态镜像。这是「同一 collider 真源」的落点——物理后端
 * 不另造地面/墙体，只镜像既有非触发 collider；触发器、禁用、隐藏节点跳过，
 * 与 loader 的实心体口径一致。不支持的变换经 sceneColliderToStaticMirror
 * 产出 diagnostic（非均匀球/胶囊、shear、退化），绝不静默近似。
 *
 * 镜像集合差分：本组合在 backend 上以独立命名空间登记/拥有自己同步出的静态镜像
 * （key 带本组合前缀），重复 sync 时对「有效→disabled/trigger/隐藏/组件移除/节点删除/
 * 变换拒绝」做失效移除，使旧镜像不再挡路；只移除本组合拥有的镜像，不清除其他
 * owner 登记的静态项。恢复有效后可重新镜像。
 */

import type { SceneGraph, ColliderComponent, NodeId } from '@aether/scene';
import { sceneColliderToStaticMirror } from './fracture-static-mirror';
import type { RapierFractureBackend } from './fracture-rapier';

export interface StaticMirrorSyncResult {
  /** 成功镜像的 nodeId 数。 */
  mirrored: number;
  /** 本次失效移除的镜像 nodeId 数。 */
  removed: number;
  /** 拒绝的 collider（nodeId + 原因）。 */
  rejected: readonly { nodeId: NodeId; diagnostic: string }[];
}

/** 本组合拥有的静态镜像 key 前缀，与其他 owner 登记的静态项隔离。 */
const MIRROR_PREFIX = 'scene-mirror:';

/**
 * 把 SceneGraph 当前全部有效 collider 镜像进后端，并对本组合拥有的镜像做差分：
 * 有效 collider upsert（同 nodeId 即更新，不叠加）；失效 collider（disabled/trigger/
 * 隐藏/组件移除/节点删除/变换拒绝）移除其本组合镜像。只动本组合命名空间下的镜像。
 */
export function syncStaticMirrorsFromScene(graph: SceneGraph, backend: RapierFractureBackend): StaticMirrorSyncResult {
  let mirrored = 0;
  const rejected: { nodeId: NodeId; diagnostic: string }[] = [];
  const active = new Set<string>();
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
      backend.upsertStatic(MIRROR_PREFIX + node.id, {
        position: result.spec.position,
        rotation: result.spec.rotation,
        shape: result.spec.shape,
      });
      active.add(MIRROR_PREFIX + node.id);
      mirrored++;
    }
  }
  // 差分移除：本组合此前镜像过、但本次不再有效的 collider（含节点删除/组件移除/失效变换）。
  let removed = 0;
  for (const key of backend.staticKeys()) {
    if (key.startsWith(MIRROR_PREFIX) && !active.has(key)) {
      backend.removeStatic(key);
      removed++;
    }
  }
  return { mirrored, removed, rejected };
}
