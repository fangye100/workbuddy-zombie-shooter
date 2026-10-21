# 碎裂作者配置、独立 Preview 与持久化（WU-08）

日期：2026-10-22（Asia/Singapore）。已批准 base：`8b5a07a957c4cf5f3153a9feb9f8590274bc6b3f`。
本指南核对的源码提交：`4434694d4fe989a742da6e97e6699fead01f5c14`；最终是否放行仍由 supervisor 对冻结 exact SHA 裁决。

## 使用原入口

从右上角项目场景选择器打开 `assets/scenes/sandbox/fracture-wu06.scene.json`，选中 P-01 油桶；
NPC 案例也可打开 `assets/scenes/sandbox/fracture-wu07.scene.json`，选 E-04 功能体。
“场景/光照”页的“碎裂 · 组件、资产与真实预览”接收原层级/视口选择，也提供稳定 NodeId 选择器。
资产浏览器选 `.fracture.json` 后，原资产 Inspector 的“编辑碎裂配方与预览”打开同一个表单。

1. 打开带 GUID/path 的正式 profile；物体必须对应源模型 GUID，NPC 必须对应刷怪点 characterId。
2. 物体编辑 enabled、初始耐久、direct/explosion/burn 和破坏后的 collider/navigation 策略；
   NPC 的启用状态表示 `SpawnPoint.deathFracture` 引用或 null，不改角色 HP/死亡规则。
3. “应用碎裂配置”经原 SpawnEditStore 原子命令写 SceneDocument；原场景 Undo/Redo 与 Save 继续生效。
   引用在 Apply 时重新走当前 profile/sidecar 准入；非法输入、外改和校验期间的新输入均保留草稿。
4. 可复用配方独立编辑名称、priority、TTL/fade、稳定 chunkId 对应的 large/small、质量、摩擦、恢复、
   collisionGroup、线/角速度上限。Apply/Undo/Redo/Save 属资产历史，场景保存不冒充资产保存。
   高级 JSON 同样只允许这些作者字段；身份、来源、bind/pivot/单位、代理形状和未支持字段只读，
   交由原离线制作链更新，不能通过 JSON 写入 runtime/GPU 状态。单资产硬容量仍由原 schema 校验。
5. 开始预览先显示完整模型；未保存的合法配方也可观察。默认固定 seed=7、暂停启动；单步可观察
   NPC 当前动画姿态，再点“触发碎裂预览”。暂停/继续、单步、重播、Stop 和聚焦均有真实控件。
   聚焦复用原编辑器取景；原视口环绕/平移/缩放与自由相机继续可用。
6. 参数 Apply/Undo/Redo 会退役旧 Preview，再重播读取新权威值。选择切换、Play、场景更换、
   场景重建、面板关闭和热卸载也停止 Preview。切换 NodeId 会保留各自未应用草稿。
7. 分别保存资产和场景，在 Stop/Edit 下整页 reload，再从原选择器重开；浏览器提示放弃修改时
   需要明确选择。CAS 冲突保留本地草稿，不刷新 baseline 强写；“从磁盘重载”是明确放弃/接受动作，
   重载期间的新 Apply 或新表单输入仍被保护。

## 责任和实际数据流

| 责任 | 原 owner / 本次窄扩展 |
|---|---|
| 场景配置与历史 | `packages/scene/src/fracture.ts`、`document.ts` 既有 v25/v1 契约；`SpawnEditStore.editNodes`、原 History、`AuthorSceneSaver`。没有新 schema 版本或第二份 HP。 |
| 资产历史/CAS | 从原 `VfxDocument` 局部抽离 `AuthorResourceDocument`，VFX 入口保留薄适配；碎裂使用同一实现，未复制历史/保存栈。 |
| 当前准入 | 原 `admitFractureProfile` 统一当前 profile/sidecar、合法草稿和全部引用 GLB。NPC source/chunk 复用原 skin owner 的 `validateSkinMesh` 静态合同；正式 `bakeSkinVertices` 同用该函数。两种 Apply/Preview/Play 共用，NPC 仍复用当次原字节。 |
| 草稿配方 | `PrepareOptions.draftProfile` 仅替换合法配方内容；磁盘版本/GUID/kind/隔离先校验，草稿不能覆盖磁盘拒绝。runtime 唯一 `fractureAuthorDraft` 约束可写字段，编辑侧保留薄转出。 |
| 预览组合 | `FracturePreview` 注入独立 host，复用 `bindFractureToPlay`、固定 tick、真 Rapier、原简化 sim、租约和正式准备器。没有调用游戏伤害或建立 Preview 专用运动求解。 |
| 完整 NPC 与碎块 | 原 ActorLibrary/动作选择/poseIndexAt 取当前姿态；原 `bakeSkinVertices` 求完整四权重表面。`paletteForNamedPose` 按接收 GLB 的骨名映射，不借另一份 rig 的下标；原 WU07 准备器也使用该 helper。 |
| GPU | 原 `PlayFractureRenderer`、`CoreDynamicBatch`、原材质/深度/光照/描边及真实 draw 回执。新增可选 owner 域和 `releaseDynamicOwner`，缺省 Play 路径保持原 owner。 |
| 保存/改名 | 原 devfs/CAS、`writeTypedAssetWithMeta` 和 typed refs 改名事务；sourceHash 随源文件事务更新，partial sidecar failure 回滚源文件。 |

预览锚点来自所选节点的 SceneGraph 世界 TRS；静态碰撞由同一 SceneGraph 镜像到独立 World，
仅在该 Preview 副本中排除待碎物体本身。原作者文档、实际关卡 collider/nav、HP、击杀、奖励、
投射物配额均不写。碎块走动态批次，不增加静态 64 槽。完整源表现直到实际 GPU 接管成功才隐藏；
上传失败取消本事件的 body/lease/mesh，保留完整源表现和定位诊断，重播可恢复。

Preview 的几何、材质纹理和实例槽使用独立前缀。Stop 先退役 runtime/归还租约，再销毁 World，
释放自己的实际 GPUBuffer/GPUTexture、CPU ImageBitmap；不撤下 Editor/Play 共享 palette/frame/材质资源。
引擎共享白色材质仍由 core 管理。异步 profile/meta/GLB/actor/ready 完成后核代次，旧结果不能回写新代。
WASM compat 内嵌模块没有独立下载请求；模块代码可共享，World 始终隔离。pose 求值和 GPU 写入本身同步，
不虚构异步分支；ready 通知、IO、逐帧 pending/failed 的边界分别验证。

## 本轮实际验证

主代理原始记录位于 `.workbuddy/tmp/wu08-review/`；正式 JSON/截图见
`docs/evidence/fracture-wu08-20261022/`。以下是开发侧结果，不冒称独立审核员或 supervisor 已复跑。

| 命令/证据 | 实际结果 |
|---|---|
| 修复前全仓 / 当前相关 owner | 历史全仓 196 文件/2258 保留；最终共享蒙皮校验后 8 文件/205 通过，含16条真实NPC source/chunk边界；未重新执行最终全仓。 |
| `pnpm run typecheck` / `architecture:check` / `editor:build` | 当前通过；架构 434 文件、0 错误，构建保留 bundle 大小提示。 |
| `pnpm run scene:check` | 最终作者验收副本清理后通过，正式资产/项目保持原字节。 |
| Node fs owner runner | 最近独立 4/4，源/sidecar 事务、CAS、typed refs 及失败回滚；该 owner 本轮后续未改，按源码身份继承。 |
| `node tools/verify/wu08-author-probe.mjs --headed` | 48/48，严格 TLS、DISPLAY1、真实 NVIDIA Lovelace 非 fallback，0 console error/exception；原生 UI 与受控 IO/GPU 故障分开记录。 |
| `node tools/verify/wu08-admission-probe.mjs --headed` | 当前 165/165，三类引用各九类故障；含哈希匹配且头/长度合法的坏 JSON 和非有限 POSITION。两种 Apply 拒绝/保留草稿与历史、World/GPU 前拒绝及恢复均通过。 |
| 正式 NPC 原生击杀回归 | 最近原生 23/23；按未变的相机/玩法/渲染消费者及新 owner、E04 实际预览证据继承，未冒称本轮再次完整实射。 |
| 正式物体/爆炸/导航回归 | 最近原生 43/43；按未变的合法数据与原消费者继承，当前共享准入/PlayController owner 及实际作者 Play 读取另外通过。 |
| 原 Editor 核心 UI 回归 | 最近独立完整副本 123 PASS/2 FAIL/0 SKIP、exit1；复制两项为有原生对照的宿主限制，未称整套通过。 |
| 独立 Three 数值 oracle | 最近独立 1/1，22 骨完整源表面/法线/世界 TRS/真 Rapier；本次只收敛准入，不改 skin/几何公式，新增原字节单读复用测试通过。 |

作者探针通过原菜单创建并登记每轮独占场景，原 UI 添加物体/NPC 配置、Apply/Undo/Redo、预览、
资产/场景 Save、真实外改 CAS、明确重载、timeOrigin 变化、原选择器重开和实际 Play 配置读取。
typed refs 路径通过原资产浏览器/Inspector/右键改名，移动独占 chunk 并核 GUID/sourceHash/再次预览。
它保留真实 GPU 对象和原 destroy、真实 World/free 与旧 handles；两轮 Stop 均全部释放，Editor 共享资源存活。
真实 rigid writeBuffer 故障保留完整源模型并取消 body/lease；恢复后新 owner 正常接管。
原生 Stop/选择切换/面板关闭跨实际 meta/source/chunk fetch 的迟到成功或失败也有记录。

表面连续性覆盖完整已绘制 E04 的 6515/6515 个源顶点到激活碎块，最大误差 0，容差 3e-5。
早期计数探针没有抓住 actor 与源 GLB 骨序不同的问题；本轮修复为稳定骨名，并补独立已知输入的
乱序/额外骨骼/恒等尾关节测试。此前失败、控件重排竞态和 CDP 对象序列化失败原始日志均保留，
没有计入通过结果。保存和故障注入仅操作独占副本，正式 profile/model/scene 未被探针改写。

owner tests 还保留旧 runtime/backend 引用：profile/meta/source/chunk 的迟到失败跨重播不污染新代；
真实 World 初始化后只延后 ready 通知，分别验证迟到成功/失败；源模型迟到成功跨 Stop 不装配。
该 ready 测试保留真实后端，不冒称重新下载或故意破坏 WASM 模块。原物理初始化门禁仍归原 session owner。

CodeGraph 先定位原入口，随后以源码和行为核实；结构刷新使用受支持 `--no-embed`。
图谱仍有 parse/未解析动态调用及向量覆盖限制，不按边数量证明运行成本。
WU09 联合压力、成本采样与跨设备性能认证未实施；本轮结果不外推其性能结论。

原 VFX M1 当前回归：23/23，通过。复用原探针，仅在 ignored 副本修正严格 TLS/独占路径及已变更的资产期望（当前枪口宽度来自源资产、4 张纹理）；原首次 3 个旧期望失败保留。资产 Apply/Undo/Redo/保存/重载、真实开火、遮挡及 Stop 通过。

Editor 核心冒烟的剪贴板失败不属于本次修改路径；实际焦点为 true、readable=true、HUD 符合，读回长度为 0。原 asset-util/AssetBrowser/clipboard-probe/启动授权均未改；未据此调整产品或将失败隐藏。后续复制与未执行项目仍缺本轮整套证明。

部分源文件因 Git safecrlf 要求在提交前仅转换 CRLF→LF；原 GPU JSON 的原始 sourceHashes 保留，`line-ending-receipt.json` 记录转换前后 SHA256。转换后内容与源码提交逐文件一致，未改动业务逻辑。

## 独立 FAIL 后的修复与边界

首轮独立整单审核绑定 `464afeb07a1f1359dc7fbf5cb80b454345d3b821`，结论 FAIL（8 PASS、2 FAIL、2 NOT_VERIFIED）。原报告 SHA256：`03444ad61759ddac8731c7f532c7ca33b2dd5886d511b4b00c642e2208c5337a`，完整原文保存在本目录 `independent-first-fail.json` 的 utf8 字段，可恢复原始字节复核。没有把旧 FAIL 当作完成依据。

F08-01：原 checkRefMeta 只核 GUID/kind，漏掉 source/chunk/convex sidecar 的当前 userData.status。修复统一在原 helper 读取当次 sidecar 后拒绝 quarantined，定位到具体路径；Preview 与 Play 同用此入口。新增三条 owner 测试分别覆盖 source/chunk/独立 convex 引用：先合法通过，再隔离，磁盘和合法未保存草稿都在任何二进制读取前拒绝，恢复后再通过。相关 runtime/preview owner 当前 **50/50**；严格 TLS/真实 GPU 原生准入反例当前 **5/5**（profile/source/chunk 隔离、错误 GUID、恢复），拒绝时 backend=null/0 GPU mesh，恢复后实际绘制。类型、架构与构建通过；原全仓 2258 是修复前有效记录，不冒称含新增三条测试。

F08-03：正式作者探针取消捕获资源前的固定150ms，改为等待当前 owner 的真实 dynamicBatchState=ready，再保留真实对象。修复后的正式完整作者验收 **48/48**，关闭面板抓到实际 mesh/instance/texture，原 destroy/free 及共享资源存活通过。

F08-02：剪贴板两项仍失败，未写成通过。额外最小对照不调用应用 copyText/菜单 handler，直接用 navigator.clipboard.writeText、ClipboardItem.write、原生 execCommand(copy) 和 Ctrl+C；各自写入本轮已知 sentinel 后 readText 均为空，权限granted/焦点true。Windows Get-Clipboard 也为空（仅记录长度及与本轮预期是否相等，不记录其他剪贴板内容）。这将失败定位到当前原生浏览器/系统剪贴板通路，未确定更细成因，不伪称焦点/权限/用户软件问题。原 copyText/AssetBrowser/剪贴板验证和启动授权与批准base相同。没有为消除结果去修改无关产品或全局权限。

为查清被首次中止挡住的原能力，在 ignored 核心探针副本仅捕获剪贴板读回异常为显式失败后继续执行，**125项中123 PASS、2 FAIL、0 SKIP**，exit1；保留原严格判据，没有降为SKIP或整套通过。后续真实改名/取消改名/磁盘200及404、多语言切换等全部通过。本轮旧Inspector/编辑/资源/文件入口的其余实际行为有当前证据；剪贴板正常性仍为上述原生环境边界，交由新整单独立审核评估其对本WU的适用范围。

原失败报告、反例与修复结果全部保留。新exact的全新整单审核另行执行；本节不预先声称独立PASS或supervisor批准。

## 当前磁盘只读身份与合法作者草稿（F08-04）

第二轮全新整单审核绑定 `229ac3bb36e2d7f8b109c775d4535e91fbaf5d6e`，结论 FAIL（8 PASS、4 FAIL）。原报告 SHA256 `e5106acdbaf61ad2806f158be72effbb6cb1641d4661b72c04c0ee546f602b77`；完整原文保存在 `independent-second-fail.json`，不改写旧结论。F08-01/03已独立关闭；F08-02经浏览器之外的 Windows 原生写后读空对照，界定为宿主通路限制，对本WU原行为保留不再单独阻断，但复制菜单两项仍明确FAIL。

F08-04反例：打开合法配方并保留TTL9草稿后，当前磁盘profile内部source/chunk GUID外改。原prepare仅比较profile自身GUID/kind，再整体采用旧draft，使普通prepare拒绝而Preview仍创建12真body/GPU。修复将既有作者可写路径约束从editor局部迁入原runtime activation owner，编辑文件仅转出同一函数；prepare在正式引用读取前用当前diskProfile作只读baseline，Scene Apply也共用该约束。没有新增第二套加载/保存/编辑/物理实现；无draft的原Play路径保持直接检查当前disk。

允许当前disk和本地草稿各自不同的合法名称、分类、物理和播放参数；不可写的source/chunk/convex引用、几何坐标/形状/身份变化必须报出具体路径并保留本地草稿，恢复磁盘后仍可预览原TTL/质量。它不要求先Save，也不强行接受外改。资产Save继续由原CAS拒绝覆盖外部改变。

新增owner反例覆盖source/chunk/convex错误GUID，以及合法但只读的assemblyScale变化，均在draft二进制读取前拒绝；另有当前disk仅作者参数变化仍允许未保存TTL9/质量17的正例。相关runtime/preview/editor作者约束 **62/62** 通过。原UI/真实GPU补验 **7/7**：source与chunk两种当前外改时，Scene Apply原子拒绝、作者输入保留、Preview在World/GPU前拒绝；恢复后Scene Apply与真实绘制均成功。正式完整作者链再次 **48/48**，类型/架构/构建通过。新正式raw `author-readonly-results.json` / `readonly-reference-results.json` 包含具体环境和输入输出；原失败反例继续保留。

第三轮全新完整WU_ACCEPTANCE在新的冻结exact上另行裁决；本段只记录修复与开发侧实测，不预称独立PASS或supervisor批准。

## Scene/Asset Apply 共用完整引用准入（F08-05）

第三轮完整独立审核绑定 `86bbc5e9134291819696c44993148cd8ccfa53bd`，9 PASS/3 FAIL，原报告 SHA256 `92e5140902771358ebcfb705555f343b9b26be383d44c7934b0449984d266670`。完整原文保存在 `independent-third-fail.json`；唯一剩余产品 finding 是 F08-05：当前 source/chunk sidecar GUID 错误时，Preview拒绝而Scene Apply仍改耐久。其余 F08-01/03/04有效关闭保留；F08-02仍为两项实际失败及有事实界定的宿主限制。

修复不是新增简化校验器：将原prepare内部的全部引用 sidecar/GLB 准入收敛到原 `admitFractureProfile`，先校当前profile及合法草稿，再读取全部source/chunk/独立convex元数据与实际二进制。Scene Apply、资产参数 Apply、Preview 预检和正式 prepare 都调用同一入口；NPC返回当次已验原字节，原pose烘焙不重读chunk。原World/物理/几何/渲染转换、两种历史、CAS保存owner均保留。

资产参数Apply也以当前资源准入为前置条件，再交原AuthorResourceDocument写一笔历史。异步期间核对asset实例、打开代次、当前raw输入及该Document原有editRevision（只新增只读getter），新输入/Undo/重载不能被旧结果覆盖；关闭面板、换资源/节点、Play互斥或新预览会使旧操作失效。只读snapshot提供已应用资产和历史深度用于实证，不新建可编辑真源。

新增正式可复跑工具 `tools/verify/wu08-admission-probe.mjs`：source/chunk/独立convex三路径 × GUID/kind/quarantined/未来版本/缺sidecar/缺二进制/坏GLB七类输入，共21组合。每组合在原UI验证两种Apply均拒绝、两份已应用Document/历史和输入保留、Preview无World/GPU；恢复后资产Apply只增一笔历史、场景Apply成功、12真body与实际GPU接管成功。另验资产读取期间新输入保留，以及关闭后的旧失败不污染新Apply/历史/诊断。合计 **129/129、0 SKIP、0console/exception**，严格TLS、DISPLAY1、真实NVIDIA Lovelace非fallback。

其中正常P01物体和真实GLB字节不变；仅当前tab把配方响应设置为合法独立convex引用，并提供该正式chunk的原始字节/独立GUID，故障只替换精确IO响应，不改正式文件。JSON区分这一受控输入与正式物理资产；不把虚拟路径发布成实际可选资产或将故障注入冒称原生文件外改。当前 `full-admission-results.json` 保留21组合、文档hash/历史/命中/World/GPU/恢复及正式文件前后hash。

完整准入新增owner覆盖同样21组合，Apply公共入口、带draft/无draft prepare均拒绝并恢复；NPC字节Map与单读复用实测通过。相关8文件189通过；最后资产只读revisiongetter及既有VFX/历史owner另复跑2文件23通过。完整原作者创建、保存、CAS、整页reload、非bind NPC、真实资源与Play/typedrename再次48/48，原始输出为 `author-all-apply-results.json`。类型、434文件架构、构建和副本清理后的scene门禁通过。三轮FAIL和所有旧反例保留。

新的精确提交仍需第四轮全新完整WU_ACCEPTANCE；本节只记录实现和实际验证，不预先声称PASS或supervisor批准，未开始WU09。

## 实际内容解码与非有限几何准入（F08-06）

第四轮完整独立审核绑定 `958d8ecfe2a1c9f1c035d419ee4da3ce2c473efa`，8 PASS/4 FAIL，唯一未闭合产品 finding 为 F08-06：文件头/长度有效但 JSON 损坏的 source 或独立 convex，Apply 仍提交，Preview 才失败。原报告 SHA256 `26969d789940eda229f15c266fbcc2de957bae89766265f49d03c74ee83243bf`，完整原文保存在 `independent-fourth-fail.json`。原报告内“用户接受”的历史措辞不构成人类新增授权；本轮沿已有修复授权推进。

修复在原 `checkRefBinary` 使用正式 `parseGlb`（normalize=false）做 CPU 内容解码，然后核输出顶点/权重有限、非空且索引不越界。没有新建加载器，没有分配 World/GPU；解码或数值错误统一为带路径的 ref-binary diagnostic。全部当前引用在两种 Apply 写原 Document/History 前完成同一准入；原 NPC 当次字节复用、合法未保存作者草稿及原 prepare/物理/渲染消费者保持。此处不是任意 glTF 扩展/图像编解码或性能认证。

正式准入探针扩为 source/chunk/独立 convex 三路径 × 九类故障，27 组合、**165/165、0 SKIP、0 console/exception**。新增两类分别只损坏真实完整 GLB 的 JSON 字节、在合法结构的 FLOAT POSITION 写入 NaN，头/版本/长度均保留，返回 sidecar.sourceHash 与坏字节 SHA256 相同；逐例记录并断言该事实与精确 ref-binary 阶段，排除仅摘要过期的假阴性。两种 Apply 已应用值/历史不变且草稿保留，Preview 无 World/GPU；解除后实际提交不同新值、增加一笔资产历史，再次12真body和真实GPU接管。原第四轮 source/convex 反例另复跑 **13/13**，原失败不覆盖。

完整原作者流程在当前内容校验后重新 **48/48**，见 `author-content-results.json`；准入原始输出为 `content-admission-results.json` 和 `content-original-results.json`。相关8文件189通过、类型/构建/434文件架构和副本清理后的scene门禁通过。新增测试使用真实可解析正例；相关夹具未发现仅文件头的合法输入。只将固定 GLB 夹具模块的首次装载预热移入 beforeAll，每次生产 IO 仍读取新字节，不跨准入缓存，不放宽全局超时；此前单次默认超时及成功复跑日志保留。CodeGraph 当前增量结构刷新8文件、0解析错误，向量覆盖669/9917仅作限制披露。

本记录仍待新的 exact SHA 全新完整 WU_ACCEPTANCE，不提前声称独立PASS或supervisor批准，未开始WU09。旧129项及其他历史证据保留其原版本归属。

## 复用正式蒙皮静态合同（F08-07）

第五轮全新独立整单审核绑定 `59f345d4d7eea4d7497c3cfef0a7db1a240e88c0`，8 PASS/4 FAIL，唯一未闭合 F08-07：实际 E04 head GLB 的有限四权重 `[-0.25,1.25,0,0]`（和仍为1）经两种 Apply 成功提交，但后续正式 skin owner 拒绝。原报告 SHA256 `306f75ce733b1c0c1b8a6a7b14a74af9e69404fe0c81f076e48e5eaa93d53fb1`，完整原文保存在 `independent-fifth-fail.json`，旧失败未被覆盖。

从原 `bakeSkinVertices` 在同一 skin.ts 局部抽离 `validateSkinMesh`：完整15-float顶点与四权重、权重有限/非负/和为1（沿原1e-3容差）、正权重关节范围。原bake调用此函数后继续原矩阵/坐标/法线烘焙，删除旧内联静态检查，没有复制蒙皮算法；矩阵/姿态结果错误仍由原bake处理。共用准入在真实解码后，对NPC source和chunk调用同一个静态函数，按原palette数量包含尾部恒等关节；独立convex的纯点集不被误要求蒙皮。缺少NPC具名骨架也在引用阶段定位拒绝，保留原错误信息和草稿。原prepare仍消费当次已验原字节，无跨事件缓存或假palette烘焙。

新增16条真实GLB owner用例：source/chunk各覆盖有限负权重、非单位和、全零、正权重关节越界、NaN、Infinity，以及合法零权重无效关节/恒等尾关节。带草稿/无草稿的共用准入与正式prepare分别拒绝或合法通过，恢复原字节可重试。旧缺skin用例改为核更早的ref-binary、当前路径和缺骨架诊断，未把非法输入改成合法或放松拒绝。相关8文件 **205/205**；原skin23个已知闭式数值/失败用例仍通过。

原第五轮UI反例在相同head字节、摘要配对及正确期望下重跑 **12/12**（原10项外另核两种Apply的ref-binary/权重诊断及TTL9/启用草稿保留）；另将同类有限负权重仅注入真实source GLB，原UI同样 **12/12**。两种Apply均不改Document/资产历史、保留草稿并定位ref-binary/权重非法；同输入Preview在World/GPU前拒绝，解除后真正不同值成功，正式NPC重新10块/3真body/GPU接管。故障只替换精确IO，正式磁盘未改；脚本和输入回执在ignored审核根，原始输出为 `skin-chunk-results.json`、`skin-source-results.json`。

当前完整作者流程重新 **48/48**，含保存/重载/CAS、非bind表面连续及真资源释放；原正式准入探针重新 **165/165**，见 `author-skin-results.json`、`admission-skin-results.json`。typecheck、build、434文件架构及副本清理后scene门禁通过。首次新增导出时Vite旧变换导致页面未就绪的失败日志保留；保持源码字节不变触发原模块刷新后恢复，原PID21604未重启。最初测试类型错误及缺skin旧阶段断言失败也保留，修正后才计205/205。本记录仍待新exact的fresh完整WU_ACCEPTANCE，不预先宣称独立PASS/supervisor批准，未进入WU09。
