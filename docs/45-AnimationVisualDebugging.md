# 动画可视化调试

编辑器提供针对单个观察角色的临时、只读动画图。在视口左下角打开**动画调试图 · 只读**，
再用已有 Play 控制进入游戏。如果玩家通过场景骨架渲染，默认观察该场景玩家；否则观察
运行时玩家。**观察角色**还列出场景骨架和当前存活的 NPC 身份。

## 两种视图的含义

**状态与条件**显示实际表现选择器的规则、请求状态/片段和真实输出。绿色连线表示选中的
规则路径。点击节点可检查条件真假、优先级、片段可用性及回退原因。这些连线属于实际
解析规则，不是编辑配置的状态机，也不是人为补出的任意状态间过渡。Profile 将状态映射到
片段，并不定义状态机连线。

未配置区域层的场景沿用现有优先级：手动覆盖、可用武器动作候选、旧开火输入、移动状态，
有效瞄准 IK 可在开火时保留步态。配置 `SharedMotionBinding.poseLayer` 的玩家使用持续基础
步态与独立区域武器动作；射击/换弹/切枪的 phase 只控制上层，缺 equip/unequip 保留基础
步态与 ready/程序化姿态，并报告 `WEAPON_CLIP_MISSING`，没有假称存在换枪动作素材。
持续按住开火不等于接受了一次武器动作。武器请求、动作 stamp、缺片与区域 mask 来自
执行时保存的生产元数据；观察器不会重选玩家的组合策略。

实例 NPC 使用实际行为到片段的映射，包括静止追击角色的行为归一化。实例渲染的玩家使用
现有武器片段/动作映射，该路径有自己的 fire→attack 回退，不复用场景动作解析器。
缺失片段名称回退到第 0 个片段，空片段集合使用绑定姿态。Proxy/LOD 和当前角色加载失败
会明确显示；不会为胶囊代理推断动画。

**姿态管线**显示基础采样、基础姿态过渡、配置时的骨骼区域动作混合、身体 IK 控制及渲染输出。
区域节点显示独立片段/time/phase、roots/exclude、实际 mask 骨骼与节点、0–1 配置权重和独立
过渡；禁用/缺骨/缺片也可检查。区域组合后只执行一次身体 IK。IK 有效权重包含真实运行时
动作乘子：换弹淡出手部 IK 后恢复，持久配置权重不变。目标权重使用真实缓动
权重，不能把 elapsed/duration 直接当作混合权重。场景骨架的过渡源是捕获的局部姿态，
实例角色的过渡源是捕获的调色板矩阵；两条路径都不会在过渡中持续播放两个源片段。
Retarget 和调色板烘焙发生在加载阶段，不作为每帧处理节点展示。

点击 IK 控制节点可查看配置权重、有效权重、目标类型、解析后的角色局部目标、有效性和
解算诊断。缺失目标、无效骨链及跳过解算的有效权重为 0。当前 GPU 实例不执行 CPU 身体 IK，
图中标为不支持，并突出直接输出路径。未配置、加载中和失败的层仍保持可见。解算诊断来自
最近一次可用 CPU 计算；没有 GPU 回读，也没有重建实际渲染顶点的位置。

## 观察控制

- **冻结观察画面**保留当前图和时间线；游戏继续，选定角色的生产事件流仍收集有界事件。
  **恢复实时观察**显示最新状态。这不是游戏暂停。
- 点击最近一次切换可查看记录的投影；**返回当前观察**回到当前或冻结的投影，不会重播世界。
- **缩小图**、**放大图**、**复位图**、Ctrl+滚轮、滚动条及拖动图的空白区域仅改变图视图。
  节点支持 Enter/Space 查看详情。
- 面板按键不会传给游戏/编辑器快捷键；松键仍传给已有输入 owner，以释放此前按住的移动/开火键。
- **关闭**取消观察订阅，并清除保留的视图与历史。关闭后不再进行额外调试采样。

Stop、新一轮运行、切换目标或实体代次变化都会清除观察历史和冻结视图。场景目标使用稳定
NodeId，运行时实体使用 runId/entityId/generation；渲染批次行号和静态数组槽位不能用作
持久化身份。面板不写场景文件、资产 sidecar、动作库或编辑器偏好。

## 职责与成本

`apps/editor/src/services/animation-debug/` 负责与原状态隔离的契约、解析规则说明、运行适配、
收集器、图投影和面板。`RuntimeSceneMotion`、`RuntimeBridge`、`RuntimeBodyIk` 仅提供
窄范围的只读观察；`PalettePoseTransitions.describe` 只提供 CPU 元数据。
`main.ts` 创建面板、提供宿主引用、渲染后刷新，并随编辑器销毁面板。
游戏会话从 `@aether/zombie-game` 公共入口消费；观察器不把游戏职责移回 Framework。

只有选定角色产生调试快照。执行事件独立于 UI 刷新捕获，UI 每秒最多刷新 8 次。场景玩家
保留最后实际执行的选择器输入，作为轻量表现元数据；因此首次观察或暂停时切回玩家能
读取当前规则，无需推进动画。首次自动 tick 之前，图解释加载时实际选中的默认状态。
首次选择 GPU 角色时，观察器立即读取已打包的 CPU 实例行及过渡元数据，Play 暂停时也一样。
该操作不重建批次、不采样或推进姿态，也不推进世界。

历史最多保留 32 个隔离快照，可检查短暂过渡及连续同片段武器动作，无需每帧复制整个群体。
目标下拉列表按 UI 频率枚举当前身份，不复制群体姿态。观察器不拥有 GPU 资源、不改动画
参数、不调用动画/IK setter，也不暂停模拟。已有动画和 IK 控制面板保留各自行为。

只读接口 `window.__editor.animationDebug.snapshot()` 返回当前显示视图的隔离副本；没有
保留视图时返回 null。该接口没有控制功能，可见面板仍是验收入口。

## 定向验证

模型与服务门禁：

```powershell
pnpm exec vitest run apps/editor/test/animation-debug-selection.test.ts apps/editor/test/animation-debug-collector.test.ts apps/editor/test/animation-debug-source.test.ts apps/editor/test/runtime-scene-motion.test.ts apps/editor/test/runtime-body-ik.test.ts apps/editor/test/runtime-bridge.test.ts packages/render/test/pose-transition.test.ts
pnpm run typecheck
pnpm run editor:build
```

有界面 Play 验收使用已有 `assets/scenes/sandbox/shared-motion-runtime.scene.json` 和
`assets/scenes/sandbox/body-ik-validation.scene.json`。打开面板，检查场景/NPC 路径、点击条件/
控制节点、查看短暂过渡与历史、验证图导航；用 Space 激活冻结按钮时确认运行 tick 继续。
Stop/重跑并切换观察角色，确认历史不会跨身份。还需在实际可达运行路径检查 Proxy 及缺失/
配置诊断。单元测试和构建不能替代可见/GPU 验收。
