# 可破坏物体玩法闭环（WU-06）

日期：2026-10-21。WU-base：WU-05 APPROVED `917b6ba4aeec5eaf382a242079d46e830336f8ef`。
权威计划：`docs/architecture/fracture-system-development-plan-20261020.md` §3/§4/§8/§10 WU-06。

## 职责与边界

| Owner | 本单元责任 |
|---|---|
| `packages/runtime/src/weapon-combat.ts` | 在原 `WeaponWorld` 事实链上增加场景目标查询/伤害入口；不持有物体 HP |
| `packages/zombie-game/src/loader.ts` | 读取 `Destructible` 作者配置与稳定 NodeId 世界快照；拆除静态 collider 的重复归属 |
| `packages/zombie-game/src/session.ts` | Play 副本耐久、一次性 intact→broken、射线/导航移除、不可变破坏事实 |
| `apps/editor/src/services/play-controller.ts` | 消费事实：隐藏完整显示、同步碎片物理镜像、调用正式 `spawnFracture`、Reset/Stop 恢复 |
| `assets/scenes/sandbox/fracture-wu06.scene.json` | 正式场景内容（登记于 `aether.project.json`） |

不复制 HP/伤害/武器策略/导航/物理/渲染内核；场景作者文档保持 intact，运行破坏状态只在 Play 副本。

## 数据与正式场景

- 场景组件 `Destructible`（schema v25，WU-01 契约）：`profile`（带 GUID 的 `.fracture.json`）、
  `maxDurability`、`trigger{direct,explosion,burn}`、`onBroken{collider,navigation}`。
- `fracture-wu06` 布局：12×12 地面 + NavSurface；全宽屏障在 z=0 仅留 2m 缺口，
  P-01 油桶 A 放在缺口中央（缩放 2，宽 1.2m），破坏前 NPC 无法通过；B 在屏障玩家侧
  1.8m/2.0m 处作为爆炸范围内目标；C 在左墙后方 (-3.5,0.9,-1.5) 完整位于墙后作为真实遮挡对照；另有未配置对照箱
  与独立墙体。玩家起点 z=1.8，E-04 刷怪点在 z=-3.5。
- 场景已登记进 `aether.project.json`，可由原场景选择器打开；内容不含引擎硬编码。

## 伤害与一次性状态

- `WeaponWorld` 新增可选方法（不破坏其它实现）：
  `sceneTargets()`、`damageScene(nodeId,damage,facts,kind,point?,normal?)`、
  `blockedExcept(from,to,ignoreNodeId)`。
- hitscan/pellets/piercing 在真实 `trace` 命中场景 collider 后以 `direct` 来源扣耐久；
  projectile 以 `projectile`；爆炸沿真实爆心/距离/`blockedExcept` 遮挡查询；
  flame 以 `burn` 来源，范围目标用 `blockedExcept` 忽略自身 collider，命中后按
  `burnSec/burnDps` 进入场景 DOT（仍由 `trigger.burn` 明确门控）。散弹同 tick 多弹丸可多次
  提交，但会话只允许一次 broken 转换。
- `RuntimeSession` 持有 `hp` 副本与 broken 位；伤害来源不被 trigger 允许时返回 0。
  转换完成后生成不可变 `FractureEvent`（runId + 稳定 NodeId + 世界 TRS + contact/normal +
  weaponId/hitSequence），经 `frozenFractureEvent` 冻结后发布给表现层；`hitSequence` 使用
  武器 trace/projectile/explosion 的 VFX 序号，normal/impulse 沿命中/爆心方向生成。
  表现失败不回滚该事实。

## 碰撞、导航与生命周期

- 装载期：`onBroken.collider='remove'` 的目标不进静态 `shotColliders`，由会话在 intact
  期间持有所属 `SolidColliderDesc`；`navigation='clear-blocking'` 的目标在三维地表场景
  不进基础 obstacles，作为动态障碍随状态加入/移除。平面导航不支持动态移除，
  装载期给 `W_DESTRUCTIBLE_NAV_STATIC` 提示并保留静态障碍。
- broken 后 `syncGates()` 同时重建 `liveSolids` 与动态障碍：后续真实射线/弹道穿过缺口，
  NPC 路径重新可达；只移除目标自身，墙体、地面与未配置对照保留。
- 表现层把目标 NodeId 标为不可见，并用去掉该节点的运行图调用
  `fractureBinding.syncScene()`，移除 `scene-mirror:` 物理镜像；随后走 WU-04/05 的
  正式 fragment runtime/GPU。Reset 恢复完整显示、碰撞、导航与作者文档；Stop 由原快照恢复。

## 验收证据（headed，DISPLAY1 1920,80，严格 TLS）

`node tools/verify/wu06-destructible-probe.mjs --headed --scene assets/scenes/sandbox/fracture-wu06.scene.json`
本轮 **40 PASS / 0 FAIL / 0 SKIP**，nvidia/lovelace、secure=true、fallback=false：

- 初始 3 个目标 hp=40 intact；目标同时参与射线与动态导航；对照箱/墙体保持静态。
- 原生数字键 1 + 鼠标瞄准 + J：真实手枪击碎 A；collider 与动态障碍移除、完整显示隐藏、
  24 批碎片出现、静态物理镜像移除；重复命中不再破坏。原生 5 电锯（范围 direct）与
  4 狙击（贯穿）也在射程内真实击碎 A，证明不是只接手枪。
- 破坏前 NPC `unreachable=1`、z=-1.12；破坏后 5s NPC 穿过缺口到 z=0.93。
- Reset 后 hp/碰撞/导航/显示全部恢复；原生数字键 7 + J 的榴弹在 A 处爆炸，
  A/B 同时破坏，墙后 C 保持 hp=40，对照箱不受影响。
- Reset 后旧代破坏表现不作用新 run；注入 profile 读取失败时玩法事实仍为 broken、
  collider 已移除、完整对象隐藏，`destructibleError` 给出
  `profile-read — profile 读取失败`；后端未就绪时同样先隐藏/移除镜像并给出
  “等待重试”，恢复后同一事实重试成功（24 批）；Stop ledger 15/15、pending=0，作者文档与静态件恢复。
- 原始结果：`.workbuddy/tmp/wu06-final/wu06-destructible-results.json` 与截图
  `direct-broken.png`、`explosion.png`。

相关 owner 测试：`packages/runtime/test/weapon-scene-damage.test.ts`（pellets/piercing/
explosion/flame 来源与遮挡）、`packages/zombie-game/test/loader.test.ts`、
`packages/zombie-game/test/session.test.ts`（一次性状态/来源门控/Reset 恢复）、
`apps/editor/test/fracture-renderer.test.ts`。

## 边界与后续

- WU-07：NPC 当前姿态/致死碎裂；本单元的 E-04 只做普通玩法与导航验证。
- WU-08：作者配置/Preview/Apply/Undo/Save/full reload UX。
- WU-09：压力/性能认证；本指南不宣称所有场景或全部武器组合的预算上限。
- 平面导航的可破坏导航清除需三维地表；正式 WU-06 场景使用 NavSurface。
- 正式场景的 `trigger.burn=false`；代码路径仍以 `burn` 来源显式门控并支持
  `burnSec/burnDps` 场景 DOT，不借用同帧直接命中序号。
