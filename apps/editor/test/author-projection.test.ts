import { it, expect } from 'vitest';
import { cloneDocument, SpawnEditStore, newAuthorNode } from '@aether/runtime';
import { SceneGraph, type SceneDocument } from '@aether/scene';
import { applyLightChanges, applyMaterialChanges, lightSnapshot } from '../src/services/author-projection';
import { lightAngles } from '../src/services/scene-light';
import { defaultParams } from '../src/params';
const modules = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true });
function fixture(): SceneDocument { return cloneDocument((Object.values(modules)[0] as { default: SceneDocument }).default); }

it('persists selected light controls as node data, preserving world-space direction under a parent', () => {
  const doc = fixture();
  const parent = newAuthorNode('light-parent', 'Light parent');
  parent.transform.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2]; parent.transform.position = [8, 1, 3]; doc.nodes.push(parent);
  doc.nodes.find(n => n.id === 'nd_f1_key')!.parent = parent.id;
  doc.nodes.find(n => n.id === 'nd_f1_beacon')!.parent = parent.id;
  const store = new SpawnEditStore(doc);
  const before = lightSnapshot(defaultParams());
  const after = { ...before, keyAzimuth: 45, keyElevation: 25, keyIntensity: 2.7, pointPosition: [3, 4, 5] as [number, number, number] };
  expect(store.editNodes('lights', nodes => applyLightChanges({ ...doc, nodes }, before, after)).ok).toBe(true);
  const graph = SceneGraph.fromDocument(store.document); graph.updateWorldTransforms();
  const angles = lightAngles(graph.getNode('nd_f1_key')!.world.rotation);
  expect(angles.azimuth).toBeCloseTo(45); expect(angles.elevation).toBeCloseTo(25);
  graph.getNode('nd_f1_beacon')!.world.position.forEach((v, i) => expect(v).toBeCloseTo([3, 4, 5][i]!));
  store.undo(); expect(store.document).toEqual(doc); store.redo();
  expect(store.document.nodes.find(n => n.id === 'nd_f1_key')!.components.find(c => c.kind === 'Light')).toMatchObject({ intensity: 2.7 });
});

it('only patches changed material slots and preserves other bindings', () => {
  const doc = fixture(), node = doc.nodes.find(n => n.id === 'nd_f1r0_building_-1')!;
  const mesh = node.components.find(c => c.kind === 'MeshRenderer')!;
  if (mesh.kind !== 'MeshRenderer') throw new Error('fixture');
  const original = structuredClone(mesh.materials);
  const value = { nodeId: node.id, index: 0, key: 'qa-primitive', base: 's0', patch: { albedo: '#ff4400' } };
  const before = new Map([[node.id + '/0', { ...value, patch: { albedo: '#ffffff' } }]]);
  const after = new Map([[node.id + '/0', value]]);
  applyMaterialChanges(doc.nodes, before, after);
  expect(mesh.materials[0]).toMatchObject({ match: { by: 'primitiveKey', value: 'qa-primitive' }, material: { type: 'override', patch: { albedo: '#ff4400' } } });
  expect(mesh.materials.slice(1)).toEqual(original);
  applyMaterialChanges(doc.nodes, after, after); expect(mesh.materials).toHaveLength(original.length + 1);
});
