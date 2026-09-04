/**
 * 场景包：几何契约 + 极简 glTF 2.0 加载器 + 身高归一化 + 场景文件格式（引擎层真源，ADR-005 / 0b.3）。
 * 编辑器通过 @aether/scene 消费。0b.8 已删除 `apps/lab/shader-lab` 下的兼容桥，
 * 本包是 glTF/几何在全仓的唯一真源。
 *
 * 各块的职责边界（2026-09-04 引入 document / asset-meta / project 后必须说清，
 * 否则会被当成同一个东西）：
 *   geometry.ts   顶点布局契约 + 程序化几何 + 网格运算 —— **允许被 packages/render 依赖**（向下）
 *   gltf.ts       GLB 解析，产出 MeshData / 子网格 / 骨骼 / 动画
 *   project.ts    项目容器（aether.project.json）—— 所有相对路径与层表的锚点
 *   asset-meta.ts 资产 sidecar 元数据（*.meta.json）—— 导入设置 + 默认绑定 + 骨骼/动画配置
 *   document.ts   场景 / prefab 文件 schema（*.scene.json）—— 游戏内容的唯一载体（ADR-010）
 *   asset-server.ts 资产 sidecar 加载器（S1）—— **只读**，缺失/损坏一律降级不抛异常
 *
 * 四层容器与覆盖链：project ⊃ asset(.meta) → prefab → scene → runtime（Play 期，不落盘）
 *
 * ## 加载器为什么在 scene 包里而不是新建 packages/assets
 *
 * asset-server 的全部依赖就是 asset-meta.ts 的 schema（同包），建新包只会多一层
 * 路径映射与 `tsconfig.check.json` 白名单维护，换不来任何隔离。
 * 等它真长出「guid 索引重建 / 字节流缓存 / 写入回存」再拆不迟 —— 不为想象中的包建目录。
 */
export * from './geometry';
export * from './gltf';
export * from './project';
export * from './asset-meta';
export * from './document';
export * from './asset-server';
export * from './graph';
export * from './migrate';
