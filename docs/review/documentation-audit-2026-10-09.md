# Documentation audit against current source and CodeGraph

## Reviewed scope

Date: 2026-10-09, Asia/Singapore. Source baseline: `e6c2278` on
`codex/architecture-boundaries-20261009`, after integrated main `90d6427` and
the game/framework separation. Unrelated dirty daily logs, untracked deliveries
and the music/voice draft were preserved. No game, scene, asset or MCP behavior
changed in this documentation task.

The review covered the shared catalog/classification, current Agent/README and
development/animation/art/rigging/MCP guides, the structure map, tracked Markdown
link targets, and historical documents containing obsolete owner paths or
architecture instructions. It is not a line-by-line certification of every old
design specification, external reference or asset description.

## Graph evidence and confidence

The installed `code-graph-mcp 0.167.0` server was accessed through actual stdio
MCP `initialize`, `tools/list`, `project_map` and file-qualified `module_overview`.
Tool schemas were read before querying. Audited roots are `apps`, `assets`,
`packages`, `tools`; root configs and document metadata were inspected separately.
See [the query receipt](../evidence/documentation-audit-2026-10-09/codegraph.json).

Incremental indexing returned 18 updated / 1 removed file and completed embedding,
while also emitting a concurrent-lock warning. The following health result was
healthy with 965 files, 6,504 nodes, 15,670 edges, four parser flags, 6,870 unresolved
calls and 6,437/6,437 embedded nodes. Counts include documents/data/tests and are
not production ownership or runtime-performance measures. No lock was removed,
foreign process stopped or index copied from another checkout. The warning limits
claims about exclusive refresh; subsequent queries and source reads were used.

The full map returned 52 directory groups without reported budget omissions.
Even depth-1 dependency lists mixed unrelated same-name receivers with real
imports. The export-only game barrel returned dependencies alongside a “No files
found” warning. These results were checked against actual barrels/imports, the
scene migration chain, render/shader implementation and the source-edge gate;
they were not treated as missing files or architectural violations.

## Repairs

| Finding | Correction / source authority |
|---|---|
| README described FrameGraph as the active renderer and omitted current packages | Describe Editor Play/direct GPU passes, M0-only sample, framework/game/presentation owners and actual build/tool routes; `RendererCore`, dormant `feature.ts`/`framegraph/graph.ts` |
| Current gameplay guide still used v14 and moved tests | Update v15, game-owned session/audio, accepted weapon action/IK boundaries and current scoped test paths; `document.ts`, game barrel and actual test files |
| IK/transition guides described conflicting pre-merge migration histories as current | Preserve original version provenance; document v13→v14 audio mapping and v14→v15 integration from `migrate.ts`, including absence/preservation semantics |
| Historical QA service was presented as this checkout's live service | Retain dated provenance; require live ownership rather than reuse of another worktree's PID/stop recipe |
| Art guide had a broken combat-ink link and obsolete missing-model/weapon statements | Point to game presentation; distinguish original placeholders from delivered replacements, implemented procedural feedback from final model/hand/atlas integration |
| Root rules addressed only WorkBuddy and asserted every sidecar field still disappeared | Address every development Agent; retain persistence requirements without asserting all fields' implementation status; require internal guide/command repair after owner/schema changes |
| “Scene SOT” wording implied duplicating reusable roster/asset data into every scene | Clarify scene-instance/config authority versus project registration, canonical roster/stat JSON and reusable sidecars |
| Old design/review findings could be mistaken for current instructions/defects | Add dated-context notices to seven design entries and ten delivery/review entries; original bodies, paths, measurements and findings retained |
| Catalog classified browser validation as history and had generic routes | Correct current guide roles/topics/headings, attach relevant source contracts, preserve stable IDs and add seven live source entries plus this dated evidence report |
| Structure map lacked the post-refactor execution/test path | Add current source map and routes while preserving the 2026-10-08 measurements in an explicitly historical section |

The catalog now contains 127 entries. A document marked `current` is a source
navigation/contract guide; historical acceptance paragraphs inside it remain
dated evidence. This review does not promote design targets to delivered features.

## Verification and remaining limits

Actual local checks:

- `knowledge:test`: all five tests passed, including duplicate/missing/unsafe
  paths, historical-authority rejection and role/status/topic discovery.
- `knowledge:check`: 127 entries, no classification/path/source-reference errors;
  tracked-document coverage passed.
- `knowledge:find`: browser validation is discoverable as a current validation
  guide; migration lookup returns the canonical migration source.
- `architecture:check`: 257 production TS/JS files, zero forbidden edges.
- Current guide command audit: 13 entry/guide documents, 54 script/test references;
  package scripts and literal Vitest test paths all exist. This is path/registration
  validation, not execution of every listed command.
- Tracked Markdown local-file targets and new report links passed; `git diff
  --check` passed. The complete scan scope includes tooling/asset Markdown as well
  as catalogued project documents.

Browser, GPU, listening, mobile, full gameplay and old performance measurements
are not renewed by this documentation review. No runtime source was changed, so
unrelated runtime builds and acceptance suites were not repeated.

Remaining engineering work stays in the current guides: legacy game-oriented
scene-schema extension extraction and editor bootstrap consolidation; automatic
weapon-marker hand IK and procedural reload; final atlas/resource quality;
semantic editor MCP coverage and client setup; target-device and human listening
acceptance. External URLs and Markdown heading anchors are outside the local-file
link scan. Pure index counts do not prove semantic reuse or complete call resolution.
