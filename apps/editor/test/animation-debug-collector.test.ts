import { describe, expect, it, vi } from 'vitest';
import { AnimationDebugCollector, type AnimationDebugSource, type DebugTarget } from '../src/services/animation-debug/collector';
import { noIk, type AnimationSink, type AnimationSnapshot } from '../src/services/animation-debug/contracts';
import { selectionGraph, poseGraph } from '../src/services/animation-debug/graph';
function sample(tick = 0, revision = 0, runId = 1, generation = 1): AnimationSnapshot {
  return { identity: { kind: 'entity', id: 0, runId, generation }, label: 'NPC', tick, revision, pipeline: 'gpu-palette', status: 'ready',
    decision: { requested: 'walk', actual: 'walk', source: 'behavior', fallback: null, actionStamp: '', rules: [{ id: 'behavior', label: 'behavior', matched: true, selected: true, reason: '1 → walk' }] },
    clip: { name: 'walk', index: 1, time: tick / 30, duration: 1, phase: tick / 30, loop: null },
    transition: { from: 'idle', to: 'walk', elapsed: 0, duration: .05, weight: 0, source: 'palette-matrix-snapshot' }, ik: noIk('unsupported'), diagnostics: [] };
}
function fixture() {
  let active = true, runId = 1, sink: AnimationSink | null = null, latest = sample(), generation = 1;
  const target = (): DebugTarget => ({ kind: 'entity', id: 0, runId, generation, label: 'NPC' });
  const source: AnimationDebugSource = { context: () => ({ active, runId: active ? runId : null }), targets: vi.fn(() => [target()]), defaultTarget: target,
    watch: vi.fn((_target, callback) => { sink = callback; }), read: vi.fn(() => structuredClone(latest)) };
  const collector = new AnimationDebugCollector(source);
  return { source, collector, emit(s: AnimationSnapshot) { latest = s; sink?.(structuredClone(s)); }, stop() { active = false; },
    rerun() { runId++; generation = 1; latest = sample(0, 0, runId); }, nextGeneration() { generation++; latest = sample(0, 0, runId, generation); } };
}
describe('selected animation debug collection', () => {
  it('does zero source reads/watches while closed and throttles the view independently of events', () => {
    const f = fixture(); for (let i = 0; i < 10; i++) expect(f.collector.update(i)).toBeNull();
    expect(f.source.read).not.toHaveBeenCalled(); expect(f.source.targets).not.toHaveBeenCalled(); expect(f.source.watch).not.toHaveBeenCalled();
    f.collector.setOpen(true); expect(f.collector.update(0)!.snapshot!.tick).toBe(0);
    f.emit(sample(1, 1)); f.emit(sample(2, 2)); // Two transitions completed before the next UI refresh.
    expect(f.collector.update(50)).toBeNull();
    const view = f.collector.update(125)!; expect(view.history).toHaveLength(3); expect(view.history[1]!.snapshot.transition!.duration).toBe(.05);
    f.collector.setOpen(false); vi.mocked(f.source.read).mockClear(); f.collector.update(1000); expect(f.source.read).not.toHaveBeenCalled();
  });
  it('bounds history, captures consecutive action stamps on the same clip, and freezes only detached view', () => {
    const f = fixture(); f.collector.setOpen(true); const initial = f.collector.update(0)!; initial.snapshot!.clip!.name = 'polluted';
    f.collector.setFrozen(true);
    for (let i = 1; i <= 50; i++) { const s = sample(i); s.decision.actionStamp = `pistol:fire:${i}`; f.emit(s); }
    const frozen = f.collector.update(125)!; expect(frozen.snapshot!.tick).toBe(0); expect(frozen.history).toHaveLength(1); expect(frozen.frozen).toBe(true);
    f.collector.setFrozen(false); const live = f.collector.update(126)!;
    expect(live.snapshot!.clip!.name).toBe('walk'); expect(live.snapshot!.tick).toBe(50); expect(live.history).toHaveLength(32);
    expect(live.history[31]!.snapshot.decision.actionStamp).toBe('pistol:fire:50');
  });
  it('clears frozen history on rerun, rejects old identity, clears on Stop and target change', () => {
    const f = fixture(); f.collector.setOpen(true); f.collector.update(0); f.collector.setFrozen(true); f.rerun();
    const rerun = f.collector.update(1)!; expect(rerun.history).toHaveLength(1); expect(rerun.snapshot!.identity.runId).toBe(2); expect(rerun.frozen).toBe(false);
    f.emit(sample(9, 10, 1)); expect(f.collector.update(130)!.history).toHaveLength(1);
    f.nextGeneration(); f.collector.select({ kind: 'entity', id: 0, generation: 2, runId: 2, label: 'new generation' });
    expect(f.collector.update(131)!.history).toHaveLength(1);
    f.stop(); expect(f.collector.update(132)).toMatchObject({ snapshot: null, history: [], active: false });
  });
  it('projects actual selector and pose facts without invented state edges or GPU IK', () => {
    const s = sample(); const graph = selectionGraph(s); expect(graph.edges).toContainEqual({ from: 'behavior', to: 'selector', active: true });
    expect(graph.nodes.find(n => n.id === 'actual')!.subtitle).toBe(s.decision.actual);
    const pose = poseGraph(s); expect(pose.nodes.find(n => n.id === 'ik')!.subtitle).toBe('此管线不支持 IK');
    expect(pose.nodes.find(n => n.id === 'transition')!.details.join(' ')).toContain('前一显示姿态快照');
  });
});
