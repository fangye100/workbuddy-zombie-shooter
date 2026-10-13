# 模型与骨骼握点契约（v18）

本指南定义持久数据和中性机制。真实游戏装配由游戏表现投影和编辑器 runtime-weapons 适配器消费；机制测试通过不等于模型美术或实际 Play 验收。

## 数据归属与优先级

`packages/scene/src/model-attachments.ts` 是刚性 socket 真源。位置使用模型最终 `parseGlb` import-space 的米制坐标，旋转使用 xyzw 单位四元数；不得用烘焙前 pivot 或原始 GLB 节点坐标测握点。

资产 `.meta.json.modelSockets` 保存通用模型默认值。武器 `presentation.assembly.sockets` 按 key 覆盖默认值，未列出的 key 继承。附件 `attachments[]` 使用稳定 GUIDAssetRef、父 socket、子 socket、刚性 offset 和子资产 socket 覆盖。

角色 sidecar `boneSockets` 使用持久骨骼名称及 contact；`MeshRenderer.boneSockets` 为场景覆盖。undefined 继承，null 显式禁用，按 key 合并而不修改资产默认。骨骼 contact 的位置为规整化 actor 米制偏移，随骨方向旋转，不重复乘原骨架厘米尺度。仅接受正均匀尺度与刚性方向；反射、非均匀尺度和 shear 有诊断。

`presentation.assembly` 配置真实模型关系；`holdPose` 是 actor-local 理想模型位置及世界瞄准朝向的附加旋转。旧 `presentation.markers` 保留模拟发射点与无 assembly 的显式 legacy 表现；其 muzzle 使用胶囊中心相对 yaw-local 坐标，modelSockets 使用实际模型 local 坐标，两者职责独立，不能直接复制。不把 markers 与 modelSockets 同时作为同一个视觉握点的真源。缺配置不会猜测骨骼、创建假模型或静默宣称装配成功。

## 每武器 Hip 相对位置

v18 可选 `presentation.assembly.holdSlot = { bone: 'Hips', position: [x,y,z] }` 属于武器配置。
position 使用规整化 actor 轴米制偏移，+Z 朝角色前方；它替代 `holdPose.position`，不叠加两份位置。
Hip 只贡献平移；武器方向仍由已有瞄准、后坐和 `holdPose.rotation` 决定。未配置 slot 的旧数据维持绝对 holdPose。

编辑器在 `场景/光照 → 定位玩法规则 → 每件武器 · Hip 持握位置` 修改七件已有 slot 的 XYZ（步长 .01m）。
输入先留草稿，`应用节点修改` 后可撤销/重做，再经 File 保存并重开；Play 时作者表单锁定。
同一事务按游戏定义的 actor +Z→模拟 yaw-local +X 转换，平移该武器旧 markers，避免模拟发射点留在旧位置。
不改实际模型 socket、模型尺度、骨长、弹药或动作时钟。缺 slot 的 legacy 配置继续沿用原字段，表单不猜测骨基准。

`assets/weapons/prototype.weapons.json` 是新生成默认；场景 RunRules.arsenal 中的 slot 是独立作者覆盖。
`tools/level/gen-level.mjs` 保留已有场景 slot 和 markers；`calibrate-weapon-models.mjs` 保留 prototype 和场景的 slot，
按 `assets/art/calibration/weapon-assembly-trial.json` 中 H01 的规整化作者 Hip 参考重算零后坐模拟枪口。
该参考仅用于离线数据投影，运行时始终从本帧动画求基准，不能从参考 pose 或上一帧蒙皮矩阵取代。
生成器的 muzzle 投影也消费场景 slot 与默认 slot 的差值；校准器匹配不了骨参考时明确失败。

## 一次采样和同帧依赖

`packages/render/src/body-ik.ts` 接受中性瞬态请求，先处理 torso/head，再处理 primary 的位置与腕部方向。由该次实际手姿态 H、骨 contact C 和模型握点 G 求 `W = H * C * inverse(G)`。dependent 的目标由这个 W 求出，因此 reach clamp 与 partial weight 不使用理想 mount 或上一帧武器。保留旧配置的顺序与行为；残差同时报告米制距离和旋转弧度。

Editor 将持久骨名（支持既有 Mixamo 前缀）唯一解析为瞬态节点索引，传给中性 `positionAnchor:{node}`。
render 在 primary 求解前用当次 sampled locals 的 FK，经过 skeleton.normalization 得到 actor-local 基准，
与输入偏移相加产生独立 `resolvedTarget`。原 `request.target` 不写回；诊断测量使用 resolvedTarget。
随后仍是 primary→实际模型→dependent 的同帧链，Hip 和双腿采样轨道不受位置调整影响。
骨名缺失/歧义在 Editor 产生 `WEAPON_HOLD_SLOT` 并保留 legacy；失效节点在 render 产生 `IK_ATTACHMENT_ANCHOR`，不显示精确装配成功。

`skin.ts` 一次采样已有 base/Spine 动作、一次 IK，再最终 FK，输出带 frameStamp 的实际骨矩阵。父节点无需在 GLB 数组中排在子节点前。新增输出是骨世界矩阵，不能拿蒙皮的 inverseBind 共轭矩阵当 socket。

`attachment-transform.ts` 只做刚性变换；`model-draw.ts` 为单模型提供独立 mat4 的 CoreObjectDraw。它不占作者 64 个静态槽、不改变群体 ABI。每次 buffer/texture 创建后立即调用宿主资源登记端口，创建中失败释放已分配资源，disposer 幂等。宿主负责异步 generation/Stop 取消，资源登记拒绝之后不继续上传。

## 迁移与验证

v16→v17 的 `explicit-model-socket-assemblies` 仅为旧武器补 `assembly:null`，不推断握点、不改玩法。磁盘迁移：`node tools/level/migrate-scenes.mjs`；只读门禁：`node tools/level/migrate-scenes.mjs --check`。本次 18 场景移除版本、迁移更新时间和新增 legacy null 后，语义与迁移前一致，createdAt 保留；历史检视 hash 只对应当时版本。

v17→v18 的 `optional-bone-relative-hold-slots` 只升级版本，不为旧场景创建 slot，也不重写持握值。
2026-10-13 的 22 场景升级只改 schemaVersion；七件默认值之后在 prototype 和四个武器场景中独立配置。
初版默认前移 8–12cm 是候选。实机正常持枪/切换采样在 `f5c3ea6` 发现六件左手不可达，
霰弹枪/SMG/狙击枪/电锯/火焰/火箭筒最大残差分别约 59.6/17.7/78.8/82.7/28.8/29.9mm。
2026-10-13 的一次数据修正相对该候选将 slot 分别平移 `[.14,.10,0]`、`[.10,0,0]`、
`[.16,.04,-.04]`、`[.16,0,-.05]`、`[.10,.10,0]`、`[.09,.02,0]` 米；手枪保持。
主要靠 +X 向左肩靠近和 Y 上抬。狙击枪和电锯的前向分量本身已超过链长，收回小量 Z 后仍保留 4/7cm 前移；
其他武器仍保留初版前移量。基于原始 154 个可见帧的双手肩球计算，修正候选最小余量约 9.9mm。
精简观测夹具 `packages/zombie-game/test/fixtures/weapon-hold-shoulders.json` 记录原 HEAD、源报告、
actor-local 肩位置及最不利双手目标，回归测试 `packages/zombie-game/test/presentation/weapon-hold-slots.test.ts`
对当前作者 slot 检查余量。肩球计算只证明这些观测帧的位置可达；后续真实 GPU 验证见下节，
不能凭单元测试宣称胸前距离或全姿态质量通过。

本轮定向验证另含 `apps/editor/test/runtime-weapons.test.ts`、`apps/editor/test/scene-authoring-loop.test.ts`、
`packages/zombie-game/test/presentation/weapon-model.test.ts` 和 `node --test tools/level/weapon-assembly-defaults.test.mjs tools/verify/weapon-assembly.test.mjs`。
headed 工具使用 `node tools/verify/weapon-assembly.mjs --expected-head <完整提交> --hold-switch-only --collapse-ik-panel`，
入口为正常 HTTPS MagicDNS:5198 的武器试验场景。该模式只做七件正常持枪、真实 Digit1..7 切换、一次移动及 Pause/Stop 恢复，
不执行攻击/换弹；保存重开和单件 slot 改值需 Audit 另走正常可见编辑路径。

## 2026-10-13 R5 实机与保存证据

验收源码与内容为 `2305610d715febd2fa3ad2413f2f1290f0e8d07e`，同一 Windows 检出目录、
正常 HTTPS/TLS、headed Chrome 与 NVIDIA Lovelace。使用上面的有界模式加 `--aim-yaw 135`，
不修改场景 Camera；该视角提供侧前观察。七件真实 Digit1..7 切换、正常持枪、一次 W 移动、
Pause、Stop、重启及再次 Stop 的工具检查全部通过。原报告共 194 条快照；正常持枪/切换双手门禁
计入 184 条本帧有效模型样本，`failures: []`，作者文档/玩家恢复与资源账目归零通过。
Audit 对原生侧前 Flame 图进行了目检，武器前移位置可见；此证据认证本次正常持枪路径，
不扩大为七件所有姿态的穿插几何、换弹、NPC 或性能认证。

随后经可见 `场景/光照 → 定位玩法规则` 将 Flame 的 slot Z 从 `0.3945957025749669` 改为
`0.4445957025749669` 米，Apply、File 保存、Reload 后值保留，其他六件定义逐项保持。
Flame 的五个旧 markers 仅按同一事务的 actor +Z→模拟 +X 平移约 `.05m`；单武器真实 GPU 探针通过。
同一 `seven-flame-ready` 标签、idle/phase 0 的 actor-local 观察中，resolvedTarget.Z 为
`.3676152533 → .4176152533`，实际模型 result.Z 为 `.3676152530 → .4176152530`；
LeftHand.Z 为 `.3799861536 → .4299861340`，RightHand.Z 为 `.1780537177 → .2280537515`，
均约前移 `.05m`，双手残差小于 `4e-7m`。两次 idle 采样时间不同，Y 约有 `.000165m` 差异，
因此不将世界坐标或整个姿态向量宣称为精确刚性平移。

可见 UI 恢复原 Z、Apply、保存后，磁盘所有 slot 回到原值。初次临时 `+.05m` 的 Reload 已验证，
最终恢复后的 Reload 未取得有效证据。五标记唯一遗留的 Flame primaryGrip.position[0]
浮点尾差约 `1e-17` 由 owner 精确恢复到该 HEAD；试验场景磁盘内容与该 HEAD 完全一致。
本轮最终只提交证据文档，不增加动作或参数机制。

本地原始证据位于 `.workbuddy/tmp/weapon-hip-slot/headed-correction-audit/observations.json` 和
`.workbuddy/tmp/weapon-hip-slot/ui-slot-audit/` 的 `baseline-scene.json`、`temporary-after-save.json`、
`final-restored-scene.json`、`temporary-slot-evidence/observations.json` 和 `cua-original-records.jsonl`。
后者保留本次 Audit 的原始 CUA 调用、响应及原生截图。这些忽略路径是本次本机可复查证据，
不会随 Git 分发；版本化契约保留上述提交、路径、计数和限制。独立终审另行执行，不将工具通过当作终审批准。

定向测试：`pnpm exec vitest run packages/scene/test/model-attachments.test.ts packages/scene/test/migrate.test.ts packages/render/test/body-ik.test.ts packages/render/test/model-draw.test.ts`。涉及资产/场景还需 scene:check；跨层源码需 architecture:check；发布指南需 knowledge:check。

实际装配入口、持久校准与待 GPU 复验边界见[真实武器装配试验](weapon-assembly-trial.md)。
