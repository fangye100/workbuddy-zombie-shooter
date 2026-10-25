# 碎裂系统联合运行、成本与交付边界（WU-09）

日期：2026-10-26，Asia/Singapore。批准 base：`9478b6034f021b751ef8e70daf5b34c7411f88bf`。
本轮生产修复为 `3712383e63a71e969ebe30062bfc3446f64daa0c`，验证工具源码为 `e06306c`（完整 SHA 见冻结清单）。
本文记录开发自验和运行方法；完整独立 WU_ACCEPTANCE 与 supervisor 对最终 exact SHA 的 APPROVED 是后续放行条件，不由本文代替。

## 从现有编辑器开始

仓库根运行 `pnpm run editor`，打开 `https://fangye-win11-office.tail6b29a2.ts.net:5100/`。
固定端口为5100，保留 HTTPS、host/strictPort 及现有证书；不要为试验改项目 startIndex。
本机验收窗口固定 DISPLAY1（1920,80），复用 `.workbuddy/tmp/chrome-profile`，不删除 profile。

从右上角原场景选择器打开已登记案例：

| 场景 | 正式内容与操作 |
|---|---|
| `assets/scenes/sandbox/fracture-wu06.scene.json` | P-01 油桶、墙、独立地面及未配置对照物。Play 后用原武器真实命中；油桶耐久归零后只破坏一次，移除其 collider/导航阻挡，地面与其他墙保留。 |
| `assets/scenes/sandbox/fracture-wu07.scene.json` | 移动 E-04 配置致死碎裂，E-01 保留普通死亡。原数字键选枪、鼠标瞄准、J/左键开火；真实致死后冻结最后可见姿态，成功 GPU 接管才隐藏原死亡尾部。 |

在原层级/功能体或资产 Inspector 打开“碎裂”表单，选择含 GUID/path 的 profile。
组件配置走原场景历史；共享配方参数走原资产历史。Apply、Undo/Redo、资产 Save 和场景 Save 是各自明确的入口。
保存后整页重载，再从原选择器打开并 Preview/Play；完整步骤与 CAS/草稿失败行为见
[作者指南](fracture-authoring-20261022.md)。Preview 共用正式模拟/渲染，但隔离真实玩法 HP、奖励和导航。

暂停不推进模拟，单步恰好一个固定 tick。观察相机按钮进入观察模式，左拖环绕、右/中键或 Shift 拖平移、滚轮缩放；Esc 返回游戏视角。
Reset 通过原控制器重建 run/碎裂绑定；Stop 退役租约、销毁 World 及 Play GPU 资源并恢复作者状态。
编辑器相机和游戏 Camera 组件仍各自归原 owner。

## 资产制作与支持范围

复用[离线制作链](fracture-asset-pipeline-20261020.md)及其原工具，不在运行时切割网格。
完整/分块 GLB、封口材质、代理、bind/pivot、单位与 NPC 具名骨映射是离线配方；可复用作者数据保存在资产及 sidecar，场景只存引用和实例配置。
更新源文件时按原事务维护 GUID/sourceHash/sidecar，并执行 `pnpm run scene:check`。
不得把 GPUBuffer、顶点数组、临时 pose 或运行态 HP 写入场景。

当前正式例子为 P-01 和 E-04，不认证任意骨架。NPC 使用现有四权重 LBS 与实际具名 pose，large 使用真 Rapier、small 使用原三维简化积分。
事件世界尺度须均匀，bind 与代理限制由公共准入显式诊断；不静默平均尺度、不回退成 T-pose。
坏引用、隔离/版本漂移、非法 GLB/权重/退化代理在分配前拒绝，保留作者草稿；迟到请求由原 generation/run 身份隔离。

## 本轮窄修复及唯一责任链

`PlayFractureRenderer.sync` 在 null/空活动列表早返回前清零 `instanceBytes`。
回归先实际生成128字节实例，再解绑、恢复活动帧、释放 runtime，分别验证两个早返回边界；旧实现会留下128。
该值是本次 sync 的 CPU 准备量，其他 geometry/upload/resident 累计观察值同样不再被注释为实测 GPU 上传或驻留。

原 `prepareFractureActivation` 增加可选 `PrepareOptions.measurements` 数字接收器。
普通宿主不传；观测不进入 activation，不新增生产状态或模拟模式。成功准备区分准入异步墙钟、NPC chunk 解码 CPU、palette+bake CPU、剩余变换/代理/速度规划 CPU。
失败时尚未完成阶段的零值不能当作该阶段的成本样本。P-01 和 NPC 都核对带/不带观测的激活等价；palette 原异常现在进入同一 pose-invalid 诊断。

| 原职责 | 唯一入口 → 消费者与 owner |
|---|---|
| 场景/配方与保存 | 原 Inspector/FracturePanel → SpawnEditStore/History 或 AuthorResourceDocument → AuthorSceneSaver/devfs/CAS/typed sidecar 事务。未新增文档/保存实现。 |
| 物体与死亡事实 | 原 WeaponCombat/RuntimeSession → PlayController.consumeDestructibleEvents / consumeDeathFractures → spawnFracture。奖励/槽位归原游戏内核。 |
| 当前准入与姿态准备 | admitFractureProfile → 原 parseGlb / skin 公共合同 / 当前凸点集 → prepareFractureActivation。未新增加载器或烘焙算法。 |
| 模拟与预算 | 原 bindFractureToPlay/固定 tick → createFractureRuntime、RapierFractureBackend 与原 small 积分、ObjectPool。 |
| 绘制与销毁 | 原 PlayFractureRenderer → CoreDynamicBatch/RendererCore 原材质、深度与描边；Play owner 退役资源，Stop 实际 destroy/free。 |
| Preview | 原 FracturePreview 组合上述准备/模拟/渲染，独立 owner，原面板可达。 |
| 验证观测 | `tools/verify/fracture-measure.mjs` 只包裹真实 API/下一原编辑器帧；两条 WU09 probe 只驱动上述实现，不提供第二套业务模拟器。 |

## 测量方法与实际边界

原始记录在 [WU09证据目录](../evidence/fracture-wu09-20261026/measurement-summary.json)。
三模式使用同一正式场景、事件/pose/seed 与输入 SHA；每模式8帧暖机、32帧测量。
off 不激活；simplified 把同一22块交给原 small 积分；rigid 保持作者的15 large + 7 small。
它们是验证输入控制，未修改正式资产或添加产品开关。准备阶段另有每类2次暖机、10次样本；原死亡事实同步消费/分派只有一次观测，不冒称统计分布。

GPU timestamp 是 **scene begin → post end**，包含原 scene/outline/VFX/post 区间，绝非碎片单 pass。
CPU submission 是 `core.drawFrame` 的同步编码墙钟；Play Step 还包含原游戏；simplified 字段包含积分与 TTL 遍历。
计时有工具包装开销及浏览器计时精度，不能把不同阶段的分位数相加成一帧分位数，也不能从单次采样推出硬件性能上限。

| 模式 | 真/简化活动数 | GPU区间中位/p95/峰值 ms | CPU提交中位/p95/峰值 ms | 真物理中位/p95/峰值 ms | 实际碎片writeBuffer字节/帧 |
|---|---|---|---|---|---|
| off | 0/0 | 0.417/0.987/0.999 | 0.300/0.400/0.700 | 0.100/0.200/0.900 | 0 |
| simplified | 0/22 | 0.580/1.038/1.083 | 0.600/1.400/1.600 | 0.100/0.200/0.700 | 5632 |
| rigid | 15/7 | 0.761/1.460/1.529 | 1.100/1.800/2.200 | 0.500/1.200/2.500 | 5632 |

draw/三角形来自实际 drawIndexed 调用，包含描边的再次绘制；22块产生44个材质子批、88次碎片 indexed draw、85,932个含描边三角形提交。
唯一几何与材质批数另列，不能把提交三角形数称作模型独立面数。
实际上传来自成功 `GPUQueue.writeBuffer` 的有效范围（区分 TypedArray 元素和 ArrayBuffer/DataView 字节）及 `copyExternalImageToTexture`；准备量不代替上传。
存活量取实际尚未 destroy 的 GPUBuffer.size；纹理按实际格式/尺寸/mip 描述给逻辑字节，**WebGPU 未提供本工具可读取的物理显存驻留值**。

默认32真实/256简化/256事件队列只是当前配置，本机已测至该预算，非任意设备认证。
压力使用32次12块的 P-01 事件，延长 TTL 为60秒；活动达到32+256，显式跳块，低优先级满额输入不删除已有句柄。
队列第257条拒绝，后续有界消费。压力不是原生武器主路径，也不占投射物额度。
长时休眠/TTL 直接推进原 binding.onFixedTick 并调用原同步，隔离玩家死亡；不借它证明宿主接线，宿主由原生23/43项验证。

最终压力记录的32真刚体均进入休眠，仍实际持有 body/collider/租约和GPU资源；TTL到期退役288租约，真实 World 仅剩4个独立静态镜像 body/collider。
Reset 核旧 runtime/队列/租约/288句柄失效及 World 已释放。三模式与压力期间记录到的374个曾被碎片消费的实际 GPU 资源在 Stop 前后均各销毁一次；此集合含跨模式已退役项与被复用的 Play 材质，不能称作“同时驻留374个”或“全部都是碎片独占”。

## 本轮实际验证与继承

| 当前命令 | 实际结果与观察 |
|---|---|
| `pnpm exec vitest run apps/editor/test/fracture-renderer.test.ts packages/runtime/test/fracture-activation.test.ts` | 97/97；后续仅强化 NPC sink 等价断言，定向2/2通过（81项未选，不冒称再跑83项）。 |
| `pnpm exec vitest run apps/editor/test/play-controller.test.ts packages/runtime/test/fracture-runtime.test.ts packages/runtime/test/fracture-rapier.test.ts packages/render/test/dynamic-batch-lifecycle.test.ts` | 152/152；真实Rapier接触/休眠、宿主身份与异步失败、GPU owner/回执。 |
| `node --test tools/verify/fracture-measure.test.mjs` | 6/6；真实调用范围的观察替身、不同批次对象、取消/迟到map、部分分配/绘制失败均恢复钩子并释放观测资源；不是硬件证据。 |
| `node tools/verify/wu06-destructible-probe.mjs --headed --out <独占目录>` | 43/43；原生武器/爆炸、碰撞与导航通路、Reset/Stop及受控失败。 |
| `node tools/verify/wu07-npc-death-probe.mjs --headed --out <独占目录>` | 23/23；原生移动NPC致死、非bind、E01对照、Pause/Step及Stop。 |
| `node tools/verify/wu08-author-probe.mjs --headed --out <独占目录>` | 48/48；原UI的Apply/历史/Save/full reload/CAS、源6515顶点连续性、实际Preview GPU释放及故障恢复。 |
| `node tools/verify/wu09-fracture-probe.mjs --headed --out <独占目录>` | 21/21；三模式真实timestamp/上传、默认预算、队列、休眠/TTL/Reset/Stop。 |
| `node tools/verify/wu09-physics-visual-probe.mjs --headed --out <独占目录>` | 20/20；同seed双来向轨迹、真实求解manifold、三轴姿态和同tick截图、原Reset按钮。 |

五项浏览器路径均 strict TLS、DISPLAY1、实际 NVIDIA Lovelace 非 fallback，console/exception 为0。
已查看物体外表面/封口、遮挡/描边及 NPC 完整/分块画面；没有把 CPU 实例对齐自比较冒充 GPU readback。
准备测量的准入墙钟数百毫秒与 NPC 解码/烘焙成本是本轮真实限制，不认证无卡顿；具体分布和峰值保留原始数据。

原 native 23/43 在可选计时增量之前运行，后者不传 measurements；正常事件数学、准备结果、实例、shader、材质及玩法路径未变。
作者 raw 的273项源码摘要与当前生产源码核对；所有正常/失败记录通过最终冻结清单绑定，不能只用目录名字或旧 HEAD 标签证明版本。
本轮不改共享 shader/skin/layout、七武器或 M4/Act1 owner；逐项历史断言、原SHA、实际不匹配文件和继承理由在
[原功能覆盖核对](../evidence/fracture-wu09-20261026/coverage-audit.json)。其中 M4 compute/Ribbon 受测核心摘要匹配，soft/贴花/图编译的后续可选flow/类型改名差异按具体分支说明；不声称历史整条依赖树与当前完全相同。
原 Editor 剪贴板两项仍 FAIL，保留其原始记录与宿主界定；本 WU 不认证当前复制可用。历史错误夹具、准入反例、未测自然 blocked 酸液及其他未认证组合不改写为通过。

门禁：typecheck、editor:build、architecture:check、scene:check 已实际通过；后续新增工具再按冻结结果核架构文件数。
工作区 knowledge:check 的8项并发旧目录错误保留。交付目录从 HEAD 的正确 catalog 局部追加，通过精确 Git tree 的原 validateCatalog 验证，不覆盖并发工作区文件。
CodeGraph 0.167.0 已先 project_map/指定模块，再核源码；预算截断、未解析/损坏解析文件及非完整向量索引不作为完整架构或运行成本证据。

## 冻结、审核与仍未完成的放行

最终 source/input/raw/画面摘要、base..final 所属文件、提交链及远端一致性在开发会话冻结 manifest 中。
历史失败尝试及探针修正日志保留在 `.workbuddy/tmp/wu09-review/`，最终测量使用 `cost-pressure-final` 与 `physics-visual-r2`，不是挑选旧失败断言重新计分。
主代理先停止 source/tests/docs/被测服务/fixture 写入，再启动全新独立、继承主对话模型且不传 model 覆盖、max 推理的整单 WU_ACCEPTANCE。
独立通过后才向唯一 supervisor 报 WAITING_REVIEW；未经最终 exact APPROVED 不宣布九个 WU 全部完成。
