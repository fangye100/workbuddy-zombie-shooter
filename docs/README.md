# 全部开发 Agent 的项目知识入口

这是由仓库维护、供 Codex、WorkBuddy 及其他开发 Agent 共用的文档入口，不依赖
WorkBuddy 记忆服务或浏览器。先读 [`AGENTS.md`](../AGENTS.md)，再按任务选择真源。
项目报告、指南和新增说明默认使用简体中文；路径、标识、协议字段及命令保持原样。

## 权威层级与引用方式

1. 当前用户指令与项目 `AGENTS.md` 约束工作。
2. 当前源码契约、项目/场景数据和测试定义实际行为。
3. 当前指南用于定位这些契约；设计文档表达设计意图。
4. 验收报告、日报只证明其记录版本的观察，不自动成为当前执行规则或实现完成证明。

通过[机器可读目录](knowledge/catalog.json)按稳定 ID、职责、主题和状态查找。
ID 不依赖文档编号：项目有两份 `39-*` 和两份 `40-*` 文档。引用完整仓库路径和章节，
历史结论还应注明提交；不要只说“文档 39”或依赖他人无法读取的会话。
相对链接支持不同检出目录。未跟踪资产交付和草稿不是已发布知识。

## 按任务选择入口

| 任务 | 优先读取 | 当前真源与职责 |
|---|---|---|
| 职责、依赖分析与重构 | [分层契约](architecture/layers.md)、[CodeGraph MCP](knowledge/codegraph.md) | `tools/architecture/layers.json` 与当前检出源码 |
| 当前实现与原架构设计的区别 | [当前结构图谱](44-CodeGraph代码结构图谱.md#current-source-review-2026-10-09) | 已核实的源码职责、直接 GPU 路径及未启用/规划功能；旧测量保留历史属性 |
| 场景编辑与持久化 | [开发流程](43-GameplayDevelopmentWorkflow.md)、[场景设计](14-Scene系统与场景数据持久化架构设计.md) | `packages/scene/src/document.ts`、`project.ts`、`asset-meta.ts`；`@aether/runtime` 编辑状态 |
| 玩法、NPC、奖励和音频事件 | [玩法设计](13-玩法与关卡设计GDD.md)、[开发流程](43-GameplayDevelopmentWorkflow.md) | `packages/zombie-game/src`、`assets/scenes`、`packages/content` |
| 通用武器、射线碰撞与计时 | [武器报告](39-Unified-weapons-and-animation-hooks.md)、[分层契约](architecture/layers.md) | `packages/runtime/src/weapon-system.ts`、`weapon-combat.ts`、`solid-ray.ts` |
| HUD、语言、触摸/鼠标和游戏音频 | [输入报告](37-CombatInputAndPopulationQuality.md)、[音频指南](42-GameplayAudioIntegration.md) | `packages/zombie-game/src/presentation`；宿主提供视口、输入和 Play 端口 |
| 绑定、Retarget 与 IK | [绑定流程](rigging/character-rigging-workflow.md)、[身体 IK](animation/body-ik-blending.md)、[动作过渡](animation/pose-transitions.md) | `packages/render`、`packages/scene` 契约与编辑器绑定适配器 |
| 动画只读观察与排障 | [动画可视化调试](45-AnimationVisualDebugging.md) | `apps/editor/src/services/animation-debug`；观察现有选择器、姿态与 IK，不拥有或修改玩法状态 |
| 动作资源交接与候选检视 | [ANI 批次接入记录](animation/ani-20261008-intake.md)、[动作需求](38-GameplayActionAndVfxAssetBrief.md) | 离线 FBX 提取、共享 BVH 和检视场景；候选不等于正式玩法验收 |
| 动作进入实际玩法 | [动作接入指南](animation/ani-gameplay-integration.md) | 内容裁剪配方、四向步态、NPC 相位/受击/死亡尾部、t1 完整状态与真实 GPU 验证边界 |
| 场景美术、材质与建筑 LOD | [品质提升指南](art/visual-quality-playbook.md)、[街景报告](36-StreetQualityAndArchitecturalLOD.md) | 场景/资产文件、通用渲染器与美术验证工具 |
| 接触阴影、群体避让与贴花选型 | [修复与选型复核](architecture/crowd-and-decals-20261010.md) | 阴影步长修复、现有 CPU 基准及未实施方案的职责/验收边界 |
| 高性能群体寻路与避让 | [导航实现指南](architecture/crowd-navigation.md) | 分帧流场、预测速度约束、连续静态/动态碰撞、NavZone.crowd v16 配置及真实运行验证边界 |
| 浏览器或 GPU 验收 | [浏览器入口](browser-verification.md)、项目浏览器/GPU 规则 | 有界面目标检出环境及运行证据，不能只用构建代替 |
| Agent 通过 MCP 编辑 | [编辑器 MCP](../tools/mcp-editor/README.md) | `editor_workflow` → 明确选择实例 → 当前 schema/revision |
| 历史决策和事故证据 | 目录中 `historical` 项 | `docs/review`、`docs/evidence`、`.workbuddy/memory`；复用前核对源码 |

## 查询与维护

```powershell
pnpm run knowledge:find -- --topic animation
pnpm run knowledge:find -- --role framework --status current
pnpm run knowledge:check
pnpm run architecture:check
```

查询返回稳定 ID、完整路径、建议章节及权威属性。检查验证 ID、已跟踪覆盖、路径、状态/
职责词汇及真源引用，不会把旧内容声明为当前事实。发布指南或长期设计决策时更新目录；
重要会话结论落到聚焦的 `docs/` 指南，说明职责、契约、失败行为、实际验证和未完成项。
日报保留历史语境，不批量将过期命令或临时参数提升为项目规则。

[2026-10-09 文档复核](review/documentation-audit-2026-10-09.md)记录修订入口和验证范围。
源码迁移后必须修正当前指南正文，仅增加导航提示不够。历史报告保留原路径/计数，并指向
当前契约。架构设计表达意图，不能据此认定 FrameGraph、导出、子系统或 MCP 路线图已交付。

CodeGraph 是当前检出目录的派生缓存，补充源码阅读和目录检索；图中心性或文档年龄都不
决定真实性。目录的英文 ID、分类值和协议字段保持机器契约，用户可读标题/说明使用中文。
