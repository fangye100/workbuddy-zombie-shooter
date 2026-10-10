import { describe, expect, it, vi } from 'vitest';
import { createEmptySceneDocument, type SceneNode, type SharedMotionBinding } from '@aether/scene';
import type { RuntimeSession } from '@aether/zombie-game';
import { createBodyIkState, createSkinState, sampleAnimationPose } from '@aether/render';
import { newBodyIkControl } from '@aether/scene';
import { RuntimeSceneMotion } from '../src/services/runtime-scene-motion';
import { SharedMotionRuntime, type ResolvedMotion } from '../src/services/shared-motion-runtime';
import { skeletonFromFitPositions } from '../src/services/binding/retarget-session';
import { tposeWorldPositions } from '../src/services/binding/humanik-template';
import type { AnimationSnapshot } from '../src/services/animation-debug/contracts';

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
  it('保留同一固定 tick 的四向步态，停止位移和重新开始时清空方向', async () => {
    const f = fixture();
    for (const name of ['walk_f','walk_b','walk_l','walk_r']) {
      f.result.states[name] = { loop: true };
      f.result.clips.push({ name, duration: 1, tracks: [] });
    }
    const rt = (tick: number, x: number, z: number, runId = 1) => ({ ...f.rt(tick,x,runId), player: () => ({x,z,yaw:0,runId}) }) as unknown as RuntimeSession;
    f.motion.start(f.doc); await vi.waitFor(() => expect(f.motion.summary().pending).toBe(0));
    f.motion.sync(rt(0,0,0)); f.motion.sync(rt(1,0,.1)); f.motion.sync(rt(2,0,.2));
    const before = f.motion.debugSnapshot('player')!;
    expect(before.decision.actual).toBe('walk_r');
    f.motion.sync(rt(2,0,.2));
    expect(f.motion.debugSnapshot('player')!.revision).toBe(before.revision);
    expect(f.motion.debugSnapshot('player')!.clip!.time).toBe(before.clip!.time);
    expect(f.motion.summary().nodes[0]!.state).toBe('walk_r');
    f.motion.sync(rt(3,0,.2)); expect(f.motion.summary().nodes[0]!.state).toBe('idle');
    f.motion.sync(rt(4,-.1,.2)); expect(f.motion.summary().nodes[0]!.state).toBe('walk_b');
    f.motion.sync(rt(0,0,0,2)); expect(f.motion.summary().nodes[0]!.state).toBe('idle');
    f.motion.stop();
  });
  it('captures an automatic short transition even when it completes before the next view refresh', async () => {
    const f = fixture(); f.result.transitionSec = .02;
    f.motion.start(f.doc); await vi.waitFor(() => expect(f.motion.summary().pending).toBe(0)); f.motion.sync(f.rt(0, 0));
    const snapshots: AnimationSnapshot[] = []; f.motion.watchDebug('player', s => { if (s) snapshots.push(s); });
    f.motion.sync(f.rt(3, 1));
    expect(snapshots.some(s => s.transition?.duration === .02 && s.transition.weight === 0)).toBe(true);
    f.motion.sync(f.rt(6, 2));
    expect(snapshots.at(-1)!.transition).toBeNull();
    expect(snapshots.at(-1)!.decision.actual).toBe('run');
  });
  it('observes only the selected node, detaches snapshots, captures same-clip replay, and cannot interrupt animation', async () => {
    const f = fixture(); f.motion.start(f.doc); await vi.waitFor(() => expect(f.motion.summary().pending).toBe(0));
    const sink = vi.fn(); f.motion.watchDebug('other-node', sink); f.motion.sync(f.rt(0, 0)); expect(sink).not.toHaveBeenCalled();
    f.motion.watchDebug('player', sink); f.motion.sync(f.rt(1, .2));
    const snapshot = f.motion.debugSnapshot('player')!; expect(snapshot.decision.actual).toBe('run');
    snapshot.decision.rules.length = 0; snapshot.clip!.name = 'corrupt';
    expect(f.motion.debugSnapshot('player')!.clip!.name).toBe('run');
    const revision = snapshot.revision; f.motion.setState('player', 'run');
    expect(f.motion.debugSnapshot('player')!.revision).toBe(revision + 1);
    expect(f.motion.debugSnapshot('player')!.decision.source).toBe('manual');
    f.motion.watchDebug('player', () => { throw new Error('broken consumer'); });
    expect(() => f.motion.sync(f.rt(2, .4))).not.toThrow();
    f.motion.watchDebug(null, null); sink.mockClear(); f.motion.sync(f.rt(3, .6)); expect(sink).not.toHaveBeenCalled();
  });
  it('keeps locomotion under IK for accepted weapon fire, without applying weapon phase to the gait clip', async () => {
    const f=fixture(); f.result.states.shoot={loop:false}; f.result.clips.push({name:'shoot',duration:.5,tracks:[]});
    f.motion.start(f.doc); await vi.waitFor(()=>expect(f.motion.summary().pending).toBe(0));
    const c=newBodyIkControl('upperBody');c.target={kind:'position',position:[0,1.5,2]};
    f.object.skinState.bodyIk=createBodyIkState(f.object.skeleton,{enabled:true,weight:1,locomotionWhileAiming:true,controls:[c]});
    f.motion.sync(f.rt(0,0));
    const rt=(tick:number,x:number)=>({...f.rt(tick,x),firing:true,weapons:{animation:{action:'fire',phase:.8,startTick:tick,weaponId:'pistol',clip:'pistol-fire',fallback:'run'}}}) as unknown as RuntimeSession;
    f.motion.sync(rt(1,.2)); expect(f.motion.summary().nodes[0]!.state).toBe('run');
    expect(f.object.skinState.time).not.toBeCloseTo(.8*f.object.skinState.clips[f.object.skinState.clip]!.duration);
    f.object.skinState.bodyIk.binding.weight=0;f.motion.sync(rt(2,.4));
    expect(f.motion.summary().nodes[0]!.state).toBe('shoot');f.motion.stop();
  });
  it('uses successful weapon action phase and retriggers the same clip; held input alone cannot animate a shot',async()=>{
    const f=fixture();f.result.states.shoot={loop:false};f.result.clips.push({name:'shoot',duration:.5,tracks:[]});
    f.motion.start(f.doc);await vi.waitFor(()=>expect(f.motion.summary().pending).toBe(0));
    f.motion.sync(f.rt(0,0));
    const rt=(tick:number,action:string,phase:number,startTick:number)=>({...f.rt(tick,0),firing:true,weapons:{animation:{action,phase,startTick,weaponId:'pistol',clip:'pistol-fire',fallback:'attack'}}}) as unknown as RuntimeSession;
    f.motion.sync(rt(1,'idle',0,0));expect(f.motion.summary().nodes[0]!.state).toBe('idle');
    f.motion.sync(rt(2,'fire',.5,2));expect(f.motion.summary().nodes[0]!.state).toBe('shoot');expect(f.object.skinState.time).toBe(.25);
    f.motion.sync(rt(5,'fire',0,5));expect(f.object.skinState.time).toBe(0);
    f.motion.sync(rt(5,'fire',0,5));expect(f.object.skinState.time).toBe(0);
    f.motion.stop();expect(f.object.animations).toBe(f.oldClips);
  });
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

describe('player base plus weapon region assembly',()=>{
  it('continues gait and freezes only upper weapon phase across fire/reload/missing equip and same ticks',async()=>{
    const f=fixture(),mesh=f.doc.nodes.at(-1)!.components[0]!;if(mesh.kind!=='MeshRenderer')throw new Error('fixture');
    mesh.sharedMotion={...binding,poseLayer:{roots:['Spine'],exclude:[],weight:1,transitionSec:.16}};
    for(const name of ['shoot','reload','ready']) { f.result.states[name]={loop:name==='ready'};f.result.clips.push({name,duration:2,tracks:[]}); }
    const leg=f.object.skeleton.joints[f.object.skeleton.jointNames.indexOf('LeftUpLeg')]!,spine=f.object.skeleton.joints[f.object.skeleton.jointNames.indexOf('Spine')]!;
    const track=(node:number,x:number)=>({node,path:'rotation' as const,stride:4,interpolation:'LINEAR' as const,times:new Float32Array([0,1]),values:new Float32Array([0,0,0,1,Math.sin(x/2),0,0,Math.cos(x/2)])});
    f.result.clips.find(c=>c.name==='run')!.tracks=[track(leg,.6),track(spine,.2)];
    f.result.clips.find(c=>c.name==='reload')!.tracks=[track(leg,2),track(spine,1)];
    const original=f.object.skinState;
    f.motion.start(f.doc);await vi.waitFor(()=>expect(f.motion.summary().pending).toBe(0));f.motion.sync(f.rt(0,0));
    const rt=(tick:number,action:'fire'|'reload'|'equip'|'unequip',phase:number)=>({...f.rt(tick,tick*.2),runId:1,weapons:{animation:{action,clip:`pistol-${action}`,fallback:'idle',phase,startTick:action==='fire'?tick:3,weaponId:'pistol'}}}) as unknown as RuntimeSession;
    f.motion.sync(rt(1,'fire',.8));const gait=f.object.skinState;expect(gait.clips[gait.clip]!.name).toBe('run');
    f.motion.sync(rt(2,'fire',.8));expect(gait.time).toBeCloseTo(1/30);expect(gait.poseLayer!.time).toBe(1.6);
    f.motion.sync(rt(3,'reload',.2));const time=gait.time;
    f.motion.sync(rt(4,'reload',.2));expect(gait.time).toBeGreaterThan(time);expect(gait.poseLayer!.time).toBe(.4);
    const pose=sampleAnimationPose(gait);const layer=gait.poseLayer!;delete gait.poseLayer;expect(sampleAnimationPose(gait)[leg]).toEqual(pose[leg]);gait.poseLayer=layer;
    const beforeDebug=JSON.stringify(gait);const snapshot=f.motion.debugSnapshot('player')!;
    expect(snapshot.layer!.clip!.name).toBe('reload');expect(snapshot.clip!.name).toBe('run');expect(snapshot.layer!.nodes).not.toContain(leg);
    snapshot.layer!.nodes.length=0;snapshot.layer!.roots[0]='corrupt';snapshot.layer!.clip!.time=99;
    expect(f.motion.debugSnapshot('player')!.layer!.roots).toEqual(['Spine']);expect(JSON.stringify(gait)).toBe(beforeDebug);
    f.motion.watchDebug('player',()=>{throw new Error('observer');});
    f.motion.sync(rt(4,'reload',.2));expect(gait.poseLayer!.time).toBe(.4);expect(sampleAnimationPose(gait)).toEqual(pose);
    f.motion.sync(rt(5,'unequip',.5));expect(gait.clips[gait.clip]!.name).toBe('run');expect(gait.clips[gait.poseLayer!.clip]!.name).toBe('ready');
    const before=gait.time;f.motion.sync(rt(6,'equip',.5));expect(gait.time).toBeGreaterThan(before);
    gait.poseLayer!.binding.weight=0;f.motion.sync(rt(7,'reload',.5));expect(gait.clips[gait.clip]!.name).toBe('run');
    f.motion.sync(f.rt(0,0,2));expect(gait.clips[gait.poseLayer!.clip]!.name).toBe('ready');expect(gait.poseLayer!.time).toBe(0);expect(gait.poseLayer!.transition?.elapsed).toBe(0);
    f.motion.stop();expect(f.object.skinState).toBe(original);expect(original.poseLayer).toBeUndefined();
  });
});
