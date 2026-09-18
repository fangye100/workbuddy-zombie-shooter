# 19 · 最终开发报告（Agent 优先 Game Editor · WU-0 → WU-6）

- 分支：`feature/headless-runtime` —— **已通过 PR #3 合并进 `main`**（merge commit `4091ec3`，2026-09-18；合并时领先 22 笔、全部已推送）。
- 依据：`docs/17-Agent优先GameEditor架构与开发指导.md` §8 业务证明、§9 报告要求。
- 取舍过程：`docs/18-运行时责任收敛与取舍记录.md`（WU-0 → WU-6 逐节，含踩坑与仍未解决项）。
- 独立评审：`docs/review/`（三份只读评审，A 架构铁律 / B 证据可复现 / C 代码风险）。
  首轮 A、B **不通过**（6 条阻断），第二轮 A **不通过**（含整改引入的 1 条真回归 + 1 处门禁红）；
  两轮发现已全部修掉。评审意见与整改见 `docs/18` §9。
- 合并后补记（2026-09-18 → 09-19）：PR #3 的 22 条 bot 评审（codex 3 + copilot 19）逐条复现后
  整改 —— 20 条修复（`87c2b25`）、2 条拒绝（附取证），独立审核 PASS；2026-09-19 第二轮独立审核
  （逐条复现 + 门禁复跑）再次 PASS。本报告中与整改冲突的段落已同步（§6 资源清理、§6 已知限制 1/2）。

---

## 1. 用户现在能完成的实际操作 / 仍暂缓的能力

### 现在能闭环的操作

一条"**人能定位问题、局部修改、保存、重跑并检查结果**"的完整链路已在编辑器里跑通：

1. 打开 `https://localhost:5100`（或 Tailscale 域名），编辑器从 `aether.project.json`
   解析启动场景并加载。
2. 按 **Play** —— 场景里的刷怪点按房间触发真正生成敌人（不是 Proxi 占位）。
3. 在视口里**点一只僵尸** —— 选中它，Inspector 跳到「刷怪点」页，
   直接显示它的**来源刷怪点**（"它是从哪冒出来的"一步到位）。
4. 在该面板改**生成散布半径** → 面板即时反映 dirty → **保存**写回 `.scene.json`。
5. 不满意就**撤销**（单步，回到上一个值）。
6. **重跑**（Stop→Play）按新文档重新装载，A/B 对比初始散布变化。
7. **Pause / Step / Stop**：暂停后 tick 与位置不变，Step 只推进一个 tick，
   Stop 精确恢复 Play 前的作者状态（相机、选中、场景内容都不被 Play 污染）。
8. 关掉页面重新打开 —— 保存过的值仍在（**保存重开保持**）。

### 仍暂缓的能力（明确未做，不是"看起来像做了"）

| 能力 | 状态 |
|---|---|
| `Script` 组件（行为注册表）的执行 | **未接线**。文档里的 `Script` 组件会被完整保留、但运行时**不执行**任何行为；实体行为目前只有内建的 idle / chase 两态。**且未产出 diagnostic**（见 §6 已知限制 6） |
| 500 僵尸性能验收 | 未做。§8 第 8 条只证明"动态实体不占静态槽位"，不等于性能达标 |
| 通用 Undo/Redo | 未做。撤销只覆盖刷怪点被编辑的两个字段（radius / count） |
| `revertAll()`（整轮还原） | 只是 `SpawnEditStore` 的 API，**没有 UI / 钩子入口**，用户到不了 |
| 面板单测 | 未做。vitest 环境是 `node`，没有 jsdom；面板逻辑靠实机 harness |
| Play 中热替换运行描述 | 未做。"重跑"是 Stop→Play 的整轮重新装载 |
| 角色动画重定向 / Motion Match | 本阶段范围外（设计见 docs/16） |
| 手臂 IK | 设计上决定不做（与持枪瞄准打架），仅双腿走 IK；本阶段未实现 |

---

## 2. 主要生产 owner、唯一状态来源、责任变化

### 唯一状态来源（每类运行状态只有一个权威 owner）

| 状态 | 唯一 owner | 落点 |
|---|---|---|
| 场景文档（作者数据） | `SpawnEditStore`（`committed` + `working` + 撤销栈） | `packages/runtime/src/spawn-edit.ts` |
| 运行世界（实体表 / 生成 / 触发 / 移动） | `RuntimeSession` | `packages/runtime/src/session.ts` |
| **运行状态机**（play/paused/stopped） | **`PlaySession`（runtime 包，纯 CPU 可测）** | `packages/runtime/src/play-session.ts` |
| Play 期资源账目 | `PlaySession`（`registerResource` / `ledger`） | 同上 |
| 场景 → 运行视图的翻译 | `RuntimeBridge`（纯翻译层，**不含状态机**） | `apps/editor/src/services/runtime-bridge.ts` |
| 编辑器侧装配（快照 / 推进 / 通知 UI） | `PlayController`（**只做透传，不持有状态**） | `apps/editor/src/services/play-controller.ts` |
| 场景文档语义 / schema | `packages/scene/src/document.ts` | — |
| 相机矩阵 | `renderer-core`（`viewProj` / `invViewProj` / `eyeVec`） | `packages/render/src/renderer-core.ts` |

**责任变化的要点**：WU-3 之前编辑器"既跑世界又存状态"；现在编辑器只剩**装配 + IO + 控件**，
领域逻辑全部下沉到 `packages/runtime`（纯 CPU，不认 DOM / GPU / 真实时间）。

两个容易被写错的界线：

- `RuntimeBridge` 刻意**不含状态机**（WU-4 把它搬去 `PlaySession`），因为它要做的是"翻译"，
  一旦持有状态就会变成第二个 owner。
- 状态机的 owner 是 **`PlaySession` 而不是 `PlayController`** ——
  `PlayController.state` 只是 `this.session.state` 的透传（评审 B2 指出过这里曾被写反）。

### 已有大文件是否增长 / 增长是否只是装配接线

口径：`wc -l`（数换行符）。

| 文件 | main | HEAD | 说明 |
|---|---|---|---|
| `apps/editor/src/main.ts` | 1958 | **2566** | +608，**全部是装配接线**：Play/Pause/Step/Stop 按钮绑定、Bridge 每帧注入、刷怪点面板挂载、验证钩子。领域逻辑一行都没有 |
| `apps/editor/src/renderer.ts` | 2137 | 2385 | +248，动态实例批次注入 + 作者状态快照 + 灯光 priority 选择 |
| `packages/render/src/renderer-core.ts` | 934 | 1141 | +207，动态实例渲染通道（storage 实例数组 + `@builtin(instance_index)`） |
| `apps/editor/src/services/runtime-bridge.ts` | — | 307 | 新建 |
| `apps/editor/src/services/play-controller.ts` | — | 170 | 新建 |
| `apps/editor/src/services/spawn-panel.ts` | — | 215 | 新建 |

`main.ts` 涨到 2566 行是事实，但涨的都是"把已有的东西接起来"；
判断标准是：**把它删掉，运行时与规则仍然完整**（都在 `packages/runtime`）。
它是本阶段唯一一处需要盯的膨胀点，建议下一阶段把面板/钩子装配按领域拆成独立装配模块。

---

## 3. CLI 与浏览器共享的实际代码入口、输入契约、对比证据

**共享入口（关键）**：两侧都走 `PlaySession.play(doc)` → `RuntimeSession.step()`，差别只在宿主。

| | CLI | 浏览器 |
|---|---|---|
| 入口 | `npm run runtime:build` → `node tools/verify/runtime-parity.mjs --scene <path> --seed <n> --ticks <n>` | `window.__editor.runtime.runTo(seed, ticks)` |
| 模块来源 | esbuild 单文件打包产物（`platform=node`） | vite 解析的同一个 `@aether/runtime` 模块实例 |
| 只读性 | **只读**：不写场景、不改 `aether.project.json`（与 `sim-level.mjs` 的区别就在这里） | 自建自停的临时 `PlaySession`，**不碰用户正在播放的会话** |
| 输入契约 | `SceneDocument` + `seed` + `fixedStep` + `ticks` | 同左 |
| 输出契约 | `{sceneId, schemaVersion, fixedStep, tick, docFingerprint, entities[]}` | 同左 |

### 对比证据（§8 第 1 条）

**先证明输入相同，再谈输出相同** —— 两侧各自对**实际喂进 runtime 的那份文档**取
`sceneFingerprint()`（`stableJson` 键排序 + FNV-1a）。

比对逻辑**已入库**：`runtime-parity.mjs --compare <web.json> [--scene ... | --against <node.json>]`。
这一点是被评审逼出来的 —— 第一版里"两侧一致"只存在于一个临时脚本中，结论不可复跑。

```
$ npm run verify:parity-host
[PASS] 两侧喂进 runtime 的是同一份文档 — 7adf8152
[PASS] 场景与 schema 一致 — sc_sim_floorsc_act1_floor1_t5 v3
[PASS] 到达同一 tick — 60
[PASS] 逐实体身份 / 位置 / 目标 / 状态一致 — 13 个实体，maxΔ=0.00e+0
[PASS] 换种子后仍一致
[PASS] 不同种子确实产生不同结果（一致性不是恒等）
```

身份按 `id:generation` 配对，`characterId` / `kind` / `sourceNodeId` / `targetId` / `behavior`
逐字段全等，`x` / `z` / `yaw` 逐位相等（容差 1e-9）。**不是"两边都刷了 13 只"，是同 13 只站在同一位。**

---

## 4. 真实场景语义支持表与 diagnostic

### 本轮真实消费的组件（4 种）

| 组件 | 语义 | 落点 |
|---|---|---|
| `RoomVolume` | 房间触发体（含 `enabled` 禁用语义） | 进入触发 + 只触发一次 |
| `SpawnPoint` | `characterId` / `count` / `wave` / `trigger` / `delaySec` / `radius` / `prefab` / `enabled` | 生成批次 + 每点独立随机流 |
| `Collider` | 障碍（`isTrigger` 的不挡路） | 流场烘焙 `bakeClearance` + `CrowdSolver` 避障 |
| `NavZone` | 导航区（本轮取第一个） | 流场网格范围 |

**未消费**：`Script`（行为注册表）、`Camera`、`MeshRenderer`、以及任何将来新增的 kind。
它们被**完整保留在文档里**（保存不丢字段），运行时**不执行、也不近似执行**。
⚠️ 但**"明确不支持"没有落地产物**（见 §6 已知限制 6）：目前不产生任何 diagnostic。

### diagnostic

**装载期**（`loader.ts`，一次性）：

| 码 | 级别 | 触发 |
|---|---|---|
| `E_GRAPH` | error | 场景建图失败 |
| `E_PLAYER_START_UNSET` | error | 没有 `playerStart` |
| `E_PLAYER_START_MISSING` | error | `playerStart` 指向不存在的节点（带 NodeId） |
| `E_SPAWN_UNKNOWN_CHAR` | error | 刷怪点写了 roster 里没有的 `characterId`（带 NodeId），**不创建半运行世界** |
| `E_NAV_MISSING` | error | 需要导航但没有 `NavZone` |
| `W_SPAWN_TRIGGER_UNSUPPORTED` | warning | 刷怪点用了本轮不支持的 trigger 类型 |
| `W_NAV_MULTIPLE` | warning | 多个 `NavZone`，只取第一个（提示是哪一个） |
| `W_NO_ROOM` | warning | 没有 `RoomVolume`，`room-enter` 触发的刷怪点永远不会投放 |

**运行期**（`RuntimeSession.diagnostics()`，本次整改新增）：

| 码 | 级别 | 触发 |
|---|---|---|
| `W_SPAWN_CAPACITY` | warning | 房间这一波需要的实体数超过剩余容量 → 整批不生成（带 `nodeId` / `needed` / `free`），同一房间只记一次 |

**渲染期**（`renderer.loadScene` 的 warnings）：灯光降级（见 §6 已知限制 7）。

**临时实验规则**（单 `NavZone` 限制、`wave` 字段当前不参与调度等）
一律按 warning 显式告知，**不描述为产品行为**。

---

## 5. 实际运行的最小测试、场景门禁、真实 GPU 检查

### 定向测试与门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run test` | **568 passed / 32 files** |
| `npm run smoke:nav` | **exit 0 / 13 PASS**（§8-3 的 `bakeClearance` 证据在这里） |
| `npm run scene:check` | exit 0（28 个资产元数据同步 + 12 条场景文件测试） |
| `npm run content:check` | exit 0 |
| `npm run verify:prefix` | exit 0 |
| `npm run editor:build` | exit 0 |
| `npm run editor:smoke` | **127 PASS / 6 FAIL / 3 SKIP**，CONSOLE 0 / EXCEPTION 0 |
| `npm run verify:parity-host` | **20 PASS / 0 FAIL，连续 3 次一致**（§8-1 / §8-5 / §8-6 实机 harness） |

`editor:smoke` 的 **6 条 FAIL 与整改前逐条一致、零新增**（详见 §6 已知限制 1）。

### 八条业务证明的落点（整改后每条都有可复跑证据）

| # | docs/17 §8 条目 | **入库**证据 | 实机补充 |
|---|---|---|---|
| 1 | Node/浏览器同输入一致 | `tools/verify/runtime-parity.mjs --compare`（比对逻辑入库） | `verify:parity-host` §8-1 |
| 2 | 房间触发与禁用语义 | `session.test.ts`：禁用 SpawnPoint 不生成（**按身份核**）、禁用 RoomVolume 不触发、**玩家走出房间再走回来不重复投放**、时间推进不重复触发 | — |
| 3 | 障碍参与移动约束 | `session.test.ts:112,241` 用 `insideAnyObstacle()` 在 tick 0/10/50/200 逐实体核（**不是"朝玩家距离变小"**）；`packages/ai/test/navigation.smoke.ts`（`smoke:nav`，13 条） | — |
| 4 | Pause/Step 与帧率无关 | `play-session.test.ts`：暂停 5 秒不补算、`stepOnce()` 严格 +1、**对齐到同一 tick 后逐实体比世界状态（1e-9）** | — |
| 5 | 选敌读身份/来源/目标/状态 + **画面对应** | `runtime-bridge.test.ts`（身份/来源/拾取自洽） | `verify:parity-host` §8-5：点在 `(730.6,174.2)px` → 命中 `#2·代1`，回投影 `Δ=(0.00,0.00)px` |
| 6 | 改 radius 撤销 + 保存重开保持 + 同种子重跑 | `spawn-edit.test.ts`（undo 精确回原值、多步 LIFO、一次编辑恰好 1 条差异路径）+ `spawn-ab.test.ts`（改一处不牵动它处、散布随 radius **单调变大**） | `verify:parity-host` §8-6：整页重载后仍 `4.75` |
| 7 | Stop 恢复作者状态 + 20 次启停账目 | **`apps/editor/test/play-controller.test.ts`（本次整改新增，此前零测试）**：Play 中改动 → Stop 后逐字段还原、装载失败不动作者状态、20 次启停 `registered==disposed 且 pending==0` | — |
| 8 | 动态实体不占静态槽位 | `session.test.ts:226`（120 只 > 64）+ `runtime-bridge.test.ts`（**批次 == 体型种类数**） | docs/18 §5.5 |

**范围说明**：本轮未改 schema、未改 `assets/**`，故未重跑内容/场景生成全量流程；
`scene:check` / `content:check` 仍按纪律执行。**未按 `npm run sim` 走完整模拟导出**
（docs/17 §8 明确禁止用它代替只读检查，它会写场景和 project.json）。

---

## 6. 作者数据前后差分、资源清理、已知限制

### 作者数据前后差分

- **保存前自检**（写盘之前）：改动路径必须全部落在**某个 `SpawnPoint`** 的 `radius` / `count`
  上（**不限条数**，作者连改两个点是合法操作）。
  （整改前只匹配路径形状 `/components[N].(radius|count)$/`，`Collider{sphere}.radius`
  或任何组件上的 `count` 都能骗过，形同虚设；后来误改成"恰好一条"，把合法的
  多节点编辑也拒了 —— 见 docs/18 §9.5。`editor-parity` §8-6 的双节点用例是它的回归守卫。）
- **未消费组件与无关字段原样保留**：节点数、场景名、`Script` / `userData` 等未被触碰的字段
  在写回后逐字段不变。
- **收尾还原**：验证用的写盘在 `finally` 里全部还原，场景文件与原文**逐字节一致**（43763 字节），
  `git status -- assets` 干净。
- **画布无关状态**：编辑器相机、面板折叠、资产浏览器目录等 UI 状态走 localStorage，不入场景文件。

### 资源清理（如实描述）

- **runtime 侧没有 GPU 资源**（依赖方向禁止），`PlaySession.stop()` 断开世界引用即可回收。
- **Play 期由宿主分配的资源必须登记进 `PlaySession`**（AGENTS.md §2.4），
  `stop()` 逐个释放，`ledger` 给出 `{registered, disposed, pending}`；
  编辑器把 **Bridge 批次 + 渲染侧动态实例资源（`RendererCore.releaseDynamicResources()`）
  两项**登记进去。**`pending === 0` 是"Stop 后无残留"的可断言判据**
  （本次整改新增 —— 整改前这条规则只写在文档里，代码没有任何登记表）。
- **动态实例/代理网格由渲染核心持有**（按 `meshId` 缓存），但**随 Stop 释放**：
  `RendererCore.releaseDynamicResources()` 销毁实例 buffer / bind group / 代理网格缓存，
  并由 `PlayController` 登记进 PlaySession 账目（bot 评审 [11]/[21] 修正）。
  报告截点前的写法是「跨 Play 复用、不随单次 Stop 销毁」——与 AGENTS.md §2.4
  「Play 期每一次 GPU 资源分配都必须登记、Stop 时逐个 `destroy()`」相抵，纪律优先；
  500 僵尸的造网格 CPU 开销另作优化，不与资源纪律混用。
- 20 次启停后 `registered == disposed == 40`（2 项/轮）、`pending == 0`，并断言渲染侧
  释放入口真的被调用（入库测试 `play-controller.test.ts`）。

### 已知限制

1. **`editor:smoke` 6 条 FAIL 持续存在**（横跨 WU-3 → 合并，尚未修；2026-09-19 合并态实测 127 PASS / 6 FAIL / 3 SKIP）：
   - **5 条**是脚本硬编码了 sandbox 场景（`default.scene.json`）的期望值（物体数 13、固定物体名、
     `category` / `pickable`），而启动场景是 `assets/scenes/act1/floor-1.scene.json`
     （**19 物体**，作者场景）。实测：`objects=19 ≠ 13`、物体名/层级数对不上、
     `category` / `pickable` 两条返回 `{}` —— **门禁在这两项上仍完全失效**。
     ⚠️ 报告截点的根因（WU-1e 把 `startIndex` 1→7、启动场景变 sim 快照）已被 bot 评审整改
     回改（`87c2b25` → `startIndex: 1`，见限制 2），但 **smoke 脚本的期望值未同步更新** ——
     这 5 条与其无关地继续失败，性质是「脚本未跟随产品启动场景」，不再是数据回归。
   - **1 条** `autoFitCylinders`：脚本 `:1357` 取的是**活引用**未拷贝，被它自己的
     "还原"步骤（`:1372`）就地写回旧值；同批取回的 `oRadiiImmediate/Persist`（数字）
     都是正确的 `0.0574924`。**功能是好的，是脚本自身的问题。**
     （2026-09-19 实测复现：该条仍 FAIL，LeftArm 读到 `0.091` vs 预期 `0.0575`。）
2. **启动场景曾指向 sim 派生产物 —— 已修复**（bot 评审 [2]/[9]）：`87c2b25` 把 `startIndex`
   回改为 `1` → `assets/scenes/act1/floor-1.scene.json`（作者场景 `sc_act1_floor1`）。
   sim 快照（`floor1-t0/t1/t3/t5`）恢复「派生产物」身份、不再是启动场景，快照 id 与
   `scenes[]` 登记项已对齐（同一提交，评审 [7]/[8]）。§8-1 的比对脚本与方法不依赖具体场景
   （`runtime-parity.mjs --scene <path>` 可指向任意场景），但上面那组记录数字是在当时的
   sim 快照（旧 id `sc_sim_floorsc_act1_floor1_t5`）上采集的。
3. **点光位置仍由引擎轨道驱动**（`frame-uniforms.ts` 硬编码 `cos(t)*2.6 / 1.4 / sin(t)*2.6`）。
   本次整改只把点光的 color/intensity/range 接到了场景组件，位置字段 schema 没有。
4. **`LabRenderer` 仍保留硬编码 fallback 场景**（`buildDefaultSpecs()`，13 物件），
   违反 AGENTS.md §2.2 字面。可用 `getSceneSource() === null` 辨识，但兜底内容与真实场景
   物件数相同、名字也相近 —— 是最容易误判的形态。
5. **`panBy()` 仍有第二份相机基向量**（`main.ts`，与 `screenRay()` 同型风险）。
   `screenRay()` 已删（当时复刻旧公式做对照，**它也命中**，所以是"消除重复实现"不是"修 bug"），
   但 `panBy` 这条同源风险当时没一起清。另外 FOV 45° 有三处硬编码（render-core / main / asset-preview）。
6. **未消费组件零 diagnostic**：作者挂一个 `Script`，装载后控制台一片寂静。
   docs/17 §7 要求的是"**明确不支持**"，目前只做到了"不近似执行"。
7. **多灯降级已按 `priority` 实现**（top-1 directional + top-1 point，落选者进 warnings），
   但**尚未在编辑器里"标黄"**，只有文字告警（AGENTS.md §2.3 要求标黄）。
8. **A/B 未覆盖"房间还没进 → 一个都没刷"这一分支**（正是 A/B 声称的核心价值），
   测试夹具只取已触发的刷怪点。
9. `MAX_OBJECTS = 64` 超限会明确报错而非静默丢弃；但 500 僵尸的性能上限仍未测。
10. 面板无单测（缺 jsdom）；`__editor.*` 钩子在生产构建里也无条件装配。

---

## 7. 提交、逐笔推送、保留的他人工作区改动

- 分支 `feature/headless-runtime`，所有提交**逐笔 push 到 `origin`**，本地不留未推送提交
  （`git rev-list --left-right --count origin/feature/headless-runtime...HEAD` → `0  0`）。
- 提交时**只 `git add` 本会话改动的文件**，不使用 `git add -A`。
- **保留他人工作区改动**：`agents.md` 由另一并行会话修改、`agents.md.bak-webdebug-20260911`
  是其备份 —— 本轮**未暂存、未修改、未删除**。
- 本阶段提交构成：WU-0(1) + WU-1(4) + WU-2(1) + WU-3(2) + WU-4(2) + WU-5(2) + WU-6(2)
  + 记忆日志(4) + **评审整改(4)** = 22 笔。
- 本轮（评审整改）改动文件：

| 文件 | 动作 |
|---|---|
| `packages/runtime/src/session.ts` | `StepReport` 真实回传生成数与被拒房间；新增运行期诊断 |
| `packages/runtime/src/play-session.ts` | 资源登记表 `registerResource()` / `ledger` / `stop()` 逐个释放 |
| `packages/runtime/test/session.test.ts` | 容量拒绝 3 条、真实生成数、跨边界重入 |
| `packages/runtime/test/play-session.test.ts` | 帧率无关改为"对齐 tick 后逐实体比世界状态" |
| `apps/editor/src/renderer.ts` | 灯光按 `priority` 取 top-1+top-1、落选告警、点光来自场景 |
| `apps/editor/src/services/play-controller.ts` | 登记 Bridge 批次；暴露 `ledger` / `runtimeDiagnostics` |
| `apps/editor/src/main.ts` | 保存自检收紧；点光接线；去掉重复赋值 |
| `apps/editor/test/play-controller.test.ts` | **新建**（§8-7 此前零测试） |
| `apps/editor/test/runtime-bridge.test.ts` | 修 2 条恒真/近似断言 |
| `tools/verify/runtime-parity.mjs` | 新增 `--compare` 比对模式 |
| `tools/verify/editor-parity.mjs` | **新建**（原 `wu*-probe` 转正入库） |
| `apps/editor/test/scene-lights.test.ts` | **新建**（灯光 priority 降级此前零测试） |
| `package.json` | `verify:parity` / `verify:parity-host` 入口 |
| `docs/18`、`docs/19` | 评审记录与本报告 |

---

## 交付判断

以 docs/17 §9 的口径复述：**"人能定位问题、局部修改、保存、重跑并检查结果"** ——

- **定位**：点画面里的僵尸 → 面板直接告诉你是哪个刷怪点、什么角色、追谁、什么状态；
  跨宿主不一致时，输入指纹先告诉你"是输入不同还是逻辑不同"。
- **修改**：面板改散布半径，改前自检、改后可撤销。
- **保存**：写盘前核对改动集合（**全部落在某个 SpawnPoint 的 radius/count 上**），
  未消费组件不丢；重开页面值仍在。
- **重跑并检查**：停→跑按新文档重新装载，同种子重跑可 A/B 对比初始散布。

这条闭环是通的，且每一环都有**可复跑**的证据（入库测试 + 入库 harness）。
**没有用文件数、工具数、按钮数或测试总数替代它。**

最后一句留给下一轮：本阶段最值钱的产出不是功能，是**"报告里的每一句实现声明都要有一条断言"**
这条纪律 —— 首轮评审判出的 6 条阻断里有 4 条都是"声称做到但代码没产出对应信号"。
