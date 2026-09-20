# C 组评审报告 · 代码风险与遗留（只读评审）

- 分支：`feature/headless-runtime`，HEAD `ba5e093`（WU-6 2/2）
- 评审范围：`packages/runtime/src/**`、`apps/editor/src/{main.ts,renderer.ts,services/**}`、
  `packages/render/src/renderer-core.ts`、`packages/runtime/test/**`、`apps/editor/test/runtime-bridge.test.ts`、
  `tools/verify/editor-smoke.mjs`、`docs/18`、`docs/19`
- 只读声明：本次评审**未修改任何源文件、未提交、未动 assets、未碰 `.git`**；唯一写入即本报告。
- 复核手段：`Grep` 全仓（排除 `node_modules`/`dist`）+ 逐文件精读 + `node -e` 读取场景夹具核对冒烟脚本期望值。

---

## 结论速览

| 档 | 条数 | 编号 |
|---|---|---|
| 阻断 | **0** | — |
| 应修 | 8 | A1 – A8 |
| 建议 | 7 | B1 – B7 |

**总判定：通过**（无阻断项）。A1–A4 建议在下一 WU 开工前修掉，其余可入待办。

---

## 一、阻断（实际是 bug / 泄漏 / 错误路径报错成功 / 确定性被破坏）

### 未发现。

四个阻断判据逐条核过，最接近的三个候选及其**降级理由**：

1. **`PlaySession` / `RuntimeBridge` 的分配与释放是否配对** —— 结论是**配对**。
   - `PlaySession` 侧只有 CPU 对象：成功 `play()` 建会话（`play-session.ts:116-124`），
     `stop()` 置 `session = null`（`play-session.ts:160-164`），启动失败路径同样置 null 且
     `accumulator` 归零（`play-session.ts:108-114`），与注释「不创建半运行世界」一致，
     并有测试锁（`play-session.test.ts:142-152`）。
   - GPU 侧资源全在 `renderer-core`：`dynamicInstBuf` 与 `dynamicMeshes` 都在
     `destroy()` 里释放（`renderer-core.ts:1133-1134`），`destroy()` 幂等（`:1108`）；
     `drawDynamicBatches` 扩容时先 `destroy()` 旧 buffer（`:742`）。**未发现泄漏。**
   - `RuntimeBridge` 不持有任何 GPU 句柄，只缓存 CPU 侧 `vertices/indices`（`runtime-bridge.ts:245-247`
     注释明确「不 clear() slots 是为了复用网格」），`attach(null)` 即清空（`:152-156`）。
2. **错误路径是否「报错成功」** —— 结论是**没有假成功**。
   - 装载失败：`loadLevelRuntime` 只出 diagnostic，`hasError || playerStart===null` 时 `desc=null`
     （`loader.ts:307-310`）；`PlaySession.play()` 据此返回 `ok:false` 且不建世界（`play-session.ts:108-114`）。
   - 保存失败：`writeProjectFile` 返回 `!res.ok` 时只提示、**不 commit**，`dirty` 保持为真
     （`main.ts:969-973`）。未提交状态不会被吞。
   - 单步/暂停/恢复的非法调用一律静默忽略而非误报（`play-session.ts:127-152`）。
3. **确定性是否被破坏** —— 结论是**没有**。
   - `packages/runtime` 全目录 grep `Math.random|Date.now|performance.now|new Date|window.|document.|setTimeout`
     **零命中**。递归依赖 `packages/ai`、`packages/gameplay`、`packages/content` 同样零命中。
   - `CrowdSolver` 的 `jitter: 0.05`（`session.ts:192`）是确定性参数不是随机源（ai 包无 `Math.random`）。
   - 唯一的 `Math.random` 在 `packages/scene` 的 `create*` 工厂里（见 B6），**不在装载路径上**，
     已确认不影响 runtime 输出。

---

## 二、应修（结构性风险）

### A1 · `StepReport.spawned` / `rejectedRooms` 恒为 0 —— 接口契约在说谎
- `packages/runtime/src/session.ts:89-96` 声明并注释：
  「`spawned` 本步新生成的实体数」「`rejectedRooms` 本步因容量不足被整批拒绝的房间数」
  「**拒绝是显式的，不藏在返回值里**」。
- `packages/runtime/src/session.ts:258`：`return { tick: this.tickCount, spawned: 0, rejectedRooms: 0 };`
  —— `triggerRooms()`（`:313-335`）内部的 `continue`（`:329` 原子拒绝）从不回传计数。
- 全仓 grep `rejectedRooms`：**只有声明、赋值 0、`run()` 转发三处，无任何消费者、无测试**
  （`session.ts:90/95/258/262`）。
- 风险：这是 Agent 优先架构里 runtime 对外的**唯一推进回执**。Agent 读到 `rejectedRooms: 0`
  会得出「本步没有房间被拒」的结论，而实际上容量不足的房间是**被静默跳过**的 ——
  与注释宣称的「显式」正好相反。修法二选一：让 `triggerRooms()` 真正回传计数，或删掉这两个字段。

### A2 · A/B 探针完全没有覆盖「房间未进入的刷怪点」这一分支，而它正是 A/B 声称的核心价值
- `docs/18:382-383`（§7.4）声称 A/B 的意义是让作者「判断不出改动是真生效了，还是**被触发条件吞了**
  （房间还没进 → 一个都没刷）」。
- 代码路径确实支持：未触发点 `spawned=0` → `meanDist=0`、`minPairDist=-1`，
  改 radius 前后**两者全等** → `changed=false`（`spawn-ab.ts:107-133`、`:203-209`）。
- 但测试**只取已触发的刷怪点**：`spawn-ab.test.ts:17-21` 的 `triggeredSeeds()` 过滤 `spawned > 0`，
  全部 6 个用例（`:57,74,89,105,116,133`）都以它为夹具。
- 后果：这条「被吞了」的分支行为没有任何断言，将来改 `compareScatter` 的 `changed` 判定
  （比如把 `spawned` 从比较项里删掉）不会有任何测试变红。
  另外 UI 层面会出现「消息栏写已改 radius，A/B 区却标未变」的自相矛盾（`main.ts:912-917`
  无条件写 `已改 …`，A/B 行按 `changed` 打「未变」标签），该组合行为也无测试。

### A3 · `revertAll()` 没有产品入口，但 `docs/19` 把「整轮还原」列为可操作能力
- `packages/runtime/src/spawn-edit.ts:253-257` 定义 `revertAll()`。
- 全仓引用：仅 `spawn-edit.test.ts:129` 与 `spawn-ab.test.ts:121` 两条测试。
- 面板按钮只有 `撤销 / 保存 / 重跑 / 定位来源`（`spawn-panel.ts:104-109`），
  `__editor.spawn` 钩子也只暴露 `select/edit/undo/save/rerun/focusSource/pickFirstNpc`
  （`main.ts:1113-1133`），**没有 revertAll**。
- `docs/19:22`（§1 第 5 步）白纸黑字写「不满意就**撤销（或整轮还原）**」—— 用户与探针都到不了这个入口。
  要么补按钮/钩子，要么把这句话从报告里删掉。

### A4 · 保存前自检弱于文档所声称的强度
- `docs/19:186-189`（§6）声称：「改动路径集合必须**恰好等于**预期」。
- 实际实现 `main.ts:955-964`：
  ```ts
  const unexpected = diffs.filter((d) => !/\.components\[\d+\]\.(radius|count)$/.test(d.path));
  ```
  两处不足：
  1. **不限定组件 kind**：`Collider{sphere}.radius` / 任何组件上的 `count` 都匹配该正则，
     会被当成「合法的刷怪点改动」放行；
  2. **只做「剔除」不做「恰好」**：`diffs.length` 是 1 条还是 20 条都不校验，
     只要路径形状像就全部通过。
- 对比 runtime 侧的同名性质是有强断言的：`spawn-edit.test.ts:91-93` 断言 `toHaveLength(1)`。
  编辑器侧这条兜底反而更松 —— 它正是 `docs/18:369-370` 说的「将来有人加新命令也不会悄悄破坏
  这个性质」那道闸，当前形同虚设。

### A5 · `docs/19` §6「资源清理」的描述与代码不符（夸大）
- `docs/19:198`：**「Play 期每一次 GPU 资源分配都登记进 `PlaySession`，Stop 时逐个 `destroy()`。」**
- `PlaySession` 全类（`play-session.ts:41-188`）**没有任何资源登记表、`destroy()` 方法或 GPU 引用**；
  `stop()` 的实现就是三行置空（`:160-164`）。GPU 资源由 `renderer-core` 持有并在 `destroy()` 时释放，
  与 `PlaySession` 无关。
- 这句话会让读者（和下一个 Agent）误以为存在一套「Play 期显存账目」，实际不存在。
  应改写为「runtime 侧无 GPU 资源；GPU 侧由渲染核心持有，Stop 时批次置空、随 `destroy()` 释放」。

### A6 · 第二份相机基向量仍在（`panBy`），与已登记的 `screenRay` 是同型风险，但文档没记
- `main.ts:487-499` 手工推导相机基：
  `right = (cos yaw, 0, -sin yaw)`、`up = (-sin yaw·sin el, cos el, -cos yaw·sin el)`
  （注释在 `:484-486` 明说「相机基与 orbitEye/lookAt 同约定」）。
- 这与 `docs/18:500-507`（§8.2）承认并删掉的 `screenRay()` 是**同一类重复**：
  两套「yaw/elevation → 世界基向量」约定，一套在 `main.ts`，一套在 `renderer-core` 的
  `viewProj` 里。区别只是 `panBy` 用于平移方向、`screenRay` 用于射线，所以当时没一起清。
- `docs/18:557-558`（§8.6）只登记了「没有测试锁住射线必须与画面矩阵互逆」，
  **没有登记 panBy 这条同源风险**。实测影响是「平移方向随 yaw 漂移」而非拾取错位，属低危但同源。
  `screenRay` 确实已清理干净：全仓 grep 只剩 `main.ts:518` 的注释，无实现残留。

### A7 · FOV 45° 有三份硬编码，没有单一真源
- `packages/render/src/renderer-core.ts:869`（`m4.perspective(this.proj, (45*Math.PI)/180, …)`）
- `apps/editor/src/main.ts:469`（`const FOVY = (45 * Math.PI) / 180; // 与 renderer.render 的 perspective 保持一致`）
- `apps/editor/src/services/asset-preview.ts:465`（同款注释）
- `main.ts` 用它算平移手感（`:494`）与聚焦距离（`:834`），`asset-preview.ts:489` 同样。
  改 FOV 需要同时改三处且没有编译期约束 —— 典型的「注释代替真源」。建议从 `@aether/render`
  导出一个 `DEFAULT_FOVY` 常量。

### A8 · 三条「恒真 / 近似物」断言（假阳性）
- `apps/editor/test/runtime-bridge.test.ts:96`：`expect(ids.size).toBeGreaterThanOrEqual(1)`。
  注释写的是「floor-1 第一间房有多种 NPC → **至少两个尺寸**」，断言写的却是 `>= 1`；
  而 `ids` 来自非空 `batches`，`Set.size >= 1` 恒真。用例标题「不同体型分成不同批次」实际上
  没有验证「不同」。
- `apps/editor/test/runtime-bridge.test.ts:128`：`expect(batches.length).toBeLessThan(total / 10)`。
  这是 `docs/18:226`（§5.5）点名的证据项，但它是**数量级近似**（`total=121` 时允许 12 个批次），
  并没有断言「批次 == 体型种类数」。若将来退化成「每 10 个实体一份网格」它照样通过。
- `packages/runtime/test/session.test.ts:71`：`expect(v.every((e) => Number.isInteger(e.generation))).toBe(true)`。
  `generation` 来自 `Uint32Array`（`table.generation[i]`，`session.ts:223`），必然是整数，
  恒真；该用例真正有意义的是下一行 `Set(v.map(e=>e.id)).size === v.length`。

---

## 三、建议（可选改进）

### B1 · `__editor.*` 钩子的常驻代价：无门控 + 泄漏可变内部状态
- 装配点：`main.ts:384-389`（`camera` / `params` / `renderer`）、`main.ts:1139-1141`
  （`bridge` / `pointerRay` / `pickAtClient`）、`main.ts:1156-1193`（`runtime`）、
  `main.ts:2296-2311`（`assets` / `inspector` / `preview` / `spawnAsset` / `renderer`）。
- 全文件 grep `import.meta.env` / `DEV`：**零命中** —— 钩子在生产构建里也无条件装上。
- 泄漏的是**可变引用**而非快照：`hook.camera` 指向可写的 `camera` 对象（`main.ts:377`）、
  `hook.params` 是 `panel.params` 本体、`hook.renderer` 是渲染器单例、
  `hook.bridge` 是 `RuntimeBridge` 实例。经它们可直达 `renderer.destroy()`、
  `renderer.setDocument()`、`bridge.attach()`、`bridge.select()` 等破坏性方法。
- 误用风险排序：`hook.spawn.save()`（**直接写用户磁盘上的 `.scene.json`**）> `renderer.destroy()`
  > `bridge.attach()` > `camera/params` 改写。
- 建议收敛（按性价比）：
  1. 生产构建用 `import.meta.env.DEV || location.search.includes('debug')` 门控整段钩子装配；
  2. 把 `camera` / `params` / `renderer` / `bridge` 收成**只读快照函数**，与 `hook.spawn.state()`
     （`main.ts:1081-1112`，已经是纯数据镜像，是好样板）对齐；
  3. `hook.pointerRay` / `hook.pickAtClient` / `hook.runtime.runTo`（自建自停，不碰用户会话）
     是无副作用的取证口，可以保留。

### B2 · `hook.renderer` 被重复赋值
- `main.ts:388`（初始化对象里的 `renderer,` 简写）与 `main.ts:2311`（`hook.renderer = renderer;`）
  指向同一个键。属冗余，删后者即可。

### B3 · `advance()` 的丢弃策略与注释不完全一致（受控，但描述不精确）
- `play-session.ts:179-186`：while 循环最多跑 `maxCatchUpSteps` 步，
  收尾 `if (this.accumulator > step * this.maxCatchUpSteps) this.accumulator = 0;`。
- 实际效果：`<= step * maxCatchUpSteps`（默认 5 步 ≈ 0.167s）的**积压会被保留**，
  只有超过 5 步的部分才丢弃。注释（`:184`「超出部分**丢弃**」、`:169-171`「超出部分丢弃而不是攒着」）
  读起来像是全部丢弃。
- 行为本身是受控且有界的（积压恒 `<= 5` 步，不会无限增长），测试
  `play-session.test.ts:78-93` 也锁住了极端情形。但持续低帧率下会稳定处于
  「每帧补 5 步」的慢放状态 —— 这是设计取舍，建议把注释改成「保留最多 5 步积压，超出清零」。

### B4 · `clearDynamicMeshes()` 除 `destroy()` 外无人调用
- `packages/render/src/renderer-core.ts:721-727` 注释写「换关卡 / 代理体参数变了时调用」，
  但全仓唯一调用点是自己的 `destroy()`（`:1134`）。
- 换场景（`loadScene`）不会清这份按 `meshId` 缓存的胶囊网格；不同体型种类累积会让它缓慢增长
  （上界 = 历史出现过的 `(radius,height)` 组合数，量级很小，且 `destroy()` 会回收）。
  属「文档描述了不存在的调用路径」，不是泄漏。

### B5 · GPU / 渲染器初始化失败路径没有反向释放
- `main.ts:108-109`：`tryInitGpu` 返回 null 直接 `return`，未对可能已建好的 `GpuContext` 做清理
  （`initGpu` 内部是否部分分配未核，属防御缺口）。
- `main.ts:126-129`：`new LabRenderer(gpu, canvas)` 抛异常时只 `showFatal`，未调 `renderer.destroy()`
  —— 此时 core 的 buffer/texture 可能已建一部分。两条路径都直接进 fatal 页，实际影响极小，
  但「错误路径要配对」这条纪律值得补。

### B6 · `packages/scene` 的 `create*` 工厂含 `Math.random()`，建议加 grep 门禁
- `packages/scene/src/document.ts:557`、`project.ts:189`、`asset-meta.ts:75` 用
  `Math.random()` 生成 id。**不在装载路径上**，runtime 确定性当前未受影响（已 grep 确认）。
- 但 `@aether/runtime` 直接依赖 `@aether/scene`，这类工厂一旦被 `loadLevelRuntime` 或
  `migrate` 间接引入，确定性会静默失效。建议加一条门禁脚本：
  `packages/runtime/src` 与 `packages/{ai,gameplay,content,scene}/src` 的**装载可达路径**
  禁止出现 `Math.random|Date.now|performance.now`，比事后靠人 grep 可靠。

### B7 · 若干小的状态清理与可用性缺口
- `main.ts:877-892` `setSpawnScene()` 清了 `spawnAb` / `selectedSpawnNode`，但**没清 `spawnMsg`**，
  换场景后面板可能残留上一份场景的提示语。
- `spawn-panel.ts:202` `this.rerunBtn.disabled = false;` 恒为可用；无场景时点「重跑」
  会在 `main.ts:985` 静默返回（`spawnStore === null`），用户看不到任何反馈。
- `main.ts:536` 与 `pickAtClient` 未命中分支（`:535-536`）改了面板但没置 `hudDirty`。

### B8 · 文档漂移（不影响代码，但会让下一次评审走错路）
- `docs/18:193` 仍写 `RuntimeBridge` 的 API 是
  `start/stop/setPaused/stepOnce/reset/advance/batches/select/pickRay`，
  `docs/18:195` 仍写 `main.ts`「场景加载完成即 `bridge.start(doc)`；渲染循环 `bridge.advance(dt)`」——
  WU-4 之后实际是 `attach(session)` / `refresh()`（`runtime-bridge.ts:149,169`）。
- `docs/19:156-157` 写「启动场景早已换成 **floor-1**（32 物件）」；实际
  `aether.project.json:55` 的 `startIndex = 7` 指向
  `assets/scenes/sim/floor1-t5.scene.json`（**sim 派生产物**，35 节点；已用 `node -e` 核对），
  `docs/18:234-236` 的描述是准确的，§19 这句偏松。

---

## 四、对 7 个指定问题的直接回答

**1）重复实现 / 死代码有没有第二份？**
- 相机→射线：`screenRay()` 已彻底删除，仅剩 `main.ts:518` 注释；唯一实现 `renderer.pointerRay()`
  → `PickingService.pointerRay()`（`services/picking.ts:21`）→ `core.invViewProj`。**✅ 已收敛。**
- 相机矩阵：`panBy` 仍有一份手写基向量（A6）。
- 序列化：仅 `stableJson` / `sceneFingerprint`（`doc-diff.ts:81,102`）一份；未发现第二份。
- AABB：`pointInAabb`（`renderer.ts:305`）、`m4.rayAabb`（`core/math.ts:324`）、
  `aabbToXZ`（`loader.ts:130`）各司其职（点在内 / 射线求交 / XZ 降维），**不是重复实现**。
- 随机流：`makeRng` + `mixSeed`（`session.ts:35,50`）仅一份，且 WU-5 已把它从共享流改成
  逐刷怪点派生流；未发现第二份。
- 文档比较：`changedJsonPaths`（`doc-diff.ts:66`）仅一份。

**2）声称做到但入口走不到 / 假阳性断言？**
- 走不到：`revertAll()`（A3）、`clearDynamicMeshes()`（B4）。
- 接口说谎：`StepReport.spawned/rejectedRooms`（A1）。
- 假阳性/近似断言：3 条（A8）。
- 未覆盖的关键分支：A/B 的「房间未进入」分支（A2）。

**3）错误路径与资源释放？** —— 见「一、阻断」第 1、2 条，配对且无假成功；残留缺口见 B5。

**4）确定性？** —— grep 全绿（runtime + ai + gameplay + content 零命中）；固定步追赶策略有界
（B3 是描述精度问题不是正确性）。唯一隐患是 B6 的 `packages/scene` 工厂，当前不在装载路径。

**5）`__editor.*` 钩子的代价？** —— 见 B1：无 DEV 门控、泄漏可变引用（含可写盘与 `destroy()`）、
建议收敛为只读快照函数 + 构建期门控；B2 是顺带发现的重复赋值。

**6）已知遗留是否如实登记？** —— 大部分如实（`docs/18` §5.6/§6.7/§7.8/§8.6 与 `docs/19` §6
覆盖了射线无测试、面板无单测、Undo 缺失、钩子常驻、冒烟硬编码、500 僵尸未测）。
**文档没记但代码里明显缺的**：A1（StepReport 恒 0）、A2（A/B 未覆盖未触发分支）、
A3（revertAll 无入口）、A4（保存自检弱于声称）、A5（资源清理描述夸大）、A6（panBy 第二份基向量）、
A7（FOV 三份硬编码）、B4（clearDynamicMeshes 无调用方）。

**7）`editor:smoke` 的 6 条失败是否为「脚本硬编码 sandbox 期望 vs floor-1 启动场景」+ 
`autoFitCylinders` 读取路径不同步，而非被掩盖的真实回归？**

**结论：是，确认 6 条全部不是真实回归**，且第 6 条的真实根因比文档描述更具体：

**5 条 sandbox 期望（`tools/verify/editor-smoke.mjs`）**

| # | 行号 | 断言 | 硬编码的 sandbox 期望 | 实际启动场景 |
|---|---|---|---|---|
| 1 | `:366-370` | `src.objects === 13` | `default.scene.json` 15 节点 − 光/相机 = 13 | `floor1-t5` 35 节点 |
| 2 | `:376-380` | `地面 Ground` / `角色 Character` / `敌人 Enemy 6` 都在 | sandbox 的物件名 | 楼层场景无这些名字 |
| 3 | `:381-386` | `sceneObjs.length === 12 && 无 天空 Sky` | sandbox 13 物件 − 1 个 background | 物件数与 background 分层都不同 |
| 4 | `:387-397` | `角色=角色` / `敌人6=敌人` / `地面=环境` | sandbox 的 category | 同上 |
| 5 | `:398-405` | `地面.pickable===false && 立方体 Box.pickable===true` | sandbox 的物件与 pickable | floor1-t5 无「立方体 Box」 |

判断依据：
- 启动场景由 `aether.project.json:55` 的 `startIndex = 7` 决定 → `scenes[7]` =
  `assets/scenes/sim/floor1-t5.scene.json`（`aether.project.json:48-53`）。
- 用 `node -e` 直接核对夹具：`default.scene.json` **15 节点**，物件名恰为
  `地面 Ground / 角色 Character / 立方体 Box / 敌人 Enemy 6 / 天空 Sky`；`floor1-t5` **35 节点**。
  脚本里那 5 条期望值正是从 sandbox 这份文件逐字抄来的。
- 同一节 B2 里两条**非硬编码**的断言——「场景来源非 null（不是硬编码 fallback）」(`:360-365`)
  与「场景来源指向 `.scene.json`」(`:361-365`)——**都是 PASS**。也就是说场景装载链路本身是好的，
  失败的只是「把 sandbox 的物件清单当成了通用期望」。**没有掩盖回归。**

**1 条 `autoFitCylinders`（`editor-smoke.mjs:1433-1440`）**

- 断言：`sl.oRadii.top === sl.expR`（`expR = clamp(骨长×0.35, 0.04, 0.22)`，`:1365`）。
- 失败现象：`oRadii.top` 读到旧值 `0.091`，而同一批取回的
  `oRadiiImmediate`（`:1355`）/ `oRadiiPersist`（`:1360`）都是正确的 `0.0574924`。
- **真实根因（比文档描述更具体）**：`:1357` 的
  `const oRadii = b.wrappers.cylinders()[other].radii;` 取的是**活引用**，没有像
  `:1302 / :1308 / :1316 / :1323 / :1344` 那样用 `{...}` 拷贝。而脚本在返回前做「还原」
  （`:1369-1372`），其中 `:1372` 的 `b.wrappers.setRadius(other, s, otherOrig[s])`
  **把同一个对象就地写回了旧值**。等 Node 侧执行到 `:1434-1440` 的 `check` 时，
  `oRadii` 已经被自己的还原步骤改成 `0.091`；而 `oRadiiImmediate/Persist` 是**数字**，
  在还原前就定格了，所以是对的。
- 另有一处佐证：失败信息的文案写的是 `LeftArm=…`，而 `:1341` 的 `other` 实际是 `'RightArm'` ——
  说明这条断言还带着早期版本的残留，进一步证明是脚本自身问题。
- **结论：与产品代码无关，`autoFitCylinders` 功能本身是好的**（`oRadiiImmediate/Persist` 都等于公式值）。
  修法：`:1357` 改成 `{ ...b.wrappers.cylinders()[other].radii }`，并把 `:1439` 的 `LeftArm=` 改成 `RightArm=`。
  `docs/19:159-160` 定性为「断言读取路径与半径表不同步」方向正确，但没点出「活引用 + 还原步骤」这个根因。

---

## 五、总判定

**通过**，阻断项：**无**。

理由：四类阻断判据（bug 当遗留、资源泄漏、错误路径报错成功、确定性被破坏）逐条核过均未成立；
`editor:smoke` 的 6 条失败经夹具核对确认为门禁脚本自身问题，未掩盖真实回归；
`packages/runtime` 与三个下游包的确定性 grep 全绿。

建议的合入前/下一 WU 首日清单：**A1（API 契约说谎）、A2（A/B 关键分支无测试）、
A3（声称的能力无入口）、A4（保存自检弱于声称）** 这四条直接影响「文档声称 vs 实际保证」的可信度；
A5–A8 与 B1–B8 可入待办。
