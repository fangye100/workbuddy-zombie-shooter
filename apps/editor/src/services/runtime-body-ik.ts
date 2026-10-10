/** Play-owned procedural assembly. Renderer owns pose evaluation; this adapter resolves
 * gameplay targets into normalized actor space and owns only transient CPU state. */
import { type Vec3 } from '@aether/core';
import { SceneGraph, validateBodyIkBinding, type SceneDocument, type AssetMeta } from '@aether/scene';
import { createBodyIkState, rotateVec3, type BodyIkState, type SkinState } from '@aether/render';
import type { RuntimeSession } from '@aether/zombie-game';
import { weaponHandGoals } from '@aether/zombie-game/presentation/player-motion';
import type { SceneObject } from '../renderer';
import { observeIk } from './animation-debug/ik-observation';
import { noIk, type DebugIk } from './animation-debug/contracts';

export type IkObject = Pick<SceneObject, 'pos' | 'quat' | 'scale' | 'skeleton' | 'skinState' | 'removed' | 'loadedAssetPath'>;
interface Entry { handWeight?: number; lastTick?: number; runId?: number; player: boolean; nodeId: string; name: string; object: IkObject; state: BodyIkState; original: SkinState; clone: SkinState }
export function worldToActor(object: Pick<IkObject, 'pos' | 'quat' | 'scale'>, point: Vec3): Vec3 {
  const q = object.quat;
  return rotateVec3([-q[0], -q[1], -q[2], q[3]], [(point[0] - object.pos[0]) / object.scale, (point[1] - object.pos[1]) / object.scale, (point[2] - object.pos[2]) / object.scale]);
}
export class RuntimeBodyIk {
  private generation = 0;
  private entries = new Map<string, Entry>();
  private errors: { nodeId: string; message: string }[] = [];
  private pending = 0;
  private targetDocument: SceneDocument | null = null;
  private targetGraph: SceneGraph | null = null;
  private restoreAuthors: (() => void)[] = [];
  private loadingNodes = new Set<string>();
  /** Detached selected-node projection, including resolved targets and current solver diagnostics. */
  debugSnapshot(nodeId: string): DebugIk {
    const entry = this.entries.get(nodeId);
    if (entry) return observeIk(entry.state);
    const errors = this.errors.filter(e => e.nodeId === nodeId).map(e => e.message);
    return { ...noIk(errors.length ? 'failed' : this.loadingNodes.has(nodeId) ? 'pending' : 'unconfigured'), diagnostics: errors };
  }
  constructor(private readonly objectForNode: (id: string) => IkObject | null,
    private readonly meta: (path: string) => Promise<AssetMeta | null>,
    private readonly worldPos: (id: string) => Vec3 | null,
    private readonly mouse: (height: number) => Vec3 | null,
    private readonly changed: () => void = () => {}) {}
  start(doc: SceneDocument): void {
    this.stop(); this.errors = [];
    this.targetDocument = doc;
    const generation = this.generation;
    for (const node of doc.nodes) {
      const mesh = node.components.find(c => c.kind === 'MeshRenderer' && c.enabled && c.visible && !c.editorOnly);
      if (mesh?.kind !== 'MeshRenderer' || mesh.source.type !== 'asset' || !node.visible || mesh.bodyIk === null) continue;
      const object = this.objectForNode(node.id), path = mesh.source.ref.path;
      if (!object?.skeleton || !object.skinState || object.removed || object.loadedAssetPath !== path) {
        if (mesh.bodyIk) this.errors.push({ nodeId: node.id, message: 'IK 目标骨架尚未加载' });
        continue;
      }
      this.pending++;
      this.loadingNodes.add(node.id);
      const authorSkin = object.skinState, authorValues = { ...authorSkin }, skeleton = object.skeleton;
      this.restoreAuthors.push(() => { Object.assign(authorSkin, authorValues); });
      void (async () => {
        try {
          const binding = mesh.bodyIk === undefined ? (await this.meta(path))?.bodyIk : mesh.bodyIk;
          if (generation !== this.generation || !binding) return;
          if (object.removed || object.loadedAssetPath !== path || object.skeleton !== skeleton || !object.skinState) throw new Error('IK target changed while loading');
          const errors = validateBodyIkBinding(binding);
          if (errors.length) throw new Error(errors.join('; '));
          const original = object.skinState!;
          const state = createBodyIkState(object.skeleton!, binding), clone = { ...original, bodyIk: state };
          object.skinState = clone;
          this.entries.set(node.id, { player: node.id === doc.playerStart && mesh.playBinding === 'player', nodeId: node.id, name: node.name, object, state, original, clone });
        } catch (error) { if (generation === this.generation) this.errors.push({ nodeId: node.id, message: String(error) }); }
        finally { if (generation === this.generation) { this.pending--; this.loadingNodes.delete(node.id); this.changed(); } }
      })();
    }
    this.changed();
  }
  stop(): void {
    this.generation++;
    for (const e of this.entries.values()) {
      if (e.object.skinState === e.clone) e.object.skinState = e.original;
      else if (e.object.skinState?.bodyIk === e.state) delete e.object.skinState.bodyIk;
    }
    for (const restore of this.restoreAuthors) restore();
    this.restoreAuthors = [];
    this.targetDocument = null; this.targetGraph = null;
    this.entries.clear(); this.pending = 0;
    this.loadingNodes.clear();
  }
  sync(runtime: RuntimeSession | null, preservePointer = false): void {
    let enemies: ReturnType<RuntimeSession['view']> | undefined;
    for (const e of this.entries.values()) {
      const skin = e.object.skinState; if (!skin || e.object.removed) continue;
      // Shared motion loading can replace SkinState after IK loads; attach to the new sampler.
      skin.bodyIk = e.state;
      e.state.controlWeights = {};
      for (const c of e.state.binding.controls) {
        let world: Vec3 | null = null;
        const target = c.target;
        if (target.kind === 'position') { e.state.targets[c.id] = target.position; continue; }
        if (target.kind === 'mouse') {
          world = this.mouse(target.height);
          if (!world && preservePointer) continue;
        }
        else if (target.kind === 'node') {
          // Empty attachment/aim nodes have no renderer object. Resolve their authored
          // parent transforms once; rendered targets continue to use their live pose.
          let p = this.worldPos(target.nodeId);
          if (!p && this.targetDocument) {
            this.targetGraph ??= SceneGraph.fromDocument(this.targetDocument);
            p = this.targetGraph.getNode(target.nodeId)?.world.position ?? null;
          }
          if (p) world = [p[0] + target.offset[0], p[1] + target.offset[1], p[2] + target.offset[2]];
        } else if (runtime) {
          enemies ??= runtime.view().filter(entity => entity.kind === 'npc' && entity.alive && entity.hp > 0);
          let best = Infinity;
          for (const enemy of enemies) {
            const distance = Math.hypot(enemy.x - e.object.pos[0], enemy.z - e.object.pos[2]);
            if (distance < best) { best = distance; world = [enemy.x, target.height, enemy.z]; }
          }
        }
        e.state.targets[c.id] = world && Number.isFinite(e.object.scale) && e.object.scale > 0 ? worldToActor(e.object, world) : null;
      }
      const player = e.player ? runtime?.player() : null;
      if (player && skin.poseLayer && runtime?.weapons && player.sourceNodeId === e.nodeId) {
        const pose = runtime.weapons.poseIntent;
        const mount = runtime.weaponMount;
        const goals = weaponHandGoals(pose, mount.position, player.yaw);
        const layer = skin.poseLayer, clip = layer && skin.clips[layer.clip];
        const authoredReload = pose.action === 'reload' && !!clip && ['reload', runtime.weapons.animation.clip].includes(clip.name) && layer!.binding.weight > 0;
        if (e.runId !== player.runId) { e.handWeight = 1; e.lastTick = runtime.tick; e.runId = player.runId; }
        const desired = authoredReload ? 1 - layer!.binding.weight : 1;
        const dt = Math.max(0, runtime.tick - (e.lastTick ?? runtime.tick)) * runtime.fixedStep;
        const maxChange = layer!.binding.transitionSec > 0 ? dt / layer!.binding.transitionSec : 1;
        const previous = e.handWeight ?? 1;
        e.handWeight = previous + Math.sign(desired - previous) * Math.min(Math.abs(desired - previous), maxChange);
        e.lastTick = runtime.tick;
        for (const control of e.state.binding.controls) {
          if (control.part !== 'leftHand' && control.part !== 'rightHand') continue;
          // Preserve clip-authored reload hands; runtime multipliers never modify asset configuration.
          e.state.controlWeights[control.id] = e.handWeight;
          e.state.targets[control.id] = worldToActor(e.object, control.part === 'leftHand' ? goals.left : goals.right);
        }
      }
    }
  }
  setWeight(nodeId: string, controlId: string | null, weight: number): boolean {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) return false;
    const e = this.entries.get(nodeId); if (!e) return false;
    if (controlId === null) e.state.binding.weight = weight;
    else { const c = e.state.binding.controls.find(c => c.id === controlId); if (!c) return false; c.weight = weight; }
    this.changed(); return true;
  }
  locomotion(nodeId: string): boolean {
    const entry = this.entries.get(nodeId);
    if (entry?.object.skinState?.poseLayer) return false; // Four-way base clips already consume the aim-facing heading.
    const state = entry?.state;
    return !!state && state.binding.locomotionWhileAiming && bodyAimActive(state);
  }
  summary() {
    return { pending: this.pending, errors: [...this.errors], nodes: [...this.entries.values()].map(e => ({
      nodeId: e.nodeId, name: e.name, binding: structuredClone(e.state.binding), diagnostics: [...e.state.diagnostics],
    })) };
  }
}
export function bodyAimActive(state: BodyIkState | undefined): boolean {
  return !!state && state.binding.enabled && state.binding.weight > 0 && state.binding.controls.some(c =>
    c.enabled && c.weight > 0 && (c.part === 'upperBody' || c.part === 'head') && !!state.nodes[c.id] &&
    (c.target.kind === 'position' || !!state.targets[c.id]));
}
