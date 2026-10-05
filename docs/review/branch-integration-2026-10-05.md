# Branch integration audit — 2026-10-05

## Scope and merge policy

The user authorized sequential PRs and direct merges of all current development, including the primary checkout and worktrees, and explicitly waived Copilot requests/waiting because the review quota is exhausted. Existing findings and repository checks still apply. Merge commits retain source-branch ancestry; older already-squashed deliveries are compared by content rather than reapplying obsolete code.

The primary checkout's uncommitted author notes, project rules and two H-01 inspection images were committed on `codex/main-workspace-sync-20261005`. Temporary `_tmp_*` files, a rule backup and the original delivery directory remain local. Canonical P0 source/derivative assets are already versioned on the scene quality branch. No worktree is removed.

## Branch inventory

| Branch | Disposition |
|---|---|
| `fix/lod-regen-20261004` | Already merged through PR #23; `1d12313` is an ancestor of main |
| `fix/editor-review-20261003` | Post-PR-21 H-01 files and notes preserved through integration PR #24 |
| `codex/main-workspace-sync-20261005` | PR #24 merged as `fc65bc9`; main's newer runtime code retained |
| `codex/scene-authoring-loop` | Scene editing, campaign art, player appearance, comic rendering, P0 intake and knowledge guide; integration checks and existing-review closure below |
| `codex/editor-mcp-coverage` | Separate prototype to integrate after scene quality; production acceptance remains incomplete |
| `codex/scene-game-refine` | Already delivered by squash PR #22: branch tip `cd6cbb8` and merge `7f8121c` have identical trees |
| `feat/combat-p5-20261002` | Already delivered by squash PR #20; its final memory patch `929affe` equals main's `f4035ca` (stable patch ID `23b5807e19a110040f08f9c78a830fca5a21937b`) |
| Other historical development branches | Already present in main ancestry; no duplicate PR needed |

## Existing PR #23 comments

| Comment ID | Decision | Resolution and evidence |
|---|---|---|
| 4177635009 | Accepted; already fixed on scene quality branch | Hierarchy and keyboard Delete call `deleteAuthorObject`, which executes `removeNodeTree` through `SpawnEditStore.editNodes`; save/history regressions cover node removal. No renderer-only deletion remains at these entry points. |
| 4177635016 | Accepted | Initialize the budget candidate independently for each asset; Python regression covers failure as the first asset and failure after a successful asset. |
| 4177635020 | Accepted | Filter probe steps by the requested maximum and include its exact endpoint; regressions cover 4×, 2.5× and 16× plus invalid numeric ceilings. |
| 4177635022 | Accepted | Expose asset insertion IDs retained by undo/redo history; prune CPU asset copies after author refresh/insertion. Regressions cover discarded redo, retained insertions, rejected edits, owner replacement and exactly-once bitmap closure. |

The full suite initially exposed old test assumptions after the art changes: floor-one static capacity is now full, scenery/collider placement is different, the project has another gallery, and migration now reaches v10. Authoring fixtures now reserve render capacity without changing semantic nodes; collider math fixtures explicitly set their baseline transforms; builtin bounds-proxy tests explicitly create the builtin proxy; migration and project-list assertions check the current contract. No production capacity or loader behavior was weakened to make tests pass.

## Validation before the scene-quality PR

- The 61 tests in the five initially failing suites pass after fixture repairs, including two new CPU texture lifetime regressions.
- Four Python budget-search tests pass without decimating or writing real assets.
- Typecheck and editor build pass; the existing large-bundle advisory remains.
- `scene:check` passes: 174 GLB sidecars, ten schema-v10 scenes, twelve scene-file tests, 38 environment LOD families and the P0 source/LOD/texture/reference gate.
- `content:check`, `verify:prefix` and `git diff --check` pass.
- Existing headed NVIDIA visual evidence and its boundaries remain in [the scene report](../28-EnvironmentSceneQualityPass.md), [comic report](../30-ComicRenderingAcceptance.md) and [P0 report](../32-P0-asset-intake-2026-10-05.md). This integration check does not invent a new GPU or full-campaign acceptance run.

## Final integration checks

PR #25 merged scene quality as `0c081ce`. The MCP integration uses `AETHER_EDITOR_MCP=1` on the Vite server and `agent=1` on the selected browser tab; ordinary editor sessions leave the prototype inactive. It is not registered as a user MCP and still lacks complete live authoring acceptance.

After integration, all 87 Vitest files / 1,416 tests pass. Four Node broker tests pass. Typecheck, editor build and `scene:check` pass (173 active product GLBs, ten v10 scenes, existing environment and P0 gates). This is a new full CPU/build integration run, not a new headed GPU run. Existing hardware evidence remains linked above.

PR #24 received three further comments before finalization:

| Comment ID | Decision | Resolution |
|---|---|---|
| 4182451267 | Accepted | Regenerate the asset manifest so H-01 exposes the retained 27-joint rigged LOD. This indexes the asset without changing the scene's selected player model. |
| 4182451276 | Accepted | Both textured GLBs hash to `05673bb5c33f52ed46bd1e2962b4a0187d0c65ccf884c507343a97da8e150c15`. Keep one canonical `textured` candidate with the current GUID and merged binding-editor state. Move the duplicate and its legacy GUID/sidecar into an explicitly annotated `archive` directory, retaining all bytes in Git LFS while removing ambiguous manifest selection. |
| 4182451281 | Accepted | `web-debug` is absent on this host. Project rules now name a portable [repository verification entry](../browser-verification.md) for that case, preserving current browser-tool, ownership, headed and hardware requirements. No global Skill/configuration was changed. |

The final merge/LFS audit verifies current main against development tips, then hydrates and hash-checks tracked LFS files in the primary checkout. Merely having a branch or a local LFS pointer is insufficient evidence of delivery. Original delivery files, temporary files and worktrees remain in place.
