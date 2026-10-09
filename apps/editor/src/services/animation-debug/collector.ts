import { identityKey, type AnimationSink, type AnimationSnapshot } from './contracts';
export type DebugTarget = { kind: 'scene'; nodeId: string; label: string }
  | { kind: 'entity'; id: number; generation: number; runId: number; label: string };
export interface AnimationDebugSource {
  context(): { active: boolean; runId: number | null };
  targets(): DebugTarget[];
  defaultTarget(): DebugTarget | null;
  watch(target: DebugTarget | null, sink: AnimationSink | null): void;
  read(target: DebugTarget): AnimationSnapshot | null;
}
export interface DebugHistoryEntry { sequence: number; tick: number; from: string; to: string; reason: string; snapshot: AnimationSnapshot }
export interface DebugView { snapshot: AnimationSnapshot | null; history: DebugHistoryEntry[]; targets: DebugTarget[]; target: DebugTarget | null; frozen: boolean; active: boolean }
const targetKey = (t: DebugTarget | null): string => !t ? '' : t.kind === 'scene' ? `scene:${t.nodeId}` : `entity:${t.runId}:${t.id}:${t.generation}`;
/** Captures only the selected production stream; UI throttling never drops transition events. */
export class AnimationDebugCollector {
  static readonly refreshMs = 125;
  static readonly historyLimit = 32;
  private open = false;
  private frozen = false;
  private runId: number | null = null;
  private active = false;
  private target: DebugTarget | null = null;
  private latest: AnimationSnapshot | null = null;
  private history: DebugHistoryEntry[] = [];
  private lastSignature = '';
  private lastIdentity = '';
  private sequence = 0;
  private nextRefresh = 0;
  private displayed: DebugView | null = null;
  constructor(private readonly source: AnimationDebugSource) {}
  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open; this.clear(); this.target = null; this.frozen = false; this.nextRefresh = 0;
    this.source.watch(null, null);
    this.runId = null;
  }
  select(target: DebugTarget | null): void {
    if (targetKey(target) === targetKey(this.target)) return;
    this.clear(); this.target = target ? { ...target } : null; this.frozen = false; this.nextRefresh = 0;
    this.source.watch(this.open ? this.target : null, this.open && this.target ? s => this.capture(s) : null);
    if (this.open && this.target) this.capture(this.source.read(this.target));
  }
  setFrozen(frozen: boolean): void {
    this.frozen = frozen; this.nextRefresh = 0;
    // The retained view is CPU-only. Capture continues while the world runs.
    if (this.displayed) this.displayed.frozen = frozen;
  }
  private clear(): void { this.latest = null; this.history = []; this.lastSignature = ''; this.lastIdentity = ''; this.sequence = 0; this.displayed = null; }
  private capture(snapshot: AnimationSnapshot | null): void {
    if (!this.open || !this.target) return;
    const context = this.source.context();
    if (!context.active || context.runId !== this.runId) return;
    if (!snapshot) { this.latest = null; return; }
    if (this.target.kind === 'entity') {
      const id = snapshot.identity;
      if (id.kind !== 'entity' || id.runId !== this.target.runId || id.id !== this.target.id || id.generation !== this.target.generation) return;
    } else {
      if (snapshot.identity.kind !== 'scene' || snapshot.identity.nodeId !== this.target.nodeId) return;
      // Async scene loading has no runtime argument; the current run boundary is supplied by the host.
      snapshot = { ...snapshot, identity: { ...snapshot.identity, runId: this.runId! } };
    }
    const key = identityKey(snapshot.identity);
    if (this.lastIdentity && key !== this.lastIdentity) this.clear();
    this.lastIdentity = key;
    const signature = JSON.stringify([snapshot.status, snapshot.pipeline, snapshot.decision.actual, snapshot.decision.actionStamp, snapshot.revision]);
    if (signature !== this.lastSignature) {
      this.history.push({ sequence: ++this.sequence, tick: snapshot.tick, from: this.latest?.decision.actual ?? '开始观察',
        to: snapshot.decision.actual, reason: [snapshot.decision.source, snapshot.decision.fallback, snapshot.decision.actionStamp].filter(Boolean).join(' · '),
        snapshot: structuredClone(snapshot) });
      if (this.history.length > AnimationDebugCollector.historyLimit) this.history.shift();
      this.lastSignature = signature;
    }
    this.latest = snapshot;
  }
  /** Call from the editor frame; context guard is cheap even when the panel is closed. */
  update(now: number): DebugView | null {
    if (!this.open) return null;
    const context = this.source.context();
    if (context.active !== this.active || context.runId !== this.runId) {
      this.clear(); this.frozen = false; this.target = null; this.source.watch(null, null);
      this.runId = context.active ? context.runId : null; this.nextRefresh = 0;
      this.active = context.active;
    }
    if (now < this.nextRefresh) return null;
    this.nextRefresh = now + AnimationDebugCollector.refreshMs;
    if (!context.active) return { snapshot: null, history: [], targets: [], target: null, frozen: false, active: false };
    if (!this.target) this.select(this.source.defaultTarget());
    this.nextRefresh = now + AnimationDebugCollector.refreshMs;
    if (this.target) this.capture(this.source.read(this.target));
    if (this.frozen && this.displayed) return structuredClone(this.displayed);
    this.displayed = structuredClone({ snapshot: this.latest, history: this.history, targets: this.source.targets(), target: this.target, frozen: this.frozen, active: true });
    return structuredClone(this.displayed);
  }
  /** Detached inspection for diagnostics/tests; exposes no animation control methods. */
  inspect(): DebugView | null { return this.displayed ? structuredClone(this.displayed) : null; }
  dispose(): void { this.setOpen(false); }
}
