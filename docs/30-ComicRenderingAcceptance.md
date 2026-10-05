# Comic rendering and scene atmosphere — 2026-10-05

This delivery adds a shared comic rendering foundation to the three authored campaign scenes. It does not claim pixel equivalence to the illustrated design board or completion of character animation production.

## Reference and acceptance target

Reference: [Ardot gameplay / combat HUD, node 2:74](https://ardot.tencent.com/file/720788949675822?node_id=2%3A74), observed in the user-provided Chrome tab. Its common art language combines dark ink, restrained background detail, warm danger colors, cyan utility accents, purple UI panels and layered urban scenery. The illustrated shoulder-level camera is not copied: the local GDD specifies a god-view camera, and the levels retain separate gameplay rules.

| Dimension | Previous runtime | Delivered change | Remaining design distance |
| --- | --- | --- | --- |
| Color | AgX processed linear input without logarithmic exposure encoding; midtone grading read zero padding as saturation | Correct AgX exposure/linearization and midtone uniform indexing; exact display-space ink exemption | Texture palettes still vary between existing asset families |
| NPC materials | Animated batches used uniform proxy colors | Existing GLB albedo sampled in instanced rendering, with white fallback and owned GPU texture destruction | Existing rigs, silhouettes and motion quality are retained |
| Background | Empty colored areas beyond roads | Scene-referenced two-row industrial skyline, continuous road underlays and low-noise atlases in all three levels | Procedural scenery is less detailed than the painted reference |
| Sky | No authored sky rendering | Camera-centred directional sky, gradient, painted cloud bands and sun, controlled by scene data | Normal god-view gameplay mostly sees architecture/ground; sky is visible from lower inspection angles |
| Grounding | Weak actor/prop contact | Derived contact ellipses from authored transforms and runtime instances | These are contact shadows, not occluding directional shadow maps |
| Texture stability | Single-level albedo textures | Generated mip chains and 8x anisotropic sampling on static and dynamic albedo | No full-frame temporal antialiasing |
| HUD | Compact debug-like panels | Ink-bordered life/status/ammo panels and a live 20-metre enemy radar | Portrait artwork, illustrated action controls and cinematic effects remain outside this delivery |

## Ownership and persistence

- `packages/scene/src/document.ts` owns schema 9 sky/comic fields and diagnostics. Migration 8→9 preserves legacy appearance without inventing atmosphere. All nine checked-in scenes are migrated.
- `AtmospherePanel` owns drafts only. `SpawnEditStore` owns validated commands and undo/redo. `AuthorSceneSaver` owns allowed paths, conflict checks and file persistence. Discarding drafts during scene replacement clears both atmosphere and node forms.
- Scene JSON owns all art settings and backdrop placements. Backdrop geometry is generated offline from `assets/environment/backdrops/industrial-quarter.json`; scenes reference GLB paths and GUIDs. No new world props are hardcoded in the renderer.
- `RendererCore` owns sky/contact passes, albedo mip generation and dynamic texture lifetime. `SceneContacts` derives transient render data without mutating the scene.
- Campaign static object counts are 64 / 57 / 51. The first floor is at the current 64-object ceiling. NPCs remain instanced and do not consume static slots.
- No character model, rig, animation or binding sidecar was modified. H-01 remains the previously confirmed T-pose player asset.

## Actual validation

Environment: Windows, visible Chrome, HTTPS editor on port 5100, NVIDIA Lovelace WebGPU adapter. The user supplied a separate Ardot tab in the discoverable Chrome profile; this provides tab isolation, not proof of a separate OS profile. Other sessions' tabs were not operated.

- 164 relevant unit tests passed across scene migration/validation, contacts, actor/bridge behavior, environment history, save authority and HUD projection. After extending road assets to floors 2/3, the 31 level contract tests passed again.
- `pnpm run typecheck` and `pnpm run editor:build` passed. Vite retains its advisory about a bundle over 500 kB.
- `pnpm run scene:check` passed: 153 source hashes/metas, nine schema-9 scenes, 12 scene-file tests, 38 existing environment LOD families.
- Actual common WGSL compute probe passed black, neutrality, monotonic gray, middle-gray, highlight rolloff and RGB separation checks on NVIDIA. Post-render probe used production `packPost` and `POST_WGSL`: saturation 0 produced `[143,143,143]`; saturation 1 produced `[188,137,71]`; exempt ink produced `[20,17,15]`.
- Visible atmosphere path: invalid cloud coverage `1.2` rejected; `0.54→0.6` applied, saved through File menu and retained after reload with a clean document; restored `0.54` through the same save path. Tests also cover sky disable/re-enable and environment undo/redo.
- Visible draft navigation: edited the third-floor sky without Apply, selected floor 1, received the unsaved-change dialog, chose discard, and observed floor 1's `0.54` rather than the stale draft.
- Opened each floor through the scene browser, waited for zero pending assets, entered Play and paused for inspection. No new GPU/browser warning or error appeared in the final runs.
- Play/Stop check: dynamic mesh cache `4→0`; two actor textures had 13 mip levels; ledger `registered=3, disposed=3, pending=0` after Stop. Author camera and cloud coverage were restored. Aggregate cleanup explicitly destroys cached dynamic textures; author-mode contact buffers may be recreated for the editor frame.
- A temporary low-elevation editor camera exposed sky/clouds and the skyline, then was restored. It was not persisted as the game camera.

These checks do not constitute a full campaign playthrough, mobile-device performance certification, completed H-01 animation, directional shadow-map acceptance or final artistic parity with the concept illustration.

## Evidence

- [First-floor gameplay](evidence/comic-matching-2026-10-05/play-comic.png)
- [Sky inspection — temporary editor angle](evidence/comic-matching-2026-10-05/sky-inspection.png)
- [Second floor](evidence/comic-matching-2026-10-05/floor-2-comic.png)
- [Third floor](evidence/comic-matching-2026-10-05/floor-3-comic.png)
- [GPU probe results](evidence/comic-matching-2026-10-05/gpu-probes.json)
- Previous baseline: [H-01 gameplay](evidence/player-appearance-2026-10-05/play-overview.png).

AgX reference: [three.js tone-mapping shader](https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js).

## Automation boundary

The repository's current domain MCP is `tools/mcp-binding`, covering bone/skin authoring and sidecar persistence; its `render` tool produces binding projections, not a live game render. Scene file operations and runtime hooks already exist beneath the UI, but are not exposed as a scene-editing MCP tool family. Repeated state checks should use those interfaces; visible UI remains necessary for validating the real save/navigation path and final GPU appearance.

The initial scene MCP prototype is parked and pushed separately on `codex/editor-mcp-coverage` (`d5eed7a`). It is not part of this quality branch and is not a completed full-development MCP interface.

## Combat presentation follow-up

Actual shot events now draw ink-edged tracers, a short origin flash and powder puff. Actual damage events draw a deterministic impact burst, rising damage amount and a separate kill caption. Presentation does not invent critical hits, change damage or own new gameplay entities. Event positions survive enemy despawn; old-run, future and invalid events are filtered. Pause uses the simulation clock. The overlay accounts for device pixel ratio, capped at 2.

Three focused combat/HUD tests, typecheck and editor build passed. In a separate visible Chrome tab on NVIDIA Lovelace, Play/pause followed by the existing runtime fire-input hook and one simulation step produced a real hit: tick 3, 12 damage, target HP 33. [The screenshot](evidence/comic-matching-2026-10-05/combat-ink.png) shows its tracer, flash and damage number. This is deterministic input-hook coverage with visible rendering, not a claim of a new keyboard-path or campaign acceptance run. Subsequent stepping advanced beyond the effect lifetime; enemy telegraph drawings remained valid. Stop hid the feedback canvas; no warning/error appeared in the captured console snapshot. The dedicated test tab was closed.

These effects are still Canvas illustrations. They do not claim shared-atlas GPU rendering or depth-occluded world particles. The requested asset-generation brief and future atlas layout are in [the art handoff](31-美漫画风资产需求与生成提示词.md).
