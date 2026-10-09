# Aether — WebGPU 游戏引擎与编辑器

## Agent 开发入口

跨模块开发先读[项目规则](AGENTS.md)、[共享知识](docs/README.md)、
[分层契约](docs/architecture/layers.md)和 [CodeGraph MCP 用法](docs/knowledge/codegraph.md)。
僵尸模拟/表现使用 `packages/zombie-game`，通用机制保留 Framework 包。
按改动执行 `pnpm run architecture:check`、`pnpm run knowledge:check` 和相关测试。
报告及指南默认使用中文。

项目包含模块化 WebGPU 引擎、Game Editor 和僵尸战役。当前完整可玩路径是 **5100 端口
的 Editor Play**。`RendererCore` 直接安排 GPU Pass，包含实例角色和 GPU 姿态采样。
FrameGraph、更完整 GPU-driven 剔除及全部子系统架构仍是设计方向，不能只因设计文档
存在就认为已接入当前运行路径。

## 文档索引

当前开发从[游戏开发流程](docs/43-GameplayDevelopmentWorkflow.md)开始，覆盖场景持久化、
美漫材质/LOD、NPC/输入、统一武器/IK 接口、音频和定向验收。
[Game Editor MCP](tools/mcp-editor/README.md)提供流程发现及共享编辑/诊断路径。

| 文档 | 内容 |
|---|---|
| [当前结构图谱](docs/44-CodeGraph代码结构图谱.md) | 当前源码职责/执行路径、CodeGraph 范围/限制及保留的历史审计 |
| [01-架构总览与主循环](docs/01-架构总览与主循环.md) | 原架构设计及路线图；依赖图使用前以当前分层契约复核 |
| [02-WebGPU设备资源层与FrameGraph](docs/02-WebGPU设备资源层与FrameGraph.md) | 能力分级、句柄、分配器、绑定模型和 FrameGraph 等设计 |
| [03-渲染管线](docs/03-渲染管线.md) | 渲染拓扑、阴影/GI/材质/透明/后处理及合批设计 |
| [04-子系统](docs/04-子系统.md) | ECS、场景、资产、动画、物理、VFX、UI、音频、输入、脚本等设计 |
| [05-NPC角色控制系统](docs/05-NPC角色控制系统.md) | 角色/决策/移动/战斗分层、装配、群体、时序及攻击许可设计 |
| [16-Retargeting 设计与开发计划](docs/16-MotionMatch动画匹配设计.md) | 空间补偿、接触、全身求解、契约、队列和验收 |
| [16A-Retargeting 运动空间补偿研究](docs/16A-Retargeting运动空间补偿算法研究.md) | 公开证据、公式、接触策略、数值验证及脚本 |
| [角色绑定流程](docs/rigging/character-rigging-workflow.md) | 源姿态编辑、体积权重、刚性道具、GLB、共享动作和控制验收 |
| [绑定 MCP](tools/mcp-binding/README.md) | 流程发现、编辑工具、最终权重诊断、持久化和骨架导出 |
| [品质提升指南](docs/art/visual-quality-playbook.md) | 美漫画风、构图、Shader、贴图 LOD、占位替换、天空/图集及证据验收 |
| [2026-10-07 群体性能基线](docs/39-CrowdPerformanceBaseline-2026-10-07.md) | 上半身 IK、500–2,500 NPC 样本、CPU/GPU 时间与持续稳定边界 |
| [2026-10-07 iPhone Play 缓解](docs/40-IPhonePlayCrashMitigation-2026-10-07.md) | 按场景需求装载、运行纹理限制、GPU 丢失处理及设备验证边界 |
| [动画可视化调试](docs/45-AnimationVisualDebugging.md) | 选定角色的只读规则/姿态图、有界切换历史、观察冻结及 CPU/GPU 管线边界 |

## 当前目录与职责

```text
packages/
  core/         ECS、数学及应用契约
  gfx/          设备、资源句柄、uniform/staging ring
  framegraph/   Pass/资源规划，当前渲染器未启用
  scene/        项目/场景/sidecar schema、迁移及数据契约
  render/       RendererCore 直接 Pass、Shader、蒙皮、IK、姿态混合
  ai/           导航、空间哈希、群体和战斗基础机制
  gameplay/     通用角色表/池、装配、LOD、射线
  runtime/      通用编辑命令、行为端口、武器、碰撞
  content/      生成角色 API；roster/stat JSON 为真源
  zombie-game/  战役模拟/进度及独立表现子路径
apps/editor/            编辑 UI、渲染/Play 适配；5100
apps/samples/00-init/   M0 GPU 初始化示例；5101
docs/                   共享指南、设计与历史证据；先读 docs/README.md
tools/                  MCP、文件事务、美术/音频/场景/绑定管线和门禁
```

## 快速开始

```powershell
pnpm install
git lfs pull
pnpm run editor       # Game Editor 及完整 Play，固定 5100
pnpm run typecheck
pnpm run architecture:check
pnpm run knowledge:check
```

HTTPS/Tailscale 使用配置的证书主机名，见[项目网络/浏览器规则](AGENTS.md)。
确认安全上下文和实际硬件 WebGPU 适配器，浏览器/设备支持需在目标设备验证，不能由版本
标签推断。`pnpm run dev` 仅启动 5101 的 M0 清屏/能力示例。

无界面战役工具先 `pnpm run game:build` 构建分离的 Framework/游戏 bundle。
`pnpm run sim` 导出派生快照，`--focus` 可改变启动选择，不是只读检查。
`pnpm run verify:parity` 生成 Node 样本；跨宿主一致性还需要匹配的浏览器快照及显式比较。
生成前检查工具参数。

## 原设计方向

下述主张描述目标架构，不代表当前执行路径。新开发遵守[强制分层契约](docs/architecture/layers.md)。

> WebGPU 的价值不在“画得更好看”，而在于 compute + indirect draw 让 CPU 从每帧数千次
> 绑定调用里解放出来。目标是把剔除、排序、蒙皮、粒子推到 GPU，CPU 声明本帧需求，
> FrameGraph 编译并组织执行。
