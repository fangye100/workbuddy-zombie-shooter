# Gameplay development: contracts, workflow and agent entry points

## Current ownership and knowledge routing, 2026-10-09

Read the [shared documentation index](README.md), [layer contract](architecture/layers.md)
and [CodeGraph MCP guide](knowledge/codegraph.md) for current owners and discovery.
Scene schema is now v15 after the [branch integration](review/branch-integration-2026-10-09.md).
Zombie simulation, progression and audio-event projection live in
`packages/zombie-game/src`; HUD/input/audio rendering in its `presentation` directory.
Generic author commands, weapons and collision remain `packages/runtime`.
Paths and v14 acceptance claims in the original report below describe its
recorded revision; they are not the current source layout or a new acceptance run.

This is the current development entry point for the scene-quality branch, through the weapon and audio integration delivered on 2026-10-07. It connects the implementation contracts to a repeatable authoring and acceptance process. Specialized reports retain their own dates, revisions and evidence; their historical test counts are not results of a new run. Current source and project rules take precedence over older notes.

## Responsibilities and sources of truth

| Area | Durable authority | Execution owner / technical rule |
|---|---|---|
| Scene selection and content | `aether.project.json`, registered `assets/scenes/**`, `packages/scene/src/document.ts` | The editor reads and writes scene files. Stable NodeId references, complete components and AssetRef path/GUID pairs survive reload. Schema v14 is the current documented baseline; discover the actual loaded version with `scene_get`. |
| Authoring, history and save | `SpawnEditStore`, author commands, `author-scene-save.ts` | UI and MCP share one author store/history. Disk conflicts are explicit. A dirty form is distinct from a committed author edit. |
| Environment and material overrides | Scene environment and Mesh components; project material library | Tune a reproducible game-camera composition. Renderer objects are projections, never the durable author state. |
| Art and LOD derivatives | `assets/art/sources/**`, runtime GLBs, sidecars and build manifests | Preserve the source, normalization recipe, hashes and GUIDs. Each LOD derives from the original, preserving UV/straight structural features. |
| NPC attacks and timing | Scene gameplay components and character definitions | `RuntimeSession` / enemy attack logic own range eligibility, attack tokens, seeded independent timing, damage and attack effects. Presentation consumes actual accepted state. |
| Weapon definitions | Scene `RunRules.arsenal`; schema in `packages/scene/src/weapons.ts` | `WeaponSystem` owns equipment, ammo, reload, upgrades and accepted action events. `WeaponCombat` implements hitscan, pellets, penetration, projectiles, melee and flame. |
| Weapon animation / future IK | Weapon presentation markers, animation selectors and procedural parameters | Accepted events drive animation hooks. Local primary/support grip, muzzle, magazine and chamber markers plus recoil/reload intent are consumer ports. HumanIK authoring/blending is a separate owner; these ports do not implement a solver. |
| Audio | Scene `RunRules.audio`; WAV AssetRefs and measured `.meta.json` | `AudioFramePlanner` projects accepted facts. `GameAudio` owns decoding, mix, voices and cleanup. It must not mutate combat, replace weapon hooks or consume gameplay RNG. |
| Controls and HUD | Game controls, game language and HUD services | Desktop mouse/keyboard and touch controls use the same runtime actions. English/Chinese labels exist; phone emulation is only layout evidence. |
| Play lifetime | `PlaySession` / `PlayController` and their resource ledger | Snapshot author data before Play; run a runtime copy. Stop rolls back author state and releases registered Play resources, including audio. |
| Game Editor MCP | `tools/mcp-editor`, live `EditorAgent` dispatcher | Stdio → loopback broker → explicitly selected browser instance → existing business services. No second scene store, simulation, DOM-click engine or arbitrary code evaluation. |

## Main techniques and their failure boundaries

**Composition and materials.** Establish the player, readable threats and traversable lane before decorative detail. Inspect entry, middle and end-room views using the game camera; an attractive orbit view can hide missing street/background surfaces. Use near/middle/far silhouette and value separation, continuous street/apron coverage, matte building overrides, restrained comic ink and coherent warm/cool light. Keep semantic room/navigation nodes separate from decorative batching. Static capacity remains 64 meshes; do not route hot NPC populations through that path. Diagnose linear/sRGB transfer, tone mapping and uniform packing before compensating with extreme texture colors or exposure. See [visual playbook](art/visual-quality-playbook.md) and [street/LOD report](36-StreetQualityAndArchitecturalLOD.md).

**Architectural LOD.** Bake the glTF hierarchy before axis correction. Build levels independently from the original with UV-aware simplification and protected boundaries/planes. Restrict vertex relocation to avoid invented roof folds; do not treat a triangle target as a quality goal when it destroys structural lines. Check displaced parallel planes as well as normals: an apparently parallel roof may have moved. Inspect textured roof/facade transitions in the actual headed Asset Browser and game camera. Numeric plane/UV statistics are diagnostics, not visual approval. Keep accepted placeholder paths and GUIDs when replacing them.

**Population and attack readability.** Increasing counts needs attack distance gates and concurrency control, not simultaneous windup by every nearby NPC. Use seeded per-entity variation for decisions, windup, recovery and cooldown, while keeping damage/death immediate. Gameplay shows attack warning, travel/contact and persistent effect as appropriate; attack-range rings belong to debugging. Persist acid pools independently of shooter death/slot reuse. Preserve distinct floor objectives despite a shared art language. See [combat/input report](37-CombatInputAndPopulationQuality.md).

**Weapon abstraction.** Add definitions and concrete combat behavior without duplicating ammo or timers in renderers. A rejected shot must not emit firing animation, recoil or sound. Hooks receive copied accepted events and local markers; observer failure cannot roll back combat. Reload stages and normalized animation phase support future procedural hand motion. Rebind consumers after reset because it constructs a new weapon owner. Resource placeholders are explicit and valid; the current procedural presenter does not load arbitrary weapon model AssetRefs. See [weapon contract and hook guide](39-Unified-weapons-and-animation-hooks.md).

**Audio intake and playback.** Import isolated takes rather than recutting the preview reel. Validate inventory, unique take hashes, format, onset/headroom and loop sample indices. Use process-stable synthesis seeds, correct loop crossfade direction, filtering before loop closure and valid RIFF padding. Scene-owned mappings bind sounds to accepted shots, contacts and NPC attack entries. Bounded voices/decode memory, priority, distance attenuation and a quiet ambience bed make horde playback inspectable. Pause/hidden/mute/terminal states remove voices; Stop rejects late decodes and clears buffers. Browser AudioContext still needs a trusted user gesture. Source-start counters do not prove perceived sound quality. See [audio integration](42-GameplayAudioIntegration.md) and [SFX request list](40-GameplayAudioAssetBrief.md).

## Repeatable development and delivery process

1. **Establish the baseline.** Inspect branch, upstream and existing dirt; preserve other sessions' work. Read current project rules and relevant design/evidence. For integrations, fetch and verify ancestry before saying a feature is merged. Identify owners and acceptance criteria before crossing scene/runtime/presentation contracts. Do not replace another session's service or take over rig/IK assets.
2. **Make the data contract first.** A new scene semantic starts in `packages/scene/src/document.ts` or its dedicated schema module, with validation and migration tests. Each schema increment needs its migration link. Register new scenes transactionally. Missing optional resources remain explicit placeholders or diagnostics, rather than invented finished assets.
3. **Implement at the existing owner.** Runtime decides accepted gameplay facts; presentation/audio consume them. Author commands update the shared store and history. Avoid independently cached ammo, scene copies, clocks or duplicate random streams. Carry/save/reset must preserve their documented invariants.
4. **Complete authoring persistence.** Edit → validate → save → reopen → compare changed fields on disk and in the loaded author document. Check both rejected edits and conflicts. Never serialize runtime QA fixtures or GPU objects into a scene. Stop Play before writing author content.
5. **Validate according to the change.** Run related CPU/contract tests, typecheck and the affected build. Changed `assets/**` requires `scene:check`; new/changed GLBs require merging sidecar generation without overwriting rig/bindings/user data. Roster changes additionally require content generation/checking. Real rendering changes require headed hardware-GPU comparisons; follow browser/GPU rules before connecting or probing the dev service.
6. **Exercise the reachable product path.** Use visible Open/Save/Play controls, actual mouse/keyboard/touch events and a trusted audio-ready gesture where relevant. Inspect live attacks, weapon action/ammo/VFX, audio/mute/pause and Stop cleanup. MCP single steps and injected QA fixtures establish narrow logic coverage, not full user-path or campaign acceptance. Restore temporary fixtures and authored settings.
7. **Record and deliver.** Store revision, adapter/viewport, changed data, observations, fixture boundaries and unresolved acceptance next to evidence. Update the relevant guide and MCP contract when the workflow changes. Precisely stage owned files; commit with a conventional Chinese message and immediately push to the correct SSH origin. A PR, if requested, follows the user-required `pr-bot-review` process; passing checks alone do not authorize or prove artistic acceptance.

Typical checks (choose the affected subset; these are commands, not a claim of a fresh full run):

```powershell
node --test tools/mcp-editor/*.test.mjs
pnpm exec vitest run apps/editor/test/editor-agent.test.ts apps/editor/test/weapon-diagnostics.test.ts --no-file-parallelism
pnpm exec vitest run packages/runtime/test/weapons.test.ts packages/runtime/test/audio-frame.test.ts apps/editor/test/game-audio.test.ts --no-file-parallelism
python -m unittest tools/audio/test_audio.py
pnpm run typecheck
pnpm run editor:build
pnpm run scene:check
```

Art authoring scripts are in `tools/art/`; the architectural build is `tools/art/build-p0-lods.py`. Audio synthesis, intake and checking are in `tools/audio/`. Review their arguments and affected outputs before running generation/publish; these scripts can rewrite runtime assets or all campaign scenes. Checking is distinct from regeneration.

## Agent workflow through the current MCP

Read [transport setup, schemas and examples](../tools/mcp-editor/README.md). Normal sessions remain opt-in: Vite needs `AETHER_EDITOR_MCP=1`, the deliberately selected tab needs `agent=1`, and client registration is separate. Fixed editor/game ports remain 5100/5101.

1. Call **`editor_workflow`** without an instance to discover this guide, source paths, stage tools, failure recovery and coverage gaps. The broker must be running, but a browser instance is not required.
2. Call **`editor_instances`**; select the exact intended instance UUID. Then **`scene_list`** and **`scene_get`** give registered paths, the complete author document, schema version and `state.revision`. Never select the first arbitrary tab.
3. Build a complete node from the freshly read document. For material, `RunRules.arsenal` or `RunRules.audio` edits, change only the desired component fields and pass the full node to **`scene_edit_nodes`** (`replace`, stable `nodeId`). For atmosphere changes, preserve the complete environment and call **`scene_set_environment`**. Every mutation includes `expectedRevision`; use the returned current revision for the next call. Creation registers a file but does not switch scenes.
4. Call **`scene_validate`**, **`scene_save`**, **`scene_open`** with the saved path, then **`scene_get`** and compare authored fields. This is the persisted roundtrip. Generic node replacement does not offer dedicated weapon/audio form editing or asset search.
5. **`editor_play`** starts paused; `resume`, `pause`, deterministic `step` (1–600) and `stop` delegate to PlayController. **`editor_runtime`** reports actual tick/player/NPC/ledger, `weapons` (null when stopped) and `audio` lifecycle/mix counters. Weapon facts include ammo per ID, action/phase, local markers, recoil/reload intent, latest 16 accepted events, hook errors and current effect count. No call here equips/fires a weapon or bypasses autoplay.
6. **`editor_capture`** captures a rendered GPU canvas frame only. DOM HUD/input and listening acceptance need their own user-path evidence. Stop and inspect the ledger, author state and audio buffers/voices before finishing.

On stale revision, reread and rebase; on human drafts, coordinate apply/discard; on Play locks, Stop first. On disk conflict, preserve local changes and inspect disk. On projection error or timeout, inspect the returned/current revision before retrying: an author edit may already have executed. Rediscover disconnected instances rather than substituting another tab. See MCP workflow discovery for the exact structured recovery map.

## Evidence and open acceptance

Existing reports establish specific observed results: [street material Edit → Save → Reload and LOD comparisons](36-StreetQualityAndArchitecturalLOD.md), [NPC/input checks](37-CombatInputAndPopulationQuality.md), [weapon combat/input/hook checks](39-Unified-weapons-and-animation-hooks.md), and [22-take audio playback/cleanup checks](42-GameplayAudioIntegration.md). These are historical evidence, not a rerun caused by this documentation update. None establishes complete concept-art matching, full-campaign correctness or sustained phone performance.

Remaining work includes in-game human listening feedback; dedicated missing SFX and final weapon/animation resources; BGM/VO intake; HumanIK consumption/blending of weapon ports; and full agent-friendly asset/component discovery, dedicated semantic authoring, reconnect/race hardening and client setup. That broader MCP coverage remains a separate development scope. WorkBuddy's untracked `docs/41` and delivery folders retain their original ownership; this guide does not approve or commit those deliveries.

The 2026-10-08 documentation/MCP update passed six Node transport/workflow tests, ten tests across editor-agent, weapon diagnostics and game audio, TypeScript checking, editor production build and 19 local document-link checks. The stdio test uses a real adapter process and controlled loopback broker without a browser. No assets, schemas, rendering or gameplay behavior changed, so this update does not add fresh GPU/visual/listening acceptance. Existing Vite CJS and chunk-size warnings remain.
