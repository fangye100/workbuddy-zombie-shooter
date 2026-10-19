import { quatMul, quatToEuler, type Quat } from '@aether/core';
import { SceneGraph, type SceneDocument } from '@aether/scene';
import type { EntityView } from '@aether/zombie-game';
import type { SceneObject } from '../renderer';
import { characterYaw } from './character-facing';

export type PlayerVisualObject = Pick<SceneObject,
  'pos' | 'quat' | 'rot' | 'visible' | 'pickable' | 'bob' | 'removed' | 'loadedAssetPath'>;

/** One authored player mesh, reusing its loaded material/texture and existing object slot.
 * No GPU allocation and no document mutation. PlayController owns snapshot restoration.
 * Enemy crowds continue to use RuntimeBridge instancing.
 */
export class PlayerPresentation {
  private bound: { nodeId: string; object: PlayerVisualObject; rotation: Quat; y: number; initialY:number; last: [number, number] | null; heading: number | null; runId: number | null } | null = null;

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
    const graph=SceneGraph.fromDocument(doc);
    const surfaceMode=doc.nodes.some(n=>n.components.some(c=>c.kind==='NavZone'&&c.enabled&&c.surface));
    this.bound = { nodeId: node.id, object, rotation: [...object.quat], y: object.pos[1],initialY:surfaceMode ? graph.getNode(node.id)!.world.position[1] : 0,last:null,heading:null,runId:null };
    return node.id;
  }

  sync(player: EntityView | null, locomotionFacing = false): void {
    if (!this.bound) return;
    const { object, rotation, y, nodeId } = this.bound;
    object.visible = player !== null && player.alive && player.hp > 0 && player.sourceNodeId === nodeId;
    if (!object.visible || !player) return;
    if (this.bound.runId !== player.runId) { this.bound.last = null; this.bound.heading = null;this.bound.runId=player.runId; }
    object.pos = [player.x,y+(player.y??0)-this.bound.initialY,player.z];
    if (this.bound.last) {
      const dx = player.x - this.bound.last[0], dz = player.z - this.bound.last[1];
      if (Math.hypot(dx, dz) > 1e-5) this.bound.heading = Math.atan2(dz, dx);
    }
    this.bound.last = [player.x, player.z];
    const yaw = characterYaw(locomotionFacing ? this.bound.heading ?? player.yaw : player.yaw);
    object.quat = quatMul([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], rotation);
    object.rot = quatToEuler(object.quat);
    object.pickable = false;
    object.bob = 0;
  }

  detach(): void { this.bound = null; }
}
