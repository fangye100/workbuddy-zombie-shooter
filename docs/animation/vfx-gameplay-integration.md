# Act1 实战 VFX 与直接试玩

日期：2026-10-19。初次接入基线 `db170c558391b0563f1c42bde815d47689bf803b`；R2 漫画强化基线 `528ae3a1de1362f22ffe71879dca0f63e2b2bc84`；R3 酸液/爆尸实战补验基线 `20ab81b5b02a307742634c8a6961e90f7d53c468`。
本次把已有正式 VFX 接到原 Act1 三层，不新增验收专用游戏场景。
启动场景仍由 `aether.project.json` 的 `startIndex=1` 指向第一层。

## 试玩入口与操作

服务为本仓库已有的固定 HTTPS 5100。点击入口，等场景及 GLB 加载结束后按左上 **Play**。
若提示“场景或资产尚未加载完成”，等右上显示“已打开”后再播放。

| 实际场景 | 入口 | 可遇到的原有内容 |
|---|---|---|
| 第一层 · 火场公路 | [直接打开](https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=assets%2Fscenes%2Fact1%2Ffloor-1.scene.json) | 首战 E-01、E-02；扑击落点、近战弧线；后续事件房与第二战斗房 |
| 第二层 · 尸潮仓储区 | [直接打开](https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=assets%2Fscenes%2Fact1%2Ffloor-2.scene.json) | 首战 E-01/E-02，第二波 E-03 酸液、落地酸池；事件房后精英房 E-04 冲锋 |
| 第三层 · 暗巷撤离站 | [直接打开](https://fangye-win11-office.tail6b29a2.ts.net:5100/?scene=assets%2Fscenes%2Fact1%2Ffloor-3.scene.json) | 首房 E-04 冲锋及 E-02；沿道路可直接进入 Boss 房，首波 B-01、E-05 自爆，清完后有 E-03。首房击败 E-04 即清房，会跳过其原数据中的第二波 E-03 |

WASD/方向键移动，鼠标瞄准，鼠标左键或 J 持续攻击；R 换弹，E 交互，空格暂停。
三层均以手枪开始，现有武器选择器和数字键 **1–7** 可直接换装：
1 手枪、2 霰弹枪、3 冲锋枪、4 狙击枪、5 电锯、6 火焰喷射器、7 榴弹发射器。
当前武器没有额外解锁/拾取要求；成长 `unlocked` 用于天赋资格。
换装需等待原换装动画结束，选择强化弹出时战斗会冻结，点击一项强化后继续。
不修改伤害、弹药、波次、奖励、天赋、地形、导航、相机、灯光或角色绑定。

### 直接测试酸液：第二层首房第二波

1. 打开上表第二层，Play 后按 **7** 换榴弹发射器，鼠标朝向追来的密集敌人，按住 J 或左键开火。用 WASD 在最初的大块道路内绕行；不要站桩等扑跃者贴身。可沿路面上侧向右、右侧向下、下侧向左循环，避免卡在路边掩体。
2. 出现“选择强化 · 战斗已暂停”时点选再继续。开发实际路线优先选 **尸髓回流**，没有时选 **重型弹头**，其余照常选择；每次选完重新按住 J。R 可正常换弹。没有修改弹药、奖励或强化资格。
3. 首波共 **48** 只 E-01/E-02。清完后停火，约 **2 秒** 后本房出现 **24** 只 E-03；不必走到下一个房间。开发样本正常完成了 48 次击杀与 7 次强化选择。
4. 呕吐者发出绿色酸团，约 **0.8 秒** 后在原瞄准落点形成粗黑边亮绿色池。离开亮边危险圆圈并继续沿道路绕行，把后续落点引到别处再观察旧池：池半径 **2m**，持续 **4 秒**，到时消失并留短暂沙灰边焦痕。后续新投射会生成别的池，不能把新池误认成旧池未消失。

### 直接测试爆尸：第三层沿公路进入 Boss 房

1. 打开上表第三层，Play 后沿公路向画面右侧前进，保持在道路中间，经过斑马线继续走。可用 D 为主，W/S 小幅修正，避开盾卫的黄色冲锋线和扑跃落点；本次已实测 **不开枪、不清首房** 也能沿现有道路进入 Boss 房，未添加跳房入口。
2. 右前方会出现巨大 Boss 和一群 **绿色胖爆尸**。接近群体边缘的一只，看到它周围的 **橙红色大圈/前摇刻度** 后立即向左后方跑开。触发距离约 **2.5m**；前摇基准 **1.5 秒**，有原规则抖动，爆炸伤害半径 **3.5m**。
3. 让它自己爆炸，观察黄白星芒、橙色碎片、黑色粗轮廓与随后沙灰边地面短痕；不要先开枪打死它。爆发约 **0.35 秒** 后回收，装饰痕迹约 **1.2 秒** 后消失。周围敌人和 Boss 仍会攻击，可用空格暂停，左上“单步”逐 tick 看清过程。

这两条都是正式现有关卡的原生玩法路径。原关卡没有专用选房菜单；第二层需正常清首波，第三层房间由进入范围触发，不要求前房先清。首房 `elite-dead` 会因 E-04 死亡直接结束，故第三层首房不是稳定的第二波酸液入口。

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

R1 当时没有自然打到第二波酸液及 Boss 房爆尸，不把该历史绑定检查写成已实战触发；R3 后续实际补验见下文。
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
| 手枪 / 霰弹 / SMG / 狙击 | 原共用 0.045m 弹迹，改为 0.13 / 0.09 / 0.095 / 0.21m；闪光、命中尺寸及 0.08–0.34s 短促节奏各自区分 |
| 火焰 | 0.5×0.65m → 0.85×1.4m 火舌，初生不再缩成小球；仍 60/s，单发射器上限 64→48，寿命 0.5→0.46s，不延长末端射程 |
| 燃烧烟 / 火花 | 烟加大黑描边体积、12→8/s、64→16 上限；火花加尖锐亮芯，120→90/s、64→32 上限，依靠形状而非堆数量 |
| 冲锋 | 尾带 0.35→0.85m，橙白锯齿+深边；尘从 60→30/s、0.4→0.28s、上限64→24，并降低透明度和 sprite 图案高度；世界锚点不变，留在脚下而不盖住长尾 |
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
旧迁移断言及知识目录三诊断继续按前文单列，未修无关基线。R2 当时酸液/自爆重绘和绑定已有资源检查，但仍未自然打到对应后续波次，不把它们称为 R2 已自然实战触发；R3 后续补验见下文。
`before/` 首轮基线投影失败，是验证工具在纹理请求内同步调用 git 造成装配迟延/玩家死亡；改为 Play 前预载后 `before-02` 完整通过，旧失败记录保留。

复跑当前版本及独立基线投影：

```powershell
node tools/verify/vfx-gameplay-probe.mjs --headed --style-sequence --profile .workbuddy/tmp/vfx-cartoon-intensity/chrome-profile --out .workbuddy/tmp/vfx-cartoon-intensity/recheck
node tools/verify/vfx-gameplay-probe.mjs --headed --profile .workbuddy/tmp/vfx-cartoon-intensity/chrome-profile --compare-base 528ae3a1de1362f22ffe71879dca0f63e2b2bc84 --out .workbuddy/tmp/vfx-cartoon-intensity/baseline-recheck
```

最终候选由提交/push 后的精确 HEAD 再跑上述当前版本路径，命令/exit 与结果放同根 `final-command.log`、`development-final/`；队列独立验收/终审另行判定。

开发收尾：精确 `c10f536506c14daaa88c3dea24c3599af081ccf6` 的 `development-final` 与 `baseline-final` 均 **32/32、EXIT0**；后者另有 `baseline-command.log`，投影文件的基线与当前 hash 分列 `projectedSources` / `comparisonCurrentSources`。
`comparison.json` 核八组武器全景及三段冲锋帧的 viewProj/eye/viewport 相同；自然 tick 的差异原样保留。
此后仅修正本指南的节奏下界、sprite 高度表述并补录证据，不改资产、场景、生产/测试/工具源码；对应最终文档提交仍需独立 Audit 对最终 SHA 复跑及 Reviewer 批准，不预用旧目标的通过结论。

## R3 酸液与爆尸的现有关卡实战补验

R3 初版 `4bf299f` 只有 focused 验证工具及指南/目录变更，生产源码、VFX 资产和三层场景当时与 `20ab81b` 相同。初版独立审核发现末端痕迹不可明确辨认，后续按下文 R3-V01 修正了现有 ground-mark SVG/表现参数及其两个 meta；当前生产 TS 和三层场景仍不变。不新增场景、传送、刷怪或伤害入口。工具只读 runtime 快照指导原生键鼠，清波、换装、强化选择、前进和后撤均走原控件。暂停/单步使用原工具栏；GPU on/off 只作暂停后局部受控测量，不制造模拟事件。

初版证据在 `.workbuddy/tmp/vfx-acid-explosion/`。工具提交 `db1d2a6c78bf3c60cffe5ba033638a8060e82677` 的 `development-final/result.json` 为 **29/29、EXIT0**，原始命令与输出在 `final-command.log`；真实 headed / 有效 MagicDNS HTTPS / NVIDIA Lovelace 非 fallback，无浏览器/GPU 错误。该29项证明事件/生命周期/资源释放及局部GPU差异，不单独证明末端在普通镜头可辨。原资源预算仍为 14/16 纹理、256 装饰池，未扩容。

| 实际事件 | 同一身份的实测阶段（30 tick/s） | 证据 |
|---|---|---|
| 第二层首房 wave2，`nd_f2r0_sp2` E-03 | run1 / attack15 / actor11 / generation2；tick419 发射，443 成池，563 到时结束。真实半径2m、直径4m、池4秒 | `acid-start.png`、`acid-pool.png`、`acid-mark.png`；飞行/池/痕迹 on/off ROI 改变333/9470/376像素 |
| 第三层 Boss 房 wave1，`nd_f3r1_sp1` E-05 | run1 / attack12 / actor27 / generation1；死前 HP90、原生接近前摇；tick315 自爆，326 到时结束。真实半径3.5m、持续0.35秒 | `explosion-windup.png`、`explosion-burst.png`、`explosion-mark.png`；爆发/痕迹 ROI 改变17510/145像素 |

初版正常镜头中酸池落在实际道路、危险边界可读；爆花在绿色爆尸群中可见，原橙红前摇圈、其他敌人的黄色冲锋线保持。但独立 `audit-final` 指出酸液/爆尸结束后的深色小痕迹难以指认，ROI仅34/160像素变化不能作为普通镜头可读性通过，原失败证据保留。每次跟踪同一个 run/attack/source/generation，保留死前 actor、源节点、房间、原 SpawnPoint/wave、完整事件、位置、surface、阶段与预计结束 tick；不是拿后续新池证明旧池结束。`surface.nodeId=null` 是当前道路地面查询的实际返回，保留向上法线，不伪称绑定到某个道路 mesh。

原生暂停冻结 tick，单步到目标 end 时确认事件队列完整消费、无事件丢弃、池/爆发实例消失且同帧产生痕迹；再单步60 tick确认该痕迹回收。两层均 Stop 后实际销毁14纹理和缓冲，Play账目归零；重新 Play 加载就绪再 Stop 通过。正式场景/生产源码资产的逐文件 SHA-256 验收前后相同。

坏资源回归单列：同一工具提交的 `fallback-final/result.json` 为 **16/16、EXIT0**，命令输出在 `fallback-command.log`。`--bad-pool` 仅拦截本测试 tab 的 `comic-acid-pool.svg`，返回无效SVG，场景与真实攻击路线不变。原生清波后仍有真实酸池/伤害阶段，资源诊断明确，GPU未把不可画实例标记成功，原绿色危险池保底继续可见；13张已加载纹理释放、重开及同攻击结束/痕迹回收均核对。它是故障注入，不能与正常14纹理美术样张混称。

R3 初版相关现有 enemy planner **3项**回归通过，覆盖阶段/真实直径/结束、预算及不可画纹理保底、blocked不成池和不可变自爆位置；不是用这些模拟单测代替上述实战。`node --check` 通过。初版仅工具/文档变化，当时未重复 R2 的全build/scene门禁；architecture 与知识目录按当时影响检查，工作区三条既有知识诊断仍单列。后续 R3-V01 资产修复已补完整 `scene:check` 与这3项 owner 回归。

本次没有自然命中障碍物的 blocked 酸液样本；保留现有相关单测能力证据，不声称已补齐该自然路径。也未重新认证全部设备或24只E03持续轰炸的帧率。旧 `explosion-01/02`、`acid-01/02`、`fallback-01` 的工具时序/错误等待或站桩死亡记录保留；不覆盖为通过。初版 `db1d2a6` 到 `4bf299f` 只有文档变更，hash复用仅适用于该历史范围，不能用它证明 R3-V01 新资产已验收。队列独立 Audit/Reviewer 仍以修复后的最终 SHA 判定。

### R3-V01 末端痕迹可读性修复

首次独立 `audit-final` 的生命周期/GPU/释放29项通过，但正常镜头看不清末端痕迹，结论为视觉失败，未覆盖成通过。原因是原1.3m/0.85s图案仅稀疏深线，和暗道路低对比，且新酸池/身体会遮住痕迹。

修复只修改 `comic-ground-mark.svg`、`comic-enemies.vfx.json` 的 ground-mark 和对应两个 sidecar：单帧128图集改成非闭合粗暗焦痕、沙灰折裂边与少量碎屑；装饰尺寸2.2m、持续1.2秒，前70%保持、末段淡出。没有亮绿池、闭合预警圆或发光危险区的语义。真实酸池/爆炸半径和end tick、地面锚点、深度/身体遮挡都不变；GUID、帧数、纹理数量与256池预算不变。此glyph也用于pounce结束，走相同surface shader和end消费；相关owner回归覆盖原pounce不可变落点，第三层普通收尾全景同时可见其沙灰裂痕。

探针仅追加同一目标end后的8/16原生Step全景，保留原首帧；酸池4秒期间持续原生避险，临近目标end才暂停，后续酸液自然落到别处。没有过滤普通镜头的其他特效或隐藏敌人。`mark-fix-03` 两路线 **29/29、EXIT0**，`mark-fix-03-command.log` 保留输出：酸液attack16/source17/generation2的end后，首帧仍有别的真实池；+8tick后其他池自然结束，叉车下方道路的同key焦痕可清楚指认。`acid-mark{-1,-2}.png` 与 `explosion-mark{-1,-2}.png` 为普通镜头连续帧，均保持真实敌群和危险提示；不是仅凭ROI阈值结案。该酸液序列HP83.4且running，爆尸回收时HP46且running，后续60tick自然回收发生在Stop前。

完整 `scene:check`（含15项场景测试）与3项 enemy planner 回归通过，原始输出在 `mark-scene-check.log` / `mark-owner-tests.log`；只改资源和验证工具，不增加生产TS依赖，未重复全build。提交后的源码/资产/工具逐文件hash与 `mark-fix-03` 比较，证明最终交付包含同一套已测新字节；独立Audit再对最终SHA评审正常镜头。旧坏纹理16项只保留其对应版本的故障/装配/清理证据；失败注入、资源加载、planner和危险保底生产代码未改，当前ground-mark新字节由本轮健康实战重新验证，旧hash清单不能证明新资产已验收。

身体或仍有效的其他酸池依然可以正确遮住残留；需在后续真实露出的短暂时刻观察，不保证每一帧可见。装饰尺寸不表示伤害范围，灰色残留不继续伤害；新的绿色池仍按自身真实阶段生效。`mark-fix-01/02` 的重叠样本和原 `audit-final` 视觉失败均保留。

复跑正常两路线与独立坏纹理回归（必须先有本checkout的5100服务；探针不会自动启动服务）：

```powershell
node tools/verify/vfx-acid-explosion-probe.mjs --headed --out .workbuddy/tmp/vfx-acid-explosion/recheck
node tools/verify/vfx-acid-explosion-probe.mjs --headed --only acid --bad-pool --out .workbuddy/tmp/vfx-acid-explosion/fallback-recheck
pnpm exec vitest run packages/zombie-game/test/enemy-vfx-planner.test.ts
```

工具默认使用独立 `.workbuddy/tmp/vfx-acid-explosion/chrome-profile` 和 CDP9343；端口占用即退出。仅关闭本次创建的Chrome，不碰用户标签或固定profile，不重启/停止既有5100，不写回场景。
