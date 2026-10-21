# NPC 当前姿态致死碎裂（WU-07）

日期：2026-10-22。实现起点提交 `c7a2ae3e7b451b6be09a4916077f5956d866fee8`；
当前接管/资源修复源码提交 `e7d4625e7af73db787d1ce0ea2c346d84eec9467`；
WU 基线为已批准的 `aaed9502d37af27a83845f0ed8e5ca9254788245`。
本文记录实现与实测边界，逐 WU 放行仍以 supervisor 对最终 exact SHA 的批准为准。

## 用户入口与视角

原场景选择器打开“致死碎裂 WU-07 · NPC 当前姿态/真实kill/死亡保底”，路径
`assets/scenes/sandbox/fracture-wu07.scene.json`，已登记到 `aether.project.json`。
Play 后 WASD 移动，数字键 1–7 切枪，鼠标瞄准、J 开火；完成击杀强化选择后继续战斗。
右侧 E-04 配置 `SpawnPoint.deathFracture.profile`，E-01 为未配置的普通死亡对照。

Play/Pause 点“观察视角”或按 V：左拖环绕、右/中键平移、滚轮缩放；Esc/V 返回
游戏相机。游戏相机与编辑相机仍由原 `PlayCameraController` 保存/恢复。
原夹具错写 `yawOffset` 导致相机 attach 失败，已改为 schema 字段 `yawOffsetDeg`。
强化选择面板会按原规则阻止战斗输入，测试通过真实点击完成选择，不绕过此规则。

## 责任与数据流

| 责任 | 原模块及本次接线 |
|---|---|
| 致死、奖励、掉落、波次、槽位回收 | `packages/zombie-game/src/session.ts` 原 applyDamage→kill；冻结 CombatEvent/defeated。武器事实增加复制后的 origin/contact，不另建 HP 或死亡状态 |
| 配置加载 | `packages/zombie-game/src/loader.ts` 读取既有 v25 SpawnPoint.deathFracture；本次不增加 schema 版本 |
| 可见姿态 | `apps/editor/src/services/runtime-actors.ts` 提供原 normalization/jointNames；`runtime-bridge.ts` 保留同身份最后呈现行、palette pose、transition 来源/权重、position/yaw/tick |
| 死亡表现决策 | `play-controller.ts` 沿真实 kill 消费，按完整身份冻结快照、调用正式准备器；`npc-motion.ts` 只按 run/id/generation 抑制原 death 尾部 |
| 表面烘焙 | `packages/render/src/skin.ts` 原 skin owner 新增 `bakeSkinVertices`；只求值已冻结矩阵，不推进动画 |
| 准入、物理、租约 | 原 `fracture-activation.ts`、`fracture-runtime.ts`、Rapier 与 Core ObjectPool |
| GPU 绘制与资源 | 原 `fracture-renderer.ts`→CoreDynamicBatch；RendererCore.dynamicBatchState 读取原上传/绘制编码回执；Stop 仍由 PlaySession ledger 统一释放 |

Npc 配置为非空时，原 kill 事实（包括原 burn/DOT 致死）触发该表现；未配置不触发。
直接命中/爆炸使用原武器 origin/contact，burn 保留 damageKind，不借同帧直接命中序号。
没有接触事实时传 null，不伪造命中来向。失败不会回滚或重复执行游戏死亡与奖励。

## 当前姿态与坐标合同

正式资产仍使用 `assets/fracture/e04-bulwark/e04-bulwark.fracture.json` 的 10 个 skinned
分块和原 22 骨权重。`boneMap` 用于准入/身份关联，不再用单根骨骼代替完整 LBS。

死亡消费者在原模拟 advance 之后、bridge 下一次 refresh 之前，冻结上一实际呈现行。
用源 actor 的 normalization T 把 chunk 原顶点放到 actor 空间；palette 已为 T·S·T⁻¹，
按原四权重对位置（w=1）、normal/smoothNormal（w=0）求和并归一化方向，保留 UV/颜色。
过渡中的 shear、非均匀缩放和镜像完整进入顶点，取消单骨四元数近似。

posed AABB 中心作为 pivot；body.position = eventT + eventR·(pivot·eventScale)，
body.rotation = eventR，worldScale = eventScale。15-float bakedVertices 保留 posed 模型坐标；
原实例装配减去 R·scale·pivot，再应用同一刚体基。规范化、世界 TRS 和 pivot 均只应用一次。
原事件 tick 与最后呈现行 tick 分属模拟与呈现，不把 defeated 游戏位置当作可见顶点。

当前 NPC 支持正式资产采用的 box 代理与单位 bind；烘焙后用 posed bounds 建 box。
其他 NPC 代理/非单位 bind 明确拒绝并保留普通 death。物体路径继续支持原有合法代理和 bind。
烘焙只在触发时执行，不每帧读取 GPU 或重建所有 NPC。

## 成功、失败与生命周期

入队 accepted 不代表可见接管。全部预期块已激活、CPU 网格/纹理解码完成、原 GPU owner
实际完成实例/刚体/过渡数据上传及 draw 编码后，才隐藏同身份的完整 death；物理/容量或 GPU 失败撤销该事件
的装饰块和租约，保留原 death 并诊断。profile 每次读取当前文件，失败结果不缓存为永久状态。
坏 boneMap 进入失败诊断，异步异常被原消费者捕获。

每个请求带完整身份和单调次序；旧 generation 的迟到失败不能覆盖新请求诊断。
Reset/Stop/Start 清游标与待接管记录，所有异步结果仍核 binding 代次。
终态可用 tick(0) 消费已成立的表现事实，不额外推进物理时间。Pause 冻结，Step 推进一固定步。
Reset 核旧 runtime.disposed/active、poolActive 和真实 backend.ledger；Stop 恢复原作者快照。

本次真实 GPU 暴露了原简化支撑查询拒绝世界 Y≤0 的问题：竖线查询改为支持零高度与地下层。
初始与脚下支撑重叠的小块会被推出；仅考虑质心下方支撑，不抬到头顶平台。

## 实际验证

Windows DISPLAY1（1920,80）、headed Chrome、严格 TLS、实际编辑器 NVIDIA Lovelace，
isFallbackAdapter=false。记录均为本机范围，不是并发压力或跨设备性能认证。

| 命令 | 实际结果与原始证据 |
|---|---|
| `pnpm test` | 193 文件、2233/2233，exit 0；`.workbuddy/tmp/wu07-final-r2-vitest.log` |
| `pnpm run typecheck` | exit 0；`.workbuddy/tmp/wu07-final-r2-typecheck.log` |
| `pnpm run architecture:check` | 428 文件、0 错误；`.workbuddy/tmp/wu07-final-r2-architecture.log` |
| `pnpm run editor:build` | exit 0，保留原有 bundle 大小提示；`.workbuddy/tmp/wu07-final-r2-build.log` |
| `pnpm run scene:check` | exit 0；`.workbuddy/tmp/wu07-scene-final.log` |
| `node tools/verify/wu07-npc-death-probe.mjs --headed` | 23/23，无 console error/exception；`.workbuddy/tmp/wu07-repair-native/` |
| `node tools/verify/wu06-destructible-probe.mjs --headed` | 原真实武器/爆炸/遮挡/碰撞/导航/Reset/Stop 43/43；`.workbuddy/tmp/wu07-repair-wu06/` |

源表面测试以原正式 mesh 的所有共享顶点/法线为独立参照，覆盖完整 22 骨过渡、世界平移/
旋转/尺度、normalization、shear/reflection、非法矩阵，实际 posed bounds 进入真 Rapier。
集成测试补充坏 boneMap、GPU owner 分配失败、同 slot 跨 generation 迟到错误、Stop/Start
首帧击杀、profile 失败、非致死和普通 death 对照。受控 IO/GPU/事实边界均与原生输入区分。

GPU 主验收使用原生切枪、瞄准、J 击杀移动中的 E-04，3 真刚体+7 简化块、10 个几何/
20 个材质子批，核同帧 body/实例/pivot 最大位置误差小于 1e-4；实际本轮约 5e-8。
同时验证普通 E-01、观察视角、Pause/Step、Reset 旧真实后端 destroyed 与租约归零、Stop 快照。

版本化原始 GPU 结果见 [gpu-results.json](../evidence/fracture-wu07-20261022/gpu-results.json)，
[完整物体回归](../evidence/fracture-wu07-20261022/wu06-results.json)。
[原生击杀前](../evidence/fracture-wu07-20261022/e04-live.png)与
[切面近景](../evidence/fracture-wu07-20261022/e04-cut-close.png)保留实际画面。
旧失败 run 日志保留在 `.workbuddy/tmp/wu07-*`，不以新 PASS 改写历史。

工作区 catalog 有其他会话旧快照造成的 6 条既有错误，且旧快照缺本次新条目时会另报该指南未登记；本任务从已提交 HEAD 只追加自己的条目，
以待提交 catalog 的完整内容验证，避免吞入旧快照。证据见 `.workbuddy/tmp/wu07-review/`。

完整作者 Inspector/Apply/Save/重载属于 WU-08，联合压力/性能属于 WU-09；本单元不声明其完成。


## 第一轮独立审核与修复闭环

独立审核员 Hubble 对 `4b0ded763c2a977f5f6bf1c35bd51387760b1efb` 给出 FAIL，
原报告为 `.workbuddy/tmp/wu07-review/independent-final-4b0ded7.md`，原始反例保留不覆盖。
F07-01 实测两轮唯一姿态 GPUBuffer 残留从 2,944,296 增至 5,888,592 字节；
F07-02 实测实例上传失败时尸体已隐藏。正常路径通过没有覆盖这两项失败。

修复沿原 owner：drawDynamicBatches 在原写缓冲及 draw 编码后记录每个几何状态，
同几何任一材质失败则整帧失败；控制器只接受 ready 回执，pending 保留 death，failed 诊断并取消本事件。
Core 原 prefix 释放方法增加 keep 集合，控制器每次同步精确释放退役姿态网格，保留其他活动块、
角色及可复用共享贴图。没有新增上传队列或第二套死亡/渲染系统。

新增 `dynamic-batch-lifecycle.test.ts` 覆盖首次 pending、实例/刚体上传及 draw 编码失败、
同几何多材质失败、恢复以及保留真实资源替身引用的 destroy；控制器新增 pending 不隐藏测试。
死亡集成用例覆盖散弹/多爆炸/DOT、奖励/槽位一次、双 E-04 倒序异步与同槽新代，
GUID/quarantined/meta 恢复、满队列以及满 rigid/small/两类预算，均保留其他事件资源。
profile/Stop、meta/Reset、source GLB/真换场景、chunk GLB/Stop 分别覆盖迟到成功/失败，
明确核旧 body/lease/queued/disposed、内外守卫返回及新代诊断，不以只清 JS 引用证明释放。

- `node tools/verify/wu07-fracture-resources-probe.mjs --headed`：18/18，真实 NVIDIA/严格TLS/DISPLAY1。
  保留实际 GPUBuffer 引用包装 destroy；两轮到期均 aliveBytes=0，上传故障保留完整 death、
  active/pool 取消；撤销故障后新代合法 NPC 正常接管。受控伤害/故障明确区别原生主路径。
  完整原始记录见 [resources-results.json](../evidence/fracture-wu07-20261022/resources-results.json)，
  raw 为 `.workbuddy/tmp/wu07-resources-accepted/`。
- `node tools/verify/vfx-gameplay-probe.mjs --headed`：正式 Act1 三层 33/33，七种武器、普通 hit/burn、
  原生强化选择、自然冲锋 Ribbon 局部 GPU 可见及 Stop 全通过。
  仅修正测试导航：严格TLS、固定profile/DISPLAY1，恢复下拉框后焦点，并从只读原枪口几何计算
  指针侧向视差，不改变生产瞄准/伤害。早期探针射空记录保留为失败，不冒称产品回归。
  摘要与原始文件 SHA 见 [act1-summary.json](../evidence/fracture-wu07-20261022/act1-summary.json)，
  原始约1.96MB完整状态与截图在 `.workbuddy/tmp/wu07-act1-accepted/`。

原生23项、资源18项、Act1 33项、WU06 43项均在修复后重跑，无console error/exception；
全量2233、typecheck/build/architecture同步通过。scene:check沿用同字节正式场景的成功结果，后续未改资产。
GPU驻留结论取自实际资源引用/destroy证据；CPU准备/累计字节不作为精确GPU驻留或性能认证，
成本口径与压力认证仍由WU09实测。
