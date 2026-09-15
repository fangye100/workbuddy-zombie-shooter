# 评审报告 B · 证据与可复现性（只读复核）

- 对象：`feature/headless-runtime`（17 笔，`9a550cc` → `ba5e093`），报告 `docs/19-最终开发报告（headless-runtime）.md`
- 规格：`docs/17` §8（八条业务证明 + 验证范围纪律）、§9（报告七项）
- 立场：独立复核，**未修改任何源文件 / assets / .git**。仅执行只读命令与门禁脚本（`runtime:build` 产物落在 gitignore 的 `.workbuddy/tmp/runtime/`，复核后 `git status` 仍只有评审前已有的 4 项他人改动）。
- 环境：node v22.22.2 / npm 10.9.7 / vitest 2.1.9

---

## 一、总判定

**不通过。**

阻断 3 条：**B-1（§8-1 跨宿主比对证据不可复现）、B-5（§8-5 画面对应在库内无证据）、B-7（§8-7 Stop 恢复作者状态在库内无测试）**。
三条共同根因：**本轮全部实机取证脚本 `wu3/wu4/wu5/wu6-probe.mjs` 都躺在被 gitignore 的 `.workbuddy/tmp/`，没有转正入库** —— 项目自己在 `docs/12-Game-Editor-重构质量审计与加固.md:241` 已把"冒烟脚本未入库、结论不可复现"列为 P0 并修过一次，本阶段又退化了。

数字层面另有 1 处硬错误（提交数 15 vs 实测 17）。

---

## 二、阻断项

### B-1（阻断）§8-1 的"maxΔ=0.00e+0"无法被任何人复跑

**证据链实际形态**：

| 环节 | 位置 | 是否入库 |
|---|---|---|
| Node 侧取样 CLI | `tools/verify/runtime-parity.mjs` | ✅ 已入库（`git ls-files tools/` 命中） |
| 浏览器侧取样钩子 | `apps/editor/src/main.ts:1156` `hook.runtime.runTo()` | ✅ 已入库 |
| 输入指纹 | `packages/runtime/src/doc-diff.ts` `sceneFingerprint()` | ✅ 已入库 |
| **两侧比对 + 容差判定（产出 `maxΔ=0.00e+0`）** | `.workbuddy/tmp/wu6-probe.mjs` | ❌ **被 gitignore** |

**实测**：

```
$ git check-ignore -v .workbuddy/tmp/wu6-probe.mjs
.gitignore:27:.workbuddy/tmp/	.workbuddy/tmp/wu6-probe.mjs

$ git ls-files | grep -i probe
tools/verify/dock-probe.mjs        # 只有这一个，wu3/wu4/wu5/wu6 全不在
```

也就是说：报告里被加粗引用的五行 `[PASS]`（§3）与 §5 表格的第一行，**唯一来源是半年后必然消失的临时文件**。入库的 `runtime-parity.mjs` 只做单侧取样（`--out` 写 JSON），**没有任何 compare 模式**，把两份快照喂进去仍然要靠人眼或另一个不存在的脚本。

**可复现性实测（Node 半侧确实能跑，这点是好的）**：

```
$ npm run runtime:build && node tools/verify/runtime-parity.mjs \
    --scene assets/scenes/sim/floor1-t5.scene.json --seed 7 --ticks 60
{ "host":"node","seed":7,"fixedStep":0.03333333333333333,"tick":60,
  "sceneId":"sc_sim_floorsc_act1_floor1_t5","schemaVersion":3,
  "docFingerprint":"7adf8152", "entities":[ ... 13 项 ... ] }
```
指纹 `7adf8152` 与 13 实体**与报告一致**（另测 `act1/floor-1` = `9fba3e18`、`sim/floor1-t0` = `c1f84482`，均可区分）。但**这只能复现"Node 侧"，复现不了"两侧一致"这个结论本身**。

**附带问题（同一条里，非阻断）**：比对用的文档是 `assets/scenes/sim/floor1-t5.scene.json` —— **sim 导出的派生产物**（`aether.project.json` 中标注 `name: "第一层 · 火场 · t=5s 快照（派生产物）"`），不是作者真源 `act1/floor-1.scene.json`。报告 §3 未说明这一点。

**修法**：把 `wu6-probe.mjs` 里的比对逻辑抽成 `tools/verify/runtime-parity.mjs --compare <node.json> <web.json>`（或新增 `tools/verify/parity-compare.mjs`），加 `package.json` 入口，探针只负责取 web 侧 JSON 后调用它。

---

### B-5（阻断）§8-5「并在画面中对应到它」在库内没有证据

docs/17 §8-5 原文：*"选择一个敌人，能读到稳定身份、来源节点、目标和状态，**并在画面中对应到它**"*。

**库内实际覆盖**：`apps/editor/test/runtime-bridge.test.ts:137-160` 三条拾取测试 ——

```
138: 从实体正上方往下打能命中它自己
146: 从实体头顶之上继续往上打不命中
152: 选中后 selectedEntity 能取到；generation 对不上时拒绝选中
```

这三条的射线是**由实体世界坐标构造**的（先知道答案再打枪），**完全不涉及屏幕像素 → 世界射线 → 命中**这条链。也就是说库内测的是"拾取函数自洽"，不是"画面上点到的就是它"。

**报告自己的供认**（docs/19 §6 已知限制 1，docs/18 §8.2 / §8.6）：

> `screenRay()` 已删……但**没有测试锁住"射线必须与画面矩阵互逆"这条性质**。我复刻旧公式回探针做对照，**它当时也能命中** —— 所以这次删除是**消除重复实现**，不是修错位 bug。

即：唯一支撑"画面对应"的 `Δ=(0.00,0.00)px` 来自 `.workbuddy/tmp/wu6-probe.mjs`，**且该证据不具区分力**（旧公式同样 Δ=0）。一条既不可复跑、又不能证伪的证据，撑不起 §8-5 的后半句。

**修法**（docs/18 §8.6 已给出方向，但仍未做）：补一条入库的往返测试 —— 取 `renderer` 的 `viewProj`，把实体世界坐标投影成 NDC/像素，再用 `pointerRay()` 反投影并拾取，断言命中同一 `id:generation`。这条不需要 GPU，node 环境可做。

---

### B-7（阻断）§8-7「Stop 恢复 Play 前作者状态」库内零测试

docs/17 §8-7 前半句是硬要求：*"Stop 恢复 Play 前作者状态"*。

**实测：全仓没有一处测试碰它。**

```
$ git ls-files apps/editor/test/
... retarget / binding / selection-outline / cylinder-overlay / gizmo /
    models / scene-boot / runtime-bridge / materials          # 无 play-controller.test.ts

$ grep -rn "snapshotAuthorState\|restoreAuthorState" --include=*.test.ts .
（无命中）
```

相关实现在 `apps/editor/src/services/play-controller.ts`（157 行）与 `apps/editor/src/renderer.ts`（`snapshotAuthorState()` / `restoreAuthorState()`），**两者都没有测试文件**。`runtime-bridge.test.ts` 的 12 条只覆盖挂接/摘下、refresh、实例打包、拾取、换世界，不含作者态快照。

唯一证据是 docs/18 §6.5 的 WU-4 探针（`Stop → 实例回 0`、`draw 55 → Play 61 → Stop 55`），落在 `.workbuddy/tmp/wu4-probe.mjs`（gitignore）。

> 补充（对团队公允）：§8-7 的**后半句**"20 次启停账目平衡"**是有入库测试的** —— `packages/runtime/test/play-session.test.ts:197`「20 次启停：每次都是新世界，结果一致，无跨次残留」（断言每次 `runtime` 是新对象、`stop()` 后为 null、20 次快照逐位相同、`cycleCount === 20`）。所以这条是**一半阻断**。
>
> 但要注意：该测试**没有计数分配/释放**，它测的是"引用账目"，不是 docs/17 要求的"**受管理资源分配/释放账目平衡**"。测试注释自己也承认：*"runtime 侧没有 GPU 资源，能测的是引用账目……真正的显存账目在浏览器侧配 `debugDynamicInstanceCount()` 回落到 0 验证"* —— 而那个"浏览器侧"就是 gitignored 的探针。

**修法**：给 `play-controller` / `renderer` 的作者态快照补入库单测（快照字段集合 + restore 后逐字段相等 + 数量不一致时的 warn 分支）；分配/释放计数做成可查询的 `PlaySession` 字段并断言 `alloc == free`。

---

## 三、应修项

### M-1（应修）报告提交数 15 与实际 17 不符 —— 两处

| 报告位置 | 声称 | 实测命令 | 实测 |
|---|---|---|---|
| docs/19 §开头 | "领先 `origin/main` **15 笔提交**" | `git rev-list --count origin/main..HEAD` | **17** |
| docs/19 §7 | `git rev-list --left-right --count origin/main...HEAD` → `0  15` | 同命令 | **`0	17`** |

补充实测（报告未列但相关）：

```
$ git rev-list --left-right --count origin/feature/headless-runtime...HEAD
0	0                      # 确实全部推送，无未推送提交 ✅
$ git log --oneline origin/main..HEAD | wc -l
17
```
17 = WU-0(1) + WU-1a~1e(4) + WU-2(合) + WU-3(2) + WU-4(2) + WU-5(2) + WU-6(2) + 记忆日志(4)。报告写 15 大概是漏算了 4 笔"补充记忆日志"提交。**这是复核者第一条就会跑的命令，必须准。**

### M-2（应修）§8-2 第三条断言名不副实：玩家根本不动，"跨边界"没发生

`packages/runtime/test/session.test.ts:206`：

```ts
it('再次跨越边界不重复投放（跑 300 步实体数不涨）', () => {
  const s = new RuntimeSession({ desc: desc(), seed: 5 });
  const n0 = s.countNpc();
  s.run(300);
  expect(s.countNpc()).toBe(n0);
  expect(s.triggeredRooms()).toEqual(['nd_f1r0']);
});
```

docs/18 §4 第 1 条明确：**"玩家不移动……玩家 `maxSpeed = 0`"**。玩家不动 ⇒ 300 步内**没有任何一次跨界**，这条实际只证明了"同一房间不会被重复触发"，**没有证明 docs/17 §8-2 要求的"再次跨越边界不重复投放同一波"**。

同一条在 `session.test.ts:53` 还有一份（`s.run(200)`），是同一个弱断言的重复。

§8-2 的另两条是**真证据**：
- `:194` 禁用 SpawnPoint —— 断言 `countNpc()===7` **且** `sourceNodeId==='nd_f1r0_sp0'` 一个都没有（**身份级**，不是数量级）✅
- `:201` 禁用 RoomVolume —— `countNpc()===0` 且 `triggeredRooms()===[]` ✅

**修法**：要么给玩家注入一段脚本化位移（进出房间两次）再断言，要么把用例名改成"同一房间 300 步内不重复投放"，并在报告里注明"跨边界重入因玩家不可移动，本阶段无法验证"。

### M-3（应修）§8-3 引用的证据不在报告声称的门禁里，且落点写错

docs/19 §5 与 docs/18 §8.4 都写：§8-3 由 **"WU-1/WU-2 既有测试（流场 + `bakeClearance`）"** 证明。

**实测：`bakeClearance` 的唯一测试 `packages/ai/test/navigation.smoke.ts` 根本不在 `npm run test` 里。**

```ts
// vitest.config.ts
include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
// navigation.smoke.ts 不匹配 *.test.ts ⇒ 被排除

$ npx vitest list | grep -c "ai/test"
0
$ npm run test | grep -c "packages/ai"
0                      # 549 条里 0 条来自 packages/ai
```

它只能由 `npm run smoke:nav` 跑，而**报告 §5 的门禁表没有列 `smoke:nav`**。我实测它现在是过的：

```
$ npm run smoke:nav
PASS  绕障寻路收敛  frames=1
PASS  clearance 惩罚显著减少贴墙  贴墙格 114 → 5，步数 114 → 114
PASS  密封房间标记为 UNREACHABLE  v=4294967295
... 共 13 条 All checks passed.  exit=0
```

但**报告没说跑过它**，读者无法核对。

**好消息**：真正的障碍约束证据其实**在库内、在 549 里**，只是报告没指过去 —— `session.test.ts:77`「推进过程中没有僵尸停在障碍内部」用 `insideAnyObstacle()`（留 0.05 容差）在 tick 0/10/50/200 四个点逐实体核；`:156` 在 60 只超量场景下再核一次。这是**比"朝玩家距离变小"强得多的证据**，符合 docs/17 §8-3 的反例要求。

**修法**：报告 §5 门禁表补上 `npm run smoke:nav`（exit 0 / 13 PASS），并把 §8-3 落点改成 `session.test.ts:77,156` + `packages/ai/test/navigation.smoke.ts`。

### M-4（应修）§8-4「不同渲染帧率不改变约定逻辑结果」只测了 tick 数，容差 ±1

`packages/runtime/test/play-session.test.ts:66`：

```ts
for (let i = 0; i < 60; i++) a.advance(1 / 60);   // 60fps
for (let i = 0; i < 10; i++) b.advance(0.1);      // 10fps
expect(Math.abs(a.tick - 30)).toBeLessThanOrEqual(1);
expect(Math.abs(b.tick - 30)).toBeLessThanOrEqual(1);
```

问题有二：
1. 只比 **tick 数量**，没有比**实体位置/状态** —— "约定逻辑结果"应该是世界状态，不是步数。
2. `±1` 容差意味着 `a.tick=29 / b.tick=30` 也判过 —— 严格讲这**允许两种帧率走不同步数**，与"帧率不改变逻辑结果"存在张力。

§8-4 的另两半是**扎实的**：`:95` 暂停 5 秒后 `tick` 不变、恢复瞬间不补算 ✅；`:117` `stepOnce()` 只在 paused 下生效且严格 +1 ✅。

**修法**：改成"喂到两侧 tick 相等（各跑到 ≥30 后对齐到同一 tick）再逐实体比坐标"，容差用 1e-9 而不是 ±1 步。

### M-5（应修）§8-6「保存重开保持」无入库证据；撤销/局部性/A-B 反而被报告低估

docs/17 §8-6 要求三件事：撤销有效、**保存重开保持**、同输入重跑散布变化且无关字段不变。

| 子项 | 库内证据 | 判定 |
|---|---|---|
| radius 撤销有效 | `spawn-edit.test.ts:96` undo 精确回原值、差异归零；`:109` 多步 LIFO；`:123` revertAll | ✅ 强 |
| 改一处不牵动其它刷怪点 | `spawn-ab.test.ts:57` 改一处 radius，其余逐位不变；`:74` 散布随 radius **单调变大**（不是只"变了"） | ✅ 强 |
| 无关作者字段不变 | `spawn-edit.test.ts:84` 一次编辑只产生 **1 条**差异路径；`spawn-ab.test.ts:116` 撤销后文档差异归零 | ✅ 强 |
| 同种子重跑逐位一致（A/B 前提） | `spawn-ab.test.ts:35`、`play-session.test.ts:176` | ✅ 强 |
| **保存重开保持（整页重载后值仍在）** | **无** —— 只能靠浏览器，唯一证据 `wu5/wu6-probe.mjs`（gitignore） | ❌ |

**修法**：报告应把 §8-6 前四项明确指向 `spawn-edit.test.ts` / `spawn-ab.test.ts`（现在 §5 表格只写"WU-5/WU-6 探针"，把强证据说成了弱证据），并单独标注"页面重载持久化"这一子项暂无入库证据。

### M-6（应修）§8-8 落点写反了：把入库的强证据写成了探针

docs/19 §5 表写：§8-8 → `docs/18 §5.5（WU-3 探针，超 MAX_OBJECTS 的纯胶囊用例）`。

实际 docs/18 §5.5 的**第一条**就是入库测试，而且比探针硬：

- `session.test.ts:143`：`makeScaled(40, 512)` → `countNpc()===120`，`view().length > 64`（静态上限 `MAX_OBJECTS=64`）✅
- `session.test.ts:150`：容量不足整批拒绝，`countNpc()===0`、不悄悄截断 ✅
- `runtime-bridge.test.ts:115`：**120 实体只产出"体型种类数"份网格**（`batches.length < total/10`）—— 若走静态路径就是 120 份几何 + 120 个 transformBuf 槽 ✅ 这条直接打在"渲染分离"上

**判定：§8-8 实际是八条里证据最扎实的一条之一**，报告的落点表述低估了它。改指向上述三个入库测试即可，探针作为"真实 GPU 上确实画出来了"的补充。

### M-7（应修）D 组：分支层面确实跑过 sim 且产物入库，报告未披露

docs/19 §5 写 *"本轮不改 schema、不改 `assets/**`"*、*"未按 `npm run sim` 走完整模拟导出"*。对 **WU-6 这一轮**成立（实测 WU-6 两笔只改 `main.ts` / `session.test.ts` / `doc-diff.ts` / `runtime-parity.mjs` / docs）。但**分支整体**不是：

```
$ git diff --name-status origin/main..HEAD -- assets aether.project.json
M  aether.project.json
A  assets/characters/stats.json
M  assets/scenes/act1/floor-1.scene.json
M  assets/scenes/act1/floor-2.scene.json
M  assets/scenes/act1/floor-3.scene.json
A  assets/scenes/sim/floor1-t0.scene.json
A  assets/scenes/sim/floor1-t1.scene.json
A  assets/scenes/sim/floor1-t3.scene.json
A  assets/scenes/sim/floor1-t5.scene.json

$ git diff origin/main..HEAD -- aether.project.json
-  "startIndex": 1,
+  "startIndex": 7,          # → scenes[7] = assets/scenes/sim/floor1-t5.scene.json
```

`startIndex` 在 `e66d6be`（WU-1c/1e）被从 1 改成 7 —— **编辑器的启动场景变成了一个 sim 派生的快照**。这带来两个后果：

1. 它是 `editor:smoke` 6 条 FAIL 中 **5 条**的直接根因（脚本硬编码 sandbox 的 13 物件/15 节点期望，实际加载 32 物件）：
   ```
   [FAIL] 物体数 = 13（场景文件 15 个节点减去光与相机） — objects=32
   [FAIL] 天空不进层级面板（background 生效），故列表 12 个而场景 13 个 — list=31 scene=32
   [FAIL] category 来自正式字段 ... — {}
   [FAIL] pickable 来自文件 ... — {}
   [FAIL] 物体名来自文件 ... — names=房间 1 · 战斗,掩体 1,...
   ```
2. **§8-1 的"同一份文档"就是这份派生产物**（指纹 `7adf8152` = `sim/floor1-t5`）。

docs/18 §5.6 已经把这条记为遗留（*"它是派生产物却当成了启动场景，`startIndex` 值得回头核对一次"*），但**交付时仍未处理**。报告 §6 已知限制里也没提。

**修法**：要么把 `startIndex` 回到 `act1/floor-1`，要么在报告里显式披露"启动场景是 sim 派生快照，本分支由 WU-1e 引入，未回改"。

### M-8（应修）`editor:smoke` 场景期望硬编码，6 FAIL 长期噪声未修

报告把它列为"已列入待办"，但从 docs/18 §5.6 到 docs/19 §6 已知限制 3 —— **横跨 WU-3 到 WU-6 都没修**。每轮交付都带着 6 条恒失败，真实回归会被淹没（报告自己也承认这点）。而且这 5 条不是"与场景演进脱节"那么轻：`category` 与 `pickable` 两条返回 `{}`，是**断言对整个对象取空**，等于门禁在这两项上完全失效。

---

## 四、建议项

### L-1 行数表格绝对值系统性 +1（非缺陷，建议统一口径）

| 文件 | 报告 main→HEAD | 实测（`wc -l`） | 增量 |
|---|---|---|---|
| `apps/editor/src/main.ts` | 1959 → 2507 | 1958 → 2506 | +548 ✅ |
| `apps/editor/src/renderer.ts` | 2138 → 2293 | 2137 → 2292 | +155 ✅ |
| `packages/render/src/renderer-core.ts` | 935 → 1141 | 934 → 1140 | +206 ✅ |
| `apps/editor/src/services/runtime-bridge.ts` | — → 307 | — → 306 | — |
| `apps/editor/src/services/play-controller.ts` | — → 157 | — → 156 | — |
| `apps/editor/src/services/spawn-panel.ts` | — → 214 | — → 214 | ✅ |

增量全部对得上，绝对值是 `wc -l`（数换行符）与"末行无换行"的口径差。建议报告统一用 `wc -l` 或统一用编辑器行数，并注明口径。

### L-2 `editor:build` 的 384.58 kB 不可作为门禁证据

实测 `dist/editor/assets/index-CGnWEOiH.js 384.66 kB`（exit 0 ✅）。产物字节数随依赖树微变，写进报告会成为下一次复核的"对不上"。建议只保留 `exit 0`，删掉字节数，或注明"仅供参考"。

### L-3 `scene:check` 的"1 file passed"表述

实测输出是 `[scene:check] 28 个资产的元数据全部同步` + `packages/scene/test/scene-files.test.ts (12 tests)`。写"1 file passed"容易读成"只查了 1 个文件"。建议写成"28 资产元数据同步 + 12 条场景文件测试"。

### L-4 `assets` 变更与 `scene:check` 的时序无法回溯验证

分支确实改了 `assets/**`（WU-0b/1a/1e），`scene:check` 现在 exit 0 ✅，但**无法从提交历史证明每笔 commit 时都跑过**。建议在 WU 提交模板里固化"改 assets ⇒ 同笔或紧接一笔包含 scene:check 输出"。

### L-5 `MAX_OBJECTS=64` 超限报错已测，但 500 僵尸性能仍无数据

报告已诚实标注"未做"（§1 表格 + §6 已知限制 4）。建议下一阶段把 `smoke:nav` 已有的"群体避让在预算内 0.655 ms/frame @ 300 agents"作为性能基线的起点，别从零开始。

---

## 五、C 组：数字逐项核对表

| # | 报告声称 | 实测 | 判定 |
|---|---|---|---|
| 1 | 领先 `origin/main` 15 笔 | **17**（`git rev-list --count origin/main..HEAD`） | ❌ |
| 2 | `origin/main...HEAD` → `0  15` | `0	17` | ❌ |
| 3 | `origin/feature/headless-runtime...HEAD` 全部已推送 | `0	0` | ✅ |
| 4 | `npm run test` 549 passed / 30 files | `Test Files 30 passed (30)` / `Tests 549 passed (549)` | ✅ |
| 5 | `npm run typecheck` exit 0 | exit 0 | ✅ |
| 6 | `npm run scene:check` exit 0 | exit 0（28 资产同步 + 12 tests） | ✅ |
| 7 | `npm run content:check` exit 0 | exit 0（tokens/roster/stats 均最新） | ✅ |
| 8 | `npm run verify:prefix` exit 0 | exit 0 | ✅ |
| 9 | `npm run editor:build` exit 0 / 384.58 kB | exit 0 / **384.66 kB** | ⚠ |
| 10 | `npm run editor:smoke` 127 PASS / 6 FAIL / 3 SKIP | **完全一致**（共 136），6 FAIL 明细逐条吻合 | ✅ |
| 11 | smoke CONSOLE 0 / EXCEPTION 0 | `CONSOLE ERRORS: 0` / `EXCEPTIONS: 0` | ✅ |
| 12 | 输入指纹 `7adf8152` / 13 实体 | 复现一致（`sim/floor1-t5`, seed 7, tick 60） | ✅ |
| 13 | 场景原文 43763 字节 | `wc -c assets/scenes/sim/floor1-t5.scene.json` = **43763** | ✅ |
| 14 | `git status -- assets` 干净 | 空 | ✅ |
| 15 | `session.test.ts` 共 19 条 | 19 | ✅ |
| 16 | 各文件行数增长 | 增量全对，绝对值 +1（见 L-1） | ⚠ |
| 17 | 他人 `agents.md` 未暂存未提交 | `git log origin/main..HEAD -- agents.md` 空；`git status` 仅 ` M agents.md` | ✅ |
| 18 | 无未推送提交 | `git log origin/feature/headless-runtime..HEAD` 空 | ✅ |
| 19 | `npm run smoke:nav` | **报告未列**，实测 13 PASS / exit 0 | ⚠ 漏报 |

---

## 六、D 组：验证范围纪律

| 纪律（docs/17 §8） | 本轮表现 | 判定 |
|---|---|---|
| 不跑 `npm run sim` 代替只读检查 | WU-6 两笔未跑；但 WU-1e 跑过并把 4 个快照 + `startIndex:1→7` 入库（见 M-7） | ⚠ 应修 |
| 改 assets 后必须跑 `scene:check` | 分支改了 assets；`scene:check` 现状 exit 0（时序不可回溯，见 L-4） | ✅ / 建议 |
| 默认执行受影响 owner 的定向测试，不以全量替代 | 549 全量跑了，但**漏了 `smoke:nav`**（§8-3 引用的那一处，见 M-3） | ⚠ 应修 |
| 真实 WebGPU 必须 headed Chrome + 硬件 GPU | 探针用真实 GPU（截图/像素断言在 `.workbuddy/tmp/*.png`） | ✅ 但脚本未入库 |
| harness 必须入库，结论与证据一起入库（项目自身铁律，docs/12:241） | **违反** —— 4 个 wu*-probe 全在 gitignore 目录 | ❌ 阻断（B-1/B-5/B-7 根因） |

---

## 七、八条业务证明总表

| # | docs/17 §8 条目 | 报告落点 | 库内可复跑证据 | 判定 |
|---|---|---|---|---|
| 1 | Node/浏览器同输入一致 | `runtime-parity.mjs` + `runTo` | 半侧入库，**比对逻辑不入库** | **阻断 B-1** |
| 2 | 房间触发与禁用语义 | `session.test.ts` 3 条 | ✅ 2 条硬（身份级）；第 3 条名不副实 | 应修 M-2 |
| 3 | 障碍参与移动约束 | "WU-1/WU-2 流场 + bakeClearance" | ✅ `session.test.ts:77,156`（真正覆盖）；引用落点错 + `smoke:nav` 未申报 | 应修 M-3 |
| 4 | Pause/Step 与帧率无关 | docs/18 §6.5 | ✅ 暂停/单步扎实；帧率只测 tick ±1 | 应修 M-4 |
| 5 | 选敌读身份/来源/目标/状态 **+ 画面对应** | WU-6 探针 | ❌ 画面对应在库内无测试，报告自承无性质锁 | **阻断 B-5** |
| 6 | 改 radius 撤销 + 保存重开保持 + 同种子重跑 | WU-5/6 探针 | ✅ 撤销/局部性/A-B 强（17+11 条）；**"重开保持"无** | 应修 M-5 |
| 7 | Stop 恢复作者状态 + 20 次启停账目 | docs/18 §6.5 | ❌ Stop 恢复零测试；20 次启停有（但只测引用账目，非分配/释放计数） | **阻断 B-7** |
| 8 | 动态实体不占静态槽位 | docs/18 §5.5 探针 | ✅ `session.test.ts:143,150` + `runtime-bridge.test.ts:115` 强 | 应修 M-6（落点写反） |

---

## 八、给团队的一句话

本阶段的**工程实现质量是高的** —— 库内 549 条测试里有大量"身份级而非数量级"的断言（`sourceNodeId` 追溯、`insideAnyObstacle` 逐实体核、改动路径恰好 1 条、改一处不牵动它处），docs/18 里"探针差点把用户的场景文件改了""固定调试端口接管上一轮 Chrome"两条踩坑记录的价值甚至高过业务断言本身。

**问题不在做得好不好，在于做完之后没把尺子留下。** 八条业务证明里有三条的判据只存在于一个半年后会被清掉的临时目录；报告又恰好把这三条都指向了"探针"，而把另外两条本来有硬测试支撑的（§8-6 撤销、§8-8 静态槽位）也一起指向了探针 —— 既高估了弱的，也低估了强的。

**最小修复集**（不改任何产品代码，只做"把证据搬进库" + 改报告）：
1. `wu6/wu5/wu4-probe.mjs` 中的**比对与断言逻辑**抽到 `tools/verify/`，补 `package.json` 入口（解 B-1、B-5、B-7 的"不可复现"半边）；
2. 补一条 `pointerRay` 投影往返的入库测试（解 B-5）；
3. 补 `play-controller` / `renderer` 作者态快照单测（解 B-7）；
4. 改报告：15→17、补 `smoke:nav`、§8-3/§8-6/§8-8 落点改指入库测试、披露 `startIndex=7` 与 sim 派生产物。
