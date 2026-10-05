# Scene-authored Scavenger player appearance

The three campaign scenes now use the existing H-01 Scavenger textured 10,500-triangle model for the player in Game Editor Play. Its source GLB and sidecar have not been modified. This is a rigid T-pose presentation: walking, weapon holding, recoil and death animations are not supplied by this asset.

## Contract and ownership

- Scene schema v8 adds the optional `MeshRenderer.playBinding: "player"`, valid only on the stable `playerStart` node and an asset mesh that is not `editorOnly`. The v7→v8 migration preserves old scene behavior without inventing bindings. All nine stored scenes are migrated.
- The existing MeshRenderer AssetRef contains both path and GUID (`as_yrsn456i`). Mesh/material edits and the binding checkbox remain scene data. The generator reproduces the same three player configurations.
- `PlayerPresentation` reuses the already-loaded scene object, including texture, material overrides and scale. It synchronizes the runtime copy's position and facing from the real player entity. No player-specific asset path lives in engine or editor code.
- This single player uses the existing authored object slot (floor counts remain 63/56/50). NPC crowds retain the instanced rendering path. RuntimeBridge suppresses only the bound player's capsule; disabling the binding restores capsule rendering and temporarily hides the author marker.
- Gameplay identity, collision radius, weapon, progression and damage remain owned by RuntimeSession. The extended T-pose arms do not enlarge collision geometry. A missing or unresolved bound asset rejects Play with an explicit message instead of presenting placeholder geometry as the character.
- PlayController owns restoration. The presentation allocates no additional GPU resources; the editor retains the pre-existing author mesh. Stop restores its transform/visibility and releases normal Play resources.

## Acceptance, 2026-10-05 (Singapore time)

Headed existing Chrome, HTTPS secure context, NVIDIA Lovelace adapter. The editor service runs from the `codex/scene-authoring-loop` worktree on port 5100. The separate 5101 sample is still the engine's minimal rendering sample and was not used as gameplay acceptance.

1. Opened floor 1 and confirmed 63 objects, the loaded H-01 asset, active texture, 10,500 triangles and approximately 1.8 m height.
2. Clicked Play in the visible toolbar. Only one player representation rendered. At the paused initial frame, the player remained at (3, 0.02, 0), with 100 HP. No errors/warnings were observed in captured browser logs.
3. A local development harness dispatched WASD/J keyboard events through the existing input listeners (no player teleport, direct damage or gameplay-state rewriting). The player moved from x=3 to x=9.749999, fired, killed one enemy and triggered the normal upgrade choice. The rendered yaw (-1.254601 radians) and position matched the runtime player. Dynamic instances numbered 7 for 8 live entities: the one player was rendered by its authored mesh.
4. Stop restored the complete author snapshot, editor camera and serialized scene document. Resource ledger: registered=3, disposed=3, pending=0. Repeated start/reset/stop, paused stepping, asset-load rejection, legacy fallback and death visibility are covered by regression tests.
5. Used the visible scene-node form to disable the binding, apply, save and reload; it remained disabled. Re-enabled it, applied and saved; the UI reported a successful save and reload retained the binding with a clean document. The final generated scenes retain the enabled binding.
6. Final build rendering was checked after the asset readiness invalidation change. [Overview](evidence/player-appearance-2026-10-05/play-overview.png) uses the authored gameplay camera. [Close-up](evidence/player-appearance-2026-10-05/play-closeup.png) uses a temporary diagnostic camera to inspect the coat, scarf and goggles; this camera was restored and was not saved. The editor was left stopped with clean scene state.

Validation commands: scoped player/bridge/controller/snapshot tests, scene schema/migration tests, runtime progression tests, `pnpm run typecheck`, `pnpm run editor:build`, and `pnpm run scene:check`. The build reports its existing bundle-size advisory. No animation or complete gameplay-design acceptance is claimed by this appearance delivery.
