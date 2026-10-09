# Development branch integration, 2026-10-09

## Integrated sources

- `codex/scene-authoring-loop`: `32e16895c1ce4330606ae7a7eb3fa9bd42fb65c1`;
  fast-forwarded and pushed to `main` before the second merge.
- `codex/animation-body-ik-20261007`: `38d2d19fe32dd317d07f293d45392c147dd2eaf5`.
- Binding workspace, H-01 rig and shared-motion branches were already ancestors
  of main. Their existing tips were retained; no duplicate cherry-picks.

## Contract reconciliation

Both branches published scene schema v14 with different migration histories.
The combined schema is v15. Migration `integrated-weapons-audio-body-ik` accepts
either v14 shape: preserves authored arsenal/audio/IK/transitions and derives the
legacy single-weapon arsenal only when absent. Source input is not mutated.
All 13 registered scenes were migrated through the supported migration tool.

Weapon animations remain driven by accepted weapon events. An active IK aim
binding with locomotion enabled retains the gait during fire, and the weapon
phase is not applied to the gait clip. Reload/equip retain their action routing.

## Verification

- Affected-owner Vitest suite: 105 files, 1,485 tests. Two initial failures were
  stale expected migration names, repaired and verified by a focused 21-test
  rerun. The additional gait/weapon regression passed in an 8-test motion run.
- Typecheck, editor build and M0 sample build passed.
- `scene:check` passed: asset hashes, 13 v15 scenes, environment/art/audio checks.
- MCP editor/performance Node tests: 17 passed. Audio Python tests: 5 passed.
- Headed Chrome, secure Tailscale editor URL, WebGPU NVIDIA Lovelace adapter.
  Floor 1 Play loaded the seven-weapon arsenal and all 22 audio buffers; gameplay
  audio events played without audio errors. Stop ledger: 8 registered, 8 disposed,
  pending 0; audio closed with no buffers or voices.
- Registered HumanIK validation scene: four authored motion/IK characters loaded,
  pending 0, loading errors empty. Changed upper-body Play weight from 0.75 to 0.5
  via the visible slider, confirmed in runtime summary; Stop restored authored
  weight 0.75 and disposed both registered resources (pending 0).

Evidence: [Play](../evidence/branch-integration-2026-10-09/ik-play.json),
[Stop](../evidence/branch-integration-2026-10-09/ik-stop.json),
[headed capture](../evidence/branch-integration-2026-10-09/ik-play.png).

Validation limits: desktop device only; no new physical iPhone acceptance or
human audio-quality judgment. Retarget reports still mark existing contact
calibration/capability gaps as partial. Missing mouse target falls back to
animation with an explicit diagnostic; authored angle limits clamp as designed.
This merge does not claim those pre-existing limitations were repaired.

Concurrent WorkBuddy daily logs, untracked deliveries and draft music/voice brief
were preserved outside the merge commit. Further classification work continues
on a separate development branch.
