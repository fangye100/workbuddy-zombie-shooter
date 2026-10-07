# Character control verification — 2026-10-07

## Fixed behavior

Runtime headings use `atan2(z, x)`: zero faces +X and positive angles turn
toward +Z. The nine current character assets face local +Z. The render shader's
Y rotation therefore needs `pi/2 - heading`, rather than the gameplay heading.
`character-facing.ts` owns this conversion; PlayerPresentation, RuntimeBridge
and the PlayController target-camera adapter share it. Navigation, combat rays,
the radar and serialized author transforms retain their existing contracts.

Broodmother's authored `moveSpeed` is zero. Its AI can still enter chase, which
previously selected a walk clip whose phase advanced only with displacement.
RuntimeBridge now selects time-driven idle for chase actors with zero authored
speed. This applies to stationary actors generally and does not change AI,
combat stats, the Broodmother's anchored position or its rig weights.

## Actual verification

- 74 tests pass across player-presentation, runtime-bridge, play-controller and
  play-camera. New regressions cover eight player movement directions, NPC
  displacement versus shader forward, and anchored Broodmother animation.
  Existing player tests now reference the current LOD0 GUID and v11 migration.
- 54 runtime session/combat regressions pass; combat headings stay unchanged.
- Type checking and the editor production build pass.
- Headed Chrome, HTTPS, actual NVIDIA Lovelace, persisted nine-character scene:
  all nine ActorLibrary entries assemble with no diagnostics. All eight NPC
  batches use actual `actor:*` meshes.
- Broodmother at ticks 3 and 15: position stays
  `(2.0162847042, 4.0166220665)`; idle pose advances 33 → 40 and maximum sampled
  bone-matrix change is 0.1421. It is no longer stuck on a walking frame.
- Player: developer keyboard events go through the installed WASD handlers,
  followed by the visible Single Step button. All eight directions produce
  positive displacement and forward/displacement alignment above 0.999999.
  This is input-handler coverage, not an OS keyboard automation claim.
- NPCs: eight deterministic heading fixtures for all eight actual actors,
  runtime bridge instance data and real GPU screenshots. All 64 forward/heading
  alignments exceed 0.999999. Front/back screenshots verify the current assets'
  +Z-facing convention. These fixtures assign headings; they do not claim all
  eight AI agents naturally travel in all eight directions in one session.

Evidence is ignored under `.workbuddy/tmp/character-control-20261007/`:
`mother.json`, `player-directions.json`, `npc-directions.json` and eight headed
direction screenshots. Temporary heading/position/camera changes are confined
to verification Play. Reload restores the authored camera; a subsequent normal
Play/Stop leaves zero dynamic instances.

Different future asset forward axes need an explicit authoring/import contract;
this fix verifies the nine current assets. Boss-specific attacks and previous
cloth/armor deformation limits are outside this control repair.
