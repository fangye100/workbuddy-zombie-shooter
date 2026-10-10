/** Generic transient region mask; no game action or playback policy. */
import { validatePoseLayerBinding, type PoseLayerBinding, type SkeletonData, type NodeLocal } from '@aether/scene';
export interface PoseLayerState {
  binding: PoseLayerBinding;
  nodes: number[];
  diagnostics: string[];
  clip: number;
  fromClip?: number;
  time: number;
  loop: boolean;
  transition?: { from: NodeLocal[]; elapsed: number; duration: number };
}
export function createPoseLayerState(sk: SkeletonData, binding: PoseLayerBinding): PoseLayerState {
  const state: PoseLayerState = { binding: structuredClone(binding), nodes: [], diagnostics: validatePoseLayerBinding(binding), clip: -1, time: 0, loop: false };
  if (state.diagnostics.length) return state;
  const key = (name: string): string => name.replace(/^mixamorig[:_]?/i, '').toLowerCase();
  const names = new Map<string, number[]>();
  sk.jointNames.forEach((name, i) => { if (name) names.set(key(name), [...(names.get(key(name)) ?? []), sk.joints[i]!]); });
  function resolve(name: string): number {
    const found = names.get(key(name));
    if (found?.length !== 1) { state.diagnostics.push(`LAYER_BONES: Missing or ambiguous ${name}; base retained`); return -1; }
    return found[0]!;
  }
  const roots = binding.roots.map(resolve), excluded = binding.exclude.map(resolve);
  if (state.diagnostics.length) return state;
  const descendants = (node: number, ancestors: number[]): boolean => {
    const seen = new Set<number>();
    for (let i = node; i >= 0; i = sk.parent[i]!) {
      if (seen.has(i) || i >= sk.parent.length) { state.diagnostics.push('LAYER_HIERARCHY: Invalid skeleton hierarchy; base retained'); return false; }
      seen.add(i); if (ancestors.includes(i)) return true;
    }
    return false;
  };
  // Check all parent chains even if a root is encountered before a broken ancestor.
  for (let node = 0; node < sk.locals.length; node++) descendants(node, []);
  if (state.diagnostics.length) return state;
  for (let node = 0; node < sk.locals.length; node++) if (descendants(node, roots) && !descendants(node, excluded)) state.nodes.push(node);
  if (!state.nodes.length) state.diagnostics.push('LAYER_EMPTY: Mask contains no nodes; base retained');
  return state;
}
