/**
 * 场景包：几何契约 + 极简 glTF 2.0 加载器 + 身高归一化（引擎层真源，ADR-005 / 0b.3）。
 * 编辑器通过 @aether/scene 消费。0b.8 已删除 `apps/lab/shader-lab` 下的兼容桥，
 * 本包是 glTF/几何在全仓的唯一真源。
 */
export * from './geometry';
export * from './gltf';
