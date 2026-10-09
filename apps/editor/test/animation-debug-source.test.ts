import { describe, expect, it } from 'vitest';
import { PlaySession } from '@aether/runtime';
import { createSkinState } from '@aether/render';
import { createEmptySceneDocument, type SceneDocument, type SceneNode } from '@aether/scene';
import { RuntimeBridge } from '../src/services/runtime-bridge';
import { RuntimeSceneMotion } from '../src/services/runtime-scene-motion';
import { RuntimeBodyIk } from '../src/services/runtime-body-ik';
import { SharedMotionRuntime } from '../src/services/shared-motion-runtime';
import { RuntimeAnimationDebugSource } from '../src/services/animation-debug/runtime-source';
import { AnimationDebugCollector } from '../src/services/animation-debug/collector';
import { skeletonFromFitPositions } from '../src/services/binding/retarget-session';
import { tposeWorldPositions } from '../src/services/binding/humanik-template';
const modules = import.meta.glob('../../../assets/scenes/act1/floor-1.scene.json', { eager: true, import: 'default' });
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
