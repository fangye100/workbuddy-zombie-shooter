import { describe, expect, it } from 'vitest';
import { RuntimeSession } from '../src/session';
import { loadLevelRuntime } from '../src/loader';
import type { SceneDocument } from '@aether/scene';
const docs = import.meta.glob('../../../assets/scenes/act1/*.scene.json', { eager: true, import: 'default' });
function make(depth: number) {
  const doc = docs[`../../../assets/scenes/act1/floor-${depth}.scene.json`] as SceneDocument;
  const loaded = loadLevelRuntime(doc); expect(loaded.desc).not.toBeNull();
  return new RuntimeSession({ desc: loaded.desc!, seed: 7 });
}
function enter(s: RuntimeSession, id: string) {
  const r = s.desc.rooms.find(r => r.nodeId === id)!;
  s.table.posX[s.playerEntityId] = (r.minX + r.maxX) / 2;
  s.table.posZ[s.playerEntityId] = (r.minZ + r.maxZ) / 2; s.step();
}
describe('room actions', () => {
  it('interaction is spatial, explicit, once per run, and resets', () => {
    const s = make(1); expect(s.interact()).toBe(false);
    enter(s, 'nd_f1r1'); expect(s.clearedRooms()).not.toContain('nd_f1r1');
    expect(s.interact()).toBe(true); expect(s.clearedRooms()).toContain('nd_f1r1');
    expect(s.interact()).toBe(false); s.reset(); expect(s.clearedRooms()).not.toContain('nd_f1r1');
    enter(s, 'nd_f1r1'); expect(s.interact()).toBe(true);
  });
  it('elite target death clears the room while surviving escorts do not impersonate the target', () => {
    const s = make(2); enter(s, 'nd_f2r2');
    const target = s.view().find(e => e.sourceNodeId === 'nd_f2r2_sp0')!;
    expect(target).toBeDefined(); expect(s.clearedRooms()).not.toContain('nd_f2r2');
    s.applyDamage(target.id, target.maxHp); s.step();
    expect(s.clearedRooms()).toContain('nd_f2r2'); expect(s.countNpc()).toBeGreaterThan(0);
  });
  it('all three authored floors can reach the real terminal state using their own clear rules', () => {
    for (const depth of [1, 2, 3]) {
      const s = make(depth);
      for (const r of s.desc.rooms) {
        enter(s, r.nodeId);
        for (let n = 0; n < 4; n++) {
          for (const e of s.view()) if (e.kind === 'npc') s.applyDamage(e.id, e.maxHp);
          if (r.clearRule === 'interact') s.interact();
          s.run(65);
        }
      }
      expect(s.outcome).toBe('floor-clear');
    }
  });
});
