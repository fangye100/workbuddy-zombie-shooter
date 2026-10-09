# ANI-20261008 动作进入实际玩法

## 当前接入与责任

2026-10-10，在 `codex/architecture-boundaries-20261009`、基线提交
`bab7673c75b89e429a7a9eacd43443dff93ce80e` 上完成本次接入。之前的
[候选交接记录](ani-20261008-intake.md)保留当时未做 GPU 验收的事实。本次是可运行的
玩法接入与定向验收，不认证整款游戏已达到设计稿的最终品质。

- 内容配方：[ani-20261008.recipe.json](../../assets/animations/gameplay/ani-20261008.recipe.json)。
  原始共享 BVH 保留；21 个派生片段分别持有稳定 GUID、源哈希、包含末帧的裁剪区间和接缝帧数。
  剪辑点是有界面预览后的人工选择，不伪称交付方提供的命中标记或精密动作捕捉测量。
- Framework：[motion-direction.ts](../../packages/runtime/src/motion-direction.ts)只计算面向相对的四向步态，
  `yaw=atan2(dz,dx)`。武器计时、持握标记和后坐力 hook 仍使用原有通用武器系统。
- 游戏内核：[session.ts](../../packages/zombie-game/src/session.ts)提供真实随机前摇/收势相位、
  Boss 砸击阶段，以及 NPC 击杀前快照。渲染不反向决定射击、伤害、移动、冷却或奖励。
- 游戏表现：[npc-motion.ts](../../packages/zombie-game/src/presentation/npc-motion.ts)消费战斗事件，
  受击 0.3 秒、死亡尾部 3.3 秒；死亡快照最多 32 个，身份同时含 runId、slot、generation。
  攻击/收势优先于受击；受击不额外施加硬直。尸体不参与模拟、碰撞和选取；Stop 清空全部表现状态。
- Editor：`RuntimeSceneMotion` 适配作者玩家网格；`RuntimeBridge` 打包 NPC GPU 实例；
  `ActorLibrary` 装载 rig sidecar 指定的 profile。动画观察器说明实际执行的状态，不拥有玩法状态。

## 映射与受限接收

| 目标 | 实际映射 | 接收边界 |
|---|---|---|
| 玩家 | 持枪待机、walk_f/b/l/r、shoot、reload | 四向步态按面向与实际位移选择；短开火段与换弹段按现有武器 phase 播放 |
| E-01 游荡者 | 单击前摇 + 收势 | 代替以前所有 NPC 共用的双手攻击 |
| E-02 扑跃者 | 扑咬前摇 + 收势 | In Place 动作；位移与落地伤害继续由扑跃模拟负责 |
| E-03 呕吐者 | 咆哮前摇 + 收势 | 替代喷吐动作，酸液 flight/pool 仍消费真实攻击轨迹 |
| E-05 爆尸 | 抽搐前摇 | 替代引爆预警；爆炸时刻与范围由游戏规则负责 |
| B-01 屠夫 | hook 前摇/收势、slam/砸地收势 | 常规攻击和 Boss 预警阶段分别映射，不能用循环随机相位播放一次性砸击 |
| NPC 通用 | hit/hit_b、前倒 death | 精确 hit_b 优先，缺片才回退 hit；击杀当 tick 立即移出模拟，显示尾部不延迟死亡 |
| E-04 冲锋候选 | 未接为冲锋 | `Pointing Onward` 是指向手势，保留原有攻击表现，继续需要合适动作 |
| 备用瞄准 | 保留候选 | 步枪戒备姿态没有替换默认手枪待机 |

共享库 `player` profile 被实际三层场景的作者玩家引用；E-01/E-02/E-03/E-05/B-01 的
`*_animation_ready.glb.meta.json` 仅调整 `sharedMotion.profile`，未改绑骨配方、权重或源模型。
通用 `npc` profile 补上受击变体和死亡，其他角色继承该默认值。

接缝处理使用 XYZ 旋转的四元数最短路径混合，末帧与首帧等价；保留 Y 起伏并固定 XZ 根位移。
运行时继续按 nominalSpeed 与实际位移驱动步频。接缝位置连续不等于速度导数连续或无滑步。
同一模拟 tick 的重复渲染保留步态方向和片段时间；新 tick 停步、Stop 或新开局清空方向。
没有恢复原始 FBX 入 Git，也没有将 FBX 作为公开资源包分发。

## t1 档裁剪缺陷与失败行为

有界面验收发现 `t1.maxClips=2` 把 NPC profile 裁成 idle/walk，攻击、死亡和受击从 GPU
调色板消失。现在显式共享 profile 保留完整状态，旧 GLB 的可选片段仍按档位裁剪。
低档仍使用 16 fps，模型按实际刷怪类型加载、贴图按原有上限解码；调色板按角色类型共享，
不按每只 NPC 复制。增加动作会增加类型级 CPU/显存成本，不认证实体手机容量或帧率。

无效裁剪区间、非法通道、非有限帧、源哈希过期、重复派生 ID 或不存在的 profile clip
都会在发布派生文件前失败；不能用 `scene:gen` 刷新坏哈希来绕过。生成后执行 motion/scene 门禁。
动作库或 rig 引用出错时继续使用原有显式装载诊断，不静默切换到旧内嵌动作。

## 重现与验证入口

```powershell
node tools/motion/derive-clips.mjs assets/animations/gameplay/ani-20261008.recipe.json
node --test tools/motion/derive-clips.test.mjs
pnpm run motion:check
pnpm run scene:check
pnpm exec vitest run packages/runtime/test/motion-direction.test.ts packages/zombie-game/test/npc-motion.test.ts packages/zombie-game/test/campaign-combat.test.ts apps/editor/test/animation-debug-selection.test.ts apps/editor/test/runtime-scene-motion.test.ts apps/editor/test/runtime-bridge.test.ts apps/editor/test/runtime-actors.test.ts packages/zombie-game/test/session.test.ts packages/zombie-game/test/play-session.test.ts
pnpm run typecheck
pnpm run architecture:check
pnpm run editor:build
pnpm run knowledge:check
```

生成工具更新派生动作与动作库；角色使用哪个 profile 是独立内容绑定，不由通用生成工具猜测。
门禁分别属于工具、Framework、游戏和编辑器。`motion:check` 同时装配桌面与 t1 的 9 种角色，
核对全部声明状态保留、逐帧矩阵有限、rest pose 未变及异构 palette 偏移。
本次相关 9 个 Vitest 文件共 126 项测试通过，工具 Node 测试 3 项通过；
typecheck、architecture:check、editor:build、knowledge:check、motion:check、scene:check 均通过。

## 2026-10-10 实际 headed 验收

使用独立验收标签页与当前检出目录 5100 服务，经编辑器 MCP 完成场景打开、validate、Play、
Stop；候选场景的 RoomVolume 改为 interact 并实际 save/reopen，避免无 NPC 时立即通关冻结。
GPUDevice.adapterInfo 为 `nvidia / lovelace`，secure context，实际 WebGPU 画布与贴图可见。

- 第一层 24、第二层 48、第三层 16 个初始 NPC 都能装配；通过实际波次调度检查 E-03，
  通过第三层已编排房间检查 B-01/E-05。相机跟随后再核对 LOD，胶囊截图不能当作骨架动作通过。
- 定向运行时探针确认玩家 walk_f/b/l/r；开火扣弹 18→17，`shoot` 与火器 phase 一致；
  reload phase=0.3125 时播放源段 1.03125 秒。探针使用真实 Play/渲染但调用运行时输入端口，
  不是实体键鼠操作验收。当前浏览器连接不支持原始 CDP Input，画布 locator 也无法按键；
  没有把失败的 UI 点击当作开火成功。
- 收尾复核在普通 100 HP 下验证四向步态；同一 tick 再次同步时状态、revision 与片段时间
  均不变；停止输入并推进一 tick 后回到 idle。验收后 Stop，ledger 再次 4/4、pending=0。
- GPU 观察到 hit_b 精确选片；前倒 death phase≈0.768；模拟 NPC 数为 23 时显示含一个尸体的
  24 个实例，3.3 秒之后回到 23 个、该尸体 debugSnapshot=null。
- E-03 前摇 phase≈0.501，随后 recover 与真实 acid/flight 同时存在；E-05 引爆前摇
  phase≈0.422；B-01 slam phase≈0.389，随后 slam_recover 与实际 slam/strike 效果一致。
- 三层 Stop 的 Play ledger 分别为 4/4、8/8、12/12 registered/disposed，均 pending=0；
  最后直接核对 bridge.batches()=null、motions.nodes=0，作者场景 revision 不变、dirty=false。
  MCP 的 instances/meshIds 为渲染统计快照，Stop 后不能用该瞬时旧值推断仍有活动批次。
- 本次标签页捕获的 error 日志为空。音频本次没有人工审听，不能把 audio ledger 关闭当作听感验收。

[运行时观察记录](evidence/ani-20261010/runtime-probes.json)及
[四向步态](evidence/ani-20261010/floor1-direction.png)、
[死亡显示](evidence/ani-20261010/floor1-death.png)、
[酸液攻击](evidence/ani-20261010/floor2-acid.png)、
[Boss 砸击](evidence/ani-20261010/floor3-boss.png)保存本次版本证据。
截图里的高生命值、快速波次清空和房间定位是临时运行时测试条件，未保存进场景或发布给玩家。
采集后将 Boss 动作观察器的来源标签由 `combat-event` 校正为 `game-cue`；动作与计时没有改变。

CodeGraph MCP 0.167.0 用于当前目录的 project_map/module_overview，再核对真实 import 与调用者；
增量索引报告 52 个文件、243 个节点更新，1500 个 embedding 完成，但出现其他进程持锁警告及
main.ts/game-audio.ts 的解析警告。图谱不认证独占快照，同名方法推断边不证明真实依赖；
依赖以源码和 architecture 门禁为准。

## 仍需资源与美术精修

E-04 需要真正的低头架肩冲锋；手枪换弹仍是步枪替代，需要弹匣出入与双手持握修正；
E-02/E-03/E-05/B-01 的替代动作还需更贴设计稿的专用版本。当前不含 fingers 轨道，
足接触/world-lock 仍有 partial 诊断，不能用矩阵有限或接缝连续认证脚锁、无穿地或最终持握精度。
用户已有 HumanIK/武器 hook 保留，精修应在对应 owner 上继续，不重写另一会话的绑骨资产。
