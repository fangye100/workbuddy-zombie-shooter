# Scene workspace and gameplay refinement — acceptance record

## Verdict (2026-10-04)

**The scene workspace workflow passed the scoped functional acceptance below. The requested comprehensive game-quality refinement has NOT passed acceptance. PR #22 remains a draft and must not be represented as a finished game or merged on the strength of unit tests alone.**

The branch is `codex/scene-game-refine`, based on `origin/main` at `5aade8f`. The original checkout and the ongoing character asset work were preserved. This work owns scene authoring, scene persistence, runtime room-completion semantics and their editor presentation; it does not own character asset production.

Design sources actually inspected: `docs/13-玩法与关卡设计GDD.md`, local environment concept references S-01/P-11, `assets/environment/props.json`, and the authenticated Ardot file https://ardot.tencent.com/file/720788949675822?node_id=0%3A1 in the user's Chrome profile. Its nine boards cover the main menu, battle HUD, three-choice upgrades, supply store, settlement, elite encounter, low-health swarm, ultimate skill and wave loot. The earlier Chrome/service access limitation is resolved and is not a current blocker.

## Implementation and data ownership

| Owner | Delivered behavior |
| --- | --- |
| EditorMenu / scene-workspace | File, Edit, Scene, Rendering, Asset, Run and View menus; searchable project scene picker; create, duplicate, reload and save; explicit URL selection with project startIndex as default |
| devfs / create-scene | Validate scene documents and paths, reject overwrite/duplicate IDs, register new files in project scenes under a write lock |
| SpawnEditStore / AuthorSceneSaver | Existing author command history and CAS persistence; environment lighting, fog, rim and exposure edits serialize without overwriting unrelated fields |
| Scene schema / migration | v6 clearTarget uses a stable NodeId, constrained to this room's SpawnPoint; editorOnly mesh markers; v5 migration adds null rather than guessing a target |
| RuntimeSession / PlaySession | Spatial event interaction and designated elite death completion; common interaction eligibility for commands and HUD; terminal state and reset |
| GameHud | Health, enemies, room progress, objectives, interaction, defeat/retry, next floor and final-floor completion feedback |
| Scene material / light resolution | Nested material overrides; stable primitive matching; missing instance fallback to its declared base with diagnostics; world-rotation-derived directional light |
| Scene generator / authored floors | Road edges and markings, differentiated room surfaces, serialized material treatment and lights, editor-only marker visibility |

Scene creation uses exclusive file creation followed by project registration. Ordinary registration failure rolls back the new file. This is not a crash-atomic multi-file transaction; an interrupted process may leave an unregistered file requiring explicit recovery. Character files were not modified.

## Headed acceptance and repairs

Tests ran against this worktree on the fixed HTTPS port 5100, temporarily replacing the original Vite service with authorization. Chrome's real rendering diagnostic reported **nvidia lovelace**. Foreground observation reached 59–60 FPS; background throttling was not used as performance evidence. This was not headless/SwiftShader validation.

| Check | Actual result |
| --- | --- |
| Project picker and creation | UI created a duplicate and an empty scene; actual files and project entries matched their new stable IDs; opening selected the requested document |
| Edit/save/reload | Ambient intensity changed via UI, Undo and Redo restored expected values, Save wrote the file, Reload retained the saved value |
| Dirty navigation | Added explicit Save and Continue / Discard and Continue / Cancel dialog after native-only protection proved insufficient; all three routes exercised |
| Failed save while leaving | Controlled external disk change caused a CAS conflict; Save and Continue stayed on the original dirty scene with an error, without overwriting external content; exact authored file restored after the probe |
| Empty scene Play | Play correctly rejected missing playerStart/NavZone; fixed the previously invisible error so the editor displays the cause |
| Chinese / English and layout | New menus/dialogs translated in English; checked 1000×720 layout, persistent status and toolbar overflow; restored Chinese and temporary viewport overrides |
| Play / pause / step / Stop | Editor helper markers hidden in Play and restored on Stop; pause held simulation, one Step advanced exactly one tick; author camera restored |
| Real gameplay input path | Keyboard-event movement and J shooting produced player movement, damage and kill events; defeat and UI retry reset the player. This does not establish a full normal-input playthrough or balanced difficulty |
| Floor progression, controlled probe | Direct runtime positioning/damage intentionally isolated room-completion integration from combat skill: floor 1 → floor 2 → floor 3 UI navigation worked, elite target death completed a room with escorts alive, last floor displayed campaign completion without another scene |
| Resource disposal | Final Stop ledger: registered 3, disposed 3, pending 0 |
| Browser errors | No captured warning/error console entries in the final checked editor tab |

The controlled terminal probes are **not** player-playthrough evidence. The new explicit navigation guard also protects next-floor navigation. Reduced excessive authored fog improves overview readability; it is not proof of artistic parity.

Two test-only scenes and their project entries were removed after preserving evidence. The project file was restored byte-for-byte after verifying that no other change would be lost. The conflict probe restored its exact source backup. No test-only scene is committed.

Local evidence is retained under `.workbuddy/tmp/acceptance-20261004/`: `editor-overview.png`, `play-combat.png`, `save-conflict-preserves-edit.png`, `menus-1000-en.png`, `menus-1000-final.png`, `floor3-terminal-controlled.png`, `ardot-design-board.png`, and the two temporary scene documents. These are local diagnostic artifacts, not a claim that a normal playthrough passed.

## Automated verification

After test-scene cleanup and behavior fixes:

- `pnpm run typecheck`: passed.
- Six targeted suites (scene workspace, game HUD, author scene save, Play controller, runtime room actions and spawn editing): **70 tests passed**.
- `pnpm run scene:check`: **105 asset metadata records synchronized, eight scenes at schema v6, 12 scene-file tests passed**.
- `pnpm run editor:build`: passed; existing Vite CJS deprecation and >500 kB chunk warnings remain.
- `git diff --check`: passed.

Earlier implementation verification included 602 targeted tests across 31 files and the isolated scene-creation verifier (registration, overwrite/path rejection and duplicate-ID concurrency). The later Copilot-fix verification passed 74 tests across six affected suites. These earlier runs are historical evidence, not freshly rerun totals for this acceptance patch.

## Copilot review adjudication

The review snapshot is review `5403675361` on `d86322fb00c4854cd348da598a1a11321dfbc23c`, submitted 2026-10-04 00:57:50 UTC. Its overview explicitly reports **Balanced** effort. The review had settled before the latest snapshot, with no requested reviewers and no additional issue comments. These findings were fixed in `f680baf`; no approval on the latest head is claimed and no redundant review request was sent.

| Comment | Finding | Decision | Evidence / fix |
| --- | --- | --- | --- |
| 4175606600 | HUD advertises ineligible interaction | Accepted | Runtime interactionTarget is shared by command and HUD; regression includes untriggered/live-enemy/repeat/reset/dead-player cases |
| 4175606628 | Serialized instance base ignored | Accepted | Missing instance falls back to declared base with warning, including nested overrides; loaded instances and shared state remain intact |
| 4175606644 | Elite check allocates full views each tick | Accepted | Entity table/source slots scanned directly; regression forbids view() while active and during elite death with surviving escorts |
| 4175606660 | New menus bypass localization | Accepted | Menu/dialog strings use t() and English dictionary; English-mode browser check confirmed new labels |

The installed `C:/Users/fangy/.codex/skills/pr-bot-review/SKILL.md` was located and read during acceptance. Its workflow is used for the existing PR; earlier statements that the skill was unavailable are superseded.

## Failed / outstanding product acceptance

The following are required by the original brief and remain unfinished; they are not waived merely because the editor checks passed:

1. **Visual design parity fails:** authored rooms remain sparse separated road planes and props, substantially unlike the dense illustrated urban environment in the local and online references. Final scene composition, material/shader quality, lighting and existing-character presentation need further implementation and comparison.
2. **Core game loop is incomplete:** loot/currency, meaningful build choices within the opening 90 seconds, store/altar interactions, cross-floor progression, dedicated Boss/danger mechanics and settlement are missing. The event action currently completes room semantics only.
3. **Normal player acceptance is incomplete:** automated keyboard-path checks demonstrated movement/combat/retry, but did not establish a complete three-floor normal-input run or the GDD's 5–8 minute pacing. Controlled runtime damage cannot substitute for it.
4. **Authoring coverage remains bounded:** arbitrary structural edits and all material-panel parameters are not yet covered by the author save whitelist. The new supported persistence scope is the documented environment fields plus existing transforms/spawn edits.

No character asset production should be taken over to address these gaps. The current PR is an incremental implementation under review, not delivery of the full requested quality target. It stays draft pending completion and acceptance of the outstanding scope.
