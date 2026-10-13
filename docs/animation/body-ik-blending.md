# HumanIK 分部位程序化动画混合

动画模块先采样已有片段，再对选定骨链应用编辑配置的 HumanIK。导入 FBX 后烘焙的目标
`AnimClip` 与共享运行时 Retarget 片段共用采样器，状态切换先经过[姿态过渡](pose-transitions.md)，
再执行 IK。权重 0 保留采样动作，1 应用完整 IK；有效权重为 `binding.weight * control.weight`，
局部旋转使用最短弧四元数插值。位移、缩放、hips 及无关轨道保留，每帧从采样姿态开始，
避免修正累积。

## 职责与持久化

- `packages/scene/src/body-ik.ts`：持久化配置与验证。
- `packages/render/src/body-ik.ts`：骨骼映射及采样后姿态计算。
- `packages/render/src/two-bone-ik.ts`：实时 IK/已有 Retarget 共用解析解算器；编辑器旧入口重新导出。
- `apps/editor/src/services/runtime-body-ik.ts`：Play 生命周期及实时目标。
- `PlayerPresentation`：玩家变换与下半身移动朝向。
- `RuntimeSceneMotion`：步态片段选择和固定模拟时钟。

`MeshRenderer.bodyIk` 覆盖资产 `.meta.json` 的 bodyIk 默认值：undefined 继承，null 禁用。
资产默认可用角色局部坐标、pointer 或最近敌人目标；稳定场景 NodeId 目标属于场景覆盖。
不存采样姿态、代码或 GPU 资源。当前集成 schema 为 v18；v15 为历史集成版本。HumanIK 原分支在 v13 引入字段，
但合并后的 v12→v13 是武器库迁移；v14→v15 保留两种 v14 历史中的 IK、过渡、武器和音频，
缺失控制仍不添加。准备数据以[迁移源码](../../packages/scene/src/migrate.ts)及
[集成证据](../review/branch-integration-2026-10-09.md)为准，不沿用原分支版本含义。

## 控制部位与目标空间

| 部位 | HumanIK 骨链 | 解算 |
|---|---|---|
| `upperBody` | Spine / Spine1 / Spine2 | 分布式瞄准旋转 |
| `head` | Neck / Head | 分布式瞄准旋转 |
| `leftHand`、`rightHand` | Arm / ForeArm / Hand | 两骨骼到达 |
| `leftFoot`、`rightFoot` | UpLeg / Leg / Foot | 两骨骼到达 |

支持标准 HumanIK 名及 `mixamorig:`/`mixamorig` 前缀。缺失/歧义名字、不兼容骨链和不支持
缩放产生诊断。上半身先于头/四肢解算，不受插入顺序影响；不移动 root，不拉伸肢体。

- `position`：包含 GLB 导入归一化的角色局部米制坐标。
- `mouse`：可见玩法鼠标/摇杆目标，位于配置的世界高度。
- `node`：节点世界位置加配置的世界空间米制偏移；渲染节点取实时位置，空挂点使用本次
  Play 捕获的场景层级，包含父变换。
- `enemy`：最近、存活且健康值为正的运行时 NPC，使用配置高度。无目标时保留原动画，
  诊断说明跳过原因。

手脚 `pole` 是角色局部弯曲方向；瞄准 `forward` 是骨局部轴（默认 +Z），`maxAngleDeg`
限制相对采样动作的修正。Position 经逆骨架归一化；宿主世界目标先逆角色位移/旋转/缩放。

2026-10-14 的持枪候选使用左手 `[1,-.35,0]`、右手 `[-1,-.35,0]` 的镜像侧向、略向下 pole。
新建手控制默认及 H01 当前 animation-ready sidecar、武器试验与三张楼层的作者覆盖同步；腿与其他角色不改。
现有生成器对新玩家继承该 sidecar，对已有作者配置继续保留，避免重生成覆盖用户 pole。
求解器已经将 actor-local 方向逆规整化并正交投影到肩→手轴垂面，本轮没有新增 IK 机制、骨长或权重端口。
外展观测采用实际 ForeArm 肘位置相对肩→手轴的正交 bend 对作者 pole 的投影；
近伸直链允许 bend 很小，不要求肘 X 跨越肩 X。正投影只证明弯曲方向，不能认证皮肤/身体无穿插。

`locomotionWhileAiming` 在有有效加权 torso/head 目标时保留 idle/walk/run，开火也如此。
玩家 mesh 面向移动，玩法朝向仍决定瞄准/射击。禁用 IK 或权重 0 恢复全身 shoot 选择。
[动作适配器](../../apps/editor/src/services/runtime-scene-motion.ts)消费实际接受的武器动作；
开火并启用瞄准 IK 时保留步态片段/时钟，不用射击阶段覆盖步态。换弹/换装仍选择可用的
配置片段及动作阶段。旧武器 markers 不会自动转换成精确握点；v17 的显式 assembly 与骨 socket 由表现层转换成中性依赖 IK 请求，见[模型握点契约](model-attachments.md)。

## 编辑器流程

1. 选中带骨架的场景节点，打开**场景/光照**及节点编辑表单。
2. 在 **HumanIK · 分部位程序化混合**选择**设置分部位 IK**，添加部位，配置权重、目标、
   弯曲方向和瞄准限制。
3. **应用节点修改**，再通过 File 菜单保存；草稿未应用不改场景，undo/redo 和保存冲突
   检查仍生效。
4. Play 中 **HumanIK 混合**提供临时总/分部位权重；pointer/敌人目标每帧更新。暂停可在
   固定采样时间比较。
5. Stop 恢复原 SkinState 引用及播放值，迟到异步结果不得重新挂 IK。共享动作加载可能
   替换采样器，适配器给新采样器挂同一临时控制，并在 Stop 清理。

Play 或 Pause 的底部工具栏可点击 **观察视角**：左拖环绕，右/中键或 Shift 拖平移，滚轮缩放。
若 HUD 的“游戏视图”隐藏了编辑器工具栏，先用既有 **编辑器视图** 入口返回，再点观察按钮。
观察期间键盘 1–7 仍通过原装备命令切枪；移动、射击、瞄准、换弹输入不由导航触发。
按钮 **回游戏相机** 或 Esc 退出观察，恢复最新游戏机位；下一次 Esc 仍按原流程退出 Play。
Stop 精确恢复作者机位。观察时钟与 Play/Pause 原语义一致，没有新的动画或模拟时钟。

`apps/editor/src/services/play-observation-navigation.ts` 负责临时观察 UI、捕获阶段输入及释放，
并与编辑态共享 orbit/pan/zoom 数学；`play-camera.ts` 独立保留当前游戏相机和 Play 前的作者相机。
游戏跟随机位在观察时继续计算，不覆盖观察视口；失焦、取消指针或切换模式释放输入。
这与 HUD 的“游戏视图”显示开关及编辑态 WASD 自由飞行相机是不同入口，场景 Camera/editorCamera 均不写回。

已登记 `assets/scenes/sandbox/body-ik-validation.scene.json` 展示 4 个角色，包含 Run+
torso/hand 和 Walk+head/foot。远处 NPC 和较慢配置决策留出观察权重的时间。

## 能力边界

这是编辑配置的骨架场景对象（含玩家）的采样后控制层。群体 NPC 仍用烘焙姿态调色板/
instancing，未实现逐 NPC IK，本改动不新增 GPU 分配。不实现自动武器持握、地形查询、
脚部贴地、全身 root 修正或通用多片段动画图。角色/骨架缩放须正且均匀；瞄准/到达限制
是诊断，不是解剖学关节限制。部分权重不保证精确末端接触；最近敌人瞄准是表现，玩法
目标仍权威。

<a id="validation"></a>

## 验证

定向测试覆盖全/零/部分权重、总×部位等价、下半身保留、重复计算确定性、厘米单位、
Mixamo 名字、不可达肢体、缺目标/骨骼、角度限制、场景/资产验证、迁移、异步加载/Stop、
采样器替换、移动朝向/瞄准分离、开火步态和重启。

本轮有界 CPU 工具 `node tools/verify/weapon-elbow-poses.mjs` 加载实际 H01、共享 idle/ready、Spine layer
及当前 equip 的 ready 回退，覆盖七把×四阶段×yaw 0/135 共 56 个 FK 样本，检查双手握点及肘 bend 方向。
导航 owner 测试为 `apps/editor/test/play-observation-navigation.test.ts`、`play-camera.test.ts`、`play-controller.test.ts`。
有界 GPU 命令为 `node tools/verify/weapon-assembly.mjs --expected-head <完整提交> --hold-switch-only --elbow-observation --collapse-ik-panel --aim-yaw 135`。
它通过可见观察按钮和真实鼠标 orbit/pan/wheel 取得七件前/侧原生截图、Play/Pause 导航、游戏相机返回和 Stop 作者相机恢复证据；
仍不执行开火/换弹。2026-10-14 的实际结果见下节。

### R6 实机观察与导航证据（2026-10-14）

验收目标为 `0222268fb7c1428ada7ed200506e16622e495c17`，当前 Windows worktree 的正常 HTTPS/TLS、
headed Chrome、安全上下文与 NVIDIA Lovelace。工具报告 `passed:true`，25 项检查全部通过；
共 312 条快照，其中 299 条本帧有效模型样本同时纳入双手握点与肘 bend 门禁，二者 `failures:[]`。
前述 56 个 CPU FK 姿态样本是独立证据，不与 299 个实机帧混计。

真实 Digit1–7 切枪、七件正常持枪及一次 W 移动通过。可见观察按钮与真实鼠标 orbit/pan/wheel
改变观察机位，未触发玩家移动或射击；Pause 中仍能拖动观察，模拟及动作时钟保持冻结。
回游戏相机恢复当前游戏机位；Stop 精确恢复作者相机和作者文档，资源账目归零，重启后再次 Stop 无残留。
原记录中 R 键输入为 0，firing 为真或 lastShot 非空的快照为 0，输入清理与异常列表为空。

每件均取得原生前/侧 PNG。下表为数值快照帧 / PNG 捕获期间帧区间，截图并非冻结在单一数值帧：

| 武器 | 前视快照 / PNG 帧区间 | 侧视快照 / PNG 帧区间 |
|---|---|---|
| pistol | 385 / 385–401 | 424 / 424–440 |
| shotgun | 555 / 555–569 | 592 / 592–607 |
| smg | 721 / 721–734 | 758 / 758–774 |
| sniper | 887 / 887–901 | 923 / 924–942 |
| chainsaw | 1056 / 1056–1070 | 1094 / 1094–1110 |
| flame | 1224 / 1224–1239 | 1263 / 1263–1281 |
| launcher | 1399 / 1399–1415 | 1438 / 1438–1455 |

Audit 人工查看七件前/侧图未见明显上臂挤入胸廓，Flame 两侧肘外展可见。
Launcher 枪体遮挡更多，不能据此批准所有表面的解剖像素质量。
本次只认证上述正常持枪/切枪、少量既有瞄准与观察导航路径，不认证全部 aim、攻击/换弹、
所有姿态穿插、身体碰撞或全部输入失败路径的实机行为；独立终审另行进行。

原始报告为本地忽略路径 `.workbuddy/tmp/weapon-hip-slot/r6-headed-audit/observations.json`，
同目录 `seven-<weapon>-observation-front.png` / `seven-<weapon>-observation-side.png` 对应上表。
这些文件不随 Git 分发，文档保留版本、计数、帧区间与限制供本机复查。
本轮自有 Chrome 82104 已退出、CDP 9348 无监听；原 5198 服务 PID53452 保留，这些是验收时的进程快照。

有界面 Chrome 还需确认目标检出/场景、真实 GPU/安全上下文、可见 Apply/保存/重载/
权重控制、正确角色的源片段变化及 Stop 精确恢复。构建或矩阵测试不能代替视觉验收。

以下为 2026-10-07、v15 集成前的历史验收，使用 Windows、有界面 Chrome、安全上下文
及 NVIDIA Lovelace：

- 同一 Run 采样时刻可见总权重 0/1 比较：hips/双腿关节矩阵差为 0，上半身改变，矩阵元素
  最大差 1.00372；证明隔离，不证明解剖品质。
- 真实键鼠生成角色局部瞄准目标，移动朝向与玩法瞄准分离；Space 暂停保留目标。
- 可见编辑表单将 torso 权重改为 0.75，Apply、File 保存和重载保留；保存报告 1 个字段变化。
- 可见 Stop 后文档不变，原片段/时间/播放值精确恢复，无挂接 IK 或待加载残留。
- 23 个文件、358 项定向测试，类型检查、编辑器构建及 `scene:check` 通过（206 个资产、
  13 个场景、38 对环境 LOD）。

当时使用另一个 worktree 的 QA 5197 服务，日志/PID 在本地 `.workbuddy/tmp/body-ik/`。
这是历史服务来源，不是当前目录启动/停止服务的命令。进程操作先核归属；正常端口仍为
5100/5101。后续 v15 集成及重构另见[集成报告](../review/branch-integration-2026-10-09.md)
和[架构报告](../architecture/acceptance-2026-10-09.md)，不等于重跑全部原解剖比较、手机
或群体压力检查。
