import { describe, expect, it, vi } from 'vitest';
import { createEmptySceneDocument, type SceneNode, type SharedMotionBinding } from '@aether/scene';
import type { RuntimeSession } from '@aether/runtime';
import { createBodyIkState, createSkinState } from '@aether/render';
import { newBodyIkControl } from '@aether/scene';
import { RuntimeSceneMotion } from '../src/services/runtime-scene-motion';
import { SharedMotionRuntime, type ResolvedMotion } from '../src/services/shared-motion-runtime';
import { skeletonFromFitPositions } from '../src/services/binding/retarget-session';
import { tposeWorldPositions } from '../src/services/binding/humanik-template';

const binding: SharedMotionBinding = { library: { path: 'assets/motion.json', guid: 'as_motion' }, profile: 'player', defaultState: 'idle', speed: 1 };
function fixture() {
  const sk = skeletonFromFitPositions(tposeWorldPositions());
  const oldClips = [{ name: 'author', duration: 2, tracks: [] }];
  const object = { skeleton: sk, animations: oldClips, skinState: createSkinState(sk, oldClips), loadedAssetPath: 'assets/target.glb', removed: false, scale: 1 };
  object.skinState.time = .25;
  const result: ResolvedMotion = { key: 'target-specific', clips: ['idle', 'walk', 'run'].map(name => ({ name, duration: 1, tracks: [] })),
    states: { idle: { loop: true }, walk: { loop: true }, run: { loop: true } }, reports: [] };
  const library = new SharedMotionRuntime(async () => '{}');
  const resolve = vi.spyOn(library, 'resolve').mockResolvedValue(result);
  const motion = new RuntimeSceneMotion(library, () => object);
  const doc = createEmptySceneDocument('shared-motion-test');
  doc.playerStart = 'player';
  doc.nodes.push({ id: 'player', name: 'player', visible: true, components: [{ kind: 'MeshRenderer', enabled: true, visible: true,
    source: { type: 'asset', ref: { path: 'assets/target.glb' } }, playBinding: 'player', sharedMotion: binding }] } as SceneNode);
  const rt = (tick: number, x: number, runId = 1) => ({ tick, fixedStep: 1 / 30, player: () => ({ x, z: 0, runId }) }) as unknown as RuntimeSession;
  return { doc, object, motion, resolve, result, rt, oldClips };
}
describe('Play-owned shared scene motion', () => {
  it('advances transitions only on fixed ticks, clears them on rerun and restores author state on Stop', async () => {
    const f = fixture(), original = f.object.skinState; f.result.transitionSec = .2;
    f.motion.start(f.doc); await vi.waitFor(() => expect(f.motion.summary().pending).toBe(0));
    f.motion.sync(f.rt(0,0)); f.motion.setState('player','walk');
    expect(f.object.skinState.transition!.elapsed).toBe(0);
    f.motion.sync(f.rt(3,0)); expect(f.object.skinState.transition!.elapsed).toBeCloseTo(.1);
    f.motion.sync(f.rt(3,0)); expect(f.object.skinState.transition!.elapsed).toBeCloseTo(.1);
    f.motion.setState('player','run'); expect(f.object.skinState.transition!.elapsed).toBe(0);
    f.motion.sync(f.rt(6,0)); f.motion.sync(f.rt(9,0)); expect(f.object.skinState.transition).toBeUndefined();
    f.motion.setState('player','walk'); f.motion.sync(f.rt(0,0,2)); expect(f.object.skinState.transition).toBeUndefined();
    f.motion.setState('player','walk'); f.motion.stop(); expect(f.object.skinState).toBe(original); expect(original.transition).toBeUndefined();
  });
  it('keeps gait while procedural aim is active and returns to shoot when IK weight is zero', async () => {
    const f = fixture(); f.result.states.shoot = { loop: false }; f.result.clips.push({ name: 'shoot', duration: .5, tracks: [] });
    f.motion.start(f.doc); await vi.waitFor(() => expect(f.motion.summary().pending).toBe(0));
    const c = newBodyIkControl('upperBody'); c.target = { kind: 'position', position: [0, 1.5, 2] };
    f.object.skinState.bodyIk = createBodyIkState(f.object.skeleton, { enabled: true, weight: 1, locomotionWhileAiming: true, controls: [c] });
    f.motion.sync(f.rt(0, 0)); f.motion.sync({ ...f.rt(1, .2), firing: true } as RuntimeSession);
    expect(f.motion.summary().nodes[0]!.state).toBe('run');
    f.object.skinState.bodyIk.binding.weight = 0; f.motion.sync({ ...f.rt(2, .4), firing: true } as RuntimeSession);
    expect(f.motion.summary().nodes[0]!.state).toBe('shoot'); f.motion.stop();
  });
  it('restores configured default state for display characters on rerun', async () => {
    const f = fixture(); f.doc.playerStart = null;
    f.motion.start(f.doc); await vi.waitFor(() => expect(f.motion.summary().pending).toBe(0));
    f.motion.sync(f.rt(0, 0)); f.motion.setState('player', 'run'); f.motion.sync(f.rt(10, 0));
    expect(f.motion.summary().nodes[0]!.state).toBe('run');
    f.motion.sync(f.rt(0, 0, 2)); expect(f.motion.summary().nodes[0]!.state).toBe('idle'); expect(f.object.skinState.time).toBe(0);
  });
  it('matches gait distance, handles repeated render frames, and replays manual actions', async () => {
    const f = fixture(); f.result.states.run!.nominalSpeedMps = 5;
    f.result.states.shoot = { loop: false }; f.result.clips.push({ name: 'shoot', duration: .5, tracks: [] });
    f.motion.start(f.doc); await vi.waitFor(() => expect(f.motion.summary().pending).toBe(0));
    f.motion.sync(f.rt(0, 0)); f.motion.sync(f.rt(1, .2)); f.motion.sync(f.rt(2, .4));
    expect(f.object.skinState.time).toBeCloseTo(.04, 6); // .2 m / 5 m/s
    f.motion.sync(f.rt(2, .4)); expect(f.object.skinState.time).toBeCloseTo(.04, 6);
    const firing = { ...f.rt(3, .4), firing: true } as RuntimeSession;
    f.motion.sync(firing); expect(f.motion.summary().nodes[0]!.state).toBe('shoot');
    f.motion.setState('player', 'run'); f.motion.sync(f.rt(4, .4)); expect(f.object.skinState.time).toBeCloseTo(1 / 30, 6);
    f.motion.setState('player', 'run'); f.motion.sync(f.rt(4, .4)); expect(f.object.skinState.time).toBe(0);
    f.motion.sync(f.rt(5, .4, 2)); expect(f.motion.summary().nodes[0]!.state).toBe('idle'); expect(f.object.skinState.time).toBe(0);
  });
  it('drives player locomotion by fixed ticks and restores exact author animation state on Stop', async () => {
    const f = fixture(), oldSkin = f.object.skinState;
    f.motion.start(f.doc);
    await vi.waitFor(() => expect(f.motion.summary().pending).toBe(0));
    expect(f.object.animations).toBe(f.result.clips);
    f.motion.sync(f.rt(0, 0)); f.motion.sync(f.rt(1, .03));
    expect(f.motion.summary().nodes[0]!.state).toBe('walk');
    f.motion.sync(f.rt(2, .2)); expect(f.motion.summary().nodes[0]!.state).toBe('run');
    f.motion.sync(f.rt(2, .2)); expect(f.motion.summary().nodes[0]!.state).toBe('run'); // render frame without a simulation step
    f.motion.sync(f.rt(3, .2)); expect(f.motion.summary().nodes[0]!.state).toBe('idle');
    expect(f.object.skinState.playing).toBe(false); // renderer must not advance a second clock
    f.motion.stop();
    expect(f.object.animations).toBe(f.oldClips); expect(f.object.skinState).toBe(oldSkin);
    expect(oldSkin.time).toBe(.25);
  });
  it('rejects late completion across Stop and supports explicit per-node disable', async () => {
    const f = fixture(); let complete!: (r: ResolvedMotion) => void;
    f.resolve.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    f.motion.start(f.doc); await vi.waitFor(() => expect(f.resolve).toHaveBeenCalled());
    f.motion.stop(); complete(f.result); await Promise.resolve(); await Promise.resolve();
    expect(f.motion.summary().nodes).toEqual([]); expect(f.object.animations).toBe(f.oldClips);
    const mesh = f.doc.nodes.at(-1)!.components[0]!;
    if (mesh.kind === 'MeshRenderer') mesh.sharedMotion = null;
    f.resolve.mockClear(); f.motion.start(f.doc);
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.motion.summary().pending).toBe(0);
  });
});
