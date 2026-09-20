# 第三轮独立评审报告（review-a3）

- 项目：`game-design-zombie`，分支 `feature/headless-runtime`，HEAD = `25d6d64`（评审整改 5）
- 评审方式：只读。未改任何源文件 / assets / `.git`；唯一写入是本报告。
- 日期：2026-09-16

---

## 0. 门禁重跑结果（本轮实测）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | ✅ exit 0 | `tsc -p tsconfig.check.json` 无输出 |
| `npm run test` | ✅ **569 passed / 32 files**，与预期完全一致 | vitest 汇总行 |
| `npm run editor:build` | ✅ 通过 | vite build，89 modules，`built in 1.13s` |
| `runtime-parity.mjs --compare` 区分力抽测 | ✅ 同种子 4 PASS / exit 0；异种子 1 FAIL / exit 1 | 本轮在 `.workbuddy/tmp` 自取样自比对（临时文件已清理） |
| `git status -- assets/` | ✅ 干净 | 空输出 |

editor-parity 实机 harness 本轮**未复跑**：它需要已运行的 dev server + Chrome，且 §8-6 会真写场景文件（虽 finally 还原），超出本轮「只读」授权。其判定基于静态审查 + 第二轮留下的 3×「20 PASS / 0 FAIL」记录，见 B5。

---

## 1. 八条逐项判定

### A1 容量超限零 diagnostic —— **闭合**

- 产出侧：`packages/runtime/src/session.ts:288-300` 每步把 `rejections` 真值写进 `StepReport`（`spawned` / `rejectedRooms` / `rejections` 明细），`:289` 逐房间 `pushDiag('W_SPAWN_CAPACITY', …)`，同 (code, node) 去重（`:316-323`）。
- 消费侧：`apps/editor/src/main.ts:189-199` `drainRuntimeDiagnostics()` 每帧取走并显示（HUD + console.warn），不再是「信号零消费者」。
- 断言有区分力：`packages/runtime/test/session.test.ts:160-166`（rejections 精确等于 `[{roomNodeId:'nd_f1r0', needed:12, free:5}]`）、`:168-176`（diagnostic 恰好 1 条、code/nodeId/文案都对）、`:178-183`（drain 后清空）、`:185-206`（容量充足时 spawned 为真值且 diagnostics 为空 —— 双向夹住，不是只验拒绝路径）。
- 残留问题单独立项，见「应修 S1」（不影响 A1 信号链本身闭合）。

### A2 资源登记表缺失 —— **闭合**

- 登记表：`packages/runtime/src/play-session.ts:109-121` `registerResource()` / `ledger`（registered/disposed/pending 可查询）；`stop()` `:217-231` 逐个释放、单个失败不挡其余、账目照记。
- 宿主登记：`apps/editor/src/services/play-controller.ts:102` Bridge 批次以 `bridge-batches` 挂号。
- 断言：`apps/editor/test/play-controller.test.ts:130-144` **20 次启停**，每轮 `pending===0` 且 `registered===disposed`，终值 20/20 —— 判据是账目不是「看着没泄漏」，有区分力；`:146-157` 释放回调抛错分支也测了。

### A3 多灯 priority 未实现 —— **闭合**

- 实现：`apps/editor/src/renderer.ts:456-489` `pickSceneLights()` 纯函数 —— priority 降序取 top-1 directional + top-1 point，落选者逐盏进 `warnings` 且点名占用者；稳定排序保证同输入同结果；`enabled:false` 不参与竞争。
- 消费：`:961-975` warnings 进 `SceneLoadResult.warnings` → boot 时 `main.ts:452` console.warn + `:1862` 面板展示。落选提示有消费者。
- 测试：`apps/editor/test/scene-lights.test.ts` 8 条，用构造数据把降级分支全部跑出来（最高 priority 胜出 / top-1+top-1 / 每盏落选都有提示且点名占用者 / 同 priority 稳定 / 禁用不竞争 / 无灯全 null）。有区分力。

### B1 比对逻辑未入库 —— **闭合**

- `tools/verify/runtime-parity.mjs` 在库，`--compare` 模式（`:140-184`）先比 docFingerprint（输入不同直接拒谈输出），再比 sceneId/schema/tick，最后逐实体 diff，退出码区分一致/不一致。
- 本轮实测区分力：同种子两取样比对 **4 PASS / exit 0**；异种子比对 **逐实体不一致 / exit 1**。不是恒真脚本。
- editor-parity 只负责取浏览器侧快照，比对唯一出处在本文件（`tools/verify/editor-parity.mjs:15-16` 注释明写），职责不重复。

### B5 画面对应无证据 —— **闭合**（注明验证方式）

- 探针已转正入库：`tools/verify/editor-parity.mjs` §8-5（`:244-333`）。
- 负载抖动整改属实：实体出现改为轮询（`:249-259`，30s 上限）；暂停后等 `frameCounter` 真的递增（`:267-272`）；投影落入画布判定带 20 次重试（`:313-319`）。三处都不再赌固定 sleep。
- 断言区分力：真实点击入口回环（`pickAtClient`），命中身份（id+generation）与投影回屏幕 ≤2px 双重判定；另保留「旧公式能否证伪」的如实披露（文档 §9.2 B5 行）。
- 限制声明：本轮未复跑实机（授权边界），依据是静态审查 + 第二轮 3×「20 PASS / 0 FAIL」记录。若后续有人复跑出抖动，应重开本条。

### B7 Stop 恢复零测试 —— **闭合**

- `apps/editor/test/play-controller.test.ts`：`:85-95` Play 期间改场景 → Stop 逐字段恢复（不比磁盘）；`:97-114` 装载失败 / 场景未加载不动作者状态；`:116-126` mismatched 告警分支（本轮新增，spy 断言 `console.warn` 含「不一致」）；`:160-176` 状态机透传。7 条全过。

### 回归 1：typecheck 红 —— **闭合**

- 本轮实测 `npm run typecheck` exit 0。`session.test.ts:191` 的 `NodeId | null` 类型错已不复存在。

### 回归 2：保存自检误拒合法保存 —— **闭合**

重点复验结论（`apps/editor/src/main.ts:985-1037`）：

- **合法多节点编辑不会被拒**：判据是「全部 diff 路径 ∈ 当前文档所有 SpawnPoint 组件的 radius/count 集合」（`:1001-1011`），不限条数。改两个点的 radius → 2 条 diff 都在集合内 → 放行。
- **不合法路径不会被放行**：`Collider{sphere}.radius` 所在组件 kind ≠ SpawnPoint，其索引不进 `expected` 集合 → 落进 `unexpected` → 拒存（`:1012-1020`）。同节点上 SpawnPoint 与 Collider 并存时也只放行 SpawnPoint 那个下标。新增节点 / 删除组件产生的 diff 路径同样不在集合内 → 保守拒绝，方向正确。
- **`diffs.length === 0`**：提示「没有改动需要保存」并直接返回，不写盘（`:994-998`）。撤销回原点再保存也走这条路，行为合理（warn 而非 error，无误伤）。
- **回归守卫有牙**：`tools/verify/editor-parity.mjs:359-389` 刻意连改两个刷怪点再保存，断言「已保存」且不含「拒绝保存」；`:400-406` 再断言第二个点的改动真落了盘。入库场景 floor-1 有 **6 个** SpawnPoint（`assets/scenes/act1/floor-1.scene.json`），`secondId` 必然取到，守卫不会退化成「单点场景跳过」。
- 路径格式一致性已核对：`doc-diff.ts` 产出 `nodes[3].components[1].radius` 与 `main.ts:1007-1008` 构造的集合元素格式相同。

---

## 2. 新发现问题

### 阻断

无。

### 应修

**S1. 诊断去重集合跨 Play 会话不清空：第二次 Play 同类告警被静默吞掉**
`apps/editor/src/main.ts:188`
`shownRuntimeDiags` 是 boot 闭包里的 app 生命周期集合，Play → Stop → 再 Play 时不重置。第一次 Play 某房间容量被拒会提示；Stop 后作者改了参数再 Play，同一房间再次超容时，`W_SPAWN_CAPACITY|nd_xxx` 已在集合里 → **UI 一片寂静**，正是 A1 整改要消灭的那个症状在「第二次 Play」上复活。复现路径：Play（容量不足，告警出现）→ Stop → 再 Play（容量仍不足，告警不再出现）。
修法二选一：在 `stopPlay()` / `playCtl.start()` 成功处清空该集合；或改用 runtime 侧已备好的 `drainDiagnostics()`（`packages/runtime/src/session.ts:309-314`，取走即清空、天然每会话重新计）替代现在的累计式 getter，那样 `shownRuntimeDiags` 整个可以删掉。

### 建议

**S2. `drainRuntimeDiagnostics` 名不副实，且每帧全量迭代累计数组**
`apps/editor/src/main.ts:189-199` + `packages/runtime/src/play-session.ts:124-126`
名字叫 drain，实际走的是 `diagnostics()` 累计视图（从不清空），每帧 O(N) 全量迭代 + 编辑器侧再叠一层去重 —— 与 runtime 侧 `pushDiag` 的去重是双保险而非单职责。当前 N 被 (code,node) 去重限制在极小范围，**无实际性能问题**；但 `drainDiagnostics()` 这个为它准备的消费者接口（`session.test.ts:178` 注释明写「宿主每帧取一次」）在编辑器里无人调用。随 S1 一并改掉即可，不必单开工作。

**S3. `stop()` 里 `bridge.attach(null)` 双重调用**
`apps/editor/src/services/play-controller.ts:155` 与 `:102`（资源释放回调）各调一次。已核实幂等：`runtime-bridge.ts:149-156` 第二次调用时 slots 已空、`session` 重复置 null，无副作用。属无害冗余，留着反而让人怀疑两次调用语义不同，建议删一处并留注释。

**S4. `PlayController.start()` 自身不校验状态**
`apps/editor/src/services/play-controller.ts:86`
连调两次 `start()`（绕过 `main.ts:169` 的按钮守卫）会重复登记 `bridge-batches` 并直接替换旧会话。已核实无泄漏（旧会话纯 CPU 可被 GC；Stop 时两份登记都释放且 attach(null) 幂等，账目仍平），但「start 只能在 stopped 调用」目前靠调用方自觉。建议在 `start()` 开头加 `if (this.session.state !== 'stopped') return false;`，与类注释「状态机在 PlaySession」的口径一致。

---

## 3. 总判定：**通过**

- 六条首轮阻断全部闭合，且每条都有「产出 + 消费 + 有区分力的断言」三段链；
- 两条整改回归闭合，typecheck/test/build 三门禁本轮实测全绿（569/32）；
- 保存自检重点复验：多节点合法编辑放行、Collider 路径拒存、零改动不写盘，三个方向都对；
- 新发现 0 阻断 / 1 应修 / 3 建议。S1 是真实的功能缺陷但触发面窄（仅「第二次 Play 同一告警」），不构成本轮不通过的理由，建议排进下一轮整改。
