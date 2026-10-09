# Editor, framework and game ownership

## Required boundaries

| Layer | Location and public entry | Responsibility |
|---|---|---|
| Framework | `packages/core`, `gfx`, `framegraph`, `scene`, `render`, `ai`, `gameplay`, `runtime`; `@aether/<package>` | Reusable data contracts, resources, rendering, math, navigation, weapon mechanics, collision and author commands |
| Zombie game, headless | `packages/zombie-game/src/index.ts`; `@aether/zombie-game` | Concrete roster consumption, scene-to-campaign loading, rooms/waves, NPC attacks, run rewards, game Play composition and audio-event projection |
| Zombie game, presentation | `packages/zombie-game/src/presentation`; named `@aether/zombie-game/presentation/<module>` entries | HUD, language, controls, overlays, run storage and Web Audio playback; reads game facts and calls game commands |
| Game content | `packages/content`, `assets/scenes`, `assets/behaviors`, asset sidecars | Authored/generated game data; scene remains the sole game-content SOT |
| Editor | `apps/editor/src` | Authoring UX, binding, inspectors, history/save and editor-specific render/Play adapters |
| Host and tools | sample entrypoints, editor Vite/devfs, `tools` | Composition, process/file/network adapters, MCP transport, offline generation and validation |

Framework must not import game content, game logic, presentation or editor.
Headless game may import framework and content; it must not import presentation
or editor. Presentation may import headless game/framework but never editor.
Editor/host assembles these services through explicit ports. Type-only references
are architectural dependencies too. A game-specific feature must not move into
framework solely because it is CPU-only or has an abstract class.

Cross-package source dependencies use public `@aether` entries. Presentation has
explicit named public subpaths in `tools/architecture/layers.json`; arbitrary deep
imports are rejected. The headless entry does not re-export DOM modules. A second
game should create its own game package and supply data/policies to framework;
it must not require editing Zombie rewards, actor IDs or HUD to use the engine.

## Data and failure ownership

- Scene/schema/project/sidecar authority stays in `packages/scene`; no alternate
  scene cache or inline assets were introduced by this move. Stable NodeIds,
  GUID-bearing AssetRefs, migration diagnostics and registered scenes still apply.
- Generic author commands, behavior ports, segment/solid collision, ammunition,
  equipment timing and weapon strategies remain `@aether/runtime`.
- `RuntimeSession`, Zombie level loading, `RunProgress`, enemy attacks,
  `AudioFramePlanner`, spawn A/B and the game's `PlaySession` moved to
  `@aether/zombie-game`. All hosts consume the same implementation.
- Input, viewport projection, storage and trusted audio gestures are host ports;
  render/DOM facts never own damage or rewards. Stop still restores author state
  and releases the complete Play ledger.
- CLI `game:build` builds separate framework and game bundles. `runtime:build`
  now builds framework only. Parity/simulation consumers use the game bundle;
  old callers must change imports instead of retaining a reverse re-export.

## Enforced gate and review obligations

`pnpm run architecture:check` parses production TS/JS in the configured roots.
It checks ownership, static imports/re-exports, type imports, literal dynamic
imports/require, `import.meta.glob`, and `new URL(..., import.meta.url)` resources
(including Workers). Framework/headless nonliteral module dispatch requires an
explicit host port. Missing aliases, unknown package ownership, forbidden edges
and cross-package relative imports fail. Server-only Vite/devfs composition is
explicitly classified as host, so browser editor modules cannot import tooling.
No grandfathered reverse-import allowlist is needed at this revision.

Node tests exercise bypass/failure paths. CI runs the architecture and knowledge
gates. The manifest cannot prove semantic reuse: reviewers must reject new Zombie
IDs, reward formulas, campaign state or host UI inside framework even if no
import edge exposes the mistake. Python dependencies, text-generated code and
message payload semantics need source review; this checker does not certify them.

Tests follow their implementation owner: Zombie simulation/presentation under
`packages/zombie-game/test`; reusable author/weapon/collision tests under runtime;
editor adapter/Play integration tests remain under editor. Tools have separate
Node/Python runners. Moving files is not acceptance: verify import resolution,
same-input simulation parity and the reachable headed Play path.

## Remaining consolidation

The v15 shared scene contract retains legacy built-in game-oriented `RunRules`,
talent/theme/weapon definitions and compatibility factories. Extracting those into
a versioned extension system requires a dedicated schema/migration change; this
refactor preserves authored data instead of claiming that migration is done.
`apps/editor/src/main.ts` still assembles game ports alongside editor setup;
splitting its bootstrap adapters is a later structural step, not permission to
add gameplay formulas there. Binding/retarget authoring remains editor-owned;
generic IK/pose blending remains render-owned. Follow source ownership rather
than historical file locations in old reports.
