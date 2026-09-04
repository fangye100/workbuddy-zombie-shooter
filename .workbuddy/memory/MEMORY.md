# 项目长期记忆

## 项目规则（铁律）
- 收尾必须 `git add <本会话文件> && git commit && git push`，规范中文 commit message，不留脏工作区。
- 🔴 未经许可禁止触碰 `.git` 内部（fsck/删文件/建 refs/碰 pack 全禁）。异常只报告症状等指令。
  多 session 并行时**只 `git add` 本会话改的**，禁止 `git add -A`（会吞别人在途改动）；不禁止各 session 自行提交；push 避开同分支并发。
- 远程 `origin = git@github.com:fangye100/workbuddy-zombie-shooter.git`（只走 SSH；拼写 **shooter**，另有空仓 shotter 勿推）。
- 🔴 **Python 写文本文件会偷偷 LF→CRLF**：`open(p,'w')` 默认做换行翻译，仓库 blob 存 LF → 整文件 diff。**一律用 `newline=''`**。
  自查 `git diff --cached --stat --ignore-cr-at-eol` 应远小于 `git diff --cached --stat`；已中招用 `open(f,'wb').write(open(f,'rb').read().replace(b'\r\n',b'\n'))`。

## ADR 速查（全文在 `docs/10` 与 `docs/14`）
001 渲染真源唯一化 · 002 资料库为运行时单一真源 · 003 验证分层 · 005 包体 `@aether/*` · 007 render(L3) 不得反向依赖 content(L4) · 008 验证资产与结论同入库 · 009 测试与被测代码同位 · **010 场景为唯一数据载体** · 011 Authoring=Node/Component(AoS)+热实体 SoA ECS，NodeId↔EntityId 桥接 · 012 扁平节点表+parent · 013 JSON+SCHEMA_VERSION+迁移链 · 014 Edit/Play 严格分离（快照/副本/回滚/释放 GPU）· 015 项目容器 `aether.project.json` 为锚点 · 016 资产附加数据走同名 sidecar · 017 脚本=行为注册表

## 资料 / 真源（改前先改这里）
- `assets/characters/roster.json`（8 角色 npcs5+bosses3，**顶层键不是 `characters`**）+ `assets/style/tokens.json`。
- 生成层 `packages/content/`：`scripts/gen-content.mjs` → `src/generated/{tokens,roster}.generated.ts`。`content:gen` 写 / `content:check` 比对（不同步 exit 1）。
- **生成器铁律**：① 解析失败抛错不静默填 0（B-02 `speed:"本体固定不可移动"` → `null`）；② 复合串取第一个数值 + 原始串原样保留（`heightRaw`）。
- ⚠️ **D3 未完：`roster.json` 承载不了 `CharacterDef`**（无胶囊半径/质量/转向速率/视野/攻击性/骨骼受伤盒）。11 项不可派生字段清单在 `roster.generated.ts` 头部。
  **硬生成 = 把编造数字洗成「单一真源」，比硬编码更坏**，别干。
- 遗留 L-8（待用户决策，勿擅改）：`params.ts` `gradeShadowMult` 0.95 vs 真源 0.78、`gradeShadowMix` 0.12 vs 真源 0.2。**修正改变画面**，属美术决策。

## 引擎与编辑器
- 端口：**编辑器 5100**，**最终游戏 5101**（见 `agents.md` §1）。以 `apps/editor/vite.config.ts` 的 `port` 为准。
- **脚本名坑**：`npm run build` 构建的是 sample-00；**编辑器**是 `npm run editor:build`；冒烟 `npm run editor:smoke`（无 `verify:smoke`），需传 `--glb <rigged.glb>` 才启用骨骼动画断言组（不传 3 条 SKIP）。另有 `verify:glb|uv|facade|dock|prefix`。`lab*` 只是 `editor*` 的兼容别名。
- 引擎已落地：`ai`(流场寻路/战斗/行为，最成熟) · `gameplay`(SoA 角色表) · `gfx` · `core` · `framegraph`。platform/scene/assets/animation/physics/vfx/ui/audio 尚未建——不为空包建目录。
- dormant：`packages/framegraph/src/graph.ts` + `packages/render/src/feature.ts`（425 行零消费者，已标 DORMANT 未删）。注意 `apps/editor/src/features/*.feature.ts` 的 feature 与 `RenderFeature` **不是同一个东西**。
- 验证方法论：数学 Node 直测 + headless WebGPU(Chrome152 + `--enable-unsafe-swiftshader`) + CDP 像素判定（已证伪 headless 假阴性）→ 引擎级 CI 标准。
- 换模型材质绑定：GLB node extras → nodePath → primitiveKey 三层匹配；nodeId 精确匹配须双侧 leaf 同名否则撞车；未认领进孤儿池。
- Asset Preview 自开独立 `RendererCore` 实例（`apps/editor/src/services/asset-preview.ts`），与 `LabRenderer` 平级，均不内嵌渲染逻辑。骨骼 X-ray 用引擎 `CoreSkeletonOverlay`，编辑器算端点、引擎只画。

### 🔴 资产库面板「不见了」——两个独立成因
**完整诊断方法论已外置为 skill `ui-element-invisible-diagnosis`（分层阶梯 + 广告拦截定性 + 防复发闸门），别在这里重写。** 本项目特有事实只留这些：
- 已成事实：类名前缀 `ad-` 全改 `asset-`（`adk-`→`akind-`、`data-ad`→`data-asset`），commit `750972d`；闸门 `npm run verify:prefix`。
- 次要成因：localStorage `zh.assets.collapsed === '1'`（还有 `zh.ui.dockH`），删掉硬刷即恢复。
- 项目工具 `node tools/verify/dock-probe.mjs`（五视口 + 分段高度 + `elementFromPoint`）；基线 `seg {grip:6, head:42, body:212, tree:212, content:212, sum:260}`。

## Scene 系统（2026-09-04 定案；铁律 `agents.md` §2/§2.5，全文 `docs/14`，这里只留**不可派生的判断与坑**）
- **游戏规则：游戏开发必须以场景为唯一数据存储与编辑载体**。三份真源：`document.ts`(场景) / `project.ts`(项目锚点) / `asset-meta.ts`(资产 sidecar)。改 schema 先改它 + 补测试 + 补迁移链。
- **🔴 不要用 `packages/core/src/ecs/world.ts` 当场景骨架**：半成品（remove 空实现 :170、strideOf 硬编码 4 :229、isChanged 恒真 :189）。用它重写 = 把能跑的编辑器拆成不能跑的架构正确品。静态物件走 SceneGraph，500 僵尸走 ai+gameplay 的 SoA。
- **容量硬约束**：`MAX_OBJECTS=64`（frame-uniforms.ts:23）静态物件上限，超了**必须报错不能静默丢**；`MAX_MATERIAL_SLOTS=256`；`LIGHTS_FLOATS=40` → **只支持 1 directional + 1 point**，schema 允许多灯、运行时按 `priority` 取 top-1+top-1、**落选者标黄**。**500 僵尸必须 instancing**。
- **Play mode 前置**：`App.tick` 空实现（`core/src/app.ts:156-161`），必须先补固定步长主循环，否则又变两套循环。
- 分层修正：`renderer-core.ts:18` 反向 import `@aether/scene` 与「L3 不能依赖 L4」冲突 → 把 `scene/geometry.ts` 定性为**共享契约层**允许被 L3 依赖，`graph.ts`/`document.ts` 才是 L4。只改文档与注释，**不移动文件**。
- 路线 S0(已完)→S1 加载→S2 保存→S3 Play→S4 灯光组件化→S5 prefab→S6 接 ai/gameplay。S1 第一件事：把 `renderer.ts:431-436` 硬编码的地面/胶囊换成从 `assets/scenes/sandbox/default.scene.json` 加载。

### 资产元数据（ADR-016）
- **四层容器**：`aether.project.json`(锚点) ⊃ `<file>.meta.json`(保留源扩展名 → a.glb 与 a.obj 不撞车) → `*.prefab.json` → `*.scene.json`。**覆盖链**：`.meta` → prefab → scene → runtime(Play 期不落盘)，每级只存差异。
- **🔴 归属判定两句**：① 换个全新空场景，这数据还在不在？不在 → `.scene`。② **这段数据丢了，能不能从源 GLB 反推出来？能 → 不存**（否则双真源）。
- **不用集中索引** —— `assetdb.json` 是**合并冲突制造机**；guid→path 索引是派生产物，启动扫描重建落 `.workbuddy/cache/`（不进 git）。
- `.meta` ⇄ `binding.ts`：`PrimitiveBinding{materialId,override}` ⇄ `MaterialBindingRef{shared|instance|override}` 三形态对应。**转换是编辑器/资产层职责，不放 schema**（避免 scene 反向依赖 render）。
- **不落盘三类**：派生/烘焙 → `.workbuddy/cache/`；编辑器 UI 状态 → localStorage；Play 运行时 → 内存 Stop 即弃。
- ⚠️ **schema 两个已修的坑**：① `MaterialRef` 与 `packages/render/materials.ts` 同名撞车 → `MaterialBindingRef`；② `MaterialPatch` 字段须与 `MaterialState` **逐个对齐**（`emissiveColor` 不是 `emissive`，另有 shadowEnd/specMix/softnessScale/halftoneScale/unlit），清单见 `MATERIAL_STATE_FIELDS`。
- **🔴 门禁测试禁用 `node:fs`**：未装 `@types/node`，`tsconfig.check.json` 的 `types` 是白名单。用 `import.meta.glob('/assets/**/*.meta.json',{eager:true,import:'default'})`（无需 node 类型 + 新资产自动纳入）。
- `tools/scene/gen-asset-meta.mjs`（⚠️ 不是 `tools/gen-asset-meta.mjs`）：**28 个** `.glb.meta.json`。跳过原始混元产物（`<ID>_<YYYYMMDD>_<HHMMSS>.glb`，40-50MB）、`_broken_backup_*/`、`uvkeep/`、`obj_*/`；只留 `rigged/ textured/ game_ready/ synthetic/`。
  铁律：① **merge 不覆盖**（手改的 bindings/rig/userData/导入设置必须保留）；② 身高从 **`roster.generated.ts` 的 `heightMeters`** 读，断言 8 个角色否则抛错。
- **门禁必须验证会拦住错误**（不能只报绿）：`maxSubMeshes=0`、重复 guid、新增资产漏 sidecar 三种已实测能精确报错 exit 1。

### 🔴 骨骼：会话存，结果不存（2026-09-04 实证订正）
- 实测 `E04_Bulwark_1600_rigged_animated.glb`（300KB）已含 **22 关节 + inverseBindMatrices + JOINTS_0/WEIGHTS_0 + 6 动画** → **绑定结果已随导出 GLB 落盘（LFS）**，往 `.meta` 抄一份 = **双真源，比丢失更糟**。
- `.meta.rig` 只装**造出结果的配方**（产物里都找不到）：`session.positions`(摆位，导出时已反解到 T-pose) / `session.bindPose` / `session.skinCylinders`(Wrapper 三段半径，算完即弃) / `export.*`(falloff/eps/maxInfluences/smooth×/mirrorWeights) / `tposeLocalRotations`。
- **不存 `mirrorPairs`**：它是 `humanik-template.ts` 的 `MIRROR_PAIRS` 模板常量，由 `template` 派生。
- `rig.exported` 取代 `weightsBaked`：`false` = 结果只在内存（**真·重灾区**，发 `W_META_RIG_NOT_EXPORTED`）；`true` = 结果已在 GLB，`.meta.rig` 降级为**历史记录**，运行时不读。
- S0d 编辑器侧对接未做（依赖 S1 Inspector）：`binding-panel.ts` 的 `positions`/`bindPose`/`cylinders`/`smoothWeights`/`mirrorWeightsExport`/`unposed` **全是实例私有字段，无落盘路径**。

### 脚本（ADR-017）
- 代码资产 + **`BehaviorParamSchema` 必须有**（没它 Inspector 画不出控件 = 功能等于没有）。场景只存 `{behavior:'spawn-wave', params:{count:12}}`，**绝不存代码字符串**（RCE 入口 + 无法重构）。
- 行为失效报 warning 降级空操作，**不阻塞加载**。Play 中禁用行为热重载。

## 3D 资产生成管线
- 入口 `assets/characters/_tools/gen3d_from_image.py`（勿直接调 buddy-cloud `--image-base64`，本地 PNG base64 超 Windows 命令行长度上限）。
- 减面首选 `decimate_cluster.py`（对病态拓扑免疫）；质检硬判据 = 表面积保持率 >80%。混元产物脚在 z-max，`export_labmesh` 用 `(x,-z,y)`，极性反用 `--up-flip`。
- **全链路 `assets/characters/_tools/pipeline_character.py`**：front.png → 混元图生3D(80000 tris) → decimate_cluster → bake_lowpoly(xatlas UV+贴图) → rig_character → retarget_bvh(烤6段) → validate_glb。单角色一条命令。
- **两套 Python 环境必须分开**：云端/绑骨 `binaries/python/versions/3.13.12`（要 requests）；减面/烘焙 `binaries/python/envs/default`（要 pymeshlab+xatlas）。
- **⚠️ 混元每日提交上限 5 次/天**（hy-3d，HTTP 429）；图生3D **不能同时带 `--prompt`**（API 拒 "Prompt和ImageBase64不能同时存在"）。
- headless `cdp-rigged.mjs`（参数化，GLB 路径走命令行）20 断言。**8/8 角色 rig+anim 全齐**（B-02/B-03 于 2026-09-04 补跑完成）。
- worktree 内 npm 装依赖会漂版本（TS 5.9/@webgpu/types 0.1.72 → 一片 TS2345）；主仓 pnpm 钉 5.6.3 / 0.1.49，修法 `npm install --no-save` 钉同版。

## WebGPU
**编码期陷阱（usage 常量混用 / 多画布）已外置为 skill `webgpu-coding-pitfalls`；
运行时验证流程见 skill `webgpu-headless-validate`。** 这里只留一句话：
**tsc + vite build 全绿照样线上炸** —— WebGPU 的 usage 错配、uniform offset 对齐、bind group
visibility、WGSL 编译错误只在运行时暴露，headless 验证是必选项不是可选项。

## 门禁（8 道，收尾全跑）
`typecheck` · `vitest` · `editor:build` · `editor:smoke` · `content:check` · `verify:prefix` · `scene:gen` · `scene:check`
（后四道防「跑不出来但会出事」：真源改了忘重跑 / 类名撞广告拦截 / 资产漏 sidecar / 场景格式非法）
