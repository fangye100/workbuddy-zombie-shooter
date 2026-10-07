# Gameplay sound-effect asset brief

Version: 2026-10-07. Production brief for WorkBuddy or a sound designer.
This document requests assets; it does not implement audio playback or authorize
paid generation. Follow the weapon contract in [docs 39](39-Unified-weapons-and-animation-hooks.md),
the animation/VFX brief in [docs 38](38-GameplayActionAndVfxAssetBrief.md),
and the character identities in `assets/characters/roster.json`.

## 1. Current scope and sound direction

The current seven weapon prototypes are pistol, shotgun, SMG, sniper, chainsaw,
flamethrower and a grenade launcher extension. Runtime exposes accepted weapon
actions, reload stages, combat damage/kill events and enemy attack effects.
The Asset Browser recognizes audio extensions, and the AI package exposes an
SFX notify callback. The eight-family calibration batch is now wired into campaign
Play Mode; playback, provisional bindings and listening acceptance are tracked in
[docs 42](42-GameplayAudioIntegration.md). The remaining brief is still pending.
No audio files were found under `assets` during this inventory; no playback
service was found in the inspected editor, sample or runtime code.

Create a readable American comic-book action soundscape: chunky attack
transients, dry mechanical detail, exaggerated but controlled impact bodies,
brief gritty tails and a little industrial character. Gun families and enemy
attack types must remain distinguishable at low volume in a dense horde.
Avoid cinematic reverb baked into close sounds, ultra-deep bass that disappears
on phone speakers, harsh sustained treble, recognizable commercial recordings,
speech, music, logos and voiceover. Zombie sounds are nonverbal, stylized and
restrained; impacts must not sound like realistic dismemberment.

Priority means production order, not a claim that the associated audio adapter
already exists:

- **P0:** weapon identity, attack warnings and immediate damage feedback.
- **P1:** reload/equipment detail, locomotion, run feedback and current ambience.
- **P2:** additional surface variants, future locations and future boss abilities.

Inventory: **78 cue IDs** (32 P0, 38 P1, 8 P2), requesting **196 individual
variant files** if every row is produced. The initial eight-ID calibration batch
requests only **22 variant files**. These counts exclude preview reels, masters
in additional formats and delivery manifests. Do not treat this inventory as an
instruction to generate the entire batch before calibration.

Duration ranges below are creative targets. Deliver measured durations. A sound
must never decide attack timing, reload completion, damage or entity movement.

## 2. Delivery and technical specification

- Deliver to `assets/_delivery/AUDIO-<YYYYMMDD>/<ID>/`. Each ID contains
  `source/`, `runtime/`, `preview/` and `delivery.json`. Do not write directly over
  accepted game assets. Accepted placement is proposed as `assets/audio/`;
  integration must add binary LFS rules and the necessary asset metadata first.
- Master: **48 kHz, 24-bit PCM WAV**. Use mono for localized weapons, footsteps,
  impacts and enemies; stereo for nonlocalized ambience and UI only where it
  improves the cue. Do not bake stereo panning into a mono positional source.
- Supply trimmed WAV runtime candidates. Compressed browser delivery is an
  integration decision after checking supported decoders and loop behavior;
  do not discard the lossless source or use MP3 as the only master.
- One-shot onset should normally be within **10 ms**, with no cut transient or
  unintended leading silence. Retain natural tails. Apply tiny fades only where
  needed to remove clicks. Leave at least **3 dB peak headroom** in delivered WAVs;
  no clipping, hard-limiter distortion or loudness competition between variants.
  Calibrate perceived loudness against the approved sample set, not by peak
  normalization alone. Short transients do not need a mandatory LUFS target.
- Loops require measured sample indices: `loopStartSample`, `loopEndSample`
  (exclusive) at 48 kHz. Provide a seamless pre-rendered loop preview with at
  least three repetitions. Keep start/body/stop parts separate. No crossfade
  timing may alter the simulation. Check mono fold-down and small-speaker clarity.
- File naming: `<ID>__v01.wav`, `__v02.wav`, etc. Variants are different takes,
  not duplicates with only pitch/volume edits. Each table's variant count applies
  to that individual ID. A preview reel may combine takes; runtime files may not.
- A loop is an independent audio resource, not a texture atlas. Runtime should
  cache a decoded buffer per accepted resource and share it among voices. Do not
  concatenate all cues into one file or assume concatenation reduces mixing cost.
- Per-ID `delivery.json`: `id`, `version`, `priority`, `status`, description,
  tool/author, source and license/provenance, file list and SHA-256 hashes,
  measured sample rate/bit depth/channels/duration/peak, variant names, loop
  indices, intended trigger and bus, known defects and generation capability.
  Explicitly list failed or missing assets; a silent file is not a completed cue.

## 3. Weapon firing and sustained effects

All weapons below use the existing stable weapon IDs from scene data. Close
shot files combine the muzzle report and short mechanical body. Do not add a
second generic gunshot over the same event. Range/reverb belongs to the mixer.

| Asset ID | Priority / variants | Detailed sound brief | Length / playback | Intended trigger and position |
|---|---|---|---|---|
| SFX-WPN-PISTOL-SHOT | P0 / 3 | Heavy compact pistol: sharp dry crack, chunky midrange thump, short metal slide click; confident rather than a cannon | 0.18-0.35s / one-shot | Accepted `pistol` fire; muzzle |
| SFX-WPN-SHOTGUN-SHOT | P0 / 3 | Wide rough blast, solid low-mid body, short granular air tail; clearly heavier and broader than pistol | 0.35-0.65s / one-shot | Accepted `shotgun` fire; one cue per shot, not per pellet |
| SFX-WPN-SMG-SHOT | P0 / 4 | Tight dry mechanical pop, small spring/bolt texture, fast attack and short tail; usable at current 0.09s base cadence without a continuous roar | 0.08-0.18s / one-shot | Every accepted `smg` shot; muzzle; no prerecorded fixed-length burst |
| SFX-WPN-SNIPER-SHOT | P0 / 3 | Distinct hard precision crack and deep restrained body, slightly longer air tail; bolt handling delivered separately | 0.45-0.85s / one-shot | Accepted `sniper` fire; one report even when penetration hits several targets |
| SFX-WPN-LAUNCHER-LAUNCH | P0 / 3 | Hollow industrial tube thump, short gas puff and latch rattle; distinguish from shotgun | 0.20-0.40s / one-shot | Accepted `launcher` fire; muzzle; never the explosion cue |
| SFX-WPN-LAUNCHER-FLIGHT | P1 / 1 | Quiet airy spin/flutter with modest midrange movement; no missile-engine roar | 0.4-0.8s / seamless loop | Live grenade projectile position; stop on collision/expiry/reset |
| SFX-WPN-LAUNCHER-EXPLODE | P0 / 3 | Punchy comic blast, brief distorted industrial body and light gravel debris; little lingering rumble | 0.50-1.0s / one-shot | Actual projectile explosion effect at impact position, not launch |
| SFX-WPN-SAW-START | P0 / 2 | Short motor pickup, coarse sputter settling into a readable buzz | 0.15-0.30s / one-shot | Start of an accepted chainsaw use interval; weapon |
| SFX-WPN-SAW-LOOP | P0 / 2 | Loaded chain motor, tooth rhythm and midrange grit; controlled high frequencies, no piercing constant whine | 0.8-1.5s / seamless loop | Sustained accepted chainsaw action; one owned voice, not one voice per simulation tick |
| SFX-WPN-SAW-STOP | P0 / 2 | Fast motor rundown with a small final chain rattle | 0.12-0.30s / one-shot | End of saw use, release or unequip; skip dramatic rundown on Stop cleanup |
| SFX-WPN-SAW-CONTACT | P0 / 3 | Short coarse cloth/armor grind plus blunt contact, different from motor body; no graphic wet gore | 0.12-0.25s / one-shot | Actual melee damage contact, rate-limited separately from motor |
| SFX-WPN-FLAME-START | P0 / 2 | Dry igniter tick followed by brief whoosh into flame body | 0.12-0.25s / one-shot | Start of accepted flame use; muzzle |
| SFX-WPN-FLAME-LOOP | P0 / 2 | Pressurized warm rushing flame, gritty low-mid turbulence, restrained high hiss; no explosion beats | 1.0-2.0s / seamless loop | Sustained accepted flame action; one source at the muzzle |
| SFX-WPN-FLAME-STOP | P0 / 2 | Valve closure and short fading breath of flame | 0.10-0.25s / one-shot | Release, exhaustion or unequip; stop loop immediately when gameplay stops |
| SFX-WPN-DRY | P0 / 2 | Small dry trigger/bolt click; noticeable but quieter than a report | 0.06-0.12s / one-shot | Failed empty-ammo attempt; requires a distinct adapter signal, not `onFire` |

For saw/flame, hold input alone is insufficient to start audio: switching,
reload, a choice panel or exhausted ammo may block the action. The future audio
adapter should derive an accepted-use interval from action state/accepted-fire
edges, stop it on suspension and avoid repeatedly replaying start/stop every
0.1s. That interval is not currently a dedicated runtime event.

## 4. Reload, handling and equipment

Deliver components, not a fixed full reload recording. Reload can be interrupted,
retimed and performed by FBX or procedural IK. Mechanisms follow the accepted
weapon mesh; do not assume every rifle has a bolt lever or every canister a
magazine release. These source sound ideas are subject to mesh calibration.

| Asset ID | Priority / variants | Detailed sound brief | Length / playback | Intended action marker |
|---|---|---|---|---|
| SFX-WPN-PISTOL-MAG-OUT | P1 / 2 | Compact release click and short metal/polymer magazine slide | 0.10-0.20s / one-shot | `pistol` magazine-out |
| SFX-WPN-PISTOL-MAG-IN | P1 / 2 | Firm compact insertion and latch snap | 0.10-0.20s / one-shot | `pistol` magazine-in |
| SFX-WPN-PISTOL-CHAMBER | P1 / 2 | Short metal slide rack and spring return | 0.15-0.30s / one-shot | `pistol` chamber |
| SFX-WPN-SMG-MAG-OUT | P1 / 2 | Lighter quick release and short loose rattle | 0.10-0.20s / one-shot | `smg` magazine-out |
| SFX-WPN-SMG-MAG-IN | P1 / 2 | Snappy narrow magazine seating with spring click | 0.10-0.20s / one-shot | `smg` magazine-in |
| SFX-WPN-SMG-CHAMBER | P1 / 2 | Small bolt pull and crisp return | 0.12-0.25s / one-shot | `smg` chamber |
| SFX-WPN-SNIPER-MAG-OUT | P1 / 2 | Heavier deliberate release and metal movement | 0.12-0.25s / one-shot | `sniper` magazine-out |
| SFX-WPN-SNIPER-MAG-IN | P1 / 2 | Low clack and secure latch; distinguish from pistol | 0.12-0.25s / one-shot | `sniper` magazine-in |
| SFX-WPN-SNIPER-BOLT | P1 / 2 | Two readable bolt movements and final locking clack | 0.20-0.40s / one-shot | Chamber marker; optional post-shot bolt marker when that motion exists; never double-play |
| SFX-WPN-SHOTGUN-SHELL | P0 / 3 | Brass/plastic shell slid into receiver, small spring latch; compact enough for 0.55s insertion cycles | 0.10-0.20s / one-shot | One shell insertion per completed/marked shell cycle; do not play magazine-out |
| SFX-WPN-SHOTGUN-PUMP | P1 / 2 | Chunky two-part fore-end rack, metal scrape and positive lock | 0.18-0.35s / one-shot | Calibrated post-shot/reload-end pump marker if the accepted weapon uses a pump |
| SFX-WPN-FLAME-CAN-OUT | P1 / 2 | Connector click and tiny pressure release, with a short canister movement | 0.15-0.30s / one-shot | `flame` magazine-out mapped to canister |
| SFX-WPN-FLAME-CAN-IN | P1 / 2 | Heavy connector seat, twist/lock and small valve click | 0.20-0.35s / one-shot | `flame` magazine-in mapped to canister; no fake bullet chamber sound |
| SFX-WPN-LAUNCHER-ROUND-OUT | P1 / 2 | Tube/breech latch opens and a hollow casing movement | 0.15-0.30s / one-shot | Launcher opening/removal marker; adjust to final concrete feed mechanism |
| SFX-WPN-LAUNCHER-ROUND-IN | P1 / 2 | Large round seats with a hollow thud and firm breech closure | 0.20-0.40s / one-shot | Launcher insertion/closure marker; adjust to final concrete feed mechanism |
| SFX-WPN-EQUIP | P1 / 3 | Short strap/cloth rustle and grip/stock contact; no gunshot | 0.12-0.25s / one-shot | Acquire incoming grip; weapon mount |
| SFX-WPN-UNEQUIP | P1 / 3 | Softer cloth movement and restrained sling/holster click | 0.12-0.25s / one-shot | Release outgoing grip; weapon mount |

Current reload target durations are 1.6s pistol, 0.55s per shotgun shell, 1.8s
SMG, 2.1s sniper, 2.2s flame and 2.4s launcher. Existing procedural phases are
0.2 out / 0.65 in / 0.85 chamber. These are mapping defaults, not baked offsets
in audio files. The chainsaw has no ammo reload. Shell pump/end and sniper
post-shot bolt require a calibrated motion marker or adapter rule; they are not
newly implemented hooks. Ignore mechanism-inapplicable generic stages.

## 5. Impact and player feedback

| Asset ID | Priority / variants | Detailed sound brief | Length / playback | Intended trigger |
|---|---|---|---|---|
| SFX-HIT-FLESH | P0 / 4 | Dry thick comic thwack with a little cloth; restrained wet layer, no gore detail | 0.10-0.22s / one-shot | Actual bullet damage to ordinary zombies; target position |
| SFX-HIT-ARMOR | P0 / 3 | Compact bright clank, dark body and brief scraped rattle | 0.12-0.30s / one-shot | Shield/armor contact only when impact classification exists |
| SFX-HIT-CONCRETE | P1 / 3 | Hard tick/crack with small sandy chips | 0.10-0.25s / one-shot | Actual finite-solid shot collision with authored concrete classification |
| SFX-HIT-METAL | P1 / 3 | Sharp ping and short sheet-metal body; no long musical ringing | 0.12-0.30s / one-shot | Actual metal collision; do not assume material from model appearance |
| SFX-HIT-BURN | P1 / 2 | Small dry fire catch and crackle accent | 0.15-0.35s / one-shot | Burn status starts; not each DoT tick |
| SFX-PLAYER-HURT | P0 / 3 | Brief breath/grunt with a small armor-cloth impact; no words, identity neutral | 0.15-0.35s / one-shot | Nonzero player damage; rate-limited |
| SFX-PLAYER-DOWN | P0 / 2 | Short exhausted breath and low body/gear fall | 0.40-0.80s / one-shot | Player death once; do not also stack hurt on the lethal event |
| SFX-PLAYER-LOW-HP | P1 / 1 | Subtle double heartbeat with a soft muffled body; no loud alarm or endless treble | 1.2-2.0s / seamless loop | Enter low-HP presentation state; threshold/crossfade must be authored later |

Shotgun pellets and piercing hits must not produce uncontrolled impact stacks.
Coalesce contacts on the same target within a shot; cap nearby impact voices.
Existing CombatEvent provides target/source identity but not a complete weapon
or surface classification. The later integration must enrich or correlate
simulation impact facts; it must not identify materials by raycasting the image
or infer which weapon caused old DoT from the currently equipped weapon.

## 6. Enemy identity and attack readability

Enemy descriptions below follow the existing roster. No dialogue or language
variants are required. Anticipation duration is randomized by gameplay: deliver
short warning accents plus extendable loops when needed, rather than baking an
entire fixed telegraph into a clip. Source identity uses runId/slot/generation.

| Asset ID | Priority / variants | Detailed sound brief | Length / playback | Intended trigger |
|---|---|---|---|---|
| SFX-E01-AMBIENT | P1 / 4 | Loose breath, dry low groan and cloth drag; quiet background threat | 0.5-1.2s / one-shot | Nearby wanderer E-01 idle/move scheduler, never every frame |
| SFX-E01-SWIPE | P0 / 3 | Arm swing whoosh with a brief strained throat rasp | 0.20-0.40s / one-shot | E-01 actual melee release, within attack logic |
| SFX-E02-POUNCE-WARN | P0 / 3 | Tight inhale and rising short animal-like rasp; recognizably different from swipe | 0.20-0.40s / one-shot | E-02 accepted windup entry; warn before launch |
| SFX-E02-POUNCE-LAUNCH | P0 / 3 | Abrupt rasp, leg push and small air rush | 0.15-0.30s / one-shot | Pounce trajectory starts, not damage time |
| SFX-E02-POUNCE-LAND | P0 / 3 | Blunt pavement/gear smack and little debris | 0.20-0.40s / one-shot | Actual landing or obstruction; damage cue only if it hits |
| SFX-E03-ACID-WARN | P0 / 3 | Hollow pressure swell with coarse wet bubbling; not an ordinary zombie groan | 0.25-0.50s / one-shot | E-03 windup; voice must be readable beside firing |
| SFX-E03-ACID-LAUNCH | P0 / 3 | Short pressurized liquid pop and soft gulp | 0.15-0.30s / one-shot | Acid effect begins `flight`; source position |
| SFX-E03-ACID-SPLASH | P0 / 3 | Broad thick splash, tiny droplets and sizzling entry | 0.25-0.50s / one-shot | Actual flight-to-pool transition; blocked flight uses contact variant, no invented ground pool |
| SFX-E03-ACID-POOL | P0 / 2 | Low bubbling/corrosive fizz with intermittent soft pops | 1.0-2.0s / seamless loop | Live pool position, ends with pool expiry; not per damage tick |
| SFX-E04-CHARGE-WARN | P0 / 3 | Shield scrape/cock-back and low strained growl | 0.25-0.50s / one-shot | E-04 accepted windup |
| SFX-E04-CHARGE-MOVE | P1 / 2 | Fast armor rattle with low foot friction; little sharp treble | 0.6-1.0s / seamless loop | Live charge trajectory, stops when blocked/finished |
| SFX-E04-CHARGE-IMPACT | P0 / 3 | Heavy shield clang with a compact body thump | 0.25-0.50s / one-shot | Actual collision/contact, never merely reaching attack range |
| SFX-E05-FUSE | P0 / 2 | Recognizable rising electronic-organic buzz/pulse, comic danger signal | 0.6-1.0s / seamless loop | E-05 fuse state; adapter varies urgency with normalized windup phase |
| SFX-E05-EXPLODE | P0 / 3 | Puffy corrosive blast, gritty low-mid body and thick fluid debris; distinct from grenade | 0.50-0.90s / one-shot | Actual E-05 detonation; cancel fuse on death before detonation |
| SFX-NPC-HURT | P1 / 4 | Short dry breath/rasp; varied midrange, no long scream | 0.15-0.35s / one-shot | Surviving enemy nonzero damage; strongest nearby cue gets priority |
| SFX-NPC-DOWN | P1 / 4 | Brief extinguished groan, soft gear/body fall; avoid repeating exact rhythm across a horde | 0.35-0.70s / one-shot | Actual kill once, never inherited by reused slot |
| SFX-B01-SLAM-WARN | P1 / 2 | Heavy inhale, shoulder/cleaver creak and restrained low growl | 0.30-0.60s / one-shot | Butcher B-01 slam windup if that phase is exposed |
| SFX-B01-SLAM-IMPACT | P0 / 3 | Dense grounded smash, short metallic edge and rubble scatter | 0.40-0.80s / one-shot | Existing `slam` effect at actual impact |
| SFX-B02-PRESENCE | P2 / 2 | Layered hollow organic breathing, soft brood-like clicking, no recognizable speech | 1.0-2.0s / one-shot | Mother B-02 future encounter; identity only, ability specifics deferred |
| SFX-B03-PRESENCE | P2 / 2 | Unstable restrained breath with short mechanical-biological texture | 0.8-1.6s / one-shot | Patient Zero B-03 future encounter; identity only, ability specifics deferred |

Do not invent B-02/B-03 skill timing from the presence sounds. Their concrete
attack cues require approved ability definitions and runtime contracts first.
Death of an acid shooter does not erase an already launched projectile/pool;
its audio must follow the effect lifetime, not the shooter's current slot.

## 7. Locomotion, environment and interaction

| Asset ID | Priority / variants | Detailed sound brief | Length / playback | Intended trigger |
|---|---|---|---|---|
| SFX-STEP-ASPHALT | P1 / 5 | Heavy boot, dry road grit and a little gear movement | 0.10-0.25s / one-shot | Actual player foot contact; current highway baseline |
| SFX-STEP-CONCRETE | P1 / 5 | Compact hard boot tap with slight sandy scuff, less grit than asphalt | 0.10-0.25s / one-shot | Authored concrete floor contact |
| SFX-STEP-METAL | P2 / 4 | Boot clack with a low plate response, restrained ring | 0.12-0.30s / one-shot | Authored metal surface contact |
| SFX-STEP-WET | P2 / 4 | Boot and small shallow splash; no deep-water slosh | 0.12-0.30s / one-shot | Authored wet surface, not inferred from a green decal |
| SFX-ENV-HIGHWAY-BED | P1 / 1 | Empty suburban road: low wind, distant industrial hum, sparse rustling; no constant near gunfire or identifiable traffic | 20-30s / seamless stereo loop | Current highway location bed; low beneath combat |
| SFX-ENV-FIRE-LOOP | P1 / 2 | Small localized burning debris, restrained crackles and low flame body | 4-8s / seamless mono loop | Authored active fire source, not every glowing material |
| SFX-ENV-METAL-CREAK | P2 / 3 | Distant damaged sign/fence creak, short and irregular | 0.6-1.5s / one-shot | Authored scenery emitter with jittered sparse schedule |
| SFX-ENV-WAREHOUSE-BED | P2 / 1 | Low roof resonance, draft and remote pipes, occasional muted structure movement | 20-30s / seamless stereo loop | Future approved warehouse scene |
| SFX-ENV-SUBWAY-BED | P2 / 1 | Low ventilation draft, remote rail/pipe resonance, sparse water drip; no train passing through gameplay | 20-30s / seamless stereo loop | Future approved subway scene |
| SFX-ENV-HOSPITAL-BED | P2 / 1 | Sterile air hum, soft intermittent electric texture and restrained distant metal | 20-30s / seamless stereo loop | Future approved hospital scene |
| SFX-INTERACT-SUPPLY | P1 / 3 | Small practical latch, package/gear rustle and compact reward accent | 0.25-0.50s / one-shot | Successfully taking a supply; not pressing E out of range |

Use boot contact markers from accepted FBX or procedural locomotion. Do not
play footsteps every rendered frame or at a fixed rate while motion is blocked.
NPC steps can initially share a small quiet subset or be culled entirely; hundreds
of independent full-volume footsteps are not a production target.

## 8. UI and run-state feedback

| Asset ID | Priority / variants | Detailed sound brief | Length / playback | Intended trigger |
|---|---|---|---|---|
| SFX-UI-CONFIRM | P1 / 2 | Short warm click/tick, slightly rising, no long melody | 0.06-0.15s / one-shot | Successful UI choice; 2D UI bus |
| SFX-UI-DENIED | P1 / 2 | Small low double tick, clearly different from confirm; not punitive | 0.10-0.20s / one-shot | Failed purchase/upgrade/equipment request, rate-limited |
| SFX-UI-UPGRADE | P1 / 2 | Crisp mechanical snap with brief bright reward shimmer | 0.25-0.45s / one-shot | Actual `upgraded` event or accepted talent purchase; avoid duplicate confirm |
| SFX-RUN-WAVE | P1 / 2 | Short tense midrange pulse and industrial knock; not a huge cinematic sting | 0.40-0.70s / one-shot | `wave-start` once |
| SFX-RUN-ROOM-CLEAR | P1 / 2 | Short relieving comic reward hit with two small ascending accents | 0.45-0.80s / one-shot | `room-cleared` once |
| SFX-RUN-FLOOR-CLEAR | P1 / 2 | Slightly fuller affirmative reward accent, ends cleanly | 0.70-1.20s / one-shot | `floor-clear` once; supersedes room-clear if simultaneous |
| SFX-RUN-GAME-OVER | P1 / 2 | Brief low descending mechanical/organic sting, restrained and readable | 0.60-1.10s / one-shot | `game-over` once; balance with player-down |

UI cues contain no Chinese/English speech or baked spoken button labels, so both
languages use the same assets. BGM, voiceover and localized dialogue are outside
this SFX batch. Do not substitute a music loop for an ambience bed.

## 9. Proposed integration contract and performance targets

These are requirements for the later audio implementation, not new schema fields
or verified capabilities:

- Persist authored emitters, cue mappings, bus settings and relevant thresholds
  in scene/project data after extending the schema and migration chain. Use
  stable NodeId for emitters and path + GUID AssetRef for accepted files.
  Imported audio measurements belong to sidecars. A generation delivery manifest
  is not a replacement for the project's scene or asset schema.
- Subscribe to accepted `WeaponSystem.events` for firing/upgrades/equipment and
  compose reload-stage observers with existing animation consumers. The current
  `setAnimationHooks` replaces the observer bundle; an audio consumer must not
  overwrite HumanIK callbacks. A subscription/fan-out adapter is future work.
- De-duplicate weapon edges by runId + sequence. Combat identity includes
  runId/slot/generation/tick; pellet and simultaneous contacts additionally need
  impact grouping. Enemy effect phases need owned edge detection/IDs because the
  current list is state, not a replay-safe audio event stream.
- One audio voice per owned loop. Stop/reset/scene change release all voices;
  unequip stops old weapon loops. Pause freezes or suspends world audio without
  replaying old attacks on resume; UI confirmation may remain available. On web,
  unlock the audio context from the user's Play/Resume gesture and present
  blocked-audio status rather than treating autoplay failure as success.
- Draft caps: **32 simultaneous gameplay voices on desktop, 16 on mobile**,
  plus at most two ambience beds during a transition. Within that budget reserve
  warning/player feedback slots (4 desktop, 3 mobile), and cap impact voices at
  6/3. Cull quiet/distant idle groans and footsteps before accepted attack warnings.
  These are starting budgets requiring measurement, not device guarantees.
- First decoded working-set target: **<=16 MiB mobile, <=32 MiB desktop** for
  the active scene; keep source masters separate and load other locations on
  demand. Estimate decoded memory as frames x channels x 4 bytes. A 30s stereo
  48 kHz bed is approximately 11 MiB, so never preload all four location beds on
  mobile. Long beds may need streaming or shorter accepted alternates.
- Randomly choose variants without immediate repeats; allow subtle pitch/gain
  variation for footsteps/groans. Warning timing remains simulation-owned.
  Enemy state jitter must not be replaced with a random audio start delay.
- Separate Master / Weapons / Enemy / Player / Ambience / UI gains. Duck
  ambience during warnings and prioritize a threatening nearby attacker. Choose
  positional attenuation around the **gameplay listener**, not the distant
  elevated camera without calibration. Check moving source pan in the current
  view; a centered player should not sound distant because the camera is high.
- Proposed fail-soft behavior: missing optional file is a visible diagnostic
  and a silent presentation fallback; it cannot stop combat, grant ammo or alter
  attack state. Placeholder synthesis may use clicks/noise/tone, but must be
  labelled placeholder rather than an accepted delivered asset.

## 10. Production batches and acceptance

### Calibration batch: eight individual IDs

Produce only these first, each with the variants specified in its table:
SFX-WPN-PISTOL-SHOT, SFX-WPN-SMG-SHOT, SFX-WPN-FLAME-LOOP,
SFX-E02-POUNCE-WARN, SFX-E03-ACID-LAUNCH, SFX-E03-ACID-POOL,
SFX-HIT-FLESH, SFX-ENV-HIGHWAY-BED.

Preview individually, then in a short illustrative mixed reel (pistol/SMG,
nearby warning, hit and quiet bed). The reel is a loudness/style reference, not
runtime acceptance. Confirm family separation, transient clarity and seamless
loops before expanding to the remaining P0 IDs, then P1. P2 follows actual
location/ability development; do not generate speculative boss skill packs.

Reusable generation prompt; fill it from one table row at a time:

> Generate only [ASSET ID] for a stylized American comic-book zombie action
> game. Sound description: [ROW DESCRIPTION]. Duration: [ROW RANGE]. Format:
> [MONO OR STEREO]. Provide [VARIANT COUNT] distinct takes. Playback:
> [ONE-SHOT OR SEAMLESS LOOP]. Dry close perspective for positional effects,
> bold readable midrange, controlled bass and treble, no baked room reverb,
> no speech, no music, no borrowed recognizable recording, no unrelated sound
> bed, no clipped transient. For loops supply a seamless body and measured
> loop points; start/stop parts are separate requested IDs. Deliver isolated
> WAV sources, real measured metadata, provenance and a preview. If the tool
> cannot generate actual audio, report that limitation; do not return a text
> description or silent WAV as a completed asset.

Delivery acceptance checklist:

1. IDs, files, actual variants and hashes match the manifest; sources/license are
   recorded and failed items are explicit. All files decode, channels and rates
   match, no corrupt/silent/duplicate-by-mistake takes.
2. Listen on headphones and ordinary speakers; compare low-volume mono
   playback for mobile clarity. Check onsets, peak headroom and three loop
   repetitions for clicks, periodic thumps or a changing noise floor.
3. Verify gun families, warning types and impact types remain distinct in the
   reference mix; flame/saw do not mask warnings, SMG overlap does not clip.
4. After playback integration, use actual mouse and touch actions in headed
   gameplay: one accepted action yields the intended sound, reload stages align
   under timing variation and interruption, delayed explosions sound at impact,
   acid pools persist correctly after shooter death, and slot reuse cannot
   replay an old cue. Check mute/gain controls and first-gesture unlock.
5. Pause/Stop/reset/floor changes release loops and all owned voices; profile
   decode memory and active-voice limits under the existing horde. Test on a
   physical phone before claiming mobile performance acceptance. Run scene:check
   after accepted asset/scene changes. Receiving WAVs does not mean steps 4-5
   or scene integration have passed.

This task delivers the specification only. No audio sources have been generated,
imported or heard in-game as part of this documentation change.
