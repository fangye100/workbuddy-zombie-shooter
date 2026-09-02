/**
 * 场景包：几何契约 + 极简 glTF 2.0 加载器（引擎层真源，ADR-005 / 0b.3）。
 * 编辑器通过 @aether/scene 消费；apps/lab/shader-lab/src/gpu/{geometry,gltf}.ts 仅作兼容桥。
 */
export * from './geometry';
export * from './gltf';
