import { describe, expect, it } from 'vitest';
import { createDefaultAssetMeta, type SharedMotionBinding, type SharedMotionLibrary } from '@aether/scene';
import { SharedMotionRuntime } from '../src/services/shared-motion-runtime';
import { skeletonFromFitPositions } from '../src/services/binding/retarget-session';
import { tposeWorldPositions } from '../src/services/binding/humanik-template';
import { buildBvhText } from './motion-retarget/fixture';

const binding: SharedMotionBinding = { library: { path: 'assets/motion/library.json', guid: 'as_motion_library' }, profile: 'npc', defaultState: 'walk', speed: 1 };
const library: SharedMotionLibrary = { schemaVersion: 1, id: 'as_motion_library', clips: {
  walk: { source: { path: 'assets/motion/walk.bvh', guid: 'as_motion_walk' }, loop: true, rootPolicy: 'in-place' },
}, profiles: { npc: { walk: 'walk' } } };
function fixture() {
  const files = new Map([
    ['assets/motion/library.json', JSON.stringify(library)],
    ['assets/motion/walk.bvh', buildBvhText({ unit: 'm', frames: 6, rootPos: f => [8 * f, 100, 0], rot: (f, bone) => [bone === 'LeftArm' ? f * 5 : 0, 0, 0] })],
    ['assets/motion/walk.bvh.meta.json', JSON.stringify(createDefaultAssetMeta('as_motion_walk', 'bvh'))],
  ]);
  const runtime = new SharedMotionRuntime(async p => { const text = files.get(p); if (text === undefined) throw new Error(`missing ${p}`); return text; });
  return { runtime, files };
}
describe('shared motions at runtime', () => {
  it('reuses solved clips across playback speed/default changes, including concurrent consumers', async () => {
    const { runtime, files } = fixture(), sk = skeletonFromFitPositions(tposeWorldPositions());
    const lib = structuredClone(library); lib.profiles.npc!.idle = 'walk';
    files.set(binding.library.path, JSON.stringify(lib));
    const [a, b] = await Promise.all([runtime.resolve(sk, binding), runtime.resolve(sk, { ...binding, speed: 2, defaultState: 'idle' })]);
    expect(a).toBe(b); expect(runtime.stats.solves).toBe(2); expect(runtime.stats.cacheHits).toBe(1);
  });
  it('keeps different limb lengths intact and scales nominal gait speed by pelvis height', async () => {
    const { runtime, files } = fixture(), sk = skeletonFromFitPositions(tposeWorldPositions());
    const lib = structuredClone(library); lib.clips.walk!.nominalSpeedMps = 2;
    files.set(binding.library.path, JSON.stringify(lib));
    const b = structuredClone(sk);
    for (const name of ['LeftForeArm', 'RightForeArm']) {
      const i = b.joints[b.jointNames.indexOf(name)]!;
      b.locals[i]!.t = b.locals[i]!.t.map(v => v * 1.6) as [number, number, number];
    }
    const before = structuredClone(b.locals);
    const aResult = await runtime.resolve(sk, binding), bResult = await runtime.resolve(b, binding);
    expect(aResult.key).not.toBe(bResult.key); expect(b.locals).toEqual(before);
    // Only the root translates. Limb offsets continue to come from this target's rest pose.
    const translated = bResult.clips[0]!.tracks.filter(t => t.path === 'translation').map(t => t.node);
    expect(translated).toEqual([b.joints[b.jointNames.indexOf('Hips')]]);
    expect(bResult.states.walk!.nominalSpeedMps).toBeCloseTo(aResult.states.walk!.nominalSpeedMps!, 6);
    for (const t of bResult.clips[0]!.tracks) expect(Array.from(t.values).every(Number.isFinite)).toBe(true);
  });
  it('shares a source but solves distinct target proportions, preserving target translations', async () => {
    const { runtime } = fixture();
    const a = skeletonFromFitPositions(tposeWorldPositions());
    const b = structuredClone(a);
    for (const loc of b.locals) for (let axis = 0; axis < 3; axis++) loc.t[axis] = loc.t[axis]! * 1.4;
    const [ra, rb] = await Promise.all([runtime.resolve(a, binding), runtime.resolve(b, binding)]);
    expect(ra.key).not.toBe(rb.key);
    const root = (r: typeof ra) => r.clips[0]!.tracks.find(t => t.path === 'translation')!;
    expect(root(rb).values[1]! / root(ra).values[1]!).toBeCloseTo(1.4, 4);
    // in-place policy is independent from source root motion detection
    for (const r of [ra, rb]) expect(new Set(Array.from(root(r).values).filter((_, i) => i % 3 === 0)).size).toBe(1);
    expect(runtime.stats.solves).toBe(2);
    expect((await runtime.resolve(a, binding))).toBe(ra);
    expect(runtime.stats.solves).toBe(2);
  });
  it('invalidates on authoritative source edits and rig edits; failed work never poisons cache', async () => {
    const { runtime, files } = fixture(), sk = skeletonFromFitPositions(tposeWorldPositions());
    const first = await runtime.resolve(sk, binding);
    files.set('assets/motion/walk.bvh', buildBvhText({ unit: 'm', frames: 8 })); runtime.beginLoad();
    const second = await runtime.resolve(sk, binding);
    expect(second.key).not.toBe(first.key);
    const bad = structuredClone(sk); bad.locals[0]!.s = [1, 2, 1];
    await expect(runtime.resolve(bad, binding)).rejects.toThrow('MOTION_TARGET');
    expect(await runtime.resolve(sk, binding)).toBe(second);
  });
  it('rejects missing profile, source identity mismatch, and future library versions', async () => {
    const { runtime, files } = fixture(), sk = skeletonFromFitPositions(tposeWorldPositions());
    await expect(runtime.resolve(sk, { ...binding, profile: 'missing' })).rejects.toThrow('MOTION_PROFILE');
    files.set('assets/motion/walk.bvh.meta.json', JSON.stringify(createDefaultAssetMeta('as_other', 'bvh'))); runtime.beginLoad();
    await expect(runtime.resolve(sk, binding)).rejects.toThrow('MOTION_IDENTITY');
    files.set(binding.library.path, JSON.stringify({ ...library, schemaVersion: 999 })); runtime.beginLoad();
    await expect(runtime.resolve(sk, binding)).rejects.toThrow('MOTION_LIBRARY');
  });
});
