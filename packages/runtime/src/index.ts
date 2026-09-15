/**
 * @aether/runtime —— headless 游戏世界（ADR：场景是数据，runtime 是它的消费者）。
 *
 * 定位：**纯 CPU 的玩法内核**，不认识 WebGPU、不认识编辑器、不认识场景文件格式。
 * 它只接受纯数据（SpawnRequest / CharacterStats），产出纯数据（AgentView）。
 * 场景 JSON 的解析与快照的序列化都在调用方 —— 这样同一个 runtime 才能被
 * vitest、Node 脚本、编辑器、游戏本体四种宿主复用。
 *
 * 消费方式：
 *   浏览器 / vitest：import { ... } from '@aether/runtime'（vite alias 解析）
 *   Node 脚本：先 `npm run runtime:build` 用 esbuild 打成单文件，再 node 跑
 *
 * 2026-09-15 修订：早期为了"四种宿主都能用"刻意零依赖，结果重复实现了
 * CharacterTable 与寻路的劣化版。现按 docs/17 §3.5 —— 与 DOM / GPU / 真实时间解耦即可，
 * 不禁 @aether 系列包：依赖 scene（数据契约 + 世界变换）、content（只读生成物）、
 * gameplay（实体状态表）、ai（流场寻路），全是纯 CPU；不依赖 render 与编辑器。
 */
export * from './types';
export * from './loader';
export * from './world';
