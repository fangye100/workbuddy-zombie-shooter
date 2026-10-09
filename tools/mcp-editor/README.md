# Game Editor MCP — opt-in authoring and diagnostics

Adapter v0.2 adds structured workflow discovery and weapon/audio runtime inspection. Read the [gameplay development guide](../../docs/43-GameplayDevelopmentWorkflow.md) for contracts, ownership and acceptance. The adapter remains opt-in and unregistered in the user's MCP configuration. This update does not establish full agent-friendly coverage or production readiness.

`editor_workflow` contract v2 also returns portable knowledge/catalog, layer and
CodeGraph guide paths. All Agents can read [the shared index](../../docs/README.md)
without the WorkBuddy memory service. Simulation and game presentation now live
in `packages/zombie-game`; generic author/weapon/collision APIs stay framework.

## Setup and responsibility

`server.mjs` adapts MCP stdio to a loopback-only Vite broker. Requests explicitly identify a connected editor instance. The browser dispatcher delegates to the existing author store, validation, shared undo/redo, save service and PlayController. It does not own a second scene state or automate DOM clicks.

For deliberate use, set `AETHER_EDITOR_MCP=1` before starting Vite and open the selected tab with `?agent=1` (or append `&agent=1`). Both switches are required. Use fixed editor port 5100 and service-ownership rules; do not replace another session's server merely to enable the adapter. Follow project browser-validation rules before connecting or probing a browser/service.

Example stdio transport once enabled (TLS validation stays enabled):

```powershell
node tools/mcp-editor/server.mjs --url https://fangye-win11-office.tail6b29a2.ts.net:5100
```

`--ca` accepts an actual issuing CA bundle if needed, not the leaf certificate. The adapter connects to loopback while retaining URL hostname validation. Never disable certificate verification. Remote web clients and requests with an Origin header are rejected. Enabling the broker/tab does not register a client; this update changes no user MCP configuration.

## Tools and sequence

Precise JSON schemas come from `tools/list` (`catalog.mjs`); unknown arguments are rejected. `initialize` returns workflow instructions. All tools except the two discovery tools require the exact `instanceId`. All authoring/Play mutations additionally require `expectedRevision` from current `scene_get.state.revision`.

| Tool | Purpose / constraints |
|---|---|
| `editor_workflow` | Structured stages, sources, topic guides, checks, recovery and coverage limits. No browser instance required; broker still required. |
| `editor_instances` | Connected UUIDs and author/ready/dirty/Play state. Explicitly select the intended instance. |
| `scene_list`, `scene_get` | Registered scene paths; full author document, stable NodeIds and revision. |
| `scene_create`, `scene_open` | Transactional creation/registration; explicit opening. Creation does not switch scenes. Unsaved edits block opening unless explicitly discarded. |
| `scene_edit_nodes` | Atomic 1–128 operation batch by NodeId. Add/replace takes a complete SceneNode; remove can cascade. Same validation/history as UI. |
| `scene_set_environment` | Complete validated undoable environment replacement; preserve existing fields. |
| `scene_validate`, `scene_history`, `scene_save` | Read-only diagnostics; shared undo/redo; disk-conflict-aware save. Validate → save → reopen → compare is necessary. |
| `editor_play` | Start paused; resume/pause/step (1–600)/stop through PlayController. Stop restores author state and releases Play resources. |
| `editor_runtime` | Actual tick/player/NPC/diagnostics/ledger and copied weapon/audio facts described below. |
| `editor_capture` | PNG of the next rendered GPU canvas frame. DOM HUD excluded; explicit timeout if no live frame. |

Call `editor_workflow` → `editor_instances` → `scene_list` → `scene_get` first. For material, arsenal or audio edits, copy the selected node, change its relevant component and replace the complete node. There are no dedicated weapon/audio setters or asset search. Use the returned new revision for later mutations; reread when another actor changes the scene. Preserve unrelated components, references and GUIDs.

Tool-call parameters for the MCP client's `tools/call` method:

```json
{"name":"editor_workflow","arguments":{}}
```

```json
{"name":"scene_get","arguments":{"instanceId":"<selected live UUID>"}}
```

Build `scene_edit_nodes` arguments from that response: `instanceId`, `expectedRevision`, an optional `label`, and `operations: [{op: 'replace', nodeId: node.id, node}]`. Here `node` is the complete modified SceneNode object, not a JSON string. Scene schema validation is authoritative.

## Runtime diagnostics

`editor_runtime.runtime.weapons` is null when stopped. In Play it contains equipped ID, copied magazine/reserve/level states, active behavior, capacity, reload remaining, switching, upgrade cost, action/phase, local grip/muzzle/magazine/chamber markers, recoil/reload intent, latest 16 accepted events, bounded hook errors and active effect count. Inspection does not equip/fire/reload, advance time or invoke hooks.

`editor_runtime.runtime.audio` exposes AudioContext state/run generation, pending decodes, buffers/bytes, voices/loops/peak voices, played/skipped counters, mute/gain and errors through the existing audio snapshot. Play control does not bypass the browser's trusted Ready/Resume gesture. After Stop, inspect zero pending ledger resources and zero audio buffers/bytes/voices. Counters do not establish perceived sound quality.

Read-only runtime inspection needs no revision argument and is available during paused/running Play. Scene loading still must have produced an author store. Runtime facts are never persisted into scene data.

## Failure handling

`editor_workflow` returns the structured recovery map:

- `REVISION_CONFLICT`: reread and rebase only intended changes.
- `UI_DRAFT`, `UNSAVED_CHANGES`, `PLAY_LOCKED`: coordinate draft/save/discard or Stop; do not silently clear human edits.
- `NOT_READY`: wait for projection/assets to settle and inspect state.
- Save `CONFLICT`: preserve local changes and inspect disk before retrying.
- `COMMAND_FAILED`: projection failure may leave an already applied author edit. Inspect returned revision/history.
- `TIMEOUT`: a write may have executed. Inspect state and disk before retrying; never blindly repeat creation/mutations.
- `EDITOR_DISCONNECTED`: rediscover instances; never substitute another tab automatically.

## Evidence and remaining coverage

Historical acceptance includes actual stdio initialize/discovery and UUID isolation. The [2026-10-07 street report](../../docs/36-StreetQualityAndArchitecturalLOD.md) records a real material Edit → Save → Reload roundtrip through Game Editor MCP, color/GUID checks on disk and restoration of the reviewed material. This supersedes the original prototype claim that no live mutation had occurred. It does not certify every semantic edit, race or reconnect path.

This update's automated checks cover loopback restrictions, argument/instance isolation, timeout uncertainty, shutdown cleanup, workflow source/tool references and actual stdio initialize/list/discovery through a controlled broker without a browser. Editor tests cover revision/draft/Play guards, atomic edits, history, disk conflict and projection failure; weapon inspection tests verify detached copies, no hook/time side effects and bounded recent events. These controlled tests are not new headed-browser acceptance.

```powershell
node --test tools/mcp-editor/*.test.mjs
pnpm exec vitest run apps/editor/test/editor-agent.test.ts apps/editor/test/weapon-diagnostics.test.ts --no-file-parallelism
```

Outstanding: semantic asset/component discovery, dedicated authoring controls, rig/IK integration, runtime action commands, client registration, reconnect and full asynchronous human-edit race hardening. Full MCP coverage remains separate follow-up work. Headed hardware-GPU, visible input/UI and in-game listening checks remain complementary for changes in those behaviors.
