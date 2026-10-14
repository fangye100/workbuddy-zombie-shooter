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

## 2026-10-14 左右横移步幅与节奏定向修正

源码基线为 `38ca87e4667f6c9b71560762ecdbb2518fc0119c`，内容实现提交为
`bcd380575117aa4ef863f75b71e2e67cc31259c6`。真实 headed 验证目标为
`02d5ead4f728f9b70ec4fab115d088b525071c9d`；后两笔提交只修验证工具，内容相同。
[紧凑原始数据摘要](evidence/strafe-20261014/runtime-summary.json)记录源报告哈希、采样口径、
前后 CPU 数据及实机检查；完整原始报告和失败尝试保留在本检出的 `.workbuddy/tmp/strafe-motion/`。

只修 `game_walk_l/r`：源动作本身已有宽幅侧跨，18/19 帧就是完整循环，未截成半步。
同相位源最大横向踝距为 1.132/1.146 米，H-01 重定向后为 0.935/0.947 米。
按骨盆高归一没有放大；按腿链长归一约增加 6.3%，是目标身体比例的次要影响。
因此不能把主因归为单位错误或重定向统一放大。

[内容配方](../../assets/animations/gameplay/ani-20261008.recipe.json)将两个 UpLeg 的
`Zrotation` 外展幅度设为 0.70，膝、足部和其余旋转通道保留。
[离线调节工具](../../tools/motion/clip-conditioning.mjs)复用真实 BVH 解析/FK，按原始每帧最低
踝高补偿 rootY（上限 0.1 米），并在最终派生/接缝输出上重测低位足速中位数作为 nominal。
每帧实际补偿范围为左 +0.002～+0.058 米、右 −0.008～+0.082 米。
元数据保留源、配方哈希及测量依据。非法骨名、通道、幅度、单位、补偿超限或无足速样本明确失败。
定向发布保留其它派生文件与 profile，不调整游戏速度、武器时钟、前后移动、绑骨、上身 IK、
pole、持握 slot 或场景相机。

CPU 使用实际 H-01、1.8 米导入标尺、scene scale=1、相同采样相位及当前
`SharedMotionRuntime` → 烘焙 → `evalJointMatrices`。下表周期是在实际速度 1 米/秒时按现有
`actualSpeed/(nominal*object.scale)` 算出的理论值，不是浏览器前后测速。

| 指标 | 左横移：前→后 | 右横移：前→后 |
|---|---|---|
| H-01 最大横向踝距 | 0.935→0.815 米 | 0.947→0.814 米 |
| H-01 nominal | 2.284→1.885 米/秒 | 2.438→2.074 米/秒 |
| 1 米/秒时循环周期 | 1.294→1.068 秒 | 1.463→1.244 秒 |

膝/足旋转、骨长、完整周期与最低踝高检查通过；未配置调节的旧输出保持字节相同。
前后移动的同项 CPU 数据一致，共享库除左右两个 nominal 外逐字段一致。内容实现时工具及既有
验证 harness 32 项、相关 Vitest 18 项、motion/scene/typecheck/editor build/architecture/knowledge
检查通过；最终验证工具的 6 项聚焦测试覆盖完整浏览器快照读口、真实 A/D、回退/残差和遮挡拒绝。

真实验证使用正常 TLS 的 MagicDNS:5198、固定保留 profile、原始 CDP 键鼠事件和 NVIDIA
Lovelace，未写运行时姿态/相机状态或隐藏 HUD。A/D 在正常游戏视图持续横移后，仍按键时点击
Pause，再释放按键，通过现有观察 UI 做自然 orbit/wheel/pan，冻结原步态拍全身。
投影检查覆盖头部、双膝、双足、画布边界及实际 HUD 矩形；观察截图不冒充运行时移动证据。

| 实机输入 | 有效移动样本 / 相位回绕 | 测得移动速度 | 最大横向踝距 | 最大双手目标残差：右 / 左 |
|---|---|---|---|---|
| A / walk_l | 51 / 7 | 4.500001 米/秒 | 0.807 米 | 2.78e-7 / 3.05e-7 米 |
| D / walk_r | 46 / 6 | 4.500001 米/秒 | 0.812 米 | 2.24e-7 / 3.06e-7 米 |

20 项实机检查通过：本帧模型及 attachment frame stamp、实际双手/装配目标和残差一致；
Pause 的模拟 tick 和片段 time 保持；W/S 基本回归、释放输入回 idle；Stop ledger/pending/
draw/动作节点归零，作者文档和相机回滚。异常与 console error 均为零。
[左横移冻结全身](evidence/strafe-20261014/a-paused-observation.png)与
[右横移冻结全身](evidence/strafe-20261014/d-paused-observation.png)为未编辑的原生 PNG，
采用 Git LFS 保存。

首次探针错误地调用未公开的 `motions.debugSnapshot`，在 Play 前失败；改读公开
`motions.summary()` 后，第二次发现观察近景仍被 HUD 遮住脚部，且断言未识别既有手枪回退。
最终工具以实际相机/投影驱动一次自然观察路径，并按本帧双手残差验证持握。
`pistol-idle` 专用片段当前仍缺失，`playerMotionChoice` 保留 base、选 `ready` 上身层并使用
已配置的装配 IK；`WEAPON_CLIP_MISSING` 诊断原样保留，其他诊断不会被忽略。

框架已有源足标定/标记、接触段、锚点、腿 IK 与 root 平滑能力；当前左右源和 H-01 sidecar
均未提供 `retarget.calibration`（运行期为 null），in-place 来源仍报告未标定接触、无 world-lock 和 partial。
本次离线保持的是原最低**踝关节**高度，**不是接地 IK、足底标定或地形锁脚**；没有承诺解决脚滑。

定向复现（实机前按浏览器入口加载当前主机规则；使用待验证完整 HEAD）：

```powershell
node tools/motion/derive-clips.mjs assets/animations/gameplay/ani-20261008.recipe.json --clips game_walk_l,game_walk_r
node --test tools/motion/derive-clips.test.mjs tools/verify/strafe-motion.test.mjs
$taskTargetHead = git rev-parse HEAD
node tools/verify/strafe-motion.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head $taskTargetHead --cdp 9348 --hold-ms 1800 --out .workbuddy/tmp/strafe-motion/recheck-current
```

## 2026-10-14 R8：普通桌面横移与自由观察入口

R7 的实机探针始终使用有效 pointer aim，未覆盖“进入 Play 后鼠标未移动，直接按 A/D”。
该路径原来传入 null aim，游戏模拟按移动方向更新 yaw，因此角色转身后使用前向片段。
本轮实现为 `e083904cca1ebf7cbf0f554cd5742ce4b2785dd0`，仅调整游戏输入表现、Editor
视角入口和试验场景 Camera；动画内容、绑骨、IK、移动速度和武器计时均未改变。

- [试验场景](../../assets/scenes/sandbox/weapon-assembly-trial.scene.json)沿用 `orbit-follow`、
  world yaw 和原 entryCamera，以 pitch=55°、distance=8 米提供 GodView 俯视跟随。
- [GameControls](../../packages/zombie-game/src/presentation/game-controls.ts)的桌面初始面向取
  相机前方，移动不会覆盖请求方向；有效鼠标瞄准更新此方向。Pause、观察、blur 清输入但保留方向，
  新 runtime/Stop 后的新 Play 才重置。无 pointer fallback 使用既有 `setAim` 显式点，射击沿稳定
  面向，因而不进入最近敌人的自动瞄准支路；触屏无 aim 仍传 null，保留原移动朝向/辅助瞄准规则。
- [视角入口适配器](../../apps/editor/src/services/view-navigation-control.ts)让同一自由按钮和 V
  在 Edit 使用原自由飞行，在 Play/Pause 使用既有观察导航；两个按钮同步标签、title、active 与
  aria-pressed。观察期间捕获 V 退出，repeat 不反复切换；Esc 返回游戏相机，观察输入不移动玩家，
  Stop 仍恢复作者相机。未新增相机模式或直接修改运行时相机的测试 hook。

真实验收目标为 `14138be2fffcf5470640eab67373c5c587f97216`，后两笔工具修正与实现的生产内容相同。
[紧凑记录](evidence/controls-20261014/runtime-summary.json)保存原始报告 SHA-256、版本、范围、
命令、采样口径和检查结果；完整原始报告与 stdout 保留在本检出的 `.workbuddy/tmp/r8-evidence/`。
本轮为正常 TLS、headed Chrome、NVIDIA Lovelace，211 个样本、350 个真实键鼠/只读观察记录，
30/30 检查通过，异常、console error 和清理错误为零。

| 实际路径 | 有效样本 / 周期回绕 | 移动速度 | 面向/位移检查 |
|---|---|---|---|
| 初始无 pointer A / walk_l | 21 / 4 | 4.500000 米/秒 | yaw 与实际 actor 最大偏差 0.007500 rad；位移前向比例 0.007500 |
| 初始无 pointer D / walk_r | 21 / 3 | 4.500000 米/秒 | 同项最大偏差与比例均约 0.007500 |
| pointer 改向→Pause/观察→返回→无 pointer A / walk_r | 14 / 2 | 4.500000 米/秒 | 保留反向 heading；最大偏差 0.007504 rad |
| 重启后有效 pointer A / D | 47 / 7；41 / 6 | 4.500001 米/秒 | 最大双手目标残差均小于 3.10e-7 米；本帧装配/frame stamp 一致 |

实际自由按钮在 Pause 进入观察，native orbit/pan/wheel 将 yaw 从 −π/2 改为 −1.780796 rad、
pitch 从 55°改为 50°、距离从 8 改为 9.019975 米，并改变 target；tick/clip time 保持。
V 返回后朝向不跳回默认方向；Play 中 V 进入观察时 A 不移动玩家，Esc 退出；Edit V 开关保持原行为。
随后通过真实 Stop→Play 重启隔离回归，出生点恢复为 (0, 2.5) 米；A/D、W/S、停步 idle 与最终 Stop
均完成，两次 Stop 的 ledger/model pending/draw/动作节点归零且作者文档/相机恢复。
[无 pointer A 的原始 GodView](evidence/controls-20261014/no-pointer-a-game.png)和
[自由按钮进入后的原始观察截图](evidence/controls-20261014/actual-free-paused-navigation.png)保持原生像素，以 LFS 保存。

工具默认仍执行 R7 严格侧前肖像机位验收；本轮显式 `--controls-only true` 使用作者 GodView
全身截图，保留头、双膝、双足、画布边界和 HUD 遮挡检查，并将额外 R7 侧前 45°肖像机位列为一项
**notApplicable**，没有把它改写为通过。首次完整探针累计横移撞到房间边界；真实重启修正后，
旧肖像左拖未改变相机而未通过朝向条件，其失败报告同样保留。当前用户观察入口的短 orbit/pan/wheel
实际变化检查仍是必过项。本轮没有承诺足底接触/world-lock 或脚滑解决，既有 `pistol-idle` 缺失回退诊断仍保留。

原始 `check-commands.json` 和对应 `.log` 记录 owner 50 项、工具 29 项及 scene/typecheck/editor
build/architecture/knowledge 通过；之后两次仅工具修正各有 8 项聚焦测试通过。额外表现回归为
31/32：`apps/editor/test/player-presentation.test.ts:75` 的 v7 迁移列表缺少既有 v17/v18 项。
该测试、`packages/scene/src/migrate.ts`、`document.ts` 的 Git blob 与基线
`4bf33743314a57867a73322efdd3b6b7521b1a2d` 完全一致；此项是保留的既有测试缺口，未修复、未宣称通过。
本次文档收尾只运行 knowledge/diff 检查，不重复生产门禁。

复现 R8 专项（按浏览器入口加载主机规则，输出使用独立目录）：

```powershell
$taskTargetHead = git rev-parse HEAD
node tools/verify/strafe-motion.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head $taskTargetHead --controls-only true --cdp 9348 --hold-ms 1800 --out .workbuddy/tmp/r8-evidence/recheck-current
```

## 2026-10-14 R9：武器靠角色右侧、上方与前方持握

基线为 `a9467fb864d8923e60ddca6ec375a8a75409064f`，内容及实机目标为
`0833275cf1f544debb2dc01a9a12219974d48926`。
[紧凑证据](evidence/weapon-hold-20261014/runtime-summary.json)记录实际 source/tool/raw 报告哈希、
CPU 基线对照、七件实机帧数及保留诊断；完整报告和 stdout 在本检出的 `.workbuddy/tmp/r9-evidence/`。

H-01 的实际 rest 与运行时肩/手坐标确认角色右为 actor-local **−X**，+Y 向上、+Z 向前。
原 shotgun/smg/sniper/chainsaw/flame 的 Hip slot 为 +X，右手目标跨向胸口左侧；pistol/launcher
已经在 −X。本轮沿用 `setWeaponHoldSlotAxis`，原子更新 slot 与模拟/legacy markers；marker 平移
按现有 `[deltaZ, deltaY, -deltaX]` 转换，保留 trial 相对 prototype 的 muzzle Y 特异值 −0.02 米。

| 内容组 | Hip slot 改动，角色局部米 |
|---|---|
| shotgun、smg、sniper、chainsaw、flame | X 设为 −0.05；原 Y +0.10、原 Z +0.005 |
| pistol、launcher | X 保留；原 Y +0.03、原 Z +0.01 |

只更新 [prototype](../../assets/weapons/prototype.weapons.json)、trial 与 floor-1/2/3 的 arsenal。
四个游戏场景的 H-01 `Mesh.bodyIk.upperBody.target` 复用已有 position `[0,0.95,0.45]`，
让现有 Spine/Spine1/Spine2 提供有限前倾空间；weight=0.55、limit=60°保持。
资产 meta 默认值、头部 target/weight/limit、手部 poles、rig、骨长、模型 socket、武器 rotation、
动画、武器动作与场景相机不变。单独大幅右移会超出左手链，因此没有用骨长 clamp 代替正确持握。

[CPU 工具](../../tools/verify/weapon-elbow-poses.mjs)以当前源码内存 bundle、实际 H-01/idle/ready/walk_f
计算 56 个关键姿态：七件 × idle、equip phase=0、unequip phase=1、walk_f 0.35 秒 × yaw 0/135°。
两种切枪端点含完整 0.08 米下沉；上身和头部均提供有效实际 target，动作层按对应 phase 采样。
另有 56 个匹配基线帧作对照，Hips 位置差为零。当前 56 帧均无 hand unreachable/socket residual
诊断，外向肘检查通过；实际 contact 残差最大 1.76e−7 米、1.27e−7 rad，最小左链余量为
chainsaw 3.93 mm。七件握点/模型 muzzle 均在胸参考右侧，muzzle 最小右偏 2.74 cm。
Spine→Spine2 轴前倾为静止 10.46°、该步行样本 15.60°；这些是有界姿态数据，不是所有姿态碰撞保证。
历史肩球 fixture 保留，固定旧肩位置不能认证新上身配置的可达性，当前可达检查由真实 FK 接替。

正常 TLS、headed Chrome、NVIDIA Lovelace 实机报告为 286 个样本、233 个真实输入/观察记录，
25/25 检查通过。275 个本帧有效模型样本覆盖七件真实 Digit1–7 切枪、正常持枪及一次 W 移动，
最大右/左目标残差分别为 3.43e−7 / 3.08e−7 米，双手肘 bend 朝作者外侧 pole。
原生观察 orbit/pan/wheel、Pause 时钟冻结、返回游戏相机、Stop 作者回滚与资源释放、重启后再次
Stop 均完成，异常、console error 和输入清理错误为空。本轮没有开火、换弹或换罐验证。

显式 `--observation-closeup` 通过原生输入取 20°/4.8 米观察机位；前视之后向角色 −X 侧
环绕约 34.4°，第二张是角色右前侧。七件右前侧原图保留在本地报告目录；Main 目检七张，
Worker 另核对以下两张代表图，右肘、完整前臂与胸口可辨，未见这些正常持枪姿态明显穿胸或过度弯腰。
[Shotgun 右前侧](evidence/weapon-hold-20261014/seven-shotgun-observation-side.png)与
[Flame 右前侧](evidence/weapon-hold-20261014/seven-flame-observation-side.png)是未编辑原生 PNG，以 LFS 保存。
这不是精确 mesh 碰撞或右眼射线认证，也不扩成全部 aim/动作/姿态验收。

头部 `IK_AIM_LIMIT` 的 38 条采样诊断保留；观察期间 pointer 不可用时头部 `IK_TARGET` 为
243 条，保留动画。既有 `WEAPON_CLIP_MISSING` 的 idle/equip/unequip 回退及 motion reports 的
partial、派生标记、未标定接触、无 world-lock 能力缺口仍在，均未声称消除。
首次命令因 scene URL 少了 `scenes/` 被参数门禁在启动浏览器前拒绝；原 stderr 被重试覆盖，
`probe.initial-args-guard.*` 是明确标注的 transcript-recovered 副本，**不是原始 stderr 文件**。

owner 28 项、工具 25 项及完整 `scene:check` 通过，原始命令/exit code 路径见紧凑记录。
本次仅文档与两张截图收尾，运行 knowledge/diff 检查，不重复生产门禁。复现需按浏览器入口
加载主机规则，使用独立输出目录：

```powershell
node tools/verify/weapon-elbow-poses.mjs --baseline-head a9467fb864d8923e60ddca6ec375a8a75409064f
$taskTargetHead = git rev-parse HEAD
node tools/verify/weapon-assembly.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head $taskTargetHead --url "https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-assembly-trial.scene.json" --cdp 9348 --hold-switch-only --all-weapons --elbow-observation --observation-closeup --collapse-ik-panel --aim-yaw 135 --out .workbuddy/tmp/r9-evidence/recheck-current
```
