/**
 * WU-03!î¿ø»û…Ğˆü›ûÜºÙ¯ collider ÜŸú“üˆSceneGraph"ÊƒÂ¹ + ÜŸîŸø–Õß«Øµü‰
 * É»ÇÔŸÈ Rapier"İ™ÀƒÕÃÀ‚ÿ™Ø¯ÀĞø€ collider!ÜŸúÀÚ„Ğ½Â¹À”À•É©Ğ†Ğë¯
 *!øÏ¦À¡Ü²İ¢/â™ı“üÏªÕÃ×¢Ü‹İç¦Ï‘ collidesü›ç¦Ï‘Ù¨ÀæÔ¨ÀÚ’×Ê‚Â»÷³ÿ‡üŒ
 * ø loader!Ú„îŸÿƒı“Ï£ş…ø€Ç´ÀƒøÔ¯ÌÚ„Ï™Í£û sceneColliderToStaticMirror
 *!ú§Çº diagnosticüŠİİ‡ÌĞƒ/Ã¶ÛŠÀshearÀƒÀÌ–ü‹üûøİ›û˜ÿ‘ü¼À‚
 */

import type { SceneGraph, ColliderComponent, NodeId } from '@aether/scene';
import { sceneColliderToStaticMirror } from './fracture-static-mirror';
import type { RapierFractureBackend } from './fracture-rapier';

export interface StaticMirrorSyncResult {
  /** È‘ÊŸÕœÃÚ„ nodeId Õ°À‚ */
  mirrored: number;
  /**!Ë’ûÚ„ collidesüˆnodeId + ÎŸÛ£ü‰À‚ */
  rejected: readonly { nodeId: NodeId; diagnostic: string }[];
}

/**
 *!ÊŠ SceneGraph ı“ÉÅ¨Ã©Ü‰Õˆ collider"ÕœÃÿ›Ğë¯À‚ÇäğƒÔ¨ï¹ĞŒ nodeId Í³ÛµÖ°
 *#üˆupsert"ï­ù‹ü‹üŒøü›Ï Ê¡ù½Áµ colliderü›ğƒÔ¨Ö»ôŸô£ÜªÊƒÂ¹È¢Ù¥×¶ğƒÔ¨
 * backend.removeStatic(nodeId)À‚
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
        rejected.push({ nodeId: node.id, diagnostic: result.diagnostic ?? 'Ü«ß¥ÎŸÛ ' });
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
