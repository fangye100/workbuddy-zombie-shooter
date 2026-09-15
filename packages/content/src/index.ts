/**
 * @aether/content —— 内容真源的生成物入口（ADR-002 / docs/10 D3）
 *
 * 本包位于 **L4**，只允许被 scene / gameplay / editor 读取，反向零依赖。
 * 特别地：**packages/render 是 L3，不能 import 本包** —— 引擎侧的风格参数
 * 必须按 ADR-007 由上层注入，不能让引擎反向读内容层。
 *
 * 包内所有 .generated.ts 都是 `scripts/gen-*.mjs` 的产物，勿手改。
 * 真源：
 *   assets/style/tokens.json        → tokens.generated.ts
 *   assets/characters/roster.json   → roster.generated.ts（外观 / 叙事 / 威胁档）
 *   assets/characters/stats.json    → stats.generated.ts（运行时物理与 AI 数值）
 *
 * roster 与 stats 是两份分工不同的真源：前者是美术/设计资料库，后者是程序消费的
 * 运行时数值。CharacterDef 需要的字段在 roster 里一项都没有（见 gen-content.mjs 的
 * UNDERIVABLE 清单），所以不要试图从 roster.generated 里找它们。
 */
export * from './generated/tokens.generated';
export * from './generated/roster.generated';
export * from './generated/stats.generated';
