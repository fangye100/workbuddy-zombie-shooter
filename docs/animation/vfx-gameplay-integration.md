# Act1 实战 VFX 与直接试玩

日期：2026-10-19。初次接入基线 `db170c558391b0563f1c42bde815d47689bf803b`；R2 漫画强化基线 `528ae3a1de1362f22ffe71879dca0f63e2b2bc84`。
本次把已有正式 VFX 接到原 Act1 三层，不新增验收专用游戏场景。
启动场景仍由 `aether.project.json` 的 `startIndex=1` 指向第一层。

## 试玩入口与操作

服务为本仓库已有的固定 HTTPS 5100。点击入口，等场景及 GLB 加载结束后按左上 **Play**。
若提示“场景或资产尚未加载完成”，等右上显示“已打开”后再播放。

| 实际场景 | 入口 | 可遇到的原有内容 |
|---|---|---|
| 第一层 · 火场公路 | [直接打开](https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=assets%2Fscenes%2Fact1%2Ffloor-1.scene.json) | 首战 E-01、E-02；扑击落点、近战弧线；后续事件房与第二战斗房 |
| 第二层 · 尸潮仓储区 | [直接打开](https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=assets%2Fscenes%2Fact1%2Ffloor-2.scene.json) | 首战 E-01/E-02，第二波 E-03 酸液、落地酸池；事件房后精英房 E-04 冲锋 |
| 第三层 · 暗巷撤离站 | [直接打开](https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=assets%2Fscenes%2Fact1%2Ffloor-3.scene.json) | 首房 E-04 冲锋及 E-02，第二波 E-03；后续 Boss 房 B-01、E-05 自爆与 E-03 |

WASD/方向键移动，鼠标瞄准，鼠标左键或 J 持续攻击；R 换弹，E 交互，空格暂停。
三层均以手枪开始，现有武器选择器和数字键 **1–7** 可直接换装：
1 手枪、2 霰弹枪、3 冲锋枪、4 狙击枪、5 电锯、6 火焰喷射器、7 榴弹发射器。
当前武器没有额外解锁/拾取要求；成长 `unlocked` 用于天赋资格。
换装需等待原换装动画结束，选择强化弹出时战斗会冻结，点击一项强化后继续。
不修改伤害、弹药、波次、奖励、天赋、地形、导航、相机、灯光或角色绑定。

## 已接入的表现及边界

- 四把射线枪共用三张正式纹理，R2 分别绑定 pistol/shotgun/smg/sniper 的独立效果 key。手枪利落爆闪，霰弹大星芒和多线爆散，SMG 较短连贯，狙击宽线及更重命中；真实接触点另有火花。只有对应 GPU 表现已就绪时才替换旧 Canvas 枪效。
- 火焰喷射器使用真实枪口/方向发射，真实燃烧 actor 按身份代次附着烟。R2 用纵长火舌、橙黄白亮芯、较窄装饰散角和重叠粒子形成连续喷流，烟以黑描边/亮暗块面形成体积，soft 交界为 0.2m。没有改变枪口、射程、伤害锥或命中事实。
- E-02 扑击、E-03 飞行/落地/酸池/被挡、E-05 自爆和结束痕迹复用正式敌人资源。危险轮廓和前摇提示保留，缺资源/预算不足继续走原保底。
- E-04 的真实冲锋同时有尘尾与 M4 连续 Ribbon，读取逐 tick 移动事实，不增加高度偏移。电锯和敌人近战复用真实挥击弧线。
- GPU 命中已有同 run/tick/slot/generation 的可画实例时，去掉重复 Canvas 星花；伤害与击杀文字保留。缺图、旧代次、无匹配命中均继续保底。
- 榴弹发射器仍走现有 Canvas 弹丸/爆炸，未宣称其已 GPU 迁移。默认 sandbox 无玩家起点/RunRules，继续用于编辑；未改造成新玩法。
- 当前关卡没有合适的既有 graph/compute 作者节点或静态跨面涂印语义，本次不添加这类摆件。三项能力的作者入口与支持边界仍见 [M4 指南](../architecture/vfx-m4-20261019.md)，不把系统能力等同于已在实战触发。

绑定真源为三份 `assets/scenes/act1/floor-*.scene.json`：四把武器的 `presentation.vfx` 和 RunRules 所在节点的 `VfxBindings`。
`tools/level/gameplay-vfx.mjs` 由 `gen-level.mjs` 调用，显式重建正式关卡也会保留这些绑定；本次没有运行整关重生成。
资产使用稳定 GUID，并进入场景 dependencies；各枪/标签共享 **14/16** 张纹理，没有为每把枪复制纹理。
共享装饰池仍为 256，Ribbon 共享点预算沿原系统；满池时可能减少装饰，不改变模拟或危险范围。

## R1 初次接入的历史验证与限制

开发原始记录在 `.workbuddy/tmp/vfx-gameplay-integration/`。
`development-09/result.json` 的 **31 项通过**：真实 headed、HTTPS、NVIDIA Lovelace 非 fallback；
三层直接从磁盘加载、四枪/13 标签和 14 纹理就绪；原生数字键/J/鼠标产生六武器实际事实；
原生击杀→强化选择→继续战斗；真实火焰/燃烧烟和三层自然盾卫冲锋。
手枪、成熟火焰、冲锋 Ribbon 分别做暂停同机位 GPU on/off 局部像素比较，原始 PNG 与阈值同目录保存。
所有 Stop 检查账目归零及真实纹理/缓冲销毁；场景 hash 验收前后相同。
这些像素比较关闭的是已有 Pass，属于受控测量；攻击/冲锋来源是原游戏输入/状态机。

本轮没有自然打到第二波酸液及 Boss 房爆尸，不把绑定检查写成已实战触发。
遮挡/透明混合/失败路径的通用能力继续复用 [M1](../architecture/vfx-m1-20261019.md)、[M2](../architecture/vfx-m2-20261019.md)、[M3](../architecture/vfx-m3-20261019.md)、[M4](../architecture/vfx-m4-20261019.md) 对应精确版本的既有独立验收；本次没有新增关卡遮挡几何或重新认证所有设备/繁忙波次帧率。
生产最小检查为 scene:check、typecheck、editor:build、architecture:check 与相关 owner 测试。
CPU 控制器/角色测试使用无 GPU 替身隔离 VFX 装配，其通过不作为 GPU 证明。
player-presentation 的旧 v7 迁移精确列表缺 v15→19 四项，是基线 `db170c5` 已存在的失败，未在本次修复。
knowledge 全工作区仍包含两份未跟踪架构草稿的三条既有诊断；本任务目录按单独 staged 版本检查。
开发通过仍需队列独立 Audit/Final Reviewer，本文不预授最终批准。

复跑：

```powershell
node tools/verify/vfx-gameplay-probe.mjs --headed --out .workbuddy/tmp/vfx-gameplay-integration/recheck
node --test tools/level/gameplay-vfx.test.mjs
```

探针使用本任务专属 Chrome profile/CDP，保留用户原窗口与 5100 服务，不写回正式场景。
旧 development-01–07 的过早 Play/输入、成长模态与未成熟粒子采样失败保留；不覆盖成通过记录。

## R2 漫画与激烈感强化

本轮直接重绘 14 张现有 SVG 矢量图集：深墨线、饱和橙黄、白芯、尖锐星芒、断裂碎片、分明的火舌/烟团与速度楔形，包含三帧形变及消散。保持纹理 GUID、图集尺寸和帧数。
`comic-pistol.vfx.json` 新增四组效果，保留原 `comic-muzzle/trail/impact` key 供原示例兼容；实际三层与关卡生成器改用分枪 key，仍只加载同三张枪械纹理。

| 内容 | R1 → R2 的纯表现变化 |
|---|---|
| 手枪 / 霰弹 / SMG / 狙击 | 原共用 0.045m 弹迹，改为 0.13 / 0.09 / 0.095 / 0.21m；闪光、命中尺寸及 0.075–0.34s 短促节奏各自区分 |
| 火焰 | 0.5×0.65m → 0.85×1.4m 火舌，初生不再缩成小球；仍 60/s，单发射器上限 64→48，寿命 0.5→0.46s，不延长末端射程 |
| 燃烧烟 / 火花 | 烟加大黑描边体积、12→8/s、64→16 上限；火花加尖锐亮芯，120→90/s、64→32 上限，依靠形状而非堆数量 |
| 冲锋 | 尾带 0.35→0.85m，橙白锯齿+深边；尘从 60→30/s、0.4→0.28s、上限64→24，并降低透明度/高度，留在脚下而不盖住长尾 |
| 近战 / 酸液 / 扑击 / 自爆 | 图集统一粗墨线和分层爆发，装饰形变/短尾更明确；既有真实半径、攻击阶段、危险轮廓及结束事实仍由模拟持有 |

资源与池预算仍为 **14/16 纹理、256 装饰实例**，没有修改 Framework、模拟、相机、地形或光照，也没有加入全屏闪烁/强制相机抖动。
`scene-preservation.json` 对比 R2 基线三层：剔除仅武器 `presentation.vfx` 后，其余完整 JSON 结构 hash 相同。

R2 证据根目录为 `.workbuddy/tmp/vfx-cartoon-intensity/`。`before-02` 31/31、`current-02` 32/32，均真实 headed / HTTPS / NVIDIA Lovelace 非 fallback，无 console/GPU 错误；原生六武器、强化后恢复、三层 Play/Stop、真实燃烧和自然盾卫冲锋通过。
`current-02` 的额外一项为自然冲锋暂停后，原生 Step 按钮逐 tick 推进 20 tick 的三个全景帧，不是注入轨迹。
原始结果记录实际 checkout commit 与源码/资产 SHA-256；开发轮可能含未提交的候选字节，不能仅把当时 HEAD 当成全部资产快照。

前后样张为 `before-02/floor1-{pistol,shotgun,smg,sniper,flame,chainsaw}.png` 与 `current-02/` 同名全景；冲锋看 `floor3-charge.png`、新版本另有 `floor3-charge-1.png`/`-2.png`。
旧版来自测试 tab 对精确基线 `528ae3a` 的三层/VFX/sidecar 原字节投影，`projectedSources` 列出各文件 SHA-256，不回退工作区，也不拦截用户 tab。
`first-comparison.json` 记录八组正常游戏相机的 viewProj/eye/viewport 完全相同；自然战斗 tick/目标可不同，不能当作同输入性能基准。
已目检全景与局部，判断依据为粗线条、色块/连续性和分枪轮廓；GPU on/off ROI 只证明效果可见，不证明审美更好。

R2 的 56 项相关 owner 测试、2 项绑定工具测试及完整 scene:check 通过；冲锋 owner 测试现核每个真实 move 历史位置均被消费，不再依赖旧尘率制造的粒子数量。typecheck、editor:build、architecture:check 通过，构建保留原 chunk 警告。
旧迁移断言及知识目录三诊断继续按前文单列，未修无关基线。酸液/自爆重绘和绑定已有资源检查，但仍未自然打到对应后续波次，不把它们称为本轮已自然实战触发。
`before/` 首轮基线投影失败，是验证工具在纹理请求内同步调用 git 造成装配迟延/玩家死亡；改为 Play 前预载后 `before-02` 完整通过，旧失败记录保留。

复跑当前版本及独立基线投影：

```powershell
node tools/verify/vfx-gameplay-probe.mjs --headed --style-sequence --profile .workbuddy/tmp/vfx-cartoon-intensity/chrome-profile --out .workbuddy/tmp/vfx-cartoon-intensity/recheck
node tools/verify/vfx-gameplay-probe.mjs --headed --profile .workbuddy/tmp/vfx-cartoon-intensity/chrome-profile --compare-base 528ae3a1de1362f22ffe71879dca0f63e2b2bc84 --out .workbuddy/tmp/vfx-cartoon-intensity/baseline-recheck
```

最终候选由提交/push 后的精确 HEAD 再跑上述当前版本路径，命令/exit 与结果放同根 `final-command.log`、`development-final/`；队列独立验收/终审另行判定。
