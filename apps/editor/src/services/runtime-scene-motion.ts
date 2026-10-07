/** Play-owned animation presentation for authored skinned scene nodes. */
import type { SceneDocument } from '@aether/scene';
import type { RuntimeSession } from '@aether/runtime';
import { createSkinState, selectClip } from '@aether/render';
import type { SceneObject } from '../renderer';
import { SharedMotionRuntime, type ResolvedMotion } from './shared-motion-runtime';

type MotionObject = Pick<SceneObject, 'skeleton' | 'animations' | 'skinState' | 'loadedAssetPath' | 'removed' | 'scale'>;
interface Entry {
  nodeId: string; name: string; object: MotionObject; player: boolean; speed: number;
  defaultState: string; result: ResolvedMotion; state: string; startTick: number;
  manual: boolean;
  elapsed: number; lastTick: number;
  weaponActionStamp?: string;
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
  constructor(readonly library: SharedMotionRuntime, private readonly objectForNode: (id: string) => MotionObject | null,
    private readonly changed: () => void = () => {}) {}
  start(doc: SceneDocument): void {
    this.stop(); this.library.beginLoad(); this.errors = []; this.tick = 0;
    const generation = this.generation;
    for (const node of doc.nodes) {
      const mesh = node.components.find(c => c.kind === 'MeshRenderer' && c.enabled && c.visible && !c.editorOnly);
      if (mesh?.kind !== 'MeshRenderer' || mesh.source.type !== 'asset' || !node.visible || mesh.sharedMotion === null) continue;
      const path = mesh.source.ref.path, object = this.objectForNode(node.id);
      if (!object || !object.skeleton || object.removed || object.loadedAssetPath !== path) {
        if (mesh.sharedMotion) this.errors.push({ nodeId: node.id, message: '共享动作目标骨架尚未加载' });
        continue;
      }
      this.pending++;
      const authorAnimations = object.animations, authorSkin = object.skinState;
      const authorSkinValues = authorSkin ? { ...authorSkin } : null;
      void (async () => {
        try {
          const meta = await this.library.assetMeta(path);
          const binding = mesh.sharedMotion ?? meta?.sharedMotion;
          if (!binding) return;
          const result = await this.library.resolve(object.skeleton!, binding, meta);
          if (generation !== this.generation) return;
          this.restore.push(() => {
            if (authorSkin && authorSkinValues) Object.assign(authorSkin, authorSkinValues);
            object.animations = authorAnimations; object.skinState = authorSkin;
          });
          object.animations = result.clips; object.skinState = createSkinState(object.skeleton!, result.clips);
          const entry: Entry = { nodeId: node.id, name: node.name, object, player: node.id === doc.playerStart && mesh.playBinding === 'player',
            speed: binding.speed, defaultState: binding.defaultState, result, state: '', startTick: this.tick, manual: false, elapsed: 0, lastTick: this.tick };
          this.entries.set(node.id, entry); this.select(entry, binding.defaultState, false); this.changed();
        } catch (error) {
          if (generation === this.generation) { this.errors.push({ nodeId: node.id, message: String(error) }); this.changed(); }
        } finally { if (generation === this.generation) { this.pending--; this.changed(); } }
      })();
    }
    this.changed();
  }
  stop(): void {
    this.generation++; for (const restore of this.restore) restore();
    this.restore = []; this.entries.clear(); this.pending = 0; this.runId = null; this.lastPlayer = null; this.playerSpeed = 0;
  }
  setState(nodeId: string, state: string): boolean {
    const entry = this.entries.get(nodeId); if (!entry || !entry.result.states[state]) return false;
    this.select(entry, state, true); return true;
  }
  private select(entry: Entry, state: string, manual: boolean): void {
    const skin = entry.object.skinState;
    if (!skin || !entry.result.states[state]) return;
    if (entry.state !== state || manual) {
      selectClip(skin, skin.clips.findIndex(c => c.name === state)); entry.startTick = this.tick;
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
        this.select(entry, entry.defaultState, false);
        entry.startTick = runtime.tick; entry.manual = false; entry.elapsed = 0; entry.lastTick = runtime.tick;
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
        const locomotion=this.playerSpeed>2.5 && entry.result.states.run?'run':this.playerSpeed>.05?'walk':'idle';
        const requested=action && action.action!=='idle'?[action.clip,action.action==='fire'?'shoot':action.action,action.fallback].find(s=>!!entry.result.states[s]):undefined;
        const state=requested ?? (!action && runtime.firing && entry.result.states.shoot?'shoot':locomotion);
        const stamp=action && action.action!=='idle'?`${runtime.runId}:${action.weaponId}:${action.action}:${action.startTick}`:'';
        if(requested && stamp!==entry.weaponActionStamp){this.select(entry,state,true);entry.manual=false;}
        entry.weaponActionStamp=stamp;
        this.select(entry, entry.result.states[state] ? state : entry.defaultState, false);
      }
      const config = entry.result.states[entry.state]!, clip = skin.clips[skin.clip]!;
      const gait = entry.player && !entry.manual && config.nominalSpeedMps ? this.playerSpeed / (config.nominalSpeedMps * entry.object.scale) : 1;
      entry.elapsed += Math.max(0, this.tick - entry.lastTick) * this.step * entry.speed * gait;
      entry.lastTick = this.tick;
      const time = entry.elapsed;
      const weapon=entry.player && !entry.manual?runtime.weapons?.animation:null;
      const isWeaponClip=weapon && weapon.action!=='idle' && [weapon.clip,weapon.action==='fire'?'shoot':weapon.action,weapon.fallback].includes(entry.state);
      skin.time = isWeaponClip?weapon.phase*clip.duration:config.loop && clip.duration > 0 ? time % clip.duration : Math.min(time, clip.duration);
      skin.loop = config.loop; skin.playing = false;
    }
  }
  summary() {
    return { pending: this.pending, errors: [...this.errors], stats: { ...this.library.stats }, nodes: [...this.entries.values()].map(e => ({
      nodeId: e.nodeId, name: e.name, key: e.result.key, state: e.state, time: e.object.skinState?.time,
      clips: e.result.clips.map(c => c.name), joints: e.object.skeleton?.joints.length,
      reports: e.result.reports.map(r => ({ state: r.state, status: r.status, warnings: [...new Set(r.diagnostics.filter(d => d.severity !== 'info').map(d => d.code))], metrics: r.metrics })),
    })) };
  }
}
