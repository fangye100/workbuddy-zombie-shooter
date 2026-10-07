# HumanIK procedural animation blending

The animation module evaluates the existing clip first, then applies authored
HumanIK controls to selected bone chains. Imported FBX motion baked into the
target's `AnimClip` and shared runtime retarget clips use the same sampler.
Weight zero retains the sampled motion; weight one applies the full IK result.
Effective weight is `binding.weight * control.weight`, using shortest-arc local
quaternion interpolation. Translation, scale, hips and unrelated local tracks
are preserved. Each frame starts from the sampled pose, preventing accumulation.

## Ownership and persistence

- `packages/scene/src/body-ik.ts`: persistent assembly and validation.
- `packages/render/src/body-ik.ts`: bone mapping and post-sampling pose evaluation.
- `packages/render/src/two-bone-ik.ts`: shared analytic solver used by live IK and
  the existing retarget pipeline. The editor's old solver entry re-exports it.
- `apps/editor/src/services/runtime-body-ik.ts`: Play lifecycle and live targets.
- `PlayerPresentation`: player transform and lower-body movement heading.
- `RuntimeSceneMotion`: locomotion clip selection and the fixed simulation clock.

`MeshRenderer.bodyIk` overrides the asset's `.meta.json` `bodyIk` defaults.
Undefined inherits; null disables. Reusable asset defaults may use actor-local
positions, pointer targets or nearest-enemy targets. Stable scene NodeId targets
belong in scene overrides. No sampled pose, executable code or GPU resources are
serialized. Scene schema v13 adds an opt-in migration from v12. Existing scenes
retain their animation behavior without inventing controls.

## Controls and target spaces

| Part | HumanIK chain | Solve |
| --- | --- | --- |
| `upperBody` | Spine / Spine1 / Spine2 | Distributed aim rotation |
| `head` | Neck / Head | Distributed aim rotation |
| `leftHand`, `rightHand` | Arm / ForeArm / Hand | Two-bone reach |
| `leftFoot`, `rightFoot` | UpLeg / Leg / Foot | Two-bone reach |

Canonical HumanIK names and `mixamorig:` / `mixamorig` prefixes are supported.
Missing/ambiguous names, incompatible chains and unsupported scales produce
diagnostics. Upper-body solving precedes head and limb solving, independently
of insertion order. No control changes the root position or stretches a limb.

- `position`: normalized actor-local metres, including the GLB import normalization.
- `mouse`: visible gameplay mouse/stick target at an authored world height.
- `node`: target node world position plus an authored world-space offset in metres.
  Rendered nodes use their live position. Empty attachment nodes use the authored
  scene hierarchy, including parent transforms, captured for this Play session.
- `enemy`: closest living runtime NPC with positive health, at the authored world
  height. With no target, the original animation remains active and diagnostics
  explain why the control is skipped.

Hand/foot `pole` is an actor-local bend direction. Aim `forward` is a bone-local
axis (default +Z); `maxAngleDeg` limits the correction relative to sampled motion.
Position targets pass through the inverse skeleton normalization. Host world
targets first pass through the inverse actor translation, rotation and scale.

`locomotionWhileAiming` keeps idle/walk/run while a weighted torso/head aim control
has a valid target, including while firing. The player mesh faces movement while
the gameplay heading continues to own aiming and shot direction. Disabling IK
or setting its weight to zero restores existing full-body shoot selection.

## Editor workflow

1. Select a skinned scene node. Open **场景/光照**, then its scene node author form.
2. Under **HumanIK · 分部位程序化混合**, choose **设置分部位 IK**. Add the required
   parts; set each weight, target source, bend direction and aim limit.
3. Choose **应用节点修改**, then save the scene through the File menu. Draft changes
   do not alter the scene until applied. Standard undo/redo and save conflict
   checks remain in effect.
4. Enter Play. **HumanIK 混合** exposes transient master/part weights. Pointer and
   enemy targets update every frame. Pause allows a fixed animation-time comparison.
5. Stop restores the original SkinState reference and its playback values.
   Late asynchronous completions cannot reattach IK after Stop. Shared motion may
   replace the sampler during loading; the adapter attaches the same transient
   control state to the replacement and releases it on Stop.

The registered `assets/scenes/sandbox/body-ik-validation.scene.json` demonstrates
four actors, including Run + torso/hand IK and Walk + head/foot IK. Distant NPCs
and slower authored decisions provide time to inspect the live weights.

## Capability boundaries

This is a post-animation control layer for authored skinned scene objects,
including the player. Crowd NPCs still use baked pose palettes and instancing;
per-entity IK in that path is not implemented. This change adds no GPU allocation.
It does not implement automatic weapon grip, terrain queries, foot planting,
whole-body root correction, or a general multi-clip animation graph. Actor and
skeleton scales must be positive/uniform. Aim/reach limits are diagnostic,
not anatomical joint limits. Partial IK weight does not promise exact endpoint
contact. Nearest-enemy aiming is visual; gameplay targeting remains authoritative.

## Validation

Focused tests cover full/zero/partial weights, master × part equivalence, sampled
lower-body preservation, deterministic repeated evaluation, centimetre units,
Mixamo naming, unreachable limbs, missing targets/bones, aim limits, scene/asset
validation, migrations, asynchronous load/Stop, shared-motion sampler replacement,
movement-facing versus gameplay aim, firing gait and restart behavior.

Headed Chrome acceptance must additionally confirm the correct checkout and
scene, real GPU/secure context, visible Apply/save/reload and Play weight controls,
source-clip changes on the intended actor, and exact Stop restoration. A successful
build or matrix test alone is not visual acceptance.

Verified on Windows, headed Chrome with a secure context and NVIDIA Lovelace:

- Visible master slider 0/1 comparison at the same Run sample time: hips and both
  legs had zero joint-matrix difference; the upper body changed (maximum matrix
  element difference 1.00372). This confirms isolation, not anatomical quality.
- Real mouse/keyboard input produced an actor-local aim target while movement
  facing remained separate from gameplay aim. Space pause retained that target.
- The visible author form changed the torso weight to 0.75. Apply, File save and
  browser reload retained 0.75; save reported one changed field.
- Visible Stop left the document identical, restored author clip/time/playing
  values exactly, and left zero attached IK states or pending loads.
- 358 focused tests across 23 files passed, along with typecheck, editor build and
  scene:check (206 assets, 13 scenes, 38 environment LOD pairs).

The isolated demonstration server uses temporary QA port 5197 so it does not
take over another checkout's fixed 5100 service. Working directory is this
checkout; logs and PID are in `.workbuddy/tmp/body-ik/server.log`,
`server.err.log`, and `server.pid`. Stop it in PowerShell with
`Stop-Process -Id ([int](Get-Content .workbuddy/tmp/body-ik/server.pid))`.
The project's normal development ports and HTTPS settings are unchanged.
