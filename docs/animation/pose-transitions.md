# Runtime pose transitions

Game motion state changes now transition from the currently displayed animation
pose to the moving target clip. Default duration is 0.2 simulation seconds, using
smoothstep easing. This is a frozen-source pose transition; the outgoing clip does
not continue playing during the fade. The destination clip starts at its normal
start time and keeps the existing gait-distance or attack-phase clock.

## Configuration and ownership

`SharedMotionBinding.transitionSec` accepts 0 through 5 seconds. Missing means
0.2; zero means immediate selection. Scene overrides belong in
`MeshRenderer.sharedMotion`, reusable defaults in the asset `.meta.json`.
The visible scene author form exposes the duration. Apply and save use the
existing document/history/conflict checks. Scene schema v14 adds the opt-in field;
the v13 migration preserves existing bindings rather than writing generated poses.
NPCs inherit the duration from their asset's resolved motion binding.

- `skin.ts` owns transient pre-IK local pose snapshots and TRS evaluation.
- `RuntimeSceneMotion` owns clip selection and fixed-tick transition advancement.
  Playback speed changes clip time, not transition wall time. Repeated render
  frames and paused sessions do not advance a second animation clock.
- `PalettePoseTransitions` owns CPU snapshots for instanced actors. `RuntimeBridge`
  keys them by run/id/generation, packs the blend weight and source matrix offset,
  and prunes removed or invisible actors.
- `RendererCore` owns snapshot storage buffers per batch. It uploads sources only
  when their revision/data changes and destroys them on palette replacement,
  capacity replacement, Play Stop, and renderer disposal. Existing PlaySession
  resource registration calls the same dynamic-resource release path.

## Continuity and IK ordering

For authored skinned objects, the source is sampled before IK: translations and
scales interpolate linearly, rotations use normalized shortest-arc slerp. The
post-animation HumanIK layer runs once on the resulting pose. Changing clips
during a fade captures the current mixed pose, avoiding a jump back to the
previous clip or an accumulation of IK correction.

For crowds, the source snapshots the currently displayed blended palette
matrices only at clip changes. The GPU interpolates to the current destination
palette pose for positions, normals and outlines. Per-frame CPU FK for every NPC
is not added. Row changes in a batch rewrite the corresponding snapshot, keeping
source poses attached to entity identity rather than an unstable row number.
The dynamic instance ABI is 20 floats / 80 bytes; the last vec4 stores target
weight, source matrix offset, and two reserved values. Binding 5 stores source
matrices separately from the immutable baked palette at binding 4.

## Reset and boundaries

Initial load, rerun and new entity identities select immediately. Stop restores
the original author SkinState and releases transient dynamic GPU resources.
Invalid clip indexes and nonfinite/negative transition requests leave playback
unchanged. Asset/config validation rejects durations outside the authored range.
Solved retarget clips remain cached independently of transition duration.

This adds state-change continuity, not a locomotion blend tree, phase matching,
inertialization, anatomical joint limits, root-motion blending, or foot planting.
NPC matrix interpolation is an LBS approximation: large opposing rotations can
temporarily reduce volume. The palette still uses nearest-frame sampling within
each clip. No mobile performance or 500-NPC stress claim is made by these checks.

## Validation

Tests cover TRS endpoints, moving destinations, shortest-arc rotations, interrupted
fades, repeated evaluation and pause, IK ordering, fixed ticks, restart/Stop,
palette identity and row changes, zero-duration selection, cache reuse, and
scene/asset validation and migration. Headed hardware acceptance additionally
checks actual shader/pipeline compilation and visible motion controls.

The focused suite passed 428 tests across 28 files. `pnpm run typecheck`,
`pnpm run editor:build`, `pnpm run build`, and `pnpm run scene:check` passed;
the scene gate checked 206 assets and all 13 scenes at schema v14.

Headed acceptance on Windows/NVIDIA Lovelace (2026-10-07) confirmed a secure
context and schema v14. The visible author form saved/reloaded a 0.6-second demo
override. With Play paused, Run -> Idle began with zero joint-matrix difference;
nine visible fixed-step clicks reached 50% and changed the pose (maximum matrix
element difference 0.99763). Interrupting that fade with Run again had zero
initial matrix difference. Completing the fade cleared its transient state.

Actual NPC wakeup at tick 151 entered a GPU transition with weight 0. At tick 154
both NPC batches had weight 0.5 and a 1792-byte source buffer each. No new GPU
errors occurred after the final shader load. A temporary developer-only destroy
counter observed both snapshot buffers destroyed by the visible Stop button;
dynamic slots/palette and all transition states were cleared. Author document
and clip/time/playing values matched the pre-Play snapshot exactly. The counter
was removed after verification. These are integration/lifecycle checks, not
crowd volume-preservation or mobile stress acceptance.

The existing HumanIK demo at QA port 5197 exposes transitions and IK together.
Its detached service working directory, logs, PID and stop command remain in
[the IK workflow](body-ik-blending.md#validation).
