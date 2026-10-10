# 接触阴影修复、群体避让与贴花选型复核

日期：2026-10-10。源码基线：`484b129d61262bc4eda50332d5b3567f19f5e9b5`，
分支 `codex/architecture-boundaries-20261009`；本报告随阴影修复提交。
**阴影修复已实现并验证；避让与贴花是选型建议，尚未实现新系统。**

## 1. 复核范围与证据可信度

先使用本检出目录的 CodeGraph MCP 0.167.0 查询 `project_map`，再查询
`packages/zombie-game/src/session.ts`、`packages/render/src/renderer-core.ts`
的 `module_overview`，以及 shadow/Decal/FlowField 的 AST 定位。
根目录配置为 `apps`、`assets`、`packages`、`tools`。索引曾被其他索引进程占用，
未强制删除锁或中断其他会话；本轮 map 仍提示 34 个返回文件未逐一与磁盘核对。
因此图谱仅用于定位，关键生产调用、格式和失败行为均以当前源码复核。
本次没有重新统计全库解析错误/未解析调用，也不以图入边数量推导性能。

证据分三类：阴影由 headed Chrome 的实际 WebGPU 画面和运行数据验证；
避让基准只测 Node 中的现有 CPU 内核；外部算法/渲染方案参考其官方资料。
未进行新 ORCA、NavMesh 或 GPU 贴花的 A/B 实验，不能声称这些方案已通过项目验收。

## 2. 黑色交叉阴影：原因、修复与验证

生产实例契约在 [renderer-core.ts](../../packages/render/src/renderer-core.ts)
的 `DYNAMIC_INSTANCE_FLOATS = 20`，含变换、动画姿态及过渡字段。
[SceneContacts](../../apps/editor/src/services/scene-contacts.ts) 原先仍以 16 floats
跨行读取。从第二只 NPC 起，把动画字段读成位置/缩放，得到异常巨大、交叉的接触阴影。
此前同帧关闭 ContactShadowPass 的诊断使条纹消失，定位到接触阴影路径。

修复直接引用 `@aether/render` 的权威步长，读取数量同时受 `count` 和完整行数约束。
没有关闭阴影、限制异常半径来掩盖问题，也没有修改场景灯光/材质或资产。
回归测试覆盖两只连续实例、大数值动画/过渡字段、实际 count 限制及不完整末行。

| 第一层、游戏相机、tick 6 | 修复前 | 修复后 |
|---|---:|---:|
| NPC 数 | 24 | 24 |
| 接触阴影数（静态 + 动态） | 55 | 55 |
| 全部阴影最大半径 | 47.8169 m | 6.0072 m |
| 动态 NPC 阴影最大半径 | 未独立记录 | 0.8810 m |
| 场景接触阴影不透明度 | 0.48 | 0.48 |
| 跨街黑色交叉条纹 | 可见 | 消失 |

全部阴影最大半径包含车辆等静态物件，不能与 NPC 半径混为一谈。
道路原有的裂缝/材质暗部与正常物件阴影仍存在，不属于此次步长错误。

修复前（同基线诊断截图）：

![修复前：巨大的交叉接触阴影](../evidence/shadow-crowd-decals-20261010/shadow-before.png)

修复后（阴影保持开启）：

![修复后：保留脚底阴影，交叉条纹消失](../evidence/shadow-crowd-decals-20261010/shadow-fixed.png)

实际验证：

- `scene-contacts.test.ts` + `runtime-bridge.test.ts`：40 个测试通过。
- `pnpm run typecheck`、`pnpm run editor:build` 通过。构建现有的大包提示仍存在。
- `pnpm run architecture:check`：268 个生产文件，错误为 0；
  `pnpm run knowledge:check`：目录检查通过。未修改 assets，本次不涉及 scene:check。
- 独立 headed Chrome 页，安全上下文，WebGPU adapter 为 NVIDIA Lovelace，
  `isFallbackAdapter=false`。视口 2560×1271；截图由浏览器捕获为 2559×1271。
- tick 6 与 tick 120 都有 24 个动态阴影，最大半径 0.8810 m；tick 120 的动作
  `pending=0`、错误列表为空。该页浏览器错误/警告列表为空。
- MCP Stop 后账目 `registered=4 / disposed=4 / pending=0`，实际 bridge batches
  为 null。场景 revision 仍 `90ed0617`，dirty=false，未改写作者数据。

运行证据：[tick 6 GPU 数据](../evidence/shadow-crowd-decals-20261010/shadow-fixed-runtime.json)、
[tick 120 画面](../evidence/shadow-crowd-decals-20261010/shadow-fixed-tick120.png)、
[Stop 账目](../evidence/shadow-crowd-decals-20261010/stop-runtime.json)。
只验证了第一层这条实际运行路径；未据此认证手机或所有关卡的整体美术质量。

## 3. 当前 NPC 导航与避让

生产入口是 [RuntimeSession](../../packages/zombie-game/src/session.ts) 的
`moveNpcs()`、目标更新与障碍烘焙；通用算法在
[navigation.ts](../../packages/ai/src/navigation.ts)。当前职责如下：

1. XZ 网格上的 FlowField 为共同目标产生全局方向：8 邻域 Dijkstra，阻止穿斜角，
   使用 clearance/代价；运行时双线性采样。不是 NavMesh，也不是空中三维导航。
2. CrowdSolver 用空间哈希找邻居，重叠后施加分离力、贴墙代价梯度、固定左右偏置和
   加速度限制。没有基于未来相撞时间的速度约束。
3. 只有追逐中的 NPC 进入求解器。玩家、站定前摇/恢复角色和突扑/冲锋角色不进入
   同一邻居集合；前者对后者的局部避让不完整。特殊攻击另有位置控制路径。
4. 最多处理 8 个发生重叠的候选邻居，候选按哈希遍历顺序截断，**并非距离排序**。
   完全重合（距离平方 < 1e-6）被跳过，极端密度会缺少分离方向。
5. NPC 最终直接累加速度，没有玩家路径那样的硬位置修正。
   `stuck` 虽由算法输出，当前 `moveNpcs()` 没有消费它来解堵。
6. FlowFieldIntegrator 支持分步工作，但当前目标更新一次传入全部格数，不能称作
   已有跨帧预算。玩家移动约一个网格单元后更新目标。
7. 障碍来自场景启用的非 Trigger Collider；仅摆放建筑 mesh 不会自动阻挡导航。
   默认实体容量 512（含玩家），独立算法测 1000 不代表现有游戏能装载 1000 NPC。

源码中“500 实体 ORCA 太贵”的注释没有本项目 ORCA 对照基准支撑，不作为选型依据。

### 3.1 可复现 CPU 基准

工具：[crowd-benchmark.mjs](../../tools/verify/crowd-benchmark.mjs)。运行：

```powershell
node tools/verify/crowd-benchmark.mjs
```

输出 `.workbuddy/tmp/crowd-benchmark/report.json`，本次发布的不可变结果见
[crowd-benchmark.json](../evidence/shadow-crowd-decals-20261010/crowd-benchmark.json)。
Intel Core i9-14900HX / Node 22.23.2；132×32、0.5 m 网格；固定步长 1/30 秒。
每例预热 30 tick、测量 300 tick。FlowField 另测 30 次真实目标重建。
`door` 为墙上约 4 m 开口；`dense` 以 0.32 m 间距初始化，刻意包含初始重叠。
`open`/`door` 部分半径组合也可能轻微初始重叠。

| 条件 | 代理数 | solve P95(ms) | Flow 重建 P95(ms) | 目标区外重叠代理数 | 最大穿叠深度(m，目标区外) |
|---|---:|---:|---:|---:|---:|
| open | 100 | 0.142 | 2.774 | 15 | 0.336 |
| open | 500 | 0.366 | 0.854 | 283 | 0.768 |
| open | 1000 | 0.759 | 0.781 | 705 | 0.800 |
| door | 100 | 0.056 | 1.062 | 100 | 0.484 |
| door | 500 | 0.403 | 0.912 | 484 | 0.800 |
| door | 1000 | 0.823 | 0.946 | 981 | 0.800 |
| dense | 100 | 0.055 | 0.758 | 91 | 0.510 |
| dense | 500 | 0.373 | 0.722 | 481 | 0.800 |
| dense | 1000 | 0.695 | 1.131 | 981 | 0.800 |

末帧重叠定义为两圆穿叠 > 2 cm；目标区外要求两圆心均距目标 > 1.5 m。
所有代理持续追同一点，没有攻击停驻/到达分配，因此总重叠不能直接等同真实战斗。
排除目标邻域后仍明显重叠，说明当前分离力在这些合成压力条件下不足。
末帧 O(n²) 质量计数在计时外执行。9 例位置均有限，采样中心落入阻挡格/越界的峰值
均为 0；这不证明带半径的胶囊不会擦穿墙。

单次运行、执行顺序和 JIT 影响 Flow P95，不能由这张表推导代理数让寻路更快。
没有计入全游戏状态机、攻击、动画、渲染、浏览器/Worker 传输、实体手机。
**当前证据说明既有 CPU 求解便宜，但高密度避让质量不足；尚不能判断新 ORCA 成本。**

### 3.2 选型结论

当前关卡主要是地面移动，建议继续 XZ/2.5D 导航：保留 FlowField 的共享目标优势，
先补齐邻居与碰撞契约，再以 ORCA 作为预测性局部避让候选进行 A/B。
美术是 3D 并不自动要求体积三维避让。坡道/桥面可采用带高度的 NavMesh，局部避让
按导航层和垂直胶囊交集过滤，不能把桥上和桥下角色都压进同一 XZ 邻居集合。
真正自由飞行、立体穿行的代理才需要体积 3D 速度障碍。

| 方案 | 本项目收益 | 代价/限制 | 建议 |
|---|---|---|---|
| 当前 Flow + 分离力 | 易复用，已有低 CPU 成本 | 碰撞后才排斥，拥堵/重合处理弱 | 保留作基线，修正确性 |
| Flow + ORCA 局部速度约束 | 提前规避相撞，保持共用目标场 | 密集门口仍可能僵持；JS/WASM、加速度限制需实测 | 优先原型与对照 |
| Recast/Detour NavMesh + Crowd | 不规则可行走面、层高、路径走廊成熟 | 替换导航资产链；Crowd 拥有位置，需适配攻击/击退 | 出现坡道、多层地形后优先重评 |
| GPU compute 群体/位置约束 | 更多代理时可能减少 CPU 开销 | 回读、邻域构建、确定性与业务数据同步复杂 | 现有测量无迫切迁移依据 |
| 全刚体 NPC | 能提供接触/冲量机制 | 仍需导航与行为策略，调参/成本另增 | 不作为单独避让方案 |

[ORCA 官方资料](https://gamma.cs.unc.edu/ORCA/)采用互惠的速度约束和低维线性规划；
其示例性能不能外推本项目。[RVO2 上游](https://github.com/snape/RVO2)是 C++ 实现，
Apache-2.0，若采用 WASM 需另核对绑定来源、许可证和 Worker 部署，当前没有引入依赖。
[DetourCrowd 官方契约](https://recastnav.com/group__crowd.html)要求 Crowd 控制代理位置；
不能每帧强写冲锋/击退再期待它保持内部路径状态。文档的历史建议人数不是硬上限，
`maxAgents` 由[当前 API](https://github.com/recastnavigation/recastnavigation/blob/main/DetourCrowd/Include/DetourCrowd.h)配置；容量与性能仍要测。

原型前先解决这些契约，否则单换算法效果仍差：

- 所有活跃角色均进入障碍观察集合，移动状态和参与约束分开；站定者速度为零，玩家
  不承担互惠的一半避让责任。用稳定实体 ID + generation 关联求解输出/僵持状态。
- 候选取最近邻而非首次碰到的邻居；完全重合时给确定性的分离方向；邻域覆盖最大
  半径、速度和预测时间，不能继续无条件使用固定 3×3 小格。
- 预测速度、加速度与最终胶囊/圆盘位置约束协同。先 ORCA 后随意裁剪速度会破坏
  它的可行解条件，不能声称数学上的完全无碰撞；硬修正同样需检测可通行性。
- 到达区域/攻击占位由僵尸游戏策略分配，保留可调的少量尸潮拥挤；不是所有 NPC
  都冲向同一点。突扑、冲锋、击退使用明确模式切换和连续碰撞检查。
- 消费 stuck，设有限的侧向绕行/重试/等待；门口无可行解显式反馈，不靠随机瞬移。
- 导航计算和实体位置仍由 CPU 游戏模拟持有；动画使用最终速度，渲染只消费结果。

Framework owner：`packages/ai` 的通用邻域/速度约束和求解接口；通用碰撞能力归
`packages/runtime`。`packages/zombie-game` 拥有移动模式、攻击占位、解堵策略和
tick/generation 映射；Editor 只编辑场景与显示诊断，不能承接 NPC 决策。
可配置的关卡导航/策略数据必须落场景或内容契约，不在 main.ts 写死。

后续验收必须对同一录制输入比较基线与候选：100/500 以及显式提高容量后的 1000；
开放地、对向人流、约 1 m/4 m 门口、完全同点出生、玩家阻挡、前摇站定、冲锋和击退。
记录 P50/P95、到达率、门口通量、停滞时间、目标区外穿叠、墙体穿透和朝向抖动；
最后在 headed 真实 GPU 上测完整游戏 CPU/GPU 帧时与 Stop，手机单独验证。

## 4. 当前贴花能力与选型

实际渲染是 [RendererCore](../../packages/render/src/renderer-core.ts) 的自定义
WebGPU/WGSL，不能把导入/Retarget 使用 Three.js 等同于采用 Three 的整套渲染器。
`feature.ts` 的 `PASS_ORDER` 虽登记 `decal`，只是保留顺序；当前没有对应生产贴花 Pass
与可持久化 Decal 组件闭环。ContactShadowPass 是程序地面椭圆阴影，不是通用贴花。

当前枪火、曳光、命中 ink、敌人攻击反馈在
[combat-overlay.ts](../../packages/zombie-game/src/presentation/combat-overlay.ts)
等 Canvas 叠加层里绘制，无场景深度遮挡。道路裂缝等基础外观来自既有网格/材质，
不代表弹孔、酸液或焦痕已经通过贴花系统应用到接收表面。

[VFX-ATLAS-01](../../assets/art/textures/VFX-ATLAS-01/delivered-layout.json)实际有
23 效果 / 64 格 / 4096²，含 8 个 DEC 静态 ID；每格 512²、16 px 保护带、内容 480²。
纹理 sidecar 仍为 `quarantined`，存在残底/裁烟等问题；UV 清单不证明 GPU 接入。
RGB bleed、alpha/padding 修复、mip 防串格须先验收。可按效果逐格解除隔离，不能把
尚未通过的格静默启用。共享一张纹理还需兼容的管线、混合、深度及实例合批才能降 draw call。

### 4.1 技术方案比较

| 方案 | 适合内容 | 当前接入代价/风险 | 选择 |
|---|---|---|---|
| 实例化平面贴花 + 共享图集 | 道路油污、焦痕、纸片、裂缝；平墙弹孔 | 低；需要表面锚点、深度偏移/透明排序 | 首期首选 |
| CPU 裁切投影网格 | 少量静态转角/复杂接收面 | 每次投影生成几何；接收者 LOD/变换变化需重建 | 按需静态补充 |
| 屏幕空间体积投影 | 路缘、凹凸墙面、运行时跨面痕迹 | 深度重建、法线/接收过滤、遮挡边缘与 overdraw | 第二阶段候选 |
| DBuffer / 材质贴花 | 贴花必须改变法线/粗糙度等材质响应 | 增加缓冲/预通道/材质采样，带宽与兼容成本高 | 暂不优先 |
| 当前 Canvas 反馈 | HUD 字效、漫画爆字、短促战斗提示 | 不贴附表面、无 3D 深度遮挡 | 继续承担屏幕反馈 |

[Three.js DecalGeometry](https://threejs.org/docs/pages/DecalGeometry.html)可作为裁切
投影几何的参考，但它不是适配本项目 GPU 管线的完整贴花功能；官方也提示角部投影
会变形。大量运行时命中不要逐次分配 mesh；先做池化和合批，避免占 64 个静态场景槽。

[Unity 6 URP 官方参考](https://docs.unity3d.com/6000.0/Documentation/Manual/urp/renderer-feature-decal-reference.html)
展示 DBuffer 对颜色、法线和材质属性的融合，并说明 DepthNormal 预通道的 tile GPU
成本。这是评估带宽/管线复杂度的参考，不是本项目已经具备这些能力的证据。

当前 hdr/aux 是 RGBA16F 输出，aux 并非完整材质/法线 GBuffer；主深度纹理只有
`RENDER_ATTACHMENT`。若做屏幕投影，应增加可采样深度和明确的 pass：
opaque 写深度并 store → 后续 decal pass 采样，深度附件若绑定则必须只读。
[WebGPU 资源使用规则](https://www.w3.org/TR/webgpu/#resource-usages)允许只读深度
附件与采样并存，不允许同一子资源在同一 render pass 同时可写与采样。
不能只增加绑定标志而继续在原可写 pass 读深度。

### 4.2 建议首期实现契约（尚未实现）

首期把道路和平墙痕迹真正放进 GPU 场景，使用专门的实例数据池和共享图集，
由 `packages/render` 提供通用平面贴花能力。保留后续体积 projector 接口，避免首期
为少量道路污迹改造全套延迟渲染。

- **持久化**：先扩 `packages/scene/src/document.ts`；作者贴花是稳定 NodeId 节点，
  保存带 GUID 的图集 AssetRef、region/effect ID、变换/尺寸、颜色/透明度、绘制优先级
  和可选 receiver NodeId/层过滤。锚点区分世界/接收者局部坐标，不硬编码地面高度。
  schema 升版同时补迁移与测试；资产导入配置归 sidecar，场景实例归 scene。
- **生命周期**：编辑器保存/重载作者贴花；枪击/酸池等 Play 临时痕迹由带 runId 的
  有界池产生，TTL/淡出随模拟时间暂停，Stop 回滚、释放登记资源，不写回场景。
- **表现**：GPU 深度测试开启、深度写关闭，使用局部法线偏移/明确 depth bias。
  Alpha 从 straight 转 premultiplied 或采用一致的 straight 混合，不能重复预乘。
  图集边缘 bleed 与 mip 层保护分别验证；不要把透明矩形写成描边实体。
- **接收面**：首期平面需要作者/命中提供明确表面位置和法线；不假装自动贴合任意网格。
  跨路缘/墙角用裁切或后续 projector。排除角色/其他楼层，避免痕迹漂到玩家身上。
- **成本**：按 atlas/pipeline 分组实例批，视锥/距离剔除，有界数量与溢出策略；合批
  不能破坏透明顺序。许多屏幕大贴花即便只有一次 draw，也可能产生严重 overdraw。
- **业务边界**：伤害、酸液持续时间由 zombie-game 决定；贴花仅订阅事件，不计算伤害。
  通用材质/绘制属于 render，编辑 Inspector/MCP 读写适配属于 editor/工具。
  玩法临时池适配按分层注入端口，不让 Framework import 僵尸规则或 Editor。

后续验收：作者贴花创建→编辑→保存→重载→换场景；坏 AssetRef/region 显式诊断；
Play/暂停/Stop 不污染作者数据或泄漏。平路、斜面、墙角、远距离 mip、缩放、HDR/描边、
角色遮挡、接收者 LOD 改变均要实际看图。以 32/128/512 个贴花作为候选压力矩阵，
测整帧 GPU/CPU 与 overdraw；这些是待测样本，**不是已认证容量**。
发布贴花资产/场景后跑 scene:check，跨层改动跑 architecture:check，再做 headed
真实 GPU 验收，手机另测。

## 5. 本次交付边界与后续顺序

本次交付只有接触阴影的格式修复、回归测试、可重跑 CPU 基准与此选型复核；
未修改 NPC 避让算法、导航资产、贴花 schema，也未解除图集隔离。
优先后续顺序是：修邻居/重合/站定观察/硬碰撞与到达策略 → ORCA 对照原型 →
平面图集贴花闭环 → 复杂接收面 projector；NavMesh/DBuffer 以关卡和材质需求触发。
当前低 CPU 数据不能替代视觉、行为和目标设备验收。
