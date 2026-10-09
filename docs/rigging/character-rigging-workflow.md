# 角色绑定：源编辑到运行时交付流程

本指南总结 2026-10-07 的 9 个角色交付流程，说明实现、GUI 和 MCP 的共同契约。各资产的结果与视觉验收边界见
[交付记录](character-rig-delivery-2026-10-07.md)及[控制验证](character-control-2026-10-07.md)。

## 职责与坐标空间

| 数据/操作 | 真源或执行职责 |
|---|---|
| 源几何/纹理 | 原 GLB，禁止被 rig 输出覆盖 |
| 关节、包裹器、平滑、体积参数、刚性选择 | `<source>.glb.meta.json.bindingEditor` |
| 编辑/历史/计算权重 | BindingSession，GUI/MCP 共用 |
| 体积单元/扩散 | volumetric-volume/volumetric-skin；GUI 可交给 CPU Worker 执行，MCP 使用 CPU 路径 |
| mesh、骨架、inverse bind、top-4 权重 | 导出 rig GLB |
| 运行身份/物理高度/共享动作 | 输出 meta；场景稳定 path/GUID |
| NPC rig 选择 | asset-manifest → ActorLibrary，SpawnPoint 存角色 ID |
| 共享源动作/状态配置 | assets/animations/mixamo/shared.motion.json 和 BVH |
| 目标求解/缓存/GPU 采样 | SharedMotionRuntime → ActorLibrary 调色板 / RuntimeSceneMotion |

源绑定用归一化**模型局部米制**，编辑尺来自 E-04 roster 高度（当前 2.05m），不是世界
坐标或各角色玩法身高。`get_state.model` 提供源/sidecar、尺和当前顶点选择指纹。
物理交付全 rig 按 roster 身高缩放：POSITION、局部关节/节点和 inverse-bind 位移同步，
不能只缩 mesh 或把源选择指纹复制到归一化输出。生成 sidecar 指回源编辑会话。

## 1. 恢复并检查实际源姿态

通过 GUI 的 **Skeleton → 角色绑定数据…** 选择角色并核对 sidecar 路径。NPC 使用带贴图的源 mesh，
玩家使用 LOD0。关节选择、正侧视图拖动及局部 XYZ 编辑共用 BindingSession；保存并重载 meta 验证持久化。
MCP 先调用 `get_workflow`，再调用 `load_model/get_state/get_joints/render`，检查正侧视图并启用 `grid:true`；
已有 meta 自动恢复。MCP 渲染的是 CPU 诊断图，动作/GPU 验收使用有界面的 Editor；stdio 不控制浏览器。
按真实姿态放关节，不把模板 T 骨架套弯肢体。保留用户确认位置；非对称镜像、重置或解除
手工包裹器会改数据。cylinders.unpin 立即 auto-fit，auto-fit 跳手工包裹器。
`save` 必须返回 `ok:true`。GUI/MCP 使用版本比较及 patch 写入；发生冲突时保留本地修改，重载后协调。保存成功不等于
生成或发布 rig。

## 2. 体积权重与持有道具

当前 NPC 的已验证起始配置：

```json
{
  "weightMode": "volumetric",
  "volumetric": { "resolution": 48, "depth": 1, "tolerance": 0.001 },
  "smoothWeights": true,
  "smoothIters": 6,
  "smoothLambda": 0.5,
  "mirrorWeights": false
}
```

这是交付预设，不替换默认或已批准玩家权重。顺序：算法→可选镜像→表面平滑→刚性约束。
自适应体积扩散、种子投影及 CPU 边界见[算法指南](volumetric-skinning.md)。
全部后处理结束后读取 `compute_skin.weightQuality`，检查零权重、非有限值、负权重及归一化误差；同时核对收敛情况、
outsideBones、projectedBones 距离、fallbackVertices。薄/开放生成面可能需显式最近骨
回退，体积扩散不修错误解剖或补缺几何。

道具使用 GUI 的 **刚性部件约束**或 `set_options.rigidRegions`。胶囊配置包含 `name`、变形骨 `bone`、
模型局部 `start/end`、`radius` 和可选的 `feather`；精确选择还需提供源 `vertices` 及当前 `selectionHash`。
无效或过期选择会原子失败；后定义的区域优先。`rigidRegions:[]` 清除约束，省略字段则保留。
B-03 的胶囊边界切到了融合的道具/身体三角形，复核后的方案改用完整 UV 岛：输液架、袋和管的 3,060 个顶点在
平滑后以权重 1 跟随 LeftHand，身体仍使用体积扩散。选择指纹用于防止几何变化导致误用，不能替代 sidecar 的 SHA-256 来源校验。

## 3. 导出与发布可动画 rig

非 T-pose 的源模型使用 `export_glb` 的 `bindPose:"source"`，并明确输出路径；`overwrite:true` 仅用于已授权的替换。
该模式保留当前 mesh/rest 姿态、关节及对应 inverse bind；默认导出仍为 T-pose。源姿态导出拒绝不兼容的内嵌 T-pose 动画，
共享动作必须针对目标的实际 rest 变换求解。MCP 输出采用绑定尺尺度，不会自动按 roster 高度归一化、登记场景、
创建共享动作配置或嵌入动画片段。9 个角色交付的复现命令为：

```powershell
node tools/rigging/export-character-rigs.mjs
node tools/rigging/integrate-character-rigs.mjs
pnpm run scene:gen
pnpm run scene:check
pnpm run motion:check
```

第一个脚本通过真实 MCP 复用已保存的 NPC 会话，保留已批准的玩家权重，并对整个 rig 归一化。
第二个脚本更新 rig 资产档位、三个楼层的玩家引用及已登记的验证场景。脚本针对当前清单，改用于其他 roster 前须核对范围。
Meta 生成必须合并现有字段，不能清除编辑绑定。

## 4. 运行时动作与控制验收

Rig GLB 无内嵌片段，共享 BVH 对各目标 rest 求解并缓存，再烘焙可复用 CPU/GPU 调色板。
不是每角色拷一份 FBX/BVH，也不是每帧体素蒙皮。契约/限制见
[运行集成](../35-SharedMotionRuntimeRetarget.md)及 16A/16B 研究。
使用已登记的 `character-rig-validation.scene.json`：Edit 预览编辑后的 rig，Play 隐藏静态 NPC 预览并创建
8 个真实 `actor:*` NPC 实例，Stop 恢复编辑状态并释放 Play GPU 资源。通过有界面、真实 GPU 验证带贴图的 rest 姿态、
idle/walk/attack/death/scream、持有道具及死亡动作收尾。
检查 8 个移动方向，以及静态玩家和实例 NPC 两条路径。玩法朝向为 `atan2(z,x)`，+Z 向前的渲染角为 `pi/2 - heading`，
由 `character-facing.ts` 负责转换。战斗朝向保持不变，目标相机的表现转换在适配器边界完成。
配置速度为零的追击角色使用时间驱动的 idle，不能使用依赖位移的 walk；Broodmother 按设计保持固定。
有限矩阵、有效 hash、构建、可见 canvas 只是结构检查，不证明衣甲变形、脚接触、专属
Boss 攻击或群体性能。交付记录应明确这些边界，每项验收结论都应附截图与实测运行状态。
