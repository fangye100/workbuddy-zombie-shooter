/** Renderer projections never own author data. Material changes are serialized as scene-local overrides. */
import { MATERIAL_STATE_FIELDS, type SceneNode, type MaterialPatch } from '@aether/scene';
import type { LabRenderer } from '../renderer';
import { pickSceneLights } from '../renderer';
import type { LabParams } from '../params';
import { SceneGraph, identityTransform, worldToLocalTransform, type SceneDocument } from '@aether/scene';

export function lightSnapshot(p: LabParams) {
  return { keyColor: p.keyColor, keyIntensity: p.keyIntensity, keyAzimuth: p.keyAzimuth, keyElevation: p.keyElevation,
    pointColor: p.pointColor, pointIntensity: p.pointIntensity, pointRange: p.pointRange, pointPosition: [...p.pointPosition] as [number, number, number] };
}

export function applyLightChanges(doc: SceneDocument, before: ReturnType<typeof lightSnapshot>, after: ReturnType<typeof lightSnapshot>): void {
  const picked = pickSceneLights(doc.nodes), graph = SceneGraph.fromDocument(doc); graph.updateWorldTransforms();
  for (const [kind, id] of [['key', picked.key?.nodeId], ['point', picked.point?.nodeId]] as const) {
    const node = doc.nodes.find(n => n.id === id); if (!node) continue;
    const light = node.components.find(c => c.kind === 'Light'); if (light?.kind !== 'Light') continue;
    if (after[`${kind}Color`] !== before[`${kind}Color`]) light.color = after[`${kind}Color`];
    if (after[`${kind}Intensity`] !== before[`${kind}Intensity`]) light.intensity = after[`${kind}Intensity`];
    if (kind === 'point' && after.pointRange !== before.pointRange) light.range = after.pointRange;
    const world = structuredClone(graph.getNode(node.id)!.world);
    if (kind === 'key' && (before.keyAzimuth !== after.keyAzimuth || before.keyElevation !== after.keyElevation)) {
      const a = after.keyAzimuth * Math.PI / 180, e = after.keyElevation * Math.PI / 180;
      const dir = [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
      const q = [dir[2]!, 0, -dir[0]!, 1 + dir[1]!]; const length = Math.hypot(...q);
      world.rotation = length < 1e-8 ? [1, 0, 0, 0] : q.map(v => v / length) as [number, number, number, number];
      const parent = node.parent ? graph.getNode(node.parent)!.world : identityTransform();
      const local = worldToLocalTransform(parent, world, identityTransform()); if (!local) throw new Error('灯光父节点变换不可逆'); node.transform.rotation = local.rotation;
    }
    if (kind === 'point' && JSON.stringify(before.pointPosition) !== JSON.stringify(after.pointPosition)) {
      world.position = [...after.pointPosition];
      const parent = node.parent ? graph.getNode(node.parent)!.world : identityTransform();
      const local = worldToLocalTransform(parent, world, identityTransform()); if (!local) throw new Error('灯光父节点变换不可逆'); node.transform.position = local.position;
    }
  }
}

export function materialSnapshot(renderer: LabRenderer): Map<string, { nodeId: string; index: number; key: string; base: string; patch: MaterialPatch }> {
  const out = new Map<string, { nodeId: string; index: number; key: string; base: string; patch: MaterialPatch }>();
  for (const [oi, o] of renderer.state.objects.entries()) {
    if (!o.nodeId || o.removed) continue;
    for (const [index, slot] of o.subMeshes.entries()) {
      const info = renderer.getSlotMaterial(oi, index); if (!info) continue;
      const patch = Object.fromEntries(MATERIAL_STATE_FIELDS.map(key => [key, (info.state as unknown as Record<string, unknown>)[key]]));
      out.set(`${o.nodeId}/${index}`, { nodeId: o.nodeId, index, key: slot.primitiveKey, base: /^s\d+$/.test(slot.materialId) ? slot.materialId : 's0', patch });
    }
  }
  return out;
}

export function applyMaterialChanges(nodes: SceneNode[], before: ReturnType<typeof materialSnapshot>, after: ReturnType<typeof materialSnapshot>): void {
  for (const [key, value] of after) {
    if (JSON.stringify(value) === JSON.stringify(before.get(key))) continue;
    const mesh = nodes.find(n => n.id === value.nodeId)?.components.find(c => c.kind === 'MeshRenderer');
    if (mesh?.kind !== 'MeshRenderer') continue;
    const match = value.key ? { by: 'primitiveKey' as const, value: value.key } : { by: 'index' as const, value: value.index };
    mesh.materials = mesh.materials.filter(b => b.match.by !== match.by || b.match.value !== match.value);
    mesh.materials.unshift({ match, material: { type: 'override', base: { type: 'shared', id: value.base }, patch: value.patch } });
  }
}
