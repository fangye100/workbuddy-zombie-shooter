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
不存采样姿态、代码或 GPU 资源。当前集成 schema 为 v15。HumanIK 原分支在 v13 引入字段，
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

`locomotionWhileAiming` 在有有效加权 torso/head 目标时保留 idle/walk/run，开火也如此。
玩家 mesh 面向移动，玩法朝向仍决定瞄准/射击。禁用 IK 或权重 0 恢复全身 shoot 选择。
[动作适配器](../../apps/editor/src/services/runtime-scene-motion.ts)消费实际接受的武器动作；
开火并启用瞄准 IK 时保留步态片段/时钟，不用射击阶段覆盖步态。换弹/换装仍选择可用的
配置片段及动作阶段。武器标记不会自动转换成手部目标。

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
