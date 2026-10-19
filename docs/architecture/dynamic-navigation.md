# 动态障碍与吊门寻路

2026-10-11，`codex/crowd-navigation-20261010`，开发基线 `c96929c`，场景 schema v18。
本次是在固定三维地表图上增删阻挡，不重新生成地形或烘焙 GLB NavMesh。
地表采样图的范围与限制仍见[三维地表导航](surface-navigation.md)。

## 职责与真源

| Owner | 源码 | 责任 |
|---|---|---|
| Framework / Scene | `packages/scene/src/document.ts`、`migrate.ts` | NavigationGate 参数、稳定 NodeId、v17→v18 显式可选迁移 |
| Framework / AI | `packages/ai/src/surface-navigation.ts` | 运行 AABB 快照、局部格/边阻挡层、旧场失效、按预算重算路线 |
| Framework / Runtime | `packages/runtime/src/navigation-gates.ts` | 固定步运动学门、目标反向、占用扫掠等待、姿态与射线几何 |
| Framework / Core | `packages/core/src/contact.ts` | 共享 Float32 接触容差，避免贴门被误判为穿入而无法后退/开门 |
| Game | `packages/zombie-game/src/loader.ts`、`session.ts`、`surface-crowd-navigation.ts` | 场景装载、角色占用注入、活动碰撞集合、追击策略及 CharacterTable 写回 |
| Editor | `gate-presentation.ts`、`gate-panel.ts`、`play-controller.ts`、`editor-agent.ts` | 只读姿态投影、可见开关按钮和 MCP 装配、Stop 快照恢复 |

门节点的作者变换是**关闭姿态**。同节点需有一个启用的非 Trigger box Collider；可见
外观仍由 MeshRenderer 持久化。组件示例：

```json
{"kind":"NavigationGate","enabled":true,"openOffset":[0,4,0],"travelSec":1.5,"initialOpen":false}
```

偏移在节点局部空间，loader 用作者世界矩阵转换成世界位移。运动只平移，不改变旋转或
缩放。本版本要求无子节点的根节点、显式 NavZone.surface，禁止将活动门作为静态
NavSurface.supportCollider。非法模式、形状、层级、偏移或时长给出 E_NAV_GATE_*；
不静默退回旧平面模式。旧场景迁移只升级版本，不制造门或改变内容。15 个已有场景完成
v18 迁移；新动态白盒登记在项目 scenes 清单。

## 路径更新、碰撞与失败行为

loader 把启用的运动门从静态导航障碍和静态射线集合中抽离，避免初始关门永久裁掉底图。
RuntimeSession 持有 NavigationGates 副本，advanceGates 在每个固定步的角色移动前推进。
同一进度生成世界 AABB、精确 box 逆矩阵与可见位置；玩家、NPC、突扑/冲锋、击退的
地表移动，以及枪弹/敌人攻击遮挡消费更新后的障碍。作者文档始终不变。

`SurfaceNavigation.setDynamicObstacles` 原子校验并复制完整运行障碍集合。新旧 AABB
周围的格和边重新检查，静态支撑图和连接不重建；开启后恢复被阻断的边。超大/远处
查询退回检查已有桶，避免遍历无边界的空白世界。连续物理碰撞立即采用新快照；仅当
阻挡格/边变化时使旧 published/staging 目标场失效，重新按 flowCellBudget 推进。
未发布有效路线或无路可达时等待，不以穿墙直线追击兜底。角色靠近门边时，最近采样格
可能被保守阻挡，需按实际半径找同面连续可达邻格，并先回到可走格中心再转角。

门在打开和关闭两个方向都检查下一步扫掠 AABB。宿主直接读存活角色的权威 XYZ/半径，
高度取实际胶囊与导航配置的较大值，保持占用保护和导航净空一致。有角色阻挡时门原位
等待并保留目标；角色离开继续移动，反向命令可中途取消关闭。不开启挤压、强制瞬移或
压入角色的策略。上下层按实际 Y 区间隔离，不以 XZ 重合判阻挡。

导航与占用统一用 `intervalsPenetrate` 判断严格穿入；忽略至少 10μm 或两 Float32 ULP 的接触误差。这样 CharacterTable 的 Float32 写回不会把合法贴门位置变成非法起点，真实穿入仍使门等待。

快照提供 obstacleVersion、dynamicObstacleCount、blockedDynamicCells/Edges、overlayWork
及目标场版本；门提供 progress、targetOpen、waiting、state、position、bounds。
overlayWork 是最近一次局部更新工作项，不是 flowCellBudget 的一部分。局部更新、
占用检查、数组清空和发布仍同步执行；搜索预算不是毫秒硬上限。

## 编辑、MCP 与 Play

作者配置使用共享 `scene_get → scene_edit_nodes → scene_validate → scene_save → scene_open`
闭环；没有新增专用 NavigationGate 作者 Inspector。Play 中左下角“动态导航门”按钮与
MCP 共用 `RuntimeSession.setGateOpen`，不修改作者配置或推进模拟。

```json
{"name":"editor_gate","arguments":{"instanceId":"<明确选择的实例>","expectedRevision":"<scene_get.state.revision>","nodeId":"nd_gate_ramp","open":true,"runId":1}}
```

runId 必须取当前 `editor_runtime.runtime.player.runId`，重跑/重建后旧代拒绝；作者 revision
过期、未在 Play、未知门、非法参数和终态均拒绝。通过 editor_play.step 推进，再读取
editor_runtime.runtime.gates / navigation，不能把命令被接受当成门已经移动到位。
Stop 清空运行实例、恢复作者物体变换及游戏相机，并释放已有 Play GPU 资源。

## 实际验收与性能边界

白盒：`assets/scenes/sandbox/dynamic-navigation-whitebox.scene.json`，生成器
`node tools/level/gen-dynamic-navigation-whitebox.mjs`。55 节点、46 个静态 mesh、21 个导航面、
1245 个底图格；保留斜坡、楼梯、叠层和孤岛，A 斜坡门初始关闭，B 楼梯门初始打开。
证据目录 `docs/evidence/dynamic-navigation-20261011/`。

- headed Chrome / HTTPS secure context / NVIDIA Lovelace / fallback=false。
- 关闭 A 时，坡道组经 B 楼梯绕行，tick 300 已在楼梯按踏面取高度。
- 两门关闭后 tick 160，12 NPC 不可达并等待；底图仍为 1245 格。
- 打开 A，tick 180 进度 44.4%，净空仍不足，NPC 继续等待。
- 门边缘回归修复后 tick 780，连通区 8 NPC 全部到 Y=4 高台；隔离层/孤岛 4 NPC 不可达。
- travelSec 1.5→1.6 保存重开，再改回 1.5 保存重开，NodeId、初态、偏移与无关字段保留。
- Stop 后作者文档逐字序列化相同，门外观回关闭姿态；gates=[]、navigation=null，GPU 账本 registered=6/disposed=6/pending=0。
- 门占用等待、反向、精确弹道随姿态更新、贴门 Float32 接触、失败输入和 reset 有独立 CPU 回归。
  GPU 白盒使用 E-01 静态实例和胶囊玩家，不认证完整角色动画或 500 人渲染帧率。

CPU 工具：`node tools/verify/dynamic-navigation-benchmark.mjs`。Node 22.23.2，本次固定
门开关序列下 100 NPC P95 15.12ms、500 NPC P95 22.42ms，初始化约 143/79ms，
搜索最大工作项 2048，局部 overlay 最大 3477 项。报告记录源码 hash。夹具故意在半径
1m 内密集投放，残余初始重叠峰值 1329/32698 对，不能认证零穿透或全部群体通关。
占用导致关门等待是预期行为；数据包含游戏 CPU 模拟、GC/调度，不能换算 FPS。

能力边界：没有移动地表、旋转/物理门、门与静态建筑的刚体接触、跳跃/攀爬链接、飞行
体积寻路或任意 GLB 自动导航烘焙。门净空用保守 AABB，地表支撑用有限采样；斜向门
可能比视觉更早阻挡，复杂窄缝不保证精确胶囊碰撞。

变更门禁：相关 owner Vitest、typecheck、editor:build、architecture:check、scene:check、
knowledge:check 以及 Node 场景契约/MCP 测试。独立复审关闭一个 Float32 贴门锁死 P1，终审无未关闭 P1/P2；完整验收记录见上述证据目录。
