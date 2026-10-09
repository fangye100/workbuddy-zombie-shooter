# Ownership and shared-knowledge delivery, 2026-10-09

## Source scope

Base: integrated main `90d6427`, parents scene-authoring `32e1689` and HumanIK
`38d2d19`. Development branch: `codex/architecture-boundaries-20261009`.
Main integration is documented [separately](../review/branch-integration-2026-10-09.md).
Untracked WorkBuddy deliveries/draft briefs and the dirty October 5 daily log
were preserved outside this change.

Seven Zombie simulation modules and thirteen game presentation modules (plus
HUD CSS) moved into `packages/zombie-game`; twenty-one test/fixture files moved
with their owner. Public imports and CLI bundles now distinguish game from
framework. Framework has no reverse game/editor source-import exception.

`AGENTS.md` was renamed from lowercase `agents.md` using Git, making the mandatory
entry discoverable on case-sensitive hosts. It requires the three-layer contract,
CodeGraph-first navigation and shared knowledge discovery. The catalog contains
versioned guides, source contracts and historical WorkBuddy/project documents;
stable IDs, roles, topics, authority and status distinguish reuse from evidence.
`editor_workflow` contract v2 returns the same knowledge/architecture/MCP routes.
Architecture and knowledge checks have a CI workflow; local results follow.

## Actual verification

- Affected editor/runtime/game Vitest suite: 77 files / 1,017 tests passed.
  After removing the old reverse barrel exports, four dependent test imports
  were repaired and their 37 tests passed again. A real-glob audio regression
  adds two tests, both passing; three audio lifecycle tests also passed.
- Typecheck, editor build, separate framework/game CJS bundles passed.
- Same scene v15, seed 7, fixed 1/30 step, tick 180: before/after snapshots
  match document fingerprint, entity identity, position, targets and states;
  25 entities, maximum positional delta 0; [comparison inputs](../evidence/architecture-2026-10-09/parity.json). This is refactor parity on Node,
  not a new Node/browser parity certification.
- Architecture source-edge gate: 257 production TS/JS files, zero forbidden
  edges. It excludes tests/generated caches; Python/message semantics still
  require source review. Architecture/knowledge/MCP Node tests: 29 passed.
- Knowledge lookup successfully retrieved current animation guides. Catalog
  validation passed path/ID/classification/source-reference and tracked-document
  coverage checks. Untracked music/voice brief is not catalogued or accepted.
- Actual CodeGraph MCP initialized as 0.167.0 and queried project map and scoped
  runtime/controls modules before and after the move. Incremental structure
  update returned 153 updated / 42 removed files and completed embedding.
  There was a concurrent index-lock warning and four Tree-sitter parser-error
  flags despite a passing TypeScript check; inferred depth-2 same-name call edges
  were not treated as source dependencies. See [query receipt](../evidence/architecture-2026-10-09/codegraph.json).
- Headed secure Chrome on NVIDIA Lovelace: visible Play, Chinese/English game
  HUD, seven-weapon arsenal, HUD-driven Pistol→SMG equip completed through 16
  visible single-step actions. The game loaded 22 audio buffers; ambience and
  enemy warning events played with no audio errors. A real headed run first
  caught an audio-path prefix slash lost during relocation; repaired and covered
  by the actual asset-reference test rather than only mocked audio tests.
- Stop restored authored Pistol selection, disposed all four registered resources,
  pending 0; closed audio, buffers/bytes/voices/loops all 0. Browser error log empty.

Evidence: [Play state](../evidence/architecture-2026-10-09/play.json),
[Stop state](../evidence/architecture-2026-10-09/stop.json),
[headed English HUD capture](../evidence/architecture-2026-10-09/play-en.png).

No scene or asset data changed in this structural commit; the integrated main
already passed `scene:check`. Physical phone performance and perceived audio
quality were not newly accepted. Existing large-chunk/CJS warnings remain.

Remaining schema-extension and bootstrap consolidation are explicitly listed in
[the layer contract](layers.md). Current legacy built-in RunRules are preserved;
the import gate does not claim to prove every algorithm is semantically generic.
