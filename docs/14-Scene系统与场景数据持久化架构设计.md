# 14 · Scene 系统 —— 以场景为唯一数据载体的架构设计

> 角色：引擎架构师
> 时间：2026-09-04 ｜ 基线：agents.md 规则 + docs/10 架构定案 + 当前代码盘点
> 数据字典真源：`packages/scene/src/document.ts`（本文不重复 schema，只解释**为什么这么定**）
> 配套验证：`packages/scene/test/document.test.ts`（28 例，纯 Node 可跑）

---

## 0. 结论先行

**一句话**：游戏内容不再是代码里的常量，而是 `assets/scenes/**/*.scene.json` 里的节点与组件；
编辑器只是这个文件的**读写器 + 运行器**，不再拥有场景。

| # | 决策 | 一句话理由 |
|---|---|---|
| **ADR-010** | 场景是游戏开发的唯一数据载体 | 硬编码场景 = 内容不可版本化、不可复用、不可程序生成 |
| **ADR-011** | Authoring 用 Node/Component（AoS），热实体用 SoA ECS，两者靠 `NodeId ↔ EntityId` 映射桥接 | 现有 ECS World 是半成品，用它当场景骨架会把能跑的编辑器拆成不能跑 |
| **ADR-012** | 场景文件用**扁平节点表 + parent 引用**，不用嵌套树 | diff 友好、无递归、与 prefab override 的 propertyPath 寻址天然一致 |
| **ADR-013** | 文件格式用 **JSON + schemaVersion + 迁移链**，不用二进制 | 与 roster.json/tokens.json 的真源哲学一致；二进制 .pak 是 Phase 4 的**运行时产物**，不是编辑格式 |
| **ADR-014** | Edit/Play 严格分离：Play 前快照、Play 中只改副本、Stop 时整体回滚 + 释放全部 Play 期 GPU 资源 | 否则反复 Play/Stop 泄漏显存（项目已在 `removeObject` 上踩过同类坑） |
| **ADR-015** | 项目容器 `aether.project.json` 是所有路径/场景清单/层表的**锚点** | 没有它，`.meta` 的 guid、"相对什么"、场景清单、`layer: 3` 是第几层全都靠口头约定 |
| **ADR-016** | 资产附加数据走**同名 sidecar**（`<file>.meta.json`），不用集中索引 | 集中索引文件是合并冲突制造机；sidecar 跟着文件走，天然无冲突 |
| **ADR-017** | 脚本 = **行为注册表**（代码资产 + 参数 schema），场景只存 `behavior id + params` | JSON 携带代码字符串 = 远程代码执行入口；且没有参数 schema 就没有 Inspector 控件 |

**头号风险（必须先看）**：当前渲染器 `MAX_OBJECTS = 64`（`packages/render/src/frame-uniforms.ts:23`）。
场景里的静态物件受此硬限，而 GDD 要求的 **500 僵尸不能走这条路径**。见 §4.5 容量预算。

---

## 1. 现状确诊（事实 + 证据）

| 现状 | 证据 | 后果 |
|---|---|---|
| **场景是硬编码的** | `LabRenderer` 构造函数直接 `createPlane(80,24)` / `createCapsule(...)` 造地面和角色（`apps/editor/src/renderer.ts:431-436`） | 刷新即丢，无文件、无版本、无复用 |
| **没有 Play/Edit 模式** | `main.ts` 里的 `mode` 只指 gizmo 的 translate/rotate/scale（`main.ts:613,679-681`） | 无法"运行预览"，只能静态看 |
| **灯光是渲染调试参数，不是场景内容** | 灯光字段在 `LabParams`（`params.ts:15-40`），装箱进 `lightsData`(40 floats) 送 shader | 每个场景不能有独立氛围，GDD §4.3 的"火场/暗巷"主题无处落地 |
| **场景表示与 GPU 资源耦合** | `SceneObject` 同时持有 `vertexBuffer`/`texture` 和 `pos`/`quat`/`scale`（`renderer.ts:93-167`） | 无法序列化：存盘必然带着 GPU 句柄 |
| **引用靠数组下标** | `slotBase`、`selectedIndex`、`bindGroups[index]`，注释已写明"索引一变就打乱 uniform 槽位"（`renderer.ts:132,138`） | 数据层根除：改用稳定 NodeId |
| **主循环是空实现** | `App.tick` 只有 `void now`（`packages/core/src/app.ts:156-161`），编辑器自己写 rAF（`main.ts:1646-1649`） | Play mode 没有可复用的调度器，必须 S3 补 |
| **ECS World 是半成品** | `remove()` 空实现（`world.ts:170`）、`strideOf()` 硬编码返回 4（`world.ts:229`）、`isChanged()` 恒真（`world.ts:189`） | 不能直接当场景运行时的底座，见 §4.1 |
| **分层图有反向依赖** | `packages/render/src/renderer-core.ts:18` 反向 import `@aether/scene` | 见 §8 修正方案 |
| **没有项目容器** | 仓库根无 `aether.project.json`；"基准路径"靠口头约定 | 见 §3.7 |
| **零资产元数据** | `find assets -name '*.meta*'` 返回空；绑定/骨骼/导入参数全在内存 | 见 §3.8 —— **正在发生的数据丢失** |

**一句话诊断**：编辑器有**渲染能力**、有**编辑交互**，但缺**数据层**。场景系统就是补这一层。

---

## 2. 设计原则（7 条，违反即打回）

1. **代码里不许出现场景内容**。地面、灯光、相机、刷怪点只能来自场景文件。
   发现硬编码 = 该内容没被持久化 = bug。
2. **文档与运行时分离**。文件里只有路径引用、标量和可静态校验的结构；
   没有 `GPUBuffer`、没有 `Float32Array` 顶点、没有对象引用。
3. **引用靠稳定 id，不靠下标**。`NodeId` 是唯一寻址方式（`parent` / `followTarget` / prefab override）。
4. **数据结构向前兼容，渲染能力渐进增强**。schema 允许声明超出当前渲染能力的灯，
   运行时按优先级降级（§6），而不是反过来限制数据。
5. **可 diff 优先于可紧凑**。JSON 人可读、git 可 review；体积问题交给 Phase 4 的打包产物解决。
6. **静默修数据是犯罪**。加载旧版本、字段缺失、引用断链，一律产出 diagnostic 展示给用户（§7.2）。
7. **验证与结论同入库**（ADR-008）。schema 的任何结论必须有可跑的脚本/测试支撑。

---

## 3. 数据层：SceneDocument

完整类型定义见 `packages/scene/src/document.ts`，这里只讲设计取舍。

### 3.1 五层容器 + 三种表示

**落盘的四层容器**（都是 JSON，都在 git 里）：

```
  aether.project.json                    锚点：路径根 / 场景清单 / 层表 / 渲染档位
    │
    ├─ assets/**/<file>.glb.meta.json    资产默认：导入设置 + 默认绑定 + 骨骼/动画
    │      │ 提供默认值
    │      ▼
    ├─ assets/prefabs/*.prefab.json      复用单元：节点树 + 组件（可覆盖 .meta）
    │      │ 实例化 + override
    │      ▼
    └─ assets/scenes/*.scene.json        关卡：节点 + 组件（可覆盖 prefab）
```

**四级覆盖链**（每级只存与上级的差异，不是全量拷贝）：

```
  .meta（资产默认） ─▶ prefab（覆盖） ─▶ scene（覆盖） ─▶ runtime（Play 期，不落盘）
```

改一次 `.meta`，引用它的几十个场景同步生效；某个场景要特化，只写自己那一条覆盖。

**三种表示**（落盘 → 内存 → 逐帧）：

```
  SceneDocument                 SceneRuntime                    GPU
  (JSON on disk)                (in-memory)                     (RenderFrameInput)
  ┌──────────────┐   load()    ┌──────────────┐   extract()   ┌──────────────┐
  │ nodes[]      │ ──────────▶ │ SceneGraph   │ ───────────▶  │ objects[]    │
  │ components[] │             │  NodeId→索引 │               │ uniforms     │
  │ AssetRef     │ ◀────────── │  变换缓存    │               │ bindGroups   │
  │ (纯数据)     │  save()     │  SceneObject │               │ (逐帧)       │
  └──────────────┘             └──────────────┘               └──────────────┘
   可 diff/可 review            可交互/可撤销                    只画一帧
```

**关键**：三种表示之间**单向**转化。GPU 层永远不会写回 Document 层（编辑的是 Runtime 的 Node，
保存时序列化 Node → Document）。这保证了"屏幕上的临时状态"不会污染文件。

**不落盘的三类**（务必区分，否则会污染 git 或丢失可复现性）：

| 类别 | 例子 | 落点 |
|---|---|---|
| 派生/烘焙产物 | 减面结果、AO 贴图、流场、guid 索引 | `.workbuddy/cache/`（gitignore，按 `.meta.sourceHash` 失效重算） |
| 编辑器 UI 状态 | 面板折叠、最近打开文件、相机位置 | `localStorage`（项目已有先例 `zh.assets.collapsed`） |
| Play 期运行时状态 | 僵尸生成、门打开、拾取物消耗 | 内存，Stop 即弃（ADR-014） |

### 3.2 为什么是扁平节点表（`nodes[]` + `parent`）

| 维度 | 嵌套树 | 扁平表（选它） |
|---|---|---|
| git diff | 改一个深层节点，整块位移，diff 无法阅读 | 只变动一行 |
| 递归深度 | `JSON.parse` 深嵌套、序列化递归、栈风险 | O(n) 一次遍历 |
| prefab override 寻址 | 需要 `'root.children[2].children[0]'` 这种脆弱路径 | `'/nd_x8fk/transform.position'` 稳定 |
| 与运行时对齐 | 运行时本来就要摊平成数组做变换传播 | 直接映射 |

> 项目吃过整文件 diff 的亏（1700 行）。格式设计要主动避开它。

### 3.3 组件模型

8 种组件（`ComponentKind`），各自对应一种**引擎能力或玩法语义**：

| 组件 | 引擎侧消费者 | 说明 |
|---|---|---|
| `MeshRenderer` | `packages/render` | 网格 + 逐子网格材质绑定 |
| `Light` | `packages/render` | 支持降级，见 §6 |
| `Camera` | Play mode | 与编辑器相机**完全分离** |
| `Collider` | 物理（Phase 2） | 含 trigger 语义 |
| `SpawnPoint` | `packages/gameplay` | 引用 roster.json 的 characterId |
| `RoomVolume` | 关卡系统 | GDD §4.2 房间池 / §4.3 主题 |
| `NavZone` | `packages/ai` | 流场网格作用域 + 离线烘焙产物 |
| `Script` | 行为注册表 | **只存 behavior id + 参数，不存代码字符串** |

**为什么 Script 不存代码**：一旦场景文件能携带可执行文本，JSON 就变成远程代码执行入口，
且无法静态校验、无法 diff。行为必须由注册表 key 解析。

**组件去重规则**：同一节点上每种组件最多一个（`REPEATABLE_COMPONENTS` 只白名单 `Script`）。
一盏节点挂两盏灯是设计错误，不是特性。

### 3.4 资产引用：只存引用，绝不内联

```ts
{ path: 'assets/characters/E-04/rigged.glb', sub: 'prim:Body#0' }
```

- 一个 40MB 的 GLB 内联进 JSON 会同时毁掉 git diff 与 LFS。
- `sub` 的定位优先级 **primitiveKey > nodePath > nodeName > index**，
  与 `packages/scene/src/gltf.ts` 的 `SubMeshRange`（`nodeId`/`nodePath`/`primitiveKey`）完全对齐 ——
  换模型时的材质继承匹配规则不需要重写。

**资产管理必须独立一层**（`AssetServer`）：500 个僵尸 prefab 实例共享同一个 GLB，
若各自 parse 一遍，内存和加载时间都会爆。缓存键 = `AssetRef.path`，值 = 解析后的 `MeshData` + 纹理。

### 3.5 预制体：不是锦上添花，是 GDD 的必要前提

GDD §4.1-4.2 要求**程序生成楼层**（3 层 × 房间图）。程序生成的本质是：

```
房间图（RoomGraph）─▶ 逐个 Instantiate(room prefab) ─▶ 运行时场景
        ▲                        ▲
      随机+约束              拼装的原子
```

**没有 prefab，程序生成就无从下手**。所以 prefab 不是"以后再说"的便利功能。

- `PrefabDocument` = 一棵可复用的节点子树（`nodes[]` + `root`），结构与 `SceneDocument` 同质。
- 场景里的实例只存 `PrefabInstance { ref, overrides, disconnected }`。
- override 用 **propertyPath** 寻址：`'/nd_x8fk/Light.intensity'`、`'/nd_x8fk/transform.position'`。
  **用 id 而非下标** —— prefab 内部增删节点不会打乱已有 override。
- `disconnected: true` = 一次性特化，不再跟随源 prefab。

### 3.6 环境：灯光从"渲染参数"变成"场景内容"

原本散落在 `LabParams` 的 `key/fill/ambient/rim/fog` 现在是 `EnvironmentData`（场景级单例）+ `Light` 组件。
**收益**：GDD §4.3 的四个楼层主题（火场/尸潮/腐液/暗巷）第一次有了数据落点 ——
每个主题就是一套 `EnvironmentData` 预设 + 若干 `Light` 节点。

保留 `postOverride: AssetPath | null` 指向风格文件（由 tokens.json 生成）。
**引擎不直接读 tokens**（ADR-007：render 在 L3，content 在 L4，禁止反向依赖），
风格参数仍由编辑器 UI 层注入 `PostPackParams`。

### 3.7 项目容器：`aether.project.json`（ADR-015）

**为什么必须有**：前面几层都需要一个锚点才有意义 ——
`.meta` 的 guid 在什么范围内唯一？资产路径相对谁？"通关后去哪个场景"？`layer: 3` 是第几层？
没有项目文件，这些全靠**口头约定**，而约定不会写进任何地方。

对标 Unity `ProjectSettings/`、Unreal `.uproject`、Godot `project.godot`。

**形态决策：单文件，不是目录**。本项目所有真源都是单文件 JSON（`roster.json` / `tokens.json`），
保持一致；目录形态会把设置散成十几个小文件，改一项要 diff 一堆。**一个仓库 = 一个项目**（多项目是 YAGNI）。

里面装什么（完整定义见 `packages/scene/src/project.ts`）：

| 字段 | 作用 |
|---|---|
| `assetRoots` | 资产根目录，扫描 guid 索引时遍历它 |
| `scenes[]` + `startIndex` | 场景清单 = Unity Build Settings；**有它"通关后加载哪个场景"才有数据落点** |
| `layers[]` | 层表，索引即 `MeshRenderer.layer` 的值。前 8 个是内置层（`Default`/`Character`/`Pickup`/`Trigger`…）**不可改名** |
| `tags[]` | 自由语义标注（`Boss` / `Loot` / `Destructible`） |
| `render` | 目标档位 `t0..t3`（对齐 `packages/gfx` 的 `CapabilityTier`）、描边/后处理开关、`renderScale`、`targetFps` |
| `defaultStyle` / `inputMap` / `gameplayConfig` | 指向独立资产的路径（**项目文件只存指针，不存内容**，避免它随方案调整频繁变动） |
| `materialLibrary` | 一个项目一套共享材质库，跨场景复用美术调校 |
| `behaviorRoots` | 行为（脚本）目录，Inspector 的 Script 下拉项从这里扫 |

**明确不放进去**：资产索引（guid→path 派生产物，扫描重建，落 cache）、
编辑器 UI 状态（localStorage）、烘焙产物（cache，按 hash 失效）。

### 3.8 资产附加数据：`<file>.meta.json`（ADR-016）

**这不是设计缺口，是正在发生的数据丢失**。编辑器对 GLB 做的操作会产生大量附加数据，
现在**全部只活在内存里，刷新即丢** —— `assets/` 下一个 `.meta.json` 都没有：

| 已产生的附加数据 | 现存位置 | 丢失后果 |
|---|---|---|
| 材质绑定继承快照 `MeshNodeBinding` + 孤儿池 | `SceneObject.bindingOrphans`（内存） | 换模型后材质绑定全回默认 |
| 身高归一化系数（E-04 = 2.05 m） | 命令行参数 `MODEL_RULER_HEIGHT_M` | 每次导入要重填 |
| 骨骼绑定会话（骨长采纳、T/A-pose 反解、镜像权重） | `binding-panel.ts` 会话（内存） | **重灾区**：花几小时摆的骨骼，刷新全没 |
| 动画配置（clip 选择 / loop / speed） | `SkinState`（内存） | 每次重设 |
| 导入参数（焊接容差 / AO / up-flip / 拆子网格） | Python 脚本命令行 | 换台机器重导入结果不同 |

**归属判定规则**（本层的设计地基）：

> **问一句：「换一个全新的空场景，这个数据还在不在？」**
> 在 → 资产数据（`.meta.json`）｜不在 / 是场景特有 → 场景数据（`.scene.json`）

| 数据 | 归属 | 理由 |
|---|---|---|
| 身高归一化 2.05 m | `.meta` | 换场景，E-04 还是 2.05 m |
| GLB 子网格 3 默认用"铁锈"材质 | `.meta` | 任何场景导入它都该这样（**可**被场景覆盖） |
| 骨骼绑定 / T-pose 反解结果 | `.meta` | 模型固有属性 |
| 这个房间里的僵尸皮肤偏红 | scene override | 场景特有 |
| 这盏灯只照亮这个房间 | scene | 有位置，场景特有 |

**为什么是 sidecar 而不是集中索引**：集中索引（如 `assetdb.json`）会让每次加资产都改同一个文件，
多人协作时是**合并冲突制造机**。sidecar 跟着文件走，天然无冲突。
索引是派生产物，启动时扫描各 `.meta.json` 重建，落 `.workbuddy/cache/`（gitignore）。

**guid 的作用**：场景若存死路径 `.../E-04/rigged.glb`，改个目录名所有引用全断。
有了 guid，文件移动后 sidecar 跟着走、guid 不变，引用自动保持。
S1 阶段解析仍走 `path`，`guid` 作为"重命名保护"的预备字段先落盘 —— 渐进启用，不一次性改完。

**`.meta` 与 `binding.ts` 的对接**：`PrimitiveBinding { materialId, override }`
⇄ `MaterialBindingRef { shared | instance | override }` 三种形态一一对应
（转换是**编辑器/资产层的职责**，不放 schema 里，避免 scene 包反向依赖 render 包造成循环）。
`PrimitiveBindingEntry` 的 `nodeId` / `nodePath` 直接沿用现有两层匹配（nodeId 精确 → 反向路径打分），
换模型继承的匹配算法一个字都不用改。

**身高归一化值从哪来**：`.meta` 只存数值（如 `2.05`），
由生成工具从 `roster.json` 的 `heightMeters` 填入 —— 数据层零依赖，生成器做桥（与 ADR-002 同构）。

### 3.9 脚本与行为（ADR-017）

**三层结构**：

```
  ① 行为定义（代码资产，不落盘）        ② 参数 schema（代码里声明）      ③ 引用（场景数据）
     assets/behaviors/*.ts                 BehaviorDef.params[]           ScriptComponent
     defineBehavior({                        ├ {key:'count', kind:'int',    { behavior:'spawn-wave',
       id: 'spawn-wave',                    │   min:1, max:50, default:8}   params:{ count:12 } }
       run(ctx, params){...} })             └ {key:'prefab', kind:'assetRef'}
```

**为什么场景绝不存代码字符串**：
① JSON 就成了远程代码执行入口（打开下载来的 `.scene.json` 即中招）；
② 无法静态校验；③ 重构时改个函数名要全局搜 JSON。

**最容易漏掉的一环是参数 schema**。如果行为只有 `run(ctx, params)` 而不声明参数结构，
Inspector 就画不出控件（不知道 `count` 该是 slider 还是文本框、范围多少），
结果 Script 组件只能靠手改 JSON 编辑 —— 功能等于没有。所以 `BehaviorParamSchema` 是**必需**的，
字段覆盖 `number/int/bool/string/color/nodeRef/assetRef/enum` 八种控件类型。

**失效处理**：行为被删 / 参数改名 → 加载时报 `warning`，组件降级为空操作，**不阻塞加载**
（一个挂了的行为不该让整个场景打不开）。

**热重载**：行为是 TS 模块，Vite HMR 天然支持。但 Play 模式下正在跑的实体持有旧闭包 ——
**约定：Play 中禁用行为热重载**，或只对新生成实体生效。

---

## 4. 运行时层：SceneGraph

### 4.1 为什么不用现成的 `packages/core` ECS World

现状（证据在 §1）：`remove()` 是空实现、`strideOf()` 硬编码返回 4、`isChanged()` 恒真、
`CommandBuffer` 的 `spawn()` 返回 `INVALID_ENTITY`（延迟执行，同步点前拿不到实体）。

**它撑不起场景骨架**：
- 场景节点需要**稳定 id + 父子层级 + 局部/世界变换传播**，ECS 的 archetype 迁移模型天然不适合表达层级；
- 用半成品 World 重写，等于把**已经能跑的编辑器**拆成**不能跑的架构正确品**。

> 架构纯洁性不值得用可运行性换。这是本项目吃过一次亏的地方（两套平行代码），不要再吃第二次。

### 4.2 双层分工（ADR-011）

```
   Authoring 层（AoS）                        热实体层（SoA / ECS）
   ┌────────────────────────┐                ┌────────────────────────┐
   │ SceneGraph             │                │ World + CharacterTable  │
   │  NodeId → row          │   NodeId ↔     │  500 僵尸               │
   │  transform TRS         │◀──EntityId──▶  │  流场寻路 / 战斗 / LOD   │
   │  components[]（对象）   │   双向映射表    │  （packages/ai 已就绪）  │
   │  几十~几百个静态物件    │                │  （packages/gameplay）   │
   └────────────────────────┘                └────────────────────────┘
        编辑、序列化、撤销                         每帧高频、SoA 热路径
```

- **静态/可编辑物件**（地面、灯、门、刷怪点、房间体）走 SceneGraph，AoS，直接可序列化。
- **运行时海量实体**（僵尸、子弹）走 `packages/ai` + `packages/gameplay` 的 SoA 表。
- 两者通过 `NodeId ↔ EntityId` **双向映射表**桥接：`SpawnPoint` 节点生成僵尸时，
  在映射表里登记，Stop 时按表回收。

**ECS 的成熟化放到 Phase 2**（500 僵尸场景），届时只需补完 `world.ts` 的三个半成品方法，
不动 SceneGraph。这是 Bevy / Unity DOTS / Godot 都走过的路。

### 4.3 变换传播

- 存 **TRS 而非矩阵**：可编辑（Inspector 三行）、可插值、不累积剪切。
- 四元数 `xyzw` 存盘（与 `m4.Quat` 一致），不用欧拉角（万向锁 + 插值不唯一）。
  现有 `SceneObject` 同时有 `rot`（欧拉，仅面板显示）和 `quat`（真源）——
  **场景文件只存 quat**，欧拉角是 Inspector 的显示派生物，不入盘。
- **脏标记传播**：改一个节点的 local → 标记自身及全部后代 dirty → 帧首自顶向下重算世界矩阵。
  根节点到叶子的顺序保证父先于子（扁平表按拓扑序排一次即可，O(n)）。

### 4.4 Node ↔ SceneObject 映射

**粒度决策（重要）**：
- **一个场景节点 = 一个可变换对象 = 一个 `SceneObject`**；
- **GLB 内部的骨骼/组节点不提升为场景节点**。

理由：一个 80k 面角色有 30+ 骨骼节点，全提升会淹没 Hierarchy 面板、撑爆场景文件、
并让"选中角色"变成"选中指骨"。模型内部层级保留在 `nodeTree` 里，
只用于材质匹配与层级面板展示 —— **现有行为完全不变**。

```
场景节点 "Zombie_E01_01"                    ← 场景文件里的一行
   └ MeshRenderer { ref: E-01/rigged.glb }
        └ SceneObject（运行时）
             ├ subMeshes[]  ← GLB primitives（Body/Weapon/Shield）
             └ nodeTree[]   ← GLB 内部层级（只展示，不提升）
```

### 4.5 容量预算（硬约束，务必先看）

| 常量 | 值 | 位置 | 含义 |
|---|---|---|---|
| `MAX_OBJECTS` | **64** | `frame-uniforms.ts:23` | 变换 uniform 槽位上限 = **场景静态物件上限** |
| `MAX_MATERIAL_SLOTS` | 256 | `frame-uniforms.ts:22` | 材质槽位（逐子网格分配） |
| `SLOT_BYTES` | 256 | `frame-uniforms.ts:19` | minUniformBufferOffsetAlignment |
| `LIGHTS_FLOATS` | 40 | `frame-uniforms.ts:26` | 10×vec4 → 1 directional + 1 point |

**推论（写死在架构里）**：
1. 场景里的**静态物件**最多 64 个（含地面）。超出必须报错，不能静默丢物体。
2. **500 僵尸绝不能走 `CoreObjectDraw` 路径**。它们必须走 **instanced / 批处理**路径
   （Phase 2 的 GPU-driven 剔除 + `packages/gameplay` 的 LOD：Full/Vat/Proxy）。
3. 材质槽 256 个 = 64 物件 × 平均 4 子网格。导入高面数模型时要核算预算。

> 不做这个预算表，做到第 3 个月会撞墙：场景一放 70 个物件，多出来的就"神秘消失"。

---

## 5. Edit Mode / Play Mode

### 5.1 状态机

```
                    ┌──────────────┐
       打开场景 ───▶ │   EditMode   │ ◀──── Stop（回滚快照 + 释放 Play 资源）
                    └──────┬───────┘
                    Play   │
                           ▼
     ┌─────────────────────────────────────────┐
     │              PlayMode                    │
     │  ┌─────────┐   Pause   ┌────────────┐   │
     │  │ Running │ ────────▶ │  Paused    │   │
     │  └─────────┘ ◀──────── └────────────┘   │
     │       │ Resume                           │
     └───────┼──────────────────────────────────┘
             │ Stop
             ▼
        丢弃 runtime 副本 → 从快照重建 → 回 EditMode
```

### 5.2 快照与恢复（ADR-014）

**Enter Play**：
1. 对 `SceneDocument` 做**深拷贝快照**（`structuredClone` 即可，纯数据，无 GPU 句柄）。
2. 从快照实例化**独立的 runtime 副本**：`PlayWorld`。
3. Play 中所有改动（僵尸生成、门打开、拾取物消耗、实体死亡）**只作用于 PlayWorld**。

**Stop**：
1. 销毁 `PlayWorld`，其中登记的全部 GPU 资源**逐个 `destroy()`**。
2. 从快照重建 Edit Runtime，恢复选中/相机/gizmo。

**为什么必须快照**：不快照 = Play 中的破坏性修改（僵尸被打死、道具被捡走）会写回文件，
一次 Play 就毁了关卡。这是 Unity/Unreal 的 EnterPlayMode 语义，不是可选项。

**为什么必须显式释放 Play 期 GPU 资源**：项目在 `removeObject` 上已经踩过"只打墓碑不释放缓冲 = 永久泄漏"
的坑（`HierarchyService.removeObject` 的注释）。反复 Play/Stop 会以每次几十 MB 的速度吃显存。

### 5.3 相机分野

| | Edit Mode | Play Mode |
|---|---|---|
| 相机来源 | `SceneDocument.editorCamera` | 场景里的 `Camera` 组件（`entryCamera`） |
| 交互 | 轨道相机，鼠标可自由转 | 由游戏逻辑驱动（`orbit-follow` 跟随 `followTarget`） |
| 落盘 | **落盘**（编辑便利） | 不落盘 |

**两者不能混**：编辑时怎么转视角都不该影响玩家看到的画面。
引擎侧无感 —— `RenderFrameInput.camera` 的语义不变，只是喂不同数据。

### 5.4 主循环：必须先补 `App.tick`

`packages/core/src/app.ts:156-161` 的 `tick` 是空实现（`void now`），
编辑器自己在 `main.ts:1646-1649` 写 rAF。

**Play mode 需要真正的调度器**：固定步长累加器 + Stage 顺序 + `maxFixedStepsPerFrame` 防死亡螺旋。
`Stage` 枚举（`app.ts:8-28`）已经定义好了（First→PreUpdate→FixedUpdate→Update→PostUpdate→Extract→Prepare→Render→Last），
**只需要实现 tick**。这个实现同时被 Play mode 和最终游戏复用 —— 不做就是两套主循环（又是两套代码）。

### 5.5 灯光渲染在 Play mode 的落点

Play mode 的渲染路径与 Edit mode **完全共用** `RendererCore.drawFrame`：

```
PlayWorld  ──▶ Extract 阶段 ──▶ RenderFrameInput  ──▶ RendererCore.drawFrame
              （变换传播 +     （objects / uniforms /
                剔除 + 排序）    camera / highlight=null）
```

**唯一差异**：`RenderFrameInput.gizmo = null`、`highlight = { primary: null, secondary: null }`
（Play 里没有选中高亮和 gizmo）。这条差异在 `features/` 里已有先例
（`selection-outline.feature.ts` 把编辑语义映射成引擎的中性 `primary/secondary`）。
**引擎不认识"Play 模式"这个概念** —— 它只认识"这一帧有没有 gizmo 和高亮"。

---

## 6. 灯光与多灯降级

### 6.1 硬件天花板（写死的事实）

`Lights` uniform = 40 floats = 10 × vec4（`scene.wgsl.ts:24-35`）：

```
keyDir · keyColor · fillSky · fillGround · rim · ambient · rimParams · fog · pointLight · pointColor
```

即：**1 盏 directional（key）+ 1 盏 point**，其余（fill/ambient/rim/fog）是全局环境项。

### 6.2 降级策略（ADR：数据结构向前兼容，渲染能力渐进增强）

- **数据层不设上限**：场景可以声明任意多盏灯。
- **运行时装箱**：按 `Light.priority` 降序，取 **top-1 directional + top-1 point** 送 shader。
- **落选处理**：不报错、不静默丢弃 —— 产生一条 `warning` diagnostic，
  编辑器 Hierarchy 里对应灯节点**标黄 + tooltip「当前渲染器仅支持 1 主光 + 1 点光（落选）」**。
- **Phase 2 clustered 落地后**，装箱函数自动支持多灯，场景文件**一个字节都不用改**。

> 不做显式降级提示的后果：用户放 5 盏灯只亮 1 盏，会当成 bug 排查一整天。

### 6.3 灯光与环境的职责划分

| 项 | 归属 | 理由 |
|---|---|---|
| key / fill / ambient / rim / fog | `EnvironmentData`（场景级单例） | 全局唯一，不属于任何节点 |
| 位置相关的光（吊灯、火把、车灯） | `Light` 组件（挂在节点上） | 有位置/朝向/范围，需要变换 |

现有 `LabParams` 里的灯光参数应当**从"渲染调试面板"降级为"环境编辑面板"**，
编辑的是 `SceneDocument.environment` + 选中节点的 `Light` 组件，而不是全局参数。

---

## 7. 持久化

### 7.1 为什么是 JSON

| 维度 | JSON（选它） | 二进制 |
|---|---|---|
| git diff / code review | ✅ 改一行 diff 一行 | ❌ 整块变化 |
| 人工修（场景坏了手改） | ✅ | ❌ |
| 与项目哲学一致性 | ✅ roster.json / tokens.json 都是 JSON 真源 | ❌ |
| 体积 / 加载速度 | ❌ | ✅ |

**体积问题不在这个阶段解决**：Phase 4 的 `.pak` 打包产物才是运行时格式，
JSON 是**编辑格式**。两者职责不同，不要提前优化。

### 7.2 版本与迁移链（必须第一天就做）

```ts
// packages/scene/src/migrate.ts（S0 交付）
type Migration = (doc: unknown) => unknown;
const MIGRATIONS: Record<number, Migration> = {
  // 1: (d) => { /* v1 → v2 */ return d; },
};
export function migrateToCurrent(doc: unknown): SceneDocument;
```

- 加载时：`schemaVersion < SCHEMA_VERSION` → 沿链升级；`> SCHEMA_VERSION` → **拒绝加载**并提示升级编辑器。
- 迁移后**不自动写盘**，而是提示"此场景已迁移到 v2，保存后生效" —— 静默写盘会让用户丢失回滚能力。
- 每次结构性变更必须同时补一条迁移函数和一条测试（ADR-008）。

> 没有迁移链的场景格式，会在第一次改 schema 时变成灾难。这是必须第一天就做、且做了就几乎不用再碰的东西。

### 7.3 目录约定

```
aether.project.json                ← 项目锚点（路径根 / 场景清单 / 层表 / 渲染档位）
assets/
  scenes/
    act1/act1-01-highway.scene.json      手工编辑的静态场景
    act4/act4-03-hospital.scene.json
    sandbox/combat-test.scene.json       战斗沙盒（GDD §10.4）
  prefabs/
    characters/zombie-E01.prefab.json    角色 prefab（roster → 场景的桥）
    rooms/room-combat-a.prefab.json      房间模板（程序生成原子）
    props/door.prefab.json
  characters/models/E-04/rigged/
    E04_rigged.glb                       源资产（LFS，只读）
    E04_rigged.glb.meta.json             资产 sidecar（git，可写）← 导入设置/绑定/骨骼
  materials/
    library.mat.json                     共享材质库（跨场景复用）
  behaviors/
    spawn-wave.ts                        行为定义（代码资产，不落 JSON）
  style/
    *.post.json                          风格/后处理预设（EnvironmentData.postOverride 指向它）
  input/
    mobile-landscape.input.json          输入映射（GDD：横屏虚拟摇杆 + 右侧动作键）
.workbuddy/cache/                        ← 派生/烘焙产物 + guid 索引（gitignore）
```

### 7.4 git 与 LFS

- 场景/prefab/材质 JSON **走普通 git**（要 diff）。
- GLB / 贴图走 LFS（`.gitattributes` 已配，不要绕过）。
- **场景文件里绝不能出现绝对路径或机器相关路径** —— 一律仓库根相对 POSIX 路径。

---

## 8. 分层与依赖修正

### 8.1 现存冲突

`packages/render/src/renderer-core.ts:18` 反向引用 `@aether/scene`（拿 `VERTEX_LAYOUT`/`SKIN_LAYOUT`），
而 docs/10 §3 的分层图把 scene 放在 L4（render 之上），规则是"只允许向下依赖"。

### 8.2 修正方案：把 `packages/scene` 拆成两个语义层（不动代码）

```
core(L0) → gfx(L1) → framegraph(L2) → render(L3) → scene/graph(L4)
                          ▲                              │
                          └──── scene/geometry（共享契约层，允许被 L3 依赖）
```

- `scene/geometry.ts`（顶点布局 + MeshData + 纯几何运算）= **共享契约层**。
  它是"GPU 顶点数据长什么样"的定义，本质是 L2/L3 之间的东西，被 render 依赖是**正确**的。
- `scene/gltf.ts` = 资产导入，L4。
- `scene/document.ts` = 场景文件 schema，L4（本次新增）。
- `scene/graph.ts`（S1 新增，运行时场景图）= L4，依赖 render 是合法的（向下）。

**动作**：只更新 docs/10 §3 的分层图 + `packages/scene/src/index.ts` 的头注释（已做），
**不移动任何文件**。这是文档/语义层面的修正，不是重构。

### 8.3 新增代码的落点

| 新增 | 位置 | 层 |
|---|---|---|
| `document.ts` | `packages/scene/src/` | L4（已交付） |
| `migrate.ts` | `packages/scene/src/` | L4 |
| `graph.ts`（SceneGraph + 变换传播） | `packages/scene/src/` | L4 |
| `instantiate.ts`（Document → Runtime） | `packages/scene/src/` | L4 |
| `asset-server.ts`（引用解析 + 缓存） | `packages/assets/src/`（新建包，Phase 0 backlog 已在规划里） | L4 |
| `scene-*.ts`（编辑器读写/面板） | `apps/editor/src/services/` | L6 |

---

## 9. 与既有资产体系的对接

| 真源 | 场景如何引用 | 注意 |
|---|---|---|
| `roster.json`（8 角色） | `SpawnPoint.characterId = 'E-04'` | roster 是**资料库**，不能派生 `CharacterDef`（缺胶囊半径/质量/转向速率等 11 项，见 `roster.generated.ts` 头部）。**角色 prefab 是必需的一环**：roster 管"长什么样/数值多少"，prefab 管"怎么摆进场景" |
| `tokens.json`（风格） | `EnvironmentData.postOverride → assets/style/*.post.json` | 引擎不直接读 tokens（ADR-007），风格参数由 UI 层注入 |
| GLB 模型 | `MeshRenderer.source.ref` | 身高归一化系数存 `importScale`（对应 `MODEL_RULER_HEIGHT_M`），换模型时保持身高一致 |
| 材质三层语义 | `MaterialRef{shared/instance/override}` | 与 `materials.ts` 的三层一一对应；共享材质活在 `library.mat.json`，场景只存引用 + patch |
| `packages/ai` 流场 | `NavZone{ bounds, cellSize, baked }` | AI 包已就绪（665 行 navigation），接 scene 即可跑 |
| GDD §4 房间/主题 | `RoomVolume{ roomType, theme, clearRule, depth }` | 程序生成 = 按房间图实例化 room prefab |

---

## 10. 实施路线（S0 → S6）

| 阶段 | 交付 | 验收（可跑的判据） | 依赖 |
|---|---|---|---|
| **S0 · 场景 Schema**（✅ 已完） | `document.ts` + 28 例测试 | `npm run typecheck` + `vitest` 全绿 | — |
| **S0b · 项目 + 资产元数据**（✅ 已完） | `project.ts` + `asset-meta.ts` + 46 例测试；顺带修掉 schema 两处缺陷（`MaterialRef` 撞名、patch 字段与 `MaterialState` 不对齐） | `vitest` 95/95；scene 包类型检查零错误 | — |
| **S0c · 落地文件**（建议紧接，半天） | 落地 `aether.project.json`；写 `tools/gen-asset-meta.mjs` 扫描 `assets/**/*.glb` 批量产出 sidecar（从 `roster.json` 填 `normalizeHeightM`、从 `_tools` 脚本参数填导入设置）；把现有骨骼绑定会话导出成 `.meta` | `npm run scene:check` 对全部场景/元数据零 error；改一次 `.meta` 的材质，所有引用它的场景同步生效 | S0b |
| **S1 · 加载** | `migrate.ts` + `graph.ts` + `instantiate.ts` + `asset-server`（读 `.meta` 的导入设置与默认绑定）；编辑器启动时从 `assets/scenes/*.scene.json` 加载，**删掉构造函数里硬编码的地面/胶囊** | 编辑器启动后画面与今天一致（地面还在，但来自文件）；`validateSceneDocument` 对示例场景零 error | S0c |
| **S2 · 保存** | Inspector 绑定组件 → 编辑 → 写回文件；Undo/Redo | 改一盏灯颜色 → 保存 → 重开 → 颜色还在；git diff 只一行 | S1 |
| **S3 · Play mode** | 补 `App.tick` 主循环；Play/Stop 状态机；快照回滚；Play 期 GPU 资源登记与释放 | Play → 生成 10 只僵尸 → Stop → 场景回到原样；**连按 20 次 Play/Stop，显存无增长** | S2 |
| **S4 · 灯光组件化** | `Light` 组件 + 多灯降级 + 环境面板改造 | 场景里放 3 盏灯，只有 1 主 1 点生效且落选者标黄；主题切换（火场/暗巷）改变画面 | S3 |
| **S5 · Prefab** | `PrefabDocument` + override 解析 + 编辑器「解包/应用」 | 改 zombie prefab → 场景里 20 个实例同步更新；单个实例的 override 不被覆盖 | S2 |
| **S6 · 玩法** | `SpawnPoint`/`RoomVolume`/`NavZone` 接 `packages/ai` + `gameplay`；房间图程序生成 | 一个 Act1 战斗房能跑通：进房 → 刷怪 → 流场寻路 → 清场开门 | S3+S5 |

**并行建议**：S4/S5 可与 S3 并行（不同文件域）。S6 必须在 S3+S5 之后。

---

## 11. 验证体系（ADR-003 三层 + ADR-008 结论可复现）

| 层 | 内容 | 命令 |
|---|---|---|
| **L1 数学/数据** | schema 校验、迁移链、往返、override 解析、变换传播 | `npx vitest run packages/scene/test/` |
| **L2 headless WebGPU** | 加载真实场景文件 → 渲染 1 帧 → CDP 像素判定（非全黑 + 有描边 + 主光方向正确） | Chrome 152 + `--enable-unsafe-swiftshader`（配方见 `webgpu-headless-validate` 技能） |
| **L3 编辑器冒烟** | `editor:smoke` 新增 **section K**：Play/Stop 往返 20 次后 GPU 资源数归零、场景内容与快照逐字段相等 | `npm run editor:smoke` |

**新增门禁**（S1 起）：
- `npm run scene:check` —— 校验 `assets/scenes/**` 全部文件通过 `validateSceneDocument`，失败 exit 1。
  与现有 `content:check`（roster/tokens 同步检查）同构，都是防"跑不出来但会出事"的问题。

---

## 12. ADR 索引（本次新增）

- **ADR-010**：场景为唯一数据载体 —— 游戏内容（网格/灯光/相机/刷怪点/房间）只能来自场景文件，
  禁止在代码里硬编码场景内容。数据字典真源 `packages/scene/src/document.ts`。
- **ADR-011**：双层运行时分工 —— Authoring 用 Node/Component（AoS，可序列化、可撤销），
  热实体用 SoA ECS（`packages/ai`+`gameplay`），通过 `NodeId ↔ EntityId` 映射桥接。
  现有 `packages/core` 的 World 是半成品，不得用作场景骨架。
- **ADR-012**：场景文件用扁平节点表 + parent 引用，不用嵌套树（diff 友好 / 无递归 / 与 propertyPath 一致）。
- **ADR-013**：格式用 JSON + `schemaVersion` + 迁移链，不用二进制。二进制 .pak 是 Phase 4 运行时产物。
- **ADR-014**：Edit/Play 严格分离 —— Play 前快照、Play 中只改副本、Stop 回滚 + 释放全部 Play 期 GPU 资源。
- **ADR-015**：项目容器 `aether.project.json` 是锚点 —— 路径根、场景清单、层表、渲染档位、材质库/行为目录指针都在这里。单文件形态，一个仓库 = 一个项目。
- **ADR-016**：资产附加数据走同名 sidecar `<file>.meta.json`（导入设置 + 默认绑定 + 骨骼/动画配置 + userData + sourceHash）。guid 保证重命名/移动不丢引用；索引是派生产物不进 git。归属判定问一句"换场景还在不在"。
- **ADR-017**：脚本 = 行为注册表。代码资产 + `BehaviorParamSchema`（Inspector 据此画控件），场景只存 `behavior id + params`。绝不存代码字符串。

---

## 13. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **`MAX_OBJECTS=64` 撞墙** | 场景放到 70 个物件时神秘消失 | §4.5 预算表 + 超限时**报错而非静默丢弃**；500 僵尸走 instancing |
| **Play/Stop 显存泄漏** | 反复 Play 后 OOM 黑屏 | ADR-014 资源登记 + section K 冒烟（连按 20 次） |
| **场景格式中途改 schema** | 老场景全废 | 迁移链（§7.2）+ 每次变更必须补迁移与测试 |
| **prefab override 路径失效** | 改了 prefab 后 override 全丢 | override 用 NodeId 寻址（不用下标）；断链时报 diagnostic 而非静默丢弃 |
| **并行 session 改同一批文件** | 互相覆盖 | 严守 agents.md §2 的多 session 纪律：只 `git add` 本会话文件 |
| **迁移链被绕过** | 用户在别处手改 JSON 绕过校验 | `scene:check` 门禁进 CI（S1 起） |

---

## 14. 立即可做（S1 开工清单）

1. `packages/scene/src/migrate.ts` —— 迁移链骨架（当前 `MIGRATIONS` 为空表，先把机制建起来）。
2. `packages/scene/src/graph.ts` —— `SceneGraph`：NodeId→row 索引、TRS 存取、脏标记变换传播。
3. `packages/assets/src/asset-server.ts` —— `AssetRef` → `MeshData`/纹理，带缓存。
4. `packages/scene/src/instantiate.ts` —— Document + AssetServer → `SceneObject[]`（复用现有 `addObject` 逻辑）。
5. 把 `assets/scenes/sandbox/default.scene.json` 造出来（内容 = 今天编辑器里硬编码的那三样：地面 + 胶囊 + 一盏主光）。
6. 删除 `LabRenderer` 构造函数里的硬编码几何（`renderer.ts:431-436`）。
