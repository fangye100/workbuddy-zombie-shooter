# 44 - CodeGraph structure map and development workflow

## Current source review, 2026-10-09

For current owners use [the layer contract](architecture/layers.md); for connecting
and querying the installed MCP use [the portable CodeGraph guide](knowledge/codegraph.md).
Reviewed checkout: `codex/architecture-boundaries-20261009`, source `e6c2278`.
Main integration is `90d6427`; this source includes weapons/audio and HumanIK/pose
transitions. The current scene schema is v15, with the integrated v14→v15 migration
in `packages/scene/src/migrate.ts`. This is a documentation/source review, not a
new gameplay, GPU or device acceptance run.

Actual MCP `project_map` and seven file-qualified `module_overview` queries used
server `code-graph-mcp 0.167.0`. The map returned 52 directory groups, including
tests/docs/tooling; they are not 52 production packages. Full query budgets were
used without reported budget omissions. The incremental update completed with
18 updated / 1 removed file but also emitted a concurrent-lock warning. Four
parser flags and 6,870 unresolved calls remained in the subsequent health result.
See [audit scope and receipt](review/documentation-audit-2026-10-09.md).

The graph's same-name call resolution also contaminates depth-1 dependency lists:
`RuntimeSession` showed unrelated renderer/device calls and `SceneDocument` showed
unrelated editor `find` receivers. Those are not confirmed imports. Source reads
and the TypeScript-AST architecture gate determine the dependency findings here.
The game barrel's “No files found” warning despite returned export dependencies
was checked against the real file; the package is present.

### Current execution and data paths

```text
Editor authoring (:5100)
  -> framework author commands / shared history
  -> editor projection / devfs -> tools/fs coordinated write -> scene/project/sidecar
Editor Play (:5100)
  -> zombie-game PlaySession / RuntimeSession / RunProgress / EnemyAttacks
       -> framework weapons, collision, navigation and character primitives
       -> content-generated roster/stat APIs (JSON remains authoritative)
  -> zombie-game presentation: HUD, controls, audio and combat/weapon ink
  -> editor host adapters: actors, game camera, shared motion, IK and render bridge
       -> render RendererCore / skin / body-ik / pose-transition / direct GPU passes
            -> gfx / core / scene contracts
MCP: stdio -> loopback broker -> WebSocket -> selected EditorAgent -> same services
M0 sample (:5101): gfx initialization/capability HUD; not the campaign Play path
```

| Source owner | Current location / limits |
|---|---|
| Reusable framework runtime | `packages/runtime/src`: author commands, behavior ports, weapons and solid-ray collision; no reverse game exports |
| Zombie simulation/progression | `packages/zombie-game/src`: loader, session, PlaySession, spawn A/B, RunProgress, EnemyAttacks and AudioFramePlanner; public headless barrel |
| Game presentation | `packages/zombie-game/src/presentation`: 13 modules plus HUD CSS; explicit public subpaths, no editor dependency |
| Editor adapters | `apps/editor/src/services`: authoring, binding, actor/render/Play integration and game-camera/IK adapters; bootstrap still needs consolidation |
| Generic IK/pose sampling | `packages/render/src/body-ik.ts`, `two-bone-ik.ts`, `skin.ts`, `pose-transition.ts`; scene/sidecar contracts remain in `packages/scene` |
| Rendering status | Direct passes in `RendererCore` are active. `FrameGraph` / `RenderFeature` are dormant design infrastructure, not the current GPU scheduler |

Git-tracked recursive `src/**/*.ts` counts at this source: runtime 10, Zombie
game 21 (8 headless including barrel + 13 presentation), render 22, editor 92.
These counts include barrels/WGSL TS modules; they are navigation scope, not
activity, complexity, memory or performance measurements.

### Current test and tool routes

Select the affected subset; commands here are current routes, not a claim that
all were executed during this documentation review.

```powershell
pnpm exec vitest run packages/zombie-game/test/run-progress.test.ts packages/zombie-game/test/audio-frame.test.ts packages/runtime/test/solid-ray.test.ts
pnpm exec vitest run packages/render/test/pose-palette.test.ts packages/zombie-game/test/presentation/game-hud.test.ts packages/zombie-game/test/presentation/game-audio-assets.test.ts
node --test tools/mcp-editor/*.test.mjs
pnpm run architecture:check
pnpm run knowledge:check
```

`game:build` builds separate headless game/framework bundles; `runtime:build`
alone no longer exports Zombie simulation. Default Vitest still covers only
apps/packages tests. Node/Python tools need their own runners. `verify:parity`
alone samples Node; explicit matching-browser comparison is needed for a
cross-host claim. Assets/scenes still require `scene:check`; graphical behavior
requires the headed/hardware path under project rules.

## Preserved historical audit — 2026-10-08

Sections 1–8 below retain the original source snapshot and measurements. Old
runtime/editor file paths and test commands describe that revision; use the
current owner/test routes above for new work. Do not copy historical counts or
unexecuted checks into a current acceptance claim.

## 1. Evidence and scope

Reviewed on 2026-10-08 (Asia/Singapore), against source commit
`1bd98a11c9ddedf63243156f38b7ae8e98748313`, using the local index generated by
`@sdsrs/code-graph 0.167.0`. This is a source snapshot; later changes need renewed verification.

CodeGraph is a Rust executable using Tree-sitter AST extraction. It does not
compile or execute the project to discover its architecture. The chosen Agent
controls scope, queries and interpretation, rather than the parser's extraction
rules. Optional local embeddings support semantic retrieval separately.

The audited roots in `.code-graph/source-roots.json` are `apps`, `assets`,
`packages`, and `tools`. `.code-graph/` is an ignored local SQLite cache, not a
Git-distributed artifact or architectural source of truth. Initialize/refresh the
index in the intended checkout using the installed tool's supported interface.
A different worktree's index must not be assumed current for this checkout.

| Read-only audit measurement | Result |
|---|---|
| Tracked code files in the four roots | 420; no missing indexed source files |
| TS/JS syntax audit | 363 files, including root configuration outside the four roots; 3,305 named declarations, none missing |
| Python syntax audit | 378 named functions/classes, none missing |
| Independent syntax diagnostics | None in audited TS/JS and Python files |
| Indexed files / nodes / all edges | 900 / 6,261 / 15,030; includes documents/data and non-call edges |
| Stored snippets checked | 5,271; 135 truncated snippets had matching retained prefixes |
| Call-edge confidence | 3,080 extracted + 2,582 inferred + 1,727 ambiguous = 7,389 |
| Pending unresolved calls | 6,577 |

Four indexed files had parser-error flags despite passing independent syntax
and named-declaration checks. File/symbol coverage does not prove complete or
correct call resolution. The audit did not execute runtime tests, browser/GPU
validation, or MCP reindexing. Schemas, ADRs and project rules remain authoritative.

## 2. Historical execution paths

```text
apps/editor (:5100)
  -> services: authoring, binding/retargeting, Play and presentation
  -> runtime: PlaySession / RuntimeSession
       -> gameplay: character data, ray primitives
       -> ai: navigation, combat scheduling, crowd solving
       -> content: generated roster/stat APIs
  -> render: RendererCore, skinning and direct GPU passes
       -> gfx / core / scene

apps/samples/00-init (:5101)
  -> gfx: M0 device initialization, swapchain clear, capability/FPS HUD

Authoring persistence
  -> editor devfs or offline binding MCP filesystem adapter
  -> tools/fs/project-write.mjs: shared lock, baseline comparison, atomic writes
  -> project / scene / prefab / asset-sidecar files

Dormant design, not the current rendering path
  render/src/feature.ts --import type--> framegraph
```

The playable development path is editor Play. The sample
[`main.ts`](../apps/samples/00-init/main.ts) imports `GfxDevice`, not runtime/render/scene.
Port 5101 is not a complete standalone game entrypoint.
[`RendererCore`](../packages/render/src/renderer-core.ts) directly orchestrates
GPU passes. [`FrameGraph`](../packages/framegraph/src/graph.ts) and
[`RenderFeature`](../packages/render/src/feature.ts) explicitly document dormant
status. A type import or exported interface does not establish runtime use.

## 3. Package and data ownership

These counts are recursive `src/**/*.ts` files at the reviewed commit, including
barrels and generated files; they are not implementation or activity counts.

| Package | TS files | Responsibility / important entrypoints |
|---|---:|---|
| core | 5 | ECS World, CommandBuffer, archetypes, queries, math/naming |
| gfx | 4 | GfxDevice, capabilities, resource handles, uniform/staging rings |
| framegraph | 2 | Dormant pass/resource planning; no current production runtime consumer verified |
| scene | 16 | Scene/prefab schema and migrations, project container, asset metadata, behavior definitions, GLB and retarget/shared-motion/audio/weapon contracts |
| render | 19 | RendererCore, skinning, materials, uniforms, direct passes and WGSL; pose-palette.ts, albedo-texture.ts |
| gameplay | 3 | Character SoA/pool, assembly, LOD and ray primitives |
| ai | 4 | Flow fields, spatial hash, combat/damage/montages, perception, CrowdSolver |
| runtime | 17 | Sessions, spawning, behavior execution, weapons/attacks, loading/authoring; run-progress.ts, solid-ray.ts, asset-node-edit.ts, audio-frame.ts |
| content | 4 | Generated character roster/stat APIs; input JSON remains canonical |

- `aether.project.json` owns paths, scene registration/start selection, layers and
  project settings; schema: `packages/scene/src/project.ts`.
- Scene/prefab JSON owns authored nodes/components; scene schema and migration
  contract: `packages/scene/src/document.ts` and migration modules.
- Asset `.meta.json` sidecars own reusable binding/rig/import metadata. Binary
  resources remain referenced assets.
- Character roster/stat JSON owns content definitions; generators derive TS APIs.
  Scene schema is not the sole owner of every kind of project data.
- Play uses a runtime copy; PlaySession owns snapshot/rollback and Play resource
  cleanup. Persistent authoring and transient simulation remain distinct.

[`devfs.ts`](../apps/editor/devfs.ts) exposes development-only filesystem routes.
GUI writes, offline MCP sidecar saves and renames coordinate through
[`project-write.mjs`](../tools/fs/project-write.mjs): participating writers compare
loaded baselines inside the project lock and perform atomic writes. Conflicts
remain visible. Direct filesystem writers are not automatically protected.
Abandoned locks require explicit recovery after confirming the owner stopped.
[`rename-project.mjs`](../tools/fs/rename-project.mjs) owns multi-file rename
transactions and recovery journals.

## 4. Editor structure and dynamic boundaries

`apps/editor/src` has 101 TS files. Services has 54 direct files / 85 recursively;
binding has 20 direct / 31 recursively, including its 11-file
`binding/motion-retarget` pipeline. Do not mix these scopes. The former “890 active
exports” claim had no reproducible definition and is removed.

| Owner | Entry points |
|---|---|
| Shell/assets/rendering | main, ui, asset-browser/inspector, models, renderer, scene-boot, editor features |
| Binding/skinning | binding-panel/session/persistence/export/math, humanik-template, volumetric modules |
| Retargeting | binding/retarget-session and retarget-workbench; motion-retarget/pipeline, calibration, pose/two-bone/temporal solvers, quality-report, bake-adapter |
| Authoring | author-asset/transform/scene-save/snapshot/projection, scene-author-panel, workspace/environment/light/material/contact panels |
| Runtime bridge | runtime-bridge/actors, scene/shared motion, behavior-host, play-controller |
| Presentation | game-hud, run-hud, run profile/settlement/transfer, cameras/controls, combat/weapon ink/diagnostics, player presentation, game audio/assets |
| Persistence/automation | apps/editor/devfs.ts, resource rename, editor-agent, filesystem coordination and MCP broker |

Static graphs do not capture every connection. Trace both endpoints explicitly:

1. [Volumetric worker client](../apps/editor/src/services/binding/volumetric-worker-client.ts)
   creates a Worker via URL and exchanges messages with
   [the worker](../apps/editor/src/services/binding/volumetric-worker.ts).
2. [Behavior host](../apps/editor/src/services/behavior-host.ts) discovers
   `assets/behaviors` through `import.meta.glob`, registers definitions and injects
   them into runtime execution; a direct import/call edge is not required.
3. Editor MCP crosses stdio, HTTP, WebSocket and browser dispatch. Verify message
   contracts, request/response handling and the actual editor owner.

## 5. Tools and MCP responsibilities

| Owner | Responsibility |
|---|---|
| tools/verify | Browser/GPU/gameplay/filesystem probes; follow repository headed validation rules |
| tools/level | Generation, scene migration, simulation, environment preparation |
| tools/rigging and tools/motion | Rig export/integration, animation import/checks |
| tools/art, tools/scene, tools/audio | Art checks, sidecars, audio preparation/verification; Python asset pipelines also live in assets/**/_tools |
| tools/fs | Coordinated writes, scene creation, rename/recovery |
| tools/mcp-binding | Offline binding; reuses editor binding plus scene/runtime/content; filesystem injected through FsPort |
| tools/mcp-editor | stdio adapter -> local HTTP broker -> WebSocket -> editor-agent -> editor operations; browser owns live state |
| tools/mcp-hello | Protocol probe, not a scene/gameplay domain owner |

The three MCP servers do not share the originally claimed scene/gameplay/ai dependency set.

## 6. Confidence and hotspot claims

Raw counts/centrality are navigation hints, not verified coupling, runtime
frequency, CPU/GPU cost or refactoring priority. Check exact receivers, source
paths, confidence, production/tests, type/runtime imports and dynamic boundaries.

| Target | Incoming edges in snapshot | Finding |
|---|---|---|
| SpawnEditStore.set | 62: 55 production + 7 tests; 60 ambiguous, 2 inferred | Includes unrelated Map.set in asset-browser.ts; “hottest write entrypoint” is unsupported |
| Local buildSolidVolume.find | 118: 55 production + 63 tests; all ambiguous | Includes array .find in params.ts; not verified union-find callers |
| AttackTokenPool.has | 27: 26 ambiguous, 1 extracted | Verify receiver identity |
| BehaviorRegistry.has | 31: 29 ambiguous, 1 inferred, 1 extracted | Verify receiver identity |
| BindingPanel.refresh | 19: 16 extracted, 3 ambiguous | Inspect actual callers before asserting impact |
| RetargetSession.solve | 4: 3 inferred, 1 ambiguous | Trace workbench/session/pipeline source |

The original import-weight and betweenness rankings are removed: symbol-edge
counts were treated as runtime dependency strength, and uncertain calls polluted
centrality. Binding/retargeting is a cross-module workflow by source inspection;
its status as the project's largest chokepoint is unproven. Future rankings must
state query parameters, count definitions, test scope and confidence, with
representative verified source evidence.

## 7. Graph-first development workflow

For project/module structure, responsibility discovery, dependency/call analysis,
impact assessment and refactoring, start with the CodeGraph index. Do not first
reconstruct architecture through broad grep/rg searches. Use the installed MCP
schema for exact supported arguments:

1. Confirm checkout, branch/commit, tool version, roots/exclusions and indexing
   completion; initialize/refresh as needed using supported tool operations.
2. Use `project_map` / `module_overview` to locate modules and owners; use
   file-qualified `get_ast_node`, `get_call_graph`, `find_references`,
   `semantic_code_search` or `ast_search` to narrow the relevant symbols.
3. Follow pagination/truncation and inspect unresolved calls/parser errors.
   Read the graph-located source to verify critical edges and failure paths.
4. Use targeted text search to fill known gaps (dynamic messages, glob registration,
   configuration/data, uncertain same-name edges). If the MCP/index is unavailable
   or cannot cover the task after a reasonable attempt, state that limitation and
   use source search as fallback; do not fabricate graph evidence or stop all work.
5. Separate confirmed source facts, inferred/ambiguous relationships and unverified
   runtime behavior. Record the snapshot/scope in architecture reports.

No fixed “first 32 files refreshed per query” guarantee was independently verified.
A query response alone does not prove index freshness. Graph results complement
source/schema/ADR contracts and behavior-specific tests, not replace them.

## 8. Historical test ownership

The default [Vitest configuration](../vitest.config.ts) includes only
`apps/**/*.test.ts` and `packages/**/*.test.ts`, excluding tools/assets. `pnpm test`
does not validate every tool/Python pipeline. Available targeted entrypoints
below were **not executed for this documentation correction**:

| Owner | Command / verification |
|---|---|
| Runtime progression/rays/audio | `pnpm exec vitest run packages/runtime/test/run-progress.test.ts packages/runtime/test/solid-ray.test.ts packages/runtime/test/audio-frame.test.ts` |
| Pose palettes / HUD | `pnpm exec vitest run packages/render/test/pose-palette.test.ts apps/editor/test/game-hud.test.ts` |
| Editor MCP | `node --test tools/mcp-editor/server.test.mjs tools/mcp-editor/broker.test.mjs tools/mcp-editor/workflow.test.mjs` |
| Audio Python | `python -m unittest discover -s tools/audio -p test_audio.py` |
| Art/environment Python | Select applicable test_*.py under tools/art or assets/environment/_tools and use the owner's runner |
| Scene/assets | `pnpm run scene:check`; content JSON also requires `pnpm run content:gen` and `pnpm run content:check` |
| Motion / binding MCP | `pnpm run motion:check`; relevant binding TS tests and `pnpm run mcp-binding:check` |
| Persistence | Relevant devfs tests and `pnpm run verify:fs`, including conflict/recovery paths |
| Visible gameplay/GPU | Headed editor Play and affected browser/GPU probes under project rules; builds/index success are insufficient |
