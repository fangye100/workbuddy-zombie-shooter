import { describe, expect, it, vi } from 'vitest';
import { PlaySession } from '@aether/runtime';
import { createSkinState, PalettePoseTransitions } from '@aether/render';
import { createEmptySceneDocument, type SceneDocument, type SceneNode } from '@aether/scene';
import { RuntimeBridge } from '../src/services/runtime-bridge';
import { RuntimeSceneMotion } from '../src/services/runtime-scene-motion';
import { RuntimeBodyIk } from '../src/services/runtime-body-ik';
import { SharedMotionRuntime, type ResolvedMotion } from '../src/services/shared-motion-runtime';
import { RuntimeAnimationDebugSource } from '../src/services/animation-debug/runtime-source';
import { AnimationDebugCollector } from '../src/services/animation-debug/collector';
import { PlayController } from '../src/services/play-controller';
import type { LabRenderer } from '../src/renderer';
import type { ActorMesh } from '../src/services/runtime-actors';
import { skeletonFromFitPositions } from '../src/services/binding/retarget-session';
import { tposeWorldPositions } from '../src/services/binding/humanik-template';
const modules = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true, import: 'default' });
const auditScenes = import.meta.glob('../../../assets/scenes/sandbox/{shared-motion-runtime,body-ik-validation}.scene.json', { eager: true, import: 'default' });
function connectedFixture(doc: SceneDocument, sharedPlayer = false) {
  const actor: ActorMesh = { characterId: 'E-01', meshId: 'actor:E-01', vertices: new Float32Array(0), indices: new Uint32Array(0),
    joints: new Uint16Array(0), weights: new Float32Array(0), paletteBase: 0, restPose: 3, feetOffset: 0,
    palette: { jointCount: 1, data: new Float32Array(4 * 16), clipBasePose: [0, 1, 2], clips: ['idle', 'walk', 'attack'].map(name => ({ name, frameCount: 1, durationSec: 1 })) },
    clips: ['idle', 'walk', 'attack'].map((name, basePose) => ({ name, basePose, frameCount: 1, durationSec: 1 })) };
  const bridge = new RuntimeBridge({ get: id => id === 'E-01' ? actor : null });
  const renderer = { getDocument: () => doc, findObjectIndexByNodeId: () => null,
    snapshotAuthorState: () => ({ count: 0, objects: [], selectedIndex: null }), restoreAuthorState: () => ({ mismatched: false }),
    core: { releaseDynamicResources: () => {} } } as unknown as LabRenderer;
  const skeleton = skeletonFromFitPositions(tposeWorldPositions());
  const skin = createSkinState(skeleton, [{ name: 'native-idle', duration: 1, tracks: [] }]);
  const mesh = doc.nodes.find(n => n.id === doc.playerStart)!.components.find(c => c.kind === 'MeshRenderer');
  const object = { skeleton, animations: skin.clips, skinState: skin, removed: false, scale: 1,
    loadedAssetPath: mesh?.kind === 'MeshRenderer' && mesh.source.type === 'asset' ? mesh.source.ref.path : '' };
  const library = new SharedMotionRuntime(async () => '{}');
  if (sharedPlayer) {
    const names = ['idle', 'walk', 'run', 'shoot', 'reload', 'equip'];
    const result: ResolvedMotion = { key: 'loaded-player', clips: names.map(name => ({ name, duration: 1, tracks: [] })),
      states: Object.fromEntries(names.map(name => [name, { loop: ['idle', 'walk', 'run'].includes(name) }])), reports: [] };
    vi.spyOn(library, 'assetMeta').mockResolvedValue(null); vi.spyOn(library, 'resolve').mockResolvedValue(result);
  }
  const motions = new RuntimeSceneMotion(library, id => sharedPlayer && id === doc.playerStart ? object : null);
  const controller = new PlayController(renderer, bridge, sharedPlayer ? { sharedMotions: motions } : {}); expect(controller.start()).toBe(true);
  const ik = new RuntimeBodyIk(() => null, async () => null, () => null, () => null);
  bridge.setPlayerPresentation(doc.playerStart);
  const source = new RuntimeAnimationDebugSource({ runtime: () => controller.session.runtime, document: () => doc,
    skin: id => id === doc.playerStart ? object.skinState : null, actorDiagnostics: () => [] }, motions, bridge, ik);
  const collector = new AnimationDebugCollector(source);
  const npc = source.targets().find(t => t.kind === 'entity' && t.label.includes('E-01'))!; expect(npc).toBeDefined();
  return { controller, bridge, source, collector, npc, motions, object };
}
function fixture() {
  const play = new PlaySession(); expect(play.play(structuredClone(Object.values(modules)[0]) as SceneDocument).ok).toBe(true);
  const bridge = new RuntimeBridge(); bridge.attach(play.runtime);
  const motions = new RuntimeSceneMotion(new SharedMotionRuntime(async () => '{}'), () => null);
  const ik = new RuntimeBodyIk(() => null, async () => null, () => null, () => null);
  const skin = createSkinState(skeletonFromFitPositions(tposeWorldPositions()), [{ name: 'native-idle', duration: 1, tracks: [] }]);
  const doc = createEmptySceneDocument('debug'); doc.nodes.push({ id: 'authored-player', name: 'actor', visible: true,
    components: [{ kind: 'MeshRenderer', enabled: true, visible: true, source: { type: 'asset', ref: { path: 'actor.glb' } } }] } as SceneNode);
  const source = new RuntimeAnimationDebugSource({ runtime: () => play.runtime, document: () => doc,
    skin: id => id === 'authored-player' ? skin : null, actorDiagnostics: () => ['P-01: failed asset'] }, motions, bridge, ik);
  return { play, bridge, source, skin };
}
describe('animation debug runtime adapter', () => {
  it('explains the actually selected load default on first paused Player observation before an automatic tick', async () => {
    const f = connectedFixture(structuredClone(Object.values(auditScenes)[0]) as SceneDocument, true);
    await vi.waitFor(() => expect(f.motions.summary().pending).toBe(0)); f.controller.pause();
    const advance = vi.spyOn(f.controller.session, 'advance'), refresh = vi.spyOn(f.bridge, 'refresh'), sync = vi.spyOn(f.motions, 'sync');
    const before = { tick: f.controller.tick, clip: f.object.skinState.clip, time: f.object.skinState.time };
    f.collector.setOpen(true); const snapshot = f.collector.update(0)!.snapshot!;
    expect(snapshot.decision).toMatchObject({ source: 'configured-default', actual: 'idle', rules: [
      { id: 'configured-default', matched: true, selected: true },
    ] }); expect(snapshot.clip!.name).toBe(snapshot.decision.actual);
    expect({ tick: f.controller.tick, clip: f.object.skinState.clip, time: f.object.skinState.time }).toEqual(before);
    expect(advance).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); f.collector.dispose();
  });
  for (const action of ['walk', 'shoot']) {
    it(`retains actual Player inputs and rules while observing NPC, then reads ${action} immediately after Pause`, async () => {
      const f = connectedFixture(structuredClone(Object.values(auditScenes)[0]) as SceneDocument, true);
      await vi.waitFor(() => expect(f.motions.summary().pending).toBe(0)); f.controller.update(1 / 30);
      f.collector.setOpen(true); const initial = f.collector.update(0)!; const player = initial.target!;
      expect(initial.snapshot!.decision.actual).toBe('idle'); f.controller.update(1 / 30);
      f.collector.select(f.npc); f.collector.update(1);
      f.controller.session.setInput(.1, 0); f.controller.update(1 / 30);
      if (action === 'shoot') { f.controller.session.setFire(true); f.controller.update(1 / 30); }
      const currentClip = f.object.skinState.clips[f.object.skinState.clip]!.name; expect(currentClip).toBe(action);
      f.controller.pause();
      const advance = vi.spyOn(f.controller.session, 'advance'), step = vi.spyOn(f.controller.session.runtime!, 'step');
      const refresh = vi.spyOn(f.bridge, 'refresh'), sync = vi.spyOn(f.motions, 'sync');
      const before = { tick: f.controller.tick, clip: f.object.skinState.clip, time: f.object.skinState.time, transition: structuredClone(f.object.skinState.transition) };
      f.collector.select(player); const view = f.collector.update(2)!, snapshot = view.snapshot!;
      expect(snapshot.decision.actual).toBe(currentClip); expect(snapshot.clip!.name).toBe(currentClip); expect(view.history).toHaveLength(1);
      expect(snapshot.decision.rules.find(r => r.id === 'walk')).toMatchObject({ matched: true, selected: action === 'walk' });
      expect(snapshot.decision.rules.find(r => r.id === 'weapon')).toMatchObject({ matched: action === 'shoot', selected: action === 'shoot' });
      expect(snapshot.decision.rules.find(r => r.id === 'legacy-fire')!.matched).toBe(action === 'shoot');
      if (action === 'shoot') { expect(snapshot.decision.source).toBe('weapon'); expect(snapshot.decision.actionStamp).toContain(':fire:'); }
      expect({ tick: f.controller.tick, clip: f.object.skinState.clip, time: f.object.skinState.time, transition: f.object.skinState.transition }).toEqual(before);
      expect(advance).not.toHaveBeenCalled(); expect(step).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
      f.collector.setOpen(false); const read = vi.spyOn(f.source, 'read'), debugRead = vi.spyOn(f.motions, 'debugSnapshot');
      f.controller.resume(); f.controller.session.setFire(false); f.controller.session.setInput(0, 0); f.controller.update(1 / 30);
      expect(f.collector.update(127)).toBeNull(); expect(read).not.toHaveBeenCalled(); expect(debugRead).not.toHaveBeenCalled();
      f.controller.pause(); f.collector.setOpen(true); expect(f.collector.update(128)!.snapshot!.decision.actual).toBe(f.object.skinState.clips[f.object.skinState.clip]!.name);
      const oldRun = snapshot.identity.runId; f.controller.reset(); const rerun = f.collector.update(253)!;
      expect(rerun.snapshot!.identity.runId).not.toBe(oldRun); expect(rerun.history).toHaveLength(1); expect(rerun.snapshot!.decision.actual).toBe('idle'); f.collector.dispose();
    });
  }
  it('reads automatic Player rules when first opened while paused after unobserved movement', async () => {
    const f = connectedFixture(structuredClone(Object.values(auditScenes)[0]) as SceneDocument, true);
    await vi.waitFor(() => expect(f.motions.summary().pending).toBe(0)); f.controller.update(1 / 30);
    f.controller.session.setInput(.1, 0); f.controller.update(1 / 30); f.controller.pause();
    const sync = vi.spyOn(f.motions, 'sync'), advance = vi.spyOn(f.controller.session, 'advance'), refresh = vi.spyOn(f.bridge, 'refresh');
    f.collector.setOpen(true); const snapshot = f.collector.update(0)!.snapshot!;
    expect(snapshot.decision.actual).toBe('walk'); expect(snapshot.clip!.name).toBe('walk');
    expect(snapshot.decision.rules.find(r => r.id === 'walk')).toMatchObject({ matched: true, selected: true });
    expect(sync).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); f.collector.dispose();
  });
  it('follows a natural Playing presentation update after subscribing through the actual adapter', () => {
    const f = connectedFixture(structuredClone(Object.values(auditScenes)[0]) as SceneDocument);
    f.collector.setOpen(true); f.collector.update(0); f.collector.select(f.npc);
    f.controller.update(1 / 30);
    expect(f.collector.update(125)!.snapshot).toMatchObject({ pipeline: 'gpu-palette', tick: f.controller.tick });
    f.controller.update(1 / 30); expect(f.collector.update(250)!.snapshot!.tick).toBe(f.controller.tick); f.collector.dispose();
  });
  for (const [path, doc] of Object.entries(auditScenes)) {
    for (const paused of [false, true]) {
      it(`reads already-presented NPC immediately through the source/collector while ${paused ? 'Paused' : 'Playing'}: ${path}`, () => {
        const f = connectedFixture(structuredClone(doc) as SceneDocument);
        if (paused) f.controller.pause();
        const refresh = vi.spyOn(f.bridge, 'refresh'), notify = vi.spyOn(f.bridge, 'notifyActorsChanged');
        const advance = vi.spyOn(f.controller.session, 'advance'), step = vi.spyOn(f.controller.session.runtime!, 'step');
        const sample = vi.spyOn(PalettePoseTransitions.prototype, 'sample');
        const tick = f.controller.tick, batches = f.bridge.batches()!.map(b => [...b.instances]);
        f.collector.setOpen(true); f.collector.update(0); f.collector.select(f.npc);
        const initial = f.collector.update(1)!;
        expect(initial.snapshot).toMatchObject({ identity: { kind: 'entity', id: f.npc.kind === 'entity' ? f.npc.id : -1 }, pipeline: 'gpu-palette' });
        expect(initial.snapshot!.clip).not.toBeNull(); expect(initial.history).toHaveLength(1);
        expect(f.controller.tick).toBe(tick); expect(f.bridge.batches()!.map(b => [...b.instances])).toEqual(batches);
        expect(refresh).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(step).not.toHaveBeenCalled();
        expect(sample).not.toHaveBeenCalled(); sample.mockRestore();
        if (!paused) { f.controller.update(1 / 30); expect(f.collector.update(126)!.snapshot!.tick).toBe(f.controller.tick); }
        else expect(f.collector.update(126)!.snapshot!.tick).toBe(tick);
        f.collector.dispose();
      });
    }
  }
  it('guards rerun identity and captures nothing while closed through the connected adapter', () => {
    const f = connectedFixture(structuredClone(Object.values(auditScenes)[0]) as SceneDocument);
    f.collector.setOpen(true); f.collector.update(0); f.collector.select(f.npc);
    const old = f.collector.update(1)!.snapshot!; f.collector.setFrozen(true);
    f.controller.reset(); const rerun = f.collector.update(126)!;
    expect(rerun.frozen).toBe(false); expect(rerun.snapshot!.identity.runId).not.toBe(old.identity.runId);
    expect(f.source.read(f.npc)).toBeNull();
    const npc = f.source.targets().find(t => t.kind === 'entity' && t.label.includes('E-01'))!;
    f.collector.select(npc); expect(f.collector.update(127)!.snapshot).toMatchObject({ pipeline: 'gpu-palette' });
    expect(f.collector.inspect()!.history).toHaveLength(1);
    f.collector.setOpen(false);
    const read = vi.spyOn(f.source, 'read'), targets = vi.spyOn(f.source, 'targets');
    f.controller.update(1 / 30); expect(f.collector.update(253)).toBeNull();
    expect(read).not.toHaveBeenCalled(); expect(targets).not.toHaveBeenCalled(); expect(f.bridge.debugSnapshot()).toBeNull();
  });
  it('keeps load-failure status identical in execution events and low-frequency reads', () => {
    const f = fixture(), collector = new AnimationDebugCollector(f.source); collector.setOpen(true); collector.update(0);
    f.bridge.refresh(); expect(collector.update(125)!.snapshot!.status).toBe('failed');
    for (let i = 1; i < 5; i++) { f.bridge.refresh(); expect(collector.update(125 + i * 125)!.history).toHaveLength(1); }
    collector.dispose();
  });
  it('uses the actual authored-player presentation and reads native sampler without controlling it', () => {
    const f = fixture(); f.bridge.setPlayerPresentation('authored-player');
    const target = f.source.defaultTarget()!; expect(target).toMatchObject({ kind: 'scene', nodeId: 'authored-player' });
    const stateBefore = { clip: f.skin.clip, playing: f.skin.playing, time: f.skin.time };
    const snapshot = f.source.read(target)!; expect(snapshot.decision.source).toBe('native-sampler');
    expect(snapshot.ik.status).toBe('unconfigured'); snapshot.clip!.name = 'corrupt';
    expect(f.source.read(target)!.clip!.name).toBe('native-idle');
    expect({ clip: f.skin.clip, playing: f.skin.playing, time: f.skin.time }).toEqual(stateBefore);
    expect(f.source.targets().filter(t => t.kind === 'entity' && t.id === f.play.runtime!.player()!.id)).toEqual([]);
  });
  it('exposes current actor-load failure on a proxy and rejects stale run identities after reset', () => {
    const f = fixture(), target = f.source.defaultTarget()!; expect(target.kind).toBe('entity');
    f.source.watch(target, () => {}); f.bridge.refresh();
    expect(f.source.read(target)).toMatchObject({ pipeline: 'proxy', status: 'failed', diagnostics: expect.arrayContaining(['P-01: failed asset']) });
    expect(f.bridge.selectedEntity).toBeNull(); f.play.runtime!.reset(); expect(f.source.read(target)).toBeNull();
    f.source.watch(null, null); expect(f.bridge.debugSnapshot()).toBeNull(); f.play.stop(); expect(f.source.context()).toMatchObject({ active: false, runId: null });
  });
});
