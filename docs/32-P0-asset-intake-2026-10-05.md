# P0 asset intake and scene integration — 2026-10-05

Historical intake record. MID-03/FAR-02 have since arrived with MID-04/05/06;
the [2026-10-07 street pass](36-StreetQualityAndArchitecturalLOD.md) records their
replacement, current architectural budgets and later validation.

## Delivered scope

The WorkBuddy delivery was read from `assets/_delivery/P0-20261005` in the original checkout. That directory and the separate character-production worktree were not modified. Source GLBs, embedded/extracted BaseColor images, previews, delivery manifests and reference images are retained under `assets/art/sources`. Runtime derivatives are under `assets/art/models`; all GLB/PNG files use Git LFS.

| Stable asset ID | Runtime LOD0 / LOD1 / LOD2 triangles | Runtime dimensions X / Y / Z (metres) | Texture |
|---|---:|---|---|
| ENV-MID-01 | 12,000 / 6,000 / 3,000 | 9.91 / 13.00 / 7.81 | 2048² |
| ENV-MID-02 | 14,000 / 10,000 / 8,000 | 12.00 / 11.04 / 11.88 | 2048² |
| ENV-FAR-01 | 20,000 / 14,000 / 10,000 | 64.00 / 26.80 / 46.52 | 1024² |
| WPN-01 | 3,000 / 1,500 / 650 | 0.046 / 0.195 / 0.280 | 1024² |
| ENV-MID-03 | 310 / 310 / 310 | Procedural garage placeholder | Palette |
| ENV-FAR-02 | 302 / 302 / 302 | Procedural industrial skyline placeholder | Palette |

The roughly 0.5-million-triangle deliveries are retained as **sources**, not loaded by gameplay. Runtime LOD0 is already an optimized derivative. Each real LOD is independently simplified from the original source with UV-aware QEM. Imported glTF node transforms already convert the raw source to Y-up; no second Z-up rotation is applied. Buildings retain uniform proportions and a ground-centred pivot; the pistol uses +Z forward and a grip-relative pivot.

The original lower targets failed the unchanged 90% surface-retention gate. A later close scene view exposed excessive skyline UV stretching at 6,000 triangles, so FAR-01 was raised again and Floor 1 uses its 14,000-triangle LOD1. The raised targets above are explicit in `assets/art/p0-intake.json` alongside the original requested targets. Accepted outputs retain 90.6–96.5% surface area and stay within 1.1% bounds drift; topology gates do not allow new boundary/nonmanifold counts relative to the welded source. This is geometric and desktop visual acceptance, **not a mobile performance certification**. The broad skyline is deeper than the original brief; it is placed entirely behind the playable road.

## Scene and authoring behavior

- Floor 1 now references MID-01, MID-02, FAR-01 and the two named placeholders with stable NodeIds and AssetRef GUIDs. A second FAR-01 instance continues the skyline. Existing gameplay nodes and prior environment families remain intact.
- Six zebra-stripe meshes become one authored GLB while retaining the first stripe's node identity and location. Floor 1 stays at **64 static meshes**.
- The two placeholders have explicit hierarchy labels, sidecar status, quota-block reason and replacement instructions. Their three files intentionally contain identical cheap geometry. They are not represented as accepted final artwork or as three independently simplified levels.
- `P0 · LOD 与占位资产验收` is registered in the project scene picker. It shows six rows and three LOD columns at a labelled uniform presentation scale. The pistol is available here and in the asset browser; **player hand attachment and weapon animation have not been integrated** in this change.
- SKY-01 is referenced by floors 1–3 through scene schema v10. Its source is a painted cloud band, not a true equirectangular panorama. The sky shader maps the band to the upper hemisphere and fades toward the poles and horizon; it does not claim to reconstruct physically correct panoramic content.
- The atmosphere panel exposes texture path/GUID, blend and azimuth. Apply, undo, save and reload use the existing authoring store. An invalid GUID produces an explicit visible diagnostic and procedural-sky fallback. Stale asynchronous decodes are closed without replacing the next scene's texture; clearing/replacing textures releases their GPU allocation.
- Scene generation includes the P0 authoring pass. Migration 9→10 preserves old presentation and does not invent texture references for old scenes.

## VFX intake disposition

The actual delivered atlas contains **23 effect IDs / 64 cells**, rather than the summary's “16 effects.” Its 4096² image and exact pixel/UV metadata are retained. Frame counts, unique cells, bounds and UV conversion pass automated checks.

It remains explicitly **quarantined** in its sidecar: explosion edges contain rectangular residue, later smoke frames clip against cell boundaries, and the sequences are affine variants of one drawing. It has not replaced the working combat feedback. Repair alpha/padding and review sequence motion before a shared GPU-atlas integration; inventory validation alone is not visual acceptance. No image-generation credits were spent in this intake.

## Reproduction and replacement

1. Use Python 3.12 with `pymeshlab==2025.7.post1`, `numpy==2.5.3`, `Pillow==12.3.0` and the Windows runtime dependency. This run used an isolated, ignored `.workbuddy/tmp/art-python` environment.
2. Run `python tools/art/build-p0-lods.py`. Inspect its staged reports. Run `--publish --only ENV-MID-01 ENV-MID-02 ENV-FAR-01 WPN-01` only for the reviewed source IDs; publishing checks source/recipe/output hashes and numeric gates. Re-generation resets visual status to pending.
3. Run `node tools/art/build-p0-placeholders.mjs`, then `pnpm run scene:gen`, then `node tools/art/prepare-p0-meta.mjs`. Metadata annotations merge into existing sidecars and preserve GUIDs.
4. Run `node tools/art/apply-p0-art.mjs` and, when deliberately rebuilding the comparison scene, `node tools/art/build-p0-gallery.mjs`. The latter is an authoring generator and replaces its gallery document.
5. Run `pnpm run scene:check`. The P0 hash/reference/atlas gate is included in this command.

When final MID-03/FAR-02 arrives, change its recipe status and processing parameters, build and review all three runtime LODs, replace the existing runtime files and preserve their sidecar GUIDs. Update the placeholder labels/status only after visual acceptance. Keep metre scale and pivots, so existing scene placement and references survive replacement.

## Actual validation

- TypeScript check and editor production build passed. The existing large-bundle warning remains.
- 59 targeted tests passed: schema/migration, environment editing, author save authority, and asynchronous sky-texture lifetime/failure paths.
- `scene:check` passed: 172 GLB sidecars synchronized, 10 registered scenes at schema v10, 12 scene-file tests, the existing 38-family LOD audit, and the new P0 gate.
- Headed Chrome on Windows: secure context, NVIDIA `lovelace` adapter, all 18 gallery models and Floor 1's new art references loaded; no shader/asset errors on successful loads.
- Visible UI: changed gallery sky azimuth 40→65, applied, saved via File menu, confirmed the on-disk value and loaded texture after reload. A deliberate `as_bad0000` GUID produced the visible mismatch/fallback diagnostic; UI Undo restored the original GUID and loaded GPU texture, with a clean authoring state.

Play/Stop was also exercised with the new Floor 1 assets: enemies loaded and stopping returned to a clean authoring scene. This was a loading/rollback check, not a full level-completion test.

Evidence: [Floor 1 overview](evidence/p0-art-intake-2026-10-05/floor1-art-overview.png), [Play check](evidence/p0-art-intake-2026-10-05/floor1-play.png), [LOD gallery](evidence/p0-art-intake-2026-10-05/lod-gallery.png), [weapon/placeholder detail](evidence/p0-art-intake-2026-10-05/weapon-lods.png), [GUID mismatch diagnostic](evidence/p0-art-intake-2026-10-05/sky-guid-diagnostic.png).

Open items are the two final quota-blocked models, VFX repair/integration, player weapon attachment, mobile profiling, and further art-direction matching. This intake does not claim that the entire game now matches the design.
