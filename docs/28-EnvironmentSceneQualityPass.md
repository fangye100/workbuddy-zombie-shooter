# Environment scene quality pass

## Scope and ownership

This pass integrates the delivered environment catalog into the campaign and refines
floor one as the environment sample. It does not own ongoing character production.
The existing enemy presentation is retained; the unrigged protagonist still uses its
runtime fallback. Floors two and three receive themed placements, not the same depth
of art refinement as floor one.

References reviewed: GDD sections 4.1–4.4, the local S-01/S-02 concept images, the
delivered P-11 LOD evidence, and the previously captured Ardot board. A fresh Ardot
connection timed out during this run; no fresh online design inspection is claimed.

Scene JSON remains runtime SOT. All gameplay component values and gameplay node IDs
are unchanged. New scenery uses stable IDs and sidecar GUID/path references. Only
redundant decorative lane dashes were removed to free object slots. No schema or
capacity increase was needed.

## Delivered scene content

| Floor | Theme | Static objects | Catalog placements | LOD1 / LOD2 |
|---|---|---:|---:|---:|
| 1 | Accident approach, gas-station supply, toll checkpoint | 63 | 20 | 5 / 15 |
| 2 | Warehouse and loading yard | 56 | 13 | 1 / 12 |
| 3 | Subway approach and medical evacuation | 50 | 16 | 1 / 15 |

All 38 catalog model families have at least one visible authored placement; see the
[complete node mapping](evidence/scene-art-pass-2026-10-04/model-placement.md).
LOD variants are chosen per placement, not duplicated as separate scenery. The 76
delivered GLBs remain intact. Automatic environment LOD switching is not implemented.

Floor one additionally references four reusable asphalt assets (six placements).
Their deterministic texture supplies aggregate, cracks and repair patches, with no
baked shadows. Surface height preserves the old floor top; lane paint sits above it.
The scene controls warm key light, cool hemisphere fill, reduced outlines, floor AO,
a warm supply point light, and a fixed-world follow camera (24 m, 52 degrees).
No realtime shadow-map/contact-shadow implementation is claimed.

The generator applies the art pass explicitly. Editor edits still save directly to
scene JSON; regeneration replaces that authored baseline and must be diff-reviewed.
To rebuild the reusable road assets:

```powershell
node tools/level/bake-road-surfaces.mjs
pnpm run scene:gen
node tools/level/gen-level.mjs
pnpm run scene:check
```

## Runtime and editor corrections

- Play uses the full workspace; Stop restores author panels without replacing their
  stored dimensions. The compact HUD leaves more of the game scene visible.
- Editor orbit, pan, zoom and double-click focus no longer change the game camera.
  Pending author focus/pointer state is cleared before Play.
- Authored point lights now enable their render slot on load. Loading a scene without
  a selected light clears the old slot instead of retaining stale illumination.
- Runtime actor LOD distance uses the renderer's shared orbit-eye projection,
  including the degree-to-radian conversion and matching yaw axes.

## Verification

- 99 focused tests passed for level scenes, runtime movement/collision, Play camera
  lifecycle and light-slot projection.
- TypeScript typecheck and editor production build passed. Existing bundle-size
  warning remains; it is not a failed build.
- `scene:check` passed: 149 matching asset sidecars, nine schema-v7 scenes, twelve
  scene-file checks and the unchanged 38-model LOD quality audit.
- Added catalog completeness/GUID/dependency checks and an actual runtime movement
  regression from the first-floor entry to the checkpoint through authored colliders.
- Headed Chrome, HTTPS, NVIDIA Lovelace. One observed desktop sample was approximately
  60 FPS at 1470×697 with 90 draw calls and 375,705 triangles. This is a spot sample,
  not a sustained performance benchmark or mobile acceptance.
- Wheel/drag regression at a visible Play pause left the authored camera unchanged
  (distance 24 m, elevation 52 degrees). No console/GPU error was observed at that check.

The gameplay acceptance uses browser-generated movement/fire/interact key events
and visible UI choices, never teleporting the player or directly damaging enemies.
The recorded first-floor run completed 24 kills, all three rooms, and finished with
69.592 HP at tick 3091 (1:43 simulation time, including time spent standing at supply).
It exercised both combat rooms/waves, the supply interaction, a purchase (61 to 31
scrap), growth choices, ammunition/reload and the visible next-floor button. This is
an automated input proof, not a human pacing/playability study. The second floor
loaded paused with 24 cumulative kills and the purchased build intact.

The final art-only adjustment moves the supply store/canopy/pump behind the road;
these three nodes have no gameplay components/colliders. Its framing was inspected
again in the final scene. The later LOD projection correction was typechecked, built
and exercised in the final Play/Stop check; the recorded complete run predates those
last presentation changes.

All three scenes loaded with zero pending assets and 63/56/50 objects. All sixteen
external third-floor placements had textures and their expected LOD triangle counts
(including P-31 at 20k). Final Play/Stop registered and disposed all three session
resources, left zero pending, restored the saved editor camera and author panels,
and left the scene clean with 63 objects. Final console warning/error snapshot was
empty. The open editor is framed on the first-floor overview using an inspection
camera only; its saved scene camera was not overwritten.

Evidence:

- [Full first-floor input log](evidence/scene-art-pass-2026-10-04/floor1-input-proof.json)
- [Floor-one completion](evidence/scene-art-pass-2026-10-04/floor1-clear.png)
- [Final first-floor overview](evidence/scene-art-pass-2026-10-04/floor1-overview.png)
- [Final game entry](evidence/scene-art-pass-2026-10-04/floor1-entry.png)
- [Floor-two carry-over](evidence/scene-art-pass-2026-10-04/floor2-load.png)
- [Floor-three placement](evidence/scene-art-pass-2026-10-04/floor3-load.png)

Regeneration was verified byte-idempotent for all three campaign scenes. The service
is the existing detached HTTPS editor on port 5100 in the `scene-game-refine`
worktree, PID 35172 when last checked, with logs at
`.workbuddy/tmp/author-loop-merged-vite.out.log` and `.err.log`. Recheck command line
and working-directory ownership before using `Stop-Process -Id 35172`.

## Remaining boundaries

Character rig/animation production, advanced shadows, mobile profiling, automatic
environment LOD selection, and equivalent art refinement of floors two/three remain
separate work. This pass does not claim complete visual parity with every concept
board or full-game design acceptance.
