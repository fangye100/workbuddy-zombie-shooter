# Unified weapons and animation integration

Sound-effect IDs, production specifications and proposed event mappings are in
[the gameplay audio asset brief](40-GameplayAudioAssetBrief.md).

The six weapon families in GDD 13 section 5.1 now share one equipment, ammo,
upgrade and animation lifecycle. An additional launcher exercises the projectile
extension. Its tuning is a prototype, not an addition to the approved GDD roster.

## Ownership and persisted data

Scene schema v13 stores the arsenal in the stable RunRules node:
`arsenal.equipped`, `switchSec`, and `definitions[]`. Runtime reads this scene
payload; it does not load a second global weapon catalog. The JSON file under
`assets/weapons/prototype.weapons.json` is an explicit authoring/generator seed.
Editing it alone does not change an already authored scene. Edit scene fields in
the author panel, Apply, Save, and reload to change gameplay.

The v12 migration preserves an existing arsenal; otherwise it creates one
compatible pistol from the old ammo values. Invalid values remain diagnostics.
Campaign scenes explicitly opt into all seven prototypes. The former
`RunRules.weapon.magazineSize/reserveRounds/reloadSec` fields are deprecated
compatibility data; v13 gameplay uses `arsenal.definitions[].ammo` exclusively.
The remaining ammo reward/purchase fields still own run economy.

- `WeaponSystem`: one ammo/level record per stable weapon ID, equipment
  transitions, firing cadence, reload timers, upgrade prices, bounded action log.
- `WeaponCombat`: concrete hitscan, pellet, piercing, projectile, melee and flame
  strategies; swept traces, LOS, blast, DoT, slow and collision-resolved knockback.
- `RuntimeSession`: adapter over the existing entity table, finite colliders and
  applyDamage/reward path. It owns both controllers and the fixed simulation clock.
- `RunProgress`: rewards, talents and carry; compatibility ammo accessors delegate
  to the same WeaponSystem. There is no second magazine.
- Editor presentation: shared motion adapters select actual actions and sample
  normalized action phase. Canvas ink placeholders project simulation facts.

Projectile launch lift (`projectile.launchSpeedY`), speed, gravity, swept radius
and lifetime are authored per weapon. The launcher uses 3 m/s of initial upward
lift; other families use zero. No renderer or animation callback owns ballistics.

Magazine reload cannot fire until complete. A shell reload loads one shell per
authored interval and can be interrupted once a shell is available. Unequip cancels
an unfinished reload without granting ammo. Each weapon retains its inventory on
return. Upgrading consumes scrap only after eligibility checks, and increases
authored damage/cadence/capacity increments. It does not grant free ammo.

Carry contains the equipped ID and every weapon's level/magazine/reserve.
Validation occurs before modifying rewards, talents or equipment. Transient
reloads, switching, effects and hooks are not carried into another floor.
Reset reconstructs the original arsenal and effects. Pause and talent choices
freeze simulation clocks. Neither Play nor its presentation changes author data.

## Grip and HumanIK / FBX blending port

Each definition provides primaryGrip, supportGrip, muzzle, magazine and chamber
markers. Coordinates are **metres, weapon-local Y up, +X along the barrel**.
Rotations are unit quaternions in **xyzw** order. Primary/support grip effectors
use `right-hand` / `left-hand` semantic names, not asset bone names.

`runtime.weaponMount` provides the current mount position and quaternion.
Transform local marker positions and rotations by that mount. The current
placeholder mount is the player's capsule centre, not a measured wrist joint.
The HumanIK adapter must replace the visual mount with the solved hand/socket
transform and calibrate its weapon-local offset; it must not move the gameplay
entity or let FBX root motion move it a second time. Quaternion composition is
`mountRotation * markerRotation`. Aim is simulated separately from locomotion.

```ts
runtime.weapons.setAnimationHooks({
  onFire: ({ event, definition, markers }) => {
    // Observe the accepted fire edge, then layer recoil on the upper-body pose.
    // The existing shared-motion adapter remains the base clip selector.
    // event.sequence is an edge identity; event.tick uses runtime.fixedStep.
  },
  onReload: ({ event }) => { /* Start the authored reload or procedural fallback. */ },
  onReloadStage: ({ stage, markers }) => {
    // magazine-out / magazine-in / chamber; map left hand to local marker.
  },
  onUnequip: ({ event }) => { /* Release old support grip. */ },
  onEquip: ({ event, markers }) => { /* Attach new weapon and acquire grips. */ },
});
const intent = runtime.weapons.poseIntent;
// intent.markers, recoil.translation / pitchDeg, reload.leftHandTarget / phase
// Sample each fixed tick and blend over the FBX base pose in the IK branch.
```

Fire callbacks occur only on accepted shots, not every frame while input is held.
Reload stage callbacks fire once per shell/magazine cycle. Callback payloads are
copies; observer failures enter bounded `hookErrors` and cannot cancel damage or
ammo use. Hooks are presentation observers: do not re-enter equipment commands
from them. Rebind hooks after Reset, which creates a fresh WeaponSystem.

`animation` reports action, weaponId, clip, fallback, normalized phase and
startTick. Use startTick/weapon/action to retrigger the same one-shot clip.
Use the action phase instead of an independent wall-clock timer, so pause and
time compression remain synchronized. The shared-motion adapter tries the
weapon-specific state, generic shoot/reload/equip state, then the configured
fallback. Missing reload/holding animations currently fall back to idle while
procedural markers/recoil and ink feedback remain operational.

This branch implements the producer port and existing motion adapters. Actual
HumanIK solving, wrist attachment and FBX upper-body blending remain owned by
the other branch. No IK configuration, skeleton calibration or rig sidecars
were modified here.

Keep a single base clip selector when adding HumanIK: consume the action and
phase already selected by RuntimeSceneMotion, and apply grip/recoil/reload pose
layers afterward. A hook observer must not start a competing animation clock.

## Failure and resource boundaries

Model, animation and VFX AssetRefs allow explicit null placeholders. Non-null
references require path and GUID. The current renderer uses procedural weapon
silhouettes, recoil, reload indicator, projectile/flame/slash/blast ink and
existing shared-motion states. It does not yet import arbitrary weapon model or
animation files from those new reference slots. See the resource list in docs 38;
replace placeholders only after asset/rig acceptance and adapter integration.

The projectile pool is bounded at 64. Saturation defers fire before ammo is
consumed and emits W_WEAPON_CAPACITY. Projectile radius expands capsules and
solid collision bounds conservatively; box corners and nonuniform spheres are
conservative bounds, not exact convex swept-volume collision. Ordinary bullet
rays retain exact finite-solid behavior. Dead/reused entity generations cannot
inherit DoT or slow. Walls block shots, area hits and blast; an authored muzzle
protruding through a wall cannot shoot through it.

## Acceptance

Controls: mouse aim / left-click fire, R reload, 1–7 select weapon; the same
selection/reload/upgrade controls are reachable on touch. The HUD is bilingual.
Upgrades use run scrap and reset between runs; this is not permanent numerical
meta progression.

Automated checks cover migration/validation, action timing, shell interruption,
switch preservation, atomic carry, observer failures, all six strategies,
projectile lifetime/capacity, walls, damage/statuses and deterministic scatter.
Shared motion tests verify that held fire cannot animate an unaccepted shot and
that normalized phase retriggers an identical clip.

Local acceptance on 2026-10-07 used a dedicated headed Chrome tab over secure
Tailscale HTTPS. WebGPU reported `nvidia / lovelace`. Other Chrome tabs and the
HumanIK development service were untouched.

- 675 tests passed across runtime, scene, runtime bridge, shared motion, game
  controls, combat ink and scene authoring. Subsequent projectile launch-lift,
  expiry, ground-crossing and atomic legacy-carry checks passed in a 31-test
  regression run (14 weapon, 12 run-progress and 5 campaign tests), bringing
  distinct checked tests to 677. Typecheck, editor production build,
  content:check and full scene:check passed. The build retains the existing Vite
  CJS deprecation and large-chunk warnings.
- Actual dropdown / keyboard / mouse input exercised shotgun pellet damage,
  shell reload (reserve 48 to 47), upgrade spending (100 to 85 scrap), sniper
  damage/penetration and the shared `shoot` clip, flame burn ticks, and a delayed
  launcher impact (fire tick 1167 to explosion tick 1174).
- English landscape touch controls selected SMG and right-stick fire reduced
  ammo 32 to 31. Portrait 390 x 844 and landscape 844 x 450 were visually checked;
  weapon selection and upgrade targets measure 44 px. Temporary viewport
  overrides were cleared and game language restored to Chinese. These are
  desktop Chrome touch-layout checks, not performance measurements on a phone.
- Actual Stop returned Play to `stopped`, removed its runtime and changed the
  resource ledger from registered 3 / disposed 0 / pending 3 to 3 / 3 / 0.
  Author dirty state remained false with undo depth zero.

Combat captures used temporary runtime-only QA fixtures (stationary enemies,
high player HP, scrap for upgrades and hook-triggered pause). Damage, ammo,
collision and VFX still ran through the normal simulation; no authored scene
was saved from these fixtures. Reloading removed them. One transient HMR module
error during editing was repaired before acceptance and the subsequent page
loaded successfully; it is not counted as a clean historical console log.

Evidence: [sniper](evidence/weapons-2026-10-07/sniper-desktop.jpg),
[flame](evidence/weapons-2026-10-07/flame-desktop.jpg),
[launcher](evidence/weapons-2026-10-07/launcher-desktop.jpg),
[touch landscape](evidence/weapons-2026-10-07/mobile-landscape-en.jpg),
[touch portrait](evidence/weapons-2026-10-07/mobile-portrait-en.jpg),
[structured acceptance record](evidence/weapons-2026-10-07/acceptance.json).
