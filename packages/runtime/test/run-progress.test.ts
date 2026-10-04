import { describe, expect, it } from 'vitest';
import { loadLevelRuntime, RuntimeSession, RunProgress } from '../src';
import { SCHEMA_VERSION, migrateToLatest, validRunRules, validateSceneDocument, type SceneDocument, type RunRulesComponent } from '@aether/scene';
const docs = import.meta.glob('../../../assets/scenes/act1/*.scene.json', { eager: true, import: 'default' });
function doc(n = 1): SceneDocument { return structuredClone(docs[`../../../assets/scenes/act1/floor-${n}.scene.json`] as SceneDocument); }
function session(n = 1) { const d = loadLevelRuntime(doc(n)); expect(d.desc).not.toBeNull(); return new RuntimeSession({ desc: d.desc!, seed: 7 }); }
function rules(): RunRulesComponent { return doc().nodes.flatMap(n => n.components).find(c => c.kind === 'RunRules') as RunRulesComponent; }

describe('authored run progression', () => {
  it('freezes immediately when the last elite dies, including surviving escorts', () => {
    const d = loadLevelRuntime(doc(2)).desc!;
    const room = d.rooms.find(r => r.clearRule === 'elite-dead')!;
    d.rooms = [room]; d.playerStart.x = (room.minX + room.maxX) / 2; d.playerStart.z = 0;
    d.spawns = d.spawns.filter(s => s.roomNodeId === room.nodeId);
    const s = new RuntimeSession({ desc: d, seed: 7 });
    const elite = s.view().find(e => e.sourceNodeId === room.clearTarget)!;
    s.applyDamage(elite.id, elite.maxHp);
    const before = s.view(); const tick = s.tick;
    s.setInput(1, 0); s.setFire(true); s.step();
    expect(s.outcome).toBe('floor-clear'); expect(s.countNpc()).toBeGreaterThan(0);
    expect(s.tick).toBe(tick); expect(s.view()).toEqual(before);
    expect(s.progress!.essence).toBe(s.progress!.rules.floorEssence);
  });
  it('enforces magazine/reload timing, finite reserves and paid resupply', () => {
    const p = new RunProgress(rules(), 7), size = p.rules.weapon.magazineSize;
    for (let i = 0; i < size; i++) expect(p.takeRound()).toBe(true);
    expect(p.magazine).toBe(0); expect(p.takeRound()).toBe(false);
    expect(p.reloadRemaining).toBe(p.rules.weapon.reloadSec);
    p.advanceReload(p.rules.weapon.reloadSec - 0.01); expect(p.takeRound()).toBe(false);
    p.advanceReload(0.02); expect(p.magazine).toBe(size);
    expect(p.reserve).toBe(p.rules.weapon.reserveRounds - size);
    p.magazine = 0; p.reserve = 0; expect(p.takeRound()).toBe(false); expect(p.reloadRemaining).toBe(0);
    expect(p.buyAmmo()).toBe(false); p.scrap = p.rules.weapon.ammoCost;
    expect(p.buyAmmo()).toBe(true); expect(p.scrap).toBe(0); expect(p.reserve).toBe(p.rules.weapon.ammoSupply);
    expect(p.reload()).toBe(true); expect(p.reload()).toBe(false);
  });
  it('locked options do not alter stats and become eligible only after an unlock', () => {
    const p = new RunProgress(rules(), 7), locked = p.rules.talents.find(t => t.unlockCost)!;
    expect(p.availableTalents.some(t => t.id === locked.id)).toBe(false);
    p.setUnlocked([locked.id]); expect(p.availableTalents.some(t => t.id === locked.id)).toBe(true);
    expect(p.strength(locked.effect)).toBe(0);
  });
  it('ignores hidden rule owners and rejects broken Boss references', () => {
    const hidden = doc(); hidden.nodes.find(n => n.components.some(c => c.kind === 'RunRules'))!.visible = false;
    expect(loadLevelRuntime(hidden).desc!.runRules).toBeNull();
    const broken = doc(3); const r = broken.nodes.flatMap(n => n.components).find(c => c.kind === 'RunRules') as RunRulesComponent;
    r.bossAttack!.source = 'nd_missing';
    expect(loadLevelRuntime(broken).diagnostics.some(d => d.code === 'E_BOSS_SOURCE')).toBe(true);
    expect(loadLevelRuntime(broken).desc).toBeNull();
  });
  it('assisted shooting applies damage upgrades, leech and real kill rewards', () => {
    const d = loadLevelRuntime(doc()).desc!;
    d.obstacles = []; d.shotColliders = [];
    d.spawns = [{ ...d.spawns[0]!, x: 10, z: 0, count: 1, radius: 0, wave: 1 }];
    const s = new RuntimeSession({ desc: d, seed: 7 });
    const target = s.view().find(e => e.kind === 'npc')!;
    s.progress!.stacks.set('heavy', 1); s.progress!.stacks.set('leech', 1);
    s.applyDamage(s.playerEntityId, 20); s.setFire(true); s.step();
    expect(s.table.health[target.id]).toBeCloseTo(target.hp - 12 * 1.35, 4);
    expect(s.player()!.hp).toBeCloseTo(80 + 12 * 1.35 * 0.08, 4);
    s.run(45); expect(s.progress!.kills).toBe(1); expect(s.progress!.choosing).toBe(true);
  });
  it('Boss telegraph locks its target, permits escape and resets cleanly', () => {
    const d = loadLevelRuntime(doc(3)).desc!;
    const source = d.runRules!.bossAttack!.source;
    d.obstacles = []; d.shotColliders = [];
    d.spawns = [{ ...d.spawns.find(s => s.nodeId === source)!, roomNodeId: d.rooms[0]!.nodeId, x: 25, z: 0, count: 1, radius: 0 }];
    const s = new RuntimeSession({ desc: d, seed: 7 }); s.step();
    expect(s.danger).not.toBeNull(); const locked = { ...s.danger! };
    s.setInput(0, -1); s.run(15);
    expect(s.danger!.x).toBe(locked.x); expect(s.danger!.z).toBe(locked.z);
    s.run(45); expect(s.danger).toBeNull(); expect(s.player()!.hp).toBe(100);
    s.reset(); expect(s.danger).toBeNull(); s.step(); s.run(60);
    expect(s.player()!.hp).toBeLessThanOrEqual(100 - d.runRules!.bossAttack!.damage);
  });
  it('migrates old scenes without silently opting them into new gameplay', () => {
    const d = doc(); d.schemaVersion = 6; d.nodes = d.nodes.filter(n => !n.components.some(c => c.kind === 'RunRules'));
    const r = migrateToLatest(d);
    expect(r.doc.schemaVersion).toBe(SCHEMA_VERSION); expect(r.applied).toContain('support-authored-run-rules');
    expect(loadLevelRuntime(r.doc).desc!.runRules).toBeNull();
  });
  it('rejects invalid tuning, duplicate IDs and duplicate rule owners', () => {
    const r = rules(); expect(validRunRules(r)).toBe(true);
    expect(validRunRules({ ...r, choiceEveryKills: 0 })).toBe(false);
    expect(validRunRules({ ...r, healCost: NaN })).toBe(false);
    expect(validRunRules({ ...r, talents: [r.talents[0], r.talents[0], r.talents[1]] })).toBe(false);
    const d = doc(); d.nodes.find(n => !n.components.some(c => c.kind === 'RunRules'))!.components.push(structuredClone(r));
    expect(validateSceneDocument(d).some(d => d.code === 'E_RUN_RULES_DUP')).toBe(true);
    expect(loadLevelRuntime(d).desc).toBeNull();
  });
  it('awards a kill once, freezes a choice and resumes only after a valid selection', () => {
    const s = session(); const enemy = s.view().find(e => e.kind === 'npc')!;
    s.applyDamage(enemy.id, enemy.maxHp, s.playerEntityId);
    s.applyDamage(enemy.id, enemy.maxHp, s.playerEntityId);
    const p = s.progress!; expect(p.kills).toBe(1); expect(p.scrap).toBe(p.rules.scrapPerKill);
    expect(p.choices).toHaveLength(3); const tick = s.tick; s.run(30); expect(s.tick).toBe(tick);
    expect(s.chooseTalent('not-offered')).toBe(false);
    const id = p.choices[0]!.id; expect(s.chooseTalent(id)).toBe(true); expect(s.chooseTalent(id)).toBe(false);
    s.step(); expect(s.tick).toBe(tick + 1); expect(p.stacks.get(id)).toBe(1);
    s.reset(); expect(s.progress!.kills).toBe(0); expect(s.progress!.stacks.size).toBe(0);
  });
  it('rejects purchases away from supply, charges once, and preserves max HP', () => {
    const s = session(); expect(s.buyTalent()).toBe(false); expect(s.buyHeal()).toBe(false);
    const room = s.desc.rooms.find(r => r.roomType === 'event')!;
    s.table.posX[s.playerEntityId] = (room.minX + room.maxX) / 2; s.table.posZ[s.playerEntityId] = 0; s.step();
    expect(s.interact()).toBe(true); expect(s.interact()).toBe(false);
    expect(s.progress!.scrap).toBe(s.progress!.rules.eventScrap);
    expect(s.buyHeal()).toBe(false); // full health costs nothing
    s.applyDamage(s.playerEntityId, 20); expect(s.buyHeal()).toBe(true);
    expect(s.player()!.hp).toBe(s.player()!.maxHp); expect(s.buyHeal()).toBe(false);
    expect(s.progress!.scrap).toBe(s.progress!.rules.eventScrap - s.progress!.rules.healCost);
    expect(s.buyTalent()).toBe(false); // insufficient funds
  });
  it('does not charge for a cancelled purchase, and does not offer capped talents', () => {
    const p = new RunProgress(rules(), 7); p.scrap = 200;
    expect(p.shopTalent()).toBe(true); expect(p.scrap).toBe(200);
    expect(p.cancelShop()).toBe(true); expect(p.scrap).toBe(200);
    expect(p.shopTalent()).toBe(true); const id = p.choices[0]!.id;
    expect(p.choose(id)).toBe(true); expect(p.scrap).toBe(170); expect(p.choose(id)).toBe(false);
    for (const t of p.rules.talents) p.stacks.set(t.id, t.maxStacks);
    expect(p.shopTalent()).toBe(false); expect(p.scrap).toBe(170);
  });
  it('carries HP, currency and upgrades across floors, with atomic invalid-data rejection', () => {
    const s = session(); const p = s.progress!; p.recordKill(); p.choose(p.choices[0]!.id); p.finishFloor(); p.finishFloor();
    expect(p.essence).toBe(p.rules.floorEssence);
    const carry = p.snapshot(64); const next = session(2);
    expect(next.restoreRun({ ...carry, stacks: { invented: 9 } })).toBe(false); expect(next.progress!.kills).toBe(0);
    expect(next.restoreRun(carry)).toBe(true); expect(next.player()!.hp).toBe(64);
    expect(next.progress!.snapshot(64)).toEqual(carry);
    next.step(); expect(next.restoreRun(carry)).toBe(false);
    next.reset(); expect(next.player()!.hp).toBe(100); expect(next.progress!.scrap).toBe(0);
  });
});
