# 碎片运行与预算（WU-04）

日期：2026-10-20（2026-10-21 增补）。基线：codex/vfx-system-20261019，
WU-base = WU-03 批准 SHA 1e17e909；本指南描述的 WU-04 实现 SHA 为
509a4334c48dda5036aadae0bee9e24c2cad53c7（实现与测试；本文件是其后的
一笔仅文档提交，验收以 supervisor 绑定的 final 为准）。
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
- 简化积分不建物理 body、不占真实刚体容量；环境接触查询场景静态
  镜像的竖向扫掠支撑面（见 R2：只选本步下落能接触的面，不选头顶天花板），无场景支撑时继续下落，禁用大规模块间求解。

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
拒绝）；profile/source/sidecar 身份核对已由生产准入准备 prepareFractureActivation（R1）承担。

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

## 验证（实际命令与证据；数值以 final SHA 复跑为准）

- pnpm run typecheck：0 错误。
- pnpm run architecture:check：errors=[]。
- pnpm exec vitest run packages/runtime：22 文件 217 测试全过，其中
  fracture-runtime.test.ts 42 测试、fracture-activation.test.ts 19 测试、
  fracture-play-composition.test.ts 10 测试。
- pnpm exec vitest run packages/runtime apps/editor/test/play-controller.test.ts：
  23 文件 243 测试全过（play-controller 26）。宿主接线（R3）的 owner 证据在
  apps/editor/test/play-controller.test.ts（26 测试），其中「真实 PlayController.update
  推进碎片物理」「reset 换绑碎片代数」两条只经真实 update/pause/step/stop/reset
  驱动，删除 update→onFixedTick 接线会失败；账目用例断言每轮恰 3 项、
  20 轮登记/释放各 60 次。
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
播放重新准入，不缓存隔离状态绕开复查）；按唯一变换链（资产 bind TRS/pivot→事件世界变换，
assemblyScale 已含在事件世界变换、不二次乘，只执行一次）生成 chunk 世界位置；由来向/接触/seed（mulberry32 确定性）
驱动初始线/角速度；离线 convex 代理经注入 resolveConvexPoints 端口真实读入。IO 经
注入端口（readText/readBinary），runtime 不碰 fs/DOM，Preview/Play 共用。

## 生产激活入口与准入补强（W04-01/02/09）

PlayController.spawnFracture(event) 是生产激活入口：用编辑器 IO（/__fs/file）读
profile/sidecar/GLB，走 prepareFractureActivation + 生产凸代理 resolver，再交给
runtime.play。WU-06/07 的伤害/死亡策略从这里喂事件；不存在「只有测试调用准备函数」
的断层。

准入在分配 body/租约前完成以下检查，失败一律返回带 stage 的诊断：
- profile 版本/格式/quarantine、profile/sidecar/event 三方 GUID；
- profile.kind 与事件目标 kind 对齐（object 不能由 NPC 事件激活，反之亦然）；
- source.model 与每块 mesh 的 sidecar 身份；
- 引用资产的二进制可用性：能读到、非 LFS 指针、GLB magic 与声明长度一致
  （sidecar 合法不代表文件读得到）。已核验路径可按会话缓存，避免每次激活重读数 MB；
- 凸代理：按 15 浮点步长取 POSITION、减去 pivot、非退化校验（NaN/共线/共面/零体积）。

## 凸代理坐标合同（F2 续）

profile 的 pivot 是资产原始坐标里的局部点（实测 chunk-0009 原始 POSITION
y=0.6005..0.9005，pivot.y=0.789352）。因此解析器用
parseGlb(buffer, null, 'auto', { normalize: false }) 取未规整化坐标，再由准备函数
减去 pivot，得到「以 pivot 为原点」的代理局部系；body 平移 = pivot + 事件世界变换。
若改用默认的居中/贴地结果，碰撞体会整体偏离 body（chunk-0009 偏差约 0.79 m）。
测试同时覆盖 chunk-0001（pivot 接近原点）与 chunk-0009（pivot 远离原点），
并有手写已知偏移 GLB 的逐点闭式对照。

## 旋转与来向的输入合同（W04-03/04）

- 旋转：事件 rotation 与每块 bind.rotation 都必须是有限单位四元数。零/非单位
  四元数会在 Rapier 里静默产生退化姿态（不报错、物理失效），因此准入层明确拒绝并给
  transform 诊断，runtime 的 validate 再兜一层；两者都在 body/租约分配前生效。
- 来向：事件带 impulse 时以其方向为主；没有 impulse 时由 normal 决定初始方向
  （normal 缺失才回退世界向上）。反转 normal 会得到相反的水平初速度，不再出现
  「两个来向不同的合法事件产生完全相同初速度」。

## 资产验证状态不跨代共享（F4）

准入的二进制可用性核验**不做跨调用缓存**：路径曾经可读，不代表当前仍可读、仍是同一
版本。此前控制器持有一个共享的 verified Paths 集合，旧代挂起的读取在 Stop/重开之后
仍会写回该集合，导致新代跳过 chunk 读取并错误准入（监督用真实控制器复现：新代目标
GLB 完全不可读，spawnFracture 仍 accepted，下一次 update 建出 12 个 body）。

现在每次 prepare 都读当前字节（GLB magic + 声明长度 + 实际长度），失败在
body/租约/队列分配前返回 ref-binary；恢复合法源后可立即重试成功。旧代迟到的读取只
影响它自己的结果（最终返回 session-closed），不会改动任何跨代状态。
代价是每次激活重读引用资产；带版本/失效合同的资产缓存属后续资产管线（WU-05/09），
不在本单元另造缓存系统。

## 迟到 IO 与 reset 门同步（W04-08/09）

- 迟到读取：spawnFracture 的资产读取是异步的。await 之后重新核对
  this.fractureBinding === binding 且 binding.backend() 非空；不一致返回
  reason=session-closed 的结构化拒绝（可重试），不再对已释放 binding 取 runtime
  而抛未预期异常。
- reset：rebuildFractureBinding() 与 start() 一样在新 binding ready 后调用
  syncGateMirrors()，因此重置后 initialOpen 门在首个 tick 前就是权威姿态。
- 边界：syncScene(graph) 供宿主在场景文档变化时重建镜像；运行期门姿态走
  syncRuntimePoses。运行期 collider 的增删/禁用（非门）属 WU-06/08 的场景变更路径，
  本单元不接线，已在「边界与遗留」注明。

## 简化层的速度上限与接触窗口（W04-04/07）

- 速度上限：SimplifiedState 保存块级 maxLinearSpeed/maxAngularSpeed，积分起点
  夹紧线/角速度——此前只有 rigid 后端消费，小块会以 400 m/s 飞。
- 接触窗口：穿越判定用底面（质心 − 支撑半径）对支撑面顶扫掠，落地时质心停在
  top + radius。此前用质心对顶面判定，质心尚未到顶面就不接触，会先穿透约一个
  支撑半径再被抬回（实测从 0.76 掉到 0.512 才吸附到 0.75）。
- 胶囊语义：profile capsule.halfHeight 是含端帽的总半高；准备层换算全高
  2*halfHeight，后端再算圆柱段半高 height/2 - radius，世界顶点高度 = halfHeight。
  owner 用例逐级断言 {radius:0.25,height:1}。

## 启动时的初始门姿态（F3 续）

initialOpen:true 的门在运行时已处于开启姿态，而作者文档仍是关闭位置。控制器在
binding ready 后立即调用 syncGateMirrors()（不等首个 fragment tick），因此启动后
静态可观察状态、直接使用 binding 的宿主、以及首个 tick 的接触都基于当前权威姿态。
回归用沙盒里的 nd_gate_stairs（initialOpen:true）断言 ready 后镜像 y 已等于门姿态，
且高于作者文档的关闭位置。

## 运行期门姿态与终态（F3 续）

- 门：PlayController.syncGates() 在更新渲染对象后调用
  binding.syncRuntimePoses(gateSnapshot())，把 scene-mirror:<nodeId> 重定位到当前
  姿态（复用登记形状，不新建碰撞源）。
- 终态：PlaySession 在 game-over/floor-clear 后仍可能返回步数，但世界已冻结；
  update() 只在 outcome === 'running' 时驱动碎片，step() 额外要求非终态。
  回归在真实控制器上把 outcome mock 成 game-over，断言碎片 tick 不再增长，
  恢复 running 后单步重新生效。

## 简化层场景接触（R2）

小块的有界环境接触复用真实场景 collider 镜像。后端 staticSupportSurfaces() 返回每个
静态 box 的 OBB 描述（中心、局部半尺寸、世界旋转四元数），不做世界 AABB 近似
（旋转盒的 AABB 顶面会在斜坡上制造虚假平台）。

查询是「竖向直线与 OBB 求交」：把过查询点 (x,z)、方向世界 +Y 的竖线逆旋转到 OBB
局部系，得到参数化射线 o+t·d（倾斜时 d 一般非轴对齐）；用 slab 法求三个轴上的
进入/离开区间 [tN,tF]，取 tF（须 tF > 0 且 tF ≥ max(tN,0)）；再把完整局部交点
(ox+tF·ddx, oy+tF·ddy, oz+tF·ddz) 旋转回世界系，取世界 Y 分量加中心 Y 作为支撑面顶。
漏掉 ddx/ddz 会把高度低估成 tF·cos²θ（30° 时 x=1 少 0.22 m、x=3 少 0.51 m）。
局部系求交同时给出足印判定：竖线不与盒相交即无支撑，足印外不会产生虚假平台。

球与胶囊静态镜像同样参与支撑（不再静默穿过）：竖向线在圆截面内（d ≤ r）时
支撑高度 = 中心 Y + 圆柱段半高 + sqrt(r² − d²)，胶囊圆柱段半高 = height/2 − radius
（至少 0），球为 0；截面外返回 null。球/胶囊按竖直姿态处理（旋转不改变其竖向轮廓）。
测试覆盖球顶 1.5、胶囊顶 1.75 的落停与足印外继续下落。

支撑面选择按本步竖向穿越窗口（prevY ≥ topY ≥ currY）取最高面，不选头顶天花板；
已贴伏（底部距面 ≤ 1 cm）的块保持贴面；无穿越且未贴伏返回 null，块继续下落。
质心停在「支撑面顶 + 块支撑半径」，不塞进地板。无场景 collider（或块移出有限
平台/斜坡边界）时继续下落，不生成无限地面。摩擦/恢复用 chunk 输入策略，非固定
常数。场景 collider 变化经 syncScene 更新镜像后支撑面随之更新。

## Stop/Reset 释放合同（F1）

绑定对象提供唯一、幂等的 dispose()：先 runtime.dispose()（退役活动块、归还全部
租约、清空事件队列、标记 disposed、销毁物理 World），再 session.dispose()（未就绪时
取消进行中的初始化）。PlayController 的 Stop/Reset 与 PlaySession 账目回调走同一
条链，因此被丢引用的旧 runtime 同样处于 disposed=true、poolActive=0、
queuedEvents=0，旧代 play() 返回 session-closed。

只销毁 session/World 而不关闭 runtime，会把活动租约、排队请求和「仍接受 play」的旧代
留在内存里；页面引用清空与 ledger 归零都不能单独证明释放完成。owner 回归用真实
ctl.stop()/ctl.reset() 先激活 1 大 1 小并再排一个事件，随后读旧引用断言上述四项
与迟到拒绝，并核对新代可用。

## 凸代理坐标合同（F2）

createGlbConvexResolver() 复用 scene 的 parseGlb，取 MeshData.vertices 的 POSITION
分量：顶点缓冲是 15 浮点交错（position3 + normal3 + smoothNormal3 + uv2 + color4），
按整块当 XYZ 会让点数膨胀 15 倍、把法线/UV/颜色当坐标，碰撞体被撑到 ±1m。

坐标空间与 profile 的 pivot/bind 同一套：解析时传 normalize:false，只保留 node 世界
变换烘焙，**不做 XZ 居中、不贴地、不缩放**（parseGlb 默认行为不变，角色/道具导入
仍走原规整化）。准备阶段再把每个点减去 profile.pivot，得到以 pivot 为原点的代理
局部系。真实 chunk-0001 原始包围盒 [-4.5e-5,0.000285,-3.2e-5]..[0.300037,0.300274,0.299973]，
代理 bbox = 原始 − pivot(0.162673,0.114231,0.168472)；chunk-0009（原始 y
0.6005..0.9005、pivot.y=0.789352）单独覆盖「pivot 远离原点」的情形，避免只测近似
中心的块掩盖错位。另有手写已知偏移 GLB 的逐点闭式对照。Rapier 凸包 + 竖直线投射
核实际接触高度约 0.30m（旧缺陷为 ~1.0m）。

显示侧：FractureChunkInput/ActiveChunk 增加 pivot 字段，渲染层按
mesh 原始坐标先平移 -pivot 再套 worldScale/rotation（WU-05 直接可用，不重读 profile）。

## 运行期 collider 姿态同步（F3）

作者文档只是初始状态：导航门在玩法中升降后，其权威姿态来自
PlaySession.gateSnapshot()。PlayController.syncGates() 在更新渲染对象的同时调用
binding.syncRuntimePoses(poses)，后者经 syncStaticMirrorPoses 把
scene-mirror:<nodeId> 重定位到当前姿态（只换姿态、复用登记时的形状与碰撞组，
不新建第二套碰撞源，也不动其他 owner 的镜像）。真实沙盒场景回归：开门后跑 100 次
ctl.update(1/60)，门姿态 [4,3,0]→[4,7,0]，碎片镜像同步到 [4,7,0]。

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
- Play 生命周期组合已由 bindFractureToPlay（fracture-play-composition.ts，R3）交付：
  Play 启动装配/场景变化镜像 sync/Stop 账目释放/重开新 session；伤害事实
  转 FractureActivation 的业务接线属 WU-06/07。
- 简化层环境接触已按场景静态镜像逐块竖向扫掠求支撑面（R2：穿越窗口选最高可接触面，休眠匹配当前面）；更精细的
  多点接触/休眠唤醒策略属后续改进。
- 离线凸代理读入已在本单元接通（createGlbConvexResolver + 准入二进制核验）；
  NPC 当前可见姿态烘焙属 WU-07。
