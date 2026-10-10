import type { BodyIkState } from '@aether/render';
import { noIk, type DebugIk } from './contracts';
/** Read actual resolved targets and solver diagnostics; never resolve or solve here. */
export function observeIk(state: BodyIkState | undefined): DebugIk {
  if (!state) return noIk();
  const binding = state.binding;
  return { status: 'configured', enabled: binding.enabled, weight: binding.weight,
    diagnostics: state.diagnostics.map(d => `${d.code}: ${d.message}`),
    controls: binding.controls.map(c => {
      const target = Object.hasOwn(state.targets, c.id) ? state.targets[c.id] ?? null : c.target.kind === 'position' ? c.target.position : null;
      const valid = !!state.nodes[c.id] && !!target && target.every(Number.isFinite);
      const diagnostics = state.diagnostics.filter(d => d.controlId === c.id || !d.controlId).map(d => `${d.code}: ${d.message}`);
      const skipped = diagnostics.some(d => /IK_(CONFIG|BONES|CHAIN|SCALE|TARGET|LENGTH):/.test(d));
      return { id: c.id, part: c.part, enabled: c.enabled, weight: c.weight,
        effectiveWeight: binding.enabled && c.enabled && valid && !skipped ? binding.weight * c.weight * (state.controlWeights?.[c.id] ?? 1) : 0,
        targetKind: c.target.kind, target: target ? [...target] : null, valid, diagnostics };
    }) };
}
