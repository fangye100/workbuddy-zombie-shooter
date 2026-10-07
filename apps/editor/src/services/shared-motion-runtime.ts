/** Runtime host adapter: shared BVH -> existing RetargetSession -> target-local clips.
 * Solves once per source/rig/calibration/recipe identity. Never writes target GLBs.
 * IO is injectable; this service owns CPU caches, while renderer owns GPU resources.
 */
import {
  retargetFingerprint, RETARGET_ALGORITHM_VERSION, validateAssetMeta,
  validateSharedMotionBinding, validateSharedMotionLibrary,
  type AssetMeta, type AnimClip, type AnimTrack, type SkeletonData,
  type SharedMotionBinding, type SharedMotionLibrary, type SharedMotionClip,
} from '@aether/scene';
import { RetargetSession } from './binding/retarget-session';
import { parseBvh } from './binding/bvh-parser';
import { buildSourceMotion } from './binding/motion-retarget/source-motion';
import { buildTargetRig } from './binding/motion-retarget/rig-calibration';
import type { RetargetDiagnostic, RetargetMetrics } from './binding/motion-retarget/contracts';
import { fileUrl } from '../asset-util';

export interface ResolvedMotion {
  key: string;
  clips: AnimClip[];
  states: Record<string, { loop: boolean; nominalSpeedMps?: number }>;
  reports: { state: string; status: string; diagnostics: RetargetDiagnostic[]; metrics: RetargetMetrics | null }[];
}
export class SharedMotionError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}
const noWrites = {
  read: async () => ({ ok: false, json: null, error: 'Runtime uses supplied metadata' }),
  patch: async () => ({ ok: false, error: 'Runtime cannot write assets' }),
};
export class SharedMotionRuntime {
  private reads = new Map<string, Promise<string>>();
  private results = new Map<string, Promise<ResolvedMotion>>();
  readonly stats = { solves: 0, cacheHits: 0, failures: 0 };
  constructor(private readonly read: (path: string) => Promise<string> = async path => {
    const r = await fetch(fileUrl(path), { cache: 'no-store' });
    if (!r.ok) throw new SharedMotionError(r.status === 404 ? 'MOTION_NOT_FOUND' : 'MOTION_IO', `${path}: HTTP ${r.status}`);
    return r.text();
  }) {}
  /** Re-read authoritative resources for a new Play; content-keyed solved clips remain reusable. */
  beginLoad(): void { this.reads.clear(); }
  clear(): void { this.reads.clear(); this.results.clear(); }
  private text(path: string): Promise<string> {
    let p = this.reads.get(path);
    if (!p) { p = this.read(path); this.reads.set(path, p); p.catch(() => { if (this.reads.get(path) === p) this.reads.delete(path); }); }
    return p;
  }
  async assetMeta(path: string): Promise<AssetMeta | null> {
    // Legacy assets have no sidecar. A present but invalid configured binding must fail visibly.
    let text: string;
    try { text = await this.text(`${path}.meta.json`); } catch (error) {
      if (error instanceof SharedMotionError && error.code === 'MOTION_NOT_FOUND') return null;
      throw error;
    }
    const meta = JSON.parse(text) as AssetMeta;
    if (meta.sharedMotion) {
      const errors = validateAssetMeta(meta).filter(d => d.severity === 'error');
      if (errors.length) throw new SharedMotionError('MOTION_META', errors.map(d => d.message).join('; '));
    }
    return meta;
  }
  async resolve(sk: SkeletonData, binding: SharedMotionBinding, meta: AssetMeta | null = null): Promise<ResolvedMotion> {
    const bindingErrors = validateSharedMotionBinding(binding);
    if (bindingErrors.length) throw new SharedMotionError('MOTION_BINDING', bindingErrors.join('; '));
    const libText = await this.text(binding.library.path);
    const library = JSON.parse(libText) as SharedMotionLibrary;
    const errors = validateSharedMotionLibrary(library);
    if (errors.length) throw new SharedMotionError('MOTION_LIBRARY', errors.join('; '));
    if (library.id !== binding.library.guid) throw new SharedMotionError('MOTION_IDENTITY', 'Library guid does not match binding');
    const profile = library.profiles[binding.profile];
    if (!profile || !profile[binding.defaultState]) throw new SharedMotionError('MOTION_PROFILE', `${binding.profile}.${binding.defaultState} is missing`);
    const sources = await Promise.all(Object.entries(profile).map(async ([state, id]) => {
      const config = library.clips[id]!;
      const [text, sourceMetaText] = await Promise.all([this.text(config.source.path), this.text(`${config.source.path}.meta.json`)]);
      const sourceMeta = JSON.parse(sourceMetaText) as AssetMeta;
      if (sourceMeta.guid !== config.source.guid) throw new SharedMotionError('MOTION_IDENTITY', `${id}: source guid mismatch`);
      const errors = validateAssetMeta(sourceMeta).filter(d => d.severity === 'error');
      if (errors.length) throw new SharedMotionError('MOTION_SOURCE_META', errors.map(d => d.message).join('; '));
      return { state, config, text, sourceMeta };
    }));
    const key = retargetFingerprint({ algorithm: RETARGET_ALGORITHM_VERSION, libraryRef: binding.library, profile: binding.profile, library,
      source: sources.map(s => [s.state, s.text, s.sourceMeta.retarget ?? null]),
      target: { joints: sk.joints, names: sk.jointNames, parent: sk.parent, locals: sk.locals, roots: sk.roots,
        normalization: Array.from(sk.normalization), inverseBind: Array.from(sk.inverseBind) }, calibration: meta?.retarget?.calibration ?? null });
    const cached = this.results.get(key);
    if (cached) { this.stats.cacheHits++; return cached; }
    const result = this.generate(sk, key, sources, meta);
    this.results.set(key, result);
    result.catch(() => { if (this.results.get(key) === result) this.results.delete(key); this.stats.failures++; });
    return result;
  }
  private async generate(sk: SkeletonData, key: string, sources: {
    state: string; config: SharedMotionClip; text: string; sourceMeta: AssetMeta;
  }[], meta: AssetMeta | null): Promise<ResolvedMotion> {
    const clips: AnimClip[] = [], states: ResolvedMotion['states'] = {}, reports: ResolvedMotion['reports'] = [];
    for (const source of sources) {
      // Yield between clips, allowing the editor to render loading state and Stop to take effect.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const session = new RetargetSession(noWrites);
      const load = session.loadSourceBvh(source.text, source.state, { unitScale: 1, forceUpAxis: 1 });
      if (!load.ok) throw new SharedMotionError('MOTION_SOURCE', load.diagnostics.map(d => d.message).join('; '));
      if (source.sourceMeta.retarget?.calibration) {
        const cal = session.setSourceCalibration(source.sourceMeta.retarget.calibration);
        if (!cal.ok) throw new SharedMotionError('MOTION_SOURCE_CALIBRATION', cal.diagnostics.map(d => d.message).join('; '));
      }
      const target = session.setTarget({ skeleton: sk, name: 'runtime-target', assetKey: key });
      if (!target.ok) throw new SharedMotionError('MOTION_TARGET', target.diagnostics.map(d => d.message).join('; '));
      if (meta?.retarget?.calibration) {
        const cal = session.setTargetCalibration(meta.retarget.calibration);
        if (!cal.ok) throw new SharedMotionError('MOTION_TARGET_CALIBRATION', cal.diagnostics.map(d => d.message).join('; '));
      }
      session.updateRecipeSettings({ spaceMode: 'normalize-gait' });
      const outcome = session.solve(); this.stats.solves++;
      if (outcome.status === 'failed') throw new SharedMotionError('MOTION_SOLVE', outcome.diagnostics.map(d => `${d.code}: ${d.message}`).join('; '));
      const baked = session.bake();
      if (!baked.ok) throw new SharedMotionError('MOTION_BAKE', baked.message);
      // Local tracks already identify the real target nodes, including intermediate hierarchy.
      const tracks: AnimTrack[] = [];
      for (const t of baked.tracks) {
        const node = t.nodeIndex;
        const times = Float32Array.from(t.times);
        tracks.push({ node, path: 'rotation', times, values: Float32Array.from(t.rotations), stride: 4, interpolation: 'LINEAR' });
        if (t.translations) {
          const values = Float32Array.from(t.translations);
          if (source.config.rootPolicy === 'in-place' && t.bone === 'Hips') {
            // Retain vertical body motion; horizontal navigation remains owned by gameplay.
            for (let f = 0; f < times.length; f++) { values[f * 3] = values[0]!; values[f * 3 + 2] = values[2]!; }
          }
          tracks.push({ node, path: 'translation', times, values, stride: 3, interpolation: 'LINEAR' });
        }
      }
      if (!tracks.length) throw new SharedMotionError('MOTION_NO_TRACKS', source.state);
      let duration = tracks[0]!.times.at(-1) ?? 0;
      if (source.config.poseAtS !== undefined) {
        if (source.config.poseAtS > duration) throw new SharedMotionError('MOTION_POSE_RANGE', source.state);
        for (const track of tracks) {
          let f = 0;
          while (f + 1 < track.times.length && track.times[f + 1]! <= source.config.poseAtS) f++;
          const value = track.values.slice(f * track.stride, (f + 1) * track.stride);
          track.times = new Float32Array([0, 1]); track.values = new Float32Array(track.stride * 2);
          track.values.set(value); track.values.set(value, track.stride);
        }
        duration = 1;
      }
      clips.push({ name: source.state, duration, tracks });
      let nominalSpeedMps: number | undefined;
      if (source.config.nominalSpeedMps !== undefined) {
        const motion = buildSourceMotion(parseBvh(source.text), { unitScale: 1, forceUpAxis: 1 });
        const cal = source.sourceMeta.retarget?.calibration;
        const sourceHeight = cal?.pelvisHeightM ?? Math.max(.1, motion.worldPositions[motion.rootBone]![1]! - (cal?.supportPlane?.origin[1] ?? 0));
        const targetHeight = buildTargetRig({ skeleton: sk, calibration: meta?.retarget?.calibration ?? null }).rig.pelvisHeightM;
        nominalSpeedMps = source.config.nominalSpeedMps * targetHeight / sourceHeight;
      }
      states[source.state] = { loop: source.config.loop, ...(nominalSpeedMps === undefined ? {} : { nominalSpeedMps }) };
      reports.push({ state: source.state, status: outcome.status, diagnostics: [...target.diagnostics, ...outcome.diagnostics], metrics: outcome.metrics });
    }
    return { key, clips, states, reports };
  }
}
