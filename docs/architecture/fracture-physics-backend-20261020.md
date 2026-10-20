# 碎裂真实物理后端（WU-03）

日期：2026-10-20。基线：codex/vfx-system-20261019（WU-02 批准 SHA 77775372 起）。
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
| packages/runtime/src/fracture-physics-session.ts | 宿主窄组合入口：generation 守卫 + dispose 真实释放 | 供 PlayController.registerResource 式登记；不复制第二套模拟 |
| packages/runtime/src/fracture-scene-mirror.ts | 从 SceneGraph 批量同步静态镜像（同一 collider 真源） | 触发器/禁用/隐藏跳过；节点删除由调用方 removeStatic |

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

## 同一 collider 真源

静态环境镜像从场景 collider 真源生成，不另造隐藏地面/墙体：
- syncStaticMirrorsFromScene 遍历 SceneGraph 节点的非触发、enabled、有效可见
  collider，用 graph.worldMatrix(nodeId) 的真实世界矩阵（含全部父级嵌套 TRS）
  经 sceneColliderToStaticMirror 分解，upsert 进后端。口径与 loader 的实心体一致。
- 变换核对：box 的世界缩放折进 halfExtents；sphere/capsule 仅允许均匀缩放，
  非均匀明确 diagnostic 拒绝（不静默当均匀）；shear（旋转列不正交）、退化缩放、
  非有限矩阵同样拒绝。离线凸代理（WU-02 资产）按世界缩放预乘后走 convex，
  绕过均匀缩放限制。
- 状态同步：同 nodeId 重复 sync 即 upsert 更新（先移除旧的，不叠加）；节点删除/
  开门由调用方 removeStatic(nodeId)，测试证明移除后通路打开、无幽灵 collider；
  Stop 经 session.dispose() → backend.destroy() 清空。门/可破坏对象的运行时
  collider 输入变化复用同一 upsert/remove 接口，本单元不提前实现 WU-06 破坏规则。

## 生命周期与资源账目

- WASM 代码共享加载；World/body/collider 按 session 隔离。createRapierBackend 的
  isCurrentGeneration 守卫 + createFracturePhysicsSession 的二次守卫保证：Stop/换
  场景后迟到的异步初始化返回 null，不新建/复活旧 World。
- destroy() 真实释放 World 与全部 body/collider；重复销毁安全；旧 handle 的
  snapshot 返回 null；release 按 key 精确移除不误删其它 body；两个 session 的
  World 互不影响。
- 账目区分 dynamicBodies/staticColliders/ticks/destroyed，不以单一 JS 计数归零
  自证已释放。WASM allocator 的预留内存不回落不等于泄漏，判据是活动 world/body/
  collider 与多轮高水位趋势（本单元测试覆盖账目归零与重复销毁）。

## 验证（实际命令与证据）

- pnpm run typecheck：0 错误。
- pnpm run architecture:check：errors=[]（111 framework 文件）。
- pnpm exec vitest run packages/runtime：19 文件 127 测试全过，其中新增：
  - fracture-rapier.test.ts 22 测试：落地/墙碰/块间接触/偏心冲量旋转/休眠/恢复
    系数/固定步长/分组排除玩家/碎片撞大块/速度上限/移除镜像通路/upsert 不叠加/
    destroy 账目/异步迟到取消/失败路径/静态镜像变换适配。
  - fracture-rapier-negatives.test.ts 4 测试：忽略静态碰撞穿地（分组错误）、未释放
    body 账目体现 pending、移除镜像前仍挡路、CCD 标志真实写入。
  - fracture-physics-session.test.ts 4 测试：独立后端/dispose 释放/迟到取消/双
    session 隔离/重复 dispose。
  - fracture-scene-mirror.test.ts 5 测试：SceneGraph 真源镜像、镜像墙真实阻挡、
    删除节点通路打开、嵌套 TRS 缩放折进、坏变换 diagnostic。
- 实际加载 Rapier WASM（非 mock），真实 body/collider 进出求解器。浮点用有依据
  容差，未承诺跨平台逐 bit 相同。

## 边界与遗留

- 不实现碎片播放调度/池/优先级预算（WU-04）、动态渲染（WU-05）、伤害/死亡
  （WU-06/07）、作者 UI（WU-08）。本单元无 GPU 动态网格/真实武器/完整 UI。
- 宿主（PlayController）尚未把后端接入 Play 主循环——那是 WU-04 播放运行时的
  责任；本单元提供 createFracturePhysicsSession 作为登记入口。
- 离线凸代理与 WU-02 资产的接通（读 .fracture.json 的代理/质量/摩擦/恢复）属
  WU-04 播放运行时，本单元后端接口已支持 convex 形状。
