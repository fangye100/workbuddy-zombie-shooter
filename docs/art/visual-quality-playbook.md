# Visual quality playbook — comic zombie game

Distilled from the scene-quality work of 2026-10-04–05. This is the reusable project knowledge entry; delivery reports retain the revision-specific results. Implementation statements below describe the quality branch through `e3bc6c4`, not an assertion that the branch has merged or that artistic matching is complete. Current project rules and source contracts take precedence over historical notes.

## 1. Match an art language before adding detail

The reviewed gameplay reference combines dark ink, restrained background detail, warm danger colors, cyan utility accents, purple UI panels and layered urban scenery. Levels keep their different gameplay rules while sharing this language. Keep the local GDD's god-view camera: copying the illustration's shoulder-level framing would change the gameplay contract.

Use this refinement order:

1. Lock a reproducible gameplay view and identify the player, threats, traversable lane and interaction targets.
2. Establish large silhouettes and near/middle/far value separation. Fill missing background planes before spending effort on small surface marks.
3. Align the key light, cool fill, material palette and tone mapping. Preserve visible shadow planes on characters and buildings.
4. Add grounded contact, restrained outlines and stable texture detail.
5. Add readable, event-driven combat accents. Recheck the scene during movement and combat, not only when empty.

A high-angle game view exposes roofs and ground more than façades. Request complete roofs, parapets, setbacks and awnings from asset generation. Prefer large hand-painted patches and structural lines over dense scan noise. Source previews need to survive the actual toon shader, exposure and projected size.

**Observed composition correction:** the supply store/canopy/pump blocked the playable road from the game camera. Moving these decorative pieces behind the road improved interaction visibility without moving gameplay nodes. Likewise, the deep P0 skyline was placed behind the playable space. Increasing detail on an occluding foreground roof would not solve this problem.

Treat procedural geometry as useful for composition, repeatable roads, broad silhouettes and explicitly tracked missing assets. Distinctive middle-distance architecture benefits from authored source assets. Neither provenance automatically establishes final quality.

Sources: [art brief](../31-美漫画风资产需求与生成提示词.md), [scene pass](../28-EnvironmentSceneQualityPass.md), [reference comparison](../30-ComicRenderingAcceptance.md).

## 2. Diagnose rendering before repainting assets

### Color and uniform contracts

The session found two defects that could make good source textures look wrong:

- AgX received linear values without the required logarithmic exposure encoding. The current implementation transforms to its working space, encodes exposure, applies the contrast curve and returns linear sRGB; the post pass applies the display transfer once.
- Post saturation read padding rather than the packed value. The current saturation field is float 10, `midG.z`; `midG.y` is padding. A correct-looking CPU parameter object does not prove the shader reads that parameter.

For regressions, use the production packer and shader together. Probe black, neutral gray, monotonic brightness, middle gray, highlight rolloff and RGB separation on the real adapter. Check saturation zero and one, plus the explicit display-space ink exemption. These narrow probes isolate color math from scene composition; they complement the visible scene comparison.

Do not compensate for a broken transfer function with extreme exposure or painted textures. First establish where sRGB decoding, linear lighting, tone mapping and display encoding happen. Keep ink dark without crushing all material shadow detail.

Source: [common shader](../../packages/render/src/shaders/common.wgsl.ts), [post shader](../../packages/render/src/shaders/post.wgsl.ts), [uniform packing](../../packages/render/src/frame-uniforms.ts), [recorded GPU probes](../evidence/comic-matching-2026-10-05/gpu-probes.json).

### Light, line and grounding

- Keep key-light direction sufficiently distinct from the view direction to reveal form. Under a steep camera, compare a lower side key against a high frontal key before increasing global contrast. Light settings belong to scene data; no single intensity is a universal art rule.
- Tune background line weight at its actual screen size. Tiny reconstructed facets can produce excessive black noise with strong outlines. Reduce per-material outline strength for distant scenery when this occurs.
- Current contact ellipses provide grounding for props and actors. They are not directional shadow maps and cannot establish whether a roof truly occludes light.
- In the current static shader, `unlit` bypasses key-light quantization but still receives key multiplication and additive lighting terms. It is not a reliable lighting-independent diagnostic mode. Switching it on will not repair stretched UVs.

Source: [scene shader](../../packages/render/src/shaders/scene.wgsl.ts), [contact pass](../../packages/render/src/contact-shadows.ts), [scene contact projection](../../apps/editor/src/services/scene-contacts.ts).

### Static and animated materials must both work

The animated batches previously used proxy colors while static models displayed textures. BaseColor has to reach the instanced actor path, including its binding and lifetime, for the art direction to be consistent. A textured Asset Browser preview alone cannot prove this.

Generated albedo mip chains and anisotropic sampling reduce distant shimmer on both paths. Check texture stability while moving, and check owned texture destruction on replacement and Stop. Do not copy these opaque-albedo assumptions blindly into transparent VFX.

Source: [albedo texture creation](../../packages/render/src/albedo-texture.ts), [dynamic shader](../../packages/render/src/shaders/dynamic.wgsl.ts), [renderer ownership](../../packages/render/src/renderer-core.ts).

## 3. Convert generated sources into usable assets

### Normalize once, with an explicit recipe

Keep the untouched source, extracted BaseColor, preview and provenance separate from runtime derivatives. A roughly 500k-triangle generated source is not a suitable runtime LOD0 merely because it has that filename. P0 runtime LOD0 is itself an optimized derivative.

Apply the glTF node hierarchy transforms before judging up-axis. The P0 raw vertex arrays looked Z-up, but their node rotation already produced Y-up. A second correction would rotate a valid building onto its side. Preserve uniform proportions; use a ground-centred building pivot and a documented grip/forward convention for weapons. Do not apply character-height normalization to buildings.

Dimension notation also matters: the generation brief uses W×D×H = X×Z×Y, whereas a GLB bounds vector is X/Y/Z. Gallery presentation scale is separate from the physical dimensions of the asset.

### Generate each LOD from the same original

Use texture-aware simplification and preserve UV seams. Positions shared across different UV islands are not interchangeable. Generate each level independently from the original rather than repeatedly decimating the previous level. Record source hash, normalization recipe, target, output hash and measured results so stale output is detectable.

The current P0 pipeline checks:

| Gate | P0 threshold | What it cannot establish |
|---|---|---|
| Position/UV validity | Finite attributes | Artistic surface quality |
| Surface area | 90–110% of source | Local window/roof distortion |
| Bounds drift | At most 5% | Correct silhouette at every angle |
| Triangle target | Within 5% | Frame time on a target device |
| Topology | No added boundary/nonmanifold counts relative to welded source | Repair of defects already present in the source |

These are the implemented P0 gates, not universal thresholds for every future asset class. Stage outputs before publishing. Publishing validates recipe/source/output hashes and numerical gates; **it does not enforce visual acceptance**. Regeneration marks visual review pending.

**Counterexample worth retaining:** FAR-01 at 6k triangles passed numerical gates but stretched window textures into triangular shapes in the scene. Increasing the family to 20k/14k/10k and placing its 14k LOD1 improved the inspected result. Reducing outline strength or changing lighting could not repair that underlying UV loss. Do not weaken the geometric gate simply to satisfy the original face budget; revise the recipe and measure performance separately.

Inspect all levels side by side, then inspect the chosen level from the game camera, close enough to expose UV damage and far enough to judge silhouette/noise. Generating three files does not implement automatic distance switching, streaming or a mobile performance budget. Environment placements currently choose explicit LOD references.

Source: [P0 builder](../../tools/art/build-p0-lods.py), [intake recipe](../../assets/art/p0-intake.json), [intake report and final budgets](../32-P0-asset-intake-2026-10-05.md), [comparison gallery](../evidence/p0-art-intake-2026-10-05/lod-gallery.png).

## 4. Keep visual refinement editable and replaceable

All placements, atmosphere and light parameters belong to scene JSON. Offline generators can author assets and scene data; rendering code consumes them. New semantics start in the scene schema, with migration and validation, before runtime/UI implementation. Use stable NodeIds and AssetRef path/GUID pairs; register scenes in the project container.

Placeholders should carry the same logical asset identity and replacement contract as the future source: metres, axes, pivot, stable paths/GUIDs, explicit status and visible hierarchy labels. P0 MID-03/FAR-02 have three identical cheap placeholder files, explicitly declared as such. This keeps references usable without claiming three separately simplified quality levels. Replace bytes and update metadata only after the final model is reviewed; preserve identity and placement.

Respect capacity while improving composition. Floor 1 had only 64 static slots: six decorative crosswalk strips were combined into one offline GLB, retaining the first node's identity and removing only redundant decorative nodes. This recovered five slots without raising the engine limit. Do not merge gameplay-semantic nodes merely to save draw slots. NPCs use the runtime instanced path.

Store reusable asset facts in sidecars and scene-specific decisions in scene files. Sidecar generation/annotation must merge existing data and retain GUIDs. Scene regeneration can replace authored content: inspect its diff before accepting it, especially after manual editor adjustments.

Source: [scene contract](../../packages/scene/src/document.ts), [placeholder builder](../../tools/art/build-p0-placeholders.mjs), [art authoring pass](../../tools/art/apply-p0-art.mjs), [metadata merge](../../tools/art/prepare-p0-meta.mjs), [gallery authoring](../../tools/art/build-p0-gallery.mjs).

## 5. Sky and background need both mapping and lifecycle

A seamless left/right edge does not make an image a true equirectangular panorama. SKY-01 is a painted cloud band. The current pass maps it over the upper hemisphere and fades its influence near the horizon/pole to conceal unsuitable regions. This is a deliberate presentation compromise, not reconstruction of missing panoramic information.

The sky is directional at infinity and consumes no static mesh slot. Keep blend, yaw and AssetRef in scene data; the editor camera only changes inspection. A downward gameplay camera can legitimately show little sky, so spend matching effort on the visible skyline and ground too. Do not replace the game camera just to produce a sky screenshot.

Async texture loading is part of quality: an old scene's decode must not overwrite the newly opened scene. The current loader validates path/GUID, uses a generation token to reject late results, closes decoded bitmaps, reports failures visibly and provides a procedural fallback. Replacing/clearing the GPU texture releases its allocation. Test these failure paths along with successful Apply → Save → Reload.

**Unit trap:** saved `editorCamera.elevation` is radians; the panel's `cameraElevation` is degrees. Entering `0.5` into the latter gives a near-horizon view, not about 29°. Use the existing conversion boundaries; keep author and gameplay camera state separate.

Source: [sky pass](../../packages/render/src/comic-sky.ts), [async loader](../../apps/editor/src/services/sky-texture.ts), [atmosphere authoring](../../apps/editor/src/services/atmosphere-panel.ts), [camera conversions](../../apps/editor/src/main.ts).

## 6. Comic feedback and shared atlases

Current combat ink follows actual shot/damage events: tracers, origin flash, powder, impact burst, damage numbers and kill captions. Presentation does not create damage or invent critical hits. Preserve event positions after entity removal, filter obsolete runs, and use simulation time so pause freezes feedback consistently. The implemented feedback is Canvas-based, not depth-occluded GPU particles.

For a future atlas, require a manifest with effect IDs, frame counts/timing, pixel rectangles, normalized UV offsets/scales, pivots and alpha convention. Validate the bytes against that manifest instead of trusting a delivery summary: the P0 delivery actually contains 23 effect IDs in 64 cells, despite its summary saying 16.

Transparent backgrounds need visual inspection on light and dark surfaces. Check for fake checkerboards, rectangular residue, clipped smoke and thin lines lost during extraction. Single-frame scale/rotation/fade variants are not independently illustrated animation frames. Review the moving sequence, not only an atlas contact sheet.

The delivered atlas remains quarantined because of residue and cell-edge clipping. Before GPU integration, the recommended next steps are to repair alpha, provide appropriate RGB bleed/padding, choose a consistent straight/premultiplied-alpha pipeline and validate minification/mip sampling without adjacent-cell leakage. **These repairs and the shared GPU-atlas renderer are not completed in this session.**

A shared texture can reduce texture changes. Draw-call reduction additionally requires compatible pipeline/blend/depth state and batching or instancing; merely sampling different UV offsets does not automatically batch separate draws.

Source: [combat ink](../../apps/editor/src/services/combat-ink.ts), [requested atlas contract](comic-vfx-atlas-v1.json), [actual delivered layout](../../assets/art/textures/VFX-ATLAS-01/delivered-layout.json), [intake disposition](../32-P0-asset-intake-2026-10-05.md).

## 7. Troubleshooting map

| Symptom | First discriminating check | Direction supported by this session |
|---|---|---|
| Everything looks washed out or unexpectedly gray | Production post packing plus gray/color probes | Fix transfer/offset errors before retuning assets |
| Static preview is textured, animated enemy is flat | Inspect the dynamic material/texture binding | Carry BaseColor through the instanced path |
| Distant buildings sparkle or turn black | Compare mip usage, outline strength and projected size | Stabilize texture sampling and reduce line noise |
| Windows become triangles after optimization | Compare textured source and LOD under identical light | Preserve UVs or raise the simplification target |
| Building lies sideways or changes size between LODs | Evaluate node transforms and normalization recipe | Normalize once; preserve metres, pivot and proportions |
| Decorative asset hides a supply interaction | Inspect from the actual game camera | Reposition scenery while preserving gameplay semantics |
| Sky is acceptable at horizon but stretches overhead | Check source projection and poles | Use documented fade/mapping compromise or better source |
| Wrong sky appears after switching scenes | Delay an earlier decode intentionally | Reject stale completion and dispose its bitmap |
| Atlas has boxes/halos or clipped motion | Inspect alpha on contrasting backgrounds and animate | Quarantine; repair extraction/padding before integration |

## 8. Acceptance and evidence discipline

For each refinement, record the revision, scene, selected asset/LOD, game camera, viewport/DPR/render scale, relevant lighting/exposure and runtime state. Compare the same framing; change one suspected cause at a time. A temporary inspection camera is useful evidence but must be labelled and restored.

Use four distinct checks:

1. **Data:** scene/sidecar GUIDs, schema/migrations, source and derived hashes, references and capacity. Run `pnpm run scene:check` after asset or scene changes. Never regenerate metadata to hide unsmudged LFS pointer files.
2. **Behavior:** relevant tests for author commands, persistence, async failure and resource ownership. Build/typecheck establish compilation, not appearance.
3. **Visible authoring:** open the intended scene, wait for actual asset completion, edit/apply/save/reload, inspect invalid references, and verify Play/Stop restores author state. A direct input hook proves that hook's behavior, not an untested keyboard/menu path.
4. **Real GPU appearance:** use the required headed browser, verify secure context and actual hardware adapter, inspect gameplay and comparison views, and check GPU/browser errors. Follow current browser/GPU rules rather than copying historical launch flags. A clean console is necessary evidence, not artistic acceptance by itself.

A desktop FPS spot sample is not sustained/mobile performance certification. A previous full-level run cannot automatically certify later art changes. Keep each claim attached to its tested revision and distinguish level completion, loading/rollback, visual quality and target-device performance.

### Evidence and remaining work

- [Environment pass](../28-EnvironmentSceneQualityPass.md): composition changes, placement mapping and the earlier full first-floor input run.
- [Player appearance](../29-PlayerAppearanceAcceptance.md): existing H-01 presentation scope.
- [Comic rendering](../30-ComicRenderingAcceptance.md): color probes, dynamic textures, sky/contact foundation, actual validation and combat-feedback limitations.
- [P0 intake](../32-P0-asset-intake-2026-10-05.md): current asset budgets, gallery, sky persistence/failure evidence and Play/Stop scope.

As of the documented revision, final MID-03/FAR-02 models, atlas repair/GPU integration, player weapon attachment, mobile profiling and further design matching remain open. The pistol is available in the gallery/asset browser; that is not a completed player-weapon integration. Full editor MCP coverage remains separate development work.

## 9. Architectural LOD and continuous streets — 2026-10-07 update

MID-03/FAR-02 have now arrived, together with MID-04/05/06. See the
[street quality delivery](../36-StreetQualityAndArchitecturalLOD.md) for the new
budgets, scene counts and revision-specific evidence; the earlier numbers above
remain historical rather than current acceptance claims.

- For buildings, compare endpoint-preserving textured QEM against unconstrained
  vertex relocation. Preserve normals, boundaries and UV seams, enable planar
  quadrics, and raise roof/window/bridge budgets before accepting visible folds.
  None of these options guarantees a straight source or a perfect simplification.
- Global area/bounds checks can miss a locally folded roof. Compare local output
  normals and offsets against coherent source planes. Report the qualifying coverage;
  noisy generated surfaces may make the metric inconclusive. Do not turn insufficient
  coverage into an automatic artistic pass, or classify intentional gables/damage as
  invented slopes. Keep textured near views and the actual gameplay view as separate
  acceptance checks.
- Batch only decorations whose identities are not referenced and whose transforms
  the authoring tool can correctly bake. Keep gameplay nodes separate, preserve the
  retained NodeId and reject unsupported parent scale/rotation instead of guessing.
- Check the importer's pivot contract. This project's GLB parser recenters X/Z and
  grounds Y even when scale normalization is disabled. A world-space baked street
  batch therefore needs its original center/minimum restored in the scene transform.
  Otherwise a valid GLB can shift curbs or bury road paint.
- Replace disconnected road/walk fragments with continuous authored surfaces and
  extend the apron beneath the skyline. A repeated building does not conceal a ground
  plane that ends before its base. Judge near/middle/far coverage from the whole
  playable street, including entry, supply area and last-room viewpoints.
- After merging animation work, explicit scene regeneration must retain the latest
  player's rig, shared-motion library and game camera. Verify those actual components
  before and after regeneration; an assertion on a missing node proves nothing.
