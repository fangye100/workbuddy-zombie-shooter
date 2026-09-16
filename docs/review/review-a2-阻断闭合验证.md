# 第二轮独立评审（只读复验）· `feature/headless-runtime`

评审对象：`C:\Users\fangy\WorkBuddy\game-design-zombie`，HEAD = `26f8c22`，20 笔提交。
评审方式：只读。未修改任何源文件、未提交、未动 `.git`。唯一写入是本报告。
（注：工作区里 `agents.md` 的未提交改动是评审开始前就存在的他人改动，与本次评审无关。）

---

## 0. 门禁实测（先摆事实）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run test` | ✅ **560 passed / 31 files** | `Test Files 31 passed (31) · Tests 560 passed (560)` |
| `npm run typecheck` | ❌ **失败（1 error）** | `packages/runtime/test/session.test.ts(191,80): error TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'.` |
| `npm run editor:build` | ✅ | `✓ 89 modules transformed … built in 3.06s` |
| `npm run scene:check` | ✅ | `Tests 12 passed (12)` |
| `npm run content:check` | ✅ | `✅ content 生成物与真源同步。` |
| `npm run verify:prefix` | ✅ | `✅ 类名前缀闸门通过` |
| `npm run smoke:nav` | ✅ | `All checks passed.` |
| `npm run editor:smoke` | ⚠️ **127 PASS / 6 FAIL / 3 SKIP** | 与 docs/19 §6-1 登记的「6 条恒失败」一致 |

`typecheck` 是**红的**，且是整改提交直接引入的 —— 详见「新发现 · 阻断 1」。

---

## 1. 六条阻断：逐条闭合判定

### A1 容量超限零 diagnostic ｜ **部分闭合**

**做到的部分（真实、且断言具区分力）**

- `packages/runtime/src/session.ts:379-410`：`triggerRooms()` 返回 `{ spawned, rejections }`，
  拒绝走 `rejections.push({ roomNodeId, needed: total, free })`（`:402`），整批原子拒绝。
- `session.ts:284-301`：`step()` 把 rejections 同时回填 `StepReport.rejectedRooms/rejections`，
  并对每条 push 一条 `W_SPAWN_CAPACITY`（`:288-294`），同一 `(code,node)` 只记一次（`:316-323`）。
- `session.ts:304-314`：`diagnostics()` / `drainDiagnostics()`。
- 测试 `packages/runtime/test/session.test.ts:160-183` 断言**是精确值而不是形狀**：
  `expect(r.rejections).toEqual([{ roomNodeId: 'nd_f1r0', needed: 12, free: 5 }])`。
  把 `needed`/`free` 改成任何别的数都会红 —— 判据成立。

**没做到的部分**

1. **产出没有消费者。** 全库搜索：`rejections` 只被 `session.ts` 自己与 `session.test.ts` 引用；
   `drainDiagnostics()` 除测试外**零调用**；
   `PlayController.runtimeDiagnostics`（`apps/editor/src/services/play-controller.ts:71-73`）
   定义后**无人读取**。也就是说：容量不足时，编辑器 UI 上一片寂静。
   AGENTS.md §2.2 要求的是「**显式告知**」，目前只做到了「显式产出，无人告知」。
   `session.ts:120` 的注释写着「供 UI 指出是哪一个房间」—— 这个 UI 不存在。
   这正是整改文档 §9.4 自己总结的病根的**变体**：上一轮是「声明与断言未成对」，
   这一轮是「产出与消费未成对」。
2. **构造期 / reset 期的拒绝被丢弃。**
   `session.ts:232`（构造函数）与 `session.ts:351`（`reset()`）调用 `triggerRooms()`
   **丢弃返回值**。玩家出生房间若一开始就超容量，在第一次 `step()` 之前
   `diagnostics()` 是空的，而 `play()` 返回 `ok:true`，宿主无从察觉。

**判定**：核心缺陷（接口返回假常量）已真修，但「告知」未闭环，且留有丢弃窗口 → **部分闭合**。

---

### A2 Play 期资源登记表 ｜ **闭合（附一条限制）**

- `packages/runtime/src/play-session.ts:109-121`：`registerResource()` + `ledger{registered, disposed, pending}`，
  `pending` 取 `this.resources.length`（真值，不是计数器）。
- `play-session.ts:217-231`：`stop()` **先**逐个 `dispose()`（try/catch，一个失败不挡其余），
  **再** `session = null`，顺序与注释一致；`disposedCount` 只在成功时 +1。
- `apps/editor/src/services/play-controller.ts:102`：宿主登记 Bridge 批次。
- 断言 `apps/editor/test/play-controller.test.ts:118-132`：
  20 轮启停，每轮都断言 `pending === 1 → 0` 且 `registered === disposed`，
  末了 `registered === disposed === 20`。
  **具区分力**：若 `registerResource` 没被调用，`pending` 恒 0，`toBe(1)` 立刻红。
  实测 `npm run test` 中该用例通过（`play-controller.test.ts (6 tests) 163ms`）。
- 文档一致性：docs/19 §6「资源清理」描述的机制（runtime 不持 GPU、宿主登记、
  动态实例 buffer 由渲染核心按 meshId 缓存跨 Play 复用）与
  `play-session.ts:214-215` 注释、代码完全对得上。

**附带的实质限制（需写进文档，不是阻断）**：
唯一登记项 `'bridge-batches'` 的 dispose 是 `() => this.bridge.attach(null)`，
而 `apps/editor/src/services/runtime-bridge.ts:149-161` 的 `attach(null)` **只清 JS 数组
（`slots.clear()`），不销毁任何 GPU 资源**。真正的 GPU 侧实例 buffer 被有意排除在账目外
（docs/19 §6 已披露）。
所以 `pending === 0` 证明的是「**登记纪律**」，**不证明「显存已释放」**。AGENTS.md §2.4
「释放**全部** Play 期 GPU 资源」仍有一类豁免项。建议把这句话在 AGENTS.md/docs/19 里
改成「账目证明的是登记—释放配对，不是显存归零」，否则下一个人会拿 `pending===0`
去宣称「无显存泄漏」。

---

### A3 多灯按 priority 降级 ｜ **部分闭合**

**做到的部分**：`apps/editor/src/renderer.ts:884-919` 实现完整 ——
按 `priority` 降序（`byPriority`，稳定排序保证同输入同结果）、
directional 与 point/spot 分桶、各取 top-1、落选者 `slice(1)` 进 `warnings`；
结果经 `main.ts:440-449` 写进面板。**入口可达**：`loadScene()` 每次 boot 都走。

**没做到的部分**

1. **零断言。** 全库 `*.test.ts` 中 `priority` 只出现在 `packages/scene/test/document.test.ts`
   的 schema 夹具里；`keyLight` / `pointLight` / `灯光降级` **没有任何测试引用**。
   整改文档 §9.4 第 1 条刚写下「报告里的每一句实现声明，都应该有一条断言」，
   A3 这条声明仍然没有。
2. **入库场景上永不触发。** 实测 8 份 `.scene.json`
   （`act1/floor-1/2/3`、`sandbox/default`、`sim/floor1-t0/t1/t3/t5`）
   **每份都只有 1 盏 `directional`（priority 100），point 灯 0 盏**：

   ```
   assets\scenes\act1\floor-1.scene.json → 1 盏: [{"id":"nd_f1_key","type":"directional","prio":100,"en":true}]
   …（8 份同形）
   ```

   ⇒ `directional.slice(1)` / `point.slice(1)` 恒为空，落选 warnings 分支**不可达**；
   `r.pointLight` 恒为 `null`，`main.ts:446-449` 的点光接管**在当前任何场景下都不会执行**。
   「点光 color/intensity/range 首次来自场景」这句结论，在库内没有任何一份数据能复现。
3. **AGENTS.md §2.3 的「标黄」未满足。** 落选 warnings 只到
   `apps/editor/src/main.ts:432` 的 `console.warn(`[boot] 场景告警：${w}`)`，
   编辑器 UI 里没有呈现。（`main.ts:1836` 那处 `bd-warn` 属于绑定/重定向结果面板，
   不是 `SceneLoadResult.warnings`。）
   docs/19 §6-7 写「尚未在编辑器里标黄，**只有文字告警**」—— 措辞偏乐观：
   连 UI 文字都没有，只有控制台。

**判定**：行为真做了、入口真走到了，但**不可测、不可复现、未告知** → **部分闭合**。

---

### B1 两侧一致比对逻辑入库 ｜ **闭合**

`tools/verify/runtime-parity.mjs`，比对自己在 `:92-119`（按 `id:generation` 配对、
离散字段全等、连续字段容差 `1e-9` 并报 `maxΔ`），`:140-183` 是 compare 模式。
实测**正负对照**（`npm run runtime:build` 后，对 `assets/scenes/act1/floor-1.scene.json`）：

```
### 同种子（应 PASS）
[PASS] 两侧喂进 runtime 的是同一份文档 — 9fba3e18
[PASS] 逐实体身份 / 位置 / 目标 / 状态一致 — 13 个实体，maxΔ=0.00e+0
===== 4 PASS / 0 FAIL =====   exit=0

### 异种子 seed48 vs seed7（应 FAIL）
[FAIL] 逐实体不一致 — 1:1.x Δ=6.684e-1 | 1:1.z Δ=3.651e-1 | 1:1.yaw Δ=5.906e+0 | …
===== 3 PASS / 1 FAIL =====   exit=1
```

两边实体数都是 13（只比数量会假绿），逐实体 Δ 被真实报出，退出码分岔。**闭合**。
（`editor-parity.mjs:214` 通过 `spawnSync` 调这个模式，§8-1 结论的唯一出处成立。）

---

### B5 §8-5 画面对应取证 ｜ **闭合（证据入库）**

`tools/verify/editor-parity.mjs` 已入库，挂 `npm run verify:parity-host`。
三条证明齐全：§8-1（调 `runtime-parity.mjs --compare`）、§8-5（`:266-303`，
`worldToScreen` 得像素位置 → 真实点击入口回环命中）、§8-6（保存重开）。
文件头保留了「被测对象身份是隐含断言」的纪律（每轮唯一端口 + `performance.now()` 验页面年龄，
`:153` / `:173`）。docs/19 也如实写了「该证据尚不能证伪旧公式」。

**本次未能端到端复跑**：harness 不自启编辑器服务（`URL_APP = https://localhost:5100/`，`:41`），
需外部先 `npm run editor`；`usage` 里写了前置条件但未写「必须先起服务」，见建议 5。
就「阻断本身（证据不在库内）」而言 **闭合**。

---

### B7 Stop 恢复作者状态 ｜ **部分闭合**

`apps/editor/test/play-controller.test.ts` 入库，6 条，`npm run test` 通过。
其中 `:85-95` 确能判出「`stop()` 忘了调 restore」（忘了则 `objects` 仍是被改过的，断言红）。

**但断言不覆盖真正要证的东西。** `:44-48` 的替身是**恒真**的：

```ts
restoreAuthorState: (snap: AuthorSnapshot) => {
  objects = snap.objects.map((o) => ({ name: o.name }));
  selectedIndex = snap.selectedIndex;
  return { restored: Math.min(snap.objects.length, snap.objects.length), mismatched: false };
},
```

`mismatched` 恒 `false`、恢复恒成功、字段恒整体覆盖。
§8-7 要证的是「**真实的** `LabRenderer.restoreAuthorState()` 逐字段把作者状态恢复回去」，
而它被替身顶掉了 —— 真的那份（`apps/editor/src/renderer.ts`）依旧**零测试**。
同时 `play-controller.ts:146-151` 的 `res.mismatched` 告警分支也永远走不到。

**判定**：装配层的调用顺序有了断言，真实恢复逻辑仍无断言 → **部分闭合**。

---

## 2. 新发现

### 阻断

**【阻断 1】`npm run typecheck` 在 HEAD 上是红的，且是整改提交直接引入**

```
packages/runtime/test/session.test.ts(191,80): error TS2345:
  Argument of type 'string | null' is not assignable to parameter of type 'string'.
```

`packages/runtime/test/session.test.ts:191`
`… && !triggered.includes(sp.roomNodeId)`
—— `SpawnDesc.roomNodeId` 的类型是 `NodeId | null`（`packages/runtime/src/loader.ts:77`），
而 `triggeredRooms(): NodeId[]`（`session.ts:277`）。
`git blame` 确认这一行来自 **`45f9a82`「评审整改（1/2）」**，即本轮整改新增的测试。

vitest 用 esbuild 只转译不检查，所以 `npm run test` 全绿掩盖了它。
后果：整改是以「门禁通过」为交付前提的，但**门禁之一没跑过**。
按整改文档 §9.4 的话说，这又是一次「声明（门禁绿）与断言（门禁真的跑）未成对」。

修法最小：`triggered.includes(sp.roomNodeId ?? '')` 或把 `triggered` 声明为 `(NodeId | null)[]`。

---

### 应修

**【应修 1】保存自检收紧后，会误拒完全合法的保存（整改引入的功能回归）**

`apps/editor/src/main.ts:984`：`if (unexpected.length > 0 || diffs.length > 1)`
—— `expected` 只按 **`lastEdit` 那一个节点**展开（`:970-982`），
而 `SpawnEditStore` 是长生命周期的（场景载入时建一次，`main.ts:892`），
`selectedSpawnNode` 可以在 Play 中点僵尸就换（`main.ts:536` / `:1157`），
多步编辑 + undo 栈本来就是支持的流程（面板还展示 `undoDepth`）。

用真实场景 `assets/scenes/act1/floor-1.scene.json` 复现（只读脚本，未落盘）：

```
改 sp0.radius=3.5 + 改 sp0.count=9   => 拒绝? true | diffs=2
   …components[0].count , …components[0].radius | 文案:应1处实际2处
改 sp0.radius=3.5 + 改 sp1.count=9   => 拒绝? true | diffs=2
   …components[0].radius , …components[0].count | 文案:非刷怪点字段 nodes[7].components[0].radius
```

即：**同一个刷怪点改 radius 再改 count → 拒绝保存**；
**换一个刷怪点再改 → 拒绝保存，而且报错说是「非刷怪点字段的改动」**（实际是同类组件的
另一个节点），文案会直接把作者带错排查方向。
`lastEdit` 为 `null` 时本身是安全的（此时 `diffs` 也为空），真正的问题在 `diffs.length > 1`
这一条与「只认最后一个节点」这两处。

建议：`expected` 按**全部 `SpawnEdit` 的 nodeId** 展开（或直接取
`store.undoStack` 的每个 `nodeId`），把 `diffs.length > 1` 换成
「`unexpected.length === 0 && diffs.length >= 1`」。

**【应修 2】A1 产出的信号在生产链路上无消费者（死代码 + §2.2 未落实）**

见 A1 第 1 点。涉及 `session.ts:299`、`session.ts:309`、
`play-controller.ts:71-73`。要么在 Play HUD / 面板里把
`runtimeDiagnostics` 显示出来（并对 `rejections` 指出是哪一个房间），
要么从 `StepReport` 里删掉 `rejections` 并改掉 `session.ts:120` 的注释。
现状是「接口声称了一个没人用的能力」，与首轮判阻断的形态同源。

**【应修 3】A3 灯光选择零断言、且在入库场景上不可达**

见 A3 第 1、2 点。建议把 `renderer.ts:884-919` 那段纯函数抽成
`pickLights(nodes): { key, point, dropped }` 放进 `packages/scene` 或 `apps/editor/src/`，
配一组「3 盏 directional priority 10/100/50 + 2 盏 point」的夹具测试；
再在 `assets/scenes/` 里放一份**真的有多盏灯**的场景，让降级路径在库内有可复现数据。

**【应修 4】B7 的替身让断言绕开了真实 `restoreAuthorState`**

见 B7。建议补一条对真实 `LabRenderer.snapshotAuthorState/restoreAuthorState`
的测试（哪怕只测纯数据部分：把两个方法里对 `objects[]` 的读写抽成不依赖 GPU 的函数），
或至少在测试文件头写明「本文件只覆盖装配层，真实恢复逻辑仍无断言」——
现在的文件头（`:1-13`）读起来像是把整条 §8-7 都证明了。

---

### 建议

1. **构造 / reset 期的 rejection 被丢弃**（`session.ts:232`、`:351`）。
   建议在这两处把 rejections 也 `pushDiag`，否则 `play()` 成功但首步前的世界里
   已经有一批静默拒绝。
2. **`PlayController.stop()` 重复摘桥**（`play-controller.ts:154-155`）：
   `session.stop()` 的账目回调已经 `bridge.attach(null)`，下一行又做一次。
   无害但会让「账目里那一项到底释放了什么」更难解释。
3. **A2 的账目语义要在文档里钉死**（见 A2 附带的限制）：`pending === 0` 只能宣称
   「登记—释放配对」，不能宣称「显存归零」。
4. **`editor-parity.mjs` 不自启服务**（`:41` 硬依赖 `https://localhost:5100/`），
   usage（`:29-31`）也没写这条前置。建议在 usage 补一行「先 `npm run editor`」，
   否则半年后仍会有人跑不起来而误判为「结论失效」。
5. **docs/19 §6-7 措辞**：「只有文字告警」应改为「只有控制台日志，编辑器 UI 未呈现」，
   与 `main.ts:432` 对齐。
6. **建议把 AGENTS.md §2 的硬约束做成清单式回归**（整改文档 §9.4 第 2 条已提出，
   本轮仍未做）：`MAX_OBJECTS`、多灯 priority、sidecar、不硬编码场景。
   A3 这次之所以靠人肉才抓到，就是因为没有任何一条自动化检查。
   这与 §9.4 的自我总结直接呼应，建议列入下一轮。

---

## 3. docs/19 §6「已知限制」十条与代码的一致性核对

| # | 限制 | 核对结果 |
|---|---|---|
| 1 | `editor:smoke` 6 条恒失败（5 条硬编码 sandbox 期望 + 1 条 `autoFitCylinders` 脚本自伤） | ✅ **一致**。实测 6 FAIL 逐条吻合：`objects=32`（期望 13）、物体名、`list=31 scene=32`、`category={}`、`pickable={}`、`autoFitCylinders`（`oRadiiImmediate/Persist` 都是正确的 `0.0574924`） |
| 2 | 启动场景是 sim 派生产物，`startIndex = 7` | ✅ 一致（smoke 的 `objects=32` 正源于此） |
| 3 | 点光位置仍由引擎轨道驱动 | ✅ 一致。新增的 `pointLight.color/intensity/range` 已接线（`renderer.ts:905`、`main.ts:446-449`），位置确实未接 |
| 4 | `LabRenderer` 仍保留硬编码 fallback `buildDefaultSpecs()` | ✅ 一致（`renderer.ts:435`，构造期 `:660` 使用） |
| 5 | `panBy()` 仍有第二份相机基向量；`screenRay()` 已删 | ✅ 一致。`main.ts:494-507` 手算 `sin/cos(yaw/elevation)`；全库已无 `screenRay`，只剩 `renderer.pointerRay()` |
| 6 | 未消费组件零 diagnostic | ✅ 一致。`packages/runtime/src/loader.ts` 里搜不到任何 `Script` / 未消费 / `E_UNKNOWN` 诊断 |
| 7 | 多灯降级已按 priority 实现，但尚未标黄 | ⚠️ **偏乐观**：实际只有 `console.warn`（`main.ts:432`），编辑器 UI 里没有文字，不只是「没标黄」 |
| 8 | A/B 未覆盖「房间还没进 → 一个都没刷」 | ⚠️ **部分不准确**。`spawn-ab.test.ts:26-32` 已断言 `spawned > 0` 与 `spawned === 0` **两者都存在**（注释写明「房间 3 未进入 → 0」），所以「捕获」这一侧是覆盖了的；未覆盖的是 **A/B 比较**（`triggeredSeeds()`，`:18-22` 只取已触发的）。建议改成「A/B **比较**只取已触发的刷怪点」 |
| 9 | `MAX_OBJECTS = 64` 超限明确报错；500 僵尸性能未测 | ✅ 一致（`packages/render/src/frame-uniforms.ts:23`）；未测也属实 |
| 10 | 面板无单测；`__editor.*` 钩子生产构建里无条件装配 | ✅ 一致（`main.ts:1107` 的 `hook.spawn = {...}` 无任何环境判断） |

**有没有把已修的还写在限制里？** 没有。§6「资源清理」段明确写了 ledger 是「本次整改新增」，
未把它误列为限制。
**有没有把未修的漏掉？** 漏了两条本轮新引入的：
① `npm run typecheck` 红（阻断 1）；② 保存自检误拒合法保存（应修 1）。
另外「A1 产出无消费者」（应修 2）也应在 §6 里登记为限制，否则读者会以为容量拒绝已经上屏了。

---

## 4. 六条阻断判定汇总

| # | 判定 | 一句话理由 |
|---|---|---|
| A1 | **部分闭合** | 真值 + diagnostics + 精确值断言都到位；但产出零消费者（§2.2「告知」未落实），构造/reset 期拒绝被丢弃 |
| A2 | **闭合** | ledger 真实、断言具区分力（`pending 1→0` 会红）、释放顺序正确、文档与机制一致；附一条「不证明显存归零」的措辞限制 |
| A3 | **部分闭合** | priority top-1 + 落选 warnings 已实现且可达；但零断言、8 份入库场景全是单灯故分支不可达、AGENTS.md §2.3「标黄」未做 |
| B1 | **闭合** | compare 模式入库，实测正负对照分岔（exit 0 / exit 1，报出逐实体 Δ） |
| B5 | **闭合** | harness 入库 + 挂 npm script，§8-5 用真实点击入口回环；本次未能端到端复跑（需外部起服务） |
| B7 | **部分闭合** | 装配层断言成立；但替身 `restoreAuthorState` 恒真，真实恢复逻辑仍零测试，且 `mismatched` 分支永不可达 |

---

## 5. 总判定

# ❌ 不通过

理由（按严重度）：

1. **门禁是红的**：`npm run typecheck` 在 HEAD 上失败，且由整改提交 `45f9a82` 直接引入
   （`packages/runtime/test/session.test.ts:191`）。整改以「重跑门禁无回归」为交付前提，
   这条前提不成立。
2. **整改引入了功能回归**：保存自检收紧后，连续编辑两次（**同一节点或换节点**）
   都会被拒绝保存，且换节点时报错文案指向错误方向（`apps/editor/src/main.ts:984`）。
   这是「修一个阻断 → 撞出一个新 bug」，且是修在作者数据写盘这条路径上。
3. **六条阻断中三条只是部分闭合**，且部分闭合的原因高度同构：
   **信号产出 / 行为实现了，但没有断言、没有消费者、没有可复现数据**
   （A1 无人消费、A3 零测试且场景不可达、B7 断言绕过真实实现）。
   这恰好是整改文档 §9.4 自己提炼的病根 —— 说明整改只修了「接口返回假常量」那一层，
   没修「声明—断言—消费」这条链。

建议的最小放行条件：修掉阻断 1（1 行）、修掉应修 1（保存自检按全部 `SpawnEdit` 的
nodeId 展开、去掉 `diffs.length > 1` 这条判据）、给 A3 补一组纯函数测试，
然后**全量重跑一次 `npm run typecheck && npm run test`** 并把输出贴进 docs/19。
A2 / B1 / B5 三条可以认定为已闭合。
