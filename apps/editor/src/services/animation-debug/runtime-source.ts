import { poseTransitionWeight, type SkinState } from '@aether/render';
import type { SceneDocument } from '@aether/scene';
import type { RuntimeSession } from '@aether/zombie-game';
import type { RuntimeSceneMotion } from '../runtime-scene-motion';
import type { RuntimeBridge } from '../runtime-bridge';
import type { RuntimeBodyIk } from '../runtime-body-ik';
import { noIk, type AnimationSink, type AnimationSnapshot } from './contracts';
import type { AnimationDebugSource, DebugTarget } from './collector';
export interface RuntimeDebugHost {
  runtime(): RuntimeSession | null; document(): SceneDocument | null;
  skin(nodeId: string): SkinState | null; actorDiagnostics(): readonly string[];
}
/** Adapter is read-only except replacing subscriptions in the presentation owners. */
export class RuntimeAnimationDebugSource implements AnimationDebugSource {
  constructor(private readonly host: RuntimeDebugHost, private readonly motions: RuntimeSceneMotion,
    private readonly bridge: RuntimeBridge, private readonly ik: RuntimeBodyIk) {}
  context() { const runtime = this.host.runtime(); return { active: !!runtime, runId: runtime?.runId ?? null }; }
  targets(): DebugTarget[] {
    const entities: DebugTarget[] = (this.host.runtime()?.view() ?? []).map(e => ({ kind: 'entity', id: e.id, generation: e.generation, runId: e.runId, label: `${e.kind === 'player' ? '主角' : 'NPC'} ${e.characterId} #${e.id} · 代${e.generation}` }));
    const nodes: DebugTarget[] = (this.host.document()?.nodes ?? []).filter(n => n.visible && n.components.some(c => c.kind === 'MeshRenderer' && c.enabled && c.visible && !c.editorOnly &&
      (this.host.skin(n.id) || c.sharedMotion || c.bodyIk))).map(n => ({ kind: 'scene', nodeId: n.id, label: `场景 ${n.name}` }));
    // An authored player is rendered through the CPU object, not the suppressed GPU proxy.
    return [...nodes, ...entities.filter(e => !(e.kind === 'entity' && this.bridge.presentedPlayerNodeId && this.host.runtime()?.player()?.id === e.id))];
  }
  defaultTarget(): DebugTarget | null {
    const player = this.host.runtime()?.player();
    const nodeId = this.bridge.presentedPlayerNodeId;
    if (nodeId) return { kind: 'scene', nodeId, label: '主角（场景骨架）' };
    if (player) return { kind: 'entity', id: player.id, generation: player.generation, runId: player.runId, label: `主角 ${player.characterId}` };
    return this.targets()[0] ?? null;
  }
  watch(target: DebugTarget | null, sink: AnimationSink | null): void {
    this.motions.watchDebug(target?.kind === 'scene' ? target.nodeId : null, target?.kind === 'scene' ? sink : null);
    this.bridge.watchDebug(target?.kind === 'entity' ? { kind: 'entity', id: target.id, generation: target.generation, runId: target.runId } : null,
      target?.kind === 'entity' && sink ? snapshot => sink(this.decorateEntity(snapshot)) : null);
  }
  private decorateEntity(snapshot: AnimationSnapshot | null): AnimationSnapshot | null {
    if (!snapshot || snapshot.pipeline !== 'proxy' || !snapshot.characterId) return snapshot;
    const errors = this.host.actorDiagnostics().filter(message => message.startsWith(`${snapshot.characterId}:`));
    if (errors.length) { snapshot.status = 'failed'; snapshot.diagnostics.push(...errors); }
    return snapshot;
  }
  read(target: DebugTarget): AnimationSnapshot | null {
    const runtime = this.host.runtime(); if (!runtime) return null;
    if (target.kind === 'entity') {
      if (target.runId !== runtime.runId) return null;
      const e = runtime.view().find(e => e.id === target.id && e.generation === target.generation);
      if (!e) return null;
      const snapshot = this.bridge.debugSnapshot();
      if (!snapshot) return null;
      if (snapshot.identity.kind !== 'entity' || snapshot.identity.id !== target.id || snapshot.identity.generation !== target.generation || snapshot.identity.runId !== target.runId) return null;
      return this.decorateEntity(snapshot);
    }
    const node = this.host.document()?.nodes.find(n => n.id === target.nodeId);
    if (!node) return null;
    let snapshot = this.motions.debugSnapshot(target.nodeId);
    const skin = this.host.skin(target.nodeId), clip = skin?.clips[skin.clip];
    if (!snapshot || snapshot.status === 'unconfigured') {
      snapshot = { identity: { kind: 'scene', nodeId: target.nodeId, runId: runtime.runId, generation: snapshot?.identity.generation ?? 0 },
        label: node.name, tick: runtime.tick, revision: 0, pipeline: 'cpu-scene', status: skin ? 'ready' : 'unavailable',
        decision: { requested: clip?.name ?? 'bind pose', actual: clip?.name ?? 'bind pose', source: 'native-sampler', fallback: null, actionStamp: '', rules: [
          { id: 'native', label: '原始资产采样器', matched: !!clip, selected: !!clip, reason: '未配置共享动作选择器，直接读取当前 SkinState' },
        ] }, clip: skin && clip ? { name: clip.name, index: skin.clip, time: skin.time, duration: clip.duration,
          phase: clip.duration > 0 ? skin.time / clip.duration : 0, loop: skin.loop } : null,
        transition: skin?.transition ? { from: '前一显示姿态', to: clip?.name ?? 'bind pose', elapsed: skin.transition.elapsed,
          duration: skin.transition.duration, weight: poseTransitionWeight(skin.transition.elapsed, skin.transition.duration), source: 'local-pose-snapshot' } : null,
        ik: noIk(), diagnostics: skin ? ['共享动作未配置；原始动画，不推断状态机边'] : ['目标骨架不可用'] };
    }
    snapshot.ik = this.ik.debugSnapshot(target.nodeId);
    return snapshot;
  }
}
