# 碎裂真实物理后端（WU-03）

日期：2026-10-20。基线：codex/vfx-system-20261019（WU-02 批准 SHA 77775372 起；
本指南描述当前修复后实现 SHA ad4973e，复审轮次见 §验证）。
权威计划：fracture-system-development-plan-20261020.md（§3、§4.3、§6.1/6.2、§10）。
数据契约真源：packages/runtime/src/fracture.ts（WU-01 冻结的 FracturePhysicsBackend 边界）。

## 职责与边界

WU-03 只交付真实三维物理后端与镜像，不实现碎片播放调度（WU-04）、渲染（WU-05）、
游戏破坏规则（WU-06/07）或作者 UI（WU-08）。物理世界只负责被授权的碎片范围；
原角色移动、武器射线和导航继续原系统，本单元不改变其调用路径。

| 模块 | 职责 | 边界 |
|---|---|---|
| packages/runtime/src/fracture-rapier.ts | Rapier 适配实现 RapierFractureBackend；ensureRapier 共享 WASM 加载；碰撞分组；速度/角速度上限 | 不实现碎片调度/渲染；动态刚体不含凹三角网格（box/sphere/capsule/离线凸代理） |
| packages/runtime/src/fracture-static-mirror.ts | 场景 collider 世界矩阵 → 静态镜像规格的纯变换适配；非均匀球/胶囊、shear、退化显式拒绝 | 只读 scene 的 decomposeMatrixToTrs；不持有后端 |
| packages/runtime/src/fracture-physics-session.ts | 宿主窄组合入口：start 重复/并发拒绝、generation 守卫 + dispose 真实释放 | 供 PlayController.registerResource 式登记；不复制第二套模拟 |
| packages/runtime/src/fracture-scene-mirror.ts | 从 SceneGraph 批量同步静态镜像（同一 collider 真源），镜像隔离命名空间 + 差分移除失效镜像 | 触发器/禁用/隐藏跳过；镜像生命周期由 sync 差分全权管理，宿主不得手动 removeStatic 裸 NodeId |

## 真实后端

- 包：@dimforge/rapier3d-compat@0.21.0（Apache-2.0），精确锁定于 package.json
  dependencies 与 pnpm-lock.yaml。compat 变体内嵌 WASM base64，无运行时 fetch，
  适配 vitest/Node 与 vite/浏览器；WASM 模块代码经 ensureRapier() 共享加载一次，
  World/body/collider/handle 按 Preview/Play session 各自 new，互不共享。
- 进入求解器的真实量：三轴位置、四元数、线速度、角速度、质量、摩擦、恢复系数、
  碰撞分组、CCD 标志。固定步长 world.timestep=fixedStepSec，step() 恰推进一个固定
  tick，不反向推进物理时钟；Pause 不推进（宿主不调用 step），Step 恰一个 tick，
  有界 catch-up 由宿主按 maxCatchUpTicks 限幅（本单元后端不替宿主决定预算）。
- 可观察行为（均有测试）：落地静止、静态墙阻挡、大块间接触堆叠、偏心冲量三轴
  旋转、落地休眠、不同恢复系数弹跳高度不同、速度/角速度上限夹紧。
- 碰撞分组：membership<<16|filter。碎片属 chunk 组，默认与环境+其它 chunk 碰撞，
  明确排除 player/npc（首期装饰，不撞飞玩家/NPC、不算伤害/奖励/导航）。CCD 仅对
  确有穿透风险的快速小刚体经 ccd 标志开启，非全量无差别打开。Rapier 0.21 的默认
  非线性投影求解器已能阻挡 300 m/s 小球，故 CCD 门禁以"标志真实写入且不破坏接触"
  验证，不伪造"无 CCD 必穿透"的差异。

## 构造失败原子性（R5）

RapierFractureBackend 构造器的所有可预先验证的选项校验都在分配 WASM World 之前
完成：固定步长（有限正数）、重力三分量（有限数）、线/角速度上限（有限正数）。
任一校验失败时构造抛错且未分配任何 World——调用方拿不到引用，也无需 destroy。
分配后仅写入 timestep（纯赋值），并包 try/catch：分配后任何意外抛错都会 free
已分配 World，不留无法回收的 WASM 资源。测试用真实 Rapier 模块仅包装 World
构造/free 计数（不替换求解器），断言四次非法限值构造的 allocated=0、freed=0。

## session 启动语义（R1）

createFracturePhysicsSession().start(opts) 返回 \`{ status, backend }\`：

| status | 含义 | backend |
|---|---|---|
| 'started' | 新后端就绪，session 拥有唯一引用 | 新后端 |
| 'rejected' | 已有活动后端或进行中初始化（busy），拒绝重复/并发启动，不覆盖唯一引用、不新建第二份 World | null |
| 'cancelled' | 初始化 resolve 前 dispose，或已 dispose 后再 start；不复活旧 World | null |

- \`busy\` = 已有活动后端或进行中的初始化；busy 时重复 start 一律 rejected。
- 如需重启必须先 dispose()（真实释放当前后端），再 start。
- 非法选项的 start 会 rejects 抛错（构造失败原子性见上节），session 保持可用：
  busy=false、backend=null，可用合法参数重试，也可安全 dispose。
- 活动后端始终经 \`session.backend\` 可见；rejected 不返回活动后端引用，
  避免所有权歧义。

## 同一 collider 真源与镜像所有权（R2）

静态环境镜像从场景 collider 真源生成，不另造隐藏地面/墙体：

- syncStaticMirrorsFromScene 遍历 SceneGraph 节点的非触发、enabled、有效可见
  collider，用 graph.worldMatrix(nodeId) 的真实世界矩阵（含全部父级嵌套 TRS）
  经 sceneColliderToStaticMirror 分解，upsert 进后端。口径与 loader 的实心体一致。
- **镜像命名空间**：镜像在后端登记为 \`scene-mirror:<nodeId>\` 前缀 key，
  与场景节点裸 id 及其他 owner 的静态体隔离。sync 只 upsert/移除本组合拥有的
  前缀 key，不触碰其他 owner（如手工登记的 \`ground\`/\`wall\`）的镜像。
- **差分移除**：每次 sync 先收集本次有效的镜像 key，再对后端 \`staticKeys()\`
  中前缀匹配但已失效的镜像执行 removeStatic。失效类别：disabled、trigger、
  隐藏、collider 组件被移除、节点被删除、变换被拒绝（非均匀/shear/退化/非有限）。
- **宿主纪律**：场景状态变化（含节点删除、开门、组件增删）后，宿主应再次调用
  syncStaticMirrorsFromScene 做被动差分；**禁止宿主按裸 NodeId 手动
  removeStatic**——镜像 key 已命名空间化，裸 id 无法命中，且会绕过所有权边界。
- 变换核对：box 的世界缩放折进 halfExtents；sphere/capsule 仅允许均匀缩放，
  非均匀明确 diagnostic 拒绝（不静默当均匀）；shear（旋转列不正交）、退化缩放、
  非有限矩阵同样拒绝。离线凸代理（WU-02 资产）按世界缩放预乘后走 convex，
  绕过均匀缩放限制。
- Stop 经 session.dispose() → backend.destroy() 清空全部镜像与刚体。

## 生命周期与资源账目

- WASM 代码共享加载；World/body/collider 按 session 隔离。createRapierBackend 的
  isCurrentGeneration 守卫 + createFracturePhysicsSession 的二次守卫保证：Stop/换
  场景后迟到的异步初始化返回 null（cancelled），不新建/复活旧 World。
- destroy() 真实释放 World 与全部 body/collider；重复销毁安全；旧 handle 的
  snapshot 返回 null；release 按 key 精确移除不误删其它 body；两个 session 的
  World 互不影响。
- 账目区分 dynamicBodies/staticColliders/ticks/destroyed，不以单一 JS 计数归零
  自证已释放。WASM allocator 的预留内存不回落不等于泄漏，判据是活动 world/body/
  collider 与多轮高水位趋势；构造失败路径以真实 World 分配/free 计数断言
  （见 §构造失败原子性），不以 Map 大小自证。

## 验证（实际命令与证据）

当前 SHA ad4973e 的实际验证：

- pnpm run typecheck：0 错误。
- pnpm run architecture:check：errors=[]（111 framework 文件）。
- pnpm exec vitest run packages/runtime：19 文件 145 测试全过，其中新增/更新：
  - fracture-rapier.test.ts 29 测试：落地/墙碰/块间接触/偏心冲量旋转/休眠/恢复
    系数/固定步长/分组排除玩家/碎片撞大块/速度上限/移除镜像通路/upsert 不叠加/
    destroy 账目/异步迟到取消/失败路径/静态镜像变换适配/R3 求解前夹紧/
    R5 分配前拒绝（allocated=0）/R5 非法步长与重力分配前拒绝。
  - fracture-rapier-negatives.test.ts 4 测试：忽略静态碰撞穿地（分组错误）、未释放
    body 账目体现 pending、移除镜像前仍挡路、CCD 标志真实写入。
  - fracture-physics-session.test.ts 8 测试：独立后端/dispose 释放/顺序重复拒绝/
    并发恰一份 started/初始化中 Stop cancelled/dispose 后 start cancelled/
    双 session 隔离/重复 dispose 安全/R5 start 失败后可重试与安全 Stop。
  - fracture-scene-mirror.test.ts 12 测试：SceneGraph 真源镜像、镜像墙真实阻挡、
    六类失效差分移除（disabled/trigger/隐藏/组件移除/节点删除/变换拒绝）、
    其他 owner 隔离、嵌套 TRS 缩放折进、坏变换 diagnostic。
- 实际加载 Rapier WASM（非 mock），真实 body/collider 进出求解器。浮点用有依据
  容差，未承诺跨平台逐 bit 相同。
- 历史口径：首轮提交（SHA 7dfd48e..ae2ac95 区间）曾报告 19 文件 127 测试；
  该数字对应修复前快照，当前计数为 145（R1/R2/R3/R5 新增测试）。

## 边界与遗留

- 不实现碎片播放调度/池/优先级预算（WU-04）、动态渲染（WU-05）、伤害/死亡
  （WU-06/07）、作者 UI（WU-08）。本单元无 GPU 动态网格/真实武器/完整 UI。
- 宿主（PlayController）尚未把后端接入 Play 主循环——那是 WU-04 播放运行时的
  责任：WU-04 需要在 Play 启动时 createFracturePhysicsSession + start、场景变化后
  再次 syncStaticMirrorsFromScene（被动差分，无事件订阅）、Stop 时 dispose。
  本单元提供全部入口，但不替宿主决定步进预算与接入时机。
- 离线凸代理与 WU-02 资产的接通（读 .fracture.json 的代理/质量/摩擦/恢复）属
  WU-04 播放运行时，本单元后端接口已支持 convex 形状。
