# 44 - CodeGraph 代码结构图谱

> 2026-10-08 用 code-graph MCP 为全仓建立符号级索引后沉淀的结构快照。
> 索引真源：`.code-graph/`（SQLite，约 21MB，source roots = `apps / assets / packages / tools`）。
> 本文数字（调用计数、模块符号数）来自索引统计，供定位代码用；架构约束以各 ADR 与 AGENTS.md 为准。

## 1. 总体分层

pnpm monorepo，四层结构，依赖方向自上而下：

```
应用层    apps/editor (Game Editor, :5100)     apps/samples/00-init (最终游戏, :5101)
              │                                      │
服务层    apps/editor/src/services (~54 文件)          │
   ├─ binding/ (绑定·蒙皮·重定向工作台, 20 文件)         │
   └─ motion-retarget/ (重定向管线, 11 文件)            │
              │                                      │
运行时层  packages/runtime (会话/玩法/刷怪/武器)  ←────┘
              ├→ packages/gameplay (角色 SoA 表/射线)
              ├→ packages/ai (FlowField 寻路/战斗配额)
              └→ packages/content (roster/stats 生成物)
渲染层    packages/render (RendererCore/蒙皮/Pass)
              └→ packages/framegraph (瞬态资源 FrameGraph)
                   └→ packages/gfx (WebGPU 设备/句柄环)
数据层    packages/scene (场景 schema/迁移/资产元数据 —— 全仓唯一数据真源)
基础设施  packages/core (ECS World/数学/命名)
工具层    tools/ (verify 门禁 · level 生成 · rigging/motion 管线 · 3 个 MCP server)
```

## 2. 引擎包（packages/*）结构与关键符号

| 包 | 文件数 | 职责 | 关键符号（括号内 = 索引到的调用方数） |
|---|---|---|---|
| `core` | 4 | ECS 与数学底座 | `World`（spawn/add/moveTo）、`CommandBuffer`、`Query.forEach`(19)、archetype 表（`getOrCreateArchetype`/`swapRows`）；`math.ts` 的 `mat4`(10)/`v3*`/`quat*`/`rayAabb` |
| `gfx` | 3 | WebGPU 设备抽象 | `GfxDevice.createBuffer`(12)、`UniformRing`/`StagingRing`（每帧环形上传）、`ResourceRegistry` 代际句柄（`makeHandle`/`handleGeneration`）、`initGpu`/`GpuUnavailableError` |
| `framegraph` | 1 | 帧图与瞬态资源 | `FrameGraph.createTexture`(8)/`createBuffer`(12)、`detectHazards`/`mergePasses`/`assignPhysicalResources`/`blitToSwapchain` |
| `scene` | 15 | **数据真源**：schema、迁移链、资产元数据 | `document.ts`（`validateSceneDocument`(9)、`createEmptySceneDocument`）、`SceneGraph.has`(26)/`getNode`(9)/`fromDocument`/`updateWorldTransforms`(8)、`migrate.migrateToLatest`、`project.validateProject`、`asset-meta.validateAssetMeta`(6)、`behavior.BehaviorRegistry.has`(24)、`gltf.parseGlb`、`retarget-meta`（指纹/校准校验）、`weapons`/`shared-motion`/`audio` |
| `render` | 17 | 渲染管线与蒙皮 | `RendererCore.drawFrame`/`destroy`(10)/`clearDynamicMeshes`、`skin.ts`（`createSkinState`/`play`(8)/`selectClip`/`evalJointMatrices`）、`materials.sharedId`/`cloneMaterial`、`frame-uniforms.packFrameUniforms`、独立 Pass：`ComicSkyPass`/`ContactShadowPass`；WGSL 着色器以 TS 字符串存于 `shaders/*.wgsl.ts`（COMMON/DYNAMIC/GIZMO/POST/SCENE） |
| `gameplay` | 2 | 角色数据导向层 | `CharacterTable`（SoA：`spawn`/`isAlive`(16)/`alloc`/`activate`/`deactivate`）、`CharacterPool`、`AssemblyQueue`、`selectLodTier`/`updateLod`；`ray.ts` 的 `rayCapsuleY`/`raySphere` |
| `ai` | 3 | 寻路与战斗调度 | `FlowField`（`index`(8)/`isBlocked`(8)/`bakeClearance`/`sampleFlow`）+ `FlowFieldIntegrator` + `SpatialHash`；`combat.ts`：`AttackTokenPool.has`(24)、`HitDedupeBuffer.contains`(12)、`DamagePipeline`、`MontageRuntime.play`(9)、`SurroundQuota`；`behavior.PerceptionSystem.propagateAggro` |
| `runtime` | 16 | 会话级玩法运行时（编辑器 Play 与游戏共用） | `RuntimeSession`（`player`(16)/`view`(8)/`step`/`applyDamage`/`pushDiag`）、`PlaySession`（编辑器 Play Mode 快照/回滚）、`SpawnEditStore.set`(**55**，全仓最热写入口)、`doc-diff.sceneFingerprint`(8)、`weapon-system`/`weapon-combat`/`enemy-attacks`、`scene-authoring.validateAuthorNodes`、`behavior-executor`、`loader` |
| `content` | 3 | roster.json → 生成代码 | `roster.generated.requireCharacter`、`stats.generated.lookupCharacterStats`(5) |

## 3. 应用层（apps/*）

### apps/editor —— Game Editor（101 个 src 文件，890 个活跃导出）

- **顶层模块**：`main.ts`（入口 + `refreshSpawnPanel`(14)）、`ui.ts`（`Panel.syncAll`/`setModelInfo`）、`i18n.ts`（`t`(49)）、`materials.ts`（`MaterialLibrary.find`(21)）、`asset-browser`/`asset-inspector`/`models`/`renderer`/`scene-boot`/`gizmo`/`presets`/`splitter`；`features/` 存放 gizmo、selection-outline 特性。
- **services/**（54 文件，编辑器业务核心）：
  - `binding/`（20 文件）：**全仓调用图的结构枢纽**（见 §5）。`binding-panel.ts` 是中枢 UI（`refresh`(19)/`requestSkin`/`drawView`/`scheduleDraw`/`updateDiag`/`invalidatePreview`/`getCylinders`/`syncDisplay`/`currentFit`）；`binding-session.ts`（`beginEdit`(17)/`editSig`(11)/`computeSkinAsync`）；`binding-math.ts`（`quatMul`(24)/`boneSegments`(15)）；`volumetric-*` 体积蒙皮（worker 化，`buildSolidVolume.find` 55+测试 63 = 全仓最热函数）；`humanik-template.ts`（27 关节模板，`isTipBone`(11)）。
  - `binding/motion-retarget/`（11 文件）：重定向管线 `pipeline.retargetMotion` → `rig-calibration`/`pose-solver`/`two-bone-solver`/`temporal-solve`/`space-targets`/`quality-report`/`bake-adapter`；配套 `retarget-session.ts`（`solve`）与 `retarget-workbench.ts`。
  - 作者侧：`author-asset.ts`（`add`(14)）、`author-transform`（`reject`(10)）、`author-scene-save`/`author-snapshot`/`author-projection`。
  - 运行时桥：`runtime-bridge`/`runtime-actors`（`ActorLibrary`）/`runtime-scene-motion`/`runtime-motion-panel`/`shared-motion-runtime.ts`（`resolve`(11)/`generate`）。
  - 场景面板：`scene-workspace`/`scene-environment`/`scene-light`/`scene-material`/`scene-contacts`/`spawn-panel`/`script-panel`/`atmosphere-panel`/`behavior-host`/`behavior-controls`。
  - 玩法预览：`play-controller`/`play-camera`/`free-camera`/`game-controls`/`game-language`（`gameText`）/`game-audio`(+`game-audio-assets`)。
  - 战斗表现：`combat-ink`/`combat-overlay`/`enemy-attack-ink`/`weapon-ink`/`weapon-diagnostics`/`player-presentation`。
  - 基础服务：`selection`/`picking`/`hierarchy`/`editor-state`/`editor-menu`（`message`(11)/`refresh`(10)）/`editor-agent.ts`（`call`，MCP 桥）/`animation.ts`（`activeSkinObject`(14)）/`asset-preview`/`skeleton-overlay`/`render-resolution`/`resource-rename`/`run-profile`/`run-settlement`/`run-transfer`/`sky-texture`。

### apps/samples/00-init —— 最终游戏入口

单文件 `main.ts`（`main`/`renderHud`/`resize`），消费 runtime/render/scene 包；vite 固定端口 5101。

## 4. 工具层（tools/）

| 目录 | 用途 | 代表脚本 |
|---|---|---|
| `verify/` | 浏览器/渲染/玩法验证门禁 | `editor-smoke.mjs`（冒烟门禁，支持 `--headed`）、`cdp-verify.mjs`、各 `*-probe.mjs`（combat/lod/comic-gpu/stress…） |
| `level/` | 关卡生成与验收 | `gen-level`/`verify-level`/`sim-level`/`migrate-scenes`/`environment-art-pass`/`bake-comic-backdrop` |
| `rigging/` `motion/` | 角色绑定导出与 Mixamo 动画导入 | `export-character-rigs`/`integrate-character-rigs`、`import-mixamo` |
| `art/` `fs/` `scene/` | 美术资产批处理、项目文件写改、sidecar 生成 | `scene/gen-asset-meta.mjs` = `pnpm run scene:gen` |
| `mcp-binding/` `mcp-editor/` `mcp-hello/` | 三个 MCP server（绑定领域/编辑器编排/hello） | 依赖 `packages/scene`、`packages/gameplay`、`packages/ai` |

## 5. 模块依赖与架构热点（索引统计）

**依赖强度 Top（import 边数）**——数据载体铁律在依赖图上的直接体现：

1. `editor/src/services → packages/scene/src`（82）：编辑器一切业务最终落在场景数据上。
2. `editor/src → packages/render/src`（59）、`editor/services → render`（57）：编辑器直接驱动渲染层。
3. `editor/src/services → packages/runtime/src`（58）：Play 模式与游戏运行时共用一套 runtime。
4. 测试镜像同样强烈：`scene/test → scene/src`（141）、`editor/test → services/binding`（82+91）。

**中介中心性 chokepoint（改动需谨慎、重构优先隔离）**：

| 函数 | 位置 | betweenness |
|---|---|---|
| `BindingPanel.refresh` / `requestSkin` / `drawView` / `scheduleDraw` | `apps/editor/src/services/binding/binding-panel.ts` | 18802 / 14137 / 11656 / 11210 |
| `RetargetSession.solve` | `binding/retarget-session.ts` | 13709 |
| `retargetMotion` | `binding/motion-retarget/pipeline.ts` | 10907 |
| `BindingSession.computeSkinAsync` | `binding/binding-session.ts` | 9583 |
| `SharedMotionRuntime.resolve` / `generate` | `services/shared-motion-runtime.ts` | 8193 / 7374 |
| `editor-agent.call` | `services/editor-agent.ts` | 6514 |
| `refreshSpawnPanel` | `apps/editor/src/main.ts` | 7965 |

结论：**绑定/蒙皮/重定向工作台是全项目调用图上最重的桥**——它横跨 scene（元数据/骨骼）、render（蒙皮）、runtime（共享动作），任何对其接口的改动都有最大扇出。

## 6. 用 code-graph MCP 查询这份结构

索引随仓库持久化在 `.code-graph/`，会话间复用。常用入口：

- 全局结构：`project_map`（架构图 + 热点函数 + 中介中心性 chokepoint）。
- 目录概览：`module_overview { path }`（按类型分组符号 + 调用计数；`include_deps` 看文件依赖，`include_dead` 找孤儿）。
- 精确符号：`get_ast_node { symbol_name, file_path }`（签名/源码/影响面/相似节点）。
- 调用链：`get_call_graph { symbol_name | route_path }`（替代多轮 grep）。
- 模糊语义：`semantic_code_search { query }`；按类型枚举：`ast_search { type/returns/params }`。
- 重命名审计：`find_references { symbol_name }`（含跨语言与测试引用）。

注意：每次调用仅对前 32 个文件做磁盘新鲜度校验，改动文件后窄化路径重查即可刷新行号与片段。
