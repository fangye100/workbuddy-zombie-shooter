# C 组第二轮评审报告 · 代码风险与遗留（只读复审）

- 分支：`feature/headless-runtime`，HEAD `25d6d64`（评审整改 5/5）
- 复审基线：第一轮报告 `docs/review/review-c-代码风险与遗留.md`（HEAD `ba5e093`）；
  整改范围 = `ba5e093..HEAD` 五笔提交（`git diff --stat` 实测：18 文件，+2766/−179）
- 只读声明：本次复审**未修改任何源文件、未提交、未动 assets、未碰 `.git`**；唯一写入即本报告。
- 复核手段：`npm run typecheck` ✅ 绿；`npm test` ✅ **569/569 绿**（含新增
  `play-controller.test.ts` 7 条、`scene-lights.test.ts` 8 条）；
  `packages/{runtime,ai,gameplay,content}/src` grep `Math.random|Date.now|performance.now` **零命中**；
  整改前后 `git show` 逐文件比对。

---

## 结论速览

| 档 | 条数 | 编号 |
|---|---|---|
| 阻断 | **0** | — |
| 应修 | 2 | C2-1（docs/19 保存自检描述残留「恰好一条」）、C2-2（A7 FOV 未修） |
| 建议 | 5 | C2-3 ~ C2-7 |

**总判定：通过。**

---

## 一、第一轮 8 条应修逐条判定

### A1 `StepReport.spawned/rejectedRooms` 恒为 0 —— **已修**
- `session.ts:379-410` `triggerRooms()` 回传 `{spawned, rejections}`；`session.ts:284-301`
  `step()` 汇总为真实计数并逐条产出 `W_SPAWN_CAPACITY` 诊断（`pushDiag` 按 code+node 去重，
  `:316-323`）。接口注释（`:105-113`）把「曾经返回常量 0」如实写成了教训。
- 测试锁：`session.test.ts:163-205` 四条（容量不足 `spawned=0/rejectedRooms=1/rejections` 明细、
  诊断产生、`drainDiagnostics` 排空、容量充足时真实生成数）。
- 消费者已接：`main.ts:192-203` + `:2556` 每帧取走并上 UI（见 §二-1 的代价核查）。

### A2 A/B 未覆盖「房间未进入 → 一个都没刷」分支 —— **已修（capture 层），附一处事实订正**
- `spawn-ab.test.ts:24-33` 新增断言：指纹覆盖全部刷怪点，且未进入房间的点 `spawned === 0`
  （`:32`）。这是第一轮点名缺的那条分支断言。
- **事实订正（第一轮描述有偏差）**：`git show ba5e093` 证实 `compareScatter` 的 `changed`
  公式**当时就包含** `radius/count` 比较（旧版 :203-209 与现版逐字相同，`spawn-ab.ts`
  不在本轮改动面内）。所以编辑未触发点时 `changed=true`，A/B 行实际标「已改 · 实体 0→0」，
  而不是第一轮所说的「两者全等 → changed=false」「A/B 标未变与消息栏矛盾」。
  该分支的**行为**当时是可见的，缺的是**断言** —— 现已补上 capture 侧。
- 残留：compare 侧「编辑未触发点 → 展示 实体 0→0」仍无专项断言（全部编辑用例仍走
  `triggeredSeeds`），见建议 C2-6。

### A3 `revertAll()` 无入口却写进可操作清单 —— **已修（按"删声称"路线）**
- `docs/19:37` 现在如实登记：「`revertAll()`（整轮还原）只是 `SpawnEditStore` 的 API，
  **没有 UI / 钩子入口**，用户到不了」。
- grep 确认 §1 第 5 步的「撤销（或整轮还原）」声称已删除；全仓 `revertAll` 仅剩
  `spawn-edit.ts:253` 定义与两条测试。代码入口未补 —— 第一轮给的两个选项（补入口或删声称）
  之二，合规。

### A4 保存自检弱于声称 —— **已修**
- `main.ts:1003-1016`：合法集合改为**按 kind 限定** —— 遍历文档所有 `SpawnPoint` 组件生成
  `nodes[i].components[c].{radius,count}` 白名单，`Collider{sphere}.radius` 之类不再能骗过。
- `diffs.length === 0` 早退（`:998-1002`，提示"没有改动需要保存"，不写盘）；
  多节点编辑合法（注释 `:981-984` 明确不按条数卡，并记录了"恰好一条"曾造成回归的教训）。
- 回归守卫：`tools/verify/editor-parity.mjs:359-389` 双节点编辑必须能存盘。

### A5 「资源清理」描述夸大 —— **已修**
- `docs/19:218-228` 整段重写为「如实描述」：runtime 侧无 GPU 资源；宿主资源登记进
  `PlaySession.ledger`；动态实例/网格由渲染核心按 `meshId` 缓存、跨 Play 复用、随
  `destroy()` 释放。与代码（`play-session.ts:109-121,217-231`）逐句对得上。

### A6 `panBy` 第二份相机基向量 —— **已修（登记路线）**
- 第一轮的诉求是「`docs/18` 没登记这条同源风险」。现 `docs/19:249-251`（限制 5）已如实登记
  panBy 与 screenRay 同型、以及 FOV 三处硬编码。代码未动（`main.ts:518-530` 手写基向量仍在），
  低危遗留，账目清楚了。

### A7 FOV 45° 三份硬编码 —— **未修**（转入 C2-2）
- 三处原样保留：`renderer-core.ts:869`、`main.ts:500`、`asset-preview.ts:465`。
  第一轮建议的 `DEFAULT_FOVY` 单一真源未做；仅在 `docs/19:251` 登记。属"已登记的未修"。

### A8 三条恒真/近似断言 —— **已修**
- `runtime-bridge.test.ts:96-99`：改断言「无重复 meshId + 形态匹配」，`size>=1` 恒真断言已删；
- `runtime-bridge.test.ts:136`：新增强断言 `batches.length === kinds.size`（批次 == 体型种类数）。
  注：`:137` 仍保留旧的 `toBeLessThan(total/10)`，已被 `:136` 完全覆盖，属冗余而非假阳性；
- `session.test.ts:98-101`：删掉「generation 是整数」恒真断言，改锁「id 唯一 + generation ≥ 1」，
  注释把理由写明了。

---

## 二、整改是否引入新问题（逐项核查）

### 1. `drainRuntimeDiagnostics()` 每帧代价 —— **可忽略，无问题**
- 调用链：`main.ts:2556` → `playCtl.runtimeDiagnostics`（`play-controller.ts:71-73`）→
  `session.diagnostics()`（`session.ts:304-306`）**返回数组引用，无分配**。
- 诊断累计上界 = 不同 (code,nodeId) 对数（`pushDiag` 去重，`session.ts:316-323`），
  即房间数量级；`reset()` 同步清空（`:346-347`）。每帧一次引用读取 + 小集合查找，代价可忽略。

### 2. `shownRuntimeDiags` 去重集合生命周期 —— **主路径正确，重跑路径有缺口（建议 C2-3）**
- 新 Play 清空（`main.ts:175-178`）—— 本次改动正确：第二轮 Play 的同类告警不会被上一轮吞掉。
- **缺口**：`restartPlay()`（`main.ts:1044-1056`）直接调 `playCtl.start()`，**绕过** btnPlay
  处理器里的 `shownRuntimeDiags.clear()`。重跑后若再次命中同一房间容量拒绝，告警不再显示。
  低频低危（容量拒绝本就罕见），但"清空时机"应该跟"新世界创建"对齐而不是跟"按钮"对齐。

### 3. `play()` 失败路径的资源登记残留 —— **无残留**
- `PlayController.start()`：`play()` 失败在 `registerResource` 之前 return
  （`play-controller.ts:92-96`），本轮不登记任何东西；失败也不动作者状态
  （测试 `play-controller.test.ts:97-114` 锁住）。
- `PlaySession.play()` 失败路径（`play-session.ts:161-167`）不触碰 `resources`；
  即使异常顺序（未 stop 再 play），旧登记项仍由下一次 `stop()` 统一释放，
  `registered == disposed` 恒成立（20 次启停 + 释放抛错两条测试锁住，
  `play-controller.test.ts:130-157`）。

### 4. 保存自检边界行为 —— **正确**
- `diffs.length === 0`：早退、提示、不写盘（`main.ts:998-1002`）。✅
- 多节点编辑：全部路径落在白名单即放行，编辑器探针有守卫用例。✅
- **但 `docs/19` 的描述没跟上代码，见 C2-1。**

### 5. `pickSceneLights` 的 spot 与 `range<=0` —— **range 处理合格；spot 语义静默丢失（建议 C2-4）**
- `range<=0`：schema 层已在装载时拦截（`document.ts:761` point/spot 必须 `range>0`）；
  编辑器侧 `main.ts:473` `if (range > 0)` 才覆盖面板默认，双保险，处理正确。
- **spot**：`renderer.ts:469` 把 spot 并入 point 桶，`PickedLight` 不带 `type/spotAngle`
  （schema 有该字段，`document.ts:239`），锥角语义**静默丢弃且 warnings 不提示**。
  目前入库场景无 spot 灯，无实际影响，但这正是 A3 当年"数据字典向下游承诺了不存在的行为"
  的同型缺口，建议补一句 warning 或在 docs/19 限制里登记。

### 6. 顺带发现：`drainDiagnostics()` 生产零调用（建议 C2-5）
- 全仓 grep：`drainDiagnostics` 仅 `session.ts:309` 定义 + `session.test.ts:178-181` 测试，
  宿主走的是非排空的 `diagnostics()` + UI 侧 `shownRuntimeDiags` 去重 —— **两层去重**。
  功能正确，但 API 声称的"宿主每帧取一次"与实际用法不符；要么宿主改调 drain 版（省掉
  UI 侧集合），要么删掉 drain 版。与第一轮 B4（`clearDynamicMeshes` 无调用方）同型。

---

## 三、第一轮"通过"判据再确认

| 判据 | 结论 | 证据 |
|---|---|---|
| 分配/释放配对 | ✅ 成立且**变强了** | 20 次启停 `registered==disposed==20`、`pending==0` 入库断言（`play-controller.test.ts:130-144`）；释放抛错不挡停止（`:146-157`）；renderer-core `destroy()` 路径本轮未动 |
| 错误路径不假成功 | ✅ 成立 | 装载失败不动作者状态、error 有原因（`:97-114`）；写盘失败不 commit、`dirty` 保留（`main.ts:1029-1033`） |
| 确定性 | ✅ 零命中（本轮实测） | `packages/{runtime,ai,gameplay,content}/src` grep `Math.random\|Date.now\|performance.now` 无任何命中 |
| `editor:smoke` 6 条失败非真实回归 | ✅ 定性仍成立 | `editor-smoke.mjs` 与启动场景/`startIndex` 在本轮改动面内**零改动**（`git diff --stat ba5e093..HEAD` 实测），第一轮基于夹具核对的定性不受影响。本轮未重跑浏览器 smoke（只读评审不开 dev server），结论基于改动面推断 |
| 门禁纪律（§9.5 的教训） | ✅ | `typecheck` 绿 + `test` 569/569 绿，本轮两门禁同跑 |

---

## 四、本轮发现清单

### 阻断
**无。**

### 应修
- **C2-1 · `docs/19` 保存自检描述残留「恰好一条」，与代码直接矛盾**
  `docs/19:208-209` 仍写「改动路径必须全部落在**被编辑那一个** `SpawnPoint` 的
  radius/count 上，且**恰好一条**」。代码（`main.ts:981-984`）明确**不按条数卡**、
  多节点编辑合法；`docs/18:525-529` 也已注明该判据改为按 kind 限定。
  这是 §9.5 抓过的真回归的**描述残留** —— 最终报告声称的闸门比实际严，
  下一个 Agent 按报告复现会得出"保存被拒是 bug"的错误结论。改为按 kind 限定的描述即可。

- **C2-2 · A7 未修：FOV 45° 仍三份硬编码，无单一真源**
  `renderer-core.ts:869` / `main.ts:500` / `asset-preview.ts:465`。
  已如实登记（`docs/19:251`），所以从"未登记的重复"降级为"已登记的未修"，
  但第一轮判的是应修，整改未动代码，照实判**未修**。

### 建议
- **C2-3** · `shownRuntimeDiags.clear()` 只在 btnPlay 路径执行，`restartPlay()` 绕过
  （`main.ts:177` vs `:1044-1056`）。建议把清空挪进 `PlayController.start()` 成功的回调里。
- **C2-4** · `pickSceneLights` 把 spot 当 point 用，`spotAngle` 静默丢弃、无 warning
  （`renderer.ts:469`）。当前无 spot 场景，无实际影响。
- **C2-5** · `session.drainDiagnostics()` 生产零调用，与非排空读 + UI 去重形成两层去重
  （`session.ts:309`、`main.ts:192-203`）。二选一收敛。
- **C2-6** · A/B compare 层仍无「编辑未触发点」专项断言（`spawn-ab.test.ts` 编辑用例全走
  `triggeredSeeds`）。补一条：改房间 3 的点 → `changed=true` 且 `实体 0→0`。
- **C2-7** · `runtime-bridge.test.ts:137` 的 `toBeLessThan(total/10)` 已被 `:136` 的
  严格等值断言覆盖，属冗余，可删。

---

## 五、总判定

**通过。**

理由：阻断判据四条全部维持成立且资源账目由"探针观察"升级为"入库断言"；
8 条应修 7 条已修、1 条（A7）未修但已如实登记、无修错；
新发现问题均为文档描述残留与低频边界缺口，最高档位应修，无阻断。
建议合入前处理 C2-1（最终报告与代码矛盾，属同一类"声称 vs 实际"问题，不该带进主分支）。
