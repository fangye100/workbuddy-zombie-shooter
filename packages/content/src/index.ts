/**
 * @aether/content —— 内容真源的生成物入口（ADR-002 / docs/10 D3）
 *
 * 本包位于 **L4**，只允许被 scene / gameplay / editor 读取，反向零依赖。
 * 特别地：**packages/render 是 L3，不能 import 本包** —— 引擎侧的风格参数
 * 必须按 ADR-007 由上层注入，不能让引擎反向读内容层。
 *
 * 包内所有 .generated.ts 都是 `scripts/gen-content.mjs` 的产物，勿手改。
 * 真源：assets/style/tokens.json · assets/characters/roster.json
 */
export * from './generated/tokens.generated';
export * from './generated/roster.generated';
