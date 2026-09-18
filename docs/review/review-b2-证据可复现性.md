# 评审报告 B2 · 证据与可复现性（第二轮只读复核）

- 对象：`feature/headless-runtime`，**实测 21 笔提交**（`git rev-list --count origin/main..HEAD` = 21，`origin/feature/headless-runtime...HEAD` = `0 0` 全部已推送）。
- 报告：`docs/19-最终开发报告（headless-runtime）.md`（305 行）、`docs/18` §9 整改记录。
- 上一轮：`docs/review/review-b-证据与可复现性.md`（阻断 3 / 应修 8 / 建议 5）。
- 立场：**只读复核**。除本报告 `.workbuddy/tmp/review-b2.md` 与该目录下我自己的中间产物（`rev-b2-*.json` / `b2-*.log`）外，未改任何源文件 / assets / `.git`；未提交。复核后 `git status --porcelain` 仍只有评审前已有的 4 项他人改动（` M agents.md` + 3 个未跟踪 memory + 1 个 bak）。
- 环境：node v22.22.2 / npm 10.9.7 / vite 5.4.21 / Chrome 152.0.7977.66，编辑器跑在 `https://localhost:5100`（HTTP 200）。

---

## 一、总判定

**不通过。**

| 上一轮阻断 | 判定 |
|---|---|
| B-1 §8-1「两侧一致」比对逻辑不可复跑 | **闭合** |
| B-5 §8-5「画面对应」在库内无证据 | **未闭合**（换成了入库的 harness，但该 harness 不确定） |
| B-7 §8-7「Stop 恢复作者状态」零测试 | **闭合（有保留）** |

本轮新增 1 条阻断：**`npm run verify:parity-host` 本身不可复现** —— 同一条命令 10 次运行给出两种结果（`16 PASS / 3 FAIL` × 4 次，`19 PASS / 0 FAIL` × 6 次），而报告声称的是第三种（`17 PASS / 0 FAIL`）。§8-5 的三条断言正是全挂的那三条。

另有一处系统性问题：**报告里的数字整体停留在最后一笔提交 `cae778e` 之前**（提交数、测试条数、harness 断言数、两个文件行数全部对不上）。这与上一轮 M-1（15 vs 17）是同一个失误形态的复发。

---

## 二、阻断

### B2-1（阻断）`npm run verify:parity-host` 不确定 —— §8-5 结论仍不可复现

**报告声称**（docs/19:180）：

```
| `npm run verify:parity-host` | **17 PASS / 0 FAIL**（§8-1 / §8-5 / §8-6 实机 harness） |
```

**实测：这条命令有三种可能的结果，其中两种是失败。**

10 次连跑（每次都完整跑 `npm run verify:parity-host`，脚本自己开 headed Chrome）：

```
run1  :: ===== 16 PASS / 3 FAIL =====     （冷启动，vite 首次 transform）
run2  :: ===== 16 PASS / 3 FAIL =====     （同时并发跑 npm run test）
run3  :: ===== 16 PASS / 3 FAIL =====     （同时并发跑我的 CDP 探针）
run4  :: ===== 16 PASS / 3 FAIL =====     （同上）
run5  :: ===== 19 PASS / 0 FAIL =====
run6  :: ===== 19 PASS / 0 FAIL =====
run7  :: ===== 19 PASS / 0 FAIL =====
run8  :: ===== 19 PASS / 0 FAIL =====
run9  :: ===== 19 PASS / 0 FAIL =====
run10 :: ===== 19 PASS / 0 FAIL =====
```

失败时挂的永远是 §8-5 的三条，且失败原因是 harness **自己判出来的**（不是我的观察）：

```
──── §8-5：选中的敌人在画面中对应得到 ────
[PASS] Play 中选中一个运行敌人 — {"id":1,"generation":1,"sourceNodeId":"nd_f1r0_sp0","characterId":"E-01"}
[FAIL] 画面里能找到可见的运行时实体 — 画面里没有可见实体
[FAIL] 🔴 点在它的像素位置上能选中运行时实体（真实点击入口） — 点下去什么都没选中
[FAIL] 🔴 选中的就是画面上那一只（投影回屏幕与点击点 ≤ 2px） — 无
```

而通过时，输出与报告逐字一致（`#2·代1 @ (730.6, 174.2)px` / `Δ=(0.00, 0.00)px`），说明报告贴的那份确实是真跑出来的，只是**不是每一次都能跑出来**。

**两点独立的硬伤：**

1. **`17` 这个数字在任何一次运行里都不存在。** 我数过 harness 的 `check(` 调用：18 条无条件 + 1 条条件（`secondId !== null` 时才跑），场景里有两个刷怪点，所以满额是 **19**。`grep -c` 佐证：
   ```
   $ grep -nE "^\s*check\(" tools/verify/editor-parity.mjs | wc -l   # 19 处调用（另 1 处是函数定义）
   ```
   报告写 17，既不是失败态（16），也不是通过态（19）。
2. **4 次失败都发生在机器有并发负载 / 冷启动时。** 失败集中在 `sleep(1500)` / `sleep(400)` 不够用的那几次；机器空转时连跑 5 次全过。也就是说 §8-5 依赖**固定 sleep**而不是**等待条件成立**，是一条竞态。

**危害**：这条命令被报告当作「§8-1 / §8-5 / §8-6 的唯一出处」。一条同一输入产出两种终态的命令，作为门禁等于没有门禁 —— 下一次真实回归会被当成"又抽风了"而放过。

**修法**（任选，成本都很低）：
- §8-5 不要靠 sleep：把 `locate` 换成**轮询直到 `cands.length > 0`（带超时）**，超时才判 FAIL；
- 或不要"在当前画面里碰运气挑一只看得见的"——显式记录取景相机，先断言"取景里至少有 1 只实体"，再点它；
- `#btn-play` 之后改为轮询 `bridge.entities.length > 0 && renderer.debugDynamicInstanceCount() > 0`，而不是 `sleep(1500)`。

**附带**：`--user-data-dir` 是**跨轮复用**的 `.workbuddy/tmp/chrome-profile-parity`（窗口几何等存在 `Default/Preferences`，实测 `window_placement = {left:10,top:10,right:1610,bottom:910}`）。harness 自己在文件头把「被测对象身份是一条隐含断言」写成了铁律，却只断言了**页面年龄**（`age <= 30s`），没断言**窗口几何 / profile 是否干净** —— 而 §8-5 的成败恰好依赖取景与 canvas 几何。

---

## 三、逐条闭合判定（上一轮 3 条阻断）

### B-1 → **闭合**

比对逻辑确实入库、确实可复跑、**确实有区分力**（这条是我最担心的，专门做了正负对照）。

**入场核对**（3 件事都成立）：

```
$ git ls-files tools/verify/          # runtime-parity.mjs / editor-parity.mjs 都在
$ grep -nE "^(import|const|let|var|function|\s*const compare)" tools/verify/runtime-parity.mjs
        # 比对逻辑在 runtime-parity.mjs:92 diffSnapshots()，-compare 模式在 :140
$ npm run runtime:build               # EXIT=0，.workbuddy/tmp/runtime/index.js 78466 B
```

**editor-parity 没有把比对内联第二份**（用户点名的检查项）——它是 `spawnSync` 调入库的那份：

```js
// tools/verify/editor-parity.mjs:214
const cmp = spawnSync(process.execPath,
  ['tools/verify/runtime-parity.mjs', '--compare', webFile, '--scene', scenePath,
   '--seed', String(SEED), '--ticks', String(TICKS)], { encoding:'utf8', ... });
```

文件头也明写：*"比对逻辑**不在本文件里**，而是调用 `runtime-parity.mjs --compare`"*。文件内**没有**第二份 `diffSnapshots` / 逐实体比对代码（`grep -c "maxDelta" tools/verify/editor-parity.mjs` = 0，只透传 `maxΔ` 文案）。

**正例（一致时通过）**：

```
$ node tools/verify/runtime-parity.mjs --scene assets/scenes/sim/floor1-t5.scene.json \
      --seed 7 --ticks 60 --out .workbuddy/tmp/rev-b2-A.json
已写出 .workbuddy/tmp/rev-b2-A.json（13 个实体，tick 60）    EXIT=0
# 指纹 7adf8152 / 13 实体 —— 与 docs/19 §3 一致

$ node tools/verify/runtime-parity.mjs --compare .../rev-b2-A.json --against .../rev-b2-A.json
[PASS] 两侧喂进 runtime 的是同一份文档 — 7adf8152
[PASS] 场景与 schema 一致 — sc_sim_floorsc_act1_floor1_t5 v3
[PASS] 到达同一 tick — 60
[PASS] 逐实体身份 / 位置 / 目标 / 状态一致 — 13 个实体，maxΔ=0.00e+0
===== 4 PASS / 0 FAIL =====                                   EXIT=0
```

**负例（4 类扰动，全部判出且 exit 1）** —— 只验"一致时通过"等于恒真断言，所以我按 4 种不同故障模式各打了一枪：

| 负例 | 扰动 | 实测输出 | exit |
|---|---|---|---|
| B | `entities[3].x += 1e-6`（超 1e-9 容差、肉眼不可辨） | `[FAIL] 逐实体不一致 — 3:1.x Δ=1.000e-6` | **1** |
| C | `entities[3].behavior` 0↔1（离散字段） | `[FAIL] 逐实体不一致 — 3:1.behavior 1 vs 0` | **1** |
| D | 删掉 1 个实体（数量差） | `[FAIL] 逐实体不一致 — 实体数 13 vs 12` | **1** |
| E | 只改 `docFingerprint`（实体全同） | `[FAIL] 输入文档不一致（node=7adf8152 other=deadbeef）—— 先解决输入，别谈输出` | **1** |

身份配对用 `id:generation`（不是数组下标），离散字段全等、连续字段报实际偏差，`exit 0` 还必须同时满足 `problems.length===0 && 指纹相同`。**这条判据是硬的**，B-1 的整改是真的。

### B-5 → **未闭合**

形状上整改到位了：`editor-parity.mjs` 入库、`package.json` 有 `verify:parity-host` 入口、§8-5 走的是**真实点击入口**（`window.__editor.pickAtClient`，即 mousedown 那条路），并且断言"投影回屏幕与点击点 ≤ 2px"——比上一轮"先知道答案再打枪"强了一个量级。

但是从**证据**角度它没立住：这条结论依赖的命令有 40% 概率不产出该证据（B2-1），报告又把它标成确定性的 `17 PASS / 0 FAIL`。**一条会随机消失的证据，和上一轮躺在 gitignore 里的证据，对复核者的可用性是一回事。**

顺带肯定两处上一轮提过的改进，我实测确认：
- docs/19 §6 限制 1 已把「`category` / `pickable` 两条返回 `{}` 等于门禁失效」写明，`startIndex=7` 与 sim 派生产物也披露了（M-7 闭合）。实测 `node -e` 读 `aether.project.json`：`startIndex = 7 -> assets/scenes/sim/floor1-t5.scene.json`，name 标注 **"第一层 · 火场 · t=5s 快照（派生产物）"**；场景 **35 节点**，与报告限制 1 写的"35 节点"一致。
- `editor:smoke` 的 6 FAIL 定性准确（见下 §五 数字表）。

### B-7 → **闭合（有保留）**

库内确实有测试了，而且进了 `npm run test`（我全量跑过，见 §五）。`apps/editor/test/play-controller.test.ts` 6 条：

- `:85` Play 期间改动 → Stop 后 `expect(r.read()).toEqual(before)`（覆盖 controller 的"先用快照、不从磁盘重载"）
- `:97` 装载失败不动作者状态 + `error` 有原因 + 状态回 `stopped`
- `:109` 场景未加载时 `start()` 失败不抛异常
- `:118` **20 次启停**：每轮 `ledger.pending===1` → `stop()` 后 `pending===0`、`registered===disposed`，末尾断言 `registered===20 / disposed===20`（这条是上一轮点名要的"账目可断言"）
- `:134` 释放回调抛错不挡住 stop，账目仍记已处理（`vi.spyOn(console,'warn')`）
- `:149` pause/resume/step 透传，`step()` 严格 +1

**保留在四点上**（详见 M2-5/M2-6 与 §四）：

1. 它用**替身 renderer**（`fakeRenderer()`），真实的 `renderer.snapshotAuthorState()`（`renderer.ts:1746`）/ `restoreAuthorState()`（`:1770`）**全仓仍零测试**：
   ```
   $ grep -rn "AuthorState\|AuthorSnapshot" --include=*.test.ts .
   apps/editor/test/play-controller.test.ts:8,9,17,27,44        # 只有替身，没有真 renderer
   $ grep -rn "mismatched" --include=*.test.ts .
   apps/editor/test/play-controller.test.ts:47   # 恒为 false —— 真实的 mismatch 分支从未覆盖
   ```
2. 替身的 `restoreAuthorState` 是 `restored: Math.min(snap.objects.length, snap.objects.length)` —— 左右两边同一个表达式，**自身即恒等式**。
3. 上一轮点名要的"**数量不一致时的 warn 分支**"没做：`play-controller.ts:146-151` 的 `res.mismatched === true → console.warn("…张冠李戴")` 在测试里永远不会进入。
4. §8-7 那条"Stop 后实例回 0 / draw 55→61→55"的**实机**证据仍无入库落点（见 M2-3）。

判定为闭合，是因为上一轮的阻断理由是"库内零测试"——这条已经消除。

---

## 四、应修

### M2-1（应修）报告数字整体停留在最后一笔提交 `cae778e` 之前

`cae778e`（"评审整改（4）：修掉我自己引入的回归，并补齐三条'部分闭合'"）改了 5 个文件、+271 行，**加了 1 个测试文件、给 harness 加了断言、改了 main.ts / renderer.ts**，但报告一个数字都没跟着改。全部偏差都精确等于这一笔：

```
$ git show --stat --oneline cae778e
 apps/editor/src/main.ts               |  57 +++++----
 apps/editor/src/renderer.ts           | 120 +++++++-----
 apps/editor/test/scene-lights.test.ts | 104 +++（新建，8 条用例）
 packages/runtime/test/session.test.ts |   2 +-
 tools/verify/editor-parity.mjs        |  38 ++++-
```

| 报告位置 | 声称 | 实测命令 | 实测 | 差 |
|---|---|---|---|---|
| docs/19:3、:270 | 20 笔提交 | `git rev-list --count origin/main..HEAD` | **21** | ❌ |
| docs/19:173 | `560 passed / 31 files` | `npm run test` | **568 passed / 32 files** | ❌ |
| docs/19:180 | `verify:parity-host` 17 PASS / 0 FAIL | 10 次连跑 | **19 PASS/0 FAIL ×6，16 PASS/3 FAIL ×4** | ❌ |
| docs/19:75 | `main.ts` 1958 → **2537** | `wc -l` | 1958 → **2565** | ❌ −28 |
| docs/19:76 | `renderer.ts` 2137 → **2329** | `wc -l` | 2137 → **2384** | ❌ −55 |

`docs/18` §9.3 也写着"报告数字：提交数 15 → 20"，同样没跟上 21。

**这是上一轮 M-1 的同型复发**：报告在最后一笔提交之后没有重核过。**"复核者第一条会跑的命令"必须准**，建议把这几项做成脚本产出而非手写。

### M2-2（应修）docs/19 §5 的行号落点已漂移

报告 §5 表格里的行号是上一轮（文件更短时）的值，现在指向的内容完全无关：

| 报告声称落点 | 实际内容 | 真实落点 |
|---|---|---|
| §8-3 → `session.test.ts:77,156` | `:77` = `expect(s.countNpc()).toBe(before);`（§8-2 那个新用例）；`:156` = 一句关于容量的注释 | `:112` 与 `:241`（唯一的两个 `insideAnyObstacle()` 调用，用例在 `:106` / `:238`） |
| §8-8 → `session.test.ts:143,150` | `:143` = "不同种子得到不同散布"；`:150` = `make({ capacity: 6 })` | `:228`（`countNpc()===120`）与 `:233`（整批拒绝） |

文件名指对了（这点比上一轮强），但**行号错等价于落点错**。`grep -n "insideAnyObstacle" packages/runtime/test/session.test.ts` 只有 `36`（定义）/`112`/`241` 三处。

### M2-3（应修）§8-7 的"实机补充 `verify:parity-host`"是虚假归属

docs/19 §5 表格第 7 行把 `verify:parity-host` 列为 §8-7 的实机补充。**harness 里没有任何 §8-7 断言**：

```
$ grep -nE "实例|instanceCount|draw|作者状态|restoreAuthor" tools/verify/editor-parity.mjs
23: * 用固定端口 + 不等 Chrome 退出，会连上上一轮的 Chrome 实例…     # 注释
307:  // 收尾 Stop（§8-6 要写盘，别让 Play 会话挂在上面）             # 只是清理用的点击，无断言
```

`editor-parity.mjs` 只覆盖 §8-1 / §8-5 / §8-6（文件头自述，实测断言的 19 条也全在这三块内）。§8-7 的实机侧（`debugDynamicInstanceCount()` 回落 0、`draw` 计数）**仍无入库落点**。要么补，要么把这一栏改回"—"，不能把没跑的写成"实机补充"。

### M2-4（应修）§2 行数表的口径声明与数字不符

docs/19:72 新加了口径声明「口径：`wc -l`（数换行符）」，但表里 4 个文件仍是上一轮那套 **+1** 的老数字（上一轮 L-1 已提过）：`renderer-core.ts` 声称 1141 / 实测 **1140**；`runtime-bridge.ts` 307 / **306**；`play-controller.ts` 170 / **169**；`spawn-panel.ts` 215 / **214**。而 `main.ts` / `renderer.ts` 的 main 侧（1958 / 2137）恰好就是 `wc -l` 值 —— 同一张表两种口径。**既然声明了口径，四个数就该按声明的口径写。**

### M2-5（应修）B-7 的"真实 renderer 路径"仍无测试，替身自身有恒等式

见 §三 B-7 的四点保留。最小修法：给 `renderer.snapshotAuthorState()/restoreAuthorState()` 补一条**不需要 GPU**的单测（构造 `state.objects` 若干项 → 快照 → 就地改 → restore → 逐字段比对；再构造 `objects.length !== snap.count` 触发 `mismatched===true`，断言 controller 的 `console.warn` 文案）。`renderer.ts:1746-1794` 的字段集合是可枚举的（`pos/rot/quat/scale/bob/visible/removed/pickable/name/category/subVisible` + `selectedIndex`），没有 GPU 依赖，做得到。

### M2-6（应修）docs/18 仍在引用被 gitignore 的临时物作为关键证据

`docs/18` 是本报告 §"取舍过程"cited 的对象，整改后仍有两处指向 `.workbuddy/tmp/`：

```
docs/18:231  …截图见 `.workbuddy/tmp/wu3-runtime.png`                                   # §8-4/WU-3 实机证据
docs/18:407  实机探针 `.workbuddy/tmp/wu5-probe.mjs`：**32 PASS / 0 FAIL**，console 错误 / 异常 0   # §8-6 实机证据
```

`git check-ignore` 判定该目录被忽略（`.gitignore:27`）。这些文件**此刻还躺在磁盘上**，但正是上一轮 B-1 的成因形态。docs/19 §5 已把 §8-6 的入库证据改指 `spawn-edit.test.ts` / `spawn-ab.test.ts`（这半边是好的），docs/18 里这两行应改成同一组入库文件的指针，或显式标注"历史记录，产物已不入库"。

### M2-7（应修）docs/19 指错了评审报告的位置

```
docs/19:6  - 独立评审：`.workbuddy/tmp/review-{a,b,c}.md`（三份只读评审…）
```

实际入库位置是 `docs/review/`，且是 `cae778c`（"评审报告一并入库"）刻意做的：

```
$ git ls-files docs/review/
docs/review/review-a-架构与铁律合规.md
docs/review/review-b-证据与可复现性.md
docs/review/review-c-代码风险与遗留.md
```

`docs/18:584` 写对了（"三份报告**已入库**在 `docs/review/`"），只有 docs/19 还指着 gitignore 的那份副本 —— 又是"报告里指着一份不入库的东西"。改一行即可。

### M2-8（应修）§8-5 的固定 sleep + 复用 profile 是无确定性的直接成因（B2-1 根因）

`editor-parity.mjs` 用 `sleep(1500)`（Play 后）与 `sleep(400)`（Pause 后）代替条件等待，并复用 `--user-data-dir`。harness 已经把"页面身份"（每轮唯一端口 + `age` 校验）处理得很漂亮，但**同类的第二、第三个变量（取景是否已有实体、窗口几何是否本轮确立）没有断言**。这是 B2-1 的根因，修掉后 4/10 的失败应消失。

---

## 五、C 组：数字逐项核对表（第二轮）

| # | 报告声称（docs/19 行号） | 实测 | 判定 |
|---|---|---|---|
| 1 | 领先 `origin/main` 20 笔（:3, :270） | **21** | ❌ M2-1 |
| 2 | `origin/feature/headless-runtime...HEAD` = `0 0`（:265） | `0	0` | ✅ |
| 3 | `npm run test` 560 / 31 files（:173） | **568 / 32** | ❌ M2-1 |
| 4 | `npm run typecheck` exit 0（:172） | exit 0 | ✅ |
| 5 | `npm run smoke:nav` 13 PASS / exit 0（:174） | exit 0，**13 条 PASS**（绕障/clearance/UNREACHABLE/无 NaN/预算 0.443ms@300） | ✅ |
| 6 | `npm run scene:check` exit 0，28 资产 + 12 tests（:175） | exit 0，`28 个资产的元数据全部同步` + `12 passed` | ✅ |
| 7 | `npm run content:check` exit 0（:176） | exit 0 | ✅ |
| 8 | `npm run verify:prefix` exit 0（:177） | exit 0 | ✅ |
| 9 | `npm run editor:build` exit 0（:178） | exit 0 | ✅ |
| 10 | `npm run editor:smoke` 127/6/3，CONSOLE 0 / EXCEPTION 0（:179） | `断言：127 PASS / 6 FAIL / 3 SKIP（共 136）`、`CONSOLE ERRORS: 0`、`EXCEPTIONS: 0` | ✅ |
| 11 | 6 条 FAIL 与整改前逐条一致（:182） | 逐条吻合（5 条场景期望 + `autoFitCylinders` `LeftArm 0.091 vs 预期 0.0575`，同批 `oRadiiImmediate/Persist = 0.05749242` 正确） | ✅ |
| 12 | `verify:parity-host` **17 PASS / 0 FAIL**（:180） | 19 PASS/0 FAIL ×6；16 PASS/3 FAIL ×4 | ❌ **B2-1** |
| 13 | §8-1 `maxΔ=0.00e+0` / 13 实体 / 指纹 `7adf8152`（:110-113） | 逐字复现（10/10 次的 §8-1 子块都是 4 PASS） | ✅ |
| 14 | §8-5 `(730.6,174.2)px → #2·代1，Δ=(0.00,0.00)px`（:192） | 仅 6/10 次复现；4 次该块全挂 | ⚠ **B2-1** |
| 15 | §8-6 重载后仍 `4.75`（:193） | 10/10 次 PASS（`1.5 → 4.75`、第二点 `1.5 → 3.75`、重载后 `4.75`、`dirty=false undo=0`） | ✅ |
| 16 | 场景文件 43763 字节（:213） | `wc -c` = **43763** | ✅ |
| 17 | `git status -- assets` 干净（:214） | 空（跑完 harness 后仍为空） | ✅ |
| 18 | `startIndex=7` / sim 派生产物 / 35 节点（:233-242） | `startIndex=7 → assets/scenes/sim/floor1-t5.scene.json`，name 含"派生产物"；`nodes.length = 35` | ✅ |
| 19 | §2 行数表（:75-80） | main.ts **2565**（称 2537）/ renderer.ts **2384**（称 2329）/ 另 4 个 +1 | ❌ M2-1 + M2-4 |
| 20 | §5 行号落点 §8-3 `:77,156`、§8-8 `:143,150`（:190,195） | 实为 `:112,241` / `:228,233` | ❌ M2-2 |
| 21 | §8-7 实机补充 = `verify:parity-host`（:194） | harness 无 §8-7 断言 | ❌ M2-3 |
| 22 | 独立评审在 `.workbuddy/tmp/review-{a,b,c}.md`（:6） | 已入库在 `docs/review/` | ❌ M2-7 |
| 23 | 上一轮 §8-6 撤销/局部性/A-B 落点已改指入库测试（:193） | `spawn-edit.test.ts` / `spawn-ab.test.ts` 命中 | ✅ M-5 闭合 |
| 24 | 上一轮 §8-8 落点已改指入库测试（:195） | `session.test.ts` + `runtime-bridge.test.ts`；且弱断言 `< total/10` 已换成"批次 == 体型种类数" | ✅ M-6 闭合 |
| 25 | 上一轮 §8-2「跨边界」名不副实（:189） | 新增 `session.test.ts:67`，**真的搬动玩家坐标**走出房间再走回、断言 `countNpc()` 不变且 `triggeredRooms()` 仍 `['nd_f1r0']`；旧用例改名"时间推进不会重复投放（同一房间内跑 200 步）" | ✅ M-2 闭合 |
| 26 | 上一轮 §8-4 帧率只测 tick ±1（:191） | `play-session.test.ts:73` 改为"对齐到同一 tick 后逐实体比 id/generation/sourceNodeId/x/z/yaw，容差 1e-9" | ✅ M-4 闭合 |

---

## 六、D 组：验证范围纪律（第二轮）

| 纪律（docs/17 §8） | 本轮表现 | 判定 |
|---|---|---|
| 不改 `assets/**` | 全程 `git status --porcelain -- assets` 为空；`floor1-t5.scene.json` 恒 43763 B | ✅ |
| harness 结论与证据一起入库 | `runtime-parity.mjs` / `editor-parity.mjs` 均 `git ls-files` 命中，`package.json` 有入口 | ✅ 上一轮根因已解 |
| 验证脚本不得污染用户资产 | §8-6 真写盘，还原在 `finally`（`editor-parity.mjs:387-400`）；实测 10 次运行后 assets 干净 | ✅ |
| 不改 schema、不跑 `npm run sim` 代替只读检查 | `runtime-parity.mjs` 只读（不写场景/不导快照），与 `sim-level.mjs` 分离 | ✅ |
| 默认跑受影响 owner 的定向测试 | `smoke:nav`（§8-3 的 `bakeClearance` 出处）已进报告 §5 门禁表 | ✅ 上一轮漏报已补 |
| 结论必须能被独立复跑 | §8-1 / §8-6 可以；**§8-5 40% 概率不产出证据** | ❌ **B2-1** |
| 门禁必须确定性 | `verify:parity-host` 同一输入两种终态 | ❌ **B2-1** |

---

## 七、建议

- **L2-1** `editor-parity.mjs` §8-5：把 `sleep` 换成"轮询到 `cands.length > 0` 或超时"；`#btn-play` 后等 `bridge.entities.length > 0 && debugDynamicInstanceCount() > 0` 而不是 `sleep(1500)`。这是 B2-1 的正解。
- **L2-2** 每轮用全新的 `--user-data-dir`（如 `mkdtemp`），并在日志里打印窗口几何 / `#gpu` rect / 取景相机，把"被测对象身份"断言补全到第三个变量。
- **L2-3** docs/19 §3 那个 `$ npm run verify:parity-host` 代码块贴的是 `runtime-parity --compare` 的**子输出**（4 行）+ harness 的 2 行，而真实输出是 19 行。建议贴完整输出或标注"其中 `--compare` 部分"。
- **L2-4** 报告 §5 的门禁数字建议改为脚本产出（或加一条 `npm run report:check` 自检），从机制上断掉"最后一笔提交之后报告没重核"这个复发两次的失误。
- **L2-5** `editor:smoke` 已连续 4 个 WU 恒 6 FAIL 且 `editor:smoke` exit 1。本轮报告定性准确（并点名 `category`/`pickable` 两条是"对整个对象取空"的门禁失效），但**仍未修**。建议下一步先修那两条取空断言，至少让门禁在这两项上复活。
- **L2-6** `tools/verify/README.md` 已存在，建议把 `verify:parity-host` 的"需要 5100 上编辑器在跑 + 会开 headed Chrome + §8-6 会临时写盘"写进去，并注明 `--no-save`。

---

## 八、一句话

上一轮的三条阻断，**闭合两条、未闭合一条**；其中"证据搬进库"这件事做得很彻底（两个 harness 都入库、`--compare` 有 4/4 的判伪能力、§8-6 的 `finally` 还原实测不脏盘），这是实质进步。

但本轮暴露了同一个病根的**新变种**：门禁脚本本身从"不可复跑"变成了"**跑起来有两种答案**"（10 次里 4 次 §8-5 全挂），而报告把它写成了确定性的 `17 PASS / 0 FAIL` —— 那个数字在任何一次运行里都不存在。叠加"报告数字整体停留在最后一笔提交之前"（提交 20/21、测试 560/568、行数 2537/2565），形态与上一轮 `15 vs 17` 完全一致。

**结论不能比产生它的那把尺子更确定。**
