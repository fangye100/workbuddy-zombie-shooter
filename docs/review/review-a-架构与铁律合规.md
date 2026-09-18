# A 组评审报告 · 架构与铁律合规

- 评审对象：分支 `feature/headless-runtime`（HEAD `ba5e093`，17 笔提交，WU-0 → WU-6）
- 评审范围：单一 owner / 依赖方向 / ADR 合规 / 容量与降级 / Play 资源生命周期 / 失败矩阵
- 评审性质：**只读**。未修改任何源文件、未提交、未改 assets、未碰 `.git`。
- 证据形式：静态代码核对 + `git diff --stat origin/main...HEAD`。
- ⚠️ **本轮未重跑门禁**（`npm run test` / `scene:check` / `editor:smoke` / 实机探针）。
  原因：本次沙箱 shell 缺 coreutils 且 `npx` 被安全策略拦截，无法执行。
  凡"实测数据"类结论一律按**开发方自述**对待，本报告不为其背书。

---

## 一、结论速览

| 档位 | 条数 | 编号 |
|---|---|---|
| 阻断 | 3 | A1 / A2 / A3 |
| 应修 | 5 | B1 – B5 |
| 建议 | 5 | C1 – C5 |

**总判定：不通过。阻断项编号：A1、A2、A3。**

其中 A1、A2 是本轮（WU-0 → WU-6）新引入；A3 是本轮之前既有，
但本轮最终报告（docs/19 §5「已知限制」）既未列出也未声明豁免。

---

## 二、阻断

### A1 · 容量超限被**静默丢弃**，零 diagnostic —— 违反 AGENTS.md §2.2 与 docs/17 §7

**证据 1：拒绝分支只有一句注释，没有任何上报通道。**

`packages/runtime/src/session.ts:323-334`
```ts
      const pending = this.desc.spawns.filter(
        (s) => s.roomNodeId === room.nodeId && s.enabled && s.trigger === 'room-enter',
      );
      const total = pending.reduce((a, s) => a + s.count, 0);
      if (total > this.table.capacity - this.table.aliveCount) {
        // 原子拒绝：宁可这一波不刷，也不能刷一半让调用方以为成功了
        continue;                       // ← 静默跳过，无 diagnostic、无计数、无返回值
      }
```

**证据 2：本该承载这个信号的两个字段是死的，永远返回 0。**

`packages/runtime/src/session.ts:89-96`
```ts
/** 一次推进的结果摘要。拒绝是显式的，不藏在返回值里 */
export interface StepReport {
  tick: number;
  /** 本步新生成的实体数 */
  spawned: number;
  /** 本步因容量不足被整批拒绝的房间数 */
  rejectedRooms: number;
}
```
`packages/runtime/src/session.ts:254-259`
```ts
  step(): StepReport {
    this.triggerRooms();
    this.moveNpcs();
    this.tickCount += 1;
    return { tick: this.tickCount, spawned: 0, rejectedRooms: 0 };  // ← 恒 0
  }
```
`spawned` / `rejectedRooms` 在全仓仅此一处赋值，`PlaySession.advance()`
（`play-session.ts:172-187`）丢弃 `step()` 的返回值，编辑器与 CLI 都拿不到。

**证据 3：测试只断言"没生成"，不构成"明确失败"。**

`packages/runtime/test/session.test.ts:120-124`
```ts
  it('容量不足 → 整批原子拒绝，不留半批实体', () => {
    const s = make({ capacity: 6 }); // 玩家占 1，房间 1 需要 12
    expect(s.countNpc()).toBe(0);
    expect(s.triggeredRooms()).toEqual([]);
  });
```

**为什么算阻断：**

1. **违反铁律**。`AGENTS.md:48`：
   「❌ 静默修数据：旧版本、缺字段、断链、超容量，一律产出 diagnostic 显式告知用户。」
   `AGENTS.md:56-59` 把 `MAX_OBJECTS=64` 定为「超了必须报错而不是静默丢弃」。
2. **违反 docs/17 §7 失败矩阵**：「生成量超过容量 → 实体状态 owner → **明确失败**，符合约定的原子性」。
   原子性做到了（不留半批），**明确失败完全没做**。
3. **会让结论不可信**。docs/18 §3「floor-1 实测基线」写着「房间 3 玩家未进入，正确地一只没刷」——
   在零 diagnostic 的前提下，"一只没刷"到底是"房间没触发"还是"容量不够被拒"，
   **从输出上无法区分**。这条基线以及 §8-2 的"禁用刷怪点不生成"断言都建立在同一类
   "以数量代替原因"的推理上。
4. **叠加死代码**：`StepReport` 的两个字段在接口里声称是信号，实际是常量 0 —— 典型
   「文档里写了、代码里没有」。

**最小修复方向**：`triggerRooms()` 把被拒的 (roomNodeId, 需要数, 剩余容量) 推入一个
`pendingRejections` 队列，`step()` 写入 `StepReport.rejectedRooms`；`RuntimeSession`
暴露 `drainDiagnostics()`，`PlaySession.play/advance` 汇总后由 HUD
（`main.ts:2408` 已有 diagnostics 渲染位）显示。

---

### A2 · docs/19 声称「GPU 资源登记进 PlaySession，Stop 时逐个 destroy()」——代码里不存在

**证据 1：报告原文。**

`docs/19-最终开发报告（headless-runtime）.md:198`
```
- Play 期每一次 GPU 资源分配都登记进 `PlaySession`，Stop 时逐个 `destroy()`。
```
`AGENTS.md:68` 的原文同样如此要求：
「Play 期的每一次 GPU 资源分配都必须登记进 PlaySession，Stop 时逐个 `destroy()`。」

**证据 2：`PlaySession` 全文没有任何登记 / 释放 API，作者自己也在注释里否掉了。**

`packages/runtime/src/play-session.ts:154-164`
```ts
  /**
   * 停止并释放。
   *
   * runtime 侧没有 GPU 资源，释放 = 断开引用让整棵世界可回收；GPU 侧的
   * 动态实例 buffer 由渲染核心持有，Bridge 不再产出批次即自然不画。
   */
  stop(): void {
    this.session = null;
    this._state = 'stopped';
    this.accumulator = 0;
  }
```
整个类（`play-session.ts:41-188`）的私有字段只有
`session / _state / accumulator / diag / errs / cycles` —— **没有资源登记表、没有
`register()`、没有 `dispose()`、没有 `destroy()`**。

**证据 3：GPU 资源实际归 `renderer-core`，且只在整核销毁时释放，Play Stop 从不触发。**

- 代理网格缓存：`packages/render/src/renderer-core.ts:354`
  `private readonly dynamicMeshes = new Map<string, { vbuf; ibuf; indexCount }>();`
  创建于 `renderer-core.ts:699-718`（`createBuffer` ×2 + `writeBuffer` ×2）。
- 实例 buffer：`renderer-core.ts:741-758`（`dynamicInstBuf` + `dynamicBindGroup`）。
- 释放点只有两处：`renderer-core.ts:721-727 clearDynamicMeshes()` 与
  `renderer-core.ts:1107-1134 destroy()`（`destroy()` 在 1134 行调用前者）。
- **全仓 grep `clearDynamicMeshes` 只有定义（721）与 `destroy()` 内调用（1134）两个命中**，
  没有任何 Play 生命周期调用点。`PlayController.stop()`
  （`apps/editor/src/services/play-controller.ts:130-144`）只做
  `restoreAuthorState` → `session.stop()` → `bridge.attach(null)`，**不碰 GPU**。

**为什么算阻断：**

1. **典型的"声称做到但实际没做"**，且是最终报告 §6「资源清理」小节的第一条。
2. **直接削弱 §8-7 的验收结论**。docs/19:199-200 与 docs/18 §6.5 反复用
   「20 次启停，受管理资源的分配/释放计数平衡」作为无泄漏证据；
   但所谓"账目"实际只有 `PlaySession.cycles++`（`play-session.ts:124`）与浏览器侧
   draw call 回落观察，**没有任何分配/释放配对计数**。
   `packages/runtime/test/play-session.test.ts:190-195` 自己也承认：
   「runtime 侧没有 GPU 资源，能测的是**引用账目**」—— 也就是说
   "分配/释放账目平衡"这句话在单测层面**没有被实现过**。
3. **违反 AGENTS.md §2.4** 明文（"必须登记进 PlaySession"）。
   AGENTS.md §2.4 还专门写了立这条规则的原因：「项目已在 `removeObject` 上踩过
   "只打墓碑不释放"的泄漏坑，不要再踩」。

**客观说明（不推翻阻断，但影响修复优先级）**：当前实现**实际不会泄漏** ——
`dynamicMeshes` 按 `meshId` 缓存复用，`dynamicInstBuf` 扩容时旧 buffer 被 destroy，
20 次启停 draw call 回到 55 与这一点吻合。也就是说**代码行为是可辩护的，
报告措辞是不可辩护的**。修复成本极低，二选一：
(a) 把 docs/19 §6 改成如实描述（"动态 GPU 资源按 meshId 缓存归 core，跨 Play 复用，
Stop 不销毁；Play 期无逐次分配"）并说明为何符合 §5.2「共享资产不因单个 Play 停止而被销毁」；
或 (b) 真的在 `PlaySession` 上加登记表并在 `stop()` 释放。**不能维持现状 + 现状措辞。**

---

### A3 · 多灯按 `priority` 降级未实现（无排序、无 top-1+top-1、无落选提示）

**证据 1：schema 侧的承诺。**

`packages/scene/src/document.ts:226-243`
```ts
 * 当前 packages/render 的 Lights uniform 只有 40 floats（10×vec4），
 * 硬件上只支持 **1 盏 directional（key）+ 1 盏 point**。
 * 场景文件**允许声明任意多盏**（数据层不设上限），运行时按 `priority` 降序取 top-N，
 * 落选者降级并在编辑器里标黄提示。等 Phase 2 clustered 落地后自动支持多灯。
 ...
  /** 降级排序权重，越大越优先占用 shader 槽位。默认 0 */
  priority: number;
```

**证据 2：唯一消费点既不排序、也不分类型、也不提示。**

`apps/editor/src/renderer.ts:875-884`
```ts
    // 场景灯光：第一个启用的 Light 组件（directional key）。场景 schema 目前只有
    // 颜色 + 强度，方向仍归编辑器的方位角/仰角滑块。
    let keyLight: SceneLoadResult['keyLight'] = null;
    for (const n of migrated.doc.nodes) {
      for (const c of n.components) {
        if (c.kind === 'Light' && c.enabled && keyLight === null) {
          keyLight = { color: c.color, intensity: c.intensity };
        }
      }
    }
```
`keyLight === null` 这个守卫的语义是「**取节点顺序第一个**」，与 `priority` 无关；
循环里没有 `.sort()`，没有按 `type` 分桶（没有第二盏 point 的落点），
落选灯不产生任何 warning / diagnostic / UI 标记。

**证据 3：`priority` 在全仓没有渲染侧消费者。**
grep `priority`（排除 `node_modules`）命中仅：
`document.ts:243`（定义）、`document.ts:584`（默认值）、
`packages/gameplay/src/character.ts:337/360/391`（动画层，与灯光无关）、
`packages/scene/test/document.test.ts:202/231/248`（测试夹具字面量）。
**没有任何一处读它做排序。**

**为什么算阻断：**

1. **违反铁律**。`AGENTS.md:63`：
   「多灯降级：场景可声明任意多盏灯，运行时按 `priority` 取 **top-1 + top-1**，
   落选者在编辑器里**标黄提示**。」三点全缺。
2. **铁律自己写了不做的后果**（`docs/14` §6.2 同源表述）：
   「不做显式降级提示的后果：用户放 5 盏灯只亮 1 盏，会当成 bug 排查一整天。」
3. **schema 注释与实现互相说谎**：`document.ts:228` 是数据字典真源
   （`AGENTS.md:28` 指定），它对下游承诺了不存在的运行时行为。

**责任归属说明**：此缺陷来自 `57e5a90`（本轮之前，已合入 main），**不是本轮引入**。
但本轮 docs/19 §5「已知限制」逐条列了 5 条限制，**没有一条提及灯光降级**，
也没有声明"本轮不修"。按 docs/17 §7 末段口径
（「只有影响真实产品数据、身份、持久化、运行/渲染或本轮验收语义的问题阻断相应 WU」），
它影响"运行/渲染"，故仍计入阻断。

---

## 三、应修

### B1 · 未支持组件零 diagnostic，"明确不支持"没有落地产物

`packages/runtime/src/loader.ts:194-294` 的 `graph.traverse` 只处理
`RoomVolume` / `SpawnPoint` / `Collider` / `NavZone` 四类，其余 kind
（`Script` / `Camera` / `MeshRenderer` / `Light` …）**静默跳过**，
`loader.ts:296-305` 的完整性检查也只覆盖 NavZone 与 RoomVolume。

docs/19:118-120 声称：
「它们被**完整保留在文档里**（保存不丢字段），运行时**不执行、也不近似执行** ——
符合 docs/17 §7「关键组件语义未支持 → 明确不支持；不静默执行近似规则」。」

"不近似执行"做到了；**"明确不支持"没有** —— 作者给节点挂一个
`behavior: 'spawn-wave'` 的 `Script`，装载后控制台与 HUD 都是一片寂静。
docs/17 §7 这一行要求的是**明确告知**，不是"默默正确"。

建议：loader 对未消费 kind 出一条 `W_COMPONENT_UNSUPPORTED`（带 NodeId + kind），
复用已有 `warn()` 闭包（`loader.ts:152-154`）与 HUD diagnostics 渲染
（`main.ts:2408`）。成本 <10 行。

### B2 · docs/19 §2 的"状态机 owner"写错，与 docs/18 自相矛盾

`docs/19-最终开发报告（headless-runtime）.md:49`
```
| 运行状态机（play/paused/stopped） | `PlayController`（**从 Bridge 里搬走**） | `apps/editor/src/services/play-controller.ts` |
```

代码里 `PlayController` 只做透传：
`apps/editor/src/services/play-controller.ts:44-46`
```ts
  get state(): PlayState {
    return this.session.state;   // session = PlaySession（runtime 包）
  }
```
真正持有 `_state` 的是 `packages/runtime/src/play-session.ts:43`，
且 `docs/18:250` 写的是「`play-session.ts` | **runtime 包（纯 CPU 可测）** | 状态机 …」，
与 docs/19 打架。

**为什么算应修而非阻断**：实现是对的（状态机确实在 runtime，比报告写得更好），
只是报告 owner 表指错了地方。但 docs/17 §9-2 要求报告交付"唯一状态来源"，
一张指错的表会让下一轮维护者按错误的 owner 改代码 —— 持续劣化，不阻断本轮验收。

### B3 · 编辑命令没有"预期版本"（docs/17 §5.4 契约缺口）

`docs/17:136`：「命令携带目标稳定身份和预期版本；过期对象或版本冲突明确失败。」

`packages/runtime/src/spawn-edit.ts:227-242` 的 `SpawnEditStore.set()` 只校验
`nodeId` 存在 + 值合法，**没有 revision / 版本参数，也没有冲突检测**。
`SpawnEdit` 接口（`spawn-edit.ts:44-49`）只有 `field / nodeId / from / to`。

当前单用户单 store、面板每次改动后整份重绘（`main.ts:852-853`），
所以现在不会爆；但契约一旦需要（第二入口、A/B 并发、外部文件被改）就无从拒绝。

### B4 · `LabRenderer` 内仍有硬编码 fallback 场景（ADR-010 / AGENTS.md §2.2）

`apps/editor/src/renderer.ts:427-433`
```
 * 硬编码 fallback 场景（S1 之前渲染器的唯一内容来源）。
 */
function buildDefaultSpecs(): ObjectSpec[] {
```
在 `renderer.ts:658`（构造期）与 `renderer.ts:866`（`applySpecs` 抛错后）被调用，
产出 12~13 个硬编码物件。违反 `AGENTS.md:44`
「❌ 在 `LabRenderer` / `main.ts` / 任何引擎代码里硬编码场景物件、灯光、相机。」

**为何只是应修**：本轮之前既有；它是启动兜底且 `getSceneSource() === null`
（`renderer.ts:899-904`）可明确辨识"当前不是场景文件"，`main.ts:429` 也会 warn。
但按铁律字面它仍是一处违规，且 `renderer.ts:602` 自己承认
「fallback 与场景文件当前都是 13 个物体、名字也一样」—— **这正是最危险的形态**：
兜底内容与真实场景无法从画面上区分。

### B5 · 引擎侧硬编码点光位置（ADR-010）

`packages/render/src/frame-uniforms.ts:186-190`
```ts
  const t = p.pointOrbit ? time * 0.8 : 0;
  dst[32] = Math.cos(t) * 2.6;
  dst[33] = 1.4;                       // ← 高度写死
  dst[34] = Math.sin(t) * 2.6;
```
点光位置不由场景 `Light` 组件驱动，而是引擎里写死的环绕轨道。
（本轮之前既有。）场景里 `LightComponent.range`（`document.ts:236-237`）只喂给了
`dst[35] = p.pointRange`，位置仍是硬编码。

---

## 四、建议

- **C1 · `clearDynamicMeshes()` 是事实死代码**（`renderer-core.ts:721`，
  除 `destroy()` 外零调用点）。要么接进 `PlayController.stop()`（配合 A2 的修复方向 b），
  要么删掉并同步改注释。**与 A2 同源，建议合并处理。**
- **C2 · `StepReport.spawned / rejectedRooms` 恒为 0**（`session.ts:258`）。
  与 A1 同源：要么实现，要么从接口里删掉 —— 留着会让"拒绝是显式的"这句注释持续说谎。
- **C3 · `SpawnEditStore.revertAll()` 无生产调用点**
  （`spawn-edit.ts:253-257`，仅 `spawn-edit.test.ts` 使用）。
- **C4 · 过期注释**。`packages/scene/src/migrate.ts:58`
  「目前为空 —— `SCHEMA_VERSION` 还是 1，没有历史要迁」，
  而 `document.ts:23` 已是 `SCHEMA_VERSION = 3`，`migrate.ts:263-266` 已注册
  `migrateV1ToV2` / `migrateV2ToV3`。新读者按这行注释会误判迁移链不存在。
- **C5 · 注释引用了错误的归属**。`packages/runtime/src/spawn-edit.ts:132`
  「且 loader 的 `E_SPAWN_COUNT` 也要求整数」—— `E_SPAWN_COUNT` 实际在
  `packages/scene/src/document.ts:771`（scene 校验器），不在 loader。

---

## 五、核对通过项（附证据，找不到问题就写"未发现"）

### 5.1 单一 owner —— 未发现第二份作者文档

- 作者文档只有一份：`main.ts:885` `spawnStore = new SpawnEditStore(doc)` →
  `main.ts:888` `renderer.setDocument(spawnStore.document)`。
  `renderer.setDocument`（`renderer.ts:913-915`）**只存引用不拷贝**，
  所以 `renderer.document === spawnStore.document` 恒成立。
- `PlayController.start()`（`play-controller.ts:77`）读 `renderer.getDocument()`，
  即同一份工作副本。运行时装载读的也是它。**未发现编辑器另存一份作者文档。**
- 状态机：`PlaySession._state`（`play-session.ts:43`）唯一；
  `RuntimeBridge` 不持有播放状态（`runtime-bridge.ts:122-128` 只有
  `session / slots / selected`，且 `runtime-bridge.ts:145` 明确"本模块不拥有运行状态"）。
- `spawn-panel.ts` 只持有 DOM 元素引用（`spawn-panel.ts:67-81`），无业务状态。
- `renderer.state.objects` 是渲染表示（派生量），符合 docs/17 §3.3 的三态划分，不算第二 owner。

### 5.2 依赖方向 —— 通过

`packages/runtime` 全部 import（grep `^import|from '|require\(`）：

| 文件 | 外部依赖 |
|---|---|
| `session.ts:26-31` | `@aether/gameplay`、`@aether/ai`、`@aether/content`、`@aether/scene`（type） |
| `loader.ts:27-36` | `@aether/scene`、`@aether/content` |
| `play-session.ts:1-4` | `./loader`、`./session`、`@aether/scene`（type） |
| `spawn-edit.ts:25-27` | `@aether/scene`、`./doc-diff` |
| `spawn-ab.ts:29-33` | `./loader`、`./session`、`@aether/scene`（type） |

额外 grep
`@aether/(render|editor)|apps/editor|window\.|navigator\.|performance\.now|Date\.now`
在 `packages/runtime` 下 **0 命中**。**依赖方向合规，DOM/GPU/真实时间全部解耦。**

### 5.3 ADR 合规

| ADR | 结论 | 证据 |
|---|---|---|
| ADR-001 GPU 资源归 core | ✅ | `renderer-core.ts:699-718` 建 vbuf/ibuf 并按 `meshId` 缓存；Bridge 侧只有 CPU `Float32Array`（`runtime-bridge.ts:114-120`），不碰 `GPUBuffer` |
| ADR-010 场景是唯一数据载体 | ⚠️ 部分 | 本轮新增代码全部从 `SceneDocument` 读（loader.ts）；**遗留两处硬编码见 B4 / B5** |
| ADR-013 JSON + SCHEMA_VERSION + 迁移链 | ✅ | `document.ts:23 SCHEMA_VERSION = 3`；`migrate.ts:116-121` 高于当前版本拒绝；`migrate.ts:263-266` 注册 v1→v2、v2→v3；`document.ts:556` 写入时带版本号 |
| ADR-014 Edit/Play 分离 | ✅ | `renderer.ts:1654-1672 snapshotAuthorState` / `1678-1702 restoreAuthorState`，**不从磁盘重载**；`main.ts:313-319`（层级面板删除）与 `main.ts:1251-1262`（Delete 键）两处 Play 中拦截增删 |
| ADR-017 脚本 = 行为注册表 | ✅ | `document.ts:370-376` `ScriptComponent` 仅 `behavior: string` + `params`，无代码字符串；注释 `document.ts:363-368` 写明理由 |

### 5.4 MAX_OBJECTS 超限 —— 明确报错，通过

`apps/editor/src/renderer.ts:722-727`
```ts
  private applySpecs(specs: readonly ObjectSpec[]): void {
    if (specs.length > MAX_OBJECTS) {
      throw new Error(
        `场景有 ${specs.length} 个物体，超过渲染器上限 ${MAX_OBJECTS}；大量同类实体请走 instancing`,
      );
    }
```
另两道：`renderer.ts:1502-1503`（`addObject` 满则 `console.warn` 返回 null）、
`main.ts:1457`（UI 提示「场景物体已达上限（64）」）。
**此处不静默丢弃**（与 A1 的运行时容量是两条独立路径，不要混为一谈）。

### 5.5 动态实体不占静态槽位 —— 真实独立 instancing 路径，通过

- 独立 storage buffer：`renderer-core.ts:743-747`
  `usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST`，与 `transformBuf`
  （`renderer-core.ts:464`，`MAX_OBJECTS * SLOT_BYTES`）**完全分离**。
- 真 instancing 绘制：`renderer-core.ts:777` `pass.drawIndexed(mesh.indexCount, n)`
  （`n` = 实例数），插在 pass 1 内、`pass.end()`（`renderer-core.ts:985`）之前
  （调用点 `renderer-core.ts:980-983`），复用同一 MRT + depth。
- 静态侧对比：`renderer-core.ts:971` `pass.drawIndexed(sm.indexCount, 1, ...)`（instanceCount 恒 1）。
- CPU 侧证据：`session.test.ts:143-148` 120 只 NPC 并存（> 64）；
  `apps/editor/test/runtime-bridge.test.ts:115-126`。
**结论：§8-8 的"渲染分离"确有实现，不是文档措辞。**

### 5.6 Play 资源生命周期 —— 见 A2（阻断）

已核对的**非 GPU** 部分是对的：
`PlayController.stop()` 顺序为「先恢复作者态 → 再断会话」
（`play-controller.ts:130-143`），避免"僵尸还在但关卡回到编辑态"的鬼影；
`PlaySession.stop()` 置空引用。问题只在 GPU 侧声明不实。

### 5.7 失败矩阵（docs/17 §7）逐项

| 触发条件 | 结论 | 证据 |
|---|---|---|
| 场景/引用/玩家起点非法 | ✅ | `loader.ts:170-186`（`E_PLAYER_START_UNSET` / `E_PLAYER_START_MISSING` 带 NodeId）、`loader.ts:307-310` 有 error 则 `desc: null`；`play-session.ts:108-113` 失败不建会话 |
| 关键组件语义未支持 | ⚠️ | 触发类型有 `W_SPAWN_TRIGGER_UNSUPPORTED`（`loader.ts:226-232`）；**组件 kind 层级缺 diagnostic → B1** |
| 已进入房间重复触发 | ✅ | `session.ts:320` `if (this.triggered.has(room.nodeId)) continue;` + `session.ts:333` |
| 生成量超过容量 | ❌ | 原子性 ✅，**明确失败 ❌ → A1** |
| 暂停后继续 / 浏览器卡顿 | ✅ | `play-session.ts:131/137` 暂停与恢复都清累加器；`play-session.ts:179-185` `maxCatchUpSteps` 上限并丢弃残留 |
| 旧会话实体 / 过期作者版本 | ⚠️ | 实体侧 ✅（`runtime-bridge.ts:192-198` 校验 generation）；作者侧 ❌ 无版本 → B3 |
| GPU 初始化 / 资源创建失败 | ⚠️ | `renderer.ts:861-868` 捕获 `applySpecs` 异常并回落兜底；**但"释放本次已分配资源"无实现 → A2** |
| 文件保存失败 | ✅ | `main.ts:968-973`：`res.ok` 为假 → 显示「保存失败」且**不调 `store.commit()`**，dirty 保留，未报成功 |

### 5.8 CLI 与浏览器共享入口 —— 通过（措辞与代码一致）

- Node：`tools/verify/runtime-parity.mjs:62-69`
  `new rt.PlaySession({ seed, fixedStep: 1/30 })` → `ps.play(doc)` → `s.step()`；
- 浏览器：`main.ts:1158-1192` 同一个 `PlaySession` + `RuntimeSession.step()`；
- 两侧共用同一 `sceneFingerprint`（`doc-diff.ts:102-110`）：
  `runtime-parity.mjs:81` 与 `main.ts:1176`；
- `sim-level.mjs:33/151/162` 已改走共享 `loadLevelRuntime` + `createSession`，
  **未发现第二份场景解释**。
- 只读性：`runtime-parity.mjs` 全文无 `writeFileSync` 以外的资源写入
  （唯一写出口是 `--out` 显式指定的取样文件），不写场景、不改 project.json。✅

### 5.9 大文件增长是否只是装配接线 —— 数字与报告一致

`git diff --stat origin/main...HEAD`（节选）：
```
 apps/editor/src/main.ts                     | 556 ++++++...-
 apps/editor/src/services/play-controller.ts | 156 ++++++++
 apps/editor/src/services/runtime-bridge.ts  | 306 ++++++++
 apps/editor/src/services/spawn-panel.ts     | 214 ++++++++
 packages/render/src/renderer-core.ts        | 206 ++++++++
 packages/render/src/shaders/dynamic.wgsl.ts | 210 ++++++++
 packages/runtime/src/{loader,session,play-session,spawn-edit,spawn-ab,doc-diff}.ts | 1600 行级新增
```
`main.ts` +556/-4（净 +552）与报告「1959 → 2507」吻合；
抽查 `main.ts` 的运行时相关段落（169-185 / 313-319 / 855-996 / 1026-1031 /
1140-1193 / 2378-2412 / 2489-2493）确为绑定、钩子、提示与装配，
**未发现玩法/规则逻辑**。「删掉 main.ts 运行时与规则仍完整」这句判断，
静态看是成立的。

---

## 六、给开发方的两点方法论提醒

1. **A1 与 A2 是同一类问题**：先写一个"看起来对"的类型或注释（`StepReport.rejectedRooms`、
   "登记进 PlaySession"），再用它去支撑报告结论，而没有让代码真正产出那个信号。
   docs/18 §8.5 自己总结过"验证脚本的被测对象身份本身是一条隐含断言"——
   **"报告里的每一句实现声明，也都应该有一条断言"**。建议把 docs/19 §2 / §6 的
   owner 表与资源清理声明各配一条可执行断言，进 CI。
2. **A3 的教训是"铁律项要有清单式回归"**。AGENTS.md §2 的硬约束
   （MAX_OBJECTS、多灯 priority、sidecar、不硬编码场景）目前没有任何一条自动化检查。
   建议把 §2 拆成 `npm run rules:check` 的若干条断言，否则每轮都靠人肉回忆。

---

## 七、总判定

**不通过。阻断项：A1（容量超限零 diagnostic）、A2（GPU 资源登记/释放声明不实）、
A3（多灯 priority 降级未实现）。**

三条都不是"本轮功能没做完"，而是**铁律/失败矩阵的明文档要求没有落地**。
其中 A1、A2 的修复量都很小（A1 约 30 行 + 1 条测试；A2 主要是改文档措辞或加 ~20 行登记表），
建议优先消掉 A2 的措辞问题（最低成本、最高风险收益比），再修 A1，A3 单独排期。

其余架构主干 —— 依赖方向、单一 owner、ADR-013/017、动态 instancing 路径、
MAX_OBJECTS 报错、保存失败语义、CLI/浏览器共用入口 —— **经静态核对均成立**，
本轮"责任收敛"的主线目标是达成的。
