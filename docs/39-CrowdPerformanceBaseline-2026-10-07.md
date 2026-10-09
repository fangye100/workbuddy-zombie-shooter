# Crowd performance baseline — 2026-10-07

Sampling was stopped at the user's request. This is a recorded optimization baseline, not a production population limit or a mobile performance acceptance.

## Result and acceptance boundary

The highest **sustained mixed-animation sample actually confirmed** was 1,250 NPCs: 79.40 seconds, 59.96 average FPS, with every 10-second window above 59.79 FPS. Short samples up to 2,250 NPCs passed 50 FPS. The subsequent 2,250-NPC sustained sample averaged 55.00 FPS but fell to 43.80 FPS in a window, so it did **not** pass stability. The 2,500-NPC sustained sample averaged 49.10 FPS with a minimum window of 37.34 FPS.

No further populations or sustained confirmation at 1,500–2,000 NPCs were tested after the stop request. These intermediate counts therefore have short-sample evidence only. Do not describe 2,250 NPCs as a stable capacity merely because its average exceeds 50 FPS.

| NPCs | Duration (s) | Average FPS | Lowest window FPS | Frame P95 (ms) | CPU callback P95 (ms) | GPU passes P95 (ms) | Result |
|---:|---:|---:|---:|---:|---:|---:|---|
| 500 | 22.00 | 59.95 | 59.90 | 16.90 | 5.20 | 5.57 | Short sample passed |
| 750 | 22.00 | 60.00 | 59.99 | 16.90 | 5.40 | 6.49 | Short sample passed |
| 1,000 | 22.01 | 57.75 | 57.30 | 17.00 | 18.50 | 5.83 | Short sample passed |
| 1,250 | 22.00 | 59.77 | 59.60 | 16.90 | 7.90 | 6.09 | Short sample passed |
| 1,250 | 79.40 | 59.96 | 59.80 | 16.90 | 7.70 | 5.90 | Sustained sample passed |
| 1,500 | 22.00 | 57.45 | 56.70 | 17.00 | 19.90 | 6.23 | Short sample passed |
| 1,750 | 22.03 | 58.34 | 57.30 | 16.80 | 17.50 | 6.49 | Short sample passed |
| 2,000 | 22.02 | 59.53 | 59.10 | 16.80 | 15.10 | 7.01 | Short sample passed |
| 2,250 | 22.00 | 59.73 | 59.50 | 16.80 | 11.90 | 7.54 | Short sample passed |
| 2,250 | 113.36 | 55.00 | 43.80 | 33.30 | 20.00 | 15.53 | Sustained sample failed |
| 2,500 | 22.04 | 44.33 | 43.60 | 33.70 | 31.40 | 8.85 | Short sample failed |
| 2,500 | 143.45 | 49.10 | 37.34 | 33.50 | 30.10 | 8.72 | Sustained sample failed |

All rows above used actual gameplay movement and shots with **Run locomotion plus upper-body HumanIK aiming at enemies**. Their submitted NPC instance counts matched the runtime counts. The 500 → 750 → … → 2,500 sequence followed the requested 250-NPC increment. Sustained confirmation revealed instability that the short samples missed.

## Revision, machine and rendering load

- Gameplay/animation source revision: `a24f7b94e12754531cbb43af31b133edaf004056`, branch `codex/animation-body-ik-20261007`. The sampling patch adds optional WebGPU timestamp-query capability and developer instrumentation; it does not change animation algorithms or production population capacity.
- Windows; Intel Core i9-14900HX, 24 cores / 32 logical processors; NVIDIA GeForce RTX 4070 Laptop GPU, 8,188 MiB VRAM; NVIDIA driver 596.21; headed Chrome 154.0.0.0, real NVIDIA/Lovelace adapter.
- Existing QA server: port 5197, this worktree. Scene: `assets/scenes/act1/floor-2.scene.json`, game view, secure HTTPS context. Production ports 5100/5101 were unchanged.
- Mixed-animation runs rendered at **1,353 × 757 pixels** throughout the recorded rows. Earlier control runs used other viewport shapes near one million pixels; their raster sizes are recorded separately in the JSON summary.
- Runtime tier `t1`; NPC baked palette profile: 16 FPS, at most 2 clips. This is desktop hardware running that quality profile, not a phone measurement.
- Four real actor meshes, E-01 / E-02 / E-03 / E-04: 3,000 / 3,300 / 3,600 / 4,800 triangles per instance. No proxy instances in the mixed rows. Draw calls remained 84. The player is a separate authored skinned mesh, not another instanced NPC.
- Submitted NPC body geometry: 1,812,300 triangles at 500; 4,567,500 at 1,250; 8,242,500 at 2,250; 9,162,300 at 2,500. The outline pass adds a further rendering pass; these figures count the body geometry once.
- The machine was shared with other applications and Codex sessions. An earlier device observation showed 7,472 / 8,188 MiB VRAM used; the post-cleanup observation was 6,735 MiB. These are **whole-device** observations, not project resource allocations. Other applications were not closed. Power, thermals and concurrent load were not held constant, so non-monotonic timings cannot be attributed solely to NPC count.

Both character paths deform vertices on the GPU. The authored player evaluates its animation pose and procedural IK on the CPU, then renders GPU-skinned vertices. NPCs use shared baked bone palettes and instanced GPU skinning; CPU simulation selects states, transitions and instance data. CPU pressure in this report is therefore not evidence of traditional CPU vertex skinning. The mixed tests exercise **one player IK assembly**, not thousands of independently solved HumanIK characters or thousands of 80k-triangle player meshes.

## Gameplay fixture and what was exercised

The probe drove the public `RuntimeSession.setInput`, `setAim` and `setFire` APIs before real fixed-step simulation. The player followed a bounded 4 m waypoint loop while continuously requesting fire. Actual movement, ammo consumption, reloads, hits, enemy AI/attacks, hit feedback and rendering remained active. This is automated runtime-input coverage, not physical keyboard/mouse acceptance.

The first movement/combat series used the scene's default animation, which selects a full-body shoot clip while firing. It is archived as `gameplay-*`. It proves gameplay movement and combat load but does not prove simultaneous Run and IK composition. The final `mixed-gameplay-*` series used a transient clone of the scene document and reused the player binding from `assets/scenes/sandbox/body-ik-validation.scene.json`, with the upper-body target set to the supported `enemy` target. `locomotionWhileAiming` kept the retargeted Run clip active. No scene file or asset sidecar was changed.

The fixture gave the player 100,000,000 health and a large ammo reserve to avoid prematurely ending the sample. Normal magazine size and reload duration remained active. It selected available upgrades through the public choice API when needed and replaced killed NPCs with real `debugSpawn` entities, preserving the target count. Extra NPCs were distributed within a 12 m radius. This deliberately dense placement is a capacity fixture, not authored wave balance, normal enemy distribution, or a visual-quality acceptance.

| Capture | Movement | Actual shots / hits | Reloads | Fixed steps | NPC range |
|---|---:|---:|---:|---:|---:|
| Mixed 500, 22 s | 95.16 m | 47 / 47 | 3 | 660 | 500–500 |
| Mixed 1,250, 79 s | 343.71 m | 173 / 173 | 10 | 2,382 | 1,250–1,250 |
| Mixed 2,250, 113 s | 486.09 m | 249 / 249 | 14 | 3,369 | 2,250–2,250 |
| Mixed 2,500, 143 s | 620.72 m | 317 / 317 | 17 | 4,302 | 2,500–2,500 |

Movement and fire were concurrent in all recorded fixed steps in these rows. The mixed sustained rows recorded hits but no kills; they must not be cited as kill/refill stress coverage. The earlier default-animation 500-NPC sustained run did exercise 4 kills / 4 refills and one upgrade choice, with 295 shots, 16 reloads and 579.18 m movement over 133.84 seconds.

HumanIK reported the normal `IK_AIM_LIMIT` clamp in some end snapshots: the target exceeded the authored 75-degree limit. This is preserved in the summary and does not mean the IK chain failed. It also means perfect weapon-target alignment was not established. Shared-motion reports remained `partial`, with derived-marker/contact-calibration/capability warnings. This measurement does not upgrade the existing retarget calibration or validate hand/grip/foot constraints for every character.

![1,250 NPCs during mixed Run and IK combat](evidence/crowd-performance-2026-10-07/mixed-gameplay-1250.png)

## Measurement method and limitations

`tools/verify/crowd-performance-page.mjs` is developer-only. It wraps the existing animation frame loop and actual renderer/simulation calls; it is not imported by the product. Samples began after asset/motion/IK preload and normally a 5-second warm-up. The final 2,250-NPC sustained run began immediately after preload/configuration, so its early phase is retained rather than discarded. Cold downloads, initial retarget solving and shader creation are not isolated loading-time benchmarks.

- FPS = recorded frame count / elapsed wall time. Frame percentiles use actual animation-frame intervals; nearest-rank percentiles are used.
- Stability requires a live advancing runtime, foreground-visible and focused frames, no recorded probe errors, matching runtime/rendered populations, real concurrent movement/fire, hits and reloads. Samples must last at least 20 seconds and their average plus **every recorded 10-second window** must reach 50 FPS. A final partial window is retained if at least one second long. Mixed acceptance additionally requires Run and enabled upper-body IK on the same node.
- CPU callback time covers the measured main frame callback, including game HUD and presentation work. `simulationAndPresentationMs` covers fixed-step runtime advancement, animation/presentation synchronization, bridge refresh and camera work. It is **not pure AI time**. `gameplayStepMs` includes the fixture's input injection, counting/refills and real simulation. CPU stage percentiles are nested/overlapping and must not be summed.
- GPU times are asynchronous timestamp-query durations for the `scene` and `post` render passes. They exclude uploads outside those passes, queue waiting, presentation and browser scheduling. Chrome timestamps in these recordings have 0.065536 ms quantization. They are not end-to-end GPU frame latency.
- Four query/readback pools avoid blocking the game loop. Busy pools drop a GPU sample rather than wait. The 2,250-NPC sustained capture has 6,039 GPU timings for 6,235 CPU frames (196 dropped, 96.86% coverage), so its GPU percentile distribution is incomplete and may omit congested frames. Its CPU/FPS result remains fully recorded. The 2,500-NPC sustained capture has 7,043 GPU timings for 7,044 frames; the 1,250-NPC sustained capture has 4,761 / 4,761. Do not compare incomplete GPU timing distributions as if coverage were identical.
- Early `baseline-*` captures and `focused-500` are retained as setup controls, not gameplay acceptance. The unfocused/insufficient-focus controls gave about 20–25 FPS despite modest CPU/GPU pass timings. Foreground/focus was subsequently checked per frame. Focus checks cannot establish that no other OS/browser scheduling interruption occurred.
- Earlier default-animation 1,500-NPC samples ranged from 30.18 FPS to 59.63 FPS; a longer run contained roughly one-second scheduling gaps. These records are preserved. The cause was not isolated, and they are not a deterministic population limit. No debugger CPU profile was collected: that capability was unavailable through the supported browser connection.
- The mixed 2,500-NPC long run ended with some windows near 60 FPS after several windows below 50. Stability uses the entire sample; later recovery does not erase earlier failure.

## Optimization references, without expanding this task

The 2,500-NPC sustained CPU callback P95/P99 were 30.10/36.40 ms, simulation/presentation P95 15.90 ms, render CPU P95 4.70 ms and encoding P95 3.20 ms. GPU measured-pass P95/P99 were 8.72/9.63 ms. This suggests substantial main-thread pressure in that recording; it does not identify an individual AI/IK/HUD function or exclude GPU queuing and external load.

The 2,250-NPC sustained run also showed GPU pass P95/P99 of 15.53/22.87 ms with dropped GPU measurements, compared with short-run P95 7.54 ms. Future optimization should separate simulation/avoidance/target searches, bridge packing and transitions, HUD/VFX, pose evaluation and GPU work, while recording GPU coverage and controlling external load. Do not assume a CPU-only bottleneck from one recording.

Future comparisons should use the same revision-tagged fixture, asset mix, resolution, quality profile and movement/fire path. Add dedicated sustained runs at intermediate counts, isolate cold loading separately, record thermals/clock and scheduling state, and compare measured percentiles/windows rather than one instantaneous FPS value. These are reference items only; **no additional optimization or sampling was started after the user's stop request**.

## Evidence, replay and cleanup

- [Machine-readable summary](evidence/crowd-performance-2026-10-07/summary.json): all 31 captures, original SHA-256 values, percentiles, complete window FPS lists, runtime actions, geometry counts, animation reports, query coverage and cleanup state.
- [Raw archive](evidence/crowd-performance-2026-10-07/captures.zip): original JSON captures, cleanup JSON and the recorded screenshots. The ZIP and PNG are tracked with Git LFS. Rejected/setup captures are retained rather than removed.
- [Developer probe](../tools/verify/crowd-performance-page.mjs) and [offline report generator](../tools/verify/crowd-performance-report.mjs).

To recompute the report after extracting the archive, run:

```powershell
node tools/verify/crowd-performance-report.mjs <extracted-directory> <output-summary.json>
node --test tools/verify/crowd-performance-page.test.mjs
```

To reproduce a browser fixture in a future authorized test, use a headed real-GPU editor page through the supported browser developer connection: install `crowdPerformanceBootstrap` and `installCrowdPerformance`; while stopped call `prepareCrowdMixedAnimation` and `prepareCrowdCapacity`; use the actual Play UI; wait for actor/motion/IK preload; reset/pause; call `configureCrowdPopulation` and `driveCrowdGameplay`; resume and switch to game view. Bring the page to the foreground, warm up, then call `begin`, `end` and `snapshot`. Increase capacity only in that stopped test tab, by constructing the real `PlaySession`; production remains 512. Stop through the UI and call `dispose` to restore the session and document reader. These exports are evaluated in page scope; they are not a product-facing feature or a standalone browser launcher.

The test was stopped and cleaned up: original capacity 512 restored, Play ledger registered 3 / disposed 3 / pending 0, dynamic instance slots empty, dynamic palette released, transient IK removed, profiler hooks and query resources removed. Original document has 61 nodes and the player's authored IK field remains unset. No assets or scene files changed. The retained QA service belongs to this worktree; its existing logs/PID are under `.workbuddy/tmp/body-ik/`.

The archived run's profiler pools were separately owned and explicitly disposed after Stop; the recorded ledger counts above cover the engine's Play resources. The checked-in probe additionally registers query/readback pools with PlaySession and uses idempotent disposal, so future Stop/dispose cycles release them even if explicit probe cleanup is missed. Future ledgers will include those extra resource entries. This lifecycle bookkeeping was covered by an offline test after sampling stopped; it did not change the recorded captures.

Validation: 11 offline evidence/lifecycle tests and 2 optional-GPU-capability tests passed; TypeScript checking and editor production build passed. No further performance samples were taken after stopping. The build's existing large-chunk warning remains.
