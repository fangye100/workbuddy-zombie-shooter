/** Play-owned animation presentation for authored skinned scene nodes. */
import { DEFAULT_MOTION_TRANSITION_SEC, type SceneDocument } from '@aether/scene';
import type { RuntimeSession } from '@aether/runtime';
import { advancePoseTransition, createSkinState, selectClip, poseTransitionWeight } from '@aether/render';
import type { SceneObject } from '../renderer';
import { SharedMotionRuntime, type ResolvedMotion } from './shared-motion-runtime';
import { bodyAimActive } from './runtime-body-ik';
import { sceneChoice, type SceneChoiceInput } from './animation-debug/selection';
import { deliver, noIk, type AnimationSink, type AnimationSnapshot } from './animation-debug/contracts';
import { observeIk } from './animation-debug/ik-observation';

type MotionObject = Pick<SceneObject, 'skeleton' | 'animations' | 'skinState' | 'loadedAssetPath' | 'removed' | 'scale'>;
interface Entry {
  nodeId: string; name: string; object: MotionObject; player: boolean; speed: number;
  defaultState: string; result: ResolvedMotion; state: string; startTick: number;
  manual: boolean;
  elapsed: number; lastTick: number;
  weaponActionStamp?: string;
  revision: number; fromState: string; choice?: SceneChoiceInput;
}
export class RuntimeSceneMotion {
  private generation = 0;
  private entries = new Map<string, Entry>();
  private restore: (() => void)[] = [];
  private tick = 0;
  private runId: number | null = null;
  private step = 1 / 30;
  private lastPlayer: { x: number; z: number; tick: number } | null = null;
  private playerSpeed = 0;
  private errors: { nodeId: string; message: string }[] = [];
  private pending = 0;
  private nodeStatus = new Map<string, 'pending' | 'failed' | 'unconfigured'>();
  private debugNode: string | null = null;
  private debugSink: AnimationSink | null = null;
  /** Replaces only the debug subscriber; never selects an animation. */
  watchDebug(nodeId: string | null, sink: AnimationSink | null): void {
    this.debugNode = nodeId; this.debugSink = sink;
  }
  debugSnapshot(nodeId: string): AnimationSnapshot | null {
    const e = this.entries.get(nodeId);
    if (!e) {
      const status = this.nodeStatus.get(nodeId); if (!status) return null;
      return { identity: { kind: 'scene', nodeId, runId: this.runId ?? 0, generation: this.generation }, label: nodeId,
        tick: this.tick, revision: 0, pipeline: 'cpu-scene', status,
        decision: { requested: '—', actual: '—', source: status, fallback: null, actionStamp: '', rules: [] },
        clip: null, transition: null, ik: noIk(), diagnostics: this.errors.filter(x => x.nodeId === nodeId).map(x => x.message) };
    }
    const skin = e.object.skinState, clip = skin?.clips[skin.clip];
    const decision = e.choice && !e.manual ? sceneChoice(e.choice, true).decision! : {
      requested: e.state, actual: e.state, source: e.manual ? 'manual' : 'configured-default', fallback: null, actionStamp: '', rules: [],
    };
    if (e.manual) decision.rules.push({ id: 'manual', label: '已有控制面板手动覆盖', matched: true, selected: true, reason: '循环动作保持；非循环结束后恢复自动选择' });
    return { identity: { kind: 'scene', nodeId, runId: this.runId ?? 0, generation: this.generation }, label: e.name,
      tick: this.tick, revision: e.revision, pipeline: 'cpu-scene', status: 'ready', decision,
      clip: clip && skin ? { name: clip.name, index: skin.clip, time: skin.time, duration: clip.duration,
        phase: clip.duration > 0 ? skin.time / clip.duration : 0, loop: skin.loop } : null,
      transition: skin?.transition ? { from: e.fromState || 'initial pose', to: e.state,
        elapsed: skin.transition.elapsed, duration: skin.transition.duration,
        weight: poseTransitionWeight(skin.transition.elapsed, skin.transition.duration), source: 'local-pose-snapshot' } : null,
      ik: observeIk(skin?.bodyIk), diagnostics: e.result.reports.filter(r => r.state === e.state).flatMap(r => r.diagnostics.filter(d => d.severity !== 'info').map(d => `${d.code}: ${d.message}`)) };
  }
  private emitDebug(nodeId: string): void {
    if (this.debugSink && this.debugNode === nodeId) deliver(this.debugSink, this.debugSnapshot(nodeId));
  }
  constructor(readonly library: SharedMotionRuntime, private readonly objectForNode: (id: string) => MotionObject | null,
    private readonly changed: () => void = () => {}) {}
  start(doc: SceneDocument): void {
    this.stop(); this.library.beginLoad(); this.errors = []; this.tick = 0;
    const generation = this.generation;
    for (const node of doc.nodes) {
      const mesh = node.components.find(c => c.kind === 'MeshRenderer' && c.enabled && c.visible && !c.editorOnly);
      if (mesh?.kind !== 'MeshRenderer' || mesh.source.type !== 'asset' || !node.visible) continue;
      if (mesh.sharedMotion === null) { this.nodeStatus.set(node.id, 'unconfigured'); continue; }
      const path = mesh.source.ref.path, object = this.objectForNode(node.id);
      if (!object || !object.skeleton || object.removed || object.loadedAssetPath !== path) {
        if (mesh.sharedMotion) this.errors.push({ nodeId: node.id, message: '共享动作目标骨架尚未加载' });
        this.nodeStatus.set(node.id, 'failed');
        continue;
      }
      this.pending++;
      this.nodeStatus.set(node.id, 'pending');
      const authorAnimations = object.animations, authorSkin = object.skinState;
      const authorSkinValues = authorSkin ? { ...authorSkin } : null;
      void (async () => {
        try {
          const meta = await this.library.assetMeta(path);
          const binding = mesh.sharedMotion ?? meta?.sharedMotion;
          if (!binding) { if (generation === this.generation) this.nodeStatus.set(node.id, 'unconfigured'); return; }
          const result = await this.library.resolve(object.skeleton!, binding, meta);
          if (generation !== this.generation) return;
          this.restore.push(() => {
            if (authorSkin && authorSkinValues) Object.assign(authorSkin, authorSkinValues);
            object.animations = authorAnimations; object.skinState = authorSkin;
          });
          object.animations = result.clips; object.skinState = createSkinState(object.skeleton!, result.clips);
          const entry: Entry = { nodeId: node.id, name: node.name, object, player: node.id === doc.playerStart && mesh.playBinding === 'player',
            speed: binding.speed, defaultState: binding.defaultState, result, state: '', startTick: this.tick, manual: false, elapsed: 0, lastTick: this.tick, revision: 0, fromState: '' };
          this.entries.set(node.id, entry); this.select(entry, binding.defaultState, false); this.changed();
        } catch (error) {
          if (generation === this.generation) { this.nodeStatus.set(node.id, 'failed'); this.errors.push({ nodeId: node.id, message: String(error) }); this.changed(); }
        } finally { if (generation === this.generation) { this.pending--; this.changed(); this.emitDebug(node.id); } }
      })();
    }
    this.changed();
  }
  stop(): void {
    this.generation++; for (const restore of this.restore) restore();
    this.restore = []; this.entries.clear(); this.pending = 0; this.runId = null; this.lastPlayer = null; this.playerSpeed = 0;
    this.nodeStatus.clear(); deliver(this.debugSink, null);
  }
  setState(nodeId: string, state: string): boolean {
    const entry = this.entries.get(nodeId); if (!entry || !entry.result.states[state]) return false;
    this.select(entry, state, true); this.emitDebug(nodeId); return true;
  }
  private select(entry: Entry, state: string, manual: boolean, immediate = false): void {
    const skin = entry.object.skinState;
    if (!skin || !entry.result.states[state]) return;
    if (entry.state !== state || manual || immediate) {
      entry.fromState = entry.state; entry.revision++;
      selectClip(skin, skin.clips.findIndex(c => c.name === state), immediate || !entry.state ? 0 : entry.result.transitionSec ?? DEFAULT_MOTION_TRANSITION_SEC); entry.startTick = this.tick;
      entry.elapsed = 0; entry.lastTick = this.tick;
    }
    entry.state = state; entry.manual = manual; skin.playing = false;
  }
  sync(runtime: RuntimeSession | null): void {
    if (!runtime) return;
    this.step = runtime.fixedStep;
    this.tick = runtime.tick;
    const player = runtime.player();
    if (player && this.runId !== player.runId) {
      this.runId = player.runId; this.lastPlayer = null; this.playerSpeed = 0;
      for (const entry of this.entries.values()) {
        this.select(entry, entry.defaultState, false, true);
        entry.startTick = runtime.tick; entry.manual = false; entry.elapsed = 0; entry.lastTick = runtime.tick;
        delete entry.choice; delete entry.weaponActionStamp;
      }
    }
    if (player && this.lastPlayer && this.tick > this.lastPlayer.tick) {
      this.playerSpeed = Math.hypot(player.x - this.lastPlayer.x, player.z - this.lastPlayer.z) / ((this.tick - this.lastPlayer.tick) * this.step);
    }
    if (player) this.lastPlayer = { x: player.x, z: player.z, tick: this.tick };
    for (const entry of this.entries.values()) {
      const skin = entry.object.skinState; if (!skin) continue;
      const clipConfig = entry.result.states[entry.state]!;
      if (entry.manual && !clipConfig.loop && (this.tick - entry.startTick) * this.step * entry.speed >= skin.clips[skin.clip]!.duration) entry.manual = false;
      if (entry.player && !entry.manual) {
        const action=runtime.weapons?.animation;
        const keepGait=!!skin.bodyIk?.binding.locomotionWhileAiming && bodyAimActive(skin.bodyIk);
        const input: SceneChoiceInput = { states: entry.result.states, defaultState: entry.defaultState, speed: this.playerSpeed, keepGait,
          weapon: action, firing: runtime.firing, runId: runtime.runId };
        const { requested, state, stamp } = sceneChoice(input);
        if (this.debugSink && this.debugNode === entry.nodeId) entry.choice = input;
        if(requested && stamp!==entry.weaponActionStamp){this.select(entry,state,true);entry.manual=false;}
        entry.weaponActionStamp=stamp;
        this.select(entry, entry.result.states[state] ? state : entry.defaultState, false);
      }
      const config = entry.result.states[entry.state]!, clip = skin.clips[skin.clip]!;
      const gait = entry.player && !entry.manual && config.nominalSpeedMps ? this.playerSpeed / (config.nominalSpeedMps * entry.object.scale) : 1;
      const dt = Math.max(0, this.tick - entry.lastTick) * this.step;
      advancePoseTransition(skin, dt);
      entry.elapsed += dt * entry.speed * gait;
      entry.lastTick = this.tick;
      const time = entry.elapsed;
      const weapon=entry.player && !entry.manual?runtime.weapons?.animation:null;
      const isWeaponClip=weapon && weapon.action!=='idle' && !(weapon.action==='fire' && skin.bodyIk?.binding.locomotionWhileAiming && bodyAimActive(skin.bodyIk)) && [weapon.clip,weapon.action==='fire'?'shoot':weapon.action,weapon.fallback].includes(entry.state);
      skin.time = isWeaponClip?weapon.phase*clip.duration:config.loop && clip.duration > 0 ? time % clip.duration : Math.min(time, clip.duration);
      skin.loop = config.loop; skin.playing = false;
      this.emitDebug(entry.nodeId);
    }
  }
  summary() {
    return { pending: this.pending, errors: [...this.errors], stats: { ...this.library.stats }, nodes: [...this.entries.values()].map(e => ({
      nodeId: e.nodeId, name: e.name, key: e.result.key, state: e.state, time: e.object.skinState?.time,
      transition: e.object.skinState?.transition ? { elapsed: e.object.skinState.transition.elapsed, duration: e.object.skinState.transition.duration } : null,
      clips: e.result.clips.map(c => c.name), joints: e.object.skeleton?.joints.length,
      reports: e.result.reports.map(r => ({ state: r.state, status: r.status, warnings: [...new Set(r.diagnostics.filter(d => d.severity !== 'info').map(d => d.code))], metrics: r.metrics })),
    })) };
  }
}
