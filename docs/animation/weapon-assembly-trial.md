# 真实武器装配试验入口

当前试验与三floor已配置七件真实模型和六件独立换弹附件，复用v17 assembly、单一Spine层/双手IK与Play ledger。93572b5及c19f3b2的正常TLS、真实GPU输入与生命周期证据仅对应当时Pistol/Launcher版本；新五本体、切分区域、附件离回槽、近景Camera和全动作握姿仍待本轮headed验收，整个接入请求未完成。2026-10-12 WPN-02～06本体已齐，下文“次日交付”保留为c19f3b2历史事实。

## WPN-20261012 本体原源检视

交付真源为 `assets/_delivery/WPN-20261012/delivery.json` 与五件同名 GLB。检视场景 `assets/scenes/sandbox/weapon-body-source-review.scene.json`（`sc_weapon_body_source_review`）已登记，入口：`https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-body-source-review.scene.json`。这是原 5198 试验服务的新场景入口，不变更固定5100约定，也不把创建入口写成 GPU 验收。

场景有20个静态模型：每行一件，依次侧面、正长轴端面、俯面、负长轴端面。Shotgun 行为 `侧+X / 端+Z / 俯+Y / 端-Z`；其余四行为 `侧+Z / 端+X / 俯+Y / 端-X`。节点稳定ID为 `nd_wpn_body_<行0..4>_<列0..3>`，行顺序为 Shotgun、SMG、Sniper、Chainsaw、Flame。选择准确 Hierarchy 名称后单独按 F；节点旋转已把标注原源方向朝向编辑相机+Z，无需操纵 gizmo。每件四副本使用同一展示尺度，非米制；炮口正号、握区和分件区域均待 headed 目检。

| 原源 | 三角数 | 节点变换后长轴 | 位置焊接连通块（面数） | 后续LOD预算 |
|---|---:|---|---|---|
| WPN-02-SHOTGUN | 100000 | Z | 1（100000） | 5000 / 2500 / 800 |
| WPN-03-SMG | 100000 | X | 2（98310、1690） | 5000 / 2500 / 800 |
| WPN-04-SNIPER | 99984 | X | 2（97618、2366） | 6000 / 3000 / 1000 |
| WPN-05-CHAINSAW | 100004 | X | 1（100004） | 6000 / 3000 / 1000 |
| WPN-06-FLAME | 102494 | X | 2（102194、300） | 6000 / 3000 / 1000 |

五件均为1 mesh/1 primitive、无skin，节点X旋转90°，BaseColor为4096²；源GLB/preview/delivery未修改。`assets/art/models/<完整ID>/source-report.json` 保存源hash、节点变换、实际 final parse bounds、目标规格、位置网格焊接统计与副本旋转；同名 raw sidecar 保存稳定GUID，导入显式 `normalizeHeightM:null/upAxisFlip:false`。位置焊接容差1e-6源单位，仅统计，不删面或认定语义部件；Flame测得23 boundary edges/2 nonmanifold edges，其他四件为0。没有命名/抽取护木、弹匣或罐体，不能将小连通块冒充这些部件。尤其SMG固有弹匣和Flame固有罐体/软管需与昨日附件对照，防止重复几何；Shotgun护木命名意图不等于现已独立分件或泵动实现。

后续按长度等比规整为Y-up/炮口+Z（符号待确认），实测其他外廓而不非均匀硬凑规格；保留旧Pistol+Z/Launcher+X兼容。主握位置以 `parseGlb(buffer,null,y)` 最终XZ居中/Y贴底空间保存socket并报告pivot偏移，不修改全局导入器。当前检视仅使用已有BaseColor路径，不认证完整PBR。

工具：`node tools/art/prepare-weapon-body-review.mjs --check` 验证当前source/sidecar/report/节点/GUID/旋转/展示尺度；不带参数仅首次创建，已有场景拒绝覆盖。`node --test tools/art/prepare-weapon-body-review.test.mjs` 检查UV seam位置焊接及正负端面朝向，2项通过。源准备与 `--check` 均通过；scene:check 为246资产、20个v17场景及15项跨文件测试通过，既有LOD/P0/音频检查通过；knowledge:check 为137条、0错误，architecture:check 为280个生产文件、0错误。上述离线检查不替代源模型视觉验收。

94c68a1 原源 headed CUA 取得11项有效视图：Shotgun +Z、SMG/Sniper/Flame -X 内孔与侧面可辨；SMG固有弹匣、Flame固有罐/软管可见但没有证明自然可拆。电锯端面未辨明薄齿端，侧面与 node-baked 截面厚度（-X前三段Z厚 .030–.050，中央壳体 .266–.384）支持 -X 齿端推断，仍待规范化实际持向复核。该批没有读取GPU adapter、没有本地PNG，不能认证vendor或虚构截图证据。

本体LOD管线 `tools/art/build-weapon-body-lods.py` 复用既有node-baked加载、QEM和源表面转移；每档独立1024逐面atlas，均等比按源长轴归一到规格长度，实际宽高差见各 `assets/art/models/<ID>/lod-report.json`。Shotgun 5000/2500/800，SMG 5000/2500/800，Sniper 6000/3000/1000，Chainsaw 6000/3000/1000，Flame 6000/3000/1000；位置焊接后各档非流形为0。首次无拓扑保护QEM新增边的失败计数保留，正式候选显式 `preservetopology=True, selected=False`；Flame派生输入仅移除3个非流形邻面、补17面封局部孔（原源23边界/2非流形→派生0/0），源不改。MeshLab补孔会选择新增面，未显式 `selected=False` 时QEM曾未减面而导致atlas失败；管线现在在atlas前拒绝超预算。15档RGB五面内采样平均误差约1.7–4.1/255，不代表完整texel/美术通过；Chainsaw LOD2面积比 .883、细齿损失待GPU确认。

检视入口：[本体Raw/LOD三向](https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-body-lod-review.scene.json)。60mesh，每行一件，每组Raw/LOD0/LOD1/LOD2；各组三向为侧+X、枪口+Z（电锯齿端候选）、俯+Y。节点 `nd_body_lod_<行0..4>_<组0..3>_<向0..2>`，每件共用展示比例，不按每LOD包围盒另缩放；raw变换补偿与LOD parser recenter都来自报告。该LOD里程碑a792bf4尚未挂三floor；后续下面的切分/装配阶段已配置候选，仍非美术批准。

复验：`node tools/art/prepare-weapon-body-lod-review.mjs --check`；`.workbuddy/tmp/art-python/Scripts/python.exe tools/art/build-weapon-body-lods.test.py`（3项空间/实际输出预算/焊接拓扑检查通过）；`pnpm run scene:check`、`architecture:check`、`knowledge:check`。首次sidecar漏写 `userData.file` 导致15项元数据门禁失败，已仅补齐本次sidecar文件标签并保持GUID，未用全局scene:gen覆盖。

CodeGraph在当前检出 roots=apps/assets/packages/tools 执行一次 `incremental-index --no-embed --json`：13files/99nodes/507edges、本次parse errors0、结构ready；输出index.lock被另一个进程持有的竞态警告，没有删除锁/全量重建。当时向量6563/6896；后续只读health显示1058files/6933nodes/17450edges、embedding100%、5既有解析恢复、7417未解析调用、Snapshot absent。没有为embedding重复刷新或等待，不能据这些计数认证无竞态或源码调用全部可解析。

## 持久入口与测量

2026-10-12切分/装配候选：`tools/art/build-weapon-fit-parts.py`按node-baked空间区域切真实三角边并插值UV，封局部孔；SMG移出区为x<-.09且y<.30，Flame后can及冲突return-hose段为x>.19且y<.395。保留原源/完整本体候选，不按UV seam组件假分件；这些平面是否侵入receiver/握把、残留固有附件需GPU检查。七组各三档面数：SMG无mag 5000/2500/800、Flame无can 6000/3000/1000、SMGfitmag 400/200/80、狙击派生mag 400/200/80、Fuel罐680/336/122、Shell局部底火修复340/170/68、Launcher派生弹丸340/170/68；位置焊接边界/非流形均0，独立逐面源采样atlas均1024。各 `<variant>-fit-report.json`保存原source/hash、切平面/增删面/cap区域、XYZ缩放、各LOD几何/采样误差与parser偏移。props有明确非均匀fit缩放，法线由最终变换几何重算；本体继续等比。

Fuel仅删除源note许可的冲突软管区，保留罐/阀；拓扑保护QEM实际970面floor，采用几何QEM留封孔余量。native fallback后无条件串联清理曾access violation；现在按真实非流形/边界条件处理，三边残孔显式封口，未安装依赖或用拆顶点掩盖拓扑。Shell只截源底火X>.174（约长2.1%）并取原黄铜有效texel封局部端；红壳/rim保留，仍需确认没有新橙楔/条纹。狙击mag来自SMGmag、Launcher弹丸来自Shell，交付缺口仍明确，均为本地派生而非WorkBuddy新生成；Launcher弹丸不宣称完整火箭造型。

候选入口：[部件/槽口对照](https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-fit-review.scene.json)，当前44mesh。`nd_fit_<weapon>_assembled_0/1`为侧/俯主体，`_child_0/1`为同坐标独立附件；SMG/Flame另有`_integral_0/1`切前、`_cut_0/1`切后无外挂件；`nd_fit_prop_0_<LOD0..2>`为Shell底火-Y、`nd_fit_prop_1_<LOD0..2>`为Fuel罐阀侧面。新增`nd_fit_prop_0_source`、`nd_fit_prop_0_source_side`、`nd_fit_prop_0_derived_side`、`nd_fit_prop_1_source`提供原源/候选同角度同fit缩放对照，原源保留软管和底火区域。选择可见Hierarchy准确名称后F。各组共用尺度，包含实际v17 parent/child socket变换，不借另一渲染器或额外静态地面超容量。

`node tools/art/calibrate-weapon-models.mjs --check`核对sidecar默认socket、scene覆盖、seed和三floor。新本体source测量点通过源node-baked旋转/等比scale/full-body pivot/各LOD实际parser recenter转到final import-space；旧Pistol+Z、Launcher+X主握与hold保持。Launcher仅scene assembly覆写后盖magazine位置并增加派生弹丸。七件模拟marker按各actorY和capsuleHalf=.90重新推导，未改伤害、弹量、攻击/换弹时钟。Shotgun/Sniper初始主掌actorZ=.12造成bind support越界55/78mm，root向身体回收.105m至Z=.015；SMG初始换弹越界34mm，上移root .05m仍6.6mm，最后上移.09m。原socket与骨长保留，CPU可达不认证实际持姿或遮挡。

`node tools/art/check-weapon-fit.mjs`使用实际H01、RuntimeSession fire/reload与一次bind采样/IK，四向及相位共388样本。新五件手目标残差最大<2.8e-7m、非melee同tick fire origin误差<2.9e-7m；旧Pistol未采样Spine时20个换弹样本有最大55.2mm左手诊断，工具如实退出1，不能记为388帧全通过或据此盲改已有hold。原始`.workbuddy/tmp/wpn-integration/seven-fit-cpu.json`保留所有诊断，上身/头pointer未提供，IK_TARGET存在。新固定目标必须实际运动/Spine/换弹复验；旧target18/18不能免除本轮Pistol可见附件验收。

离线相关检查：部件切割UV插值/面积守恒、封孔拒绝分叉及21件实际LOD预算/hash/位置焊接拓扑三项Python测试通过；99项owner回归和8项Node工具/生成默认测试通过。首次typecheck暴露旧测试将JSON直接强转WeaponArsenal的tuple不兼容，已改为正式validWeaponArsenal入口校验。该修复不改变业务schema。

补充回归diagnostics测试1项通过，typecheck与editor:build通过（保留Vite大chunk提示）；scene:check为282资产/22个v17scene/15跨文件测试及既有LOD/P0/audio通过，architecture为284生产文件0错误，knowledge137条0错误。三floor语义比对只改变model/assembly/muzzle及dependency，Camera、玩法数值与其他组件相同；原交付目录已追踪文件无diff。CodeGraph在本检出roots=apps/assets/packages/tools一次incremental --no-embed：88files/211nodes/571edges、结构ready，runtime-weapons测试1文件解析恢复、旧锁竞态警告、6401/7029向量；未删锁/全量重建/等embedding。定向overview覆盖RuntimeWeapons.summary/afterPose与新fit工具prepared/build/main和真实Input入口；私有符号有导出筛选限制，不认证调用全面解析。原始codegraph-seven-fit.log及三份overview JSON均留ignored证据目录。

独立场景 `assets/scenes/sandbox/weapon-assembly-trial.scene.json` 已登记在项目 scenes。本次独立试验服务的已验证证书域名入口为 `https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-assembly-trial.scene.json`。仓库固定5100服务契约未改；不将localhost视为本次TLS可达入口。场景持久化H01 rig、SharedMotion Spine层、双手BodyIK、Light与七件武器库；当前trial Camera为distance1.8m/pitch0°/yawOffset−90°/camera节点Y1.18m（现有orbit-follow取该锚点高度），三floor Camera原样。ac8295c旧视角为2.1m/15°/-30°，不能用其遮挡画面批准当前视角。没有运行生成器覆盖三层。

编辑态的 `nd_pistol_inspect_0/1/2` 是同尺度侧面、+Z 端面与顶面副本，选择节点后按 F 聚焦；它们在 Play 隐藏。Pistol 的 final parseGlb 长轴实际为 Z；93572b5 的真实 GPU 静态 +Z 端面观察确认上方圆形炮口与内环。Launcher 已有 LOD0 +X 炮口观察；端面观察不认证握姿或弹道。

`assets/art/calibration/weapon-assembly-trial.json` 记录原资产 GUID、sha256、最终 import bounds、socket、H01 手掌 contact 候选和 CPU 结果。GLB 未改写。H01 contact 来自规整化腕到手尖的 0.163659m 量程，仍需可见掌心/手指贴合检验。Pistol 原本体握把为整网格，新增 Mag01 在槽内可能重叠；卸出附件不会自动删除原 mesh 的固有轮廓，不声称已经精确匹配。

## 表现与资源责任

`packages/zombie-game/src/presentation/weapon-model.ts` 只消费已有 WeaponSystem 的相位、recoil、player.yaw；先在瞄准空间 pitch，再适配 Pistol +Z / Launcher +X 模型轴。换弹附件阈值来自既有 procedural 配置。编辑器 `services/runtime-weapons.ts` 负责 GUID/sidecar 解析、异步加载、renderer 中性端口适配和逐 GPU 资源登记。

Renderer 一次 base/Spine 采样、一次 IK 后输出最终骨矩阵；右手实际结果决定武器，再决定左手。有效同帧骨口、实际 IK 和 visible draw 全部具备时才隐藏 Canvas 武器占位。缺配置、缺骨、GUID 错误、失败/取消仍有诊断并保留兼容表现。Stop 先失效 generation 和 AbortSignal，迟到 bitmap 关闭；已创建 buffer/texture 全部立即进入同一 PlaySession ledger，disposer 幂等。

正式模型 socket 用最终模型 local 坐标。模拟 `presentation.markers.muzzle` 仍由确定性 fireStep 消费，使用 capsule centre 相对 yaw-local 坐标，不能直接复制 model-local socket。P-01 capsuleHeight 的真源是 `packages/content/src/generated/stats.generated.ts`，半高 0.90m；Pistol 理想零 recoil 枪口 `[.480,1.347,.080]`、Launcher `[.715,1.360,.030]` 是相对 actor 原点的 yaw-space 世界偏移，marker Y 另加场景 actorY 后减 0.90m。独立场景 actorY=0，三层 actorY=.02，分别校准。生成器版本17和纯默认适配同样按实际作者高度计算；保留已有 MeshRenderer 全部配置，仅新玩家使用真实 rig 与双手默认控制。

真实 RuntimeSession 的 setAim/setFire/step 四向测试验证模拟 from；实际 H01 bind-pose 一次 IK/FK 探针与同 tick from 的最大误差约 2.9e-7m。该探针没有采样 SharedMotion、未提供 torso/head pointer，保留 IK_TARGET 诊断。运行时 reach clamp、动画、移动、后坐力及 GPU 掌心接触必须复验；模拟不读取 renderer 反馈。VFX 从同帧实际模型 muzzle 捕获视觉起点，弹道和伤害仍由原模拟决定。

## 只读观察与验收

`window.__editor.weaponModels.snapshot()` 是隔离数据副本，包含 `pending/loaded/generation/simulationTick/pose/visible/visibleDrawCount/frameStamp/muzzle/ikDiagnostics/measurements`。右手/左手位置残差以未 clamp 理想目标和同帧实际依赖目标计算，方向误差用弧度；`muzzleYawErrorRad` 使用 muzzle socket 的 +X 世界向量。`lastShotOriginTick/sameTickShotOriginResidualM` 仅在效果 tick 等于当前模拟 tick-1 时提供，历史射击不与移动后枪口比较。`modelMuzzleToSimulationMountM` 只是不同语义点的距离，不能当成弹道错误或验收通过。

已有 `__editor.bodyIk.summary()`、`__editor.motions.summary()` 与 Animation Debug 面板可交叉检查；Play 面板/EditorAgent runtime 提供 ledger、模拟 tick、cycle 和诊断。1/7 切 Pistol/Launcher，R 换弹，移动同时按住鼠标开火/换弹；必须通过真实键盘 keyDown/keyUp 和 mouse 事件保持并发输入，单次点击或快照不证明持续操作。检查腿部 locomotion 持续、Spine 动作和 IK、弹匣实际装卸、四向枪口、Pause 双时钟、Stop ledger0、重启身份和迟到取消。保存固定 HEAD/场景 hash/HTTPS secure context/NVIDIA GPU 与有效视角截图后，才能写实机结论。

93572b5 实操原始记录在 `.workbuddy/tmp/wpn-integration/play-audit-93572b5/observations.json`：正常 TLS/NVIDIA Lovelace、真实 held 移动与开火、Spine shoot 和下半身 walk_f、7/1/R、Pause 双时钟、Stop 作者回滚/ledger0 与 restart 共 18 checks 通过。PNG 为背视，不能据此批准手枪、Launcher、Mag01 细部。独立 CUA 正/斜前观察见 `cua-front-observations.json`：Launcher 扣弹且左手位置不可达约 .008m；Pistol R 完成，但弹匣被手/躯干遮挡。该 CUA 批次没有本地 PNG，不将可见工具输出伪写为图片文件。

脚本中 5 次 Pistol `IK_SOCKET_RESIDUAL` 的位置约 1e-8m，角度约 .00020–.00046rad；最终归一化矩阵方向误差约 1e-7rad。原 FK quaternion 的范数没有录入该批证据，不能断言全部误报。本轮角距离改为 `abs(dot)/(normA*normB)`，保持原 1e-4 门槛和真实位置/部分权重/不可达诊断。Launcher .008m 是另一个位置问题；该记录没有目标、肩位及朝向，不足以决定 holdPose 修正方向，本轮保留原数据，先收同帧链位置与装配请求。

美术证据边界：此前 Launcher LOD0 三面、Mag01 LOD0 两面及 Shell 原件/旧新 LOD0 底火观察仍有效。新增 15 个有效静态焦点记录在 `.workbuddy/tmp/wpn-integration/static-audit-93572b5/observations.json`：SMG/Fuel 原件侧面、SMG LOD0 插入端、Fuel LOD0 侧面、五件 LOD1/2 侧面及 Pistol +Z 端面。Launcher LOD1/2 管身/握把可读；Mag01 LOD2 棱角与黑缝、SMG 暗缝仍在；Shell LOD2 橙楔侵入红壳及底边锯齿，底火仍未批准；Fuel 各档带面斜纹与管阀视觉分离仍为候选。没有全端面/全 PBR/本体精确 fit 批准，不启动全批 LOD 重设计。

相关验证：`pnpm exec vitest run apps/editor/test/runtime-weapons.test.ts packages/zombie-game/test/presentation/weapon-model.test.ts packages/zombie-game/test/presentation/weapon-muzzle-calibration.test.ts packages/scene/test/level-scenes.test.ts`；`node --test tools/level/weapon-assembly-defaults.test.mjs`；`pnpm run scene:check`、`architecture:check`、`knowledge:check`、`typecheck`、`editor:build`。

本阶段离线验证：90 项首次定向测试、旧HUD1项和模型占位/同tickVFX1项通过；scene:check 为246资产/19个v17场景、15项场景测试及既有质量/音频门禁通过，architecture为278文件，knowledge为137条，typecheck、editor:build与示例build通过。三层语义核对只允许Pistol/Launcher表现与玩家BodyIK变化，4件sidecar GUID/sourceHash保持。CodeGraph在本检出 apps/assets/packages/tools 有界刷新96+2文件；当前health为1050files/6889nodes/17320edges、5个解析恢复文件、7341未解析调用，healthy=true，但锁竞争警告和embedding6251/6851(91%)仍是限制，不将图谱完整性或测试数量当成可见验收。

## 本任务 headed 输入探针

本轮可选 `--all-weapons`，默认仍为原Pistol/Launcher流程。七件模式按真实Digit1～7持续采样：1手枪hitscan＋Mag01、2霰弹pellets＋逐Shell换弹、3SMG hitscan＋独立弹匣、4狙击piercing＋SMG源短弹匣、5电锯melee（reloadMode:none，无假换弹附件/链条动画）、6喷射器flame＋Fuel罐、7发射器projectile＋Shell源弹丸。开火或攻击均是真实鼠标按住；W/S交替移动，R触发原WeaponSystem换弹，不setInput/注入phase。每件记录实际Spine/base、phase、子draw矩阵与frame、out/mid/in原始上下文/clip截图；脚本数值检查不批准遮挡画面。静态候选44槽与实际trial分别加载，不能以静态装配图代替离回槽实操。

`weaponModels.snapshot().attachmentDraws`是本帧提交GPU的子draw `{id,guid,removed,frameStamp,worldMatrix,worldCorners}`副本；worldCorners为final import包围盒八角经实际draw矩阵变换的结果，用于截图包含整件附件，不是GPU readback。sync/frame失效与Stop清空，禁止反馈到时钟/下一帧IK。采样frame须同时匹配主draw和子矩阵，矩阵变化仅佐证，不替代可见几何。近Camera改变后旧c19取景证据不认证本轮视角。Audit按真正无遮挡地面选择主/侧aim-ratio，或使用下面的世界方位投影；工具先核ground ray，不把请求角度名字当实际朝向或槽口可见批准。

七件命令沿用下面root/SHA/URL，在末尾加 `--all-weapons --aim-ratio '按可见地面填写x,y' --side-aim-ratio '按可见地面填写x,y'`。120秒操作预算保持；模型/输入失败或截图遮挡如实记录，Worker不预运行浏览器或声明七件GPU已通过。

`tools/verify/weapon-assembly.mjs` 是本任务受控入口，复用 editor-smoke-lib 的 Cdp/等待与可见 Chrome，显式 `ignoreCertificateErrors:false`；不使用 ensureServer、normalizeEditorState、localStorage 修改、Security bypass 或手写 DOM dispatchEvent。旧冒烟调用的 HTTPS 默认仍保留，不能拿旧默认声明正常 TLS 通过。本入口不启动/重启 dev server。

运行前将参数里的 SHA 替换为 Main 提供的完整冻结 target，并在本检出根执行：

```powershell
node tools/verify/weapon-assembly.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head '填入冻结的40位SHA' --cdp 9348 --url 'https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-assembly-trial.scene.json' --out .workbuddy/tmp/wpn-integration/weapon-assembly-headed
```

工具先核对 root/cwd/HEAD、证据范围、保留 profile 的实际 Chrome 命令行与 CDP 端口空闲；冲突或归属不可读立即退出，不删除 profile、改随机 profile 或 kill 他人浏览器。启动后再比较 SystemInfo browser PID 和本次 spawn PID，防止 Chrome 复用其他进程。正常 TLS 导航失败时退出；不忽略证书、不降级 HTTP。headed 窗口记录 secure context、NVIDIA/Lovelace、控制台与异常。

通过真实可见 Play/Pause/Stop 按钮、实际 Canvas 点击及 Input.dispatchKeyEvent(key/code/Windows VK)/dispatchMouseEvent 持续操作。W 与鼠标开火同时保持，移动键保持期间按7/1/R；射击后真实W→S切换，换弹中再W→S折返，避免小场景边界持续阻挡，采样角色位置、实际发射、武器 phase、下半身上传矩阵/clip/time、同帧模型与残差，再 Pause/Stop/重启。首屏与两次Stop读取作者renderer玩家pos/quat/scale/visible/nodeId及内存document序列化SHA256，逐项比较回滚；Stop后从持久playerStart定位玩家，不依赖已经为null的runtime.player。Chrome/CDP连接30秒上限，PID核对和Play CDP命令10秒上限，连接后的操作预算120秒；释放已按住的键/鼠标，关闭本次target/进程，不处理其他标签。

换弹截图阈值直接读持久Pistol procedural phase，每张记录相应sample索引和时间，不把末尾完成画面当成Mag01离枪证明。证据 `observations.json` 与8张可见上下文截图、最多3张换弹离枪/中间/回位截图留在 out；失败的输入/模型/资源检查和未覆盖事实原样保存，退出1。`passed` 只代表该次输入与生命周期检查，CPU skinScratch不是GPU readback，手指贴合/细节质量仍由 Audit 看有效画面。迟到 decode 未被此实操人为制造，静态LOD补充也未覆盖，不能因测试或脚本退出0改写原未完成项。工具5项参数/归属/异常释放测试命令：`node --test tools/verify/weapon-assembly.test.mjs`。a76阶段的CUA仅证明场景可见/Resume，未证明W持续移动或7切换，不能据此判断产品bug。

可选 `--aim-ratio 'x,y'` 和 `--side-aim-ratio 'x,y'` 使用当前 canvas 内 .05–.95 的比例；由 Audit 根据可见地面选择，不能把比例名称当成正面/侧面认证。未传参数保持旧中心行为。指定点必须是无遮挡 canvas，并由既有 `renderer.pointerRay` 正向命中持久 plane 范围和游戏 .9m 瞄准平面；不命中或被 UI 遮挡即失败，不注入 aim/角色状态。真实 `Input.dispatchMouseEvent(mouseMoved)` 后短采样 Pistol、Launcher 两个请求方向并记录实际 pointer、player.yaw、pose、frameStamp；有主点时回到主点执行原移动/换弹流程。新增最多 6 张姿态上下文截图。

每个样本额外只读当前 attachment request/result，以及从本帧 skinScratch × 规整化 inverse-bind 原点恢复的六个肩/肘/腕位置，可核对理想目标距肩和实际链长度。该恢复不重新采样或执行 IK，不改变模拟。指定主瞄准点时，out/mid/in各留原始全页上下文与近景PNG，裁切同时包含前臂/手及本帧child的八个包围角投影，记录clip、关联sample/phase与截图前后frame范围；不伪称截图锁定单一GPU帧。无可用同帧投影即失败。裁切不消除遮挡，仍须Audit目检附件是否实际可见。当前只有trial Camera改动；三floor Camera、Launcher holdPose/markers与生成种子保持原值。

本轮最小离线回归：BodyIK 16 项和工具 5 项通过，含 quaternion 范数漂移、真实部分权重/不可达残差、瞄准参数边界/无效射线及只读链位置恢复。工具测试有效命令仍为 `node --test tools/verify/weapon-assembly.test.mjs`。

## c19f3b2 阶段回执与待交付项

实机目标为 `c19f3b29dac82255e49ac03aa39dc7ee931d65c4`。两批原始记录分别在 `.workbuddy/tmp/wpn-integration/play-audit-c19f3b2/observations.json` 与 `play-audit-c19f3b2-side-reload/observations.json`，均为正常 TLS、headed NVIDIA/Lovelace，18/18 checks、console/exception 0；场景 SHA256 均保持 `8E5CEB334C788FFD8A4535947BEAFBBEAC70552C007BD9BC053394D84179570B`。Pistol/Launcher 在正面及侧面实际可辨；移动射击、切枪、移动换弹、Pause/Stop 回滚/资源归零及 restart 的阶段验证完成。该结论不是全姿态或五件美术批准。

两批样本均没有 `IK_SOCKET_RESIDUAL` / `IK_UNREACHABLE`；其他目标缺失和侧向 head `IK_AIM_LIMIT` 诊断仍保留。第一批 Launcher frame507/tick245、yaw=2.623345：右理想目标残差 2.071e-8m、左依赖目标残差 2.956e-7m，muzzle yaw 误差 4.616e-8rad；左上臂约 .2430m、前臂 .2619m、总长 .5048m，目标肩距 .4786m，约 94.8% 可达长度。此前 CUA 的约 8mm 位置残差未在这两方向复现，不能否定旧观察或扩大为全姿态通过；目前没有实际数据支持改 holdPose/marker，校准、Camera、模型与生成种子保持原值。

两批 `09/10/11-magazine-*` 虽有原始 clip 与关联 sample/frame/phase，但 Mag01 仍被手、枪和身体遮挡，离槽/回槽几何未目检通过。侧批 out/mid/in 分别为 phase .2292/.4375/.7292、frame594/613/639，关联样本 yaw 均约 .683；该批其他时段朝向也有变化，文件名“side”不能证明全程侧向。下一步需取得真正可见的弹匣过程证据，不能以 phase 或附着等式替代。

用户明确 WPN-02～06 本体次日才能完整提供；收到真实模型后才能标定对应附件精确 fit。Shell 底火/LOD2、Fuel 条纹与管阀视觉分离等候选缺陷仍未批准，其他静态边界见上文。整个原五件接入任务尚未完成；Final Reviewer 尚未创建，也没有全队列批准。本次收尾仅更新文档，不更改源码、测试、资产或校准数据，不重跑浏览器与场景门禁。

## 固定候选视图原始 PNG 入口（2026-10-12）

`weapon-assembly.mjs --static-scene <路径> --nodes <逗号分隔稳定NodeId>`只允许登记的60网格本体LOD场景和当前44网格fit场景，每次1～12个唯一节点。默认不传时仍走原Play路径。静态模式复用正常TLS/headed硬件、保留profile归属检查及自身cleanup；不进入Play，不改相机/变换数据，不调用内部选择接口。实际mouseWheel定位可见Hierarchy名称行、点击，再真实KeyF聚焦；先等待资产与Hierarchy精确名称同步，拒绝陈旧fallback列表。Inspector精确名称及可见文字行、Save disabled、作者节点指纹、F后相机target与实际对象bounds中心逐图核对。

```powershell
node tools/verify/weapon-assembly.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head '填入冻结的40位SHA' --static-scene assets/scenes/sandbox/weapon-fit-review.scene.json --nodes nd_fit_smg_integral_0,nd_fit_smg_cut_0,nd_fit_flame_integral_0,nd_fit_flame_cut_0,nd_fit_prop_0_0,nd_fit_prop_1_0 --out .workbuddy/tmp/wpn-integration/static-fit-audit
```

本体LOD示例用`--static-scene assets/scenes/sandbox/weapon-body-lod-review.scene.json --nodes nd_body_lod_3_1_0,nd_body_lod_4_3_0`。本体ID结构为`nd_body_lod_<0～4:霰弹/SMG/狙击/电锯/喷射器>_<0原件/1LOD0/2LOD1/3LOD2>_<0侧/1端/2俯>`；fit可选`nd_fit_<武器>_assembled_0/1`、`child_0/1`，SMG/Flame另有`integral_0/1`与`cut_0/1`，Shell/Fuel为`nd_fit_prop_0/1_<0～2档>`。不存在/非资产NodeId或GUID失配在启动前拒绝；不使用隐藏OPTION坐标。

输出每节点原始全页PNG及`observations.json`，保留冻结HEAD、工具/helper hash、scene hash、AssetRef/GUID/GLB及meta hash、实际UI身份、editorCamera/bounds、截图前后frame范围、GPU/错误/cleanup记录。PNG未修补；frame范围不伪称截图锁定单一GPU帧。模型仍须人工检查端面、UV、轮廓、遮挡和重复附件；静态退出0不批准美术或换弹离回槽。

工具7项定向Node测试通过；未提交工具在资产target `b8f60c3`上的小样（工具hash独立记录）为fit两节点6/6与body单节点5/5、正常TLS NVIDIA/Lovelace、console/exception 0，作者数据/场景/HEAD保持，浏览器关闭后9348空闲。原始证据分别为`.workbuddy/tmp/wpn-integration/static-tool-selftest-fit-final/`与`static-tool-selftest-body-2/`；只证明采集入口可用。Shell底火像素仍粗碎、其他候选与七件实际换弹须正式Audit，不能从本次工具自测改写批准状态。5198继续原PID74824，本次未重启；仓库5100固定契约不变。

## ac8295c复验后的聚焦修正（2026-10-12）

原始`play-audit-ac8295c/observations.json`及`play-audit-ac8295c-full/`保留在ignored证据目录；攻击/换弹双手FK残差小于.31微米，但31个aim/switch样本有真实`IK_UNREACHABLE/IK_SOCKET_RESIDUAL`，最大Sniper切入91.388mm。全部40个fit/30个body固定PNG已采集，六件换弹附件仍被躯干/手臂遮挡，不能据phase/draw批准离槽归位。`play-audit-ac8295c-yaw/`的两个比例被地面guard拒绝，没有实际输入，不能写成测试姿态。

`GameControls.update`原先在.9m平面取游戏aim，`targetWorld(height)`又以同一ray与1.3/1.5m相交。实测近景ray在.9m落玩家前方，在1.5m落背后，使上身与枪口目标矛盾。当前只将同帧游戏aim的XZ升到所需Y，失效仍null；不修改aimAssist、模拟yaw或输入状态。`weapon-model.ts`同时把phase驱动降枪18cm减为8cm：原降枪会让长枪support超出左臂可达范围，phase/时钟、骨长、socket与hold不变。

`node tools/art/check-weapon-motion-fit.mjs`复用真实H01、SharedMotion/Spine、RuntimeSceneMotion/BodyIk/Weapons和单次采样/FK，有限四向、1/4m目标距离、移动/切枪/攻击/原换弹共5120帧。XZ修复而保留18cm时72个失败全为equip/unequip，最大29.208mm；8cm时0手部失败，右最大3.050e-7m、左4.345e-7m、切换左4.249e-7m。`IK_AIM_LIMIT`仍保留。原失败`seven-motion-fit-before.json`、后续`seven-motion-fit.json`及`motion-fit-before.log/motion-fit-check.log`保存原始结果；这不是全姿态、DOM输入或GPU批准，也不改写旧bind/Pistol失败证据。

可选`--aim-yaw 180 --side-aim-yaw 135`以度指定世界请求方位，0朝+X、90朝+Z。工具只读当前玩家/Camera与`worldToScreen`，将玩家前.75m、Y=.9的点投到真实canvas，核UI无遮挡、射线正向命中持久地面及游戏平面、实际gameAim与请求点误差小于1e-4m，然后只发送真实`Input.dispatchMouseEvent`。移动中有界重投影并继续真实mouseMoved，未传时保持旧中心/ratio行为；同点yaw与ratio不能混用。记录实际pointer/ray/gameAim/player.yaw/phase，不能把请求角度当实际朝向批准。当前近景Camera和child范围clip仍待正常TLS/headed复验。

```powershell
node tools/verify/weapon-assembly.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head '填入冻结的40位SHA' --all-weapons --aim-yaw 180 --side-aim-yaw 135 --out .workbuddy/tmp/wpn-integration/seven-focused-audit
node tools/verify/weapon-assembly.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head '填入冻结的40位SHA' --static-scene assets/scenes/sandbox/weapon-fit-review.scene.json --nodes nd_fit_prop_0_source,nd_fit_prop_0_0,nd_fit_prop_0_1,nd_fit_prop_0_2,nd_fit_prop_0_source_side,nd_fit_prop_0_derived_side,nd_fit_prop_1_source,nd_fit_prop_1_0,nd_fit_prop_1_1,nd_fit_prop_1_2 --out .workbuddy/tmp/wpn-integration/prop-source-focused-audit
```

Shell原底火+X经Z-90°变为-Y；ac8295c的fit节点却使用+Y端旋转并误标“底火+Y”。当前改为X-90°面向真正-Y，稳定ID不变；旧该节点图像不能直接证明修补底火端，其他有效视图事实保留。`primer-fixed`是历史文件名，只代表局部拓扑截断/封口，未证明艺术上消除了碎斑。原源与候选采用同一fit缩放/材料/角度，源仍保留被截区域；F会按各自完整bounds取景，不能因软管跨度不同假称像素尺度相同。

Fuel原4096 atlas自身含密集深色横纹。有限最近源表面对照：Fuel三档面内RGB MAE .89–1.92/255，近边MAE2.75–3.22，近边新增黑点约0–.294%；Shell三档近边MAE2.34–3.17、新增黑点约.098–.980%。原始`prop-atlas-edge-diagnostics.json/log`只支持“大片暗纹多数源表面已有”，不证明完整texel/法线/LOD2棱角或GPU质量通过。本轮未重写源GLB或候选二进制；底火碎片、Fuel斜纹/阀口需看上述有效同角度PNG后裁决，源质量限制不扩大成整件重造。

WPN-02～06本体现已交付并有正式候选装配；不再把历史“次日提供”当当前缺口。整个任务仍待七件实际可达切换、六件可见离槽归位与美术边界复验，Final Reviewer尚未批准。相关原始检查日志统一留`.workbuddy/tmp/wpn-integration/focused-*.log`；按本次改动运行定向测试、typecheck、scene/architecture/knowledge门禁，不重跑无关静态30图或规模性能测试。

本次15项GameControls/模型/loader owner测试、9项正常TLS工具参数/输入释放/端面测试通过，typecheck和editor:build通过（保留Vite大chunk提示）；scene:check为282资产、22个v17场景及15项跨文件测试和既有质量/音频门禁通过；architecture为286生产文件0错误，knowledge为137条0错误。新增headed检查将所有有效同帧aim/switch/attack/reload样本的真实手部不可达/socket residual计为失败，`IK_AIM_LIMIT`继续保留，避免生命周期检查通过掩盖手部失败。当前尚未运行改后GPU探针。

CodeGraph在本检出、base `ac8295c`、roots=apps/assets/packages/tools进行一次`incremental-index --no-embed --json`：16files/130nodes/610edges，结构ready；RuntimeWeapons测试文件仍1项tree-sitter解析恢复，6677/7052节点有向量，旧index.lock竞争警告保留。不删除锁、重建或等待向量，图谱不认证全部调用解析；原始`codegraph-focused-fix-index.log/health.log`保存限制，先前MCP定位原始记录为`codegraph-focused-ac8295c.json`。

## 0aee371 后续局部修复与未通过项（2026-10-12）

`seven-focused-audit/observations.json` 的 normalTLS/NVIDIA 与 sceneId 通过，但只有2个stopped样本，实际Hierarchy仍为默认12物件；UI Play未进入运行，不能写成七件已验收。工具原先只等 `__editor + pendingAssetCount=0`，会早于作者场景、外部GLB和Hierarchy的完整同步。本轮等待由磁盘scene推导全部5个作者MeshRenderer：逐个核对稳定NodeId/name、实际loadedAssetPath、可见Hierarchy对应名称和无遮挡可用Play按钮；超时保存authorReadiness，真实点击后失败额外保存controller.error、sample与UI文字。没有setPlay或状态注入；仍须独立headed复验。

直接目检 `prop-source-focused-audit` 的10张原始PNG确认：Fuel候选新增黄/暗斜三角线，Shell候选底火的大黑楔与侧底破面加重。面绕序与角法线同向不证明端面正确。Shell原局部close_holes在源X=.174填了外圈和两条近重合内圈；LOD端面边界投影自交，安全重三角化拒绝。最后有界X=.160/.150裁切（比旧端内收约.925/1.586mm）仍自交，LOD2闭合估算82/88也超过80，未发布任何Shell或同源Launcher-round新几何。旧候选保持未批准；需源底火内折叠/自交rim修订，用户范围决定尚待答复，不以翻面或放宽门禁伪通过。

仅Fuel-fit-can三档更新独立1024 atlas：每格gutter颜色取同一目标三角的最近重心点再采原源表面，替代全局pull-push。几何/角法线逐角bitwise核对不变，仍680/336/122面，GUID/modelSockets不变；报告保留旧input hash/recipe和新增后处理hash。真实normalized UV*size−.5线性口径、1024→128的有界mip比较记录在fit-report：256px边缘均差由13.21/15.15/16.61降至5.41/6.05/5.16，128px由19.02/20.80/20.48降至9.48/10.35/8.01（RGB0..255）。LOD0原尺寸少量>40异常比例仍由.93%升至1.81%；该数值改善不替代GPU各向异性采样和三档像素批准。

复现先用原 `build-weapon-fit-parts.py --only WPN-FUEL-01-fit-can` 得到原减面stage，再用独立venv执行 `tools/art/repair-weapon-prop-surface.py --only WPN-FUEL-01-fit-can`，检查stage后加`--publish`合并GLB/meta/report；不运行全批生成。原始失败、mip前后与后处理日志在 `.workbuddy/tmp/wpn-integration/` 的 `prop-surface-diagnosis.*`、`atlas-border-probe.log`、`prop-surface-repair-shell.log`、`prop-surface-repair-fuel.log`；Shell有界裁切结果为 `cap-bounded-cut.log`。本轮不改源交付、七件hold/marker/seed或camera；上一轮5120姿态回归可复用。六件真实附件离槽/回槽与七件GPU姿态仍pending，原40/30其余静态证据不重写为全美术批准。

本轮9项工具、1项本面gutter、3项派生来源/预算/闭合回归通过；Fuel新增逐角geometry/normal hash检查，meta除sourceHash/updatedAt外与提交前一致。scene:check 282资产、22个v17场景、15项跨文件测试及既有门禁通过，knowledge137条0错误。日志为 `startup-repair-test.log`、`prop-surface-repair-test.log`、`fit-parts-repair-test.log`、`prop-startup-scene-check.log`、`prop-startup-knowledge-check.log`。没有产品TS改动，不重跑未受影响构建/姿态/GPU验证。

CodeGraph MCP 0.167.0在本根/base `0aee371`实际查project_map与main/play-controller/renderer指定module，原始 `codegraph-ready-0aee371.json`。一次 `incremental-index --no-embed --json` 更新11files/71nodes/187edges，本轮0parse错误、结构ready；旧index.lock竞争警告保留。health为1135files/7099nodes/17689edges，5个既有damaged-parse文件、7865pending resolution；不删除锁、重建或等待向量。`prop-startup-index.log/health.log`不等于完整调用解析或视觉批准。

## 3370b80 探针时序修正（2026-10-12）

原始 `seven-audit-3370b80/observations.json` 已证明真实UI Play启动、7个GLB加载/pending=0、移动射击和下身动画；180°/135°/返回三段均有样本。移动截图之后虽已发送7键，下一次re-aim被旧合并guard拒绝，没有Launcher或后续七件换弹样本，不能写成七件验证通过。

源码核对 `PickingService.worldToScreen/pointerRay` 均使用canvas的CSS client矩形，DPR/backing pixels不进入指针坐标；游戏yaw=`atan2(ΔZ,ΔX)`，180°朝-X。最后有效请求与gameAim相差约5.7µm，地面交点Z=-11.38574，作者Ground80×24的Z边界为±12，只余.61426m。旧工具截图期间仍按住W；截图后越界有时序与机制依据，但旧失败返回null，没有失败点数据，根因仍待下一次原始guard上下文确认，不归咎于坐标或角度。

本次仅工具/文档修改：guard逐次保留分项reason、实际element、CSS rect/DPR/backing pixels、requested/ray/两平面交点、作者地面范围、frame/tick；地面与1e-4m误差检查不放宽。原始PNG采集期间真实释放W/S，成功后恢复，模拟/动作时钟与鼠标射击继续，不暂停或注入状态。显式world-yaw模式持续采样时按当前地面交点与Camera yaw预留1.5m移动余量，通过真实W/S换向；双方均无余量仍失败。`movementPlan`保存请求/实际键向及对应guard帧。旧center/ratio模式不增加自动换向。

12项工具定向Node回归通过，覆盖3370真实射线的CSS投影、平移后地面越界、遮挡/平行/投影偏差明细、旋转Camera移动约定、截图输入释放/成功恢复/失败不恢复。日志 `aim-guard-tool-test.log`；本根/base3370的MCP定位记录为 `codegraph-aim-3370b80.json`。未运行本次改后Chrome；沿用上文 `--all-weapons --aim-yaw 180 --side-aim-yaw 135` 命令，填新冻结HEAD和独立out目录再交Audit。产品源码、资产、scene/Camera/hold/marker不变；原5120姿态回归与未受影响静态证据保留。七件GPU姿态与六件可见离槽/回位仍待实操；Shell/round依赖用户范围决定继续暂停，原任务尚未批准。

本轮 `knowledge:check` 137条0错误；一次 `incremental-index --no-embed --json` 更新3files/61nodes/189edges、当次0parse错误，结构ready，旧index.lock竞争告警保留。紧随health为1135files/7110nodes/17719edges、5个既有parse文件/7877未解析调用；向量已自行完成7076/7076，本轮没有等待或重建。原始 `aim-guard-index.log/health.log` 仅为定位限制记录，不能替代七件实机结果。

## 03b0818 原始结果与聚焦采样修正（2026-10-12）

`seven-audit-03b0818/observations.json` 保存293个样本、68张原始PNG与46项检查，其中Shotgun附件回位和SMG攻击两项为false，不能写成全项通过。七件真实切换、其他适用攻击/六件换弹phase、移动下身、Pause/Stop作者回滚/ledger归零/restart均有本次证据；同帧手部最大右2.7503e-7m、左3.3227e-7m，仅出现`IK_AIM_LIMIT`，不是GPU readback。Pistol/SMG/Sniper的附件离枪及重新接入区域可辨，完整slot与手指仍局部遮挡；Shotgun回槽、Fuel/Launcher过程未获像素批准。

源码与raw确认Shotgun .55s补弹完成后直接idle：旧筛选只接受reload回位，排除了有效同帧mounted child。SMG .09s fire窗口短于旧.12s间隔，旧attack-before还在mouseDown后，不能用所有样本idle否定实际射击。当前before先取再真实射击，25ms有界采样；只读已有WeaponSystem事件及runtime.firing，分别检查同武器新fire sequence、lastShot同tick、弹药/后坐或实际上层动作，以及移动下身。保留实际捕获的fire帧，不把事件存在冒称每帧都有shoot。

回槽接受完成后的idle，但必须有同帧visible child draw、相对作者actor的out/in实际位移，以及相对换弹前slot位置小于1mm的回位误差。短于.9s的换弹使用最多三次正常射击→R，每周期只指定out/mid/in之一；该阶段raw先记录，再启动原始PNG，连续raw采样继续。PNG不锁定模拟，记录trigger sample与实际capture sample/frameRange，跨越阶段时像素阶段仍未知，不把末尾idle图冒称离槽。其他换弹沿用单周期采集。所有输入仍是CDP真实按键/鼠标，不修改phase/ammo/pose。

可用`--weapon shotgun,smg`只执行选定武器的攻击/换弹及公共生命周期，仍按场景原Digit映射切换；与`--all-weapons`互斥。报告显式列selectedWeapons/executedWeapons，未选武器不构成本次批准。默认原Play和静态入口保持。

```powershell
node tools/verify/weapon-assembly.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head '填入冻结的40位SHA' --weapon shotgun,smg --aim-yaw 180 --side-aim-yaw 135 --out .workbuddy/tmp/wpn-integration/short-phase-audit
```

`prop-torso-diagnosis-03b0818.json`的CPU重放中，Fuel out六段手链位置与raw最大误差1.361e-7m，149个Hips/Spine加权顶点位于实际closed can内部；Launcher out/in误差1.859e-7/3.089e-7m，分别2/1点在round内。正数证明这些姿态存在交叠；单向0顶点不证明clear。Shotgun重放误差26–80mm，省略过渡，不能给零交点结论。既有三组侧移及三组抬高耦合候选均没有同时证明可达和分离，未发布hold修改。限定reload到双Shoulder子树、关闭torso权重及组合的idle/out/in离线对照也未消除交叠，原layer不变；记录在`prop-torso-layer-03b0818.json`，不将mask对照当原姿态复现或像素批准。实际装配位置仍待修复，Shell/round底火源质量仍等待用户范围决定。

## Launcher前孔与肩侧持候选（2026-10-12）

CPU原源实际炮管截面确认+X前孔约`.375`、腔底`.112951`，旧`magazine=-.365`落在实心后盖。当前物理槽改为模型LOD0 final import-space `[.197,.28,0]`，弹丸以真实`base`接入，长177.44mm、半径24.88mm；未改GLB/轴向/比例或弹丸底火。历史`.workbuddy/tmp/wpn-integration/1-WPN-07-LAUNCHER-end.png`来自965cf的CDP采集，仅作参考，TLS bypass状态未记录，不作为normalTLS批准；ddfb08f的有效CUA观察另确认+X炮孔，未本地导出。

旧idle整枪有654个CPU torso三角交面，不能以前移弹丸掩盖。真实下侧握区截面X=-.08/Y=.213、两侧Z=-.070792/+ .070847、该侧下表面Y=.207270支持`supportGrip=[-.08,.213,-.05]`。候选root `[-.31,1.15,.30]`在实际右肩-X侧：ready姿态左/右肩分别`[.222141,1.384928,.100033]`/`[-.152766,1.405282,-.011403]`，没有左右镜像或全局forward错误证据。候选idle整枪与round交面均0，左reach481.392mm/链504.847mm；这不是手指/像素批准，whole-skin parity未认证闭合。三档物理socket按各LOD parser recenter差换算；场景删除旧后盖override，继承sidecar，三floor/prototype与静态模拟muzzle marker同步，其他武器不变。

v17既有命名刚体frame复用为**Game动作参考**：`reloadPose`是相对当前hold的模型局部米制/xyzw变换；`reloadExtract`是已挂附件握点的局部退出delta，先+X轴向179mm脱开，再暂侧移40mm；`reloadClearance`/`reloadReturnClearance`是转枪的局部平移waypoint。它们不是物理grip或装配槽，不含H01绝对actor坐标、骨长、phase时钟。Game依据现有magOut/magIn/chamber phase派生姿态；Framework仅执行通用IK/附件frame，Editor透传错误。可选frame全缺失沿用旧行为；缺必需配对、非法frame、非正轴向退出或缺真实附件握点明确diagnostic，模型回退。无需新增schema或另一时钟。

12点phase路径手IK无不可达/socket residual，最紧左余14.35mm、右余17.15mm。直线转枪有22/124/354/707规划交面；局部抬升和右肩侧绕使所测进出中间点交面归零。原始`launcher-static-side-geometry-03b0818.json`、`launcher-continuous-quick-03b0818.json`、`launcher-clearance-arc-geometry-03b0818.json`、`launcher-return-arc-geometry-03b0818.json`仍保留。省略transition的部分raw基线重放差57–142mm只供规划；可靠晚段原frame2455/tick1270/phase.944444/clip3.116667的链重放差2.018e-7m。强行phase=1但仍保留reload末帧有633肩衣交面，该状态不等于真实WeaponSystem完成后的idle/upper ready crossfade；**必须实际连续录制late>.9→首idle→ready过渡后的raw与PNG**，不能由端点或离线零交面宣称动作可用。

```powershell
node tools/verify/weapon-assembly.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head '填入冻结40位SHA' --weapon shotgun,smg,launcher --launcher-recovery --aim-yaw 180 --side-aim-yaw 135 --out .workbuddy/tmp/wpn-integration/front-loading-focused-audit
```

正常TLS入口继续`https://fangye-win11-office.tail6b29a2.ts.net:5198/?scene=assets/scenes/sandbox/weapon-assembly-trial.scene.json`；5198为本次试验服务，仓库固定5100未改。前孔静态检查可选fit节点`nd_fit_launcher_assembled_0,nd_fit_launcher_child_0,nd_fit_launcher_assembled_1,nd_fit_launcher_child_1`；原有未影响30/40静态证据保留。新动作、手部可达、整枪不穿插和真正round离回槽仍待独立正常Input/GPU复验，Fuel真实装配仍待后续修正。

`--launcher-recovery`仅适用于含Launcher的1–3件`--weapon`聚焦列表，不能与`--all-weapons`混用。普通out/mid/in周期之后追加四次真实射击→R，每周期只采一个指定PNG：phase[.90,.95)、[.95,1)、连续raw首次观察到reload→idle、idle且实际upper `ready`层有权重并完成crossfade。25ms连续raw保留左右手残差/IK诊断和upper transition的elapsed/duration，漏指定阶段显式失败。首idle是首次**观察**的转换，截图另存trigger、capture sample与frameRange；PNG耗时可能跨阶段，标签不证明exact-frame像素。此工具新增路径仅完成定向回归，未由Worker启动浏览器，不声称上述新动作或四阶段已通过GPU复验。

用户现已选择**补交修复后的WPN-SHELL-01源模型**，等待新版实际路径/commit；不再等待范围三选一，也不进行程序cap/旧源自交修复。旧Shell与同源Launcher round只用于装配候选，其底火视觉仍未批准；没有授权缩小整个验收范围。新版源未到且独立复验未完成前，全队列不能标APPROVED/COMPLETED。

本轮14项Game/loader owner测试、1项fixture测试、calibration/fixture `--check`、typecheck通过；scene:check为282资产、22个v17场景、15项跨文件测试及既有门禁通过，architecture286文件0错误、knowledge137条0错误。日志统一为`.workbuddy/tmp/wpn-integration/launcher-front-{owner-test,fixture-test,calibration-check,fixture-check,typecheck,scene-check,architecture-check,knowledge-check}.log`。没有浏览器/GPU执行，不把旧03b机械证据扩为新姿态批准。

本检出/roots apps/assets/packages/tools一次CodeGraph `incremental-index --no-embed --json`更新15files/70nodes/306edges、当次0parse错误，结构ready；旧index.lock告警、5个既有parse文件与7891未解析调用保留，6822/7092向量完整。原始`launcher-front-index.log/health.log`记录限制；不删锁、不重建、不等待向量。

## f5ac7bb 实机失败与0.90人体工学候选（2026-10-12）

`front-loading-focused-audit/observations.json`的633样本/40张PNG保留实际失败：Launcher持枪左手9–15mm，晚段最大左117.899mm、右40.797mm；late95左66.917mm、upperReady左9.645mm，并有`IK_UNREACHABLE/IK_SOCKET_RESIDUAL`。四恢复阶段捕获齐全只是采样覆盖，前腔离回槽仍未清楚，不构成像素通过。Shotgun/SMG本次移动射击/换弹机制及双手可达可复用；接口仍局部遮挡。

本轮直接用423个同帧actual肩链复算旧target，残差与实机measurement最大差3.20e-7m。当前marker组合没有重复yaw或坐标变换错误，问题是旧ready左肩Z与规划基线不同，以及回程rootX=-.337把支撑目标拉出真实肩球。保留轴向、前孔与模型比例，Launcher和同源round各三档统一0.90：名义本体长.750→.675m，实际round LOD0长约177.44→159.69mm，前腔深262.05→235.84mm。主握与支撑握点分别来自归一化前真实握把截面`[-.222,.074,-.020]`和`[-.080,.213,-.070]`，两側实表面位置记入calibration，再整体乘.90；不是空中socket。

最终hold为actor-local `[-.31,1.20,.245]`；Game动作frame均是**最终模型局部米/xyzw**：reloadPose `[.165,.035,-.298]`/RY+90，extract `[.1611,-.036,0]`，entry clearance `[.13457441181107344,.126,0]`，return clearance `[0,.072,.036]`。入位原frame2299/phase.16667有152个颈肩交面，沿真实base.rotation的前轴（该帧actor+Z）解析SAT阻塞30.034995mm，加1mm间隙需localX增量.134574412m（sin系数.230615871）；423肩球减15mm余量的同方向参数交集为[0,.204145123]m。该解析增量已经是.90候选的局部米，不能再次缩放。

423真实肩链快速筛0失败，最小右19.736mm/左15.582mm；7个已确定代表态的枪体/round交面及反向点parity均0，原六关节重放差最大2.08e-7m。只覆盖无transition的ready、entry、reload后半、late及upperReady代表态；whole-skin parity没有认证watertight，不宣称全路径clear或GPU握姿通过。原始计算为`launcher-actual-reach-f5.json`、`launcher-current-grip-section.json`、`launcher-current-shoulders-candidate.json`、`launcher-entry-clearance-interval.json`、`launcher-entry-separation.json`、`launcher-actual-geometry-f5.json`。

后处理命令为`python tools/art/rescale-launcher-assembly.py`及`--check`，只修改现有6个派生GLB的POSITION/accessor bounds，UV/NORMAL/indices/embedded texture/cap BIN逐字节不变；重复运行不重复缩放，hash失配拒绝写入。原生成recipe及pipeline hash保留，报告`ergonomicNormalization`显式记录输入hash、后处理hash和有效scaleXYZ。重生成时先走原生成管线，再执行这一后处理、`node tools/art/calibrate-weapon-models.mjs`与两种review fixture生成；禁止为了复现此缩放重做旧Shell底火。稳定GUID不变，三LOD物理socket按各自final parser recenter换算，prototype/trial/三floor及静态模拟muzzle marker同步；三floor Camera与其他武器不变。

3项后处理安全回归、3项真实f5肩链/三档数据/四向muzzle-owner回归、10项Game投影和4项loader回归、1项fixture测试通过；后处理/calibration及两种review `--check`通过，scene:check为282资产/22个v17场景/15项跨文件测试，architecture与knowledge通过。日志使用`launcher-scale-*`前缀。当前仍是待独立normalTLS/headed候选。Audit沿上文focused3命令使用新冻结HEAD、独立out目录及`--launcher-recovery`：普通out/mid/in后追加5次正常shoot→R，分别entry真实phase[.14,.18]、late90、late95、firstIdle、upperReady；漏窗显式false，原始PNG仍保留跨窗frameRange，不声称exact-frame像素。

加载身份通过工具磁盘asset hash记录、正常`cache:no-store`下载与既有`window.__editor`只读snapshot交叉核对。`renderer.getDocument()`中Launcher hold应为`[-.31,1.20,.245]`，`actor.attachmentRequest`的LOD0 primary为`[-.1998,.0666,-.018]`、support为`[-.072,.1917,-.063]`；前槽`[.1773,.252,0]`由sidecar默认继承，在非removed子件相对parent frame可核。新的请求变化和child worldCorners尺寸核实际数据消费，models.frameStamp/child frameStamp核同帧；runtime summary不直接输出GLB sourceHash，不能只凭HEAD证明加载版本。Fuel装配仍后续处理，Shell与round底火仍等用户补交修复实源，全队列未批准。


## aab0edef 实机机制与侧视补证候选（2026-10-12）

原始 `.workbuddy/tmp/wpn-integration/launcher-ergonomic-audit-aab/observations.json` 保存22项检查、566样本、26张原始PNG：normalTLS/headed NVIDIA，console error/exception均0，未出现`IK_UNREACHABLE/IK_SOCKET_RESIDUAL`。Launcher最大右手位置残差3.080191e-7m、左2.653646e-7m；排除`action=reload`的最大枪口yaw误差1.667371e-7rad。换弹的90°是当前Game转枪动作，不作为射击朝向失败。这些只证明本版本所采机制，不能扩为全姿态/手指或像素验收。

out触发phase.20833/frame387，而crop落在403–410；mid触发.43056/frame419，crop433–440；in触发.65278/frame451，crop466–475。前腔粉色弹体形态有变化，但完整离槽间隙未清晰确认，仍未批准可见离槽/归位。PNG不锁帧，触发样本不能代替该PNG实际阶段。

本轮仅将trial的Camera `yawOffsetDeg` 从0改为−90，保持distance1.8m/pitch0°/锚点Y1.18m；校准工具同步保留该持久值，三floor相机与全部武器数据不变。普通世界yaw180°输入时，角色朝−X、Launcher换弹炮管转到+Z；相机从−X观察人物前方及炮管侧面，使轴向抽取方向落在屏幕平面。该方位来自现有坐标/动作数据，是否实际露出前腔仍由新目标原始PNG判断。现有自由相机在Play被禁止；没有新增或注入运行时观察机位。

```powershell
node tools/verify/weapon-assembly.mjs --root C:/Users/fangy/WorkBuddy/game-design-zombie-worktree-01 --expected-head '填入冻结40位SHA' --weapon launcher --launcher-recovery --aim-yaw 180 --side-aim-yaw 135 --out .workbuddy/tmp/wpn-integration/launcher-side-slot-audit
```

沿用真实移动/射击→R、out/mid/in及entry/late/首idle/upperReady的有界周期和PNG frameRange；本轮未启动Chrome，不预写新视角通过。该入口只补Launcher可见性，未执行武器不计本轮通过。

Fuel实际使用`WPN-06-FLAME-without-can`，源后罐区域已在源x>.19且y<.395处切除；当前dock来自真实切面x=.19/y=.265，外置Fuel替代原后置罐，没有重复挂回源罐。现有旧out frame2052的六关节重放差1.361e-7m，149个躯干顶点在罐内，真实装配仍待修复。新左侧高持/转枪规划的35真实肩链快筛可达，但ready frame1931反向闭合罐检测有376个相关body顶点在罐内，最大已测顶点深度51.985mm，不能因罐的极值点不在body parity内便宣称clear。唯一解析上移需要66.379mm，保留15mm肩链余量的上限仅12.662mm；候选拒绝，未改生产hold/dock/grips/尺寸或层。mid/in旧重放缺transition仍不作精准几何结论。原始有界记录为`fuel-interface-pose-candidate-aab.json`、`fuel-ready-contact-depth-aab.json`、`fuel-ready-upward-separation-aab.json`和`fuel-ready-upward-feasibility-aab.json`；CPU诊断不是新GPU验收。

Shell与同源round底火等待用户补交修复实源；round×.90只归一化，未修cap。Fuel装配与真实附件可见性未完成，全队列尚未批准，未启动Final Reviewer。
