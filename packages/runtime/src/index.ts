/**
 * @aether/runtime — reusable scene editing, behavior ports, collision and weapons.
 *
 * Zombie campaign loading, simulation, progression and Play composition live in
 * @aether/zombie-game. Framework code must not import that package or editor code.
 * Scene contracts remain data-only; browser/GPU adapters belong to their hosts.
 *
 * 消费方式：
 *   浏览器 / vitest：import { ... } from '@aether/runtime'（vite alias 解析）
 *   Node: pnpm run runtime:build; zombie CLI: pnpm run game:build.
 *
 * Framework dependencies are data/CPU contracts; concrete rosters, campaigns,
 * rewards, HUD and host clocks are supplied by game or editor composition.
 */
export * from './behavior-executor';
export * from './doc-diff';
export * from './spawn-edit';
export * from './asset-node-edit';
export * from './solid-ray';
export * from './environment-edit';
export * from './scene-authoring';

export * from './weapon-system';
export * from './weapon-combat';
export * from './motion-direction';
export * from './disc-collision';
