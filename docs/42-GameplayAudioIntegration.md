# Gameplay audio integration and in-game calibration

This batch puts the eight calibration sound families (22 independent takes) into campaign Play Mode. It is a functional listening build; its sound identity and mix still need feedback while playing. BGM, voice-over, the remaining SFX brief and WorkBuddy's `docs/41` are outside this delivery.

## Source intake and fixes

The delivery already contains isolated WAVs. The preview reel is a listening compilation, not an authoritative source to cut again. `tools/audio/import_calibration.py` verifies and imports the individual takes into `assets/audio/calibration`, preserving existing sidecar GUIDs and user-authored asset settings. Original delivery files are retained in `assets/_delivery/AUDIO-20261007`.

The corrected synthesis batch uses a SHA-256 seed instead of Python's process-dependent `hash()`. Loop crossfades start with the tail continuation and fade back into the original head. Highway filtering happens before loop closure. The 24-bit writer pads odd RIFF data chunks. The reel tool now reads actual delivered samples and repeats full authored loops, including their real join.

Verification requires a nonempty expected inventory, separate take hashes, exact duration/format metadata, bounded sample ranges, 48 kHz/24-bit PCM, minimum 3 dB headroom and one-shot onset within 10 ms. Quiet assets need not peak at exactly -3 dBFS. Loop join measurements are diagnostics, not proof that a listener cannot hear the join.

## Scene data and responsibility

Schema v14 adds optional `RunRules.audio`. Its explicit v13 migration preserves authored data and leaves previously silent scenes silent. All registered scenes use v14; the three campaign floors declare cues, AssetRef path/GUID pairs, weapon bindings, warning distances and mixing limits. `gameplay-audio.json` is an authoring seed; the running scene's configuration is the authority. Audio measurements and loop sample indices belong to each WAV's `.meta.json`.

`AudioFramePlanner` projects accepted weapon events, actual direct flesh contacts (including kills), NPC windup entries and simulation-owned acid effects. It does not write simulation state, change ammo, replace weapon animation hooks or consume gameplay random streams. Source slot reuse cannot transfer an old acid pool to another NPC.

`GameAudio` owns browser decoding, voice admission, variant selection, spatial gain/pan and playback. Vite bundles the WAV URLs and sidecars for both development and production builds. Missing/invalid resources produce a visible audio diagnostic and do not block combat. Each Play session registers audio cleanup in its resource ledger. Stop closes the AudioContext, aborts requests, discards late decode results and releases buffers and nodes. Reset starts a new decode generation without adding duplicate ledger entries.

## Current bindings

| Gameplay fact | Sound |
|---|---|
| Accepted pistol / SMG shot | Dedicated family, alternating takes |
| Direct player hit or lethal contact | Flesh impact, coalesced per target and simulation tick |
| Flame held and actually firing | Flame loop; release/reload/empty ammo/switch removes it |
| E-02 enters attack windup within warning distance | Pounce warning once per state entry |
| E-03 acid flight begins | Acid launch once per attack |
| Unblocked acid pool exists | Positioned pool loop, independent of shooter survival |
| Active battle | Quiet highway ambience |
| Shotgun / sniper / grenade prototype | **Provisional** pitched pistol take; dedicated identity still missing |
| Chainsaw held and firing | **Provisional** slowed flame loop |

Reload/equip clicks, other enemy families, footsteps, UI sounds, explosions, BGM and VO are not fabricated as finished assets. They remain in the resource briefs.

## Mix and user path

Open the game view, click **Ready / Resume**, then play with mouse + keyboard or touch controls. The gesture enables Web Audio under browser autoplay policy. HUD **Sound** opens mute and volume controls; Chinese and English labels are available. Scene master gain is 0.65 by default; the HUD slider multiplies it. Individual cues have authored gains, warning priority exceeds shots and ambience has lowest priority. Limits are 24 simultaneous voices, four flesh voices, 24 MiB decoded data and 28 m spatial attenuation, with warnings within 18 m. A compressor limits dense overlap; its presence is not a claim of final mastering.

Pause, hidden page, mute and terminal outcome stop all voices. Growth choices stop ongoing loops and fresh warnings, while letting the lethal shot/hit that opened the choice finish. Resume does not replay consumed events. No delayed attack sound queue is built during loading or pause.

## Validation and remaining acceptance

- `tools/audio/test_audio.py`: cross-process seed stability, loop blend direction, odd WAV padding and invalid intake paths/format/hash/inventory.
- Scene/runtime/editor tests: migration, bounds and references; saved/reopened gain; actual accepted shot projection; pause/reset; held-fire loop lifecycle; warning entry/range; acid pool source reuse; lethal contacts; failed request recovery and late decode after Stop.
- `pnpm run scene:check` includes the accepted audio inventory and WAV measurements. `scene:gen` merges measured WAV sidecars without discarding authored loop indices.
- Headed Chrome on NVIDIA Lovelace: actual mouse pistol/SMG firing and weapon selection; held flame loop; naturally occurring E-02 warnings; second-floor E-03 launch and pool playback; mute/volume; pause and Stop ledger balance; English/Chinese controls and 390×844 / 844×450 responsive views. Long-run checks temporarily increased player health; the acid test skipped the first wave through the damage API, then observed normal NPC attacks. Final navigation restored the normal first-floor scene. Detailed observations are stored in `docs/evidence/audio-2026-10-07`.

Verified: 682 related Vitest tests, five Python regression tests, TypeScript checking, editor production build and `scene:check`. Chrome decoded all 22 takes into 13,405,440 bytes, with no audio errors. Held flame produced two loops including ambience. Pause produced zero voices/loops; Stop produced zero buffers/bytes/voices and a balanced 4-registered / 4-disposed resource ledger. Generation needs NumPy/SciPy; audio checking needs NumPy. Browser runtime needs neither Python package.

The measurements and actual source starts confirm the playback path. They do **not** establish perceived weapon weight, family distinction at low volume, ambience balance or fatigue under a horde. These are the next in-game listening decisions. Mobile screenshots validate layout in desktop Chrome emulation, not mobile hardware performance or audio latency.
