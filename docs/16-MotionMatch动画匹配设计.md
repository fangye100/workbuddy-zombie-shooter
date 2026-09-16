# Retargeting 空间补偿与接触求解：设计及开发计划

> Implementation refinement: **MR-01…05 and the bake core were reviewed from `749dd66` by three independent agent queues. Current algorithm: `mr-foot-2`. Scope, corrections, failure rules and validation evidence are recorded in [16B — Core review and refinement](./16B-RetargetingCoreReviewAndRefinement.md). Editor/session integration and real mocap acceptance remain pending; this is not a full-product completion claim.**
> 本文是本项目 retargeting 后续开发的计划真源，替代 2026-09-10 版的固定 FK/IK 分区及单链后处理方案。
> 算法依据：[16A-Retargeting运动空间补偿算法研究](./16A-Retargeting运动空间补偿算法研究.md)。该报告区分公开证据、独立推导与工程选择。
> 关联：[资产管线](./06-从2D概念图到3D游戏模型管线.md)、[绑定评审](./15-绑定与蒙皮面板技术美术评审.md)、[场景及持久化](./14-Scene系统与场景数据持久化架构设计.md)。

## 0. 产品目标与本次修订

用户导入一段 mocap，应用到约 2 米和 0.5 米、以及四肢和躯干比例不同的角色时，默认生成符合所选运动语义的动画：自由运动保留姿态风格，支撑动作保持正确接触，无法满足的约束可见且可定位。

完整目标包括走路、转身、跳跃、手掌支撑、走路进入翻滚、胸背接触及体型引起的穿插。分阶段交付；**完成足部 MVP 不代表完成翻滚或全身体积接触**。优先离线烘焙为现有动画轨道，运行时播放普通 FK 动画。动态地形、运行时变速和物理平衡不属于离线保证。

文件名保留以维持引用；这里的 MotionMatch 指动作重定向适配，不是从动作数据库检索片段的 Motion Matching。

| 旧版假设/计划 | 本版决定 |
|---|---|
| 逐链比例映射已消除比例引起的滑步，接触只是加固 | 接触是核心约束；根与末端比例不同会使映射后的静止脚漂移 |
| 手臂、脊椎永久属于 FK 区，HumanIK 也是如此 | 保留全身 FK 基准，按时段任务和权重选择参与求解的关节；不能如此推断 HumanIK |
| 所有末端都守恒“链根相对位置 × 链长比” | 自由、支撑、滚动、滑动、物体接触、身体接触使用不同目标空间 |
| `Hips + rest 固定偏移` 得到当前链根 | 使用真实目标 FK 链根，包含父层级旋转 |
| 只传目标 `RetargetClip` 就能恢复源目标信息 | 显式保留源 rig、源采样姿态、单位和根运动语义 |
| 只根回退一次便可完成接触修正 | 共享根和活动约束迭代求解，按残差终止；双支撑不可行须报告 |
| 地面处理留待 L4 下一轮 | 足底标记、地面标定与不穿地从足部 MVP 开始实现 |
| 所有等比输入都必须原样输出 | 恒等验收要求源接触正确、无冲突任务且不需要清理；源滑动清理会有意改变姿态 |
| `translation === null` 等价于 in-place 且锁脚无意义 | 轨道缺失、in-place、世界轨迹分别建模，按可用轨迹/相位判断能力 |
| 一个约 600 行的 `motion-match.ts` 实现全部规则 | 按源采样、目标构造、接触、求解、时序、集成划分 owner |

HumanIK 公开的是朝向初始化、效应器配置、IK pass 与补偿参数。本项目不声称复现其未公开的 Auto 比例公式，也不把 Floor Contact 等同于整段锁脚或全身碰撞。

## 1. 当前代码基线（已检查，非新增能力）

| 现有 owner | 当前责任与缺口 |
|---|---|
| [`retarget.ts`](../apps/editor/src/services/binding/retarget.ts) | `retargetBvh` 做骨向换基和根位移缩放；`RetargetClip` 只有时间、目标局部旋转与可空根平移；另有 `clipToAnimClip`、`skeletonRestWorldPositions` |
| [`bvh-parser.ts`](../apps/editor/src/services/binding/bvh-parser.ts) | BVH 解析、语义骨映射、参考骨架；新采样器复用解析结果 |
| [`binding-math.ts`](../apps/editor/src/services/binding/binding-math.ts) | 矩阵/四元数、蒙皮和拟合等混合责任；冻结责任增长，不堆接触或全身求解 |
| [`main.ts`](../apps/editor/src/main.ts) | `retargetInto` 只缓存目标 clip/report；承担两个 BVH 入口、预览应用及导出编排。新增任务前抽离本场景簇 |
| [`binding-export.ts`](../apps/editor/src/services/binding/binding-export.ts) | 消费动画输入并写 GLB，不拥有空间补偿规则 |
| [`asset-meta.ts`](../packages/scene/src/asset-meta.ts) | `RigSettings`、`AnimationSettings` 等 sidecar 契约；尚无本文完整配方/接触标定字段 |

L0 当前公式 `R'_i = A_parent · R_src_i · A_i⁻¹`；`computeSkeletonScale` 使用 `Hips.y − min(关节.y)` 的目标/源比。该量不是大腿＋小腿链长，也不是标定后的骨盆到脚底高度。

新路径复用 L0 旋转基准，从源采样重新构造根目标，**不能把已缩放的 L0 根轨道再缩放一次**。旧 L0 直接调用作为明确的 FK 基准模式保持自身契约；新路径按新标定和验收语义实现，不为保住旧断言沿用错误尺度。

姿态基准公式分层（2026-09-15 钉板）：源为 BVH（rest 是纯平移链，姿态差编码在**骨向**里）时，用 L0 的**方向最小弧换基** `A_i = quatFromUnitVectors(d_src_i, d_tgt_i)`；源与目标标定都携带完整 rest TRS（glTF→glTF）时，用研究报告 §4.2 的**世界 rest 换基**（roll 精确传递）。两式在「rest 差异只由骨向表达」时一致；BVH 源**禁止**用世界 rest 换基（其 rest 世界旋转恒为 identity，公式会退化为直接拷贝、把 A-pose 偏移带进目标——正是 L0 头注释里的坑）。选择显式记入配方 `rotationBaseline: 'direction' | 'world-rest'`，`rig-calibration` 对不兼容组合产出诊断并拒绝，不允许隐式切换。

## 2. 层编号与数据流

L0–L4 是责任层，不是固定执行顺序，也不是动画师控制器的 IK/FK 模式。

| 层 | 责任 | 输出 |
|---|---|---|
| L0 | 参考姿态、骨轴映射、旋转基准 | 用于风格保持与 A/B 的 `basePose` |
| L1 | 根尺度、自由运动归一化、物体/身体空间目标 | 根候选、自由末端及朝向任务 |
| L2 | 固定骨长的姿态求解 | 两骨解析核、共享根约束解，后续全身解 |
| L3 | 接触时段与目标空间选择 | 置信度、稳定落点、滚动枢轴和活动约束 |
| L4 | 时间连续、质量评估、烘焙交付 | clip、诊断、指标和可复现配方 |

```text
源 BVH/导入描述 + 目标标定 + 资产配方 + 环境契约
 → 源采样（米、秒、统一轴；保留世界轨迹或缺失状态）
 → L0 旋转基准 + L1 根/自由目标
 → L3 从源标记识别接触，构造世界/物体/身体任务
 → L2 用共享根、固定骨长和活动约束求解
 ↔ L4 在窗口内调整连续性、复算约束，直到收敛或显式失败
 → 烘焙适配：统一世界解 → 指定输出骨架的节点局部 clip
 → 同一局部结果 clip → 预览（clipToAnimClip）或 GLB（binding-export）
 → 配方/摘要写 sidecar；场景特有约束写场景；临时缓存可重建
```

## 3. 空间补偿规则

### 3.1 坐标、根与足迹

先统一米、秒、up/forward 和四元数约定。`C` 是固定世界朝向对齐，`o_s/o_t` 是对应支撑平面的参考原点。默认 profile 保持归一化步态：

```text
h_s/h_t = 参考站姿骨盆到各自支撑平面的高度（包含足底标定）
s_root  = h_t / h_s
S(p)    = o_t + s_root · C · (p − o_s)
H_bar(t)= S(H_source(t))
```

标定须满足 `S(H_source_ref) = H_target_ref`。这是本项目选择，不称为 HumanIK Auto。根与默认足迹共用 `S`；不能用最后整体下降掩盖平面/原点错误。

业务若要求保持现实米制路径或固定物体，选择 `preserve-world`：不按角色尺寸缩放这些世界目标，允许姿态/相对步幅改变。模式持久化。运行时速度比例 `v_game/v_clip` 是独立问题，不混入身高比。

两种模式的目标构造规则（2026-09-15 钉板，MR-02 实现依据）：`normalize-gait`（默认）下根、默认足迹与自由末端共用 `S`；`preserve-world` 下接触锚点与世界物体目标**直接取源世界坐标**（不乘 `s_root`），根的竖直分量仍按 `h_t/h_s` 归一（骨盆离地高度是身体属性），根的水平轨迹降为软目标、由求解器在「锚点固定」约束下重排步幅，`S` 只继续用于自由末端的相对身体目标。模式写入配方 `spaceMode`，单个配方内不允许混用。

### 3.2 自由部位

链根 `A`、链长 `L`、标定后的附着框架 `U`：

```text
u_source = inverse(U_source) · (P_source − A_source) / L_source
P_free   = A_target + L_target · U_target · u_source
```

`A_target` 来自真实 FK。该目标是软任务，允许降低自由手臂的位置权重以保留摆动，不能覆盖接触。GMR 分部位径向缩放可作比较策略，不把其中调校系数当作自动骨长比。

接触时不能继续直接用自由目标：若 `P_hat = r_root H + r_tip(P − H)` 且源脚静止，则 `dP_hat/dt = (r_root − r_tip) dH/dt`。IK 精确跟踪这个目标仍会滑步。

### 3.3 接触与标记

| 任务模式 | 空间及约束 | 阶段 |
|---|---|---|
| 自由摆动 | 链附着空间目标＋姿态软约束 | MR-02 |
| 稳定足支撑 | 同时段固定世界落点 | MR-03/04 |
| 脚跟→前掌→脚尖滚动 | 固定当前支撑标记，允许足部旋转 | MR-03/04 |
| 有意滑动 | 法向高度约束＋切向轨迹 | MR-03/04 |
| 手掌支撑 | 掌面世界标记；肩/臂/脊椎/骨盆协同 | MR-07 |
| 抓物、手触身体 | 物体局部点或目标身体对应表面点 | MR-07/08 |
| 胸背翻滚 | 随滚动切换的表面支撑、不穿透 | MR-08 |

稳定时段 `I_k` 的初始落点：`a_k = projectToPlane(S(median(P_source_marker[I_k])))`。时段内保持固定；允许调整脚印时，`a_k` 是整段共享变量并惩罚偏离初值，不能逐帧重设。

脚底局部标记为 `b_target` 时，踝目标 `P_ankle = a_k − R_foot_world · b_target`。求解后按新的父旋转恢复指定足部世界朝向，再用最终姿态重算标记验收。不能用踝静止代替脚尖静止，也不能无条件固定源脚跟/脚尖的原始间距。

### 3.4 无动画师时的识别规则

可信标注优先；否则使用源标记高度、世界速度、进入/退出滞回、最短持续时间（秒）与置信度生成接触段。阈值按标定高度归一化，速度用实际时间差，不固定帧数。

- 未知地面可从长时间稳定候选拟合，保留来源/置信度；低置信度必须诊断。编辑器可提供已保存的平地烘焙配方，不硬编码场景地面。
- 显式区分 `world-trajectory`、`in-place-with-trajectory`、`in-place-with-phase`、`unknown`。仅相位可指导局部摆动，不能承诺世界锁脚；锁脚需要可重建的位移轨迹。
- 禁止逐帧将最低骨/最低脚归零，保留跳跃与腾空。
- 低高度不自动等于静止支撑；滚动、滑动、自由运动分别建模。手掌/胸背自动接触必须有相应表面标记与环境证据，缺失则报告能力未覆盖。

## 4. IK、共享根与时间求解

### 4.1 两骨解析核

根 `A`、末端 `T`、骨长 `l1/l2`，`D=|T−A|`，可达域为 `|l1−l2| ≤ D ≤ l1+l2`。非退化情形：

```text
e = (T − A) / D
a = (l1² − l2² + D²) / (2D)
b = sqrt(max(0, l1² − a²))
K = A + a·e + b·v    // v 正交于 e，来自映射后的源弯曲平面
```

处理零骨长、`D=0`、完全伸直、180°、pole 退化和跨帧连续。不可达预览近似必须记录内/外半径残差；总链长相同比不保证可达。

最小 from-to 旋转通常已经是 swing，不能再次分解它便宣称保住 twist。用基准骨朝向/源弯曲平面定义扭转保持，足/掌世界朝向单列任务。`q` 与 `−q` 是同一旋转，按相邻四元数点积选半球，不按轴投影正负防翻转。

### 4.2 共享姿态约束

变量为一个共享根/骨盆、参与的关节角及可选时段落点。优化姿态偏离、自由末端误差、根轨迹偏离、脚印调整与时间修正；位置残差按目标尺寸归一化，旋转用 SO(3) 对数。

活动约束为接触标记固定、不穿透、关节范围；固定骨长由 FK 保证。足部阶段可固定躯干基准，联合求根＋双腿，这是阶段能力限制，不是永久 FK 分区；MR-07 开放肩/脊椎等自由度。

用阻尼 Gauss–Newton/SQP 或等价可验证约束方法，记录残差、迭代与终止原因。两骨核用于适用链的初始化/子解，不代替共享约束。详细方程见研究报告 §4.7。

不以“只修一次骨盆”判成功。约束冲突时显式放松软姿态/根目标或允许时段落点调整；硬接触仍超标则 `partial/failed`。禁止静默拉骨、移动固定物体或以平均误差隐藏单脚失败。

### 4.3 时间连续

保留源节奏，对相对基准的修正做时间正则。接触切换采用秒制过渡和窗口，跨窗口携带同一段落点；平滑后重新评估约束。足部 MVP 就包含这一层。

## 5. 数据契约、持久化与边界

下表为待实现语义，最终 TS/schema 由 MR-01 落定；本轮只改文档。

| 契约 | 必需信息 | 真源/生命周期 |
|---|---|---|
| `RetargetRig` | 稳定骨 id/映射、parent、参考局部变换、链、关节范围、坐标标定、足/掌/表面标记 | 骨架由资产派生；源标定进源资产 sidecar，目标标定进目标资产 sidecar，各为唯一真源 |
| `SourceMotion` | 秒制时间、源 rig、可采样局部/世界姿态、根模式、单位/轴来源、源指纹 | 从源重建；采样缓存不复制到 sidecar |
| `RetargetRecipe` | 版本、源/目标引用及 hash、双方标定指纹、profile、环境、尺度规则、接触标注/检测配置、权重、容差、算法版本 | 派生动画资产 sidecar；引用双方标定，不复制一份可编辑标定 |
| `ContactSegment` | 稳定 id、标记/链、起止秒、模式、参考空间、来源/置信度、落点/枢轴 | 标注覆盖进配方；自动结果可缓存并存摘要 |
| `RetargetEnvironment` | 源/目标平面、物体/表面映射、标定来源；场景引用用 `NodeId` | 平地烘焙配方或场景节点/组件，不在引擎硬编码 |
| `RetargetOutcome` | `complete/partial/failed`、可空目标节点局部 clip、输出骨架/父层级指纹、逐段指标、诊断、能力覆盖、依赖指纹 | 可播放结果才交预览；不完整不标“验收成功” |

接口语义为 `retargetMotion({source, targetRig, basePose, recipe, environment}) → RetargetOutcome`。`RetargetOutcome` 是运行期求解结果契约；它刻意**不与** [`retarget.ts`](../apps/editor/src/services/binding/retarget.ts) 既有导出 `RetargetResult`（L0 的 clip+report 二元组）同名——两者不同形，session 层同时引用时同名只会制造歧义，禁止改回同名。`basePose` 必须与源/目标/时刻一致。输入不可变，支持取消，失败不覆盖最后已验收产物。

源侧 `SourceCalibration` 和目标侧 `TargetCalibration` 分别保存于各自资产 sidecar：包括不能从资产反推的足/掌标记、参考站姿/支撑平面标定、单位和轴向覆盖及版本。MR-01 的 BVH 源资产接入必须支持该标定，不将其仅存采样缓存。配方只引用双方标定指纹；任一标定修改均使结果失效。临时载入的外部 BVH 在保存可复现配方前须进入源资产身份/sidecar 管理，不能只记浏览器临时文件名。

`RetargetResult.clip` 明确使用**指定目标实际骨骼节点的绝对局部旋转（xyzw）和局部平移**，不能直接装入统一世界求解值。新增 `bake-adapter.ts` 负责输出转换：先将规范世界解转换回目标资产/实例坐标，再用实际目标父世界变换的逆矩阵计算 `M_local = inverse(M_parent_world) · M_joint_world`，分解为局部 TRS；保留未动画的目标参考平移/缩放。根骨有容器或骨架父节点时也按此规则，不能只对四肢转换。单位、参考旋转、骨名到实际节点映射及输出父层级均纳入适配和指纹。

现有 `RetargetClip` 只容纳旋转和 Hips 平移，因此本阶段输出要求固定骨长/参考局部缩放、非 Hips 关节无新增平移自由度；适配不可表达时显式拒绝，不丢轨道。正的统一父缩放、父平移/旋转必须支持；非均匀缩放、反射或 shear 若不能经标定烘入合法刚性骨架，报告不支持。预览和导出若父层级/参考姿态不同，各由同一世界解确定性适配到相应输出骨架，再比较规范世界读回结果；不能跨不同父空间复用裸局部数组。`clipToAnimClip` 与 `binding-export` 只消费已适配的局部轨道。

报告包含根/链尺度、接触覆盖与置信度、每段最大落点偏差、累计切向滑动、最大穿透、内/外可达残差、关节超限、根修正、切换跳变、时序残差、迭代/收敛状态、耗时及峰值内存；米/秒/角度单位明确，不只报 `maxStretch`。

持久化归属 `packages/scene/src/asset-meta.ts`；复杂字段提取到拟新增 `retarget-meta.ts`，由 AssetMeta 引用，禁止 scene 反向依赖编辑器。先正式 schema、校验、迁移/往返，再接保存。当前 `AssetKind` 未列 BVH，MR-01 必须明确源动画导入类型/引用并补验证，不能冒充 glTF 或藏到 `userData`。

场景特有接触先扩 `document.ts` 及迁移，MR-08 单独声明这个 owner。源/目标 hash、参考姿态、标记、配方、环境或算法版本变化使结果失效。缓冲和详细日志进 `.workbuddy/cache/`；轨道进派生 GLB，配方可在重载后复现，不造双真源。

## 6. 生产与测试 owner

拟新增 `apps/editor/src/services/binding/motion-retarget/`，简称 `MR/`；测试为 `apps/editor/test/motion-retarget/`，简称 `MT/`。以下均为规划路径，不建泛化 utils 或按行数拆分。

| 责任 | 生产 owner | 唯一测试 owner/归属 |
|---|---|---|
| 资产配方/版本 | 新 `packages/scene/src/retarget-meta.ts`，由 `asset-meta.ts` 接入 | 新 `packages/scene/test/retarget-meta.test.ts`：配方迁移校验；原 `asset-meta.test.ts`：AssetMeta 集成 |
| 内存合同 | `MR/contracts.ts` | `MT/contracts.test.ts`：形状、身份、时刻、单位 |
| 源采样与标定 | `MR/source-motion.ts`、`MR/rig-calibration.ts` | `MT/source-motion.test.ts`：采样/轨迹；`MT/rig-calibration.test.ts`：参考姿态/轴/标记 |
| 空间目标 | `MR/space-targets.ts` | `MT/space-targets.test.ts`：根/链尺度、坐标与错误目标反例 |
| 接触语义 | `MR/contact-segments.ts` | `MT/contact-segments.test.ts`：支撑/滚动/滑动/跳跃/置信度 |
| 两骨几何 | `MR/two-bone-solver.ts` | `MT/two-bone-solver.test.ts`：解析解/可达域/pole/末端朝向 |
| 共享姿态 | `MR/pose-solver.ts` | `MT/pose-solver.test.ts`：双支撑/根/限位/手支撑/不可行 |
| 时间窗口 | `MR/temporal-solve.ts` | `MT/temporal-solve.test.ts`：切换/跨窗口/保留源动态 |
| 身体表面 | `MR/surface-contacts.ts` | `MT/surface-contacts.test.ts`：物体/自身/胸背及穿插 |
| 质量指标 | `MR/quality-report.ts` | `MT/quality-report.test.ts`：已知轨迹指标/阈值/能力覆盖 |
| 算法编排 | `MR/pipeline.ts`，仅连接 owner | `MT/pipeline.test.ts`：输入不可变/依赖一致/取消/顺序 |
| 输出坐标/轨道适配 | `MR/bake-adapter.ts` | `MT/bake-adapter.test.ts`：世界到实际父局部、参考变换/单位、可表达性与输出骨架指纹 |
| 载入、预览、导出会话 | 新 `services/binding/retarget-session.ts`（放在 `binding/` 下而非 `motion-retarget/` 内是**有意的**：session 编排预览/导出/失效检查，范围超出算法层，禁止实施时当笔误“纠正”），`main.ts` 只调用；诊断汇总（状态＋逐约束残差）在此输出，呈现 UI 另开后续单元 | `MT/retarget-session.test.ts`：两入口/重载/失效/失败不覆盖 |
| 最终烘焙验收 | `bake-adapter.ts` 交付局部轨道，复用 `clipToAnimClip`、`binding-export.ts` 消费 | `MT/bake-acceptance.test.ts`：最终轨道读回与业务组合；原 `binding.test.ts` 继续拥有绑定/蒙皮合同 |

现有 `retarget.test.ts` 只拥有 L0 基准/API，不追加接触。`main.ts`、`binding-math.ts`、`binding-export.ts` 不增加求解规则；`retarget.ts` 现有换基/动画转换混合，不再增加源接触或新 rig 构建责任。共享 fixture 仅提供输入与独立 oracle，不能用被测目标生成器计算预期值。

## 7. 开发队列

全部状态为 **待开发**。本次完成的是计划修订和研究归档，不勾选任何新增功能。

全部单元按下方表格状态推进（2026-09-15 起随交付逐行更新；MR-06 之后的单元仍为待开发）。

| 单元 | 依赖 | 声明的 owner / 交付 | 最小验收 | 状态 |
|---|---|---|---|---|
| MR-01 数据和持久化 | 无 | `retarget-meta.ts`、`asset-meta.ts`、`MR/contracts.ts` 及对应测试；源身份、源/目标独立标定、单位/轨迹、版本/迁移 | 旧资产迁移/往返、新版拒绝、双方标定保存/读取与指纹；无轨迹不伪造 world 模式 | **已交付 2026-09-15**（未接 UI；scene:check 的 meta 哈希失配为 worktree 既有问题——2026-09-15 独立审核实测 28 项、交付前即存在且与本交付无关，未擅跑 scene:gen） |
| MR-02 源采样、标定、空间目标 | MR-01 | `source-motion.ts`、`rig-calibration.ts`、`space-targets.ts` 及测试，复用 parser/L0 | 等比 2m/0.5m、非等比腿、轴/单位等价、2cm 漂移反例、根不二次缩放 | **已交付 2026-09-15**（world-rest 基准已实现并有公式自洽测试；BVH 路径固定 direction 并守门） |
| MR-03 足部接触语义 | MR-02 | `contact-segments.ts` 及测试；标记/平面、时段/锚点、滚动/滑动 | 噪声、30/60/120Hz、脚跟到前掌、跳跃不归零、in-place 不误判 | **Support detection and executable annotation validation delivered.** World locks require declared/trusted trajectory and source foot calibration. Slide/roll annotations are retained but explicitly partial; their solvers remain pending. |
| MR-04 两骨与共享根 | MR-02/03 | `two-bone-solver.ts`、`pose-solver.ts` 及测试 | 双支撑、大小腿比例差、内/外可达域、足底/朝向、不穿地、冲突诊断 | **已交付 2026-09-15**（GN 只用于共享根平移，yaw 不受污染；A06 朝向任务在 two-bone 侧验收） |
| MR-05 连续性和质量 | MR-04 | `temporal-solve.ts`、`quality-report.ts`、`pipeline.ts` 及测试 | 切换/窗口连续、平滑后约束有效、complete/partial/failed 正确 | **Refined in `mr-foot-2`:** seconds-based smoothing, final re-solved correction metrics, independently measured anchors, inner/outer reach and convergence gates. Remaining temporal violations return partial; real-clip performance measurement remains in MR-06. |
| MR-06 足部编辑器/烘焙闭环 | MR-01/05 | 新 `retarget-session.ts`、`MR/bake-adapter.ts`；抽离 `main.ts` 场景簇；最小接入预览/导出/sidecar；session/adapter/bake 测试 | 两入口规范世界结果一致；含父平移/旋转/统一缩放的导出读回；双方标定刷新复现/修改失效；2m/0.5m 真实 walk/turn/jump。到此仅足部 MVP | **会话与接入交付 2026-09-16**（bake-adapter 已于 09-15 交付；6b58632 + 审核修复 438783e）：`services/binding/retarget-session.ts`（两入口统一会话：源/目标/标定/配方/结果、stale 同版本守门 + 消费点（导出/应用/exportDryRun）二次守门、syncTarget 目标漂移失效、失败/取消不覆盖、配方标定缺失拒绝（MRS_RECIPE_CAL_UNBOUND，R13 会话层可达）、sidecar merge 读写、呈现层只读视图）、`retarget-workbench.ts`（状态徽章 通过/部分完成/失败/待更新、源·目标双视口预览、接触时间轴与问题帧、诊断汇总）+ `main.ts` 两入口接入（入口 A fit→合成骨架、入口 B 场景骨架，共用同一求解/烘焙路径；冒烟 `hook.anim` 形状不变）+ `MT/retarget-session.test.ts`（A14 两入口一致/烘焙读回/配方重载复现、失败/取消不覆盖；A16 标定 sidecar 往返与单侧失效重绑；15 测试）。全仓 697 测试/typecheck 0/editor:build 过；headed 真实 GPU 冒烟动画段全过（A-pose 45° 消偏、22 骨映射、23 轨道导出、E-04 挂载自动播放）+ 工作台定向验证 13/13（dock 打开/徽章状态机/三画布非空）；冒烟其余 6 项失败经 HEAD 复跑确认为既有（场景物体数期望 5 项、自动半径公式 1 项），与本交付无关。**独立审核一轮 FAIL→修复于 438783e→复审 PASS**（P0 导出/应用消费点绕过同版本守门、P1 入口 A fit 拖改不失效与配方标定缺失静默重绑、P2 spaceMode 回显自持与地线硬编码 y=0，全闭合并补 5 项回归；A14/A16/对话三态/§9 复审全通过；全仓 702 测试）。**用户真实浏览器业务验收一轮 4×P1+4×P2 → 修复于 ed5c94e → 独立复审 PASS → 跟进 efc3299（P2 播放中路径输入回显覆盖 + P3×5 收口）→ 终审 PASS**（标定 sidecar 载入/保存闭环 + 动作位移纠正 setSourceRootMotion、首载空白（先 resize 后绘制）、错误载入保留工作状态 + 一次性通知、时间轴 seek 场景蒙皮角色 + 投影视口标签诚实化、诊断块排版/时间轴点击扣标签区/未评估指标不给 0.00mm/问题帧只含未兑现段；浏览器定向验证 27/27、全仓 703 测试）。**二轮业务复验（Luna 独立测试）2×P1+2×P2 → 修复 → 独立复审 PASS**（标定归属：源/目标标定按几何身份验明——标记骨存在 / rest 骨盆高 35% 带宽 / 最低标记隐含足底贴平面，换骨架自动停用+警告、显式错配拒绝、同骨架换 clip 保留；R13 拒收窄为「配方与当前同一输入匹配却缺标定」；入口 B 重生成后自动重挂载新轨道并提示「新轨道已应用到…」；路径输入即时启用载入；问题帧排除 info 且纳入残差超容差段（summary.tolerances）；浏览器定向验证 34/34、全仓 708 测试）。**口径澄清（复审确认）**：已交付的是「已有 sidecar 标定的载入/保存/复用」；**首次标定的标记创建/编辑 UI（视口拾取）、完整配方保存/恢复 UI（派生资产）、工作台内完整蒙皮预览（入口 A）均未交付**，分阶段开发中。**85620c9 复审三 P1 已修复（b840ac6→13b9bd2，独立复审三轮闭环）**：①停用几何标定保留单位声明（targetUnitCtx + 人形区间 [0.1,5]m 候选链：残留→默认米→厘米推断 MRS_TARGET_UNITS_INFERRED）；②pelvisHeightM 按契约即骨盆到支撑面相对量，判据不再二次减 planeY（角色+地面同抬保留）；③判据为链推导足类逐标记带宽（3 骨腿链末端骨，与 pipeline footMarkers 同源）——单侧拉长/缩短都在该标记自身暴露，非足类标记只受上界（手部不劫持）。**剩余**：真实 mocap 2m/0.5m walk/turn/jump 验收（待真实数据）；首次标定的标记创建/编辑 UI（视口拾取，当前仅 sidecar 载入/保存/复用）；完整配方保存/恢复 UI（派生资产 sidecar）；工作台内完整蒙皮预览（入口 A；入口 B 已由自动重挂载 + 时间轴 seek 覆盖）；单足标定只保护单侧的数据模型边界（UI/sidecar 校验层提示）；solve 期「声明平面 vs 采样足底」合理性诊断；基线构建失败时兼容检查静默跳过（极端骨架）；目标侧停用/单位诊断的指纹过期（源侧已做）；stale 态 tolerances 与旧残差的口径；slide/roll 问题帧分层的产品判断；重载同 BVH 保留位移声明；播放期轻量重绘；MR-07/08 |
| MR-07 手掌与全身求解 | MR-06 | 扩展 pose、标定/接触 owner 及各自测试，开放肩/脊椎/根自由度；bake 组合验收 | 走路→掌面支撑、手脚同支撑、自由摆臂风格、真实手支撑烘焙 | 待开发 |
| MR-08 表面及翻滚闭环 | MR-07 | `surface-contacts.ts` 及测试；场景部分另列 `document.ts`/迁移/测试单元；最小接入 pipeline/bake | 胸背滚动、手触身体、固定抓物、不同体积不穿插；真实“入场→翻滚→起身”导出读回 | 待开发 |

实施前重核现有 owner；需要表外 owner 时先说明影响并按项目规则取得授权。MR-06 的当前预览/导出具体适配文件属于上述声明范围，业务规则仍归新会话 owner。本次不提前改生产代码。足部 MVP 后继续 MR-07/08，不将手臂或脊椎永久排除出用户目标。

## 8. 验收矩阵

数字为本项目拟定门槛，不是 Autodesk 保证。业务指标在最终烘焙读回后测量；解析核可用更严的数值容差。真实动作记录源噪声、模型尺寸、帧率、配方与能力覆盖。

| ID | 场景 / 独立判据 | 测试 owner |
|---|---|---|
| A01 | 正确接触的同骨架/严格等比，无清理及冲突任务：旋转差 ≤1e-5rad，S 映射位置差 ≤1e-5m | `bake-acceptance.test.ts` |
| A02 | 根比 .25、末端比 .20、源骨盆移动 .4m：自由映射有 .02m 漂移，不可直接锁脚 | `space-targets.test.ts` |
| A03 | 同动作 m/cm、不同 up/forward 和有效父变换，归一化输出差 ≤1e-5m | `rig-calibration.test.ts` |
| A04 | 接触与独立标注一致，30/60/120Hz 的秒制边界偏差不超过各自一个采样间隔 | `contact-segments.test.ts` |
| A05 | 可达双支撑/不同比例：标记误差 ≤1e-4m，骨长误差 ≤1e-6m；内外不可达显式报告 | `pose-solver.test.ts` |
| A06 | 父旋转改变后足部保持指定世界朝向（≤0.5°），支撑标记固定但允许踝移动 | `two-bone-solver.test.ts` |
| A07 | 切换/跨窗口不重设锚点；修正引入的速度跳变默认 ≤0.1×目标标定高度/秒，不误罚源动态 | `temporal-solve.test.ts` |
| A08 | 真实完整锁定段：最大切向落点偏差 ≤0.002×h_t，累计切向路程 ≤0.005×h_t，穿透 ≤0.001×h_t；过渡段单列 | `bake-acceptance.test.ts` |
| A09 | 无根轨道、零位移轨道、in-place＋轨迹、in-place＋仅相位能力有区别，不因 null/非 null 判成功 | `source-motion.test.ts` |
| A10 | 多接触/限位冲突定位到帧与约束；无 NaN、不静默拉骨 | `pose-solver.test.ts` |
| A11 | 跳跃不逐帧贴地，保留对应尺度的源高度变化 | `contact-segments.test.ts` |
| A12 | 手支撑调动必要全身关节；固定物体不随人物缩放 | `pose-solver.test.ts`（支撑）、`surface-contacts.test.ts`（物体） |
| A13 | 胸背滚动支撑点变化且表面不穿地，不同厚度分别验收，骨架正确不代替网格正确 | `surface-contacts.test.ts` |
| A14 | 两入口与导出同配方/结果，重载可复现，源/目标/标记/版本变化正确失效 | `retarget-session.test.ts` |
| A15 | 目标有非恒等父平移/旋转/正统一缩放；最终 GLB 读回转到规范世界后与求解结果差 ≤1e-5m，根不二次变换；不同输出父空间各自适配后结果等价 | `bake-acceptance.test.ts` |
| A16 | 源侧足底偏移、参考站姿/平面、单位覆盖重载后保持一致；改源或目标任一标定仅使关联配方失效，重算使用新指纹 | `retarget-session.test.ts` |
| A17 | 摆动相净空：非接触段目标脚底标记不低于支撑面（穿透容差同 A08），源腾空净空按 `h_t/h_s` 缩放后保留——短腿不刮地、跳跃不被压平 | `pose-solver.test.ts` |
| A18 | 根朝向轨迹：yaw 随源保留；等比恒等路径下转身的世界朝向差 ≤0.5°；非等比下锚点求解不得污染根朝向 | `space-targets.test.ts` |

滑步至少报告整段最大锚点偏差、相邻样本切向距离总和及速度分布，不只报最大单帧位移。若真实数据需调整门槛，记录尺寸、原因和批准的产品质量档，不能改变统计口径隐藏失败。

研究附录的二维数值验证只证明几何关系，不能替代本矩阵或真实骨架/蒙皮验收。各阶段需独立真实动作证据。

## 9. 失败矩阵和交付边界

| 发现 | 行为 / 状态 | 单元 |
|---|---|---|
| 单位/轴/标定不可信、时刻不一致 | 拒绝请求并指出字段，保留已有产物 | MR-01/02 |
| 输出父变换/参考骨架不匹配，或轨道无法表达所求解的自由度 | 重新适配指定输出骨架或显式拒绝；不把世界值直接写局部轨道，不静默丢平移/缩放 | MR-06 |
| 缺源轨迹或平面置信度低 | FK/自由运动可预览但为 partial，不承诺世界锁脚 | MR-02/03 |
| 缺足/掌标记 | 使用已保存代理并报告误差或标未覆盖；不以踝偷偷代替脚底 | MR-02/03/07 |
| 多接触不可达、限位冲突、不收敛 | 最佳预览＋逐约束残差，partial/failed，不覆盖成功产物 | MR-04/05/07 |
| 有意滑动被误锁 | 接触模式标注覆盖持久化，重新生成 | MR-03/06 |
| 仅骨架无法判断胸背/皮肤穿插 | 表面能力未覆盖，不报告翻滚完成 | MR-08 |
| 依赖指纹变化 | 结果失效并重算，缓存不作真源 | MR-01/06 |
| 取消/导出失败 | 不写半份完成状态，不丢原产物，说明失败阶段 | MR-06 |
| 动态地形/游戏速度偏离假设 | 离线保证失效，另开 runtime adaptation 单元 | 本离线闭环之外 |

只有影响真实数据、持久结果、运行时表现或本单元验收的问题阻断当前单元；无关静态清理进入 backlog，不全仓整顿。MR-08 未完成不阻断范围明确的足部阶段交付，也不能据此宣布完整目标完成。

## 10. 检查、性能和当前状态

- 单元默认只跑所属 `npx vitest run <测试文件...>`；改 L0 才加 `apps/editor/test/retarget.test.ts`，导出影响绑定才加原 `binding.test.ts`，不默认全仓 `npm test`。
- MR-01 涉 scene 公共契约时扩大到相关元数据/迁移消费者并说明原因；改 `assets/**` 必跑 `scene:check`，必要时先 `scene:gen`。改文档不触发资产门禁。
- MR-06/08 触及实际编辑器时做相应类型检查/`editor:build`、headed 真实 GPU 定向验证；共享类型需全项目 typecheck 时说明影响。保留接触测量和导出读回，不以启动成功替代。
- 求解耗时取决于帧数、自由度、约束、窗口和迭代；不再宣称千次运算或毫秒级。MR-05/06 测量真实 10s/60s 片段耗时/内存，支持进度/取消，再决定 worker 和缓存。
- 默认离线求解，普通播放不新增 IK。500 角色能否共享产物取决于骨架/配方/尺寸指纹，不假定所有体型共用同一 clip。
- 本轮文档 owner：本文维护合同/队列/验收，16A 保存研究证据与推导；README 只增导航。**生产文件及测试代码未改，现有 god file 未增长；仅做文档一致性、链接与 diff 检查。**
