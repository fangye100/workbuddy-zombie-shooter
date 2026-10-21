# 碎裂作者配置、独立 Preview 与持久化（WU-08）

日期：2026-10-22（Asia/Singapore）。已批准 base：`8b5a07a957c4cf5f3153a9feb9f8590274bc6b3f`。
本指南核对的源码提交：`c926b543ef0a7502392a55a9d03d5757216bfeee`；最终是否放行仍由 supervisor 对冻结 exact SHA 裁决。

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
| 当前准入 | `admitFractureProfile` 从原 activation 前段抽离，Apply/Preview/Play 共用；完整激活继续由原 `prepareFractureActivation` 核源/chunk/convex 的当前身份、状态与真实 GLB。 |
| 草稿配方 | `PrepareOptions.draftProfile` 仅替换合法配方内容；磁盘版本/GUID/kind/隔离先校验，草稿不能覆盖磁盘拒绝。编辑侧 `fractureAuthorDraft` 约束可写字段。 |
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
| `pnpm test` | 196 文件、2258 项通过；`final-vitest-accepted.log`。 |
| `pnpm run typecheck` / `architecture:check` / `editor:build` | 通过；架构 433 文件、0 错误，构建保留 bundle 大小提示。 |
| `pnpm run scene:check` | 通过；正式资产/项目在验收副本清理后与 base 相同。音频门禁通过不等于新增听音验收。 |
| Node fs owner runner | 4/4；包含真实源/sidecar 事务、CAS、typed refs 和受控原子替换失败回滚。 |
| `node tools/verify/wu08-author-probe.mjs --headed` | 48/48，严格 TLS、DISPLAY1、真实 NVIDIA Lovelace 非 fallback，0 console error/exception；原生 UI 与受控 IO/GPU 故障分开记录。 |
| 当前正式 NPC 原生击杀回归 | 23/23，通过；严格 TLS、DISPLAY1、真实 NVIDIA Lovelace。 |
| 当前正式物体/爆炸/导航回归 | 43/43，通过；严格 TLS、DISPLAY1、真实 NVIDIA Lovelace。 |
| 原 Editor 核心 UI 回归 | 111 项通过、1 项失败后中止；剪贴板 HUD 成功但系统读回为空，其后用例未执行，不算整套通过。 |
| 当前独立 Three 数值 oracle（开发侧复跑历史原脚本，独占输出） | 1/1；22 骨完整源表面/法线/世界 TRS/真 Rapier，容差 3e-5。 |

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
