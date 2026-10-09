# 44 — CodeGraph 代码结构图谱与开发流程

<a id="current-source-review-2026-10-09"></a>

## 当前源码复核（2026-10-09）

当前职责见[分层契约](architecture/layers.md)，已安装 MCP 的连接和查询见
[CodeGraph 指南](knowledge/codegraph.md)。核对分支 `codex/architecture-boundaries-20261009`，
源码 `e6c2278`；主分支集成 `90d6427`，包含武器/音频、HumanIK 和动作过渡。
当前 schema v15，v14→v15 在 `packages/scene/src/migrate.ts`。本节是文档/源码复核，
不新增玩法、GPU 或设备验收。

实际 MCP `project_map` 及 7 次指定文件 `module_overview` 使用 `code-graph-mcp 0.167.0`。
完整图谱返回 52 个目录组，含测试/文档/工具，不是 52 个生产包；使用完整查询预算，未报告
预算遗漏。增量索引完成 18 个更新、1 个移除，同时报告并发锁警告；后续健康结果仍有
4 个解析标记和 6,870 个未解析调用。见[范围与查询记录](review/documentation-audit-2026-10-09.md)。

同名调用解析会污染深度 1 的依赖列表：`RuntimeSession` 混入无关 renderer/device 调用，
`SceneDocument` 混入编辑器 find 接收者。它们不是已确认 import；这里的依赖结论以
源码阅读及 TypeScript AST 门禁为准。游戏导出入口虽报 “No files found”，仍返回导出
依赖；真实文件已确认存在。

### 当前执行与数据路径

```text
Editor 编辑（5100）
  -> Framework 编辑命令 / 共享历史
  -> 编辑器投影 / devfs -> tools/fs 协调写入 -> 场景/项目/sidecar
Editor Play（5100）
  -> zombie-game PlaySession / RuntimeSession / RunProgress / EnemyAttacks
       -> Framework 武器、碰撞、导航及角色基础机制
       -> content 生成的 roster/stat API（JSON 仍是真源）
  -> zombie-game 表现：HUD、控制、音频及战斗/武器反馈
  -> Editor 宿主适配：角色、游戏相机、共享动作、IK、渲染 Bridge
       -> render RendererCore / skin / body-ik / pose-transition / 直接 GPU Pass
            -> gfx / core / scene 契约
MCP：stdio -> 本机 broker -> WebSocket -> 指定 EditorAgent -> 同一业务服务
M0 示例（5101）：gfx 初始化/能力 HUD，不是战役 Play
```

| 源码职责 | 当前位置与限制 |
|---|---|
| 通用 Framework runtime | `packages/runtime/src`：编辑命令、行为端口、武器和 solid-ray；无反向游戏导出 |
| 僵尸模拟/进度 | `packages/zombie-game/src`：loader、session、PlaySession、spawn A/B、RunProgress、EnemyAttacks、AudioFramePlanner；公共无界面入口 |
| 游戏表现 | `packages/zombie-game/src/presentation`：13 个模块及 HUD CSS，明确公共子路径，无 editor 依赖 |
| 编辑器适配 | `apps/editor/src/services`：编辑、绑定、角色/渲染/Play 集成及相机/IK 适配；启动仍待整理 |
| 通用 IK/姿态采样 | `packages/render/src/body-ik.ts`、`two-bone-ik.ts`、`skin.ts`、`pose-transition.ts`；场景/sidecar 契约仍在 scene |
| 渲染状态 | `RendererCore` 直接 Pass 活跃；FrameGraph/RenderFeature 是未接入当前调度的设计基础设施 |

此源码版本 Git 跟踪的递归 `src/**/*.ts` 数：runtime 10、zombie-game 21（含入口的
无界面 8 + 表现 13）、render 22、editor 92。含入口和 WGSL TS 模块，是导航范围，
不表示执行活跃度、复杂度、内存或性能。

### 当前测试与工具入口

按改动选择子集，以下是当前路径，不代表文档复核时全部执行：

```powershell
pnpm exec vitest run packages/zombie-game/test/run-progress.test.ts packages/zombie-game/test/audio-frame.test.ts packages/runtime/test/solid-ray.test.ts
pnpm exec vitest run packages/render/test/pose-palette.test.ts packages/zombie-game/test/presentation/game-hud.test.ts packages/zombie-game/test/presentation/game-audio-assets.test.ts
node --test tools/mcp-editor/*.test.mjs
pnpm run architecture:check
pnpm run knowledge:check
```

`game:build` 分离构建游戏/Framework；`runtime:build` 不再导出僵尸模拟。
默认 Vitest 只覆盖 apps/packages，Node/Python 工具另用运行器。`verify:parity` 单独
只取 Node 样本，跨宿主结论需匹配浏览器后显式比较。资产/场景仍跑 `scene:check`，
图形行为仍按项目规则走有界面/硬件路径。

## 保留的历史审计（2026-10-08）

以下 1–8 节保留原源码快照和测量。旧 runtime/editor 路径及测试命令只属于当时版本，
新开发使用上方当前入口，不把历史计数或未执行检查当作当前验收。

## 1. 历史证据与范围

2026-10-08（Asia/Singapore）核对提交 `1bd98a11c9ddedf63243156f38b7ae8e98748313`，
使用 `@sdsrs/code-graph 0.167.0` 本地索引；之后改动需重新验证。

CodeGraph 是基于 Tree-sitter AST 的 Rust 程序，不编译/运行项目来发现架构。Agent
决定范围、查询与解释，不控制解析提取规则；可选本地嵌入另用于语义检索。
`.code-graph/source-roots.json` 根为 apps/assets/packages/tools。该目录是忽略的本地
SQLite 缓存，不是 Git 交付或架构真源；只在目标检出中用支持的接口初始化/刷新。

| 只读审计指标 | 结果 |
|---|---|
| 四根目录跟踪代码文件 | 420，无缺失索引源码 |
| TS/JS 语法审计 | 363 个文件（含根配置），3,305 个有名声明，无遗漏 |
| Python 语法审计 | 378 个有名函数/类，无遗漏 |
| 独立语法诊断 | 已审计 TS/JS/Python 均无 |
| 索引文件/节点/全部边 | 900 / 6,261 / 15,030，含文档/数据及非调用边 |
| 核对代码片段 | 5,271；135 个截断片段的保留前缀匹配 |
| 调用边可信度 | extracted 3,080 + inferred 2,582 + ambiguous 1,727 = 7,389 |
| 待解析调用 | 6,577 |

4 个索引文件有解析标记，独立语法及有名声明检查仍通过。文件/符号覆盖不能证明调用关系
完整正确。当时审计未执行运行测试、浏览器/GPU 验证或 MCP 重新索引；schema、ADR、
项目规则仍权威。

## 2. 历史执行路径

```text
apps/editor（5100）
  -> services：编辑、绑定/Retarget、Play、表现
  -> runtime：PlaySession / RuntimeSession
       -> gameplay：角色数据、射线基础
       -> ai：导航、战斗调度、群体解算
       -> content：生成角色/数值 API
  -> render：RendererCore、蒙皮、直接 GPU Pass
       -> gfx / core / scene
apps/samples/00-init（5101）
  -> gfx：M0 设备初始化、swapchain 清屏、能力/FPS HUD
编辑持久化
  -> editor devfs 或离线绑定 MCP 文件适配
  -> tools/fs/project-write.mjs：共享锁、基线比较、原子写
  -> 项目 / 场景 / prefab / sidecar
未启用设计（非当时渲染路径）
  render/src/feature.ts --类型 import--> framegraph
```

可玩路径是 Editor Play。[M0 main.ts](../apps/samples/00-init/main.ts)只引入 GfxDevice，
不引入 runtime/render/scene；5101 不是完整独立游戏。
[RendererCore](../packages/render/src/renderer-core.ts)直接组织 GPU Pass；
[FrameGraph](../packages/framegraph/src/graph.ts)和[RenderFeature](../packages/render/src/feature.ts)
明确标注未启用，类型 import 或导出接口不能证明运行时使用。

## 3. 历史包与数据职责

下列为当时递归 `src/**/*.ts` 数，含入口/生成文件，不是实现或活跃度数量。

| 包 | TS 数 | 职责/入口 |
|---|---:|---|
| core | 5 | ECS World、CommandBuffer、archetype、query、数学/命名 |
| gfx | 4 | GfxDevice、能力、资源句柄、uniform/staging ring |
| framegraph | 2 | 未启用 Pass/资源规划，当时未核实生产运行消费者 |
| scene | 16 | 场景/prefab/schema/迁移、项目、元数据、行为、GLB、Retarget/共享动作/音频/武器契约 |
| render | 19 | RendererCore、蒙皮、材质、uniform、直接 Pass、WGSL；pose-palette、albedo-texture |
| gameplay | 3 | 角色 SoA/池、装配、LOD、射线 |
| ai | 4 | 流场、空间哈希、战斗/伤害/montage、感知、CrowdSolver |
| runtime | 17 | 当时会话、刷怪、行为、武器/攻击、装载/编辑；run-progress、solid-ray、asset-node-edit、audio-frame |
| content | 4 | 生成角色/数值 API，输入 JSON 为真源 |

- `aether.project.json` 持有路径、场景登记/启动、层和项目设置；schema 在 scene/project.ts。
- 场景/prefab JSON 持有配置节点/组件；契约在 scene/document.ts 和迁移模块。
- 同名 sidecar 持有可复用绑定/骨架/导入元数据，二进制资源仍是引用资产。
- 角色 roster/stat JSON 持有内容定义，生成器派生 TS API；场景 schema 不是所有数据唯一 owner。
- Play 用运行副本，PlaySession 管快照/回滚/资源清理；持久编辑与临时模拟区分。

[devfs.ts](../apps/editor/devfs.ts)是开发文件接口。GUI、离线 MCP sidecar 保存和重命名
经[project-write.mjs](../tools/fs/project-write.mjs)协调：锁内比较装载基线、原子写并显式
报告冲突；直接文件写入不自动受保护。遗留锁需确认 owner 停止后显式恢复。
[rename-project.mjs](../tools/fs/rename-project.mjs)负责多文件重命名事务及恢复日志。

## 4. 历史编辑器结构与动态边界

当时 editor/src 有 101 个 TS；services 直接 54/递归 85，binding 直接 20/递归 31，
含 11 个 motion-retarget 文件。口径不能混合。原“890 活跃导出”无可复现定义，已撤回。

| 职责 | 入口 |
|---|---|
| 外壳/资产/渲染 | main、ui、asset-browser/inspector、models、renderer、scene-boot、editor features |
| 绑定/蒙皮 | binding-panel/session/persistence/export/math、humanik-template、volumetric |
| Retarget | retarget-session/workbench；motion-retarget/pipeline、calibration、pose/two-bone/temporal、quality-report、bake-adapter |
| 编辑 | author-asset/transform/scene-save/snapshot/projection、scene-author-panel、workspace/environment/light/material/contact |
| 运行 Bridge | runtime-bridge/actors、scene/shared motion、behavior-host、play-controller |
| 当时表现 | game-hud、run-hud、profile/settlement/transfer、camera/control、combat/weapon ink/diagnostics、player、audio/assets |
| 持久化/自动化 | devfs、resource rename、editor-agent、文件协调与 MCP broker |

静态图谱不包含全部联系，须明确追踪两端：

1. [体积 Worker 客户端](../apps/editor/src/services/binding/volumetric-worker-client.ts)
   用 URL 创建 Worker，与[工作线程](../apps/editor/src/services/binding/volumetric-worker.ts)通信。
2. [行为宿主](../apps/editor/src/services/behavior-host.ts)用 glob 发现 assets/behaviors，
   注册定义并注入执行器，不要求直接 import/call 边。
3. 编辑器 MCP 跨 stdio、HTTP、WebSocket、浏览器派发；核消息契约、请求/响应和实际 owner。

## 5. 工具与 MCP 职责

| 位置 | 职责 |
|---|---|
| tools/verify | 浏览器/GPU/玩法/文件探针，遵守有界面验证规则 |
| tools/level | 生成、迁移、模拟、环境准备 |
| tools/rigging、tools/motion | 骨架导出/接入、动画导入/检查 |
| tools/art、tools/scene、tools/audio | 美术检查、sidecar、音频；Python 资产管线还在 assets/**/_tools |
| tools/fs | 协调写入、创建场景、重命名/恢复 |
| tools/mcp-binding | 离线绑定，复用 editor binding 及 scene/runtime/content，FsPort 注入文件能力 |
| tools/mcp-editor | stdio→本机 HTTP broker→WebSocket→editor-agent→编辑操作，浏览器持有实时状态 |
| tools/mcp-hello | 协议探针，不负责场景/玩法 |

三个 MCP 服务并不共享原先宣称的 scene/gameplay/ai 依赖集合。

## 6. 可信度与热点结论

计数/中心性用于导航，不证明耦合、执行频率、CPU/GPU 成本或重构优先级；需核接收者、
源码路径、可信度、生产/测试、类型/运行引用及动态边界。

| 对象 | 当时入边 | 结论 |
|---|---|---|
| SpawnEditStore.set | 62：生产 55/测试 7；ambiguous 60/inferred 2 | 含 asset-browser 的无关 Map.set，不能称最热写入口 |
| buildSolidVolume 内部 find | 118：生产 55/测试 63；全部 ambiguous | 含 params 的 array.find，未确认真实 union-find 调用者 |
| AttackTokenPool.has | 27：ambiguous 26/extracted 1 | 核接收者身份 |
| BehaviorRegistry.has | 31：ambiguous 29/inferred 1/extracted 1 | 核接收者身份 |
| BindingPanel.refresh | 19：extracted 16/ambiguous 3 | 影响判断前核真实调用者 |
| RetargetSession.solve | 4：inferred 3/ambiguous 1 | 追踪 workbench/session/pipeline |

原 import 权重/介数排名已撤回：符号边被误当作运行依赖强度，不确定调用污染中心性。
源码确认绑定/Retarget 跨模块，但未证明它是最大瓶颈。未来排名须写参数、计数口径、
测试范围/可信度，并给代表性源码证据。

## 7. 图谱优先流程

结构、职责、依赖、影响及重构先查 CodeGraph，不先大范围 grep/rg 重建架构，参数以
当前安装 MCP schema 为准：

1. 确认检出、分支/提交、工具版本、根/排除及索引完成，按需受支持初始化/刷新。
2. 用 project_map/module_overview 定位，再查指定文件的 AST、call/ref、语义搜索。
3. 跟进分页/截断，检查未解析/解析错误，读定位源码核关键边和失败行为。
4. 定向搜索补动态消息、glob、配置/数据和同名边。合理尝试后索引不可用或无法覆盖，
   说明具体限制后源码回退，不编造图谱或阻断全部工作。
5. 区分源码事实、推断/歧义及未验证运行行为，报告快照/范围。

“每次只刷新前 32 个文件”的固定保证未独立确认，查询返回不证明索引新鲜。
图谱补充源码/schema/ADR 和行为测试，不替代它们。

## 8. 历史测试职责

默认 [Vitest 配置](../vitest.config.ts)只含 apps/packages 的 TS 测试，排除 tools/assets。
`pnpm test` 不验证全部工具/Python。以下是原审计时未执行的入口，旧路径不适用于当前迁移：

| 当时职责 | 当时命令/验证 |
|---|---|
| runtime 进度/射线/音频 | `pnpm exec vitest run packages/runtime/test/run-progress.test.ts packages/runtime/test/solid-ray.test.ts packages/runtime/test/audio-frame.test.ts` |
| 姿态/HUD | `pnpm exec vitest run packages/render/test/pose-palette.test.ts apps/editor/test/game-hud.test.ts` |
| editor MCP | `node --test tools/mcp-editor/server.test.mjs tools/mcp-editor/broker.test.mjs tools/mcp-editor/workflow.test.mjs` |
| Python 音频 | `python -m unittest discover -s tools/audio -p test_audio.py` |
| Python 美术/环境 | 按职责选 tools/art 或 assets/environment/_tools 的 test_*.py |
| 场景/资产 | scene:check；内容 JSON 还需 content:gen/content:check |
| 动作/绑定 MCP | motion:check、相关 TS、mcp-binding:check |
| 持久化 | 相关 devfs 及 verify:fs，含冲突/恢复 |
| 可见玩法/GPU | 项目规则的有界面 Play 与相关探针；构建/索引不能代替 |
