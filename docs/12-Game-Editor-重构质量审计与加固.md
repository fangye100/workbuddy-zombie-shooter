# 12 · Game Editor 重构质量审计与加固

> 角色：软件架构师（按 `docs/10` 架构定案 + `docs/11` 结构蓝图，对「Game Editor Refactory」session 的产出做**证据级**复核，并就地修复）
> 审计时间：2026-09-03｜审计对象：`0ca20fe`(0b.2) → `39675b8`(0b.8D) 共 19 个提交
> 基准：`docs/10` 的 D1–D5 / ADR-001–004，`docs/11` 的 ADR-005–007 与 §9 迁移计划

---

## 0. 一句话结论

**重构成果是真的，但被高估了；验证结论是真的，但不可复现。**

- ✅ **必须承认的成绩**：19 个提交把 ~13K 行自带渲染器的单体 app，拆成了「包体真源 7,760 行 + 编辑器消费者 8,354 行」，ADR-001 的硬判据（`packages/*` 内零编辑器类型）成立，`apps/lab` 已物理消亡。这条路走对了。
- ⚠️ **被高估的部分**：`docs/11 §13.6` 称 `LabRenderer`「退化为门面」——实测 94 个方法里只有 31 个是 ≤2 行委托，**29 个方法仍含 10 行以上实质逻辑（1,330 行 / 1,945 行 = 68%）**；GPU 资源创建调用编辑器与引擎是 **20 : 24**，接近一半的 GPU 资源仍由编辑器侧创建。这不是门面，是"半拆的 god class"。
- 🔴 **最严重的问题**：声称的「headless WebGPU 冒烟 30/30 PASS」**脚本从未入库、截图也不存在**，结论不可复现。docs/10 §5 自己列为风险的"线上资料库未入版本控制"是同一类病——**验证资产不入版本控制，等于没验证**。

本轮已修复 12 项，三道门禁 + 新增第四道冒烟门禁全绿（见 §5）。

---

## 1. 审计方法（先说怎么查的，免得结论像拍脑袋）

不读提交信息（提交信息是当事人写的，会自证），全部**实测**：

| 手段 | 命令 / 判据 |
|---|---|
| 依赖方向 | `grep -rn "apps/editor\|@aether/editor" packages/` 必须零命中 |
| ADR-001 硬判据 | `grep -rniE "LabParams\|LabRenderer\|selectedIndex\|hovered" packages/` |
| ADR-005 路径 | `grep -rnE "from '\.\./\.\./" packages/` 必须零命中 |
| god class 度量 | 解析 `renderer.ts` 的 AST 缩进层级，统计每个方法体行数分布 |
| GPU 代码分布 | 统计 `createRenderPipeline\|createBindGroupLayout\|createBuffer\|createTexture\|device.create` 出现次数 |
| 测试归属 | 看 `vitest run` 列出的测试文件路径在哪一层 |
| 运行时验证 | 真实 Chrome + SwiftShader + CDP 驱动 services（见 §4） |

---

## 2. 审计发现（按严重度）

### 🔴 P0-1 · 验证结论不可复现 —— 最严重

`docs/11 §13.6` 写着：

> headless WebGPU 冒烟（真实 Chrome 152 + SwiftShader + CDP，`webgpu-headless-validate` 流程）……**30/30 PASS，CONSOLE(0)，EXCEPTIONS(0)**。截图 `editor-0b8-smoke.png`。

实测：

```
grep -rln "SelectionService\|AnimationService\|0b8" tools/verify/ .workbuddy/tmp/*.mjs  → 零命中
find . -name "editor-0b8-smoke*"                                                        → 未找到
```

**脚本跑在临时目录、从未入库，截图不存在。** 这意味着：

1. 任何人都无法复跑这条"30/30"，无法确认它当时真的跑过、跑的是哪个版本；
2. 后续任何人改动渲染代码，都拿不到这条基线做回归对比；
3. `docs/10` D4 明确要求"记录 headless 配方到 `tools/verify/`"——**这条验收项当时并未满足，却被记成了已完成**。

> 这不是能力问题，是工程纪律问题：**结论必须跟着证据一起入库**。

**已修复**：新建 `tools/verify/editor-smoke.mjs`（可复跑，35 断言，见 §4），并 `npm run editor:smoke` 固化入口。

---

### 🔴 P0-2 · 引擎层零测试，测试全住在编辑器里

`vitest.config.ts` 的 include 写着 `packages/**/*.test.ts`，但**一个都没有**：

```
修复前：7 个测试文件（97 例）全部位于 apps/editor/src/
  math / geometry / gltf / skin / materials / binding / gizmo
```

被这些测试覆盖的 `math / geometry / gltf / skin / materials / binding` **全是 `packages/*` 的代码**。后果：

- `docs/10` D4 要的是"vitest 覆盖引擎包"，实际是"引擎的测试住在 app 里"——**分层图上凭空多出一条 app → packages 的测试依赖**；
- `packages/*` 想独立发布/独立 CI 做不到（测试不在自己家）；
- 更糟的是 `apps/editor/src/gpu/` 这个目录：0b.3 把 geometry/gltf 搬走后，只剩 3 个测试文件和一个夹具 `testGlb.ts` 撑着，**目录名还在暗示编辑器有一层 gpu 实现**。

**已修复**：测试按被测代码归位。

| 迁出 | 迁入 | 例数 |
|---|---|---|
| `apps/editor/src/gpu/math.test.ts` | `packages/core/test/math.test.ts` | 16 |
| `apps/editor/src/gpu/geometry.test.ts` | `packages/scene/test/geometry.test.ts` | 5 |
| `apps/editor/src/gpu/gltf.test.ts` | `packages/scene/test/gltf.test.ts` | 16 |
| `apps/editor/src/gpu/testGlb.ts`（夹具） | `packages/scene/test/testGlb.ts` | — |
| `apps/editor/src/skin.test.ts` | `packages/render/test/skin.test.ts` | 9 |
| `apps/editor/src/binding.test.ts` | `packages/render/test/binding.test.ts` | 19 |
| `apps/editor/src/materials.test.ts` | `apps/editor/test/materials.test.ts` | 23 |
| `apps/editor/src/gizmo.test.ts` | `apps/editor/test/gizmo.test.ts` | 9 |

`apps/editor/src/gpu/` 目录已删除。编辑器真正自己的测试（材质库 / gizmo 交互数学 / 内置模型）移入 `apps/editor/test/`。

---

### 🟠 P1-1 · `binding.ts` 上提漏做（docs/11 §5 明确列了，没执行）

`docs/11 §5` 模块映射表写的是 `binding.ts (245) → packages/render/src/materials`，实际它一直在 `apps/editor/src/binding.ts`，且**没有 ADR 记录这个偏差**（对比：0b.1 的 `MaterialState` 命名偏差、0a 的 workspace 偏差都在 §13 里记了）。

文件内容其实是引擎域纯逻辑（GLB 换模型时的材质绑定继承：nodeId 精确匹配 → 反向路径匹配，19 例单测），依赖只有一个 `MaterialState`（**已经在 `packages/render`**）——**没有任何理由留在编辑器**。

**已修复**：迁入 `packages/render/src/binding.ts`，`@aether/render` 再导出，三个消费者（`renderer.ts` / `main.ts` / `services/editor-state.ts`）改直连。

---

### 🟠 P1-2 · ADR-005 深相对路径残留 3 处

ADR-005 要求"禁止深相对路径跨包"，但两个包没跟上：

```
packages/framegraph/src/graph.ts:7   import type { GfxDevice } from '../../gfx/src/device';
packages/render/src/feature.ts:7     import type { GfxDevice, CapabilityTier } from '../../gfx/src/device';
packages/render/src/feature.ts:8     import type { FrameGraph } from '../../framegraph/src/graph';
```

同批次的 `packages/render/src/skin.ts` 已经用 `@aether/core`，说明这是**漏网**而非有意。

**已修复**：三处改为 `@aether/gfx` / `@aether/framegraph`。现在 `grep -rnE "from '\.\./\.\./" packages/` **零命中**。

---

### 🟠 P1-3 · 注释是谎言：5 个文件仍在描述"兼容桥"

0b.8 已经把 10 个兼容桥**全删了**，但包体里 5 个文件的头注释还在告诉读者"编辑器侧有个兼容桥"：

```
packages/core/src/math.ts:7        "apps/lab/shader-lab/src/gpu/math.ts 仅作兼容桥"
packages/core/src/naming.ts:8      "apps/lab/shader-lab/src/naming.ts 仅作兼容桥"
packages/render/src/shaders/index.ts:4  "apps/lab/shader-lab/src/shaders/*.wgsl.ts 仅作兼容桥"
packages/scene/src/index.ts:3      "apps/lab/shader-lab/src/gpu/{geometry,gltf}.ts 仅作兼容桥"
packages/render/src/gizmo.ts:13    "交互数学留在编辑器侧（apps/lab/shader-lab/src/gizmo.ts）"
```

括号里的路径**已经不存在了**（0b.8A 物理搬迁）。这是重构后最典型的文档腐化：代码是对的，**注释在骗人**。下一个 session 照着注释去找 `apps/lab/shader-lab/`，会直接怀疑自己看错了仓库。

**已修复**：5 处全部改写为真实现状（`packages/render/src/gizmo.ts` 的交互数学路径改为 `apps/editor/src/gizmo.ts`）。

---

### 🟠 P1-4 · 引擎域函数被遗落在编辑器：`normalizeMeshHeight`

`apps/editor/src/models.ts` 里的 `normalizeMeshHeight(mesh, targetMeters)` 是**纯几何运算**（只依赖 `MeshData`），而且被**运行时导入链路**调用：

```
main.ts:237 / main.ts:865 / asset-inspector.ts:119  →  parseGlb(buffer, CHARACTER_HEIGHT_M)
```

导入 GLB 后统一身高，这是引擎行为，不是 UI 行为。docs/11 §5 把 `gpu/geometry.ts`（顶点契约）归了 `packages/scene`，这个函数是同一族，**属于遗漏**。

**已修复**：上提 `packages/scene/src/geometry.ts`，编辑器 `models.ts` 改为 re-export（不再维护第二份实现）。

> 注意：`CHARACTER_HEIGHT_M = 2.05` **故意没上提** —— 它是内容常量（源自 `roster.json`），按 ADR-002 应由内容生成层产出，留在编辑器域是对的。见遗留项 L-4。

---

### 🟡 P2-1 · `LabRenderer` 仍是"半拆的 god class"，文档结论夸大

`docs/11 §13.6` 原文：

> `LabRenderer` 退化为**门面**（持有 service 实例、公开 ~80 方法 1 行委托……）
>
> —— 实测是**半拆**：58 个方法确实是 ≤2 行委托，但仍有 15 个方法装着 626 行实质逻辑（L-3 后）。
> 委托占比 67%，说「门面」仍属夸大。

> ⚠️ **本表 2026-09-03 已重测并订正。** 初版给出的「94 方法 / 31 委托 / 29 个 >10 行 / 1,330 行 / 占文件 68%」
> 来自一个**从未入库的临时脚本** —— 数字无法复现，也无法核对口径。这本身正是本文档 §8 ADR-008
> 要禁止的行为，审计报告自己先犯了。现已把度量脚本固化到 `tools/verify/facade-metric.py`
> （`npm run verify:facade`），下表全部由它产出，可复现。

实测（`tools/verify/facade-metric.py`，口径：方法体剔除空行/注释/收尾括号后的**实质行**）：

| 指标 | HEAD（`39675b8` 混元3 原状） | L-3 收敛后 |
|---|---|---|
| 文件行数 | 1,946 | **1,748**（−198） |
| 方法总数 | 90 | **86**（−4，即装箱四件套） |
| ≤2 行（纯委托） | 58（64%） | 58（67%） |
| >10 行（实质逻辑） | 19 | **15**（−4） |
| 这些方法实质行合计 | 773（占全部方法体实质行 891 的 **87%**） | **626**（占 744 的 **84%**） |
| 最长方法（实质行） | `constructor` 123 / `render` 105 / `addObject` 81 / `applySubMeshes` 65 / `packLights` 50 | `constructor` 123 / `render` 110 / `addObject` 81 / `applySubMeshes` 65 / `buildGridTexture` 48 |
| GPU 资源创建调用 | 编辑器 20 处 : 引擎 24 处 | 同左（本轮未动资源生命周期） |

注意：初版的 68% 分母是**文件总行数**，本表的 87%/84% 分母是**方法体实质行合计**，不是同一把尺子。
本表用后者，因为「门面化」问的是方法体的构成，而非方法体占文件的比例。

结论：**抽得动的状态机（selection/hover/gizmo/animation）抽走了，抽不动的 GPU 装箱与资源生命周期留在了体内**（`buildGridTexture` 65 行 / `packPost` 63 行 / `packLights` 61 行 / `uploadMesh` 56 行 / `packToon` 41 行 / `packMaterial` 35 行）。

这不构成 ADR-001 违规（所有 GPU **layout 常量** `FRAME_FLOATS`/`SLOT_BYTES`/`VERTEX_LAYOUT` 都在包体，编辑器只是按契约填数），**但"门面"这个词是错的**。用词不准会误导后续 session 以为这块已经收拾干净了。

**已处理**：不强行改代码（风险 > 收益，且用户已否决 `registerFeature` 路线），改为在本文档如实记录，并在 §6 给出三条可选收敛路径。**文档已订正表述。**

---

### 🟡 P2-2 · 命名债：app 改名了，外围标识没跟上

0b.8A 把 `apps/lab/shader-lab` 物理搬成 `apps/editor`，但：

| 位置 | 残留 |
|---|---|
| `package.json` | 脚本仍叫 `lab` / `lab:build` |
| `apps/editor/vite.config.ts` | `outDir: '../../dist/shader-lab'` |
| `tsconfig.check.json` | `exclude` 仍列 `apps/lab/shader-lab/vite.config.ts`（已不存在的路径） |
| `packages/core/src/math.ts:3` | "只为 Shader Lab 服务" |

**已修复**：新增 `editor` / `editor:build` / `editor:smoke` 脚本（`lab` / `lab:build` 保留为别名，避免打断肌肉记忆与既有文档）；`outDir` 改 `dist/editor`；`exclude` 删掉失效路径。

---

### 🟡 P2-3 · `framegraph` 与 `RenderFeature` 是运行时孤儿

```
grep -rn "@aether/framegraph" apps/editor/src packages/render/src  →  仅 packages/render/src/feature.ts:8 一处 import
grep -rn "RenderFeature|PASS_ORDER|registerFeature" 同上           →  零处实现 / 零处注册
```

`packages/framegraph`（295 行）与 `packages/render/src/feature.ts`（130 行）**在运行时完全没有被消费**。docs/11 §13.6.2 自己承认这是"保持零改动"的刻意选择。

这不算 bug（Phase 0 不接 M1 的 FrameGraph 是合理的），但**必须在路线图上写明处置**：要么 Phase 1 真接上，要么标注为 dormant 免得后来者以为是活代码。

**已处理**：记录为遗留项 L-1，不做代码删除（删了 Phase 1 要重写）。

---

### 🟡 P2-4 · 引擎契约里残留编辑器语义词 `hovered`

`packages/render/src/renderer-core.ts:64`：

```ts
hovered: { objIndex: number; sub: number | null; bindGroup: GPUBindGroup } | null;
```

docs/11 §13.3.5 声称"core **不认识任何编辑器语义**——选中/悬停已在 `RenderFrameInput` 里物化"。物化是对的（core 不持有状态），但**契约字段名仍叫 `hovered`**——引擎在字面上认识"悬停"这个概念。

按 ADR-006 的严格读法这是个瑕疵；中性化（如 `highlight.secondary`）会更干净，但会动 `renderer-core.ts` 的装箱分支，属**行为等价但非零风险**的改动，**本轮不做**，见遗留项 L-2。

---

## 3. 已修复清单（12 项）

| # | 问题 | 处置 | 文件 |
|---|---|---|---|
| 1 | 冒烟脚本未入库、结论不可复现 | 新建可复跑 harness + npm 入口 | `tools/verify/editor-smoke.mjs`、`package.json` |
| 2 | 引擎测试住在 app 里 | 6 个测试 + 1 个夹具归位 `packages/*/test` | 见 §2 P0-2 表 |
| 3 | `apps/editor/src/gpu/` 残留空壳目录 | 删除 | — |
| 4 | `binding.ts` 未上提 | 迁入 `packages/render/src/binding.ts` | +3 消费者改直连 |
| 5 | ADR-005 深相对路径 3 处 | 改 `@aether/*` | `framegraph/graph.ts`、`render/feature.ts` |
| 6 | 5 处注释描述已删除的兼容桥 | 改写为真实现状 | 见 §2 P1-3 |
| 7 | `normalizeMeshHeight` 遗落编辑器 | 上提 `packages/scene`，编辑器 re-export | `scene/geometry.ts`、`models.ts` |
| 8 | npm 脚本 / outDir / exclude 命名债 | 改名 + 保留别名 | `package.json`、`vite.config.ts`、`tsconfig.check.json` |
| 9 | README「禁止 headless」与 docs/10 D4 冲突 | 订正为"软渲染不验像素、但可以验结构" | `tools/verify/README.md` |
| 10 | 编辑器缺内置模型不变量测试 | 新增 `apps/editor/test/models.test.ts`（3 例） | — |
| 11 | gltf 测试缺退化输入用例 | 新增零高度网格不产生 NaN 断言 | `packages/scene/test/gltf.test.ts` |
| 12 | core 测试反向依赖 scene（L0→L4） | 改用本地 12 三角形立方体，去掉跨层依赖 | `packages/core/test/math.test.ts` |

---

## 4. 新增：可复跑的结构冒烟（`npm run editor:smoke`）

`tools/verify/editor-smoke.mjs` —— 真实 Chrome + SwiftShader + CDP，**零第三方依赖**（Node 22 全局 `WebSocket`）。

覆盖 9 组 35 断言，逐一驱动 services 公开 API（经 `LabRenderer`）：

| 组 | 断言内容 |
|---|---|
| A 启动 | `#fatal` 未显形、`window.__editor` 已挂载、canvas 尺寸有效、GPU adapter 名可读 |
| B 帧循环 | `drawCalls > 0`、`triangles > 0`、FPS 有读数 |
| C SelectionService | 对象列表非空、选中往返、悬停往返、取消选中归 null、`selectedName` 可读 |
| D HierarchyService | 子网格数、显隐切换、重算三角形、包围盒有限 |
| E MaterialPanelService | 材质库、槽位读写、实例/覆盖创建丢弃、导出 |
| F PickingService | `getEye`、`pointerRay`、`worldToScreen`、`pickAt` |
| G GizmoService | mode/space 切换、位置旋转缩放写入读回、激活轴、四元数 |
| H AnimationService | **经真实「导入 GLB…」路径**载入 rigged GLB → clip 列表 → 播放/暂停/seek |
| I 稳定性 | 1.5s 后仍在出帧 |

### 实测结果

```
默认胶囊场景：              30 PASS / 0 FAIL / 3 SKIP（H 组需 --glb）│ CONSOLE(0) EXCEPTIONS(0)
+ E-01 rigged+animated：   35 PASS / 0 FAIL / 0 SKIP              │ CONSOLE(0) EXCEPTIONS(0)
   导入结果：smoke.glb · 1222 顶点 / 852 面 / 2.05 m / 贴图已载入
   动画 clip：idle / run / attack / walk / hit / death
   GPU: google swiftshader · drawCalls 25 · triangles 15332 · FPS 17
```

### 两个判据陷阱（已写进 README，写新断言时必读）

1. **`setCharacter()` 是替换角色槽，不是新增物体** —— `getObjectList().length` 导入前后**不变**。拿对象数判定"GLB 是否导入成功"必然假失败，要读 `#model-info`。
   > 为此给 `#model-info` 加了稳定 id（此前是匿名 `.hint` div，自动化无从选取）。
2. **`#fatal` 是常驻 DOM**，靠 `style.display` 显形。直接读 `innerText` 即使卡片没显示也会返回标题文字「无法启动」（`innerText` 对未渲染元素回退成 `textContent`）——审计时这里先报了一次假阳性，已改用 `getComputedStyle(...).display !== 'none'`。

---

## 5. 四道门禁（修复后全绿）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | **0 error** |
| 单元 | `npm test` | **100/100**（core 16 · scene 21 · render 28 · editor 35） |
| 构建 | `npm run editor:build` | 成功，`dist/editor` |
| 冒烟 | `npm run editor:smoke -- --glb <rigged.glb>` | **35 PASS / 0 FAIL**，CONSOLE(0) EXCEPTIONS(0) |

测试分布已按分层归位：

```
packages/core/test/math.test.ts        16
packages/scene/test/geometry.test.ts    5
packages/scene/test/gltf.test.ts       16
packages/render/test/skin.test.ts       9
packages/render/test/binding.test.ts   19
packages/render/test/frame-uniforms.test.ts 17  ← 引擎层合计 82（L-3 后）
apps/editor/test/materials.test.ts     23
apps/editor/test/gizmo.test.ts          9
apps/editor/test/models.test.ts         3
apps/editor/test/selection-outline.test.ts 7  ← 编辑器层合计 42（L-2 后）
```

---

## 6. 遗留项（本轮刻意不做，需决策）

| ID | 项 | 为什么不做 | 建议 |
|---|---|---|---|
| **L-1** | `framegraph` + `RenderFeature` 运行时孤儿（425 行） | Phase 0 不接 M1；删了 Phase 1 要重写 | ✅ **dormant 标记已于 2026-09-03 完成**（§6.3），代码一个字没动。仍待决策：在 `docs/10` Phase 1 里把"接上 FrameGraph"写成明确交付项 |
| **L-2** | `RenderFrameInput.highlight.hovered` 编辑器语义词 | ~~与 L-3 一起做~~ **已于 2026-09-03 第二轮完成**，见 §6.2 | — |
| **L-3** | `LabRenderer` 剩余 1,330 行实质逻辑（GPU 装箱 + 资源生命周期） | ~~推荐收敛路径~~ **已于 2026-09-03 第二轮完成**，见下方 §6.1；剩余部分是资源生命周期（`uploadMesh` / `buildGridTexture` / bind group 管理），需重做运行时验证，不在本轮范围 | 下一步若要继续收敛，目标是资源生命周期，不是装箱 |
| **L-4** | `CHARACTER_HEIGHT_M = 2.05` 硬编码，未由 `roster.json` 生成 | ~~属 `docs/10` Phase 0 backlog 第 3 项（D3/ADR-002），是独立里程碑~~ | ✅ **已于 2026-09-03 第三轮完成**，见 §6.4 |
| **L-5** | ADR-005 的生产形态未落地（无 `pnpm-workspace.yaml`、无子包 `package.json`） | docs/11 §13.1 已记录为刻意偏差（多 session 下 `pnpm install` 有风险） | 保持现状；等上提全部收敛、单 session 时再补 |
| **L-6** | `docs/10` 未发布到线上资料库 | 资料库现有 01–05 + Game Editor 系列 4 篇，**没有 10/11/12** | 与 `docs/11`、`docs/12` 一并发布（docs/10 §5 自己把"线上内容未入版本控制"列为风险， mitigation 是"以 docs/ 为同源真源，发布仅是镜像"——那就真的要发） |
| **L-7** | `packPost` 里 grading 三色硬编码（`#0E0C16` night-deep / `#FFF6E2` bone / `0.98` 中间调倍率） | ~~随 L-3 下沉时只是搬家，未改性质；改成内容库驱动要动 ADR-002 生成层~~ | ✅ **已于 2026-09-03 第三轮完成**，见 §6.4 |
| **L-8** | `params.ts` 的 10 个 `grade*` 默认值里 **2 处与 `tokens.json` 漂移**：`gradeShadowMult` 0.95（真源 0.78）、`gradeShadowMix` 0.12（真源 0.2，疑似把亮部的 0.12 抄到了暗部） | **修正会改变画面**（暗部更深、紫蓝更重），属美术决策，审计不擅自改 | 由用户在编辑器里目视确认后决定：对齐真源 or 承认这是刻意艺术偏移并在注释里写明 |

### 6.1 L-3 已收敛（2026-09-03 第二轮）

按 §6 推荐的路径执行，**装箱与 layout 常量合到同一处**：

| 动作 | 位置 |
|---|---|
| 新增 `frame-uniforms.ts`：layout 常量 + 4 个 pack 函数 + 收窄的参数契约 | `packages/render/src/` |
| `SLOT_BYTES / SLOT_FLOATS / MAX_MATERIAL_SLOTS / MAX_OBJECTS / FRAME_FLOATS / LIGHTS_FLOATS / TOON_FLOATS / POST_FLOATS` 从 `renderer-core.ts` 搬入 `frame-uniforms.ts` | buffer 尺寸与写入顺序同处一屏，改 WGSL 只动一处 |
| `srgbToLinear` / `hexToLinear` 归入 `@aether/core`（原为 `renderer.ts` 私有函数） | L0 色域工具，装箱要用 |
| `renderer-core.ts` 改为 import，并**停止导出**这批常量 | 否则与 `export * from './frame-uniforms'` 撞名（ESM 星号导出歧义） |
| 编辑器 `render()` 里 3 行 `packXxx` → 1 次 `packFrameUniforms({...})` | `apps/editor/src/renderer.ts` |

**关键设计：参数契约刻意收窄。** 引擎侧只声明装箱真正读到的字段（`LightPackParams` / `ToonPackParams` / `PostPackParams`），
**不引入 `LabParams`**（ADR-007：LabParams 属编辑器 UI 层）。调用方直接传 `LabParams` —— 它是这三个接口的字段超集，
结构化类型天然兼容。这样既保住了依赖方向，又不用在引擎层复制一份 60 字段的参数表。

新增 17 条单测（`packages/render/test/frame-uniforms.test.ts`，ADR-009 归位），
覆盖：layout 常量与 buffer 尺寸一致、装箱后不留 NaN/未初始化槽位、灯光颜色走 sRGB→linear 而 grading 走 raw sRGB
（两条路径方向相反，是最容易写反的地方）、点光环绕随时间走圆、线宽按 1080p 换算、`packMaterial` 的 base 偏移不越界。

### 6.2 L-2 已收敛（2026-09-03 第二轮）

引擎侧的高亮契约去掉了鼠标交互词汇，`hovered` 这个语义泄漏点被消除：

| 位置 | 原名 | 中性名 |
|---|---|---|
| `CoreHighlight` 字段 | `selected` / `hovered` | `primary` / `secondary` |
| `CoreFrameUniforms` 字段 | `selToon` / `selMat` / `hoverToon` / `hoverMat` | `primaryToon` / `primaryMat` / `secondaryToon` / `secondaryMat` |
| `RendererCore` buffer | `selToonBuf` / `selMatBuf` / `hoverToonBuf` / `hoverMatBuf` | `primaryToonBuf` / `primaryMatBuf` / `secondaryToonBuf` / `secondaryMatBuf` |
| 绘制分支局部变量 | `isSel` / `isHover` | `isPrimary` / `isSecondary` |

**编辑器的 `selected` / `hovered` 命名刻意保留不变** —— 那本来就是编辑器的领域概念，
硬改成 primary/secondary 只会让 `state.hoveredIndex` 这类代码变难读。ADR-001 约束的是
**引擎的公共签名**，不是调用方的内部命名。翻译集中在一个地方：
`apps/editor/src/features/selection-outline.feature.ts`（+ `RenderFrameInput.uniforms` 的键名映射）。

**为什么值得为一次改名单写 7 条测试**：真正的风险不是改名本身，而是那条
「悬停与选中是同一物体时第二层让位」的规则 —— 它在引擎里是 `!isPrimary` 的短路，
映射写反了**不会有编译错误**，只会让选中物体多画一圈描边，肉眼很难发现。
`apps/editor/test/selection-outline.test.ts` 把这条规则连同另外几条边界（bind group 未建好时退化为 null、
产出的键必须只有 `primary`/`secondary`）一起钉死。

### 6.3 L-1 已标注 dormant（2026-09-03 第二轮，代码未动）

`packages/framegraph/src/graph.ts`（295 行）+ `packages/render/src/feature.ts`（130 行）共 425 行
处于「编译得过时、没人调过」的状态。本轮**不改代码**，只在两个文件头加 DORMANT 标记，写明：

- 可复现的核实命令与结果（`grep -rn "@aether/framegraph"` 的唯一命中是 `feature.ts` 自己的
  `import type`；`RenderFeature` 零实现者）—— 两个 dormant 模块互相引用，谁都没落地；
- 当前真实路径是 `renderer-core.ts` 手写的 4-pass，没经过 FrameGraph；
- 启用前置条件：先补单测（`packages/framegraph/` 下目前一个测试都没有），
  再写 driver 迁移 4 个 pass 并做运行时等价验证。

顺带记录两个坑：①`packages/framegraph/src/**/*.ts` **在** `tsconfig.check.json` 的 include 里，
所以它「typecheck 通过」不等于「能用」；②`apps/editor/src/features/*.feature.ts` 的 "feature"
与 `RenderFeature` **不是同一个东西** —— 前者是活的、每帧在跑的帧输入组装纯函数，
后者是 dormant 接口。命名撞车，已在 `feature.ts` 文件头写明。

---

### 6.4 L-4 + L-7 已收口：`packages/content/` 生成层（2026-09-03 第三轮）

L-4 与 L-7 卡在同一个前置 —— **ADR-002 的 `content/` 生成层**（`docs/10` D3 / Phase 0 backlog 第 3 项）。
本轮把它建起来（D3 的第一步），并顺带收掉这两个遗留项。

**新增 `packages/content/`（L4）**

| 文件 | 作用 |
|---|---|
| `scripts/gen-content.mjs` | 生成器。`roster.json` + `tokens.json` → 强类型 TS。纯 Node、零依赖 |
| `src/generated/tokens.generated.ts` | `CORE_COLORS` / `COLOR_USAGE` / `NUMBERS` / `GRADING` / `TOON_RAMP` / `OUTLINE` |
| `src/generated/roster.generated.ts` | 8 个角色（npc 5 + boss 3）的标识与可解析数值 |
| `src/index.ts` | `@aether/content` 入口 |
| `test/content.test.ts` | 13 条回归（ADR-009 归位） |

`npm run content:gen` 写文件，`npm run content:check` 只比对（不同步即 exit 1）。

**生成器的两条铁律**

1. **只派生真源里真实存在的东西，绝不编造。** 解析失败直接抛错，不静默填 0。
   实例：B-02 母体 `speed: "本体固定不可移动"` → 生成 `speedMps: null`，
   **不是 0** —— 0 是我们编的数，`null` 是「真源明示不可移动」这个事实。
2. **复合串取第一个数值，原始串原样保留。** `"1.25 m（四足）/ 1.60 m（直立）"` → `1.25`，
   且 `heightRaw` 保留全文，信息不丢。规则写进生成物注释，并有测试钉死。

**不可派生清单（11 项，写进生成物头部）**

`CharacterPhysicsDef` 的半径/质量、`CharacterAiDef` 的转向/视野/听觉/攻击性、
`HurtboxDef` 的骨骼与半径、boss 招式数值、`BodyPartDef` 的网格/材质索引 ——
**roster.json 里根本没有这些字段**（它的 `ai` 是出图提示词，`weakness` 和 `attacks[].desc` 是中文散文）。

> ⚠️ 这一点很重要：D3 原文写的是「`roster.json` → `roster.generated.ts`，`gameplay/character.ts` 改读生成物」，
> 但**真源承载不了 `CharacterDef` 需要的调参数**。硬生成等于把编造的数字洗成「单一真源」，
> 比硬编码更坏 —— 那正是 §4 里「68% 来自未入库临时脚本」同一类错误。
> 因此本轮**只做标识与可解析数值**，`CharacterDef` 的调参字段继续留空，
> 等真源补结构化数据、或由独立调参表承载。清单本身已入版本库，不会靠口头传承。

**L-7 的解法不是「引擎读 tokens」 —— 分层不允许**

`content/` 在 **L4**，`packages/render` 在 **L3**，依赖规则只允许向下。**render 不能反向 import content。**
所以 `packPost` 的三处硬编码改成 **参数注入**（ADR-007：LabParams 由编辑器 UI 层产出，引擎只声明收窄契约）：

| 硬编码 | 改为 | 真源 |
|---|---|---|
| `dst[8] = 0.98` | `p.gradeMidMult` | `grading.stops[mid].multiply` |
| `hexToRgb('#0E0C16')` | `p.gradeShadowColor` | `stops[shadow].mixTo` → `core.night-deep` |
| `hexToRgb('#FFF6E2')` | `p.gradeLightColor` | `stops[light].mixTo` → `core.bone` |

`gradeMidMult` 原先连参数都不是（写死 0.98），现已补滑杆，可调。
测试补两条「值来自参数而非硬编码」的断言 —— 否则改回硬编码后值一样，测试照样绿。

**L-4：`CHARACTER_HEIGHT_M` → `MODEL_RULER_HEIGHT_M`（改名 + 接真源）**

值改为 `requireCharacter('E-04').heightMeters`（由生成层派生）。**改名是必要的**：
roster 里 8 个角色身高从 1.25 m（E-02 四足）到 4.0 m（B-02 母体）各不相同，
原名会被读成「角色都是这个高度」；它实际是**归一化标尺**。
选值规则（E-04 盾卫，编辑器全部验收截图与回归测试都用它）已写进注释。
测试补溯源断言（必须严格等于 roster 里 E-04 的身高），防止改回硬编码。

**顺带发现 L-8**：`params.ts` 的 10 个 `grade*` 默认值里 8 个与 `tokens.json` 一致，
但 `gradeShadowMult`（0.95 vs 真源 0.78）与 `gradeShadowMix`（0.12 vs 真源 0.2）漂移 ——
后者疑似把亮部的 0.12 抄到了暗部。修正会改变画面，列为 L-8 交用户决策。

---

## 7. 对这次重构的最终评价

**方向对，执行扎实，收尾潦草。**

值得肯定的：
- 19 个提交**每步保绿**（每步都过 tsc + vitest + build），这是 strangler 式重构的正确姿势；
- 跨 session 冲突处理得当（0b.3/0b.5 用"先 cp 真源再写桥"保住并行 session 的 WIP），还把踩到的坑（cp 与 Write 不能并行）固化成了纪律；
- `renderer-core` 的行为等价做得很实（矩阵公式、gizmo 缩放 k、draws 计数、uniform 字节布局逐项比对）。

需要纠正的：
1. **结论与证据必须一起入库** —— 30/30 的冒烟结论没有脚本，等于没有结论。这条比任何代码问题都重要。
2. **用词要准** —— "退化为门面"实际是"半拆"，68% 的实质逻辑还在体内。文档夸大比不写文档更危险。
3. **注释会腐烂，要跟着代码一起改** —— 5 个文件描述已删除的兼容桥，是本次最典型的"代码对了、注释在骗人"。

按 `docs/10` 的 Phase 0 定义衡量（**2026-09-03 第二轮 L-3 完成后更新**）：
**D1（并轨）达成度约 95%** —— 装箱逻辑与 layout 常量已全部归入 `packages/render`，
编辑器侧不再有任何「按 WGSL 字段顺序写 Float32Array」的代码；剩下 5% 是资源生命周期
（`uploadMesh` 46 行 / `buildGridTexture` 48 行 / bind group 管理），需重做运行时验证。
**D4（验证标准化）本轮补齐**（冒烟脚本入库 + 度量脚本入库）；D2/D3/D5 未在本 session 范围内。

**第二轮自检发现的问题**（记在这里，避免好了伤疤忘了疼）：本文档初版 §4 的 68% 指标
由一个未入库的临时脚本产出 —— 审计报告自己违反了它要立的 ADR-008。第二轮把度量脚本
固化进 `tools/verify/` 后才发现，初版那组数字（94 方法 / 31 委托 / 29 个 >10 行）与
可复现口径（90 / 58 / 19）对不上。**结论：度量工具必须和结论同时入库，否则连"数字是多少"
都会随脚本丢失而漂移。**

---

## 8. ADR 增补

- **ADR-008**：验证资产与结论同入库 —— 任何"跑过 X 条断言 / Y 全绿"的结论，其脚本、配置、产物必须可复现地存在于版本控制内（`tools/verify/`），否则视为未验证。
- **ADR-009**：测试随被测代码分层归位 —— `packages/*` 的测试放 `packages/<pkg>/test/`，`apps/*` 的测试放 `apps/<app>/test/`；禁止把引擎测试放在 app 的 `src/` 下，也禁止测试反向依赖上层包。
