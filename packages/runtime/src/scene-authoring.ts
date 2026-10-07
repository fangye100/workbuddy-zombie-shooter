/** Authoring transactions validate references and capacity before changing the working document. */
import { legacyWeaponArsenal, validateSceneDocument, type SceneDocument, type SceneNode, type RunRulesComponent } from '@aether/scene';

export function validateAuthorNodes(doc: SceneDocument): string | null {
  try {
    const error = validateSceneDocument(doc).find(d => d.severity === 'error');
    if (error) return `${error.path} ${error.code}: ${error.message}`;
    if (doc.nodes.filter(n => n.components.some(c => c.kind === 'MeshRenderer')).length > 64) return '场景静态物件不能超过 64 个';
    for (const node of doc.nodes) {
      if (!node.name.trim() || typeof node.visible !== 'boolean' || typeof node.pickable !== 'boolean') return `节点 ${node.id} 的名称或显隐无效`;
      if (Math.abs(Math.hypot(...node.transform.rotation) - 1) > 1e-3) return `节点 ${node.id} 的四元数未归一`;
      for (const c of node.components) {
        if (typeof c.enabled !== 'boolean') return `节点 ${node.id} 的组件启用状态无效`;
        if (c.kind === 'Light' && (![c.intensity, c.range, c.spotAngle, c.priority].every(Number.isFinite) || c.intensity < 0)) return `节点 ${node.id} 的灯光数值无效`;
        if (c.kind === 'RoomVolume' && c.enabled && c.clearRule === 'elite-dead' && c.clearTarget) {
          const target = doc.nodes.find(n => n.id === c.clearTarget)?.components.find(x => x.kind === 'SpawnPoint');
          let parent: string | null | undefined = c.clearTarget;
          while (parent && !doc.nodes.find(n => n.id === parent)?.components.some(x => x.kind === 'RoomVolume')) parent = doc.nodes.find(n => n.id === parent)?.parent;
          if (target?.kind !== 'SpawnPoint' || !target.enabled || target.count <= 0 || target.trigger !== 'room-enter' || parent !== node.id) return `精英房 ${node.name} 的清场目标不可用`;
        }
        if (c.kind === 'RunRules' && c.enabled && c.bossAttack) {
          const target = doc.nodes.find(n => n.id === c.bossAttack!.source)?.components.find(x => x.kind === 'SpawnPoint');
          if (!target?.enabled) return 'Boss 攻击来源必须是启用的刷怪点';
        }
      }
    }
    return null;
  } catch (e) { return `场景节点无效：${String(e)}`; }
}

export function removeNodeTree(nodes: SceneNode[], id: string): void {
  const removed = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const n of nodes) if (n.parent && removed.has(n.parent) && !removed.has(n.id)) { removed.add(n.id); changed = true; }
  }
  // Reference validation rejects deleting targets still used by surviving nodes.
  for (let i = nodes.length - 1; i >= 0; i--) if (removed.has(nodes[i]!.id)) nodes.splice(i, 1);
}

export function newAuthorNode(id: string, name: string, box = false): SceneNode {
  return { id, name, parent: null, visible: true, pickable: true, prefab: null,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: box ? [{ kind: 'MeshRenderer', enabled: true, source: { type: 'builtin', shape: 'box', params: [1, 1, 1] }, materials: [], visible: true, layer: 0, importScale: 1 }] : [] };
}

/** Explicit opt-in seed for the authoring button, never injected while loading old scenes. */
export function newRunRules(): RunRulesComponent {
  return { kind: 'RunRules', enabled: true, attackTokenCount: 4, npcTiming: {decisionMinSec:.08,decisionMaxSec:.35,recoveryMinSec:.2,recoveryMaxSec:.55,windupJitterFrac:.15,cooldownJitterFrac:.35}, campaign: 'custom', scrapPerKill: 2, firstChoiceKills: 3, choiceEveryKills: 6,
    eventScrap: 10, healCost: 10, healAmount: 25, talentCost: 15, floorEssence: 10, aimAssist: true,
    weapon: { magazineSize: 12, reserveRounds: 120, reloadSec: 1.2, ammoPerKill: 8, ammoCost: 10, ammoSupply: 60 },
    arsenal: legacyWeaponArsenal({magazineSize:12,reserveRounds:120,reloadSec:1.2}),
    talents: [
      { id: 'damage', name: 'Damage', description: '', effect: 'damage', value: 0.2, maxStacks: 5 },
      { id: 'haste', name: 'Haste', description: '', effect: 'haste', value: 0.15, maxStacks: 5 },
      { id: 'speed', name: 'Speed', description: '', effect: 'speed', value: 0.1, maxStacks: 5 },
    ] };
}
