# 碎裂系统需求矩阵与后续开发依据

日期：2026-10-26。适用项目：`game-design-zombie`，离线预破碎与运行时三维碎片系统。

本文把已确认的需求整理成可追踪清单，说明每项需求的意义、责任和验收标准，作为后续开发、修改与审核的共同依据。
需求来自[原开发计划](fracture-system-development-plan-20261020.md)及 WU-09 原始授权，未增加新的产品范围。
实现与证据基线为 `0f7616a574e6c8f3b8648971e0ba01f75200c944`；上一已批准单元 WU-08 为 `9478b6034f021b751ef8e70daf5b34c7411f88bf`。
本文新增与知识目录更新属于文档改动；最终交付以独立整单审核和 supervisor 对新 exact SHA 的裁决为准。

## 使用方法和权威边界

- 表中的“需求”说明必须保留的能力；“意义”解释用户价值与所防止的问题；“验收标准”说明怎样证明能力成立。
- 后续修改先定位需求 ID，再核对对应源码 owner、数据真源和受影响调用链。涉及的需求及直接相关原行为需要验证；不要求每次小改重跑全部系统。
- 本文是需求追踪依据，字段与实际接口仍以当前 schema、源码和项目数据为准。历史测量只证明其记录版本，不自动变成新版本认证。
- 构建通过、截图存在、接口导出、计数清零、消息已发，分别只能证明对应事实，不能互相替代。
- 开发自验、独立 `WU_ACCEPTANCE PASS`、supervisor `APPROVED` 分开记录；必需项 `FAIL` 或 `NOT_VERIFIED` 不能计为通过。
- 浏览器验收使用 headed、实际硬件 GPU 与严格 TLS；窗口固定 Windows DISPLAY1（1920,80），保留固定profile，不影响其他显示器。
- 结构/调用影响先查当前检出的 CodeGraph，再核源码与实际消费者；图谱盲区、调用次数和构建成功不代替行为或成本证据。

## 一、产品需求矩阵

| 需求 ID | 需求及用户可见行为 | 意义 | 责任与数据归属 | 验收标准 | 原始范围 |
|---|---|---|---|---|---|
| FR-01 数据可持久化 | 场景保存对象/NPC碎裂配置和 GUID/path；配方、稳定 chunkId、来源及可复用参数属于资产/sidecar。 | 换场景、重载或移动资产后配置仍可追踪，不出现只存在内存中的功能。 | `scene` schema、项目/资产元数据；原作者保存事务。运行 HP、pose、GPU/WASM 句柄不持久化。 | 保存后整页重载并实际消费；版本/迁移、断引用、重复 ID、sourceHash 与 typed rename 有明确校验。 | 计划§4、§9；WU-01/08。 |
| FR-02 正式离线资产 | 正式完整模型与预切碎块可还原；外表面、封口、材质、代理、pivot/单位及 NPC 骨映射正确。 | 破碎后仍像原物体，不以占位几何、开壳或错位块冒充美术交付。 | 原离线制作工具、正式资产、配方与 sidecar；不在运行时调用离线切割器。 | 核真实 GLB/来源/摘要、有限值/封闭性/装配关系；查看 GPU 近景和非 bind NPC。 | 计划§5；WU-02。 |
| FR-03 真三维刚体 | 至少大块具有真实 body/collider、位置/四元数、冲量、环境与块间接触、落地及休眠。 | 碎块对来向和环境作出物理响应，不固定播放同一飞散动画。 | 原 `RapierFractureBackend`，静态镜像来自当前场景/runtime collider。 | 不同来向产生不同轨迹；真实接触与休眠状态、同 tick 画面和三轴姿态相符；质量/摩擦/恢复/速度上限被消费。 | 计划§6.1/6.2、§11.2；WU-03/05。 |
| FR-04 简化层与容量 | small 仍是有三维姿态/深度的 mesh；真实、简化和队列分别有界，满额有明确策略和计数。 | 控制并发成本，同时保留必要真刚体；防止视觉预算误删玩法资源。 | 原 `FractureRuntime`、small 积分及 Core ObjectPool；不借用武器投射物配额。 | 满池/优先级/TTL/拒绝/淘汰/租约与高水位可观察；正常容量不永久全退化；无隐藏无限地面。 | 计划§6.3、§11.4；WU-04/09。 |
| FR-05 一次性不可变事实 | 真实伤害发布带 NodeId 或 run/id/generation、tick、来源、profile、seed 和变换的碎裂事件。 | 散弹、爆炸、贯穿与同 tick 多次命中不会重复爆碎；旧实体不会污染复用槽位。 | 原武器/游戏事实生产者；通用事件快照与运行去重。 | 重复输入只转换一次；入队后外部改写不改变请求；换 run/代次后旧事件失效；同输入随机分配可复现。 | 计划§3.2/3.3、§6.2；WU-01/04/06/07。 |
| FR-06 原动态渲染能力保留 | 通过原动态批次绘制碎块，按 pivot/worldScale/rotation/position 装配；保留材质、光照、深度、描边和原角色通道。 | 翻滚与画面一致，扩展碎裂时不丢失已有角色表现，也不耗尽64个静态槽。 | 原 `PlayFractureRenderer → CoreDynamicBatch → RendererCore` 与动态 shader。 | 同帧物理/实例/GPU行为核对；外表面/切口/遮挡/描边可见；原 skin/transition/hit/burn 分支继续成立。 | 计划§7.1、§11.2/11.5；WU-05。 |
| FR-07 物体破坏闭环 | 正式物体被原武器直接攻击/爆炸破坏，完整显示、原 collider 和导航阻挡同步转换。 | 视觉打开的通路也能被射线和 NPC 使用，不留下看不见的墙，不连带删地面。 | 原 `WeaponCombat/RuntimeSession` 管耐久和碰撞/导航；宿主消费表现事实。 | intact→broken一次；散弹去重/爆炸遮挡；射线穿通、NPC通过、相邻墙与地面保留；Stop恢复。 | 计划§8；WU-06。 |
| FR-08 NPC 当前姿态致死 | 配置允许的移动 NPC 由真实致死触发，冻结最后可见的具名四权重姿态；GPU成功接管后才替换该身份 death。 | 不从T-pose/原点飞出，不重复奖励，也不误隐藏新代 NPC。 | 原游戏死亡/奖励/槽位；原 bridge/skin/prepare/死亡表现消费链。 | 非 bind 姿态衔接与独立数值参照；真实 kill/奖励一次；未配置及准备/后端/上传失败保留原死亡表现。 | 计划§7.2；WU-07。 |
| FR-09 原作者入口闭环 | 原组件/资产 Inspector 能配置、Apply、Undo/Redo、Preview、Save 与完整重载。 | 功能由实际编辑器用户使用，配置能交接，预览不会损伤真实玩法。 | 原 FracturePanel、场景历史/保存、AuthorResourceDocument 与独立 FracturePreview。 | 从原选择器/Inspector走完整路径；Preview复用正式模拟/渲染且隔离HP/奖励/导航；两类历史各归原 owner。 | 计划§9；WU-08。 |
| FR-10 准入与失败恢复 | 每次激活核当前 profile/sidecar/source/chunk/convex 身份、状态及真实二进制；坏输入保留草稿。 | 不因旧缓存或已打开面板绕过隔离，不把失败静默变成损坏配置。 | 原 `admitFractureProfile/prepareFractureActivation`、parseGlb/skin合同和 CAS/文件事务。 | 错GUID/版本/JSON/NaN/权重/退化代理在分配前拒绝；恢复后重试成功；旧代IO/ready完成不复活、不覆盖新诊断。 | 计划§4.3、§11.1/11.3；贯穿各WU。 |
| FR-11 资源与 Play 生命周期 | Pause/Step、TTL、Reset、Stop/重开按所属会话处理真实 World/body/collider、租约及 GPU 对象。 | 长时间和多轮运行有界，Stop真正释放资源，并保留借用的共享Editor资源。 | 原 PlaySession、碎裂 binding/runtime/backend、原 renderer 的 owner。 | 保留旧引用核实际free/destroy及活动/队列/租约；区分休眠、退役和销毁；多轮重开，不用空数组every或单一ledger证明释放。 | 计划§6、§11.3；WU-03/04/05/08/09。 |
| FR-12 可解释的成本 | 同场景/输入/seed比较off、仅简化与真刚体；CPU分段、GPU区间、上传、逻辑分配和压力分别报告。 | 能判断成本发生在哪一阶段，避免把CPU准备量当GPU上传、全场GPU时间当碎片单pass。 | 各原owner的窄观测，验证工具只采样，不复制业务模拟。 | 记录暖机/样本/分布/峰值、实际API范围字节/draw/三角形/材质批及配置来源；不可用量明确未知，实测不外推其他设备。 | 计划§11.4；WU-09。 |
| FR-13 原能力与分层 | 七武器、原NPC通道、M4与Act1按影响保留；每个正式职责只有一个实现。 | 交付新增能力时不退化已有游戏，也不形成两套逐渐分叉的代码。 | Editor/Framework/Game原分层、公共包入口和职责模块。 | 核注册端→实际消费者；清除本次重复实现；受影响行为实测，充分未变历史证据附原SHA/断言/继承理由。 | 计划§3、§11.5；各WU及最终收尾。 |
| FR-14 可审查交付 | 精确所属文件/提交并推送，原文、输入、源码、原始输出及画面能绑定；整单独立审核通过后汇报监督。 | 他人可以复验实际交付，消息送达、测试绿和最终放行不会混为一谈。 | 当前开发owner；独立只读审核；唯一supervisor裁决。 | 完整需求矩阵和原反例；fresh独立上下文继承主对话模型、不传model覆盖、max推理；最终exact SHA的完整WU_ACCEPTANCE与APPROVED分开。 | 计划§10/12/13、review-contract/addendum。 |

## 二、WU-09 联合验收矩阵

本表保留原授权的 W09 编号，避免把某次最后修复当作完整需求。证据位置见下一表；计数是对应执行的事实，不等于本行自动通过。

| 原要求 ID | 意义 | 必须观察的结果 | 当前证据及判定边界 |
|---|---|---|---|
| W09-01 正式完整路径 | 将资产、作者配置和实际玩法连成用户可走的闭环。 | 两个已登记案例经原入口配置/历史/保存/重载/Preview，以及原生武器破坏与移动NPC致死、Pause/Step/Reset/Stop。 | E01/E02/E03；原生主路径与受控压力/故障分列，不以注入kill代替。 |
| W09-02 真实物理与画面 | 证明运动来自求解，并与实际绘制一致。 | 真body/collider、地面/墙/块接触、双来向轨迹、休眠、三轴旋转；切面/深度/描边/非bind衔接与small保留。 | E02/E03/E05；同tick截图和实际manifold保留，CPU实例对齐不冒充GPU读回。 |
| W09-03 同输入三模式 | 给成本比较提供可核对的共同基准。 | 同scene/event/pose/seed下off、仅small、作者large/small；说明内容/数量差别，复用原模拟。 | E04；off不激活，simplified为22small，rigid为15真+7简化；这是测量控制，不是新增产品开关。 |
| W09-04 CPU分段 | 区分一次性准备和稳定帧成本。 | 事实规划/姿态烘焙、physics、small积分、render提交分开，写明同步/异步墙钟、暖机、样本、分布及峰值。 | E04/E06；单次事实同步分派不当统计分布；准入异步墙钟不叫纯CPU。 |
| W09-05 GPU/上传口径 | 防止指标名称造成性能和内存误判。 | 真timestamp区间、样本/可用性；实际draw/tri/material/writeBuffer范围；CPU准备、累计量、逻辑分配及物理显存分别说明；空帧instanceBytes清零。 | E04/E06；GPU为scene→post全区间；物理VRAM未知；原128字节残留用有辨别力测试覆盖。 |
| W09-06 预算与压力 | 验证配置边界与满额保底，而非只看正常单次播放。 | 达32/256当前默认活动预算和256队列；计数/水位/跳块/拒绝/回收/峰值；满额不误删其他活动资源。 | E04；第257条拒绝。默认值不是永久产品上限或其他硬件认证。 |
| W09-07 释放与睡眠 | 验证会话真正退役，而不是仅清界面引用。 | 睡眠驻留、TTL、Reset、两轮活体Stop/重开分别核World/body/collider/租约/GPU实际对象与共享资源。 | E03/E04/E06；519为全序列曾消费集合，非同时驻留/全部独占；free/destroy与旧引用分别核对。 |
| W09-08 玩法和异步失败 | 失败不能破坏游戏事实或污染新会话。 | 物体碰撞/导航缺口和独立地面；NPC死亡/奖励/槽位一次；坏资源/后端/上传失败保底、恢复、迟到IO/ready隔离。 | E01/E02/E03/E06及E07对应充分历史反例；不能把旧FAIL直接改成PASS。 |
| W09-09 原功能回归 | 保留碎裂之外的既有游戏和VFX能力。 | 七武器、hit/death/transition/burn、M4 compute/Ribbon/soft/贴花/图编辑及Act1按实际影响验证或有效继承。 | E07；继承有具体原SHA/断言/差异理由。原剪贴板2FAIL、未认证组合继续保留。 |
| W09-10 原职责唯一 | 避免为新需求再建简化的旧系统。 | 正式模拟、渲染、加载、历史保存和Preview均能追到唯一原owner与消费者；本次重复实现清除。 | E08的责任链及源码；验证观测不充当生产替代实现。 |
| W09-11 指南/门禁/精确交付 | 让其他开发者能运行、复验和继续修改。 | 中文指南/本矩阵/目录；相关owner/type/build/architecture/scene/knowledge；完整owned、提交推送、source/input/raw/画面摘要。 | E06/E08；精确Git树与并发旧工作区catalog分开。文档新增后更新final并复核目录。 |
| W09-12 独立与监督终审 | 完成独立复检和责任明确的最终放行。 | 原全文/hash ACK、完整12行矩阵、真实消费者/成功失败/原反例；必需FAIL/NOT_VERIFIED不得PASS；独立通过后向唯一监督报WAITING_REVIEW。 | 独立完整报告绑定最终exact SHA；supervisor仍是最终APPROVED owner，本文和投递回执都不替代它。 |

## 三、证据与源码入口

下列计数对应编写时已有记录；后续修改应记录新SHA与受影响行为的复验或继承，不覆盖旧测量。

| 证据 ID | 文档区原始记录/入口 | 已记录内容 |
|---|---|---|
| E01 | [物体原生路径](../evidence/fracture-wu09-20261026/native-object.json) | 43项开发验证；真实攻击、爆炸遮挡、碰撞导航、恢复与受控失败。 |
| E02 | [NPC原生路径](../evidence/fracture-wu09-20261026/native-npc.json) | 23项开发验证；移动非bind致死、E01对照、时钟/身份/生命周期。 |
| E03 | [作者与持久化](../evidence/fracture-wu09-20261026/author.json) | 48项开发验证；配置、两类历史、CAS、完整重载、实际Preview及资源故障恢复。 |
| E04 | [三模式/压力原始记录](../evidence/fracture-wu09-20261026/cost-pressure.json)、[测量摘要](../evidence/fracture-wu09-20261026/measurement-summary.json) | 24项开发验证；原始分段样本、预算、实际资源与两轮Stop/重开。 |
| E05 | [双来向物理与画面](../evidence/fracture-wu09-20261026/physics-visual.json) | 20项开发验证；实际接触、姿态、同tick截图和原Reset入口。 |
| E06 | [门禁原始字节](../evidence/fracture-wu09-20261026/checks.json) | 主代理owner97、生命周期152、NPC定向2、观测工具6及type/build/architecture/scene记录；保留选择范围和原始退出结果。 |
| E07 | [原能力继承核对](../evidence/fracture-wu09-20261026/coverage-audit.json) | 旁路覆盖建议、原SHA/实际断言/不匹配文件与继承理由；不是整单独立PASS。 |
| E08 | [联合运行与成本指南](fracture-delivery-20261026.md)、[作者指南](fracture-authoring-20261022.md)、[制作链](fracture-asset-pipeline-20261020.md) | 运行方法、原责任链、已测成本/设备限制及未完成放行；不把估计量写成实测。 |

| 责任 | 当前源码入口 |
|---|---|
| 场景与资产真源 | `packages/scene/src/document.ts`、`packages/scene/src/asset-meta.ts`、`packages/scene/src/fracture.ts`。具体版本读取当前常量，不复制原计划中的历史版本号。 |
| 准入/准备/模拟 | `packages/runtime/src/fracture-activation.ts`、`fracture-runtime.ts`、`fracture-rapier.ts`、`fracture-play-composition.ts`。 |
| 原绘制消费 | `apps/editor/src/services/fracture-renderer.ts`、`packages/render/src/renderer-core.ts` 及原动态shader。 |
| 游戏状态与宿主组合 | `packages/zombie-game/src/session.ts`、`apps/editor/src/services/play-controller.ts`、原bridge与NPC表现模块。 |
| 原作者与事务 | `apps/editor/src/services/fracture-panel.ts`、`fracture-preview.ts`、`author-resource-document.ts`；原场景保存与devfs事务。 |

## 四、后续开发的范围边界

| 能力 | 当前约束与后续处理原则 |
|---|---|
| 任意位置实时切割、递归二次破碎、建筑坍塌 | 不属于本期离线预破碎交付。若将来开发，先定义资产/事件/资源预算与物理责任，不能沿用本矩阵的现有PASS认证新增能力。 |
| 任意rig、ragdoll、存活断肢/部位伤害 | 当前只验证已配置的正式NPC致死碎裂；新骨架及新玩法需对应数据、姿态和伤害契约。 |
| 残骸挡路或伤人 | 首期碎片为装饰；有玩法责任的残骸必须归玩法状态，不能被视觉预算直接淘汰。 |
| 手机/其他GPU的性能上限 | 当前是本机NVIDIA实测；需在目标设备按明确输入和同口径重新测量，不能外推默认32/256就是通用认证。 |

后续完成记录应引用本表需求 ID、实际变更、验证范围及新 exact SHA。保留历史失败与限制；需求发生变化时同步正文、调用契约和相关验收依据。
