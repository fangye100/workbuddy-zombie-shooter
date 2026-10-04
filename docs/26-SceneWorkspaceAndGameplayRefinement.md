# Scene workspace and gameplay refinement — acceptance record

## Delivery status (2026-10-04)

The scene workspace and the new three-floor progression loop have passed the scoped checks below. This is a substantial playable refinement, not a claim that every feature or illustration in the full GDD is finished. Character asset production remains outside this task. The original checkout and its in-progress changes were preserved; implementation lives on `codex/scene-game-refine`, based on `origin/main` at `5aade8f`.

Sources actually inspected: `docs/13-玩法与关卡设计GDD.md`, local S-01, P-11 and S-02 concept images, `assets/environment/props.json`, and the authenticated Ardot design in the user's existing Chrome profile: https://ardot.tencent.com/file/720788949675822?node_id=0%3A1 . The nine boards cover the menu, battle, three-choice upgrades, supply, settlement, elite encounters, low-health combat, ultimate and loot.

## Delivered behavior and ownership

| Owner | Result |
| --- | --- |
| EditorMenu / scene-workspace | File, Edit, Scene, Rendering, Asset, Run and View; searchable project scene picker, create, duplicate, open, save and reload; explicit dirty-navigation choices and visible errors |
| devfs / AuthorSceneSaver / SpawnEditStore | Project registration, exclusive file creation, author command history and CAS save; supported transforms, spawns and environment fields persist without overwriting unrelated author data |
| SceneDocument / migrations | v7 RunRules stores economy, upgrade pool, ammo and Boss attack tuning; v6 stable clearTarget and editorOnly semantics retained; v6-to-v7 migration is opt-in and does not invent gameplay for older scenes |
| RuntimeSession / RunProgress | Actual damage, haste, leech, blast and speed effects; capped three-choice upgrades; kill/event rewards; paid healing, ammo and upgrades; finite magazine/reserve and timed reload; assisted aim with solid occlusion; Boss locked-position warning and damage |
| RunTransfer / RunProfile | Targeted tab-local cross-floor carry of HP, ammo, currency and stacks; malformed transfer errors preserve the source; cumulative essence credited once; permanent pool unlocks do not grant stat stacks; retry starts at the first campaign floor |
| RunHud / GameHud / RunSettlement | Choice pause, supply controls, currency/build/ammo feedback, ready-to-resume on scene entry, death/retry and settlement; narrow Play expands the game view and Stop restores author panels |
| CombatOverlay / RuntimeBridge / dynamic shader | Projected shot traces, hit/kill numbers, NPC windup arcs and Boss evacuation circles; hit flash and shared comic halftone treatment for existing runtime actors |
| Scene generation / asset loading | Continuous road, curbs/crosswalks and authored point/key/fill/rim lighting; corrected footprint axes; formal texture asset references; explicit sidecar up-axis handling instead of misclassifying wide buildings |
| Environment asset | Reproducible S-02 storefront based on the local concept: cream shell, charcoal roof, split red sign, yellow stripe, broken cyan panes, shelves and roof units; 1,138 triangles, six stable material primitives, LFS asset plus metadata |
| Rendering controls | Balanced raster budget with native-resolution opt-in in Rendering; CSS/UI stays at native resolution; FPS measurement uses wall time, independently of bounded simulation catch-up |

The authored floors use 62, 62 and 49 static objects respectively, below the 64-object limit. All scene asset references retain GUIDs. No character asset files were modified. Player presentation retains the existing capsule fallback where no compatible animated player asset is available; existing animated enemies and Boss assets are reused.

New gameplay rules are authored in scene JSON, not hidden UI state. Player saves are separate from scene authoring. Cross-floor reload restores the floor-entry checkpoint, not a mid-floor snapshot. Local profile storage is a single-browser prototype, not a server-backed or multi-tab transactional economy.

Scene creation rolls back ordinary registration failures, but is not crash-atomic across both files. A process interruption can still leave an unregistered scene requiring explicit recovery.

## Actual headed acceptance

The worktree ran on the authorized fixed HTTPS port 5100. Chrome reported a real NVIDIA Lovelace adapter, not SwiftShader. The browser was the user's existing profile. Native and 1000×720 layouts were exercised; temporary viewport overrides were reset.

Earlier scene-workspace acceptance remains valid: UI-created empty/duplicated scenes and project registration; edit/undo/redo/save/reload; all three dirty-navigation choices; a controlled CAS conflict preserving the dirty author document; visible empty-scene Play rejection; Chinese/English menus; pause/single-step/Stop and author-camera restoration. Temporary scenes were removed and the project restored exactly after those probes.

The new gameplay acceptance used a browser harness emitting WASD/J/E keyboard events and clicking the real choice/supply controls. Aim assist was enabled. It did not teleport entities, call applyDamage, or write HP/currency in the three-floor run. The final revised run produced:

| Floor | Simulation time | Cumulative kills | Result |
| --- | --- | --- | --- |
| 1 | 0:49 | 24 | All three rooms completed; event/supply used; HP restored before advancing |
| 2 | 0:31 | 51 | Carry restored, free and paid progression paths exercised across runs; elite objective completed; ammo carried forward |
| 3 | 1:22 | 66 | Boss and final wave defeated through real shooting; health and ammo remained; cumulative essence reached 30 |

The first ammo configuration was rejected after the Boss probe showed insufficient supply. Authored reserves and kill/supply ammo were adjusted, then the complete run above was repeated. This is automated input-path acceptance with a known kiting strategy, not human difficulty or 5–8 minute pacing acceptance. Choice/paused wall time is excluded from the simulation timer.

Additional checks:

- Boss warning locked its ground target, displayed an evacuation circle/countdown and allowed escape. Unit coverage separately verifies both escape and actual damage.
- Essence wallet moved from 50 to 35 on a single 15-essence unlock (the 50 included earlier test runs). The option joined the pool without granting a stack. Retry returned to floor 1 at full HP, zero kills/currency/stacks, retaining the unlock.
- A separate, explicitly controlled death-plus-pending-choice probe used direct runtime damage only to test the rare UI failure path. Death settlement remained visible, including at 1000×720. It is not part of the input playthrough evidence.
- Stop resource ledger: registered 3, disposed 3, pending 0.
- A regression first reproduced and then fixed the extra combat/movement tick after elite completion with surviving escorts.
- Narrow-window testing exposed settlement overlap; the final Play layout gives the game the full workspace and restores editing panels on Stop.
- Large-window browser timing included throttled frame intervals. Foreground samples reached 60 FPS; these observations are not a controlled performance benchmark. Reducing raster size must not be presented as proof that all timing stalls are GPU-bound.

Local evidence: `.workbuddy/tmp/refine-20261004/run-v2-floor1.json`, `run-v2-floor2.json`, `run-v2-floor3.json`, `run-v2-floor3.png`, `boss-danger.png`, `settlement-unlock.png`, `run-narrow-combat.png`, `death-pending-choice-1000.png`, and `keyboard-proof.js`. Earlier scene-management evidence remains in `.workbuddy/tmp/acceptance-20261004/`.

## Automated verification

- 651 tests passed across 36 relevant scene/runtime/editor suites.
- `pnpm run typecheck`: passed.
- `pnpm run scene:check`: 106 synchronized metadata records, eight schema-v7 scenes, 12 scene-file checks passed.
- `pnpm run editor:build`: passed; existing Vite CJS deprecation and large-chunk warnings remain.
- `git diff --check`: passed.

## Bot review adjudication

The installed `C:/Users/fangy/.codex/skills/pr-bot-review/SKILL.md` governs review handling. Older review results are not claimed as approval of the new implementation.

| Comment | Decision | Evidence / action |
| --- | --- | --- |
| 4175606600 | Accepted, previously fixed in f680baf | Shared interactionTarget predicate; trigger/live-enemy/repeat/reset/death regressions; reply 4175773960 |
| 4175606628 | Accepted, previously fixed in f680baf | Declared instance-base fallback plus warning, including nested overrides; reply 4175774034 |
| 4175606644 | Accepted, previously fixed in f680baf | Table/source scan instead of per-tick view allocation; reply 4175774097 |
| 4175606660 | Accepted, previously fixed in f680baf | Localized menus/dialogs and headed English check; reply 4175774156 |
| 4176052762 | Accepted | Settled Codex review on 5b81eb3, submitted 03:55:43 UTC: disabled/zero-count/unsupported-trigger elite targets made completion impossible. Loader now rejects these with E_CLEAR_TARGET_UNAVAILABLE; all three regression cases pass |

The original Copilot review 5403675361 explicitly used Balanced effort, against d86322f. The PR was observed OPEN and no longer draft on the latest check; no merge or latest-head approval is asserted here.

Implementation was committed and pushed as `9afa03bde82005e9241630b64ecd7f47a9a297a6`. Comment 4176052762 received reply 4176150362. A current-head Copilot request through `gh pr edit --add-reviewer '@copilot'` returned success, but produced no new request/review activity. At 04:34 UTC the authenticated PR UI explicitly showed **Monthly limit reached**, with Balanced selected. This is a concrete review quota blocker, not completed review. Evidence: `.workbuddy/tmp/refine-20261004/copilot-monthly-limit.png`. No duplicate request was submitted and the PR remains unmerged.

## Remaining design boundaries

The original wide brief is not reduced to these tests. Full illustration-level urban density/art polish, the entire GDD weapon/element/summon catalog, physical loot presentation, ultimate/death-replay features, and measured human pacing remain beyond this implementation. The current run includes five implemented numeric/mechanical upgrade effects and one permanent pool unlock. New RunRules tuning is JSON-authored; a dedicated rule inspector is not supplied. General structural authoring and all material-panel properties are not newly covered by the existing save whitelist.

Character asset production remains with its existing owner. These boundaries must remain visible in PR/release communication; neither a green unit suite nor a bot review establishes full visual-design parity.
