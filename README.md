# Aether — WebGPU 游戏引擎设计与骨架

以 WebGPU 为一等公民的模块化游戏引擎：数据驱动（ECS + SoA）、GPU-driven 剔除、
FrameGraph 驱动的渲染管线，配套编辑器与资产烘焙工具链。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-架构总览与主循环](./docs/01-架构总览与主循环.md) | 七层架构、包划分、一帧时序、Job 调度、技术选型决策表、M0–M8 路线图、编码规范 |
| [02-WebGPU设备资源层与FrameGraph](./docs/02-WebGPU设备资源层与FrameGraph.md) | 能力分级、句柄系统、五种分配器、绑定组频率模型、ShaderLab 变体、FrameGraph 编译四件事、GPU-driven 路径、Timestamp 剖析 |
| [03-渲染管线](./docs/03-渲染管线.md) | Clustered Forward+ 选型、一帧 Pass 拓扑、阴影/GI/材质/透明/后处理、RenderWorld 解耦、排序与合批 |
| [04-子系统](./docs/04-子系统.md) | ECS、场景、资产、动画、物理、VFX、UI、音频、输入、脚本、网络、地形、存档、i18n、剖析器、依赖矩阵 |
| [05-NPC角色控制系统](./docs/05-NPC角色控制系统.md) | 四层解耦（Agent/Locomotion/Avatar/Combat）、角色装配与池化、VAT 表现 LOD、感知与 Utility 决策、流场寻路与群体避让、帧数据与扫掠命中、攻击名额与包围圈配额 |

## 目录

```
packages/
  core/        app(插件/Stage/调度) + ecs(Archetype+SoA) + math
  gfx/         handle(句柄与注册表) + device(能力/分配器/缓存三件套)
  framegraph/  声明式 Pass DAG、生命周期推导、内存别名
  render/      RenderFeature 接口、管线配置装配、Pass 顺序表
  ai/          流场寻路(Dial's Dijkstra) + 空间哈希 + 群体避让 + 感知 + Utility 决策 + 战斗帧数据
  gameplay/    CharacterDef / CharacterTable(SoA) / 池化与分帧装配 / 表现 LOD
apps/samples/00-init   最小可运行基座（M0 验收）
docs/                  上述五篇设计文档
tools/                 baker / shaderlab / trace（规划中）
```

## 快速开始

```bash
pnpm install
pnpm dev        # 打开 apps/samples/00-init
pnpm typecheck  # 全量 TypeScript 严格检查
pnpm smoke:nav  # 导航层冒烟测试（纯 CPU，无需浏览器）
```

需要 Chrome 113+ / Edge 113+ / Safari 18+。M0 验收标准：稳定 60fps 清屏，
HUD 能读出 tier、format、maxBindGroups、timestamp 支持情况。

## 一句话设计主张

> WebGPU 的价值不在"画得更好看"，而在于 **compute + indirect draw 让 CPU 从每帧数千次
> 绑定调用里解放出来**。所以这套架构的重心是把剔除、排序、蒙皮、粒子全部推到 GPU，
> CPU 只负责声明"这一帧要什么"（FrameGraph），其余交给编译期推导。
