# 战斗动作与特效追加资产需求（WorkBuddy 执行稿）

Related sound-effect production requirements: [Gameplay audio asset brief](40-GameplayAudioAssetBrief.md).

版本 2026-10-07。延续 docs/31 的美漫规范；本清单是新增资源需求，不接管正在进行的角色绑定工作。现有环境模型及 LOD 复用，不要求重新生成角色 mesh。

## 交付约定

动画生成与模型生成是不同能力。若当前 Hunyuan 通道只能生成静态模型/姿态，先交参考图和未完成记录，不得把 T-pose 或单张姿态称作动作资源。使用能输出骨骼关键帧的动画工具，或由动画师制作；不在本任务中调用付费生成服务。

- 每件独立稳定 ID，与适用角色 ID、版本、作者/工具、来源许可、实际时长/FPS、成功/缺失项一起写入 `delivery.json`。先交 `assets/_delivery/<批次>/<ID>/`，验收后接入。
- 首批先做 ANI-P-AIM-IDLE、ANI-E02-POUNCE、ANI-E03-ACID 各一件校准。使用项目已有 rig 的导出副本作为参考，保留骨架名称/层级、rest pose、单位米、Y-up 和朝向；不要改写项目原角色及 sidecar。
- 动作源交 GLB animation 或 FBX，并交预览 MP4（正侧面及俯视 3/4）、动作时间标记 JSON。优先骨骼动画，不重复携带 mesh/贴图；必须带 mesh 的工具保留原源件，接入阶段再提取。
- 30 FPS 以上真实采样，单位缩放固定，根旋转/尺度无跳变。循环首尾位置和姿态连续；指脚不得漂移、手腕不得翻转，避免手穿身体。不得烘焙相机、灯光、UI、地面或 VFX。
- locomotion、突扑、冲锋使用 **In Place**：世界位移由模拟速度/碰撞决定，不让 root motion 再移动一次。动作表现可以有局部身体/骨盆起伏，但根骨不累计位移。
- `markers.json` 单位秒，标明 anticipation / release / impact / recovery 及左右脚接触。参数表为设计目标；交真实测量值，由运行时映射实际随机前摇长度，不能依靠固定帧号造成视觉与命中脱节。
- 若源骨架不同，明确列出骨架和映射，不冒充已兼容。通过项目 retarget 流程验证肩、肘、膝、脚接触和武器握持；partial capability 警告不自动视为验收通过。

## Animation：优先动作清单

统一美术 prompt：美式漫画僵尸动作，清楚夸张的大轮廓、短而可读的预备动作、爆发与恢复有对比；俯视约 52° 下能辨别攻击类型。允许每个实例不同起始相位与前摇节奏，但不要加入与玩法不一致的攻击距离、轨迹或伤害事件。

| ID / 优先级 | 适用角色 | 动作与几何表现 | 时长与时间标记目标 |
|---|---|---|---|
| ANI-P-AIM-IDLE / P0 | P-01（现有毁灭者） | 双手握重型手枪，略屈膝，肘不贴胸；轻微呼吸，上半身能清楚朝瞄准方向。保持原 rig、身高、体型 | 2s loop，无 root 位移 |
| ANI-P-STRAFE-F/B/L/R / P0 | P-01 | 4 个独立瞄准移动循环；枪口朝前，侧移和后退不转身丢目标；脚步短而稳定，提供左右脚接触 | 每个 0.8–1.2s loop，In Place |
| ANI-P-PISTOL-FIRE / P0 | P-01 | 短促后坐、前臂抬起后回稳，手保持握柄，不整个人挥拳；适合上半身叠加 | 0.25–0.4s，release≈0.03s，recovery≈0.25s |
| ANI-P-RELOAD / P0 | P-01 | 换弹匣、入膛、回到瞄准姿态；不把弹匣/枪生成在身体模型上，留握持标记 | 对应场景 weapon.reloadSec，记录 magazine-out/in、ready 实际时间 |
| ANI-E01-MELEE / P0 | E-01 Shambler | 身体后摆、单臂横扫、失衡恢复；相邻实例允许左右变体，避免整群同步举手 | anticipation 0.8s、impact、recovery 0.3–0.5s，one-shot |
| ANI-E02-POUNCE / P0 | E-02 Lunger | 低伏蓄力、腾身向前、双臂下砸、落地缓冲；根骨不向前移动，模拟负责 8m/s / 最远6m | windup 0.5s；flight 段可拉伸至实际飞行时长，impact=落地，recovery≈0.35s |
| ANI-E03-ACID / P0 | E-03 Spitter | 腹/胸收缩、仰头、张口喷出、弯腰恢复；嘴部可读，酸液从明确口部 socket 发射 | anticipation 1.2s；release；recovery≈0.4s，酸液另飞0.8s |
| ANI-E04-CHARGE / P0 | E-04 Bulwark | 1s 低头架肩蓄力、迈步冲撞、刹停/撞墙变体；不能用远程挥拳代替 | anticipation 1s；charge loop In Place；impact/stop；recovery≈0.5s |
| ANI-E05-FUSE / P0 | E-05 Bloater | 身体膨胀/抽搐与危险抬臂，末端爆裂姿态；爆炸粒子单独资产，不能烘焙到mesh | 基础1.5s，可映射随机延长，末端 detonate |
| ANI-B01-HOOK-SLAM / P1 | B-01 | 分别交近战勾拳和双臂举起砸地；砸地预警和落点由场景决定 | 两个one-shot，记录release/impact/recovery；以现有Boss场景参数校准 |
| ANI-NPC-HIT-LIGHT / P1 | E-01/02/03 | 轻受击胸肩短促反应，可叠加且不打断模拟位置；两种左右变体 | 0.2–0.35s |
| ANI-NPC-DEATH-F/B / P1 | 既有NPC | 前倒/后倒两个单次动作，终帧静止；不穿地、不拉长骨骼。死亡立即生效，表现时长不延迟击杀 | 0.7–1.2s，终帧hold |

以上为 clip ID，不是新增 mesh ID，因此三角形预算不适用；交接报告应明确“骨骼数、曲线数、关键帧数、时长、文件大小”，不要填假的 LOD 面数。

## VFX：VFX-COMBAT-ATLAS-02 / P0

替换有棋盘残留和边缘裁切的旧战斗图集。统一美漫粗黑外轮廓、黄橙枪火、黄白突扑/冲撞线、酸液黄绿高光/深绿阴影、少量网点。每个特效独立可读，不含 UI 字体、商标、水印或假透明棋盘。

交付一个 4096² RGBA 主图集，共 8×8 格，每格512²、16px透明保护带；有效绘画区域480²。预览图可以拼图，生成源帧必须每张单效果、真实透明，动画按帧画形状变化，不用一帧缩放冒充完整序列。按以下顺序分配格子，UV 元数据与实际图集严格一致。

| ID | 帧数/格索引 | 美术/形状要求 | 显示目标 |
|---|---|---|---|
| FX2-MUZZLE | 4 / 0–3 | 偏心不规则四尖枪火，黑线/奶黄核心/橙边，底部可对齐枪口 | 0.08–0.12s，世界宽0.2–0.4m |
| FX2-ACID-FLIGHT | 6 / 4–9 | 黄绿色酸液团、尾滴，明确朝向，首尾有体积变化，禁止雾状矩形 | 循环随0.8s轨迹，宽0.2–0.35m |
| FX2-ACID-SPLASH | 8 / 10–17 | 落地冠状液滴、中心摊开，最终形成低矮污液，不占整个格边界 | 0.25–0.4s，世界直径约4m以内 |
| FX2-ACID-POOL | 8 / 18–25 | 俯视不规则绿色液池，周期气泡、明暗起伏，轮廓保持可读 | 4s loop，玩法半径2m |
| FX2-POUNCE-IMPACT | 6 / 26–31 | 黄白地面星裂、短弧和漫画碎屑；不生成实际飞散建筑模型 | 0.2–0.3s，直径约3.2m |
| FX2-CHARGE-DUST | 8 / 32–39 | 米灰蓝灰分层尘团、粗线，地面拖尾；不遮住角色全身 | 0.4s loop，随路径，单片约0.7m |
| FX2-BLOATER-EXPLODE | 10 / 40–49 | 黄橙核心、红橙外爆、绿褐碎滴，几帧扩张再瓦解；禁真实血腥碎尸 | 0.4–0.6s，玩法直径7m，核心可更小 |
| FX2-HIT-INK | 6 / 50–55 | 两组各3帧：奶黄命中星、黑白冲击速度线 | 0.1–0.2s，宽0.2–0.5m |
| DEC2-SCORCH/ACID/CRACK/FLASH | 4 / 56–59 | 四种静态地面漫画贴花，透视由运行时处理，源图正投影俯视 | 烧痕0.8m/酸渍1m/裂纹1m/闪光0.2m |
| Reserved | 4 / 60–63 | 全透明，元数据不把它们当可用效果 | 保留 |

元数据每项：`id, cells, fps, loop, pivot, worldSize, blend`；每格UV写真实有效范围，注明straight或premultiplied alpha。透明像素做适当RGB bleed，不能让相邻格串色；交浅/深背景和缩小到64/32像素的循环预览。单张纹理需要兼容blend/depth管线和实例批次才减少draw call；UV offset本身不保证降低draw call。接入后再做真实GPU深度/排序/遮挡验收。

## 武器与附加资源

- **WPN-SOCKET-01 / P0**：复用现有 WPN-01 手枪，不重新生成模型。交右手握柄、左手托握、枪口 muzzle、弹匣 pivot 的明确坐标/方向和三个视角预览。尺寸约0.28–0.35m枪身长；持握点需按已确认角色rig校准，不写死来源模型单位。由接入方持久化 AssetRef/GUID 和绑定sidecar。
- **WPN-MAG-01 / P1**：独立重型手枪弹匣，漫画深蓝灰金属、少量黄铜底盖，无文字；0.04×0.025×0.11m（X×Z×Y），源GLB+BaseColor1024²+预览。清理后运行时LOD0≤400 tris、LOD1≤200、LOD2≤80；LOD由本地生成，不要求云端重复交三份。
- **UI-TOUCH-COMIC-01 / P1**：移动/瞄准射击/换弹/交互的透明美漫按钮符号；粗黑外轮廓、奶黄/暗红强调，四种图标共用1024²图集，4×4格、16px保护带。不要把按钮底座、文字或摇杆背景烘焙进去；代码提供中英文字、可访问名称和按压状态。

新增环境模型需求继续以 docs/31 未完成项为准。此次不为已有街景重复采购。所有交付先做目检、动作/UV/透明验证，再接入场景并跑 `scene:check`；源资产到货不等于运行时验收完成。

## Unified weapon resource addendum (2026-10-07)

These are resource requests, not claims of completed asset integration. The weapon
system operates with explicit null AssetRefs and procedural ink placeholders.
Reuse WPN-01 and WPN-02 through WPN-06 specifications from docs 31; do not
regenerate accepted sources. Deliver each source GLB, BaseColor, preview and
delivery.json through the existing handoff directory.

| ID | Art and geometry | Runtime target after local reduction |
|---|---|---|
| WPN-SOCKETS-ALL / P0 | For pistol, shotgun, SMG, sniper, chainsaw and flame: primary right-hand grip, support left-hand grip, muzzle, magazine and chamber positions plus quaternion orientations. Weapon-local metres, Y up, +X barrel; retain actual source calibration/normalization separately. Include orthographic side/front/top previews with labelled sockets; do not change the character rig | JSON per weapon; socket metadata adds no triangles |
| WPN-07-LAUNCHER / P1 | Optional projectile prototype: chunky comic industrial grenade launcher, dark slate tube, warm yellow hazard bands without text/logos, one readable large barrel and grip. Length 0.75m, width 0.18m, height 0.3m. Single material, BaseColor 1024 square, separated magazine if provided | LOD0 <=3000 tris, LOD1 <=1500, LOD2 <=500; local pipeline creates LODs |
| WPN-MAG-ALL / P1 | Reusable detached pistol/SMG/sniper magazines, a shotgun shell, flame fuel canister and launcher round. Match the existing source weapon palette; clean silhouettes, no microscopic engraved text. Magazines approx 0.04 x 0.025 x 0.11m; shell diameter 0.025m/length 0.07m; fuel cylinder diameter 0.12m/length 0.25m | Each magazine/shell <=400 tris; canister <=800; one shared 1024 square material atlas where compatible |
| ANI-P-WEAPON-HOLD-{family} / P0 | Six upper-body hold loops for the existing player. Rifle support hand on forward grip, chainsaw elbows separated and weighted stance, flame nozzle held clear of torso. Legs remain available for locomotion blending. Preserve exported skeleton/rest pose and use In Place | 1.5-2s loop, >=30 FPS; no mesh duplication |
| ANI-P-WEAPON-FIRE-{family} / P0 | Six distinct release/recovery clips. Pistol short wrist recoil; shotgun stronger shoulder impulse; SMG short repeatable burst; sniper bolt recovery separated from recoil; chainsaw powered contact vibration; flame sustained braced grip. Do not move the world root | 0.09-1.1s depending on family; release at 0, normalized action timing owned by runtime |
| ANI-P-WEAPON-RELOAD-{family} / P0 | Magazine out/in/chamber actions for pistol/SMG/sniper/launcher; shotgun one-shell insert repeatable segment plus end; flame fuel-can replacement. Chainsaw needs no ammo reload in current gameplay. Show both hands without flipping wrists or losing the main grip | Match current authored reload periods: pistol 1.6s, shotgun shell 0.55s, SMG 1.8s, sniper 2.1s, flame 2.2s, launcher 2.4s. Mark normalized phases 0.2 out / 0.65 in / 0.85 chamber; provide measured timings |
| ANI-P-WEAPON-EQUIP-ALL / P1 | Generic release/acquire upper-body motion compatible with each grip calibration, no baked weapon mesh, no root displacement | Unequip/equip each approx 0.2s, retimed to scene switchSec |
| VFX-WEAPON-ATLAS / P1 | One 4096 square, 8x8 atlas, 512 square cells with 16px guard. Rough black comic edges, amber muzzle flashes, paper-white pellet sparks, cyan sniper streaks, orange/yellow flame tongues, cream chainsaw slashes, grenade smoke and starburst blast. Straight alpha with RGB bleed and deep/light-background previews; no fake checkerboard or watermarks | Flash 8 cells, hit 8, flame 16, saw 8, smoke 8, explosion 16. UV metadata per effect: id/cells/fps/loop/pivot/worldSize/blend; shared texture only reduces draws when blend/depth/batching are compatible |

Calibration batch: WPN-SOCKETS-ALL for the accepted pistol, one hold/fire/reload
triple on the existing player, and flash/flame atlas samples. Confirm metre scale,
wrist orientation and FBX-to-IK blend before producing the full batch. Clouds that
only generate static meshes cannot satisfy the animation rows; report missing
capability instead of passing off a pose as motion.
