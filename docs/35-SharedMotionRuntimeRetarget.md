# Shared motion runtime retargeting

## Delivered behavior

One target-independent motion library drives authored scene characters and dynamic NPCs in the current playable host, Game Editor Play. On loading a character, the host uses the existing `RetargetSession` to generate target-local clips in memory. Character rest offsets, hierarchy, proportions and extra tip bones remain owned by the target rig. No per-character animation GLB is published by this path.

The runtime then samples the generated clips or an NPC pose palette. Whole-clip contact detection, temporal solving and baking do not execute each rendering frame. This is **load-time runtime retargeting**, with a content-keyed CPU cache, rather than a per-frame streaming retarget solver.

The separate `apps/samples/00-init` application remains the M0 WebGPU clear-screen sample; it is not a second playable game host. This implementation is verified through the scene-driven Game Editor Play host. A future packaged game host can inject its own asset reader into `SharedMotionRuntime`; the default reader uses the editor's `/__fs/file` endpoint.

## Data and ownership

| Owner | Persistent data / responsibility |
|---|---|
| `assets/animations/mixamo/shared.motion.json` | Sources, loop/root policies, gait speeds, player/NPC state profiles |
| Source BVH sidecar | Stable guid, source hash and optional source calibration |
| Character GLB + sidecar | Rest skeleton, skin weights, target calibration and default `sharedMotion` binding |
| Scene `MeshRenderer.sharedMotion` | Optional scene override; omitted inherits asset defaults, `null` disables |
| `SharedMotionRuntime` | Read validation, existing retarget solver, in-memory target-local clip cache |
| `RuntimeSceneMotion` | Play-owned authored-node state, fixed-tick clock, exact Stop restoration |
| `ActorLibrary` / `RuntimeBridge` | NPC palette construction, behavior selection, displacement-based gait phase |
| Renderer / Play resource ledger | GPU upload and destruction; per-actor palette stride |

Scene schema is v11. The v10 → v11 migration adds no binding to existing scenes. Ten existing scenes are upgraded only in version. Asset defaults are set on eight existing rig-only manifest assets and the previously delivered H-01 LOD0 rig.

```json
{
  "library": {
    "path": "assets/animations/mixamo/shared.motion.json",
    "guid": "as_mixamo_shared_motion"
  },
  "profile": "player",
  "defaultState": "idle",
  "speed": 1
}
```

The cache identity includes source contents, library policies/profile, algorithm version, target hierarchy/rest transforms/inverse bind/normalization and source/target calibration. Playback speed and default state do not change solved clips. Concurrent instances share the same pending result. Each Play re-reads authored resources; failed solves are removed from the cache, and Stop rejects late asynchronous attachment. GPU resources are recreated for each Play.

## Using the editor

1. Open `assets/scenes/sandbox/shared-motion-runtime.scene.json`, registered as **Shared Motion · Runtime Retarget** in the project.
2. Press Play. Four authored targets load shared motions: two H-01 LOD0 instances (27 joints), E-01 and E-04 (22 joints). Three comparison targets use the same Walking source. Dynamic E-01/E-04 NPCs use the NPC profile.
3. Expand **共享动作 · Play** to select actions per authored target. Pause/single-step can inspect specific poses. The player selects idle/walk/run from locomotion and shoot from held fire input; the existing game controls are WASD and J.
4. To change a binding, Stop, open **场景/光照**, select a mesh node, and edit **共享动作库 · Runtime 重定向**. Apply node changes, wait for completion, then save through File → Save. Reload confirms persistence.
5. Stop restores the original animation/skin state and removes dynamic GPU resources. Restart uses unchanged solved clips from the CPU cache.

Player profile: ready pose, walk, run, jump, shoot, punch. The ready pose samples frame zero of Shoot Rifle; the source downloads did not contain a separate player idle. NPC profile: idle, walk, attack, death, scream. Current NPC behavior automatically selects idle/walk; attack/death/scream are library states available to consumers, not new combat/death event wiring. Manual jump does not add a gameplay jump mechanic. NPC render tier limits may retain only the first two states, matching the existing palette budget.

All shipped clips use `in-place`: horizontal hip displacement is removed, vertical body movement is retained, and navigation stays in gameplay. The downloaded Zombie Death actually has approximately 1.175 m of source endpoint horizontal displacement; the root policy handles this explicitly. `trajectory` preserves a clip's visual root track; it does not transfer root-motion authority to gameplay.

## Import and verification

`pnpm run motion:import` requires the ten already downloaded FBXs in ignored `assets-src/mixamo/animations/`. Three.js is an offline dev dependency for FBX decoding and is not imported by the browser runtime. The converter removes FBX world-rest rotations with a change of basis, converts centimetres to metres, samples at 30 fps and writes BVH channels in the project's absolute-root-position convention. Both direct FK and serialized BVH readback are checked against FBX FK; import fails above 2 mm. Sidecar re-import merges existing authored fields instead of deleting calibration/bindings/user data.

`pnpm run motion:check` needs only checked-in derived assets. It verifies source/sidecar hashes, resolves actual scene target rigs, samples every frame through the renderer's joint-matrix evaluator, checks finite matrices and unchanged target rest offsets, and assembles real 27/22-joint actor palettes. GPU stride includes one identity joint, yielding 28/23 matrices per pose. Global palette addressing is `matrixBase + localPose * actorJointStride + jointId`.

Keep original FBXs ignored. Derived motions are embedded game resources, not a standalone redistribution of the Mixamo animation library.

## Acceptance and limits (2026-10-06)

- Relevant retarget, Play, actor, bridge, palette, metadata and migration tests: 427 passed, followed by an additional rerun-default-state regression; scene-file gate: 13 passed.
- Type checking, editor build, `motion:check`, `scene:check` passed. Editor build reports its existing bundle-size warning.
- Headed Chrome on secure HTTPS, NVIDIA Lovelace hardware adapter (`isFallbackAdapter=false`): actual shared scene, action buttons and single-step pose changes verified.
- Visible Apply → Save → Reload preserves a speed edit; restored speed 1 was saved and reloaded. An intentionally encountered stale disk baseline was rejected without overwriting the generated scene.
- Stop: four authored animation states restored to zero embedded clips, dynamic instance count 0, ledger registered/disposed 2/2 after one cycle and 4/4 after two, pending 0. Renderer instance counters settle on the next rendered frame.
- Second Play: 59 cumulative whole-clip solves remained unchanged; cache hits rose from 1 to 13. Fixed-step input hook moved the player 0.3 m and selected proportion-adjusted run. This input-hook check is logic coverage; it is distinct from the visible action-button path. Physical held-WASD/J automation was not established by that check.

The solver currently reports **partial** for these assets: foot markers and source pelvis height are derived, and reliable contact calibration is missing. The shipped in-place sources cannot establish world-space planted-foot anchors on their own. Zero slide/penetration metrics in this capability mode are not proof of perfect foot locking. Precise hands-on-weapon alignment, foot locking, contact-aware root correction, action blending and 500-NPC performance are not certified by this delivery.

Nominal gait speeds are initial estimates from low-foot-height horizontal velocity, scaled by target/source pelvis height. Runtime locomotion scales cadence by actual movement. These values can be tuned in the library; they do not replace foot contact annotations or gait blending. Supported rigs must satisfy the existing named HumanIK/humanoid retarget contract. Unsupported mapping/calibration/source data produces visible diagnostics; NPCs retain the existing capsule fallback.

The next proportion-quality improvement is authored foot/palm calibration and contact annotations. A build-time optional cache for many NPC archetypes can consume the same source library and target keys after real loading/memory measurements; it should not become another authoring source of truth.

Evidence: [shared Walking](evidence/shared-motion-runtime-2026-10-06/shared-walking.png), [action switching](evidence/shared-motion-runtime-2026-10-06/actions.png), [stopped author state](evidence/shared-motion-runtime-2026-10-06/stopped.png), [headed report](evidence/shared-motion-runtime-2026-10-06/headed-report.json), [real-asset CPU gate](evidence/shared-motion-runtime-2026-10-06/check-report.json), [FBX import FK report](evidence/shared-motion-runtime-2026-10-06/import-report.json).
