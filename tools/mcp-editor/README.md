# Game Editor MCP prototype — opt-in

The user authorized integrating all development on 2026-10-05. This prototype is included in that integration, remains unregistered in the user's MCP configuration and has not completed production acceptance. Normal editor sessions do not enable its broker or browser dispatcher.

## Current shape

`server.mjs` adapts MCP stdio to a loopback-only Vite broker. Requests explicitly identify a connected editor instance. The browser dispatcher calls the existing author store, validation, undo/redo, save service and PlayController. It does not automate DOM clicks or own a second scene state.

Prototype tools cover instance discovery, registered scenes, document inspection, scene creation/opening, atomic NodeId edits, environment editing, validation, history, save, Play control, runtime diagnostics and GPU viewport capture.

For deliberate prototype testing, set `AETHER_EDITOR_MCP=1` before starting Vite, and open the selected editor tab with `?agent=1` (or append `&agent=1` to an existing query). Both switches are required. Use the fixed editor port and existing service-ownership rules; do not replace another session's running server merely to enable the prototype.

Example transport for this machine once the prototype has been enabled (TLS validation remains enabled):

```powershell
node tools/mcp-editor/server.mjs --url https://fangye-win11-office.tail6b29a2.ts.net:5100
```

`--ca` accepts an actual issuing CA bundle when required, not the leaf server certificate. The proxy connects to loopback while retaining URL hostname validation. Never disable certificate verification.

## Evidence and outstanding work

- MCP initialize and connected-editor discovery were exercised through the actual stdio transport. Four live instances were distinguished by UUID. No mutation was dispatched through MCP before deferral.
- Typecheck and six dispatcher unit tests cover stale revision rejection, human draft/Play locks, atomic NodeId edits, shared history, invalid environment rejection, disk conflict propagation and post-edit projection failure.
- Four broker tests cover local/origin restrictions, argument rejection, client/identity isolation, timeout uncertainty and server-shutdown cleanup using controlled clients (`node --test tools/mcp-editor/broker.test.mjs`).
- Live mutation/save/reload/capture acceptance, asynchronous human-edit races, reconnect behavior, semantic component/asset discovery, client registration and complete gameplay-development coverage remain unfinished.
- UI acceptance remains complementary. The eventual goal is the full authoring workflow through business MCP, with visible rendering and user-path checks retained where necessary.

Integration does not establish production readiness. Full agent-friendly development coverage and live acceptance remain separate follow-up work.
