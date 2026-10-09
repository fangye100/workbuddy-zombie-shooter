# CodeGraph MCP for development Agents

## Connect to the intended checkout

The installed local server was verified on 2026-10-09 as `code-graph-mcp`
version `0.167.0`, through MCP `initialize`, `tools/list` and actual
`project_map`/`module_overview` calls. The callable tool names exposed to an Agent
depend on its client; no single vendor's memory or tool namespace is required.

For a client supporting a stdio MCP server, configure the installed `code-graph`
executable with argument `serve`, and working directory equal to the **actual
checkout**. Resolve the installed executable with `Get-Command code-graph` on
PowerShell or the host equivalent. Do not paste another user's global install
path, modify global client settings, or silently run an installer. Windows clients
that cannot execute a `.cmd`/`.ps1` wrapper directly can use the installed Node CLI
entrypoint after resolving it locally. This repository does not change client
registration or grant new MCP permissions.

1. Record `git branch --show-current`, `git rev-parse HEAD`, dirty scope, server
   version, roots and indexing completion. Root-level configs need separate reads.
2. Audited roots: `apps`, `assets`, `packages`, `tools`. `.code-graph/` is an ignored
   derived cache; do not copy another worktree's index or publish its SQLite data.
3. Refresh using the installed server's supported indexing operation/CLI
   (`code-graph incremental-index` in the verified version). Respect another
   indexer holding the lock. Report an incomplete/stale refresh; never delete the
   lock or interrupt another session merely to get a “fresh” map.
   Some versions print a lock warning yet continue indexing. Record both warning
   and returned completion; that does not prove an exclusive, race-free refresh.
4. Discover current arguments with `tools/list`; use `project_map` and a path-scoped
   `module_overview`, then file-qualified AST/reference/call queries. Prefer small
   scoped queries; follow budget omissions/pagination or a supported full export.

Example MCP calls, after initialization:

```json
{"name":"project_map","arguments":{"max_tokens":10000}}
```

```json
{"name":"module_overview","arguments":{"path":"packages/zombie-game/src/session.ts","include_deps":true,"deps_depth":1,"max_tokens":10000}}
```

## Interpretation and fallback

Read the located source to confirm imports, receivers, dynamic dispatch and
ownership. Separate production/tests, type/runtime dependencies and
extracted/inferred/ambiguous calls. This version's directory overview may report
`dependencies_unavailable`; query the specific file rather than treating it as
no dependencies. Same-name `set`, `find`, `clear` calls can produce ambiguous
receiver edges. During this refactor such edges in the controls overview were
confirmed with source imports instead of accepted as couplings. This also occurs
at dependency depth 1: its relationship list is not an AST import manifest.
Export-only barrels can report `files_count: 0`/“No files found” while returning
their export dependencies; read the barrel and source gate before claiming a file
or package is missing. `project_map.entry_points: []` likewise does not mean the
editor has no entrypoint.

Trace Worker URL/message endpoints, `import.meta.glob`, injected registries and
HTTP/WebSocket/MCP dispatch explicitly. Missing static edges do not establish
dead code. Report parser errors/unresolved calls and snapshot boundaries;
do not turn call counts into claims about cost, frequency or quality.

If the MCP is not exposed but its installed stdio server is available, a supported
MCP client/stdio call can still obtain its tools and results. If neither route
works after a reasonable attempt, state the concrete error and use targeted
source reads/search. The rest of the task continues. Do not invent graph results.

The [structure map](../44-CodeGraph代码结构图谱.md) separates the current
2026-10-09 source review from the preserved 2026-10-08 measurements.
[Current ownership](../architecture/layers.md) and the
`architecture:check` source-edge gate govern new code. Refresh after a move;
typecheck, owner tests, scene/content/motion checks and headed GPU paths still
provide the required runtime evidence.
