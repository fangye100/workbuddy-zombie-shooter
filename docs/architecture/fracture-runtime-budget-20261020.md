# 碎片运行与预算（WU-04）

日期：2026-10-20。基线：codex/vfx-system-20261019（WU-03 批准 SHA 1e17e909 起；
本指南描述 WU-04 实现 SHA 6fbe874（含 R1–R6 审核修复）。
权威计划：fracture-system-development-plan-20261020.md（§3、§6.3、§10 WU-04、§11）。
上游契约：packages/runtime/src/fracture.ts（WU-01）；物理后端 packages/runtime/src/fracture-rapier.ts（WU-03）。

## 职责与边界

WU-04 交付通用碎片播放器（runtime）：真实/简化两层播放、准入校验、事件去重、
活动预算、TTL/淡出、异常原子清理、可观察统计、ObjectPool 租约账目。固定步长由
宿主经 tick(dt)/stepOnce() 驱动，渲染频率不反推物理时钟。

| 模块 | 职责 | 边界 |
|---|---|---|
| packages/runtime/src/fracture-runtime.ts | 碎片播放器 createFractureRuntime：两层、准入、去重、预算、TTL、统计、租约 | 不做 GPU 渲染（WU-05）、伤害/死亡（WU-06/07）、作者 UI（WU-08） |
| packages/runtime/src/fracture-rapier.ts | 真实刚体后端（WU-03） | 本单元复用，不改其契约 |
| packages/core/src/object-pool.ts | 通用借还/异常契约池 | 本单元复用，不另造重复通用池 |
| packages/runtime/src/fracture-activation.ts | 生产准入与激活准备：读验 profile/sidecar GUID/kind/status、唯一变换链、seed/来向驱动初始运动、离线 convex 端口 | IO 经注入端口；不碰 fs/DOM/僵尸策略 |
| packages/runtime/src/fracture-play-composition.ts | 宿主窄组合：Play 启动装配、初始+场景变化场景镜像、Stop 账目释放、重开新 session、时钟一致校验 | 复用既有 PlaySession 固定步长与 registerResource，不复制第二套时钟 |

碎片是装饰：不占用武器 ProjectilePool 配额（独立 ObjectPool 实例互不影响）、
不淘汰承担玩法职责的对象来满足视觉预算。NPC 可见姿态烘焙属 WU-07，GPU 刚体
网格属 WU-05，真实攻击/死亡接线属 WU-06/07——本单元不提前实现。

## 两层播放

- **真实层（large 块）**：创建真实 Rapier body，三轴位置/四元数/线/角速度、质量、
  摩擦、恢复系数进入求解器；正常容量下 large 块实际走真实路径，不全部回退简化。
- **简化层（small 块）**：有界简化三维积分（位置/速度/四元数/角速度 + 重力 +
  地面接触反弹 + 摩擦衰减 + 休眠）。简化块仍是 mesh 运动状态（ActiveChunk.sim
  持有三维变换与速度），不是伪装成 mesh 的 sprite；实际绘制留 WU-05。
- 简化积分不建物理 body、不占真实刚体容量；地面接触用 defaultGroundY（宿主可
  按静态镜像近似提供），禁用大规模块间求解。

## 身份、去重与代次

- 去重键 = fractureEventKey(target)：同 run/target 一次运行只碎裂一次；散弹/贯穿/
  爆炸/同 tick 多次伤害不重复破碎。重复事件计入 stats.deduplicated，不重复建 body。
- 句柄 key = `{eventKey}#g{sessionSeq}-{activationGen}:{chunkId}`，含进程唯一
  session 代次 + 激活代次：同 target 重开新 session 不复用旧 key，不误操作新 body。
- 公开事件经 frozenFractureEvent 冻结，不可池化后改写；池化的是内部 wrapper 租约。

## 准入校验（分配前）

play() 在分配任何物理资源/租约之前校验：碎块集合非空、chunkId 唯一非空、尺度为
有限正数、质量为有限正数、变换/速度分量有限、priority/lifetimeSec/fadeSec 合法。
非法输入返回 { accepted:false, rejection:{ reason:'invalid-activation' } }，不建 body、
不消耗租约。正式 profile 的 status 必须是 accepted（quarantined 隔离资产在激活前
拒绝）；profile/source/sidecar 身份核对由宿主在组合 FractureActivation 前完成。

## 预算、优先级与 TTL

- 活动真实刚体、简化块、事件队列分别独立有界（maxRigidBodies/maxSimplifiedChunks/
  maxEventQueue）。默认值 32/256/256 是计划 §6.3 的待测初值，**不是已测性能或
  永久上限**；理由：覆盖单场约 8–16 块 × 并发 2–3 处破坏的常见密度，待实测调整。
- 容量满时按优先级淘汰：低优先级 + 更老的活动块优先回收（retire 释放真实 body +
  归还租约），新进者优先级不占优则跳过该块并计入 stats.skipped（显式计数，不静默丢块）；淘汰计入 stats.evicted。
- TTL：ageSec 超 lifetimeSec 进入淡出，fade 从 0 递增至 1；fadeSec=0 立即退役。
  退役/淡出完毕释放真实 body 并归还租约，计入 stats.expired。
- 事件队列满拒绝新事件（queue-full）并计入 rejectedAdmission。

## 固定步长与生命周期

- tick(frameDtSec) 把真实时间累加进累加器，够一个 fixedStep 走一步；单帧最多补
  maxCatchUpTicks 步（默认 5），超出残余丢弃（宁可慢放不瞬移）。Pause=宿主不调
  tick，物理不推进；stepOnce() 恰推进一个固定 tick。
- 渲染频率不反推物理时钟：同总 dt 拆多帧与少帧的总步数一致（有界追赶内）。
- dispose()：先 retire 全部活动块（释放真实 body + 归还租约），再销毁孤儿租约
  （leasePool.invalidate），最后 leasePool.dispose() + backend.destroy()。
  重复 dispose 安全；dispose 后 play 返回 session-closed，旧 handle snapshot 为 null。
- 异常原子清理：物理资源先分配成功才消耗租约；激活中途任一块失败，本事件已建
  对象全部 retire（释放 body + 归还租约），无孤儿 body/租约。

## 可观察统计（CPU 链路）

stats 记录：rigidActive/simplifiedActive、queuedEvents、deduplicated、
rejectedAdmission、evicted、expired、skipped（满额跳块）、poolActive/poolHighWater、physicsMs/
integrateMs/updateMs、ticks。三角形/材质批/上传字节/GPU draw 属 WU-05/09 绘制
链路，本单元未测，不伪造零值或性能通过。

## 验证（实际命令与证据，SHA f540850）

- pnpm run typecheck：0 错误。
- pnpm run architecture:check：errors=[]（112 framework 文件）。
- pnpm exec vitest run packages/runtime：22 文件 190 测试全过，其中新增
  fracture-runtime.test.ts 32 测试：
  - 两层播放与真实物理组合：large 建真实 body 且速度进求解器、small 简化积分、
    固定输入同 seed 可复现（容差 1e-6）、正常容量 large 全走真实路径。
  - 去重与身份：同 run/target 去重、不同身份分别碎裂、句柄含 session+激活代次。
  - 准入：空块/坏尺度/坏质量/非有限速度/重复 chunkId 分配前拒绝且零 body。
  - 预算：满额高优先级淘汰低优先级并计数、低优先级不占优被跳过、TTL 淡出退役、
    淡出期 fade 递增。
  - 固定步长：不足一步不推进、Pause 不推进、stepOnce 恰一步、大 dt 有界追赶、
    渲染频率不反推时钟。
  - 生命周期：dispose 释放全部租约与 World 账目归零、重复 dispose 安全、建 body
    中途失败原子清理零泄漏、不占武器 ProjectilePool 配额、旧 handle 不复活。
  - 正式 profile 组合：P-01 油桶 12 大块全真实 body 且 90 tick 落地不穿透、
    E-04 NPC 3 大 7 小分层激活、quarantined profile 激活前拒绝。
- 实际加载 Rapier WASM（非 mock）；测试用 import.meta.glob 读正式 .fracture.json
  （仓库规约禁 node:fs）。

## 生产准入与激活准备（R1）

createFractureRuntime 不再接受调用方手工填的 chunks 作为唯一准入。生产共用准备
prepareFractureActivation（fracture-activation.ts）负责：读取并复用 scene 的
validateFractureAsset/validateAssetMeta 校验 profile/sidecar；核验事件 GUID=profile.id=
sidecar.guid 且 kind=fracture；quarantined 在分配 body/租约前拒绝（恢复 accepted 后下一次
播放重新准入，不缓存隔离状态绕开复查）；按唯一变换链（资产 bind/pivot→assemblyScale→
事件世界变换，只执行一次）生成 chunk 世界位置；由来向/接触/seed（mulberry32 确定性）
驱动初始线/角速度；离线 convex 代理经注入 resolveConvexPoints 端口真实读入。IO 经
注入端口（readText/readBinary），runtime 不碰 fs/DOM，Preview/Play 共用。

## 简化层场景接触（R2）

小块的有界环境接触复用真实场景 collider 镜像：后端 staticSupportSurfaces() 返回所有
静态镜像的顶部支撑面（世界 Y + XZ 范围），简化层每 tick 查询当前 XZ 位置下的最高
支撑面，质心停在 支撑面顶 + 块支撑半径（不把质心塞进地板）。无场景 collider（或
块移出有限平台边界）时继续下落，不生成无限地面。摩擦/恢复用 chunk 输入策略，
非固定常数。场景 collider 变化经 syncScene 更新镜像后支撑面随之更新。

## 唯一固定步长（R3）

碎片年龄/简化层与真实后端共享同一物理时钟：createFractureRuntime 校验 runtime
fixedStepSec 与后端 worldTimestep() 一致（容差 1e-6），不一致抛错，不让年龄与真实
物理时间脱离。宿主窄组合 bindFractureToPlay（fracture-play-composition.ts）在 Play
启动时装配：创建物理 session + 用宿主 fixedStep 初始化后端 + 首次场景镜像 sync +
登记 registerResource 进既有 PlaySession 账目。Stop 先 runtime.dispose（还租约/退役
碎片）再 session.dispose（销毁 World）；重开 = dispose 旧 binding/session 后 create
新 session 再 start（已 disposed 的 session 不再 start）。场景 collider 变化后调
syncScene 再次正式差分 sync，保留其他 owner 镜像。

## 分配原子性与失败计数（R4）

激活每个块：物理资源（addBody）先分配，成功后先入 built（携带清理所需 handle/layer），
再借租约（leasePool.acquire）。任何阶段（addBody/acquire/注册）失败，catch 回收 built
内全部（含当前块）的 body/租约，不突破预算、不留孤儿 World body；failedActivations
显式计数，后续事件与 Stop 仍可正常运行。

## 队列输入隔离（R5）

play() 入队即取不可被外部改写的深拷贝快照（复制嵌套数组与 convex TypedArray），
activate 用快照身份/变换，不再读外部可变对象。提交后改写调用方 chunks/event/TRS/
凸点缓存均不改变已提交请求、去重身份（seen 用入队时 eventKey）与激活结果。

## 代理尺度（R6）

chunk.shape 是未缩放的资产局部代理；激活时 scaledShape 按 scale 折进世界尺寸（唯一
一次，不重复乘）：box halfExtents、sphere radius、capsule radius/height、convex 点集
整体缩放（复制 TypedArray）。supportRadiusOf 推导支撑半径供简化层接触与 WU-05 显示
尺度共用。capsule 资产 halfHeight → 后端 height（全高）语义在 fracture-activation 核对。

## 边界与遗留

- 不实现 GPU 渲染（WU-05）、伤害/死亡策略（WU-06/07）、作者 UI（WU-08）。
- 宿主接线（PlayController 在 Play 启动 createFracturePhysicsSession + 场景变化后
  再 syncStaticMirrorsFromScene + 伤害事实转 FractureActivation）属 WU-06/07；
  本单元提供 createFractureRuntime 作为播放入口，由宿主按固定 tick 驱动。
- 简化层地面接触用单一 defaultGroundY，未按静态镜像逐块求高度（计划 §6.3 允许
  「复用现有碰撞查询或由后端提供有界环境接触」）；逐块接触精度属后续改进。
- NPC 当前可见姿态烘焙（WU-07）与离线凸代理读入（WU-04 接口已支持 convex 形状）
  属后续接线。
