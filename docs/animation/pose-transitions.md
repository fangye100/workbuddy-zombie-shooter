# 运行时姿态过渡

游戏动作状态变化时，从当前显示姿态过渡到持续变化的目标片段，默认 0.2 模拟秒、
smoothstep 缓动。源姿态冻结，源片段在过渡中不继续播放；目标片段从正常起点开始，
保留原有步态距离或攻击阶段时钟。

## 配置与职责

`SharedMotionBinding.transitionSec` 范围 0–5 秒，缺省 0.2，0 表示立即切换。
场景覆盖在 `MeshRenderer.sharedMotion`，可复用默认在资产 `.meta.json`。
节点表单显示时长，Apply/保存共用文档/历史/冲突检查。当前集成 schema v15；原 IK 分支
在 v14 引入该可选字段，这只是版本来源。合并后的 v13→v14 保留 `scene-audio-cue-mapping`，
v14→v15 为 `integrated-weapons-audio-body-ik`。已有过渡保留，缺字段使用采样默认值，
不序列化生成姿态。见[迁移源码](../../packages/scene/src/migrate.ts)。NPC 从已解析资产动作
配置继承时长。

- `skin.ts`：临时 IK 前局部姿态快照、TRS 计算。
- `RuntimeSceneMotion`：片段选择及固定 tick 过渡推进；播放速度只改片段时间，不改过渡
  时长。重复渲染/暂停不推进第二个动画时钟。
- `PalettePoseTransitions`：实例角色的 CPU 快照；`RuntimeBridge` 用 run/id/generation
  标识，打包混合权重和源矩阵偏移，移除已消失/不可见实体。
- `RendererCore`：每批快照 storage buffer；版本/数据变化才上传，调色板/容量替换、
  Play Stop 及渲染器销毁时释放；现有 PlaySession 登记共用动态资源释放路径。

## 连续性与 IK 顺序

场景骨架对象在 IK 前取源姿态：位移/缩放线性插值，旋转最短弧归一化 slerp；之后只执行
一次 HumanIK。过渡中再切片段，捕获当前混合姿态，避免跳回旧片段或累积 IK 修正。

群体仅在片段变化时快照当前混合的调色板矩阵，GPU 插值位置/法线/描边至当前目标姿态，
不新增每 NPC 每帧 CPU FK。批内行变化重写对应快照，源姿态跟随实体身份而非不稳定行号。
动态实例 ABI 为 20 floats/80 bytes，末 vec4 存目标权重、源矩阵偏移和两个保留值；
binding 5 存源矩阵，binding 4 存不可变烘焙调色板。

## Reset 与边界

初始加载、重跑和新实体立即选择；Stop 恢复原编辑 SkinState 并释放临时动态 GPU 资源。
无效片段下标、非有限/负过渡请求不改变播放；资产/配置拒绝超范围时长。
Retarget 求解片段缓存独立于过渡时长。

本功能解决状态切换连续性，不提供步态 blend tree、相位匹配、inertialization、解剖
关节限制、root-motion 混合或贴地。NPC 矩阵插值为 LBS 近似，大幅反向旋转可暂时损失
体积；片段内调色板仍最近帧采样。本检查未证明手机性能或 500-NPC 压力。

## 验证

测试覆盖 TRS 端点、移动目标、最短弧、打断过渡、重复计算/暂停、IK 顺序、固定 tick、
重启/Stop、调色板身份/行变化、零时长、缓存复用、场景/资产验证及迁移。硬件有界面验收
还需实际 Shader/管线编译和可见动作控制。

以下为 IK 分支 2026-10-07 的历史结果：28 个文件、428 项定向测试通过；类型检查、
编辑器构建、M0 构建、`scene:check` 通过，场景检查覆盖 206 个资产、13 个 v14 场景。

Windows/NVIDIA Lovelace 有界面验收确认安全上下文和 v14。可见编辑表单保存/重载
0.6 秒覆盖；暂停时 Run→Idle 起点关节矩阵差为 0，9 次可见固定单步达到 50%，矩阵元素
最大差 0.99763。中途切回 Run 起点差为 0，结束后清除临时过渡。

NPC 在 tick 151 唤醒，GPU 过渡权重 0；tick 154 两批均权重 0.5，各有 1792-byte
源缓冲。最终 Shader 加载后无新 GPU 错误。临时开发销毁计数观察可见 Stop 释放两个
快照缓冲，动态槽/调色板及过渡状态清空，文档与原片段/时间/播放值一致。计数器验证后
已移除；这是集成/生命周期检查，不是群体体积或手机压力验收。

历史演示使用另一 worktree 的 QA 5197 服务。登记验证场景仍在当前项目，重跑前核对
服务归属和 schema。[IK 流程](body-ik-blending.md#validation)及
[v15 集成报告](../review/branch-integration-2026-10-09.md)区分原验收与后续证据。
