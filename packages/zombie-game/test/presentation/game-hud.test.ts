import { expect, it } from 'vitest';
import { RuntimeSession, loadLevelRuntime } from '@aether/zombie-game';
import type { SceneDocument } from '@aether/scene';
import { gameHudModel } from "../../src/presentation/game-hud";

const floors = import.meta.glob("../../../../assets/scenes/act1/floor-1.scene.json", { eager: true, import: 'default' });

it('HUD offers interaction exactly when the runtime accepts it, including combat and reset', () => {
  const desc = loadLevelRuntime(structuredClone(Object.values(floors)[0]) as SceneDocument).desc!;
  const room = desc.rooms.find(r => r.clearRule === 'interact')!;
  // Give the normally peaceful event room a combat wave to exercise the reported failure.
  desc.spawns.push({ ...desc.spawns[0]!, nodeId: 'test-event-enemy', roomNodeId: room.nodeId,
    count: 1, wave: 1, x: (room.minX + room.maxX) / 2, z: (room.minZ + room.maxZ) / 2 });
  const s = new RuntimeSession({ desc, seed: 7 });
  const moveInside = (): void => {
    s.table.posX[s.playerEntityId] = (room.minX + room.maxX) / 2;
    s.table.posZ[s.playerEntityId] = (room.minZ + room.maxZ) / 2;
  };
  moveInside();
  expect(gameHudModel(s).canInteract).toBe(false); // Room has not triggered yet.
  expect(s.interact()).toBe(false);
  s.step();
  expect(gameHudModel(s).canInteract).toBe(false);
  expect(gameHudModel(s).objective).not.toContain('按 E');
  expect(s.interact()).toBe(false);
  const enemy = s.view().find(e => e.sourceNodeId === 'test-event-enemy')!;
  s.applyDamage(enemy.id, enemy.maxHp);
  expect(gameHudModel(s).canInteract).toBe(true);
  expect(gameHudModel(s).objective).toContain('按 E');
  expect(s.interact()).toBe(true);
  expect(gameHudModel(s).canInteract).toBe(false);
  expect(s.interact()).toBe(false);
  s.reset(); moveInside();
  expect(gameHudModel(s).canInteract).toBe(false);
  s.step();
  const respawn = s.view().find(e => e.sourceNodeId === 'test-event-enemy')!;
  s.applyDamage(respawn.id, respawn.maxHp);
  expect(gameHudModel(s).canInteract).toBe(true);
  s.applyDamage(s.playerEntityId, s.player()!.maxHp);
  expect(gameHudModel(s).canInteract).toBe(false);
  expect(s.interact()).toBe(false);
});
