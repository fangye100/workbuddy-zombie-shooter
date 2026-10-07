# H-01 Scavenger LOD0 rig delivery

Delivered on 2026-10-06 using the current Game Editor binding domain MCP and the headed editor Skin UI.

## Assets and recipe

- Source: `assets/characters/models/H-01/H01_20261003_173137.glb` (Asset Browser LOD0, 79,980 triangles / 56,603 vertices).
- Output: `assets/characters/models/H-01/rigged/H01_SCAVENGER_LOD0_animation_ready.glb` (20,670,048 bytes).
- The original source GLB is unchanged. Its new sidecar stores the editable joint positions and Skin Wrapper recipe; the output sidecar references that source by path and GUID.
- 27 HumanIK joints, including 22 deforming joints and five unweighted tips; four influences per vertex; inverse bind matrices embedded in the GLB.
- Wrapper weights with distance fallback, followed by eight smoothing iterations at lambda 0.5. Wrapper offsets are zero. Bilateral positions are stored explicitly; no mirror operation overwrote an existing side.
- Joint placement was checked against the LOD0 front/side silhouettes. Arms have upper-arm/forearm lengths of 0.283 / 0.305 m; thighs/shins are 0.394 / 0.474 m in the 2.05 m editor binding ruler.
- The export is a static T-pose rig ready to receive animation, with no embedded animation clips. It does not provide individual finger articulation.
- The embedded BaseColor image is byte-identical to the source; SHA-256: `050eea2f13b31bcee3d6aacefd40ffac228a58a37f4917ca4ed0a141821beca5`. The editor export uses its standard material rather than carrying every source PBR channel.
- T-pose conversion changes mesh bounds from 2.050 m to 2.09549 m. The output importer uses the roster height of 1.80 m; the editable binding recipe uses the editor's 2.05 m ruler.

## Actual verification

- `python assets/characters/_tools/validate_glb.py <output>` passed reconstruction of all 56,603 bind-pose vertices. Maximum LBS error: 1.41e-7 m; mean: 2.79e-8 m (tolerance 1e-3 m).
- Zero-weight vertices: 0. Tip weight sum: 0. Geometry counts are preserved.
- `pnpm run scene:check` passed: 174 product assets synchronized, 10 scenes current, 12 scene-file tests passed, environment LOD and P0 asset checks passed.
- Saved source-sidecar data was reopened through the editor's visible Binding entry. The UI restored the joint positions, wrapper settings and eight-iteration smoothing recipe.
- Headed Chrome used secure HTTPS and a NVIDIA Lovelace WebGPU adapter. Pose-mode checks covered approximately 90-degree elbow bends, a raised left leg, and torso lean/twist. These used the editor's temporary pose snapshot, leaving the saved binding unchanged.
- The exported GLB was reopened in the Asset Browser: 79,980 triangles, 56,603 vertices, embedded texture and skeleton controls available. This establishes actual editor import and rendering, not only file statistics.
- The visible BVH loader accepted the project's `sample_mixamo_walk.bvh`: 22/22 source bones mapped, no missing bones, 60 frames. The editor animation export dry run produced 23 channels. That probe is not embedded in the delivered static rig.

## Validation boundaries

The sample BVH retarget preview reports partial contact support because the sample lacks source foot calibration/trusted world trajectory, and reports swing penetration. This delivery does not claim foot locking or production walk-animation acceptance. Windcoat vertices outside the wrappers retain distance-fallback weights (29,114 vertices); pose checks do not establish collision-free clothing across all future animations. No gameplay scene or runtime model selection was changed.

Local diagnostic images and JSON are retained under `.workbuddy/tmp/scavenger-lod0-rig/`. The editor started for this task runs from this checkout on HTTPS port 5100; logs are `.workbuddy/tmp/rig-editor.stdout.log` and `.workbuddy/tmp/rig-editor.stderr.log`. The launch PID was 61348; if still owned by this task, stop it with `Stop-Process -Id 61348` after checking its command line.
