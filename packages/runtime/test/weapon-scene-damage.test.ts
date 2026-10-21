import { describe, it, expect } from 'vitest';
import type { WeaponDefinition } from '@aether/scene';
import { WeaponCombat, type WeaponWorld, type WeaponActor, type WeaponSceneTarget } from '../src/weapon-combat';

const weapon = (over: Record<string, unknown> = {}): WeaponDefinition => ({
  id: 'w_test', behavior: 'hitscan', damage: 10, rangeM: 20, spreadDeg: 0, pellets: 1, penetration: 1,
  effects: { blastRadiusM: 0, knockbackM: 0, burnSec: 0, burnDps: 0, slowSec: 0, slowFrac: 0 },
  presentation: { color: '#ffffff', markers: { muzzle: { position: [0, 0, 0] } } },
  projectile: { lifetimeSec: 1, radiusM: 0.1, speedMps: 10, launchSpeedY: 0, gravity: 0 },
  ...over,
} as unknown as WeaponDefinition);

function sceneWorld(opts: {
  traceActor?: WeaponActor | null;
  targets?: WeaponSceneTarget[];
  blockedExcept?: (from: readonly number[], to: readonly number[], nodeId: string) => boolean;
  blockedAlways?: boolean;
} = {}) {
  const sceneHits: { nodeId: string; kind: string; damage: number }[] = [];
  const scenePoints: { nodeId: string; point: readonly number[] | undefined }[] = [];
  const actorHits: number[] = [];
  const world: WeaponWorld = {
    actors: () => opts.traceActor ? [opts.traceActor] : [],
    actor: () => opts.traceActor ?? null,
    trace: () => opts.traceActor
      ? { actor: opts.traceActor, distance: 4, point: [4, 1, 0], kind: 'entity', normal: [0, 0, 1] }
      : { actor: null, distance: 4, point: [4, 1, 0], kind: 'scene', nodeId: 'nd_crate',
          surface: { nodeId: 'nd_crate', distance: 4, point: [4, 1, 0], normal: [0, 0, 1] }, normal: [0, 0, 1] },
    blocked: () => opts.blockedAlways ?? false,
    blockedExcept: (from, to, nodeId) => opts.blockedExcept?.(from, to, nodeId) ?? false,
    damage: (id) => { actorHits.push(id); return 1; },
    displace: () => {},
    sceneTargets: () => opts.targets ?? [],
    damageScene: (nodeId, damage, _facts, kind, point) => { sceneHits.push({ nodeId, kind, damage }); scenePoints.push({ nodeId, point }); return damage; },
  };
  return { world, sceneHits, scenePoints, actorHits };
}

describe('WU-06 武器事实链 → 场景可破坏目标', () => {
  it('hitscan 命中场景 collider 时沿原 trace 事实声明 direct 来源', () => {
    const { world, sceneHits } = sceneWorld();
    new WeaponCombat(7).fire(weapon(), [0, 1, 0], [1, 0, 0], 15, 3, world);
    expect(sceneHits).toEqual([{ nodeId: 'nd_crate', kind: 'direct', damage: 15 }]);
  });

  it('爆炸复用真实爆心/距离/遮挡，墙后目标不受伤害', () => {
    const actor: WeaponActor = { id: 1, generation: 1, x: 0, y: 0, height: 1.8, z: 0, radius: 0.3, hp: 100 };
    const { world, sceneHits, actorHits } = sceneWorld({
      traceActor: actor,
      targets: [
        { nodeId: 'nd_near', position: [1, 0.5, 0], radius: 0.4 },
        { nodeId: 'nd_behind_wall', position: [2, 0.5, 0], radius: 0.4 },
        { nodeId: 'nd_far', position: [6, 0.5, 0], radius: 0.4 },
        { nodeId: 'nd_grazing', position: [3.75, 1, 0], radius: 0.5,
          minX: 3.25, maxX: 4.25, minY: 0.5, maxY: 1.5, minZ: -0.5, maxZ: 0.5 },
      ],
      blockedExcept: (_from, _to, nodeId) => nodeId === 'nd_behind_wall',
    });
    new WeaponCombat(7).fire(weapon({ effects: { blastRadiusM: 3, knockbackM: 0, burnSec: 0, burnDps: 0, slowSec: 0, slowFrac: 0 } }),
      [0, 1, 0], [1, 0, 0], 20, 3, world);
    expect(actorHits).toEqual([1]);
    expect(sceneHits).toEqual([{ nodeId: 'nd_near', kind: 'explosion', damage: 10 }]);
  });

  it('flame 范围事实以 burn 来源触发，不借用同帧直接命中序号', () => {
    const { world, sceneHits } = sceneWorld({
      targets: [{ nodeId: 'nd_crate', position: [2, 0.5, 0], radius: 0.4 }],
    });
    new WeaponCombat(7).fire(weapon({ behavior: 'flame', rangeM: 5 }),
      [0, 1, 0], [1, 0, 0], 6, 3, world);
    expect(sceneHits).toEqual([{ nodeId: 'nd_crate', kind: 'burn', damage: 6 }]);
  });

  it('散弹同 tick 多颗弹丸分别走 direct 事实，最终一次性由会话去重', () => {
    const { world, sceneHits } = sceneWorld();
    new WeaponCombat(7).fire(weapon({ behavior: 'pellets', pellets: 3, spreadDeg: 12 }),
      [0, 1, 0], [1, 0, 0], 8, 3, world);
    expect(sceneHits).toHaveLength(3);
    expect(sceneHits.every((h) => h.nodeId === 'nd_crate' && h.kind === 'direct')).toBe(true);
  });

  it('范围武器只忽略目标自身 collider；墙后目标仍被遮挡', () => {
    const { world, sceneHits, scenePoints } = sceneWorld({
      targets: [{ nodeId: 'nd_crate', position: [2, 0.5, 0], radius: 0.6 }],
      blockedAlways: true,
      blockedExcept: () => false,
    });
    new WeaponCombat(7).fire(weapon({ behavior: 'flame', rangeM: 5, damage: 6 }),
      [0, 1, 0], [1, 0, 0], 6, 3, world);
    expect(sceneHits).toEqual([{ nodeId: 'nd_crate', kind: 'burn', damage: 6 }]);
    expect(scenePoints[0]!.point![0]).toBeLessThan(2);

    const behind = sceneWorld({
      targets: [{ nodeId: 'nd_behind', position: [2, 0.5, 0], radius: 0.6 }],
      blockedAlways: true,
      blockedExcept: () => true,
    });
    new WeaponCombat(7).fire(weapon({ behavior: 'flame', rangeM: 5, damage: 6 }),
      [0, 1, 0], [1, 0, 0], 6, 3, behind.world);
    expect(behind.sceneHits).toEqual([]);
  });

  it('AABB 最近距离严格按半径边界（<、=、>）判定，不重复扩张目标尺寸', () => {
    const actor: WeaponActor = { id: 1, generation: 1, x: 0, y: 0, height: 1.8, z: 0, radius: 0.3, hp: 100 };
    const { world, sceneHits } = sceneWorld({
      traceActor: actor,
      targets: [
        { nodeId: 'nd_in', position: [3.15, 0.5, 0], radius: 0.5, minX: 2.9, maxX: 3.4, minY: 0, maxY: 1, minZ: -0.5, maxZ: 0.5 },
        { nodeId: 'nd_edge', position: [3.25, 0.5, 0], radius: 0.5, minX: 3.0, maxX: 3.5, minY: 0, maxY: 1, minZ: -0.5, maxZ: 0.5 },
        { nodeId: 'nd_out', position: [3.75, 0.5, 0], radius: 0.5, minX: 3.25, maxX: 4.25, minY: 0, maxY: 1, minZ: -0.5, maxZ: 0.5 },
      ],
      blockedExcept: () => false,
    });
    new WeaponCombat(7).fire(weapon({ effects: { blastRadiusM: 3, knockbackM: 0, burnSec: 0, burnDps: 0, slowSec: 0, slowFrac: 0 } }),
      [0, 0.5, 0], [1, 0, 0], 20, 3, world);
    expect(sceneHits.map((h) => h.nodeId)).toEqual(['nd_in', 'nd_edge']);
  });
});
