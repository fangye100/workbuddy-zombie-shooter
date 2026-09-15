/**
 * @aether/runtime —— headless 游戏世界（ADR：场景是数据，runtime 是它的消费者）。
 *
 * 定位：**纯 CPU 的玩法内核**，不认识 WebGPU、不认识编辑器、不认识场景文件格式。
 * 它只接受纯数据（SpawnRequest / CharacterStats），产出纯数据（AgentView）。
 * 场景 JSON 的解析与快照的序列化都在调用方 —— 这样同一个 runtime 才能被
 * vitest、Node 脚本、编辑器、游戏本体四种宿主复用。
 *
 * 消费方式：
 *   浏览器 / vitest：import { World } from '@aether/runtime'（vite alias 解析）
 *   Node 脚本：先 `npm run runtime:build` 编成 CJS，再 require 产物
 */
export * from './types';
export * from './world';
