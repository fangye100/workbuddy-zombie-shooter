# Street quality and architectural LOD — 2026-10-07

## Delivery and integration

`codex/scene-authoring-loop` was recovered from its archived tip and fast-forwarded
to `origin/main` at `dc9511cc474082c1223cf9f9a492a2f20672350e`. This includes the
nine-character rigging, volumetric skinning and shared animation/retargeting work.
The original character checkout and WorkBuddy delivery directory were left intact.
This pass owns environment derivatives, scene/material authoring and their tools;
it does not change character assets or retargeting algorithms.

WorkBuddy's five new sources are retained under `assets/art/sources/`: MID-03
repair garage, MID-04 brick factory, MID-05 broken wall, MID-06 overpass and FAR-02
industrial skyline. MID-03/FAR-02 replace their quota placeholders at the existing
runtime paths and GUIDs. Source GLBs, extracted BaseColor, previews and provenance
remain separate from the optimized runtime files. Binaries use Git LFS.

## Street and material changes

All three campaign scenes now contain seven middle-distance buildings, three
skyline placements, eight low foreground wall sections and an entrance overpass.
Floors retain their different gameplay and neighborhood palettes. These are scene
nodes with AssetRef path/GUID pairs, not objects created by rendering code.

| Floor | Static meshes, including editor proxies | Gameplay theme |
|---|---:|---|
| 1 | 57 / 64 | Accident road, supply stop and checkpoint |
| 2 | 55 / 64 | Warehouse/loading district |
| 3 | 56 / 64 | Dark evacuation district |

The street has a continuous 160 m asphalt asset, two continuous raised sidewalks,
batched curbs and yellow/ivory lane paint. A paved apron extends behind the distant
models as well as the foreground; the ground no longer ends before the skyline.
Cracks, repair patches, grain and paving joints come from deterministic textures.
Semantic room/corridor floor meshes remain visible to the author and are hidden in
Play, avoiding visible road-tile seams without changing room or navigation rules.

Building overrides use matte roughness, zero metallic/specular mix and restrained
ink/halftone strength. Cool distant tints, hemisphere fill and contact opacity are
authored in the scenes. Existing sky, character BaseColor and combat feedback are
retained. This pass adds no new shader or shadow-map implementation.

Only mesh-only, unreferenced box decorations are combined. The first NodeId stays
stable; referenced or unsupported transformed input fails explicitly. The GLB
loader recenters X/Z and grounds Y even with metric import scale, so the batch's
original center/minimum is restored by its scene transform. This prevents misplaced
curbs and paint disappearing beneath the road.

## Architectural simplification

Each level is generated independently from its original source, with texture-aware
QEM, boundary preservation, `optimalPlacement=false`, `preserveNormal=true`, planar
quadrics, quality threshold 0.7 and texture weight 2. Remaining vertices therefore
stay at original endpoints instead of being relocated by a free quadric solution.
This reduces invented diagonal folds; it does not reconstruct noisy source planes.

| Family | LOD0 / LOD1 / LOD2 triangles |
|---|---|
| MID-01 | 28,000 / 20,000 / 14,000 |
| MID-02 | 30,000 / 22,000 / 16,000 |
| MID-03 | 28,000 / 18,000 / 12,000 |
| MID-04 | 32,000 / 22,000 / 15,000 |
| MID-05 | 22,000 / 15,000 / 10,000 |
| MID-06 | 30,000 / 20,000 / 14,000 |
| FAR-01 | 32,000 / 24,000 / 18,000 |
| FAR-02 | 32,000 / 22,000 / 16,000 |

Across these 24 outputs, retained surface area is 93.46–99.62%; maximum bounds drift
is 0.416%. Existing topology, finite-attribute and target-budget gates still apply.
WPN-01 and the earlier 38-family environment delivery are not regenerated here.
The campaign references explicit LOD1/LOD2 files; automatic distance switching is
not implemented by generating these files.

`architecture-quality.py` additionally measures invented slopes and plane offsets
on coherent, axis-aligned source patches. It requires local normal coherence and
at least 5% qualifying area before enforcing its structural limits. MID-05/MID-06
provide enough coverage and pass all three levels. The other six families explicitly
report `insufficient-planar-coverage`: their generated source surfaces are too noisy
for this metric to certify them. Those diagnostics are not numerical proof of straight
facades. All eight families received a separate headed, textured LOD0/1/2 comparison.
Original damage, sloped factory roofs and residual source waviness remain visible;
this is not a claim of CAD-like reconstruction.

The gallery presents 27 models, including the unchanged pistol, in three columns.
During close comparison, other rows were temporarily hidden through the editor's
undoable node commands. Eight Undo operations restored the original clean gallery;
inspection visibility was not saved into its scene file.

## Reproduction

Use Python 3.12 with pymeshlab 2025.7.post1, numpy 2.5.3, Pillow 12.3.0 and scipy
1.17.0; Windows also needs the compatible MSVC runtime. This run used the ignored
`.workbuddy/tmp/art-python` environment. Put that environment's Scripts directory
on PATH when running the Python part of `scene:check`.

```powershell
python tools/art/test_architecture_quality.py
python tools/art/build-p0-lods.py --only ENV-MID-03 ENV-MID-04 ENV-MID-05 ENV-MID-06 ENV-FAR-02
# Review staged reports before publishing these explicitly selected IDs.
python tools/art/build-p0-lods.py --publish --only ENV-MID-03 ENV-MID-04 ENV-MID-05 ENV-MID-06 ENV-FAR-02
pnpm run scene:gen
node tools/art/prepare-p0-meta.mjs
node tools/art/refine-streets.mjs
node tools/art/build-p0-gallery.mjs
pnpm run scene:gen
pnpm run scene:check
```

Rebuilding resets visual review to pending. Publishing verifies source, recipe,
output and structural-method hashes and rejects numerical failures. Building also
returns a failure when a generated level misses a gate. `--recheck-structure` only
rechecks explicitly selected unrotated architecture outputs; it does not simplify
them again. Recheck and publishing are separate operations.

The v11 level generator applies the street pass and preserves the existing player's
MeshRenderer, rig/shared-motion reference, name and game Camera component. Explicit
regeneration still replaces other authored baseline edits and needs diff review.

## Actual verification and limits

- `scene:check`: 206 synchronized asset sidecars, 12 scenes at schema v11, 13 scene
  file tests, unchanged 38-family LOD audit and the expanded 27-file P0 gate passed.
- 94 relevant scene/runtime/presentation tests passed across the focused runs;
  three Python tests reject a folded roof and a parallel displaced plane while
  accepting coplanar retriangulation. Typecheck and editor production build passed.
- Contract comparison confirms all three scenes keep the main-branch gameplay
  components, semantic transforms, player rig/shared-motion configuration and game
  camera. Regeneration and repeated street authoring preserve these contracts.
- Headed Chrome, secure HTTPS, NVIDIA `lovelace`, 1577×773 viewport at DPR 1. All
  campaign scenes and the gallery loaded with no asset failures; all three campaign
  scene validations returned no diagnostics. The gallery intentionally has no player
  start and warns that it cannot be played.
- The default game camera remains 24 m / 52 degrees. Entry views, a first-floor
  movement sample using DOM keyboard events plus deterministic MCP steps, and temporary
  last-room start viewpoints were inspected. The movement sample is input-handler
  coverage, not a native held-key or full-campaign acceptance run. These
  viewpoint fixtures are undone after inspection; they are not completed campaigns.
- First-floor material editing through Game Editor MCP completed Edit → Save →
  Reload, verified the color and GUID on disk, then restored and reloaded the reviewed
  material. Visible Play/pause/Stop controls were exercised. Stop reports zero pending
  Play GPU resources and restores clean authoring state.
- Shared motions loaded with no errors, but their upstream reports remain `partial`
  with derived-marker/contact-calibration capability warnings. This pass does not
  certify or repair those retargeting limitations. No browser error was recorded in
  the inspected tab. A roughly 60 FPS spot sample is not sustained/mobile profiling.

Evidence is in [street-quality-2026-10-07](evidence/street-quality-2026-10-07):
[entry](evidence/street-quality-2026-10-07/floor1-entry.jpg),
[street overview](evidence/street-quality-2026-10-07/floor1-overview.jpg),
[scene contracts](evidence/street-quality-2026-10-07/scene-contracts.json),
[material roundtrip](evidence/street-quality-2026-10-07/material-roundtrip.json),
[hardware and motion](evidence/street-quality-2026-10-07/hardware-and-motion.json),
[LOD measurements](evidence/street-quality-2026-10-07/lod-summary.json), and the eight
`lods-ENV-*.jpg` comparison images. Comparison orbit is an inspection camera, not
the gameplay camera. Earlier art reports describe their own historical revisions.

VFX atlas repair/GPU integration, player weapon attachment, mobile profiling and
full editor MCP coverage remain separate work. No fresh Ardot-board comparison or
complete pixel match to the concept design is claimed by this intake.

The dedicated validation service used a CLI port override at HTTPS 5200 to avoid the
other checkout's 5100 service. Fixed Vite configuration remains 5100/5101. Its owned
Node PID is 5868, logs are `.workbuddy/tmp/quality-vite{,-error}.log`, and stopping it
requires targeting that PID only.
