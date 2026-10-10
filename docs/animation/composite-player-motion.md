# 玩家持续步态与身体区域动作组合

## 设计范围与证据

基线 `484b129d61262bc4eda50332d5b3567f19f5e9b5`，当前 worktree 的 CodeGraph MCP 0.167.0 查询记录在本机忽略目录 `.workbuddy/tmp/animation-layer-dev/codegraph-design.json`。查询覆盖 project_map、8 个 module_overview、3 个 call graph；未报告预算遗漏，33 个文件 freshness 未逐个核验，同名 set/find/forEach 边可能歧义。下述责任以实际 import 和源码核对为准，图谱不能认证运行或视觉行为。

## 责任与数据流

`packages/scene/src/shared-motion.ts` 持有可复用的可选 `poseLayer` 配置；角色 sidecar 定义资产默认，MeshRenderer.sharedMotion 定义实例覆盖。配置只含通用 roots/exclude 后代区域、0–1 权重与过渡时间，不含僵尸或武器策略。无配置保持既有全身动画路径，场景版本升为 v16，v15→v16 正式迁移仅保留原数据并升级版本，不为旧场景自动添加或启用区域；资产 sidecar 仍使用其独立 schema。

游戏表现策略消费固定 tick 的移动速度、方向和已接受的武器 action，输出基础 locomotion 与区域动作请求；活动武器 phase 只控制区域片段，不覆盖基础时钟。Editor 的 RuntimeSceneMotion 负责装配解析后的片段和固定 tick；RuntimeBodyIk 将输入目标和武器 poseIntent 投影到已有 HumanIK 控件。Editor 不计算武器动作时间或伤害。

render 的 SkinState 区域状态具有独立 clip/time/loop/weight 与过渡。采样顺序为基础片段 → 基础过渡 → 区域采样/过渡/权重 → 一次 applyBodyIk → FK/关节矩阵。基础切片的过渡快照排除区域与 IK，区域切换的快照也排除 IK，避免累积和二次应用。进入、切换、退出的区域快照仅影响 mask；基础步态持续前进。

## 区域和失败契约

mask 由 HumanIK 或 mixamorig 名称的 roots 后代构成，保护 root/Hips/腿部链。骨骼必须唯一解析，缺失、歧义或错误层级禁用区域并显式诊断，保留基础采样，不退为全身覆盖。上层只覆盖片段实际包含的轨道，缺轨道保留基础。

缺 shoot/reload/equip/unequip 时保留 locomotion 并报告请求缺片。切枪和后坐力的程序化姿态可使用现有 poseIntent → 手部 IK；它不是替代缺失动作片段的资产验收。reload 有片时衰减手部 IK，避免争夺换弹手轨道；总权重与部位持久配置不修改。目标不可用跳过该部位；0 权重保留前面的动画组合与腿部步态。

同 tick 不推进任何时钟；暂停冻结生产输出；重启清空运行期区域/动作 stamp；异步结果用 generation 拒绝跨 Stop 完成。Stop 恢复原 author SkinState/animations，不把运行期区域、IK 目标或调试状态写回场景。

## 观察与验收边界

只读 debug 展示生产状态的 base、区域 clip/time/mask/weight/过渡/缺片与 IK 有效权重。观察、选择、freeze 不执行采样、动作选择、推进时钟或配置写入。NPC 的现有 GPU palette/proxy 路径保持原有只读观察，本次区域组合仅作用于玩家场景骨架。

开发验证覆盖 mask 对腿矩阵不变、独立时钟、权重/过渡、缺骨/缺片、无累积、资产配置往返、游戏策略及 Play 装配/恢复。CPU 测试和 build 不构成视觉验收；真实 GPU headed Play 审核由队列 Audit 提供，结果另记。
