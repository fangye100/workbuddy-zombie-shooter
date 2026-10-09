# Animation visual debugging

The editor provides a transient, read-only animation graph for one observed actor.
Open **动画调试图 · 只读** at the bottom left of the viewport and enter Play using
the existing Play controls. The authored player is selected by default when it
is rendered as a scene skeleton; otherwise the runtime player is observed.
**观察角色** also lists scene skeletons and live NPC identities.

## Reading the two views

**状态与条件** shows the real presentation rules feeding a selector, the requested
state/clip, and the actual output. Green edges mark the selected rule path. Click
a node to inspect condition truth, precedence, availability and fallback reasons.
These are resolver edges, not an authored state machine or invented transitions
between every pair of animation states. A profile maps states to clips; it does
not define state-machine edges.

Scene motion keeps the existing priority order: manual overrides, available
weapon action candidates, legacy firing when no weapon system exists, locomotion,
then the configured default for missing locomotion states. Active aiming IK can
retain gait during fire. A held fire input is not an accepted weapon action.
Weapon clip/action/fallback choices, action stamps and replay events are observed
from the same resolver used by execution.

Instanced NPCs use their actual behavior-to-clip mapping, including stationary
chase normalization. Runtime players rendered as instances use the existing
weapon clip/action mapping. This pipeline has its own fire-to-attack fallback;
it does not reuse the scene motion resolver. Missing names fall back to clip zero,
and an empty clip collection uses bind pose. Proxy/LOD and current actor-load
failures are displayed explicitly. No animation is inferred for a capsule.

**姿态管线** shows base sampling, the current pose transition, body IK controls,
and render output. The target weight is the actual eased weight, rather than
elapsed/duration presented as a blend weight. Transition sources are captured
local poses for scene skeletons and captured palette matrices for instances.
Neither transition continuously plays two source clips. Retargeting and palette
baking occur at load time and are not represented as per-frame processing nodes.

Click an IK control node to inspect authored and effective weights, target kind,
the resolved actor-local target, validity and solver diagnostics. Missing targets,
invalid chains and skipped solves have zero effective weight. Current GPU
instances do not execute the CPU body-IK layer; the graph marks it unsupported
and highlights the direct output path. Unconfigured, pending and failed layers
remain visible. Solver diagnostics are the latest available CPU evaluation;
there is no GPU readback or reconstruction of rendered vertex positions.

## Observation controls

- **冻结观察画面** retains the currently displayed graphs and timeline. The game
  continues, and the selected production stream continues to collect bounded
  events. **恢复实时观察** displays the latest state. This is not game pause.
- Click a recent switch to inspect the recorded projection. **返回当前观察**
  returns to the current or frozen projection. This does not replay the world.
- **缩小图**, **放大图**, **复位图**, Ctrl+wheel, scrollbars, and dragging the blank
  graph area navigate the graph only. Nodes support Enter/Space for details.
- Panel key presses do not reach game/editor shortcuts. Key releases remain
  available to the existing input owner so previously held movement/fire keys
  can be released.
- **关闭** unsubscribes the observation stream and clears retained views/history.
  Closing the panel performs no additional debug sampling.

Stop, a new run, target changes and entity-generation changes clear observation
history and frozen views. Scene targets use stable NodeIds; runtime entities use
runId/entityId/generation. Render batch rows and static array slots are never
persisted identities. The panel does not write scene files, asset sidecars,
motion libraries or editor preferences.

## Ownership and cost

`apps/editor/src/services/animation-debug/` owns detached contracts, resolver
explanations, runtime adapters, the collector, graph projection and panel.
`RuntimeSceneMotion`, `RuntimeBridge` and `RuntimeBodyIk` expose narrow read-only
observations. `PalettePoseTransitions.describe` exposes CPU metadata only.
`main.ts` creates the panel, supplies host references, updates it after rendering,
and disposes it with the editor.

Only the selected actor produces debug snapshots. Execution events are captured
independently of the UI refresh; the UI refreshes at most eight times per second.
History retains at most 32 detached snapshots, so brief transitions and consecutive
same-clip weapon actions can be inspected without per-frame crowd cloning. The
target dropdown enumerates current identities at UI frequency; it does not copy
the crowd's poses. The observer does not own GPU resources, change animation
parameters, call animation/IK setters, or pause simulation. Existing animation
and IK control panels retain their separate behavior.

For read-only inspection, `window.__editor.animationDebug.snapshot()` returns a
detached copy of the displayed view, or null when no view is retained. It exposes
no controls. The visible panel is still the acceptance path.

## Scoped verification

Model/service gates:

```powershell
pnpm exec vitest run apps/editor/test/animation-debug-selection.test.ts apps/editor/test/animation-debug-collector.test.ts apps/editor/test/runtime-scene-motion.test.ts apps/editor/test/runtime-body-ik.test.ts apps/editor/test/runtime-bridge.test.ts packages/render/test/pose-transition.test.ts
pnpm run typecheck
pnpm run editor:build
```

Use the existing `assets/scenes/sandbox/shared-motion-runtime.scene.json` and
`assets/scenes/sandbox/body-ik-validation.scene.json` for headed Play acceptance.
Open the panel, inspect scene and NPC paths, click condition/control nodes, view
short transitions and history, test navigation, and activate the freeze button
with Space while confirming runtime ticks continue. Stop/rerun and change the
observed actor to verify histories do not cross identities. Check current Proxy
and missing/configuration diagnostics on the reachable runtime path.
Pure tests and builds do not replace this visible/GPU acceptance.
