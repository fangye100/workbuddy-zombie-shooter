# Game Editor MCP prototype — deferred

This work is parked on `codex/editor-mcp-coverage` at the user's request. The active delivery remains game visual quality on `codex/scene-authoring-loop`. This prototype is not merged, not registered in the user's MCP configuration, and not accepted as a complete agent-friendly game development interface.

## Current shape

`server.mjs` adapts MCP stdio to a loopback-only Vite broker. Requests explicitly identify a connected editor instance. The browser dispatcher calls the existing author store, validation, undo/redo, save service and PlayController. It does not automate DOM clicks or own a second scene state.

Prototype tools cover instance discovery, registered scenes, document inspection, scene creation/opening, atomic NodeId edits, environment editing, validation, history, save, Play control, runtime diagnostics and GPU viewport capture.

Example transport for this machine (TLS validation remains enabled):

```powershell
node tools/mcp-editor/server.mjs --url https://fangye-win11-office.tail6b29a2.ts.net:5100
```

`--ca` accepts an actual issuing CA bundle when required, not the leaf server certificate. The proxy connects to loopback while retaining URL hostname validation. Never disable certificate verification.

## Evidence and outstanding work

- MCP initialize and connected-editor discovery were exercised through the actual stdio transport. Four live instances were distinguished by UUID. No mutation was dispatched through MCP before deferral.
- Typecheck and six dispatcher unit tests cover stale revision rejection, human draft/Play locks, atomic NodeId edits, shared history, invalid environment rejection, disk conflict propagation and post-edit projection failure.
- Live mutation/save/reload/capture acceptance, broker isolation/timeout tests, asynchronous human-edit races, reconnect behavior, semantic component/asset discovery, client registration and complete gameplay-development coverage remain unfinished.
- UI acceptance remains complementary. The eventual goal is the full authoring workflow through business MCP, with visible rendering and user-path checks retained where necessary.

Do not merge or report this prototype as production-ready. Continue this branch as a separate future task.
