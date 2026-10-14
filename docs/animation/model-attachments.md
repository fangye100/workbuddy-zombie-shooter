# 模型与骨骼握点契约（场景 v18 / 角色资产持握配置）

本指南定义持久数据和中性机制。真实游戏装配由游戏表现投影和编辑器 runtime-weapons 适配器消费；机制测试通过不等于模型美术或实际 Play 验收。

## 数据归属与优先级

`packages/scene/src/model-attachments.ts` 是刚性 socket 真源。位置使用模型最终 `parseGlb` import-space 的米制坐标，旋转使用 xyzw 单位四元数；不得用烘焙前 pivot 或原始 GLB 节点坐标测握点。

资产 `.meta.json.modelSockets` 保存通用模型默认值。武器 `presentation.assembly.sockets` 按 key 覆盖默认值，未列出的 key 继承。附件 `attachments[]` 使用稳定 GUIDAssetRef、父 socket、子 socket、刚性 offset 和子资产 socket 覆盖。

角色 sidecar `boneSockets` 使用持久骨骼名称及 contact；`MeshRenderer.boneSockets` 为场景覆盖。undefined 继承，null 显式禁用，按 key 合并而不修改资产默认。骨骼 contact 的位置为规整化 actor 米制偏移，随骨方向旋转，不重复乘原骨架厘米尺度。仅接受正均匀尺度与刚性方向；反射、非均匀尺度和 shear 有诊断。

`presentation.assembly` 配置真实模型关系；`holdPose` 是 actor-local 理想模型位置及世界瞄准朝向的附加旋转。旧 `presentation.markers` 保留模拟发射点与无 assembly 的显式 legacy 表现；其 muzzle 使用胶囊中心相对 yaw-local 坐标，modelSockets 使用实际模型 local 坐标，两者职责独立，不能直接复制。不把 markers 与 modelSockets 同时作为同一个视觉握点的真源。缺配置不会猜测骨骼、创建假模型或静默宣称装配成功。

## 每武器 Hip 相对位置

下述场景武器 slot 是兼容数据；2026-10-15 新增的角色资产配置优先级和可视编辑见下一节。

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

## 角色资产持握配置与可视编辑（2026-10-15）

`AssetMeta.holdProfiles` 是可选的角色资产数据，存于当前角色模型的 `.meta.json`，以武器模型 GUID 为 key：

```json
{
  "holdProfiles": {
    "weapon_model_guid": {
      "model": { "guid": "weapon_model_guid", "path": "assets/art/models/weapon.glb" },
      "slot": { "bone": "Hips", "position": [0, 0.2, 0.4], "rotation": [0, 0, 0, 1] }
    }
  }
}
```

该结构示意字段语义，不是可直接装载的资产引用。角色 GUID 决定保存目标，武器模型 GUID 决定该角色的独立条目；
换场景仍读同一角色 sidecar。有效角色 profile 优先于既有场景/武器 `holdSlot` 和 `holdPose`；
没有 profile 时保持旧行为。H01 的七条初始配置复制当时已有持握值，旧 arsenal 保留兼容。
本轮没有新增场景 profile 覆盖或禁用字段，也没有改变场景 schemaVersion。

`ActorHoldSlot` 的位置为规整化角色局部米制偏移，+Z 朝角色前方；Hip 仅贡献平移，不继承 Hip 的旋转。
`rotation` 为 xyzw 单位四元数，表示绝对中性模型根旋转，替代原 `holdPose.rotation`，随后仍叠加游戏瞄准和后坐。
它不是骨骼旋转或额外叠加一次旧姿态。游戏 `weaponMountForHoldSlot` 从原中性装配求刚体差值，
同步有效 assembly 与所有模拟 markers；不改模型 socket、骨长、弹药、动作相位或原始武器定义。
模拟枪口仍采用既有 yaw-local 近似；同帧双手接触不等于精确 GPU 枪口弹道认证。

在武器试验场景打开左侧 `角色武器持握槽`，核对真实角色 GUID、资产路径和基准骨。
点击 `暂停观察校准` 进入 Play 的暂停观察模式；选择武器后先 `切换选定武器`，待原有切换完成再校准。
勾选显示槽位，点击视口原点选中，使用移动轴或旋转环拖动；面板也提供角色局部 XYZ 米值、旋转度及折叠的精确四元数输入。
不支持槽位缩放。手柄原点表示配置的理想槽位，而不是不可达时经手链限制后的模型根；双手/骨骼诊断保持可见。
暂停预览使用本帧 Hip 和同帧 primary→模型→dependent 双手求解，不推进游戏 tick。

`Undo` / `Redo` 属于独立角色草稿历史，一次拖动形成一条记录；场景作者历史不拥有该数据。
`Save到角色资产` 经既有 devfs 的 baseHash 比较与原子写入，仅 patch `holdProfiles`，保留 rig 等其他字段并失效精确元数据缓存。
写入失败或 HTTP 409 保留草稿与历史，面板显示错误；有草稿时 `Reload` 明确放弃草稿。
Stop 回滚场景和释放 Play 资源，不回滚已保存的角色资产；下一次 Play 和其他引用该角色的场景重新读取保存值。
短暂缺少派生姿态帧只隐藏手柄，不取消已捕获的拖动；取消、失焦或真正退出编辑才结束手势。

当前面板校准当前 Play 玩家角色，不为任意 NPC 创建独立战斗预览。其他角色可以复用同一配置流程，
前提是角色有有效 rig、BodyIK 和左右 hand boneSockets，武器有有效握点；缺失配置、无效 GUID/四元数、骨名缺失或歧义均有显式诊断。
两角色 GUID × 两武器模型的隔离由 owner 测试覆盖；本轮原生验收实际角色为 H01，没有冒称第二角色实机通过。

Owner：`packages/scene/src/model-attachments.ts` / `asset-meta.ts` 定义持久契约；
`packages/runtime/src/weapon-system.ts` 提供有界装配更新；游戏 `weapon-model.ts` 负责坐标/marker 投影；
Editor `runtime-weapons.ts` 消费角色资产，`actor-hold-slot.ts` / `actor-hold-slot-panel.ts` / `actor-hold-slot-viewport.ts` 分别负责草稿保存、UI、原生手势。
Renderer 只消费通用 helper gizmo 与本帧姿态，不保存角色内容。

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

## 2026-10-15 R10 原生编辑与角色资产保存验收

源码、工具和 H01 候选均固定在 `ebb7bde5abfabc665a3f591a48869c904b0cdbec`，正常 HTTPS/TLS、
headed Chrome、真实 NVIDIA Lovelace。Worker 的 `--save true` 为 24/24 项通过：原点选中、
手枪原生轴移动约 12mm 和旋转约 2°、Undo/Redo、霰弹枪正常 UI 小量移动 3mm、两条独立 profile 的真实 Save/磁盘读取，
整页 Reload 等待新 document epoch 后再次 Play，Stop/重启，以及 `assets/scenes/act1/floor-1.scene.json` 复用。
最后经正常 UI 恢复两条配置并保存，完整 H01 meta 字节 SHA256 回到
`d6933e85716980e79b207e3f1061789099be237ddfe7abdc30816a47580acce0`，最终 Stop 资源账目为零。
独立 Audit 的 `--save false` 9/9 项通过，只验证原生选择、移动、旋转、Undo/Redo、草稿恢复及 Stop；
它没有执行 Save，也没有改磁盘。两份报告的 exceptions、consoleErrors 和 cleanupInputErrors 均为空，受控 Chrome 已退出。

保存后实际手枪 frame/frameStamp 均为 251，右/左手接触距离残差分别为 `1.044e-7 / 3.094e-8m`；
霰弹枪均为 382，残差 `1.674e-7 / 5.804e-8m`，models diagnostics/warnings 均为空。
霰弹枪原生截图面板仍出现短暂旧 `leftHand IK_TARGET`，对应 raw 当前 slot diagnostics 只有 head target unavailable；
面板投影与本帧实际模型诊断不能混用。Head 的 authored aim limit/观察时 target unavailable 保留，
旧武器动作回退和接地能力边界也未在本轮消除。发布的[手枪保存后原生截图](evidence/hold-slot-20261015/pistol-saved-ready.png)
展示槽位旋转环和已保存状态；不是胸部碰撞、全姿态质量或精确眼球瞄准认证。

本机完整原始报告保留在 `.workbuddy/tmp/r10-evidence/headed-save-final/observations.json` 和
`audit-native-readonly/observations.json`；紧凑指纹、检查名称、同帧数据与原始日志路径见
[版本化验收摘要](evidence/hold-slot-20261015/runtime-summary.json)。忽略路径不会随 Git 分发。
历史失败报告均保留：首轮异步控件未就绪、面板遮挡/手柄刷新与拖动生命周期失败，
以及 `headed-save-native-button` 的 18 项实际通过后整页重载等待失败、`headed-save-reload` 的 21 项通过后错误跨场景夹具失败。
后者历史 sim 场景无真实玩家骨架，改用现有有效 H01 场景后才取得本轮跨场景证据；不得将失败报告包装成通过。

定向 owner 日志包含数据/runtime 29 项、GUI 63 项、暂停适配 23 项以及最后手势策略 20 项通过；
这些是不同阶段的重叠检查，不相加为唯一测试总数。最后工具测试 2 项、typecheck、editor:build、architecture:check 通过，
构建原有大于 500kB chunk 警告保留。H01 资产改动后的完整 scene:check 已通过；本轮文档发布运行 knowledge:check。
CodeGraph 0.167.0 执行一次受支持 `incremental-index --no-embed --json`，因前次 cross-file edges 未提交而由工具自动重索引 1173 文件；
结构更新退出 0，仍有 5 文件解析恢复警告，embedding 为 0/7427。该限制不替代源码核对或行为门禁，没有删除缓存/锁或另做强制重建。
独立最终 Review 另行执行，不将上述原生操作验收写成最终审查批准。

当前有界验收命令如下；默认 `--save false`，`--save true` 会正常 UI 写当前角色 sidecar，需保留候选原字节并在结束时恢复。

```powershell
node tools/verify/actor-hold-slot.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head <完整源码提交> --url 'https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-assembly-trial.scene.json' --cdp <空闲受控端口> --save false --out .workbuddy/tmp/r10-evidence/<新目录>
```
