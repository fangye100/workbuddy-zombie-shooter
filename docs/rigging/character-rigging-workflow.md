# Character rigging: source authoring to runtime delivery

This is the reusable workflow established by the nine-character delivery on
2026-10-07. It links the current implementation, GUI and MCP contracts. Per-asset
results and visual limits remain in the [delivery record](character-rig-delivery-2026-10-07.md)
and [control verification](character-control-2026-10-07.md).

## Owners and spaces

| Data / operation | Owner |
|---|---|
| Source geometry and textures | Original GLB; never overwrite it with rig output |
| Joint positions, wrapper settings, smoothing, volume parameters, rigid selections | `<source>.glb.meta.json.bindingEditor` |
| Editing/history and calculated weights | `BindingSession`; GUI and binding MCP reuse the same implementation |
| Volumetric cells and diffusion | `volumetric-volume.ts` / `volumetric-skin.ts`; disposable CPU Worker in GUI, CPU in MCP |
| Mesh, skeleton, inverse binds and top-4 weights | Exported rig GLB |
| Runtime asset identity, physical import height and shared motion binding | Output `.meta.json`; scene uses stable path + GUID |
| NPC rig selection | `asset-manifest.json` → ActorLibrary; SpawnPoint stores character ID |
| Shared source motion and state profiles | `assets/animations/mixamo/shared.motion.json` and BVH assets |
| Target-specific solving/cache and GPU sampling | SharedMotionRuntime → ActorLibrary palettes / RuntimeSceneMotion |

Source binding uses normalized **model-local metres**, with the editor ruler
derived from E-04's roster height (currently 2.05m). These coordinates are not
world coordinates or each actor's gameplay height. `get_state.model` exposes the
source path, sidecar, ruler and current vertex-selection fingerprint.

Physical delivery scales the whole rig to its roster height: POSITION, local
joint/node translations and inverse-bind translations move together. Scaling only
the mesh or copying source-selection fingerprints onto the normalized output is
incorrect. Generated sidecars point back to the source authoring session.

## 1. Restore and inspect the actual source pose

GUI: **Skeleton → 角色绑定数据…**, select the character and check the displayed
sidecar path. NPCs use textured source meshes; the player uses the LOD0 source.
Joint selection, front/side dragging and model-local XYZ editing all use the same
BindingSession. Save and **重载 meta** verify persistence.

MCP: call `get_workflow`, then `load_model`, `get_state`, `get_joints` and `render`
with front/side views and `grid:true`. Saved metadata hydrates automatically.
MCP's renderer supplies CPU diagnostic diagrams; headed Game Editor supplies
motion/GPU acceptance. The stdio server does not control a live browser session.

Place joints in the actual posed anatomy. Do not fit a template T-pose skeleton
over a bent limb. Preserve user-confirmed placements; mirroring an asymmetric
character, resetting its pose or unpinning manual wrappers changes author data.
`cylinders.unpin` runs auto-fit immediately, while auto-fit skips manual wrappers.

`save` must return `ok:true`. GUI/MCP use version-checked compare/patch writes:
conflicts retain local edits; reload and reconcile them. A successful save alone
does not produce or publish a rig.

## 2. Compute volume weights and preserve held props

For the current NPCs, the validated starting settings are:

```json
{
  "weightMode": "volumetric",
  "volumetric": { "resolution": 48, "depth": 1, "tolerance": 0.001 },
  "smoothWeights": true,
  "smoothIters": 6,
  "smoothLambda": 0.5,
  "mirrorWeights": false
}
```

This is a delivery preset, not a replacement for existing defaults or approved
player weights. The sequence is **algorithm → optional mirror → surface smoothing
→ rigid prop constraints**. Consult the [algorithm guide](volumetric-skinning.md)
for adaptive volume diffusion, bounded seed projection and CPU limits.

Read `compute_skin.weightQuality` after all postprocessing: zero/non-finite or
negative weights, and normalization error. Also inspect volume convergence,
`outsideBones`, `projectedBones` distances and `fallbackVertices`. Thin/open
generated surfaces may need explicitly reported nearest-bone fallback. Volume
diffusion does not repair incorrect anatomy or create missing geometry.

Held props use GUI **刚性部件约束** or MCP `set_options.rigidRegions`. Capsules
include `name`, a deforming `bone`, model-local `start/end`, `radius` and optional
`feather`. Exact selections additionally provide source `vertices` and the
current `get_state.model.selectionHash`. Invalid/stale selections fail atomically.
Later regions win; `rigidRegions:[]` clears them, while omission preserves them.

For B-03, capsule boundaries cut fused prop/body triangles. The reviewed solution
uses complete UV islands: all 3,060 IV stand/bag/tube vertices follow LeftHand at
weight 1 after smoothing. The body still uses volume diffusion. A fingerprint
guards geometry changes; it is not a substitute for sidecar SHA-256 provenance.

## 3. Export and publish an animation-ready rig

For non-T source poses use `export_glb` with `bindPose:"source"`, an explicit
output path and `overwrite:true` only for an authorized replacement. The current
mesh/rest pose is preserved, with joints and matching inverse binds. The default
export remains T-pose. Source-pose export rejects incompatible embedded T-pose
animation; shared motion must solve against the target's actual rest transforms.

MCP exports a rig at the binding ruler scale. It does not automatically normalize
to roster height, register the scene, create shared-motion configuration or embed
animation clips. The current nine-character delivery is reproduced by:

```powershell
node tools/rigging/export-character-rigs.mjs
node tools/rigging/integrate-character-rigs.mjs
pnpm run scene:gen
pnpm run scene:check
pnpm run motion:check
```

The first script reuses saved NPC sessions through real MCP, preserves the approved
player weights and normalizes whole rigs. The second updates rig tiers, player
references on three floors and the registered validation scene. They target the
current manifest; review their scope before applying them to a different roster.
Metadata generation merges existing fields. It must not erase author bindings.

## 4. Runtime motion and control acceptance

Rig GLBs contain zero embedded clips. Shared BVH sources are solved against each
target rest pose and cached at runtime, then baked into reusable CPU/GPU palettes
for sampling. This is target-specific cached motion data, not a copied FBX/BVH per
character and not per-frame voxel skinning. See [runtime integration](../35-SharedMotionRuntimeRetarget.md)
and the 16A/16B research documents for solver contracts and limitations.

Use the registered `character-rig-validation.scene.json`: Edit previews authored
rigs; Play hides static NPC previews and creates eight real `actor:*` NPC instances;
Stop restores author state and releases Play GPU resources. Test textured rest
pose, idle/walk/attack/death/scream, held props and death endings on a headed GPU.

Check eight movement directions and both static player / instanced NPC paths.
Gameplay heading is `atan2(z,x)`; +Z-forward render rotation is `pi/2 - heading`.
`character-facing.ts` owns the conversion. Combat headings remain unchanged;
target-camera presentation converts at the adapter boundary. A stationary AI
chase actor with authored zero speed plays time-driven idle, not a walk phase
that depends on displacement; Broodmother intentionally stays anchored.

Finite matrices, valid hashes, a passing build and a visible canvas are structural
checks. They do not establish cloth/armor deformation quality, foot contact,
dedicated Boss attacks or crowd performance. Keep those limits visible in delivery
records; use screenshots plus measured runtime state for each claimed acceptance.
