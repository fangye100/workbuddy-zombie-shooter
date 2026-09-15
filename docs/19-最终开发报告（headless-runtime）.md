# 19 · 最终开发报告（Agent 优先 Game Editor · WU-0 → WU-6）

- 分支：`feature/headless-runtime`，领先 `origin/main` **15 笔提交**，落后 0（全部已推送）。
- 依据：`docs/17-Agent优先GameEditor架构与开发指导.md` §8 业务证明、§9 报告要求。
- 取舍过程：`docs/18-运行时责任收敛与取舍记录.md`（WU-0 → WU-6 逐节，含踩坑与仍未解决项）。

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
5. 不满意就**撤销**（或整轮还原）。
6. **重跑**（Stop→Play）按新文档重新装载，A/B 对比初始散布变化。
7. **Pause / Step / Stop**：暂停后 tick 与位置不变，Step 只推进一个 tick，
   Stop 精确恢复 Play 前的作者状态（相机、选中、场景内容都不被 Play 污染）。
8. 关掉页面重新打开 —— 保存过的值仍在（**保存重开保持**）。

### 仍暂缓的能力（明确未做，不是"看起来像做了"）

| 能力 | 状态 |
|---|---|
| `Script` 组件（行为注册表）的执行 | **未接线**。文档里的 `Script` 组件会被完整保留、但运行时**不执行**任何行为；实体行为目前只有内建的 idle / chase 两态 |
| 500 僵尸性能验收 | 未做。§8 第 8 条只证明"动态实体不占静态槽位"，不等于性能达标 |
| 通用 Undo/Redo | 未做。撤销只覆盖刷怪点被编辑的两个字段（radius / count） |
| 面板单测 | 未做。vitest 环境是 `node`，没有 jsdom；面板逻辑靠实机探针 |
| Play 中热替换运行描述 | 未做。"重跑"是 Stop→Play 的整轮重新装载 |
| 角色动画重定向 / Motion Match | 本阶段范围外（设计见 docs/16） |
| 手臂 IK | 设计上决定不做（与持枪瞄准打架），仅双腿走 IK；本阶段未实现 |

---

## 2. 主要生产 owner、唯一状态来源、责任变化

### 唯一状态来源（每类运行状态只有一个权威 owner）

| 状态 | 唯一 owner | 落点 |
|---|---|---|
| 场景文档（作者数据） | `SpawnEditStore`（`committed` + `working` + 撤销栈） | `packages/runtime/src/spawn-edit.ts` |
| 运行世界（实体表 / 生成 / 触发 / 移动） | `RuntimeSession` + `PlaySession` | `packages/runtime/src/session.ts` / `play-session.ts` |
| 运行状态机（play/paused/stopped） | `PlayController`（**从 Bridge 里搬走**） | `apps/editor/src/services/play-controller.ts` |
| 场景 → 运行视图的翻译 | `RuntimeBridge`（纯翻译层，不含状态机） | `apps/editor/src/services/runtime-bridge.ts` |
| 场景文档语义 / schema | `packages/scene/src/document.ts` | — |
| 相机矩阵 | `renderer-core`（`viewProj` / `invViewProj` / `eyeVec`） | `packages/render/src/renderer-core.ts` |

**责任变化的要点**：WU-3 之前编辑器"既跑世界又存状态"；现在编辑器只剩**装配 + IO + 控件**，
领域逻辑全部下沉到 `packages/runtime`（纯 CPU，不认 DOM / GPU / 真实时间）。
`RuntimeBridge` 刻意**不含状态机**（WU-4 把它搬去 `PlayController`），
因为它要做的是"翻译"，一旦持有状态就会变成第二个 owner。

### 已有大文件是否增长 / 增长是否只是装配接线

| 文件 | main | HEAD | 说明 |
|---|---|---|---|
| `apps/editor/src/main.ts` | 1959 | **2507** | +548，**全部是装配接线**：Play/Pause/Step/Stop 按钮绑定、Bridge 每帧注入、刷怪点面板挂载、验证钩子。领域逻辑一行都没有 |
| `apps/editor/src/renderer.ts` | 2138 | 2293 | +155，动态实例批次注入 + 作者状态快照 |
| `packages/render/src/renderer-core.ts` | 935 | 1141 | +206，动态实例渲染通道（storage 实例数组 + `@builtin(instance_index)`） |
| `apps/editor/src/services/runtime-bridge.ts` | — | 307 | 新建 |
| `apps/editor/src/services/play-controller.ts` | — | 157 | 新建 |
| `apps/editor/src/services/spawn-panel.ts` | — | 214 | 新建 |

`main.ts` 涨到 2507 行是事实，但涨的都是"把已有的东西接起来"；
**真正的判断标准是：把它删掉，运行时与规则仍然完整**（都在 `packages/runtime`）。
它是本阶段唯一一处需要盯的膨胀点，建议下一阶段把面板/钩子装配按 WU 拆成独立装配模块。

---

## 3. CLI 与浏览器共享的实际代码入口、输入契约、对比证据

**共享入口（关键）**：两侧都走 `PlaySession.play(doc)` → `RuntimeSession.step()`，
差别只在宿主。

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

```
[PASS] 🔴 两侧喂进 runtime 的是同一份文档（输入指纹相等） — web=7adf8152 node=7adf8152
[PASS] 🔴 逐实体身份 / 位置 / 目标 / 状态一致（不只比数量） — 13 个实体，最大坐标偏差 0.00e+0
[PASS] 容差内（≤ 1e-9）且报告实际偏差 — maxΔ=0.00e+0
[PASS] 换种子后仍一致（不是默认路径的巧合） — maxΔ=0.00e+0
[PASS] 不同种子确实产生不同结果（一致性不是恒等）
```

身份按 `id:generation` 配对，`characterId` / `kind` / `sourceNodeId` / `targetId` / `behavior`
逐字段全等，`x` / `z` / `yaw` 逐位相等。**不是"两边都刷了 13 只"，是同 13 只站在同一位。**

---

## 4. 真实场景语义支持表与 diagnostic

### 本轮真实消费的组件（4 种）

| 组件 | 语义 | 落点 |
|---|---|---|
| `RoomVolume` | 房间触发体（含 `enabled` 禁用语义） | 生成玩家的房间触发判断 |
| `SpawnPoint` | 刷怪点：`characterId` / `count` / `wave` / `trigger` / `delaySec` / `radius` / `prefab` / `enabled` | 生成批次 + 每点独立随机流 |
| `Collider` | 障碍（`isTrigger` 的不挡路） | 流场烘焙 `bakeClearance` + `CrowdSolver` 避障 |
| `NavZone` | 导航区（本轮取第一个） | 流场网格范围 |

**未消费**：`Script`（行为注册表）、以及任何将来新增的组件 kind。
它们被**完整保留在文档里**（保存不丢字段），运行时**不执行、也不近似执行** ——
符合 docs/17 §7「关键组件语义未支持 → 明确不支持；不静默执行近似规则」。

### diagnostic

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

**临时实验规则**（例：单 `NavZone` 限制、`wave` 字段当前不参与调度）
一律按 warning 显式告知，**不描述为产品行为**。

---

## 5. 实际运行的最小测试、场景门禁、真实 GPU 检查

### 定向测试

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run test` | **549 passed / 30 files**，exit 0（WU-5 时 546，本轮 +3 条 §8-2 断言） |
| `npm run scene:check` | 1 file passed，exit 0（本轮未改 `assets/**`） |
| `npm run content:check` | exit 0 |
| `npm run verify:prefix` | exit 0 |
| `npm run editor:build` | exit 0（384.58 kB） |
| `npm run editor:smoke` | **127 PASS / 6 FAIL / 3 SKIP**，CONSOLE 0 / EXCEPTION 0 |

`editor:smoke` 的 **6 条 FAIL 与本轮之前逐条一致、零新增**：

- 5 条是**冒烟脚本自身硬编码 sandbox 场景期望**（13 物件 / 15 节点 / 物件名 / `background` 分层 /
  `category` / `pickable`），而启动场景早已换成 floor-1（32 物件）→ 恒失败。
  这是**门禁脚本与场景演进脱节**，不是产品缺陷，已列入待办（断言应从实际加载的场景文件派生）。
- 1 条是 `autoFitCylinders` 断言读 `LeftArm` 拿到旧值 `0.091`，而钩子返回的
  `oRadiiImmediate/Persist` 都已是正确的 `0.0574924` —— **断言读取路径与半径表不同步**。

### 真实 GPU 检查（headed Chrome + 硬件 GPU）

`docs/17 §8` 的实机探针 `.workbuddy/tmp/wu6-probe.mjs`：**21 PASS / 0 FAIL**，
**连续三次一致**，CONSOLE 错误 / 异常 0。

| 证明 | 实测 |
|---|---|
| §8-1 同源同输入一致性 | 指纹相等 `7adf8152`；13 实体；`maxΔ=0.00e+0`；换种子仍 0 |
| §8-5 画面对应 | 点在 `(730.6, 174.2)px` → 选中 `#2·代1`；命中者投影回屏幕 `Δ=(0.00,0.00)px` |
| §8-6 保存重开保持 | radius `1.5→4.75`；改动路径**恰好 1 条**；重载后仍 `4.75`；`dirty=false undo=0`；场景**逐字节还原** |
| §8-2 房间触发与禁用 | `session.test.ts` 3 条：禁用 SpawnPoint 不生成（按身份核）、禁用 RoomVolume 不触发、重复跨边界不重复投放 |
| §8-3 障碍参与约束 | WU-1/WU-2 既有测试（流场 + `bakeClearance`） |
| §8-4 Pause/Step 与帧率无关 | docs/18 §6.5（WU-4 探针） |
| §8-7 Stop 恢复 + 20 次启停账目平衡 | docs/18 §6.5（WU-4 探针） |
| §8-8 动态实体不占静态槽位 | docs/18 §5.5（WU-3 探针，超 `MAX_OBJECTS` 的纯胶囊用例） |

**范围说明（为什么没有扩大验证）**：本轮不改 schema、不改 `assets/**`，所以没有重跑
内容生成与场景生成的全量流程；`scene:check` 与 `content:check` 仍按纪律执行。
**未按 `npm run sim` 走完整模拟导出** —— docs/17 §8 明确禁止用它代替只读检查（它会写场景和 project.json）。

---

## 6. 作者数据前后差分、资源清理、已知限制

### 作者数据前后差分

- **保存前自检**（写盘之前）：改动路径集合必须**恰好等于**预期。
  实测 `["nodes[7].components[0].radius"]`，一条不多一条不少。
- **未消费组件与无关字段原样保留**：节点数、场景名、`Script` / `userData` 等未被触碰的字段
  在写回后逐字段不变。
- **收尾还原**：验证用的写盘在 `finally` 里全部还原，场景文件与原文**逐字节一致**（43763 字节），
  `git status -- assets` 干净。
- **画布无关状态**：编辑器相机、面板折叠、资产浏览器目录等 UI 状态走 localStorage，不入场景文件。

### 资源清理

- Play 期每一次 GPU 资源分配都登记进 `PlaySession`，Stop 时逐个 `destroy()`。
- WU-4 实测：连续 20 次 Play/Stop，受管理资源的分配/释放计数平衡，监听与循环不累积
  （docs/18 §6.5）。**只做趋势观察，不宣称"无泄漏"** —— 一次显存读数不足以证明。
- 动态实体走独立 instancing 通道，Stop 时批次清空，不残留静态槽位。

### 已知限制

1. `screenRay()` 已删（收敛到 `renderer.pointerRay()` 唯一实现），
   但**没有测试锁住"射线必须与画面矩阵互逆"**这条性质。
   诚实备注：我复刻旧公式回探针做对照，**它当时也能命中** ——
   所以这次删除是**消除重复实现**，不是修错位 bug。
2. 验证钩子（`__editor.runtime.*`、`__editor.spawn.*`）是产品代码的一部分，
   属于"为可验证性付出的常驻成本"。
3. 冒烟脚本的场景期望仍是硬编码（见 §5），会让真实回归淹没在噪声里。
4. `MAX_OBJECTS = 64` 超限会明确报错而非静默丢弃；但 500 僵尸的性能上限仍未测。
5. 面板无单测（缺 jsdom），逻辑靠 runtime 侧覆盖 + 实机探针。

---

## 7. 提交、逐笔推送、保留的他人工作区改动

- 分支 `feature/headless-runtime`，所有提交**逐笔 push 到 `origin`**，本地不留未推送提交
  （`git rev-list --left-right --count origin/main...HEAD` → `0  15`，落后 0）。
- 提交时**只 `git add` 本会话改动的文件**，不使用 `git add -A`。
- **保留他人工作区改动**：`agents.md` 由另一并行会话修改、`agents.md.bak-webdebug-20260911`
  是其备份 —— 本轮**未暂存、未修改、未删除**。
- 本轮新增/修改文件清单（全部属于本会话业务范围）：

| 文件 | 动作 |
|---|---|
| `packages/runtime/src/doc-diff.ts` | 新增 `stableJson()` / `sceneFingerprint()` |
| `packages/runtime/test/session.test.ts` | 新增 §8-2 三条断言（共 19 条） |
| `tools/verify/runtime-parity.mjs` | 新建（只读 Node 取样 CLI） |
| `apps/editor/src/main.ts` | §8-1 取证钩子、§8-5 拾取入口统一（删 `screenRay`） |
| `docs/18-…md` | 新增 §8 WU-6 落地记录 |
| `docs/19-…md` | 本报告 |

---

## 交付判断

以 docs/17 §9 的口径复述：**"人能定位问题、局部修改、保存、重跑并检查结果"** ——

- **定位**：点画面里的僵尸 → 面板直接告诉你是哪个刷怪点、什么角色、追谁、什么状态；
  跨宿主不一致时，输入指纹先告诉你"是输入不同还是逻辑不同"。
- **修改**：面板改散布半径，改前自检、改后可撤销。
- **保存**：写盘前逐路径核对改动集合，未消费组件不丢；重开页面值仍在。
- **重跑并检查**：停→跑按新文档重新装载，同种子重跑可 A/B 对比初始散布。

这条闭环是通的，且每一环都有实测证据。**没有用文件数、工具数、按钮数或测试总数替代它。**
