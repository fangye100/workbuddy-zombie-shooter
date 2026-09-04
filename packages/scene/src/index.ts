/**
 * 场景包：几何契约 + 极简 glTF 2.0 加载器 + 身高归一化 + 场景文件格式（引擎层真源，ADR-005 / 0b.3）。
 * 编辑器通过 @aether/scene 消费。0b.8 已删除 `apps/lab/shader-lab` 下的兼容桥，
 * 本包是 glTF/几何在全仓的唯一真源。
 *
 * 三块的职责边界（2026-09-04 引入 document 后必须说清，否则会被当成同一个东西）：
 *   geometry.ts  顶点布局契约 + 程序化几何 + 网格运算 —— **允许被 packages/render 依赖**（向下）
 *   gltf.ts      GLB 解析，产出 MeshData / 子网格 / 骨骼 / 动画
 *   document.ts  场景文件 schema（纯数据，零 GPU 依赖）—— 游戏内容的唯一载体（ADR-010）
 */
export * from './geometry';
export * from './gltf';
export * from './document';
