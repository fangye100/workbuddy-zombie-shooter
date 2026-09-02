/**
 * 渲染包 shader 真源（ADR-005 / 0b.4）。WGSL 以 .wgsl.ts 字符串模块存放，
 * 引擎层 renderer 从这里取，编辑器通过 @aether/render 消费。
 * apps/lab/shader-lab/src/shaders/*.wgsl.ts 仅作兼容桥。
 */
export * from './common.wgsl';
export * from './gizmo.wgsl';
export * from './post.wgsl';
export * from './scene.wgsl';
