import { MATERIAL_STATE_FIELDS, type MaterialBinding, type MaterialBindingRef, type MaterialPatch } from '@aether/scene';
import type { MaterialState } from '@aether/render';

export interface MaterialTarget { primitiveKey: string; nodePath: string[]; nodeName: string }
export function findSceneBinding(bindings: readonly MaterialBinding[], target: MaterialTarget, index: number): MaterialBindingRef | null {
  for (const by of ['primitiveKey', 'nodePath', 'nodeName', 'index'] as const) {
    const value = by === 'index' ? index : by === 'nodePath' ? target.nodePath.join('/') : target[by];
    const match = bindings.find(b => b.match.by === by && b.match.value === value);
    if (match) return match.material;
  }
  return null;
}
/** Inner patches apply first; outer overrides win. Never mutate shared material state. */
export function resolveSceneMaterial(ref: MaterialBindingRef, base: (id: string) => MaterialState, instance: (id: string) => MaterialState | null = () => null): { id: string; state: MaterialState; warnings: string[] } {
  const patches: MaterialPatch[] = [];
  let current = ref;
  while (current.type === 'override') { patches.unshift(current.patch); current = current.base; }
  const warnings: string[] = [];
  let id = current.id;
  let material: MaterialState;
  if (current.type === 'instance') {
    const loaded = instance(current.id);
    if (loaded) material = loaded;
    else {
      id = current.base;
      material = base(id);
      warnings.push(`材质实例 ${current.id} 未加载；使用其声明的基础材质 ${id}`);
    }
  } else material = base(id);
  const state = { ...material };
  for (const patch of patches) {
    for (const key of MATERIAL_STATE_FIELDS) {
      const value = (patch as Record<string, unknown>)[key];
      if (value !== undefined) (state as unknown as Record<string, unknown>)[key] = value;
    }
    if (patch.texture) warnings.push('材质覆盖中的外部纹理暂不支持；保留网格原有贴图');
  }
  return { id, state, warnings };
}
