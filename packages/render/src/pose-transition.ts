import type { BakedPalette } from './pose-palette';

/** Time-based easing shared by local-TRS and instanced palette transitions. */
export function poseTransitionWeight(elapsed: number, duration: number): number {
  const t = duration > 0 ? Math.max(0, Math.min(1, elapsed / duration)) : 1;
  return t * t * (3 - 2 * t);
}

interface PaletteState {
  palette: BakedPalette; clip: number; pose: number; time: number;
  from: Float32Array<ArrayBuffer> | null; start: number; duration: number;
}
/** CPU snapshots only at state changes. Per-frame playback remains GPU palette lookup.
 * Entity identity must include run/generation; callers prune invisible/dead entities. */
export class PalettePoseTransitions {
  private states = new Map<string, PaletteState>();
  clear(): void { this.states.clear(); }
  prune(live: ReadonlySet<string>): void { for (const key of this.states.keys()) if (!live.has(key)) this.states.delete(key); }
  sample(key: string, palette: BakedPalette, clip: number, pose: number, time: number, duration: number) {
    let state = this.states.get(key);
    if (!state || state.palette !== palette || time < state.time) {
      state = { palette, clip, pose, time, from: null, start: time, duration: 0 };
      this.states.set(key, state);
    } else if (clip !== state.clip) {
      const count = palette.jointCount * 16, offset = state.pose * count;
      const alpha = poseTransitionWeight(state.time - state.start, state.duration);
      const from = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const target = palette.data[offset + i]!;
        from[i] = state.from ? state.from[i]! * (1 - alpha) + target * alpha : target;
      }
      state.from = duration > 0 ? from : null;
      state.start = time; state.duration = duration; state.clip = clip;
    }
    state.pose = pose; state.time = time;
    const weight = poseTransitionWeight(time - state.start, state.duration);
    if (weight >= 1) state.from = null;
    return { weight, from: state.from };
  }
}
