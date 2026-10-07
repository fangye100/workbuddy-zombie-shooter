import { quatMul, quatToEuler, type Quat } from '@aether/core';
import type { SceneDocument } from '@aether/scene';
import type { EntityView } from '@aether/runtime';
import type { SceneObject } from '../renderer';
import { characterYaw } from './character-facing';

export type PlayerVisualObject = Pick<SceneObject,
  'pos' | 'quat' | 'rot' | 'visible' | 'pickable' | 'bob' | 'removed' | 'loadedAssetPath'>;

/** One authored player mesh, reusing its loaded material/texture and existing object slot.
 * No GPU allocation and no document mutation. PlayController owns snapshot restoration.
 * Enemy crowds continue to use RuntimeBridge instancing.
 */
export class PlayerPresentation {
  private bound: { nodeId: string; object: PlayerVisualObject; rotation: Quat; y: number } | null = null;

  constructor(private readonly objectForNode: (nodeId: string) => PlayerVisualObject | null) {}

  prepare(doc: SceneDocument): string | null {
    this.bound = null;
    const node = doc.nodes.find(n => n.id === doc.playerStart);
    const mesh = node?.components.find(c => c.kind === 'MeshRenderer' && c.playBinding === 'player');
    if (!node || mesh?.kind !== 'MeshRenderer' || !mesh.enabled || !mesh.visible || !node.visible) return null;
    const object = this.objectForNode(node.id);
    if (mesh.source.type !== 'asset' || !object || object.removed || !object.visible
      || object.loadedAssetPath !== mesh.source.ref.path) {
      throw new Error('玩家外观资产尚未成功加载，请等待加载完成；加载失败时请重新打开场景');
    }
    this.bound = { nodeId: node.id, object, rotation: [...object.quat], y: object.pos[1] };
    return node.id;
  }

  sync(player: EntityView | null): void {
    if (!this.bound) return;
    const { object, rotation, y, nodeId } = this.bound;
    object.visible = player !== null && player.alive && player.hp > 0 && player.sourceNodeId === nodeId;
    if (!object.visible || !player) return;
    object.pos = [player.x, y, player.z];
    const yaw = characterYaw(player.yaw);
    object.quat = quatMul([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], rotation);
    object.rot = quatToEuler(object.quat);
    object.pickable = false;
    object.bob = 0;
  }

  detach(): void { this.bound = null; }
}
