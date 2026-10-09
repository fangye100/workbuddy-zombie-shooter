/** Transient CPU-only projections. No scene/meta, render arrays or control handles escape. */
export type AnimationIdentity = { kind: 'scene'; nodeId: string; runId: number; generation: number }
  | { kind: 'entity'; id: number; runId: number; generation: number };
export interface DebugRule { id: string; label: string; matched: boolean; selected: boolean; reason: string }
export interface DebugDecision {
  requested: string; actual: string; source: string; fallback: string | null;
  actionStamp: string; rules: DebugRule[];
}
export interface DebugTransition {
  from: string; to: string; elapsed: number; duration: number; weight: number;
  source: 'local-pose-snapshot' | 'palette-matrix-snapshot';
}
export interface DebugIk {
  status: 'configured' | 'unconfigured' | 'pending' | 'failed' | 'unsupported';
  enabled: boolean; weight: number; controls: {
    id: string; part: string; enabled: boolean; weight: number; effectiveWeight: number;
    targetKind: string; target: number[] | null; valid: boolean; diagnostics: string[];
  }[]; diagnostics: string[];
}
export interface AnimationSnapshot {
  identity: AnimationIdentity; label: string; tick: number; revision: number;
  characterId?: string;
  pipeline: 'cpu-scene' | 'gpu-palette' | 'proxy';
  status: 'ready' | 'pending' | 'failed' | 'unconfigured' | 'unavailable';
  decision: DebugDecision;
  clip: { name: string; index: number; time: number; duration: number; phase: number; loop: boolean | null } | null;
  transition: DebugTransition | null; ik: DebugIk; diagnostics: string[];
}
export type AnimationSink = (snapshot: AnimationSnapshot | null) => void;
export const noIk = (status: DebugIk['status'] = 'unconfigured'): DebugIk => ({ status, enabled: false, weight: 0, controls: [], diagnostics: [] });
export function identityKey(id: AnimationIdentity): string {
  return `${id.kind}:${id.runId}:${id.generation}:${id.kind === 'scene' ? id.nodeId : id.id}`;
}
/** A broken observer must never interrupt production animation. */
export function deliver(sink: AnimationSink | null, snapshot: AnimationSnapshot | null): void {
  if (!sink) return;
  try { sink(snapshot); } catch { /* Debug-only consumer; production still completes. */ }
}
