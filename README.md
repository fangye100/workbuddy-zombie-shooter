# Aether — WebGPU 游戏引擎设计与骨架

## Agent development entrypoints

Read [project rules](AGENTS.md), [shared knowledge](docs/README.md),
[layer ownership](docs/architecture/layers.md), and
[CodeGraph MCP usage](docs/knowledge/codegraph.md) before cross-module changes.
Zombie simulation/presentation uses `packages/zombie-game`; reusable mechanisms
remain framework packages. Run `pnpm run architecture:check` and
`pnpm run knowledge:check` with the affected tests.

A modular WebGPU engine, Game Editor and Zombie campaign. The current playable
path is **Editor Play on port 5100**. `RendererCore` schedules direct GPU passes,
including instanced actors and GPU pose sampling. FrameGraph, broader GPU-driven
culling and the full subsystem architecture remain design directions; their
presence in design documents does not establish an active runtime path.

## 文档索引

Current development starts at [Gameplay development workflow](./docs/43-GameplayDevelopmentWorkflow.md): scene persistence, comic materials/LOD, NPC/input, unified weapons/IK ports, audio and scoped acceptance. [Game Editor MCP](./tools/mcp-editor/README.md) exposes workflow discovery and the shared authoring/diagnostic path.

| 文档 | 内容 |
|---|---|
| [Current structure map](./docs/44-CodeGraph代码结构图谱.md) | Current source owners and execution paths, CodeGraph scope/limitations, plus the preserved historical audit |
| [01-架构总览与主循环](./docs/01-架构总览与主循环.md) | Original architecture design and roadmap; read the current layer contract before applying its dependency diagram |
| [02-WebGPU设备资源层与FrameGraph](./docs/02-WebGPU设备资源层与FrameGraph.md) | 能力分级、句柄系统、五种分配器、绑定组频率模型、ShaderLab 变体、FrameGraph 编译四件事、GPU-driven 路径、Timestamp 剖析 |
| [03-渲染管线](./docs/03-渲染管线.md) | Clustered Forward+ 选型、一帧 Pass 拓扑、阴影/GI/材质/透明/后处理、RenderWorld 解耦、排序与合批 |
| [04-子系统](./docs/04-子系统.md) | ECS、场景、资产、动画、物理、VFX、UI、音频、输入、脚本、网络、地形、存档、i18n、剖析器、依赖矩阵 |
| [05-NPC角色控制系统](./docs/05-NPC角色控制系统.md) | 四层解耦（Agent/Locomotion/Avatar/Combat）、角色装配与池化、VAT 表现 LOD、感知与 Utility 决策、流场寻路与群体避让、帧数据与扫掠命中、攻击名额与包围圈配额 |
| [16-Retargeting 设计与开发计划](./docs/16-MotionMatch动画匹配设计.md) | 根与末端空间补偿、接触约束、共享骨盆及全身求解、数据契约、开发队列与验收 |
| [16A-Retargeting 运动空间补偿算法研究](./docs/16A-Retargeting运动空间补偿算法研究.md) | HumanIK 等公开证据、可复现公式、接触策略、数值验证及完整脚本 |
| [Character rigging workflow](./docs/rigging/character-rigging-workflow.md) | Source-pose joint authoring, volumetric skin, rigid props, GLB delivery, shared motion and control acceptance |
| [Binding MCP](./tools/mcp-binding/README.md) | Read-only workflow discovery, authoring tools, final-weight diagnostics, persistence and rig export |
| [Visual quality playbook](./docs/art/visual-quality-playbook.md) | Comic art matching, composition, color/shader diagnosis, textured LODs, placeholders, sky/atlas handling and evidence-based acceptance |
| [Crowd performance baseline — 2026-10-07](./docs/39-CrowdPerformanceBaseline-2026-10-07.md) | Running/shooting with upper-body IK, 500–2,500 NPC samples, CPU/GPU timings, sustained stability boundaries and archived evidence |
| [iPhone Play crash mitigation — 2026-10-07](./docs/40-IPhonePlayCrashMitigation-2026-10-07.md) | Scene-demand actor loading, bounded runtime textures, GPU loss handling and device verification limits |

## 目录

```
packages/
  core/         ECS, math and application contracts
  gfx/          Device, resource handles, uniform/staging rings
  framegraph/   Pass/resource planning; dormant in the current renderer
  scene/        Project/scene/sidecar schemas, migrations and data contracts
  render/       RendererCore direct passes, shaders, skinning, IK and pose blending
  ai/           Navigation, spatial hash, crowd and combat primitives
  gameplay/     Reusable character table/pool, assembly, LOD and ray primitives
  runtime/      Reusable author commands, behavior ports, weapons and collision
  content/      Generated character APIs; roster/stat JSON is authoritative
  zombie-game/  Campaign simulation/progression; separate presentation subpaths
apps/editor/            Authoring UI and render/Play adapters; port 5100
apps/samples/00-init/   M0 GPU initialization sample; port 5101
docs/                   Shared guides, designs and dated evidence; see docs/README.md
tools/                  MCP, file transactions, art/audio/scene/rigging pipelines and gates
```

## 快速开始

```powershell
pnpm install
git lfs pull
pnpm run editor       # Game Editor and complete Play path, fixed port 5100
pnpm run typecheck
pnpm run architecture:check
pnpm run knowledge:check
```

Use the configured certificate hostname for HTTPS/Tailscale access; see
[project network/browser rules](AGENTS.md). Confirm a secure context and the
actual WebGPU hardware adapter. Browser support and device acceptance must be
verified on the target device, not inferred from a version label.

`pnpm run dev` starts only the M0 clear/capability sample on 5101. For headless
campaign tooling, `pnpm run game:build` builds separate framework/game bundles.
`pnpm run sim` exports derived snapshots and can alter startup selection with
`--focus`; it is not a read-only check. `pnpm run verify:parity` produces a Node
sample; cross-host equivalence additionally requires a matching browser snapshot
and explicit comparison. Inspect the tool arguments before generation.

## Original design direction

The statement below describes a target architecture, not the current execution
path. New work follows the [enforced layer contract](docs/architecture/layers.md).

> WebGPU 的价值不在"画得更好看"，而在于 **compute + indirect draw 让 CPU 从每帧数千次
> 绑定调用里解放出来**。所以这套架构的重心是把剔除、排序、蒙皮、粒子全部推到 GPU，
> CPU 只负责声明"这一帧要什么"（FrameGraph），其余交给编译期推导。
