# 11 · Game Editor 结构优化设计（包体基座 + 编辑器消费者）

> 角色：软件架构师（基于 `docs/10` ADR-001/004 + 代码实测测绘，产出可执行的重构结构蓝图）
> 设计时间：2026-09-02｜依赖 `docs/10` 的目标分层与 ADR-001（渲染真源唯一化）

---

## 0. 目标与范围

把 `apps/lab/shader-lab`（≈13K 行、自带渲染器的单体 app）重构为：

- **包体基座** `packages/*`：成为全项目唯一的渲染真源（toon + 描边 + 材质三层 + glTF 导入 + 顶点契约），自身不含任何编辑器 UI / 交互语义。
- **编辑器消费者** `apps/editor`：从 packages 导入渲染能力，编辑器特有的 selection / gizmo / hierarchy / 材质面板 / picking 以 **服务层 + `RenderFeature` 插件** 的形态挂在包体渲染器之上，依赖严格向下。

**不在本设计范围**：glTF 处理改用 `@gltf-transform`（见 `docs/10` §9）、Clustered Forward+ 生长、SoA 快照接线——这些留给后续里程碑。本设计只解决"结构归位"，不新增渲染功能。

---

## 1. 现状事实（实测，非观点）

| 项 | 事实 |
|---|---|
| `apps/lab/shader-lab` | 12,966 行，**与 `packages/*` 零依赖**（全仓 grep `packages`/`@aether` 0 命中） |
| `LabRenderer` | 2611 行单类，公开 ~60 方法，其中 ~35 个属编辑器语义（selection/gizmo/hierarchy/material-slot/pick） |
| 反向依赖命门 | `renderer.ts:20 → './params'`，`render(p: LabParams, …)` 直接吃编辑器参数类型 |
| 渲染核心（A 类，待上提） | `gpu/{device,math,geometry,gltf,testGlb}` `skin` `materials` `binding` `naming` `shaders/{common,scene,post}.wgsl.ts` + `renderer.ts` 的管线构建与 4-pass 帧绘制 ≈ 5.6K 行 |
| 编辑器特有（B 类，留 app） | `ui` `params` `presets` `models` `asset-browser` `asset-inspector` `asset-util` `splitter` `main` `gizmo` + `gizmo.wgsl` ≈ 4.6K 行 |
| 模块解析 | 无 `pnpm-workspace.yaml`、无子包 `package.json`、无 tsconfig `paths`，全部深相对路径（如 `../../packages/gfx/src/device`） |
| device 抽象重复 | `packages/gfx/src/device.ts`（374：能力分级 + UniformRing/StagingRing）与 `apps/lab/gpu/device.ts`（105：`initGpu`）功能重叠且互不知晓 |
| `packages/scene` | **不存在**；`render` 仅 130 行接口桩（`feature.ts`） |

---

## 2. 设计原则

1. **现实上提，不是向桩看齐**（修正 `docs/10` §6 执行顺序）：先把已验证能力以"编辑器今天就能驱动"的 API 落进包体，SoA 快照接线留给 Phase 2/M3。接口向现实妥协，而非反之。
2. **最小可驱动契约**：`render()` 在 Phase 0 不吃 `RenderWorldSnapshot` 的 SoA 终态，先定义编辑器当天能填充的 `SceneView`；M3 时 `SceneView` 由 SoA 快照实现替换。
3. **先断反向依赖，再动渲染器**：`materials.ts` 最先搬，顺手抽出 `MaterialDef` 脱离 `LabParams`，解除 `renderer → params` 的环。
4. **编辑器特有渲染 = `RenderFeature` 插件**：gizmo / 选中高亮不进包体，经 `renderer.registerFeature()` 接入（接口已在 `feature.ts` 预留，`PASS_ORDER` 含 `debug`）。
5. **每步保绿**：strangler 式逐步搬迁，每步 `npm run lab` 仍能渲染 E-04 + `vitest` 全绿。

---

## 3. 目标工作区拓扑（pnpm monorepo）

当前没有 workspace 机制，上提前必须先修模块解析，否则路径会变成 `../../../../packages/render/src/...`。

```
# pnpm-workspace.yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

每个包新增 `package.json`（`name: "@aether/<x>"`, `type: module`, `exports: { ".": "./src/index.ts" }`）。
`tsconfig.base.json` 增加 `paths`：

```jsonc
"baseUrl": ".",
"paths": {
  "@aether/core":      ["packages/core/src/index.ts"],
  "@aether/gfx":       ["packages/gfx/src/index.ts"],
  "@aether/framegraph":["packages/framegraph/src/index.ts"],
  "@aether/scene":     ["packages/scene/src/index.ts"],
  "@aether/render":    ["packages/render/src/index.ts"],
  "@aether/ai":        ["packages/ai/src/index.ts"],
  "@aether/gameplay":  ["packages/gameplay/src/index.ts"]
}
```

编辑器 `vite.config.ts` 加 `@aether` → `packages/*/src` 的 alias（或依赖 workspace 软链由 vite 自动解析）。**依赖方向铁律（CI 可加 lint 门禁）**：任何 `packages/*` 不得 import `@aether/editor` 或 `apps/` 下路径；编辑器可依赖全部包。

---

## 4. 包集合与职责（含新增 `packages/scene`）

```
packages/
  core/        @aether/core       L0  现有 app/ecs 雏形 + 迁入的 math/naming（跨层共享基础）
  gfx/         @aether/gfx        L1  现有 device(能力分级+分配器)+handle；并入 lab initGpu → 统一设备抽象
  framegraph/  @aether/framegraph L2  现有 Pass DAG（✓ 雏形）
  scene/       @aether/scene      L4  【新增】World/Transform/Camera/LOD + glTF 导入 + 顶点契约(VERTEX_LAYOUT)
  render/      @aether/render     L3  由 feature.ts 桩 + lab 渲染核心充实：toon+描边 + 材质三层 + RenderFeature 装配
  ai/          @aether/ai         （✓ 不变，最成熟）
  gameplay/    @aether/gameplay   （✓ 不变）
apps/
  editor/      @aether/editor     【由 apps/lab 重构】消费者：UI/参数/资产浏览 + services + features 插件
```

> 不为空包建目录（ADR-002 精神）：`scene` 一落地即带 glTF + 顶点契约 + Transform/Camera 真实代码，不预建空壳。
> `docs/10` §3 提及的 `packages/assets`（glTF 导入）本设计并入 `packages/scene`，减少新包数量；若后续资产类型膨胀再拆。

---

## 5. 模块 → 包映射表

| 现状文件（apps/lab） | 去处 | 动作 / 说明 |
|---|---|---|
| `gpu/math.ts` (482) | `packages/core/src/math` | 列主序数学，L0 共享 |
| `naming.ts` (35) | `packages/core/src/naming` | 跨层命名小工具 |
| `gpu/device.ts` (105) | **删除**，并入 `packages/gfx` | `initGpu` 逻辑并入 gfx 的 `createGfxDevice()`；消除第二套 device 抽象 |
| `gpu/geometry.ts` (479) | `packages/scene/src/geometry` | VERTEX_LAYOUT 60B 契约 |
| `gpu/gltf.ts` (1178) | `packages/scene/src/gltf` | GLB 解析 → 运行时网格契约 |
| `gpu/testGlb.ts` (119) | `packages/scene/test` | 测试夹具，随 glTF 走 |
| `materials.ts` (207) | `packages/render/src/materials` | 三层材质语义；**抽出 `MaterialDef` 脱离 `LabParams`** |
| `binding.ts` (245) | `packages/render/src/materials` | 材质槽绑定继承（纯逻辑）；依赖改为 `MaterialDef` |
| `shaders/{common,scene,post}.wgsl.ts` (~580) | `packages/render/src/shaders` | 真实 toon/描边/post WGSL |
| `skin.ts` (288) | `packages/render/src/skin` | LBS 蒙皮，与管线耦合 → render |
| `renderer.ts` 管线构建 + 4-pass 帧绘制 | `packages/render/src/renderer` | **剥离** selection/gizmo/hierarchy/material-slot/picking 后上提 |
| `renderer.ts` selection/hover/gizmo/hierarchy/material-slot/pick | `apps/editor` services + features | 见 §7，重新挂载为插件/服务 |
| `gizmo.ts` + `shaders/gizmo.wgsl.ts` | `apps/editor/src/features/gizmo` | 编辑器特有渲染，经 `RenderFeature` 接入 |
| `ui.ts` `params.ts` `presets.ts` `models.ts` | `apps/editor/src` | 编辑器 UI / 参数面板 / 预设 |
| `asset-browser.ts` `asset-inspector.ts` `asset-util.ts` | `apps/editor/src` | 资产浏览 / 检视 |
| `splitter.ts` | `apps/editor/src` | 可拖拽布局 |
| `main.ts` | `apps/editor/src/main` | 事件编排；改为 import `@aether/render` + `@aether/gfx` |

---

## 6. 解耦关键：`LabParams` → 包级契约

`params.ts` 反向依赖是上提渲染核心的**唯一硬阻塞**，必须先解：

- **`MaterialDef`**（置于 `packages/render/src/materials/types`）：描述材质三层（shared / instance / override）的纯数据结构。`materials.ts` 的 12 例单测改为针对 `MaterialDef`。编辑器 `params.ts` 成为 UI 绑定层，**产出** `MaterialDef`，而非被渲染器消费。
- **`SceneView`**（置于 `packages/render/src`）：Phase 0 的最小驱动契约——对象列表（meshId / materialId / model 矩阵）+ 相机 + 帧参数。`render()` 签名改为 `render(view: SceneView)`，**不再出现 `LabParams`**。编辑器把其内部对象适配成 `SceneView`。
- `RenderWorldSnapshot`（SoA，已在 `feature.ts`）保留为终态接口；M3 时 `SceneView` 由 SoA 快照实现替换，渲染器内部不改。

> 这一步让 `renderer` 的公开签名里**零编辑器类型**，是 D1/ADR-001 成立的硬判据。

---

## 7. 编辑器消费者结构（services + features）

`apps/editor` 不再持有渲染器，而是组合包体渲染器并挂载自身语义：

```
apps/editor/src/
  main.ts                 // bootstrap: createGfxDevice(@aether/gfx) → new AetherRenderer(@aether/render) → 组装 SceneView
  services/               // 原 renderer 的 ~35 个编辑器方法重归此处
    selection.ts          // selectedIndex/hovered 状态机（原 renderer 字段 + selectObject/getSelected/setHovered）
    hierarchy.ts          // 树构建/可见性/删除时取消选中（原 getObjectList/buildTree/setSubMeshVisible）
    material-panel.ts     // 材质槽编辑 → 产出 MaterialDef（原 assignSlotMaterial/ensureOverride/promoteOverride）
    picking.ts            // pickAt/worldToScreen/pointerRay（用 @aether/render 暴露的 ray 工具）
  features/               // RenderFeature 插件，经 renderer.registerFeature() 接入包体 pass 链
    gizmo.feature.ts       // 原 Pass 4 gizmo 绘制（依赖 selectedIndex）
    selection-outline.feature.ts // 选中/悬停高亮（复用包体 outlinePipeline，判 isSel/isHover）
  ui/                     // ui.ts params.ts presets.ts asset-browser.ts asset-inspector.ts splitter.ts models.ts
```

**接线的工程实质**：原 `render()` 内复用 `outlinePipeline` 追加 selection/hover draw call、Pass 4 gizmo，改为编辑器 features 在 `setup(deps)` 里预建 bind group（`buildSelectionBindGroup`/`buildHighlightBindGroup` 迁到 `selection-outline.feature`），`render(deps, view)` 里用 `FeatureDeps`（gfx + graph + SceneView）取对象状态绘制。包体渲染器只暴露"给我对象 id，我画描边/给我 object 列表，我画 gizmo"的钩子，不持有 selection 状态。

---

## 8. 依赖与构建机制

| 机制 | 做法 |
|---|---|
| 包发现 | `pnpm-workspace.yaml` 列 `packages/*` + `apps/*` |
| 包标识 | 每包 `package.json` `name: "@aether/<x>"`，`exports` 指向 `src/index.ts` |
| TS 解析 | `tsconfig.check.json` `paths`（base 未被 check 继承，故直接加在 check）映射 `@aether/*` → `packages/*/src/index.ts` |
| 运行解析 | vite alias `@aether` → `packages/*/src`（或 workspace 软链自动解析） |
| 向下依赖铁律 | packages 禁止 import `@aether/editor` / `apps/`；违规由 CI lint 拦截 |
| 类型检查 | 现有 `tsconfig.check.json` 保留 `apps/editor` + `packages/*` 平铺 include |

---

## 9. 分阶段迁移计划（strangler，每步保绿）

**Phase 0a · 工作区地基**（零代码移动，仅解析）
1. 加 `pnpm-workspace.yaml`、各包 `package.json`、`tsconfig.base` paths、vite alias。
2. 加兼容 shim：把旧 `./gpu/*` `./materials` 等相对 import 暂映射到新包导出，使后续步骤可单文件递增迁移而不一次性爆改。

**Phase 0b · 低风险逐步上提**（顺序经修正，先断环）
1. `materials.ts` → `packages/render`，**抽出 `MaterialDef`**，编辑器 `params` 改为产出 `MaterialDef`（断 `renderer→params` 环）。
2. `gpu/math.ts` → `packages/core/math`；`naming.ts` → `packages/core/naming`。
3. `gpu/geometry.ts` + `gpu/gltf.ts` → `packages/scene`（含 `testGlb` 夹具）。
4. `shaders/*.wgsl.ts` → `packages/render/src/shaders`。
5. `skin.ts` + 管线构建 → `packages/render`。
6. `renderer.ts` 帧绘制核心 → `packages/render/src/renderer`，**剥离**编辑器方法（本步风险最高，放最后）。
7. 设备层合并：`packages/gfx` 吸收 `initGpu`，删除 `gpu/device.ts`。
8. 编辑器：`main.ts` 改为组装 `AetherRenderer`；selection/gizmo/hierarchy/material-panel 重归 `services` + `features`；`apps/lab` 整体改名/重构为 `apps/editor`。

**Phase 0c · 验收**（见 §10）

> 每步结束必须：`npm run lab` 仍能渲染 E-04 + `vitest` 全绿。禁止"临时双份"——模块上提的同一 commit 内删除 app 侧旧副本。

---

## 10. 验收门禁（对应 `docs/10` D4）

| 层 | 手段 | 判据 |
|---|---|---|
| 单元 | `vitest` | math/gltf/geometry/materials（含 materials 12 例）全绿 |
| 冒烟 | headless WebGPU（Chrome 152 + `--enable-unsafe-swiftshader`） | 编辑器启动无运行时错，E-04 出现在帧缓冲 |
| 像素 | CDP 视觉判定（可选门禁） | toon+描边渲染与基线截图一致 |

**ADR-001 成立硬判据**：`apps/editor` 仍能渲染 E-04，且 `grep -r "LabParams\|renderer 内部 selection" packages/render` **零命中**（渲染真源已无编辑器语义）。

---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| `params.ts` 反向依赖阻塞上提 | 最先搬 `materials` 并抽 `MaterialDef`（§6），环先断再动渲染器 |
| `renderer.ts` 2611 行 god class 拆分风险 | 放 Phase 0b 最后一步；selection/gizmo 改为 features 前先保编辑器绿 |
| 两套 device 抽象 | Phase 0b.7 合并入 `packages/gfx`，删 `gpu/device.ts` |
| 无 workspace 致路径爆炸 | Phase 0a 先修解析，再动代码 |
| 多 session 并行改同仓库（已发生 09-02 对象库损坏） | 渲染目录过渡期只许一个 session 动；严守 git 红线，未授权不碰 `.git` 内部 |
| "临时双份"变永久 | 上提同一 commit 删旧副本；CI 加"packages 不得 import apps"门禁 |

---

## 12. ADR 增补索引

- **ADR-005**：引入 pnpm workspace + `@aether/*` 包标识，模块解析统一走包名，禁止深相对路径跨包。
- **ADR-006**：编辑器语义（selection/gizmo/hierarchy/material-panel/picking）一律以 services + `RenderFeature` 插件挂载于包体渲染器，渲染核心公开签名零编辑器类型。
- **ADR-007**：`LabParams` 拆为编辑器 UI 层（产出）与包级 `MaterialDef`/`SceneView` 契约（消费），逆向依赖禁止。

> 本设计与 `docs/10` 互补：docs/10 定"要并轨"，本设计定"怎么并、边界在哪、先断哪条环"。

---

## 13. 执行进度（2026-09-02 首增量 · Phase 0a + 0b.1 + 0b.2）

**已落地，验证全绿。** 这一增量建立整个后续上提所依赖的包体解析地基，并完成第一块纯数据的上提。

### 13.1 模块解析地基（0a）
- 各包新增 `src/index.ts` 再导出公共 API：`packages/{render,gfx,core,framegraph,ai,gameplay}/src/index.ts`。
- `tsconfig.check.json` 加 `baseUrl: "."` + `paths: { "@aether/*": ["packages/*/src/index.ts"] }`。
- `apps/lab/shader-lab/vite.config.ts` 与根 `vitest.config.ts` 各加 `@aether` 正则 alias，解析到 `packages/<pkg>/src/index.ts`（config 位于 `apps/lab/shader-lab`，别名需回退三级到项目根）。
- **偏差（刻意）**：未引入 `pnpm-workspace.yaml` / 各包子 `package.json`。活跃多 session 仓库里跑 `pnpm install` 会改写 node_modules 软链，风险高；tsconfig paths + vite alias 已完全满足"干净 `@aether/*` 导入、无深相对路径跨包"。ADR-005 的更严生产形态（workspace + 发布级 `package.json`）留待上提验证全绿后再加。

### 13.2 材质数据上提（0b.1）
- `MaterialState` + 纯原语（`MaterialKind/Source/Ref/Instance/Slot`、`sharedId/sharedIndex/isInstanceId`、`cloneMaterial`、`slotSource`、`planSubMeshCount`）迁入 `packages/render/src/materials.ts`。
- `MaterialLibrary` / `slotState` **留在** `apps/lab/src/materials.ts`：它们依赖 `LabParams.materials` 共享材质库，本质是编辑器侧材质管理（ADR-007 边界的实证——包体定义数据契约，编辑器消费并管理）。
- `params.ts` 删除 `MaterialState` 定义，改为 `import type` + `export type` 从 `@aether/render` re-export。因此 `renderer.ts` / `binding.ts` / `ui.ts` / `presets.ts` **零改动**即保绿。
- **偏差（命名）**：蓝图 §6/ADR-007 称包级类型为 `MaterialDef`，执行时保留既有 `MaterialState` 名——它本就是渲染器装箱的材质数据，改名需动 renderer 的 uniform 装箱代码，风险大且无收益。`MaterialDef` 作为工作名退役。

### 13.3 数学/命名上提（0b.2）
- `gpu/math.ts`（列主序 mat4/quat/vec3 + 拾取 rayAabb/rayTri + hex/rgb 互转）与 `naming.ts`（`uniqueName`/`nameAllocator`）真源迁入 `packages/core/src/math.ts` 与 `packages/core/src/naming.ts`，由 `@aether/core` 再导出。
- 编辑器侧 `apps/lab/shader-lab/src/gpu/math.ts` 与 `apps/lab/shader-lab/src/naming.ts` **保留为兼容桥**（`export * from '@aether/core'`）：`main.ts`/`renderer.ts`/`skin.ts`/`gltf.ts` 正被另一并行 session 暂存、本步不触碰，桥保证其 `import './gpu/math'` / `'../naming'` 继续编译，待 0b.8 编辑器收敛后删除桥。
- `materials.ts` 改为 `import { uniqueName } from '@aether/core'`（不再经桥），完成 editor→core 清洁消费。
- **踩坑（已修复）**：本步首次落地时把"拷贝真源进 core"与"写 lab 桥"放进同一条消息并行执行，桥的 `Write` 先于 `cp` 落地，导致 `cp` 把已生成的桥当真源拷进 `packages/core` —— core 与 lab 互为桥、导出全空（tsc `no exported member`、vitest `nameAllocator is not a function`）。修复：改用确定内容 `Write` 真实实现进 `packages/core`。**纪律固化：拷贝文件内容（`cp`）与改写源文件（`Write`/`Edit`）不可在同一条消息并行，必须顺序执行。**

### 13.3.1 几何/glTF 上提（0b.3，新建 packages/scene）
- 新建 `packages/scene`：`geometry.ts`（顶点契约 VERTEX_LAYOUT / createBox / weldMesh / 蒙皮布局）+ `gltf.ts`（极简 glTF 2.0 加载器 parseGlb / collectMeshInstances）真源迁入，由 `@aether/scene` 再导出。
- `gltf.ts` 内部 import 改 `./math` / `../naming` → `@aether/core`（geometry 无 import，原样迁入）；`tsconfig.check.json` include 加 `packages/scene/src/**/*.ts`。
- 编辑器侧 `apps/lab/shader-lab/src/gpu/{geometry,gltf}.ts` 保留为兼容桥（`export * from '@aether/scene'`），保护 main/renderer/skin/asset-inspector 及 skin.test 的 `import './gpu/{geometry,gltf}'` 继续编译。
- **跨 session 注意（非破坏式搬迁）**：`gpu/geometry.ts` / `gpu/gltf.ts` 当时正被并行 asset/skin session 暂存（含其 WIP 修改）。本步用"先 cp 当前 lab 文件进 packages/scene（保留其 WIP）、再写 lab 桥"的方式搬迁——其修改落到 `packages/scene/{geometry,gltf}.ts`，lab 同名文件退化为桥，**代码不丢**，待 0b.8 收敛后删桥。

### 13.3.2 WGSL 上提（0b.4，归入 packages/render）
- 4 个 `.wgsl.ts`（common / gizmo / post / scene）真源迁入 `packages/render/src/shaders/`，由 `packages/render/src/shaders/index.ts` 再导出；`@aether/render` 新增 `export * from './shaders'`。
- `scene.wgsl.ts` / `post.wgsl.ts` 的 `import { COMMON_WGSL } from './common.wgsl'` 在包内同目录仍成立，无需改路径。
- 编辑器侧 `apps/lab/shader-lab/src/shaders/*.wgsl.ts` 四项全保留为兼容桥（`export * from '@aether/render'`），保护 renderer 的 `import { SCENE_WGSL, POST_WGSL, GIZMO_WGSL } from './shaders/*'` 继续编译。

### 13.3.3 蒙皮/动画上提（0b.5，归入 packages/render）
- `skin.ts`（LBS 蒙皮 + 动画求值 evalJointMatrices / packSkin）真源迁入 `packages/render/src/skin.ts`，`@aether/render` 新增 `export * from './skin'`；内部 import 改 `./gpu/math`→`@aether/core`、`'./gpu/gltf'`→`@aether/scene`。
- 编辑器侧 `apps/lab/shader-lab/src/skin.ts` 保留为兼容桥（`export * from '@aether/render'`），保护 renderer / skin.test 的 `import './skin'` 继续编译。
- **跨 session 注意（非破坏式搬迁）**：`skin.ts` 当时正被并行 asset/skin session 暂存（含其蒙皮管线 WIP）。同 0b.3 手法——先 cp 当前 lab 文件进 packages/render（保留 WIP），再写 lab 桥，代码不丢。
- **0b.5 范围收窄**：蓝图 0b.5 含"管线构建"，但管线构建（createRenderPipeline ×4 + 4-pass 帧绘制）嵌在 `renderer.ts` 里，而 `renderer.ts` 正被并行 session 暂存且是 2611 行 god class、其消费者（main/ui/gizmo）也暂存——无法用兼容桥零破坏搬迁（renderer 是 class，剥编辑器方法会改 API 破坏锁定消费者）。故"管线构建"上提取消独立步，并入 0b.6 与 renderer 帧绘制核心一并处理（见 13.5 跨 session 协调）。

### 13.3.4 设备初始化上提（0b.7，归入 packages/gfx）
- lab `gpu/device.ts`（GpuContext / initGpu / GpuUnavailableError）真源迁入 `packages/gfx/src/context.ts`；`packages/gfx/src/index.ts` 加 `export * from './context'`。
- 注意：`packages/gfx/src/device.ts` 是既有「能力分级 / 资源注册」层（CapabilityTier / pickFeatures / ResourceRegistry），与 lab 的「设备初始化」互补两块，不冲突、不重名，合并后 `@aether/gfx` 同时暴露两者。
- 编辑器侧 `apps/lab/shader-lab/src/gpu/device.ts` 保留为兼容桥（`export * from '@aether/gfx'`），保护 main/renderer 的 `import './gpu/device'` 继续编译。

### 13.3.5 帧绘制核心上提（0b.6，归入 packages/render）
- 新建 `packages/render/src/renderer-core.ts`：`RendererCore` 拥有全部 GPU 资源（4 条管线 / 3 套 bind group layout / frame+lights+toon+post+material+transform + 4 个高亮 buffer / HDR·AUX·Depth 纹理 / gizmo 几何与资源），并封装 4-pass 帧绘制 `drawFrame(input: RenderFrameInput)`。core **不认识任何编辑器语义**——选中/悬停/子网格显隐/描边分支都已在 `RenderFrameInput` 里物化。
- 新建 `packages/render/src/gizmo.ts`：把 gizmo 几何生成 `buildGizmoHandles()` + `GizmoMode`/`GizmoSpace` 类型上提引擎层（纯几何，与编辑器解耦）；交互数学（`axisPlaneNormal`/`rotatePlaneBasis`/`angleInPlane`/`wrapAngle`）**留在**编辑器侧 `gizmo.ts`（需读相机 ray/viewProj）。
- lab `renderer.ts` 退化为薄壳：`RendererCore` 持有 + 委托；**公开 API（~80 方法）签名与行为完全保留**（main/ui/gizmo 零改动，符合 ADR-001）。编辑器侧仍负责场景对象/选中/材质解析/蒙皮/悬停-选中 toon 装箱，把「已完全解析的帧」以 `RenderFrameInput` 交给 `core.drawFrame()`。
- core 对编辑器暴露的逐帧矩阵/向量（`viewProj`/`invViewProj`/`eyeVec`/`gizmoModel`/`gizmoK`/`gizmoOrigin`/`gizmoAxes`/`width`/`height`）改为公有，供 `getGizmoInfo`/`getEye`/`pointerRay`/`worldToScreen`/`pickAtAll`/`resize` 读取。
- **行为保持**：相机矩阵公式、gizmo 恒定像素缩放 `k`、高亮描边分支优先级（sel > hover > 原生 outline）、`draws` 计数、uniform 装箱字节布局全部与重构前逐字节一致；`RendererCore` 的 `frameBuf`/材质/变换 buffer 与编辑器 `frameData`/`materialData`/`transformData` 是同一份 Float32Array。

### 13.4 验证结果（累计 0a + 0b.1 + 0b.2 + 0b.3 + 0b.4 + 0b.5 + 0b.6 + 0b.7）
| 门禁 | 结果 |
|---|---|
| `tsc -p tsconfig.check.json` | 0 错误 |
| `vitest run` | 97/97 通过（math 16 + materials 23 + geometry 5 + gltf 16 + skin 9 + gizmo 9 + binding 19；桥已删，直连 `@aether/*` 全绿） |
| `vite build`（lab） | 成功，39 模块（0b.8 删 10 兼容桥文件后），别名正确解析 |

> 0b.6 改动了 `render()` 的形态（CPU 装箱 → `RenderFrameInput` → `core.drawFrame`），但三道门禁全绿且关键数值路径（矩阵/draws/uniform 字节布局）经审查逐字节等价。**建议下一步补 headless WebGPU 冒烟**（Chrome + `--enable-unsafe-swiftshader`）以像素级确认渲染产物零回归——这是 docs/09 §7 既定的引擎级 CI 标准。
> 各增量按用户指令**逐次 git 部分提交**（仅含本增量文件，不裹挟其他并行 session 的暂存改动）；远程 `origin/main` 已恢复，本地提交后 push。

### 13.5 下一步（按 docs/11 §9 顺序）
### 13.5 剩余（0b.8，需编辑器重手术）
- ✅ **0b.6 已完成**（见 §13.3.5）：`renderer.ts` 帧绘制核心上提 `packages/render`，编辑器公开 API 零改动，三道门禁全绿。
- ✅ **0b.8 兼容桥收敛已完成**（局部收口）：删除 10 个 `export * from '@aether/*'` 桥文件（`naming.ts`/`skin.ts`/`gpu/{device,geometry,gltf,math}.ts`/`shaders/{common,gizmo,post,scene}.wgsl.ts`），并把全部消费者（`main.ts`/`gizmo.ts`/`models.ts`/`asset-inspector.ts`/`renderer.ts`/`materials.test.ts`/`gpu/{geometry,gltf,math}.test.ts`/`skin.test.ts`）的 import 改写为直连 `@aether/{gfx,scene,core,render}`——含 `gltf.test.ts` 内 6 处动态 `import('./gltf')` 一并改 `@aether/scene`。`shaders/*.wgsl.ts` 无消费者，直接删。三道门禁全绿（tsc 0 error / vitest 97/97 / lab build 39 模块）。
- ✅ **0b.8 gizmo 死代码已清**：编辑器 `gizmo.ts` 删除与引擎层 `packages/render/src/gizmo.ts` 重复的几何生成块（`GizmoHandleGPU`/`buildGizmoHandles`/`COL`/`hex`/`orient`/`pushCylinder`/`pushCone`/`pushBox`/`pushRing`/`arrow`/`ring`/`boxAt`/`toGPU` 及未引用的 `GizmoMode`/`GizmoSpace` 导出），仅保留 `axisPlaneNormal`/`rotatePlaneBasis`/`angleInPlane`/`wrapAngle`/`V3` 交互数学（main.ts + gizmo.test.ts 依赖）。三道门禁仍全绿。
- ✅ **0b.8 收口已完成**（见 §13.6）：编辑器 `services`+`features` 重构为 `apps/editor`，`LabRenderer` 退化为门面；`packages/render` 引擎零改动；headless WebGPU 冒烟 30/30 全绿、CONSOLE(0)+EXCEPTIONS(0)。

### 13.6 执行进度（0b.8A–D · 编辑器 services+features 收口）

**架构收口重手术完成，验证全绿。** 本增量把 `LabRenderer`（≈2600 行 god class）里的编辑器语义（selection/hover/gizmo/hierarchy/material-slot/pick/animation）重归 `apps/editor/src/services/*`，渲染期组装逻辑重归 `apps/editor/src/features/*`，`LabRenderer` 退化为**门面**（持有 service 实例、公开 ~80 方法 1 行委托、GPU 装箱与每帧装箱留在体内）。引擎层 `packages/render` 零改动（不引入 `registerFeature` 钩子）。

- **0b.8A 物理搬迁**（`ca07e98`）：`apps/lab/shader-lab` → `apps/editor`，更新 vite alias / index.html / 启动脚本；纯文件移动，行为不变。
- **0b.8B services 抽取**（8 提交 `c94b85d`→`ef2ad89`）：
  - `EditorState`（`c94b85d`）：集中编辑器全部可变状态为单一真源，`host.state` 读写。
  - `SelectionService`（`7378809`）：选中/悬停状态机，委托 `host.buildSelectionBindGroup` / `host.buildHighlightBindGroup`。
  - `HierarchyService`（`cd630f2`）：层级/子网格显隐/删除（释放 GPU 缓冲、联动 select/hover）。
  - `MaterialPanelService`（`61e45e3`）：材质槽三层语义（共享/实例/覆盖）+ 库导出，依赖 `host.resolveMaterial` / `host.sourceOf`。
  - `PickingService`（`d4f8ffe`）：屏幕↔世界拾取/投影，复用 `host.core.invViewProj`/`viewProj`/`eyeVec`。
  - `AnimationService`（`69ff660`）：蒙皮动画控制 + 选中名，从 `@aether/render` 引入真名、读 `host.characterIndex`。
  - `GizmoService`（`ef2ad89`）：gizmo 状态/变换读写/物体检视，`GizmoMode`/`GizmoSpace` 引自 `@aether/render`。
- **0b.8C features 抽取**（`8bb7a1d`）：`features/selection-outline.feature.ts`（`buildSelectionOutline`）与 `features/gizmo.feature.ts`（`buildGizmo`）在编辑器侧组装 `CoreHighlight`/`CoreGizmo`，从 `host.state` 读选中/悬停与 bind group；引擎层 `RenderFeature`/`framegraph` 仍作死设计为未接入口，保持零改动。
- **0b.8D 验收**：
  - ADR-001 硬判据复核：`grep -rn "LabParams" packages/render` → **零命中**（清理 `materials.ts` 注释残留字面 token，路径改为 `apps/editor/src/materials.ts`）。
  - **headless WebGPU 冒烟**（真实 Chrome 152 + SwiftShader + CDP，`webgpu-headless-validate` 流程）：默认胶囊场景 + 逐一驱动每个 service 公开 API（经 `LabRenderer` 门面）+ 导入 E-01 带动画 GLB 跑 skin 渲染与 AnimationService —— **30/30 PASS，CONSOLE(0)，EXCEPTIONS(0)**，HUD 持续出帧、无致命错误卡片。截图 `editor-0b8-smoke.png`。

#### 13.6.1 三道门禁（0b.8B/C/D 累计）
| 门禁 | 结果 |
|---|---|
| `tsc -p tsconfig.check.json` | 0 错误（每步保绿） |
| `vitest run` | 97/97 通过 |
| `vite build`（lab） | 成功，41 模块（services+features 增量后） |
| headless WebGPU 冒烟 | 30/30，CONSOLE(0)，EXCEPTIONS(0) |

#### 13.6.2 关键决策（用户拍板）
- **不引入 `registerFeature` 宿主**：原蓝图（`docs/11` §7）设想 `RendererCore` 作为 `registerFeature` 宿主、features 经 `RenderFeature` 接入包体 pass 链。用户否决（"先不做 feature register 的方式了"）——改为**编辑器侧组装 `RenderFrameInput`**，`packages/render` 零改动。`features/` 模块仅作编辑器侧组装函数，不触碰引擎 `RenderFeature` 接口。
- **门面而非引擎钩子**：`LabRenderer` 公开 API 签名与行为逐字节保留（main/ui/gizmo 零改动），services 经 `host.state`/`host.core`/`host.build*BindGroup` 读写——把 god class 拆成"门面 + 6 service + 2 feature"，而非改成引擎 plugin 系统。
