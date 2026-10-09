# 游戏开发：契约、流程与 Agent 入口

## 当前职责与知识导航（2026-10-09）

当前职责与发现方式见[共享文档入口](README.md)、[分层契约](architecture/layers.md)和
[CodeGraph MCP 指南](knowledge/codegraph.md)。[分支集成](review/branch-integration-2026-10-09.md)
后场景 schema 为 v15。僵尸模拟、进度和音频事件投影在 `packages/zombie-game/src`，
HUD/输入/音频表现位于其 `presentation`。通用编辑命令、武器和碰撞在 `packages/runtime`。
本指南的流程及源码/测试路径已对照 `e6c2278` 复核；验收测量保留原日期和版本，本次复核
不重新认证运行、美术或设备表现。

这是主分支集成和 Editor/Framework/Game 分离后的开发入口，将实现契约连到可重复的
编辑和验收流程。专项报告仍保留自己的日期、版本和证据，当前源码与项目规则优先。

## 职责与真源

| 领域 | 持久化真源 | 执行职责/技术约束 |
|---|---|---|
| 场景选择与内容 | `aether.project.json`、已登记 `assets/scenes/**`、`packages/scene/src/document.ts` | 编辑器读写场景文件；稳定 NodeId、完整组件和 AssetRef path/GUID 在重载后保留。当前 v15；读 `scene_get` 和源码常量，不假定旧报告版本 |
| 编辑、历史与保存 | `SpawnEditStore`、编辑命令、`author-scene-save.ts` | UI/MCP 共用编辑状态及历史；磁盘冲突显式报告；表单草稿与已应用编辑不同 |
| 环境与材质覆盖 | 场景 environment、Mesh 组件、项目材质库 | 以可复现游戏相机构图调节；渲染对象只是投影，不持有持久化编辑真源 |
| 美术与 LOD 派生 | `assets/art/sources/**`、运行时 GLB、sidecar、构建清单 | 保存源资产、归一化配方、哈希和 GUID；每级从原始源派生，保护 UV 和直线结构 |
| NPC 攻击与时序 | 场景玩法组件、角色定义 | `packages/zombie-game/src/session.ts`/`enemy-attacks.ts` 决定距离许可、攻击名额、独立种子时序、伤害和效果；表现消费实际接受状态 |
| 武器定义 | 场景 `RunRules.arsenal`；`packages/scene/src/weapons.ts` | `WeaponSystem` 管装备、弹药、换弹、升级和接受事件；`WeaponCombat` 实现 hitscan、散射、穿透、投射物、近战和火焰 |
| 武器动画/IK | 武器表现标记、动画选择及程序化参数 | 接受事件驱动片段/阶段；瞄准 torso/head IK 激活时，编辑器动作适配器在开火期间保留步态。持握/枪口/弹匣/弹膛标记及后坐/换弹意图是消费接口；自动手部定位和程序化填装未实现 |
| 音频 | 场景 `RunRules.audio`、WAV AssetRef 和实测 `.meta.json` | `packages/zombie-game/src/audio-frame.ts` 投影接受事实，`presentation/game-audio.ts` 管解码、混音、声音及清理；不得改战斗、替换武器 hook 或消费玩法 RNG |
| 控制/HUD | 游戏控制、语言及 HUD 服务 | 桌面键鼠与触摸共用运行时动作；有中英文标签，手机模拟仅证明布局 |
| Play 生命周期 | `PlaySession`/`PlayController` 及资源账目 | Play 前快照，运行副本；Stop 回滚编辑状态并释放登记的 Play 资源，含音频 |
| Game Editor MCP | `tools/mcp-editor`、实时 `EditorAgent` 派发 | stdio → 本机 broker → 明确选择的浏览器实例 → 已有业务服务；不另建场景状态、模拟、DOM 点击引擎或任意代码执行 |

## 主要技术与失败边界

**构图与材质。** 先保证玩家、威胁和可通行路径，再加装饰。用游戏相机检查入口、中段和
末房；好看的轨道视角可能掩盖街景/背景空缺。分近中远景轮廓和明度，保持街道/外围地面
连续，使用哑光建筑覆盖、克制描边及统一冷暖光。房间/导航语义与装饰合批分开。静态槽位
仍为 64，NPC 不能走静态路径。先排查 linear/sRGB、色调映射和 uniform 装箱，不用极端
纹理色或曝光掩盖错误。见[品质指南](art/visual-quality-playbook.md)和[街景报告](36-StreetQualityAndArchitecturalLOD.md)。

**建筑 LOD。** glTF 层级变换先烘焙，再判断轴向。每级独立从原始源做 UV 感知减面，保护
边界/平面，限制顶点迁移以免生成屋顶折面。面数目标不能高于结构直线品质；除了法线，还要
检查平行面位移。真实有界面 Asset Browser 和游戏相机检查贴图屋顶/立面。数值平面/UV
统计是诊断，不是美术通过。占位替换保持已接受的路径/GUID。

**群体与攻击可读性。** 增量 NPC 必须配距离门槛和并发许可，不能附近全体同时起手。
决策、预备、恢复和冷却使用独立种子变化，伤害/死亡立即发生。玩法按设计显示预警、运动/
接触和持续效果；攻击范围圈归调试。酸池独立于射手死亡/槽位复用。各层目标不同，美术语言
统一。见[战斗/输入报告](37-CombatInputAndPopulationQuality.md)。

**武器抽象。** 增加定义与具体战斗实现，不在渲染器重复弹药/计时。拒绝的射击不能触发
动画、后坐或音效。Hook 接收复制的接受事件和局部标记；观察者异常不能回滚战斗。
换弹阶段和归一化阶段可供后续程序化手部动作消费。Reset 会构造新武器 owner，消费者要
重绑。占位资源明确有效；当前程序化表现不装载任意武器模型 AssetRef。
见[武器契约与 hook 指南](39-Unified-weapons-and-animation-hooks.md)。

**音频接入与播放。** 导入独立 take，不再切预览 reel。检查清单、变体哈希、格式、起音/
余量和循环采样索引。使用进程稳定的合成 seed、正确的循环交叉淡化方向、闭合前过滤及
有效 RIFF padding。场景映射接入接受射击、接触及 NPC 攻击。限制声音/解码内存，使用
优先级、距离衰减和低音量环境层，便于检查尸潮声音。暂停、隐藏、静音和终局移除声音；
Stop 拒绝迟到解码并清缓冲。AudioContext 仍需可信用户交互；播放计数不证明听感。
见[音频接入](42-GameplayAudioIntegration.md)和[音效需求](40-GameplayAudioAssetBrief.md)。

## 可重复的开发交付流程

1. **建立基线。** 查分支、上游和已有修改，保留其他会话工作。读当前规则、相关设计和
   证据。集成先 fetch/核祖先关系再称“已合入”；跨场景/运行时/表现契约前明确职责和
   验收，不替换其他会话服务或接管 rig/IK 资产。
2. **先定数据契约。** 场景语义先改 `packages/scene/src/document.ts` 或专用 schema，
   补验证和迁移测试；每次增版本补链。新场景事务式登记，缺资源以占位或诊断明确表示。
3. **在正确职责实现。** 游戏会话决定游戏事实，Framework 管通用武器/碰撞，表现/音频
   消费接受事实，编辑器适配器注入端口。编辑命令更新共享历史，不重复缓存弹药、场景副本、
   时钟或随机流。跨层改动跑架构门禁；携带/保存/reset 保留契约不变量。
4. **完成持久化闭环。** 编辑→验证→保存→重开→比较磁盘/文档字段；覆盖拒绝编辑和冲突。
   不把运行时 QA 夹具或 GPU 对象存场景；修改编辑内容前停止 Play。
5. **按改动验证。** 跑相关 CPU/契约测试、类型检查和受影响构建。改 `assets/**` 跑
   `scene:check`；GLB sidecar 合并生成，不覆盖 rig/bindings/userData。Roster 改动还需
   content 生成/检查。渲染变化用有界面硬件 GPU；连接或探活前读浏览器/GPU 规则。
6. **走可达产品路径。** 使用可见 Open/Save/Play、真实键鼠/触摸及可信音频 Ready 交互。
   检查攻击、武器动作/弹药/VFX、音频/静音/暂停和 Stop 清理。MCP 单步或 QA 注入只覆盖
   有限逻辑，不代表完整用户路径/战役验收。恢复临时夹具和编辑配置。
7. **记录交付。** 证据记录版本、适配器/视口、改动数据、观察、夹具边界和待验收项。
   流程变化更新指南及 MCP 契约；精确暂存，规范中文提交后立即推正确 SSH origin。
   用户要求的 PR 按 `pr-bot-review`；检查通过不等于美术通过。

常用检查（选择受影响子集，不代表本次全部重跑）：

```powershell
node --test tools/mcp-editor/*.test.mjs
pnpm exec vitest run apps/editor/test/editor-agent.test.ts apps/editor/test/weapon-diagnostics.test.ts --no-file-parallelism
pnpm exec vitest run packages/zombie-game/test/weapons.test.ts packages/zombie-game/test/audio-frame.test.ts packages/zombie-game/test/presentation/game-audio.test.ts packages/zombie-game/test/presentation/game-audio-assets.test.ts --no-file-parallelism
python -m unittest tools/audio/test_audio.py
pnpm run typecheck
pnpm run editor:build
pnpm run scene:check
pnpm run architecture:check
pnpm run knowledge:check
```

美术脚本在 `tools/art/`，建筑构建为 `tools/art/build-p0-lods.py`；音频合成/接入/检查在
`tools/audio/`。生成/发布前确认参数和输出范围，工具可能重写运行资产或全部战役场景。
检查与重新生成不同。

## 当前 MCP 的 Agent 流程

见[传输配置、schema 和示例](../tools/mcp-editor/README.md)。默认显式启用：Vite 设置
`AETHER_EDITOR_MCP=1`，明确选中的标签带 `agent=1`，客户端登记独立处理。
编辑器及完整 Play 使用 5100，5101 仅为 M0 GPU 初始化示例。

1. 无实例调用 **`editor_workflow`**，发现指南、真源、阶段工具、失败恢复及覆盖缺口。
   需要 broker 运行，不需要浏览器实例。
2. **`editor_instances`** 后明确选择目标 UUID；**`scene_list`**/**`scene_get`** 返回
   登记路径、完整编辑文档、schema 和 `state.revision`。不能随意选第一个标签。
3. 从刚读取的文档构造完整节点。材质/`RunRules.arsenal`/`RunRules.audio` 只改目标字段，
   以稳定 nodeId 调 **`scene_edit_nodes`** replace 完整节点；氛围用完整 environment
   调 **`scene_set_environment`**。每次写带 `expectedRevision`，下一次用返回 revision。
   创建登记文件，但不会切场景。
4. **`scene_validate`**→**`scene_save`**→**`scene_open`**→**`scene_get`** 比较改动，
   完成落盘回读。通用节点替换没有专用武器/音频表单或资产搜索。
5. **`editor_play`** 初始暂停，resume/pause/step（1–600）/stop 委托 PlayController。
   **`editor_runtime`** 返回真实 tick/玩家/NPC/账目、weapons（停止时 null）和音频
   生命周期/混音计数。武器含各 ID 弹药、动作/阶段、局部标记、后坐/换弹意图、最近 16 个
   接受事件、hook 错误及效果数；这里没有换装/射击命令，也不绕过自动播放限制。
6. **`editor_capture`** 只截 GPU canvas；DOM HUD/输入和审听需独立路径证据。
   完成前 Stop 并检查账目、编辑状态及音频缓冲/声音。

revision 过期则重读并基于最新状态重做；人的草稿需协调应用/放弃；Play 锁先 Stop；
磁盘冲突保留本地改动并检查磁盘。投影错误/超时后先查当前 revision，编辑可能已执行。
断连重新发现实例，不自动换标签。结构化恢复规则见 MCP workflow。

## 已有证据与待验收项

历史报告分别证明[街景 Edit→Save→Reload/LOD](36-StreetQualityAndArchitecturalLOD.md)、
[NPC/输入](37-CombatInputAndPopulationQuality.md)、[武器/输入/hook](39-Unified-weapons-and-animation-hooks.md)、
[22 take 音频播放/清理](42-GameplayAudioIntegration.md)的限定观察。本次文档更新未重跑；
不据此认证完整概念图匹配、全部战役或持续手机性能。

剩余事项：游戏内人工审听、专用缺失音效和最终武器/动作资源、BGM/VO 接入、武器标记驱动
手部 IK 与程序化后坐/填装、完整 Agent 资产/组件发现及语义编辑、断连/竞争加固和客户端
配置。基础 HumanIK/动作过渡已集成，限制见 [IK 指南](animation/body-ik-blending.md)。
更完整 MCP 属独立范围；未跟踪 `docs/41` 和交付目录归原会话，本指南不批准或提交它们。

2026-10-08 文档/MCP 更新通过 6 项 Node 传输/workflow、10 项 editor-agent/武器诊断/
音频测试、类型检查、编辑器构建和 19 项本地文档链接检查。stdio 测试使用真实适配进程
和受控 broker，不使用浏览器。当时未改资产/schema/渲染/玩法，因此没有新增 GPU、美术
或审听验收；已有 Vite CJS 和 chunk-size 警告保留。
